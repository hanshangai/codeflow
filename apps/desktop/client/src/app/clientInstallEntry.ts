import fs from "node:fs";
import path from "node:path";

/** Client npm 包名；升级与卸载两侧共用同一份事实。 */
export const CLIENT_NPM_PACKAGE_NAME = "@codeflowai/client";

const CLIENT_PACKAGE_ENTRY_SUFFIX = "/node_modules/@codeflowai/client/bin/codeflow.js";

/** 统一路径比较格式，避免大小写与分隔符差异造成漏判或误判。 */
export function normalizeComparablePath(value: unknown): string {
  return String(value ?? "").trim().replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

/** 仅识别仓库内的源码、构建及 bin 入口；未知入口保留原有升级提示。 */
export function isClientSourceRun(entryPath: string | null | undefined = process.argv[1]): boolean {
  return /\/apps\/desktop\/client\/(?:src\/index\.tsx?|dist\/index\.(?:cjs|js)|bin\/codeflow\.js)$/u.test(
    normalizeComparablePath(entryPath),
  );
}

/** 只要区分 Windows 与 POSIX 两种布局；win32/windows 归 Windows，darwin/linux/posix 归 POSIX。 */
function isWindowsInstallPlatform(platform: NodeJS.Platform | string | undefined): boolean {
  const normalized = String(platform ?? process.platform).trim().toLowerCase();
  return normalized === "win32" || normalized === "windows";
}

/** 平台对应的路径实现，避免用本机 path 解析另一种平台的路径。 */
function installPathsForPlatform(platform: NodeJS.Platform | string | undefined): typeof path.posix {
  return isWindowsInstallPlatform(platform) ? path.win32 : path.posix;
}

/** npm 在全局前缀下生成的命令 shim 路径；两平台布局不同，Windows 为 .cmd/.ps1，POSIX 为 bin/<命令>。 */
function clientCommandShimPaths(prefix: string, platform: NodeJS.Platform | string | undefined): string[] {
  const paths = installPathsForPlatform(platform);
  return isWindowsInstallPlatform(platform)
    ? [paths.join(prefix, "codeflow.cmd"), paths.join(prefix, "codeflow.ps1")]
    : [paths.join(prefix, "bin", "codeflow")];
}

/**
 * 按包入口后缀切分路径，纯字符串处理不碰磁盘。
 * 返回 `<X>` 与包目录相对片段；POSIX 的 `<X>/lib/node_modules/...` 保留 `lib`，供后续按真实布局校验包目录。
 */
function splitClientPackageEntry(entryPath: unknown): { prefix: string; packageSegments: string[] } | null {
  const entry = String(entryPath ?? "").trim().replace(/\\/gu, "/");
  const suffixIndex = entry.toLowerCase().lastIndexOf(CLIENT_PACKAGE_ENTRY_SUFFIX);
  if (suffixIndex <= 0) return null;
  const scope = entry.slice(0, suffixIndex);
  return scope.toLowerCase().endsWith("/lib")
    ? { prefix: scope.slice(0, -"/lib".length), packageSegments: ["lib", "node_modules", "@codeflowai", "client"] }
    : { prefix: scope, packageSegments: ["node_modules", "@codeflowai", "client"] };
}

/** 入口是否具备 npm 全局包入口形态；源码入口与自定义路径恒为 false。 */
export function hasClientPackageEntryShape(entryPath: string): boolean {
  return splitClientPackageEntry(entryPath) !== null;
}

/**
 * 从入口路径反推它自身所属的 npm 全局前缀；后缀形态与磁盘归属必须同时成立，否则返回 null。
 * 归属校验是唯一安全阀（升级守卫的“仅包含判定”对构造出的前缀恒为真）：
 * 包目录须是真实目录而非链接、包名须相符、`<X>` 下须有 npm 生成的命令 shim。
 * 三条齐备才能排除源码运行、npm link 与工程内 `npm i @codeflowai/client`（后者 `<X>` 下没有 shim）。
 * 任一校验不过一律返回 null，由调用方显式拒绝，不做降级放行。
 */
export function resolveEntryOwnedNpmPrefix(
  entryPath: string | null | undefined,
  platform: NodeJS.Platform | string = process.platform,
): string | null {
  const paths = installPathsForPlatform(platform);
  const split = splitClientPackageEntry(entryPath);
  if (!split) return null;
  const prefix = paths.normalize(split.prefix);
  if (!paths.isAbsolute(prefix)) return null;
  const packageDir = paths.join(prefix, ...split.packageSegments);
  try {
    if (!fs.lstatSync(packageDir).isDirectory() || fs.lstatSync(packageDir).isSymbolicLink()) return null;
    const manifest = JSON.parse(fs.readFileSync(paths.join(packageDir, "package.json"), "utf8")) as { name?: unknown };
    if (manifest?.name !== CLIENT_NPM_PACKAGE_NAME) return null;
  } catch {
    return null;
  }
  return clientCommandShimPaths(prefix, platform).some((shim) => fs.existsSync(shim)) ? prefix : null;
}

/** Windows 私有安装前缀（%LOCALAPPDATA%\CodeFlowAI\npm）；其他平台恒为空串。 */
function windowsPrivateNpmPrefix(platform: NodeJS.Platform | string | undefined, env: NodeJS.ProcessEnv): string {
  if (!isWindowsInstallPlatform(platform)) return "";
  const localAppData = String(env.LOCALAPPDATA ?? "").trim();
  return localAppData ? path.win32.join(localAppData, "CodeFlowAI", "npm") : "";
}

export type ClientEntryPrefixCandidates = {
  /** 入口自身所属前缀；null 表示入口不具备包入口形态或缺少磁盘归属证据。 */
  ownedPrefix: string | null;
  /** 判定候选，按证据强度保序去重：入口自有前缀 → npm 探测值 → Windows 私有前缀。 */
  prefixes: string[];
};

/**
 * 组装升级/卸载共用的入口判定候选前缀。
 * 入口自有前缀排第一：它是唯一有磁盘证据的候选；`npm config get prefix` 探测值可能被私有 launcher
 * 注入的 npm_config_prefix 污染，且只要它“包含”入口就会胜出并生成错误结论，故不能作为唯一来源。
 */
export function resolveClientEntryPrefixCandidates(input: {
  npmGlobalPrefix: string | null | undefined;
  platform?: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv;
  entryPath?: string | null;
}): ClientEntryPrefixCandidates {
  const platform = input.platform ?? process.platform;
  const ownedPrefix = resolveEntryOwnedNpmPrefix(String(input.entryPath ?? "").trim(), platform);
  const values = [
    ownedPrefix ?? "",
    String(input.npmGlobalPrefix ?? "").trim(),
    windowsPrivateNpmPrefix(platform, input.env ?? process.env),
  ];
  const seen = new Set<string>();
  const prefixes: string[] = [];
  for (const value of values) {
    const comparable = normalizeComparablePath(value);
    if (!comparable || seen.has(comparable)) continue;
    seen.add(comparable);
    prefixes.push(value);
  }
  return { ownedPrefix, prefixes };
}
