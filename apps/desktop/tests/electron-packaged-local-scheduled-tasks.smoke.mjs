import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { bounded, isolatedEnvironment, launchPackagedApp, waitUntil } from "./support/packaged-app.mjs";
import { preflight, failure, processIdentity, terminateObserved } from "./electron-packaged-protocol.smoke.mjs";

const prefix = "DESKTOP_LOCAL_TASKS";

/** Hash executable, shell, current Client bundles and all Web assets without changing them. */
async function hashes(paths) {
  const files = { ...paths.files };
  /** Enumerate only ordinary files inside the packaged payload. */
  async function walk(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      assert.equal(item.isSymbolicLink(), false, `${prefix}_ARTIFACT_LINK_REJECTED`);
      if (item.isDirectory()) await walk(filename);
      else if (item.isFile()) files[path.relative(paths.artifact, filename)] = filename;
    }
  }
  await walk(path.join(paths.resources, "client/dist"));
  await walk(path.join(paths.resources, "web"));
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, filename]) =>
    [key, crypto.createHash("sha256").update(await bounded(fs.readFile(filename), 30_000, `${prefix}_HASH_TIMEOUT`)).digest("hex")])));
}

/** Snapshot a confirmed launcher's tree or registered PIDs; query failure stays explicit. */
function processTree(pid, selectedPids) {
  const filter = selectedPids ? ` -Filter '${selectedPids.map(value => `ProcessId = ${value}`).join(" OR ")}'` : "";
  const script = `$ErrorActionPreference='Stop'
$all=@(Get-CimInstance Win32_Process${filter})
$ids=[Collections.Generic.HashSet[int]]::new()
${selectedPids ? selectedPids.map(value => `[void]$ids.Add(${value})`).join("\n") : `[void]$ids.Add(${pid})`}
do { $added=$false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added=$true } } } while ($added)
$result=@($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath;commandLine=$_.CommandLine} })
ConvertTo-Json -InputObject $result -Compress`;
  const result = spawnSync(path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${prefix}_PROCESS_QUERY_FAILED: ${result.status}: ${result.stderr}`);
  const value = JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
  return Array.isArray(value) ? value : value ? [value] : [];
}

/** Verify the real packaged renderer/Client and current schema100 in isolated SQLite. */
export async function run(args) {
  const [executable, output, mode, ...extra] = args;
  assert.ok(!extra.length && (mode === undefined || ["--probe-cleanup", "--probe-launch-timeout"].includes(mode)), `${prefix}_ARGUMENTS_INVALID`);
  const paths = await preflight([executable, output]);
  const artifactBefore = await hashes(paths);
  await fs.mkdir(paths.root);
  const report = { requestId: crypto.randomUUID(), status: "running", scope: "unsigned-local-win32-x64-packaged-script-tasks",
    artifactBefore, executable: paths.executable, root: paths.actualRoot, processes: [], sessions: [], steps: [],
    stderr: "", stderrTotalCharacters: 0, mode: mode ?? "complete" };
  const observed = new Map(), sessions = [];
  const scriptFile = path.join(paths.root, "scripts/marker.ps1");
  let current, knownError, manual, timer, failedTask;

  /** Record progress in the evidence report and console during the bounded minute wait. */
  function step(name, details = {}) {
    const value = { name, at: new Date().toISOString(), ...details };
    report.steps.push(value); console.log(JSON.stringify({ code: `${prefix}_STEP`, requestId: report.requestId, ...value }));
  }

  /** Bind PID, creation time, executable, parent and command to this launch or script. */
  function observe(pid, role, parentPid, snapshot) {
    let identity;
    try {
      identity = snapshot ?? processIdentity(pid);
      assert.ok(identity, `${prefix}_PROCESS_ABSENT: ${pid}`);
      const expected = role === "launcher" ? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/cmd.exe")
        : role === "script" ? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe")
        : role === "script-console" ? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/conhost.exe") : paths.executable;
      assert.equal(path.resolve(identity.executable).toLowerCase(), path.resolve(expected).toLowerCase(), `${prefix}_PROCESS_EXECUTABLE_MISMATCH`);
      assert.equal(identity.parentPid, parentPid, `${prefix}_PROCESS_PARENT_MISMATCH`);
      if (observed.has(parentPid)) assert.ok(identity.created >= observed.get(parentPid).identity.created, `${prefix}_CREATION_ORDER_INVALID`);
      if (role === "launcher" || role === "main") assert.ok(identity.commandLine.includes(path.join(paths.root, "profile")), `${prefix}_PROFILE_MISMATCH`);
      if (role === "client") assert.ok(identity.commandLine.includes(paths.files.client) && identity.commandLine.includes("--foreground"), `${prefix}_CLIENT_COMMAND_MISMATCH`);
      if (role === "script") assert.ok(identity.commandLine.includes(scriptFile), `${prefix}_SCRIPT_COMMAND_MISMATCH`);
      if (role === "script-console") {
        assert.equal(observed.get(parentPid)?.role, "script", `${prefix}_SCRIPT_CONSOLE_PARENT_UNCONFIRMED`);
        assert.match(identity.commandLine, /^\\\?\?\\[A-Za-z]:\\Windows\\system32\\conhost\.exe 0x[0-9a-f]+$/iu, `${prefix}_SCRIPT_CONSOLE_COMMAND_UNCONFIRMED`);
      }
      if (observed.has(pid)) assert.deepEqual(identity, observed.get(pid).identity, `${prefix}_PID_IDENTITY_CHANGED`);
      else { const entry = { role, identity }; observed.set(pid, entry); report.processes.push(entry); }
    } catch (error) {
      report.unknownProcesses ??= []; report.unknownProcesses.push({ pid, role, identity, error: failure(error) }); throw error;
    }
  }

  /** Discover descendants only after checking the registered launcher and trusted parent chain. */
  function discover(session) {
    session.discovery = "unknown";
    assert.ok(session.child?.pid, `${prefix}_PROCESS_ROOT_UNCONFIRMED`);
    const anchor = observed.get(session.child.pid);
    assert.ok(anchor, `${prefix}_PROCESS_ROOT_UNCONFIRMED`);
    const tree = processTree(session.child.pid);
    report.lastProcessTree = tree;
    assert.deepEqual(tree.find(item => item.pid === session.child.pid), anchor.identity, `${prefix}_PROCESS_ROOT_CHANGED`);
    const pending = tree.filter(item => item.pid !== session.child.pid);
    while (pending.length) {
      const index = pending.findIndex(item => observed.has(item.parentPid));
      assert.notEqual(index, -1, `${prefix}_PROCESS_CHAIN_UNCONFIRMED`);
      const entry = pending.splice(index, 1)[0];
      const role = entry.pid === session.mainPid ? "main" : entry.commandLine?.includes(scriptFile) ? "script"
        : entry.commandLine?.includes(paths.files.client) ? "client" : observed.get(entry.parentPid)?.role === "script" ? "script-console" : "electron-child";
      if (role === "electron-child") assert.ok(entry.commandLine?.toLowerCase().includes(path.join(paths.root, "profile").toLowerCase()), `${prefix}_PROCESS_PROFILE_UNCONFIRMED`);
      observe(entry.pid, role, entry.parentPid, entry);
      assert.deepEqual(observed.get(entry.pid).identity, entry, `${prefix}_PROCESS_SNAPSHOT_CHANGED`);
    }
    session.discovery = "confirmed";
  }

  /** Preserve PID reuse and lookup failures as unknown instead of reporting successful cleanup. */
  function remaining() {
    const entries = [];
    if (observed.size) {
      try {
        for (const identity of processTree(0, [...observed.keys()])) {
          entries.push({ pid: identity.pid, state: isDeepStrictEqual(identity, observed.get(identity.pid).identity) ? "alive" : "identity-changed", identity });
        }
      } catch (error) { for (const pid of observed.keys()) entries.push({ pid, state: "unknown", error: failure(error) }); }
    }
    for (const session of sessions) if (session.discovery === "unknown") entries.push({ state: "unknown-scope", launcherPid: session.child?.pid });
    return entries;
  }

  /** Send product IPC exit and verify every observed process from that session has stopped. */
  async function exit(session) {
    discover(session);
    await bounded(Promise.all([session.application.waitForEvent("close", { timeout: 40_000 }),
      session.page.evaluate(() => { void window.codeflowDesktop.exit(); })]), 42_000, `${prefix}_EXIT_TIMEOUT`);
    assert.equal(session.child.exitCode, 0, `${prefix}_EXIT_CODE_INVALID`);
    session.closed = true;
    await waitUntil(() => remaining().length === 0, 10_000, `${prefix}_PROCESSES_REMAIN`);
    report.sessions.push({ ...session.facts, state: session.state, exitCode: session.child.exitCode });
    session.child.stdout?.destroy(); session.child.stderr?.destroy(); session.child.unref();
  }

  /** Cleanup records both the original failure and any identity or exit failure; unknown PIDs remain untouched. */
  async function cleanup() {
    const errors = [];
    for (const session of sessions.filter(item => !item.closed)) {
      try { await exit(session); } catch (error) { errors.push(error); }
    }
    for (const entry of remaining().reverse()) {
      try { assert.equal(entry.state, "alive", `${prefix}_CLEANUP_IDENTITY_UNCONFIRMED`); terminateObserved(observed.get(entry.pid).identity); }
      catch (error) { errors.push(error); }
    }
    report.remainingProcesses = remaining();
    report.unconfirmedSurvivors = [];
    for (const entry of report.unknownProcesses ?? []) {
      try { const identity = processIdentity(entry.pid); if (identity) report.unconfirmedSurvivors.push({ pid: entry.pid, identity }); }
      catch (error) { report.unconfirmedSurvivors.push({ pid: entry.pid, error: failure(error) }); }
    }
    if (report.remainingProcesses.length || report.unconfirmedSurvivors.length) errors.push(new Error(`${prefix}_PROCESSES_UNCONFIRMED_OR_REMAIN`));
    for (const session of sessions) { session.child?.stdout?.destroy(); session.child?.stderr?.destroy(); session.child?.unref(); }
    if (errors.length) throw new AggregateError(errors, `${prefix}_CLEANUP_FAILED`);
  }

  /** Bridge calls keep transport status and business failure visible to the assertions. */
  async function request(method, body = {}) {
    return bounded(current.page.evaluate(input => window.codeflowDesktop.request(input), { method, body }), 40_000, `${prefix}_BRIDGE_TIMEOUT: ${method}`);
  }

  /** Successful requests must satisfy both HTTP-style and business envelopes. */
  async function ok(method, body) {
    const result = await request(method, body); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body?.ok, true, JSON.stringify(result)); return result.body;
  }

  /** Read current configs through the original bounded local bridge. */
  async function list() { return (await ok("scheduledTasks.local.list", { limit: 200 })).items; }

  /** Read the retained history through the original bridge, including deleted tasks. */
  async function runs(taskId) { return (await ok("scheduledTasks.local.runs", { ...(taskId ? { taskId } : {}), limit: 200 })).items; }

  /** Locate the real task table row by immutable product task ID. */
  function row(task) { return current.page.locator(`.scheduled-tasks tr[data-row-key="${task.id}"]`); }

  /** Open the native renderer panel using its real topbar entry. */
  async function openPanel() {
    const settings = current.page.locator(".settings-modal");
    if (await settings.isVisible()) { await settings.locator(".ant-modal-close").click(); await settings.waitFor({ state: "hidden" }); }
    await current.page.getByRole("button", { name: "定时任务", exact: true }).click();
    await current.page.locator(".scheduled-tasks").waitFor({ state: "visible", timeout: 20_000 });
    report.panelButtons = await current.page.locator(".scheduled-tasks button").evaluateAll(elements => elements.map(element => ({ label: element.getAttribute("aria-label"), text: element.textContent })));
  }

  /** Save a no-workspace PowerShell task entirely through the existing UI form. */
  async function createTask(name, markerName, cronExpr = "0 0 1 1 *", scriptMode = "success") {
    await current.page.locator(".scheduled-tasks").getByRole("button", { name: /新\s*建/u }).click();
    const modal = current.page.getByRole("dialog").filter({ has: current.page.locator('input[name="codeflow-scheduled-task-name"]') });
    await modal.locator('input[name="codeflow-scheduled-task-name"]').fill(name);
    await modal.getByText("脚本", { exact: true }).click();
    await modal.locator('input[name="codeflow-scheduled-task-cron"]').fill(cronExpr);
    await modal.locator('textarea[name="codeflow-scheduled-task-command"]').fill(`& '${scriptFile.replaceAll("'", "''")}' -Marker '${path.join(paths.root, "markers", markerName).replaceAll("'", "''")}' -Mode '${scriptMode}'`);
    await modal.getByRole("button", { name: /^保\s*存$/u }).click();
    await modal.waitFor({ state: "hidden", timeout: 20_000 });
    const task = (await list()).find(item => item.name === name);
    assert.ok(task, `${prefix}_UI_SAVE_MISSING`); assert.equal(task.revision, 1); assert.equal(task.source, "local");
    assert.equal(task.workspaceScope, null); assert.equal(task.payload.contextWorkspaceId, null); assert.equal(task.taskType, "script");
    return task;
  }

  /** Wait for the real script marker and bind the live PowerShell process before its bounded exit. */
  async function marker(name) {
    const filename = path.join(paths.root, "markers", name);
    let value;
    await waitUntil(async () => {
      try { value = JSON.parse(await fs.readFile(filename, "utf8")); return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }, 130_000, `${prefix}_SCRIPT_MARKER_TIMEOUT`);
    assert.equal(value.requestId, report.requestId); assert.equal(path.resolve(value.cwd), path.join(paths.root, "home/.codeflowai/scheduled-tasks"));
    observe(value.pid, "script", current.state.pid); return value;
  }

  /** Close only the currently visible history drawer; all evidence is kept in product storage. */
  async function closeHistory() {
    const drawer = current.page.locator(".ant-drawer-content-wrapper").filter({ has: current.page.locator(".scheduled-tasks__runs") });
    if (await drawer.isVisible()) { await drawer.locator(".ant-drawer-close").click(); await drawer.waitFor({ state: "hidden" }); }
  }

  /** Launch with one reused isolated profile, and verify packaged paths plus actual Client health. */
  async function launch(env) {
    const session = { discovery: "unknown", closed: false };
    sessions.push(session);
    const launched = await launchPackagedApp({ executablePath: paths.executable, userDataDir: path.join(paths.root, "profile"), env, cwd: paths.root,
      timeoutMs: mode === "--probe-launch-timeout" ? 1 : 60_000 });
    Object.assign(session, launched); current = session;
    session.child.stdout?.resume();
    session.child.stderr?.setEncoding("utf8").on("data", chunk => { report.stderrTotalCharacters += chunk.length; report.stderr = (report.stderr + chunk).slice(-65_536); });
    const identity = processIdentity(session.child.pid); assert.ok(identity, `${prefix}_LAUNCHER_ABSENT`);
    const direct = path.resolve(identity.executable).toLowerCase() === paths.executable.toLowerCase();
    observe(session.child.pid, direct ? "main" : "launcher", process.pid);
    session.mainPid = await bounded(session.application.evaluate(() => process.pid), 15_000, `${prefix}_MAIN_PID_TIMEOUT`);
    observe(session.mainPid, "main", direct ? process.pid : session.child.pid);
    session.page = await session.application.firstWindow({ timeout: 60_000 });
    session.page.setDefaultTimeout(20_000);
    await session.page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
    await session.page.waitForFunction(async () => (await window.codeflowDesktop?.getState())?.status === "ready", undefined, { timeout: 60_000 });
    session.state = await session.page.evaluate(() => window.codeflowDesktop.getState());
    assert.equal(session.state.health.database, "ready"); assert.equal(session.state.health.dbSchemaVersion, 100); observe(session.state.pid, "client", session.mainPid);
    session.facts = await session.application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resources: process.resourcesPath, userData: app.getPath("userData"), shellPid: process.pid }));
    assert.equal(session.facts.isPackaged, true); assert.equal(session.facts.appPath, paths.files.asar); assert.equal(session.facts.resources, paths.resources);
    assert.equal(session.facts.userData, path.join(paths.root, "profile"));
    discover(session); return session;
  }

  try {
    const env = await isolatedEnvironment(paths.root);
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
    env.PATH = [path.join(systemRoot, "System32/WindowsPowerShell/v1.0"), path.join(systemRoot, "System32"), systemRoot].join(path.delimiter);
    await fs.mkdir(path.join(paths.root, "scripts")); await fs.mkdir(path.join(paths.root, "markers"));
    await fs.writeFile(scriptFile, "\uFEFF" + `param([string]$Marker, [string]$Mode)\r\n$ErrorActionPreference='Stop'\r\n$record=@{requestId='${report.requestId}';pid=$PID;cwd=(Get-Location).Path;mode=$Mode;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress\r\n[IO.File]::WriteAllText($Marker,$record,[Text.UTF8Encoding]::new($false))\r\nStart-Sleep -Seconds 8\r\nif ($Mode -eq 'failed') { throw 'D08A5_EXPECTED_SCRIPT_FAILURE' }\r\nWrite-Output 'D08A5_SCRIPT_SUCCESS'\r\n`, { encoding: "utf8", flag: "wx" });
    await launch(env);
    report.initialRuntime = await ok("runtime.info");
    assert.deepEqual(report.initialRuntime.client.workspaceIds, []); assert.deepEqual((await ok("workspaces.list")).workspaces, []);
    assert.equal((await ok("runtime.cloudAccount.status")).account.status, "unlinked"); assert.deepEqual(await list(), []); assert.deepEqual(await runs(), []);
    report.updateControl = await current.page.evaluate(async () => {
      try { await window.codeflowDesktop.request({ method: "runtime.update.prepare", body: {} }); return { rejected: false }; }
      catch (error) { return { rejected: true, message: error.message }; }
    });
    assert.equal(report.updateControl.rejected, true); assert.match(report.updateControl.message, /DESKTOP_UPDATE_CONTROL_FORBIDDEN/u);
    await openPanel(); step("fresh-packaged-no-account-no-workspace");
    manual = await createTask(`D08a5 manual ${report.requestId}`, "manual.json");
    const initial = structuredClone(manual);
    await row(manual).getByRole("button", { name: "编辑", exact: true }).click();
    const name = `D08a5 edited ${report.requestId}`;
    await current.page.locator('input[name="codeflow-scheduled-task-name"]').fill(name);
    await current.page.getByRole("dialog").getByRole("button", { name: /^保\s*存$/u }).click();
    await waitUntil(async () => (await list()).some(item => item.id === manual.id && item.revision === 2), 15_000, `${prefix}_EDIT_TIMEOUT`);
    manual = (await list()).find(item => item.id === manual.id); assert.equal(manual.name, name);
    await row(manual).getByRole("switch", { name: `启用 ${name}`, exact: true }).click();
    await waitUntil(async () => (await list()).some(item => item.id === manual.id && item.revision === 3 && !item.enabled), 15_000, `${prefix}_DISABLE_TIMEOUT`);
    await row(manual).getByRole("switch", { name: `启用 ${name}`, exact: true }).click();
    await waitUntil(async () => (await list()).some(item => item.id === manual.id && item.revision === 4 && item.enabled), 15_000, `${prefix}_ENABLE_TIMEOUT`);
    manual = (await list()).find(item => item.id === manual.id);
    const beforeConflict = await list();
    const conflict = await request("scheduledTasks.local.setEnabled", { taskId: manual.id, expectedRevision: initial.revision, enabled: false });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.ok, false); assert.equal(conflict.body.details.reason, "SCHEDULED_TASK_CONFIG_CONFLICT");
    assert.deepEqual(await list(), beforeConflict); report.cas = { initialRevision: initial.revision, currentRevision: manual.revision, conflict }; step("ui-create-edit-enable-disable-cas");
    await row(manual).getByRole("button", { name: "立即运行", exact: true }).click();
    report.manualMarker = await marker("manual.json");
    if (mode === "--probe-cleanup") throw new Error(`${prefix}_EXPECTED_FAILURE_WITH_LIVE_SCRIPT`);
    let manualRun;
    await waitUntil(async () => { manualRun = (await runs(manual.id)).find(item => item.status === "success"); return Boolean(manualRun); }, 30_000, `${prefix}_MANUAL_SUCCESS_TIMEOUT`);
    assert.equal(manualRun.triggerSource, "manual"); assert.equal(manualRun.configRevision, manual.revision); assert.equal(manualRun.taskNameSnapshot, manual.name);
    assert.equal(manualRun.workspaceId, null); assert.equal(processIdentity(report.manualMarker.pid), null); report.manualRun = manualRun;
    await current.page.locator(`.scheduled-tasks__runs tr[data-row-key="${manualRun.id}"]`).waitFor({ state: "visible" });
    await closeHistory(); step("real-manual-script-success");
    failedTask = await createTask(`D08a5 failure ${report.requestId}`, "failed.json", "0 0 1 1 *", "failed");
    await row(failedTask).getByRole("button", { name: "立即运行", exact: true }).click(); report.failedMarker = await marker("failed.json");
    await waitUntil(async () => (await runs(failedTask.id)).some(item => item.status === "failed"), 30_000, `${prefix}_SCRIPT_FAILURE_TIMEOUT`);
    report.failedRun = (await runs(failedTask.id))[0]; assert.equal(report.failedRun.status, "failed"); assert.equal(processIdentity(report.failedMarker.pid), null);
    assert.equal((await current.page.evaluate(() => window.codeflowDesktop.getState())).status, "ready"); await closeHistory(); step("script-failure-visible-and-process-exited");
    timer = await createTask(`D08a5 timer ${report.requestId}`, "timer.json", "* * * * *");
    step("waiting-real-minute-timer", { taskId: timer.id, budgetMs: 130_000 });
    report.timerMarker = await marker("timer.json");
    await row(timer).getByRole("switch", { name: `启用 ${timer.name}`, exact: true }).click();
    await waitUntil(async () => (await list()).some(item => item.id === timer.id && item.revision === 2 && !item.enabled), 15_000, `${prefix}_TIMER_DISABLE_TIMEOUT`);
    await waitUntil(async () => (await runs(timer.id)).some(item => item.status === "success"), 30_000, `${prefix}_TIMER_SUCCESS_TIMEOUT`);
    const timerRuns = await runs(timer.id); assert.equal(timerRuns.length, 1); report.timerRun = timerRuns[0];
    assert.equal(report.timerRun.triggerSource, "schedule"); assert.equal(report.timerRun.configRevision, 1); assert.equal(report.timerRun.taskNameSnapshot, timer.name);
    assert.equal(processIdentity(report.timerMarker.pid), null); timer = (await list()).find(item => item.id === timer.id); step("real-minute-timer-success-disabled");
    await row(manual).getByRole("button", { name: "删除", exact: true }).click();
    await current.page.getByRole("dialog").filter({ hasText: "删除定时任务" }).getByRole("button", { name: /^删\s*除$/u }).click();
    await waitUntil(async () => !(await list()).some(item => item.id === manual.id), 15_000, `${prefix}_DELETE_TIMEOUT`);
    assert.equal(await row(manual).count(), 0);
    await current.page.getByRole("button", { name: "全部运行记录", exact: true }).click();
    await current.page.locator(`.scheduled-tasks__runs tr[data-row-key="${manualRun.id}"]`).waitFor({ state: "visible" });
    report.runsBeforeRestart = await runs(); assert.equal(report.runsBeforeRestart.length, 3);
    report.configsBeforeRestart = await list(); await current.page.screenshot({ path: path.join(paths.root, "history-before-restart.png") });
    await exit(current); step("normal-ipc-exit-before-restart");
    await launch(env);
    assert.equal((await ok("runtime.info")).client.clientId, report.initialRuntime.client.clientId);
    assert.deepEqual(await list(), report.configsBeforeRestart); assert.deepEqual(await runs(), report.runsBeforeRestart);
    await openPanel(); assert.equal(await row(manual).count(), 0); assert.equal(await row(timer).count(), 1);
    await current.page.getByRole("button", { name: "全部运行记录", exact: true }).click();
    await current.page.locator(`.scheduled-tasks__runs tr[data-row-key="${manualRun.id}"]`).waitFor({ state: "visible" });
    await current.page.screenshot({ path: path.join(paths.root, "history-after-restart.png") });
    step("restart-config-history-and-client-identity-retained"); await exit(current);
    const db = new DatabaseSync(path.join(paths.root, "runtime/codeflowai.db"), { readOnly: true, timeout: 5_000 });
    let dbError;
    try {
      report.sqlite = { schema: db.prepare("PRAGMA user_version").get().user_version,
        configs: db.prepare("SELECT id, client_id, device_id, revision, enabled, deleted_at, name FROM scheduled_task_configs ORDER BY id").all(),
        runs: db.prepare("SELECT id, task_id, client_id, device_id, status, trigger_source, config_revision, task_name_snapshot FROM scheduled_task_runs ORDER BY id").all(),
        businessCounts: Object.fromEntries(["threads", "thread_turns", "orch_instances", "workspaces"].map(table => [table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count])) };
      assert.equal(report.sqlite.schema, 100); assert.equal(report.sqlite.configs.length, 3); assert.equal(report.sqlite.runs.length, 3);
      const tombstone = report.sqlite.configs.find(item => item.id === manual.id); assert.equal(tombstone.revision, 5); assert.equal(tombstone.enabled, 0); assert.ok(tombstone.deleted_at > 0);
      for (const config of report.sqlite.configs) { assert.equal(config.client_id, manual.clientId); assert.equal(config.device_id, manual.deviceId); }
      assert.deepEqual(report.sqlite.businessCounts, { threads: 0, thread_turns: 0, orch_instances: 0, workspaces: 0 });
      for (const run of [report.manualRun, report.failedRun, report.timerRun]) {
        const stored = report.sqlite.runs.find(item => item.id === run.id); assert.ok(stored); assert.equal(stored.status, run.status);
        assert.equal(stored.config_revision, run.configRevision); assert.equal(stored.task_name_snapshot, run.taskNameSnapshot);
      }
    } catch (error) { dbError = error; }
    try { db.close(); } catch (error) { throw new AggregateError([...(dbError ? [dbError] : []), error], `${prefix}_DB_CLOSE_FAILED`); }
    if (dbError) throw dbError;
    const logDir = path.join(paths.root, "runtime/logs");
    const logs = [];
    for (const filename of await fs.readdir(logDir)) {
      if (!/^client.*\.log$/u.test(filename)) continue;
      logs.push(...(await fs.readFile(path.join(logDir, filename), "utf8")).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)));
    }
    report.expectedErrors = logs.filter(entry => entry.code === "SCHEDULED_TASK_CONFIG_CONFLICT" || entry.code === "SCHEDULED_TASK_SCRIPT_FAILED");
    assert.equal(report.expectedErrors.length, 2);
    for (const entry of report.expectedErrors) { assert.ok(entry.requestId); assert.ok(entry.taskId); assert.equal(entry.workspaceId, null); }
    const scriptFailure = report.expectedErrors.find(entry => entry.code === "SCHEDULED_TASK_SCRIPT_FAILED");
    assert.equal(scriptFailure.runId, report.failedRun.id); assert.equal(scriptFailure.exitCode, 1);
    assert.equal(logs.filter(entry => entry.level === "ERROR" && entry.code !== "SCHEDULED_TASK_SCRIPT_FAILED").length, 0, `${prefix}_UNEXPECTED_CLIENT_ERROR`);
    step("stopped-client-readonly-sqlite-schema100-tombstone-and-runs");
  } catch (error) {
    knownError = error;
    try { await cleanup(); } catch (cleanupError) { knownError = new AggregateError([knownError, cleanupError], `${prefix}_VERIFICATION_AND_CLEANUP_FAILED`); }
  }
  try { report.artifactAfter = await hashes(paths); assert.deepEqual(report.artifactAfter, artifactBefore, `${prefix}_ARTIFACT_CHANGED`); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], `${prefix}_ARTIFACT_VERIFICATION_FAILED`); }
  report.remainingProcesses = remaining();
  if (report.remainingProcesses.length) knownError = new AggregateError([...(knownError ? [knownError] : []), new Error(`${prefix}_PROCESSES_REMAIN`)], `${prefix}_FINAL_PROCESS_CHECK_FAILED`);
  report.status = knownError ? "failed" : "passed"; if (knownError) report.failure = failure(knownError);
  report.stderrTruncatedCharacters = Math.max(0, report.stderrTotalCharacters - report.stderr.length);
  const reportPath = path.join(paths.root, "verification.json");
  try { await bounded(fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" }), 5_000, `${prefix}_REPORT_TIMEOUT`); }
  catch (error) { throw new AggregateError([...(knownError ? [knownError] : []), error], `${prefix}_REPORT_FAILED`); }
  console[knownError ? "error" : "log"](JSON.stringify({ code: `${prefix}_${report.status.toUpperCase()}`, requestId: report.requestId, reportPath, ...(knownError ? { failure: report.failure } : {}) }));
  if (knownError) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(process.argv.slice(2));
