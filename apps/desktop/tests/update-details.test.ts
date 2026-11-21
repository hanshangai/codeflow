import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as tar from "tar";
import { DESKTOP_STARTUP_CAPABILITY_PATH, type DesktopBridgeApi, type DesktopStartupMode, type DesktopUpdateDetails } from "@codeflowai/shared";
import { signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import { desktopDevicePublicKeySha256, readDesktopDeviceHeaders } from "@codeflowai/shared/desktop-device-auth";
import { createDesktopApplication, type DesktopHost } from "../src/desktopApplication.js";
import type { ClientRuntime, ClientRuntimeExpectation } from "../src/clientRuntime.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";

/** 真实签名包、HTTP及应用 owner；仅隔离窗口与 Client 子进程。 */
async function fixture(t: test.TestContext, network = true, start = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-update-details-"));
  const identity = await loadOrCreateDeviceIdentity(root), keys = crypto.generateKeyPairSync("ed25519");
  const incoming = path.join(root, "incoming");
  await fs.mkdir(path.join(incoming, "web"), { recursive: true });
  await fs.mkdir(path.join(incoming, "client", "dist"), { recursive: true });
  await fs.writeFile(path.join(incoming, "web", "index.html"), "web", "utf8");
  await fs.writeFile(path.join(incoming, "client", "dist", "index.cjs"), "client", "utf8");
  const hash = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
  const capability = JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: hash("client") });
  await fs.writeFile(path.join(incoming, DESKTOP_STARTUP_CAPABILITY_PATH), capability, "utf8");
  const archivePath = path.join(root, "archive.tar.gz");
  await tar.c({ cwd: incoming, file: archivePath, gzip: true, portable: true }, ["web", "client"]);
  const archive = await fs.readFile(archivePath);
  const webSha256 = hash(`index.html\0${hash("web")}\n`);
  const clientSha256 = hash(`dist/desktop-startup-capability.json\0${hash(capability)}\ndist/index.cjs\0${hash("client")}\n`);
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: "details-release", version: "2.0.0",
    webVersion: "2.1.0", clientVersion: "2.2.0", protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 101,
    platform: process.platform, arch: process.arch, keyId: "fixture", archiveSha256: hash(archive), archiveSize: archive.length,
    webSha256, clientSha256, packageSha256: hash(`client\0${clientSha256}\nweb\0${webSha256}\n`),
    files: [{ path: DESKTOP_STARTUP_CAPABILITY_PATH, size: Buffer.byteLength(capability), sha256: hash(capability) },
      { path: "client/dist/index.cjs", size: 6, sha256: hash("client") }, { path: "web/index.html", size: 3, sha256: hash("web") }],
    createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, keys.privateKey);
  const { signature: _signature, ...manifestPayload } = manifest;
  const baselineDir = path.join(root, "baseline");
  await fs.cp(incoming, baselineDir, { recursive: true });
  const baseline = signReleaseBundleManifest({ ...manifestPayload, releaseId: "baseline-release", version: "1.2.0",
    webVersion: "1.2.0", clientVersion: "1.2.0" }, keys.privateKey);
  await fs.writeFile(path.join(baselineDir, "baseline-release-manifest.json"), JSON.stringify(baseline), "utf8");
  await fs.writeFile(path.join(incoming, "manifest.json"), JSON.stringify(manifest), "utf8");
  const alternative = signReleaseBundleManifest({ ...manifestPayload, releaseId: "other-release" }, keys.privateKey);
  const control = { available: true, authorized: true, busy: false, badSignature: false,
    failWeb: 0, failReceipt: "", failDiscovery: false, transientFailures: 0, useAlternative: false, failArchive: false,
    transientReceipts: 0, holdHealthy: undefined as (() => Promise<void>) | undefined,
    holdArchive: undefined as (() => Promise<void>) | undefined };
  const requests: string[] = [], actions: string[] = [], serverErrors: unknown[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const meta = readDesktopDeviceHeaders(request.rawHeaders);
      requests.push(request.url!); response.setHeader("content-type", "application/json");
      if (request.url!.endsWith("/devices/register")) response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId,
        publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      else if (request.url!.includes("release-availability") || request.url === "/api/software/desktop/update-availability") {
        if (control.transientFailures > 0) { control.transientFailures--; response.writeHead(503, { "retry-after": "0" }); response.end("{}"); return; }
        if (control.failDiscovery) { response.writeHead(403); response.end("{}"); return; }
        const resource = { available: control.available, ...(control.available ? { manifest: control.badSignature ? { ...manifest, signature: `${"A".repeat(86)}==` }
          : control.useAlternative ? alternative : manifest } : {}) };
        response.end(JSON.stringify(request.url === "/api/software/desktop/update-availability"
          ? { ok: true, deviceId: identity.deviceId, requestId: meta.requestId, resource, shell: { available: false } }
          : { ok: true, deviceId: identity.deviceId, requestId: meta.requestId, ...resource }));
      } else if (request.url!.endsWith("/archive")) {
        if (control.failArchive) { response.writeHead(403); response.end("{}"); return; }
        await control.holdArchive?.();
        response.writeHead(200, { etag: `"${manifest.archiveSha256}"`, "content-length": archive.length }); response.end(archive);
      } else if (request.url!.endsWith("/switch-authorization")) response.end(JSON.stringify({ ok: true, authorized: control.authorized,
        deviceId: identity.deviceId, requestId: meta.requestId, releaseId: manifest.releaseId,
        ...(control.authorized ? { archiveSha256: manifest.archiveSha256 } : {}) }));
      else {
        const record = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (request.url!.endsWith("/update-receipts")) {
          if (record.stage === "healthy") {
            await control.holdHealthy?.();
            if (control.transientReceipts > 0) { control.transientReceipts--; response.writeHead(503, { "retry-after": "0" }); response.end("{}"); return; }
          }
          if (record.stage === control.failReceipt) { response.writeHead(403); response.end("{}"); return; }
          response.end(JSON.stringify({ ok: true, deviceId: record.deviceId, requestId: record.requestId, releaseId: record.releaseId,
            archiveSha256: record.archiveSha256, stage: record.stage, at: record.at, payloadSha256: record.payloadSha256 }));
        } else response.end(JSON.stringify({ ok: true, deviceId: record.deviceId, errorId: record.errorId, payloadSha256: record.payloadSha256 }));
      }
    })().catch(error => { serverErrors.push(error); response.destroy(error as Error); });
  });
  if (network) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const window = Object.assign(new EventEmitter(), { show() {}, focus() {}, hide() {}, destroy() {} });
  let bridge!: DesktopBridgeApi, candidateWebAttempted = false;
  const host: DesktopHost = { createWindow: () => window, createTray: () => ({ destroy() {} }), quit() {},
    registerBridge(value) { bridge = value; return () => {}; },
    /** 只在候选加载及其恢复阶段注入故障，不阻断启动前的基线页面。 */
    async loadWeb(_window, releaseDir) {
      if (releaseDir.endsWith(manifest.releaseId)) candidateWebAttempted = true;
      if (candidateWebAttempted && control.failWeb > 0) { control.failWeb--; throw new Error("WEB_LOAD_FAILED"); }
    },
    onUpdateError() {}, onUpdateRetry() {} };
  /** 保留更新协议和 held 启动事实，版本随真实选中的整组清单变化。 */
  const createRuntime = (_entry: string, expected?: ClientRuntimeExpectation, startup?: DesktopStartupMode): ClientRuntime => ({
    async start() {}, async waitReady() {}, async stop() {}, async drain() { actions.push("drain"); }, onEvent: () => () => {},
    /** 启动放行返回严格确认，更新准备另返回活动会话事实。 */
    async request(request) { actions.push(request.method); return { status: 200,
      body: request.method === "runtime.startup.continue" ? { ok: true } : { ok: true, hasRunningSessions: control.busy } }; },
    snapshot: () => ({ status: "ready", requestId: null, releaseId: expected?.releaseId ?? null, errorCode: null, pid: 123,
      health: { protocolVersion: 1, clientVersion: expected?.clientVersion ?? "1.2.0", dbSchemaVersion: 101, database: "ready" },
      ...(startup?.mode === "held" ? { startup: { continuationId: startup.continuationId, admission: "paused" as const } } : {}) }) });
  const applicationInput = { dataDir: root, initialReleaseDir: baselineDir, shellVersion: "3.0.0", host, createRuntime,
    trustedReleaseKeys: { fixture: keys.publicKey },
    ...(network ? { configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` } : {}) };
  let app = createDesktopApplication(applicationInput);
  if (start) await app.start();
  t.after(async () => {
    try { if (start) await app.exit(); }
    finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(serverErrors, []);
  });
  return { get app() { return app; }, get bridge() { return bridge; }, root, incoming, manifest, control, requests, actions,
    /** 新宿主重新沿原启动入口读取活动版本，不沿用旧观察。 */
    async restart() { await app.exit(); app = createDesktopApplication(applicationInput); await app.start(); } };
}

/** 先证明能力存在，RED须来自缺产品能力而非 undefined 调用。 */
function details(target: unknown): () => Promise<DesktopUpdateDetails> {
  const method = (target as { getUpdateDetails?: () => Promise<DesktopUpdateDetails> }).getUpdateDetails;
  assert.equal(typeof method, "function", "fixed getUpdateDetails capability is required"); return method!;
}

test("details keeps unknown facts honest and reads a detached memory snapshot without IO", async t => {
  const f = await fixture(t, false), get = details(f.bridge), before = await fs.readdir(f.root);
  const snapshot = await get();
  assert.deepEqual(snapshot.current, { shellVersion: "3.0.0", bundle: null, clientVersion: "1.2.0" });
  assert.equal(snapshot.bundle.result, "unknown"); assert.equal(snapshot.shell.result, "unknown");
  assert.equal(snapshot.bundle.target, null); assert.equal(snapshot.shell.phase, null);
  snapshot.current.clientVersion = "mutated";
  const read = t.mock.method(fs, "readFile", async () => { throw new Error("DETAILS_MUST_NOT_READ_FILES"); });
  try { assert.equal((await get()).current.clientVersion, "1.2.0"); } finally { read.mock.restore(); }
  assert.deepEqual(await fs.readdir(f.root), before); assert.deepEqual(f.requests, []); assert.deepEqual(f.actions, []);
});

test("details rejects identity-not-ready instead of inventing an empty result", async t => {
  const f = await fixture(t, false, false);
  await assert.rejects(details(f.app)(), error => error instanceof Error && error.message === "DESKTOP_UPDATE_DETAILS_FAILED");
});

test("only explicit available false proves no package and a later failed check cannot retain it", async t => {
  const f = await fixture(t), get = details(f.bridge); f.control.available = false;
  await f.app.checkForUpdates(); assert.equal((await get()).bundle.result, "none");
  f.control.failDiscovery = true; await assert.rejects(f.app.checkForUpdates());
  assert.equal((await get()).bundle.result, "failure"); assert.equal((await get()).bundle.target, null);
});

test("verified target stays prepared until restart and healthy differs from same version", async t => {
  const f = await fixture(t), get = details(f.bridge);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.control.holdArchive = async () => { entered(); await gate; };
  const checking = f.app.checkForUpdates(); await waiting;
  try {
    const active = await get(); assert.equal(active.bundle.phase, "download"); assert.equal(active.bundle.result, "unknown");
    assert.deepEqual(active.bundle.target, { releaseId: "details-release", version: "2.0.0", webVersion: "2.1.0", clientVersion: "2.2.0" });
  } finally { release(); }
  await checking;
  const prepared = await get(); assert.equal(prepared.bundle.result, "prepared");
  assert.equal(prepared.current.bundle, null); assert.equal(prepared.current.clientVersion, "1.2.0");
  assert.deepEqual(f.actions, []);
  await f.restart(); const healthy = await details(f.bridge)(); assert.equal(healthy.bundle.result, "healthy");
  assert.deepEqual(healthy.current.bundle, healthy.bundle.target); assert.equal(healthy.current.clientVersion, "2.2.0");
  await f.app.checkForUpdates(); assert.equal((await details(f.bridge)()).bundle.result, "same");
});

test("untrusted manifest never becomes a visible target", async t => {
  const f = await fixture(t), get = details(f.bridge); f.control.badSignature = true;
  await assert.rejects(f.app.checkForUpdates()); const value = await get();
  assert.equal(value.bundle.target, null); assert.equal(value.bundle.result, "failure");
  assert.equal(value.bundle.phase, "verify");
  assert.ok(value.bundle.failure); assert.equal(JSON.stringify(value).includes("signature"), false);
});

for (const revoked of [false, true]) test(`${revoked ? "startup revocation" : "direct apply completion without confirmation"} is explicit after preparation`, async t => {
  const f = await fixture(t), get = details(f.bridge); f.control.busy = !revoked;
  f.control.authorized = !revoked;
  assert.equal(await f.app.checkForUpdates(), null);
  assert.equal((await get()).bundle.result, "prepared"); assert.deepEqual(f.actions, []);
  assert.equal((await get()).current.bundle, null);
  if (revoked) {
    await f.restart(); const value = await details(f.bridge)();
    assert.equal(value.bundle.result, "revoked"); assert.equal(value.current.bundle?.releaseId, "baseline-release");
    assert.equal(value.current.clientVersion, "1.2.0");
  } else {
    assert.equal((await f.app.applyRelease(f.incoming, { requestId: crypto.randomUUID() }))?.releaseId, "details-release");
    assert.equal((await get()).bundle.result, "healthy"); assert.equal((await get()).current.bundle?.releaseId, "details-release");
  }
});

for (const failWeb of [1, 2]) test(`${failWeb === 1 ? "restored" : "unavailable"} follows actual whole bundle rollback`, async t => {
  const f = await fixture(t); f.control.failWeb = failWeb;
  await f.app.checkForUpdates(); assert.equal((await details(f.bridge)()).bundle.result, "prepared");
  if (failWeb === 1) await f.restart(); else await assert.rejects(f.restart());
  const value = await details(f.bridge)(); assert.equal(value.bundle.result, failWeb === 1 ? "restored" : "unavailable");
  assert.equal(value.current.bundle?.releaseId, "baseline-release"); assert.equal(value.current.clientVersion, "1.2.0");
  assert.ok(value.bundle.failure);
});

test("receipt delivery failure preserves already observed local healthy result", async t => {
  const f = await fixture(t); f.control.failReceipt = "healthy";
  await f.app.checkForUpdates(); assert.equal((await details(f.bridge)()).bundle.result, "prepared");
  await f.restart(); await assert.rejects(f.app.flushReceipts()); const value = await details(f.bridge)();
  assert.equal(value.bundle.result, "healthy"); assert.equal(value.current.bundle?.releaseId, "details-release");
  assert.equal(value.bundle.failure, null);
  assert.ok((await f.bridge.getUpdateState!()).updateReceiptFailure);
});

test("exhausted retryable network budget requires manual action while a recovered retry does not", async t => {
  const f = await fixture(t), get = details(f.bridge); f.control.transientFailures = 4;
  await assert.rejects(f.app.checkForUpdates()); assert.equal((await get()).bundle.result, "manual_required");
  f.control.transientFailures = 3; await f.app.checkForUpdates(); assert.equal((await get()).bundle.result, "prepared");
  await f.restart(); assert.equal((await details(f.bridge)()).bundle.result, "healthy");
});

test("new host keeps verified current version but cannot promote prior journal history into a live attempt", async t => {
  const f = await fixture(t); await f.app.checkForUpdates(); await f.restart();
  assert.equal((await details(f.bridge)()).bundle.result, "healthy");
  await f.restart();
  const value = await details(f.bridge)();
  assert.equal(value.current.bundle?.releaseId, "details-release"); assert.equal(value.current.clientVersion, "2.2.0");
  assert.equal(value.bundle.result, "unknown"); assert.equal(value.bundle.requestId, null); assert.equal(value.bundle.target, null);
  assert.equal(value.shell.result, "unknown");
});

test("ordinary exit marks an interrupted download cancelled instead of failure or no package", async t => {
  const f = await fixture(t), get = details(f.bridge);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.control.holdArchive = async () => { entered(); await gate; };
  const checking = f.app.checkForUpdates(); await waiting;
  const rejected = assert.rejects(checking);
  try { await f.app.exit(); await rejected; } finally { release(); }
  assert.equal((await get()).bundle.result, "cancelled"); assert.equal((await get()).bundle.failure, null);
});

test("new verified target clears an older retained authorization revocation before its download can fail", async t => {
  const f = await fixture(t);
  await f.app.checkForUpdates(); f.control.authorized = false; await f.restart();
  const get = details(f.bridge); assert.equal((await get()).bundle.result, "revoked");
  f.control.useAlternative = true; f.control.failArchive = true;
  await assert.rejects(f.app.checkForUpdates());
  assert.equal((await get()).bundle.target?.releaseId, "other-release"); assert.equal((await get()).bundle.result, "failure");
});

test("local healthy version is visible while its startup ACK is pending and its failure cannot replace it", async t => {
  const f = await fixture(t); let release!: () => void, entered!: () => void;
  await f.app.checkForUpdates(); assert.equal((await details(f.bridge)()).bundle.result, "prepared");
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.control.holdHealthy = async () => { entered(); await gate; }; f.control.transientReceipts = 1;
  await f.restart(); const flushing = f.app.flushReceipts(); await waiting;
  try { const value = await details(f.bridge)(); assert.equal(value.bundle.result, "healthy"); assert.equal(value.current.bundle?.releaseId, "details-release"); }
  finally { release(); }
  await assert.rejects(flushing); const value = await details(f.bridge)();
  assert.equal(value.bundle.result, "healthy"); assert.equal(value.bundle.failure, null);
  assert.ok((await f.bridge.getUpdateState!()).updateReceiptFailure);
});

test("direct apply observes its own verified target and current version before healthy ACK settles", async t => {
  const f = await fixture(t), get = details(f.bridge); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.control.holdHealthy = async () => { entered(); await gate; };
  const installing = f.app.applyRelease(f.incoming, { requestId: crypto.randomUUID() }); await waiting;
  try {
    const value = await get(); assert.equal(value.bundle.result, "healthy"); assert.equal(value.bundle.target?.releaseId, "details-release");
    assert.equal(value.current.bundle?.releaseId, "details-release"); assert.equal(value.current.clientVersion, "2.2.0");
  } finally { release(); await installing; }
});
