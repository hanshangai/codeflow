import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import type {
  EngineStatus,
  NpmInstallAttempt,
  NpmInstallSourceMode,
  SoftwareUpdateStatus,
} from "@codeflowai/shared";

import {
  parsePrivateCliManifest,
  privateCliNpmPackage,
  type PrivateCliEngine,
  type PrivateCliManifest,
  type PrivateCliRuntimeConfig,
} from "../../cli-runtime/privateCliManifest.js";
import {
  parsePrivateCliRuntimeEntry,
  privateCliEngineRoot,
  type PrivateCliRuntimeEntry,
} from "../../cli-runtime/privateCliPaths.js";
import { logger } from "../../logger.js";
import { buildCodexNodeArgs } from "../../engines/codex-app-server/codexAppServerCli.js";
import { runCli } from "./engineHandlers.js";
import { getActiveGlobalNpmInstall } from "./globalNpmInstallLock.js";

/** 磁盘预检不足：至少需要 staging 与旧版本同时存在的空间。 */
export const PRIVATE_CLI_DISK_INSUFFICIENT = "PRIVATE_CLI_DISK_INSUFFICIENT";
/** 无法读取磁盘空间（statfs 不可用或失败），必须显式失败而不是跳过预检。 */
export const PRIVATE_CLI_DISK_CHECK_UNAVAILABLE = "PRIVATE_CLI_DISK_CHECK_UNAVAILABLE";
/** 原生包与当前平台不匹配，或多平台包同时存在。 */
export const PRIVATE_CLI_PLATFORM_PACKAGE_INVALID = "PRIVATE_CLI_PLATFORM_PACKAGE_INVALID";
/** 所有 npm 尝试都失败，安装未完成。 */
export const PRIVATE_CLI_INSTALL_FAILED = "PRIVATE_CLI_INSTALL_FAILED";
/** 安装后探测失败或版本与清单固定版本不一致。 */
export const PRIVATE_CLI_PROBE_FAILED = "PRIVATE_CLI_PROBE_FAILED";
/** 原子替换失败且回滚未能完全恢复。 */
export const PRIVATE_CLI_SWAP_FAILED = "PRIVATE_CLI_SWAP_FAILED";
/** 私有运行时环境变量不完整或路径非法；不得因此回退全局安装。 */
export const PRIVATE_CLI_RUNTIME_CONFIG_INVALID = "PRIVATE_CLI_RUNTIME_CONFIG_INVALID";
/** 随包清单不可解析或不符合固定清单格式。 */
export const PRIVATE_CLI_RUNTIME_MANIFEST_INVALID = "PRIVATE_CLI_RUNTIME_MANIFEST_INVALID";
/** 请求安装版本与清单固定版本不一致。 */
export const PRIVATE_CLI_VERSION_MISMATCH = "PRIVATE_CLI_VERSION_MISMATCH";
/** 过期 .previous-* 清理失败（Windows EBUSY/EPERM）；只记录，不使安装失败。 */
export const PRIVATE_CLI_STALE_CLEANUP_FAILED = "PRIVATE_CLI_STALE_CLEANUP_FAILED";
/** 崩溃恢复失败；只记录，避免状态探测被恢复问题整体拖垮。 */
export const PRIVATE_CLI_RUNTIME_RECOVERY_FAILED = "PRIVATE_CLI_RUNTIME_RECOVERY_FAILED";

/** 桌面端只打包该文件名的 npm CLI 入口。 */
const PRIVATE_CLI_NPM_CLI_BASENAME = "npm-cli.js";

/** 磁盘预留倍数：staging 与旧版本并存时需要约两倍以上空间。 */
const DISK_SPACE_MULTIPLIER = 2.5;
/** 超过该时长的临时目录视为上次异常退出残留。 */
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
/** 版本探测超时；CLI 慢启动时给足时间，避免误判成功安装。 */
const PROBE_TIMEOUT_MS = 30_000;
/** Codex（Node 脚本）与 Claude（原生二进制）的默认安装体积预算。 */
const DEFAULT_CODEX_INSTALL_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_CLAUDE_INSTALL_TIMEOUT_MS = 20 * 60_000;

/** 私有运行时记录的统一位置：相对引擎目录的 binPath。 */
const ENGINE_BIN_PATHS: Record<PrivateCliEngine, string> = {
  claude: "node_modules/@anthropic-ai/claude-code/bin/claude.exe",
  codex: "node_modules/@openai/codex/bin/codex.js",
};

/** 原生包所在 scope 与包名前缀，用于识别多平台 optional 包。 */
const ENGINE_NATIVE_SCOPE: Record<PrivateCliEngine, string> = {
  claude: "@anthropic-ai",
  codex: "@openai",
};
const ENGINE_NATIVE_PREFIX: Record<PrivateCliEngine, string> = {
  claude: "claude-code-",
  codex: "codex-",
};

/** 可识别的平台原生包变体，用于判断是否混入其他平台包。 */
const KNOWN_PLATFORM_VARIANTS = [
  "win32-x64",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
];

/** 单次 npm 安装尝试：source 决定展示文案，env 决定 registry/代理等下载环境。 */
export type PrivateCliInstallAttemptInput = {
  source: Exclude<NpmInstallSourceMode, "auto">;
  env: NodeJS.ProcessEnv;
};

/** 安装后探测：必须返回精确版本与相对引擎目录的 binPath。 */
export type PrivateCliProbe = (input: {
  engine: PrivateCliEngine;
  engineRoot: string;
}) => Promise<{ version: string; binPath: string }>;

/** 私有 CLI 安装入口参数；probe/freeBytes 用于测试注入。 */
export type PrivateCliInstallInput = {
  root: string;
  engine: PrivateCliEngine;
  manifest: PrivateCliManifest;
  npmCliPath: string;
  attempts: PrivateCliInstallAttemptInput[];
  requestId: string;
  timeoutMs?: number;
  probe?: PrivateCliProbe;
  freeBytes?: () => Promise<number>;
};

/** 安装结果与软件更新接口的 NpmInstallResponseBody 保持同构。 */
export type PrivateCliInstallResult = {
  success: boolean;
  installedVersion: string | null;
  output: string;
  error: string | null;
  attempts: NpmInstallAttempt[];
};

/** 构造带稳定 code 的错误，调用方不依赖错误 message 判断类型。 */
function codedError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(
    new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause }),
    { code },
  );
}

/** 提取错误文本；未知异常也转为可记录的字符串。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 判断是否为本模块抛出的带 code 错误，避免重复叠加 PRIVATE_CLI_INSTALL_FAILED 前缀。 */
function isCodedCliError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("PRIVATE_CLI_");
}

/** 读取并去除环境变量空白；缺失返回空字符串，由调用方统一判定。 */
function readRuntimeEnv(env: NodeJS.ProcessEnv, key: string): string {
  return String(env[key] ?? "").trim();
}

/**
 * 读取桌面端注入的私有 CLI 运行时配置。
 *
 * 三个环境变量任一缺失返回 null（保留旧的系统/全局安装行为）；
 * 全部存在时校验绝对路径、npm 入口文件名与清单可读性。
 * 路径非法抛 PRIVATE_CLI_RUNTIME_CONFIG_INVALID，清单不合法抛
 * PRIVATE_CLI_RUNTIME_MANIFEST_INVALID，调用方必须显式失败而不是回退全局安装。
 */
export async function readPrivateCliRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  requestId?: string,
): Promise<PrivateCliRuntimeConfig | null> {
  const root = readRuntimeEnv(env, "CODEFLOWAI_CLI_RUNTIME_ROOT");
  const npmCliPath = readRuntimeEnv(env, "CODEFLOWAI_CLI_NPM_CLI");
  const manifestPath = readRuntimeEnv(env, "CODEFLOWAI_CLI_RUNTIME_MANIFEST");
  if (!root || !npmCliPath || !manifestPath) return null;
  if (!path.isAbsolute(root) || !path.isAbsolute(npmCliPath) || !path.isAbsolute(manifestPath)) {
    throw codedError(PRIVATE_CLI_RUNTIME_CONFIG_INVALID, "私有 CLI 运行时路径必须是绝对路径");
  }
  if (path.basename(npmCliPath) !== PRIVATE_CLI_NPM_CLI_BASENAME) {
    throw codedError(
      PRIVATE_CLI_RUNTIME_CONFIG_INVALID,
      `私有 CLI npm 入口必须是 ${PRIVATE_CLI_NPM_CLI_BASENAME}`,
    );
  }

  let text: string;
  try {
    text = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    throw codedError(PRIVATE_CLI_RUNTIME_CONFIG_INVALID, `无法读取私有 CLI 清单：${describeError(error)}`, error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw codedError(PRIVATE_CLI_RUNTIME_MANIFEST_INVALID, `私有 CLI 清单不是合法 JSON：${describeError(error)}`, error);
  }
  let manifest: PrivateCliManifest;
  try {
    manifest = parsePrivateCliManifest(raw);
  } catch (error) {
    throw codedError(PRIVATE_CLI_RUNTIME_MANIFEST_INVALID, describeError(error), error);
  }
  // 状态探测/安装读取配置时先做崩溃恢复；安装锁持有期间禁止并发 rename。
  if (!getActiveGlobalNpmInstall()) {
    await Promise.all([
      recoverPrivateCliRuntime(root, "claude", requestId),
      recoverPrivateCliRuntime(root, "codex", requestId),
    ]);
  }
  return { root, npmCliPath, manifestPath, manifest };
}

/** 返回清单固定版本；显式请求了不同版本时抛 PRIVATE_CLI_VERSION_MISMATCH。 */
export function assertPrivateInstallVersion(
  manifest: PrivateCliManifest,
  engine: PrivateCliEngine,
  requestedVersion: string | null | undefined,
): string {
  const pinned = manifest.engines[engine].version;
  const requested = String(requestedVersion ?? "").trim();
  if (requested && requested !== pinned) {
    throw Object.assign(new Error(PRIVATE_CLI_VERSION_MISMATCH), { code: PRIVATE_CLI_VERSION_MISMATCH });
  }
  return pinned;
}

/** 提取 CLI 输出/记录中的 semver，兼容前后附加的产品文案。 */
function extractEngineVersion(rawVersion: string | null | undefined): string | null {
  const raw = String(rawVersion ?? "").trim();
  if (!raw) return null;
  return raw.match(/\d+\.\d+\.\d+[\w.-]*/u)?.[0] ?? null;
}

/**
 * 按私有清单固定 latestVersion 与安装体积；状态探测仍由 resolver 优先私有运行时。
 * 私有模式永不提示 sudo，因此 updateAvailable 只由已安装与固定版本差异决定。
 */
export function buildPrivateSoftwareUpdateItems(input: {
  manifest: PrivateCliManifest;
  claude: EngineStatus;
  codex: EngineStatus;
}): SoftwareUpdateStatus[] {
  return [input.claude, input.codex].map((status) => {
    const entry = input.manifest.engines[status.engineType];
    const currentVersion = extractEngineVersion(status.version);
    return {
      engineType: status.engineType,
      installed: status.installed,
      currentVersion,
      latestVersion: entry.version,
      binPath: status.binPath,
      npmPackage: entry.npmPackage,
      // 私有模式统一按清单固定版本安装；不把系统 CLI 的版本差异显示成“更新/降级”。
      updateAvailable: false,
      error: status.error,
      installMode: "private",
      installSizeBytes: entry.estimatedBytes,
    };
  });
}

/** 判断路径是否存在；仅把 ENOENT 当作不存在。 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 旧运行时目录命名：`.previous-<engine>-<uuid>`。 */
const PREVIOUS_DIR_PREFIX = ".previous-";
/** 严格 UTF-8 解码器：恢复校验与解析器口径一致，坏字节视为无效运行时。 */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** 从 `.previous-<engine>-*` 目录名提取引擎；其他名字返回 null。 */
function engineFromPreviousDirectoryName(name: string): PrivateCliEngine | null {
  if (!name.startsWith(PREVIOUS_DIR_PREFIX)) return null;
  const engine = name.slice(PREVIOUS_DIR_PREFIX.length).split("-")[0];
  return engine === "claude" || engine === "codex" ? engine : null;
}

/** 记录恢复/清理失败：带稳定 code 与根因，日志本身失败不得影响安装。 */
function recordRuntimeIssue(code: string, message: string, context: Record<string, unknown>): void {
  try {
    logger.error("private-cli", message, { code, ...context });
  } catch {
    // 日志通道故障不能反向破坏安装或状态探测。
  }
}

/**
 * 读取指定目录的 runtime.json 并确认记录的 bin 存在；任何缺失或非法都返回 null。
 * 该函数只用于恢复候选与“正式目录是否有效”的判定，不做显式失败。
 */
async function readValidRuntimeEntryAt(
  directory: string,
  engine: PrivateCliEngine,
): Promise<PrivateCliRuntimeEntry | null> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(path.join(directory, "runtime.json"));
  } catch {
    return null;
  }
  try {
    const entry = parsePrivateCliRuntimeEntry(JSON.parse(UTF8_DECODER.decode(buffer)), engine);
    await fs.access(path.join(directory, entry.binPath));
    return entry;
  } catch {
    return null;
  }
}

/**
 * 崩溃恢复：正式目录没有 runtime.json 时，把最新的、含有效运行时的
 * `.previous-<engine>-*` 恢复为正式目录。失败只记录错误码与根因，不阻塞状态/安装。
 */
export async function recoverPrivateCliRuntime(root: string, engine: PrivateCliEngine, requestId?: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const engineRoot = privateCliEngineRoot(resolvedRoot, engine);
  try {
    // runtime.json 存在但不合法时留给解析器显式失败，不能当作“缺失”而被覆盖。
    if (await pathExists(path.join(engineRoot, "runtime.json"))) return;
    let entries;
    try {
      entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const prefix = `${PREVIOUS_DIR_PREFIX}${engine}-`;
    const candidates: Array<{ directory: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const directory = path.join(resolvedRoot, entry.name);
      try {
        candidates.push({ directory, mtimeMs: (await fs.stat(directory)).mtimeMs });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const candidate of candidates) {
      if (await readValidRuntimeEntryAt(candidate.directory, engine) === null) continue;
      let displaced: string | null = null;
      try {
        if (await pathExists(engineRoot)) {
          // 正式目录只剩空壳/半安装文件；先移走再恢复，避免 Windows rename 目标已存在。
          displaced = path.join(resolvedRoot, `.staging-${engine}-recover-${randomUUID()}`);
          await fs.rename(engineRoot, displaced);
        }
        await fs.rename(candidate.directory, engineRoot);
      } catch (error) {
        if (displaced) {
          try {
            await fs.rename(displaced, engineRoot);
          } catch {
            // 恢复失败已在下方按恢复错误记录；尽力还原原目录。
          }
        }
        throw error;
      }
      if (displaced) {
        try {
          await fs.rm(displaced, { recursive: true, force: true });
        } catch (error) {
          recordRuntimeIssue(PRIVATE_CLI_STALE_CLEANUP_FAILED, "清理崩溃恢复留下的临时目录失败", {
            engine, root: resolvedRoot, path: displaced, requestId, rootCause: describeError(error),
          });
        }
      }
      return;
    }
  } catch (error) {
    recordRuntimeIssue(PRIVATE_CLI_RUNTIME_RECOVERY_FAILED, "私有 CLI 运行时崩溃恢复失败", {
      engine, root: resolvedRoot, requestId, rootCause: describeError(error),
    });
  }
}

/** 把 source 对应的 registry 写进尝试记录，便于前端展示排障链路。 */
function attemptRegistry(env: NodeJS.ProcessEnv): string | null {
  const registry = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  return typeof registry === "string" && registry.length > 0 ? registry : null;
}

/** 汇总失败尝试，作为安装失败的根因文本。 */
function summarizeAttempts(attempts: NpmInstallAttempt[]): string {
  return attempts
    .filter((attempt) => !attempt.success)
    .map((attempt) => `${attempt.source}: ${attempt.error ?? "失败"}`)
    .join("\n");
}

/** 允许测试注入 freeBytes；默认读取 statfs，缺失时返回明确错误码。 */
async function resolveFreeBytes(freeBytes: (() => Promise<number>) | undefined, root: string): Promise<number> {
  if (freeBytes) return freeBytes();
  if (typeof fs.statfs !== "function") {
    throw codedError(PRIVATE_CLI_DISK_CHECK_UNAVAILABLE, "当前运行时不支持 fs.statfs，无法校验磁盘空间");
  }
  try {
    const stats = await fs.statfs(root);
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(available) || available < 0) {
      throw codedError(PRIVATE_CLI_DISK_CHECK_UNAVAILABLE, "fs.statfs 返回了非法可用空间");
    }
    return available;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === PRIVATE_CLI_DISK_CHECK_UNAVAILABLE) throw error;
    throw codedError(PRIVATE_CLI_DISK_CHECK_UNAVAILABLE, `读取磁盘空间失败：${describeError(error)}`, error);
  }
}

/**
 * 清理超过一小时的 `.staging-*` / `.previous-*`。
 * 锁由调用方持有，因此这里只按时间判断，不与并发安装交互。
 * `.previous-*` 只有在正式目录仍有有效运行时才删除，避免删掉崩溃后的唯一副本；
 * 其删除失败（Windows EBUSY/EPERM）只记录，不能使安装失败。
 */
async function cleanupStaleDirectories(root: string, requestId?: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const previousEngine = engineFromPreviousDirectoryName(entry.name);
    if (previousEngine === null && !entry.name.startsWith(".staging-")) continue;
    const target = path.join(root, entry.name);
    let modifiedAt: number;
    try {
      modifiedAt = (await fs.stat(target)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (now - modifiedAt < STALE_TEMP_MAX_AGE_MS) continue;
    if (previousEngine !== null) {
      const liveRoot = privateCliEngineRoot(root, previousEngine);
      if (await readValidRuntimeEntryAt(liveRoot, previousEngine) === null) continue;
      try {
        await fs.rm(target, { recursive: true, force: true });
      } catch (error) {
        recordRuntimeIssue(PRIVATE_CLI_STALE_CLEANUP_FAILED, "清理过期私有 CLI 旧运行目录失败", {
          engine: previousEngine, root, path: target, requestId, rootCause: describeError(error),
        });
      }
      continue;
    }
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch (error) {
      // 残留 staging 被占用时记录后继续安装，不能永久阻断后续修复。
      recordRuntimeIssue(PRIVATE_CLI_STALE_CLEANUP_FAILED, "清理过期私有 CLI 临时目录失败", {
        root, path: target, requestId, rootCause: describeError(error),
      });
    }
  }
}

/** 写 staging package.json，依赖固定为清单中的精确版本。 */
async function writeStagingPackageJson(
  staging: string,
  engine: PrivateCliEngine,
  npmPackage: string,
  version: string,
): Promise<void> {
  const content = {
    name: `codeflow-cli-runtime-${engine}`,
    private: true,
    dependencies: { [npmPackage]: version },
  };
  await fs.writeFile(path.join(staging, "package.json"), `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

/** 重建 staging，避免上一次失败尝试留下的半成品影响 npm/探测。 */
async function resetStaging(
  staging: string,
  engine: PrivateCliEngine,
  npmPackage: string,
  version: string,
): Promise<void> {
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: false });
  await writeStagingPackageJson(staging, engine, npmPackage, version);
}

/** 把相对 binPath 对应的绝对路径限制在引擎目录内。 */
function resolveEngineBin(engineRoot: string, binPath: string): string {
  return path.join(engineRoot, binPath);
}

/** 返回当前平台对应的原生包变体（如 win32-x64）；不支持的平台返回 null。 */
function currentPlatformVariant(platform: NodeJS.Platform = process.platform, arch = process.arch): string | null {
  if (platform !== "win32" && platform !== "linux" && platform !== "darwin") return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  return `${platform}-${arch}`;
}

/** 列出已安装的本引擎原生包变体，如 `["win32-x64"]`。 */
async function listInstalledNativeVariants(engine: PrivateCliEngine, engineRoot: string): Promise<string[]> {
  const scopeDir = path.join(engineRoot, "node_modules", ENGINE_NATIVE_SCOPE[engine]);
  let entries: string[];
  try {
    entries = await fs.readdir(scopeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const prefix = ENGINE_NATIVE_PREFIX[engine];
  return entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter((variant) => KNOWN_PLATFORM_VARIANTS.includes(variant));
}

/**
 * 校验原生包：不允许混入其他平台；若基础包声明了平台 optional 依赖，
 * 则当前平台包必须实际存在。
 */
async function assertPlatformPackages(engine: PrivateCliEngine, engineRoot: string): Promise<void> {
  const expected = currentPlatformVariant();
  const installed = await listInstalledNativeVariants(engine, engineRoot);
  const foreign = installed.filter((variant) => variant !== expected);
  if (foreign.length > 0) {
    throw codedError(
      PRIVATE_CLI_PLATFORM_PACKAGE_INVALID,
      `检测到非当前平台原生包：${foreign.join(", ")}（期望 ${expected ?? "未知平台"}）`,
    );
  }
  if (expected === null) return;
  const packageJsonPath = path.join(engineRoot, "node_modules", privateCliNpmPackage(engine), "package.json");
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const optional = (packageJson as { optionalDependencies?: unknown }).optionalDependencies;
  if (!optional || typeof optional !== "object") return;
  const declaresPlatformPackages = Object.keys(optional as Record<string, unknown>)
    .some((name) => name.startsWith(`${ENGINE_NATIVE_SCOPE[engine]}/${ENGINE_NATIVE_PREFIX[engine]}`));
  if (!declaresPlatformPackages) return;
  if (!installed.includes(expected)) {
    throw codedError(
      PRIVATE_CLI_PLATFORM_PACKAGE_INVALID,
      `缺少当前平台原生包 ${ENGINE_NATIVE_SCOPE[engine]}/${ENGINE_NATIVE_PREFIX[engine]}${expected}`,
    );
  }
}

/** 从 CLI --version 输出中提取精确 semver，兼容前后附加的产品文案。 */
function extractVersion(output: string): string | null {
  const match = /(?:^|[^\d])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/u.exec(output);
  return match?.[1] ?? null;
}

/**
 * 默认探测：先校验平台原生包，再执行 CLI --version。
 * Claude 直接执行原生二进制；Codex 复用隐藏子进程的 Node 包装器入口。
 * 离线导入与网络安装共用该探测，保证版本与 bin 校验口径一致。
 */
export async function defaultPrivateCliProbe(input: {
  engine: PrivateCliEngine;
  engineRoot: string;
}): Promise<{ version: string; binPath: string }> {
  await assertPlatformPackages(input.engine, input.engineRoot);
  const binPath = ENGINE_BIN_PATHS[input.engine];
  const absoluteBin = resolveEngineBin(input.engineRoot, binPath);
  const versionArgs = ["--version"];
  const result = input.engine === "codex"
    // Codex 是 Node 脚本，必须显式声明 Electron Node 模式，不能依赖调用进程是否已设置。
    ? await runCli({
      command: process.execPath,
      args: [...buildCodexNodeArgs(absoluteBin), ...versionArgs],
      timeoutMs: PROBE_TIMEOUT_MS,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    })
    : await runCli({ command: absoluteBin, args: versionArgs, timeoutMs: PROBE_TIMEOUT_MS });
  if (!result.ok) {
    throw codedError(PRIVATE_CLI_PROBE_FAILED, `执行 ${binPath} --version 失败：${result.error ?? "无输出"}`);
  }
  const version = extractVersion(result.stdout);
  if (!version) {
    throw codedError(PRIVATE_CLI_PROBE_FAILED, `${binPath} --version 未输出可识别的版本：${result.stdout.slice(0, 200)}`);
  }
  return { version, binPath };
}

/**
 * 执行探测并构造待写入的运行时记录。
 * 版本必须等于清单固定版本，binPath 必须能通过严格记录解析（位于引擎目录内）。
 */
async function verifyRuntime(
  probe: PrivateCliProbe,
  input: {
    engine: PrivateCliEngine;
    engineRoot: string;
    npmPackage: string;
    expectedVersion: string;
  },
): Promise<PrivateCliRuntimeEntry> {
  const probed = await probe({ engine: input.engine, engineRoot: input.engineRoot });
  if (!probed || typeof probed.version !== "string" || typeof probed.binPath !== "string") {
    throw codedError(PRIVATE_CLI_PROBE_FAILED, "探测结果缺少 version/binPath");
  }
  if (probed.version !== input.expectedVersion) {
    throw codedError(
      PRIVATE_CLI_PROBE_FAILED,
      `探测版本 ${probed.version} 与清单固定版本 ${input.expectedVersion} 不一致`,
    );
  }
  const now = new Date().toISOString();
  return parsePrivateCliRuntimeEntry({
    schemaVersion: 1,
    engine: input.engine,
    npmPackage: input.npmPackage,
    version: probed.version,
    installedAt: now,
    verifiedAt: now,
    binPath: probed.binPath,
  }, input.engine);
}

/** 写 staging runtime.json；entry 已经过严格解析器校验。 */
async function writeRuntimeEntry(engineRoot: string, entry: PrivateCliRuntimeEntry): Promise<void> {
  await fs.writeFile(path.join(engineRoot, "runtime.json"), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

/**
 * 显式执行 Claude 官方 install.cjs。
 * runCli 本身不接收 cwd，这里通过包装 spawnProcess 注入安装包目录作为工作目录。
 */
async function runClaudePostinstall(input: {
  staging: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ ok: boolean; stdout: string; error: string | null }> {
  const packageDir = path.join(input.staging, "node_modules", "@anthropic-ai", "claude-code");
  const installScript = path.join(packageDir, "install.cjs");
  const spawnInPackageDir = ((command: string, args?: readonly string[], options?: Record<string, unknown>) =>
    spawn(command, args as string[], { ...(options ?? {}), cwd: packageDir })) as unknown as typeof spawn;
  return await runCli({
    command: process.execPath,
    args: [installScript],
    timeoutMs: input.timeoutMs,
    env: { ...input.env, ELECTRON_RUN_AS_NODE: "1", npm_config_omit: "" },
    spawnProcess: spawnInPackageDir,
  });
}

/** Windows 短暂拒绝原生目录 rename 时有限重试；每次重核源实体和空目标，失败保留根因。 */
async function renameRuntimeDirectory(source: string, target: string): Promise<void> {
  const identity = await fs.lstat(source, { bigint: true });
  const parent = path.dirname(source);
  const parentIdentity = await fs.lstat(parent, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || path.dirname(target) !== parent) {
    throw codedError(PRIVATE_CLI_SWAP_FAILED, "引擎目录切换路径无效");
  }
  const waits = [100, 200, 400, 800, 1000];
  const started = performance.now();
  let first: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      const current = await fs.lstat(source, { bigint: true });
      const currentParent = await fs.lstat(parent, { bigint: true });
      let targetExists = true;
      try { await fs.lstat(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; targetExists = false; }
      if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isDirectory() || current.isSymbolicLink()
        || currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino || currentParent.isSymbolicLink()
        || targetExists) throw codedError(PRIVATE_CLI_SWAP_FAILED, "重命名期间引擎目录已变化，已停止切换");
    } catch (error) {
      throw first ? new AggregateError([first, error], `PRIVATE_CLI_SWAP_RECHECK_FAILED: ${describeError(first)}；目录复核失败：${describeError(error)}`) : error;
    }
    if (first && performance.now() - started >= 3000) {
      throw codedError(PRIVATE_CLI_SWAP_FAILED, `引擎目录切换等待超时，已停止安装。${describeError(first)}`, first);
    }
    try { await fs.rename(source, target); return; }
    catch (error) {
      const native = error as NodeJS.ErrnoException & { dest?: string };
      if (!(process.platform === "win32" && error instanceof Error && ["EPERM", "EBUSY", "EACCES"].includes(native.code ?? "")
        && native.syscall === "rename" && native.path === source && native.dest === target)) {
        throw first ? new AggregateError([first, error], `PRIVATE_CLI_SWAP_RETRY_FAILED: ${describeError(first)}；后续切换失败：${describeError(error)}`) : error;
      }
      first ??= error;
      const remaining = 3000 - (performance.now() - started);
      if (attempt >= waits.length || remaining <= 0) {
        throw codedError(PRIVATE_CLI_SWAP_FAILED, `Windows 持续拒绝引擎目录切换，已停止安装；请关闭使用该引擎的任务后重试。${describeError(error)}`, error);
      }
      await delay(Math.min(waits[attempt]!, remaining));
    }
  }
}

/**
 * 原子替换：旧目录与候选切换共用有限重试，替换后再次探测。
 * 探测失败时删除新目录并恢复旧目录，确保不会丢失可用运行时。
 */
async function swapIntoPlace(input: {
  staging: string;
  engineRoot: string;
  previousPath: string;
  probe: PrivateCliProbe;
  engine: PrivateCliEngine;
  npmPackage: string;
  expectedVersion: string;
}): Promise<void> {
  let previousMoved = false;
  let stagedMoved = false;
  try {
    if (await pathExists(input.engineRoot)) {
      await renameRuntimeDirectory(input.engineRoot, input.previousPath);
      previousMoved = true;
    }
    await renameRuntimeDirectory(input.staging, input.engineRoot);
    stagedMoved = true;
    await verifyRuntime(input.probe, {
      engine: input.engine,
      engineRoot: input.engineRoot,
      npmPackage: input.npmPackage,
      expectedVersion: input.expectedVersion,
    });
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (stagedMoved) {
      try {
        await fs.rm(input.engineRoot, { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackErrors.push(`remove new runtime: ${describeError(rollbackError)}`);
      }
    }
    if (previousMoved) {
      try {
        await renameRuntimeDirectory(input.previousPath, input.engineRoot);
      } catch (rollbackError) {
        rollbackErrors.push(`restore previous runtime: ${describeError(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw codedError(
        PRIVATE_CLI_SWAP_FAILED,
        `${describeError(error)}；回滚失败：${rollbackErrors.join("; ")}`,
        error,
      );
    }
    throw error;
  }
  if (previousMoved) {
    // 新运行时已通过探测；清理失败只留下临时目录，由下次安装的过期清理处理。
    try {
      await fs.rm(input.previousPath, { recursive: true, force: true });
    } catch {
      // 保留目录不影响新运行时可用性。
    }
  }
}

/**
 * staging 收尾的单一流程：探测固定版本、写入 runtime.json、原子替换并二次探测。
 * 网络安装与离线包导入共用这里，避免两条路径出现替换/回滚行为差异。
 * 失败时由调用方负责清理 staging；旧运行时由 swapIntoPlace 负责恢复。
 */
export async function commitPrivateCliStaging(input: {
  root: string;
  engine: PrivateCliEngine;
  version: string;
  npmPackage: string;
  staging: string;
  probe: PrivateCliProbe;
}): Promise<PrivateCliRuntimeEntry> {
  const root = path.resolve(input.root);
  const entry = await verifyRuntime(input.probe, {
    engine: input.engine,
    engineRoot: input.staging,
    npmPackage: input.npmPackage,
    expectedVersion: input.version,
  });
  await writeRuntimeEntry(input.staging, entry);
  await swapIntoPlace({
    staging: input.staging,
    engineRoot: privateCliEngineRoot(root, input.engine),
    previousPath: path.join(root, `.previous-${input.engine}-${randomUUID()}`),
    probe: input.probe,
    engine: input.engine,
    npmPackage: input.npmPackage,
    expectedVersion: input.version,
  });
  return entry;
}

/**
 * 安装固定版本的私有 CLI：staging 安装、探测校验、runtime.json 落盘、原子替换。
 * 任何失败都清理 staging 并保留旧运行时；requestId 由调用边界（Task 6 handler）记录。
 */
export async function installPrivateCli(input: PrivateCliInstallInput): Promise<PrivateCliInstallResult> {
  const manifestEntry = input.manifest.engines[input.engine];
  const version = manifestEntry.version;
  const npmPackage = manifestEntry.npmPackage;
  const root = path.resolve(input.root);
  const probe = input.probe ?? defaultPrivateCliProbe;
  const timeoutMs = input.timeoutMs
    ?? (input.engine === "claude" ? DEFAULT_CLAUDE_INSTALL_TIMEOUT_MS : DEFAULT_CODEX_INSTALL_TIMEOUT_MS);
  const npmCliPath = path.resolve(input.npmCliPath);
  const attempts: NpmInstallAttempt[] = [];
  const outputParts: string[] = [];
  let staging: string | null = null;
  let successfulAttempt: number | null = null;

  const failure = (error: string): PrivateCliInstallResult => ({
    success: false,
    installedVersion: null,
    output: outputParts.join("\n"),
    error,
    attempts,
  });

  try {
    await fs.mkdir(root, { recursive: true });
    // 先恢复崩溃遗留的旧运行时，再清理临时目录，避免删除唯一可用副本。
    await recoverPrivateCliRuntime(root, input.engine, input.requestId);
    await cleanupStaleDirectories(root, input.requestId);

    // 磁盘预检覆盖网络安装与离线导入，必须在复制/下载任何内容前完成。
    const freeBytes = await resolveFreeBytes(input.freeBytes, root);
    const requiredBytes = manifestEntry.estimatedBytes * DISK_SPACE_MULTIPLIER;
    if (freeBytes < requiredBytes) {
      return failure(
        `${PRIVATE_CLI_DISK_INSUFFICIENT}: 可用空间 ${freeBytes} 字节，低于所需的 ${requiredBytes} 字节`,
      );
    }

    // 企业 IT 预置的离线包优先于网络安装；动态导入避免与离线模块形成静态循环依赖。
    // 只要离线目录存在就必须走离线校验，不能因为包非法而静默回退 npm。
    const offline = await import("./privateCliOffline.js");
    if (await offline.privateCliOfflineDirectoryExists(root, input.engine)) {
      return await offline.installPrivateCliFromOfflineSource({
        root,
        engine: input.engine,
        version,
        requestId: input.requestId,
        probe,
      });
    }

    staging = path.join(root, `.staging-${input.engine}-${randomUUID()}`);
    await fs.mkdir(staging, { recursive: false });
    await writeStagingPackageJson(staging, input.engine, npmPackage, version);

    let installed = false;
    for (const attempt of input.attempts) {
      const startedAt = Date.now();
      // 每次尝试都从干净 staging 开始，避免失败尝试的半成品污染下一次安装。
      if (attempts.length > 0) await resetStaging(staging, input.engine, npmPackage, version);
      const npmResult = await runCli({
        command: process.execPath,
        args: [npmCliPath, "install", "--prefix", staging, "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund"],
        timeoutMs,
        env: { ...attempt.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      if (npmResult.stdout) outputParts.push(npmResult.stdout);

      if (!npmResult.ok) {
        if (npmResult.error) outputParts.push(npmResult.error);
        attempts.push({
          source: attempt.source,
          registry: attemptRegistry(attempt.env),
          success: false,
          error: npmResult.error ?? "npm install 失败",
          durationMs: Date.now() - startedAt,
        });
        continue;
      }

      if (input.engine === "claude") {
        const postinstall = await runClaudePostinstall({ staging, env: attempt.env, timeoutMs });
        if (postinstall.stdout) outputParts.push(postinstall.stdout);
        if (!postinstall.ok) {
          if (postinstall.error) outputParts.push(postinstall.error);
          attempts.push({
            source: attempt.source,
            registry: attemptRegistry(attempt.env),
            success: false,
            error: postinstall.error ?? "Claude install.cjs 失败",
            durationMs: Date.now() - startedAt,
          });
          continue;
        }
      }

      // npm 成功尚未等于安装成功；提交/staging 校验通过后才把该尝试标记为成功。
      successfulAttempt = attempts.length;
      attempts.push({
        source: attempt.source,
        registry: attemptRegistry(attempt.env),
        success: false,
        error: null,
        durationMs: Date.now() - startedAt,
      });
      installed = true;
      break;
    }

    if (!installed) {
      await fs.rm(staging, { recursive: true, force: true });
      staging = null;
      return failure(`${PRIVATE_CLI_INSTALL_FAILED}: ${summarizeAttempts(attempts)}`);
    }

    const entry = await commitPrivateCliStaging({
      root,
      engine: input.engine,
      version,
      npmPackage,
      staging,
      probe,
    });
    if (successfulAttempt !== null) attempts[successfulAttempt]!.success = true;
    staging = null;

    return {
      success: true,
      installedVersion: entry.version,
      output: outputParts.join("\n"),
      error: null,
      attempts,
    };
  } catch (error) {
    // 失败只清理 staging；旧运行时由 swapIntoPlace 负责恢复，禁止删除仍在使用的目录。
    if (staging) {
      try {
        await fs.rm(staging, { recursive: true, force: true });
      } catch {
        // staging 清理失败不掩盖原始安装错误。
      }
    }
    const message = describeError(error);
    if (successfulAttempt !== null && attempts[successfulAttempt]) {
      attempts[successfulAttempt]!.success = false;
      attempts[successfulAttempt]!.error = message;
    }
    return failure(isCodedCliError(error) ? message : `${PRIVATE_CLI_INSTALL_FAILED}: ${message}`);
  }
}
