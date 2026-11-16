import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { assertTrustedReleaseKeys, verifyReleaseBundlePayload } from "@codeflowai/shared/desktop-release-signing";
import { runTar } from "./tar.mjs";
import { copyNpmPackage } from "./cli-runtime-resources.mjs";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 用目标壳内置 Node 实际加载包内依赖，复用现有原生自检并返回可签名的兼容事实。 */
export async function verifyDesktopClientRuntime({ clientDir, runtimeExecutable, expectedClientVersion }) {
  const directory = await fs.realpath(clientDir);
  const executable = runtimeExecutable ?? createRequire(import.meta.url)("electron");
  const probe = `
    import fs from "node:fs";
    import path from "node:path";
    import { createRequire } from "node:module";
    import { pathToFileURL } from "node:url";
    const packageFile = process.argv[1], requireClient = createRequire(packageFile);
    const manifest = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    const modules = fs.realpathSync(path.join(path.dirname(packageFile), "node_modules"));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const resolved = fs.realpathSync(requireClient.resolve(dependency));
      const relative = path.relative(modules, resolved);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        throw new Error("DESKTOP_CLIENT_DEPENDENCY_OUTSIDE_PACKAGE: " + dependency);
      }
      await import(pathToFileURL(resolved).href);
    }
    process.stdout.write("\\n" + JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch,
      nodeMajor: Number(process.versions.node.split(".")[0]), modules: process.versions.modules }) + "\\n");
  `;
  /** 子进程错误、非零退出与超时均显式失败，保留目标运行时的原始诊断。 */
  const probeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete probeEnv.CODEFLOWAI_VERSION;
  const run = args => {
    const result = spawnSync(executable, args, { cwd: directory, encoding: "utf8", windowsHide: true,
      env: probeEnv, timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw Object.assign(new Error(`DESKTOP_CLIENT_RUNTIME_INCOMPATIBLE: ${result.stderr?.trim() || result.error?.message || `exit=${result.status}, signal=${result.signal}`}`,
        result.error ? { cause: result.error } : undefined), { code: "DESKTOP_CLIENT_RUNTIME_INCOMPATIBLE" });
    }
    return result.stdout;
  };
  const runtime = JSON.parse(run(["--input-type=module", "--eval", probe, path.join(directory, "package.json")]).trim().split(/\r?\n/u).at(-1));
  if (expectedClientVersion !== undefined) {
    const actual = run([path.join(directory, "dist", "index.cjs"), "--version"]).trim();
    if (!expectedClientVersion || actual !== expectedClientVersion) {
      throw Object.assign(new Error(`DESKTOP_CLIENT_VERSION_MISMATCH: expected=${expectedClientVersion}, actual=${actual}`),
        { code: "DESKTOP_CLIENT_VERSION_MISMATCH" });
    }
  }
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  const nativeDependencies = ["node-pty", "@napi-rs/keyring"].filter(dependency => dependency in (manifest.dependencies ?? {}));
  if (nativeDependencies.length) run([path.join(directory, "scripts", "verify-bundled-native.mjs"), ...nativeDependencies]);
  let marker;
  try { marker = await fs.readFile(path.join(directory, "desktop-runtime.json")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (marker) assert.deepEqual(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(marker)), runtime, "DESKTOP_CLIENT_RUNTIME_INCOMPATIBLE");
  return runtime;
}

/** 清单校验失败统一错误码；与打包预检的其他错误保持同一 code 语义。 */
const CLI_RUNTIME_MANIFEST_INVALID = "DESKTOP_CLI_RUNTIME_MANIFEST_INVALID";
/** 与 Client 解析器一致：只接受带数字段的精确 semver，拒绝 latest、范围和标签。 */
const EXACT_SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
/** 每个引擎绑定的唯一 npm 包，避免打包清单把包名与引擎错配。 */
const CLI_RUNTIME_ENGINE_PACKAGES = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

/** 构造带稳定 code 的清单错误，调用方不依赖错误 message 判断类型。 */
function cliRuntimeManifestError(message) {
  return Object.assign(new Error(`${CLI_RUNTIME_MANIFEST_INVALID}: ${message}`), { code: CLI_RUNTIME_MANIFEST_INVALID });
}

/** 按白名单读取普通 JSON 对象：拒绝数组、多余字段和缺失字段。 */
function readExactKeys(value, keys, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw cliRuntimeManifestError(`${label} must be a plain object`);
  }
  const names = Object.keys(value);
  if (names.length !== keys.length || keys.some(key => !names.includes(key))) {
    throw cliRuntimeManifestError(`${label} has unexpected or missing keys`);
  }
  return value;
}

/** 校验单个引擎条目：包名绑定、版本精确、体积为正整数。 */
function parseCliRuntimeManifestEntry(value, engine) {
  const entry = readExactKeys(value, ["npmPackage", "version", "estimatedBytes"], `engines.${engine}`);
  if (entry.npmPackage !== CLI_RUNTIME_ENGINE_PACKAGES[engine]) {
    throw cliRuntimeManifestError(`engines.${engine}.npmPackage is not the expected package`);
  }
  if (typeof entry.version !== "string" || !EXACT_SEMVER_PATTERN.test(entry.version)) {
    throw cliRuntimeManifestError(`engines.${engine}.version must be an exact semver version`);
  }
  if (typeof entry.estimatedBytes !== "number" || !Number.isSafeInteger(entry.estimatedBytes) || entry.estimatedBytes <= 0) {
    throw cliRuntimeManifestError(`engines.${engine}.estimatedBytes must be a positive integer`);
  }
  return entry;
}

/** 清单读取失败统一转换为桌面错误码，同时保留原始根因。 */
async function readCliRuntimeManifest(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    throw Object.assign(new Error(`DESKTOP_CLI_RUNTIME_MANIFEST_INVALID: ${error.message}`), { code: "DESKTOP_CLI_RUNTIME_MANIFEST_INVALID", cause: error });
  }
}

/** 清单必须为严格 UTF-8 JSON，并按 Client 解析器同等的严格字段规则校验。 */
function parseCliRuntimeManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw Object.assign(new Error(`DESKTOP_CLI_RUNTIME_MANIFEST_INVALID: ${error.message}`), { code: "DESKTOP_CLI_RUNTIME_MANIFEST_INVALID", cause: error });
  }
  const record = readExactKeys(manifest, ["schemaVersion", "npm", "engines"], "manifest");
  if (record.schemaVersion !== 1) {
    throw cliRuntimeManifestError("schemaVersion must be 1");
  }
  const npm = readExactKeys(record.npm, ["version"], "npm");
  if (typeof npm.version !== "string" || !EXACT_SEMVER_PATTERN.test(npm.version)) {
    throw cliRuntimeManifestError("npm.version must be an exact semver version");
  }
  const engines = readExactKeys(record.engines, ["claude", "codex"], "engines");
  parseCliRuntimeManifestEntry(engines.claude, "claude");
  parseCliRuntimeManifestEntry(engines.codex, "codex");
  return manifest;
}

/** 组装完整资源与独立信任根；显式 baseline proof 经同 payload 校验后按原字节携带。 */
export async function prepareDesktopResources({ archive, clientDir, webDir, outputDir, trustedReleaseKeysFile, baselineReleaseManifestFile,
  updateServerOrigin, npmPackageDir, cliRuntimeManifestFile, runtimeExecutable, expectedClientVersion }) {
  if (updateServerOrigin !== undefined) {
    if (typeof updateServerOrigin !== "string" || !URL.canParse(updateServerOrigin)) throw new Error("DESKTOP_UPDATE_ORIGIN_INVALID");
    const origin = new URL(updateServerOrigin);
    if (origin.origin !== updateServerOrigin || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
      || origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("DESKTOP_UPDATE_ORIGIN_INVALID");
  }
  const rawTrust = trustedReleaseKeysFile ? JSON.parse(await fs.readFile(trustedReleaseKeysFile, "utf8")) : {};
  const trustedKeys = assertTrustedReleaseKeys(rawTrust);
  if (updateServerOrigin !== undefined && Object.keys(trustedKeys).length === 0) throw new Error("DESKTOP_UPDATE_TRUST_REQUIRED");
  for (const pem of Object.values(rawTrust)) {
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/u.test(pem)) {
      throw new Error("DESKTOP_RELEASE_TRUST_INVALID");
    }
  }
  const trust = Object.fromEntries(Object.entries(trustedKeys).map(([keyId, key]) => [keyId, key.export({ format: "pem", type: "spki" })]));
  const sourceManifest = JSON.parse(await fs.readFile(path.join(clientDir, "package.json"), "utf8"));
  await fs.access(path.join(clientDir, "dist", "index.cjs"));
  await fs.access(path.join(webDir, "index.html"));
  const { readDesktopBuiltinAssetBundles } = createRequire(import.meta.url)(path.resolve(clientDir, "dist", "orchAssetBundleValidation.cjs"));
  readDesktopBuiltinAssetBundles(path.join(clientDir, "dist", "orchestration-builtin"));
  const entries = runTar(["-tzf", archive], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim().split(/\r?\n/);
  if (entries.some((entry) => !entry.startsWith("package/") || entry.split("/").includes("..") || entry.includes("\\"))) {
    throw new Error("DESKTOP_CLIENT_ARCHIVE_INVALID");
  }
  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  try {
    await fs.access(outputDir);
    throw new Error("DESKTOP_RESOURCES_ALREADY_EXIST");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stagingDir = await fs.mkdtemp(`${outputDir}.prepare-`);
  try {
    const clientOutput = path.join(stagingDir, "client");
    await fs.mkdir(clientOutput);
    runTar(["-xzf", archive, "-C", clientOutput, "--strip-components=1", "--exclude=package/dist"], { stdio: "inherit" });
    const packagedManifest = JSON.parse(await fs.readFile(path.join(clientOutput, "package.json"), "utf8"));
    assert.equal(packagedManifest.name, "@codeflowai/client", "DESKTOP_CLIENT_PACKAGE_INVALID");
    assert.deepEqual(packagedManifest.dependencies, sourceManifest.dependencies, "DESKTOP_CLIENT_DEPENDENCIES_MISMATCH");
    await fs.cp(path.join(clientDir, "dist"), path.join(clientOutput, "dist"), { recursive: true, errorOnExist: true, force: false });
    const runtime = await verifyDesktopClientRuntime({ clientDir: clientOutput, runtimeExecutable, expectedClientVersion });
    await fs.writeFile(path.join(clientOutput, "desktop-runtime.json"), `${JSON.stringify(runtime)}\n`, { encoding: "utf8", flag: "wx" });
    readDesktopBuiltinAssetBundles(path.join(clientOutput, "dist", "orchestration-builtin"));
    await fs.cp(webDir, path.join(stagingDir, "web"), { recursive: true, errorOnExist: true, force: false });
    let resolvedNpmPackageDir;
    try {
      resolvedNpmPackageDir = npmPackageDir ?? (process.env.CODEFLOWAI_NPM_PACKAGE_DIR
        ? path.resolve(process.env.CODEFLOWAI_NPM_PACKAGE_DIR)
        : path.dirname(createRequire(import.meta.url).resolve("npm/package.json")));
    } catch (error) {
      throw Object.assign(new Error(`DESKTOP_NPM_PACKAGE_INVALID: ${error.message}`), { code: "DESKTOP_NPM_PACKAGE_INVALID", cause: error });
    }
    const cliRuntimeManifestBytes = await readCliRuntimeManifest(cliRuntimeManifestFile ?? path.join(desktopDir, "config/cli-runtime.json"));
    const cliRuntimeManifest = parseCliRuntimeManifest(cliRuntimeManifestBytes);
    await copyNpmPackage({ npmPackageDir: resolvedNpmPackageDir, targetDir: path.join(clientOutput, "npm"),
      expectedVersion: cliRuntimeManifest.npm.version });
    await fs.writeFile(path.join(clientOutput, "cli-runtime.json"), cliRuntimeManifestBytes, { flag: "wx" });
    await fs.writeFile(path.join(stagingDir, "release-trust.json"), `${JSON.stringify(trust)}\n`, "utf8");
    if (updateServerOrigin !== undefined) await fs.writeFile(path.join(stagingDir, "desktop-update.json"), `${JSON.stringify({ serverOrigin: updateServerOrigin })}\n`, "utf8");
    if (baselineReleaseManifestFile !== undefined) {
      const proof = await fs.readFile(baselineReleaseManifestFile);
      const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(proof));
      await verifyReleaseBundlePayload({ directory: stagingDir, manifest, trustedKeys, requireHeldStartup: true });
      await verifyDesktopClientRuntime({ clientDir: clientOutput, runtimeExecutable, expectedClientVersion: manifest.clientVersion });
      await fs.writeFile(path.join(stagingDir, "baseline-release-manifest.json"), proof, { flag: "wx" });
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(stagingDir, outputDir);
        break;
      } catch (error) {
        if (attempt >= 14) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  } catch (error) {
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "DESKTOP_RESOURCES_CLEANUP_FAILED");
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [archive, trustedReleaseKeysFile, baselineReleaseManifestFile, updateServerOrigin, ...extra] = process.argv.slice(2);
  if (!archive || extra.length) throw new Error("用法：prepare-resources.mjs <Client.tgz> [trusted-public-keys.json] [baseline-manifest.json] [update-server-origin]");
  await prepareDesktopResources({
    archive: path.resolve(archive), clientDir: path.resolve(desktopDir, "client"),
    webDir: path.resolve(desktopDir, "../web/dist"), outputDir: path.join(desktopDir, "dist/resources"),
    trustedReleaseKeysFile: trustedReleaseKeysFile ? path.resolve(trustedReleaseKeysFile) : undefined,
    baselineReleaseManifestFile: baselineReleaseManifestFile ? path.resolve(baselineReleaseManifestFile) : undefined,
    updateServerOrigin,
  });
}
