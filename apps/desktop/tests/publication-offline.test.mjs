import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as tar from "tar";
import { formatDesktopVersion } from "@codeflowai/shared";
import { signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import { prepareRelease } from "../scripts/prepare-release.mjs";
import { buildReleaseBundle } from "../scripts/build-release-bundle.mjs";
import { preparePublication, verifyPreparedPublication } from "../scripts/prepare-publication.mjs";
import { pathToFileURL } from "node:url";

/** 从真实候选生产者生成 Windows 工件，Mac 变体同样真实归档和签名。 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-publication-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync("ed25519"), resourcesDir = path.join(root, "resources"), desktopDir = path.join(root, "desktop");
  const privateKeyFile = path.join(root, "private.pem"), notesFile = path.join(root, "notes.md"), trustedKeysFile = path.join(root, "trust.json");
  const trust = JSON.stringify({ fixture: keys.publicKey.export({ type: "spki", format: "pem" }) });
  const source = "publication-client";
  const files = { "resources/web/index.html": "发布页面", "resources/client/dist/index.cjs": source,
    "resources/client/desktop-runtime.json": JSON.stringify({ schemaVersion: 1, platform: "win32", arch: "x64", nodeMajor: 24, modules: "145" }),
    "resources/client/dist/desktop-startup-capability.json": JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: crypto.createHash("sha256").update(source).digest("hex") }),
    "resources/release-trust.json": trust, "desktop/package.json": '{"version":"1.0"}', "desktop/electron-builder.yml": "productName: Fixture\n",
    "desktop/dist/main.js": "shell", "desktop/build/installer.nsh": "installer", "notes.md": "## 更新\n\n- 同候选发布。\n", "trust.json": trust };
  for (const [relative, bytes] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), bytes, "utf8"); }
  await fs.writeFile(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  const candidate = await prepareRelease({ resourcesDir, desktopDir, privateKeyFile, notesFile, outputRoot: path.join(root, "candidates"),
    now: new Date(2026, 10, 9, 12), baselineVersion: "2026.11.08.01", validateRuntime: async () => {},
    metadata: { webVersion: "2026.11.09.01", clientVersion: "2026.11.09.01", protocolVersion: 1, capabilityVersion: 1,
      dbSchemaVersion: 96, platform: "win32", arch: "x64", keyId: "fixture", expiresAt: "2099-01-01T00:00:00.000Z" },
    /** 外部 NSIS 构建替身，生成由候选记录核对的实际文件。 */
    packageInstaller: async ({ outputDir }) => { await fs.mkdir(outputDir); const installer = path.join(outputDir, "CodeFlow-1.0.exe"); await fs.writeFile(installer, "fixture-installer"); return { shellVersion: "1.0", displayVersion: formatDesktopVersion("1.0", "2026.11.09.01"), installer }; } });
  const additionalBundleDirs = [];
  for (const arch of ["x64", "arm64"]) {
    const outputDir = path.join(root, `darwin-${arch}`);
    await fs.writeFile(path.join(resourcesDir, "web/index.html"), `Mac ${arch}`, "utf8");
    await fs.writeFile(path.join(resourcesDir, "client/desktop-runtime.json"), JSON.stringify({ schemaVersion: 1, platform: "darwin", arch, nodeMajor: 24, modules: "145" }), "utf8");
    await buildReleaseBundle({ resourcesDir, outputDir, privateKeyFile, metadata: { ...candidate.metadata, platform: "darwin", arch }, requireHeldStartup: true });
    additionalBundleDirs.push(outputDir);
  }
  return { root, candidateDir: candidate.directory, candidate, additionalBundleDirs, trustedKeysFile, privateKeyFile, outputDir: path.join(root, "publication"), publishedAt: 1794211200000 };
}

test("one publication binds three signed variants, the exact installer and same candidate notes with stable retry time", async t => {
  const f = await fixture(t), result = await preparePublication(f);
  assert.equal(result.publishInput.releaseId, f.candidate.metadata.releaseId);
  assert.deepEqual(result.publishInput.variants.map(item => `${item.platform}/${item.arch}`), ["win32/x64", "darwin/x64", "darwin/arm64"]);
  assert.equal(result.publishInput.publishedAt, f.publishedAt);
  assert.equal(result.fullInstaller.releaseId, result.publishInput.releaseId);
  assert.equal(result.fullInstaller.fileName, "CodeFlowAI-1.0.1109-win32-x64.exe");
  assert.equal(result.fullInstaller.sha256, f.candidate.installer.sha256);
  assert.equal(await fs.readFile(path.join(f.outputDir, "release-notes", `${f.candidate.metadata.version}.md`), "utf8"), "## 更新\n\n- 同候选发布。\n");
  for (const variant of result.publishInput.variants) assert.ok((await fs.stat(path.join(f.outputDir, "artifacts", variant.archiveSha256, "bundle.tar.gz"))).isFile());
  const replay = await preparePublication({ ...f, publishedAt: undefined });
  assert.deepEqual(replay, result);
  await assert.rejects(preparePublication({ ...f, publishedAt: f.publishedAt + 1 }), /PUBLICATION_REPLAY_CONFLICT/);
  assert.deepEqual(await verifyPreparedPublication(f), result);
  const preparedCli = execFileSync(process.execPath, ["--conditions=development", "--import", "tsx", "scripts/prepare-publication.mjs", f.candidateDir,
    ...f.additionalBundleDirs, f.outputDir, f.trustedKeysFile], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.deepEqual(JSON.parse(preparedCli).publishInput, result.publishInput);

});

test("rechecks legacy internal-version installer names", async t => {
  const f = await fixture(t);
  const candidateFile = path.join(f.candidateDir, "candidate.json");
  const candidate = JSON.parse(await fs.readFile(candidateFile, "utf8"));
  candidate.shellVersion = "1.0.0";
  await fs.writeFile(candidateFile, JSON.stringify(candidate));
  const result = await preparePublication(f);
  const legacyName = `CodeFlowAI-${f.candidate.metadata.version}-win32-x64.exe`;
  const directory = path.join(f.outputDir, "installers", result.fullInstaller.sha256);
  await fs.rename(path.join(directory, result.fullInstaller.fileName), path.join(directory, legacyName));
  const legacy = { ...result.fullInstaller, fileName: legacyName };
  await fs.writeFile(path.join(f.outputDir, "full-installer.json"), JSON.stringify(legacy));
  assert.equal((await verifyPreparedPublication(f)).fullInstaller.fileName, legacyName);
  assert.equal((await preparePublication({ ...f, publishedAt: undefined })).fullInstaller.fileName, legacyName);
});

test("offline publication verifier loads only shared and the pure tool, without Desktop files", async t => {
  const f = await fixture(t);
  const prepared = await preparePublication(f);
  const isolated = path.join(f.root, "isolated");
  const sourceRoot = path.resolve(import.meta.dirname, "../../..");
  const tool = "tools/release/desktop-publication.mjs";
  await fs.mkdir(path.join(isolated, "tools/release"), { recursive: true });
  await fs.copyFile(path.join(sourceRoot, tool), path.join(isolated, tool));
  // 只挂载已独立安装和构建的 shared，不提供 Desktop 目录或 Electron。
  await fs.mkdir(path.join(isolated, "packages"), { recursive: true });
  await fs.symlink(path.join(sourceRoot, "packages/shared"), path.join(isolated, "packages/shared"), "junction");
  await assert.rejects(fs.access(path.join(isolated, "apps/desktop")), { code: "ENOENT" });
  const verifier = await import(pathToFileURL(path.join(isolated, tool)).href);
  assert.deepEqual(await verifier.verifyPreparedPublication(f), prepared);
});

test("test publication exports only Windows and requires explicit test mode for every recheck", async t => {
  const f = await fixture(t), options = { ...f, additionalBundleDirs: [], environment: "test" };
  const result = await preparePublication(options);
  assert.deepEqual(result.publishInput.variants.map(item => `${item.platform}/${item.arch}`), ["win32/x64"]);
  assert.deepEqual(await verifyPreparedPublication(options), result);
  assert.deepEqual(await preparePublication({ ...options, publishedAt: undefined }), result);
  await assert.rejects(verifyPreparedPublication(f), /THREE_PLATFORMS_REQUIRED/);
  const command = ["--conditions=development", "--import", "tsx", "scripts/prepare-publication.mjs", "--test",
    f.candidateDir, f.outputDir, f.trustedKeysFile];
  const output = execFileSync(process.execPath, command, { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.deepEqual(JSON.parse(output).publishInput, result.publishInput);
  const manifest = result.publishInput.variants[0];
  await fs.appendFile(path.join(f.outputDir, "artifacts", manifest.archiveSha256, "bundle.tar.gz"), "changed");
  await assert.rejects(verifyPreparedPublication(options), /ARCHIVE_MISMATCH/);
});

test("test publication preserves canonical ordering for Windows plus one actual Mac bundle", async t => {
  const f = await fixture(t);
  const result = await preparePublication({ ...f, additionalBundleDirs: [f.additionalBundleDirs[1]], environment: "test" });
  assert.deepEqual(result.publishInput.variants.map(item => `${item.platform}/${item.arch}`), ["win32/x64", "darwin/arm64"]);
  await assert.rejects(preparePublication({ ...f, additionalBundleDirs: [f.additionalBundleDirs[0], f.additionalBundleDirs[0]],
    environment: "test", outputDir: path.join(f.root, "duplicate") }), /PLATFORMS_INVALID/);
});

for (const [field, value] of [["platform", "win32"], ["arch", "x64"], ["nodeMajor", 22], ["modules", "127"]]) {
  for (const phase of ["export", "recheck"]) test(`signed ${field} runtime mismatch fails during publication ${phase}`, async t => {
    const f = await fixture(t), publication = await preparePublication(f);
    const resourcesDir = f.additionalBundleDirs[1], outputDir = path.join(f.root, "incompatible-bundle");
    await fs.writeFile(path.join(resourcesDir, "client/desktop-runtime.json"), JSON.stringify({
      schemaVersion: 1, platform: "darwin", arch: "arm64", nodeMajor: 24, modules: "145", [field]: value,
    }), "utf8");
    const { manifest } = await buildReleaseBundle({ resourcesDir, outputDir, privateKeyFile: f.privateKeyFile,
      metadata: { ...f.candidate.metadata, platform: "darwin", arch: "arm64" }, requireHeldStartup: true });
    if (phase === "export") {
      const rejectedOutput = path.join(f.root, "rejected-publication");
      await assert.rejects(preparePublication({ ...f, additionalBundleDirs: [f.additionalBundleDirs[0], outputDir], outputDir: rejectedOutput }), /CLIENT_RUNTIME_INCOMPATIBLE/);
      await assert.rejects(fs.access(rejectedOutput), { code: "ENOENT" });
    } else {
      const artifactDir = path.join(f.outputDir, "artifacts", manifest.archiveSha256);
      await fs.mkdir(artifactDir);
      for (const name of ["manifest.json", "bundle.tar.gz"]) await fs.copyFile(path.join(outputDir, name), path.join(artifactDir, name));
      publication.publishInput.variants[2].archiveSha256 = manifest.archiveSha256;
      await fs.writeFile(path.join(f.outputDir, "publish-input.json"), JSON.stringify(publication.publishInput), "utf8");
      await assert.rejects(verifyPreparedPublication(f), /CLIENT_RUNTIME_INCOMPATIBLE/);
    }
  });
}

test("missing, duplicate, foreign-version or untrusted platform input fails before exporting", async t => {
  const f = await fixture(t);
  await assert.rejects(preparePublication({ ...f, additionalBundleDirs: f.additionalBundleDirs.slice(0, 1) }), /THREE_PLATFORMS_REQUIRED/);
  await assert.rejects(preparePublication({ ...f, additionalBundleDirs: [f.additionalBundleDirs[0], f.additionalBundleDirs[0]] }), /THREE_PLATFORMS_REQUIRED/);
  const manifestFile = path.join(f.additionalBundleDirs[1], "manifest.json"), original = await fs.readFile(manifestFile);
  const manifest = JSON.parse(original); manifest.version = "2026.11.10.01";
  await fs.writeFile(manifestFile, JSON.stringify(manifest), "utf8");
  await assert.rejects(preparePublication(f), /SIGNATURE_INVALID/);
  const { signature: _signature, ...payload } = manifest;
  await fs.writeFile(manifestFile, JSON.stringify(signReleaseBundleManifest(payload, await fs.readFile(f.privateKeyFile))));
  await assert.rejects(preparePublication(f), /VERSION_MISMATCH/);
  await fs.writeFile(manifestFile, original);
  const otherTrust = path.join(f.root, "other-trust.json"), otherKey = crypto.generateKeyPairSync("ed25519").publicKey;
  await fs.writeFile(otherTrust, JSON.stringify({ fixture: otherKey.export({ type: "spki", format: "pem" }) }));
  await assert.rejects(preparePublication({ ...f, trustedKeysFile: otherTrust }), /SIGNATURE_INVALID/);
  await assert.rejects(fs.access(f.outputDir), { code: "ENOENT" });
});

test("a signed archive must actually contain its declared payload and exported tampering remains a failure", async t => {
  const f = await fixture(t), archiveFile = path.join(f.additionalBundleDirs[1], "bundle.tar.gz");
  const original = await fs.readFile(archiveFile); await fs.appendFile(archiveFile, "changed");
  await assert.rejects(preparePublication(f), /ARCHIVE_MISMATCH/);
  await fs.writeFile(archiveFile, original);
  const manifestFile = path.join(f.additionalBundleDirs[1], "manifest.json"), originalManifest = await fs.readFile(manifestFile);
  await tar.c({ cwd: f.additionalBundleDirs[1], file: archiveFile, gzip: true, portable: true }, ["web"]);
  const incompleteArchive = await fs.readFile(archiveFile), { signature: _signature, ...payload } = JSON.parse(originalManifest);
  await fs.writeFile(manifestFile, JSON.stringify(signReleaseBundleManifest({ ...payload, archiveSize: incompleteArchive.length,
    archiveSha256: crypto.createHash("sha256").update(incompleteArchive).digest("hex") }, await fs.readFile(f.privateKeyFile))));
  await assert.rejects(preparePublication(f), /ARCHIVE_FILES_MISMATCH/);
  await fs.writeFile(archiveFile, original); await fs.writeFile(manifestFile, originalManifest);
  const result = await preparePublication(f);
  const installerFile = path.join(f.outputDir, "installers", result.fullInstaller.sha256, result.fullInstaller.fileName);
  await fs.appendFile(installerFile, "changed");
  await assert.rejects(verifyPreparedPublication(f), /INSTALLER_MISMATCH/);
  await assert.rejects(preparePublication(f), /INSTALLER_MISMATCH/);
});

test("export rejects overlapping output and never installs public registration or archived logs", async t => {
  const f = await fixture(t);
  await assert.rejects(preparePublication({ ...f, outputDir: path.join(f.candidateDir, "publication") }), /OUTPUT_OVERLAP/);
  await preparePublication(f);
  assert.deepEqual((await fs.readdir(f.outputDir)).sort(), ["artifacts", "candidate.json", "full-installer.json", "installers", "publish-input.json", "release-notes"]);

});

test("a platform cannot relabel another platform archive to reuse its Server digest directory", async t => {
  const f = await fixture(t), manifestFile = path.join(f.additionalBundleDirs[1], "manifest.json");
  const { signature: _signature, ...payload } = JSON.parse(await fs.readFile(path.join(f.additionalBundleDirs[0], "manifest.json"), "utf8"));
  await fs.copyFile(path.join(f.additionalBundleDirs[0], "bundle.tar.gz"), path.join(f.additionalBundleDirs[1], "bundle.tar.gz"));
  await fs.writeFile(manifestFile, JSON.stringify(signReleaseBundleManifest({ ...payload, arch: "arm64" }, await fs.readFile(f.privateKeyFile))));
  await assert.rejects(preparePublication(f), /CLIENT_RUNTIME_INCOMPATIBLE/);
  await assert.rejects(fs.access(f.outputDir), { code: "ENOENT" });
});

