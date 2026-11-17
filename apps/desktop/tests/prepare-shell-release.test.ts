import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareShellRelease, validateShellReleaseSigningInputs } from "../scripts/prepare-shell-release.mjs";

/** 生成本地隔离夹具；只使用临时密钥，不参与真实发布。 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prepare-shell-release-"));
  const candidateDirectory = path.join(root, "candidate");
  await fs.mkdir(candidateDirectory);
  const contents = { "CodeFlowAI.exe": "installer input", "resources/app.asar": "app bytes", "resources/release-trust.json": "{}" };
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
  return { root, candidateDirectory, privateKeyFile, trustedKeysFile, inventory };
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
  const result = await prepareShellRelease({ candidateDirectory: f.candidateDirectory, shellId: "shell-test", version: "1.2.3",
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir }, { buildShellInstaller: builder(bytes, f.inventory) });
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

test("rejects key trust mismatch, invalid metadata, protected key paths and occupied output without a package", async () => {
  const f = await fixture(), bytes = Buffer.from("installer bytes"), buildShellInstaller = builder(bytes, f.inventory);
  const base = { candidateDirectory: f.candidateDirectory, shellId: "shell-test", version: "1.2.3",
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir: path.join(f.root, "output") };
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
  await assert.rejects(prepareShellRelease(base, { buildShellInstaller }), /OUTPUT_EXISTS/);
  assert.deepEqual((await fs.readdir(base.outputDir)).sort(), [crypto.createHash("sha256").update(bytes).digest("hex")]);
});

test("read-only preflight checks the complete candidate inventory without creating output", async () => {
  const f = await fixture();
  const input = { candidateDirectory: f.candidateDirectory, shellId: "shell-test", version: "1.2.3",
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir: path.join(f.root, "checked-output") };
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
  const result = await prepareShellRelease({ candidateDirectory: f.candidateDirectory, shellId: "shell-test", version: "1.2.3",
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "test",
    privateKeyFile: f.privateKeyFile, trustedKeysFile: f.trustedKeysFile, outputDir: path.join(f.root, "actual-output") });
  const manifest = JSON.parse(await fs.readFile(path.join(result.packageDir, "manifest.json"), "utf8"));
  const installer = await fs.readFile(path.join(result.packageDir, "installer.exe"));
  assert.equal(installer.subarray(0, 2).toString("ascii"), "MZ");
  assert.equal(crypto.createHash("sha256").update(installer).digest("hex"), result.installerSha256);
  assert.deepEqual(manifest.files, f.inventory);
});
