import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import crypto from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { DESKTOP_STARTUP_CAPABILITY_PATH } from "@codeflowai/shared";
import { signReleaseBundleManifest, readReleaseBundleFiles, computeReleaseDirectorySha256, computeReleasePackageSha256 } from "@codeflowai/shared/desktop-release-signing";
import { createShellUpdateAttemptStore, createShellUpdateAttemptNetworkAdapter, isShellUpdateHandoffAttempt, shellUpdateHandoffRevision, shellUpdateProcessHistory,
  type ShellUpdateAttemptV2, type ShellUpdateAttemptV3, type ShellUpdateHandoffAttempt, type ShellUpdatePreparationAttemptV5 } from "../src/shellUpdateAttempt.js";
import { createUpdateNetworkRetry } from "../src/updateNetworkRetry.js";
import type { ProcessIdentity } from "../src/windowsProcessIdentity.js";
import { serializeShellLaunchState } from "../src/shellLaunchState.js";

/** 首轮缺入口产生行为RED，后续使用真实store/INI和受控实例边界。 */
async function api() {
  assert.ok(existsSync(new URL("../src/shellHandoff.ts", import.meta.url)), "normal main handoff boundary must exist");
  return await import("../src/shellHandoff.js");
}

/** 真实本地attempt与INI；等待预算容纳磁盘往返，超时合同由独立用例验证。 */
async function fixture(lifecycle: boolean | 5 = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cf-main-handoff-")));
  const installationDir = path.join(root, "installation"), dataDir = path.join(root, "data");
  const userDataDir = path.join(root, "user"), sessionDataDir = path.join(root, "session");
  for (const directory of [dataDir, userDataDir, sessionDataDir]) await fs.mkdir(directory);
  for (const shell of ["old", "new", "baseline"]) {
    const dir = path.join(installationDir, "shells", shell); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "CodeFlowAI.exe"), "fixture");
  }
  const baselineDir = path.join(installationDir, "shells", "baseline", "resources");
  for (const file of ["web/index.html", "client/dist/index.cjs", "release-trust.json"]) {
    const target = path.join(baselineDir, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, "fixture");
  }
  const originalState = { activeShellId: "old", previousShellId: null, baselineShellId: "baseline" };
  const candidateState = { activeShellId: "new", previousShellId: "old", baselineShellId: "baseline" };
  const processIdentity = (pid: number, parentPid: number, shell = "old"): ProcessIdentity => ({ pid, parentPid, created: 1000 + pid,
    executable: path.join(installationDir, "shells", shell, "CodeFlowAI.exe"), commandLine: `fixture-${pid}` });
  const oldMain = processIdentity(101, 90), helper = processIdentity(102, 101), main = processIdentity(103, 102, "new");
  const client = { ...processIdentity(104, 103, "new"), executable: path.join(root, "node.exe") };
  const health = { protocolVersion: 1 as const, clientVersion: "1.0", dbSchemaVersion: 7, database: "ready" as const };
  const store = createShellUpdateAttemptStore(dataDir);
  const fresh = { schemaVersion: 2, requestId: "attempt:1", revision: 0, installationDir, dataDir, userDataDir, sessionDataDir,
    originalState, binding: { kind: "installation", baselineShellId: "baseline", health }, retriesUsed: 0, phase: "preparing", target: null, candidateState: null, network: null };
  const preparationClient = { ...client, pid: 109, parentPid: oldMain.pid, commandLine: "preparation client" };
  const initial = lifecycle === 5 ? await store.beginPreparation(null, fresh, { main: oldMain, client: preparationClient,
    readyRequestId: "fixture-preparation-ready", processes: [oldMain, preparationClient] }) : await store.replace(null, fresh);
  const dispatch = await store.replace(initial, { ...initial, revision: initial.revision + 1, network: { actionKey: "discover", requestSha256: "a".repeat(64), status: "dispatching" } }) as ShellUpdateAttemptV2 | ShellUpdatePreparationAttemptV5;
  const prepared = await store.replace(dispatch, { ...dispatch, revision: dispatch.revision + 1, target: { shellId: "new", manifestSha256: "b".repeat(64), installerSha256: "c".repeat(64), installerSize: 1 },
    candidateState, network: { ...dispatch.network!, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "d".repeat(64) } } });
  const handoff = prepared.schemaVersion === 5 && !isShellUpdateHandoffAttempt(prepared) ? await store.beginHandoff(prepared, {
    lifecycle: true, continuationId: "continuation-1", oldMain, helper, processes: [oldMain, helper] }) : await store.beginHandoff(prepared, { continuationId: "continuation-1", oldMain, helper,
      ...(lifecycle ? { lifecycle: true, processes: [oldMain, helper], knownOwned: [] } : {}) });
  let selected = await store.replace(handoff, { ...handoff, revision: handoff.revision + 1, selectedMain: main }) as ShellUpdateHandoffAttempt;
  if (lifecycle) selected = await store.observeHandoffOwned(selected, { caller: helper, processes: [helper, main, client] });
  await fs.writeFile(path.join(installationDir, "shell-launch.ini"), "[shell]\r\nschema=1\r\nactive=new\r\nprevious=old\r\nbaseline=baseline\r\n");
  const channel = Object.assign(new EventEmitter(), { connected: true, sent: [] as any[],
    send(this: EventEmitter & { sent: any[] }, value: unknown, callback: (error: Error | null) => void): boolean { this.sent.push(value); this.emit("sent"); callback(null); return true; } });
  const nonce = "e".repeat(64);
  const message = (kind: string, body: unknown = {}, revision = shellUpdateHandoffRevision(selected)) => ({ t: "desktop.shell-handoff", schemaVersion: 1, kind,
    requestId: selected.requestId, continuationId: selected.continuationId, revision, nonce, body });
  const snapshot = async () => [helper, main, client];
  const input = { executablePath: main.executable, pid: main.pid, parentPid: helper.pid, dataDir, userDataDir, sessionDataDir,
    argv: ["app", "--user-data-dir=" + userDataDir, "--codeflow-shell-handoff"], channel, snapshot, timeoutMs: 10_000 };
  const facts = { client: { status: "ready" as const, requestId: "client-ready-1", pid: client.pid, health, releaseId: null, errorCode: null,
    startup: { continuationId: selected.continuationId, admission: "paused" as const } }, baseline: { releaseDir: baselineDir,
      manifest: { clientVersion: "1.0", protocolVersion: 1, dbSchemaVersion: 7 } as any }, active: null,
    web: { loaded: true as const, releaseDir: baselineDir }, continueRequestId: "application-continue-1" };
  return { root, store, selected, main, helper, client, input, channel, message, facts, snapshot };
}

/** 用原retry/adapter从preparing生成真实网络失败，保持完整S0与实际已用预算。 */
async function prehandoffFailureFixture(selected: boolean) {
  const f = await fixture(), dataDir = path.join(f.root, "failed-data"); await fs.mkdir(dataDir);
  const store = createShellUpdateAttemptStore(dataDir), originalState = { ...f.selected.originalState, previousShellId: "baseline" };
  const initial: ShellUpdateAttemptV2 = { schemaVersion: 2, requestId: "pre-handoff-failure", revision: 0, retriesUsed: 0, phase: "preparing",
    installationDir: f.selected.installationDir, dataDir, userDataDir: f.input.userDataDir, sessionDataDir: f.input.sessionDataDir, originalState,
    binding: f.selected.binding, target: null, candidateState: null, network: null };
  let current = await store.replace(null, initial) as ShellUpdateAttemptV2;
  if (selected) {
    current = await store.replace(current, { ...current, revision: current.revision + 1, network: { actionKey: "shell-discover", requestSha256: "1".repeat(64), status: "dispatching" } }) as ShellUpdateAttemptV2;
    const dispatch = current.network!;
    current = await store.replace(current, { ...current, revision: current.revision + 1, network: { ...dispatch, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "2".repeat(64) } } }) as ShellUpdateAttemptV2;
    current = await store.replace(current, { ...current, revision: current.revision + 1, target: f.selected.target, candidateState: f.selected.candidateState }) as ShellUpdateAttemptV2;
  }
  const ini = path.join(initial.installationDir, "shell-launch.ini"); await fs.writeFile(ini, serializeShellLaunchState(originalState));
  const primary = Object.assign(new Error("definitive network response failure"), { code: selected ? "DESKTOP_SHELL_INSTALLER_SIGNATURE_INVALID" : "DESKTOP_SHELL_REGISTRATION_ACK_INVALID" });
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable: createShellUpdateAttemptNetworkAdapter(store), onRetry() { assert.fail("definitive failure must not retry"); } });
  let sends = 0;
  await assert.rejects(retry.run(async () => { sends++; throw primary; }, { actionKey: selected ? "shell-installer" : "shell-register", requestSha256: "3".repeat(64),
    async persistResult() { assert.fail("failure cannot persist success"); }, async recoverResult() { return { status: "unknown" }; } }), cause => cause === primary);
  const failed = await store.read() as ShellUpdateAttemptV2;
  assert.equal(failed.phase, "failed"); assert.equal(failed.network?.status, "failed"); assert.equal(sends, 1);
  const input = { ...f.input, dataDir, executablePath: f.selected.oldMain.executable, argv: [], channel: undefined, timeoutMs: 3000,
    snapshot: async (): Promise<ProcessIdentity[]> => { assert.fail("ordinary schema2 startup must not create recovery process work"); } };
  return { ...f, store, failed, input, ini };
}

for (const selected of [false, true]) test(`pre-handoff network failure with ${selected ? "selected target" : "no target"} keeps old-shell startup ordinary without changing failure or budget`, async () => {
  const h = await api(), f = await prehandoffFailureFixture(selected), file = path.join(f.input.dataDir, "shell-update-attempt.json");
  const attemptBefore = await fs.readFile(file), iniBefore = await fs.readFile(f.ini);
  assert.equal((await h.readShellHandoffStartup(f.input)).kind, "ordinary");
  assert.equal((await h.readShellHandoffStartup(f.input)).kind, "ordinary");
  assert.deepEqual(await fs.readFile(file), attemptBefore); assert.deepEqual(await fs.readFile(f.ini), iniBefore);
  assert.equal((await f.store.read())!.retriesUsed, 0); assert.equal(f.failed.target?.shellId ?? null, selected ? "new" : null);
});

for (const defect of ["executable", "ini-active", "ini-previous", "profile", "bootstrap", "v1-failed", "v2-no-network", "v2-succeeded-network", "v2-handoff", "v3-handoff"] as const)
test(`pre-handoff failed startup never treats ${defect} as an ordinary original shell`, async () => {
  const h = await api(), f = await prehandoffFailureFixture(true), file = path.join(f.input.dataDir, "shell-update-attempt.json");
  let input = f.input;
  if (defect === "executable") input = { ...input, executablePath: f.main.executable };
  if (defect === "ini-active") await fs.writeFile(f.ini, serializeShellLaunchState(f.selected.candidateState));
  if (defect === "ini-previous") await fs.writeFile(f.ini, serializeShellLaunchState({ ...f.failed.originalState, previousShellId: null }));
  if (defect === "profile") input = { ...input, userDataDir: f.root };
  if (defect === "v1-failed") { const { network: _network, ...legacy } = f.failed; await fs.writeFile(file, JSON.stringify({ ...legacy, schemaVersion: 1 })); }
  if (defect === "v2-no-network") await fs.writeFile(file, JSON.stringify({ ...f.failed, network: null }));
  if (defect === "v2-succeeded-network") await fs.writeFile(file, JSON.stringify({ ...f.failed, network: { actionKey: "shell-installer", requestSha256: "3".repeat(64), status: "succeeded", evidence: { kind: "shell-installer", sha256: "4".repeat(64) } } }));
  if (defect === "v2-handoff") await fs.writeFile(file, JSON.stringify({ ...f.failed, phase: "handoff", network: null }));
  if (defect === "v3-handoff") await fs.writeFile(file, JSON.stringify({ ...f.selected, dataDir: input.dataDir, originalState: f.failed.originalState }));
  const before = await fs.readFile(file);
  if (defect === "profile") await assert.rejects(h.readShellHandoffStartup(input), { code: "DESKTOP_SHELL_HANDOFF_PROFILE_INVALID" });
  else if (defect === "bootstrap") {
    const waiting = h.readShellHandoffStartup({ ...input, argv: ["--codeflow-shell-handoff"], channel: f.channel });
    f.channel.emit("message", f.message("bootstrap", { role: "original", main: f.selected.oldMain }));
    await assert.rejects(waiting, { code: "DESKTOP_SHELL_HANDOFF_ATTEMPT_REQUIRED" });
  } else if (defect === "v3-handoff") await assert.rejects(h.readShellHandoffStartup(input));
  else assert.equal((await h.readShellHandoffStartup(input)).kind, "recovery-control");
  assert.deepEqual(await fs.readFile(file), before);
});

/** 等真实发送事件而非固定延迟，避免并行测试负载改变消息时序。 */
async function sentMessage(channel: Awaited<ReturnType<typeof fixture>>["channel"]) {
  if (channel.sent.length === 0) await once(channel, "sent", { signal: AbortSignal.timeout(5000) });
  return channel.sent[0];
}

/** 模拟helper沿原store完成并真实释放；消息发送本身不能充当结束证据。 */
async function finishStarted(session: { started(): Promise<void> }, startup: { attempt: ShellUpdateHandoffAttempt; input: { snapshot?: () => Promise<ProcessIdentity[]> } }, f: Awaited<ReturnType<typeof fixture>>) {
  const processes = await startup.input.snapshot!(), helper = startup.attempt.recovery?.helper ?? startup.attempt.helper;
  let released = false;
  startup.input.snapshot = async () => released ? processes.filter(item => item.pid !== helper.pid) : processes;
  const sent = once(f.channel, "sent"), completion = session.started(); await sent;
  const current = await f.store.read() as ShellUpdateHandoffAttempt, terminal = f.channel.sent.at(-1).body.terminalEvidence;
  if (current.recovery) await f.store.completeRecovery(current, terminal);
  else await f.store.replace(current, { ...current, revision: current.revision + 1, phase: terminal.ready.role === "candidate" ? "completed" : "restored", terminalEvidence: terminal });
  released = true; await completion;
}

/** 真实签名已安装业务工件，不替代运行时签名与 held 能力校验。 */
/** 以真实签名baseline或active验证启动binding，不替代产品验签入口。 */
async function signedRuntime(f: { input: { dataDir: string }; facts: Awaited<ReturnType<typeof fixture>>["facts"] }, active = false) {
  const keys = crypto.generateKeyPairSync("ed25519"), keyId = active ? "runtime-hot" : "runtime", trustedKeys = { [keyId]: keys.publicKey };
  const directory = active ? path.join(f.input.dataDir, "releases", "hot-next") : f.facts.baseline.releaseDir;
  await fs.mkdir(path.join(directory, "client", "dist"), { recursive: true }); await fs.mkdir(path.join(directory, "web"), { recursive: true });
  const client = "synthetic held client entry";
  await fs.writeFile(path.join(directory, "client", "dist", "index.cjs"), client);
  await fs.writeFile(path.join(directory, "web", "index.html"), "synthetic signed web");
  const marker = path.join(directory, DESKTOP_STARTUP_CAPABILITY_PATH); await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: crypto.createHash("sha256").update(client).digest("hex") }));
  const files = await readReleaseBundleFiles(directory), webSha256 = computeReleaseDirectorySha256(files, "web"), clientSha256 = computeReleaseDirectorySha256(files, "client");
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: active ? "hot-next" : "baseline-proof", version: "1.0.0", webVersion: "1.0.0", clientVersion: active ? "2.0" : "1.0",
    capabilityVersion: 1, platform: "win32", arch: "x64", protocolVersion: 1, dbSchemaVersion: active ? 8 : 7, webSha256, clientSha256,
    packageSha256: computeReleasePackageSha256(webSha256, clientSha256), files, archiveSha256: "1".repeat(64), archiveSize: 1,
    keyId, createdAt: "2026-10-27T00:00:00.000Z", expiresAt: "2026-11-27T00:00:00.000Z" }, keys.privateKey);
  await fs.writeFile(path.join(directory, active ? "manifest.json" : "baseline-release-manifest.json"), JSON.stringify(manifest));
  if (active) await fs.writeFile(path.join(f.input.dataDir, "active-release.json"), JSON.stringify({ releaseId: "hot-next" }));
  return { trustedKeys, manifest, directory };
}

/** 新准备周期经真实初始化持久化，旧Client留待普通启动换根事务释放。 */
async function preparationFixture() {
  const f = await fixture(), proof = await signedRuntime(f), dataDir = path.join(f.root, "preparation-data");
  await fs.mkdir(dataDir);
  const main = f.selected.oldMain, client = { ...f.client, pid: 105, parentPid: main.pid, created: 1200 };
  const store = createShellUpdateAttemptStore(dataDir), fresh = { schemaVersion: 2, requestId: "preparation-restart", revision: 0, retriesUsed: 0,
    installationDir: f.selected.installationDir, dataDir, userDataDir: f.input.userDataDir, sessionDataDir: f.input.sessionDataDir,
    originalState: f.selected.originalState, binding: f.selected.binding, phase: "preparing", target: null, candidateState: null, network: null };
  const initial = await store.beginPreparation(null, fresh, { main, client, readyRequestId: "preparation-client-ready", processes: [main, client] });
  await fs.writeFile(path.join(f.selected.installationDir, "shell-launch.ini"), serializeShellLaunchState(initial.originalState));
  const caller = { ...main, pid: 401, parentPid: 390, created: 2401, commandLine: "restarted preparation main" };
  const input = { ...f.input, dataDir, argv: [], channel: undefined, pid: caller.pid, parentPid: caller.parentPid,
    executablePath: caller.executable, trustedKeys: proof.trustedKeys, snapshot: async () => [caller] };
  return { ...f, store, initial, main, client, caller, input, proof };
}

test("schema5 ordinary startup atomically binds a new main and releases its old Client before application work", async () => {
  const h = await api(), f = await preparationFixture(); let applicationStarted = false;
  assert.equal((await h.readShellHandoffStartup(f.input)).kind, "ordinary");
  applicationStarted = true;
  const bound = await createShellUpdateAttemptStore(f.input.dataDir).read() as ShellUpdatePreparationAttemptV5;
  assert.equal(applicationStarted, true); assert.equal(bound.schemaVersion, 5); assert.equal(bound.revision, 2); assert.equal(bound.controlRevision, 2);
  assert.deepEqual(bound.preparationMains, [{ identity: f.main, boundAtRevision: 1 }, { identity: f.caller, boundAtRevision: 2 }]);
  assert.equal(bound.ownedLifecycle[0]!.release!.revision, 2); assert.equal(bound.phase, "preparing");
  assert.equal(bound.requestId, f.initial.requestId); assert.equal(bound.network, null); assert.equal(bound.retriesUsed, 0);
  const bytes = await fs.readFile(path.join(f.input.dataDir, "shell-update-attempt.json"));
  assert.equal((await h.readShellHandoffStartup(f.input)).kind, "ordinary");
  assert.deepEqual(await fs.readFile(path.join(f.input.dataDir, "shell-update-attempt.json")), bytes);
});

test("new-child snapshot ordinary preparation startup rechecks a child of its still-visible old root before binding", async t => {
  const h = await api(), f = await preparationFixture();
  const current = await f.store.bindPreparationMain(f.initial, { caller: f.caller, processes: [f.caller],
    launchState: { status: "known", value: f.initial.originalState }, binding: { status: "matched", value: f.initial.binding },
    profile: { status: "known", dataDir: f.input.dataDir, userDataDir: f.input.userDataDir, sessionDataDir: f.input.sessionDataDir } });
  const child = { ...f.caller, pid: 480, parentPid: f.caller.pid, created: 2480, commandLine: "ordinary delayed path" };
  let queries = 0;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    callback(null, JSON.stringify([f.caller, queries++ === 0 ? { ...child, executable: "" } : child]));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    assert.equal((await h.readShellHandoffStartup({ ...f.input, snapshot: undefined })).kind, "ordinary");
    const bound = await f.store.read() as ShellUpdatePreparationAttemptV5;
    assert.ok(queries >= 2); assert.deepEqual(bound, current);
    assert.equal(bound.owned.some(item => item.pid === child.pid), false); assert.equal(bound.preparationMains.length, 2);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const defect of ["old-main", "old-client", "role-reuse", "unreleased-reuse", "unknown-orphan", "partial-main", "binding", "query"] as const)
test(`schema5 ordinary startup rejects ${defect} before application work or inventory writes`, async () => {
  const h = await api(), f = await preparationFixture(), file = path.join(f.input.dataDir, "shell-update-attempt.json"), before = await fs.readFile(file);
  let applicationStarts = 0;
  const processes = [f.caller];
  if (defect === "old-main") processes.push(f.main);
  if (defect === "old-client") processes.push(f.client);
  if (defect === "role-reuse") processes.push({ ...f.main, parentPid: 990, created: 9000 });
  if (defect === "unreleased-reuse") processes.push({ ...f.client, parentPid: 990, created: 9001 });
  if (defect === "unknown-orphan") processes.push({ ...f.client, pid: 990, parentPid: f.client.pid, created: 9002 });
  if (defect === "partial-main") processes[0] = { ...f.caller, executable: "", commandLine: "" };
  const active = defect === "binding" ? await signedRuntime({ ...f, input: f.input }, true) : undefined;
  const primary = Object.assign(new Error("preparation snapshot unavailable"), { code: "CONTROLLED_PREPARATION_QUERY_FAILED" });
  await assert.rejects(async () => {
    await h.readShellHandoffStartup({ ...f.input, trustedKeys: { ...f.proof.trustedKeys, ...active?.trustedKeys },
      snapshot: async () => { if (defect === "query") throw primary; return processes; } });
    applicationStarts++;
  }, cause => {
    assert.ok(cause instanceof Error && "code" in cause && typeof cause.code === "string");
    if (defect === "query" || defect === "binding") {
      assert.equal(cause.code, defect === "query" ? primary.code : "DESKTOP_SHELL_HANDOFF_BINDING_CHANGED");
      assert.equal(Object.getOwnPropertyDescriptor(cause, "requestId")?.value, f.initial.requestId);
      assert.equal(Object.getOwnPropertyDescriptor(cause, "revision")?.value, f.initial.revision);
      assert.equal(Object.getOwnPropertyDescriptor(cause, "phase")?.value, f.initial.phase);
      assert.ok(cause.cause instanceof Error);
      if (defect === "query") assert.ok(hasCause(cause, primary));
    }
    return true;
  });
  assert.equal(applicationStarts, 0); assert.deepEqual(await fs.readFile(file), before);
});

for (const phase of ["no-update", "failed"] as const) test(`schema5 ordinary ${phase} restart binds its main without reopening the network request`, async () => {
  const h = await api(), f = await preparationFixture();
  const dispatch = await f.store.replace(f.initial, { ...f.initial, revision: 2, network: { actionKey: "shell-register", requestSha256: "4".repeat(64), status: "dispatching" } }) as ShellUpdatePreparationAttemptV5;
  const settled = await f.store.replace(dispatch, { ...dispatch, revision: 3, phase: phase === "failed" ? "failed" : "preparing",
    network: phase === "failed" ? { ...dispatch.network, status: "failed", errorCode: "DESKTOP_SHELL_REGISTRATION_ACK_INVALID" }
      : { ...dispatch.network, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "5".repeat(64) } } }) as ShellUpdatePreparationAttemptV5;
  const terminal = phase === "failed" ? settled : await f.store.replace(settled, { ...settled, revision: 4, phase: "no-update" }) as ShellUpdatePreparationAttemptV5;
  assert.equal((await h.readShellHandoffStartup(f.input)).kind, "ordinary");
  const actual = await f.store.read() as ShellUpdatePreparationAttemptV5;
  assert.equal(actual.phase, phase); assert.equal(actual.requestId, terminal.requestId); assert.equal(actual.revision, terminal.revision + 1);
  assert.deepEqual(actual.network, terminal.network); assert.equal(actual.retriesUsed, terminal.retriesUsed); assert.equal(actual.target, null);
});

test("schema5 ordinary startup propagates a failed atomic attempt write before application work", async t => {
  const h = await api(), f = await preparationFixture(), rename = fs.rename;
  const primary = Object.assign(new Error("controlled preparation rename failure"), { code: "EACCES" });
  const file = path.join(f.input.dataDir, "shell-update-attempt.json"), before = await fs.readFile(file); let applicationStarts = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === file) throw primary;
    return await rename(...args);
  });
  await assert.rejects(async () => { await h.readShellHandoffStartup(f.input); applicationStarts++; }, cause => hasCause(cause, primary));
  assert.equal(applicationStarts, 0); assert.deepEqual(await fs.readFile(file), before);
});

test("schema5 ordinary restart in a fresh Node process preserves preparation roots and prior release proof", async () => {
  const h = await api(), f = await preparationFixture();
  await h.readShellHandoffStartup(f.input);
  const first = await f.store.read() as ShellUpdatePreparationAttemptV5;
  const third = { ...f.caller, pid: 501, parentPid: 490, created: 3501, commandLine: "third preparation main" };
  const facts = { ...f.input, pid: third.pid, parentPid: third.parentPid, trustedKeys: undefined, snapshot: undefined,
    publicKey: f.proof.trustedKeys.runtime.export({ type: "spki", format: "pem" }), processes: [third] };
  const source = `import crypto from 'node:crypto';
    import { readShellHandoffStartup } from ${JSON.stringify(new URL("../src/shellHandoff.ts", import.meta.url).href)};
    const { publicKey, processes, ...input } = JSON.parse(process.argv[2]);
    const result = await readShellHandoffStartup({ ...input, trustedKeys: { runtime: crypto.createPublicKey(publicKey) }, snapshot: async () => processes });
    if (result.kind !== 'ordinary') throw new Error('fresh process was not admitted ordinarily');`;
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-", JSON.stringify(facts)],
    { cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const errors: Buffer[] = []; child.stderr.on("data", bytes => errors.push(bytes)); child.stdout.resume(); child.stdin.end(source);
  const [code, signal] = await once(child, "close"); assert.equal(signal, null); assert.equal(code, 0, Buffer.concat(errors).toString("utf8"));
  const persisted = await createShellUpdateAttemptStore(f.input.dataDir).read() as ShellUpdatePreparationAttemptV5;
  assert.equal(persisted.revision, 3); assert.equal(persisted.controlRevision, 3); assert.equal(persisted.preparationMains.length, 3);
  assert.deepEqual(persisted.preparationMains[2], { identity: third, boundAtRevision: 3 });
  assert.deepEqual(persisted.ownedLifecycle, first.ownedLifecycle); assert.equal(persisted.requestId, first.requestId);
});

/** 充分终态保留历史身份，新正常main不冒充旧 owner 或 held main。 */
async function terminalFixture(role: "candidate" | "original") {
  const f = await fixture(), proof = await signedRuntime(f);
  const main = role === "candidate" ? f.main : { ...f.main, pid: 106, executable: f.selected.oldMain.executable };
  const client = { ...f.client, pid: 107, parentPid: main.pid };
  const ready = { role, continuationId: f.selected.continuationId, main, client, readyRequestId: "terminal-ready", health: f.selected.binding.health,
    binding: f.selected.binding, launchState: role === "candidate" ? f.selected.candidateState : f.selected.originalState,
    profile: { dataDir: f.input.dataDir, userDataDir: f.input.userDataDir, sessionDataDir: f.input.sessionDataDir }, mainFrame: "loaded", startup: f.facts.client.startup };
  let current = f.selected;
  if (role === "candidate") current = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission: ready }) as ShellUpdateAttemptV3;
  const terminal = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: role === "candidate" ? "completed" : "restored",
    terminalEvidence: { ready, startedRequestId: "terminal-started", continueRequestId: "terminal-continue", startup: "completed", application: "started" } }) as ShellUpdateAttemptV3;
  await fs.writeFile(path.join(f.selected.installationDir, "shell-launch.ini"), serializeShellLaunchState(ready.launchState));
  const caller = { ...main, pid: 201, parentPid: 190, created: 2200, commandLine: "new ordinary main" };
  const input = { ...f.input, argv: [], channel: undefined, executablePath: caller.executable, pid: caller.pid, parentPid: caller.parentPid,
    trustedKeys: proof.trustedKeys, snapshot: async () => [caller] };
  return { ...f, proof, terminal, caller, terminalClient: client, ordinaryInput: input };
}

/** 新恢复执行使用真实 store claim/bind/observe，不伪造当前执行 reader。 */
async function recoveryFixture(direction: "original" | "candidate", terminal = false, lifecycle = false) {
  const f = await fixture(lifecycle), proof = await signedRuntime(f);
  let current = f.selected;
  if (direction === "candidate") {
    const admission = { role: "candidate", continuationId: current.continuationId, main: f.main, client: f.client,
      readyRequestId: "historical-ready", health: current.binding.health, binding: current.binding, launchState: current.candidateState,
      profile: { dataDir: current.dataDir, userDataDir: current.userDataDir, sessionDataDir: current.sessionDataDir }, mainFrame: "loaded", startup: f.facts.client.startup };
    current = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission }) as ShellUpdateAttemptV3;
  }
  const controller = { ...f.main, pid: 301, parentPid: 290, created: 2301, commandLine: "recovery controller" };
  const helper = { ...controller, pid: 302, parentPid: 301, created: 2302, commandLine: "recovery helper" };
  // 未终结旧库存缺失不允许推测释放；夹具明确记录首轮额外库存。
  if (lifecycle) current = await f.store.observeHandoffOwned(current, { caller: current.helper, processes: [current.helper] });
  else { current = { ...current, owned: current.admission ? [current.admission.client] : [] }; await fs.writeFile(path.join(f.input.dataDir, "shell-update-attempt.json"), JSON.stringify(current)); }
  const known = shellUpdateProcessHistory(current);
  const claimed = await f.store.beginRecovery(current, { caller: controller, helper, processes: [controller, helper], owner: { status: "gone", identity: current.helper },
    oldMain: { status: "gone", identity: current.oldMain }, selectedMain: { status: "gone", identity: current.selectedMain },
    launchState: { status: "known", value: current.candidateState }, binding: { status: "matched", value: current.binding },
    profile: { status: "known", dataDir: current.dataDir, userDataDir: current.userDataDir, sessionDataDir: current.sessionDataDir },
    ownedReleased: "verified", knownOwned: { status: "known", identities: known } });
  const main = { ...f.main, pid: 303, parentPid: 302, created: 2303, executable: direction === "candidate" ? f.main.executable : f.selected.oldMain.executable, commandLine: "recovery held main" };
  const client = { ...f.client, pid: 304, parentPid: 303, created: 2304 };
  const state = direction === "candidate" ? claimed.candidateState : claimed.originalState;
  await fs.writeFile(path.join(f.selected.installationDir, "shell-launch.ini"), serializeShellLaunchState(state));
  const runtime = { caller: helper, processes: [helper, main], launchState: { status: "known", value: state }, binding: { status: "matched", value: claimed.binding },
    profile: { status: "known", dataDir: claimed.dataDir, userDataDir: claimed.userDataDir, sessionDataDir: claimed.sessionDataDir } };
  let bound = await f.store.bindRecoveryMain(claimed, { ...runtime, main });
  bound = await f.store.observeRecoveryOwned(bound, { ...runtime, processes: [helper, main, client] });
  const ready = { role: direction, continuationId: bound.continuationId, main, client, readyRequestId: "recovery-ready", health: bound.binding.health,
    binding: bound.binding, launchState: state, profile: { dataDir: bound.dataDir, userDataDir: bound.userDataDir, sessionDataDir: bound.sessionDataDir }, mainFrame: "loaded" as const, startup: f.facts.client.startup! };
  if (terminal) bound = await f.store.completeRecovery(bound, { ready, startedRequestId: "recovery-started", continueRequestId: "recovery-continue", startup: "completed", application: "started" });
  const input = { ...f.input, executablePath: main.executable, pid: main.pid, parentPid: helper.pid, snapshot: async () => [helper, main, client] };
  const message = (kind: string, body: unknown = {}, revision = shellUpdateHandoffRevision(bound)) => ({ ...f.message(kind, body, revision), body });
  return { ...f, bound, controller, helper, main, client, input, message, ready, proof };
}

/** 二次claim使用真实释放和完整历史，前轮执行留在recoveryHistory。 */
async function repeatedRecoveryFixture() {
  const f = await recoveryFixture("candidate", false, true), prior = f.bound.recovery!;
  const state = f.bound.candidateState, profile = { status: "known", dataDir: f.bound.dataDir, userDataDir: f.bound.userDataDir, sessionDataDir: f.bound.sessionDataDir };
  const facts = { launchState: { status: "known", value: state }, binding: { status: "matched", value: f.bound.binding }, profile };
  const released = await f.store.observeRecoveryOwned(f.bound, { ...facts, caller: f.helper, processes: [f.helper] });
  const controller = { ...f.controller, pid: 401, created: 2401 }, helper = { ...f.helper, pid: 402, parentPid: 401, created: 2402 };
  const main = { ...f.main, pid: 403, parentPid: 402, created: 2403 }, client = { ...f.client, pid: 404, parentPid: 403, created: 2404 };
  let bound = await f.store.beginRecovery(released, { ...facts, caller: controller, helper, processes: [controller, helper],
    owner: { status: "gone", identity: released.helper }, oldMain: { status: "gone", identity: released.oldMain }, selectedMain: { status: "gone", identity: released.selectedMain },
    ownedReleased: "verified", knownOwned: { status: "known", identities: shellUpdateProcessHistory(released) } });
  bound = await f.store.bindRecoveryMain(bound, { ...facts, caller: helper, processes: [helper, main], main });
  bound = await f.store.observeRecoveryOwned(bound, { ...facts, caller: helper, processes: [helper, main, client] });
  const input = { ...f.input, pid: main.pid, parentPid: helper.pid, snapshot: async () => [helper, main, client] };
  const message = (kind: string, body: unknown = {}) => f.message(kind, body, shellUpdateHandoffRevision(bound));
  return { ...f, prior, bound, controller, helper, main, client, input, message };
}

for (const stage of ["bootstrap", "ready", "permit"] as const) for (const revived of ["helper", "client"] as const)
test(`schema4 second recovery rejects a revived previous ${revived} at ${stage}`, async () => {
  const h = await api(), f = await repeatedRecoveryFixture();
  let processes = [f.helper, f.main, f.client];
  const previous = revived === "helper" ? f.prior.helper : f.prior.knownOwned[0];
  if (stage === "bootstrap") processes.push(previous);
  const waiting = h.readShellHandoffStartup({ ...f.input, snapshot: async () => processes });
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main }));
  if (stage === "bootstrap") { await assert.rejects(waiting, { code: "DESKTOP_SHELL_PROCESS_INVENTORY_INVALID" }); return; }
  const startup = await waiting; if (startup.kind !== "held-candidate") throw new Error("held recovery required");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  if (stage === "ready") processes.push(previous);
  const authorized = session.continuation.authorizeReady({ ...f.facts, client: { ...f.facts.client, pid: f.client.pid } });
  if (stage === "permit") { await sentMessage(f.channel); processes.push(previous); f.channel.emit("message", f.message("permit")); }
  await assert.rejects(authorized, { code: "DESKTOP_SHELL_PROCESS_INVENTORY_INVALID" }); session.dispose();
});

for (const role of ["candidate", "original"] as const) test(`fully completed ${role} starts ordinarily with only read-only terminal verification`, async () => {
  const h = await api(), f = await terminalFixture(role), before = await fs.readFile(path.join(f.input.dataDir, "shell-update-attempt.json"));
  assert.equal((await h.readShellHandoffStartup(f.ordinaryInput)).kind, "ordinary");
  assert.deepEqual(await fs.readFile(path.join(f.input.dataDir, "shell-update-attempt.json")), before);
});

for (const defect of ["helper-alive", "client-alive", "unknown-child", "pid-reused", "wrong-ini"] as const)
test(`terminal ordinary startup rejects ${defect} before creating application work`, async () => {
  const h = await api(), f = await terminalFixture("candidate");
  const extra = defect === "helper-alive" ? f.helper : defect === "client-alive" ? f.terminalClient
    : defect === "unknown-child" ? { ...f.terminalClient, pid: 299, parentPid: f.main.pid }
      : { ...f.helper, created: 9999, commandLine: "foreign reused pid" };
  if (defect === "wrong-ini") await fs.writeFile(path.join(f.selected.installationDir, "shell-launch.ini"), serializeShellLaunchState(f.selected.originalState));
  await assert.rejects(h.readShellHandoffStartup({ ...f.ordinaryInput, snapshot: async () => [f.caller, ...(defect === "wrong-ini" ? [] : [extra])] }));
});

test("terminal ordinary startup checks signed installed entry points without rehashing Web payload files", async () => {
  const h = await api(), f = await terminalFixture("candidate");
  await fs.writeFile(path.join(f.proof.directory, "web/index.html"), "changed Web payload");
  const startup = await h.readShellHandoffStartup({ ...f.ordinaryInput, snapshot: async () => [f.caller] });
  assert.equal(startup.kind, "ordinary");
});

test("terminal ordinary startup validates current signed hot binding instead of permanently locking historical binding", async () => {
  const h = await api(), f = await terminalFixture("candidate"), active = await signedRuntime(f, true);
  assert.equal((await h.readShellHandoffStartup({ ...f.ordinaryInput, trustedKeys: { ...f.proof.trustedKeys, ...active.trustedKeys } })).kind, "ordinary");
});

/** controller夹具容纳真实磁盘往返；超时语义由独立inbox用例验证。 */
const recoveryControllerFixtureTimeoutMs = 3000;

/** controller 创建的 helper 使用受控 IPC/close，claim 和原 INI 始终由真实产品读写。 */
class RecoveryHelper extends EventEmitter {
  connected = true;
  readonly sent: any[] = [];
  exitCode: number | null = null;
  /** 固定受控 PID 供真实身份匹配，不创建系统进程。 */
  constructor(readonly pid: number) { super(); }
  onSend?: (message: any) => Promise<void>;
  /** 回调和后续消息分离，使协议等待覆盖真实异步响应。 */
  send(message: any, callback: (error: Error | null) => void) { this.sent.push(structuredClone(message)); callback(null); if (this.onSend) void this.onSend(message).catch(cause => this.emit("error", cause)); return true; }
  /** 精确停止的夹具 close 不代替产品的归属判定。 */
  close() { this.exitCode = 0; this.connected = false; this.emit("exit", 0, null); this.emit("close", 0, null); }
}

for (const defect of ["none", "schema4-initial", "schema3-initial", "missing-candidate-exe", "missing-candidate-resources", "live-history", "missing-owned", "bad-accepted", "cleanup-error", "revived-history", "unknown-cleanup", "early-close", "old-cleanup", "old-partial-cleanup", "old-dead-cleanup", "same-time-cleanup", "unknown-time-cleanup", "reused-helper-cleanup"] as const)
test(`recovery controller ${defect} preserves a single claim and owns its helper`, async t => {
  const h = await api(), entry = (h as unknown as Record<string, unknown>).startShellRecoveryController;
  assert.equal(typeof entry, "function", "recovery controller boundary is required");
  const f = await fixture(defect === "schema4-initial"), proof = await signedRuntime(f);
  const current = defect === "schema4-initial" ? await f.store.observeHandoffOwned(f.selected, { caller: f.helper, processes: [f.helper] }) : { ...f.selected, owned: [] };
  if (defect !== "missing-owned") await fs.writeFile(path.join(f.input.dataDir, "shell-update-attempt.json"), JSON.stringify(current));
  const missingCandidate = defect.startsWith("missing-candidate-");
  if (missingCandidate) {
    const oldResources = path.join(path.dirname(f.selected.oldMain.executable), "resources"); await fs.mkdir(oldResources);
    await fs.writeFile(path.join(oldResources, "release-trust.json"), JSON.stringify(Object.fromEntries(Object.entries(proof.trustedKeys).map(([key, value]) => [key, value.export({ type: "spki", format: "pem" })]))));
    if (defect === "missing-candidate-exe") await fs.unlink(f.main.executable);
    else { const resources = path.join(path.dirname(f.main.executable), "resources"); await fs.mkdir(resources); await fs.writeFile(path.join(resources, "app.asar"), "candidate"); await fs.rm(resources, { recursive: true }); }
  }
  const controller = { ...f.main, pid: 501, parentPid: 490, created: 2501, executable: missingCandidate ? f.selected.oldMain.executable : f.main.executable, commandLine: "zero Client controller" };
  const helperIdentity = { ...controller, pid: 502, parentPid: 501, created: 2502, commandLine: "recovery helper node" }, helper = new RecoveryHelper(502);
  let spawned = 0, stopped = 0, owner: any; const cleanupError = new Error("helper independent cleanup error");
  const epochCleanup = ["old-cleanup", "old-partial-cleanup", "old-dead-cleanup", "same-time-cleanup", "unknown-time-cleanup", "reused-helper-cleanup"].includes(defect);
  let processes = [controller, ...(defect === "live-history" ? [f.helper] : [])];
  if (defect === "schema4-initial" || defect === "schema3-initial") processes.push({ ...controller, pid: 503, parentPid: controller.pid, created: 2503, commandLine: "ordinary controller child" });
  if (defect === "revived-history") {
    const readFile = fs.readFile; let proofs = 0;
    t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      const result = await readFile(...args); if (String(args[0]).endsWith("baseline-release-manifest.json") && ++proofs === 2) processes.push(f.helper); return result;
    });
  }
  helper.onSend = async message => {
    if (message.kind === "arm") { assert.deepEqual(message.body.oldMain, controller); assert.deepEqual(await f.store.read(), current);
      helper.emit("message", { ...message, kind: "armed", body: { helper: helperIdentity } }); }
    if (message.kind === "accept") { const claimed = await f.store.read() as ShellUpdateAttemptV3;
      assert.equal(claimed.recovery!.controller.pid, controller.pid); assert.equal(message.revision, current.revision + 1);
      if (defect === "unknown-cleanup") { processes.push({ ...helperIdentity, pid: 599, parentPid: helper.pid, created: 2599, commandLine: "unknown child" });
        processes = processes.filter(item => item.pid !== helper.pid); helper.close(); }
      if (epochCleanup) {
        processes.push({ ...helperIdentity, pid: defect === "reused-helper-cleanup" ? helper.pid : 599, parentPid: helper.pid,
          created: defect === "unknown-time-cleanup" ? 0 : defect === "same-time-cleanup" ? helperIdentity.created : 500,
          executable: defect === "old-partial-cleanup" ? "" : helperIdentity.executable, commandLine: "historical parent epoch" });
        if (defect === "old-dead-cleanup" || defect === "reused-helper-cleanup") { processes = processes.filter(item => item.pid !== helper.pid || item.created === 500); helper.close(); }
        else if (defect === "same-time-cleanup" || defect === "unknown-time-cleanup") { processes = processes.filter(item => item.pid !== helper.pid); helper.close(); }
      }
      helper.emit("message", { ...message, kind: "accepted", revision: message.revision + (["bad-accepted", "cleanup-error", "unknown-cleanup"].includes(defect) || epochCleanup ? 1 : 0), body: {} }); }
  };
  const input = { ...f.input, argv: [], channel: undefined, trustedKeys: missingCandidate ? undefined : proof.trustedKeys, executablePath: controller.executable, pid: controller.pid, parentPid: controller.parentPid,
    snapshot: async () => structuredClone(processes), onOwned: (value: unknown) => { owner = value;
      if (defect === "early-close") { processes.push({ ...helperIdentity, pid: 599, parentPid: helper.pid, created: 2599, commandLine: "unknown early child" });
        processes = processes.filter(item => item.pid !== helper.pid); helper.close(); }
    }, timeoutMs: recoveryControllerFixtureTimeoutMs,
    boundary: { spawn: (executable: string, args: string[], options: any) => {
      spawned++; assert.equal(executable, controller.executable); assert.equal(args[1], "--codeflow-shell-recovery-helper"); assert.equal(args[2], f.input.dataDir);
      assert.equal(options.detached, process.platform === "win32"); assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ["ignore", "inherit", "inherit", "ipc"]); assert.equal(options.cwd, current.installationDir);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1"); processes.push(helperIdentity); return helper as unknown as ChildProcess;
    }, stop: async (identity: ProcessIdentity) => { assert.deepEqual(identity, helperIdentity); stopped++; processes = processes.filter(item => item.pid !== helper.pid);
      if (defect === "cleanup-error") helper.emit("error", cleanupError); helper.close(); } } };
  if (defect === "none" || defect === "schema4-initial" || missingCandidate) {
    if (missingCandidate) assert.equal((await h.readShellHandoffStartup(input)).kind, "recovery-control");
    const accepted = await (entry as (value: unknown) => Promise<any>)(input); assert.equal(accepted.helper.pid, helper.pid); assert.equal(owner, accepted);
    assert.equal((await f.store.read() as ShellUpdateAttemptV3).recovery!.main, null); assert.equal(stopped, 0);
    if (defect === "schema4-initial") assert.deepEqual((await f.store.read() as ShellUpdateAttemptV3).recovery!.knownOwned.map(item => item.pid), [503]);
    processes = processes.filter(item => item.pid !== helper.pid); helper.close(); accepted.dispose();
  } else {
    await assert.rejects((entry as (value: unknown) => Promise<any>)(input), (cause: any) => {
      if (defect === "early-close") assert.equal(cause.owner, owner);
      return defect !== "cleanup-error" || hasCause(cause, cleanupError);
    });
    const executed = ["bad-accepted", "cleanup-error", "revived-history", "unknown-cleanup", "early-close", "schema3-initial"].includes(defect) || epochCleanup; assert.equal(spawned, executed ? 1 : 0);
    assert.equal(stopped, executed && !["unknown-cleanup", "early-close", "old-dead-cleanup", "same-time-cleanup", "unknown-time-cleanup", "reused-helper-cleanup"].includes(defect) ? 1 : 0);
    if (epochCleanup) assert.equal(owner.released, ["old-cleanup", "old-partial-cleanup", "old-dead-cleanup"].includes(defect));
    if (defect === "unknown-cleanup" || defect === "early-close") { assert.equal(owner.didClose, true); assert.equal(owner.released, false); }
    if (defect === "early-close") {
      assert.equal(owner.helper, undefined); assert.deepEqual(await f.store.read(), current);
      await assert.rejects(owner.close(), (cause: unknown) => h.snapshotShellHandoffErrorContext(cause).causeCodes.includes("DESKTOP_SHELL_HANDOFF_RECOVERY_HELPER_IDENTITY_UNKNOWN"));
      assert.equal(owner.released, false);
    }
  }
});

/** 断言精确原因实体，不用 undefined 作为错误存在哨兵。 */
function hasCause(value: unknown, expected: unknown): boolean { return value === expected || value instanceof Error
  && (Object.hasOwn(value, "cause") && hasCause(value.cause, expected) || value instanceof AggregateError && value.errors.some(item => hasCause(item, expected))); }

for (const variant of ["versioned", "dev", "no-origin", "bad-main", "wrong-ini"] as const)
test(`host update facts ${variant} come only from actual versioned main and profile`, async () => {
  const h = await api(), entry = (h as unknown as Record<string, unknown>).readShellUpdateHostFacts;
  assert.equal(typeof entry, "function", "main host facts sampler is required");
  const f = await fixture();
  const input = { packaged: variant !== "dev", platform: "win32", configuredServerOrigin: variant === "no-origin" ? undefined : "https://updates.example.test",
    executablePath: f.main.executable, pid: f.main.pid, parentPid: f.helper.pid, userDataDir: f.input.userDataDir, sessionDataDir: f.input.sessionDataDir,
    snapshot: async () => [{ ...f.main, ...(variant === "bad-main" ? { created: 0 } : {}) }] };
  if (variant === "wrong-ini") await fs.writeFile(path.join(f.selected.installationDir, "shell-launch.ini"), serializeShellLaunchState(f.selected.originalState));
  if (variant === "bad-main" || variant === "wrong-ini") await assert.rejects((entry as (value: unknown) => Promise<any>)(input));
  else {
    const result = await (entry as (value: unknown) => Promise<any>)(input);
    assert.deepEqual(result, variant === "versioned" ? { installationDir: f.selected.installationDir, userDataDir: f.input.userDataDir, sessionDataDir: f.input.sessionDataDir, main: f.main } : undefined);
  }
});

test("safe main diagnostic projection preserves operation IDs and undefined causes without arbitrary text", async () => {
  const h = await api(), entry = (h as unknown as Record<string, unknown>).snapshotShellHandoffErrorContext;
  assert.equal(typeof entry, "function", "safe main diagnostics projection is required");
  const installerRequestId = crypto.randomUUID(), secret = "do-not-log nonce=private environment=private";
  const inner = Object.assign(new Error(secret, { cause: undefined }), { code: "DESKTOP_SHELL_INSTALLER_PROCESS_FAILED", requestId: "business.request+1", shellId: "new", revision: 8, phase: "process", installerRequestId,
    details: { diagnostic: { errorCode: "DESKTOP_SHELL_INSTALL_FAILED", requestId: installerRequestId, shellId: "new", stage: "extract", win32Error: 32, cleanupWin32Error: 5, raw: secret } } });
  const result = (entry as (value: unknown) => any)(new AggregateError([inner, undefined], secret));
  assert.equal(result.requestId, "business.request+1"); assert.equal(result.installerRequestId, installerRequestId); assert.equal(result.shellId, "new"); assert.equal(result.revision, 8); assert.equal(result.phase, "process");
  assert.equal(result.causeCodes.includes("UNDEFINED"), true); assert.equal(result.diagnostic.win32Error, 32); assert.equal(JSON.stringify(result).includes(secret), false);
});

for (const trap of ["element-getter", "slice-getter", "species-getter"] as const)
test(`safe main diagnostic projection never invokes aggregate ${trap}`, async () => {
  const h = await api(), errors: unknown[] = [undefined, Object.assign(new Error("private inner text"), { code: "INNER_FAILURE" })];
  let calls = 0;
  /** 恶意数组边界的访问必须可见，避免投影执行输入代码后伪称安全。 */
  const accessed = () => { calls++; throw new Error("untrusted array accessor executed"); };
  if (trap === "element-getter") Object.defineProperty(errors, "0", { get: accessed });
  if (trap === "slice-getter") Object.defineProperty(errors, "slice", { get: accessed });
  if (trap === "species-getter") Object.defineProperty(errors, "constructor", { value: Object.defineProperty({}, Symbol.species, { get: accessed }) });
  const aggregate = Object.assign(new AggregateError([], "private outer text"), { code: "OUTER_FAILURE", requestId: "business.aggregate+1" });
  Object.defineProperty(aggregate, "errors", { value: errors });
  const result = h.snapshotShellHandoffErrorContext(aggregate);
  assert.equal(calls, 0); assert.equal(result.requestId, "business.aggregate+1");
  assert.equal(result.causeCodes.includes("OUTER_FAILURE"), true); assert.equal(result.causeCodes.includes("INNER_FAILURE"), true);
  if (trap === "element-getter") assert.equal(result.causeCodes.includes("AGGREGATE_ERROR_ACCESSOR_OMITTED"), true);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

for (const variant of ["diagnostic-getter", "nested-getter", "field-getter", "array-getter", "extra-field", "symbol-field", "bad-hash", "zero-pid", "inconsistent-fields", "sparse-fields", "prototype"] as const)
test(`safe main identity projection rejects ${variant} without evaluating input or losing its cause`, async () => {
  const h = await api(), expected = { parentPid: 42, created: 1001, executableSha256: "a".repeat(64), commandLineSha256: "b".repeat(64) };
  const diagnostic: any = { pid: 81, changedFields: ["created"], expected, actual: { ...expected, created: 2001 } };
  const original = Object.assign(new Error("private-original-cause"), { code: "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED", processIdentityConflict: diagnostic });
  let reads = 0;
  const getter = { get() { reads++; throw new Error("UNTRUSTED_ACCESSOR_EVALUATED"); } };
  if (variant === "diagnostic-getter") Object.defineProperty(original, "processIdentityConflict", getter);
  if (variant === "nested-getter") Object.defineProperty(diagnostic, "expected", getter);
  if (variant === "field-getter") Object.defineProperty(diagnostic.actual, "created", getter);
  if (variant === "array-getter") Object.defineProperty(diagnostic.changedFields, "0", getter);
  if (variant === "extra-field") diagnostic.commandLine = "private-process-command";
  if (variant === "symbol-field") diagnostic[Symbol("private-field")] = "private-symbol";
  if (variant === "bad-hash") diagnostic.actual.commandLineSha256 = "private-command";
  if (variant === "zero-pid") diagnostic.pid = 0;
  if (variant === "inconsistent-fields") diagnostic.changedFields = ["parentPid"];
  if (variant === "sparse-fields") diagnostic.changedFields = new Array(1);
  if (variant === "prototype") Object.setPrototypeOf(diagnostic.actual, { command: "private-command" });
  const error = Object.assign(new Error("private-wrapper", { cause: original }), { code: "DESKTOP_SHELL_OPERATION_FAILED" });
  assert.throws(() => h.snapshotShellHandoffErrorContext(error), (failure: unknown) => {
    assert.ok(failure instanceof AggregateError); assert.equal(failure.errors[0], error);
    assert.equal(failure.errors[1].code, "DESKTOP_SHELL_HANDOFF_IDENTITY_CONFLICT_DIAGNOSTIC_INVALID");
    return true;
  });
  assert.equal(reads, 0);
});

for (const direction of ["original", "candidate"] as const) test(`current ${direction} recovery held permit uses current execution without changing historical admission`, async () => {
  const h = await api(), f = await recoveryFixture(direction), historical = structuredClone(f.bound.admission);
  const waiting = h.readShellHandoffStartup(f.input); f.channel.emit("message", f.message("bootstrap", { role: direction, main: f.main }));
  const startup = await waiting; if (startup.kind !== "held-candidate") throw new Error("held recovery required");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  const facts = { ...f.facts, client: { ...f.facts.client, pid: f.client.pid } };
  const authorized = session.continuation.authorizeReady(facts); await sentMessage(f.channel);
  f.channel.emit("message", f.message("permit")); await authorized; await finishStarted(session, startup, f);
  assert.equal(f.channel.sent[1].kind, "started"); assert.deepEqual((await f.store.read() as ShellUpdateAttemptV3).admission, historical);
  assert.equal(f.channel.sent[1].body.terminalEvidence.ready.main.pid, f.main.pid); session.dispose();
});

test("a sufficiently completed recovery starts ordinarily without rewriting historical phase", async () => {
  const h = await api(), f = await recoveryFixture("candidate", true);
  const caller = { ...f.main, pid: 401, parentPid: 390, created: 3401, commandLine: "ordinary after recovery" };
  const before = await fs.readFile(path.join(f.input.dataDir, "shell-update-attempt.json"));
  assert.equal((await h.readShellHandoffStartup({ ...f.input, argv: [], channel: undefined, pid: caller.pid, parentPid: caller.parentPid,
    trustedKeys: f.proof.trustedKeys, snapshot: async () => [caller] })).kind, "ordinary");
  assert.deepEqual(await fs.readFile(path.join(f.input.dataDir, "shell-update-attempt.json")), before);
});

test("a recovery permit cannot authorize changed current main or released helper", async () => {
  const h = await api(), f = await recoveryFixture("candidate");
  let processes = [f.helper, f.main, f.client];
  const waiting = h.readShellHandoffStartup({ ...f.input, snapshot: async () => processes });
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main }));
  const startup = await waiting; if (startup.kind !== "held-candidate") throw new Error("held recovery required");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  const authorized = session.continuation.authorizeReady({ ...f.facts, client: { ...f.facts.client, pid: f.client.pid } });
  await sentMessage(f.channel); processes = [f.main, f.client]; f.channel.emit("message", f.message("permit"));
  await assert.rejects(authorized); session.dispose();
});

test("a recovery permit rejects historical known Client revived after ready", async () => {
  const h = await api(), f = await recoveryFixture("candidate"); let processes = [f.helper, f.main, f.client];
  const waiting = h.readShellHandoffStartup({ ...f.input, snapshot: async () => processes });
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main })); const startup = await waiting;
  if (startup.kind !== "held-candidate") throw new Error("held recovery required");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  const authorized = session.continuation.authorizeReady({ ...f.facts, client: { ...f.facts.client, pid: f.client.pid } }); await sentMessage(f.channel);
  processes.push(f.bound.admission!.client); f.channel.emit("message", f.message("permit")); await assert.rejects(authorized); session.dispose();
});

test("terminal verification rechecks release after signed artifact IO before ordinary admission", async t => {
  const h = await api(), f = await terminalFixture("candidate"), readFile = fs.readFile; let revived = false;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const result = await readFile(...args); if (String(args[0]).endsWith("baseline-release-manifest.json")) revived = true; return result;
  });
  await assert.rejects(h.readShellHandoffStartup({ ...f.ordinaryInput, snapshot: async () => [f.caller, ...(revived ? [f.terminalClient] : [])] }));
});

test("shared IPC validator rejects extra fields, wrong nonce and malformed identity without exposing payload", async () => {
  const h = await api(), f = await fixture();
  assert.deepEqual(h.readShellHandoffMessage(f.message("arm", { oldMain: f.selected.oldMain })).kind, "arm");
  assert.equal(h.readShellHandoffMessage({ ...f.message("permit"), requestId: "attempt.1+retry:2" }).requestId, "attempt.1+retry:2");
  for (const message of [{ ...f.message("permit"), extra: true }, { ...f.message("permit"), nonce: "secret-invalid-nonce" },
    f.message("arm", { oldMain: { ...f.selected.oldMain, created: 0 } }), f.message("permit", { ok: true })]) {
    assert.throws(() => h.readShellHandoffMessage(message), error => { assert.equal(String(error).includes("secret-invalid-nonce"), false); return true; });
  }
});

for (const kind of ["ready", "started"] as const) for (const mode of ["return", "throw"] as const)
test(`shared IPC validator rejects binding kind ${mode} accessor in ${kind} without evaluating it`, async () => {
  const h = await api(), f = await fixture(); let getCalls = 0;
  const binding = Object.defineProperty({ ...f.selected.binding }, "kind", { enumerable: true, configurable: true,
    /** 不可信访问器必须在任何求值前被IPC边界拒绝。 */
    get() { getCalls += 1; if (mode === "throw") throw new Error("controlled binding getter"); return "installation"; } });
  const ready = { role: "candidate", continuationId: f.selected.continuationId, main: f.main, client: f.client,
    readyRequestId: "ready-1", health: f.facts.client.health, binding, launchState: f.selected.candidateState,
    profile: { dataDir: f.input.dataDir, userDataDir: f.input.userDataDir, sessionDataDir: f.input.sessionDataDir },
    mainFrame: "loaded", startup: f.facts.client.startup };
  const body = kind === "ready" ? { ready } : { terminalEvidence: { ready, startedRequestId: "started-1",
    continueRequestId: "continue-1", startup: "completed", application: "started" } };
  assert.throws(() => h.readShellHandoffMessage(f.message(kind, body)), { code: "DESKTOP_SHELL_HANDOFF_MESSAGE_INVALID" });
  assert.equal(getCalls, 0);
});

test("original recovery starts held on complete S0 and uses the same IPC without candidate admission", async () => {
  const h = await api(), f = await fixture();
  const main = { ...f.main, pid: 105, created: 1105, executable: f.selected.oldMain.executable, commandLine: "restored-original" };
  const client = { ...f.client, pid: 106, created: 1106, parentPid: main.pid };
  const snapshot = async () => [f.helper, main, client];
  await fs.writeFile(path.join(f.selected.installationDir, "shell-launch.ini"), "[shell]\r\nschema=1\r\nactive=old\r\nprevious=\r\nbaseline=baseline\r\n");
  const input = { ...f.input, pid: main.pid, executablePath: main.executable, snapshot };
  const pending = h.readShellHandoffStartup(input);
  f.channel.emit("message", f.message("bootstrap", { role: "original", main }));
  const startup = await pending; assert.equal(startup.kind, "held-candidate");
  if (startup.kind !== "held-candidate") throw new Error("unexpected startup");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  const ready = session.continuation.authorizeReady({ ...f.facts, client: { ...f.facts.client, pid: client.pid } }); await sentMessage(f.channel);
  assert.equal(f.channel.sent[0].body.ready.role, "original");
  f.channel.emit("message", f.message("permit")); await ready; await finishStarted(session, startup, f);
  assert.equal(f.channel.sent[1].body.terminalEvidence.ready.role, "original");
  assert.equal((await f.store.read() as ShellUpdateAttemptV3).admission, null);
});

test("original held permit accepts only the latest durable revision after monotonic owned observation", async () => {
  const h = await api(), f = await fixture(), initial = { ...f.selected, owned: [] };
  await fs.writeFile(path.join(f.input.dataDir, "shell-update-attempt.json"), JSON.stringify(initial));
  const main = { ...f.main, pid: 105, created: 1105, executable: f.selected.oldMain.executable, commandLine: "restored original" };
  const client = { ...f.client, pid: 106, created: 1106, parentPid: main.pid }, snapshot = async () => [f.helper, main, client];
  await fs.writeFile(path.join(f.selected.installationDir, "shell-launch.ini"), serializeShellLaunchState(f.selected.originalState));
  const waiting = h.readShellHandoffStartup({ ...f.input, pid: main.pid, executablePath: main.executable, snapshot });
  f.channel.emit("message", f.message("bootstrap", { role: "original", main })); const startup = await waiting;
  if (startup.kind !== "held-candidate") throw new Error("held original required");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  const authorized = session.continuation.authorizeReady({ ...f.facts, client: { ...f.facts.client, pid: client.pid } }); await sentMessage(f.channel);
  const observed = await f.store.observeHandoffOwned(initial, { caller: f.helper, processes: await snapshot() });
  assert.equal(observed.revision, initial.revision + 1); f.channel.emit("message", f.message("permit", {}, observed.revision));
  await authorized; await finishStarted(session, startup, f); assert.equal(f.channel.sent[1].revision, observed.revision); session.dispose();
});

test("ordinary startup reads absent attempt without querying processes or requiring an IPC permit", async () => {
  const h = await api(), f = await fixture(); await fs.unlink(path.join(f.input.dataDir, "shell-update-attempt.json"));
  assert.equal((await h.readShellHandoffStartup({ ...f.input, argv: [], snapshot: async () => { throw new Error("must not query"); } })).kind, "ordinary");
});

test("old main arms only its exact live helper over the shared protocol", async () => {
  const h = await api(), f = await fixture();
  const pending = h.startShellHandoffHelper({ channel: f.channel, oldMain: f.selected.oldMain, helper: f.helper,
    requestId: f.selected.requestId, continuationId: f.selected.continuationId, revision: f.selected.revision, nonce: "e".repeat(64),
    snapshot: async () => [f.selected.oldMain, f.helper], timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.channel.sent[0].kind, "arm");
  f.channel.emit("message", f.message("armed", { helper: f.helper }));
  const session = await pending; session.inbox.dispose();
  const before = f.channel.sent.length;
  await assert.rejects(h.startShellHandoffHelper({ channel: f.channel, oldMain: f.selected.oldMain, helper: f.helper,
    requestId: f.selected.requestId, continuationId: f.selected.continuationId, revision: f.selected.revision, nonce: "e".repeat(64),
    snapshot: async () => [f.selected.oldMain, { ...f.helper, created: f.helper.created + 1 }], timeoutMs: 1000 }));
  assert.equal(f.channel.sent.length, before);
});

test("the shared inbox rejects queued old permits and removes listeners on dispose", async () => {
  const h = await api(), f = await fixture(), inbox = h.createShellHandoffInbox(f.channel, 1000);
  const next = inbox.next("armed"); f.channel.emit("message", f.message("permit"));
  await assert.rejects(next, /DESKTOP_SHELL_HANDOFF_MESSAGE_ORDER_INVALID/u);
  await assert.rejects(inbox.next("permit")); inbox.dispose();
  assert.equal(f.channel.listenerCount("message"), 0); assert.equal(f.channel.listenerCount("disconnect"), 0); assert.equal(f.channel.listenerCount("error"), 0);
});

/** 仅推进等待定时器，证明慢核验仍可接收原协议消息且保留截止失败。 */
test("the shared inbox default accepts a valid message after thirty seconds", async t => {
  const h = await api(), f = await fixture(); t.mock.timers.enable({ apis: ["setTimeout"] });
  const inbox = h.createShellHandoffInbox(f.channel); let settled = false;
  const outcome = inbox.next("armed").then(value => { settled = true; return { value }; }, cause => { settled = true; return { cause }; });
  try {
    t.mock.timers.tick(30_001); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    const message = f.message("armed", { helper: f.helper }); f.channel.emit("message", message);
    assert.deepEqual(await outcome, { value: message });
  } finally { inbox.dispose(); await outcome; }
});

test("the shared inbox default fails exactly at its five minute deadline", async t => {
  const h = await api(), f = await fixture(); t.mock.timers.enable({ apis: ["setTimeout"] });
  const inbox = h.createShellHandoffInbox(f.channel); let settled = false;
  const outcome = inbox.next("armed").then(value => { settled = true; return { value }; }, cause => { settled = true; return { cause }; });
  try {
    t.mock.timers.tick(299_999); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    t.mock.timers.tick(1); const result = await outcome;
    assert.ok("cause" in result); assert.equal(result.cause.code, "DESKTOP_SHELL_HANDOFF_TIMEOUT");
  } finally { inbox.dispose(); await outcome; }
});

test("the shared inbox explicit timeout still fails at its shorter deadline", async t => {
  const h = await api(), f = await fixture(); t.mock.timers.enable({ apis: ["setTimeout"] });
  const inbox = h.createShellHandoffInbox(f.channel, 20); let settled = false;
  const outcome = inbox.next("armed").then(value => { settled = true; return { value }; }, cause => { settled = true; return { cause }; });
  try {
    t.mock.timers.tick(19); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    t.mock.timers.tick(1); const result = await outcome;
    assert.ok("cause" in result); assert.equal(result.cause.code, "DESKTOP_SHELL_HANDOFF_TIMEOUT");
  } finally { inbox.dispose(); await outcome; }
});

test("unmanaged pending attempt becomes recovery control with zero Client work", async () => {
  const h = await api(), f = await fixture();
  const result = await h.readShellHandoffStartup({ ...f.input, argv: [], channel: undefined });
  assert.equal(result.kind, "recovery-control");
});

for (const variant of ["parent", "main", "profile", "state", "flag", "revision"] as const) test(`candidate startup rejects ${variant} before any ready or continue`, async () => {
  const h = await api(), f = await fixture(); let input = f.input;
  if (variant === "parent") input = { ...input, snapshot: async () => [{ ...f.helper, created: f.helper.created + 1 }, f.main, f.client] };
  if (variant === "main") input = { ...input, snapshot: async () => [f.helper, { ...f.main, commandLine: "other" }, f.client] };
  if (variant === "profile") input = { ...input, sessionDataDir: f.input.userDataDir };
  if (variant === "flag") input = { ...input, argv: [...input.argv, "--codeflow-shell-handoff"] };
  if (variant === "state") await fs.writeFile(path.join(f.selected.installationDir, "shell-launch.ini"), "[shell]\r\nschema=1\r\nactive=old\r\nprevious=\r\nbaseline=baseline\r\n");
  const pending = h.readShellHandoffStartup(input);
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main }, f.selected.revision + (variant === "revision" ? 1 : 0)));
  await assert.rejects(pending); assert.equal(f.channel.sent.length, 0);
});

test("started waits for its durable terminal and actual helper release before automatic work can resume", async () => {
  const h = await api(), f = await fixture(); let processes = await f.snapshot(), settled = false;
  const waiting = h.readShellHandoffStartup({ ...f.input, snapshot: async () => processes });
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main })); const startup = await waiting;
  if (startup.kind !== "held-candidate") throw new Error("held candidate required");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  const authorized = session.continuation.authorizeReady(f.facts); await sentMessage(f.channel);
  const current = await f.store.read() as ShellUpdateAttemptV3;
  const intended = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission: f.channel.sent[0].body.ready }) as ShellUpdateAttemptV3;
  f.channel.emit("message", f.message("permit", {}, intended.revision)); await authorized;
  const sent = once(f.channel, "sent"), completion = session.started().then(() => { settled = true; }); await sent;
  await f.store.read(); assert.equal(settled, false, "sending started does not finish helper persistence");
  const terminal = f.channel.sent[1].body.terminalEvidence;
  await f.store.replace(intended, { ...intended, revision: intended.revision + 1, phase: "completed", terminalEvidence: terminal });
  await f.store.read(); assert.equal(settled, false, "terminal alone does not prove actual helper release");
  processes = [f.main, f.client]; await completion; assert.equal(settled, true); session.dispose();
});

for (const defect of ["helper-alive", "terminal-missing", "foreign-terminal", "snapshot-failure", "helper-pid-reused", "owned-pid-reused", "helper-unknown-child", "disconnect-only"] as const)
test(`started ${defect} fails explicitly without changing its live main or replaying admission`, async () => {
  const h = await api(), f = await fixture(); let finishing = false;
  const child = { ...f.client, pid: 556, parentPid: f.main.pid, created: f.client.created + 1 };
  if (defect === "owned-pid-reused") await fs.writeFile(path.join(f.input.dataDir, "shell-update-attempt.json"), JSON.stringify({ ...f.selected, owned: [f.client, child] }));
  const snapshot = async () => {
    if (!finishing) return [...await f.snapshot(), ...(defect === "owned-pid-reused" ? [child] : [])];
    if (defect === "snapshot-failure") throw undefined;
    return [f.main, f.client, ...(["helper-alive", "disconnect-only"].includes(defect) ? [f.helper]
      : defect === "helper-pid-reused" ? [{ ...f.helper, created: f.helper.created + 1 }]
        : defect === "helper-unknown-child" ? [{ ...f.helper, pid: 555, parentPid: f.helper.pid, created: f.helper.created + 1 }]
          : defect === "owned-pid-reused" ? [{ ...child, created: child.created + 1 }] : [])];
  };
  const waiting = h.readShellHandoffStartup({ ...f.input, snapshot, timeoutMs: 3000 });
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main })); const startup = await waiting;
  if (startup.kind !== "held-candidate") throw new Error("held candidate required");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  const authorized = session.continuation.authorizeReady(f.facts); await sentMessage(f.channel);
  const current = await f.store.read() as ShellUpdateAttemptV3;
  const intended = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission: f.channel.sent[0].body.ready }) as ShellUpdateAttemptV3;
  f.channel.emit("message", f.message("permit", {}, intended.revision)); await authorized;
  let enteredCompletion = false;
  /** started发送回调前固化受控终态，短预算仅测真正completion等待，不消耗上游握手或测试自身IO。 */
  f.channel.send = function (message: any, callback: (error: Error | null) => void): boolean {
    this.sent.push(message);
    void (async () => {
      assert.equal(message.kind, "started");
      if (defect !== "terminal-missing") {
        const terminal = message.body.terminalEvidence;
        await f.store.replace(intended, { ...intended, revision: intended.revision + 1, phase: "completed", terminalEvidence:
          defect === "foreign-terminal" ? { ...terminal, startedRequestId: "another-started" } : terminal });
      }
      finishing = true; enteredCompletion = true; startup.input.timeoutMs = 150;
      this.emit("sent"); callback(null);
      if (defect === "disconnect-only") this.emit("disconnect");
    })().catch(callback);
    return true;
  };
  const sent = once(f.channel, "sent"), completion = session.started();
  const rejected = assert.rejects(completion, (cause: any) => defect === "snapshot-failure" ? cause === undefined
    : cause?.code === `DESKTOP_SHELL_HANDOFF_${defect === "foreign-terminal" ? "COMPLETION_EVIDENCE_CHANGED"
      : ["helper-pid-reused", "owned-pid-reused"].includes(defect) ? "COMPLETION_PROCESS_CHANGED" : defect === "helper-unknown-child" ? "PREVIOUS_PROCESS_UNRELEASED"
        : defect === "terminal-missing" ? "COMPLETION_TERMINAL_TIMEOUT" : "COMPLETION_HELPER_RELEASE_TIMEOUT"}`);
  await sent;
  const before = await fs.readFile(path.join(f.input.dataDir, "shell-update-attempt.json")); await rejected;
  assert.equal(enteredCompletion, true);
  assert.deepEqual(await fs.readFile(path.join(f.input.dataDir, "shell-update-attempt.json")), before);
  assert.equal(f.channel.sent.filter(item => item.kind === "started").length, 1); session.dispose();
});

for (const schema of [3, 5] as const) for (const age of ["older", "older-partial", "same", "newer", "unknown"] as const)
test(`historical parent PID schema${schema} ${age} row cannot change helper release ownership`, async () => {
  const h = await api(), f = await fixture(schema === 5 ? 5 : false);
  let finishing = false;
  const child = { ...f.helper, pid: 555, parentPid: f.helper.pid,
    created: age.startsWith("older") ? f.helper.created - 1 : age === "same" ? f.helper.created : age === "newer" ? f.helper.created + 1 : 0,
    executable: age === "older-partial" ? "" : f.helper.executable, commandLine: "unrelated parent PID record" };
  const pending = h.readShellHandoffStartup({ ...f.input, snapshot: async () => finishing ? [f.main, f.client, child] : f.snapshot() });
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main }));
  const startup = await pending;
  if (startup.kind !== "held-candidate") throw new Error("held candidate required");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  const ready = session.continuation.authorizeReady(f.facts); await sentMessage(f.channel);
  const current = await f.store.read() as ShellUpdateHandoffAttempt;
  const intended = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission: f.channel.sent[0].body.ready }) as ShellUpdateHandoffAttempt;
  f.channel.emit("message", f.message("permit", {}, shellUpdateHandoffRevision(intended))); await ready;
  const send = f.channel.send;
  // 持久终态后才暴露历史行，直接覆盖最终 helper 释放校验。
  f.channel.send = function (value: any, callback: (error: Error | null) => void) {
    if (value.kind !== "started") return send.call(this, value, callback);
    void (async () => {
      const latest = await f.store.read() as ShellUpdateHandoffAttempt;
      await f.store.replace(latest, { ...latest, revision: latest.revision + 1, phase: "completed", terminalEvidence: value.body.terminalEvidence });
      finishing = true; send.call(this, value, callback);
    })().catch(callback);
    return true;
  };
  try {
    if (age.startsWith("older")) await session.started();
    else await assert.rejects(session.started());
    assert.equal(f.channel.sent.filter(value => value.kind === "started").length, 1);
    assert.equal((await f.store.read())?.phase, "completed");
  } finally { session.dispose(); }
});

test("trusted ready waits for a newer persisted intent then started follows successful application completion", async () => {
  const h = await api(), f = await fixture(); const pending = h.readShellHandoffStartup(f.input);
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main })); const startup = await pending;
  assert.equal(startup.kind, "held-candidate"); if (startup.kind !== "held-candidate") throw new Error("unexpected startup");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  const ready = session.continuation.authorizeReady(f.facts); await sentMessage(f.channel);
  const sent = f.channel.sent[0]; assert.equal(sent.kind, "ready");
  const current = await f.store.read() as ShellUpdateAttemptV3;
  const intended = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission: sent.body.ready }) as ShellUpdateAttemptV3;
  f.channel.emit("message", f.message("permit", {}, intended.revision)); await ready;
  assert.equal(f.channel.sent.length, 1);
  await finishStarted(session, startup, f); assert.equal(f.channel.sent[1].kind, "started");
  assert.equal(f.channel.sent[1].revision, intended.revision);
  assert.equal(f.channel.sent[1].body.terminalEvidence.continueRequestId, "application-continue-1"); session.dispose();
});

test("new-child snapshot latest candidate inventory accepts foreign reuse only after the helper persisted release", async t => {
  const h = await api(), f = await fixture(5);
  const child = { ...f.main, pid: 480, parentPid: f.main.pid, created: 2480, commandLine: "released before ready" };
  const initial = await f.store.observeHandoffOwned(f.selected, { caller: f.helper, processes: [...await f.snapshot(), child] });
  let rows = [...await f.snapshot(), child];
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    callback(null, JSON.stringify(rows));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    const waiting = h.readShellHandoffStartup({ ...f.input, snapshot: undefined });
    f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main }));
    const startup = await waiting; if (startup.kind !== "held-candidate") throw new Error("held candidate required");
    const released = await f.store.observeHandoffOwned(initial, { caller: f.helper, processes: await f.snapshot() });
    rows = [...await f.snapshot(), { ...child, parentPid: 900, created: 5000, commandLine: "unrelated foreign reuse" }];
    const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
    const authorized = session.continuation.authorizeReady(f.facts);
    const sent = sentMessage(f.channel);
    const state = await Promise.race([authorized.then(() => "authorized"), sent.then(() => "ready")]);
    assert.equal(state, "ready");
    const intended = await f.store.replace(released, { ...released, revision: released.revision + 1, phase: "admission-intent", admission: f.channel.sent[0].body.ready }) as ShellUpdateHandoffAttempt;
    f.channel.emit("message", f.message("permit", {}, shellUpdateHandoffRevision(intended))); await authorized;
    assert.equal(f.channel.sent[0].kind, "ready"); session.dispose();
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("new-child snapshot candidate completion waits for a complete new path through the default query", async t => {
  const h = await api(), f = await fixture(5);
  const child = { ...f.main, pid: 480, parentPid: f.main.pid, created: 2480, commandLine: "completion delayed path" };
  let finishing = false, injected = false, completed = false;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const rows = [f.main, f.client, ...(!finishing ? [f.helper] : [])];
    if (finishing) { rows.push(injected ? child : { ...child, executable: "" }); completed = injected; injected = true; }
    callback(null, JSON.stringify(rows));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    const waiting = h.readShellHandoffStartup({ ...f.input, snapshot: undefined });
    f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main }));
    const startup = await waiting; if (startup.kind !== "held-candidate") throw new Error("held candidate required");
    const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
    const authorized = session.continuation.authorizeReady(f.facts); await sentMessage(f.channel);
    const current = await f.store.read() as ShellUpdateHandoffAttempt;
    const intended = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission: f.channel.sent[0].body.ready }) as ShellUpdateHandoffAttempt;
    f.channel.emit("message", f.message("permit", {}, shellUpdateHandoffRevision(intended))); await authorized;
    const send = f.channel.send;
    f.channel.send = function (value: any, callback: (error: Error | null) => void) {
      if (value.kind !== "started") return send.call(this, value, callback);
      void (async () => {
        const latest = await f.store.read() as ShellUpdateHandoffAttempt;
        await f.store.replace(latest, { ...latest, revision: latest.revision + 1, phase: "completed", terminalEvidence: value.body.terminalEvidence });
        finishing = true; send.call(this, value, callback);
      })().catch(callback);
      return true;
    };
    await session.started(); session.dispose();
    assert.equal(injected, true); assert.equal(completed, true); assert.equal((await f.store.read())?.phase, "completed");
    assert.equal(f.channel.sent.filter(message => message.kind === "started").length, 1);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const schema of [4, 5] as const) for (const wrongRevision of [false, true]) test(`schema${schema} candidate ${wrongRevision ? "rejects physical revision as a permit" : "completes with monotonic observations and an exact control permit"}`, async () => {
  const h = await api(), f = await fixture(schema === 5 ? 5 : true);
  let processes = await f.snapshot(); f.input.snapshot = async () => processes;
  const waiting = h.readShellHandoffStartup(f.input);
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main }));
  const startup = await waiting; if (startup.kind !== "held-candidate") throw new Error("held candidate required");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  const authorized = session.continuation.authorizeReady(f.facts); await sentMessage(f.channel);
  const query = { ...f.client, pid: 150, created: f.client.created + 1, commandLine: "candidate query" };
  let current = await f.store.observeHandoffOwned(f.selected, { caller: f.helper, processes: [...processes, query] });
  current = await f.store.observeHandoffOwned(current, { caller: f.helper, processes });
  current = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission: f.channel.sent[0].body.ready }) as ShellUpdateHandoffAttempt;
  const permitRevision = shellUpdateHandoffRevision(current);
  const permitQuery = { ...query, pid: 151, created: query.created + 1 };
  current = await f.store.observeHandoffOwned(current, { caller: f.helper, processes: [...processes, permitQuery] });
  processes = [...processes, { ...query, parentPid: 900, created: 5000, commandLine: "foreign query after durable release" }];
  current = await f.store.observeHandoffOwned(current, { caller: f.helper, processes });
  assert.ok(current.revision > permitRevision);
  f.channel.emit("message", f.message("permit", {}, wrongRevision ? current.revision : permitRevision));
  if (wrongRevision) await assert.rejects(authorized, { code: "DESKTOP_SHELL_HANDOFF_PERMIT_NOT_COMMITTED" });
  else {
    await authorized; await finishStarted(session, startup, f);
    assert.equal(f.channel.sent[1].revision, permitRevision); assert.equal((await f.store.read())!.phase, "completed");
  }
  session.dispose();
});

for (const variant of ["canonical", "main", "client", "both"] as const) test(`candidate permit accepts ${variant} identity key order with unchanged values`, async t => {
  const h = await api(), f = await fixture();
  await fs.writeFile(path.join(f.input.dataDir, "shell-update-attempt.json"), JSON.stringify({ ...f.selected, owned: [] }));
  /** 复现CIM Hashtable键序，仅重排原五字段，不改变实例身份值。 */
  const sampled = (identity: ProcessIdentity): ProcessIdentity => ({ created: identity.created, pid: identity.pid,
    parentPid: identity.parentPid, commandLine: identity.commandLine, executable: identity.executable });
  const main = variant === "main" || variant === "both" ? sampled(f.main) : f.main;
  const client = variant === "client" || variant === "both" ? sampled(f.client) : f.client;
  assert.deepEqual(main, f.main); assert.deepEqual(client, f.client);
  const pending = h.readShellHandoffStartup({ ...f.input, snapshot: async () => [f.helper, main, client] });
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main })); const startup = await pending;
  if (startup.kind !== "held-candidate") throw new Error("held candidate required");
  assert.deepEqual(startup.attempt.owned, [], "bootstrap precedes the new Client inventory observation");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  t.after(() => session.dispose());
  const authorized = session.continuation.authorizeReady(f.facts); const sent = await sentMessage(f.channel);
  const beforeReady = await f.store.read() as ShellUpdateAttemptV3;
  const current = await f.store.observeHandoffOwned(beforeReady, { caller: f.helper, processes: [f.helper, main, client], knownOwned: [client] });
  const intended = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission: sent.body.ready }) as ShellUpdateAttemptV3;
  f.channel.emit("message", f.message("permit", {}, intended.revision)); await authorized;
  await finishStarted(session, startup, f);
  assert.equal((await f.store.read())?.phase, "completed");
});

for (const role of ["main", "client"] as const) for (const field of ["pid", "parentPid", "created", "executable", "commandLine"] as const)
test(`candidate permit rejects changed ${role} ${field} after ready`, async t => {
  const h = await api(), f = await fixture(); let processes = await f.snapshot();
  const pending = h.readShellHandoffStartup({ ...f.input, snapshot: async () => processes });
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main })); const startup = await pending;
  if (startup.kind !== "held-candidate") throw new Error("held candidate required");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  t.after(() => session.dispose());
  const authorized = session.continuation.authorizeReady(f.facts); const sent = await sentMessage(f.channel);
  const current = await f.store.read() as ShellUpdateAttemptV3;
  const intended = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission: sent.body.ready }) as ShellUpdateAttemptV3;
  const identity = f[role], value = identity[field];
  processes = processes.map(item => item.pid === identity.pid ? { ...item, [field]: typeof value === "number" ? value + 1 : value + "-changed" } : item);
  f.channel.emit("message", f.message("permit", {}, intended.revision));
  await assert.rejects(authorized, { code: "DESKTOP_SHELL_HANDOFF_PERMIT_FACTS_CHANGED" });
  await assert.rejects(session.started(), { code: "DESKTOP_SHELL_HANDOFF_MESSAGE_ORDER_INVALID" });
  assert.equal(f.channel.sent.some(item => item.kind === "started"), false);
});

test("candidate permit rejects a different valid durable ready request", async t => {
  const h = await api(), f = await fixture(), pending = h.readShellHandoffStartup(f.input);
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main })); const startup = await pending;
  if (startup.kind !== "held-candidate") throw new Error("held candidate required");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  t.after(() => session.dispose());
  const authorized = session.continuation.authorizeReady(f.facts); const sent = await sentMessage(f.channel);
  const current = await f.store.read() as ShellUpdateAttemptV3;
  const intended = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent",
    admission: { ...sent.body.ready, readyRequestId: "different-ready-request" } }) as ShellUpdateAttemptV3;
  f.channel.emit("message", f.message("permit", {}, intended.revision));
  await assert.rejects(authorized, { code: "DESKTOP_SHELL_HANDOFF_PERMIT_NOT_COMMITTED" });
  await assert.rejects(session.started(), { code: "DESKTOP_SHELL_HANDOFF_MESSAGE_ORDER_INVALID" });
});

for (const variant of ["early-permit", "no-intent", "wrong-nonce", "old-revision", "frame", "binding"] as const) test(`candidate ${variant} cannot authorize continue`, async () => {
  const h = await api(), f = await fixture(); const pending = h.readShellHandoffStartup(f.input);
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main })); const startup = await pending;
  assert.equal(startup.kind, "held-candidate"); if (startup.kind !== "held-candidate") throw new Error("unexpected startup");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: variant !== "frame", trusted: true }) });
  if (variant === "early-permit") f.channel.emit("message", f.message("permit"));
  const facts = variant === "binding" ? { ...f.facts, client: { ...f.facts.client, health: { ...f.facts.client.health, dbSchemaVersion: 8 } } } : f.facts;
  const ready = session.continuation.authorizeReady(facts);
  if (!["early-permit", "frame", "binding"].includes(variant)) {
    await sentMessage(f.channel);
    f.channel.emit("message", { ...f.message("permit", {}, f.selected.revision + (variant === "old-revision" ? 0 : 1)), ...(variant === "wrong-nonce" ? { nonce: "f".repeat(64) } : {}) });
  }
  await assert.rejects(ready); await assert.rejects(session.started()); session.dispose();
});

test("send failure settles the pending permit and does not leave an unhandled rejection", async () => {
  const h = await api(), f = await fixture(); const pending = h.readShellHandoffStartup(f.input);
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main })); const startup = await pending;
  if (startup.kind !== "held-candidate") throw new Error("unexpected startup");
  const failure = new Error("controlled IPC send failure"); f.channel.send = (_message, callback) => { callback(failure); return false; };
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  await assert.rejects(session.continuation.authorizeReady(f.facts), error => error === failure); session.dispose();
  await new Promise(resolve => setImmediate(resolve));
});

test("candidate permission cannot survive a changed actual INI after its ready", async () => {
  const h = await api(), f = await fixture(); const pending = h.readShellHandoffStartup(f.input);
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main })); const startup = await pending;
  if (startup.kind !== "held-candidate") throw new Error("unexpected startup");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  const ready = session.continuation.authorizeReady(f.facts); await sentMessage(f.channel);
  const current = await f.store.read() as ShellUpdateAttemptV3;
  const intended = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission: f.channel.sent[0].body.ready }) as ShellUpdateAttemptV3;
  await fs.writeFile(path.join(f.selected.installationDir, "shell-launch.ini"), "[shell]\r\nschema=1\r\nactive=old\r\nprevious=\r\nbaseline=baseline\r\n");
  f.channel.emit("message", f.message("permit", {}, intended.revision));
  await assert.rejects(ready); session.dispose();
});

test("a permit cannot adopt a different durable request after the original ready", async () => {
  const h = await api(), f = await fixture(); const pending = h.readShellHandoffStartup(f.input);
  f.channel.emit("message", f.message("bootstrap", { role: "candidate", main: f.main })); const startup = await pending;
  if (startup.kind !== "held-candidate") throw new Error("unexpected startup");
  const session = h.createShellHandoffContinuation({ startup, getMainFrame: () => ({ loaded: true, trusted: true }) });
  const ready = session.continuation.authorizeReady(f.facts); await sentMessage(f.channel);
  const current = await f.store.read() as ShellUpdateAttemptV3;
  const intended = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission: f.channel.sent[0].body.ready }) as ShellUpdateAttemptV3;
  await fs.writeFile(path.join(f.input.dataDir, "shell-update-attempt.json"), JSON.stringify({ ...intended, requestId: "different.request+1" }));
  f.channel.emit("message", f.message("permit", {}, intended.revision));
  await assert.rejects(ready); session.dispose();
});
