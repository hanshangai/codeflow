import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const requireShared = createRequire(new URL("../../packages/shared/package.json", import.meta.url));
const { assertTrustedReleaseKeys, verifyReleaseBundlePayload, verifyReleaseBundleSignature } =
  await import(pathToFileURL(requireShared.resolve("@codeflowai/shared/desktop-release-signing")).href);
const { extractReleaseBundle } = await import(pathToFileURL(requireShared.resolve("@codeflowai/shared/desktop-release-extract")).href);
const { assertDesktopReleasePlatforms, DESKTOP_RELEASE_PLATFORMS, formatDesktopVersion, readDesktopReleaseEnvironment } =
  await import(pathToFileURL(requireShared.resolve("@codeflowai/shared")).href);

const platforms = DESKTOP_RELEASE_PLATFORMS;

/** 对外安装包名与桌面端界面共用同一展示版本，避免下载名和界面版本脱节；缺失事实必须失败。 */
function publicVersion(candidate) {
  if (typeof candidate.shellVersion !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(candidate.shellVersion)) {
    throw new Error("DESKTOP_PUBLICATION_SHELL_VERSION_INVALID");
  }
  const version = formatDesktopVersion(candidate.shellVersion, candidate.metadata.version);
  if (typeof version !== "string" || !/^\d+(?:\.\d+){1,3}$/u.test(version)) {
    throw new Error("DESKTOP_PUBLICATION_DISPLAY_VERSION_INVALID");
  }
  return version;
}

/** 只接受普通单链接文件；严格 UTF-8 解码，磁盘故障不得当作缺失。 */
async function readJson(file) {
  await digest(file);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file)));
}

/** 流式核验实际工件，拒绝目录、软链接和硬链接。 */
async function digest(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("DESKTOP_PUBLICATION_FILE_INVALID");
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { sha256: hash.digest("hex"), size: stat.size };
}

/** 仅 ENOENT 表示尚未导出，权限与其他 I/O 错误继续失败。 */
async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/** 真实输出祖先保留未创建尾段，不能经链接覆盖工件输入。 */
async function resolveOutput(directory) {
  const tail = [];
  for (let current = path.resolve(directory);;) {
    try { return path.join(await fs.realpath(current), ...tail); }
    catch (error) { if (error.code !== "ENOENT" || path.dirname(current) === current) throw error; tail.unshift(path.basename(current)); current = path.dirname(current); }
  }
}

/** 同路径和包含关系均属于重叠。 */
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 严格精确对象比较不依赖 JSON 字段书写顺序。 */
function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
}

/** 按目标环境核实际平台，只产生原 publish 合同，不推导设备或放量策略。 */
function publishInput(manifests, publishedAt, environment) {
  const selected = manifests.map(item => `${item.platform}/${item.arch}`);
  // 正式入口保留原三平台失败码；测试入口仍拒绝空集合、重复和未知平台。
  if (environment === "production" && (selected.length !== 3 || platforms.some(key => selected.filter(item => item === key).length !== 1))) {
    throw new Error("DESKTOP_PUBLICATION_THREE_PLATFORMS_REQUIRED");
  }
  assertDesktopReleasePlatforms(selected, environment);
  // Server按归档摘要定位唯一manifest，不能把两个平台写到同一摘要目录。
  if (new Set(manifests.map(item => item.archiveSha256)).size !== manifests.length) throw new Error("DESKTOP_PUBLICATION_ARCHIVE_IDENTITY_CONFLICT");
  const first = manifests[0];
  if (!/^\d{4}\.\d{2}\.\d{2}\.\d+$/u.test(first.version) || manifests.some(item => item.releaseId !== first.releaseId || item.version !== first.version
    || item.webVersion !== first.webVersion || item.clientVersion !== first.clientVersion || item.dbSchemaVersion !== first.dbSchemaVersion
    || item.protocolVersion !== first.protocolVersion || item.capabilityVersion !== first.capabilityVersion)) throw new Error("DESKTOP_PUBLICATION_VERSION_MISMATCH");
  if (!Number.isSafeInteger(publishedAt) || publishedAt <= 0) throw new Error("DESKTOP_PUBLICATION_TIME_INVALID");
  return { releaseId: first.releaseId, publishedAt, variants: platforms.filter(key => selected.includes(key)).map(key => {
    const manifest = manifests.find(item => `${item.platform}/${item.arch}` === key);
    return { platform: manifest.platform, arch: manifest.arch, archiveSha256: manifest.archiveSha256 };
  }) };
}

/** 验签和完整库存通过后，核已签运行时的平台架构及同候选壳 Node/ABI。 */
async function verifyArchive(directory, trustedKeys, requiredRuntime) {
  const manifest = verifyReleaseBundleSignature(await readJson(path.join(directory, "manifest.json")), trustedKeys);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-publication-verify-"));
  let failure;
  try {
    await extractReleaseBundle({ archivePath: path.join(directory, "bundle.tar.gz"), stagingDir: scratch, manifest });
    await verifyReleaseBundlePayload({ directory: scratch, manifest, trustedKeys, platform: manifest.platform, arch: manifest.arch,
      requireFresh: true, requireHeldStartup: true });
    const runtime = await readJson(path.join(scratch, "client/desktop-runtime.json"));
    if (!runtime || runtime.schemaVersion !== 1 || runtime.platform !== manifest.platform || runtime.arch !== manifest.arch
      || !Number.isSafeInteger(runtime.nodeMajor) || runtime.nodeMajor <= 0 || typeof runtime.modules !== "string" || !/^[1-9]\d*$/u.test(runtime.modules)
      || requiredRuntime && (runtime.nodeMajor !== requiredRuntime.nodeMajor || runtime.modules !== requiredRuntime.modules)) {
      throw new Error(`DESKTOP_CLIENT_RUNTIME_INCOMPATIBLE: ${manifest.releaseId} ${manifest.platform}/${manifest.arch}; expected Node=${requiredRuntime?.nodeMajor}, ABI=${requiredRuntime?.modules}; actual ${runtime?.platform}/${runtime?.arch}, Node=${runtime?.nodeMajor}, ABI=${runtime?.modules}`);
    }
    return { manifest, runtime };
  } catch (error) { failure = error; throw error; }
  finally {
    try { await fs.rm(scratch, { recursive: true }); }
    catch (cleanup) { throw failure ? new AggregateError([failure, cleanup], "DESKTOP_PUBLICATION_VERIFY_CLEANUP_FAILED") : cleanup; }
  }
}

/** 复验可审查发布材料，信任根始终由调用者独立提供；不会连接数据库。 */
export async function verifyPreparedPublication({ outputDir, trustedKeysFile, environment = "production" }) {
  environment = readDesktopReleaseEnvironment(environment);
  const trustedKeys = assertTrustedReleaseKeys(await readJson(trustedKeysFile));
  const candidate = await readJson(path.join(outputDir, "candidate.json")), input = await readJson(path.join(outputDir, "publish-input.json"));
  if (candidate.schemaVersion !== 1 || !candidate.installer || !Array.isArray(input.variants)
    || input.variants.some(item => !item || !/^[a-f0-9]{64}$/u.test(item.archiveSha256))) throw new Error("DESKTOP_PUBLICATION_INVALID");
  assertDesktopReleasePlatforms(input.variants.map(item => `${item.platform}/${item.arch}`), environment);
  const manifests = [];
  let requiredRuntime;
  for (const variant of input.variants) {
    const { manifest, runtime } = await verifyArchive(path.join(outputDir, "artifacts", variant.archiveSha256), trustedKeys, requiredRuntime);
    if (manifest.archiveSha256 !== variant.archiveSha256 || manifest.platform !== variant.platform || manifest.arch !== variant.arch) throw new Error("DESKTOP_PUBLICATION_VARIANT_MISMATCH");
    requiredRuntime ??= runtime;
    manifests.push(manifest);
  }
  const expected = publishInput(manifests, input.publishedAt, environment);
  const windows = manifests.find(item => item.platform === "win32" && item.arch === "x64");
  if (!windows || !same(input, expected) || candidate.metadata.releaseId !== input.releaseId || candidate.metadata.version !== manifests[0].version
    || candidate.metadata.platform !== "win32" || candidate.metadata.arch !== "x64"
    || Object.entries(candidate.metadata).some(([key, value]) => windows[key] !== value)) throw new Error("DESKTOP_PUBLICATION_INPUT_MISMATCH");
  const registration = { schemaVersion: 1, kind: "full-installer", releaseId: input.releaseId, version: candidate.metadata.version,
    platform: "win32", arch: "x64", size: candidate.installer.size, sha256: candidate.installer.sha256, publishedAt: input.publishedAt };
  /** 新导出使用展示版本；旧发布目录仍接受内部版本名，保证相同命令可复验历史材料。 */
  const existingInstaller = await readJson(path.join(outputDir, "full-installer.json"));
  const fullInstaller = [
    { ...registration, fileName: `CodeFlowAI-${publicVersion(candidate)}-win32-x64.exe` },
    { ...registration, fileName: `CodeFlowAI-${candidate.metadata.version}-win32-x64.exe` },
  ].find(item => same(existingInstaller, item));
  if (!fullInstaller || !/^[a-f0-9]{64}$/u.test(fullInstaller.sha256) || !Number.isSafeInteger(fullInstaller.size) || fullInstaller.size < 1) throw new Error("DESKTOP_PUBLICATION_INSTALLER_MISMATCH");
  if (!same(await digest(path.join(outputDir, "installers", fullInstaller.sha256, fullInstaller.fileName)), { sha256: fullInstaller.sha256, size: fullInstaller.size })) throw new Error("DESKTOP_PUBLICATION_INSTALLER_MISMATCH");
  if (!same(await digest(path.join(outputDir, "release-notes", `${candidate.metadata.version}.md`)), candidate.notes)) throw new Error("DESKTOP_PUBLICATION_NOTES_MISMATCH");
  return { publishInput: expected, fullInstaller };
}

/** 正式导出三平台，测试可只导出 Windows；重试固定 publishedAt，不自动公开材料。 */
export async function preparePublication({ candidateDir, additionalBundleDirs = [], outputDir, trustedKeysFile, publishedAt, environment = "production" }) {
  // 仅生产候选时加载桌面构建入口；离线校验不加载安装器或 Desktop dist。
  const { verifyPreparedRelease } = await import("../../apps/desktop/scripts/prepare-release.mjs");
  environment = readDesktopReleaseEnvironment(environment);
  if (!Array.isArray(additionalBundleDirs) || additionalBundleDirs.length > 2 || environment === "production" && additionalBundleDirs.length !== 2) {
    throw new Error("DESKTOP_PUBLICATION_THREE_PLATFORMS_REQUIRED");
  }
  candidateDir = await fs.realpath(candidateDir); outputDir = await resolveOutput(outputDir); trustedKeysFile = await fs.realpath(trustedKeysFile);
  const sources = [path.join(candidateDir, "bundle"), ...await Promise.all(additionalBundleDirs.map(directory => fs.realpath(directory)))];
  if ([candidateDir, trustedKeysFile, ...sources].some(input => contains(input, outputDir) || contains(outputDir, input))) throw new Error("DESKTOP_PUBLICATION_OUTPUT_OVERLAP");
  const candidate = await verifyPreparedRelease({ directory: candidateDir }), trustedKeys = assertTrustedReleaseKeys(await readJson(trustedKeysFile));
  const manifests = [];
  let requiredRuntime;
  for (const source of sources) {
    const { manifest, runtime } = await verifyArchive(source, trustedKeys, requiredRuntime);
    requiredRuntime ??= runtime;
    manifests.push(manifest);
  }
  if (await exists(outputDir)) {
    const existing = await verifyPreparedPublication({ outputDir, trustedKeysFile, environment });
    if (!same(existing.publishInput, publishInput(manifests, publishedAt ?? existing.publishInput.publishedAt, environment))
      || !same(await readJson(path.join(candidateDir, "candidate.json")), await readJson(path.join(outputDir, "candidate.json")))) throw new Error("DESKTOP_PUBLICATION_REPLAY_CONFLICT");
    return existing;
  }
  const input = publishInput(manifests, publishedAt ?? Date.now(), environment);
  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  const staging = await fs.mkdtemp(`${outputDir}.build-`);
  try {
    for (const [index, manifest] of manifests.entries()) {
      const target = path.join(staging, "artifacts", manifest.archiveSha256); await fs.mkdir(target, { recursive: true });
      for (const name of ["manifest.json", "bundle.tar.gz"]) await fs.copyFile(path.join(sources[index], name), path.join(target, name));
    }
    const fullInstaller = { schemaVersion: 1, kind: "full-installer", releaseId: input.releaseId, version: candidate.metadata.version,
      platform: "win32", arch: "x64", fileName: `CodeFlowAI-${publicVersion(candidate)}-win32-x64.exe`,
      size: candidate.installer.size, sha256: candidate.installer.sha256, publishedAt: input.publishedAt };
    const installerDirectory = path.join(staging, "installers", fullInstaller.sha256); await fs.mkdir(installerDirectory, { recursive: true });
    await fs.copyFile(path.join(candidateDir, candidate.installer.path), path.join(installerDirectory, fullInstaller.fileName));
    await fs.mkdir(path.join(staging, "release-notes"));
    await fs.copyFile(path.join(candidateDir, "release-notes.md"), path.join(staging, "release-notes", `${candidate.metadata.version}.md`));
    await fs.copyFile(path.join(candidateDir, "candidate.json"), path.join(staging, "candidate.json"));
    for (const [name, value] of [["publish-input.json", input], ["full-installer.json", fullInstaller]]) await fs.writeFile(path.join(staging, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const result = await verifyPreparedPublication({ outputDir: staging, trustedKeysFile, environment });
    await fs.rename(staging, outputDir);
    return result;
  } catch (error) {
    try { await fs.rm(staging, { recursive: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "DESKTOP_PUBLICATION_BUILD_CLEANUP_FAILED"); }
    throw error;
  }
}

/** 保留既有命令参数；入口包装不承担验证或发布副作用。 */
export async function runPublicationCli(argv = process.argv.slice(2)) {
  const requestId = crypto.randomUUID();
  try {
    const args = argv, test = args[0] === "--test";
    const values = test ? args.slice(1) : args;
    const [candidateDir, second, third, fourth, fifth, ...extra] = values;
    if (!third || extra.length || test && values.length > 5 || !test && values.length !== 5) {
      throw new Error("用法：prepare-publication.mjs <candidate> <mac-x64-bundle> <mac-arm64-bundle> <output> <trust.json>；测试：--test <candidate> <output> <trust.json> [其他平台包...]");
    }
    const result = await preparePublication({ candidateDir, additionalBundleDirs: test ? values.slice(3) : [second, third],
      outputDir: test ? second : fourth, trustedKeysFile: test ? third : fifth, environment: test ? "test" : "production" });
    console.log(JSON.stringify({ code: "DESKTOP_PUBLICATION_PREPARED", requestId, ...result, applied: false }));
  } catch (error) {
    console.error(JSON.stringify({ code: "DESKTOP_PUBLICATION_FAILED", requestId, rootCause: error.message })); process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runPublicationCli();
