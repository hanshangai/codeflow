import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatDesktopVersion } from "@codeflowai/shared";
import { assertTrustedReleaseKeys, readReleaseBundleFiles, verifyReleaseBundlePayload } from "@codeflowai/shared/desktop-release-signing";
import releaseVersioning from "../../../tools/release/release-versioning.cjs";
import { buildReleaseBundle } from "./build-release-bundle.mjs";
import { readDesktopReleasePlan } from "../../../tools/release/desktop-release-plan.mjs";

const defaultDesktopDir = fileURLToPath(new URL("..", import.meta.url));
const reservedMetadata = ["releaseId", "version", "createdAt", "schemaVersion", "files", "signature", "webSha256", "clientSha256", "packageSha256", "archiveSha256", "archiveSize"];

/** JSON 和工件均严格解码/读取；不存在只用于明确的可选事实。 */
async function readJson(file) { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file))); }

/** 只有 ENOENT 表示尚未生成，权限及其他磁盘错误继续抛出。 */
async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/** 摘要绑定文件字节，拒绝链接和非普通文件。 */
async function fileDigest(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("DESKTOP_CANDIDATE_FILE_INVALID");
  const bytes = await fs.readFile(file);
  return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
}

/** 稳定键序让等价 JSON 配置复用相同候选。 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** 原子替换候选进度；失败不留下伪成功，并显式报告清理错误。 */
async function writeJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, file);
  } catch (error) {
    try { await fs.rm(temporary, { force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "DESKTOP_CANDIDATE_WRITE_CLEANUP_FAILED"); }
    throw error;
  }
}

/** 保留不存在的尾段并解析祖先链接，防止输出别名覆盖输入。 */
async function resolveOutput(directory) {
  const tail = [];
  for (let current = path.resolve(directory);;) {
    try { return path.join(await fs.realpath(current), ...tail); }
    catch (error) {
      if (error.code !== "ENOENT" || path.dirname(current) === current) throw error;
      tail.unshift(path.basename(current)); current = path.dirname(current);
    }
  }
}

/** 输入与输出不能互相包含。 */
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** 记录壳实际构建输入；资源独立计算，避免 dist/resources 重复进入指纹。 */
async function shellInputs(desktopDir) {
  const files = [];
  /** 递归绑定实际编译输出和安装配置，不跟随目录链接。 */
  const visit = async relative => {
    const file = path.join(desktopDir, relative), stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error("DESKTOP_CANDIDATE_SHELL_LINK_INVALID");
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) if (`${relative}/${name}` !== "dist/resources") await visit(`${relative}/${name}`);
    } else files.push({ path: relative, ...await fileDigest(file) });
  };
  for (const relative of ["package.json", "electron-builder.yml", "dist", "build"]) await visit(relative);
  return files;
}

/** 复用签名库存口径，并绑定安装配置与信任根。 */
async function resourceInputs(resourcesDir) {
  const files = await readReleaseBundleFiles(resourcesDir);
  for (const relative of ["release-trust.json", "desktop-update.json"]) {
    if (relative === "desktop-update.json" && !await exists(path.join(resourcesDir, relative))) continue;
    files.push({ path: relative, ...await fileDigest(path.join(resourcesDir, relative)) });
  }
  return files;
}

/** 日期目录是唯一占号事实；仅缺记录表示分配中断，已存在的坏记录必须失败。 */
async function readAllocations(outputRoot) {
  const records = [], incomplete = [], versions = [];
  for (const name of (await fs.readdir(outputRoot)).sort()) if (/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(name)) {
    const directory = path.join(outputRoot, name), entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("DESKTOP_CANDIDATE_ALLOCATION_INVALID");
    versions.push(name);
    const recordFile = path.join(directory, "candidate.json");
    if (!await exists(recordFile)) {
      const entries = await fs.readdir(directory);
      if (entries.some(entry => entry !== "events.jsonl" && !/^candidate\.json\..+\.tmp$/.test(entry))) throw new Error("DESKTOP_CANDIDATE_RECORD_MISSING");
      incomplete.push(name); continue;
    }
    const candidate = await readJson(recordFile);
    if (candidate.schemaVersion !== 1 || candidate.metadata?.version !== name) throw new Error("DESKTOP_CANDIDATE_RECORD_INVALID");
    records.push(candidate);
  }
  return { records, incomplete, versions };
}

/** 默认真实调用原本地 NSIS 构建入口，明确关闭发布并核对结构化结果。 */
async function buildInstaller({ resourcesDir, outputDir, desktopDir, planFile, allowDirty }) {
  const result = spawnSync(process.execPath, [path.join(desktopDir, "scripts/package-local-win.mjs"), resourcesDir, outputDir,
    "--require-baseline-proof", "--target", "nsis", ...(planFile ? ["--plan", planFile] : []), ...(allowDirty ? ["--allow-dirty"] : [])],
    { cwd: desktopDir, encoding: "utf8", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`DESKTOP_CANDIDATE_INSTALLER_FAILED: ${result.stderr || result.stdout}`);
  const ready = result.stdout.split(/\r?\n/).filter(line => line.startsWith("{")).map(line => JSON.parse(line))
    .find(entry => entry.code === "DESKTOP_LOCAL_PACKAGE_READY");
  if (!ready || ready.published !== false || ready.target !== "win32-x64-nsis") throw new Error("DESKTOP_CANDIDATE_INSTALLER_RESULT_INVALID");
  return ready;
}

/** 默认重验实际壳 Node/ABI；原资源准备入口拥有具体原生依赖规则。 */
async function verifyRuntime(input) {
  const { verifyDesktopClientRuntime } = await import("./prepare-resources.mjs");
  return await verifyDesktopClientRuntime({ clientDir: path.join(input.resourcesDir, "client") });
}

/** 安装器构建前和完整复验共用同一资源、签名、压缩包及日志检查。 */
async function verifyCandidatePayload(directory, record) {
  const resourcesDir = path.join(directory, "installation-resources");
  const manifest = await readJson(path.join(directory, "bundle/manifest.json"));
  const trustedKeys = assertTrustedReleaseKeys(await readJson(path.join(resourcesDir, "release-trust.json")));
  await verifyReleaseBundlePayload({ directory: resourcesDir, manifest, trustedKeys, platform: record.metadata.platform,
    arch: record.metadata.arch, requireHeldStartup: true, requireFresh: true });
  if (Object.entries(record.metadata).some(([key, value]) => manifest[key] !== value)
    || JSON.stringify(await readJson(path.join(resourcesDir, "baseline-release-manifest.json"))) !== JSON.stringify(manifest)) {
    throw new Error("DESKTOP_CANDIDATE_MANIFEST_MISMATCH");
  }
  const artifacts = [["bundle/bundle.tar.gz", { sha256: manifest.archiveSha256, size: manifest.archiveSize }], ["release-notes.md", record.notes]];
  if (record.installer) artifacts.push([record.installer.path, record.installer]);
  for (const [relative, expected] of artifacts) {
    if (!relative || path.isAbsolute(relative) || !contains(path.resolve(directory), path.resolve(directory, relative))) throw new Error("DESKTOP_CANDIDATE_ARTIFACT_PATH_INVALID");
    const actual = await fileDigest(path.join(directory, relative));
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) throw new Error(`DESKTOP_CANDIDATE_ARTIFACT_MISMATCH: ${relative}`);
  }
  if (JSON.stringify(await resourceInputs(resourcesDir)) !== JSON.stringify(record.resources)) throw new Error("DESKTOP_CANDIDATE_RESOURCES_MISMATCH");
}

/** 复验同候选的完整工件；展示号只从实际壳与签名资源版本临时计算。 */
export async function verifyPreparedRelease({ directory }) {
  const record = await readJson(path.join(directory, "candidate.json"));
  if (record.schemaVersion !== 1 || !record.installer) throw new Error("DESKTOP_CANDIDATE_NOT_READY");
  await verifyCandidatePayload(directory, record);
  return { ...record, directory, displayVersion: formatDesktopVersion(record.shellVersion, record.metadata.version) };
}

/** 创建或继续本地候选：一次分配编号，内容变化须 --new，失败重试保留原事实与现场。 */
export async function prepareRelease({ resourcesDir, outputRoot, metadata, privateKeyFile, notesFile, newCandidate = false,
  now = new Date(), baselineVersion, desktopDir = defaultDesktopDir, packageInstaller = buildInstaller, validateRuntime = verifyRuntime,
  planFile, planRoot, allowDirty = false }) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || reservedMetadata.some(key => Object.hasOwn(metadata, key))) {
    throw new Error("DESKTOP_CANDIDATE_METADATA_RESERVED");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("DESKTOP_CANDIDATE_DATE_INVALID");
  if (metadata.platform !== "win32" || metadata.arch !== "x64") throw new Error("DESKTOP_CANDIDATE_WINDOWS_X64_REQUIRED");
  resourcesDir = await fs.realpath(resourcesDir); desktopDir = await fs.realpath(desktopDir);
  outputRoot = await resolveOutput(outputRoot); privateKeyFile = await fs.realpath(privateKeyFile);
  if (contains(resourcesDir, privateKeyFile)) throw new Error("DESKTOP_RELEASE_PRIVATE_KEY_INSIDE_RESOURCES");
  if ([desktopDir, outputRoot].some(directory => contains(directory, privateKeyFile))) throw new Error("DESKTOP_CANDIDATE_PRIVATE_KEY_INSIDE_INPUT_OR_OUTPUT");
  if ([resourcesDir, desktopDir].some(input => contains(input, outputRoot) || contains(outputRoot, input))) throw new Error("DESKTOP_CANDIDATE_OUTPUT_OVERLAP");
  const plan = planFile ? await readDesktopReleasePlan({ root: planRoot ?? path.resolve(desktopDir, "../.."), file: planFile, allowDirty }) : undefined;
  if (plan && (plan.keyId !== metadata.keyId || !plan.platformSet.includes(`${metadata.platform}/${metadata.arch}`))) throw new Error("DESKTOP_CANDIDATE_PLAN_METADATA_MISMATCH");
  const shellVersion = plan?.shellVersion ?? (await readJson(path.join(desktopDir, "package.json"))).version;
  if (typeof shellVersion !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(shellVersion)) throw new Error("DESKTOP_SHELL_VERSION_INVALID");
  const resources = await resourceInputs(resourcesDir), shell = await shellInputs(desktopDir), notes = await fileDigest(notesFile);
  const keyBytes = await fs.readFile(privateKeyFile), keySha256 = crypto.createHash("sha256").update(keyBytes).digest("hex");
  if ([...resources, ...shell].some(file => file.sha256 === keySha256)) throw new Error("DESKTOP_CANDIDATE_PRIVATE_KEY_INSIDE_INPUT_OR_OUTPUT");
  if (notes.sha256 === keySha256) throw new Error("DESKTOP_CANDIDATE_PRIVATE_KEY_AS_NOTES");
  if (!notes.size) throw new Error("DESKTOP_CANDIDATE_NOTES_REQUIRED");
  const trustedKeys = assertTrustedReleaseKeys(await readJson(path.join(resourcesDir, "release-trust.json")));
  const key = crypto.createPrivateKey(keyBytes), publicKey = crypto.createPublicKey(key);
  if (key.asymmetricKeyType !== "ed25519" || !trustedKeys[metadata.keyId]
    || !publicKey.equals(trustedKeys[metadata.keyId])) throw new Error("DESKTOP_CANDIDATE_SIGNING_KEY_MISMATCH");
  await validateRuntime({ resourcesDir });
  const inputFingerprint = crypto.createHash("sha256").update(JSON.stringify(canonical({ resources, shell, notes, metadata, plan,
    publicKey: publicKey.export({ type: "spki", format: "pem" }) }))).digest("hex");
  baselineVersion ??= (await readJson(new URL("../../../package.json", import.meta.url))).version;
  releaseVersioning.resolveReleaseVersionBaseline(baselineVersion, null);
  await fs.mkdir(outputRoot, { recursive: true });
  const lockPath = path.join(outputRoot, ".prepare.lock"), lock = await fs.open(lockPath, "wx");
  let directory, failure;
  const requestId = crypto.randomUUID();
  const log = async event => await fs.appendFile(path.join(directory, "events.jsonl"), `${JSON.stringify({ requestId, at: new Date().toISOString(), ...event })}\n`, "utf8");
  try {
    const { records, incomplete, versions } = await readAllocations(outputRoot);
    // 同指纹候选按内部版本数字比较，避免 .100 在目录字典序中落到 .99 之前。
    let record;
    if (!newCandidate) for (const candidate of records) {
      if (candidate.inputFingerprint === inputFingerprint && (!record
        || releaseVersioning.resolveReleaseVersionBaseline(record.metadata.version, candidate.metadata.version) === candidate.metadata.version)) record = candidate;
    }
    if (!record && records.length && !newCandidate) throw new Error("DESKTOP_CANDIDATE_INPUT_CHANGED: use --new");
    if (!record) {
      let baseline = baselineVersion;
      for (const version of versions) baseline = releaseVersioning.resolveReleaseVersionBaseline(baseline, version);
      const today = releaseVersioning.formatDateVersionPrefix(now);
      if (today < baseline.slice(0, 10)) throw new Error("DESKTOP_CANDIDATE_CLOCK_BEHIND");
      const version = plan?.version ?? releaseVersioning.computeNextReleaseVersion(baseline, now);
      record = { schemaVersion: 1, inputFingerprint, shellVersion,
        ...(plan ? { sourceCommit: plan.sourceCommit, shellInputFingerprint: plan.shellInputFingerprint } : {}),
        metadata: { ...metadata, ...(plan ? { webVersion: plan.webVersion, clientVersion: plan.clientVersion, dbSchemaVersion: plan.dbSchemaVersion } : {}),
          releaseId: `desktop-${version}`, version, createdAt: plan?.createdAt ?? now.toISOString() }, resources, notes, installer: null };
      directory = path.join(outputRoot, version);
      await fs.mkdir(directory);
      await writeJson(path.join(directory, "candidate.json"), record);
    } else directory = path.join(outputRoot, record.metadata.version);
    if (incomplete.length) await log({ code: "DESKTOP_CANDIDATE_ALLOCATION_INCOMPLETE", reservedVersions: incomplete });
    await log({ code: "DESKTOP_CANDIDATE_STARTED", releaseId: record.metadata.releaseId });
    if (record.installer) return await verifyPreparedRelease({ directory });
    const bundleDir = path.join(directory, "bundle");
    if (!await exists(bundleDir)) await buildReleaseBundle({ resourcesDir, outputDir: bundleDir, metadata: record.metadata, privateKeyFile, requireHeldStartup: true });
    const manifest = await readJson(path.join(bundleDir, "manifest.json"));
    await verifyReleaseBundlePayload({ directory: resourcesDir, manifest, trustedKeys, platform: metadata.platform, arch: metadata.arch,
      requireHeldStartup: true, requireFresh: true });
    const installationResources = path.join(directory, "installation-resources");
    if (!await exists(installationResources)) {
      const staging = await fs.mkdtemp(path.join(directory, "resources-attempt-"));
      for (const relative of ["web", "client", "release-trust.json", "desktop-update.json"]) {
        if (relative === "desktop-update.json" && !await exists(path.join(resourcesDir, relative))) continue;
        await fs.cp(path.join(resourcesDir, relative), path.join(staging, relative), { recursive: true, errorOnExist: true, force: false });
      }
      await fs.writeFile(path.join(staging, "baseline-release-manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
      await fs.rename(staging, installationResources);
    }
    if (JSON.stringify(await resourceInputs(installationResources)) !== JSON.stringify(resources)) throw new Error("DESKTOP_CANDIDATE_RESOURCES_MISMATCH");
    if (!await exists(path.join(directory, "release-notes.md"))) await fs.copyFile(notesFile, path.join(directory, "release-notes.md"));
    await verifyCandidatePayload(directory, record);
    const attempts = (await fs.readdir(directory)).filter(name => /^installer-attempt-\d+$/.test(name)).map(name => Number(name.slice(18)));
    const outputDir = path.join(directory, `installer-attempt-${Math.max(0, ...attempts) + 1}`);
    const result = await packageInstaller({ resourcesDir: installationResources, outputDir, desktopDir, planFile, allowDirty });
    const displayVersion = formatDesktopVersion(shellVersion, record.metadata.version);
    if (result.shellVersion !== shellVersion || result.displayVersion !== displayVersion
      || !result.installer || !contains(outputDir, path.resolve(result.installer))) throw new Error("DESKTOP_CANDIDATE_INSTALLER_RESULT_INVALID");
    if (JSON.stringify(await shellInputs(desktopDir)) !== JSON.stringify(shell)) throw new Error("DESKTOP_CANDIDATE_INPUT_CHANGED_DURING_BUILD");
    record.installer = { path: path.relative(directory, result.installer).replaceAll(path.sep, "/"), ...await fileDigest(result.installer) };
    await writeJson(path.join(directory, "candidate.json"), record);
    const verified = await verifyPreparedRelease({ directory });
    await log({ code: "DESKTOP_CANDIDATE_READY", releaseId: record.metadata.releaseId, published: false });
    return verified;
  } catch (error) {
    failure = error;
    if (directory) {
      try { await log({ code: "DESKTOP_CANDIDATE_FAILED", releaseId: path.basename(directory), rootCause: error.message }); }
      catch (logging) { throw new AggregateError([error, logging], "DESKTOP_CANDIDATE_ERROR_LOG_FAILED"); }
    }
    throw error;
  } finally {
    try { await lock.close(); await fs.unlink(lockPath); }
    catch (cleanup) { throw failure ? new AggregateError([failure, cleanup], "DESKTOP_CANDIDATE_LOCK_CLEANUP_FAILED") : cleanup; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    let result;
    if (args[0] === "--verify" && args.length === 2) result = await verifyPreparedRelease({ directory: path.resolve(args[1]) });
    else {
      const [resourcesDir, outputRoot, metadataFile, privateKeyFile, notesFile, ...options] = args;
      let newCandidate = false, planFile, allowDirty = false;
      for (let index = 0; index < options.length; index++) {
        if (options[index] === "--new" && !newCandidate) newCandidate = true;
        else if (options[index] === "--allow-dirty" && !allowDirty) allowDirty = true;
        else if (options[index] === "--plan" && !planFile && options[index + 1] && !options[index + 1].startsWith("--")) planFile = path.resolve(options[++index]);
        else throw new Error("DESKTOP_CANDIDATE_ARGUMENT_INVALID");
      }
      if (!notesFile) throw new Error("用法：prepare-release.mjs <resources> <candidate-root> <metadata.json> <private-key.pem> <notes.md> [--new] [--plan <file>] [--allow-dirty]；复验：--verify <candidate-dir>");
      result = await prepareRelease({ resourcesDir, outputRoot, metadata: await readJson(metadataFile), privateKeyFile, notesFile, newCandidate, planFile, allowDirty });
    }
    console.log(JSON.stringify({ code: "DESKTOP_CANDIDATE_READY", directory: result.directory, version: result.metadata.version,
      displayVersion: result.displayVersion, shellVersion: result.shellVersion, published: false }));
  } catch (error) {
    console.error(JSON.stringify({ code: "DESKTOP_CANDIDATE_FAILED", requestId: crypto.randomUUID(), rootCause: error.message }));
    process.exitCode = 1;
  }
}
