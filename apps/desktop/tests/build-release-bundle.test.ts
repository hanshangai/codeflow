import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyReleaseBundleSignature } from "@codeflowai/shared/desktop-release-signing";
import { createReleaseBundleCoordinator } from "../src/releaseBundleCoordinator.js";
// @ts-expect-error Build scripts are native ESM and execute under the same Node loader as production.
import { buildReleaseBundle } from "../scripts/build-release-bundle.mjs";
// @ts-expect-error Build scripts are native ESM and execute under the same Node loader as production.
import { runTar } from "../scripts/tar.mjs";

/** 全部资源与签名密钥均为临时样本，不接触当前 dist 或真实安装。 */
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-release-build-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resourcesDir = path.join(root, "resources");
  await fs.mkdir(path.join(resourcesDir, "web", "assets"), { recursive: true });
  await fs.mkdir(path.join(resourcesDir, "client", "dist"), { recursive: true });
  await fs.writeFile(path.join(resourcesDir, "web", "index.html"), "页面", "utf8");
  await fs.writeFile(path.join(resourcesDir, "web", "assets", "app.js"), "web", "utf8");
  await fs.writeFile(path.join(resourcesDir, "client", "dist", "index.cjs"), "client", "utf8");
  await fs.writeFile(path.join(resourcesDir, "client", "package.json"), '{"version":"1.9.0"}', "utf8");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(root, "fixture-private.pem");
  await fs.writeFile(privateKeyFile, privateKey.export({ format: "pem", type: "pkcs8" }));
  const metadata = { releaseId: "fixture-release", version: "2.0.0", webVersion: "2.1.0", clientVersion: "1.9.0",
    protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 88, platform: process.platform, arch: process.arch,
    createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2099-10-24T00:00:00.000Z", keyId: "fixture" };
  return { root, resourcesDir, privateKeyFile, publicKey, metadata, outputDir: path.join(root, "bundle") };
}

test("local builder signs one external manifest and archives only the complete web/client payload", async t => {
  const f = await fixture(t);
  const result = await buildReleaseBundle(f);
  const manifestBytes = await fs.readFile(path.join(f.outputDir, "manifest.json"));
  const manifest = verifyReleaseBundleSignature(JSON.parse(manifestBytes.toString("utf8")), { fixture: f.publicKey });
  assert.equal(result.manifest.releaseId, manifest.releaseId);
  const archive = await fs.readFile(path.join(f.outputDir, "bundle.tar.gz"));
  assert.equal(manifest.archiveSize, archive.byteLength);
  assert.equal(manifest.archiveSha256, crypto.createHash("sha256").update(archive).digest("hex"));
  const entries: string[] = runTar(["-tzf", path.join(f.outputDir, "bundle.tar.gz")], { encoding: "utf8" }).trim().split(/\r?\n/);
  assert.ok(entries.every(entry => /^(web|client)(\/|$)/.test(entry)));
  assert.ok(!entries.includes("manifest.json"));
  assert.ok(!entries.some(entry => entry.includes("fixture-private")));
  assert.deepEqual(manifest.files.map(file => [file.path, file.size]), [["client/dist/index.cjs", 6], ["client/package.json", 19], ["web/assets/app.js", 3], ["web/index.html", 6]]);
  const coordinator = createReleaseBundleCoordinator({ rootDir: path.join(f.root, "runtime"), trustedReleaseKeys: { fixture: f.publicKey },
    getFailureContext: () => ({ deviceId: "868683b1-e79b-4509-9ca1-97b7786e5344", shellVersion: "1", currentReleaseId: "installation", webVersion: "1", clientVersion: "1" }) });
  const prepared = await coordinator.prepare(f.outputDir);
  assert.deepEqual((await fs.readdir(prepared.stagingDir)).sort(), ["client", "manifest.json", "web"]);
  assert.deepEqual(await fs.readFile(path.join(prepared.stagingDir, "manifest.json")), manifestBytes);
  await fs.appendFile(path.join(f.outputDir, "bundle.tar.gz"), "corrupt");
  await assert.rejects(() => coordinator.prepare(f.outputDir), /ARCHIVE_MISMATCH/);
});

test("builder explicitly rejects missing payloads and refuses to overwrite output", async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.resourcesDir, "client", "dist", "index.cjs"));
  await assert.rejects(() => buildReleaseBundle(f), /files.entries|ENOENT/);
  await assert.rejects(() => fs.access(f.outputDir), { code: "ENOENT" });
  await fs.writeFile(path.join(f.resourcesDir, "client", "dist", "index.cjs"), "client", "utf8");
  await fs.mkdir(f.outputDir);
  await assert.rejects(() => buildReleaseBundle(f), /OUTPUT_EXISTS/);
});

test("standalone build CLI uses explicit metadata and key files without exposing key material", async t => {
  const f = await fixture(t);
  const metadataFile = path.join(f.root, "metadata.json");
  await fs.writeFile(metadataFile, JSON.stringify(f.metadata), "utf8");
  const result = execFileSync(process.execPath, ["--conditions=development", "--import", "tsx", "scripts/build-release-bundle.mjs",
    f.resourcesDir, f.outputDir, metadataFile, f.privateKeyFile], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(result, "");
  assert.equal(verifyReleaseBundleSignature(JSON.parse(await fs.readFile(path.join(f.outputDir, "manifest.json"), "utf8")), { fixture: f.publicKey }).version, "2.0.0");
});

test("builder never packages its explicit private key file", async t => {
  const f = await fixture(t);
  const privateKeyFile = path.join(f.resourcesDir, "client", "signing-key.pem");
  await fs.copyFile(f.privateKeyFile, privateKeyFile);
  await assert.rejects(() => buildReleaseBundle({ ...f, privateKeyFile }), /PRIVATE_KEY_INSIDE_RESOURCES/);
});

test("builder inventories the capability marker while ignoring external baseline proof", async t => {
  const f = await fixture(t), markerPath = "client/dist/desktop-startup-capability.json";
  const marker = Buffer.from(JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1,
    clientEntrySha256: crypto.createHash("sha256").update("client").digest("hex") }), "utf8");
  await fs.writeFile(path.join(f.resourcesDir, markerPath), marker);
  await fs.writeFile(path.join(f.resourcesDir, "baseline-release-manifest.json"), "external proof", "utf8");
  const result = await buildReleaseBundle(f);
  assert.deepEqual(result.manifest.files.find((file: { path: string }) => file.path === markerPath),
    { path: markerPath, size: marker.byteLength, sha256: crypto.createHash("sha256").update(marker).digest("hex") });
  assert.ok(result.manifest.files.every((file: { path: string }) => file.path !== "baseline-release-manifest.json"));
  const entries: string[] = runTar(["-tzf", path.join(f.outputDir, "bundle.tar.gz")], { encoding: "utf8" }).trim().split(/\r?\n/);
  assert.ok(!entries.includes("baseline-release-manifest.json"));
});
