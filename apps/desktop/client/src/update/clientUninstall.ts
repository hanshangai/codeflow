import fs from "node:fs";
import path from "node:path";

import {
  resolveClientUpgradeEntryVerdict,
  shouldUseSudoForGlobalInstall,
  type GlobalInstallSudoContext,
} from "../app/handlers/softwareUpdateHandlers.js";
import {
  CLIENT_NPM_PACKAGE_NAME,
  hasClientPackageEntryShape,
  normalizeComparablePath,
  resolveClientEntryPrefixCandidates,
} from "../app/clientInstallEntry.js";

const SHELL_PROFILE_BLOCK_MARKER = "# CodeFlowAI npm global bin";
const SHELL_PROFILE_FILE_NAMES = [".bash_profile", ".zshrc", ".bashrc", ".profile"];

export type ClientUninstallCommandResult = { status: number | null; error?: Error; stdout?: string };
export type ClientUninstallCommand = (args: string[]) => ClientUninstallCommandResult;

/** 卸载前置校验失败；code 取值固定为 CLIENT_UNINSTALL_*，便于日志与用户文案对齐。 */
export class ClientUninstallError extends Error {
  readonly stage = "prepare";
  constructor(readonly code: string, message: string, cause?: unknown) {
    super(message, { cause });
  }
}

/** 卸载阶段失败；stage 记录失败阶段，recoveryError 单独保留，绝不把恢复失败当作卸载成功。 */
export class ClientUninstallLifecycleError extends Error {
  readonly code = "CLIENT_UNINSTALL_LIFECYCLE_FAILED";
  constructor(readonly stage: string, cause: unknown, readonly recoveryError?: unknown) {
    super(`Client 卸载阶段 ${stage} 失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export type ClientUninstallEntryCheck =
  | { allowed: true; npmGlobalPrefix: string }
  | {
      allowed: false;
      code: "CLIENT_UNINSTALL_PREFIX_UNRESOLVED" | "CLIENT_UNINSTALL_REQUIRES_GLOBAL_INSTALL";
      message: string;
      /** 本次按优先级试过的候选前缀，用于失败日志定位真实探测值；不含空候选。 */
      candidates: string[];
    };

/** 归一化平台；darwin 与 linux 的差异只影响系统包提示与 Linux 稳定命令链接。 */
export type ClientUninstallPlatform = "windows" | "darwin" | "linux" | "posix";

export type ClientUninstallPlan = {
  platform: ClientUninstallPlatform;
  homeDir: string;
  /** 安装器托管根目录：POSIX 为 ~/.codeflowai，Windows 为 %LOCALAPPDATA%\CodeFlowAI */
  managedRoot: string;
  /** 用户数据目录；Windows 与托管根目录物理分离，POSIX 混在同一目录内，故只能逐项精确删除 */
  dataDir: string;
  npmGlobalPrefix: string;
  packageDir: string;
  npmBinDir: string;
  /** npm 生成的命令 shim，由 npm uninstall -g 移除，仅用于卸载后校验 */
  npmCommandPaths: string[];
  /** 本安装器写入的独立启动器，npm 不会处理，必须显式删除 */
  launcherPaths: string[];
  /** 需要从用户 PATH 与 shell 配置移除的目录，一律限定在本安装器写入的托管目录内；Linux 稳定命令目录见 stableCommandLinks */
  pathEntries: string[];
  /** Linux 稳定命令链接；仅在确实指向托管目录时删除 */
  stableCommandLinks: string[];
  /** 命中前缀不在托管目录内（系统级 npm 安装）时为 true：托管目录下的启动器与 PATH 条目整体不回收 */
  managedArtifactsSkipped: boolean;
  /** 卸载后必须保留的重装缓存，避免重装时重新下载 */
  preservedPaths: string[];
};

function normalizePlatform(platform: NodeJS.Platform | string | undefined): ClientUninstallPlatform {
  const normalized = String(platform ?? process.platform).trim().toLowerCase();
  if (normalized === "win32" || normalized === "windows") return "windows";
  if (normalized === "darwin" || normalized === "mac" || normalized === "macos") return "darwin";
  if (normalized === "linux") return "linux";
  return "posix";
}

type PathModule = typeof path.posix;

function pathsForPlatform(platform: ClientUninstallPlatform): PathModule {
  return platform === "windows" ? path.win32 : path.posix;
}

/** 判断 candidate 是否位于 root 内部；相等或跨盘符一律返回 false，避免误删根目录。 */
function isInsideDirectory(candidate: string, root: string, paths: PathModule): boolean {
  const relative = paths.relative(paths.resolve(root), paths.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}

/** 失败判定所需上下文：文案要能区分「前缀漂移」与「源码运行」，日志要能定位真实探测值。 */
type ClientUninstallEntryContext = {
  prefix: string;
  prefixError: string;
  entryPath: string;
  ownedPrefix: string | null;
  candidates: string[];
};

/**
 * 解析卸载的托管安装判定。
 * 候选前缀按证据强度排序：入口自身所属前缀（唯一有磁盘证据）→ `npm config get prefix` 探测值 → Windows 私有前缀。
 * 探测值可能被私有 launcher 注入的 npm_config_prefix 污染（`runCli` 会把它并进子进程 env），
 * 且只要它“包含”入口就会胜出并生成错误清单，故不能作为唯一来源。
 * 不对称说明：只有入口自身所属前缀做过磁盘归属校验（见 resolveEntryOwnedNpmPrefix），
 * 探测值与私有前缀候选沿用升级守卫的“仅包含判定”，收紧会破坏既有的托管安装卸载路径。
 */
export function resolveClientUninstallEntryVerdict(
  npmGlobalPrefix: string | null | undefined,
  prefixError: string | null | undefined,
  platform: NodeJS.Platform | string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  entryPath: string | null | undefined = process.argv[1],
): ClientUninstallEntryCheck {
  const normalizedPlatform = normalizePlatform(platform);
  const prefix = String(npmGlobalPrefix ?? "").trim();
  const entry = String(entryPath ?? "").trim();
  const { ownedPrefix, prefixes: candidates } = resolveClientEntryPrefixCandidates({
    npmGlobalPrefix: prefix,
    platform: normalizedPlatform,
    env,
    entryPath: entry,
  });
  const context: ClientUninstallEntryContext = {
    prefix,
    prefixError: String(prefixError ?? "").trim(),
    entryPath: entry,
    ownedPrefix,
    candidates,
  };
  const build = (verdict: ReturnType<typeof resolveClientUpgradeEntryVerdict>, matchedPrefix: string) =>
    toClientUninstallEntryCheck(verdict, matchedPrefix, context);

  let last: ClientUninstallEntryCheck | null = null;
  // 入口自身所属前缀先单独判定并立即返回：它是唯一有磁盘证据的候选，删除清单必须按它构建。
  if (ownedPrefix) {
    const ownedVerdict = resolveClientUpgradeEntryVerdict(ownedPrefix, null, entry);
    if (ownedVerdict.allowed) return { allowed: true, npmGlobalPrefix: ownedPrefix };
    last = build(ownedVerdict, ownedPrefix);
  }
  // 其余候选沿用升级守卫的“仅包含判定”，并保留原有的首个候选只记录、其余命中即返回的顺序语义。
  const fallbackCandidates = candidates.filter((candidate) => candidate !== ownedPrefix);
  if (fallbackCandidates.length > 0) {
    const first = fallbackCandidates[0]!;
    last = build(resolveClientUpgradeEntryVerdict(first, null, entry), first);
    for (const candidate of fallbackCandidates.slice(1)) {
      const verdict = resolveClientUpgradeEntryVerdict(candidate, null, entry);
      if (verdict.allowed) return { allowed: true, npmGlobalPrefix: candidate };
      // 已命中的结论不得被后面未命中的候选改写成拒绝，否则会误报成“用户在跑源码”。
      if (!last.allowed) last = build(verdict, candidate);
    }
  }
  // prefix 探测失败时优先回报探测原因，避免把环境故障说成“用户在跑源码”。
  if (!prefix && prefixError) {
    return build(resolveClientUpgradeEntryVerdict(null, prefixError, entry), "");
  }
  return last ?? build(resolveClientUpgradeEntryVerdict(null, prefixError, entry), "");
}

/** 卸载侧自带文案，不复用升级守卫措辞：两条文案都不得出现“升级”口径，也不给 `codeflow --update` 建议。 */
function toClientUninstallEntryCheck(
  verdict: ReturnType<typeof resolveClientUpgradeEntryVerdict>,
  matchedPrefix: string,
  context: ClientUninstallEntryContext,
): ClientUninstallEntryCheck {
  if (verdict.allowed) return { allowed: true, npmGlobalPrefix: matchedPrefix };
  const candidates = context.candidates;
  if (verdict.code === "CLIENT_UPGRADE_PREFIX_UNRESOLVED") {
    return {
      allowed: false,
      code: "CLIENT_UNINSTALL_PREFIX_UNRESOLVED",
      candidates,
      message: context.prefix
        ? "无法确认当前 Client 启动入口，已中止卸载以避免误删其他文件。"
        : `无法确认 npm 全局安装目录（${context.prefixError || "npm config get prefix 未返回结果"}），已中止卸载以避免误删其他文件。`,
    };
  }
  return {
    allowed: false,
    code: "CLIENT_UNINSTALL_REQUIRES_GLOBAL_INSTALL",
    candidates,
    message: buildNotGlobalInstallMessage(context),
  };
}

/** 按「入口形态不符」与「形态相符但归属校验未过」分两类说明，并给出可执行的手工补救命令。 */
function buildNotGlobalInstallMessage(context: ClientUninstallEntryContext): string {
  const prefixHint = context.ownedPrefix ?? context.prefix;
  const remedy = `如需手动处理，可执行：npm uninstall -g ${CLIENT_NPM_PACKAGE_NAME}${prefixHint ? ` --prefix "${prefixHint}"` : ""}。`;
  if (!hasClientPackageEntryShape(context.entryPath)) {
    return `当前入口 ${context.entryPath || "(未知)"} 不是 npm 全局安装的包入口，看起来是本地源码运行：为避免误删工程文件，已拒绝卸载。${remedy}`;
  }
  return `入口 ${context.entryPath} 形似 npm 全局安装，但未通过归属校验（包目录缺失、为符号链接或不是 ${CLIENT_NPM_PACKAGE_NAME}）：可能是 npm link 或工程内依赖安装，为避免误删工程文件与另一套安装，已拒绝卸载。${remedy}`;
}

/** 计算卸载删除清单；两平台目录布局相反，必须按平台区分数据目录与程序目录。 */
export function resolveClientUninstallPlan(input: {
  npmGlobalPrefix: string | null | undefined;
  platform?: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv;
}): ClientUninstallPlan {
  const env = input.env ?? process.env;
  const platform = normalizePlatform(input.platform ?? process.platform);
  const paths = pathsForPlatform(platform);
  const prefix = String(input.npmGlobalPrefix ?? "").trim();
  if (!prefix) throw new ClientUninstallError("CLIENT_UNINSTALL_PREFIX_UNRESOLVED", "无法确认 npm 全局安装目录，已中止卸载以避免误删其他文件。");
  const homeDir = String(env.HOME || env.USERPROFILE || "").trim();
  if (!homeDir) throw new ClientUninstallError("CLIENT_UNINSTALL_HOME_UNRESOLVED", "无法确认当前用户主目录，已中止卸载。");

  if (platform === "windows") {
    const localAppData = String(env.LOCALAPPDATA ?? "").trim() || paths.join(homeDir, "AppData", "Local");
    const managedRoot = paths.join(localAppData, "CodeFlowAI");
    const launcherDir = paths.join(managedRoot, "bin");
    const npmBinDir = prefix;
    // 系统级前缀（%APPDATA%\npm）安装时，托管目录下可能另有一整套私有安装：只收窄清理，不放宽解析。
    const managedArtifactsSkipped = !isInsideDirectory(prefix, managedRoot, paths);
    return {
      platform,
      homeDir,
      managedRoot,
      dataDir: paths.join(homeDir, ".codeflowai"),
      npmGlobalPrefix: prefix,
      packageDir: paths.join(npmBinDir, "node_modules", "@codeflowai", "client"),
      npmBinDir,
      npmCommandPaths: ["codeflow", "codeflow.cmd", "codeflow.ps1"].map((name) => paths.join(npmBinDir, name)),
      launcherPaths: managedArtifactsSkipped
        ? []
        : ["codeflow.cmd", "codeflow.ps1"].map((name) => paths.join(launcherDir, name)),
      pathEntries: managedArtifactsSkipped ? [] : dedupePaths([
        launcherDir,
        paths.join(managedRoot, "Git", "cmd"),
        isInsideDirectory(npmBinDir, managedRoot, paths) ? npmBinDir : "",
      ]),
      managedArtifactsSkipped,
      stableCommandLinks: [],
      preservedPaths: ["runtime", "Git", "Installer", "npm"].map((name) => paths.join(managedRoot, name)),
    };
  }

  const managedRoot = paths.join(homeDir, ".codeflowai");
  const launcherDir = paths.join(managedRoot, "bin");
  const npmBinDir = paths.join(prefix, "bin");
  // 系统级前缀（如 /usr/local）安装时不动托管目录产物：那里的启动器可能属于另一套私有安装。
  const managedArtifactsSkipped = !isInsideDirectory(prefix, managedRoot, paths);
  return {
    platform,
    homeDir,
    managedRoot,
    dataDir: managedRoot,
    npmGlobalPrefix: prefix,
    packageDir: paths.join(prefix, "lib", "node_modules", "@codeflowai", "client"),
    npmBinDir,
    npmCommandPaths: [paths.join(npmBinDir, "codeflow")],
    launcherPaths: managedArtifactsSkipped ? [] : [paths.join(launcherDir, "codeflow")],
    // 只有安装器写入托管目录的 PATH 条目才回收；系统级 prefix（如 /usr/local/bin）属用户环境，不动。
    pathEntries: managedArtifactsSkipped
      ? []
      : dedupePaths([launcherDir, isInsideDirectory(prefix, managedRoot, paths) ? npmBinDir : ""]),
    managedArtifactsSkipped,
    // Linux 安装器会额外把 codeflow 链接到 ~/.local/bin；该目录属用户公共目录，只删链接本身。
    stableCommandLinks: platform === "linux" ? [paths.join(homeDir, ".local", "bin", "codeflow")] : [],
    preservedPaths: [paths.join(managedRoot, "runtime")],
  };
}

/** 去掉空值并保序去重 PATH 条目。 */
function dedupePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeComparablePath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

/** 生成 Client 卸载命令；系统级 macOS/Linux 安装沿用升级一致的 sudo 前缀判定。 */
export function buildClientUninstallCommand(
  platform: NodeJS.Platform | string = process.platform,
  env?: NodeJS.ProcessEnv,
  context?: GlobalInstallSudoContext,
): { command: string; args: string[] } {
  const npmArgs = ["uninstall", "-g", CLIENT_NPM_PACKAGE_NAME, "--no-audit", "--no-fund"];
  if (shouldUseSudoForGlobalInstall(platform, env, context)) return { command: "sudo", args: ["npm", ...npmArgs] };
  return { command: "npm", args: npmArgs };
}

type TextLine = { text: string; eol: string };

/** 按行拆分并保留每行原有结束符，保证未被命中的行回写时逐字节不变。 */
function splitTextLines(content: string): TextLine[] {
  const lines: TextLine[] = [];
  let index = 0;
  while (index < content.length) {
    let end = index;
    while (end < content.length && content[end] !== "\n" && content[end] !== "\r") end += 1;
    let eol = "";
    if (end < content.length) {
      eol = content[end] === "\r" && content[end + 1] === "\n" ? "\r\n" : content[end]!;
      end += eol.length;
    }
    lines.push({ text: content.slice(index, end - eol.length), eol });
    index = end;
  }
  return lines;
}

function joinTextLines(lines: TextLine[]): string {
  return lines.map((line) => line.text + line.eol).join("");
}

/**
 * 安装器把部分 PATH 块写成 `$HOME/...` 字面量而非绝对路径（NPM_USER_PREFIX、stable_dir、launcher_dir），
 * 因此同一目录要同时按绝对路径与 `$HOME` 字面量两种写法参与匹配。
 */
export function shellProfileEntryVariants(dir: string, homeDir: string): string[] {
  const relative = path.relative(homeDir, dir);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [dir];
  return [dir, `$HOME/${relative.split(path.sep).join("/")}`];
}

/**
 * 从 shell 配置文本中移除安装器写入的 PATH 块（标记行 + export 行 + 其前置空行）。
 * 仅当 export 行指向清单内目录时才删除，未命中的行逐字节保留，重复执行幂等。
 */
export function removeShellPathEntries(content: string, binDirs: string[]): { content: string; removed: number } {
  const targets = new Set(binDirs.map((dir) => normalizeComparablePath(dir)).filter(Boolean));
  if (targets.size === 0) return { content, removed: 0 };
  const lines = splitTextLines(content);

  let removed = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.text.trim() !== SHELL_PROFILE_BLOCK_MARKER) continue;
    const exportLine = lines[index + 1]?.text;
    const match = exportLine ? /^\s*export\s+PATH="([^"]*):\$PATH"\s*$/u.exec(exportLine) : null;
    if (!match || !targets.has(normalizeComparablePath(match[1]))) continue;
    const start = index > 0 && !lines[index - 1]!.text.trim() ? index - 1 : index;
    lines.splice(start, index + 2 - start);
    removed += 1;
    index = start - 1;
  }
  return { content: joinTextLines(lines), removed };
}

/** 仅当 ~/.npmrc 的 prefix 恰为托管目录时回滚；用户自有取值只回报，不自动改写。 */
export function removeNpmrcPrefix(content: string, managedPrefix: string): { content: string; removed: boolean; mismatchedValue: string | null } {
  const target = normalizeComparablePath(managedPrefix);
  const lines = splitTextLines(content);

  let removed = false;
  let mismatchedValue: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*prefix\s*=\s*(.*?)\s*$/u.exec(lines[index]!.text);
    if (!match) continue;
    const value = match[1]!.replace(/^["']|["']$/gu, "").trim();
    if (normalizeComparablePath(value) !== target) {
      mismatchedValue = value;
      continue;
    }
    lines.splice(index, 1);
    removed = true;
    index -= 1;
  }
  return { content: joinTextLines(lines), removed, mismatchedValue };
}

export type ClientUninstallCleanupReport = {
  removedLaunchers: string[];
  removedStableLinks: string[];
  strippedProfiles: string[];
  rolledBackNpmrcPrefix: boolean;
  npmrcHint: string | null;
};

/**
 * 仅当稳定命令链接确实指向本安装器安装的 codeflow 时才删除，避免误删用户自建的同名命令。
 * npm 卸载后链接目标可能已消失，故只做语法解析，不依赖 realpath。
 */
function isManagedCommandLink(linkPath: string, plan: ClientUninstallPlan): boolean {
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink()) return false;
    const target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    if (isInsideDirectory(target, plan.managedRoot, path)) return true;
    // 系统级 npm prefix 可写时安装器不建私有启动器，链接直接指向 <prefix>/bin/codeflow。
    return path.basename(target) === "codeflow" && isInsideDirectory(target, plan.npmGlobalPrefix, path);
  } catch {
    return false;
  }
}

/** POSIX 卸载清理：删独立启动器与稳定链接 → 清 shell PATH 块 → 条件回滚 ~/.npmrc。 */
export function runClientUninstallCleanup(plan: ClientUninstallPlan): ClientUninstallCleanupReport {
  const report: ClientUninstallCleanupReport = {
    removedLaunchers: [],
    removedStableLinks: [],
    strippedProfiles: [],
    rolledBackNpmrcPrefix: false,
    npmrcHint: null,
  };
  for (const launcher of plan.launcherPaths) {
    if (!fs.existsSync(launcher)) continue;
    fs.rmSync(launcher, { force: true });
    report.removedLaunchers.push(launcher);
  }
  for (const link of plan.stableCommandLinks) {
    if (!isManagedCommandLink(link, plan)) continue;
    fs.unlinkSync(link);
    report.removedStableLinks.push(link);
  }
  // 稳定命令目录（如 ~/.local/bin）属用户公共目录，不整体回收，但它所在的 profile 块由本安装器写入，须一并清除。
  const profilePathEntries = [...plan.pathEntries, ...plan.stableCommandLinks.map((link) => path.dirname(link))]
    .flatMap((dir) => shellProfileEntryVariants(dir, plan.homeDir));
  for (const fileName of SHELL_PROFILE_FILE_NAMES) {
    const profilePath = path.join(plan.homeDir, fileName);
    if (!fs.existsSync(profilePath)) continue;
    const result = removeShellPathEntries(fs.readFileSync(profilePath, "utf8"), profilePathEntries);
    if (result.removed === 0) continue;
    fs.writeFileSync(profilePath, result.content, "utf8");
    report.strippedProfiles.push(profilePath);
  }
  const npmrcPath = path.join(plan.homeDir, ".npmrc");
  if (fs.existsSync(npmrcPath) && isInsideDirectory(plan.npmGlobalPrefix, plan.managedRoot, path)) {
    const result = removeNpmrcPrefix(fs.readFileSync(npmrcPath, "utf8"), plan.npmGlobalPrefix);
    if (result.removed) {
      fs.writeFileSync(npmrcPath, result.content, "utf8");
      report.rolledBackNpmrcPrefix = true;
    } else if (result.mismatchedValue) {
      report.npmrcHint = `~/.npmrc 的 prefix 指向 ${result.mismatchedValue}，非本次安装写入，未自动改动。`;
    }
  }
  return report;
}

/** 断言卸载后包目录与全部 Client 命令均已消失；残留项逐条列出，便于用户手动处理。 */
export function assertClientUninstallCompleted(plan: ClientUninstallPlan): void {
  const leftovers = [plan.packageDir, ...plan.npmCommandPaths, ...plan.launcherPaths]
    .filter((target) => fs.existsSync(target));
  if (leftovers.length > 0) {
    throw new ClientUninstallError(
      "CLIENT_UNINSTALL_VERIFY_FAILED",
      `卸载后仍存在残留：${leftovers.join("、")}`,
    );
  }
}

/** 卸载不做自动回滚的项，仅提示用户自行处理。 */
export function clientUninstallManualHints(plan: ClientUninstallPlan): string[] {
  const hints = [`用户数据与配置已保留：${plan.dataDir}`];
  if (plan.platform === "linux") {
    hints.push("若安装时通过 apt/dnf 安装过系统 Git 或 CA 证书，属系统包，本次卸载不改动，请按需自行处理。");
  }
  return hints;
}

function checked(run: ClientUninstallCommand, args: string[]): ClientUninstallCommandResult {
  const result = run(args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`codeflow ${args.join(" ")} 退出码：${result.status}`);
  return result;
}

/**
 * POSIX 卸载阶段机：prepare 校验入口 → auth 预授权 → stop → uninstall → cleanup → verify。
 * 停止之后、包删除之前失败时尝试恢复 daemon；包已删除则绝不回滚，只报告残留项。
 */
export function runPosixClientUninstall(input: {
  entryCheck: ClientUninstallEntryCheck;
  daemonRunning: boolean;
  preparePrivilege: () => void;
  run: ClientUninstallCommand;
  uninstall: () => void;
  cleanup: () => void;
  verify: () => void;
}): void {
  let stage = "prepare";
  let stopped = false;
  let uninstalled = false;
  try {
    if (!input.entryCheck.allowed) throw new ClientUninstallError(input.entryCheck.code, input.entryCheck.message);
    stage = "auth";
    input.preparePrivilege();
    stage = "stop";
    if (input.daemonRunning) {
      checked(input.run, ["--stop"]);
      stopped = true;
    }
    stage = "uninstall";
    input.uninstall();
    uninstalled = true;
    stage = "cleanup";
    input.cleanup();
    stage = "verify";
    input.verify();
  } catch (cause) {
    let recoveryError: unknown;
    if (stopped && !uninstalled) {
      try {
        checked(input.run, ["--daemon"]);
      } catch (error) {
        recoveryError = error;
      }
    }
    throw new ClientUninstallLifecycleError(stage, cause, recoveryError);
  }
}
