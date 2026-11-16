import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildReleaseBundle } from "../../scripts/build-release-bundle.mjs";

/**
 * 生成一次性 Ed25519 发布签名身份。
 * keyId 进入清单并必须与壳的 release-trust.json 对齐；私钥只留在内存与临时目录。
 */
export function createReleaseSigningKey(keyId = "harness") {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
  };
}

/** 生成壳实际读取的信任根内容：keyId -> PEM 公钥。 */
export function createTrustFile(key) {
  return { [key.keyId]: key.publicKeyPem };
}

/** 将信任根写入指定目录的 release-trust.json。 */
export async function writeTrustFile(directory, key) {
  const file = path.join(directory, "release-trust.json");
  await fs.writeFile(file, `${JSON.stringify(createTrustFile(key), null, 2)}\n`, "utf8");
  return file;
}

/**
 * 在 workDir 下构建一个完整签名发布包。
 *
 * 复用生产构建脚本，确保清单字段顺序、归档摘要与签名口径和真实发布完全一致；
 * 只使用临时资源与临时密钥，不读取 dist、不接触真实安装或生产配置。
 * workDir 必须由调用方创建并负责清理。
 */
export async function buildSignedRelease({
  workDir,
  key,
  releaseId = "harness-release",
  version = "2.0.0",
  clientVersion = "2.0.0",
  webVersion = version,
  dbSchemaVersion = 89,
  platform = "win32",
  arch = "x64",
  now = Date.now(),
  ttlMs = 24 * 60 * 60 * 1000,
  extraWebFiles = {},
} = {}) {
  if (!workDir || !key) throw new Error("buildSignedRelease 需要 workDir 与 signing key");
  const resourcesDir = path.join(workDir, "resources");
  await fs.mkdir(path.join(resourcesDir, "web"), { recursive: true });
  await fs.mkdir(path.join(resourcesDir, "client", "dist"), { recursive: true });
  await fs.writeFile(path.join(resourcesDir, "web", "index.html"), "<!doctype html><title>harness</title>", "utf8");
  await fs.writeFile(path.join(resourcesDir, "web", "app.js"), "window.codeflowHarness = true;\n", "utf8");
  for (const [name, content] of Object.entries(extraWebFiles)) {
    const target = path.join(resourcesDir, "web", name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  await fs.writeFile(path.join(resourcesDir, "client", "dist", "index.cjs"), "module.exports = { version: 2 };\n", "utf8");
  await fs.writeFile(path.join(resourcesDir, "client", "package.json"), `${JSON.stringify({ name: "@codeflowai/client", version: clientVersion })}\n`, "utf8");

  const privateKeyFile = path.join(workDir, "release-private.pem");
  await fs.writeFile(privateKeyFile, key.privateKeyPem, "utf8");
  const outputDir = path.join(workDir, "bundle");
  const metadata = {
    releaseId,
    version,
    webVersion,
    clientVersion,
    protocolVersion: 1,
    capabilityVersion: 1,
    dbSchemaVersion,
    platform,
    arch,
    createdAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    keyId: key.keyId,
  };
  const result = await buildReleaseBundle({ resourcesDir, outputDir, metadata, privateKeyFile });
  const manifestBytes = await fs.readFile(path.join(outputDir, "manifest.json"));
  const archive = await fs.readFile(path.join(outputDir, "bundle.tar.gz"));
  return {
    manifest: result.manifest,
    manifestBytes: new Uint8Array(manifestBytes),
    archive,
    archivePath: path.join(outputDir, "bundle.tar.gz"),
    outputDir,
    trust: createTrustFile(key),
  };
}
