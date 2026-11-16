import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { downloadReleaseBundle } from "../src/releaseBundleDownload.js";
import { createDesktopUpdateTransport } from "../src/updateTransport.js";
// @ts-expect-error Test support is native ESM executed under the same Node loader as production.
import { startMockUpdateServer } from "./support/mock-update-server.mjs";
// @ts-expect-error Test support is native ESM executed under the same Node loader as production.
import { buildSignedRelease, createReleaseSigningKey } from "./support/release-artifacts.mjs";
// @ts-expect-error The real packaged smoke is native ESM and only its preflight runs here.
import { preflightUpdate } from "./electron-packaged-update.smoke.mjs";

const REGISTER_PATH = "/api/software/desktop/devices/register";
const RELEASE_PATH = "/api/software/desktop/release";

/** 预检使用真实签名归档和外置占位工件，不启动 Electron 或写验收目录。 */
async function packagedPreflightFixture(t: test.TestContext, badSchema = 98) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-update-preflight-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = createReleaseSigningKey(), resources = path.join(root, "artifact/resources");
  for (const file of ["../CodeFlowAI.exe", "app.asar", "client/dist/index.cjs", "web/index.html"]) {
    await fs.mkdir(path.dirname(path.join(resources, file)), { recursive: true });
    await fs.writeFile(path.join(resources, file), "preflight placeholder", "utf8");
  }
  await fs.writeFile(path.join(resources, "release-trust.json"), JSON.stringify({ [key.keyId]: key.publicKeyPem }), "utf8");
  const bundles = [];
  for (const [name, dbSchemaVersion] of [["good", 98], ["bad", badSchema]] as const) {
    const workDir = path.join(root, name); await fs.mkdir(workDir);
    const bundle = await buildSignedRelease({ workDir, key, dbSchemaVersion, releaseId: `preflight-${name}` });
    bundles.push(bundle.outputDir);
  }
  const output = path.join(root, "evidence"), args = [path.join(root, "artifact/CodeFlowAI.exe"), ...bundles, output];
  return { args, output, badManifest: path.join(bundles[1]!, "manifest.json") };
}

test("packaged update preflight derives schema98 from installed-trust verified bundles", { skip: process.platform !== "win32" }, async t => {
  const f = await packagedPreflightFixture(t);
  const result = await preflightUpdate(f.args);
  assert.equal(result.dbSchemaVersion, 98);
  await assert.rejects(fs.access(f.output), { code: "ENOENT" });
});

test("packaged update preflight accepts an isolated postpone scenario", { skip: process.platform !== "win32" }, async t => {
  const f = await packagedPreflightFixture(t);
  assert.equal((await preflightUpdate([...f.args, "--postpone"])).mode, "--postpone");
});

test("packaged update preflight rejects different signed schemas before creating output", { skip: process.platform !== "win32" }, async t => {
  const f = await packagedPreflightFixture(t, 99);
  await assert.rejects(preflightUpdate(f.args), /DESKTOP_PACKAGED_UPDATE_SCHEMA_MISMATCH/);
  await assert.rejects(fs.access(f.output), { code: "ENOENT" });
});

test("packaged update preflight cannot obtain schema from a tampered manifest", { skip: process.platform !== "win32" }, async t => {
  const f = await packagedPreflightFixture(t);
  const manifest = JSON.parse(await fs.readFile(f.badManifest, "utf8"));
  manifest.dbSchemaVersion = 99;
  await fs.writeFile(f.badManifest, JSON.stringify(manifest), "utf8");
  await assert.rejects(preflightUpdate(f.args), /DESKTOP_RELEASE_SIGNATURE_INVALID/);
  await assert.rejects(fs.access(f.output), { code: "ENOENT" });
});

/** 每个用例独占临时根；失败也关闭 mock Server 并清理，避免端口与文件残留。 */
async function fixture(t: test.TestContext, options: { expired?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-update-harness-"));
  const key = createReleaseSigningKey();
  const release = await buildSignedRelease({
    workDir: root,
    key,
    now: options.expired ? Date.now() - 48 * 60 * 60 * 1000 : Date.now(),
    ttlMs: 24 * 60 * 60 * 1000,
  });
  const server = await startMockUpdateServer({ manifest: release.manifestBytes, archive: release.archive });
  t.after(async () => {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, "desktop-data");
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const transport = createDesktopUpdateTransport({ dataDir, identity, configuredServerOrigin: server.origin });
  const runtimeDir = path.join(root, "runtime");
  const archivePath = `/api/software/desktop/releases/${release.manifest.releaseId}/archive`;
  return { root, key, release, server, identity, transport, runtimeDir, archivePath };
}

/** 通过真实签名与真实 HTTP 传输下载一次完整发布包。 */
async function download(input: Awaited<ReturnType<typeof fixture>>, trustedReleaseKeys: Record<string, string>) {
  return await downloadReleaseBundle({
    rootDir: input.runtimeDir,
    manifestBytes: input.release.manifestBytes,
    archivePath: input.archivePath,
    transport: input.transport,
    trustedReleaseKeys,
    platform: "win32",
    arch: "x64",
  });
}

test("downloads a signed release through the mock update server", async (t) => {
  const f = await fixture(t);
  await f.transport.register();

  const register = f.server.requestsFor(REGISTER_PATH)[0];
  assert.ok(register, "device registration must be requested");
  assert.equal(register!.headers["x-codeflow-device-auth"], "v1");
  assert.equal(register!.headers["x-codeflow-device-id"], f.identity.deviceId);
  assert.match(String(register!.headers["x-codeflow-signature"]), /^[A-Za-z0-9+/]{86}==$/u);

  const manifestResponse = await f.transport.request({ method: "GET", path: RELEASE_PATH });
  assert.deepEqual(new Uint8Array(await manifestResponse.arrayBuffer()), f.release.manifestBytes);

  const downloaded = await download(f, { [f.key.keyId]: f.key.publicKeyPem });
  assert.equal(downloaded.manifest.releaseId, f.release.manifest.releaseId);
  assert.deepEqual(new Uint8Array(await fs.readFile(downloaded.archivePath)), new Uint8Array(f.release.archive));

  const archiveRequest = f.server.requestsFor(f.archivePath)[0];
  assert.ok(archiveRequest, "archive must be requested exactly once");
  assert.equal(archiveRequest!.headers["if-match"], `"${f.release.manifest.archiveSha256}"`);
  assert.equal(archiveRequest!.headers.range, undefined);
});

test("rejects an invalid signature before requesting the archive", async (t) => {
  const f = await fixture(t);
  const other = createReleaseSigningKey();
  await assert.rejects(
    () => download(f, { [f.key.keyId]: other.publicKeyPem }),
    (error: { code?: string }) => error.code === "DESKTOP_RELEASE_SIGNATURE_INVALID",
  );
  assert.equal(f.server.requestsFor(f.archivePath).length, 0);
});

test("rejects an expired release before requesting the archive", async (t) => {
  const f = await fixture(t, { expired: true });
  await assert.rejects(
    () => download(f, { [f.key.keyId]: f.key.publicKeyPem }),
    (error: { code?: string }) => error.code === "DESKTOP_RELEASE_EXPIRED",
  );
  assert.equal(f.server.requestsFor(f.archivePath).length, 0);
});

test("resumes a partial archive from the recorded offset", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.runtimeDir, ".staging", `download-${crypto.createHash("sha256").update(f.release.manifestBytes).digest("hex")}`);
  await fs.mkdir(directory, { recursive: true });
  const prefix = f.release.archive.subarray(0, 64);
  // 续传必须同时有绑定清单与部分归档；缺清单的孤立分片会被下载器判为缓存冲突。
  await fs.writeFile(path.join(directory, "manifest.json"), f.release.manifestBytes);
  await fs.writeFile(path.join(directory, "bundle.tar.gz.part"), prefix);

  const downloaded = await download(f, { [f.key.keyId]: f.key.publicKeyPem });
  assert.deepEqual(new Uint8Array(await fs.readFile(downloaded.archivePath)), new Uint8Array(f.release.archive));
  assert.equal(f.server.requestsFor(f.archivePath)[0]!.headers.range, `bytes=${prefix.byteLength}-`);
});

test("surfaces an injected HTTP failure instead of treating it as success", async (t) => {
  const f = await fixture(t);
  f.server.failNext(f.archivePath, { status: 503, body: { ok: false, code: "MOCK_UNAVAILABLE" } });
  await assert.rejects(
    () => download(f, { [f.key.keyId]: f.key.publicKeyPem }),
    (error: { code?: string; cause?: { code?: string; status?: number } }) =>
      error.code === "DESKTOP_RELEASE_DOWNLOAD_FAILED" && error.cause?.code === "MOCK_UNAVAILABLE" && error.cause?.status === 503,
  );
});

test("mock server acknowledges receipts and failures with the exact contract shape", async (t) => {
  const f = await fixture(t);
  const receipt = {
    deviceId: f.identity.deviceId,
    requestId: crypto.randomUUID(),
    releaseId: f.release.manifest.releaseId,
    archiveSha256: f.release.manifest.archiveSha256,
    stage: "received",
    at: new Date().toISOString(),
    payloadSha256: "0".repeat(64),
  };
  const receiptAck = await f.transport.requestJson({
    method: "POST",
    path: "/api/software/desktop/update-receipts",
    body: receipt,
    requestId: receipt.requestId,
  });
  assert.deepEqual(Object.keys(receiptAck).sort(), ["archiveSha256", "at", "deviceId", "ok", "payloadSha256", "releaseId", "requestId", "stage"]);

  const failure = { deviceId: f.identity.deviceId, errorId: crypto.randomUUID(), payloadSha256: "0".repeat(64) };
  const failureAck = await f.transport.requestJson({
    method: "POST",
    path: "/api/software/desktop/update-failures",
    body: failure,
    requestId: failure.errorId,
  });
  assert.deepEqual(Object.keys(failureAck).sort(), ["deviceId", "errorId", "ok", "payloadSha256"]);
});
