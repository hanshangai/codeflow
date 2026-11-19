import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createDesktopReleasePlan } from "../../../tools/release/desktop-release-plan.mjs";
import { prepareShellRelease, validateShellReleaseSigningInputs } from "../scripts/prepare-shell-release.mjs";
import { readShellCandidateInventory } from "../scripts/build-shell-installer.mjs";

/** 生成本地隔离夹具；只使用临时密钥，不参与真实发布。 */
async function fixture(resourceKeyId = "test") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prepare-shell-release-"));
  const { file: planFile, plan } = await createDesktopReleasePlan({ root: fileURLToPath(new URL("../../..", import.meta.url)),
    planDir: path.join(root, "plans"), keyId: resourceKeyId, platforms: ["win32/x64"], allowDirty: true });
  const candidateDirectory = path.join(root, "candidate");
  await fs.mkdir(candidateDirectory);
  const require = createRequire(import.meta.url);
  const asar = createRequire(createRequire(require.resolve("electron-builder")).resolve("app-builder-lib"))("@electron/asar");
  const app = path.join(root, "app");
  await fs.mkdir(app);
  await fs.writeFile(path.join(app, "package.json"), JSON.stringify({ version: `${plan.shellVersion}.0`, shellVersion: plan.shellVersion }));
  const archive = path.join(root, "app.asar");
  await asar.createPackage(app, archive);
  const contents = { "CodeFlowAI.exe": "installer input", "resources/app.asar": await fs.readFile(archive), "resources/release-trust.json": "{}" };
  for (const [relative, bytes] of Object.entries(contents)) {
    await fs.mkdir(path.dirname(path.join(candidateDirectory, relative)), { recursive: true });
    await fs.writeFile(path.join(candidateDirectory, relative), bytes);
  }
  const keys = crypto.generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(root, "shell-private.pem");
  const trustedKeysFile = path.join(root, "trust.json");
  await fs.writeFile(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  await fs.writeFile(trustedKeysFile, JSON.stringify({ test: keys.publicKey.export({ type: "spki", format: "pem" }) }));
  const inventory = Object.entries(contents).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([file, bytes]) => ({ path: file, size: Buffer.byteLength(bytes), sha256: crypto.createHash("sha256").update(bytes).digest("hex") }));
  return { root, candidateDirectory, privateKeyFile, trustedKeysFile, inventory, planFile, version: plan.shellVersion, allowDirty: true };
}

/** 用确定字节代替平台安装器编译，验证准备器对构建器接口的消费。 */
function builder(bytes: Buffer, inventory: Array<{ path: string; size: number; sha256: string }>) {
  return async ({ outputDir }: { outputDir: string }) => {
    await fs.mkdir(outputDir);
    const executablePath = path.join(outputDir, "shell-installer.exe");
    await fs.writeFile(executablePath, bytes);
    return { executablePath, shellId: "shell-test", files: inventory };
  };
}

test("signs the installer digest and complete builder inventory into an immutable package", async () => {
  const f = await fixture(), bytes = Buffer.from("installer bytes"), outputDir = path.join(f.root, "output");
  const result = await prepareShellRelease({ candidateDirectory: f.candidateDirectory, shellId: "shell-test", version: f.version, planFile: f.planFile, allowDirty: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir, historyDir: outputDir }, { buildShellInstaller: builder(bytes, f.inventory) });
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(result.installerSha256, digest);
  assert.equal(path.basename(result.packageDir), digest);
  assert.equal((await fs.readdir(result.packageDir)).sort().join(","), "installer.exe,manifest.json");
  const manifest = JSON.parse(await fs.readFile(path.join(result.packageDir, "manifest.json"), "utf8"));
  assert.equal(manifest.installerSha256, digest);
  assert.equal(manifest.installerSize, bytes.length);
  assert.deepEqual(manifest.files, f.inventory);
  assert.equal(result.manifestSha256, crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex"));
});

test("shell signing uses its own trusted key independently of the resource plan signing key", async () => {
  const f = await fixture("resource-only");
  const input = { candidateDirectory: f.candidateDirectory, shellId: "shell-test", planFile: f.planFile, allowDirty: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir: path.join(f.root, "separate-key"), historyDir: path.join(f.root, "separate-key") };
  assert.equal((await validateShellReleaseSigningInputs(input)).keyId, "test");
  const result = await prepareShellRelease(input, { buildShellInstaller: builder(Buffer.from("independent shell signature"), f.inventory) });
  const manifest = JSON.parse(await fs.readFile(path.join(result.packageDir, "manifest.json"), "utf8"));
  assert.equal(manifest.keyId, "test");
  assert.equal(manifest.version, f.version);
  await assert.rejects(validateShellReleaseSigningInputs({ ...input, keyId: "resource-only" }), /UNTRUSTED_KEY/);
});

test("rejects key trust mismatch, invalid metadata, protected key paths and occupied output without a package", async () => {
  const f = await fixture(), bytes = Buffer.from("installer bytes"), buildShellInstaller = builder(bytes, f.inventory);
  const base = { candidateDirectory: f.candidateDirectory, shellId: "shell-test", version: f.version, planFile: f.planFile, allowDirty: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir: path.join(f.root, "output"), historyDir: path.join(f.root, "output") };
  await assert.rejects(prepareShellRelease({ ...base, keyId: "unknown" }, { buildShellInstaller }), /UNTRUSTED_KEY/);
  const otherKeys = crypto.generateKeyPairSync("ed25519"), mismatchTrust = path.join(f.root, "mismatch-trust.json");
  await fs.writeFile(mismatchTrust, JSON.stringify({ test: otherKeys.publicKey.export({ type: "spki", format: "pem" }) }));
  await assert.rejects(prepareShellRelease({ ...base, trustedKeysFile: mismatchTrust }, { buildShellInstaller }), /KEY_MISMATCH/);
  await assert.rejects(prepareShellRelease({ ...base, expiresAt: base.createdAt }, { buildShellInstaller }), /PAYLOAD_INVALID/);
  await assert.rejects(prepareShellRelease({ ...base, privateKeyFile: path.join(f.candidateDirectory, "CodeFlowAI.exe") }, { buildShellInstaller }), /PRIVATE_KEY_PATH_INVALID/);
  const outputWithKey = path.join(f.root, "output-with-key");
  await fs.mkdir(outputWithKey);
  const nestedKey = path.join(outputWithKey, "shell-private.pem");
  await fs.copyFile(f.privateKeyFile, nestedKey);
  await assert.rejects(prepareShellRelease({ ...base, outputDir: outputWithKey, privateKeyFile: nestedKey }, { buildShellInstaller }), /PRIVATE_KEY_PATH_INVALID/);
  await fs.mkdir(path.join(base.outputDir, crypto.createHash("sha256").update(bytes).digest("hex")), { recursive: true });
  await assert.rejects(prepareShellRelease(base, { buildShellInstaller }), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(base.outputDir)).sort(), [crypto.createHash("sha256").update(bytes).digest("hex")]);
});

test("read-only preflight checks the complete candidate inventory without creating output", async () => {
  const f = await fixture();
  const input = { candidateDirectory: f.candidateDirectory, shellId: "shell-test", version: f.version, planFile: f.planFile, allowDirty: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir: path.join(f.root, "checked-output"), historyDir: path.join(f.root, "checked-history") };
  await validateShellReleaseSigningInputs(input);
  await assert.rejects(fs.access(input.outputDir), { code: "ENOENT" });
  const keys = JSON.parse(await fs.readFile(f.trustedKeysFile, "utf8"));
  await fs.writeFile(f.trustedKeysFile, JSON.stringify({ test: { value: keys.test } }));
  await assert.rejects(validateShellReleaseSigningInputs(input), /TRUST_INVALID/);
  await fs.writeFile(f.trustedKeysFile, JSON.stringify(keys));
  await fs.link(path.join(f.candidateDirectory, "CodeFlowAI.exe"), path.join(f.candidateDirectory, "duplicate.exe"));
  await assert.rejects(validateShellReleaseSigningInputs(input), /FILE_INVALID/);
  await assert.rejects(fs.access(input.outputDir), { code: "ENOENT" });
});

test("real builder prepares a signed complete small Windows shell package", { skip: process.platform !== "win32", timeout: 300_000 }, async () => {
  const f = await fixture();
  const result = await prepareShellRelease({ candidateDirectory: f.candidateDirectory, shellId: "shell-test", version: f.version, planFile: f.planFile, allowDirty: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir: path.join(f.root, "actual-output"), historyDir: path.join(f.root, "actual-history") });
  const manifest = JSON.parse(await fs.readFile(path.join(result.packageDir, "manifest.json"), "utf8"));
  const installer = await fs.readFile(path.join(result.packageDir, "installer.exe"));
  assert.equal(installer.subarray(0, 2).toString("ascii"), "MZ");
  assert.equal(crypto.createHash("sha256").update(installer).digest("hex"), result.installerSha256);
  assert.deepEqual(manifest.files, f.inventory);
});

test("shell signing requires a release plan before building or accepting a manually supplied version", async () => {
  const f = await fixture();
  let called = false;
  // @ts-expect-error 运行时也必须拒绝无计划调用。
  await assert.rejects(prepareShellRelease({ candidateDirectory: f.candidateDirectory, shellId: "shell-test", version: "1.0",
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir: path.join(f.root, "unplanned"), historyDir: path.join(f.root, "unplanned-history") }, {
    buildShellInstaller: async () => { called = true; throw new Error("must not build"); },
  }), /PLAN_REQUIRED/);
  assert.equal(called, false);
  await assert.rejects(fs.access(path.join(f.root, "unplanned")), { code: "ENOENT" });
});

test("shell signing rejects an override and a packaged shell version that differs from the plan", async () => {
  const f = await fixture();
  const base = { candidateDirectory: f.candidateDirectory, shellId: "shell-test", planFile: f.planFile, allowDirty: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir: path.join(f.root, "wrong-version"), historyDir: path.join(f.root, "wrong-history") };
  await assert.rejects(validateShellReleaseSigningInputs({ ...base, version: "1.0" }), /PLAN_VERSION_MISMATCH/);
  const require = createRequire(import.meta.url);
  const asar = createRequire(createRequire(require.resolve("electron-builder")).resolve("app-builder-lib"))("@electron/asar");
  await fs.writeFile(path.join(f.root, "app/package.json"), '{"version":"1.0.0","shellVersion":"1.0"}');
  await asar.createPackage(path.join(f.root, "app"), path.join(f.candidateDirectory, "resources/app.asar"));
  asar.uncacheAll();
  await assert.rejects(validateShellReleaseSigningInputs(base), /CANDIDATE_VERSION_MISMATCH/);
});

test("an existing signed shell version cannot be rebound to different payload files", async () => {
  const f = await fixture(), outputDir = path.join(f.root, "immutable-output");
  const input = { candidateDirectory: f.candidateDirectory, shellId: "shell-test", planFile: f.planFile, allowDirty: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir, historyDir: outputDir };
  await prepareShellRelease(input, { buildShellInstaller: builder(Buffer.from("first installer"), f.inventory) });
  await fs.appendFile(path.join(f.candidateDirectory, "CodeFlowAI.exe"), "different shell bytes");
  const changed = await readShellCandidateInventory(f.candidateDirectory, "shell-test");
  await assert.rejects(prepareShellRelease(input, { buildShellInstaller: builder(Buffer.from("other installer"), changed) }), /VERSION_CONTENT_CONFLICT/);
  assert.equal((await fs.readdir(outputDir)).length, 1);
});

test("a new request directory and shellId cannot rebind signed shell version bytes", async () => {
  const f = await fixture();
  const input = { candidateDirectory: f.candidateDirectory, shellId: "shell-test", planFile: f.planFile, allowDirty: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir: path.join(f.root, "request-one"), historyDir: path.join(f.root, "history") };
  await prepareShellRelease(input, { buildShellInstaller: builder(Buffer.from("first installer"), f.inventory) });
  await fs.appendFile(path.join(f.candidateDirectory, "CodeFlowAI.exe"), "different runtime");
  const changed = await readShellCandidateInventory(f.candidateDirectory, "another-shell");
  await assert.rejects(prepareShellRelease({ ...input, shellId: "another-shell", outputDir: path.join(f.root, "request-two") }, {
    buildShellInstaller: async () => { throw new Error("CONFLICT_MUST_PRECEDE_BUILD"); },
  }), /VERSION_CONTENT_CONFLICT/);
  assert.notDeepEqual(changed, f.inventory);
});

test("a retry reuses the signed artifact bytes across request directories and shellIds", async () => {
  const f = await fixture(), input = { candidateDirectory: f.candidateDirectory, shellId: "shell-test", planFile: f.planFile, allowDirty: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir: path.join(f.root, "first-request"), historyDir: path.join(f.root, "history") };
  const first = await prepareShellRelease(input, { buildShellInstaller: builder(Buffer.from("signed once"), f.inventory) });
  const manifest = await fs.readFile(path.join(first.packageDir, "manifest.json"));
  const retried = await prepareShellRelease({ ...input, shellId: "retry-shell", createdAt: new Date().toISOString(), outputDir: path.join(f.root, "retry-request") }, {
    buildShellInstaller: async () => { throw new Error("RETRY_MUST_NOT_REBUILD"); },
  });
  assert.deepEqual(retried, first);
  assert.deepEqual(await fs.readFile(path.join(retried.packageDir, "manifest.json")), manifest);
  assert.deepEqual(await readShellCandidateInventory(f.candidateDirectory, "shell-test"), f.inventory);
  await fs.appendFile(path.join(first.packageDir, "installer.exe"), "tampered");
  await assert.rejects(prepareShellRelease(input), /HISTORY_INSTALLER_MISMATCH/);
});

test("shell projection signs identical files after only bundled business resources change", async () => {
  const f = await fixture(), outputDir = path.join(f.root, "projected");
  const business = ["resources/client/dist/index.cjs", "resources/web/index.html", "resources/baseline-release-manifest.json", "resources/default_app.asar"];
  for (const relative of business) {
    await fs.mkdir(path.dirname(path.join(f.candidateDirectory, relative)), { recursive: true });
    await fs.writeFile(path.join(f.candidateDirectory, relative), "first business bytes");
  }
  const input = { candidateDirectory: f.candidateDirectory, shellId: "shell-test", planFile: f.planFile, allowDirty: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir, historyDir: outputDir };
  let attempt = 0;
  const buildShellInstaller = async ({ candidateDirectory, outputDir }: { candidateDirectory: string; outputDir: string }) => {
    assert.notEqual(candidateDirectory, f.candidateDirectory);
    for (const relative of ["resources/client", "resources/web", ...business.slice(2)]) await assert.rejects(fs.access(path.join(candidateDirectory, relative)), { code: "ENOENT" });
    const files = await readShellCandidateInventory(candidateDirectory, "shell-test");
    return await builder(Buffer.from(`projected installer ${++attempt}`), files)({ outputDir });
  };
  const first = await prepareShellRelease(input, { buildShellInstaller });
  for (const relative of business) await fs.writeFile(path.join(f.candidateDirectory, relative), "different business bytes");
  const second = await prepareShellRelease(input, { buildShellInstaller });
  const read = async (directory: string) => JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.deepEqual((await read(first.packageDir)).files, f.inventory);
  assert.deepEqual((await read(second.packageDir)).files, f.inventory);
  for (const directory of [first.packageDir, second.packageDir]) assert.deepEqual((await fs.readdir(directory)).sort(), ["installer.exe", "manifest.json"]);
  assert.equal(await fs.readFile(path.join(f.candidateDirectory, business[0]!), "utf8"), "different business bytes");
});

test("shell projection rejects linked inputs and source changes while the installer builds", async () => {
  const f = await fixture(), input = { candidateDirectory: f.candidateDirectory, shellId: "shell-test", planFile: f.planFile, allowDirty: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir: path.join(f.root, "guarded-projection"), historyDir: path.join(f.root, "guarded-history") };
  const linked = path.join(f.candidateDirectory, "linked");
  await fs.symlink(path.join(f.candidateDirectory, "resources"), linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareShellRelease(input, { buildShellInstaller: builder(Buffer.from("must not build"), f.inventory) }), /FILE_INVALID|DIRECTORY_INVALID/);
  await fs.unlink(linked);
  await assert.rejects(prepareShellRelease(input, { buildShellInstaller: async ({ outputDir }) => {
    const result = await builder(Buffer.from("changed input"), f.inventory)({ outputDir });
    await fs.appendFile(path.join(f.candidateDirectory, "CodeFlowAI.exe"), "changed");
    return result;
  } }), /INPUT_CHANGED/);
  assert.deepEqual(await fs.readdir(input.outputDir), []);
});
