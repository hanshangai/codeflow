import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { DESKTOP_STARTUP_CAPABILITY_PATH } from "@codeflowai/shared";
import { readReleaseBundleFiles, computeReleaseDirectorySha256, computeReleasePackageSha256, signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import { signShellReleaseManifest } from "@codeflowai/shared/desktop-shell-release-signing";
import { createShellUpdateAttemptStore, shellUpdateHandoffRevision, shellUpdateProcessHistory, type ShellUpdateAttemptV2, type ShellUpdateAttemptV3, type ShellUpdateAttemptV4,
  type ShellUpdateHandoffAttempt, type ShellUpdateReadyEvidence, type ShellUpdatePreparationAttemptV5, type ShellUpdateHandoffAttemptV5 } from "../src/shellUpdateAttempt.js";
import { readShellLaunchState, serializeShellLaunchState } from "../src/shellLaunchState.js";
import type { ProcessIdentity } from "../src/windowsProcessIdentity.js";
import type { ShellHandoffMessage } from "../src/shellHandoff.js";
import { runShellHandoffHelper, runShellRecoveryHelper, reportShellHandoffHelperFailure } from "../src/shellHandoffHelper.js";
import { verifyShellReleaseArtifact } from "../src/shellReleaseArtifact.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";

const evidence = await fs.mkdtemp(path.join(os.tmpdir(), "cf-handoff-helper-"));
after(() => { process.stdout.write(`D13 helper evidence: ${evidence}\n`); });

/** 受控通道只模拟IPC边界；真实唯一store/INI仍由产品函数读写。 */
class Channel extends EventEmitter {
  connected = true;
  sent: ShellHandoffMessage[] = [];
  onSend?: (message: ShellHandoffMessage) => Promise<void>;
  send(message: ShellHandoffMessage, callback: (error: Error | null) => void) {
    this.sent.push(structuredClone(message)); callback(null);
    if (this.onSend) void this.onSend(message).catch(error => this.emit("error", error));
    return true;
  }
}

/** 正常主壳的受控IPC/进程边界，用于验证真实持久提交的先后次序。 */
class Main extends Channel {
  constructor(readonly pid: number) { super(); }
  disconnect() { this.connected = false; }
  unref() { return this; }
}

/** 合法完整S0含非空previous，以真实布局阻止只恢复active的伪成功。 */
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(evidence, "fixture-")));
  const installationDir = path.join(root, "installation"), dataDir = path.join(root, "data"), userDataDir = path.join(root, "profile"), sessionDataDir = path.join(root, "session");
  for (const directory of [installationDir, dataDir, userDataDir, sessionDataDir]) await fs.mkdir(directory);
  for (const shell of ["old", "previous", "baseline", "new"]) {
    const directory = path.join(installationDir, "shells", shell); await fs.mkdir(path.join(directory, "resources"), { recursive: true });
    await fs.writeFile(path.join(directory, "CodeFlowAI.exe"), "synthetic shell only");
    await fs.writeFile(path.join(directory, "resources", "app.asar"), "synthetic asar only");
  }
  for (const file of ["web/index.html", "client/dist/index.cjs", "release-trust.json"]) {
    const target = path.join(installationDir, "shells", "baseline", "resources", file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, "synthetic baseline only");
  }
  const baselineDir = path.join(installationDir, "shells", "baseline", "resources"), { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  await fs.writeFile(path.join(baselineDir, DESKTOP_STARTUP_CAPABILITY_PATH), JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1,
    clientEntrySha256: crypto.createHash("sha256").update("synthetic baseline only").digest("hex") }));
  const files = await readReleaseBundleFiles(baselineDir), webSha256 = computeReleaseDirectorySha256(files, "web"), clientSha256 = computeReleaseDirectorySha256(files, "client");
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: "baseline", version: "1.0.0", webVersion: "1.0.0", clientVersion: "1.0.0", protocolVersion: 1,
    capabilityVersion: 1, dbSchemaVersion: 1, platform: process.platform, arch: process.arch, keyId: "helper-fixture", archiveSha256: "e".repeat(64), archiveSize: 1,
    files, webSha256, clientSha256, packageSha256: computeReleasePackageSha256(webSha256, clientSha256), createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, privateKey);
  await fs.writeFile(path.join(baselineDir, "baseline-release-manifest.json"), JSON.stringify(manifest));
  const originalState = { activeShellId: "old", previousShellId: "previous", baselineShellId: "baseline" };
  await fs.writeFile(path.join(installationDir, "shell-launch.ini"), serializeShellLaunchState(originalState));
  const health = { clientVersion: "1.0.0", protocolVersion: 1 as const, dbSchemaVersion: 1, database: "ready" as const };
  const attempt: ShellUpdateAttemptV2 = { schemaVersion: 2, requestId: "helper.check+1", revision: 0, retriesUsed: 0, phase: "preparing",
    installationDir, dataDir, userDataDir, sessionDataDir, originalState, binding: { kind: "installation", baselineShellId: "baseline", health },
    target: null, candidateState: null, network: null };
  const store = createShellUpdateAttemptStore(dataDir); await store.replace(null, attempt);
  const start = await store.read() as ShellUpdateAttemptV2;
  const dispatch = await store.replace(start, { ...start, revision: 1, network: { actionKey: "fixture-installer", requestSha256: "1".repeat(64), status: "dispatching" } }) as ShellUpdateAttemptV2;
  const success = await store.replace(dispatch, { ...dispatch, revision: 2, network: { ...dispatch.network, status: "succeeded", evidence: { kind: "shell-installer", sha256: "2".repeat(64) } } }) as ShellUpdateAttemptV2;
  const prepared = await store.replace(success, { ...success, revision: 3, target: { shellId: "new", manifestSha256: "3".repeat(64), installerSha256: "2".repeat(64), installerSize: 1 },
    candidateState: { activeShellId: "new", previousShellId: "old", baselineShellId: "baseline" } }) as ShellUpdateAttemptV2;
  const oldMain = { pid: 101, parentPid: 1, created: 1000, executable: path.join(installationDir, "shells", "old", "CodeFlowAI.exe"), commandLine: "old" };
  const helper = { pid: 102, parentPid: 101, created: 1001, executable: oldMain.executable, commandLine: "helper" };
  const channel = new Channel(), nonce = "a".repeat(64), continuationId = crypto.randomUUID();
  const arm: ShellHandoffMessage<"arm"> = { t: "desktop.shell-handoff", schemaVersion: 1, kind: "arm", requestId: prepared.requestId,
    revision: prepared.revision, continuationId, nonce, body: { oldMain } };
  return { root, store, prepared, oldMain, helper, channel, arm, trustedKeys: { "helper-fixture": publicKey } };
}

/** 准备5真实登记并释放普通子树，交接必须保留旧proof和同PID多代完整父图。 */
async function preparationHelperFixture() {
  const f = await fixture(), dataDir = path.join(f.root, "preparation-data"); await fs.mkdir(dataDir);
  const store = createShellUpdateAttemptStore(dataDir), client = { ...f.oldMain, pid: 110, parentPid: f.oldMain.pid, created: 1010, commandLine: "preparation Client" };
  const query = { ...client, pid: 150, created: 1011, commandLine: "preparation query" }, console = { ...query, pid: 151, parentPid: 150, created: 1012, commandLine: "preparation console" };
  const fresh = { schemaVersion: 2, requestId: "helper.preparation+5", revision: 0, retriesUsed: 0, phase: "preparing", installationDir: f.prepared.installationDir,
    dataDir, userDataDir: f.prepared.userDataDir, sessionDataDir: f.prepared.sessionDataDir, originalState: f.prepared.originalState, binding: f.prepared.binding,
    target: null, candidateState: null, network: null };
  const initial = await store.beginPreparation(null, fresh, { main: f.oldMain, client, readyRequestId: "preparation-ready", processes: [f.oldMain, client, query, console] });
  const released = await store.observePreparationOwned(initial, { caller: f.oldMain, processes: [f.oldMain, client] });
  const second = { ...query, created: 1020, commandLine: "second preparation query" }, secondConsole = { ...console, created: 1021, commandLine: "second preparation console" };
  const reused = await store.observePreparationOwned(released, { caller: f.oldMain, processes: [f.oldMain, client, second, secondConsole] });
  const complete = await store.observePreparationOwned(reused, { caller: f.oldMain, processes: [f.oldMain, client] });
  const dispatch = await store.replace(complete, { ...complete, revision: complete.revision + 1,
    network: { actionKey: "fixture-installer", requestSha256: "1".repeat(64), status: "dispatching" } }) as ShellUpdatePreparationAttemptV5;
  const success = await store.replace(dispatch, { ...dispatch, revision: dispatch.revision + 1,
    network: { ...dispatch.network, status: "succeeded", evidence: { kind: "shell-installer", sha256: "2".repeat(64) } } }) as ShellUpdatePreparationAttemptV5;
  const prepared = await store.replace(success, { ...success, revision: success.revision + 1, target: f.prepared.target, candidateState: f.prepared.candidateState }) as ShellUpdatePreparationAttemptV5;
  return { ...f, store, prepared, arm: { ...f.arm, requestId: prepared.requestId, revision: prepared.revision }, client };
}

test("schema5 helper arms without a write and preserves preparation proof through exact accept", async () => {
  const f = await preparationHelperFixture(); let authorizations = 0;
  const stopped = Object.assign(new Error("stop after committed accept"), { code: "CONTROLLED_AFTER_ACCEPT" });
  f.channel.onSend = async message => {
    if (message.kind === "armed") {
      assert.deepEqual(await f.store.read(), f.prepared);
      const handoff = await f.store.beginHandoff(f.prepared, { lifecycle: true, oldMain: f.oldMain, helper: f.helper,
        continuationId: f.arm.continuationId, processes: [f.oldMain, f.helper, f.client] });
      f.channel.emit("message", { ...f.arm, kind: "accept", revision: handoff.controlRevision, body: {} });
    } else if (message.kind === "accepted") f.channel.emit("message", { ...message, kind: "drained", body: {} });
  };
  const running = runShellHandoffHelper({ dataDir: f.prepared.dataDir, channel: f.channel, pid: f.helper.pid, parentPid: f.oldMain.pid,
    trustedKeys: f.trustedKeys, timeoutMs: 1500, boundary: { snapshot: async () => [f.oldMain, f.helper, f.client], verifyPrepared: async () => {},
      authorizeSwitch: async () => { authorizations++; throw stopped; } } });
  queueMicrotask(() => f.channel.emit("message", f.arm));
  await assert.rejects(running, error => hasCause(error, stopped));
  const handoff = await f.store.read() as ShellUpdateHandoffAttemptV5;
  assert.equal(authorizations, 1); assert.equal(handoff.schemaVersion, 5); assert.equal(handoff.handoffRevision, f.prepared.revision + 1);
  assert.deepEqual(handoff.preparationMains, f.prepared.preparationMains);
  assert.deepEqual(handoff.owned, f.prepared.owned); assert.deepEqual(handoff.ownedLifecycle, f.prepared.ownedLifecycle);
  assert.equal(handoff.owned.filter(item => item.pid === 150).length, 2); assert.equal(handoff.owned.filter(item => item.pid === 151).length, 2);
});

test("schema5 helper rejects an inventory write after arm instead of accepting a later revision", async () => {
  const f = await preparationHelperFixture(); let authorizations = 0;
  f.channel.onSend = async message => {
    if (message.kind !== "armed") return;
    const extra = { ...f.client, pid: 160, created: 1030, commandLine: "late preparation query" };
    const changed = await f.store.observePreparationOwned(f.prepared, { caller: f.oldMain, processes: [f.oldMain, f.client, extra] });
    const handoff = await f.store.beginHandoff(changed, { lifecycle: true, oldMain: f.oldMain, helper: f.helper,
      continuationId: f.arm.continuationId, processes: [f.oldMain, f.helper, f.client, extra] });
    f.channel.emit("message", { ...f.arm, kind: "accept", revision: handoff.controlRevision, body: {} });
  };
  const running = runShellHandoffHelper({ dataDir: f.prepared.dataDir, channel: f.channel, pid: f.helper.pid, parentPid: f.oldMain.pid, timeoutMs: 1500,
    boundary: { snapshot: async () => [f.oldMain, f.helper, f.client], authorizeSwitch: async () => { authorizations++; }, verifyPrepared: async () => {} } });
  queueMicrotask(() => f.channel.emit("message", f.arm));
  await assert.rejects(running, error => hasCode(error, "DESKTOP_SHELL_HANDOFF_ACCEPT_NOT_COMMITTED"));
  assert.equal(authorizations, 0); assert.deepEqual(f.channel.sent.map(message => message.kind), ["armed"]);
});

test("schema5 helper first snapshot failure retains the arm request ID without sending armed", async () => {
  const f = await preparationHelperFixture(), primary = Object.assign(new Error("first snapshot unavailable"), { code: "CONTROLLED_FIRST_SNAPSHOT_FAILED" });
  const running = runShellHandoffHelper({ dataDir: f.prepared.dataDir, channel: f.channel, pid: f.helper.pid, parentPid: f.oldMain.pid, timeoutMs: 1500,
    boundary: { snapshot: async () => { throw primary; } } });
  queueMicrotask(() => f.channel.emit("message", f.arm));
  await assert.rejects(running, cause => hasCause(cause, primary) && cause instanceof Error && "requestId" in cause && cause.requestId === f.prepared.requestId);
  assert.deepEqual(f.channel.sent, []); assert.deepEqual(await f.store.read(), f.prepared);
});

/** 只遍历保留的cause链，确保用例命中预期业务失败而不是夹具故障。 */
function hasCode(value: unknown, code: string): boolean {
  return value instanceof Error && ("code" in value && value.code === code || "cause" in value && hasCode(value.cause, code)
    || value instanceof AggregateError && value.errors.some(item => hasCode(item, code)));
}

/** 原始失败必须仍能沿cause或聚合错误定位。 */
function hasCause(value: unknown, cause: unknown): boolean {
  return value === cause || value instanceof Error && ("cause" in value && hasCause(value.cause, cause)
    || value instanceof AggregateError && value.errors.some(item => hasCause(item, cause)));
}

test("arm never writes and accept must match the persisted helper before draining or switching", async () => {
  const f = await fixture(); let authorization = 0;
  f.channel.onSend = async message => {
    if (message.kind === "armed") {
      assert.deepEqual(await f.store.read(), f.prepared);
      f.channel.emit("message", { ...f.arm, kind: "accept", revision: f.prepared.revision + 1, body: {} });
    }
  };
  const running = runShellHandoffHelper({ dataDir: f.prepared.dataDir, channel: f.channel, pid: f.helper.pid, parentPid: f.oldMain.pid, timeoutMs: 100,
    boundary: { snapshot: async () => [f.oldMain, f.helper], authorizeSwitch: async () => { authorization += 1; }, verifyPrepared: async () => {} } });
  queueMicrotask(() => f.channel.emit("message", f.arm));
  await assert.rejects(running); assert.equal(authorization, 0);
  assert.deepEqual(await f.store.read(), f.prepared);
  assert.deepEqual(f.channel.sent.map(item => item.kind), ["armed"]);
});

test("a false current switch authorization leaves the complete S0 and never starts a candidate", { timeout: 60_000 }, async () => {
  const f = await fixture(); let starts = 0, authorizations = 0;
  const revoked = new Error("qualification revoked");
  f.channel.onSend = async message => {
    if (message.kind === "armed") {
      const handoff = await f.store.beginHandoff(f.prepared, { oldMain: f.oldMain, helper: f.helper, continuationId: f.arm.continuationId, processes: [f.oldMain, f.helper], knownOwned: [] });
      f.channel.emit("message", { ...f.arm, kind: "accept", revision: handoff.revision, body: {} });
    } else if (message.kind === "accepted") f.channel.emit("message", { ...message, kind: "drained", body: {} });
  };
  // 本例验证授权拒绝，沿产品默认交接预算，避免真实持久提交抢先触发100ms通道超时。
  const running = runShellHandoffHelper({ dataDir: f.prepared.dataDir, channel: f.channel, pid: f.helper.pid, parentPid: f.oldMain.pid,
    boundary: { snapshot: async () => [f.oldMain, f.helper], authorizeSwitch: async () => { authorizations += 1; throw revoked; }, verifyPrepared: async () => {},
      spawnMain: () => { starts += 1; throw new Error("must not start"); } } });
  queueMicrotask(() => f.channel.emit("message", f.arm));
  // 必须命中真实授权拒绝；IPC或持久化提前失败不能代替该业务判据。
  await assert.rejects(running, error => {
    assert.ok(hasCause(error, revoked), error instanceof Error ? `${error.message}: ${String(error.cause)}` : "NON_ERROR_REJECTION");
    return true;
  });
  assert.equal(starts, 0); assert.equal(authorizations, 1);
  const launch = await fs.readFile(path.join(f.prepared.installationDir, "shell-launch.ini"), "utf8"); assert.equal(launch, serializeShellLaunchState(f.prepared.originalState));
});

/** 新进程的旧executor若抢到owner会显式返回标记，探针不读写attempt文件。 */
async function probeHelperOwner(dataDir: string) {
  const root = await fs.realpath(dataDir), stat = await fs.lstat(root, { bigint: true });
  const script = path.join(path.dirname(root), `owner-probe-${crypto.randomUUID()}.mjs`);
  await fs.writeFile(script, `import {coordinateShellUpdateFile} from ${JSON.stringify(new URL("../src/shellUpdateFileCoordinator.ts", import.meta.url).href)};
let localExecuted=false;
try { const value=await coordinateShellUpdateFile(${JSON.stringify({ root, dev: stat.dev.toString(), ino: stat.ino.toString() })},{kind:'read'},async()=>{localExecuted=true;return null;});process.send({localExecuted,schemaVersion:value?.schemaVersion,requestId:value?.requestId}); }
catch(error){process.send({errorCode:error.code,message:error.message});process.exitCode=1;}
finally {process.disconnect();}`, "utf8");
  const child = childProcess.spawn(process.execPath, ["--conditions=development", "--import", "tsx", script], { cwd: process.cwd(),
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout!.on("data", bytes => { output += bytes; }); child.stderr!.on("data", bytes => { output += bytes; });
  const message = new Promise<{ localExecuted: boolean; schemaVersion: number; requestId: string }>((resolve, reject) => {
    child.once("message", value => resolve(value as { localExecuted: boolean; schemaVersion: number; requestId: string })); child.once("error", reject);
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error(`owner probe failed ${code}/${signal}: ${output}`)));
  });
  const result = await message; await closed; return result;
}

/** 握手与库存均由产品持久化；可在运行前准备可信上下文，不代写阶段。 */
async function session(variant: "success" | "owner-probe" | "owner-stop-expiry" | "candidate-fails" | "candidate-missing-exe" | "candidate-missing-resources" | "permit-unknown" | "old-stays" | "foreign-ready" | "original-foreign" | "unknown-descendant" | "drain-descendant" | "drain-stable" | "released-reuse" | "unreleased-reuse" | "control-progress" | "fault-query" | "fault-partial" | "fault-orphan" | "helper-query" | "old-console-stays" | "historical-old-alive" | "historical-old-gone" | "historical-candidate-gone",
  defaultSnapshot?: (read: () => ProcessIdentity[], store: Awaited<ReturnType<typeof fixture>>["store"]) => void, lifecycle: boolean | 5 = false,
  onCandidateBootstrap?: () => void, onExitRequested?: (store: Awaited<ReturnType<typeof fixture>>["store"]) => Promise<void>,
  setup?: (f: Awaited<ReturnType<typeof fixture>> | Awaited<ReturnType<typeof preparationHelperFixture>>) => Promise<unknown>, runHelper = runShellHandoffHelper) {
  const f = lifecycle === 5 ? await preparationHelperFixture() : await fixture(), events: string[] = [], children = new Map<number, Main>();
  await setup?.(f);
  let processes: ProcessIdentity[] = [f.oldMain, f.helper], authorizations = 0, starts = 0, queryFailed = false, queries = 0;
  let exitRequestBarrier: Promise<void> | undefined;
  let sampledAttempt: ShellUpdateAttemptV4 | undefined;
  if (variant === "historical-old-alive") processes.push({ ...f.oldMain, pid: 19176, parentPid: f.oldMain.pid, created: 500, executable: "", commandLine: "" });
  if (variant.endsWith("reuse") || variant.startsWith("fault-") || variant === "old-console-stays") processes.push({ ...f.oldMain, pid: 150, parentPid: f.oldMain.pid, created: 1002, commandLine: "query child" },
    { ...f.oldMain, pid: 151, parentPid: 150, created: 1003, commandLine: "query console" });
  /** 等待产品真实采样持久化，不由夹具代写库存或释放事实。 */
  const waitInventory = async (predicate: (attempt: ShellUpdateAttemptV4) => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!sampledAttempt || !predicate(sampledAttempt)) {
      if (Date.now() >= deadline) throw new Error("lifecycle observation not persisted");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  if (defaultSnapshot) {
    processes.push({ ...f.oldMain, pid: lifecycle === 5 ? 170 : 150, parentPid: f.oldMain.pid, created: f.oldMain.created + 1, commandLine: "known short child" });
    defaultSnapshot(() => structuredClone(processes), f.store);
  }
  f.channel.onSend = async message => {
    if (message.kind === "armed") {
      const state = f.prepared.schemaVersion === 5 ? await f.store.beginHandoff(f.prepared, { lifecycle: true, oldMain: f.oldMain, helper: f.helper, continuationId: f.arm.continuationId, processes })
        : await f.store.beginHandoff(f.prepared, { oldMain: f.oldMain, helper: f.helper, continuationId: f.arm.continuationId, processes,
          knownOwned: processes.filter(item => item.pid === 150 || item.pid === 151), ...(lifecycle ? { lifecycle: true } : {}) });
      f.channel.emit("message", { ...f.arm, kind: "accept", revision: state.revision, body: {} });
    } else if (message.kind === "accepted") {
      if (variant === "fault-query") { processes = processes.filter(item => item.pid !== 150 && item.pid !== 151); queryFailed = true; }
      if (variant === "fault-partial") processes = processes.map(item => item.pid === 150 ? { ...item, executable: "", commandLine: "" } : item);
      if (variant === "fault-orphan") {
        processes = processes.filter(item => item.pid !== 150 && item.pid !== 151);
        processes.push({ ...f.oldMain, pid: 152, parentPid: 150, created: 1004, commandLine: "unknown orphan" });
      }
      if (variant.endsWith("reuse")) {
        if (variant === "released-reuse") {
          processes = processes.filter(item => item.pid !== 150 && item.pid !== 151);
          await waitInventory(attempt => attempt.ownedLifecycle.length === 2 && attempt.ownedLifecycle.every(item => item.release !== null));
          events.push("released-before-reuse");
        }
        processes = processes.filter(item => item.pid !== 150 && item.pid !== 151);
        processes.push({ ...f.oldMain, pid: 150, parentPid: 900, created: 5000, commandLine: "foreign reused query" },
          { ...f.oldMain, pid: 151, parentPid: 150, created: 5001, commandLine: "foreign console" });
      }
      if (variant === "drain-stable") { await new Promise(resolve => setTimeout(resolve, 120)); assert.equal((await f.store.read())!.revision, message.revision); events.push("stable-no-write"); }
      if (variant === "drain-descendant") {
        processes.push({ ...f.oldMain, pid: 150, parentPid: f.oldMain.pid, created: f.oldMain.created + 1, commandLine: "late old child" });
        const deadline = Date.now() + 10_000;
        while (!sampledAttempt?.owned?.some(item => item.pid === 150)) { if (Date.now() >= deadline) throw new Error("old inventory not persisted"); await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      f.channel.emit("message", { ...message, kind: "drained", body: {} });
    } else if (message.kind === "exit-request") {
      events.push("exit-request");
      exitRequestBarrier = onExitRequested?.(f.store); await exitRequestBarrier;
      if (variant !== "old-stays") processes = processes.filter(item => item.pid !== f.oldMain.pid && (variant.endsWith("reuse") || item.pid !== 150 && item.pid !== 170));
      if (variant === "historical-old-gone") processes.push({ ...f.oldMain, pid: 19176, parentPid: f.oldMain.pid, created: 500, executable: "", commandLine: "" });
    }
  };
  const running = runHelper({ dataDir: f.prepared.dataDir, channel: f.channel, pid: f.helper.pid, parentPid: f.oldMain.pid, timeoutMs: 15_000, trustedKeys: f.trustedKeys,
    boundary: {
      snapshot: defaultSnapshot ? undefined : async () => {
        await exitRequestBarrier;
        if (queryFailed) throw new Error("CONTROLLED_QUERY_FAILED");
        sampledAttempt = await f.store.read() as ShellUpdateAttemptV4;
        return structuredClone([...processes, ...(variant === "helper-query" ? [{ ...f.helper, pid: 10_000 + ++queries, parentPid: f.helper.pid,
          created: 20_000 + queries, commandLine: "current helper query" }] : [])]);
      }, verifyPrepared: async () => { events.push("verify"); },
      authorizeSwitch: async () => { authorizations += 1; events.push("authorize"); },
      stop: async identity => { processes = processes.filter(item => item.pid !== identity.pid); children.get(identity.pid)?.emit("close", 0, null); events.push("stopped"); },
      spawnMain: (executable, attempt) => {
        starts += 1; events.push("spawn"); assert.equal(processes.some(item => item.pid === f.oldMain.pid), false);
        const child = new Main(200 + starts); children.set(child.pid, child);
        const main = { pid: child.pid, parentPid: f.helper.pid, created: 2000 + starts, executable, commandLine: "controlled normal shell" };
        processes.push(main);
        child.onSend = async message => {
          if (message.kind === "bootstrap") {
            const role = message.body.role, actual = await f.store.read() as ShellUpdateAttemptV3;
            if (role === "candidate") onCandidateBootstrap?.();
            if (variant === "owner-probe" && role === "candidate") {
              const probe = await probeHelperOwner(attempt.dataDir);
              assert.equal(probe.localExecuted, false, "legacy reader must not become the physical owner during candidate startup");
              assert.equal(probe.schemaVersion, 5); assert.equal(probe.requestId, attempt.requestId); events.push("helper-owner-proven");
            }
            if (role === "candidate" && variant.startsWith("candidate-missing-")) {
              if (variant === "candidate-missing-exe") await fs.unlink(executable);
              else await fs.rm(path.join(path.dirname(executable), "resources"), { recursive: true });
              child.emit("error", new Error("candidate files disappeared before admission")); return;
            }
            if (variant === "unknown-descendant" && role === "candidate") {
              processes = processes.filter(item => item.pid !== main.pid);
              processes.push({ pid: 400, parentPid: main.pid, created: main.created + 1, executable, commandLine: "unobserved descendant" });
              child.emit("error", new Error("main exited before next sample")); child.emit("close", 1, null); return;
            }
            if (variant === "owner-stop-expiry" && role === "candidate") {
              processes.push({ ...main, pid: 400, parentPid: main.pid, created: main.created + 1, commandLine: "candidate cleanup child" });
              child.emit("error", new Error("candidate failed before cleanup inventory")); return;
            }
            if (["candidate-fails", "original-foreign"].includes(variant) && role === "candidate") { child.emit("error", new Error("candidate startup failed")); return; }
            const client = { pid: 300 + starts, parentPid: main.pid, created: main.created + 1, executable, commandLine: "controlled client" };
            processes.push(client);
            if (variant === "control-progress") {
              processes.push({ ...client, pid: 450, commandLine: "bootstrap query" });
              await waitInventory(attempt => attempt.owned.some(item => item.pid === 450));
              processes = processes.filter(item => item.pid !== 450);
              await waitInventory(attempt => attempt.ownedLifecycle.some((item, index) => attempt.owned[index].pid === 450 && item.release !== null));
              const sampled = await f.store.read() as ShellUpdateAttemptV4;
              assert.ok(sampled.revision > message.revision); assert.equal(sampled.controlRevision, message.revision);
              events.push("bootstrap-control-stable");
            }
            const ready: ShellUpdateReadyEvidence = { role, continuationId: attempt.continuationId, main, client, readyRequestId: `ready-${starts}`,
              health: attempt.binding.health, binding: attempt.binding, launchState: role === "candidate" ? attempt.candidateState : attempt.originalState,
              profile: { dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir }, mainFrame: "loaded",
              startup: { continuationId: attempt.continuationId, admission: "paused" } };
            assert.equal(actual.admission, null);
            if (variant === "foreign-ready" && role === "candidate") ready.profile.dataDir = path.join(attempt.dataDir, "foreign");
            if (variant === "original-foreign" && role === "original") ready.profile.dataDir = path.join(attempt.dataDir, "foreign");
            events.push(`${role}-ready`);
            child.emit("message", { ...message, kind: "ready", body: { ready } });
          } else if (message.kind === "permit") {
            if (variant === "control-progress") {
              processes.push({ ...main, pid: 451, parentPid: main.pid, created: main.created + 2, commandLine: "permit query" });
              await waitInventory(attempt => attempt.owned.some(item => item.pid === 451));
              processes = processes.filter(item => item.pid !== 451);
              await waitInventory(attempt => attempt.ownedLifecycle.some((item, index) => attempt.owned[index].pid === 451 && item.release !== null));
              const sampled = await f.store.read() as ShellUpdateAttemptV4;
              assert.ok(sampled.revision > message.revision); assert.equal(sampled.controlRevision, message.revision);
              events.push("permit-control-stable");
            }
            events.push(executable.includes(`${path.sep}new${path.sep}`) ? "candidate-permit" : "original-permit");
            const actual = await f.store.read() as ShellUpdateAttemptV3;
            if (executable.includes(`${path.sep}new${path.sep}`)) { assert.equal(actual.phase, "admission-intent"); assert.ok(actual.admission); events.push("intent-before-permit"); }
            if (variant === "permit-unknown") { child.emit("error", new Error("started delivery unknown")); return; }
            if (variant === "historical-candidate-gone") {
              processes = processes.filter(item => item.pid !== main.pid && item.parentPid !== main.pid);
              processes.push({ ...main, pid: 19176, parentPid: main.pid, created: 500, executable: "", commandLine: "" });
              await new Promise(resolve => setTimeout(resolve, 150));
              child.emit("error", Object.assign(new Error("controlled started failure"), { code: "CONTROLLED_STARTED_FAILURE" })); return;
            }
            const role = executable.includes(`${path.sep}new${path.sep}`) ? "candidate" : "original";
            const mainReady: ShellUpdateReadyEvidence = actual.admission ?? { role, continuationId: actual.continuationId, main,
              client: { pid: 300 + starts, parentPid: main.pid, created: main.created + 1, executable, commandLine: "controlled client" }, readyRequestId: `ready-${starts}`,
              health: actual.binding.health, binding: actual.binding, launchState: actual.originalState,
              profile: { dataDir: actual.dataDir, userDataDir: actual.userDataDir, sessionDataDir: actual.sessionDataDir }, mainFrame: "loaded", startup: { continuationId: actual.continuationId, admission: "paused" } };
            child.emit("message", { ...message, kind: "started", body: { terminalEvidence: { ready: mainReady, startedRequestId: `started-${starts}`,
              continueRequestId: `continue-${starts}`, startup: "completed", application: "started" } } });
          }
        };
        return child as unknown as ChildProcess;
      },
    } });
  queueMicrotask(() => f.channel.emit("message", f.arm));
  return { f, running, events, counts: () => ({ authorizations, starts }) };
}

/** 正文身份从原签名文件读取，运行版本由本模块所属包固定提供。 */
async function helperFailureIdentity(f: { prepared: { dataDir: string } }) {
  return await loadOrCreateDeviceIdentity(f.prepared.dataDir);
}

/** 只替换源码包缺失的发布元数据；其余真实文件读取与验签照常执行。 */
function helperFailurePackage(t: test.TestContext, metadata: unknown = { version: "1.2.3-helper" }) {
  const read = fs.readFile, packageUrl = new URL("../package.json", import.meta.url).href;
  t.mock.method(fs, "readFile", ((...args: Parameters<typeof fs.readFile>) => args[0] instanceof URL && args[0].href === packageUrl
    ? Promise.resolve(Buffer.from(JSON.stringify(metadata))) : read(...args)) as typeof fs.readFile);
}

for (const [variant, phase, recovery] of [["candidate-fails", "handoff", "restored"], ["permit-unknown", "admission-intent", "failed"]] as const)
test(`D11 helper final ${variant} stores one shell failure after the old main is gone`, async t => {
  helperFailurePackage(t);
  const s = await session(variant, undefined, false, undefined, undefined, helperFailureIdentity);
  let failure: unknown; await assert.rejects(s.running, error => { failure = error; return hasCode(error, "DESKTOP_SHELL_HANDOFF_HELPER_FAILED"); });
  const identity = await loadOrCreateDeviceIdentity(s.f.prepared.dataDir), journal = createUpdateFailureJournal(s.f.prepared.dataDir), records = journal.pending(identity.deviceId);
  assert.equal(records.length, 1); const record = records[0]!; assert.equal(record.errorCode, "DESKTOP_SHELL_UPDATE_FAILED");
  if (record.errorCode !== "DESKTOP_SHELL_UPDATE_FAILED") assert.fail("shell execution must not become a binding failure");
  assert.equal(record.shellId, "new"); assert.equal(record.phase, phase); assert.equal(record.recovery, recovery);
  assert.equal(record.shellVersion, "1.2.3-helper"); assert.equal(record.currentReleaseId, "installation");
  assert.equal(record.webVersion, "1.0.0"); assert.equal(record.clientVersion, "1.0.0"); assert.equal(record.requestId, s.f.prepared.requestId);
  assert.equal(record.rootCause.code, "DESKTOP_SHELL_HANDOFF_HELPER_FAILED"); assert.equal(Object.hasOwn(record, "releaseId"), false);
  await assert.rejects(reportShellHandoffHelperFailure(s.f.prepared.dataDir, failure), error => error === failure);
  assert.deepEqual(journal.pending(identity.deviceId), records, "runtime diagnostics cannot append a second terminal failure");
  const bytes = await fs.readFile(path.join(s.f.prepared.dataDir, "errors.jsonl"), "utf8");
  assert.equal(bytes.trimEnd().split("\n").length, 1); assert.doesNotMatch(bytes, /privateKey|publicKey|candidate startup failed|started delivery unknown|CodeFlowAI\.exe/);
});

test("D11 helper leaves a live old main to its own final failure boundary", async t => {
  let packageReads = 0; const read = fs.readFile, packageUrl = new URL("../package.json", import.meta.url).href;
  t.mock.method(fs, "readFile", ((...args: Parameters<typeof fs.readFile>) => {
    if (args[0] instanceof URL && args[0].href === packageUrl) { packageReads++; throw new Error("must not read helper package before ownership"); }
    return read(...args);
  }) as typeof fs.readFile);
  const f = await fixture(), revoked = new Error("authority revoked");
  f.channel.onSend = async message => {
    if (message.kind === "armed") { const handoff = await f.store.beginHandoff(f.prepared, { oldMain: f.oldMain, helper: f.helper, continuationId: f.arm.continuationId, processes: [f.oldMain, f.helper], knownOwned: [] }); f.channel.emit("message", { ...f.arm, kind: "accept", revision: handoff.revision, body: {} }); }
    else if (message.kind === "accepted") f.channel.emit("message", { ...message, kind: "drained", body: {} });
  };
  const running = runShellHandoffHelper({ dataDir: f.prepared.dataDir, channel: f.channel, pid: f.helper.pid, parentPid: f.oldMain.pid, trustedKeys: f.trustedKeys,
    boundary: { snapshot: async () => [f.oldMain, f.helper], verifyPrepared: async () => {}, authorizeSwitch: async () => { throw revoked; }, verifyOriginal: async () => {} } });
  queueMicrotask(() => f.channel.emit("message", f.arm)); await assert.rejects(running, error => hasCause(error, revoked));
  assert.equal(packageReads, 0); await assert.rejects(fs.stat(path.join(f.prepared.dataDir, "errors.jsonl")), { code: "ENOENT" });
});

test("D11 helper metadata failure preserves the real shell failure and refuses unknown versions", async t => {
  helperFailurePackage(t, { version: 42, private: "metadata must not leak" });
  const s = await session("permit-unknown", undefined, false, undefined, undefined, helperFailureIdentity);
  await assert.rejects(s.running, error => hasCode(error, "DESKTOP_SHELL_HANDOFF_HELPER_FAILED")
    && hasCode(error, "DESKTOP_SHELL_HANDOFF_FAILURE_CONTEXT_INVALID") && hasCode(error, "DESKTOP_SHELL_HANDOFF_FAILURE_RECORD_FAILED"));
  await assert.rejects(fs.stat(path.join(s.f.prepared.dataDir, "errors.jsonl")), { code: "ENOENT" });
});

test("D11 helper refuses unknown process ownership instead of treating it as gone", async t => {
  helperFailurePackage(t); const query = new Error("controlled ownership query failure"); let unknown = false;
  const run: typeof runShellHandoffHelper = input => runShellHandoffHelper({ ...input, boundary: { ...input.boundary,
    snapshot: async context => { if (unknown) throw query; return await input.boundary!.snapshot!(context); } } });
  const s = await session("permit-unknown", undefined, false, () => { unknown = true; }, undefined, helperFailureIdentity, run);
  await assert.rejects(s.running, error => hasCause(error, query) && hasCode(error, "DESKTOP_SHELL_HANDOFF_FAILURE_RECORD_FAILED"));
  await assert.rejects(fs.stat(path.join(s.f.prepared.dataDir, "errors.jsonl")), { code: "ENOENT" });
});

test("D11 helper verifies binding context before writing any evidence", async t => {
  helperFailurePackage(t);
  const s = await session("permit-unknown", undefined, false, undefined, undefined, async f => {
    await helperFailureIdentity(f); await fs.appendFile(path.join(f.prepared.installationDir, "shells", "baseline", "resources", "web", "index.html"), "tampered");
  });
  await assert.rejects(s.running, error => hasCode(error, "DESKTOP_SHELL_HANDOFF_FAILURE_RECORD_FAILED"));
  await assert.rejects(fs.stat(path.join(s.f.prepared.dataDir, "errors.jsonl")), { code: "ENOENT" });
});

test("D11 helper journal fsync failure remains attached to the final operation failure", async t => {
  helperFailurePackage(t); const sync = await import("node:fs"), fsync = sync.default.fsyncSync, write = Object.assign(new Error("controlled D11 fsync"), { code: "EIO" });
  let journalWrites = 0;
  t.mock.method(sync.default, "fsyncSync", (fd: number) => { if (journalWrites++ === 0) throw write; fsync(fd); });
  const s = await session("permit-unknown", undefined, false, undefined, undefined, helperFailureIdentity);
  await assert.rejects(s.running, error => hasCause(error, write) && hasCode(error, "DESKTOP_SHELL_HANDOFF_HELPER_FAILED"));
  assert.ok(journalWrites > 0); assert.equal(await fs.readFile(path.join(s.f.prepared.dataDir, "errors.jsonl"), "utf8"), "");
});

test("D11 helper resolves version from its relocated app.asar package rather than cwd", async t => {
  const packaged = await fs.mkdtemp(path.join(evidence, "packaged-helper-")), distribution = path.join(packaged, "app.asar", "dist"); await fs.mkdir(distribution, { recursive: true });
  await fs.symlink(new URL("../node_modules", import.meta.url), path.join(packaged, "node_modules"), "junction");
  await fs.writeFile(path.join(distribution, "..", "package.json"), JSON.stringify({ type: "module", version: "9.8.7-packaged" }), "utf8");
  const source = await fs.readFile(new URL("../src/shellHandoffHelper.ts", import.meta.url), "utf8");
  const relocated = source.replace(/from "(\.\/[^"\r\n]+)"/gu, (_match, relative: string) => `from "${new URL(relative.replace(/\.js$/u, ".ts"), new URL("../src/shellHandoffHelper.ts", import.meta.url)).href}"`);
  const modulePath = path.join(distribution, "shellHandoffHelper.ts"); await fs.writeFile(modulePath, relocated, "utf8");
  const helper = await import(pathToFileURL(modulePath).href) as typeof import("../src/shellHandoffHelper.js");
  const s = await session("permit-unknown", undefined, false, undefined, undefined, helperFailureIdentity, helper.runShellHandoffHelper);
  await assert.rejects(s.running); const identity = await loadOrCreateDeviceIdentity(s.f.prepared.dataDir), pending = createUpdateFailureJournal(s.f.prepared.dataDir).pending(identity.deviceId);
  assert.equal(pending.length, 1); assert.equal(pending[0]!.shellVersion, "9.8.7-packaged");
});

test("default helper spawn keeps candidate and restoration GUI visible with held IPC", async t => {
  const f = await preparationHelperFixture(), children = new Map<number, Main>();
  let processes = [f.oldMain, f.helper];
  const launches: { executable: string; args: readonly string[]; options: childProcess.SpawnOptions }[] = [];
  const startupFailure = new Error("controlled GUI startup failure");
  t.mock.method(childProcess, "spawn", (executable: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    launches.push({ executable, args, options });
    const child = new Main(200 + launches.length); children.set(child.pid, child);
    processes.push({ pid: child.pid, parentPid: f.helper.pid, created: 2000 + launches.length, executable, commandLine: "controlled GUI" });
    child.onSend = async message => { if (message.kind === "bootstrap") child.emit("error", startupFailure); };
    return child as unknown as ChildProcess;
  });
  syncBuiltinESMExports();
  f.channel.onSend = async message => {
    if (message.kind === "armed") {
      const attempt = await f.store.beginHandoff(f.prepared, { lifecycle: true, oldMain: f.oldMain, helper: f.helper,
        continuationId: f.arm.continuationId, processes });
      f.channel.emit("message", { ...f.arm, kind: "accept", revision: attempt.controlRevision, body: {} });
    } else if (message.kind === "accepted") f.channel.emit("message", { ...message, kind: "drained", body: {} });
    else if (message.kind === "exit-request") processes = processes.filter(value => value.pid !== f.oldMain.pid);
  };
  try {
    const running = runShellHandoffHelper({ dataDir: f.prepared.dataDir, channel: f.channel, pid: f.helper.pid, parentPid: f.oldMain.pid,
      trustedKeys: f.trustedKeys, timeoutMs: 3000, boundary: { snapshot: async () => structuredClone(processes),
        authorizeSwitch: async () => {}, verifyPrepared: async () => {}, verifyOriginal: async () => {},
        stop: async identity => { processes = processes.filter(value => value.pid !== identity.pid); children.get(identity.pid)?.emit("close", 0, null); } } });
    queueMicrotask(() => f.channel.emit("message", f.arm));
    await assert.rejects(running, error => hasCause(error, startupFailure));
    assert.deepEqual(launches.map(value => value.executable), ["new", "old"].map(shell => path.join(f.prepared.installationDir, "shells", shell, "CodeFlowAI.exe")));
    for (const launch of launches) {
      assert.equal(launch.options.windowsHide, false, "GUI startup failures must remain visible");
      assert.equal(launch.options.detached, process.platform === "win32");
      assert.deepEqual(launch.options.stdio, ["ignore", "inherit", "inherit", "ipc"]);
      assert.equal(launch.options.env?.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(launch.options.env?.CODEFLOWAI_DESKTOP_DATA_DIR, f.prepared.dataDir);
      assert.deepEqual(launch.args, ["--codeflow-shell-handoff", `--user-data-dir=${f.prepared.userDataDir}`]);
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("helper commits intent before permit and records completed only after actual started evidence", async () => {
  const s = await session("success"); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(actual.phase, "completed"); assert.ok(actual.admission); assert.ok(actual.terminalEvidence);
  assert.deepEqual(s.counts(), { authorizations: 1, starts: 1 }); assert.ok(s.events.includes("intent-before-permit"));
  assert.ok(actual.owned?.some(identity => identity.pid === actual.admission!.client.pid));
});

for (const lifecycle of [false, 5] as const) for (const stage of ["alive", "gone"] as const)
test(`historical parent epoch helper schema${lifecycle ? 5 : 3} excludes an old row while old main is ${stage}`, async () => {
  const s = await session(stage === "alive" ? "historical-old-alive" : "historical-old-gone", undefined, lifecycle); await s.running;
  const actual = await s.f.store.read() as ShellUpdateHandoffAttempt;
  assert.equal(actual.phase, "completed"); assert.ok(actual.owned); assert.equal(actual.owned.some(item => item.pid === 19176), false);
  assert.deepEqual(s.counts(), { starts: 1, authorizations: 1 });
});

for (const lifecycle of [false, 5] as const)
test(`historical parent epoch helper schema${lifecycle ? 5 : 3} preserves IPC failure after candidate disappears`, async () => {
  const s = await session("historical-candidate-gone", undefined, lifecycle);
  await assert.rejects(s.running, cause => hasCode(cause, "CONTROLLED_STARTED_FAILURE") && !hasCode(cause, "DESKTOP_SHELL_HANDOFF_DESCENDANT_IDENTITY_UNKNOWN"));
  const actual = await s.f.store.read() as ShellUpdateHandoffAttempt;
  assert.equal(actual.phase, "failed"); assert.ok(actual.admission); assert.equal(actual.terminalEvidence, null); assert.equal(s.counts().starts, 1);
});

test("schema5 helper retains the physical owner through a real remote candidate read", async () => {
  const s = await session("owner-probe", undefined, 5); await s.running;
  const actual = await s.f.store.read() as ShellUpdateHandoffAttemptV5;
  assert.equal(actual.phase, "completed"); assert.ok(s.events.includes("helper-owner-proven"));
  assert.deepEqual(s.counts(), { authorizations: 1, starts: 1 });
  const released = await probeHelperOwner(actual.dataDir);
  assert.equal(released.localExecuted, true, "helper completion must release its coordinator listener");
});

test("an expired helper owner never sends a permit or starts an original recovery main", async t => {
  const s = await session("success", undefined, 5, () => {
    const future = Date.now() + 60_000; t.mock.method(Date, "now", () => future);
  });
  await assert.rejects(s.running, error => hasCode(error, "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_SCOPE_EXPIRED"));
  t.mock.restoreAll();
  const actual = await s.f.store.read() as ShellUpdateHandoffAttemptV5;
  assert.equal(actual.phase, "handoff"); assert.equal(actual.admission, null); assert.equal(actual.terminalEvidence, null);
  assert.deepEqual(s.counts(), { authorizations: 1, starts: 1 });
  assert.equal(s.events.includes("candidate-permit"), false); assert.equal(s.events.includes("original-permit"), false);
  assert.equal((await readShellLaunchState(actual.installationDir)).state.activeShellId, "new");
});

test("helper preserves the startup cause when its physical owner also fails to close", async t => {
  const primary = new Error("controlled candidate startup failure"), closeFailure = Object.assign(new Error("controlled owner close failure"), { code: "OWNER_TEST_CLOSE_FAILED" });
  const close = net.Server.prototype.close;
  const s = await session("success", undefined, 5, () => {
    t.mock.method(net.Server.prototype, "close", function(this: net.Server, callback?: (error?: Error) => void) {
      return close.call(this, error => callback?.(error ?? closeFailure));
    });
    throw primary;
  });
  await assert.rejects(s.running, error => hasCause(error, primary) && hasCause(error, closeFailure));
});

test("helper starts no main when another scope already owns the post-exit physical queue", async () => {
  let competing: Awaited<ReturnType<ReturnType<typeof createShellUpdateAttemptStore>["acquireOwner"]>> | undefined;
  const s = await session("success", undefined, 5, undefined, async store => { competing = await store.acquireOwner(45_000); });
  try {
    await assert.rejects(s.running, error => hasCode(error, "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_BUSY"));
    assert.deepEqual(s.counts(), { authorizations: 1, starts: 0 });
    const actual = await s.f.store.read() as ShellUpdateHandoffAttemptV5;
    assert.equal(actual.phase, "handoff"); assert.equal(actual.selectedMain, null); assert.equal(actual.terminalEvidence, null);
    assert.equal((await readShellLaunchState(actual.installationDir)).state.activeShellId, "new");
  } finally { await competing?.release(); }
});

test("helper never stops a child when owner expires during the preceding inventory commit", async t => {
  const open = fs.open; let expiryInjected = false, cleanupReads = 0;
  const s = await session("owner-stop-expiry", undefined, 5, () => {
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith("shell-update-attempt.json")) {
        const saved = JSON.parse(await fs.readFile(args[0], "utf8")) as ShellUpdateHandoffAttemptV5;
        if (saved.owned.some(identity => identity.pid === 400) && ++cleanupReads === 3) {
          const close = file.close.bind(file);
          file.close = async () => {
            await close(); const future = Date.now() + 60_000; t.mock.method(Date, "now", () => future); expiryInjected = true;
          };
        }
      }
      return file;
    });
  });
  await assert.rejects(s.running, error => hasCode(error, "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_SCOPE_EXPIRED"));
  t.mock.restoreAll();
  assert.equal(expiryInjected, true); assert.equal(s.events.includes("stopped"), false);
  assert.deepEqual(s.counts(), { authorizations: 1, starts: 1 });
  const actual = await s.f.store.read() as ShellUpdateHandoffAttemptV5;
  assert.equal(actual.phase, "handoff"); assert.equal(actual.terminalEvidence, null);
  assert.equal((await readShellLaunchState(actual.installationDir)).state.activeShellId, "new");
});

for (const variant of ["success", "candidate-fails", "control-progress"] as const)
test(`schema5 helper ${variant} uses durable lifecycle through candidate and original direction`, async () => {
  const s = await session(variant, undefined, 5);
  if (variant === "candidate-fails") await assert.rejects(s.running); else await s.running;
  const actual = await s.f.store.read() as ShellUpdateHandoffAttemptV5, prepared = s.f.prepared as ShellUpdatePreparationAttemptV5;
  assert.equal(actual.schemaVersion, 5); assert.equal(actual.handoffRevision, prepared.revision + 1);
  assert.deepEqual(actual.preparationMains, prepared.preparationMains);
  for (let index = 0; index < prepared.ownedLifecycle.length; index++) if (prepared.ownedLifecycle[index]!.release)
    assert.deepEqual(actual.ownedLifecycle[index], prepared.ownedLifecycle[index]);
  assert.equal(actual.phase, variant === "candidate-fails" ? "restored" : "completed");
  assert.equal(s.counts().starts, variant === "candidate-fails" ? 2 : 1);
  if (variant === "candidate-fails") assert.ok(s.events.includes("stopped"));
});

test("schema4 helper completes after durable query subtree release and foreign PID reuse", async () => {
  const s = await session("released-reuse", undefined, true); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV4;
  assert.equal(actual.schemaVersion, 4); assert.equal(actual.phase, "completed");
  assert.ok(s.events.includes("released-before-reuse")); assert.equal(s.events.includes("stopped"), false);
  assert.equal(actual.owned.some(item => item.commandLine.startsWith("foreign")), false);
});

test("schema4 helper rejects PID reuse before a durable release without authorizing", async () => {
  const s = await session("unreleased-reuse", undefined, true); await assert.rejects(s.running);
  assert.equal(s.counts().authorizations, 0); assert.equal(s.counts().starts, 0);
});

test("schema4 helper observes bootstrap and permit samples while preserving exact control revisions", async () => {
  const s = await session("control-progress", undefined, true); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV4;
  assert.equal(actual.schemaVersion, 4); assert.equal(actual.phase, "completed");
  assert.ok(s.events.includes("bootstrap-control-stable")); assert.ok(s.events.includes("permit-control-stable"));
});

test("schema4 candidate startup failure stops its exact owned main before restoring complete S0", async () => {
  const s = await session("candidate-fails", undefined, true); await assert.rejects(s.running);
  const actual = await s.f.store.read() as ShellUpdateAttemptV4;
  assert.equal(actual.phase, "restored"); assert.equal(actual.terminalEvidence?.ready.role, "original");
  assert.equal(actual.admission, null); assert.deepEqual(s.counts(), { authorizations: 1, starts: 2 });
  assert.ok(s.events.includes("stopped"));
});

test("schema4 old-main drain ignores a continuously sampled helper query without releasing its history", async () => {
  const s = await session("helper-query", undefined, true); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV4;
  assert.equal(actual.phase, "completed"); assert.equal(s.counts().starts, 1);
  assert.ok(actual.owned.filter(item => item.commandLine === "current helper query").length > 1);
});

test("schema4 old-main drain still blocks a surviving console after its parent exits", async () => {
  const s = await session("old-console-stays", undefined, true); await assert.rejects(s.running);
  assert.equal(s.counts().starts, 0); assert.equal(s.events.includes("stopped"), false);
  const actual = await s.f.store.read() as ShellUpdateAttemptV4;
  assert.ok(actual.ownedLifecycle.every(item => item.release === null));
});

for (const fault of ["query", "partial", "orphan"] as const) test(`schema4 helper ${fault} failure never releases inventory or authorizes a switch`, async () => {
  const s = await session(`fault-${fault}`, undefined, true); await assert.rejects(s.running);
  const actual = await s.f.store.read() as ShellUpdateAttemptV4;
  assert.equal(actual.ownedLifecycle.length, 2); assert.ok(actual.ownedLifecycle.every(item => item.release === null));
  assert.deepEqual(s.counts(), { authorizations: 0, starts: 0 });
});

test("helper default snapshot retries durable known partial before collection can overwrite it", async t => {
  let injected = false;
  const originalExec = childProcess.execFile;
  try {
    const s = await session("success", (read, store) => {
      t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
        void (async () => {
          const attempt = await store.read(), rows = read();
          if (!injected && attempt?.schemaVersion === 3) {
            const child = rows.find(item => item.pid === 150)!; assert.ok(child);
            child.executable = ""; child.commandLine = ""; injected = true;
          }
          callback(null, JSON.stringify(rows));
        })().catch(cause => callback(cause));
      }) as typeof childProcess.execFile); syncBuiltinESMExports();
    });
    await s.running; const actual = await s.f.store.read() as ShellUpdateAttemptV3;
    assert.equal(injected, true); assert.equal(actual.phase, "completed");
    assert.equal(actual.owned?.find(item => item.pid === 150)?.commandLine, "known short child");
  } finally { childProcess.execFile = originalExec; syncBuiltinESMExports(); }
});

test("schema5 helper first default snapshot retries a known preparation main before arm", async t => {
  let injected = false;
  const originalExec = childProcess.execFile;
  try {
    const s = await session("success", read => {
      t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
        const rows = read();
        if (!injected) { const main = rows.find(item => item.pid === 101)!; main.executable = ""; main.commandLine = ""; injected = true; }
        callback(null, JSON.stringify(rows));
      }) as typeof childProcess.execFile); syncBuiltinESMExports();
    }, 5);
    await s.running; const actual = await s.f.store.read() as ShellUpdateHandoffAttemptV5;
    assert.equal(injected, true); assert.equal(actual.phase, "completed"); assert.equal(actual.schemaVersion, 5);
    assert.equal(s.counts().starts, 1);
  } finally { childProcess.execFile = originalExec; syncBuiltinESMExports(); }
});

for (const lifecycle of [true, 5] as const) test(`new-child snapshot helper ${lifecycle === 5 ? "schema5" : "schema4"} persists a new child only after its path is complete`, async t => {
  let injected = false, completed = false;
  const originalExec = childProcess.execFile;
  try {
    const s = await session("success", (read, store) => {
      t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
        void (async () => {
          const attempt = await store.read(), rows = read();
          if (attempt && "continuationId" in attempt && rows.some(item => item.pid === attempt.oldMain.pid)) {
            const child = { ...attempt.oldMain, pid: 180, parentPid: attempt.oldMain.pid, created: 1180, commandLine: "new query with delayed path" };
            rows.push(injected ? child : { ...child, executable: "" });
            if (injected) completed = true;
            else { injected = true; assert.equal(attempt.owned?.some(item => item.pid === child.pid), false); }
          }
          callback(null, JSON.stringify(rows));
        })().catch(cause => callback(cause));
      }) as typeof childProcess.execFile); syncBuiltinESMExports();
    }, lifecycle);
    await s.running;
    const actual = await s.f.store.read() as ShellUpdateHandoffAttempt;
    assert.equal(injected, true); assert.equal(completed, true); assert.equal(actual.phase, "completed");
    assert.equal(actual.owned?.find(item => item.pid === 180)?.commandLine, "new query with delayed path");
    assert.equal(actual.owned?.find(item => item.pid === 180)?.executable, s.f.oldMain.executable);
    assert.deepEqual(s.counts(), { authorizations: 1, starts: 1 });
  } finally { childProcess.execFile = originalExec; syncBuiltinESMExports(); }
});

test("new-child snapshot recovery helper uses the current execution history before accepting a delayed path", async t => {
  let injected = false;
  const originalExec = childProcess.execFile;
  try {
    const s = await recoverySession("candidate", "success", (read, store) => {
      t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
        void (async () => {
          const attempt = await store.read(), rows = read();
          if (attempt && "recovery" in attempt && attempt.recovery && rows.some(item => item.pid === attempt.recovery!.helper.pid)) {
            const helper = attempt.recovery.helper;
            const child = { ...helper, pid: 780, parentPid: helper.pid, created: 4780, commandLine: "recovery query with delayed path" };
            rows.push(injected ? child : { ...child, executable: "" }); injected = true;
          }
          callback(null, JSON.stringify(rows));
        })().catch(cause => callback(cause));
      }) as typeof childProcess.execFile); syncBuiltinESMExports();
    }, 5);
    await s.running;
    const actual = await s.f.store.read() as ShellUpdateHandoffAttempt;
    assert.equal(injected, true); assert.ok(actual.recovery?.terminalEvidence);
    assert.equal(actual.recovery?.knownOwned.find(item => item.pid === 780)?.commandLine, "recovery query with delayed path");
    assert.equal(s.events.includes("permit"), true);
  } finally { childProcess.execFile = originalExec; syncBuiltinESMExports(); }
});

for (const failure of ["gone", "changed"] as const) test(`new-child snapshot helper ${failure} child fails before authorization and preserves safe error context`, async t => {
  let injected = false;
  const originalExec = childProcess.execFile;
  try {
    const s = await session("success", (read, store) => {
      t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
        void (async () => {
          const attempt = await store.read(), rows = read();
          if (attempt && "continuationId" in attempt && rows.some(item => item.pid === attempt.oldMain.pid)) {
            const child = { ...attempt.oldMain, pid: 180, parentPid: attempt.oldMain.pid, created: 1180, commandLine: "private pending query" };
            if (!injected) rows.push({ ...child, executable: "" });
            else if (failure === "changed") rows.push({ ...child, commandLine: "private changed query" });
            injected = true;
          }
          callback(null, JSON.stringify(rows));
        })().catch(cause => callback(cause));
      }) as typeof childProcess.execFile); syncBuiltinESMExports();
    }, 5);
    const h = await import("../src/shellHandoff.js");
    let captured: unknown;
    await assert.rejects(s.running, cause => { captured = cause; return h.snapshotShellHandoffErrorContext(cause).causeCodes.includes(`DESKTOP_SHELL_HEALTH_PROCESS_PENDING_${failure.toUpperCase()}`); });
    assert.equal(injected, true); assert.deepEqual(s.counts(), { authorizations: 0, starts: 0 });
    assert.equal((await s.f.store.read() as ShellUpdateHandoffAttempt).owned?.some(item => item.pid === 180), false);
    await assert.rejects(reportShellHandoffHelperFailure(s.f.prepared.dataDir, captured), cause => cause === captured);
    const log = await fs.readFile(path.join(s.f.prepared.dataDir, "logs/desktop-errors.jsonl"), "utf8"), record = JSON.parse(log.trim());
    assert.equal(record.requestId, s.f.prepared.requestId); assert.ok(record.inventoryFailures.some((item: { pid: number }) => item.pid === 180));
    assert.equal(log.includes("private pending query"), false); assert.equal(log.includes("private changed query"), false);
  } finally { childProcess.execFile = originalExec; syncBuiltinESMExports(); }
});

test("helper default snapshot never claims an unknown partial child or authorizes after it", async t => {
  let injected = false;
  const originalExec = childProcess.execFile;
  try {
    const s = await session("success", (read, store) => {
      t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
        void (async () => {
          const attempt = await store.read(), rows = read();
          if (attempt?.schemaVersion === 3 && attempt.phase === "handoff") {
            rows.push({ pid: 151, parentPid: attempt.oldMain.pid, created: attempt.oldMain.created + 1, executable: "", commandLine: "" }); injected = true;
          }
          callback(null, JSON.stringify(rows));
        })().catch(cause => callback(cause));
      }) as typeof childProcess.execFile); syncBuiltinESMExports();
    });
    await assert.rejects(s.running); assert.equal(injected, true);
    assert.deepEqual(s.counts(), { authorizations: 0, starts: 0 });
    assert.equal((await s.f.store.read() as ShellUpdateAttemptV3).owned?.some(item => item.pid === 151), false);
  } finally { childProcess.execFile = originalExec; syncBuiltinESMExports(); }
});

test("accepted handoff persists newly observed old descendants before accepting drained", async () => {
  const s = await session("drain-descendant"); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.ok(actual.owned?.some(item => item.pid === 150)); assert.ok(actual.owned?.some(item => item.pid === actual.admission!.client.pid));
});

test("accepted sampling with unchanged inventory never advances the durable revision", async () => {
  const s = await session("drain-stable"); await s.running; assert.ok(s.events.includes("stable-no-write"));
});

/** 恢复沿真实claim/bind/observe/complete；运行前仅可准备上下文或配置外部进程边界。 */
async function recoverySession(direction: "original" | "candidate", variant = "success",
  defaultSnapshot?: (read: () => ProcessIdentity[], store: Awaited<ReturnType<typeof fixture>>["store"]) => void, lifecycle: boolean | 5 = false,
  setup?: (f: Awaited<ReturnType<typeof fixture>> | Awaited<ReturnType<typeof preparationHelperFixture>>) => Promise<unknown>) {
  const f = lifecycle === 5 ? await preparationHelperFixture() : await fixture(), events: string[] = [], children = new Map<number, Main>();
  await setup?.(f);
  let historySamples = 0, historyObserved!: () => void;
  const observedHistory = new Promise<void>(resolve => { historyObserved = resolve; });
  let verifyPhysicalCandidate: (() => Promise<void>) | undefined;
  if (variant === "physical-missing-resources") {
    const candidateDirectory = path.join(f.prepared.installationDir, "shells", "new"), installerPath = path.join(f.root, "synthetic-installer.exe");
    const installer = Buffer.from("synthetic installer never executed"); await fs.writeFile(installerPath, installer);
    const files = await Promise.all(["CodeFlowAI.exe", "resources/app.asar", "resources/release-trust.json"].map(async relative => {
      const filename = path.join(candidateDirectory, relative);
      if (relative.endsWith("release-trust.json")) await fs.writeFile(filename, "synthetic candidate trust");
      const bytes = await fs.readFile(filename); return { path: relative, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    }));
    const keys = crypto.generateKeyPairSync("ed25519"), manifest = signShellReleaseManifest({ schemaVersion: 1, protocol: "codeflow-desktop-shell-v1", shellId: "new", version: "1.0.0", platform: "win32", arch: "x64",
      installerSha256: crypto.createHash("sha256").update(installer).digest("hex"), installerSize: installer.length, files, keyId: "physical-candidate",
      createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, keys.privateKey);
    verifyPhysicalCandidate = async () => { await verifyShellReleaseArtifact({ manifest, trustedKeys: { "physical-candidate": keys.publicKey }, installerPath, candidateDirectory }); };
    await verifyPhysicalCandidate(); await fs.rm(path.join(candidateDirectory, "resources"), { recursive: true });
  }
  if (["candidate-corrupt", "default-original"].includes(variant)) await fs.writeFile(path.join(f.prepared.installationDir, "shells", "new", "resources", "app.asar"), "corrupt unused candidate");
  let base: ShellUpdateHandoffAttempt = f.prepared.schemaVersion === 5 ? await f.store.beginHandoff(f.prepared, { lifecycle: true, oldMain: f.oldMain, helper: f.helper,
    continuationId: f.arm.continuationId, processes: [f.oldMain, f.helper] }) : await f.store.beginHandoff(f.prepared, { oldMain: f.oldMain, helper: f.helper, continuationId: f.arm.continuationId,
      processes: [f.oldMain, f.helper], knownOwned: [], ...(lifecycle ? { lifecycle: true } : {}) });
  const previousMain = { ...f.oldMain, pid: 201, parentPid: f.helper.pid, created: 2001, executable: path.join(f.prepared.installationDir, "shells", "new", "CodeFlowAI.exe") };
  const previousClient = { ...previousMain, pid: 301, parentPid: previousMain.pid, created: 2002, commandLine: "historical client" };
  const previousQuery = { ...previousClient, pid: 351, parentPid: previousClient.pid, created: 2003, commandLine: "historical query" };
  base = await f.store.replace(base, { ...base, revision: base.revision + 1, selectedMain: previousMain }) as ShellUpdateHandoffAttempt;
  base = await f.store.observeHandoffOwned(base, { caller: f.helper, processes: [f.helper, previousMain, previousClient, ...(variant === "revived-history" ? [previousQuery] : [])] });
  if (direction === "candidate") {
    const ready: ShellUpdateReadyEvidence = { role: "candidate", continuationId: base.continuationId, main: previousMain, client: previousClient,
      readyRequestId: "historical-ready", health: base.binding.health, binding: base.binding, launchState: base.candidateState,
      profile: { dataDir: base.dataDir, userDataDir: base.userDataDir, sessionDataDir: base.sessionDataDir }, mainFrame: "loaded", startup: { continuationId: base.continuationId, admission: "paused" } };
    base = await f.store.replace(base, { ...base, revision: base.revision + 1, phase: "admission-intent", admission: ready }) as ShellUpdateHandoffAttempt;
  }
  await fs.writeFile(path.join(base.installationDir, "shell-launch.ini"), serializeShellLaunchState(base.candidateState));
  if (variant === "missing-exe") await fs.unlink(path.join(base.installationDir, "shells", "new", "CodeFlowAI.exe"));
  if (variant === "missing-resources") await fs.rm(path.join(base.installationDir, "shells", "new", "resources"), { recursive: true });
  if (variant === "missing-original-previous") await fs.unlink(path.join(base.installationDir, "shells", "previous", "CodeFlowAI.exe"));
  let launchState = base.candidateState;
  if (lifecycle) base = await f.store.observeHandoffOwned(base, { caller: f.helper, processes: [f.helper] });
  if (variant === "second-claim" || variant === "history-truncated") {
    const controller = { ...previousMain, pid: 351, parentPid: 1, created: 3501 }, helper = { ...controller, pid: 352, parentPid: controller.pid, created: 3502 };
    base = await f.store.beginRecovery(base, { caller: controller, helper, processes: [controller, helper], owner: { status: "gone", identity: f.helper },
      oldMain: { status: "gone", identity: f.oldMain }, selectedMain: { status: "gone", identity: previousMain }, launchState: { status: "known", value: launchState },
      binding: { status: "matched", value: base.binding }, profile: { status: "known", dataDir: base.dataDir, userDataDir: base.userDataDir, sessionDataDir: base.sessionDataDir },
      ownedReleased: "verified", knownOwned: { status: "known", identities: [f.oldMain, f.helper, previousMain, previousClient] } });
    launchState = direction === "original" ? base.originalState : base.candidateState;
    await fs.writeFile(path.join(base.installationDir, "shell-launch.ini"), serializeShellLaunchState(launchState));
    const main = { ...helper, pid: 353, parentPid: helper.pid, created: 3503, executable: path.join(base.installationDir, "shells", launchState.activeShellId, "CodeFlowAI.exe") };
    const facts = { caller: helper, processes: [helper, main], launchState: { status: "known", value: launchState }, binding: { status: "matched", value: base.binding },
      profile: { status: "known", dataDir: base.dataDir, userDataDir: base.userDataDir, sessionDataDir: base.sessionDataDir } };
    base = await f.store.bindRecoveryMain(base, { ...facts, main });
    base = await f.store.observeRecoveryOwned(base, { ...facts, processes: [helper, main, { ...main, pid: 354, parentPid: main.pid, created: 3504 }] });
    if (lifecycle) base = await f.store.observeRecoveryOwned(base, { ...facts, processes: [helper] });
  }
  const controller = { ...f.oldMain, pid: 401, parentPid: 1, created: 4001, executable: path.join(base.installationDir, "shells", launchState.activeShellId, "CodeFlowAI.exe"), commandLine: "zero client controller" };
  const helper = { ...controller, pid: 402, parentPid: controller.pid, created: 4002, commandLine: "recovery helper" };
  const prebindQuery = { ...helper, pid: 711, parentPid: variant === "prebind-controller" || variant.startsWith("claim-controller") ? controller.pid : helper.pid, created: 4003, commandLine: "prebind recovery query" };
  const prebindConsole = { ...prebindQuery, pid: 712, parentPid: prebindQuery.pid, created: 4004, commandLine: "surviving prebind console" };
  let prebindSamples = 0;
  let identitySamples = 0;
  let processes: ProcessIdentity[] = [controller, helper, ...(variant.startsWith("claim-") ? [prebindQuery, prebindConsole] : [])], starts = 0, authorizations = 0;
  const startedFailure = new Error("started unknown");
  const channel = new Channel(), arm = { ...f.arm, revision: shellUpdateHandoffRevision(base), body: { oldMain: controller } };
  defaultSnapshot?.(() => structuredClone(processes), f.store);
  channel.onSend = async message => {
    if (message.kind === "armed") {
      events.push("armed"); assert.equal((await f.store.read())!.revision, base.revision);
      const prior = base.recovery;
      const historical = lifecycle ? shellUpdateProcessHistory(base) : [f.oldMain, f.helper, previousMain, previousClient, ...(prior ? [prior.controller, prior.helper, ...(prior.main ? [prior.main] : []), ...prior.knownOwned] : [])];
      const claimed = await f.store.beginRecovery(base, { caller: controller, helper, processes,
        owner: { status: "gone", identity: f.helper }, oldMain: { status: "gone", identity: f.oldMain }, selectedMain: { status: "gone", identity: previousMain },
        launchState: { status: "known", value: launchState }, binding: { status: "matched", value: base.binding },
        profile: { status: "known", dataDir: base.dataDir, userDataDir: base.userDataDir, sessionDataDir: base.sessionDataDir }, ownedReleased: "verified",
        knownOwned: { status: "known", identities: historical } });
      if (variant === "history-truncated") await fs.writeFile(path.join(base.dataDir, "shell-update-attempt.json"), JSON.stringify({ ...claimed, recoveryHistory: [] }));
      if (variant === "claim-forged-release" && claimed.schemaVersion === 4) {
        const { processInstanceKey } = await import("../src/shellProcessInventory.js");
        for (const item of claimed.recovery!.knownOwnedLifecycle) item.release = { revision: claimed.revision, observerKey: processInstanceKey(helper), snapshotSha256: "a".repeat(64) };
        await fs.writeFile(path.join(base.dataDir, "shell-update-attempt.json"), JSON.stringify(claimed));
      }
      channel.emit("message", { ...arm, kind: "accept", revision: claimed.revision, body: {} });
    } else if (message.kind === "accepted") {
      events.push("accepted");
      if (variant !== "controller-alive" && !variant.startsWith("prebind-") && !variant.startsWith("claim-")) processes = processes.filter(item => item.pid !== controller.pid);
      if (variant.startsWith("prebind-")) processes.push(prebindQuery, prebindConsole);
      if (variant === "unknown-descendant") processes.push({ ...controller, pid: 499, parentPid: f.oldMain.pid, created: 4999, commandLine: "unknown historical descendant" });
      if (variant === "revived-history") processes.push(previousQuery);
      if (variant.startsWith("historical-")) {
        const parent = variant.includes("controller") ? controller : previousMain;
        processes.push({ ...parent, pid: 19176, parentPid: parent.pid, created: 500,
          executable: variant.endsWith("partial") ? "" : parent.executable, commandLine: variant.endsWith("partial") ? "" : "unrelated historical row" });
      }
    }
  };
  const running = runShellRecoveryHelper({ dataDir: base.dataDir, channel, pid: helper.pid, parentPid: controller.pid, timeoutMs: 3000, trustedKeys: f.trustedKeys,
    boundary: {
      snapshot: defaultSnapshot ? undefined : async () => {
        if (["bind-history", "bind-release"].includes(variant) && processes.some(item => item.pid === 721) && ++identitySamples === 2) processes = processes.filter(item => item.pid !== 721);
        if (variant.startsWith("prebind-") && processes.some(item => item.pid === prebindConsole.pid) && ++prebindSamples === 2) {
          processes = processes.filter(item => item.pid !== controller.pid && item.pid !== prebindQuery.pid);
        }
        if (variant.startsWith("claim-") && processes.some(item => item.pid === prebindConsole.pid)) {
          prebindSamples += 1;
          if (prebindSamples >= 2) processes = processes.filter(item => item.pid !== controller.pid && item.pid !== prebindQuery.pid);
          if (variant === "claim-controller" && prebindSamples === 3) {
            assert.equal(starts, 0);
            const current = await f.store.read() as ShellUpdateAttemptV4;
            for (const pid of [711, 712]) assert.equal(current.recovery!.knownOwnedLifecycle[current.recovery!.knownOwned.findIndex(item => item.pid === pid)]!.release, null);
            processes = processes.filter(item => item.pid !== prebindConsole.pid);
          }
        }
        if (variant === "memory-history" && processes.some(item => item.pid === 701) && processes.some(item => item.pid === 702) && ++historySamples === 2) historyObserved();
        return structuredClone(processes);
      }, authorizeSwitch: async () => { authorizations += 1; throw new Error("recovery must not authorize"); },
      verifyPrepared: async () => { events.push("verify-candidate"); if (verifyPhysicalCandidate) await verifyPhysicalCandidate(); if (variant === "candidate-corrupt") throw new Error("candidate corrupt"); },
      verifyOriginal: ["default-original", "missing-exe", "missing-resources"].includes(variant) ? undefined : async () => { events.push("verify-original"); },
      stop: async identity => { processes = processes.filter(item => item.pid !== identity.pid); children.get(identity.pid)?.emit("close", 0, null); events.push("stopped"); },
      spawnMain(executable) {
        starts += 1; events.push("spawn"); assert.equal(processes.some(item => item.pid === controller.pid), false);
        if (variant === "claim-controller") assert.equal(processes.some(item => item.pid === prebindConsole.pid), false);
        const child = new Main(500 + starts), main = { ...helper, pid: child.pid, parentPid: helper.pid, created: 5000 + starts, executable, commandLine: "recovered main" };
        children.set(main.pid, child); processes.push(main);
        if (["bind-history", "bind-release"].includes(variant)) {
          const query = { ...helper, pid: 721, parentPid: helper.pid, created: 6000, commandLine: "identity and bind query" };
          processes.push(query, { ...query, pid: 722, parentPid: query.pid, created: 6001, commandLine: "surviving bind console" });
        }
        child.onSend = async message => {
          if (message.kind === "bootstrap") {
            if (variant === "memory-history") {
              const parent = { ...main, pid: 701, parentPid: main.pid, created: main.created + 1, commandLine: "observed short parent" };
              processes.push(parent, { ...parent, pid: 702, parentPid: 701, created: main.created + 2, commandLine: "observed surviving grandchild" });
              await observedHistory;
              processes = processes.filter(item => item.pid !== 701);
            }
            const attempt = await f.store.read() as ShellUpdateHandoffAttempt; assert.equal(attempt.recovery?.main?.pid, main.pid); assert.equal(message.revision, shellUpdateHandoffRevision(attempt));
            const client = { ...main, pid: 600 + starts, parentPid: main.pid, created: main.created + 1, commandLine: "recovered client" }; processes.push(client);
            const ready: ShellUpdateReadyEvidence = { role: direction, continuationId: attempt.continuationId, main, client, readyRequestId: `recovered-ready-${starts}`,
              health: attempt.binding.health, binding: attempt.binding, launchState: direction === "candidate" ? attempt.candidateState : attempt.originalState,
              profile: { dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir }, mainFrame: "loaded",
              startup: { continuationId: attempt.continuationId, admission: "paused" } };
            if (variant.startsWith("key-order-")) {
              /** 只重排接收ready的五字段，模拟CIM；started沿main校验后的规范证据。 */
              const sampled = (identity: ProcessIdentity): ProcessIdentity => ({ created: identity.created, pid: identity.pid,
                parentPid: identity.parentPid, commandLine: identity.commandLine, executable: identity.executable });
              if (variant !== "key-order-client") ready.main = sampled(main);
              if (variant !== "key-order-main") ready.client = sampled(client);
            }
            if (variant === "foreign-ready") ready.profile.dataDir += "-foreign";
            if (variant === "unknown-ready-field") Object.assign(ready, { extra: true });
            child.emit("message", { ...message, kind: "ready", body: { ready } });
          } else if (message.kind === "permit") {
            events.push("permit"); const attempt = await f.store.read() as ShellUpdateHandoffAttempt;
            if (variant === "bind-release") processes = processes.filter(item => item.pid !== 722);
            assert.equal(message.revision, shellUpdateHandoffRevision(attempt)); assert.ok(attempt.recovery!.knownOwned.some(item => item.pid === 600 + starts));
            if (variant === "started-unknown") { events.push("started-failure"); child.emit("error", startedFailure); return; }
            const client = processes.find(item => item.pid === 600 + starts)!;
            child.emit("message", { ...message, kind: "started", body: { terminalEvidence: { ready: { role: direction, continuationId: attempt.continuationId, main, client,
              readyRequestId: variant === "changed-terminal-ready" ? "different-ready-request" : `recovered-ready-${starts}`, health: attempt.binding.health, binding: attempt.binding, launchState: direction === "candidate" ? attempt.candidateState : attempt.originalState,
              profile: { dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir }, mainFrame: "loaded", startup: { continuationId: attempt.continuationId, admission: "paused" } },
              startedRequestId: "recovered-started", continueRequestId: "recovered-continue", startup: "completed", application: "started" } } });
          }
        }; return child as unknown as ChildProcess;
      }
    } });
  queueMicrotask(() => channel.emit("message", arm));
  return { f, running, base, events, startedFailure, inspectProcesses: () => structuredClone(processes), counts: () => ({ starts, authorizations }) };
}

for (const direction of ["original", "candidate"] as const) test(`D11 recovery ${direction} stores its final failure after the controller is gone`, async t => {
  helperFailurePackage(t); const s = await recoverySession(direction, "started-unknown", undefined, false, helperFailureIdentity);
  await assert.rejects(s.running, error => hasCause(error, s.startedFailure));
  const identity = await loadOrCreateDeviceIdentity(s.f.prepared.dataDir), records = createUpdateFailureJournal(s.f.prepared.dataDir).pending(identity.deviceId);
  assert.equal(records.length, 1); assert.equal(records[0]!.phase, "recovery"); assert.equal(records[0]!.recovery, "failed");
  assert.equal(records[0]!.rootCause.code, "DESKTOP_SHELL_RECOVERY_HELPER_FAILED");
});

for (const direction of ["original", "candidate"] as const) test(`D11 recovery ${direction} cleanup failure uses only committed terminal evidence`, async t => {
  helperFailurePackage(t); const cleanup = new Error("disconnect after completed recovery");
  t.mock.method(Main.prototype, "disconnect", () => { throw cleanup; });
  const s = await recoverySession(direction, "success", undefined, false, helperFailureIdentity);
  await assert.rejects(s.running, error => hasCause(error, cleanup));
  const identity = await loadOrCreateDeviceIdentity(s.f.prepared.dataDir), records = createUpdateFailureJournal(s.f.prepared.dataDir).pending(identity.deviceId);
  assert.equal(records.length, 1); assert.equal(records[0]!.recovery, direction === "original" ? "restored" : "not_needed");
  assert.equal(records[0]!.phase, "recovery"); assert.ok((await s.f.store.read() as ShellUpdateHandoffAttempt).recovery?.terminalEvidence);
});

for (const direction of ["original", "candidate"] as const) test(`schema5 recovery ${direction} completes while preserving preparation history`, async () => {
  const s = await recoverySession(direction, "success", undefined, 5); await s.running;
  const actual = await s.f.store.read() as ShellUpdateHandoffAttemptV5;
  assert.equal(actual.schemaVersion, 5); assert.deepEqual(actual.preparationMains, (s.f.prepared as ShellUpdatePreparationAttemptV5).preparationMains);
  assert.equal(actual.recovery!.terminalEvidence!.ready.role, direction); assert.equal(s.counts().starts, 1);
  for (let index = 0; index < (s.f.prepared as ShellUpdatePreparationAttemptV5).ownedLifecycle.length; index++) {
    const before = (s.f.prepared as ShellUpdatePreparationAttemptV5).ownedLifecycle[index]!;
    if (before.release) assert.deepEqual(actual.ownedLifecycle[index], before);
  }
});

for (const parent of ["controller", "main"] as const) for (const partial of [false, true])
test(`historical parent epoch recovery excludes an old ${partial ? "partial" : "complete"} ${parent} row`, async () => {
  const s = await recoverySession("candidate", `historical-${parent}${partial ? "-partial" : ""}`, undefined, 5); await s.running;
  const actual = await s.f.store.read() as ShellUpdateHandoffAttemptV5;
  assert.ok(actual.recovery?.terminalEvidence); assert.equal(actual.recovery.knownOwned.some(item => item.pid === 19176), false);
  assert.deepEqual(s.counts(), { starts: 1, authorizations: 0 });
});

test("schema5 recovery first default snapshot rejects a changed historical preparation root before claim", async t => {
  let injected = false;
  const originalExec = childProcess.execFile;
  try {
    const s = await recoverySession("original", "success", (read, store) => {
      t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
        void (async () => {
          const rows = read();
          if (!injected) { const current = await store.read() as ShellUpdateHandoffAttemptV5; rows.push({ ...current.oldMain, parentPid: 990, created: 9000 }); injected = true; }
          callback(null, JSON.stringify(rows));
        })().catch(cause => callback(cause));
      }) as typeof childProcess.execFile); syncBuiltinESMExports();
    }, 5);
    await assert.rejects(s.running, cause => hasCode(cause, "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED"));
    const actual = await s.f.store.read() as ShellUpdateHandoffAttemptV5;
    assert.equal(injected, true); assert.equal(actual.recovery, undefined); assert.equal(s.counts().starts, 0);
  } finally { childProcess.execFile = originalExec; syncBuiltinESMExports(); }
});

for (const direction of ["original", "candidate"] as const) test(`schema4 recovery ${direction} completes while preserving released historical Client`, async () => {
  const s = await recoverySession(direction, "success", undefined, true); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV4;
  assert.ok(actual.recovery?.terminalEvidence); assert.ok(actual.ownedLifecycle.every(item => item.release !== null));
  assert.deepEqual(s.counts(), { starts: 1, authorizations: 0 });
});

for (const direction of ["original", "candidate"] as const) for (const owner of ["helper", "controller"] as const)
test(`schema4 recovery ${direction} accepts initial ${owner} descendants and drains only the controller subtree`, async () => {
  const s = await recoverySession(direction, `claim-${owner}`, undefined, true); await s.running;
  const recovery = (await s.f.store.read() as ShellUpdateAttemptV4).recovery!;
  assert.ok(recovery.terminalEvidence); assert.deepEqual(s.counts(), { starts: 1, authorizations: 0 });
  for (const pid of [711, 712]) {
    const index = recovery.knownOwned.findIndex(item => item.pid === pid); assert.ok(index >= 0);
    assert.equal(recovery.knownOwnedLifecycle[index]!.release !== null, owner === "controller");
  }
  assert.equal(s.inspectProcesses().some(item => item.pid === 712), owner === "helper");
});

test("schema4 recovery accepts initial controller inventory but never spawns while its grandchild survives", async () => {
  const s = await recoverySession("candidate", "claim-controller-alive", undefined, true); await assert.rejects(s.running);
  assert.equal(s.events.includes("accepted"), true); assert.deepEqual(s.counts(), { starts: 0, authorizations: 0 });
});

test("schema4 recovery accept rejects a forged release in the initial inventory", async () => {
  const s = await recoverySession("candidate", "claim-forged-release", undefined, true); await assert.rejects(s.running);
  assert.equal(s.events.includes("accepted"), false); assert.deepEqual(s.counts(), { starts: 0, authorizations: 0 });
});

for (const direction of ["original", "candidate"] as const) test(`schema4 recovery ${direction} persists prebind query history when its console survives`, async () => {
  const s = await recoverySession(direction, "prebind-history", undefined, true); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV4, recovery = actual.recovery!;
  assert.ok(recovery.terminalEvidence);
  assert.ok(recovery.knownOwned.some(item => item.pid === 711)); assert.ok(recovery.knownOwned.some(item => item.pid === 712));
  assert.equal(s.inspectProcesses().some(item => item.pid === 711), false);
  assert.equal(s.inspectProcesses().some(item => item.pid === 712), true);
  assert.equal(recovery.knownOwnedLifecycle[recovery.knownOwned.findIndex(item => item.pid === 711)].release, null);
});

for (const direction of ["original", "candidate"] as const) for (const released of [false, true])
test(`schema4 recovery ${direction} reuses the successful main identity snapshot and ${released ? "releases the completed subtree" : "keeps the surviving console"}`, async () => {
  const s = await recoverySession(direction, released ? "bind-release" : "bind-history", undefined, true); await s.running;
  const recovery = (await s.f.store.read() as ShellUpdateAttemptV4).recovery!;
  assert.ok(recovery.terminalEvidence); assert.ok(recovery.knownOwned.some(item => item.pid === 721));
  assert.ok(recovery.knownOwned.some(item => item.pid === 722));
  assert.equal(s.inspectProcesses().some(item => item.pid === 721), false);
  assert.equal(s.inspectProcesses().some(item => item.pid === 722), !released);
  for (const pid of [721, 722]) assert.equal(recovery.knownOwnedLifecycle[recovery.knownOwned.findIndex(item => item.pid === pid)].release !== null, released);
});

test("schema4 recovery accept rejects a second claim whose durable recovery history was truncated", async () => {
  const s = await recoverySession("candidate", "history-truncated", undefined, true); await assert.rejects(s.running);
  assert.equal(s.counts().starts, 0); assert.equal(s.events.includes("accepted"), false);
});

test("schema4 recovery keeps draining the controller subtree while its ordinary console remains alive", async () => {
  const s = await recoverySession("candidate", "prebind-controller", undefined, true); await assert.rejects(s.running);
  assert.equal(s.counts().starts, 0);
  const recovery = (await s.f.store.read() as ShellUpdateAttemptV4).recovery!;
  for (const pid of [711, 712]) {
    const index = recovery.knownOwned.findIndex(item => item.pid === pid); assert.ok(index >= 0);
    assert.equal(recovery.knownOwnedLifecycle[index].release, null);
  }
});

test("schema4 recovery helper refuses a released historical query revived after claim before spawning", async () => {
  const s = await recoverySession("candidate", "revived-history", undefined, true); await assert.rejects(s.running);
  assert.deepEqual(s.counts(), { starts: 0, authorizations: 0 });
});

for (const direction of ["original", "candidate"] as const) test(`recovery ${direction} persists observed history after an intermediate parent exits before ready`, async () => {
  const s = await recoverySession(direction, "memory-history"); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.ok(actual.recovery?.terminalEvidence);
  assert.deepEqual(actual.recovery.knownOwned.map(item => item.pid).sort((left, right) => left - right), [601, 701, 702]);
  assert.equal(s.inspectProcesses().some(item => item.pid === 701), false);
  assert.equal(s.inspectProcesses().some(item => item.pid === 702 && item.parentPid === 701), true);
});

for (const missing of ["exe", "resources"] as const) test(`original recovery with physically missing candidate ${missing} restores complete S0 with signed binding`, async () => {
  const s = await recoverySession("original", `missing-${missing}`); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.ok(actual.recovery?.terminalEvidence); assert.equal(actual.admission, null);
  assert.deepEqual(s.counts(), { starts: 1, authorizations: 0 }); assert.equal(s.events.includes("verify-candidate"), false);
  assert.equal(await fs.readFile(path.join(actual.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState({ activeShellId: "old", previousShellId: "previous", baselineShellId: "baseline" }));
});

for (const missing of ["exe", "resources"] as const) test(`schema4 original prebind observation tolerates only the unused missing candidate ${missing}`, async () => {
  const s = await recoverySession("original", `missing-${missing}`, undefined, true); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV4;
  assert.ok(actual.recovery?.terminalEvidence); assert.equal(actual.admission, null);
  assert.deepEqual(s.counts(), { starts: 1, authorizations: 0 });
});

for (const missing of ["exe", "resources"] as const) test(`first handoff missing candidate ${missing} before admission restores full S0 and one original main`, async () => {
  const s = await session(`candidate-missing-${missing}`); await assert.rejects(s.running);
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(actual.phase, "restored"); assert.equal(actual.admission, null); assert.equal(actual.terminalEvidence?.ready.role, "original");
  assert.equal(s.counts().starts, 2);
  assert.equal(await fs.readFile(path.join(actual.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState({ activeShellId: "old", previousShellId: "previous", baselineShellId: "baseline" }));
});

test("admitted recovery missing candidate exe never restores S0 or starts another main", async () => {
  const s = await recoverySession("candidate", "missing-exe"); await assert.rejects(s.running);
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.ok(actual.admission); assert.equal(actual.recovery?.terminalEvidence, null); assert.equal(s.counts().starts, 0);
  assert.equal(s.events.includes("permit"), false);
  assert.equal(await fs.readFile(path.join(actual.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(actual.candidateState));
});

test("admitted recovery with physically missing resources fails real signed artifact verification before spawn", async () => {
  const s = await recoverySession("candidate", "physical-missing-resources"); await assert.rejects(s.running);
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(s.events.includes("verify-candidate"), true); assert.equal(s.counts().starts, 0); assert.equal(s.events.includes("permit"), false);
  assert.ok(actual.admission); assert.equal(actual.recovery?.terminalEvidence, null);
  assert.equal(await fs.readFile(path.join(actual.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(actual.candidateState));
});

test("original recovery cannot ignore a physically missing original previous shell", async () => {
  const s = await recoverySession("original", "missing-original-previous"); await assert.rejects(s.running);
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(s.counts().starts, 0); assert.equal(actual.recovery?.terminalEvidence, null); assert.equal(s.events.includes("permit"), false);
  assert.equal(await fs.readFile(path.join(actual.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(actual.candidateState));
});

for (const execution of ["first", "recovery"] as const) test(`${execution} original INI restore with committed rename and undefined response never starts or admits original`, async t => {
  const rename = fs.rename; let injected = false;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    const original = path.basename(String(args[1])) === "shell-launch.ini" && (await fs.readFile(args[0], "utf8")).includes("active=old\r\n");
    await rename(...args); if (original && !injected) { injected = true; throw undefined; }
  });
  const s = execution === "first" ? await session("candidate-missing-exe") : await recoverySession("original", "missing-exe");
  await assert.rejects(s.running); const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(injected, true); assert.equal(s.counts().starts, execution === "first" ? 1 : 0);
  assert.equal(actual.terminalEvidence, null); assert.equal(actual.recovery?.terminalEvidence ?? null, null);
  assert.equal(s.events.some(event => event === "original-permit" || event === "permit"), false);
  assert.equal(await fs.readFile(path.join(actual.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(actual.originalState));
});

for (const direction of ["original", "candidate"] as const) test(`recovery helper preserves historical evidence and completes only current ${direction} execution`, async () => {
  const s = await recoverySession(direction); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(actual.recovery?.direction, direction); assert.ok(actual.recovery?.terminalEvidence);
  assert.deepEqual(actual.admission, s.base.admission); assert.deepEqual(actual.terminalEvidence, s.base.terminalEvidence);
  assert.deepEqual(actual.network, s.base.network); assert.deepEqual(s.counts(), { starts: 1, authorizations: 0 });
});

for (const direction of ["original", "candidate"] as const)
test(`recovery ${direction} default snapshot protects historical attempt inventory absent from current known inventory`, async t => {
  let injected = false, rechecked = false;
  const originalExec = childProcess.execFile;
  try {
    const s = await recoverySession(direction, "success", (read, store) => {
      t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
        void (async () => {
          const attempt = await store.read() as ShellUpdateAttemptV3, rows = read();
          if (!injected && attempt.recovery) {
            const historical = attempt.owned![0]!;
            assert.equal(attempt.recovery.knownOwned.some(item => item.pid === historical.pid), false);
            rows.push({ ...historical, executable: "", commandLine: "" }); injected = true;
          } else if (injected) rechecked = true;
          callback(null, JSON.stringify(rows));
        })().catch(cause => callback(cause));
      }) as typeof childProcess.execFile); syncBuiltinESMExports();
    });
    await s.running; assert.equal(injected, true); assert.equal(rechecked, true);
    const actual = await s.f.store.read() as ShellUpdateAttemptV3;
    assert.equal(actual.recovery?.terminalEvidence?.ready.role, direction); assert.deepEqual(actual.admission, s.base.admission);
  } finally { childProcess.execFile = originalExec; syncBuiltinESMExports(); }
});

for (const direction of ["original", "candidate"] as const) for (const role of ["main", "client", "both"] as const)
test(`recovery ${direction} accepts ${role} ready identity key order and canonical completion`, async () => {
  const s = await recoverySession(direction, `key-order-${role}`); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(actual.recovery?.terminalEvidence?.ready.role, direction);
  assert.deepEqual(actual.admission, s.base.admission); assert.deepEqual(actual.network, s.base.network);
  assert.deepEqual(s.counts(), { starts: 1, authorizations: 0 });
});

for (const direction of ["original", "candidate"] as const) test(`recovery ${direction} rejects changed terminal ready evidence`, async t => {
  helperFailurePackage(t); const s = await recoverySession(direction, "changed-terminal-ready", undefined, false, helperFailureIdentity);
  await assert.rejects(s.running, (cause: any) => cause.code === "DESKTOP_SHELL_RECOVERY_HELPER_FAILED"
    && cause.cause?.code === "DESKTOP_SHELL_HANDOFF_RESTORE_EVIDENCE_INVALID");
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(actual.recovery?.terminalEvidence, null);
  assert.deepEqual(actual.admission, s.base.admission); assert.equal(s.events.includes("stopped"), false);
});

for (const direction of ["original", "candidate"] as const) test(`recovery ${direction} rejects unknown ready fields before permit`, async t => {
  helperFailurePackage(t); const s = await recoverySession(direction, "unknown-ready-field", undefined, false, helperFailureIdentity);
  await assert.rejects(s.running, (cause: any) => cause.code === "DESKTOP_SHELL_RECOVERY_HELPER_FAILED"
    && cause.cause?.code === "DESKTOP_SHELL_HANDOFF_MESSAGE_INVALID");
  assert.equal(s.events.includes("permit"), false);
  assert.equal((await s.f.store.read() as ShellUpdateAttemptV3).recovery?.terminalEvidence, null);
});

for (const variant of ["controller-alive", "unknown-descendant", "foreign-ready"] as const) test(`recovery ${variant} gets no business permit`, async () => {
  const s = await recoverySession("original", variant); await assert.rejects(s.running);
  assert.equal(s.events.includes("permit"), false); assert.equal(s.counts().authorizations, 0);
  if (variant !== "foreign-ready") assert.equal(s.counts().starts, 0);
});

test("original recovery ignores unused corrupt candidate while admitted candidate recovery fails explicitly", async () => {
  const original = await recoverySession("original", "candidate-corrupt"); await original.running;
  assert.equal(original.events.includes("verify-candidate"), false);
  const candidate = await recoverySession("candidate", "candidate-corrupt"); await assert.rejects(candidate.running);
  assert.equal(candidate.counts().starts, 0); assert.equal(candidate.events.includes("permit"), false);
});

test("default original recovery verifies signed S0 without server origin or unused candidate proof", async () => {
  const s = await recoverySession("original", "default-original"); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(actual.recovery?.terminalEvidence?.ready.role, "original"); assert.equal(s.events.includes("verify-candidate"), false);
  assert.equal(s.counts().authorizations, 0);
});

test("admitted recovery with unknown started preserves S1 and never stops or restarts a second main", async t => {
  helperFailurePackage(t); const s = await recoverySession("candidate", "started-unknown", undefined, false, helperFailureIdentity); await assert.rejects(s.running, (cause: any) => cause.code === "DESKTOP_SHELL_RECOVERY_HELPER_FAILED" && cause.cause === s.startedFailure);
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.deepEqual(actual.admission, s.base.admission); assert.equal(actual.recovery?.terminalEvidence, null);
  assert.equal(s.events.includes("stopped"), false); assert.equal(s.counts().starts, 1);
  assert.deepEqual(s.events.slice(-2), ["permit", "started-failure"]);
  assert.equal(await fs.readFile(path.join(actual.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(actual.candidateState));
});

test("original recovery with unknown started retains the admitted instance and does not falsely retry it", async t => {
  helperFailurePackage(t); const s = await recoverySession("original", "started-unknown", undefined, false, helperFailureIdentity); await assert.rejects(s.running, (cause: any) => cause.code === "DESKTOP_SHELL_RECOVERY_HELPER_FAILED" && cause.cause === s.startedFailure);
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(actual.recovery?.terminalEvidence, null); assert.equal(s.events.includes("stopped"), false); assert.equal(s.counts().starts, 1);
  assert.deepEqual(s.events.slice(-2), ["permit", "started-failure"]);
  assert.equal(await fs.readFile(path.join(actual.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(actual.originalState));
});

test("a recovery Client inventory rename response failure is reread and cannot authorize business", async t => {
  const rename = fs.rename; let injected = false;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    const update = path.basename(String(args[1])) === "shell-update-attempt.json" ? JSON.parse(await fs.readFile(args[0], "utf8")) : undefined;
    await rename(...args);
    if (!injected && update?.recovery?.knownOwned?.length) { injected = true; throw undefined; }
  });
  const s = await recoverySession("candidate"); await assert.rejects(s.running);
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(injected, true); assert.ok(actual.recovery?.knownOwned.length); assert.equal(s.events.includes("permit"), false);
  assert.equal(s.events.includes("stopped"), false); assert.deepEqual(actual.admission, s.base.admission);
});

for (const direction of ["original", "candidate"] as const) test(`a second recovery claim after a crashed bound ${direction} main preserves original history`, async () => {
  const s = await recoverySession(direction, "second-claim"); await s.running;
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(actual.recovery?.controller.pid, 401); assert.ok(actual.recovery?.terminalEvidence);
  assert.deepEqual(actual.admission, s.base.admission); assert.equal(actual.retriesUsed, s.base.retriesUsed); assert.deepEqual(actual.network, s.base.network);
});

test("candidate ready with a foreign profile receives no permit and original recovery completes", async () => {
  const s = await session("foreign-ready"); await assert.rejects(s.running);
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(actual.phase, "restored"); assert.equal(actual.admission, null); assert.equal(s.events.includes("intent-before-permit"), false);
});

test("an intent rename response failure is reread and never restores S0 or sends a permit", async t => {
  const rename = fs.rename; let injected = false;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    const target = String(args[1]);
    const intent = path.basename(target) === "shell-update-attempt.json" && JSON.parse(await fs.readFile(args[0], "utf8")).phase === "admission-intent";
    await rename(...args);
    if (intent && !injected) { injected = true; throw undefined; }
  });
  const s = await session("success"); await assert.rejects(s.running);
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(injected, true); assert.ok(actual.admission); assert.equal(actual.phase, "failed"); assert.equal(s.counts().starts, 1);
  assert.equal(s.events.includes("intent-before-permit"), false);
  assert.equal(await fs.readFile(path.join(actual.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(actual.candidateState));
});

test("a failed IPC send settles its paired wait without an unhandled rejection", async () => {
  const f = await fixture(), cause = new Error("send callback failed");
  f.channel.send = (_message, callback) => { callback(cause); return false; };
  const running = runShellHandoffHelper({ dataDir: f.prepared.dataDir, channel: f.channel, pid: f.helper.pid, parentPid: f.oldMain.pid, timeoutMs: 50,
    boundary: { snapshot: async () => [f.oldMain, f.helper] } });
  queueMicrotask(() => f.channel.emit("message", f.arm));
  await assert.rejects(running); assert.deepEqual(await f.store.read(), f.prepared);
});

test("an original held ready with a foreign profile is rejected before its permit", async () => {
  const s = await session("original-foreign"); await assert.rejects(s.running);
  assert.ok(s.events.includes("original-ready")); assert.equal(s.events.includes("original-permit"), false);
});

test("a committed intent with unreadable postconditions never stops the selected candidate", async t => {
  const rename = fs.rename, open = fs.open; let committed = false, denied = false;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    const intent = path.basename(String(args[1])) === "shell-update-attempt.json" && JSON.parse(await fs.readFile(args[0], "utf8")).phase === "admission-intent";
    await rename(...args); if (intent) committed = true;
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (committed && path.basename(String(args[0])) === "shell-update-attempt.json") { denied = true; throw new Error("persistent reader failure"); }
    return await open(...args);
  });
  const s = await session("success"); await assert.rejects(s.running);
  assert.equal(committed, true); assert.equal(denied, true); assert.equal(s.events.includes("stopped"), false);
  assert.equal(s.counts().starts, 1); assert.equal(s.events.includes("original-permit"), false);
});

test("unobserved descendant after immediate main death blocks S0 restore and a second profile owner", async () => {
  const s = await session("unknown-descendant"); await assert.rejects(s.running);
  assert.equal(s.counts().starts, 1); assert.equal(s.events.includes("stopped"), false);
  assert.equal(await fs.readFile(path.join(s.f.prepared.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(s.f.prepared.candidateState));
});

test("the helper diagnostic boundary retains original, unreadable state and log-write failures", async t => {
  const f = await fixture(), read = new Error("state read failed"), write = new Error("log write failed"), open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (path.basename(String(args[0])) === "shell-update-attempt.json") throw read;
    return await open(...args);
  });
  t.mock.method(fs, "appendFile", async () => { throw write; });
  await assert.rejects(reportShellHandoffHelperFailure(f.prepared.dataDir, undefined), (error: any) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[1], write);
    const primary = error.errors[0]; assert.ok(primary instanceof AggregateError); assert.equal(primary.errors[0], undefined);
    assert.equal(primary.errors[1].cause, read); return true;
  });
});

/** 诊断样本只保留安全投影；原文仅用于独立计算哈希和泄漏断言。 */
function identityConflictDiagnostic(pid = 401) {
  const hash = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return { pid, changedFields: ["parentPid", "created", "executable", "commandLine"],
    expected: { parentPid: 400, created: 1700000000000, executableSha256: hash("D:\\private-diagnostic\\original.exe"), commandLineSha256: hash("private-diagnostic-secret-original") },
    actual: { parentPid: 399, created: 1700000000001, executableSha256: hash("D:\\private-diagnostic\\actual.exe"), commandLineSha256: hash("private-diagnostic-secret-actual") } };
}

test("identity conflict diagnostic log preserves nested causes context and exact safe projections", async t => {
  const f = await fixture();
  const attempt = await f.store.beginHandoff(f.prepared, { oldMain: f.oldMain, helper: f.helper, continuationId: f.arm.continuationId,
    processes: [f.oldMain, f.helper], knownOwned: [] });
  const first = identityConflictDiagnostic(), second = identityConflictDiagnostic(402);
  const conflict = Object.assign(new Error("private-diagnostic-secret-original"), { code: "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED", processIdentityConflict: first });
  const other = Object.assign(new Error("private-diagnostic-secret-actual"), { code: "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED", processIdentityConflict: second });
  const cause = Object.assign(new Error("private-diagnostic-secret-wrapper", { cause: new AggregateError([conflict, other], "private-diagnostic-secret-aggregate") }), { code: "HELPER_TEST_FAILURE" });
  let written = "";
  t.mock.method(fs, "appendFile", async (_file: unknown, content: unknown) => { written = String(content); });
  await assert.rejects(reportShellHandoffHelperFailure(f.prepared.dataDir, cause), error => error === cause);
  const actual = JSON.parse(written);
  assert.deepEqual(actual.processIdentityConflicts, [second, first]);
  assert.deepEqual(actual.rootCause, ["HELPER_TEST_FAILURE", "AggregateError", "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED", "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED"]);
  assert.equal(actual.requestId, attempt.requestId); assert.equal(actual.shellId, attempt.target.shellId);
  assert.equal(actual.revision, attempt.revision); assert.equal(actual.phase, attempt.phase);
  assert.deepEqual(actual.helper, { pid: f.helper.pid, parentPid: f.helper.parentPid, created: f.helper.created });
  for (const secret of ["private-diagnostic", "private-diagnostic-secret", f.oldMain.executable]) assert.equal(written.includes(secret), false);
});

test("inventory failure diagnostic reaches the helper boundary with request context", async t => {
  const f = await fixture(), diagnostic = { reason: "UNKNOWN_PARENT_MISSING", pid: 401, parentPid: 400,
    created: 1700000000000, instanceSha256: "a".repeat(64) };
  await f.store.beginHandoff(f.prepared, { oldMain: f.oldMain, helper: f.helper, continuationId: f.arm.continuationId,
    processes: [f.oldMain, f.helper], knownOwned: [] });
  const cause = Object.assign(new Error("private-inventory-command"), { code: "DESKTOP_SHELL_PROCESS_INVENTORY_INVALID", inventoryFailure: diagnostic });
  let written = "";
  t.mock.method(fs, "appendFile", async (_file: unknown, content: unknown) => { written = String(content); });
  await assert.rejects(reportShellHandoffHelperFailure(f.prepared.dataDir, cause), error => error === cause);
  const actual = JSON.parse(written);
  assert.deepEqual(actual.inventoryFailures, [diagnostic]);
  assert.equal(actual.requestId, f.prepared.requestId);
  assert.equal(actual.dataDir, f.prepared.dataDir); assert.equal(actual.processId, process.pid);
  assert.equal(written.includes("private-inventory-command"), false);
});

for (const variant of ["getter", "unknown-reason", "extra-field", "invalid-hash"] as const)
test(`inventory diagnostic rejects ${variant} without evaluating it`, async t => {
  const f = await fixture(), diagnostic = { reason: "UNKNOWN_PARENT_MISSING", pid: 401, parentPid: 400,
    created: 1700000000000, instanceSha256: "a".repeat(64) };
  const cause = Object.assign(new Error("inventory failed"), { code: "DESKTOP_SHELL_PROCESS_INVENTORY_INVALID", inventoryFailure: diagnostic });
  let getters = 0, writes = 0;
  if (variant === "getter") Object.defineProperty(diagnostic, "pid", { get: () => { getters++; return 401; } });
  if (variant === "unknown-reason") diagnostic.reason = "private-inventory-command";
  if (variant === "extra-field") Object.assign(diagnostic, { commandLine: "private-inventory-command" });
  if (variant === "invalid-hash") diagnostic.instanceSha256 = "invalid";
  t.mock.method(fs, "appendFile", async () => { writes++; });
  await assert.rejects(reportShellHandoffHelperFailure(f.prepared.dataDir, cause), (error: any) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], cause);
    assert.equal(error.errors[1].code, "DESKTOP_SHELL_HANDOFF_IDENTITY_CONFLICT_DIAGNOSTIC_INVALID"); return true;
  });
  assert.equal(getters, 0); assert.equal(writes, 0);
});

for (const variant of ["diagnostic-getter", "nested-getter", "array-getter", "extra-field", "symbol-field", "invalid-pid", "invalid-created",
  "invalid-hash", "empty-fields", "duplicate-fields", "unknown-field", "array-extra", "inherited-field", "inconsistent-fields"] as const)
test(`identity conflict diagnostic rejects ${variant} without getters or loss of original cause`, async t => {
  const f = await fixture(), diagnostic = identityConflictDiagnostic(); let getters = 0, writes = 0;
  const cause = Object.assign(new Error("private-diagnostic-secret-original"), { code: "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED", processIdentityConflict: diagnostic });
  const getter = { get: () => { getters += 1; return "private-diagnostic-secret-getter"; }, configurable: true };
  if (variant === "diagnostic-getter") Object.defineProperty(cause, "processIdentityConflict", getter);
  if (variant === "nested-getter") Object.defineProperty(diagnostic.actual, "commandLineSha256", getter);
  if (variant === "array-getter") Object.defineProperty(diagnostic.changedFields, "0", getter);
  if (variant === "extra-field") Object.assign(diagnostic.actual, { commandLine: "private-diagnostic-secret-extra" });
  if (variant === "symbol-field") Object.defineProperty(diagnostic, Symbol("secret"), { value: "private-diagnostic-secret-symbol" });
  if (variant === "invalid-pid") diagnostic.pid = 0;
  if (variant === "invalid-created") diagnostic.expected.created = 0;
  if (variant === "invalid-hash") diagnostic.actual.executableSha256 = "private-diagnostic-secret-invalid";
  if (variant === "empty-fields") diagnostic.changedFields = [];
  if (variant === "duplicate-fields") diagnostic.changedFields = ["created", "created"];
  if (variant === "unknown-field") diagnostic.changedFields = ["pid"];
  if (variant === "array-extra") Object.assign(diagnostic.changedFields, { secret: "private-diagnostic-secret-extra" });
  if (variant === "inherited-field") Object.setPrototypeOf(diagnostic.expected, { secret: "private-diagnostic-secret-prototype" });
  if (variant === "inconsistent-fields") diagnostic.changedFields = ["created"];
  t.mock.method(fs, "appendFile", async () => { writes += 1; });
  await assert.rejects(reportShellHandoffHelperFailure(f.prepared.dataDir, cause), (error: any) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], cause);
    assert.equal(error.errors[1].code, "DESKTOP_SHELL_HANDOFF_IDENTITY_CONFLICT_DIAGNOSTIC_INVALID"); return true;
  });
  assert.equal(getters, 0); assert.equal(writes, 0);
});

test("candidate failure cleans its instance before restoring full S0 and held original startup", async () => {
  const s = await session("candidate-fails"); await assert.rejects(s.running);
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(actual.phase, "restored"); assert.equal(actual.admission, null); assert.equal(actual.terminalEvidence?.ready.role, "original");
  assert.deepEqual(s.counts(), { authorizations: 1, starts: 2 }); assert.ok(s.events.indexOf("stopped") < s.events.lastIndexOf("spawn"));
  assert.equal(await fs.readFile(path.join(actual.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(actual.originalState));
});

test("unknown started after committed intent preserves S1 and never opens original startup", async () => {
  const s = await session("permit-unknown"); await assert.rejects(s.running);
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(actual.phase, "failed"); assert.ok(actual.admission); assert.equal(actual.terminalEvidence, null);
  assert.equal(s.counts().starts, 1); assert.equal(await fs.readFile(path.join(actual.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(actual.candidateState));
});

test("old main surviving exit request blocks candidate and restores full S0 without a second old process", async () => {
  const s = await session("old-stays"); await assert.rejects(s.running);
  const actual = await s.f.store.read() as ShellUpdateAttemptV3;
  assert.equal(s.counts().starts, 0); assert.equal(actual.admission, null);
  assert.equal(await fs.readFile(path.join(actual.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(actual.originalState));
});
