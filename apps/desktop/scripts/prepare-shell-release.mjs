import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertShellReleasePayload } from "@codeflowai/shared";
import { signShellReleaseManifest, verifyShellReleaseSignature } from "@codeflowai/shared/desktop-shell-release-signing";
import { assertTrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";
import { buildShellInstaller, readShellCandidateInventory } from "./build-shell-installer.mjs";

const repository = fileURLToPath(new URL("../../..", import.meta.url));

/** 返回新旧路径可比较的真实绝对路径，不创建尚不存在的父目录。 */
async function resolveNew(value) {
  const tail = [];
  let current = path.resolve(value);
  for (;;) {
    try { return path.join(await fs.realpath(current), ...tail); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current)); current = parent;
    }
  }
}

/** 检查路径是否等于或位于指定目录内。 */
function within(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** 流式计算安装器摘要，并拒绝读取期间被替换或修改的文件。 */
async function digestFile(file) {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error("DESKTOP_SHELL_RELEASE_INSTALLER_FILE_INVALID");
  const digest = crypto.createHash("sha256");
  let size = 0n;
  for await (const chunk of createReadStream(file)) { digest.update(chunk); size += BigInt(chunk.length); }
  const after = await fs.lstat(file, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode
    || before.nlink !== after.nlink || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || size !== after.size
    || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("DESKTOP_SHELL_RELEASE_INSTALLER_CHANGED");
  }
  return { size: Number(size), sha256: digest.digest("hex") };
}

/** 只接受精确参数字段，避免拼写错误被静默忽略。 */
function readInput(value) {
  const fields = ["candidateDirectory", "shellId", "version", "createdAt", "expiresAt", "keyId", "privateKeyFile", "trustedKeysFile", "outputDir", "cacheDir"];
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== "string" || !fields.includes(key))) throw new Error("DESKTOP_SHELL_RELEASE_INPUT_INVALID");
  for (const field of fields.slice(0, 9)) if (typeof value[field] !== "string" || !value[field]) throw new Error("DESKTOP_SHELL_RELEASE_INPUT_INVALID");
  return value;
}

/** 在构建前验证签名清单字段与当前有效期，预检和正式发布共用。 */
function validateMetadata(input) {
  const files = ["CodeFlowAI.exe", "resources/app.asar", "resources/release-trust.json"]
    .map(file => ({ path: file, size: 1, sha256: "0".repeat(64) }));
  assertShellReleasePayload({ schemaVersion: 1, protocol: "codeflow-desktop-shell-v1", shellId: input.shellId, version: input.version,
    platform: "win32", arch: "x64", installerSha256: "0".repeat(64), installerSize: 1, files,
    createdAt: input.createdAt, expiresAt: input.expiresAt, keyId: input.keyId });
  const createdAt = Date.parse(input.createdAt), expiresAt = Date.parse(input.expiresAt), now = Date.now();
  if (createdAt > now) throw new Error("DESKTOP_SHELL_RELEASE_CREATED_IN_FUTURE");
  if (expiresAt <= now) throw new Error("DESKTOP_SHELL_RELEASE_EXPIRED");
}

/** 显式验证已有私钥和信任根，不生成密钥或接受不同 keyId 的信任。 */
async function readSigningMaterial(input, candidateDirectory, outputDir) {
  const privateKeyFile = await fs.realpath(input.privateKeyFile);
  if ([repository, candidateDirectory, outputDir].some(root => within(root, privateKeyFile))) throw new Error("DESKTOP_SHELL_RELEASE_PRIVATE_KEY_PATH_INVALID");
  const stat = await fs.lstat(privateKeyFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("DESKTOP_SHELL_RELEASE_PRIVATE_KEY_FILE_INVALID");
  const privateKey = crypto.createPrivateKey(await fs.readFile(privateKeyFile));
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new Error("DESKTOP_SHELL_RELEASE_PRIVATE_KEY_INVALID");
  const trustedKeys = assertTrustedReleaseKeys(JSON.parse(await fs.readFile(input.trustedKeysFile, "utf8")));
  const publicKey = trustedKeys?.[input.keyId];
  if (!publicKey) throw new Error("DESKTOP_SHELL_RELEASE_UNTRUSTED_KEY");
  const privatePublic = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const trustedPublic = publicKey.export({ type: "spki", format: "der" });
  if (!privatePublic.equals(trustedPublic)) throw new Error("DESKTOP_SHELL_RELEASE_KEY_MISMATCH");
  return { privateKey, trustedKeys, privateKeyFile };
}

/** 只读检查候选与外部签名信任，不创建构建、缓存或输出目录。 */
export async function validateShellReleaseSigningInputs(value) {
  const input = readInput(value);
  validateMetadata(input);
  const candidateDirectory = await fs.realpath(input.candidateDirectory);
  const outputDir = await resolveNew(input.outputDir);
  const { privateKeyFile } = await readSigningMaterial(input, candidateDirectory, outputDir);
  await readShellCandidateInventory(candidateDirectory, input.shellId);
  if (within(repository, candidateDirectory) || within(candidateDirectory, repository)
    || [repository, candidateDirectory].some(root => within(root, outputDir) || within(outputDir, root))) throw new Error("DESKTOP_SHELL_RELEASE_PATH_OVERLAP");
  return { shellId: input.shellId, keyId: input.keyId, privateKeyFile };
}

/** 完整构建、签名并验签后，将仅含清单和安装器的包原子固定到摘要目录。 */
export async function prepareShellRelease(value, dependencies = {}) {
  const input = readInput(value);
  validateMetadata(input);
  const candidateDirectory = await fs.realpath(input.candidateDirectory);
  const outputDir = await resolveNew(input.outputDir);
  const cacheDir = input.cacheDir;
  const { privateKey, trustedKeys } = await readSigningMaterial(input, candidateDirectory, outputDir);
  const payloadMetadata = { schemaVersion: 1, protocol: "codeflow-desktop-shell-v1", shellId: input.shellId, version: input.version,
    platform: "win32", arch: "x64", createdAt: input.createdAt, expiresAt: input.expiresAt, keyId: input.keyId };
  const builder = dependencies.buildShellInstaller ?? buildShellInstaller;
  await fs.mkdir(outputDir, { recursive: true });
  const staging = path.join(outputDir, `.staging-${crypto.randomUUID()}`);
  await fs.mkdir(staging);
  let failure;
  try {
    const buildDirectory = path.join(staging, "build");
    const built = await builder({ candidateDirectory, shellId: input.shellId, outputDir: buildDirectory, ...(cacheDir ? { cacheDir } : {}) });
    if (built.shellId !== input.shellId || !Array.isArray(built.files)) throw new Error("DESKTOP_SHELL_RELEASE_BUILD_RESULT_INVALID");
    const installer = await digestFile(built.executablePath), installerSha256 = installer.sha256;
    const payload = assertShellReleasePayload({ ...payloadMetadata, installerSha256, installerSize: installer.size, files: built.files });
    const manifest = signShellReleaseManifest(payload, privateKey);
    verifyShellReleaseSignature(manifest, trustedKeys);
    await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
    await fs.copyFile(built.executablePath, path.join(staging, "installer.exe"), fs.constants.COPYFILE_EXCL);
    const copiedInstaller = await digestFile(path.join(staging, "installer.exe"));
    if (copiedInstaller.size !== installer.size || copiedInstaller.sha256 !== installerSha256) throw new Error("DESKTOP_SHELL_RELEASE_INSTALLER_COPY_MISMATCH");
    await fs.rm(buildDirectory, { recursive: true });
    const packageDir = path.join(outputDir, installerSha256);
    try { await fs.lstat(packageDir); throw new Error("DESKTOP_SHELL_RELEASE_OUTPUT_EXISTS"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const manifestSha256 = crypto.createHash("sha256").update(await fs.readFile(path.join(staging, "manifest.json"))).digest("hex");
    await fs.rename(staging, packageDir);
    return { shellId: input.shellId, installerSha256, manifestSha256, packageDir };
  } catch (error) { failure = error; throw error; }
  finally {
    try { await fs.rm(staging, { recursive: true, force: true }); }
    catch (cleanup) { throw failure ? new AggregateError([failure, cleanup], "DESKTOP_SHELL_RELEASE_STAGING_CLEANUP_FAILED") : cleanup; }
  }
}
