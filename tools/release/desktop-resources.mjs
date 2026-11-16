import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runTar } from "../../apps/desktop/scripts/tar.mjs";
import pnpmCommand from "./pnpm-command.cjs";

/** 当前构建机必须与目标平台一致；arm64-only 阶段拒绝在 arm64 Mac 上伪造 x64。 */
export function currentDesktopPlatform() {
  if (process.platform === "win32" && process.arch === "x64") return { platform: "win32", arch: "x64", key: "win32/x64" };
  if (process.platform === "darwin" && process.arch === "arm64") return { platform: "darwin", arch: "arm64", key: "darwin/arm64" };
  throw new Error(`DESKTOP_BUILD_PLATFORM_UNSUPPORTED: ${process.platform}/${process.arch}`);
}

/** 按环境固定账号域名；测试遵循 HTTP/WS，生产继续使用 TLS。 */
export function resolveDesktopWebBuildEnv(plan, baseEnv = process.env) {
  const origins = { test: "ws://codeflow-test.hanshangai.com", production: "wss://codeflow.hanshangai.com" };
  const origin = origins[plan.environment];
  if (!origin) throw new Error("DESKTOP_WEB_BUILD_ENVIRONMENT_INVALID");
  const env = { ...baseEnv, VITE_CODEFLOWAI_SERVER_WS_ORIGIN: origin };
  delete env.VITE_AIDT_CODE_SERVER_WS_ORIGIN;
  return env;
}

/** Windows 的 pnpm/npm 是 .cmd；显式选择可执行名，其他命令保持原样。 */
function executableName(command) {
  return process.platform === "win32" && ["pnpm", "npm"].includes(command) ? `${command}.cmd` : command;
}

/** 执行构建命令；非零退出立即失败，不吞掉原始输出。 */
function run(command, args, options = {}) {
  if (command === "pnpm") {
    const resolved = pnpmCommand.resolvePnpmCommand();
    const result = spawnSync(resolved.command, [...resolved.prefixArgs, ...args], { stdio: "inherit", ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`DESKTOP_BUILD_COMMAND_FAILED: pnpm exit=${result.status}`);
    return;
  }
  const needsShell = process.platform === "win32" && ["pnpm", "npm"].includes(command);
  const result = spawnSync(executableName(command), args, { stdio: "inherit", shell: needsShell, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`DESKTOP_BUILD_COMMAND_FAILED: ${command} ${args.join(" ")} exit=${result.status}`);
}

/** 用 pnpm deploy 生成带 node_modules 的 Client 归档，根目录固定为 package/。 */
async function createClientArchive(root, work) {
  const packRoot = path.join(work, "client-pack");
  const packageDir = path.join(packRoot, "package");
  await fs.mkdir(packRoot, { recursive: true });
  run("pnpm", ["--filter", "@codeflowai/client", "deploy", "--prod", "--legacy", "--node-linker=hoisted", packageDir.replaceAll("\\", "/")], { cwd: root });
  const archive = path.join(work, "client.tgz");
  runTar(["-czf", archive, "-C", packRoot, "package"]);
  return archive;
}

/** 安装固定 npm 运行时，供资源准备脚本打进桌面 client。 */
async function ensureNpmRuntime(work) {
  const prefix = path.join(work, "npm12");
  run("npm", ["install", "--prefix", prefix.replaceAll("\\", "/"), "--no-package-lock", "--no-fund", "--no-audit", "npm@12.2.2"], { cwd: work });
  const packageFile = path.join(prefix, "node_modules/npm/package.json");
  const version = JSON.parse(await fs.readFile(packageFile, "utf8")).version;
  if (version !== "12.2.2") throw new Error(`DESKTOP_NPM_RUNTIME_VERSION_INVALID: ${version}`);
  return path.join(prefix, "node_modules/npm");
}

/** 构建当前平台的签名资源包；资源模式不生成安装器，安装器/DMG 由独立命令追加。 */
export async function buildDesktopResources({ root, plan, outputDir, privateKeyFile, trustedReleaseKeysFile, updateServerOrigin = undefined, build = true, npmPackageDir = null, clientArchive = null }) {
  const target = currentDesktopPlatform();
  if (!plan.platformSet.includes(target.key)) throw new Error(`DESKTOP_PLAN_PLATFORM_MISSING: ${target.key}`);
  await fs.access(privateKeyFile);
  await fs.access(trustedReleaseKeysFile);
  if (build) {
    run("pnpm", ["-C", "packages/shared", "build"], { cwd: root });
    run("pnpm", ["-C", "apps/desktop/client", "build"], { cwd: root, env: { ...process.env,
      CODEFLOWAI_CLIENT_BUILD_VERSION: plan.clientVersion,
      CODEFLOWAI_CLIENT_BUILD_TARGET: plan.environment === "test" ? "test" : "prod",
    } });
    run("pnpm", ["-C", "apps/desktop", "build"], { cwd: root });
    run("pnpm", ["-C", "apps/web", "build"], { cwd: root, env: resolveDesktopWebBuildEnv(plan) });
  }
  /** shared 构建完成后再加载资源准备模块，避免干净检出时提前解析 dist。 */
  const { prepareDesktopResources } = await import("../../apps/desktop/scripts/prepare-resources.mjs");
  const { buildReleaseBundle } = await import("../../apps/desktop/scripts/build-release-bundle.mjs");
  await fs.mkdir(outputDir, { recursive: true });
  const workRoot = path.join(root, "release");
  await fs.mkdir(workRoot, { recursive: true });
  const work = await fs.mkdtemp(path.join(workRoot, ".desktop-release-work-"));
  try {
    const archive = clientArchive ?? await createClientArchive(root, work);
    const npmDir = npmPackageDir ?? await ensureNpmRuntime(work);
    const common = {
      archive, clientDir: path.join(root, "apps/desktop/client"), webDir: path.join(root, "apps/web/dist"),
      npmPackageDir: npmDir, trustedReleaseKeysFile, updateServerOrigin, expectedClientVersion: plan.clientVersion,
    };
    const first = path.join(work, "resources-first");
    await prepareDesktopResources({ ...common, outputDir: first });
    const bundle = await buildReleaseBundle({
      resourcesDir: first,
      outputDir: path.join(outputDir, "bundle"),
      privateKeyFile,
      metadata: {
        releaseId: plan.releaseId, version: plan.version, webVersion: plan.webVersion, clientVersion: plan.clientVersion,
        protocolVersion: plan.protocolVersion, capabilityVersion: plan.capabilityVersion, dbSchemaVersion: plan.dbSchemaVersion,
        platform: target.platform, arch: target.arch, keyId: plan.keyId, createdAt: new Date().toISOString(), expiresAt: plan.expiresAt,
      },
    });
    await prepareDesktopResources({ ...common, outputDir: path.join(outputDir, "resources"), baselineReleaseManifestFile: path.join(bundle.outputDir, "manifest.json") });
    return { target, outputDir, bundleDir: bundle.outputDir, resourcesDir: path.join(outputDir, "resources") };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
