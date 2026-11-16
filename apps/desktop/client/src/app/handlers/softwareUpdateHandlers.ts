import { spawn } from "node:child_process";
import { constants as fsConstants, existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  EngineType,
  NpmInstallAttempt,
  NpmInstallNetworkOptions,
  NpmInstallResponseBody,
  NpmInstallSourceMode,
  SoftwareInstallEnvironment,
  SoftwareInstallPlatform,
  SoftwareUpdateStatus,
} from "@codeflowai/shared";

import { buildClaudeStatus, buildCodexStatus, runCli } from "./engineHandlers.js";
import { acquireGlobalNpmInstall } from "./globalNpmInstallLock.js";
import {
  assertPrivateInstallVersion,
  buildPrivateSoftwareUpdateItems,
  installPrivateCli,
  readPrivateCliRuntimeConfig,
  PRIVATE_CLI_VERSION_MISMATCH,
  type PrivateCliInstallResult,
} from "./privateCliRuntime.js";
import type { PrivateCliRuntimeConfig } from "../../cli-runtime/privateCliManifest.js";
import { resolveClientEntryPrefixCandidates } from "../clientInstallEntry.js";
import {
  buildClientRestartEnv,
  isClientDaemonChild,
  spawnClientDaemonReplacementFromCurrentProcess,
} from "../../clientDaemon.js";
import { resolveClaudeCli } from "../../engines/claude/claudeCli.js";
import { resolveCliDisplayPath } from "../../engines/cliDisplayPath.js";
import { resolveCodexCli } from "../../engines/codex-app-server/codexAppServerCli.js";
import { buildClientChildProcessEnv } from "../../runtime/clientProcessEnv.js";
import { readSelfVersion } from "../../version.js";
import {
  launchWindowsDetachedUpgrade,
  type WindowsUpgradeResultReport,
} from "../../update/windowsSelfUpgrade.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { logger } from "../../logger.js";

/** npm 包名映射 */
const NPM_PACKAGES: Record<EngineType, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};
const PACKAGE_TO_ENGINE = Object.fromEntries(
  Object.entries(NPM_PACKAGES).map(([engineType, npmPackage]) => [npmPackage, engineType as EngineType]),
) as Record<string, EngineType>;
const INSTALL_VERIFY_TIMEOUT_MS = 10_000;
const NPM_VIEW_TIMEOUT_MS = 30_000;
const CLAUDE_INSTALL_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60_000;
const NPMMIRROR_REGISTRY = "https://registry.npmmirror.com";
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";
const NPMMIRROR_NODE_DISTURL = "https://npmmirror.com/mirrors/node";
const OFFICIAL_NODE_DISTURL = "https://nodejs.org/download/release";

/** 安装白名单 */
const ALLOWED_PACKAGES = new Set(Object.values(NPM_PACKAGES));
type NpmInstallAttemptSource = Exclude<NpmInstallSourceMode, "auto">;

export type NormalizedNpmInstallNetwork = {
  mode: NpmInstallSourceMode;
  proxyUrl: string | null;
};

type NormalizeNpmInstallNetworkResult =
  | { ok: true; network: NormalizedNpmInstallNetwork }
  | { ok: false; message: string };

type CliProbeResult = {
  installed: boolean;
  version: string | null;
  binPath: string | null;
  error: string | null;
};

type CliProbeMap = Partial<Record<EngineType, () => Promise<CliProbeResult>>>;

export type CliInstallVerificationResult = {
  success: boolean;
  installedVersion: string | null;
  binPath: string | null;
  error: string | null;
};

export type CliInstallNoopResult = {
  installedVersion: string;
  binPath: string | null;
  message: string;
};

export function extractCliVersion(rawVersion: string | null | undefined): string | null {
  const raw = String(rawVersion ?? "").trim();
  if (!raw) return null;
  return raw.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] || null;
}

/** 判断输入是否为普通对象，避免直接读取未知请求体。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 校验安装源模式，非法值由请求解析层显式拒绝。 */
function isNpmInstallSourceMode(value: unknown): value is NpmInstallSourceMode {
  return value === "auto"
    || value === "npmmirror"
    || value === "official"
    || value === "proxyOfficial"
    || value === "inherit";
}

/** 规范化代理地址；npm 代理仅接受 http/https URL。 */
function normalizeProxyUrl(rawValue: string): { ok: true; proxyUrl: string } | { ok: false; message: string } {
  const raw = rawValue.trim();
  if (!raw) return { ok: false, message: "代理地址不能为空" };
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, message: "代理地址仅支持 http:// 或 https:// 协议" };
    }
    url.hash = "";
    return { ok: true, proxyUrl: url.toString().replace(/\/$/, "") };
  } catch (e) {
    return { ok: false, message: `代理地址格式不正确：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 解析 npm 安装网络选项，错误配置显式返回给前端。 */
export function normalizeNpmInstallNetwork(input: unknown): NormalizeNpmInstallNetworkResult {
  const raw = isRecord(input) ? input : {};
  const hasMode = raw.mode !== undefined && raw.mode !== null && String(raw.mode).trim() !== "";
  if (hasMode && !isNpmInstallSourceMode(raw.mode)) {
    return { ok: false, message: `不支持的安装源：${String(raw.mode)}` };
  }
  const mode = hasMode ? raw.mode as NpmInstallSourceMode : "auto";
  const rawProxyUrl = typeof raw.proxyUrl === "string" ? raw.proxyUrl.trim() : "";
  let proxyUrl: string | null = null;
  if (rawProxyUrl) {
    const normalized = normalizeProxyUrl(rawProxyUrl);
    if (!normalized.ok && (mode === "auto" || mode === "proxyOfficial")) {
      return { ok: false, message: normalized.message };
    }
    if (normalized.ok) proxyUrl = normalized.proxyUrl;
  }
  if (mode === "proxyOfficial" && !proxyUrl) {
    return { ok: false, message: "代理安装需要填写代理地址" };
  }
  return { ok: true, network: { mode, proxyUrl } };
}

/** 根据用户选择生成实际尝试顺序；auto 会按国内镜像、官方源、代理官方源执行。 */
export function buildNpmInstallAttemptPlan(network: NormalizedNpmInstallNetwork): NpmInstallAttemptSource[] {
  if (network.mode === "auto") {
    return network.proxyUrl ? ["npmmirror", "official", "proxyOfficial"] : ["npmmirror", "official"];
  }
  return [network.mode];
}

/** 返回安装源对应的 registry；inherit 不覆盖用户本机 npm registry。 */
function registryForNpmInstallSource(source: NpmInstallAttemptSource): string | null {
  if (source === "npmmirror") return NPMMIRROR_REGISTRY;
  if (source === "official" || source === "proxyOfficial") return OFFICIAL_NPM_REGISTRY;
  return null;
}

/** 返回 node-gyp 下载 Node 头文件的 disturl，避免继承废弃 taobao 镜像。 */
function nodeDistUrlForNpmInstallSource(source: NpmInstallAttemptSource): string | null {
  if (source === "npmmirror") return NPMMIRROR_NODE_DISTURL;
  if (source === "official" || source === "proxyOfficial") return OFFICIAL_NODE_DISTURL;
  return null;
}

/** 合并 NO_PROXY，确保本机回环地址不经过代理。 */
function mergeNoProxy(baseEnv: NodeJS.ProcessEnv): string {
  const values = new Set<string>();
  for (const item of String(baseEnv.NO_PROXY ?? baseEnv.no_proxy ?? "").split(",")) {
    const trimmed = item.trim();
    if (trimmed) values.add(trimmed);
  }
  for (const item of ["localhost", "127.0.0.1", "::1"]) values.add(item);
  return [...values].join(",");
}

/** 构造 npm 子进程环境变量，仅对本次安装/查询生效。 */
export function buildNpmInstallEnv(
  source: NpmInstallAttemptSource,
  proxyUrl: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = buildClientChildProcessEnv(baseEnv);
  env.npm_config_optional = "true";
  env.npm_config_include = "optional";
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";

  const registry = registryForNpmInstallSource(source);
  if (registry) env.npm_config_registry = registry;
  const distUrl = nodeDistUrlForNpmInstallSource(source);
  if (distUrl) env.npm_config_disturl = distUrl;
  if (source === "npmmirror") env.npm_config_replace_registry_host = "always";
  if (source === "official" || source === "proxyOfficial") env.npm_config_replace_registry_host = "never";

  if (source === "proxyOfficial" && proxyUrl) {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.NO_PROXY = mergeNoProxy(env);
    env.no_proxy = env.NO_PROXY;
    env.npm_config_proxy = proxyUrl;
    env.npm_config_https_proxy = proxyUrl;
  }
  return env;
}

/** 生成 npm install 参数，显式启用 optional 依赖并关闭低价值网络请求。 */
export function buildNpmInstallArgs(pkg: string): string[] {
  return ["install", "-g", pkg, "--include=optional", "--no-audit", "--no-fund"];
}

/** 生成 Client 自升级 npm 参数，保持 server tgz 主机且避免废弃的 disturl 配置。 */
export function buildClientUpgradeNpmArgs(installUrl: string): string[] {
  return [
    "install",
    "-g",
    "--force",
    `--registry=${NPMMIRROR_REGISTRY}`,
    "--replace-registry-host=never",
    installUrl,
    "--include=optional",
    "--no-audit",
    "--no-fund",
  ];
}

/** 自升级固定到当前托管安装目录，并清理废弃的 npm 下载配置。 */
export function buildClientUpgradeNpmEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  entryPath: string | undefined = process.argv[1],
): NodeJS.ProcessEnv {
  const env = buildNpmInstallEnv("npmmirror", null, baseEnv);
  const managedPrefix = resolveManagedClientUpgradePrefix(baseEnv, entryPath);
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase();
    if (normalized === "npm_config_disturl" || normalized === "npm_config_optional") delete env[key];
    if (managedPrefix && normalized === "npm_config_prefix") delete env[key];
  }
  if (managedPrefix) {
    env.npm_config_prefix = managedPrefix;
    env.NPM_CONFIG_PREFIX = managedPrefix;
  }
  // 自升级 tgz 来自当前 server，不能让 npm 把直连 tarball URL 改写到 registry host。
  env.npm_config_replace_registry_host = "never";
  return env;
}

/**
 * 把升级安装目标显式钉到判定命中的前缀：否则 npm 会回落到被私有 launcher 污染的 npm_config_prefix，
 * 或回落到当前激活 npm 的默认前缀，把新版装进另一套安装而当前入口仍是旧版。
 */
export function pinClientUpgradeNpmPrefix(env: NodeJS.ProcessEnv, npmGlobalPrefix: string): NodeJS.ProcessEnv {
  return { ...env, npm_config_prefix: npmGlobalPrefix, NPM_CONFIG_PREFIX: npmGlobalPrefix };
}

/** 仅识别安装器的 POSIX 托管入口；源码入口及指向目录外的链接不改变 npm 目标。 */
function resolveManagedClientUpgradePrefix(env: NodeJS.ProcessEnv, entryPath: string | undefined): string | null {
  const userHome = String(env.HOME ?? env.USERPROFILE ?? "").trim();
  const entry = String(entryPath ?? "").trim();
  if (!userHome || !entry) return null;
  const prefix = path.join(userHome, ".codeflowai", "npm-global");
  const installedEntry = path.join(prefix, "lib", "node_modules", "@codeflowai", "client", "bin", "codeflow.js");
  if (!existsSync(installedEntry) || !existsSync(entry)) return null;
  if (resolveComparableInstallPath(entry) !== resolveComparableInstallPath(installedEntry)) return null;
  return isCurrentClientNpmGlobalInstall(prefix, entry) ? prefix : null;
}

/** Windows 必须在 Client 退出并释放原生 DLL 后由独立进程执行升级。 */
export function shouldUseDetachedWindowsClientUpgrade(platform: SoftwareInstallPlatform): boolean {
  return platform === "windows";
}

export type GlobalInstallSudoContext = {
  nodeExecPath?: string | null;
  entrypointPath?: string | null;
  launchedCommandPath?: string | null;
};

/** 判断全局安装命令是否应显式走 sudo 提权。 */
export function shouldUseSudoForGlobalInstall(
  platform: NodeJS.Platform | string = process.platform,
  env?: NodeJS.ProcessEnv,
  context?: GlobalInstallSudoContext,
): boolean {
  const normalized = String(platform ?? "").trim().toLowerCase();
  if (normalized !== "darwin" && normalized !== "mac" && normalized !== "linux") return false;
  return !isUserManagedNodeInstall(env ?? process.env, context ?? defaultGlobalInstallSudoContext(env));
}

/** 识别 nvm/fnm/volta/asdf 或用户目录 npm prefix，避免用户级安装误走 sudo。 */
export function isUserManagedNodeInstall(
  env: NodeJS.ProcessEnv = process.env,
  context: GlobalInstallSudoContext = defaultGlobalInstallSudoContext(),
): boolean {
  const home = normalizeFsPath(env.HOME || env.USERPROFILE || "");
  const values = [
    env.npm_config_prefix,
    env.NPM_CONFIG_PREFIX,
    env.PREFIX,
    env.NVM_DIR,
    env.FNM_DIR,
    env.VOLTA_HOME,
    env.ASDF_DIR,
    env.PATH,
    context.nodeExecPath,
    context.entrypointPath,
    context.launchedCommandPath,
  ].map((value) => normalizeFsPath(value));
  if (home && values.some((value) => value === home || value.startsWith(`${home}/`))) return true;
  return values.some((value) => /(^|\/)(\.nvm|\.fnm|\.volta|\.asdf|nvm|fnm|volta|asdf)(\/|$)/u.test(value));
}

/** 生成可执行的 Client 自升级命令；系统级 macOS/Linux 安装才前置 sudo。 */
export function buildClientUpgradeCommand(
  installUrl: string,
  platform: NodeJS.Platform | string = process.platform,
  env?: NodeJS.ProcessEnv,
  context?: GlobalInstallSudoContext,
): { command: string; args: string[] } {
  const npmArgs = buildClientUpgradeNpmArgs(installUrl);
  if (shouldUseSudoForGlobalInstall(platform, env, context)) {
    return { command: "sudo", args: ["npm", ...npmArgs] };
  }
  return { command: "npm", args: npmArgs };
}

/** CLI 的停机阶段只安装已经校验的本地包，不允许 npm 联网补包。 */
export function buildClientOfflineUpgradeCommand(
  archivePath: string,
  platform: NodeJS.Platform | string = process.platform,
  env?: NodeJS.ProcessEnv,
  context?: GlobalInstallSudoContext,
): { command: string; args: string[] } {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(archivePath) || !archivePath.endsWith(".tgz")) throw new Error("Client 离线升级必须使用本地绝对路径 tgz");
  const command = buildClientUpgradeCommand(archivePath, platform, env, context);
  // 部分 npm 版本的自身更新通知仍会尝试请求 registry，需与依赖离线模式一并关闭。
  command.args.push("--offline", "--ignore-scripts=false", "--update-notifier=false");
  return command;
}
/** 按包类型给 npm install 分配超时预算。 */
/** 读取当前进程路径上下文；显式传入 env 的测试保持纯函数行为。 */
function defaultGlobalInstallSudoContext(env?: NodeJS.ProcessEnv): GlobalInstallSudoContext {
  if (env) return {};
  return {
    nodeExecPath: process.execPath,
    entrypointPath: process.argv[1] ?? "",
    launchedCommandPath: process.env._ ?? "",
  };
}

/** 统一文件路径格式，便于判断是否位于用户目录或版本管理器目录。 */
function normalizeFsPath(value: unknown): string {
  return String(value ?? "").trim().replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

/** 按包类型给 npm install 分配超时预算。 */
function resolveNpmInstallTimeoutMs(npmPackage: string): number {
  return npmPackage === NPM_PACKAGES.claude ? CLAUDE_INSTALL_TIMEOUT_MS : DEFAULT_INSTALL_TIMEOUT_MS;
}

/** 解析 Claude Code 当前平台对应的 optional native 包名。 */
export function resolveClaudeNativePackageName(platform = process.platform, arch = process.arch): string | null {
  const normalizedPlatform = platform === "win32" || platform === "linux" || platform === "darwin" ? platform : null;
  const normalizedArch = arch === "x64" || arch === "arm64" ? arch : null;
  if (!normalizedPlatform || !normalizedArch) return null;
  return `@anthropic-ai/claude-code-${normalizedPlatform}-${normalizedArch}`;
}

/** 用当前安装源解析指定 npm 包版本，安装后必须按该版本校验。 */
async function precheckNpmPackageVisible(opts: {
  packageName: string;
  version?: string | null;
  env: NodeJS.ProcessEnv;
}): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  const packageSpec = opts.version ? `${opts.packageName}@${opts.version}` : opts.packageName;
  const result = await runCli({
    command: "npm",
    args: ["view", packageSpec, "version"],
    timeoutMs: NPM_VIEW_TIMEOUT_MS,
    env: opts.env,
  });
  const resolvedVersion = extractCliVersion(result.stdout) ?? result.stdout.trim();
  if (result.ok && resolvedVersion) return { ok: true, version: resolvedVersion };
  return { ok: false, error: `npm 源未检测到 ${packageSpec}：${result.error ?? "npm view 无输出"}` };
}

/** Claude Code 安装前预检当前平台 optional native 包。 */
async function precheckClaudeNativePackage(opts: {
  npmPackage: string;
  version?: string | null;
  env: NodeJS.ProcessEnv;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (opts.npmPackage !== NPM_PACKAGES.claude) return { ok: true };
  const nativePackageName = resolveClaudeNativePackageName();
  if (!nativePackageName) {
    return { ok: false, error: `当前平台不支持 Claude Code 平台包：${process.platform}-${process.arch}` };
  }
  const checked = await precheckNpmPackageVisible({
    packageName: nativePackageName,
    version: opts.version,
    env: opts.env,
  });
  if (!checked.ok) return checked;
  return { ok: true };
}

/** 汇总多次安装尝试的错误，便于前端直接展示排障链路。 */
function summarizeNpmInstallAttempts(attempts: NpmInstallAttempt[]): string {
  return attempts
    .filter((attempt) => !attempt.success)
    .map((attempt) => `${attempt.source}: ${attempt.error ?? "失败"}`)
    .join("\n");
}

/** 将安装失败阶段映射为前端可执行的下一步提示。 */
function resolveNpmInstallNextAction(input: {
  success: boolean;
  requiresPrivilege: boolean;
  installVerificationFailed: boolean;
  hasProxy: boolean;
}): NpmInstallResponseBody["nextAction"] {
  if (input.success) return null;
  if (input.requiresPrivilege) return "sudo";
  if (input.installVerificationFailed) return "checkPermission";
  return input.hasProxy ? "retryOfficial" : "configureProxy";
}

/** 按安装源策略查询 npm 最新版本，避免刷新卡在单一 registry。 */
async function resolveLatestNpmPackageVersion(
  npmPackage: string,
  network: NormalizedNpmInstallNetwork,
): Promise<{ version: string | null; error: string | null }> {
  const errors: string[] = [];
  for (const source of buildNpmInstallAttemptPlan(network)) {
    const { ok, stdout, error } = await runCli({
      command: "npm",
      args: ["view", npmPackage, "version"],
      timeoutMs: NPM_VIEW_TIMEOUT_MS,
      env: buildNpmInstallEnv(source, network.proxyUrl),
    });
    const version = stdout.trim();
    if (ok && version) return { version, error: null };
    errors.push(`${source}: ${error ?? "npm view 无输出"}`);
  }
  return { version: null, error: errors.join("\n") || "npm view failed" };
}

/** 归一化当前 client 运行平台，供 Web 决定安装交互方式。 */
function resolveSoftwareInstallPlatform(): SoftwareInstallPlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "mac";
  if (process.platform === "linux") return "linux";
  return "unknown";
}

/** 仅 macOS/Linux 需要通过 sudo 进入管理员权限链路。 */
function platformNeedsPrivilegePrompt(platform: SoftwareInstallPlatform): boolean {
  return platform === "mac" || platform === "linux";
}

export type NpmGlobalPrefixResult = { prefix: string | null; error: string | null };

/** 按指定安装环境探测 npm prefix，保留失败原因供升级守卫区分路径错配与探测失败。 */
export async function resolveNpmGlobalPrefixResult(env?: NodeJS.ProcessEnv): Promise<NpmGlobalPrefixResult> {
  const result = await runCli({
    command: "npm",
    args: ["config", "get", "prefix"],
    timeoutMs: 10_000,
    env,
  });
  if (!result.ok) {
    return { prefix: null, error: result.error ?? "npm config get prefix 执行失败" };
  }
  const prefix = String(result.stdout ?? "").trim();
  if (!prefix || prefix === "undefined" || prefix === "null") {
    return { prefix: null, error: `npm config get prefix 输出无效：${JSON.stringify(prefix)}` };
  }
  return { prefix, error: null };
}

/** 读取 npm 全局 prefix，用于判断当前环境是否可静默执行全局安装。 */
export async function resolveNpmGlobalPrefix(): Promise<string | null> {
  return (await resolveNpmGlobalPrefixResult()).prefix;
}

/** 解析可比较的真实路径；路径尚不存在时保留绝对路径供守卫继续判定。 */
function resolveComparableInstallPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
}

/** 判断当前 Client 入口是否位于 npm 全局 prefix 内，避免本地源码运行误改全局安装。 */
export function isCurrentClientNpmGlobalInstall(
  npmGlobalPrefix: string | null | undefined,
  entryPath: string | null | undefined = process.argv[1],
): boolean {
  const prefix = String(npmGlobalPrefix ?? "").trim();
  const entry = String(entryPath ?? "").trim();
  if (!prefix || !entry) return false;
  const relative = path.relative(
    resolveComparableInstallPath(prefix),
    resolveComparableInstallPath(entry),
  );
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export type ClientUpgradeEntryVerdict =
  | { allowed: true }
  | {
      allowed: false;
      code: "CLIENT_UPGRADE_PREFIX_UNRESOLVED" | "CLIENT_UPGRADE_REQUIRES_GLOBAL_INSTALL";
      message: string;
    };

/**
 * 判定当前入口能否执行一键升级。
 * prefix 或入口探测失败时必须显式报出原因，不得降级为“非全局入口”结论，避免把环境故障误报成用户在跑源码。
 */
export function resolveClientUpgradeEntryVerdict(
  npmGlobalPrefix: string | null | undefined,
  prefixError: string | null | undefined,
  entryPath: string | null | undefined = process.argv[1],
): ClientUpgradeEntryVerdict {
  const prefix = String(npmGlobalPrefix ?? "").trim();
  const entry = String(entryPath ?? "").trim();
  if (!prefix) {
    const reason = String(prefixError ?? "").trim() || "npm config get prefix 未返回结果";
    return {
      allowed: false,
      code: "CLIENT_UPGRADE_PREFIX_UNRESOLVED",
      message: `无法确认 npm 全局安装目录（${reason}），已中止升级以避免误改其他 Client。`,
    };
  }
  if (!entry) {
    return {
      allowed: false,
      code: "CLIENT_UPGRADE_PREFIX_UNRESOLVED",
      message: "无法确认当前 Client 启动入口，已中止升级以避免误改其他 Client。",
    };
  }
  if (!isCurrentClientNpmGlobalInstall(prefix, entry)) {
    return {
      allowed: false,
      code: "CLIENT_UPGRADE_REQUIRES_GLOBAL_INSTALL",
      message: `当前 Client 由本地源码或非全局入口运行（入口 ${entry} 不在 npm 全局目录 ${prefix} 内），为避免影响已安装的全局 Client，已拒绝升级。`,
    };
  }
  return { allowed: true };
}

export type ClientUpgradeTargetResolution =
  | { allowed: true; npmGlobalPrefix: string }
  | {
      allowed: false;
      code: "CLIENT_UPGRADE_PREFIX_UNRESOLVED" | "CLIENT_UPGRADE_REQUIRES_GLOBAL_INSTALL";
      message: string;
      /** 本次按优先级试过的候选前缀，用于失败日志定位真实探测值。 */
      candidates: string[];
    };

/**
 * 解析升级的安装目标前缀：在候选前缀中找出入口真正所属的全局前缀，并回传命中前缀用于钉住 npm 安装目标。
 * 候选顺序见 resolveClientEntryPrefixCandidates（入口自有前缀 → 探测值 → Windows 私有前缀）；
 * 自有前缀先判定并立即返回（它不会被后面未命中的候选覆盖成拒绝），其余候选沿用“仅包含判定”，命中即返回。
 */
export function resolveClientUpgradeInstallTarget(input: {
  npmGlobalPrefix: string | null | undefined;
  prefixError: string | null | undefined;
  platform?: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv;
  entryPath?: string | null;
}): ClientUpgradeTargetResolution {
  const prefix = String(input.npmGlobalPrefix ?? "").trim();
  const entry = String(input.entryPath ?? process.argv[1] ?? "").trim();
  const { ownedPrefix, prefixes } = resolveClientEntryPrefixCandidates({
    npmGlobalPrefix: prefix,
    platform: input.platform,
    env: input.env,
    entryPath: entry,
  });
  const build = (verdict: ClientUpgradeEntryVerdict, matchedPrefix: string): ClientUpgradeTargetResolution => {
    if (verdict.allowed) return { allowed: true, npmGlobalPrefix: matchedPrefix };
    return { allowed: false, code: verdict.code, message: verdict.message, candidates: prefixes };
  };

  let last: ClientUpgradeTargetResolution | null = null;
  if (ownedPrefix) {
    const owned = build(resolveClientUpgradeEntryVerdict(ownedPrefix, null, entry), ownedPrefix);
    if (owned.allowed) return owned;
    last = owned;
  }
  for (const candidate of prefixes) {
    if (candidate === ownedPrefix) continue;
    // 命中必须立即返回命中前缀：安装目标只能按它钉住，否则会装到另一套安装。
    const resolution = build(resolveClientUpgradeEntryVerdict(candidate, null, entry), candidate);
    if (resolution.allowed) return resolution;
    last = resolution;
  }
  // prefix 探测失败时优先回报探测原因，避免把环境故障说成“用户在跑源码”。
  if (!prefix && input.prefixError) {
    return build(resolveClientUpgradeEntryVerdict(null, input.prefixError, entry), "");
  }
  return last ?? build(resolveClientUpgradeEntryVerdict(null, input.prefixError, entry), "");
}

/** 检查目标路径或其最近已存在父目录是否对当前用户可写。 */
async function isPathWritableOrCreatable(targetPath: string): Promise<boolean> {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      const stat = await fs.stat(current);
      const writableTarget = stat.isDirectory() ? current : path.dirname(current);
      await fs.access(writableTarget, fsConstants.W_OK);
      return true;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

/** 探测 npm 全局安装相关目录是否可写。 */
async function detectNpmGlobalInstallWritable(prefix: string | null): Promise<boolean | null> {
  if (!prefix) return null;
  const candidates = process.platform === "win32"
    ? [prefix, path.join(prefix, "node_modules")]
    : [prefix, path.join(prefix, "bin"), path.join(prefix, "lib", "node_modules")];
  const results = await Promise.all(candidates.map((candidate) => isPathWritableOrCreatable(candidate)));
  return results.every(Boolean);
}

/** 聚合当前 client 的平台与 npm 全局安装权限环境；可复用调用方已探测的 prefix，避免重复执行 npm。 */
async function resolveSoftwareInstallEnvironment(
  prefixResult?: NpmGlobalPrefixResult,
): Promise<SoftwareInstallEnvironment> {
  const platform = resolveSoftwareInstallPlatform();
  const npmGlobalPrefix = (prefixResult ?? await resolveNpmGlobalPrefixResult()).prefix;
  const npmGlobalInstallWritable = await detectNpmGlobalInstallWritable(npmGlobalPrefix);
  return {
    platform,
    npmGlobalPrefix,
    npmGlobalInstallWritable,
    requiresPrivilege: platformNeedsPrivilegePrompt(platform) && npmGlobalInstallWritable === false,
  };
}

/** 从 npm 错误文本中识别权限类失败，用于回退到 sudo 引导。 */
function isPrivilegeInstallError(platform: SoftwareInstallPlatform, errorText: string | null | undefined): boolean {
  if (!platformNeedsPrivilegePrompt(platform)) return false;
  const normalized = String(errorText ?? "").toLowerCase();
  if (!normalized) return false;
  return normalized.includes("eacces")
    || normalized.includes("permission denied")
    || normalized.includes("operation not permitted")
    || normalized.includes("errno -13");
}

function toHttpBaseFromWsUrl(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const normalized = String(hostname ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "::1") return true;
  if (normalized.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  const match172 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(normalized);
  if (match172) {
    const second = Number(match172[1]);
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
  }
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^(fc|fd)[0-9a-f:]+$/i.test(normalized)) return true;
  if (/^fe[89ab][0-9a-f:]+$/i.test(normalized)) return true;
  return false;
}

function isTrustedClientUpgradeHttpUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return isLoopbackOrPrivateHostname(url.hostname);
  } catch {
    return false;
  }
}

/** 判断公网 HTTP 下载地址是否绑定到当前已连接 Server 和受限 client 包路径。 */
function isSameServerPublicHttpDownloadUrl(rawUrl: string, serverWsUrl: string | null | undefined, downloadPath: string): boolean {
  try {
    const url = new URL(rawUrl);
    const serverUrl = new URL(String(serverWsUrl ?? ""));
    if (url.protocol !== "http:" || serverUrl.protocol !== "ws:") return false;
    if (url.hostname.toLowerCase() !== serverUrl.hostname.toLowerCase()) return false;
    return url.pathname === downloadPath;
  } catch {
    return false;
  }
}

function normalizeClientDownloadPath(rawValue: unknown): string | null {
  const path = String(rawValue ?? "").trim();
  if (!path) return null;
  if (!/^\/downloads\/codeflowai-(latest|\d{4}\.\d{2}\.\d{2}\.\d+)(?:-(win32|linux|darwin)-(x64|arm64))?\.tgz$/i.test(path)) {
    return null;
  }
  return path;
}

/** 解析 Client 升级安装地址；只接受 HTTPS、本机/内网 HTTP 或当前 Server 同主机下载路径。 */
export function resolveClientUpgradeInstallUrl(input: {
  serverWsUrl?: string | null;
  downloadPath?: string | null;
  installUrl?: string | null;
}): string | null {
  const downloadPath = normalizeClientDownloadPath(input.downloadPath);
  const httpBase = input.serverWsUrl ? toHttpBaseFromWsUrl(String(input.serverWsUrl)) : null;
  if (downloadPath && httpBase) {
    // downloadPath 是服务端生成的受限相对路径；同源下载地址以当前已连接 serverWsUrl 为准。
    const sameServerInstallUrl = `${httpBase}${downloadPath}`;
    if (
      isTrustedClientUpgradeHttpUrl(sameServerInstallUrl)
      || isSameServerPublicHttpDownloadUrl(sameServerInstallUrl, input.serverWsUrl, downloadPath)
    ) {
      return sameServerInstallUrl;
    }
  }

  const installUrl = String(input.installUrl ?? "").trim();
  if (isTrustedClientUpgradeHttpUrl(installUrl)) {
    return installUrl;
  }
  return null;
}

async function probeCli(engineType: EngineType): Promise<CliProbeResult> {
  const resolved = engineType === "claude" ? resolveClaudeCli() : resolveCodexCli();
  const binPath = resolveCliDisplayPath(resolved);
  const result = await runCli({
    command: resolved.command,
    args: [...resolved.argsPrefix, "--version"],
    timeoutMs: INSTALL_VERIFY_TIMEOUT_MS,
  });
  if (!result.ok) {
    return {
      installed: false,
      version: null,
      binPath,
      error: result.error ?? `安装后未检测到 ${engineType} CLI`,
    };
  }
  return {
    installed: true,
    version: extractCliVersion(result.stdout),
    binPath,
    error: null,
  };
}

export async function verifyInstalledCliPackage(opts: {
  npmPackage: string;
  requestedVersion?: string | null;
  probes?: CliProbeMap;
}): Promise<CliInstallVerificationResult> {
  const npmPackage = String(opts.npmPackage ?? "").trim();
  const engineType = PACKAGE_TO_ENGINE[npmPackage];
  if (!engineType) {
    return {
      success: false,
      installedVersion: null,
      binPath: null,
      error: `不支持校验的 npm 包：${npmPackage || "<empty>"}`,
    };
  }

  const probe = opts.probes?.[engineType] ?? (() => probeCli(engineType));
  const detected = await probe();
  if (!detected.installed) {
    return {
      success: false,
      installedVersion: null,
      binPath: detected.binPath,
      error: detected.error ?? `安装后未检测到 ${npmPackage}`,
    };
  }

  const requestedVersion = String(opts.requestedVersion ?? "").trim();
  if (requestedVersion) {
    if (!detected.version) {
      return {
        success: false,
        installedVersion: null,
        binPath: detected.binPath,
        error: `安装后无法读取 ${npmPackage} 的版本`,
      };
    }
    if (detected.version !== requestedVersion) {
      const binPathHint = detected.binPath ? `（当前命令：${detected.binPath}）` : "";
      return {
        success: false,
        installedVersion: detected.version,
        binPath: detected.binPath,
        error: `安装后版本不匹配：期望 ${requestedVersion}，实际 ${detected.version}${binPathHint}。请检查 PATH 是否仍指向旧 CLI。`,
      };
    }
  }

  return {
    success: true,
    installedVersion: detected.version,
    binPath: detected.binPath,
    error: null,
  };
}

/** 当前 CLI 已经满足目标版本时返回短路结果，避免重复执行 npm install。 */
export async function resolveAlreadyInstalledCliVersion(opts: {
  npmPackage: string;
  requestedVersion?: string | null;
  probes?: CliProbeMap;
}): Promise<CliInstallNoopResult | null> {
  const requestedVersion = String(opts.requestedVersion ?? "").trim();
  if (!requestedVersion) return null;

  const verification = await verifyInstalledCliPackage({
    npmPackage: opts.npmPackage,
    requestedVersion,
    probes: opts.probes,
  });
  if (!verification.success || !verification.installedVersion) return null;
  return {
    installedVersion: verification.installedVersion,
    binPath: verification.binPath,
    message: `无需升级，当前已是 ${verification.installedVersion}`,
  };
}

/** 读取异常上的稳定错误码；无 code 时使用调用方兜底。 */
function readErrorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : fallback;
}

/** 从安装结果文本中提取首个 PRIVATE_CLI_* 错误码。 */
function readPrivateCliErrorCode(error: string | null): string | null {
  return /(PRIVATE_CLI_[A-Z0-9_]+)/u.exec(String(error ?? ""))?.[1] ?? null;
}

/** 私有运行时配置不可用时显式 503，禁止回退全局安装链路。 */
function sendPrivateCliUnavailable(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  error: unknown,
  action: string,
): void {
  const code = readErrorCode(error, "PRIVATE_CLI_RUNTIME_CONFIG_INVALID");
  const rootCause = error instanceof Error ? error.message : String(error);
  logger.error("private-cli", `私有 CLI ${action}失败：运行时配置不可用`, {
    requestId: req.id,
    engine: null,
    version: null,
    code,
    rootCause,
  });
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 503,
    body: {
      ok: false,
      code,
      message: `应用私有 CLI 运行时配置不可用（${code}），已停止本次操作。`,
    },
  });
}

/** 私有模式安装：固定版本校验、互斥锁、应用私有目录安装与探测缓存刷新。 */
async function handlePrivateNpmInstall(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  input: {
    npmPackage: string;
    version: string | null;
    network: NormalizedNpmInstallNetwork;
    config: PrivateCliRuntimeConfig;
  },
): Promise<void> {
  const engine = PACKAGE_TO_ENGINE[input.npmPackage];
  if (engine !== "claude" && engine !== "codex") {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: `不允许安装的包：${input.npmPackage}` } });
    return;
  }

  let pinnedVersion: string;
  try {
    pinnedVersion = assertPrivateInstallVersion(input.config.manifest, engine, input.version);
  } catch (error) {
    // 只有版本不匹配是用户输入问题；其他异常必须上抛，不能被误报成 400 掩盖故障。
    if ((error as { code?: unknown } | null)?.code !== PRIVATE_CLI_VERSION_MISMATCH) throw error;
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: {
        ok: false,
        code: PRIVATE_CLI_VERSION_MISMATCH,
        message: `应用私有 CLI 固定版本为 ${input.config.manifest.engines[engine].version}，不接受其他版本。`,
      },
    });
    return;
  }

  const lock = acquireGlobalNpmInstall(`私有 CLI 安装：${engine}`);
  if (!lock.ok) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, code: "CONFLICT", message: `当前已有安装任务正在进行中：${lock.activeTask.label}` },
    });
    return;
  }

  try {
    const attempts = buildNpmInstallAttemptPlan(input.network).map((source) => ({
      source,
      env: buildNpmInstallEnv(source, input.network.proxyUrl),
    }));
    let result: PrivateCliInstallResult;
    try {
      result = await installPrivateCli({
        root: input.config.root,
        engine,
        manifest: input.config.manifest,
        npmCliPath: input.config.npmCliPath,
        attempts,
        requestId: req.id,
      });
    } catch (error) {
      const code = readErrorCode(error, "PRIVATE_CLI_INSTALL_FAILED");
      const rootCause = error instanceof Error ? error.message : String(error);
      logger.error("private-cli", "私有 CLI 安装失败", {
        requestId: req.id,
        engine,
        version: pinnedVersion,
        code,
        rootCause,
      });
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 500,
        body: { ok: false, code, message: "安装到应用私有目录失败" },
      });
      return;
    }

    if (result.success) {
      // 安装完成后必须绕过 20 秒探测缓存，否则状态页仍会显示未安装。
      if (engine === "claude") await buildClaudeStatus([], undefined, { forceRefresh: true });
      else await buildCodexStatus([], undefined, { forceRefresh: true });
    } else {
      logger.error("private-cli", "私有 CLI 安装失败", {
        requestId: req.id,
        engine,
        version: pinnedVersion,
        code: readPrivateCliErrorCode(result.error) ?? "PRIVATE_CLI_INSTALL_FAILED",
        rootCause: result.error,
      });
    }

    ctx.send({
      t: "api.res",
      id: req.id,
      status: 200,
      body: {
        ok: true,
        npmPackage: input.npmPackage,
        success: result.success,
        installedVersion: result.installedVersion,
        output: result.output,
        error: result.error,
        message: result.success
          ? "已安装到应用私有目录，无需系统权限"
          : "安装到应用私有目录失败",
        requiresPrivilege: false,
        attempts: result.attempts,
        nextAction: null,
      },
    });
  } finally {
    lock.release();
  }
}

/** 处理 `software.update.status`：探测 Claude/Codex 安装状态 + npm 最新版本。 */
export async function handleSoftwareUpdateStatus(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const networkResult = normalizeNpmInstallNetwork((req.body as any)?.network);
  const forceRefresh = Boolean((req.body as any)?.forceRefresh);
  if (!networkResult.ok) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: networkResult.message } });
    return;
  }
  let privateConfig: PrivateCliRuntimeConfig | null;
  try {
    privateConfig = await readPrivateCliRuntimeConfig(process.env, req.id);
  } catch (error) {
    sendPrivateCliUnavailable(ctx, req, error, "读取状态");
    return;
  }

  const [claude, codex] = await Promise.all([
    buildClaudeStatus([], undefined, { forceRefresh }),
    buildCodexStatus([], undefined, { forceRefresh }),
  ]);

  if (privateConfig) {
    // 私有模式不探测、不依赖 npm 全局目录，因此不执行 npm config get prefix。
    const environment: SoftwareInstallEnvironment = {
      platform: resolveSoftwareInstallPlatform(),
      npmGlobalPrefix: null,
      npmGlobalInstallWritable: null,
      requiresPrivilege: false,
      installMode: "private",
    };
    const items = buildPrivateSoftwareUpdateItems({ manifest: privateConfig.manifest, claude, codex });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, items, environment } });
    return;
  }

  const environment = await resolveSoftwareInstallEnvironment();
  const network = networkResult.network;

  const items: SoftwareUpdateStatus[] = await Promise.all(
    [claude, codex].map(async (engine) => {
      const engineType = engine.engineType;
      const npmPackage = NPM_PACKAGES[engineType];
      const latest = await resolveLatestNpmPackageVersion(npmPackage, network);

      // engine.version 可能包含前缀/后缀，如 "2.1.69 (Claude Code)" 或 "codex-cli 0.98.0"
      // 提取其中的 semver 版本号用于比较
      const currentVersion = extractCliVersion(engine.version);
      const updateAvailable = Boolean(
        engine.installed && currentVersion && latest.version && currentVersion !== latest.version,
      );

      return {
        engineType,
        installed: engine.installed,
        currentVersion,
        latestVersion: latest.version,
        binPath: engine.binPath,
        npmPackage,
        updateAvailable,
        error: engine.error ?? latest.error,
      };
    }),
  );

  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, items, environment } });
}

/** 处理 `software.npm.install`：npm install -g 白名单包。 */
export async function handleNpmInstall(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const npmPackage = String((req.body as any)?.npmPackage ?? "").trim();
  const version = typeof (req.body as any)?.version === "string" ? String((req.body as any).version).trim() : null;
  const networkResult = normalizeNpmInstallNetwork((req.body as any)?.network);

  if (!npmPackage) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：npmPackage" } });
    return;
  }
  if (!networkResult.ok) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: networkResult.message } });
    return;
  }
  if (!ALLOWED_PACKAGES.has(npmPackage)) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: `不允许安装的包：${npmPackage}` } });
    return;
  }

  let privateConfig: PrivateCliRuntimeConfig | null;
  try {
    privateConfig = await readPrivateCliRuntimeConfig(process.env, req.id);
  } catch (error) {
    sendPrivateCliUnavailable(ctx, req, error, "安装");
    return;
  }
  if (privateConfig) {
    // 私有模式必须走应用私有目录，禁止探测 npm 全局 prefix / sudo / 系统 CLI 版本。
    await handlePrivateNpmInstall(ctx, req, {
      npmPackage,
      version,
      network: networkResult.network,
      config: privateConfig,
    });
    return;
  }

  const environment = await resolveSoftwareInstallEnvironment();
  if (environment.requiresPrivilege) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 200,
      body: {
        ok: true,
        npmPackage,
        success: false,
        installedVersion: null,
        output: "",
        error: "当前 npm 全局目录不可写，请在本机终端使用 sudo 执行安装命令。",
        requiresPrivilege: true,
        nextAction: "sudo",
      },
    });
    return;
  }

  const lock = acquireGlobalNpmInstall(`大模型 CLI 更新：${npmPackage}`);
  if (!lock.ok) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, code: "CONFLICT", message: `当前已有安装任务正在进行中：${lock.activeTask.label}` },
    });
    return;
  }

  const network = networkResult.network;
  const installPlan = buildNpmInstallAttemptPlan(network);
  const attempts: NpmInstallAttempt[] = [];
  let output = "";
  let installedVersion: string | null = null;
  let success = false;
  let error: string | null = null;
  let requiresPrivilege = false;
  let installVerificationFailed = false;
  try {
    for (const source of installPlan) {
      const startedAt = Date.now();
      const env = buildNpmInstallEnv(source, network.proxyUrl);
      const registry = registryForNpmInstallSource(source);
      let attemptSuccess = false;
      let attemptError: string | null = null;

      const packageCheck = await precheckNpmPackageVisible({ packageName: npmPackage, version, env });
      if (!packageCheck.ok) {
        attemptError = packageCheck.error;
      } else {
        const alreadyInstalled = await resolveAlreadyInstalledCliVersion({
          npmPackage,
          requestedVersion: packageCheck.version,
        });
        if (alreadyInstalled) {
          ctx.send({
            t: "api.res",
            id: req.id,
            status: 200,
            body: {
              ok: true,
              npmPackage,
              success: true,
              installedVersion: alreadyInstalled.installedVersion,
              output: "",
              error: null,
              message: alreadyInstalled.message,
              noUpgradeNeeded: true,
              attempts: [],
              nextAction: null,
            },
          });
          return;
        }

        const precheck = await precheckClaudeNativePackage({ npmPackage, version: packageCheck.version, env });
        if (!precheck.ok) {
          attemptError = precheck.error;
        } else {
          const installPackageSpec = `${npmPackage}@${packageCheck.version}`;
          const installResult = await runCli({
            command: "npm",
            args: buildNpmInstallArgs(installPackageSpec),
            timeoutMs: resolveNpmInstallTimeoutMs(npmPackage),
            env,
          });
          if (installResult.stdout.trim()) {
            output = output
              ? `${output}\n\n[${source}]\n${installResult.stdout.trim()}`
              : `[${source}]\n${installResult.stdout.trim()}`;
          }
          if (!installResult.ok) {
            attemptError = installResult.error ?? "npm install failed";
            requiresPrivilege = requiresPrivilege || isPrivilegeInstallError(environment.platform, attemptError);
          } else {
            const verification = await verifyInstalledCliPackage({
              npmPackage,
              requestedVersion: packageCheck.version,
            });
            installedVersion = verification.installedVersion;
            if (verification.success) {
              attemptSuccess = true;
              success = true;
              error = null;
            } else {
              attemptError = verification.error ?? "安装后本机 CLI 校验失败";
              installVerificationFailed = true;
            }
          }
        }
      }

      attempts.push({
        source,
        registry,
        success: attemptSuccess,
        error: attemptError,
        durationMs: Math.max(0, Date.now() - startedAt),
      });

      if (attemptSuccess) break;
      error = attemptError;
      if (requiresPrivilege) break;
    }

    if (!success) {
      error = summarizeNpmInstallAttempts(attempts) || error || "npm install failed";
    }

    ctx.send({
      t: "api.res",
      id: req.id,
      status: 200,
      body: {
        ok: true,
        npmPackage,
        success,
        installedVersion,
        output,
        error,
        requiresPrivilege,
        attempts,
        nextAction: resolveNpmInstallNextAction({
          success,
          requiresPrivilege,
          installVerificationFailed,
          hasProxy: Boolean(network.proxyUrl),
        }),
      },
    });
  } finally {
    lock.release();
  }
}

/** 处理 `client.exit`：先响应成功，再走统一 shutdown 链路退出当前 client。 */
export async function handleClientExit(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const clientId = String((req.body as any)?.clientId ?? "").trim();
  if (!clientId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：clientId" } });
    return;
  }

  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: { ok: true, clientId, exiting: true },
  });

  setTimeout(() => {
    if (ctx.requestShutdown) {
      ctx.requestShutdown(`client.exit:${clientId}`);
    } else {
      process.exit(0);
    }
  }, 100);
}

/** 桌面壳内启动的 Client 由壳统一更新，禁止再走独立 npm 升级。 */
function isDesktopEmbeddedClient(): boolean {
  return Boolean(process.env.CODEFLOWAI_DESKTOP_REQUEST_ID?.trim()
    || process.env.CODEFLOWAI_DESKTOP_STARTUP_MODE?.trim());
}

/** 处理 `client.upgrade`：Windows 移交独立升级器，其他平台等待 npm 安装结果。 */
export async function handleClientUpgrade(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  if (isDesktopEmbeddedClient()) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 410,
      body: {
        ok: false,
        upgraded: false,
        code: "CLIENT_DISTRIBUTION_RETIRED",
        message: "桌面版 Client 随应用更新，不再支持独立升级",
      },
    });
    return;
  }
  const installUrl = resolveClientUpgradeInstallUrl({
    serverWsUrl: ctx.serverWsUrl ?? null,
    downloadPath: (req.body as any)?.downloadPath ?? null,
    installUrl: (req.body as any)?.installUrl ?? null,
  });
  const targetVersion = String((req.body as any)?.targetVersion ?? "").trim();
  if (!installUrl) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, message: "参数错误：缺少可信的 client 安装地址" },
    });
    return;
  }

  const upgradeEnv = buildClientUpgradeNpmEnv();
  const prefixResult = await resolveNpmGlobalPrefixResult(upgradeEnv);
  const entryTarget = resolveClientUpgradeInstallTarget({
    npmGlobalPrefix: prefixResult.prefix, prefixError: prefixResult.error, platform: process.platform, env: upgradeEnv,
  });
  if (!entryTarget.allowed) {
    logger.error("client-upgrade", "client upgrade entry check rejected", {
      code: entryTarget.code,
      requestId: req.id,
      clientId: ctx.clientId,
      rootCause: entryTarget.message,
      npmGlobalPrefix: prefixResult.prefix,
      npmGlobalPrefixError: prefixResult.error,
      entryPath: process.argv[1] ?? null,
      candidates: entryTarget.candidates,
    });
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        upgraded: false,
        code: entryTarget.code,
        message: `${entryTarget.message}请在本机终端执行 codeflow --update 升级全局 Client。`,
      },
    });
    return;
  }

  // 安装目标与权限判定都按判定命中的前缀：探测值可能漂移，按它判断可写性会得出错误结论。
  const environment = await resolveSoftwareInstallEnvironment({ prefix: entryTarget.npmGlobalPrefix, error: null });
  const detachedWindowsUpgrade = shouldUseDetachedWindowsClientUpgrade(environment.platform);
  if (environment.requiresPrivilege) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 200,
      body: {
        ok: true,
        upgraded: false,
        error: "当前 npm 全局目录不可写，请在本机终端使用 sudo 执行手动升级命令。",
        requiresPrivilege: true,
      },
    });
    return;
  }

  const windowsResultReport = detachedWindowsUpgrade
    ? resolveWindowsUpgradeResultReport(ctx.serverWsUrl, req.body)
    : null;
  if (detachedWindowsUpgrade && !windowsResultReport) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, upgraded: false, message: "参数错误：缺少 Windows Client 升级结果回报信息" },
    });
    return;
  }

  const fromVersion = readSelfVersion() ?? "unknown";
  const upgradeLabel = targetVersion
    ? `客户端升级：${fromVersion} -> ${targetVersion}`
    : `客户端升级：${fromVersion}`;
  const lock = acquireGlobalNpmInstall(upgradeLabel);
  if (!lock.ok) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, code: "CONFLICT", message: `当前已有安装任务正在进行中：${lock.activeTask.label}` },
    });
    return;
  }

  const result = detachedWindowsUpgrade
    ? launchWindowsClientUpgrade({
      installUrl,
      npmPrefix: entryTarget.npmGlobalPrefix,
      targetVersion,
      fromVersion,
      daemonWasRunning: isClientDaemonChild(),
      resultReport: windowsResultReport!,
      lock,
    })
    : await runClientUpgradeInstall({
      installUrl,
      targetVersion,
      fromVersion,
      platform: environment.platform,
      env: pinClientUpgradeNpmPrefix(upgradeEnv, entryTarget.npmGlobalPrefix),
      lock,
    });
  if (detachedWindowsUpgrade && result.ok) scheduleClientShutdownForDetachedUpgrade(ctx, lock);
  ctx.send({
    t: "api.res",
    id: req.id,
    status: result.ok ? 200 : 502,
    body: result,
  });
  if (!result.ok) return;
  if (!detachedWindowsUpgrade) scheduleClientUpgradeRestart(ctx);
}

type ClientUpgradeInstallResult =
  | { ok: true; upgraded: boolean; upgradeStarted: true; fromVersion: string; toVersion: string | null }
  | {
    ok: false;
    upgraded: false;
    message: string;
    error: string;
    requiresPrivilege: boolean;
    fromVersion: string;
    toVersion: string | null;
  };

/** 启动 Windows 独立升级器；只表示成功移交，不把未完成安装伪装为成功。 */
function launchWindowsClientUpgrade(input: {
  installUrl: string;
  npmPrefix: string;
  targetVersion: string;
  fromVersion: string;
  daemonWasRunning: boolean;
  resultReport: WindowsUpgradeResultReport;
  lock: { release: () => void };
}): ClientUpgradeInstallResult {
  logger.info("client-upgrade", "windows client upgrade handoff started", {
    fromVersion: input.fromVersion,
    targetVersion: input.targetVersion || null,
    parentPid: process.pid,
    daemonWasRunning: input.daemonWasRunning,
  });
  try {
    launchWindowsDetachedUpgrade({
      installUrl: input.installUrl,
      npmPrefix: input.npmPrefix,
      parentPid: process.pid,
      daemonWasRunning: input.daemonWasRunning,
      targetVersion: input.targetVersion,
      previousClientPid: input.daemonWasRunning ? process.pid : null,
      resultReport: input.resultReport,
    });
    logger.info("client-upgrade", "windows client upgrade handed off", {
      fromVersion: input.fromVersion,
      targetVersion: input.targetVersion || null,
      parentPid: process.pid,
      daemonWasRunning: input.daemonWasRunning,
    });
    return {
      ok: true,
      upgraded: false,
      upgradeStarted: true,
      fromVersion: input.fromVersion,
      toVersion: input.targetVersion || null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("client-upgrade", "windows client upgrade handoff failed", {
      fromVersion: input.fromVersion,
      targetVersion: input.targetVersion || null,
      parentPid: process.pid,
      error: message,
    });
    const result: ClientUpgradeInstallResult = {
      ok: false,
      upgraded: false,
      message: `Windows Client 升级启动失败：${message}`,
      error: message,
      requiresPrivilege: false,
      fromVersion: input.fromVersion,
      toVersion: input.targetVersion || null,
    };
    input.lock.release();
    return result;
  }
}

/** 从当前 Server 连接和受控 RPC 字段构造 detached 升级结果回报参数。 */
function resolveWindowsUpgradeResultReport(
  serverWsUrl: string | null | undefined,
  body: unknown,
): WindowsUpgradeResultReport | null {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const upgradeId = String(record?.upgradeId ?? "").trim();
  const token = String(record?.resultToken ?? "").trim();
  const fromVersion = readSelfVersion() ?? "unknown";
  const toVersion = String(record?.targetVersion ?? "").trim();
  const httpBase = serverWsUrl ? toHttpBaseFromWsUrl(serverWsUrl) : null;
  if (!httpBase || !/^[a-z0-9]+-[a-z0-9]+$/i.test(upgradeId)) return null;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token) || !toVersion) return null;
  return {
    url: `${httpBase}/api/client/upgrade-result`,
    upgradeId,
    token,
    fromVersion,
    toVersion,
  };
}

/** 执行 npm 自升级；失败返回给调用方，成功由调用方安排重启。 */
async function runClientUpgradeInstall(
  input: {
    installUrl: string;
    targetVersion: string;
    fromVersion: string;
    platform: SoftwareInstallPlatform;
    env: NodeJS.ProcessEnv;
    lock: { release: () => void };
  },
): Promise<ClientUpgradeInstallResult> {
  logger.info("client-upgrade", "client upgrade install started", {
    fromVersion: input.fromVersion,
    targetVersion: input.targetVersion || null,
  });
  try {
    const result = await runCli({
      command: "npm",
      args: buildClientUpgradeNpmArgs(input.installUrl),
      timeoutMs: 5 * 60_000,
      env: input.env,
    });

    if (!result.ok) {
      const error = result.error ?? "npm install failed";
      const requiresPrivilege = isPrivilegeInstallError(input.platform, error);
      const message = requiresPrivilege
        ? "当前 npm 全局目录不可写，请在本机终端使用 sudo 执行手动升级命令。"
        : `Client 升级安装失败：${error}`;
      logger.error("client-upgrade", "client upgrade install failed", {
        fromVersion: input.fromVersion,
        targetVersion: input.targetVersion || null,
        requiresPrivilege,
        error: requiresPrivilege ? "npm global prefix requires privilege" : error,
      });
      return {
        ok: false,
        upgraded: false,
        message,
        error,
        requiresPrivilege,
        fromVersion: input.fromVersion,
        toVersion: input.targetVersion || null,
      };
    }

    logger.info("client-upgrade", "client upgrade install finished", {
      fromVersion: input.fromVersion,
      targetVersion: input.targetVersion || null,
    });
    return {
      ok: true,
      upgraded: true,
      upgradeStarted: true,
      fromVersion: input.fromVersion,
      toVersion: input.targetVersion || null,
    };
  } finally {
    input.lock.release();
  }
}

/** detached 升级器启动后持有安装锁至延迟 shutdown，阻止重复升级竞态。 */
function scheduleClientShutdownForDetachedUpgrade(
  ctx: Pick<ApiHandlerContext, "requestShutdown">,
  lock: { release: () => void },
): void {
  setTimeout(() => {
    lock.release();
    if (ctx.requestShutdown) {
      ctx.requestShutdown("client.upgrade.detached");
    } else {
      process.exit(0);
    }
  }, 1500);
}

/** 安装成功后延迟重启，给 api.res 留出发送窗口。 */
function scheduleClientUpgradeRestart(ctx: Pick<ApiHandlerContext, "requestShutdown">): void {
  setTimeout(() => {
    let spawned = false;
    try {
      if (isClientDaemonChild()) {
        spawnClientDaemonReplacementFromCurrentProcess();
      } else {
        spawn(process.argv[0]!, [...process.execArgv, ...process.argv.slice(1)], {
          detached: true,
          stdio: "ignore",
          env: buildClientRestartEnv(process.env),
          windowsHide: true,
        }).unref();
      }
      spawned = true;
    } catch (error) {
      logger.error("client-upgrade", "client upgrade restart spawn failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (ctx.requestShutdown) {
      ctx.requestShutdown("client.upgrade.restart");
    } else if (spawned) {
      process.exit(0);
    }
  }, 1500);
}

