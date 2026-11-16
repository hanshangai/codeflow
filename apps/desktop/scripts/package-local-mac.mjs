import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build, Platform, Arch } from "electron-builder";
import { formatDesktopVersion } from "@codeflowai/shared";
import { assertTrustedReleaseKeys, verifyReleaseBundlePayload } from "@codeflowai/shared/desktop-release-signing";
import { createBuilderProject, removeBuilderProject, resolveElectronVersion, toBuilderVersion } from "./package-local-builder.mjs";

const requestId = crypto.randomUUID();

/** 解析新输出的最近既有祖先，保留尚不存在的尾段并识别父目录链接。 */
async function resolveOutputPath(directory) {
  const missing = [];
  let ancestor = directory;
  for (;;) {
    try { return path.join(await fs.realpath(ancestor), ...missing); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/** 写前拒绝输出与输入相互包含，保留真实目录供唯一错误边界记录。 */
async function assertSeparatePackagingOutput(resources, desktopDir, outputDir) {
  const output = await resolveOutputPath(outputDir);
  for (const input of [resources, desktopDir, path.join(resources, "client"), path.join(resources, "client/node_modules"),
    path.join(resources, "web"), path.join(desktopDir, "dist")]) {
    const source = await fs.realpath(input);
    for (const relative of [path.relative(source, output), path.relative(output, source)]) {
      if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
        throw Object.assign(new Error("DESKTOP_LOCAL_PACKAGE_INPUT_OUTPUT_OVERLAP"), {
          code: "DESKTOP_LOCAL_PACKAGE_INPUT_OUTPUT_OVERLAP", inputDirectory: source, outputDirectory: output,
        });
      }
    }
  }
}

/** 可选证明存在即复验原完整 payload；强制模式缺证必须在写输出前失败，返回已验签清单供对外命名。 */
async function verifyBaselineProof(resources, required, arch) {
  const proofPath = path.join(resources, "baseline-release-manifest.json");
  let stat;
  try { stat = await fs.lstat(proofPath); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    if (required) throw new Error("DESKTOP_BASELINE_PROOF_REQUIRED");
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("DESKTOP_BASELINE_PROOF_FILE_INVALID");
  const decode = bytes => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const trustedKeys = assertTrustedReleaseKeys(decode(await fs.readFile(path.join(resources, "release-trust.json"))));
  return await verifyReleaseBundlePayload({ directory: resources, manifest: decode(await fs.readFile(proofPath)), trustedKeys,
    platform: "darwin", arch, requireHeldStartup: true });
}

/** 仅接受本地 dir/dmg 目标，选项重复、缺值和未知项均在写前拒绝。 */
function readPackageArguments(argv) {
  const [input, output, ...options] = argv;
  const usage = "用法：package-local-mac.mjs <完整资源目录> <新独占输出目录> [--require-baseline-proof] [--target dir|dmg]";
  if (!input || !output || input.startsWith("--") || output.startsWith("--")) throw new Error(usage);
  let required = false, target = "dir", targetSeen = false;
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (option === "--require-baseline-proof" && !required) required = true;
    else if (option === "--target" && !targetSeen && ["dir", "dmg"].includes(options[index + 1])) {
      target = options[++index]; targetSeen = true;
    } else throw new Error(usage);
  }
  return { input, output, required, target };
}

/** 安装包始终使用实际壳版本；主版本统一为 1.0 两位，资源发布不得修改它。 */
async function resolveLocalPackageVersion(desktopDir) {
  const { version } = JSON.parse(await fs.readFile(path.join(desktopDir, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+$/.test(version)) throw new Error("DESKTOP_SHELL_VERSION_INVALID");
  return version;
}


/** 在输出目录内定位唯一 .app，避免把 builder 的中间目录当成结果。 */
async function findApplication(outputDir, depth = 0) {
  if (depth > 3) return [];
  const found = [];
  for (const entry of await fs.readdir(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(outputDir, entry.name);
    if (entry.name.endsWith(".app")) found.push(target);
    else found.push(...await findApplication(target, depth + 1));
  }
  return found;
}

/** 未签名本地包写入显式标记，只放宽 darwin 打包态基线要求，不伪造签名。 */
async function writeUnsignedMarker(outputDir) {
  const marker = path.join(outputDir, "desktop-unsigned-local.json");
  await fs.writeFile(marker, `${JSON.stringify({ schemaVersion: 1, reason: "unsigned-local-package" })}\n`, { encoding: "utf8", flag: "wx" });
  return marker;
}

/** 完整资源与卸载 Worker 须齐备；强制基线证明先于输出写入。 */
async function packageLocalMac() {
  const { input, output, required, target } = readPackageArguments(process.argv.slice(2));
  if (process.platform !== "darwin") throw new Error("DESKTOP_LOCAL_MACOS_REQUIRED");
  if (!["x64", "arm64"].includes(process.arch)) throw new Error("DESKTOP_LOCAL_MACOS_ARCH_UNSUPPORTED");
  const resources = await fs.realpath(path.resolve(input));
  const outputDir = path.resolve(output);
  for (const entry of ["client/package.json", "client/dist/index.cjs", "client/node_modules", "web/index.html", "client/npm/package.json",
    "client/npm/bin/npm-cli.js", "client/cli-runtime.json", "release-trust.json"]) {
    await fs.access(path.join(resources, entry));
  }
  const desktopDir = fileURLToPath(new URL("..", import.meta.url));
  const shellVersion = await resolveLocalPackageVersion(desktopDir);
  await fs.access(path.join(desktopDir, "dist/main.js"));
  await fs.access(path.join(desktopDir, "dist/preload.cjs"));
  await fs.access(path.join(desktopDir, "dist/macosUninstallHelper.cjs"));
  await assertSeparatePackagingOutput(resources, desktopDir, outputDir);
  let worker;
  try { worker = await fs.lstat(path.join(resources, "client/dist/desktopUninstallWorker.cjs")); }
  catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
    throw new Error("DESKTOP_UNINSTALL_WORKER_MISSING", { cause });
  }
  if (!worker.isFile() || worker.isSymbolicLink() || worker.nlink !== 1) throw new Error("DESKTOP_UNINSTALL_WORKER_INVALID");
  const baselineProof = await verifyBaselineProof(resources, required, process.arch);
  const hasBaselineProof = baselineProof !== null;
  /** 对外文件名与界面共用同一展示版本；非日期基线退回打包用三段壳版本，避免文件名与安装后版本脱节。 */
  const composedVersion = baselineProof && formatDesktopVersion(shellVersion, baselineProof.version);
  const displayVersion = composedVersion && /^\d+(?:\.\d+){1,3}$/u.test(composedVersion) ? composedVersion : toBuilderVersion(shellVersion);
  // mkdir 的非递归原子创建同时拒绝既有目录、文件及链接，不覆盖旧工件。
  await fs.mkdir(outputDir);
  const unsignedMarker = hasBaselineProof ? undefined : await writeUnsignedMarker(outputDir);
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  const requireBuilder = createRequire(import.meta.resolve("electron-builder"));
  const requireBuilderLibrary = createRequire(requireBuilder.resolve("app-builder-lib"));
  const { load } = requireBuilderLibrary("js-yaml");
  const original = load(await fs.readFile(path.join(desktopDir, "electron-builder.yml"), "utf8"));
  const electronVersion = await resolveElectronVersion();
  const configPath = path.join(outputDir, "local-builder.json");
  await fs.writeFile(configPath, `${JSON.stringify({ ...original,
      directories: { output: outputDir }, extraMetadata: { version: toBuilderVersion(shellVersion) },
      electronVersion,
      artifactName: `CodeFlowAI-${displayVersion}-darwin-\${arch}.\${ext}`,
      npmRebuild: false,
      // 本地包不进入官方签名，但仍做 ad-hoc 签名并保留图标、分类与包标识。
      mac: { ...original.mac, identity: null, hardenedRuntime: false, gatekeeperAssess: false },
      afterPack: path.join(desktopDir, "scripts/adhoc-sign-mac.cjs"),
      dmg: { ...(original.dmg ?? {}), title: `CodeFlow ${displayVersion}`, contents: [
        { x: 130, y: 220 },
        { x: 410, y: 220, type: "link", path: "/Applications" },
      ] },
      extraResources: [
        { from: resources, to: ".", filter: ["desktop-update.json"] },
        { from: path.join(resources, "release-trust.json"), to: "release-trust.json" },
        { from: path.join(resources, "client"), to: "client" },
        { from: path.join(resources, "client/node_modules"), to: "client/node_modules" },
        { from: path.join(resources, "web"), to: "web" },
        { from: path.join(desktopDir, "dist/macosUninstallHelper.cjs"), to: "macosUninstallHelper.cjs" },
        ...(hasBaselineProof ? [{ from: path.join(resources, "baseline-release-manifest.json"), to: "baseline-release-manifest.json" }] : []),
        ...(unsignedMarker ? [{ from: unsignedMarker, to: "desktop-unsigned-local.json" }] : []),
      ],
    }, null, 2)}\n`, "utf8");
  const arch = process.arch === "arm64" ? Arch.arm64 : Arch.x64;
  const builderProjectDir = await createBuilderProject(desktopDir, shellVersion);
  let artifacts, buildError;
  try {
    artifacts = await build({ projectDir: builderProjectDir, targets: Platform.MAC.createTarget(target, arch), publish: "never", config: configPath });
  } catch (error) {
    buildError = error;
    throw error;
  } finally {
    try { await removeBuilderProject(builderProjectDir); }
    catch (cleanupError) {
      if (buildError) throw new AggregateError([buildError, cleanupError], "DESKTOP_LOCAL_PACKAGE_CLEANUP_FAILED");
      throw cleanupError;
    }
  }
  let destination;
  if (target === "dir") {
    const applications = await findApplication(outputDir);
    if (applications.length !== 1) throw new Error("DESKTOP_LOCAL_APP_RESULT_INVALID");
    await fs.access(applications[0]); destination = { application: applications[0] };
  } else {
    const installers = artifacts.filter(file => path.extname(file).toLowerCase() === ".dmg");
    if (installers.length !== 1) throw new Error("DESKTOP_LOCAL_INSTALLER_RESULT_INVALID");
    const installer = path.resolve(installers[0]), relative = path.relative(outputDir, installer);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("DESKTOP_LOCAL_INSTALLER_OUTSIDE_OUTPUT");
    }
    await fs.access(installer); destination = { installer };
  }
  console.log(JSON.stringify({ code: "DESKTOP_LOCAL_PACKAGE_READY", requestId, resources, outputDir, artifacts,
    shellVersion, displayVersion, target: `darwin-${process.arch}-${target}`, ...destination,
    signed: false, adhocSigned: true, baseline: hasBaselineProof, published: false }));
}

try { await packageLocalMac(); }
catch (error) {
  console.error(JSON.stringify({ code: "DESKTOP_LOCAL_PACKAGE_FAILED", requestId, rootCause: error.message, stack: error.stack,
    ...(error.code === "DESKTOP_LOCAL_PACKAGE_INPUT_OUTPUT_OVERLAP" ? { inputDirectory: error.inputDirectory, outputDirectory: error.outputDirectory } : {}) }));
  process.exitCode = 1;
}
