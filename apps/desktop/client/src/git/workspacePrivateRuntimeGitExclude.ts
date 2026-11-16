import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isWorkspaceCodeflowaiFileDeviceMatch } from "../codeflowai/workspaceCodeflowaiDirectory.js";

type GitContext = { workspaceRoot: string; repositoryRoot?: string; excludePath?: string };
const verifiedExcludes = new Map<string, string>();
const gitConfigLocations = new Map<string, string[] | null>();

export class WorkspacePrivateRuntimeGitError extends Error {
  /** 保存可判定错误码、阶段及安全路径；调用边界负责一次日志和用户提示。 */
  constructor(readonly code: string, readonly phase: string, readonly context: GitContext, message: string, options?: ErrorOptions) {
    super(`${phase}: ${message} [workspace=${context.workspaceRoot}${context.repositoryRoot ? `, repository=${context.repositoryRoot}` : ""}${context.excludePath ? `, exclude=${context.excludePath}` : ""}]`, options);
    this.name = "WorkspacePrivateRuntimeGitError";
  }
}

/** 保护数据库及 sidecar 或指定运行文件；非 Git 不调用 Git，已跟踪数据留给用户处理。 */
export function ensureWorkspacePrivateRuntimeGitExclude(
  workspacePath: string,
  cacheName: "knowledge-search.sqlite" | "file-index.db" | readonly string[] = "knowledge-search.sqlite",
  onCloseUnconfirmed?: (error: unknown) => void,
): void {
  const context: GitContext = { workspaceRoot: fs.realpathSync.native(workspacePath) };
  const files = typeof cacheName === "string"
    ? (cacheName === "knowledge-search.sqlite" || cacheName === "file-index.db"
      ? ["", "-wal", "-shm", "-journal"].map(suffix => `${cacheName}${suffix}`) : [])
    : cacheName;
  if (!files.length || files.some(file => !file || file.includes("\0") || file.includes("\\") || path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || file.split("/").some(part => !part || part === "." || part === ".."))) {
    throw gitFailure(context, "verify", "工作区运行文件清单非法");
  }
  const cacheKey = JSON.stringify([context.workspaceRoot, files]);
  if (!findGitMarker(context)) { verifiedExcludes.delete(cacheKey); return; }
  const fingerprint = excludeInputFingerprint(context, files);
  if (fingerprint !== null && verifiedExcludes.get(cacheKey) === fingerprint) return;
  verifiedExcludes.delete(cacheKey);
  const locations = runGit(context, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-path", "info/exclude"], "locate").toString("utf8").replace(/\r?\n$/, "").split(/\r?\n/);
  if (locations.length !== 3 || locations.some(value => !path.isAbsolute(value))) {
    throw gitFailure(context, "locate", "Git 返回的仓库或 exclude 路径无效");
  }
  context.repositoryRoot = fs.realpathSync.native(locations[0]!);
  context.excludePath = path.normalize(locations[2]!);
  inspectDirectory(context, path.normalize(locations[1]!));
  try {
    inspectDirectory(context, path.join(locations[1]!, "info"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
  const relative = path.relative(context.repositoryRoot, context.workspaceRoot);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw gitFailure(context, "locate", "工作区不属于 Git 返回的仓库");
  }
  const runtimePath = path.join(relative, ".codeflowai").split(path.sep).join("/");
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const pathspec = `${caseInsensitive ? ":(icase,literal)" : ":(literal)"}${runtimePath}`;
  const tracked = runGit(context, ["ls-files", "--cached", "-z", "--", pathspec], "tracked");
  if (tracked.length) {
    throw new WorkspacePrivateRuntimeGitError("WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED", "tracked", context, "工作区 .codeflowai 已被 Git 跟踪或暂存，请先人工处理跟踪状态");
  }
  const rule = `/${runtimePath.replace(/[\\*?\[\]#! ]/g, value => `\\${value}`)}/`;
  appendExcludeRule(context, rule, onCloseUnconfirmed);
  const artifacts = Buffer.from(files.map(file => `${runtimePath}/${file}\0`).join(""));
  const ignored = runGit(context, ["check-ignore", "--no-index", "--stdin", "-z"], "verify", artifacts);
  if (!ignored.equals(artifacts)) throw gitFailure(context, "verify", "Git exclude 未能排除全部指定运行文件，请检查仓库规则");
  const verified = excludeInputFingerprint(context, files);
  if (verified !== null && verified === fingerprint && pathKey(context.repositoryRoot) === pathKey(context.workspaceRoot)) {
    verifiedExcludes.set(cacheKey, verified);
    if (verifiedExcludes.size > 64) verifiedExcludes.delete(verifiedExcludes.keys().next().value!);
  }
}

/** 根仓库及绝对全局配置覆盖按真实输入复用证明；复杂配置和未知环境仍完整校验。 */
function excludeInputFingerprint(context: GitContext, files: readonly string[]): string | null {
  const root = context.workspaceRoot, marker = path.join(root, ".git");
  if (files.some(file => file.includes("/"))) return null;
  if (Object.keys(process.env).some(key => /^GIT_/i.test(key) && !/^GIT_(?:TRACE.*|OPTIONAL_LOCKS|PAGER|CONFIG_GLOBAL)$/i.test(key))) return null;
  const globalConfig = process.env.GIT_CONFIG_GLOBAL;
  if (globalConfig !== undefined && (!globalConfig || !path.isAbsolute(globalConfig))) return null;
  try {
    const stat = fs.lstatSync(marker, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return null;
    if (fs.readdirSync(marker).some(name => name.startsWith("sharedindex.") || name === "commondir")) return null;
    const externalConfigs = resolveGitConfigLocations(context);
    if (externalConfigs === null) return null;
    const configs = [path.join(marker, "config"), path.join(marker, "config.worktree"), ...externalConfigs];
    for (const file of configs) {
      const config = fs.lstatSync(file, { throwIfNoEntry: false });
      if (config && (!config.isFile() || config.isSymbolicLink()
        || /\[\s*(?:include|includeIf)\b|\bworktree\s*=|\bbare\s*=\s*"?(?:true|yes|on|1)\b/i.test(fs.readFileSync(file, "utf8")))) return null;
    }
    const inputs = [marker, path.join(marker, "index"), path.join(marker, "HEAD"), path.join(marker, "info"),
      path.join(marker, "info", "exclude"), path.join(root, ".gitignore"), path.join(root, ".codeflowai", ".gitignore"), ...configs];
    const signature: unknown[] = [];
    for (const file of inputs) {
      const item = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (item?.isSymbolicLink()) {
        if (file === path.join(marker, "info") || file === path.join(marker, "info", "exclude")) throw gitFailure(context, "exclude", "Git 排除元数据不能是符号链接");
        return null;
      }
      signature.push(item ? [file, String(item.dev), String(item.ino), String(item.mode), String(item.nlink), String(item.size), String(item.mtimeNs), String(item.ctimeNs)] : [file, null]);
    }
    return JSON.stringify([process.env.PATH, globalConfig ?? null, signature]);
  } catch (error) {
    if (error instanceof WorkspacePrivateRuntimeGitError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw gitFailure(context, "verify", "无法检查 Git 保护输入", error);
  }
}

/** Git 2.43 起报告配置路径（含全局覆盖及缺失文件）；覆盖切换时重新查询，不猜安装前缀。 */
function resolveGitConfigLocations(context: GitContext): string[] | null {
  const key = JSON.stringify([context.workspaceRoot, process.env.PATH, process.env.HOME, process.env.USERPROFILE, process.env.HOMEDRIVE, process.env.HOMEPATH,
    process.env.XDG_CONFIG_HOME, process.env.ProgramData, process.env.GIT_CONFIG_GLOBAL]);
  if (gitConfigLocations.has(key)) return gitConfigLocations.get(key)!;
  const version = /git version (\d+)\.(\d+)/.exec(runGit(context, ["--version"], "locate").toString("utf8"));
  let locations: string[] | null = null;
  if (version && (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 43))) {
    locations = ["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL"].flatMap(name =>
      runGit(context, ["var", name], "locate").toString("utf8").replace(/\r?\n$/, "").split(/\r?\n/));
    if (process.platform === "win32") locations.push(path.join(process.env.ProgramData || "C:/ProgramData", "Git", "config"));
    if (locations.some(file => !path.isAbsolute(file) || file !== file.trim())) locations = null;
  }
  gitConfigLocations.set(key, locations);
  if (gitConfigLocations.size > 64) gitConfigLocations.delete(gitConfigLocations.keys().next().value!);
  return locations;
}

/** 只沿父链寻找 .git；仅 ENOENT 是不存在，嵌套仓库不代表工作区根。 */
function findGitMarker(context: GitContext): boolean {
  let directory = context.workspaceRoot;
  while (true) {
    const marker = path.join(directory, ".git");
    try {
      const stat = fs.lstatSync(marker);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw gitFailure(context, "marker", `Git marker 类型无效：${marker}`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw gitFailure(context, "marker", `无法确认 Git marker：${marker}`, error);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

/** 参数数组及可选 NUL 输入均不经 shell；启动、超时、拒绝或非零状态明确失败。 */
function runGit(context: GitContext, args: string[], phase: string, input?: Buffer): Buffer {
  const result = spawnSync("git", args, { cwd: context.repositoryRoot ?? context.workspaceRoot, input, windowsHide: true, shell: false, timeout: 15_000, maxBuffer: 1_048_576 });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? (phase === "verify" && result.status === 1 ? "Git exclude 未能排除指定运行文件，请检查仓库规则" : result.stderr?.toString("utf8").slice(0, 1000) || "Git 执行失败");
    throw gitFailure(context, phase, `exit=${result.status}, signal=${result.signal}: ${reason}`, result.error);
  }
  return result.stdout;
}

/** 检查元数据目录是 Git 指定位置的普通物理目录，不限制它必须位于工作区内。 */
function inspectDirectory(context: GitContext, directory: string): fs.Stats {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || pathKey(fs.realpathSync.native(directory)) !== pathKey(directory)) {
    throw gitFailure(context, "exclude", `Git 元数据目录不是普通物理目录：${directory}`);
  }
  return stat;
}

/** 最小追加并复核目录和 fd 身份；关闭副错不能覆盖写入或校验主错。 */
function appendExcludeRule(context: GitContext, rule: string, onCloseUnconfirmed?: (error: unknown) => void): void {
  const excludePath = context.excludePath!;
  const parent = path.dirname(excludePath);
  try {
    try {
      fs.lstatSync(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
      const grandparent = path.dirname(parent);
      const expected = inspectDirectory(context, grandparent);
      fs.mkdirSync(parent);
      assertDirectoryIdentity(context, grandparent, expected);
    }
    const parentIdentity = inspectDirectory(context, parent);
    let expected: fs.Stats | null = null;
    try {
      expected = fs.lstatSync(excludePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
    }
    if (expected) assertExcludeFile(context, expected);
    assertDirectoryIdentity(context, parent, parentIdentity);
    const fd = fs.openSync(excludePath, expected ? "a+" : "ax+");
    let hasFailure = false;
    let failure: unknown;
    try {
      const opened = fs.fstatSync(fd);
      assertExcludeFile(context, opened, expected ?? opened);
      assertDirectoryIdentity(context, parent, parentIdentity);
      const original = fs.readFileSync(fd);
      if (!original.toString("utf8").split(/\r?\n/).includes(rule)) {
        const newline = original.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
        const prefix = original.length && original[original.length - 1] !== 10 ? newline : "";
        assertExcludeFile(context, fs.lstatSync(excludePath), opened);
        assertDirectoryIdentity(context, parent, parentIdentity);
        const addition = Buffer.from(`${prefix}${rule}${newline}`);
        fs.writeFileSync(fd, addition, { flag: "a" });
      }
      assertExcludeFile(context, fs.fstatSync(fd), opened);
      assertExcludeFile(context, fs.lstatSync(excludePath), opened);
      assertDirectoryIdentity(context, parent, parentIdentity);
    } catch (error) {
      hasFailure = true;
      failure = error;
      throw error;
    } finally {
      try {
        fs.closeSync(fd);
      } catch (closeError) {
        const causes = hasFailure ? [failure, closeError] : [closeError];
        const combined = hasFailure ? new AggregateError(causes, "Git exclude 操作及关闭均失败", { cause: failure }) : closeError;
        try { onCloseUnconfirmed?.(combined); }
        catch (notificationError) { causes.push(notificationError); }
        if (causes.length > 1) throw new AggregateError(causes, "Git exclude 操作及关闭均失败", { cause: hasFailure ? failure : closeError });
        throw closeError;
      }
    }
  } catch (error) {
    if (error instanceof WorkspacePrivateRuntimeGitError) throw error;
    throw gitFailure(context, "exclude", "无法安全写入本机 Git exclude", error, true);
  }
}

/** 文件必须独占普通 inode，并保持路径与已打开 fd 指向同一身份。 */
function assertExcludeFile(context: GitContext, current: fs.Stats, expected?: fs.Stats): void {
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || (expected && (!isWorkspaceCodeflowaiFileDeviceMatch(expected.dev, current.dev) || expected.ino !== current.ino)) || pathKey(fs.realpathSync.native(context.excludePath!)) !== pathKey(context.excludePath!)) {
    throw gitFailure(context, "exclude", "Git exclude 不是普通独占文件或访问期间已被替换");
  }
}

/** 防止校验后替换元数据父目录；不自动改权限或清理异常工件。 */
function assertDirectoryIdentity(context: GitContext, directory: string, expected: fs.Stats): void {
  const current = inspectDirectory(context, directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw gitFailure(context, "exclude", `Git 元数据目录在访问期间已被替换：${directory}`);
}

/** Windows 路径大小写不影响身份，其他系统保持原比较语义。 */
function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 保留原错误及上下文；显式 presence 可区分无根因与 throw undefined。 */
function gitFailure(context: GitContext, phase: string, message: string, cause?: unknown, hasCause = cause !== undefined): WorkspacePrivateRuntimeGitError {
  const reason = cause instanceof Error ? `：${cause.message}` : "";
  return new WorkspacePrivateRuntimeGitError("WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED", phase, context, `${message}${reason}`, hasCause ? { cause } : undefined);
}
