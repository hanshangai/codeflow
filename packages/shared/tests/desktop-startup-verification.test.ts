import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { signReleaseBundleManifest, readReleaseBundleFiles, computeReleaseDirectorySha256,
  computeReleasePackageSha256, verifyReleaseBundlePayload } from "../src/desktopReleaseSigning.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

/** 临时签名资源同时包含启动入口、迁移 worker 与不在启动核验范围的依赖。 */
async function fixture(t: test.TestContext, held = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cf-startup-verification-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const file of ["client/dist/index.cjs", "client/dist/migration-worker.cjs", "client/package.json",
    "client/cli-runtime.json", "client/node_modules/example/index.js", "web/index.html"]) {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.writeFile(path.join(directory, file), file, "utf8");
  }
  if (held) await fs.writeFile(path.join(directory, "client/dist/desktop-startup-capability.json"), JSON.stringify({
    schemaVersion: 1, heldStartupProtocol: 1,
    clientEntrySha256: crypto.createHash("sha256").update("client/dist/index.cjs").digest("hex"),
  }), "utf8");
  const files = await readReleaseBundleFiles(directory);
  const webSha256 = computeReleaseDirectorySha256(files, "web"), clientSha256 = computeReleaseDirectorySha256(files, "client");
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: "startup-fixture", version: "1.0.0",
    webVersion: "1.0.0", clientVersion: "1.0.0", protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 88,
    platform: "win32", arch: "x64", webSha256, clientSha256, packageSha256: computeReleasePackageSha256(webSha256, clientSha256),
    files, archiveSha256: "f".repeat(64), archiveSize: 100, keyId: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, privateKey);
  return { directory, manifest, trustedKeys: { fixture: publicKey }, platform: "win32", arch: "x64" };
}

test("普通启动只核验核心文件；默认及新包核验仍覆盖依赖", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, "client/node_modules/example/index.js"), "changed", "utf8");
  assert.deepEqual(await verifyReleaseBundlePayload({ ...f, verification: "startup" }), f.manifest);
  await assert.rejects(verifyReleaseBundlePayload(f), /Client payload SHA-256/u);
  await assert.rejects(verifyReleaseBundlePayload({ ...f, verification: "startup", requireFresh: true }), /Client payload SHA-256/u);
});

test("已完整校验资源的 held 能力复核只读取核心，候选全量校验仍覆盖依赖", async t => {
  const f = await fixture(t, true);
  await verifyReleaseBundlePayload({ ...f, requireHeldStartup: true });
  const read = fs.readFile.bind(fs), reads: string[] = [];
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    reads.push(String(args[0]));
    return await read(...args);
  });
  await verifyReleaseBundlePayload({ ...f, verification: "startup", requireHeldStartup: true });
  assert.equal(reads.some(file => file.includes("node_modules")), false);
  await fs.writeFile(path.join(f.directory, "client/node_modules/example/index.js"), "changed", "utf8");
  await assert.rejects(verifyReleaseBundlePayload({ ...f, requireHeldStartup: true }), /Client payload SHA-256/u);
});

test("held 核心复核拒绝重新签名但绑定错误入口的 marker", async t => {
  const f = await fixture(t, true);
  const marker = path.join(f.directory, "client/dist/desktop-startup-capability.json");
  await fs.writeFile(marker, JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: "0".repeat(64) }));
  const files = await readReleaseBundleFiles(f.directory);
  const webSha256 = computeReleaseDirectorySha256(files, "web"), clientSha256 = computeReleaseDirectorySha256(files, "client");
  const { signature: _signature, ...payload } = f.manifest;
  const manifest = signReleaseBundleManifest({ ...payload, files, webSha256, clientSha256,
    packageSha256: computeReleasePackageSha256(webSha256, clientSha256) }, privateKey);
  await assert.rejects(verifyReleaseBundlePayload({ ...f, manifest, verification: "startup", requireHeldStartup: true }), /CAPABILITY_ENTRY_MISMATCH/u);
});

for (const file of ["client/dist/index.cjs", "client/dist/migration-worker.cjs", "client/package.json", "client/cli-runtime.json", "web/index.html"]) {
  test(`启动校验拒绝损坏核心文件：${file}`, async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.directory, file), "changed", "utf8");
    await assert.rejects(verifyReleaseBundlePayload({ ...f, verification: "startup" }), /DESKTOP_RELEASE_STARTUP_FILE_MISMATCH/u);
  });
}

test("启动校验仍拒绝错误签名和平台，held 不能绕开能力门禁", async t => {
  const f = await fixture(t);
  await assert.rejects(verifyReleaseBundlePayload({ ...f, verification: "startup", manifest: { ...f.manifest, version: "changed" } }), /SIGNATURE_INVALID/u);
  await assert.rejects(verifyReleaseBundlePayload({ ...f, verification: "startup", arch: "arm64" }), /PLATFORM_MISMATCH/u);
  await assert.rejects(verifyReleaseBundlePayload({ ...f, verification: "startup", requireHeldStartup: true }), /CAPABILITY_REQUIRED/u);
});

test("启动校验拒绝核心入口父目录链接", async t => {
  const f = await fixture(t);
  const original = path.join(f.directory, "client/dist"), target = path.join(f.directory, "moved-dist");
  await fs.rename(original, target);
  await fs.symlink(target, original, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyReleaseBundlePayload({ ...f, verification: "startup" }), /DESKTOP_RELEASE_FILE_TYPE_INVALID/u);
});

for (const file of ["client/dist/legacyClientMigrationWorker.cjs", "client/cli-runtime-extra.json", "client/dist/nested/worker.cjs"]) {
  test(`启动校验拒绝核心目录未签名文件：${file}`, async t => {
    const f = await fixture(t);
    await fs.mkdir(path.dirname(path.join(f.directory, file)), { recursive: true });
    await fs.writeFile(path.join(f.directory, file), "extra", "utf8");
    await assert.rejects(verifyReleaseBundlePayload({ ...f, verification: "startup" }), /DESKTOP_RELEASE_STARTUP_FILES_MISMATCH/u);
  });
}
