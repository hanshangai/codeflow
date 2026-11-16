import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildReleaseBundle } from "../scripts/build-release-bundle.mjs";
import { prepareResourcePublication, verifyResourcePublication } from "../../../tools/release/desktop-publish.mjs";

/** 构造一个最小但可验签的 win32/x64 资源包。 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-resource-publication-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(root, "private.pem");
  const trustFile = path.join(root, "trust.json");
  const resources = path.join(root, "resources");
  const client = "client";
  const files = {
    "web/index.html": "web",
    "client/dist/index.cjs": client,
    "client/dist/desktop-startup-capability.json": JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1,
      clientEntrySha256: crypto.createHash("sha256").update(client).digest("hex") }),
    "client/desktop-runtime.json": JSON.stringify({ schemaVersion: 1, platform: "win32", arch: "x64", nodeMajor: 24, modules: "145" }),
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(resources, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
  }
  await fs.writeFile(privateKeyFile, keys.privateKey.export({ format: "pem", type: "pkcs8" }));
  await fs.writeFile(trustFile, JSON.stringify({ fixture: keys.publicKey.export({ format: "pem", type: "spki" }) }));
  const plan = { schemaVersion: 1, environment: "test", releaseId: "desktop-2026.11.11.01", version: "2026.11.11.01",
    webVersion: "2026.11.11.01", clientVersion: "2026.11.11.01", protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 103,
    platformSet: ["win32/x64"], sourceCommit: "0".repeat(40), keyId: "fixture",
    createdAt: "2026-11-11T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
  const bundle = await buildReleaseBundle({ resourcesDir: resources, outputDir: path.join(root, "bundle"), privateKeyFile,
    metadata: { releaseId: plan.releaseId, version: plan.version, webVersion: plan.webVersion, clientVersion: plan.clientVersion,
      protocolVersion: plan.protocolVersion, capabilityVersion: plan.capabilityVersion, dbSchemaVersion: plan.dbSchemaVersion,
      platform: "win32", arch: "x64", keyId: plan.keyId, createdAt: plan.createdAt, expiresAt: plan.expiresAt } });
  const artifactsRoot = path.join(root, "artifacts");
  const platformDir = path.join(artifactsRoot, "win32-x64", "bundle");
  await fs.mkdir(platformDir, { recursive: true });
  for (const name of ["manifest.json", "bundle.tar.gz"]) await fs.copyFile(path.join(bundle.outputDir, name), path.join(platformDir, name));
  return { root, plan, trustFile, artifactsRoot, outputDir: path.join(root, "publication") };
}

test("resource publication verifies both aggregation and recheck", async t => {
  const f = await fixture(t);
  const result = await prepareResourcePublication({ plan: f.plan, artifactsRoot: f.artifactsRoot, outputDir: f.outputDir, trustFile: f.trustFile });
  assert.deepEqual(result.publishInput.variants.map(item => `${item.platform}/${item.arch}`), ["win32/x64"]);
  assert.equal((await verifyResourcePublication({ outputDir: f.outputDir, trustFile: f.trustFile })).publishInput.releaseId, f.plan.releaseId);
  const artifactDir = path.join(f.outputDir, "artifacts", result.publishInput.variants[0].archiveSha256);
  const archiveFile = path.join(artifactDir, "bundle.tar.gz");
  const archive = await fs.readFile(archiveFile);
  await fs.appendFile(archiveFile, "tampered");
  await assert.rejects(() => verifyResourcePublication({ outputDir: f.outputDir, trustFile: f.trustFile }), /ARCHIVE_MISMATCH/u);
  await fs.writeFile(archiveFile, archive);
  const manifestFile = path.join(artifactDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.version = "2026.11.12.01";
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(() => verifyResourcePublication({ outputDir: f.outputDir, trustFile: f.trustFile }), /SIGNATURE_INVALID/u);
});

test("Server can verify publication with only shared and tar support, without a Desktop package", async t => {
  const f = await fixture(t);
  const isolated = path.join(f.root, "isolated");
  const sourceRoot = new URL("../../../", import.meta.url);
  for (const relative of ["tools/release/desktop-publish.mjs"]) {
    const destination = path.join(isolated, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(new URL(relative, sourceRoot), destination);
  }
  await fs.mkdir(path.join(isolated, "packages"), { recursive: true });
  await fs.symlink(path.resolve(import.meta.dirname, "../../../packages/shared"), path.join(isolated, "packages/shared"), "junction");
  await assert.rejects(fs.access(path.join(isolated, "apps/desktop/package.json")), { code: "ENOENT" });
  const verifier = await import(pathToFileURL(path.join(isolated, "tools/release/desktop-publish.mjs")).href);
  const prepared = await verifier.prepareResourcePublication({ plan: f.plan, artifactsRoot: f.artifactsRoot,
    outputDir: f.outputDir, trustFile: f.trustFile });
  const verified = await verifier.verifyResourcePublication({ outputDir: f.outputDir, trustFile: f.trustFile });
  assert.equal(verified.publishInput.releaseId, prepared.publishInput.releaseId);
});

test("local aggregation preserves paired origin evidence and rejects incomplete pairs", async t => {
  const f = await fixture(t);
  const source = path.join(f.artifactsRoot, "win32-x64/bundle");
  await fs.writeFile(path.join(source, "build-origin.json"), '{"buildId":"opaque-evidence"}');
  await assert.rejects(prepareResourcePublication({ plan: f.plan, artifactsRoot: f.artifactsRoot,
    outputDir: f.outputDir, trustFile: f.trustFile }), /DESKTOP_RESOURCE_ORIGIN_INCOMPLETE/);
  await fs.writeFile(path.join(source, "build-origin.sig.json"), '{"signature":"opaque-evidence"}');
  const result = await prepareResourcePublication({ plan: f.plan, artifactsRoot: f.artifactsRoot,
    outputDir: f.outputDir, trustFile: f.trustFile });
  const target = path.join(f.outputDir, "artifacts", result.publishInput.variants[0].archiveSha256);
  for (const file of ["build-origin.json", "build-origin.sig.json"]) {
    assert.deepEqual(await fs.readFile(path.join(target, file)), await fs.readFile(path.join(source, file)));
  }
});
