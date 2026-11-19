import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { DESKTOP_STARTUP_CAPABILITY_PATH } from "@codeflowai/shared";
import { readReleaseBundleFiles, computeReleaseDirectorySha256, computeReleasePackageSha256, signReleaseBundleManifest, verifyReleaseBundlePayload } from "@codeflowai/shared/desktop-release-signing";

/** 真实签名和 builder 复制器复现其隐式排除；所有文件仅在独占临时目录。 */
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "packaged-resource-copy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), destination = path.join(root, "destination");
  const contents = { "client/dist/index.cjs": "client", "client/node_modules/undici/lib/llhttp/.gitkeep": "",
    "client/node_modules/runtime/.DS_Store": "signed metadata", "client/node_modules/runtime/.runtime": "hidden runtime",
    "web/index.html": "web", [DESKTOP_STARTUP_CAPABILITY_PATH]: JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1,
      clientEntrySha256: crypto.createHash("sha256").update("client").digest("hex") }) };
  for (const [relative, bytes] of Object.entries(contents)) {
    await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await fs.writeFile(path.join(source, relative), bytes, "utf8");
  }
  const keys = crypto.generateKeyPairSync("ed25519");
  const files = await readReleaseBundleFiles(source);
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: "packaged-resources", version: "1.0.0", webVersion: "1.0.0", clientVersion: "1.0.0",
    protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 103, platform: "win32", arch: "x64", keyId: "fixture", files,
    webSha256: computeReleaseDirectorySha256(files, "web"), clientSha256: computeReleaseDirectorySha256(files, "client"),
    packageSha256: computeReleasePackageSha256(computeReleaseDirectorySha256(files, "web"), computeReleaseDirectorySha256(files, "client")), archiveSha256: "a".repeat(64), archiveSize: 1,
    createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, keys.privateKey);
  await fs.writeFile(path.join(source, "baseline-release-manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(source, "release-trust.json"), JSON.stringify({ fixture: keys.publicKey.export({ type: "spki", format: "pem" }) }));
  const require = createRequire(import.meta.url);
  const builder = createRequire(createRequire(require.resolve("electron-builder")).resolve("app-builder-lib"));
  const { FileMatcher, copyFiles } = builder("./fileMatcher.js");
  await fs.mkdir(destination);
  await copyFiles([new FileMatcher(source, destination, (value: string) => value, ["**/*"])]);
  assert.equal(await fs.readFile(path.join(destination, "client/node_modules/runtime/.runtime"), "utf8"), "hidden runtime");
  await assert.rejects(fs.access(path.join(destination, "client/node_modules/undici/lib/llhttp/.gitkeep")), { code: "ENOENT" });
  return { root, source, destination, manifest, keys };
}

test("packaging preserves builder-excluded signed files and validates the complete real payload", async t => {
  const f = await fixture(t);
  const module = await import("../scripts/packaged-resource-copy.mjs");
  await module.completePackagedResources({ source: f.source, destination: f.destination, platform: "win32", arch: "x64" });
  assert.equal(await fs.readFile(path.join(f.destination, "client/node_modules/undici/lib/llhttp/.gitkeep"), "utf8"), "");
  assert.equal(await fs.readFile(path.join(f.destination, "client/node_modules/runtime/.DS_Store"), "utf8"), "signed metadata");
  await verifyReleaseBundlePayload({ directory: f.destination, manifest: f.manifest, trustedKeys: { fixture: f.keys.publicKey }, platform: "win32", arch: "x64", requireHeldStartup: true });
});

test("packaging rejects other missing or changed payload files rather than reporting success", async t => {
  const f = await fixture(t), module = await import("../scripts/packaged-resource-copy.mjs");
  await fs.unlink(path.join(f.destination, "web/index.html"));
  await assert.rejects(module.completePackagedResources({ source: f.source, destination: f.destination, platform: "win32", arch: "x64" }));
  await fs.writeFile(path.join(f.destination, "web/index.html"), "tampered");
  await assert.rejects(module.completePackagedResources({ source: f.source, destination: f.destination, platform: "win32", arch: "x64" }));
});

for (const change of ["existing-dotfile", "link", "trust", "manifest", "source"] as const) test(`packaging refuses ${change} without rewriting untrusted output`, async t => {
  const f = await fixture(t), module = await import("../scripts/packaged-resource-copy.mjs");
  const dotfile = path.join(f.destination, "client/node_modules/undici/lib/llhttp/.gitkeep");
  await fs.mkdir(path.dirname(dotfile), { recursive: true });
  if (change === "existing-dotfile") await fs.writeFile(dotfile, "untrusted output");
  if (change === "link") await fs.symlink(path.join(f.source, "client/node_modules/undici/lib/llhttp"), path.join(f.destination, "client/linked"), process.platform === "win32" ? "junction" : "dir");
  if (change === "trust") await fs.writeFile(path.join(f.destination, "release-trust.json"), "{}");
  if (change === "manifest") await fs.writeFile(path.join(f.destination, "baseline-release-manifest.json"), "{}");
  if (change === "source") await fs.writeFile(path.join(f.source, "client/node_modules/undici/lib/llhttp/.gitkeep"), "source changed after signing");
  await assert.rejects(module.completePackagedResources({ source: f.source, destination: f.destination, platform: "win32", arch: "x64" }));
  if (change === "existing-dotfile") assert.equal(await fs.readFile(dotfile, "utf8"), "untrusted output");
});
