import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build, Platform, Arch } from "electron-builder";
import { formatDesktopVersion } from "@codeflowai/shared";
import { assertTrustedReleaseKeys, verifyReleaseBundlePayload } from "@codeflowai/shared/desktop-release-signing";
import { createBuilderProject, removeBuilderProject, resolveInstalledElectronDist, toBuilderVersion } from "./package-local-builder.mjs";
import { readDesktopReleasePlan } from "../../../tools/release/desktop-release-plan.mjs";
import { readDesktopShellInputs } from "../../../tools/release/desktop-shell-version.mjs";
import { buildShellSwitch } from "./build-shell-switch.mjs";
import { writeWindowsDisplayVersion } from "./windows-install-layout.mjs";

const requestId = crypto.randomUUID();

/** 固定 electron-builder/Electron 用户缓存，避免调用环境差异导致重复下载。 */
function pinElectronCaches() {
  const base = process.env.LOCALAPPDATA;
  if (!base) return;
  process.env.ELECTRON_BUILDER_CACHE ||= path.join(base, "electron-builder", "Cache");
  process.env.ELECTRON_CACHE ||= path.join(base, "electron", "Cache");
}
pinElectronCaches();

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
async function verifyBaselineProof(resources, required) {
  const proofPath = path.join(resources, "baseline-release-manifest.json");
  let stat;
  try { stat = await fs.lstat(proofPath); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    if (required) throw new Error("DESKTOP_BASELINE_PROOF_REQUIRED");
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("DESKTOP_BASELINE_PROOF_FILE_INVALID");
  /** 文件输入严格解码，坏编码与坏 JSON 均保留失败结果。 */
  const decode = bytes => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const trustedKeys = assertTrustedReleaseKeys(decode(await fs.readFile(path.join(resources, "release-trust.json"))));
  return await verifyReleaseBundlePayload({ directory: resources, manifest: decode(await fs.readFile(proofPath)), trustedKeys,
    platform: "win32", arch: "x64", requireHeldStartup: true });
}

/** 仅接受本地 dir/nsis 目标，选项重复、缺值和未知项均在写前拒绝。 */
function readPackageArguments(argv) {
  const [input, output, ...options] = argv;
  const usage = "用法：package-local-win.mjs <完整资源目录> <新独占输出目录> [--require-baseline-proof] [--target dir|nsis] [--plan <file>] [--allow-dirty] [--environment test|production] [--allow-unsigned-production]";
  if (!input || !output || input.startsWith("--") || output.startsWith("--")) throw new Error(usage);
  let required = false, target = "dir", targetSeen = false, planFile, allowDirty = false;
  let environment = "test", environmentSeen = false, allowUnsignedProduction = false;
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (option === "--require-baseline-proof" && !required) required = true;
    else if (option === "--target" && !targetSeen && ["dir", "nsis"].includes(options[index + 1])) {
      target = options[++index]; targetSeen = true;
    } else if (option === "--plan" && !planFile && options[index + 1] && !options[index + 1].startsWith("--")) planFile = path.resolve(options[++index]);
    else if (option === "--allow-dirty" && !allowDirty) allowDirty = true;
    else if (option === "--environment" && !environmentSeen && ["test", "production"].includes(options[index + 1])) {
      environment = options[++index]; environmentSeen = true;
    } else if (option === "--allow-unsigned-production" && !allowUnsignedProduction
      && (environment === "production" || !environmentSeen)) allowUnsignedProduction = true;
    else throw new Error(usage);
  }
  if (allowUnsignedProduction && environment !== "production") throw new Error("DESKTOP_WIN_UNSIGNED_PRODUCTION_ONLY");
  return { input, output, required, target, planFile, allowDirty, environment, environmentSeen, allowUnsignedProduction };
}

/** 生产默认要求 Windows 签名材料；只有显式允许时才构建未签名包。 */
function resolveWindowsSigning(original, environment, allowUnsignedProduction) {
  if (environment !== "production" || allowUnsignedProduction) return { signed: false, signExecutable: false };
  const material = process.env.CSC_LINK || process.env.WIN_CSC_LINK
    || original.win?.certificateFile || original.win?.certificateSubjectName;
  if (!material) throw Object.assign(new Error("DESKTOP_WIN_SIGNING_REQUIRED"), { code: "DESKTOP_WIN_SIGNING_REQUIRED" });
  return { signed: true, signExecutable: undefined };
}

/** 有计划时环境必须来自计划；显式参数只能与计划一致，不能把生产计划当测试包。 */
async function resolvePlanEnvironment(planFile, environment, explicit) {
  if (!planFile) return environment;
  const plan = JSON.parse(await fs.readFile(planFile, "utf8"));
  if (!["test", "production"].includes(plan.environment)) throw new Error("DESKTOP_PACKAGE_PLAN_ENVIRONMENT_INVALID");
  if (explicit && environment !== plan.environment) throw new Error("DESKTOP_PACKAGE_ENVIRONMENT_MISMATCH");
  return plan.environment;
}

/** 发布构建使用已验来源计划；无计划仅保留原本地打包入口。 */
async function resolveLocalPackageVersion(desktopDir, planFile, allowDirty) {
  if (planFile) return (await readDesktopReleasePlan({ root: path.resolve(desktopDir, "../.."), file: planFile, allowDirty })).shellVersion;
  const { version } = JSON.parse(await fs.readFile(path.join(desktopDir, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error("DESKTOP_SHELL_VERSION_INVALID");
  return version;
}


/** 完整资源及维护 Worker 须齐备；安装包强制携带基线证明，所有检查先于输出写入。 */
async function packageLocalWindows() {
  const args = readPackageArguments(process.argv.slice(2));
  const { input, output, required, target, planFile, allowDirty, allowUnsignedProduction } = args;
  const environment = await resolvePlanEnvironment(planFile, args.environment, args.environmentSeen);
  if (allowUnsignedProduction && environment !== "production") throw new Error("DESKTOP_WIN_UNSIGNED_PRODUCTION_ONLY");
  if (process.platform !== "win32") throw new Error("DESKTOP_LOCAL_WINDOWS_REQUIRED");
  const resources = await fs.realpath(path.resolve(input));
  const outputDir = path.resolve(output);
  for (const entry of ["client/package.json", "client/dist/index.cjs", "client/node_modules", "web/index.html", "client/npm/package.json",
    "client/npm/bin/npm-cli.js", "client/cli-runtime.json", "release-trust.json"]) {
    await fs.access(path.join(resources, entry));
  }
  const desktopDir = fileURLToPath(new URL("..", import.meta.url));
  const shellVersion = await resolveLocalPackageVersion(desktopDir, planFile, allowDirty);
  await fs.access(path.join(desktopDir, "dist/main.js"));
  await fs.access(path.join(desktopDir, "dist/preload.cjs"));
  await assertSeparatePackagingOutput(resources, desktopDir, outputDir);
  let worker;
  try { worker = await fs.lstat(path.join(resources, "client/dist/desktopUninstallWorker.cjs")); }
  catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
    throw new Error("DESKTOP_UNINSTALL_WORKER_MISSING", { cause });
  }
  if (!worker.isFile() || worker.isSymbolicLink() || worker.nlink !== 1) throw new Error("DESKTOP_UNINSTALL_WORKER_INVALID");
  const baselineProof = await verifyBaselineProof(resources, required || target === "nsis");
  const { electronDist, electronVersion } = await resolveInstalledElectronDist({ platform: "win32", arch: "x64" });
  if (planFile && (await readDesktopShellInputs(path.resolve(desktopDir, "../.."))).electronVersion !== electronVersion) {
    throw new Error("DESKTOP_SHELL_ELECTRON_LOCK_MISMATCH");
  }
  const hasBaselineProof = baselineProof !== null;
  // 展示与文件名保留真实版本；builder 的补零仅供内部数字字段使用。
  const displayVersion = baselineProof ? formatDesktopVersion(shellVersion, baselineProof.version) : shellVersion;
  if (!displayVersion || /[<>:"/\\|?*$\u0000-\u001f]/u.test(displayVersion) || [".", ".."].includes(displayVersion)) {
    throw new Error("DESKTOP_PACKAGE_DISPLAY_VERSION_INVALID");
  }
  const requireBuilder = createRequire(import.meta.resolve("electron-builder"));
  const requireBuilderLibrary = createRequire(requireBuilder.resolve("app-builder-lib"));
  const { load } = requireBuilderLibrary("js-yaml");
  const original = load(await fs.readFile(path.join(desktopDir, "electron-builder.yml"), "utf8"));
  // 签名材料缺失必须在创建输出目录前失败。
  const signing = resolveWindowsSigning(original, environment, allowUnsignedProduction);
  if (!signing.signed) process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  // mkdir 的非递归原子创建同时拒绝既有目录、文件及链接，不覆盖旧工件。
  await fs.mkdir(outputDir);
  const configPath = path.join(outputDir, "local-builder.json");
  const builderProjectDir = await createBuilderProject(desktopDir, shellVersion);
  let artifacts, buildError;
  try {
    const shellSwitch = await buildShellSwitch({ outputDir: path.join(builderProjectDir, "native-tools"), version: shellVersion });
    // 独立配置复用原 YAML，避免 builder 深合并数组后把旧资源再复制一次。
    await fs.writeFile(configPath, `${JSON.stringify({ ...original,
      directories: { output: outputDir }, extraMetadata: { version: toBuilderVersion(shellVersion), desktopDisplayVersion: displayVersion },
      electronVersion, electronDist,
      artifactName: `CodeFlowAI-${displayVersion}-win32-x64.\${ext}`,
      npmRebuild: false,
      // 生产默认让 electron-builder 使用证书签名；测试或显式允许时跳过但保留图标与版本资源。
      win: signing.signed ? { ...original.win } : { ...original.win, signExecutable: false },
      afterPack: path.join(desktopDir, "scripts/packaged-resource-copy.mjs"),
      // afterPack 后 builder 仍校验根 resources/app.asar；资源编辑后、归档前再转换布局。
      ...(target === "nsis" ? { nsis: { ...original.nsis, runAfterFinish: true },
        afterSign: path.join(desktopDir, "scripts/windows-install-layout.mjs") } : {}),
      extraResources: [
        { from: shellSwitch, to: "shell-switch.exe" },
        { from: path.join(desktopDir, "build/icon.png"), to: "shell-icon.png" },
        { from: resources, to: ".", filter: ["desktop-update.json"] },
        { from: path.join(resources, "release-trust.json"), to: "release-trust.json" },
        { from: path.join(resources, "client"), to: "client" },
        { from: path.join(resources, "client/node_modules"), to: "client/node_modules" },
        { from: path.join(resources, "web"), to: "web" },
        ...(hasBaselineProof ? [{ from: path.join(resources, "baseline-release-manifest.json"), to: "baseline-release-manifest.json" }] : []),
      ],
    }, null, 2)}\n`, "utf8");
    artifacts = await build({ projectDir: builderProjectDir, targets: Platform.WINDOWS.createTarget(target, Arch.x64), publish: "never", config: configPath,
      /** 品牌与文件属性使用产品展示号；安装登记仍记录真实壳号，固定数字版本保持原值。 */
      effectiveOptionComputed: async ([defines, commands]) => {
        defines.CODEFLOW_SHELL_VERSION = shellVersion;
        defines.VERSION = displayVersion;
        commands.VIAddVersionKey = commands.VIAddVersionKey.map(value => value.replace(
          /\b(ProductVersion|FileVersion) "[^"]*"$/u, (_, key) => `${key} "${displayVersion}"`));
        return false;
      },
    });
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
    const executable = path.join(outputDir, "win-unpacked", "CodeFlowAI.exe");
    await writeWindowsDisplayVersion(executable, displayVersion); destination = { executable };
  } else {
    const installers = artifacts.filter(file => path.extname(file).toLowerCase() === ".exe");
    if (installers.length !== 1) throw new Error("DESKTOP_LOCAL_INSTALLER_RESULT_INVALID");
    const installer = path.resolve(installers[0]), relative = path.relative(outputDir, installer);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("DESKTOP_LOCAL_INSTALLER_OUTSIDE_OUTPUT");
    }
    await fs.access(installer); destination = { installer };
  }
  console.log(JSON.stringify({ code: "DESKTOP_LOCAL_PACKAGE_READY", requestId, resources, outputDir, artifacts,
    shellVersion, displayVersion, target: `win32-x64-${target}`, ...destination, signed: signing.signed, published: false }));
}

try { await packageLocalWindows(); }
catch (error) {
  console.error(JSON.stringify({ code: "DESKTOP_LOCAL_PACKAGE_FAILED", requestId, rootCause: error.message, stack: error.stack,
    ...(error.code === "DESKTOP_LOCAL_PACKAGE_INPUT_OUTPUT_OVERLAP" ? { inputDirectory: error.inputDirectory, outputDirectory: error.outputDirectory } : {}) }));
  process.exitCode = 1;
}
