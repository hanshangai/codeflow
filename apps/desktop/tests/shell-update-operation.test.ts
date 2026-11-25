import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { ChildProcess } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { DESKTOP_STARTUP_CAPABILITY_PATH } from "@codeflowai/shared";
import { desktopDevicePublicKeySha256, readDesktopDeviceHeaders } from "@codeflowai/shared/desktop-device-auth";
import { readReleaseBundleFiles, computeReleaseDirectorySha256, computeReleasePackageSha256, signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import { assertShellUpdateInventoryReleased, createShellUpdateAttemptStore, createShellUpdateAttemptNetworkAdapter, isShellUpdateHandoffAttempt, shellUpdateProcessHistory, type ShellUpdateAttemptV2 } from "../src/shellUpdateAttempt.js";
import { readShellLaunchState, serializeShellLaunchState } from "../src/shellLaunchState.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";
import type { ProcessIdentity } from "../src/windowsProcessIdentity.js";

/** 首轮真实缺入口RED；后续直接消费产品模块。 */
async function api() { assert.ok(existsSync(new URL("../src/shellUpdateOperation.ts", import.meta.url)), "shell operation must connect existing owners"); return await import("../src/shellUpdateOperation.js"); }

test("shell progress observes verified target and postponement without exposing owner paths", async t => {
  const h = await api(), f = await fixture(t); f.control.confirm = false;
  const observations: Array<{ requestId: string; phase: string; result?: string; target?: { shellId: string; version: string } }> = [];
  const result = await h.runShellUpdateOperation({ ...f.input, onProgress: observation => { observations.push(observation); } });
  assert.equal(result.status, "postponed");
  assert.deepEqual(observations.map(item => item.phase), ["prepare", "download", "install", "health", "handoff", "handoff"]);
  assert.deepEqual(observations.find(item => item.target)?.target, { shellId: "new", version: "2.0.0" });
  assert.equal(observations.at(-1)?.result, "postponed");
  assert.equal(JSON.stringify(observations).includes(f.input.dataDir), false);
});

test("recovery display never replaces the original handoff failure phase", async t => {
  const h = await api(), f = await fixture(t); f.control.fail = "drain";
  const observations: Array<{ phase: string }> = [], failures: Error[] = [];
  await assert.rejects(h.runShellUpdateOperation({ ...f.input,
    onFailure(error) { failures.push(error); }, onProgress(observation) { observations.push(observation); } }), error => {
    assert.equal((error as Error & { failurePhase: string }).failurePhase, "handoff"); return true;
  });
  assert.equal((failures[0] as Error & { failurePhase: string }).failurePhase, "handoff");
  assert.equal(observations.at(-1)?.phase, "recovery");
});

test("falsy recovery observation failure retains a live helper owner and original failure context", async t => {
  const h = await api(), f = await fixture(t); f.control.fail = "drain";
  const snapshot = f.input.boundary.snapshot;
  let blockIdentity = true;
  f.input.boundary.snapshot = async () => {
    const processes = await snapshot(); return blockIdentity && f.actions.includes("interrupt/drain") ? processes.filter(item => item.pid !== f.input.facts.main.pid) : processes;
  };
  let rejected: unknown;
  try { await h.runShellUpdateOperation({ ...f.input, onProgress(observation) { if (observation.phase === "recovery") throw false; } }); }
  catch (error) { rejected = error; }
  assert.ok(rejected instanceof Error);
  const fields = Object.getOwnPropertyDescriptors(rejected);
  assert.equal(typeof fields.helperOwner?.value?.recover, "function");
  assert.equal(fields.failurePhase?.value, "handoff"); assert.equal(fields.requestId?.value, f.input.requestId);
  assert.equal(fields.deviceId?.value, f.input.identity.deviceId);
  assert.equal(f.control.closed, false); assert.equal(f.actions.includes("resume"), false);
  blockIdentity = false;
  await fields.helperOwner!.value.recover(new Error("explicit cleanup"));
  assert.equal(f.control.closed, true);
});

/** 保留真实store/INI和签名binding；夹具预算容纳磁盘往返，不用于验证超时。 */
async function fixture(t: test.TestContext, legacy = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cf-shell-operation-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installationDir = path.join(root, "installation"), dataDir = path.join(root, "data");
  const userDataDir = path.join(root, "user"), sessionDataDir = path.join(root, "session"), temporaryParentDir = path.join(root, "temporary");
  for (const directory of [dataDir, userDataDir, sessionDataDir, temporaryParentDir]) await fs.mkdir(directory);
  for (const shell of ["old", "baseline", "new"]) { const directory = path.join(installationDir, "shells", shell); await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, "CodeFlowAI.exe"), "fixture"); }
  const initialReleaseDir = path.join(installationDir, "shells", "baseline", "resources"), clientDir = path.join(initialReleaseDir, "client", "dist");
  await fs.mkdir(clientDir, { recursive: true }); await fs.mkdir(path.join(initialReleaseDir, "web"));
  await fs.writeFile(path.join(clientDir, "index.cjs"), "client"); await fs.writeFile(path.join(initialReleaseDir, "web", "index.html"), "web");
  await fs.writeFile(path.join(initialReleaseDir, DESKTOP_STARTUP_CAPABILITY_PATH), JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: crypto.createHash("sha256").update("client").digest("hex") }));
  await fs.writeFile(path.join(initialReleaseDir, "release-trust.json"), "{}");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519"), files = await readReleaseBundleFiles(initialReleaseDir);
  const webSha256 = computeReleaseDirectorySha256(files, "web"), clientSha256 = computeReleaseDirectorySha256(files, "client");
  const baseline = signReleaseBundleManifest({ schemaVersion: 2, releaseId: "baseline", version: "1", webVersion: "1", clientVersion: "1", protocolVersion: 1,
    capabilityVersion: 1, dbSchemaVersion: 7, platform: process.platform, arch: process.arch, keyId: "fixture", archiveSha256: "a".repeat(64), archiveSize: 1,
    files, webSha256, clientSha256, packageSha256: computeReleasePackageSha256(webSha256, clientSha256), createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, privateKey);
  await fs.writeFile(path.join(initialReleaseDir, "baseline-release-manifest.json"), JSON.stringify(baseline));
  const originalState = { activeShellId: "old", previousShellId: null, baselineShellId: "baseline" };
  await fs.writeFile(path.join(installationDir, "shell-launch.ini"), serializeShellLaunchState(originalState));
  const main: ProcessIdentity = { pid: 101, parentPid: 90, created: 1101, executable: path.join(installationDir, "shells", "old", "CodeFlowAI.exe"), commandLine: "main" };
  const helper = { ...main, pid: 103, parentPid: main.pid, created: 1103, commandLine: "helper" };
  const client = { ...main, pid: 102, parentPid: main.pid, created: 1102, commandLine: "client" };
  const health = { protocolVersion: 1 as const, clientVersion: "1", dbSchemaVersion: 7, database: "ready" as const };
  const store = createShellUpdateAttemptStore(dataDir), identity = await loadOrCreateDeviceIdentity(dataDir), actions: string[] = [];
  const control = { available: true, confirm: true, fail: "", drained: false, closed: false, spawned: false, cleanupFail: false };
  const manifest = { shellId: "new", version: "2.0.0", installerSha256: "b".repeat(64), installerSize: 1 } as any;
  const target = { shellId: "new", manifestSha256: "c".repeat(64), installerSha256: manifest.installerSha256, installerSize: 1 };
  const channel = Object.assign(new EventEmitter(), { pid: helper.pid, connected: true,
    /** 模拟真实继承IPC响应时序，store迁移仍由产品发生。 */
    send(message: any, callback: (error: Error | null) => void): boolean { actions.push(message.kind); callback(null);
      queueMicrotask(() => { void (async () => {
        if (message.kind === "arm") channel.emit("message", { ...message, kind: "armed", body: { helper } });
        if (message.kind === "accept") channel.emit("message", { ...message, kind: "accepted", body: {} });
        if (message.kind === "drained") {
          const adapter = createShellUpdateAttemptNetworkAdapter(store), current = await adapter.read();
          const dispatch = await adapter.replace(current, { retriesUsed: current.retriesUsed, network: { actionKey: `shell-authorize:${current.revision}`, requestSha256: "1".repeat(64), status: "dispatching" } });
          const authorized = await adapter.replace(dispatch, { retriesUsed: dispatch.retriesUsed, network: { ...dispatch.network!, status: "succeeded", evidence: { kind: "shell-switch-authorization", sha256: "2".repeat(64) } } });
          const attempt = await store.read(); await fs.writeFile(path.join(installationDir, "shell-launch.ini"), serializeShellLaunchState(attempt!.candidateState));
          channel.emit("message", { ...message, revision: authorized.revision, kind: "exit-request", body: {} });
        }
      })().catch(error => channel.emit("error", error)); }); return true; },
    /** 清理只关闭本次helper；恢复后必须重新核原S0。 */
    disconnect() { actions.push("disconnect"); if (control.cleanupFail) throw new Error("helper cleanup failed"); channel.connected = false; control.closed = true; queueMicrotask(() => channel.emit("close", 1, null)); },
    unref() { actions.push("unref"); } });
  let installerDownloads = 0;
  const network = {
    /** 使用真实store推进发现结果，不伪造attempt引用。 */
    async prepare() { actions.push("network.prepare"); if (control.fail === "prepare") throw new Error("prepare failed");
      let current = await store.read() as ShellUpdateAttemptV2;
      if (current.target) return { status: "target" as const, attempt: current, manifest };
      const dispatch = await store.replace(current, { ...current, revision: current.revision + 1, network: { actionKey: "shell-discover", requestSha256: "d".repeat(64), status: "dispatching" } }) as ShellUpdateAttemptV2;
      current = await store.replace(dispatch, { ...dispatch, revision: dispatch.revision + 1, network: { ...dispatch.network!, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "e".repeat(64) } } }) as ShellUpdateAttemptV2;
      if (!control.available) return { status: "no-update" as const, attempt: await store.replace(current, { ...current, revision: current.revision + 1, phase: "no-update" }) as ShellUpdateAttemptV2 };
      return { status: "target" as const, manifest, attempt: await store.replace(current, { ...current, revision: current.revision + 1, target,
        candidateState: { activeShellId: "new", previousShellId: "old", baselineShellId: "baseline" } }) as ShellUpdateAttemptV2 };
    },
    /** 原网络owner只产生真实安装器成功槽。 */
    async downloadInstaller() { actions.push("network.download"); if (control.fail === "download") throw new Error("download failed");
      let current = await store.read() as ShellUpdateAttemptV2;
      if (current.network?.actionKey === "shell-installer" && current.network.status === "succeeded") return { installerPath: path.join(root, "installer.exe"), sha256: manifest.installerSha256, size: 1 };
      installerDownloads++;
      const dispatch = await store.replace(current, { ...current, revision: current.revision + 1, network: { actionKey: "shell-installer", requestSha256: "f".repeat(64), status: "dispatching" } }) as ShellUpdateAttemptV2;
      current = await store.replace(dispatch, { ...dispatch, revision: dispatch.revision + 1, network: { ...dispatch.network!, status: "succeeded", evidence: { kind: "shell-installer", sha256: "b".repeat(64) } } }) as ShellUpdateAttemptV2;
      return { installerPath: path.join(root, "installer.exe"), sha256: manifest.installerSha256, size: 1 }; }
  };
  const input = { dataDir, initialReleaseDir, identity, trustedKeys: { fixture: publicKey }, configuredServerOrigin: "http://127.0.0.1:1", requestId: crypto.randomUUID(), signal: new AbortController().signal,
    facts: { installationDir, userDataDir, sessionDataDir, main, temporaryParentDir }, getClient: () => ({ status: "ready" as const, requestId: "ready-1", releaseId: null as string | null, errorCode: null, pid: client.pid, health }),
    onRetry: async () => {},
    hooks: {
      async prepare() { actions.push("prepare"); if (control.fail === "admission") throw new Error("prepare admission failed"); return control.confirm; },
      async drain() { actions.push("interrupt/drain"); if (control.fail === "drain") throw new Error("drain failed"); control.drained = true; },
      async resume() { actions.push("resume"); control.drained = false; },
      committed() { actions.push("committed"); }
    },
    boundary: { createNetwork: () => network,
      async install() { actions.push("install"); if (control.fail === "install") throw new Error("install failed"); return { manifest, candidateDirectory: path.join(installationDir, "shells", "new") }; },
      async health() { actions.push("health"); if (control.fail === "health") throw new Error("health failed"); return { schemaVersion: 1 as const, requestId: crypto.randomUUID(), candidateShellId: "new", temporaryRoot: temporaryParentDir, status: "passed" as const,
        checks: [{ role: "baseline" as const, releaseId: "installation", releaseDir: initialReleaseDir, health, native: { loaded: [], credentialsAccessed: false as const, ptyCreated: false as const }, web: { files: [] }, database: { integrity: "ok" as const, schemaVersion: 7 }, childClosed: true as const }], phase: "completed" }; },
      async snapshot() { return [main, ...(!control.drained ? [client] : []), ...(control.spawned && !control.closed ? [helper] : [])]; },
      spawnHelper() { actions.push("spawn"); control.spawned = true; return channel as unknown as ChildProcess; },
      async stop() { actions.push("stop"); control.closed = true; queueMicrotask(() => channel.emit("close", null, "SIGTERM")); }
    }, timeoutMs: 10_000 };
  if (legacy) await store.replace(null, { schemaVersion: 2, requestId: input.requestId, revision: 0,
    installationDir, dataDir, userDataDir, sessionDataDir, originalState,
    binding: { kind: "installation", baselineShellId: "baseline", health }, retriesUsed: 0, phase: "preparing", target: null, candidateState: null, network: null });
  return { input, actions, control, store, root, channel, originalState, client, baseline, privateKey, get installerDownloads() { return installerDownloads; } };
}

/** 创建真实验签的新活动包，确保重绑定使用当前资源的签名和健康事实。 */
async function createActiveRelease(f: Awaited<ReturnType<typeof fixture>>) {
  const directory = path.join(f.input.dataDir, "releases", "active-new");
  await fs.mkdir(path.join(directory, "client", "dist"), { recursive: true });
  await fs.mkdir(path.join(directory, "web"), { recursive: true });
  for (const relative of ["client/dist/index.cjs", "web/index.html", DESKTOP_STARTUP_CAPABILITY_PATH]) {
    await fs.copyFile(path.join(f.input.initialReleaseDir, relative), path.join(directory, relative));
  }
  const files = await readReleaseBundleFiles(directory), webSha256 = computeReleaseDirectorySha256(files, "web");
  const clientSha256 = computeReleaseDirectorySha256(files, "client");
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: "active-new", version: "2", webVersion: "2", clientVersion: "2",
    protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 8, platform: process.platform, arch: process.arch, keyId: "fixture",
    archiveSha256: "d".repeat(64), archiveSize: 1, files, webSha256, clientSha256,
    packageSha256: computeReleasePackageSha256(webSha256, clientSha256), createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, f.privateKey);
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(f.input.dataDir, "active-release.json"), JSON.stringify({ releaseId: manifest.releaseId }));
  return manifest;
}

test("a prepared shell attempt rebinds to newly healthy resources without downloading its verified installer again", async t => {
  const h = await api(), f = await fixture(t); f.control.confirm = false;
  const first = await h.runShellUpdateOperation(f.input), prepared = await f.store.read() as ShellUpdateAttemptV2;
  assert.equal(first.status, "postponed");
  assert.equal(prepared.network?.actionKey, "shell-installer");
  assert.equal(prepared.network?.status, "succeeded");
  const manifest = await createActiveRelease(f);
  const main: ProcessIdentity = { ...f.input.facts.main, pid: 201, created: 1201, commandLine: "new main" };
  const client: ProcessIdentity = { ...f.client, pid: 202, parentPid: main.pid, created: 1202, commandLine: "new client" };
  f.input.facts.main = main;
  f.input.getClient = () => ({ status: "ready", requestId: "ready-new", releaseId: manifest.releaseId, errorCode: null,
    pid: client.pid, health: { protocolVersion: 1, clientVersion: "2", dbSchemaVersion: 8, database: "ready" } });
  f.input.boundary.snapshot = async () => [main, client];
  f.input.boundary.health = async () => ({ schemaVersion: 1, requestId: crypto.randomUUID(), candidateShellId: "new", temporaryRoot: f.input.facts.temporaryParentDir,
    status: "passed", phase: "completed", checks: [{ role: "baseline", releaseId: "installation", releaseDir: f.input.initialReleaseDir,
      health: { protocolVersion: 1, clientVersion: "1", dbSchemaVersion: 7, database: "ready" }, native: { loaded: [], credentialsAccessed: false, ptyCreated: false },
      web: { files: [] }, database: { integrity: "ok", schemaVersion: 7 }, childClosed: true }, { role: "active", releaseId: manifest.releaseId,
      releaseDir: path.join(f.input.dataDir, "releases", manifest.releaseId), health: { protocolVersion: 1, clientVersion: "2", dbSchemaVersion: 8, database: "ready" },
      native: { loaded: [], credentialsAccessed: false, ptyCreated: false },
      web: { files: [] }, database: { integrity: "ok", schemaVersion: 8 }, childClosed: true }] } as any);

  const resumed = await h.runShellUpdateOperation(f.input);
  const rebound = await f.store.read() as ShellUpdateAttemptV2;
  assert.equal(resumed.status, "postponed");
  assert.equal(rebound.requestId, prepared.requestId);
  assert.deepEqual(rebound.target, prepared.target);
  assert.deepEqual(rebound.network, prepared.network);
  assert.equal(rebound.binding.kind, "active");
  assert.equal(rebound.binding.kind === "active" && rebound.binding.releaseId, manifest.releaseId);
  assert.equal(f.installerDownloads, 1);
});

test("shell operation creates one original attempt and starts a fresh cycle only from proven no-update", async t => {
  const h = await api(), f = await fixture(t); f.control.available = false;
  const first = await h.runShellUpdateOperation(f.input), original = await f.store.read();
  assert.equal(first.status, "no-update"); assert.equal(original?.requestId, f.input.requestId);
  const secondId = crypto.randomUUID(); await h.runShellUpdateOperation({ ...f.input, requestId: secondId });
  assert.equal((await f.store.read())?.requestId, secondId);
  assert.equal(f.actions.includes("prepare"), false); assert.equal(f.control.spawned, false);
});

test("D13 manual network retry preserves acknowledged failure and opens a distinct checked cycle", async t => {
  const h = await api(), f = await fixture(t); f.control.fail = "prepare";
  await assert.rejects(h.runShellUpdateOperation(f.input));
  const adapter = createShellUpdateAttemptNetworkAdapter(f.store), current = await adapter.read();
  const sent = await adapter.replace(current, { retriesUsed: 0, network: { actionKey: "shell-discover", requestSha256: "d".repeat(64), status: "dispatching" } });
  await adapter.replace(sent, { retriesUsed: 0, network: { ...sent.network!, status: "failed", errorCode: "NETWORK_REFUSED" } });
  const before = await f.store.read(), journal = createUpdateFailureJournal(f.input.dataDir);
  const evidence = journal.recordShell({ deviceId: f.input.identity.deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1", clientVersion: "1",
    requestId: before!.requestId, shellId: null, phase: "prepare", recovery: "not_needed", error: new Error("DESKTOP_SHELL_NETWORK_FAILED") });
  await journal.flush(f.input.identity.deviceId, async record => record);
  f.control.fail = ""; f.control.available = false;
  await assert.rejects(h.runShellUpdateOperation({ ...f.input, requestId: crypto.randomUUID() }));
  assert.deepEqual(await f.store.read(), before);
  let checks = 0; const nextId = crypto.randomUUID();
  const result = await h.runShellUpdateOperation({ ...f.input, requestId: nextId, manual: true,
    getFailureEvidence(requestId: string, shellId: string | null) { checks++; assert.equal(requestId, before!.requestId); assert.equal(shellId, null); return evidence; } } as any);
  assert.equal(result.status, "no-update"); assert.equal(checks, 1);
  const after = await f.store.read(); assert.equal(after!.requestId, nextId); assert.equal(after!.retriesUsed, 0);
  assert.equal(f.actions.includes("spawn"), false);
});

test("D13 manual checking cannot reset a dispatching action or a failed action without durable evidence", async t => {
  const h = await api(), f = await fixture(t); f.control.fail = "prepare";
  await assert.rejects(h.runShellUpdateOperation(f.input));
  const adapter = createShellUpdateAttemptNetworkAdapter(f.store), current = await adapter.read();
  const sent = await adapter.replace(current, { retriesUsed: 0, network: { actionKey: "shell-discover", requestSha256: "d".repeat(64), status: "dispatching" } });
  const dispatching = await f.store.read(); let evidenceReads = 0;
  await assert.rejects(h.runShellUpdateOperation({ ...f.input, requestId: crypto.randomUUID(), manual: true,
    getFailureEvidence() { evidenceReads++; assert.fail("unknown dispatch cannot authorize a fresh cycle"); } } as any));
  assert.equal(evidenceReads, 0); assert.deepEqual(await f.store.read(), dispatching);
  await adapter.replace(sent, { retriesUsed: 0, network: { ...sent.network!, status: "failed", errorCode: "NETWORK_REFUSED" } });
  const failed = await f.store.read();
  await assert.rejects(h.runShellUpdateOperation({ ...f.input, requestId: crypto.randomUUID(), manual: true }));
  assert.deepEqual(await f.store.read(), failed); assert.equal(f.actions.includes("spawn"), false);
});

for (const stage of ["prepare", "download", "install", "health"] as const) test(`D13 shell failure keeps the exact ${stage} execution boundary`, async t => {
  const h = await api(), f = await fixture(t); f.control.fail = stage;
  await assert.rejects(h.runShellUpdateOperation(f.input), (error: any) => {
    assert.equal(error.failurePhase, stage); assert.equal(error.recovery, "not_needed");
    assert.equal(error.shellId ?? null, stage === "prepare" ? null : "new"); return true;
  });
});

test("D13 postponed admission cancellation failure is never reported as not needing recovery", async t => {
  const h = await api(), f = await fixture(t), primary = new Error("controlled postponed cancel failure"); f.control.confirm = false;
  f.input.hooks.resume = async () => { throw primary; };
  await assert.rejects(h.runShellUpdateOperation(f.input), (error: any) => {
    assert.equal(error.cause, primary); assert.equal(error.failurePhase, "handoff"); assert.equal(error.recovery, "failed"); return true;
  });
  assert.equal(f.control.spawned, false);
});

test("schema5 operation persists a gone ordinary instance before foreign PID reuse between stages", async t => {
  const h = await api(), f = await fixture(t), snapshot = f.input.boundary.snapshot;
  const worker = { ...f.client, pid: 211, created: 1211, commandLine: "preparation worker" };
  const foreign = { ...worker, parentPid: 900, created: 2211, commandLine: "unrelated reused instance" };
  f.control.confirm = false;
  f.input.boundary.snapshot = async () => [...await snapshot(), ...(f.actions.includes("network.download") ? [foreign]
    : f.actions.includes("network.prepare") ? [] : [worker])];
  assert.equal((await h.runShellUpdateOperation(f.input)).status, "postponed");
  const attempt = await f.store.read(); assert.equal(attempt?.schemaVersion, 5);
  if (attempt?.schemaVersion !== 5 || !("ownedLifecycle" in attempt)) throw new Error("schema5 inventory required");
  assert.deepEqual(attempt.owned, [f.client, worker]);
  assert.notEqual(attempt.ownedLifecycle[1]?.release, null);
  assert.equal(attempt.preparationMains.length, 1); assert.equal(f.control.spawned, false);
});

test("schema5 operation cannot adopt PID reuse before a product release snapshot", async t => {
  const h = await api(), f = await fixture(t), snapshot = f.input.boundary.snapshot;
  const worker = { ...f.client, pid: 212, created: 1212, commandLine: "active preparation worker" };
  f.input.boundary.snapshot = async () => [...await snapshot(), f.actions.includes("network.prepare")
    ? { ...worker, parentPid: 900, created: 2212, commandLine: "foreign" } : worker];
  await assert.rejects(h.runShellUpdateOperation(f.input));
  const attempt = await f.store.read(); assert.equal(attempt?.schemaVersion, 5);
  if (attempt?.schemaVersion !== 5 || !("ownedLifecycle" in attempt)) throw new Error("schema5 inventory required");
  assert.equal(attempt.ownedLifecycle[1]?.release, null);
  assert.deepEqual(f.actions, ["network.prepare"]); assert.equal(f.control.spawned, false);
});

test("schema5 Client binding failure precedes preparation release persistence", async t => {
  const h = await api(), f = await fixture(t), snapshot = f.input.boundary.snapshot, getClient = f.input.getClient;
  const worker = { ...f.client, pid: 213, created: 1213, commandLine: "exiting preparation worker" };
  f.input.boundary.snapshot = async () => [...await snapshot(), ...(!f.actions.includes("network.prepare") ? [worker] : [])];
  f.input.getClient = () => ({ ...getClient(), requestId: f.actions.includes("network.prepare") ? "changed-ready" : "ready-1" });
  await assert.rejects(h.runShellUpdateOperation(f.input), (cause: any) => cause.cause?.code === "DESKTOP_SHELL_OPERATION_CLIENT_BINDING_CHANGED");
  const attempt = await f.store.read(); assert.equal(attempt?.schemaVersion, 5);
  if (attempt?.schemaVersion !== 5 || !("ownedLifecycle" in attempt)) throw new Error("schema5 inventory required");
  assert.equal(attempt.ownedLifecycle[1]?.release, null); assert.equal(f.control.spawned, false);
});

for (const released of [false, true]) test(`schema5 first default snapshot ${released ? "accepts released" : "rejects unreleased"} foreign PID reuse`, async t => {
  const h = await api(), f = await fixture(t), rawSnapshot = f.input.boundary.snapshot;
  const worker = { ...f.client, pid: 214, created: 1214, commandLine: "first-operation worker" };
  f.control.confirm = false;
  f.input.boundary.snapshot = async () => [...await rawSnapshot(), ...(!released || !f.actions.includes("network.prepare") ? [worker] : [])];
  assert.equal((await h.runShellUpdateOperation(f.input)).status, "postponed");
  const before = await f.store.read(), count = f.actions.length;
  const { snapshot: _snapshot, ...boundary } = f.input.boundary;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    void rawSnapshot().then(rows => callback(null, JSON.stringify([...rows, { ...worker, parentPid: 900, created: 2214, commandLine: "foreign instance" }]))).catch(cause => callback(cause));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    const operation = h.runShellUpdateOperation({ ...f.input, boundary });
    if (released) {
      assert.equal((await operation).status, "postponed");
      const after = await f.store.read();
      assert.equal(after?.schemaVersion, 5);
      if (after?.schemaVersion !== 5 || !("owned" in after)) throw new Error("preparation inventory required");
      assert.deepEqual(after.owned, [f.client, worker]);
    } else {
      await assert.rejects(operation);
      assert.deepEqual(await f.store.read(), before); assert.equal(f.actions.length, count);
    }
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("schema5 arm freezes preparation revision and persists the disappearing child only at handoff", async t => {
  const h = await api(), f = await fixture(t), snapshot = f.input.boundary.snapshot;
  const worker = { ...f.client, pid: 215, created: 1215, commandLine: "arm-window worker" };
  let armedRevision: number | undefined;
  f.channel.on("message", message => { if (message.kind === "armed") armedRevision = message.revision; });
  f.input.boundary.snapshot = async () => [...await snapshot(), ...(!f.actions.includes("arm") ? [worker] : [])];
  const result = await h.runShellUpdateOperation(f.input), attempt = await f.store.read();
  assert.equal(result.status, "handoff");
  if (!attempt || attempt.schemaVersion !== 5 || !isShellUpdateHandoffAttempt(attempt)) throw new Error("handoff5 required");
  assert.equal(attempt.handoffRevision, armedRevision! + 1);
  assert.equal(attempt.ownedLifecycle[1]?.release?.revision, attempt.handoffRevision);
  if (result.status === "handoff") result.owner.release();
});

test("schema5 preparation rejects an inventory write while its network stage is running", async t => {
  const h = await api(), f = await fixture(t), createNetwork = f.input.boundary.createNetwork;
  f.input.boundary.createNetwork = () => {
    const network = createNetwork();
    return { ...network,
      /** 注入真实并发库存写，网络返回后原operation必须拒绝接纳。 */
      async prepare() {
        const prepared = await network.prepare(), expected = await f.store.read();
        if (expected?.schemaVersion !== 5 || isShellUpdateHandoffAttempt(expected)) throw new Error("preparation5 required");
        await f.store.observePreparationOwned(expected, { caller: f.input.facts.main, processes: [...await f.input.boundary.snapshot(),
          { ...f.client, pid: 216, created: 1216, commandLine: "concurrent observed worker" }] });
        return { ...prepared, attempt: await f.store.read() as typeof prepared.attempt };
      }
    };
  };
  await assert.rejects(h.runShellUpdateOperation(f.input), (cause: any) => cause.cause?.code === "DESKTOP_SHELL_OPERATION_ATTEMPT_CHANGED");
  assert.deepEqual(f.actions, ["network.prepare"]); assert.equal(f.control.spawned, false);
});

test("legacy schema2 remains strict and hands off as schema4 without upgrading preparation", async t => {
  const h = await api(), f = await fixture(t, true);
  const result = await h.runShellUpdateOperation(f.input);
  assert.equal(result.status, "handoff"); assert.equal((await f.store.read())?.schemaVersion, 4);
  if (result.status === "handoff") result.owner.release();
});

test("operation default snapshot retries a known Client partial without advancing its network slot", async t => {
  const h = await api(), f = await fixture(t); f.control.available = false;
  const { snapshot: rawSnapshot, ...boundary } = f.input.boundary;
  let injected = false, sawRetry = false;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    void (async () => {
      const rows = structuredClone(await rawSnapshot());
      if (!injected && f.actions.includes("network.prepare")) {
        const client = rows.find(item => item.pid === f.client.pid)!;
        client.executable = ""; client.commandLine = ""; injected = true;
      } else if (injected) sawRetry = true;
      callback(null, JSON.stringify(rows));
    })().catch(cause => callback(cause));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    const result = await h.runShellUpdateOperation({ ...f.input, boundary });
    assert.equal(result.status, "no-update"); assert.equal(injected, true); assert.equal(sawRetry, true);
    assert.equal((await f.store.read())?.phase, "no-update"); assert.equal(f.actions.includes("spawn"), false);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("new-child snapshot preparation operation records a delayed path without reopening its network stage", async t => {
  const h = await api(), f = await fixture(t); f.control.available = false;
  const { snapshot: rawSnapshot, ...boundary } = f.input.boundary;
  const child = { ...f.client, pid: 280, created: 1280, commandLine: "preparation delayed path" };
  let injected = false;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    void (async () => {
      const rows = await rawSnapshot();
      if (f.actions.includes("network.prepare")) { rows.push(injected ? child : { ...child, executable: "" }); injected = true; }
      callback(null, JSON.stringify(rows));
    })().catch(cause => callback(cause));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    assert.equal((await h.runShellUpdateOperation({ ...f.input, boundary })).status, "no-update");
    const actual = await f.store.read();
    assert.equal(injected, true); assert.ok(actual?.schemaVersion === 5);
    assert.equal(actual.owned.find(item => item.pid === child.pid)?.executable, child.executable);
    assert.equal(f.actions.filter(action => action === "network.prepare").length, 1);
    assert.equal(f.control.spawned, false);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const stage of ["prepare", "download", "install", "health"] as const) test(`shell ${stage} failure leaves original Client admitted and never spawns helper`, async t => {
  const h = await api(), f = await fixture(t); f.control.fail = stage;
  await assert.rejects(h.runShellUpdateOperation(f.input), error => { assert.equal((error as any).requestId, f.input.requestId); assert.equal((error as any).deviceId, f.input.identity.deviceId); assert.equal((error as Error).cause instanceof Error && ((error as Error).cause as Error).message, `${stage} failed`); return true; });
  assert.equal(f.actions.includes("prepare"), false); assert.equal(f.control.spawned, false); assert.equal(f.control.drained, false);
});

test("shell postponement resumes D09 before helper creation and can reuse the same schema5 attempt", async t => {
  const h = await api(), f = await fixture(t); f.control.confirm = false;
  assert.equal((await h.runShellUpdateOperation(f.input)).status, "postponed");
  const attempt = await f.store.read(); assert.equal(attempt?.schemaVersion, 5); assert.equal(attempt?.phase, "preparing");
  assert.deepEqual(f.actions.slice(-2), ["prepare", "resume"]); assert.equal(f.control.spawned, false);
  f.control.confirm = true; const result = await h.runShellUpdateOperation({ ...f.input, requestId: crypto.randomUUID() });
  assert.equal(result.requestId, attempt!.requestId); assert.equal(result.status, "handoff"); if (result.status === "handoff") result.owner.release();
});

test("shell handoff uses arm then durable begin then accepted before draining and returns an owned exit handle", async t => {
  const h = await api(), f = await fixture(t);
  const result = await h.runShellUpdateOperation(f.input);
  assert.equal(result.status, "handoff");
  assert.deepEqual(f.actions, ["network.prepare", "network.download", "install", "health", "prepare", "spawn", "arm", "accept", "committed", "interrupt/drain", "drained"]);
  const attempt = await f.store.read(); assert.equal(attempt?.schemaVersion, 5); assert.equal(attempt?.phase, "handoff");
  assert.equal(f.actions.includes("unref"), false);
  if (result.status !== "handoff") throw new Error("handoff required");
  result.owner.release(); assert.equal(f.actions.at(-1), "unref");
});

test("baseline health uses the installation label even when its signed release ID differs", async t => {
  const h = await api(), f = await fixture(t), health = f.input.boundary.health;
  f.input.boundary.health = async () => {
    const report = await health(); report.checks[0].releaseId = "installation"; return report;
  };
  const result = await h.runShellUpdateOperation(f.input);
  assert.equal(result.status, "handoff");
  assert.equal((await f.store.read())?.schemaVersion, 5);
  if (result.status === "handoff") result.owner.release();
});

test("baseline health cannot substitute its manifest ID for the installation selection label", async t => {
  const h = await api(), f = await fixture(t), health = f.input.boundary.health;
  f.input.boundary.health = async () => {
    const report = await health(); report.checks[0].releaseId = f.baseline.releaseId; return report;
  };
  await assert.rejects(h.runShellUpdateOperation(f.input), cause => (cause as Error).cause instanceof Error
    && ((cause as Error).cause as Error & { code?: string }).code === "DESKTOP_SHELL_OPERATION_HEALTH_BINDING_CHANGED");
  assert.equal(f.control.spawned, false); assert.equal(f.actions.includes("prepare"), false);
  assert.equal(await fs.readFile(path.join(f.input.facts.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(f.originalState));
});

test("baseline health cannot report another directory for the installation selection", async t => {
  const h = await api(), f = await fixture(t), health = f.input.boundary.health;
  f.input.boundary.health = async () => {
    const report = await health(); report.checks[0].releaseDir = f.input.dataDir; return report;
  };
  await assert.rejects(h.runShellUpdateOperation(f.input), cause => (cause as Error).cause instanceof Error
    && ((cause as Error).cause as Error & { code?: string }).code === "DESKTOP_SHELL_OPERATION_HEALTH_BINDING_CHANGED");
  assert.equal(f.control.spawned, false); assert.equal(f.actions.includes("prepare"), false);
});

for (const defect of ["none", "label", "directory"] as const) test(`active health preserves its signed selection with ${defect} defect`, async t => {
  const h = await api(), f = await fixture(t), getClient = f.input.getClient, health = f.input.boundary.health;
  const { signature: _signature, ...payload } = f.baseline;
  const manifest = signReleaseBundleManifest({ ...payload, releaseId: "hot-health", clientVersion: "2" }, f.privateKey);
  const releaseDir = path.join(f.input.dataDir, "releases", manifest.releaseId); await fs.mkdir(releaseDir, { recursive: true });
  for (const name of ["client", "web"]) await fs.cp(path.join(f.input.initialReleaseDir, name), path.join(releaseDir, name), { recursive: true });
  await fs.writeFile(path.join(releaseDir, "manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(f.input.dataDir, "active-release.json"), JSON.stringify({ releaseId: manifest.releaseId }));
  const activeHealth = { ...getClient().health, clientVersion: "2" };
  const input = { ...f.input, getClient: () => ({ ...getClient(), releaseId: manifest.releaseId, health: activeHealth }),
    boundary: { ...f.input.boundary, async health() {
      const report = await health();
      return { ...report, checks: [...report.checks, { ...report.checks[0], role: "active" as const,
        releaseId: defect === "label" ? "installation" : manifest.releaseId,
        releaseDir: defect === "directory" ? f.input.initialReleaseDir : releaseDir, health: activeHealth }] };
    } } };
  if (defect === "none") {
    const result = await h.runShellUpdateOperation(input); assert.equal(result.status, "handoff");
    if (result.status === "handoff") result.owner.release();
  } else {
    await assert.rejects(h.runShellUpdateOperation(input), cause => (cause as Error).cause instanceof Error
      && ((cause as Error).cause as Error & { code?: string }).code === "DESKTOP_SHELL_OPERATION_HEALTH_BINDING_CHANGED");
    assert.equal(f.control.spawned, false); assert.equal(f.actions.includes("prepare"), false);
  }
});

test("accepted handoff ignores a later external abort and still owns the required exit", async t => {
  const h = await api(), f = await fixture(t), controller = new AbortController();
  const drain = f.input.hooks.drain; f.input.hooks.drain = async () => { controller.abort(new Error("external exit")); await drain(); };
  const result = await h.runShellUpdateOperation({ ...f.input, signal: controller.signal });
  assert.equal(result.status, "handoff"); if (result.status === "handoff") result.owner.release();
});

test("interrupt failure closes exact helper before resuming original admission and preserves failure", async t => {
  const h = await api(), f = await fixture(t); f.control.fail = "drain";
  await assert.rejects(h.runShellUpdateOperation(f.input));
  assert.equal(f.control.closed, true); assert.equal(f.control.drained, false);
  assert.ok(f.actions.indexOf("disconnect") < f.actions.indexOf("resume"));
});

test("an installed stage cannot change the durable target before creating the helper", async t => {
  const h = await api(), f = await fixture(t), install = f.input.boundary.install;
  f.input.boundary.install = async () => {
    const result = await install(), attempt = await f.store.read();
    await fs.writeFile(path.join(f.input.dataDir, "shell-update-attempt.json"), JSON.stringify({ ...attempt, requestId: "different-request" }));
    return result;
  };
  await assert.rejects(h.runShellUpdateOperation(f.input));
  assert.equal(f.control.spawned, false); assert.equal(f.actions.includes("prepare"), false);
});

test("a missing current client instance cannot be replaced by a reused PID between stage checks", async t => {
  const h = await api(), f = await fixture(t), install = f.input.boundary.install;
  f.input.boundary.install = async () => {
    const result = await install();
    f.client.created += 1;
    return result;
  };
  await assert.rejects(h.runShellUpdateOperation(f.input));
  assert.equal(f.control.spawned, false); assert.equal(f.actions.includes("prepare"), false);
});

test("an unreadable admission direction retains the live helper owner and never resumes Client", async t => {
  const h = await api(), f = await fixture(t);
  const drain = f.input.hooks.drain;
  f.input.hooks.drain = async () => { await drain(); await fs.writeFile(path.join(f.input.dataDir, "shell-update-attempt.json"), "{}"); throw undefined; };
  await assert.rejects(h.runShellUpdateOperation(f.input), error => { assert.ok((error as any).helperOwner); assert.equal(((error as Error).cause as AggregateError).errors[0], undefined); return true; });
  assert.equal(f.control.closed, false); assert.equal(f.actions.includes("resume"), false);
  f.channel.disconnect();
});

/** helper产生后只注入一次首错，恢复仍使用同一合法快照与真实store。 */
function failPrearm(f: Awaited<ReturnType<typeof fixture>>, primary: unknown) {
  const snapshot = f.input.boundary.snapshot;
  let injected = false;
  f.input.boundary.snapshot = async () => {
    if (f.control.spawned && !injected) { injected = true; throw primary; }
    return await snapshot();
  };
}

for (const rejectResume of [false, true]) test(`prearm failure is observed before held resume ${rejectResume ? "rejects" : "completes"}`, async t => {
  const h = await api(), f = await fixture(t), primary = new Error("prearm snapshot failed"), additional = new Error("resume failed");
  failPrearm(f, primary);
  let enter!: () => void, release!: () => void, settled = false;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const observed: any[] = [];
  f.input.hooks.resume = async () => { f.actions.push("resume"); enter(); await held; if (rejectResume) throw additional; };
  const flight = h.runShellUpdateOperation({ ...f.input, onFailure(error: Error) {
    observed.push(error); assert.equal(f.control.closed, false); assert.equal(f.actions.includes("resume"), false);
  } }).then(() => { settled = true; throw new Error("EXPECTED_FAILURE"); }, error => { settled = true; return error; });
  try {
    await entered;
    assert.equal(settled, false); assert.equal(f.control.closed, true); assert.equal(observed.length, 1);
    assert.equal(observed[0].cause, primary); assert.equal(observed[0].requestId, f.input.requestId);
    assert.equal(observed[0].deviceId, f.input.identity.deviceId); assert.equal(observed[0].phase, "preparing");
    assert.ok(observed[0].helperOwner); assert.equal(f.actions.includes("arm"), false);
  } finally { release(); }
  const failure = await flight;
  assert.equal(failure.helperOwner, undefined);
  if (rejectResume) { assert.notEqual(failure, observed[0]); assert.deepEqual(failure.cause.errors, [primary, additional]); }
  else { assert.equal(failure, observed[0]); assert.equal(failure.cause, primary); }
});

for (const primary of [null, false, undefined]) test(`prearm failure observation preserves ${String(primary)} cause`, async t => {
  const h = await api(), f = await fixture(t), observed: Error[] = [];
  failPrearm(f, primary);
  await assert.rejects(h.runShellUpdateOperation({ ...f.input, onFailure(error: Error) { observed.push(error); } }), error => {
    assert.equal(observed.length, 1); assert.equal(error, observed[0]); assert.equal((error as Error).cause, primary); return true;
  });
  assert.equal(f.control.closed, true); assert.equal(f.actions.at(-1), "resume");
});

for (const observerFailure of [null, false, undefined]) test(`prearm failure observer throwing ${String(observerFailure)} closes helper and forbids resume`, async t => {
  const h = await api(), f = await fixture(t), primary = new Error("prearm snapshot failed");
  failPrearm(f, primary);
  await assert.rejects(h.runShellUpdateOperation({ ...f.input, onFailure() { throw observerFailure; } }), (error: any) => {
    assert.deepEqual(error.cause.errors, [primary, observerFailure]); assert.equal(error.helperOwner, undefined); return true;
  });
  assert.equal(f.control.closed, true); assert.equal(f.actions.includes("resume"), false);
});

test("failure observer errors preserve the original unknown-direction helper ownership", async t => {
  const h = await api(), f = await fixture(t), observerFailure = new Error("log write failed");
  const drain = f.input.hooks.drain;
  f.input.hooks.drain = async () => { await drain(); await fs.writeFile(path.join(f.input.dataDir, "shell-update-attempt.json"), "{}"); throw undefined; };
  try {
    await assert.rejects(h.runShellUpdateOperation({ ...f.input, onFailure() { throw observerFailure; } }), (error: any) => {
      assert.ok(error.helperOwner); assert.equal(error.cause.errors[0], undefined); assert.equal(error.cause.errors[1], observerFailure);
      assert.equal(error.cause.errors.length, 3); assert.ok(error.cause.errors[2] instanceof Error); return true;
    });
    assert.equal(f.control.closed, false); assert.equal(f.actions.includes("resume"), false);
  } finally { f.channel.disconnect(); }
});

test("failure observer errors retain cleanup failures without resuming admission", async t => {
  const h = await api(), f = await fixture(t), observerFailure = new Error("log write failed"), primary = new Error("drain failed");
  const drain = f.input.hooks.drain;
  f.input.hooks.drain = async () => { await drain(); throw primary; }; f.control.cleanupFail = true;
  await assert.rejects(h.runShellUpdateOperation({ ...f.input, onFailure() { throw observerFailure; } }), (error: any) => {
    assert.equal(error.cause.errors[0], primary); assert.equal(error.cause.errors[1], observerFailure);
    assert.equal(error.cause.errors.length, 3); assert.equal(error.cause.errors[2].errors[0].message, "helper cleanup failed"); return true;
  });
  assert.equal(f.control.closed, true); assert.equal(f.actions.includes("resume"), false);
});

test("helper cleanup failure retains both original and cleanup errors without resuming admission", async t => {
  const h = await api(), f = await fixture(t); f.control.fail = "drain"; f.control.cleanupFail = true;
  await assert.rejects(h.runShellUpdateOperation(f.input), error => {
    const cause = (error as Error).cause as AggregateError;
    assert.ok(cause instanceof AggregateError); assert.equal(cause.errors[0].message, "drain failed");
    assert.equal(cause.errors[1].errors[0].message, "helper cleanup failed"); return true;
  });
  assert.equal(f.control.closed, true); assert.equal(f.actions.includes("resume"), false);
});

for (const stopFailure of [new Error("helper stop failed"), undefined]) {
  test(`an unclosed helper preserves disconnect and ${stopFailure === undefined ? "undefined" : "stop"} failures without resuming admission`, async t => {
    const h = await api(), f = await fixture(t), primary = new Error("drain failed"), disconnect = new Error("helper disconnect failed"), late = new Error("cleanup process error");
    f.input.hooks.drain = async () => { throw primary; };
    f.channel.disconnect = () => { f.actions.push("disconnect"); f.channel.emit("error", late); throw disconnect; };
    f.input.boundary.stop = async () => { f.actions.push("stop"); throw stopFailure; };
    await assert.rejects(h.runShellUpdateOperation(f.input), (error: any) => {
      assert.equal(error.requestId, f.input.requestId); assert.equal(error.deviceId, f.input.identity.deviceId);
      assert.equal(error.shellId, "new"); assert.ok(error.helperOwner); assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors[0], primary);
      const cleanup = error.cause.errors[1]; assert.ok(cleanup instanceof AggregateError);
      assert.ok(cleanup.errors.includes(disconnect)); assert.ok(cleanup.errors.includes(stopFailure)); assert.ok(cleanup.errors.includes(late));
      assert.equal(cleanup.errors.filter((item: any) => item?.code === "DESKTOP_SHELL_OPERATION_HELPER_NOT_CLOSED").length, 1);
      assert.throws(() => error.helperOwner.check(), (cause: any) => cause instanceof AggregateError && cause.errors.includes(late));
      return true;
    });
    assert.equal(f.control.closed, false); assert.equal(f.actions.includes("resume"), false);
    assert.equal(f.actions.filter(action => action === "stop").length, 1);
    assert.deepEqual((await readShellLaunchState(f.input.facts.installationDir)).state, f.originalState);
  });
}

test("an unclosed helper retains both close deadlines and its original owner", async t => {
  const h = await api(), f = await fixture(t), primary = new Error("drain failed");
  f.input.timeoutMs = 1000; f.input.hooks.drain = async () => { throw primary; };
  f.channel.disconnect = () => { f.actions.push("disconnect"); f.channel.connected = false; };
  f.input.boundary.stop = async () => { f.actions.push("stop"); };
  await assert.rejects(h.runShellUpdateOperation(f.input), (error: any) => {
    assert.ok(error.helperOwner); assert.equal(error.cause.errors[0], primary);
    const cleanup = error.cause.errors[1]; assert.ok(cleanup instanceof AggregateError);
    assert.equal(cleanup.errors.filter((cause: any) => cause?.message === "DESKTOP_SHELL_OPERATION_HELPER_CLOSE_TIMEOUT").length, 2);
    assert.equal(cleanup.errors.filter((cause: any) => cause?.code === "DESKTOP_SHELL_OPERATION_HELPER_NOT_CLOSED").length, 1);
    return true;
  });
  assert.equal(f.control.closed, false); assert.equal(f.actions.includes("resume"), false);
  assert.equal(f.actions.filter(action => action === "stop").length, 1);
});

test("an unclosed helper preserves a failed identity query and never stops an unverified process", async t => {
  const h = await api(), f = await fixture(t), primary = new Error("drain failed"), disconnect = new Error("disconnect failed"), snapshot = f.input.boundary.snapshot;
  f.input.hooks.drain = async () => { throw primary; };
  f.channel.disconnect = () => { f.actions.push("disconnect"); throw disconnect; };
  f.input.boundary.snapshot = async () => { if (f.actions.includes("disconnect")) throw undefined; return await snapshot(); };
  await assert.rejects(h.runShellUpdateOperation(f.input), (error: any) => {
    assert.ok(error.helperOwner); assert.equal(error.cause.errors[0], primary);
    const cleanup = error.cause.errors[1]; assert.ok(cleanup instanceof AggregateError);
    assert.equal(cleanup.errors[0], disconnect); assert.equal(cleanup.errors[1], undefined);
    assert.equal(cleanup.errors[2].code, "DESKTOP_SHELL_OPERATION_HELPER_NOT_CLOSED"); return true;
  });
  assert.equal(f.actions.includes("stop"), false); assert.equal(f.actions.includes("resume"), false); assert.equal(f.control.closed, false);
});

for (const releaseId of ["baseline", "installation"] as const) test(`the existing ${releaseId} Client label preserves signed installation binding`, async t => {
  const h = await api(), f = await fixture(t), getClient = f.input.getClient; f.control.available = false;
  f.input.getClient = () => ({ ...getClient(), releaseId });
  assert.equal((await h.runShellUpdateOperation(f.input)).status, "no-update");
  assert.equal((await f.store.read())?.binding.kind, "installation");
});

test("default shell network performs real signed registration and no-update discovery on the original durable budget", async t => {
  const h = await api(), f = await fixture(t), requests: string[] = [], failures: unknown[] = [];
  const server = http.createServer((request, response) => { void (async () => {
    const meta = readDesktopDeviceHeaders(request.rawHeaders); requests.push(request.url!);
    for await (const _chunk of request) { /* 原请求签名体完整消费。 */ }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url!.endsWith("/devices/register")
      ? { ok: true, deviceId: f.input.identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(f.input.identity.publicKeyBase64) }
      : { ok: true, available: false, requestId: meta.requestId, deviceId: f.input.identity.deviceId }));
  })().catch(error => { failures.push(error); response.writeHead(500); response.end("{}"); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); assert.deepEqual(failures, []); });
  const { createNetwork: _createNetwork, ...boundary } = f.input.boundary;
  const result = await h.runShellUpdateOperation({ ...f.input, boundary, configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  assert.equal(result.status, "no-update"); assert.deepEqual(requests, ["/api/software/desktop/devices/register", "/api/software/desktop/shell-release-availability"]);
  const attempt = await f.store.read(); assert.equal(attempt?.phase, "no-update"); assert.equal(attempt?.retriesUsed, 0);
  assert.equal(attempt?.schemaVersion === 5 && attempt.network?.status, "succeeded"); assert.equal(f.control.spawned, false);
});

test("preparing recovery rejects changed signed binding before network or admission", async t => {
  const h = await api(), f = await fixture(t); f.control.confirm = false;
  await h.runShellUpdateOperation(f.input);
  const original = await f.store.read(); f.actions.length = 0;
  const changed = { ...original, binding: { ...original!.binding, health: { ...original!.binding.health, clientVersion: "different" } } };
  await fs.writeFile(path.join(f.input.dataDir, "shell-update-attempt.json"), JSON.stringify(changed));
  await assert.rejects(h.runShellUpdateOperation(f.input));
  assert.deepEqual(f.actions, []); assert.equal(f.control.spawned, false);
});

test("a rejected accepted message closes the helper and resumes the one original admission", async t => {
  const h = await api(), f = await fixture(t), send = f.channel.send;
  f.channel.send = (message, callback) => send.call(f.channel, message.kind === "accept" ? { ...message, nonce: "f".repeat(64) } : message, callback);
  await assert.rejects(h.runShellUpdateOperation(f.input));
  assert.equal(f.control.closed, true); assert.equal(f.actions.includes("interrupt/drain"), false); assert.equal(f.actions.at(-1), "resume");
});

test("a pre-spawn admission failure preserves an undefined primary cause when cancel also fails", async t => {
  const h = await api(), f = await fixture(t), cleanup = new Error("cancel failed");
  f.input.hooks.prepare = async () => { throw undefined; }; f.input.hooks.resume = async () => { throw cleanup; };
  await assert.rejects(h.runShellUpdateOperation(f.input), error => {
    assert.deepEqual(((error as Error).cause as AggregateError).errors, [undefined, cleanup]); return true;
  });
  assert.equal(f.control.spawned, false);
});

test("an accept send failure retains its cause and releases the pending IPC response", async t => {
  const h = await api(), f = await fixture(t), send = f.channel.send, failure = new Error("accept send failed");
  f.channel.send = (message, callback) => { if (message.kind === "accept") { callback(failure); return false; } return send.call(f.channel, message, callback); };
  await assert.rejects(h.runShellUpdateOperation(f.input), error => { assert.equal((error as Error).cause, failure); return true; });
  assert.equal(f.control.closed, true); assert.equal(f.actions.at(-1), "resume");
  await new Promise(resolve => setImmediate(resolve));
});

for (const late of [new Error("late helper close error"), undefined]) test(`helper cleanup preserves a late ${late === undefined ? "undefined" : "error"} before close and stops resume`, async t => {
  const h = await api(), f = await fixture(t); f.control.fail = "drain";
  f.channel.disconnect = () => {
    f.channel.connected = false; f.control.closed = true;
    queueMicrotask(() => { f.channel.emit("error", late); f.channel.emit("close", 1, null); });
  };
  await assert.rejects(h.runShellUpdateOperation(f.input), error => {
    const failure = (error as Error).cause as AggregateError;
    assert.ok(failure instanceof AggregateError);
    assert.equal(failure.errors[0].message, "drain failed");
    assert.deepEqual(failure.errors[1].errors, [late]); return true;
  });
  assert.equal(f.control.closed, true); assert.equal(f.actions.includes("resume"), false);
});

for (const variant of ["parent-missing", "child-created-unknown", "identity-changed"] as const)
test(`preparing inventory failure identifies ${variant} before any later side effect`, async t => {
  const h = await api(), f = await fixture(t, true), snapshot = f.input.boundary.snapshot;
  const parent = { ...f.input.facts.main, pid: 201, parentPid: f.input.facts.main.pid, created: 1201, commandLine: "private-parent-command" };
  const child = { ...parent, pid: 202, parentPid: parent.pid, created: variant === "child-created-unknown" ? 0 : 1202, commandLine: "private-child-command" };
  const changed = { ...parent, created: 1301 };
  let samples = 0;
  f.input.boundary.snapshot = async () => [...await snapshot(), ...(samples++ === 0 ? [parent]
    : variant === "parent-missing" ? [child] : variant === "child-created-unknown" ? [parent, child] : [changed])];
  const failedIdentity = variant === "identity-changed" ? parent : child;
  const reason = variant === "parent-missing" ? "UNKNOWN_PARENT_MISSING" : variant === "child-created-unknown" ? "CHILD_PREDATES_PARENT" : "ACTIVE_IDENTITY_CHANGED";
  const code = variant === "identity-changed" ? "DESKTOP_SHELL_OPERATION_OWNED_IDENTITY_CHANGED" : "DESKTOP_SHELL_OPERATION_OWNED_IDENTITY_UNKNOWN";
  await assert.rejects(h.runShellUpdateOperation(f.input), (error: any) => {
    assert.equal(error.requestId, f.input.requestId); assert.equal(error.phase, "preparing"); assert.equal(error.cause.code, code);
    assert.deepEqual(error.cause.inventoryFailure, { reason, pid: failedIdentity.pid, parentPid: failedIdentity.parentPid, created: failedIdentity.created,
      instanceSha256: crypto.createHash("sha256").update(JSON.stringify([failedIdentity.pid, failedIdentity.parentPid, failedIdentity.created, failedIdentity.executable, failedIdentity.commandLine]), "utf8").digest("hex") });
    assert.doesNotMatch(JSON.stringify(error.cause.inventoryFailure), /private-|CodeFlowAI/u); return true;
  });
  assert.deepEqual(f.actions, ["network.prepare"]); assert.equal(f.control.spawned, false); assert.equal(f.control.drained, false);
  const attempt = await f.store.read(); assert.equal(attempt?.schemaVersion, 2); assert.equal(attempt?.phase, "preparing");
  assert.equal(attempt?.network?.status, "succeeded");
  assert.deepEqual((await readShellLaunchState(f.input.facts.installationDir)).state, f.originalState);
});

test("handoff persists the complete observed Client and Chromium descendants without storing its roots", async t => {
  const h = await api(), f = await fixture(t), snapshot = f.input.boundary.snapshot;
  const main = f.input.facts.main;
  const renderer = { ...main, pid: 104, parentPid: main.pid, created: 1104, commandLine: "renderer" };
  const worker = { ...main, pid: 105, parentPid: f.client.pid, created: 1105, commandLine: "client worker" };
  f.input.boundary.snapshot = async () => [...await snapshot(), renderer, ...(!f.control.drained ? [worker] : [])];
  const result = await h.runShellUpdateOperation(f.input), attempt = await f.store.read();
  assert.deepEqual(attempt?.schemaVersion === 5 && "owned" in attempt && attempt.owned, [f.client, renderer, worker]);
  assert.equal(result.status, "handoff"); if (result.status === "handoff") result.owner.release();
});

/** 先走原交接与严格store迁移构造充分终态，再让同一正常候选继续检查。 */
async function completedFixture(t: test.TestContext, role: "candidate" | "original" = "candidate") {
  const h = await api(), f = await fixture(t), result = await h.runShellUpdateOperation(f.input);
  assert.equal(result.status, "handoff"); if (result.status === "handoff") result.owner.release();
  let current = await f.store.read(); assert.equal(current?.schemaVersion, 5);
  if (!current || !isShellUpdateHandoffAttempt(current)) throw new Error("handoff required");
  const historical = current;
  const main = { ...f.input.facts.main, pid: 201, parentPid: current.helper.pid, created: 1201,
    executable: path.join(f.input.facts.installationDir, "shells", role === "candidate" ? "new" : "old", "CodeFlowAI.exe"), commandLine: "candidate main" };
  const client = { ...main, pid: 202, parentPid: main.pid, created: 1202, commandLine: "candidate client" };
  if (role === "candidate") current = await f.store.replace(current, { ...current, revision: current.revision + 1, selectedMain: main }) as typeof historical;
  current = await f.store.observeHandoffOwned(current, { caller: current.helper, processes: [current.helper, main, client] });
  const ready = { role, continuationId: current.continuationId, main, client, readyRequestId: "ready-candidate", health: current.binding.health,
    binding: current.binding, launchState: role === "candidate" ? current.candidateState : current.originalState,
    profile: { dataDir: current.dataDir, userDataDir: current.userDataDir, sessionDataDir: current.sessionDataDir }, mainFrame: "loaded",
    startup: { continuationId: current.continuationId, admission: "paused" } };
  if (role === "candidate") current = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: "admission-intent", admission: ready }) as typeof historical;
  current = await f.store.replace(current, { ...current, revision: current.revision + 1, phase: role === "candidate" ? "completed" : "restored", terminalEvidence: {
    ready, startedRequestId: "started-candidate", continueRequestId: "continue-candidate", startup: "completed", application: "started" } }) as typeof historical;
  f.channel.disconnect(); f.control.drained = false; f.control.available = false; f.actions.length = 0;
  f.input.facts.main = main;
  f.input.getClient = () => ({ status: "ready", requestId: "ready-candidate", releaseId: null, errorCode: null, pid: client.pid, health: current.binding.health });
  f.input.boundary.snapshot = async () => [main, client];
  await fs.writeFile(path.join(f.input.facts.installationDir, "shell-launch.ini"), serializeShellLaunchState(ready.launchState));
  return { ...f, main, currentClient: client, terminal: current, historical };
}

test("a sufficiently completed live candidate opens a fresh cycle and preserves its signed current binding", async t => {
  const h = await api(), f = await completedFixture(t), requestId = crypto.randomUUID();
  assert.equal((await h.runShellUpdateOperation({ ...f.input, requestId })).status, "no-update");
  const current = await f.store.read();
  assert.equal(current?.schemaVersion, 5); assert.equal(current?.requestId, requestId); assert.equal(current?.retriesUsed, 0);
  assert.deepEqual(current?.originalState, f.terminal.candidateState); assert.deepEqual(current?.binding, f.terminal.binding);
});

test("inventory release accepts an unrelated absolute system path with dot segments", async t => {
  const h = await api(), f = await completedFixture(t), foreign = { ...f.main, pid: 19176, parentPid: 99999, created: 1,
    executable: "D:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe", commandLine: "bash" };
  assert.doesNotThrow(() => assertShellUpdateInventoryReleased(f.terminal, [f.main, f.currentClient, foreign], [f.main, f.currentClient]));
  f.input.boundary.snapshot = async () => [f.main, f.currentClient, foreign];
  assert.equal((await h.runShellUpdateOperation({ ...f.input, requestId: crypto.randomUUID() })).status, "no-update");
});

for (const parentRole of ["main", "client"] as const) for (const partial of [false, true])
test(`terminal cycle excludes an unrelated ${partial ? "partial" : "complete"} row older than its current ${parentRole}`, async t => {
  const h = await api(), f = await completedFixture(t), snapshot = f.input.boundary.snapshot;
  const parent = parentRole === "main" ? f.main : f.currentClient;
  const old = { ...parent, pid: 19176, parentPid: parent.pid, created: 1000,
    executable: partial ? "" : parent.executable, commandLine: partial ? "" : "unrelated historical row" };
  const foreignChild = { ...old, pid: 19177, parentPid: old.pid, created: 1300 };
  f.input.boundary.snapshot = async () => [old, foreignChild, ...await snapshot()];
  const requestId = crypto.randomUUID();
  assert.equal((await h.runShellUpdateOperation({ ...f.input, requestId })).status, "no-update");
  const current = await f.store.read();
  assert.equal(current?.requestId, requestId); assert.equal(current?.retriesUsed, 0);
  assert.equal(current?.schemaVersion, 5);
  assert.deepEqual(current?.owned.map(item => item.pid), [f.currentClient.pid]);
  assert.deepEqual(f.actions, ["network.prepare"]);
});

for (const age of ["same", "newer", "unknown"] as const)
test(`terminal cycle keeps a ${age} Client child inside the current inventory boundary`, async t => {
  const h = await api(), f = await completedFixture(t), snapshot = f.input.boundary.snapshot;
  const child = { ...f.currentClient, pid: 19176, parentPid: f.currentClient.pid,
    created: age === "unknown" ? 0 : f.currentClient.created + (age === "newer" ? 1 : 0), commandLine: "current child" };
  f.input.boundary.snapshot = async () => [child, ...await snapshot()];
  const requestId = crypto.randomUUID();
  if (age === "unknown") {
    await assert.rejects(h.runShellUpdateOperation({ ...f.input, requestId }));
    assert.deepEqual(await f.store.read(), f.terminal); assert.deepEqual(f.actions, []);
  } else {
    assert.equal((await h.runShellUpdateOperation({ ...f.input, requestId })).status, "no-update");
    const current = await f.store.read(); assert.equal(current?.schemaVersion, 5);
    assert.deepEqual(current?.owned.map(item => item.pid), [f.currentClient.pid, child.pid]);
  }
});

test("a completed candidate cycle waits for a partially described Client descendant during preparation", async t => {
  const h = await api(), f = await completedFixture(t), child = { ...f.currentClient, pid: 17532, parentPid: f.currentClient.pid, created: f.currentClient.created + 100, commandLine: "completed-cycle child" };
  const { snapshot: rawSnapshot, ...boundary } = f.input.boundary;
  let partial = true;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    void (async () => {
      const rows = await rawSnapshot();
      if (f.actions.includes("network.prepare")) { rows.push(partial ? { ...child, executable: "", commandLine: "" } : child); partial = false; }
      callback(null, JSON.stringify(rows));
    })().catch(cause => callback(cause));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    const result = await h.runShellUpdateOperation({ ...f.input, boundary, requestId: crypto.randomUUID() });
    assert.equal(result.status, "no-update");
    const current = await f.store.read();
    assert.equal(current?.schemaVersion, 5);
    assert.deepEqual(current?.owned.find(item => item.pid === child.pid), child);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const conflict of ["historical helper", "reused historical pid", "unknown historical descendant"] as const) test(`terminal cycle refuses a ${conflict} before network or store replacement`, async t => {
  const h = await api(), f = await completedFixture(t), snapshot = f.input.boundary.snapshot;
  const extra = conflict === "historical helper" ? f.historical.helper : conflict === "reused historical pid"
    ? { ...f.historical.oldMain, created: 9001, commandLine: "foreign reused pid" }
    : { ...f.historical.oldMain, pid: 999, parentPid: f.historical.oldMain.pid, created: 9001, commandLine: "unknown orphan" };
  f.input.boundary.snapshot = async () => [...await snapshot(), extra];
  await assert.rejects(h.runShellUpdateOperation({ ...f.input, requestId: crypto.randomUUID() }));
  assert.deepEqual(await f.store.read(), f.terminal); assert.deepEqual(f.actions, []);
});

test("a terminal cycle accepts a newly verified hot binding instead of freezing the historical binding", async t => {
  const h = await api(), f = await completedFixture(t), getClient = f.input.getClient;
  const { signature: _signature, ...payload } = f.baseline;
  const manifest = signReleaseBundleManifest({ ...payload, releaseId: "hot-next", clientVersion: "2" }, f.privateKey);
  const releaseDir = path.join(f.input.dataDir, "releases", manifest.releaseId); await fs.mkdir(releaseDir, { recursive: true });
  for (const name of ["client", "web"]) await fs.cp(path.join(f.input.initialReleaseDir, name), path.join(releaseDir, name), { recursive: true });
  await fs.writeFile(path.join(releaseDir, "manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(f.input.dataDir, "active-release.json"), JSON.stringify({ releaseId: manifest.releaseId }));
  f.input.getClient = () => ({ ...getClient(), releaseId: manifest.releaseId, health: { ...f.terminal.binding.health, clientVersion: "2" } });
  assert.equal((await h.runShellUpdateOperation({ ...f.input, requestId: crypto.randomUUID() })).status, "no-update");
  assert.equal((await f.store.read())?.binding.health.clientVersion, "2");
  assert.equal((await f.store.read())?.binding.kind, "active");
});

test("a sufficiently restored original main opens a fresh cycle from complete S0", async t => {
  const h = await api(), f = await completedFixture(t, "original");
  assert.equal((await h.runShellUpdateOperation({ ...f.input, requestId: crypto.randomUUID() })).status, "no-update");
  assert.deepEqual((await f.store.read())?.originalState, f.originalState);
});

test("a later normal restart opens a terminal cycle only after historical main and Client are gone", async t => {
  const h = await api(), f = await completedFixture(t);
  const main = { ...f.main, pid: 301, parentPid: 90, created: 1301, commandLine: "normal restart" };
  const client = { ...f.currentClient, pid: 302, parentPid: main.pid, created: 1302, commandLine: "normal client" };
  f.input.facts.main = main; f.input.boundary.snapshot = async () => [main, client];
  const getClient = f.input.getClient; f.input.getClient = () => ({ ...getClient(), pid: client.pid, requestId: "restart-ready" });
  assert.equal((await h.runShellUpdateOperation({ ...f.input, requestId: crypto.randomUUID() })).status, "no-update");
});

/** 复用四个恢复API生成当前执行的充分证据，顶层历史终态保持原样。 */
async function recoveredFixture(t: test.TestContext, role: "candidate" | "original", complete = true) {
  const f = await completedFixture(t, role), previous = f.terminal;
  const controller = { ...f.main, pid: 401, parentPid: 90, created: 1401, commandLine: "recovery controller" };
  const helper = { ...controller, pid: 402, parentPid: controller.pid, created: 1402, commandLine: "recovery helper" };
  const main = { ...controller, pid: 403, parentPid: helper.pid, created: 1403, commandLine: "recovered main" };
  const client = { ...main, pid: 404, parentPid: main.pid, created: 1404, commandLine: "recovered client" };
  const state = role === "candidate" ? previous.candidateState : previous.originalState;
  const facts = { caller: controller, processes: [controller, helper], launchState: { status: "known", value: state },
    binding: { status: "matched", value: previous.binding }, profile: { status: "known", dataDir: previous.dataDir, userDataDir: previous.userDataDir, sessionDataDir: previous.sessionDataDir } };
  const released = await f.store.observeHandoffOwned(previous, { caller: previous.helper, processes: [previous.helper] });
  const known = shellUpdateProcessHistory(released);
  let current = await f.store.beginRecovery(released, { ...facts, helper, owner: { status: "gone", identity: previous.helper },
    oldMain: { status: "gone", identity: previous.oldMain }, selectedMain: previous.selectedMain ? { status: "gone", identity: previous.selectedMain } : { status: "not-started" },
    ownedReleased: "verified", knownOwned: { status: "known", identities: known } });
  current = await f.store.bindRecoveryMain(current, { ...facts, caller: helper, processes: [helper, main], main });
  current = await f.store.observeRecoveryOwned(current, { ...facts, caller: helper, processes: [helper, main, client] });
  if (complete) current = await f.store.completeRecovery(current, { ready: { ...previous.terminalEvidence!.ready, main, client, readyRequestId: "recovered-ready" },
    startedRequestId: "recovered-started", continueRequestId: "recovered-continue", startup: "completed", application: "started" });
  f.input.facts.main = main; f.input.boundary.snapshot = async () => [main, client];
  const getClient = f.input.getClient; f.input.getClient = () => ({ ...getClient(), pid: client.pid, requestId: "recovered-ready" });
  return { ...f, terminal: current };
}

for (const role of ["candidate", "original"] as const) test(`a completed ${role} recovery opens a new cycle using current execution evidence`, async t => {
  const h = await api(), f = await recoveredFixture(t, role);
  assert.equal((await h.runShellUpdateOperation({ ...f.input, requestId: crypto.randomUUID() })).status, "no-update");
  assert.deepEqual((await f.store.read())?.originalState, role === "candidate" ? f.terminal.candidateState : f.terminal.originalState);
});

test("an unfinished recovery cannot reuse the ordinary network path or refund its budget", async t => {
  const h = await api(), f = await recoveredFixture(t, "candidate", false), observations: Array<{ result?: string }> = [];
  await assert.rejects(h.runShellUpdateOperation({ ...f.input, requestId: crypto.randomUUID(), onProgress: observation => { observations.push(observation); } }));
  assert.deepEqual(await f.store.read(), f.terminal); assert.deepEqual(f.actions, []);
  assert.equal(observations.at(-1)?.result, "manual_required");
});

test("old main recovery restores full S0 after the unused candidate executable disappears", async t => {
  const h = await api(), f = await fixture(t), observations: Array<{ phase: string; result?: string }> = [];
  const result = await h.runShellUpdateOperation({ ...f.input, onProgress: observation => { observations.push(observation); } });
  assert.equal(result.status, "handoff"); if (result.status !== "handoff") throw new Error("handoff required");
  await fs.unlink(path.join(f.input.facts.installationDir, "shells", "new", "CodeFlowAI.exe"));
  const primary = new Error("quit failed"), failure = await result.owner.recover(primary);
  assert.equal(failure.cause, primary); assert.equal(f.control.closed, true); assert.equal(f.actions.at(-1), "resume");
  assert.deepEqual((await readShellLaunchState(f.input.facts.installationDir)).state, f.originalState);
  assert.equal(observations.at(-1)?.phase, "recovery"); assert.equal(observations.at(-1)?.result, "restored");
});

test("a missing original shell still stops recovery without resuming Client", async t => {
  const h = await api(), f = await fixture(t), result = await h.runShellUpdateOperation(f.input);
  if (result.status !== "handoff") throw new Error("handoff required");
  await fs.unlink(path.join(f.input.facts.installationDir, "shells", "new", "CodeFlowAI.exe"));
  await fs.unlink(path.join(f.input.facts.installationDir, "shells", "old", "CodeFlowAI.exe"));
  const primary = new Error("quit failed"), failure = await result.owner.recover(primary);
  assert.ok(failure.cause instanceof AggregateError); assert.equal(failure.cause.errors[0], primary);
  assert.equal(f.actions.includes("resume"), false);
});
