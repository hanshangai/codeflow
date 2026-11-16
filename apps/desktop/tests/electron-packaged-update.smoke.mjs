import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import diagnostics from "node:diagnostics_channel";
import { buildDesktopDevicePayload, readDesktopDeviceHeaders, verifyDesktopDeviceSignature } from "@codeflowai/shared/desktop-device-auth";
import { assertDesktopUpdateReceipt } from "@codeflowai/shared/desktop-update-receipt";
import { assertUpdateFailureRecord } from "@codeflowai/shared/desktop-update-failure";
import { assertTrustedReleaseKeys, verifyReleaseBundleSignature } from "@codeflowai/shared/desktop-release-signing";
import { bounded, isolatedEnvironment, launchPackagedApp, waitUntil } from "./support/packaged-app.mjs";
import { preflight, failure, processIdentity, terminateObserved } from "./electron-packaged-protocol.smoke.mjs";

const prefix = "DESKTOP_PACKAGED_UPDATE";
const repository = fileURLToPath(new URL("../../..", import.meta.url));

/** Reject equality as well as either direction of path overlap. */
function outside(parent, target) {
  const relative = path.relative(parent, target);
  return relative.startsWith(".." + path.sep) || path.isAbsolute(relative);
}

/** Validate every input before creating evidence or launching a process. */
export async function preflightUpdate(args) {
  const [executable, good, bad, output, mode, ...extra] = args;
  assert.ok(executable && good && bad && output && !extra.length && (mode === undefined || mode === "--probe-cleanup" || mode === "--postpone"), prefix + "_ARGUMENTS_INVALID");
  const paths = await preflight([executable, output]);
  const trustedKeys = assertTrustedReleaseKeys(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    await fs.readFile(path.join(paths.resources, "release-trust.json")))));
  const bundles = {};
  for (const [name, input] of [["good", good], ["bad", bad]]) {
    const requested = path.resolve(input), directory = await fs.realpath(requested);
    for (const candidate of [requested, directory]) {
      assert.ok(outside(repository, candidate), prefix + "_BUNDLE_OUTSIDE_REPOSITORY_REQUIRED");
      for (const destination of [paths.root, paths.actualRoot]) {
        assert.ok(outside(candidate, destination) && outside(destination, candidate), prefix + "_BUNDLE_OUTPUT_OVERLAP");
      }
    }
    const manifestPath = path.join(directory, "manifest.json"), archivePath = path.join(directory, "bundle.tar.gz");
    for (const file of [manifestPath, archivePath]) {
      assert.equal((await fs.lstat(file)).isFile(), true, prefix + "_BUNDLE_FILE_REQUIRED");
      assert.ok(!outside(directory, await fs.realpath(file)), prefix + "_BUNDLE_FILE_OUTSIDE_ROOT");
    }
    const manifest = verifyReleaseBundleSignature(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(manifestPath))),
      trustedKeys, { platform: "win32", arch: "x64", requireFresh: true });
    assert.equal(manifest.platform, "win32"); assert.equal(manifest.arch, "x64");
    assert.ok(Number.isSafeInteger(manifest.dbSchemaVersion) && manifest.dbSchemaVersion > 0, prefix + "_SCHEMA_INVALID");
    assert.equal((await fs.stat(archivePath)).size, manifest.archiveSize);
    bundles[name] = { directory, manifestPath, archivePath, manifest };
  }
  assert.notEqual(bundles.good.manifest.releaseId, bundles.bad.manifest.releaseId, prefix + "_DISTINCT_RELEASES_REQUIRED");
  assert.equal(bundles.good.manifest.dbSchemaVersion, bundles.bad.manifest.dbSchemaVersion, prefix + "_SCHEMA_MISMATCH");
  return { ...paths, bundles, mode, dbSchemaVersion: bundles.good.manifest.dbSchemaVersion };
}

/** Revalidate identity immediately before terminating only the owned process. */
export async function cleanupObserved(records) {
  const errors = [];
  for (const record of [...records].reverse()) {
    try {
      const actual = processIdentity(record.pid);
      if (!actual) continue;
      assert.deepEqual(actual, record, prefix + "_CLEANUP_IDENTITY_CHANGED");
      terminateObserved(record);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, prefix + "_CLEANUP_FAILED");
}

/** Runtime server errors are recorded at their boundary, including after listen resolves. */
export async function listenFixture(server, errors) {
  server.on("error", error => { errors.push(error); });
  await new Promise((resolve, reject) => {
    /** Only startup rejection is temporary; the persistent handler owns all error records. */
    const startupError = error => { server.removeListener("listening", listening); reject(error); };
    /** Release the startup listener once the same server is actually listening. */
    const listening = () => { server.removeListener("error", startupError); resolve(); };
    server.once("error", startupError); server.once("listening", listening); server.listen(0, "127.0.0.1");
  });
}

/** A recorded fixture failure must prevent successful validation and preserve its cause. */
export function assertFixtureHealthy(errors) {
  if (errors.length) throw new AggregateError(errors, prefix + "_HTTP_FIXTURE_FAILED");
}

/** Query one launch tree or an explicit PID set; query failure stays unknown. */
function processSnapshot(rootPid, selectedPids) {
  const filter = selectedPids ? " -Filter '" + selectedPids.map(pid => "ProcessId = " + pid).join(" OR ") + "'" : "";
  const script = "$ErrorActionPreference='Stop'\n$all=@(Get-CimInstance Win32_Process" + filter + ")\n"
    + "$ids=[Collections.Generic.HashSet[int]]::new()\n"
    + (selectedPids ? selectedPids.map(pid => "[void]$ids.Add(" + pid + ")").join("\n") : "[void]$ids.Add(" + rootPid + ")")
    + "\ndo { $added=$false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added=$true } } } while ($added)\n"
    + "$result=@($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath;commandLine=$_.CommandLine} })\n"
    + "ConvertTo-Json -InputObject $result -Compress";
  const result = spawnSync(path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(prefix + "_PROCESS_QUERY_FAILED: " + result.status + ": " + result.stderr);
  const value = JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
  assert.ok(Array.isArray(value), prefix + "_PROCESS_ARRAY_REQUIRED"); return value;
}

/** Stream immutable archives instead of loading native payloads into memory. */
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Freeze executable, shell, complete Client and Web payload, trust and signed archives. */
async function artifactHashes(paths) {
  const files = { ...paths.files, trust: path.join(paths.resources, "release-trust.json") };
  /** Inventory only ordinary files in the read-only packaged payload. */
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, prefix + "_ARTIFACT_LINK_REJECTED");
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files[path.relative(paths.artifact, target)] = target;
    }
  }
  await walk(path.join(paths.resources, "client")); await walk(path.join(paths.resources, "web"));
  for (const [name, bundle] of Object.entries(paths.bundles)) { files[name + ":manifest"] = bundle.manifestPath; files[name + ":archive"] = bundle.archivePath; }
  const result = {}; for (const [name, file] of Object.entries(files)) result[name] = await bounded(digest(file), 60_000, prefix + "_HASH_TIMEOUT");
  for (const [name, bundle] of Object.entries(paths.bundles)) assert.equal(result[name + ":archive"], bundle.manifest.archiveSha256);
  return result;
}

/** Distinguish an optional absent journal from unreadable or corrupt evidence. */
async function jsonLines(file) {
  let bytes;
  try { bytes = await fs.readFile(file); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

/** Keep all scenarios on original application entrypoints and isolated data. */
export async function run(args) {
  const paths = await preflightUpdate(args), before = await artifactHashes(paths);
  await fs.mkdir(paths.root);
  const report = { requestId: crypto.randomUUID(), status: "running", root: paths.actualRoot, artifactBefore: before, scenarios: [],
    boundary: "unsigned Windows local dir package, real main/preload/Client/SQLite; loopback HTTP fixture, no PostgreSQL; busy confirmation uses a dialog adapter, not a human click" };
  let knownError;
  try { for (const mode of paths.mode === "--postpone" ? ["later"] : ["idle", "busy", "rollback"]) report.scenarios.push(await scenario(paths, report.requestId, mode)); }
  catch (error) { knownError = error; }
  try { report.artifactAfter = await artifactHashes(paths); assert.deepEqual(report.artifactAfter, before, prefix + "_ARTIFACT_CHANGED"); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_ARTIFACT_CHECK_FAILED"); }
  report.status = knownError ? "failed" : "passed"; if (knownError) report.failure = failure(knownError);
  await fs.writeFile(path.join(paths.root, "verification.json"), JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console[knownError ? "error" : "log"](JSON.stringify({ code: prefix + "_" + report.status.toUpperCase(), reportPath: path.join(paths.root, "verification.json"), failure: report.failure }));
  if (knownError) process.exitCode = 1; return report;
}

/** Exercise one update with real runtime control, retained facts and owned processes. */
async function scenario(paths, requestId, mode) {
  const root = path.join(paths.root, mode); await fs.mkdir(root);
  const bundle = paths.bundles[mode === "rollback" ? "bad" : "good"], manifest = bundle.manifest;
  const report = { mode, requestId, status: "running", traces: [], receipts: [], failures: [], serverErrors: [], processes: [], sessions: [], output: [] };
  const observed = new Map(), sessions = []; let current, scriptIdentity, gateOpen = false, closing = false, offerUpdate = true;
  let releaseGate; const gate = new Promise(resolve => { releaseGate = resolve; });
  const markerPath = path.join(root, "script-marker.json"), scriptFile = path.join(root, "long-task.ps1");
  const keys = new Map(), serverCauses = []; let knownError;

  /** Bind PID to executable, command, profile, creation time and trusted parent. */
  function observe(identity, role) {
    assert.ok(identity?.executable && identity.commandLine, prefix + "_IDENTITY_REQUIRED");
    if (observed.has(identity.pid)) { assert.deepEqual(observed.get(identity.pid).identity, identity, prefix + "_PID_REUSED"); return; }
    const expected = role === "launcher" ? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/cmd.exe")
      : role === "script" ? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe")
      : role === "script-console" ? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/conhost.exe") : paths.executable;
    assert.equal(path.resolve(identity.executable).toLowerCase(), path.resolve(expected).toLowerCase(), prefix + "_EXECUTABLE_MISMATCH");
    if (["main", "launcher", "electron-child"].includes(role)) assert.ok(identity.commandLine.toLowerCase().includes(path.join(root, "profile").toLowerCase()), prefix + "_PROFILE_MISMATCH");
    if (role === "client") {
      const command = identity.commandLine.toLowerCase();
      const initialEntry = path.join(paths.resources, "client/dist/index.cjs").toLowerCase();
      const targetEntry = path.join(root, "runtime/releases", manifest.releaseId, "client/dist/index.cjs").toLowerCase();
      assert.ok((command.includes(initialEntry) || command.includes(targetEntry)) && command.includes("--foreground"), prefix + "_CLIENT_COMMAND_INVALID");
    }
    if (role === "script") assert.ok(identity.commandLine.includes(scriptFile), prefix + "_SCRIPT_COMMAND_INVALID");
    if (role === "script-console") assert.equal(observed.get(identity.parentPid)?.role, "script");
    assert.ok(identity.parentPid === process.pid || observed.has(identity.parentPid), prefix + "_PARENT_UNCONFIRMED");
    const parent = observed.get(identity.parentPid); if (parent) assert.ok(identity.created >= parent.identity.created, prefix + "_PROCESS_CREATION_ORDER_INVALID");
    const value = { identity, role }; observed.set(identity.pid, value); report.processes.push(value);
  }

  /** Tree discovery failure stays unknown rather than becoming empty cleanup success. */
  function discover(session) {
    session.discovery = "unknown"; assert.ok(session.child?.pid, prefix + "_LAUNCH_ROOT_UNKNOWN");
    const tree = processSnapshot(session.child.pid), anchor = observed.get(session.child.pid); assert.ok(anchor, prefix + "_LAUNCH_ROOT_UNKNOWN");
    assert.deepEqual(tree.find(item => item.pid === session.child.pid), anchor.identity, prefix + "_LAUNCH_ROOT_CHANGED");
    const pending = tree.filter(item => item.pid !== session.child.pid);
    while (pending.length) {
      const index = pending.findIndex(item => observed.has(item.parentPid)); assert.notEqual(index, -1, prefix + "_PARENT_CHAIN_UNKNOWN");
      const identity = pending.splice(index, 1)[0];
      const role = identity.pid === session.mainPid ? "main" : identity.commandLine?.includes(scriptFile) ? "script"
        : identity.commandLine?.includes("index.cjs") && identity.commandLine.includes("--foreground") ? "client"
        : observed.get(identity.parentPid)?.role === "script" ? "script-console" : "electron-child";
      observe(identity, role);
    }
    session.discovery = "confirmed";
  }

  /** A single fresh snapshot preserves PID reuse and process-query failures. */
  function remaining() {
    const result = observed.size ? processSnapshot(0, [...observed.keys()]).map(identity => ({ identity, state: isDeepStrictEqual(identity, observed.get(identity.pid)?.identity) ? "alive" : "changed" })) : [];
    for (const session of sessions) if (session.discovery === "unknown") result.push({ state: "unknown-scope", launcherPid: session.child?.pid });
    return result;
  }

  /** Send real renderer IPC exit before checking all observed process identities. */
  async function exit(session) {
    discover(session);
    session.instrumentation = await session.application.evaluate(() => ({ confirmations: globalThis.__updateDialogs, errors: globalThis.__updateErrors, children: globalThis.__updateChildren, web: globalThis.__updateWeb }));
    await bounded(Promise.all([session.application.waitForEvent("close", { timeout: 40_000 }), session.page.evaluate(() => { void window.codeflowDesktop.exit(); })]), 42_000, prefix + "_EXIT_TIMEOUT");
    assert.equal(session.child.exitCode, 0, prefix + "_EXIT_NONZERO"); session.closed = true;
    await waitUntil(() => remaining().length === 0, 10_000, prefix + "_PROCESSES_REMAIN");
    report.sessions.push({ mainPid: session.mainPid, exitCode: session.child.exitCode, state: session.state, instrumentation: session.instrumentation });
    session.child.stdout?.destroy(); session.child.stderr?.destroy(); session.child.unref();
  }

  /** Settle the owned script and original response before normal exit; retain all failures. */
  async function cleanup() {
    const errors = [];
    let scriptSettled = !scriptIdentity;
    if (scriptIdentity) {
      report.cleanupScript = { status: "stopping", script: scriptIdentity, processes: [] };
      try {
        if (current && !current.closed) discover(current);
        assert.deepEqual(observed.get(scriptIdentity.pid)?.identity, scriptIdentity, prefix + "_CLEANUP_SCRIPT_UNCONFIRMED");
        const pids = new Set([scriptIdentity.pid]);
        let changed;
        do {
          changed = false;
          for (const { identity } of observed.values()) if (pids.has(identity.parentPid) && !pids.has(identity.pid)) { pids.add(identity.pid); changed = true; }
        } while (changed);
        const records = [...observed.values()].filter(item => pids.has(item.identity.pid)).map(item => item.identity);
        report.cleanupScript.processes = records;
        await cleanupObserved(records);
        for (const record of records) assert.equal(processIdentity(record.pid), null, prefix + "_CLEANUP_SCRIPT_STILL_ALIVE");
        report.cleanupScript.stoppedAt = Date.now();
        await waitUntil(() => Boolean(report.runNowResult), 40_000, prefix + "_CLEANUP_RUN_RESPONSE_TIMEOUT");
        report.cleanupScript.runNowResult = report.runNowResult;
        assert.equal(report.runNowResult.state, "resolved", prefix + "_CLEANUP_RUN_REJECTED");
        const response = report.runNowResult.result;
        assert.equal(response.status, 200); assert.equal(response.body?.ok, true);
        const run = response.body.run;
        assert.ok(run?.id); assert.equal(run.taskId, report.task.id); assert.equal(run.status, "failed");
        const history = (await ok("scheduledTasks.local.runs", { taskId: report.task.id, limit: 200 })).items;
        assert.equal(history.length, 1);
        const { source, configRevision, taskNameSnapshot, ...persistedRun } = history[0];
        assert.equal(source, "local"); assert.equal(configRevision, report.task.revision); assert.equal(taskNameSnapshot, report.task.name);
        assert.deepEqual(persistedRun, run);
        report.cleanupScript.run = run; report.cleanupScript.status = "settled";
        report.cleanupScript.settledAt = Date.now(); scriptSettled = true;
      } catch (error) { report.cleanupScript.status = "failed"; report.cleanupScript.failure = failure(error); errors.push(error); }
    }
    for (const session of sessions.filter(item => !item.closed && scriptSettled)) {
      try {
        if (session.child && observed.has(session.child.pid)) discover(session);
        await exit(session);
      } catch (error) { errors.push(error); }
    }
    try { await cleanupObserved([...observed.values()].map(item => item.identity)); } catch (error) { errors.push(error); }
    try { report.remainingProcesses = remaining(); if (report.remainingProcesses.length) throw new Error(prefix + "_PROCESSES_REMAIN"); } catch (error) { errors.push(error); }
    for (const session of sessions) { session.child?.stdout?.destroy(); session.child?.stderr?.destroy(); session.child?.unref(); }
    if (errors.length) throw new AggregateError(errors, prefix + "_CLEANUP_FAILED");
  }

  /** Preserve transport and business failure when exercising the original bridge. */
  async function ok(method, body = {}) {
    const response = await bounded(current.page.evaluate(input => window.codeflowDesktop.request(input), { method, body }), 40_000, prefix + "_BRIDGE_TIMEOUT: " + method);
    assert.equal(response.status, 200, JSON.stringify(response)); assert.equal(response.body?.ok, true, JSON.stringify(response)); return response.body;
  }

  /** Simulate the requested confirmation choice and retain every product error. */
  async function installDialogAdapter(session) {
    await session.application.evaluate(({ dialog, BrowserWindow, app, net }, postpone) => {
      globalThis.__updateDialogs = []; globalThis.__updateErrors = []; globalThis.__updateChildren = [];
      globalThis.__updateWeb = [];
      const originalFetch = net.fetch;
      /** Retain the original protocol fetch outcome while recording its exact failing URL. */
      net.fetch = async function (...args) {
        try { return await Reflect.apply(originalFetch, this, args); }
        catch (error) { globalThis.__updateWeb.push({ kind: "protocol-file-fetch-failed", at: Date.now(), url: String(args[0]), message: error.message }); throw error; }
      };
      const nativeProcesses = process.getBuiltinModule("node:child_process"), originalSpawn = nativeProcesses.spawn;
      /** Pass identical spawn inputs through and only observe the returned original child. */
      nativeProcesses.spawn = function (...args) {
        const child = Reflect.apply(originalSpawn, this, args);
        if (!args[1]?.includes("--foreground")) return child;
        const record = { executable: child.spawnfile, args: child.spawnargs, at: Date.now() };
        globalThis.__updateChildren.push(record);
        child.on("spawn", () => {
          record.pid = child.pid;
          const command = "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + child.pid + "'; if ($null -eq $p) { throw 'UPDATE_CHILD_ALREADY_EXITED' }; @{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;created=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;commandLine=$p.CommandLine} | ConvertTo-Json -Compress";
          const result = process.getBuiltinModule("node:child_process").spawnSync(process.env.SystemRoot + "/System32/WindowsPowerShell/v1.0/powershell.exe",
            ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { encoding: "utf8", timeout: 10_000, windowsHide: true });
          if (result.error || result.status !== 0) { record.identityFailure = { message: result.error?.message, status: result.status, stderr: result.stderr }; return; }
          record.identity = JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
        });
        child.on("message", message => { if (message?.t === "desktop.ready") record.ready = message; });
        child.on("exit", (code, signal) => { record.exit = { code, signal, at: Date.now() }; });
        return child;
      };
      process.getBuiltinModule("node:module").syncBuiltinESMExports();
      /** Only observe protocol requests and navigation; do not intercept or fulfill resources. */
      const watchWindow = window => {
        const contents = window.webContents;
        contents.session.webRequest.onErrorOccurred(details => { globalThis.__updateWeb.push({ kind: "request-failed", at: Date.now(), url: details.url, error: details.error, resourceType: details.resourceType, webContentsId: details.webContentsId }); });
        contents.on("did-fail-load", (_event, code, description, url, mainFrame) => { globalThis.__updateWeb.push({ kind: "load-failed", at: Date.now(), code, description, url, mainFrame }); });
        contents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => { globalThis.__updateWeb.push({ kind: "navigation-start", at: Date.now(), url, inPlace, mainFrame }); });
        contents.on("did-finish-load", () => { globalThis.__updateWeb.push({ kind: "navigation-finished", at: Date.now(), url: contents.getURL() }); });
      };
      for (const window of BrowserWindow.getAllWindows()) watchWindow(window);
      app.on("browser-window-created", (_event, window) => watchWindow(window));
      dialog.showMessageBox = async (_window, options) => {
        if (options.title !== "CodeFlow 更新" || options.buttons?.length !== 2 || options.buttons[0] !== "立即更新" || options.buttons[1] !== "稍后") throw new Error("UNEXPECTED_CONFIRMATION_DIALOG");
        const response = postpone ? 1 : 0;
        globalThis.__updateDialogs.push({ title: options.title, message: options.message, buttons: options.buttons, response, at: Date.now() });
        return { response, checkboxChecked: false };
      };
      dialog.showErrorBox = (title, content) => { globalThis.__updateErrors.push({ title, content, at: Date.now() }); };
    }, mode === "later");
  }

  /** Launch original packaged main, preload and Client in one isolated profile. */
  async function launch(env) {
    const session = { discovery: "unknown", closed: false }; sessions.push(session);
    const profile = path.join(root, "profile"), channel = diagnostics.channel("child_process");
    /** Capture the real launcher even when Playwright rejects before returning its application. */
    const onSpawn = ({ process: child }) => {
      const args = child.spawnargs?.join(" ").toLowerCase() ?? "";
      if (!args.includes(paths.executable.toLowerCase()) || !args.includes(profile.toLowerCase())) return;
      session.child = child;
      child.once("spawn", () => {
        try {
          const identity = processIdentity(child.pid); assert.ok(identity, prefix + "_EARLY_LAUNCH_IDENTITY_ABSENT");
          observe(identity, path.resolve(identity.executable).toLowerCase() === paths.executable.toLowerCase() ? "main" : "launcher");
        } catch (error) { session.earlyIdentityFailure = failure(error); }
      });
    };
    channel.subscribe(onSpawn);
    try { Object.assign(session, await launchPackagedApp({ executablePath: paths.executable, userDataDir: profile, env, cwd: root, timeoutMs: 60_000 })); }
    finally { channel.unsubscribe(onSpawn); }
    current = session; assert.equal(session.earlyIdentityFailure, undefined, prefix + "_EARLY_LAUNCH_IDENTITY_FAILED");
    session.output = { launch: sessions.length, stdout: "", stderr: "", stdoutCharacters: 0, stderrCharacters: 0 }; report.output.push(session.output);
    for (const name of ["stdout", "stderr"]) session.child[name]?.setEncoding("utf8").on("data", chunk => {
      session.output[name + "Characters"] += chunk.length; session.output[name] = (session.output[name] + chunk).slice(-262_144);
    });
    const anchor = processIdentity(session.child.pid); assert.ok(anchor);
    const direct = path.resolve(anchor.executable).toLowerCase() === paths.executable.toLowerCase(); observe(anchor, direct ? "main" : "launcher");
    session.mainPid = await bounded(session.application.evaluate(() => process.pid), 15_000, prefix + "_MAIN_PID_TIMEOUT");
    observe(processIdentity(session.mainPid), "main"); await installDialogAdapter(session);
    session.page = await session.application.firstWindow({ timeout: 60_000 });
    await session.page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
    await session.page.waitForFunction(async () => (await window.codeflowDesktop?.getState())?.status === "ready", undefined, { timeout: 60_000 });
    session.state = await session.page.evaluate(() => window.codeflowDesktop.getState());
    assert.equal(session.state.health.database, "ready"); assert.equal(session.state.health.dbSchemaVersion, paths.dbSchemaVersion);
    observe(processIdentity(session.state.pid), "client"); discover(session); return session;
  }

  /** Successful fixture responses keep exact envelopes and no hidden defaults. */
  function respond(response, value) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }

  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks = []; let count = 0;
      for await (const chunk of request) { count += chunk.length; assert.ok(count < 1024 * 1024, prefix + "_HTTP_BODY_LIMIT"); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), body = bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined;
      const metadata = readDesktopDeviceHeaders(request.rawHeaders), url = new URL(request.url, "http://fixture.invalid");
      const publicKey = url.pathname.endsWith("/devices/register") ? body.publicKeyBase64 : keys.get(metadata.deviceId);
      verifyDesktopDeviceSignature(publicKey, buildDesktopDevicePayload({ ...metadata, method: request.method, url: request.url, body: bytes }), metadata.signature);
      report.traces.push({ method: request.method, url: request.url, deviceId: metadata.deviceId, requestId: metadata.requestId, at: Date.now() });
      if (url.pathname.endsWith("/devices/register")) {
        assert.equal(body.deviceId, metadata.deviceId); const prior = keys.get(body.deviceId); if (prior) assert.equal(prior, publicKey); keys.set(body.deviceId, publicKey);
        respond(response, { ok: true, deviceId: body.deviceId, publicKeySha256: crypto.createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex") });
      } else if (url.pathname.endsWith("/release-availability")) {
        if (!gateOpen && !closing) {
          const startedAt = Date.now(); await bounded(gate, 25_000, prefix + "_AVAILABILITY_GATE_TIMEOUT");
          report.availabilityGateWaitMs = Date.now() - startedAt;
          assert.ok(report.availabilityGateWaitMs < 25_000, prefix + "_AVAILABILITY_GATE_EXCEEDED");
        }
        if (closing || !offerUpdate) return respond(response, { ok: true, available: false, deviceId: metadata.deviceId, requestId: metadata.requestId });
        respond(response, { ok: true, available: true, deviceId: metadata.deviceId, requestId: metadata.requestId, manifest });
      } else if (url.pathname === "/api/software/desktop/releases/" + manifest.releaseId + "/archive") {
        const range = metadata.range ? /^bytes=(\d+)-$/u.exec(metadata.range) : null;
        assert.ok(!metadata.range || range); const start = range ? Number(range[1]) : 0;
        assert.ok(start < manifest.archiveSize); if (metadata.ifMatch) assert.equal(metadata.ifMatch, '"' + manifest.archiveSha256 + '"');
        response.writeHead(range ? 206 : 200, { etag: '"' + manifest.archiveSha256 + '"', "content-length": manifest.archiveSize - start,
          ...(range ? { "content-range": "bytes " + start + "-" + (manifest.archiveSize - 1) + "/" + manifest.archiveSize } : {}) });
        const stream = createReadStream(bundle.archivePath, { start });
        try {
          await bounded(new Promise((resolve, reject) => {
            stream.once("error", reject); response.once("finish", resolve); response.once("error", reject);
            response.once("close", () => { if (!response.writableFinished) reject(new Error(prefix + "_ARCHIVE_RESPONSE_CLOSED")); });
            stream.pipe(response);
          }), 60_000, prefix + "_ARCHIVE_RESPONSE_TIMEOUT");
        } finally { stream.destroy(); }
      } else if (url.pathname.endsWith("/switch-authorization")) {
        respond(response, { ok: true, authorized: true, deviceId: metadata.deviceId, requestId: metadata.requestId, releaseId: manifest.releaseId, archiveSha256: manifest.archiveSha256 });
      } else if (url.pathname.endsWith("/update-receipts")) {
        assertDesktopUpdateReceipt(body);
        assert.equal(body.deviceId, metadata.deviceId); assert.equal(body.requestId, metadata.requestId); assert.equal(body.releaseId, manifest.releaseId); assert.equal(body.archiveSha256, manifest.archiveSha256);
        if (body.stage === "switched" && scriptIdentity) assert.equal(processIdentity(scriptIdentity.pid), null, prefix + "_SCRIPT_ALIVE_AT_SWITCHED");
        report.receipts.push(body); respond(response, { ok: true, ...Object.fromEntries(["deviceId", "requestId", "releaseId", "archiveSha256", "stage", "at", "payloadSha256"].map(key => [key, body[key]])) });
      } else if (url.pathname.endsWith("/update-failures")) {
        assertUpdateFailureRecord(body);
        assert.equal(body.deviceId, metadata.deviceId); assert.equal(body.errorId, metadata.requestId); report.failures.push(body);
        respond(response, { ok: true, errorId: body.errorId, deviceId: body.deviceId, payloadSha256: body.payloadSha256 });
      } else throw new Error(prefix + "_UNEXPECTED_HTTP_PATH: " + url.pathname);
    })().catch(error => {
      serverCauses.push(error); report.serverErrors.push(failure(error));
      if (!response.headersSent) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: false, code: "FIXTURE_HTTP_FAILURE" })); }
      else response.destroy(error);
    });
  });

  try {
    await listenFixture(server, serverCauses);
    const env = await isolatedEnvironment(root, { CODEFLOWAI_DESKTOP_SERVER_ORIGIN: "http://127.0.0.1:" + server.address().port });
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT; env.PATH = [path.join(systemRoot, "System32/WindowsPowerShell/v1.0"), path.join(systemRoot, "System32"), systemRoot].join(path.delimiter);
    await launch(env); const initial = current.state; report.initialState = initial;
    report.initialRuntime = await ok("runtime.info");
    const identityBefore = await fs.readFile(path.join(root, "runtime/device-identity.json")); report.identitySha256 = crypto.createHash("sha256").update(identityBefore).digest("hex");
    const releaseScript = path.join(root, "release-script");
    const waitScript = mode === "later" ? "$deadline=[DateTime]::UtcNow.AddSeconds(180); while (-not (Test-Path -LiteralPath '" + releaseScript.replaceAll("'", "''") + "')) { if ([DateTime]::UtcNow -ge $deadline) { throw 'POSTPONE_SCRIPT_RELEASE_TIMEOUT' }; Start-Sleep -Milliseconds 100 }" : "Start-Sleep -Seconds 180";
    await fs.writeFile(scriptFile, "\uFEFF" + "$ErrorActionPreference='Stop'\r\n[IO.File]::WriteAllText('" + markerPath.replaceAll("'", "''") + "',(@{requestId='" + requestId + "';pid=$PID} | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))\r\n" + waitScript + "\r\n[IO.File]::WriteAllText('" + path.join(root, "unexpected-script-finished").replaceAll("'", "''") + "', 'finished')\r\n", { encoding: "utf8", flag: "wx" });
    report.task = (await ok("scheduledTasks.local.create", { name: "D12p " + mode + " " + requestId, description: "update persistence marker", taskType: "script",
      cronExpr: "0 0 1 1 *", timezone: "UTC", enabled: true, payload: { shell: "powershell", command: "& '" + scriptFile.replaceAll("'", "''") + "'", contextWorkspaceId: null, cwdRelative: ".", envRefs: [] },
      concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 240_000 })).task;
    if (mode === "busy" || mode === "later") {
      await current.page.exposeBinding("__d12pCaptureRun", (_source, result) => { report.runNowResult = result; });
      await current.page.evaluate(taskId => {
        window.__d12pRun = { state: "pending" };
        void window.codeflowDesktop.request({ method: "scheduledTasks.local.runNow", body: { taskId } }).then(
          async result => { window.__d12pRun = { state: "resolved", result }; await window.__d12pCaptureRun(window.__d12pRun); },
          async error => { window.__d12pRun = { state: "rejected", message: error.message }; await window.__d12pCaptureRun(window.__d12pRun); });
      }, report.task.id);
      let marker; await waitUntil(async () => { try { marker = JSON.parse(await fs.readFile(markerPath, "utf8")); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }, 20_000, prefix + "_SCRIPT_MARKER_TIMEOUT");
      assert.equal(marker.requestId, requestId); scriptIdentity = processIdentity(marker.pid); observe(scriptIdentity, "script"); discover(current); report.script = scriptIdentity;
      if (paths.mode === "--probe-cleanup") throw new Error(prefix + "_EXPECTED_FAILURE_WITH_LIVE_SCRIPT");
    }
    gateOpen = true; releaseGate();
    if (mode === "later") {
      await waitUntil(async () => (await current.application.evaluate(() => globalThis.__updateDialogs.length)) === 1, 60_000, prefix + "_POSTPONE_CONFIRMATION_TIMEOUT");
      // A successful write proves original admission resumed while the first script still runs.
      const probeInput = Object.fromEntries(["description", "taskType", "cronExpr", "timezone", "payload", "concurrencyPolicy", "missedPolicy", "timeoutMs"].map(key => [key, report.task[key]]));
      const probe = (await ok("scheduledTasks.local.create", { ...probeInput, name: "after postpone", enabled: false })).task;
      await ok("scheduledTasks.local.delete", { taskId: probe.id, expectedRevision: probe.revision });
      const state = await current.page.evaluate(() => window.codeflowDesktop.getState());
      assert.equal(state.pid, initial.pid); assert.equal(state.releaseId, initial.releaseId);
      assert.ok(processIdentity(scriptIdentity.pid), prefix + "_POSTPONE_INTERRUPTED_SCRIPT");
      assert.deepEqual(report.receipts.map(item => item.stage), ["received", "verified", "prepared"]);
      assert.equal(new Set(report.receipts.map(item => item.requestId)).size, 1);
      report.postponed = { requestId: report.receipts[0].requestId, state, confirmations: await current.application.evaluate(() => globalThis.__updateDialogs), scriptAlive: true };
      await fs.writeFile(releaseScript, "release", { flag: "wx" });
      await waitUntil(() => Boolean(report.runNowResult), 40_000, prefix + "_POSTPONE_RUN_RESPONSE_TIMEOUT");
      assert.equal(report.runNowResult.state, "resolved"); assert.equal(report.runNowResult.result.status, 200); assert.equal(report.runNowResult.result.body?.ok, true);
      assert.equal(report.runNowResult.result.body.run.status, "success");
      report.postponed.run = report.runNowResult.result.body.run;
      assert.equal((await ok("scheduledTasks.local.runs", { taskId: report.task.id, limit: 200 })).items[0]?.status, "success");
      await waitUntil(() => processIdentity(scriptIdentity.pid) === null, 10_000, prefix + "_POSTPONE_SCRIPT_EXIT_TIMEOUT");
      scriptIdentity = undefined;
      await exit(current);
      assert.equal(current.instrumentation.confirmations.length, 1);
      assert.equal(current.instrumentation.confirmations[0].response, 1);
      // Suppression belongs to this application run; the next launch resumes the original automatic check.
      await launch(env);
    }
    const terminalStage = mode === "rollback" ? "rolled_back" : "healthy";
    await waitUntil(() => report.receipts.some(item => item.stage === terminalStage) || serverCauses.length > 0, 180_000, prefix + "_TERMINAL_RECEIPT_TIMEOUT");
    assertFixtureHealthy(serverCauses);
    await waitUntil(async () => (await jsonLines(path.join(root, "runtime/update-receipts.jsonl"))).some(item => item.kind === "ack" && item.ack.stage === terminalStage), 30_000, prefix + "_TERMINAL_ACK_TIMEOUT");
    if (mode === "rollback") await waitUntil(async () => await current.application.evaluate(() => globalThis.__updateErrors.length) === 1, 15_000, prefix + "_ROLLBACK_ERROR_DISPLAY_TIMEOUT");
    await current.page.waitForFunction(async () => (await window.codeflowDesktop?.getState())?.status === "ready", undefined, { timeout: 60_000 });
    current.state = await current.page.evaluate(() => window.codeflowDesktop.getState()); report.updatedState = current.state;
    observe(processIdentity(current.state.pid), "client"); discover(current);
    assert.notEqual(current.state.pid, initial.pid); assert.equal(processIdentity(initial.pid), null);
    assert.equal((await ok("runtime.info")).client.clientId, report.initialRuntime.client.clientId);
    assert.deepEqual((await ok("scheduledTasks.local.list", { limit: 200 })).items.find(item => item.id === report.task.id), report.task);
    assert.deepEqual(await fs.readFile(path.join(root, "runtime/device-identity.json")), identityBefore);
    report.dialogs = await current.application.evaluate(() => ({ confirmations: globalThis.__updateDialogs, errors: globalThis.__updateErrors, children: globalThis.__updateChildren, web: globalThis.__updateWeb }));
    for (const child of report.dialogs.children) {
      assert.equal(child.identityFailure, undefined, prefix + "_UPDATED_CHILD_IDENTITY_FAILED");
      observe(child.identity, "client");
      assert.ok(child.exit || child.pid === current.state.pid, prefix + "_UPDATED_CHILD_NOT_SETTLED");
      if (child.exit) assert.equal(processIdentity(child.pid), null, prefix + "_EXITED_CHILD_STILL_PRESENT");
    }
    assert.equal(report.dialogs.confirmations.length, mode === "busy" ? 1 : 0);
    // A postponed application run retains three receipts; restarting creates a distinct complete attempt.
    const completedReceipts = mode === "later" ? report.receipts.slice(3) : report.receipts;
    const stages = report.receipts.map(item => item.stage);
    const completedStages = mode === "rollback" ? ["received", "verified", "prepared", "rolled_back"] : ["received", "verified", "prepared", "switched", "healthy"];
    assert.deepEqual(stages, mode === "later" ? ["received", "verified", "prepared", ...completedStages] : completedStages);
    assert.equal(new Set(completedReceipts.map(item => item.requestId)).size, 1);
    if (mode === "later") assert.notEqual(completedReceipts[0].requestId, report.postponed.requestId);
    if (mode === "rollback") {
      assert.equal(current.state.releaseId, "installation"); assert.equal(current.state.health.clientVersion, initial.health.clientVersion);
      assert.equal(report.dialogs.errors.length, 1); assert.match(report.dialogs.errors[0].content, /CLIENT_HEALTH_VERSION_MISMATCH/u);
      report.localFailures = (await jsonLines(path.join(root, "runtime/errors.jsonl"))).filter(item => item.kind === "failure");
      assert.equal(report.localFailures.length, 1); assert.equal(report.localFailures[0].recovery, "restored");
      assert.equal(report.localFailures[0].phase, "restart-client");
      await assert.rejects(fs.access(path.join(root, "runtime/active-release.json")), { code: "ENOENT" });
      offerUpdate = false;
    } else { assert.equal(current.state.releaseId, manifest.releaseId); assert.equal(current.state.health.clientVersion, manifest.clientVersion); assert.deepEqual(report.dialogs.errors, []); }
    if (mode === "busy") {
      report.runs = (await ok("scheduledTasks.local.runs", { taskId: report.task.id, limit: 200 })).items;
      assert.equal(report.runs.length, 1); assert.equal(report.runs[0].status, "failed");
      assert.match(JSON.stringify(report.runs[0]), /SCHEDULED_TASK_INTERRUPTED_FOR_UPDATE/u); assert.equal(processIdentity(scriptIdentity.pid), null);
      await assert.rejects(fs.access(path.join(root, "unexpected-script-finished")), { code: "ENOENT" });
      report.runPromise = report.runNowResult;
      assert.equal(report.runPromise?.state, "resolved");
      assert.equal(report.runPromise.result.status, 200); assert.equal(report.runPromise.result.body?.ok, true);
      assert.equal(report.runPromise.result.body.run.id, report.runs[0].id);
      assert.equal(report.runPromise.result.body.run.status, "failed");
    }
    report.receiptJournal = await jsonLines(path.join(root, "runtime/update-receipts.jsonl"));
    assert.equal(report.receiptJournal.filter(item => item.kind === "receipt").length, stages.length);
    assert.equal(report.receiptJournal.filter(item => item.kind === "ack").length, stages.length);
    const archiveCount = report.traces.filter(item => item.url.endsWith("/archive")).length; assert.equal(archiveCount, 1);
    await exit(current);
    const db = new DatabaseSync(path.join(root, "runtime/codeflowai.db"), { readOnly: true });
    let dbError;
    try { report.sqlite = { schema: db.prepare("PRAGMA user_version").get().user_version, task: db.prepare("SELECT id, revision, name FROM scheduled_task_configs WHERE id=?").get(report.task.id) }; assert.equal(report.sqlite.schema, paths.dbSchemaVersion); assert.equal(report.sqlite.task.revision, 1); }
    catch (error) { dbError = error; }
    try { db.close(); } catch (error) { throw new AggregateError([...(dbError ? [dbError] : []), error], prefix + "_DB_CLOSE_FAILED"); }
    if (dbError) throw dbError;
    await launch(env);
    assert.equal(current.state.releaseId, mode === "rollback" ? initial.releaseId : manifest.releaseId);
    assert.equal((await ok("runtime.info")).client.clientId, report.initialRuntime.client.clientId);
    assert.deepEqual((await ok("scheduledTasks.local.list", { limit: 200 })).items.find(item => item.id === report.task.id), report.task);
    if (mode === "rollback") {
      await waitUntil(() => report.failures.length === 1 || serverCauses.length > 0, 30_000, prefix + "_FAILURE_UPLOAD_TIMEOUT");
      assert.equal(report.failures[0].errorId, report.localFailures[0].errorId); assert.equal(report.failures[0].requestId, report.localFailures[0].requestId);
      await waitUntil(async () => (await jsonLines(path.join(root, "runtime/errors.jsonl"))).some(item => item.kind === "ack" && item.errorId === report.localFailures[0].errorId), 30_000, prefix + "_FAILURE_ACK_TIMEOUT");
    } else {
      await waitUntil(() => report.traces.filter(item => item.url.includes("/release-availability")).length >= 2 || serverCauses.length > 0, 30_000, prefix + "_RESTART_CHECK_TIMEOUT");
    }
    closing = true; await exit(current);
    assert.deepEqual(await fs.readFile(path.join(root, "runtime/device-identity.json")), identityBefore);
    assert.equal(report.traces.filter(item => item.url.endsWith("/archive")).length, mode === "rollback" ? archiveCount : 1);
    assertFixtureHealthy(serverCauses); report.remainingProcesses = remaining(); assert.deepEqual(report.remainingProcesses, []);
    report.clientErrors = [];
    for (const filename of await fs.readdir(path.join(root, "runtime/logs"))) {
      if (!/^client.*\.log$/u.test(filename)) continue;
      const entries = (await fs.readFile(path.join(root, "runtime/logs", filename), "utf8")).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
      report.clientErrors.push(...entries.filter(entry => entry.level === "ERROR"));
    }
    if (mode === "busy") {
      assert.equal(report.clientErrors.length, 1, prefix + "_UNEXPECTED_CLIENT_ERRORS");
      const entry = report.clientErrors[0]; assert.equal(entry.code, "SCHEDULED_TASK_INTERRUPTED_FOR_UPDATE");
      assert.equal(entry.runId, report.runs[0].id); assert.equal(entry.requestId, report.runs[0].id); assert.equal(entry.taskId, report.task.id);
    } else assert.deepEqual(report.clientErrors, [], prefix + "_UNEXPECTED_CLIENT_ERRORS");
    report.desktopErrors = await jsonLines(path.join(root, "runtime/logs/desktop-errors.jsonl"));
    report.runtimeErrors = await jsonLines(path.join(root, "runtime/logs/desktop-runtime-errors.jsonl"));
    if (mode === "rollback") {
      assert.equal(report.desktopErrors.length, 1); assert.match(report.desktopErrors[0].rootCause, /CLIENT_HEALTH_VERSION_MISMATCH/u);
      assert.equal(report.desktopErrors[0].requestId, report.localFailures[0].requestId); assert.ok(report.desktopErrors[0].deviceId);
      assert.equal(report.runtimeErrors.length, 1); assert.match(report.runtimeErrors[0].rootCause, /CLIENT_HEALTH_VERSION_MISMATCH/u);
    } else { assert.deepEqual(report.desktopErrors, []); assert.deepEqual(report.runtimeErrors, []); }
  } catch (error) { knownError = error; }
  closing = true; gateOpen = true; releaseGate();
  if (knownError) { try { await cleanup(); } catch (error) { knownError = new AggregateError([knownError, error], prefix + "_VERIFICATION_AND_CLEANUP_FAILED"); } }
  try { server.closeAllConnections(); await bounded(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 10_000, prefix + "_HTTP_CLOSE_TIMEOUT"); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_HTTP_CLEANUP_FAILED"); }
  report.serverErrors = serverCauses.map(failure);
  if (serverCauses.length) knownError = new AggregateError([...(knownError ? [knownError] : []), ...serverCauses], prefix + "_HTTP_FIXTURE_FAILED");
  report.status = knownError ? "failed" : "passed"; if (knownError) report.failure = failure(knownError);
  await fs.writeFile(path.join(root, "verification.json"), JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ code: prefix + "_SCENARIO", mode, status: report.status, root }));
  if (knownError) throw knownError; return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(process.argv.slice(2));
