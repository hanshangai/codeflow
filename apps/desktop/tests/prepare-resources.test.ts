import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { prepareDesktopResources } from "../scripts/prepare-resources.mjs";
import { parsePrivateCliManifest } from "../client/src/cli-runtime/privateCliManifest.js";
import { readReleaseBundleFiles } from "@codeflowai/shared/desktop-release-signing";
import * as releaseCoordinator from "../src/releaseBundleCoordinator.js";
// @ts-expect-error Build scripts are native ESM and execute under the production Node loader.
import { buildReleaseBundle } from "../scripts/build-release-bundle.mjs";
// @ts-expect-error Build scripts are native ESM and execute under the same Node loader as production.
import { runTar } from "../scripts/tar.mjs";

test("assembles Web and the complete Client package with current runtime output", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-resources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageDir = path.join(root, "package");
  await fs.mkdir(path.join(packageDir, "node_modules", "runtime-dep"), { recursive: true });
  await fs.mkdir(path.join(root, "client", "dist"), { recursive: true });
  await fs.mkdir(path.join(root, "web"), { recursive: true });
  const { npmPackageDir, cliRuntimeManifestFile } = await writeCliRuntimeFixture(root);
  const manifest = { name: "@codeflowai/client", dependencies: { "runtime-dep": "1.0.0" } };
  await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(root, "client", "package.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(packageDir, "node_modules", "runtime-dep", "package.json"), JSON.stringify({ main: "index.js" }), "utf8");
  await fs.writeFile(path.join(packageDir, "node_modules", "runtime-dep", "index.js"), "module.exports = {};", "utf8");
  await fs.writeFile(path.join(root, "client", "dist", "index.cjs"), "current runtime", "utf8");
  await writeBuiltinResources(path.join(root, "client"));
  await fs.mkdir(path.join(packageDir, "dist"));
  await fs.writeFile(path.join(packageDir, "dist", "obsolete-worker.cjs"), "obsolete worker", "utf8");
  await fs.writeFile(path.join(root, "web", "index.html"), "current web", "utf8");
  const archive = path.join(root, "client.tgz");
  runTar(["-czf", archive, "-C", root, "package"]);
  const outputDir = path.join(root, "output");
  const keys = crypto.generateKeyPairSync("ed25519");
  const trust = { "installed-key": keys.publicKey.export({ type: "spki", format: "pem" }) };
  const trustedReleaseKeysFile = path.join(root, "trusted-public-keys.json");
  await fs.writeFile(trustedReleaseKeysFile, JSON.stringify(trust), "utf8");
  await prepareDesktopResources({ archive, clientDir: path.join(root, "client"), webDir: path.join(root, "web"), outputDir, trustedReleaseKeysFile,
    updateServerOrigin: "https://updates.example.test", npmPackageDir, cliRuntimeManifestFile });
  assert.equal(await fs.readFile(path.join(outputDir, "client", "dist", "index.cjs"), "utf8"), "current runtime");
  assert.equal(await fs.readFile(path.join(outputDir, "web", "index.html"), "utf8"), "current web");
  assert.equal(await fs.readFile(path.join(outputDir, "client", "npm", "bin", "npm-cli.js"), "utf8"), "fixture npm cli");
  assert.deepEqual(await fs.readFile(path.join(outputDir, "client", "cli-runtime.json")), await fs.readFile(cliRuntimeManifestFile));
  await assert.rejects(fs.access(path.join(outputDir, "npm")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(outputDir, "cli-runtime.json")), { code: "ENOENT" });
  const signedFiles = await readReleaseBundleFiles(outputDir);
  assert.ok(signedFiles.some(file => file.path === "client/npm/bin/npm-cli.js"));
  assert.ok(signedFiles.some(file => file.path === "client/cli-runtime.json"));
  const runtime = JSON.parse(await fs.readFile(path.join(outputDir, "client", "desktop-runtime.json"), "utf8"));
  assert.equal(runtime.schemaVersion, 1);
  assert.equal(runtime.platform, process.platform);
  assert.equal(runtime.arch, process.arch);
  assert.ok(Number.isSafeInteger(runtime.nodeMajor));
  assert.match(runtime.modules, /^\d+$/u);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(outputDir, "release-trust.json"), "utf8")), trust);
  await assert.rejects(fs.access(path.join(outputDir, "orch-asset-trust.json")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(outputDir, "desktop-update.json"), "utf8")), { serverOrigin: "https://updates.example.test" });
  assert.equal((await fs.readFile(path.join(outputDir, "release-trust.json"), "utf8")).includes("PRIVATE KEY"), false);
  assert.deepEqual(await fs.readFile(path.join(outputDir, "client", "dist", "orchestration-builtin", "builtin.json")),
    await fs.readFile(path.join(root, "client", "dist", "orchestration-builtin", "builtin.json")));
  await fs.access(path.join(outputDir, "client", "node_modules", "runtime-dep", "index.js"));
  await assert.rejects(() => fs.access(path.join(outputDir, "client", "dist", "obsolete-worker.cjs")), { code: "ENOENT" });
  await assert.rejects(() => prepareDesktopResources({ archive, clientDir: path.join(root, "client"), webDir: path.join(root, "web"), outputDir,
    npmPackageDir, cliRuntimeManifestFile }), /DESKTOP_RESOURCES_ALREADY_EXIST/);
  const offlineOutput = path.join(root, "offline-output");
  await prepareDesktopResources({ archive, clientDir: path.join(root, "client"), webDir: path.join(root, "web"), outputDir: offlineOutput,
    npmPackageDir, cliRuntimeManifestFile });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(offlineOutput, "release-trust.json"), "utf8")), {});
  await assert.rejects(fs.access(path.join(offlineOutput, "orch-asset-trust.json")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(offlineOutput, "desktop-update.json")), { code: "ENOENT" });
});

test("an update origin requires valid fixed origin and installed release trust before writing resources", async t => {
  const f = await dependencyFixture(t);
  for (const updateServerOrigin of ["http://remote.example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test/?token=secret", "", "https://example.test/"]) {
    await assert.rejects(prepareDesktopResources({ ...f, updateServerOrigin }), /DESKTOP_UPDATE_ORIGIN_INVALID/);
    await assert.rejects(fs.access(f.outputDir), { code: "ENOENT" });
  }
  await assert.rejects(prepareDesktopResources({ ...f, updateServerOrigin: "https://example.test" }), /DESKTOP_UPDATE_TRUST_REQUIRED/);
  await assert.rejects(fs.access(f.outputDir), { code: "ENOENT" });
});

test("an explicitly invalid trust file fails preparation without publishing resources", async t => {
  const f = await dependencyFixture(t);
  const dependencyDir = path.join(f.root, "package", "node_modules", "runtime-dep");
  await fs.mkdir(dependencyDir);
  await fs.writeFile(path.join(dependencyDir, "package.json"), JSON.stringify({ main: "index.js" }), "utf8");
  await fs.writeFile(path.join(dependencyDir, "index.js"), "module.exports = {};", "utf8");
  runTar(["-czf", f.archive, "-C", f.root, "package"]);
  const trustedReleaseKeysFile = path.join(f.root, "explicit-trust.json");
  await assert.rejects(() => prepareDesktopResources({ ...f, trustedReleaseKeysFile }), { code: "ENOENT" });
  await fs.writeFile(trustedReleaseKeysFile, "PRIVATE_INVALID_JSON", "utf8");
  await assert.rejects(() => prepareDesktopResources({ ...f, trustedReleaseKeysFile }), SyntaxError);
  const keys = crypto.generateKeyPairSync("ed25519");
  await fs.writeFile(trustedReleaseKeysFile, JSON.stringify({ "private-key": keys.privateKey.export({ format: "pem", type: "pkcs8" }) }), "utf8");
  await assert.rejects(() => prepareDesktopResources({ ...f, trustedReleaseKeysFile }), /DESKTOP_RELEASE_TRUST_INVALID/);
  const publicPem = keys.publicKey.export({ format: "pem", type: "spki" });
  const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" });
  await fs.writeFile(trustedReleaseKeysFile, JSON.stringify({ "public-with-extra-material": `${publicPem}${privatePem}` }), "utf8");
  await assert.rejects(() => prepareDesktopResources({ ...f, trustedReleaseKeysFile }), /DESKTOP_RELEASE_TRUST_INVALID/);
  await assert.rejects(() => fs.access(f.outputDir), { code: "ENOENT" });
});

test("a rejected Client package leaves no final resources to be packaged", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-resources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "package"));
  await fs.mkdir(path.join(root, "client", "dist"), { recursive: true });
  await fs.mkdir(path.join(root, "web"));
  await fs.writeFile(path.join(root, "package", "package.json"), JSON.stringify({ name: "wrong-package", dependencies: {} }), "utf8");
  await fs.writeFile(path.join(root, "client", "package.json"), JSON.stringify({ dependencies: {} }), "utf8");
  await fs.writeFile(path.join(root, "client", "dist", "index.cjs"), "current runtime", "utf8");
  await writeBuiltinResources(path.join(root, "client"));
  await fs.writeFile(path.join(root, "web", "index.html"), "current web", "utf8");
  const archive = path.join(root, "client.tgz");
  runTar(["-czf", archive, "-C", root, "package"]);
  const outputDir = path.join(root, "output");
  await assert.rejects(() => prepareDesktopResources({ archive, clientDir: path.join(root, "client"), webDir: path.join(root, "web"), outputDir }), /DESKTOP_CLIENT_PACKAGE_INVALID/);
  await assert.rejects(() => fs.access(outputDir), { code: "ENOENT" });
});

/** 构造缺少包内依赖的实际压缩包，用于验证组装失败不会发布输出。 */
async function dependencyFixture(t: test.TestContext, retain = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-resources-"));
  if (!retain) t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "package", "node_modules"), { recursive: true });
  await fs.mkdir(path.join(root, "client", "dist"), { recursive: true });
  await fs.mkdir(path.join(root, "web"));
  const manifest = { name: "@codeflowai/client", dependencies: { "runtime-dep": "1.0.0" } };
  await fs.writeFile(path.join(root, "package", "package.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(root, "client", "package.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(root, "client", "dist", "index.cjs"), "current runtime", "utf8");
  await writeBuiltinResources(path.join(root, "client"));
  await fs.writeFile(path.join(root, "web", "index.html"), "current web", "utf8");
  return { root, archive: path.join(root, "client.tgz"), clientDir: path.join(root, "client"), webDir: path.join(root, "web"), outputDir: path.join(root, "output"),
    ...await writeCliRuntimeFixture(root) };
}

/** 独立夹具中的固定 npm 包与清单，避免测试依赖真实 npm 安装。 */
async function writeCliRuntimeFixture(root: string): Promise<{ npmPackageDir: string; cliRuntimeManifestFile: string }> {
  const npmPackageDir = path.join(root, "cli-runtime-npm"), cliRuntimeManifestFile = path.join(root, "cli-runtime.json");
  await fs.mkdir(path.join(npmPackageDir, "bin"), { recursive: true });
  await fs.writeFile(path.join(npmPackageDir, "package.json"), JSON.stringify({ name: "npm", version: "12.2.2" }), "utf8");
  await fs.writeFile(path.join(npmPackageDir, "bin", "npm-cli.js"), "fixture npm cli", "utf8");
  await fs.writeFile(cliRuntimeManifestFile, JSON.stringify({ schemaVersion: 1, npm: { version: "12.2.2" }, engines: {
    claude: { npmPackage: "@anthropic-ai/claude-code", version: "2.1.318", estimatedBytes: 350000000 },
    codex: { npmPackage: "@openai/codex", version: "0.166.0", estimatedBytes: 520000000 },
  } }), "utf8");
  return { npmPackageDir, cliRuntimeManifestFile };
}

/** 使用真实 Client 校验 sidecar，资源正文保留为独立包内文件。 */
async function writeBuiltinResources(clientDir: string): Promise<void> {
  const { build } = await import("esbuild");
  await build({ entryPoints: [path.resolve(import.meta.dirname, "../client/src/orchestration/orchAssetBundleValidation.ts")],
    outfile: path.join(clientDir, "dist", "orchAssetBundleValidation.cjs"), bundle: true, platform: "node", format: "cjs",
    logLevel: "silent" });
  const directory = path.join(clientDir, "dist", "orchestration-builtin");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "builtin.json"), JSON.stringify({ schemaVersion: "orch-asset-bundle/v1",
    bundleId: "desktop-fixture", bundleVersion: 1, title: "内置", generatedAt: 1, source: { kind: "server-default" },
    roles: [], workflows: [], knowledgeBundles: [], skills: [], toolsets: [] }), "utf8");
}

test("invalid CLI runtime manifest and npm version drift fail with explicit codes before publishing", async (t) => {
  const f = await dependencyFixture(t);
  const dependencyDir = path.join(f.root, "package", "node_modules", "runtime-dep");
  await fs.mkdir(dependencyDir);
  await fs.writeFile(path.join(dependencyDir, "package.json"), JSON.stringify({ main: "index.js" }), "utf8");
  await fs.writeFile(path.join(dependencyDir, "index.js"), "module.exports = {};", "utf8");
  runTar(["-czf", f.archive, "-C", f.root, "package"]);
  const manifest = path.join(f.root, "scenario-cli-runtime.json");
  const scenarios: Array<{ file: string; text?: string; code: string }> = [
    { file: path.join(f.root, "missing-cli-runtime.json"), code: "DESKTOP_CLI_RUNTIME_MANIFEST_INVALID" },
    { file: manifest, text: "not json", code: "DESKTOP_CLI_RUNTIME_MANIFEST_INVALID" },
    { file: manifest, text: JSON.stringify({ schemaVersion: 2, npm: { version: "12.2.2" } }), code: "DESKTOP_CLI_RUNTIME_MANIFEST_INVALID" },
    { file: manifest, text: JSON.stringify({ schemaVersion: 1, npm: { version: 7 } }), code: "DESKTOP_CLI_RUNTIME_MANIFEST_INVALID" },
    // 与 Client 解析器一致：缺引擎、包名错配、多余字段都必须拒绝。
    { file: manifest, text: JSON.stringify({ schemaVersion: 1, npm: { version: "12.2.2" }, engines: {} }), code: "DESKTOP_CLI_RUNTIME_MANIFEST_INVALID" },
    { file: manifest, text: JSON.stringify({ schemaVersion: 1, npm: { version: "12.2.2" }, engines: {
      claude: { npmPackage: "@anthropic-ai/claude-code", version: "2.1.318", estimatedBytes: 350000000 },
      codex: { npmPackage: "@openai/wrong", version: "0.166.0", estimatedBytes: 520000000 },
    } }), code: "DESKTOP_CLI_RUNTIME_MANIFEST_INVALID" },
    { file: manifest, text: JSON.stringify({ schemaVersion: 1, npm: { version: "12.2.2" }, engines: {
      claude: { npmPackage: "@anthropic-ai/claude-code", version: "2.1.318", estimatedBytes: 350000000 },
      codex: { npmPackage: "@openai/codex", version: "0.166.0", estimatedBytes: 520000000, extra: true },
    } }), code: "DESKTOP_CLI_RUNTIME_MANIFEST_INVALID" },
    { file: manifest, text: JSON.stringify({ schemaVersion: 1, npm: { version: "11.0.0" }, engines: {
      claude: { npmPackage: "@anthropic-ai/claude-code", version: "2.1.318", estimatedBytes: 350000000 },
      codex: { npmPackage: "@openai/codex", version: "0.166.0", estimatedBytes: 520000000 },
    } }), code: "DESKTOP_NPM_VERSION_MISMATCH" },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    if (scenario.text !== undefined) await fs.writeFile(scenario.file, scenario.text, "utf8");
    const outputDir = path.join(f.root, `scenario-output-${index}`);
    await assert.rejects(() => prepareDesktopResources({ ...f, outputDir, cliRuntimeManifestFile: scenario.file }),
      (error: unknown) => (error as { code?: string; message?: string }).code === scenario.code
        && String((error as { message?: string }).message).includes(scenario.code));
    await assert.rejects(fs.access(outputDir), { code: "ENOENT" });
  }
});

test("shipped CLI runtime config is accepted by the Client manifest parser", async () => {
  const configured = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../config/cli-runtime.json"), "utf8"));
  assert.deepEqual(parsePrivateCliManifest(configured), configured);
});

test("missing builtin package fails resource preparation before publishing output", async (t) => {
  const f = await dependencyFixture(t);
  await fs.rm(path.join(f.clientDir, "dist", "orchestration-builtin"), { recursive: true });
  const dependencyDir = path.join(f.root, "package", "node_modules", "runtime-dep");
  await fs.mkdir(dependencyDir);
  await fs.writeFile(path.join(dependencyDir, "package.json"), JSON.stringify({ main: "index.js" }), "utf8");
  await fs.writeFile(path.join(dependencyDir, "index.js"), "module.exports = {};", "utf8");
  runTar(["-czf", f.archive, "-C", f.root, "package"]);
  await assert.rejects(() => prepareDesktopResources(f), /orchestration-builtin/);
  await assert.rejects(() => fs.access(f.outputDir), { code: "ENOENT" });
});

test("an incomplete builtin graph is rejected before extracting Client dependencies", async (t) => {
  const f = await dependencyFixture(t);
  const file = path.join(f.clientDir, "dist", "orchestration-builtin", "builtin.json");
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  value.roles = [{ sourceId: "role", role: { defaultKnowledgeBundleIds: ["missing"] } }];
  await fs.writeFile(file, JSON.stringify(value), "utf8");
  await assert.rejects(() => prepareDesktopResources(f), /依赖/);
  await assert.rejects(() => fs.access(f.outputDir), { code: "ENOENT" });
});

test("rejects a runtime dependency found only in the parent directory", async (t) => {
  const f = await dependencyFixture(t);
  const dependencyDir = path.join(f.root, "node_modules", "runtime-dep");
  await fs.mkdir(dependencyDir, { recursive: true });
  await fs.writeFile(path.join(dependencyDir, "package.json"), JSON.stringify({ main: "index.js" }), "utf8");
  await fs.writeFile(path.join(dependencyDir, "index.js"), "module.exports = {};", "utf8");
  runTar(["-czf", f.archive, "-C", f.root, "package"]);
  await assert.rejects(() => prepareDesktopResources(f), /DESKTOP_CLIENT_DEPENDENCY_OUTSIDE_PACKAGE/);
  await assert.rejects(() => fs.access(f.outputDir), { code: "ENOENT" });
});

test("rejects a package whose runtime dependency cannot load its transitive dependency", async (t) => {
  const f = await dependencyFixture(t);
  const dependencyDir = path.join(f.root, "package", "node_modules", "runtime-dep");
  await fs.mkdir(dependencyDir);
  await fs.writeFile(path.join(dependencyDir, "package.json"), JSON.stringify({ main: "index.js" }), "utf8");
  await fs.writeFile(path.join(dependencyDir, "index.js"), "require('missing-runtime-transitive-dependency');", "utf8");
  runTar(["-czf", f.archive, "-C", f.root, "package"]);
  await assert.rejects(() => prepareDesktopResources(f), /missing-runtime-transitive-dependency/);
  await assert.rejects(() => fs.access(f.outputDir), { code: "ENOENT" });
});

test("rejects a dependency incompatible with target Electron before publishing resources", async t => {
  const f = await dependencyFixture(t), dependencyDir = path.join(f.root, "package", "node_modules", "runtime-dep");
  await fs.mkdir(dependencyDir);
  await fs.writeFile(path.join(dependencyDir, "package.json"), JSON.stringify({ main: "index.js" }), "utf8");
  await fs.writeFile(path.join(dependencyDir, "index.js"), 'if (process.versions.electron) throw new Error("TARGET_NATIVE_ABI_MISMATCH"); module.exports = {};', "utf8");
  runTar(["-czf", f.archive, "-C", f.root, "package"]);
  await assert.rejects(() => prepareDesktopResources(f), /TARGET_NATIVE_ABI_MISMATCH/u);
  await assert.rejects(fs.access(f.outputDir), { code: "ENOENT" });
});

/** 两次原 prepare 和原 builder 使用相同包输入，证明 proof 无签名循环。 */
async function baselineProofFixture(t: test.TestContext, clientVersion = "1") {
  const f = await dependencyFixture(t, true), dependencyDir = path.join(f.root, "package", "node_modules", "runtime-dep");
  await fs.mkdir(dependencyDir);
  await fs.writeFile(path.join(dependencyDir, "package.json"), JSON.stringify({ main: "index.js" }), "utf8");
  await fs.writeFile(path.join(dependencyDir, "index.js"), "module.exports = {};", "utf8");
  await fs.writeFile(path.join(f.clientDir, "dist", "index.cjs"), 'console.log("1");', "utf8");
  const entry = await fs.readFile(path.join(f.clientDir, "dist", "index.cjs"));
  await fs.writeFile(path.join(f.clientDir, "dist", "desktop-startup-capability.json"), JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1,
    clientEntrySha256: crypto.createHash("sha256").update(entry).digest("hex") }), "utf8");
  runTar(["-czf", f.archive, "-C", f.root, "package"]);
  const keys = crypto.generateKeyPairSync("ed25519"), privateKeyFile = path.join(f.root, "fixture-private.pem"), trustedReleaseKeysFile = path.join(f.root, "trust.json");
  await fs.writeFile(privateKeyFile, keys.privateKey.export({ format: "pem", type: "pkcs8" }));
  await fs.writeFile(trustedReleaseKeysFile, JSON.stringify({ fixture: keys.publicKey.export({ format: "pem", type: "spki" }) }), "utf8");
  await prepareDesktopResources({ ...f, trustedReleaseKeysFile });
  const bundle = await buildReleaseBundle({ resourcesDir: f.outputDir, outputDir: path.join(f.root, "bundle"), privateKeyFile,
    metadata: { releaseId: "baseline", version: "1", webVersion: "1", clientVersion, protocolVersion: 1, capabilityVersion: 1,
      dbSchemaVersion: 88, platform: process.platform, arch: process.arch, keyId: "fixture", createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2099-10-24T00:00:00.000Z" } });
  return { ...f, trustedReleaseKeysFile, publicKey: keys.publicKey, baselineReleaseManifestFile: path.join(bundle.outputDir, "manifest.json"),
    provenOutput: path.join(f.root, "proven") };
}

test("baseline proof is the original signed manifest outside an unchanged complete payload", async t => {
  const f = await baselineProofFixture(t);
  await prepareDesktopResources({ ...f, outputDir: f.provenOutput });
  assert.deepEqual(await fs.readFile(path.join(f.provenOutput, "baseline-release-manifest.json")), await fs.readFile(f.baselineReleaseManifestFile));
  assert.deepEqual(await readReleaseBundleFiles(f.provenOutput), await readReleaseBundleFiles(f.outputDir));
  assert.equal((await releaseCoordinator.resolveBaselineRelease(f.provenOutput, { trustedReleaseKeys: { fixture: f.publicKey }, requireHeldStartup: true })).manifest.releaseId, "baseline");
});

test("validly signed baseline with a stale Client version is not published", async t => {
  const f = await baselineProofFixture(t, "2");
  await assert.rejects(prepareDesktopResources({ ...f, outputDir: f.provenOutput }), { code: "DESKTOP_CLIENT_VERSION_MISMATCH" });
  await assert.rejects(fs.access(f.provenOutput), { code: "ENOENT" });
});

test("planned Client version mismatch fails before publishing resources", async t => {
  const f = await baselineProofFixture(t);
  await assert.rejects(prepareDesktopResources({ ...f, outputDir: f.provenOutput, expectedClientVersion: "2" }),
    { code: "DESKTOP_CLIENT_VERSION_MISMATCH" });
  await assert.rejects(fs.access(f.provenOutput), { code: "ENOENT" });
});

for (const mutation of ["client", "web", "marker", "dependency", "signature", "trust", "missing", "utf8"] as const) {
  test(`baseline proof refuses changed input before publishing resources: ${mutation}`, async t => {
    const f = await baselineProofFixture(t);
    const changed = mutation === "client" ? path.join(f.clientDir, "dist", "index.cjs") : mutation === "web" ? path.join(f.webDir, "index.html")
      : mutation === "marker" ? path.join(f.clientDir, "dist", "desktop-startup-capability.json") : null;
    if (changed) await fs.appendFile(changed, "changed", "utf8");
    if (mutation === "dependency") {
      await fs.appendFile(path.join(f.root, "package", "node_modules", "runtime-dep", "index.js"), "\nmodule.exports.changed=true;", "utf8");
      runTar(["-czf", f.archive, "-C", f.root, "package"]);
    }
    if (mutation === "signature") {
      const manifest = JSON.parse(await fs.readFile(f.baselineReleaseManifestFile, "utf8"));
      await fs.writeFile(f.baselineReleaseManifestFile, JSON.stringify({ ...manifest, version: "changed" }), "utf8");
    }
    if (mutation === "trust") await fs.writeFile(f.trustedReleaseKeysFile, "{}", "utf8");
    if (mutation === "missing") await fs.rm(f.baselineReleaseManifestFile);
    if (mutation === "utf8") await fs.writeFile(f.baselineReleaseManifestFile, Buffer.from([0xc3, 0x28]));
    await assert.rejects(() => prepareDesktopResources({ ...f, outputDir: f.provenOutput }));
    await assert.rejects(fs.access(f.provenOutput), { code: "ENOENT" });
  });
}

test("baseline proof rejection and staging cleanup failure remain independently observable", async t => {
  const f = await baselineProofFixture(t), cleanup = new Error("staging cleanup failed"), rm = fs.rm.bind(fs);
  await fs.rm(f.baselineReleaseManifestFile);
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).startsWith(`${f.provenOutput}.prepare-`)) throw cleanup;
    return rm(...args);
  });
  await assert.rejects(() => prepareDesktopResources({ ...f, outputDir: f.provenOutput }), error => error instanceof AggregateError
    && error.errors.length === 2 && error.errors[0]?.code === "ENOENT" && error.errors[1] === cleanup);
  await assert.rejects(fs.access(f.provenOutput), { code: "ENOENT" });
  assert.ok((await fs.readdir(f.root)).some(name => name.startsWith("proven.prepare-")));
});
