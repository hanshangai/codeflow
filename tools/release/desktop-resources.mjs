import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import pnpmCommand from "./pnpm-command.cjs";
import { defaultDesktopBuildCacheDir, desktopBuildCacheKey, materializeDesktopBuildCache } from "../../apps/desktop/scripts/desktop-build-cache.mjs";

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

/** 异步执行构建命令，用于互不依赖的 Client/Web 并行构建。 */
function runAsync(command, args, options = {}) {
  const resolved = command === "pnpm" ? pnpmCommand.resolvePnpmCommand() : { command: executableName(command), prefixArgs: [] };
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, [...resolved.prefixArgs, ...args], { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`DESKTOP_BUILD_COMMAND_FAILED: ${command} ${args.join(" ")} exit=${code}`)));
  });
}

/** 阶段日志只输出名称、耗时与缓存状态，不打印环境或签名材料。 */
async function phase(name, operation) {
  const started = performance.now();
  process.stderr.write(`${JSON.stringify({ code: "DESKTOP_BUILD_PHASE", phase: name, event: "start" })}\n`);
  try {
    const result = await operation();
    process.stderr.write(`${JSON.stringify({ code: "DESKTOP_BUILD_PHASE", phase: name, event: "complete", elapsedMs: Math.round(performance.now() - started),
      ...(typeof result?.hit === "boolean" ? { cache: result.hit ? "hit" : "miss" } : {}) })}\n`);
    return result;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: "DESKTOP_BUILD_PHASE_FAILED", phase: name, elapsedMs: Math.round(performance.now() - started) })}\n`);
    throw error;
  }
}

/** 运行时工具版本进入缓存键；版本探测失败不能继续复用旧工件。 */
async function buildToolchain(root) {
  const resolved = pnpmCommand.resolvePnpmCommand();
  const result = spawnSync(resolved.command, [...resolved.prefixArgs, "--version"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 || !/^\d+\.\d+\.\d+/u.test(result.stdout?.trim() ?? "")) throw new Error("DESKTOP_BUILD_PNPM_VERSION_FAILED");
  const electronFile = createRequire(path.join(root, "apps/desktop/package.json")).resolve("electron/package.json");
  const electron = JSON.parse(await fs.readFile(electronFile, "utf8")).version;
  if (!electron) throw new Error("DESKTOP_BUILD_ELECTRON_VERSION_INVALID");
  return { node: process.version, modules: process.versions.modules, pnpm: result.stdout.trim(), electron, platform: process.platform, arch: process.arch };
}

/** 缓存仅包含部署依赖与必要脚本；本轮 Client dist 由资源入口单独装配。 */
async function createClientPackage(root, work, cacheDir, context) {
  const destination = path.join(work, "client-package");
  const key = await desktopBuildCacheKey({ root, kind: "dependencies", context });
  await phase("client-dependencies", () => materializeDesktopBuildCache({ cacheDir, namespace: "dependencies", key, destination, build: async directory => {
    const deployed = path.join(work, "client-deploy");
    run("pnpm", ["--filter", "@codeflowai/client", "deploy", "--prod", "--legacy", "--node-linker=hoisted", deployed.replaceAll("\\", "/")], { cwd: root });
    await fs.mkdir(directory);
    for (const name of ["package.json", "node_modules", "scripts", "bin"]) {
      await fs.cp(path.join(deployed, name), path.join(directory, name), { recursive: true, errorOnExist: true, force: false });
    }
  } }));
  return destination;
}

/** 复用桌面锁定的 npm 运行时；缺失或版本不符显式失败，不临时联网安装。 */
async function ensureNpmRuntime(root) {
  const packageFile = createRequire(path.join(root, "apps/desktop/package.json")).resolve("npm/package.json");
  const manifest = JSON.parse(await fs.readFile(packageFile, "utf8"));
  if (manifest.name !== "npm" || manifest.version !== "12.2.2") throw new Error(`DESKTOP_NPM_RUNTIME_VERSION_INVALID: ${manifest.version}`);
  return path.dirname(packageFile);
}

/** 构建当前平台的签名资源包；资源模式不生成安装器，安装器/DMG 由独立命令追加。 */
export async function buildDesktopResources({ root, plan, outputDir, privateKeyFile, trustedReleaseKeysFile, updateServerOrigin = undefined, build = true, npmPackageDir = null,
  clientArchive = null, cacheDir = defaultDesktopBuildCacheDir() }) {
  const target = currentDesktopPlatform();
  if (!plan.platformSet.includes(target.key)) throw new Error(`DESKTOP_PLAN_PLATFORM_MISSING: ${target.key}`);
  await fs.access(privateKeyFile);
  await fs.access(trustedReleaseKeysFile);
  await fs.mkdir(outputDir, { recursive: true });
  const workRoot = path.join(root, "release");
  await fs.mkdir(workRoot, { recursive: true });
  const work = await fs.mkdtemp(path.join(workRoot, ".desktop-release-work-"));
  try {
    const context = build || !clientArchive ? await buildToolchain(root) : undefined;
    if (build) {
      await phase("shared", () => run("pnpm", ["-C", "packages/shared", "build"], { cwd: root }));
      const webEnv = resolveDesktopWebBuildEnv(plan);
      const webKey = await desktopBuildCacheKey({ root, kind: "web", context, env: webEnv });
      // 等待两个独立任务结束后再失败，避免清理仍在使用的本轮工作目录。
      const builds = await Promise.allSettled([
        phase("client", () => runAsync("pnpm", ["-C", "apps/desktop/client", "build"], { cwd: root, env: { ...process.env,
          CODEFLOWAI_CLIENT_BUILD_VERSION: plan.clientVersion,
          CODEFLOWAI_CLIENT_BUILD_TARGET: plan.environment === "test" ? "test" : "prod",
        } })),
        phase("web", async () => {
          const destination = path.join(work, "web");
          const cached = await materializeDesktopBuildCache({ cacheDir, namespace: "web", key: webKey, destination, build: async directory => {
            await runAsync("pnpm", ["-C", "apps/web", "build"], { cwd: root, env: webEnv });
            await fs.cp(path.join(root, "apps/web/dist"), directory, { recursive: true, errorOnExist: true, force: false });
          } });
          if (cached.hit) {
            await fs.rm(path.join(root, "apps/web/dist"), { recursive: true, force: true });
            await fs.cp(destination, path.join(root, "apps/web/dist"), { recursive: true, errorOnExist: true, force: false });
          }
          return cached;
        }),
      ]);
      const failures = builds.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, `DESKTOP_BUILD_FAILED: ${failures.map(error => error.message).join("; ")}`);
      await phase("desktop", () => run("pnpm", ["-C", "apps/desktop", "build"], { cwd: root }));
    }
    // shared 构建后才加载，支持干净检出。
    const { prepareDesktopResources } = await import("../../apps/desktop/scripts/prepare-resources.mjs");
    const { buildReleaseBundle } = await import("../../apps/desktop/scripts/build-release-bundle.mjs");
    const requireShared = createRequire(new URL("../../packages/shared/package.json", import.meta.url));
    const { assertTrustedReleaseKeys, verifyReleaseBundlePayload } = await import(pathToFileURL(requireShared.resolve("@codeflowai/shared/desktop-release-signing")).href);
    const clientPackageDir = clientArchive ? undefined : await createClientPackage(root, work, cacheDir, context);
    const npmDir = npmPackageDir ?? await phase("npm-runtime", () => ensureNpmRuntime(root));
    const common = {
      ...(clientArchive ? { archive: clientArchive } : { clientPackageDir }), clientDir: path.join(root, "apps/desktop/client"), webDir: path.join(root, "apps/web/dist"),
      npmPackageDir: npmDir, trustedReleaseKeysFile, updateServerOrigin, expectedClientVersion: plan.clientVersion,
    };
    const resourcesDir = path.join(outputDir, "resources");
    await phase("prepare-resources", () => prepareDesktopResources({ ...common, outputDir: resourcesDir }));
    const bundle = await phase("release-bundle", () => buildReleaseBundle({
      resourcesDir,
      outputDir: path.join(outputDir, "bundle"),
      privateKeyFile,
      metadata: {
        releaseId: plan.releaseId, version: plan.version, webVersion: plan.webVersion, clientVersion: plan.clientVersion,
        protocolVersion: plan.protocolVersion, capabilityVersion: plan.capabilityVersion, dbSchemaVersion: plan.dbSchemaVersion,
        platform: target.platform, arch: target.arch, keyId: plan.keyId, createdAt: new Date().toISOString(), expiresAt: plan.expiresAt,
      },
    }));
    await phase("baseline-proof", async () => {
      const proof = await fs.readFile(path.join(bundle.outputDir, "manifest.json"));
      const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(proof));
      const trustedKeys = assertTrustedReleaseKeys(JSON.parse(await fs.readFile(trustedReleaseKeysFile, "utf8")));
      await verifyReleaseBundlePayload({ directory: resourcesDir, manifest, trustedKeys, platform: target.platform, arch: target.arch, requireHeldStartup: true, requireFresh: true });
      await fs.writeFile(path.join(resourcesDir, "baseline-release-manifest.json"), proof, { flag: "wx" });
    });
    await fs.rm(work, { recursive: true, force: true });
    return { target, outputDir, bundleDir: bundle.outputDir, resourcesDir };
  } catch (error) {
    try { await fs.rm(work, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "DESKTOP_BUILD_CLEANUP_FAILED"); }
    throw error;
  }
}
