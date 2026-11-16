import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const requireShared = createRequire(new URL("../../packages/shared/package.json", import.meta.url));
let signingModule;

/** 从 shared 自身导出加载签名模块，不依赖桌面安装；解析失败直接中止校验。 */
async function loadSigning() {
  if (signingModule) return signingModule;
  signingModule = {
    ...await import(pathToFileURL(requireShared.resolve("@codeflowai/shared/desktop-release-signing")).href),
    ...await import(pathToFileURL(requireShared.resolve("@codeflowai/shared/desktop-release-extract")).href),
  };
  return signingModule;
}

/** 流式计算归档摘要；发布目录必须与签名 manifest 的真实字节一致。 */
async function digestFile(file) {
  const stat = await fs.stat(file);
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { size: stat.size, sha256: hash.digest("hex") };
}

/** 发布产物目录名与 release 平台键一一对应。 */
export function platformDirectory(key) {
  return key.replace("/", "-");
}

/** 本地构建可无来源证明；存在时必须成对原样搬运，官方可信性由私有发布入口判断。 */
async function copyBuildOrigin(source, target) {
  const files = ["build-origin.json", "build-origin.sig.json"];
  const entries = new Set(await fs.readdir(source));
  const present = files.map(file => entries.has(file));
  if (!present.some(Boolean)) return;
  if (!present.every(Boolean)) throw new Error("DESKTOP_RESOURCE_ORIGIN_INCOMPLETE");
  for (const file of files) await fs.copyFile(path.join(source, file), path.join(target, file));
}

/** 严格读取 JSON；坏编码与坏 JSON 显式失败。 */
async function readJson(file) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file)));
}

/** 校验一个平台资源包，返回已验签 manifest。 */
async function verifyBundle({ bundleDir, trustFile, plan, platform, arch }) {
  const { assertTrustedReleaseKeys, verifyReleaseBundlePayload, verifyReleaseBundleSignature, extractReleaseBundle } = await loadSigning();
  const manifestPath = path.join(bundleDir, "manifest.json");
  const archivePath = path.join(bundleDir, "bundle.tar.gz");
  const trustedKeys = assertTrustedReleaseKeys(await readJson(trustFile));
  const manifest = verifyReleaseBundleSignature(await readJson(manifestPath), trustedKeys, { platform, arch, requireFresh: true });
  if (manifest.releaseId !== plan.releaseId || manifest.version !== plan.version
    || manifest.webVersion !== plan.webVersion || manifest.clientVersion !== plan.clientVersion
    || manifest.protocolVersion !== plan.protocolVersion || manifest.capabilityVersion !== plan.capabilityVersion
    || manifest.dbSchemaVersion !== plan.dbSchemaVersion || manifest.keyId !== plan.keyId
    || manifest.platform !== platform || manifest.arch !== arch) throw new Error(`DESKTOP_RESOURCE_PLAN_MISMATCH: ${platform}/${arch}`);
  const archive = await digestFile(archivePath);
  if (archive.sha256 !== manifest.archiveSha256 || archive.size !== manifest.archiveSize) throw new Error(`DESKTOP_RESOURCE_ARCHIVE_MISMATCH: ${platform}/${arch}`);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-resource-verify-"));
  try {
    await extractReleaseBundle({ archivePath, stagingDir: scratch, manifest });
    await verifyReleaseBundlePayload({ directory: scratch, manifest, trustedKeys, platform, arch,
      requireFresh: true, requireHeldStartup: true });
    const runtime = await readJson(path.join(scratch, "client/desktop-runtime.json"));
    if (!runtime || runtime.platform !== platform || runtime.arch !== arch) throw new Error(`DESKTOP_RESOURCE_RUNTIME_MISMATCH: ${platform}/${arch}`);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  return { manifest, manifestPath, archivePath };
}

/** 在 publication 目录上复验资源包；登记前不信任本地生成结果。 */
export async function verifyResourcePublication({ outputDir, trustFile, trustedKeysFile, plan: expectedPlan = null }) {
  const { assertTrustedReleaseKeys, verifyReleaseBundlePayload, verifyReleaseBundleSignature, extractReleaseBundle } = await loadSigning();
  const trustPath = trustFile ?? trustedKeysFile;
  const plan = await readJson(path.join(outputDir, "desktop-release-plan.json"));
  const input = await readJson(path.join(outputDir, "publish-input.json"));
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.platformSet) || !plan.platformSet.length
    || input?.releaseId !== plan.releaseId || !Number.isSafeInteger(input.publishedAt) || !Array.isArray(input.variants)
    || input.variants.length !== plan.platformSet.length) throw new Error("DESKTOP_RESOURCE_PUBLICATION_INVALID");
  if (expectedPlan && JSON.stringify(plan) !== JSON.stringify(expectedPlan)) {
    throw new Error("DESKTOP_RESOURCE_PUBLICATION_PLAN_ARGUMENT_MISMATCH");
  }
  const trustedKeys = assertTrustedReleaseKeys(await readJson(trustPath));
  const verified = [];
  for (const key of plan.platformSet) {
    const [platform, arch] = key.split("/");
    const variant = input.variants.find(item => item?.platform === platform && item.arch === arch && /^[a-f0-9]{64}$/u.test(item.archiveSha256));
    if (!variant) throw new Error(`DESKTOP_RESOURCE_PUBLICATION_VARIANT_MISSING: ${key}`);
    const target = path.join(outputDir, "artifacts", variant.archiveSha256);
    const manifest = verifyReleaseBundleSignature(await readJson(path.join(target, "manifest.json")), trustedKeys,
      { platform, arch, requireFresh: true });
    if (manifest.releaseId !== plan.releaseId || manifest.version !== plan.version || manifest.webVersion !== plan.webVersion
      || manifest.clientVersion !== plan.clientVersion || manifest.protocolVersion !== plan.protocolVersion
      || manifest.capabilityVersion !== plan.capabilityVersion || manifest.dbSchemaVersion !== plan.dbSchemaVersion
      || manifest.keyId !== plan.keyId || manifest.platform !== platform || manifest.arch !== arch
      || manifest.archiveSha256 !== variant.archiveSha256) {
      throw new Error(`DESKTOP_RESOURCE_PUBLICATION_PLAN_MISMATCH: ${key}`);
    }
    const archivePath = path.join(target, "bundle.tar.gz");
    const archive = await digestFile(archivePath);
    if (archive.sha256 !== manifest.archiveSha256 || archive.size !== manifest.archiveSize) {
      throw new Error(`DESKTOP_RESOURCE_ARCHIVE_MISMATCH: ${key}`);
    }
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-resource-verify-"));
    try {
      await extractReleaseBundle({ archivePath, stagingDir: scratch, manifest });
      await verifyReleaseBundlePayload({ directory: scratch, manifest, trustedKeys, platform, arch,
        requireFresh: true, requireHeldStartup: true });
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
    verified.push({ platform, arch, archiveSha256: variant.archiveSha256 });
  }
  if (JSON.stringify(verified) !== JSON.stringify(input.variants.map(item => ({ platform: item.platform, arch: item.arch, archiveSha256: item.archiveSha256 })))) {
    throw new Error("DESKTOP_RESOURCE_PUBLICATION_ORDER_MISMATCH");
  }
  return { plan, publishInput: input };
}

/** 汇总各平台资源包，生成无安装包的 resource publication。 */
export async function prepareResourcePublication({ plan, artifactsRoot, outputDir, trustFile, publishedAt = Date.now() }) {
  await fs.access(trustFile);
  try { await fs.access(outputDir); throw new Error(`DESKTOP_RESOURCE_PUBLICATION_EXISTS: ${outputDir}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  const staging = await fs.mkdtemp(`${outputDir}.build-`);
  try {
    const variants = [];
    for (const key of plan.platformSet) {
      const [platform, arch] = key.split("/");
      const bundleDir = path.join(artifactsRoot, platformDirectory(key), "bundle");
      try { await fs.access(path.join(bundleDir, "manifest.json")); await fs.access(path.join(bundleDir, "bundle.tar.gz")); }
      catch (error) { if (error.code === "ENOENT") throw new Error(`DESKTOP_RESOURCE_ARTIFACTS_MISSING: ${key}`); throw error; }
      const verified = await verifyBundle({ bundleDir, trustFile, plan, platform, arch });
      const target = path.join(staging, "artifacts", verified.manifest.archiveSha256);
      await fs.mkdir(target, { recursive: true });
      for (const name of ["manifest.json", "bundle.tar.gz"]) await fs.copyFile(path.join(bundleDir, name), path.join(target, name));
      await copyBuildOrigin(bundleDir, target);
      variants.push({ platform, arch, archiveSha256: verified.manifest.archiveSha256 });
    }
    const input = { releaseId: plan.releaseId, publishedAt, variants: plan.platformSet.map(key => {
      const [platform, arch] = key.split("/");
      return variants.find(item => item.platform === platform && item.arch === arch);
    }) };
    await fs.writeFile(path.join(staging, "publish-input.json"), `${JSON.stringify(input, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(staging, "desktop-release-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(staging, outputDir); break; }
      catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 14) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    return { outputDir, publishInput: input };
  } catch (error) {
    try { await fs.rm(staging, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "DESKTOP_RESOURCE_PUBLICATION_CLEANUP_FAILED"); }
    throw error;
  }
}
