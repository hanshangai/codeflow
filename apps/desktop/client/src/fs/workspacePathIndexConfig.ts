import fs from "node:fs";
import path from "node:path";
import { flattenWorkspacePathIndexDefaultExclusions } from "@codeflowai/shared/workspace-path-index-defaults";

export const DEFAULT_WORKSPACE_PATH_INDEX_MAX_ENTRIES = 300_000;
export const MIN_WORKSPACE_PATH_INDEX_MAX_ENTRIES = 1_000;
export const MAX_WORKSPACE_PATH_INDEX_MAX_ENTRIES = 500_000;
export const WORKSPACE_PATH_INDEX_DIRECTORY = ".codeflowai";
export const WORKSPACE_PATH_INDEX_DATABASE_FILE = "file-index.db";
export const WORKSPACE_PATH_INDEX_DATABASE_REL_PATH = `${WORKSPACE_PATH_INDEX_DIRECTORY}/${WORKSPACE_PATH_INDEX_DATABASE_FILE}`;
export const WORKSPACE_PATH_INDEX_SCHEMA_VERSION = 1;
export const WORKSPACE_PATH_INDEX_APPLICATION_ID = 0x43464958;
export const WORKSPACE_PATH_INDEX_POLICY_STAMP = "workspace-path-index-policy-v2";

export type WorkspacePathIndexPathScope = { workspaceRoot: string; privateRuntimeRoot: string | null };

/** Windows 尾空格/点目录必须按真实名称访问，避免 Win32 隐式改名。 */
export function workspacePathIndexFsPath(value: string): string {
  return process.platform === "win32" && /[ .](?:[\\/]|$)/u.test(value) ? path.toNamespacedPath(value) : value;
}

export class WorkspacePathIndexPathError extends Error {
  readonly code = "INTERNAL_ERROR";
  generation: number | null = null;

  /** 路径失败只携安全原因码；原始 I/O 异常保留在 cause，不能直接回显。 */
  constructor(
    readonly diagnosticCode: "WORKSPACE_FILE_INDEX_PRIVATE_TARGET" | "WORKSPACE_FILE_INDEX_PATH_CHECK_FAILED",
    readonly logicalPath: string,
    readonly systemCode: string,
    options?: ErrorOptions,
  ) {
    super(diagnosticCode === "WORKSPACE_FILE_INDEX_PRIVATE_TARGET" ? "文件索引路径已指向私有运行目录，请重建索引" : "无法确认文件索引路径的真实目标", options);
    this.name = "WorkspacePathIndexPathError";
  }
}

/** 每次扫描或查询只解析一次真实根；私有目录确实缺失时不创建它。 */
export function readWorkspacePathIndexPathScope(workspacePath: string): WorkspacePathIndexPathScope {
  let workspaceRoot: string;
  try { workspaceRoot = fs.realpathSync.native(workspacePath); }
  catch (error) { throw workspacePathIndexPathFailure(".", error); }
  const privatePath = path.join(workspaceRoot, ".codeflowai");
  try { fs.lstatSync(privatePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { workspaceRoot, privateRuntimeRoot: null };
    throw workspacePathIndexPathFailure(".codeflowai", error);
  }
  try { return { workspaceRoot, privateRuntimeRoot: fs.realpathSync.native(privatePath) }; }
  catch (error) { throw workspacePathIndexPathFailure(".codeflowai", error); }
}

/** 检查真实目标和缺失项的现存父路径；悬空链接与其他 I/O 失败均显式报错。 */
export function isWorkspacePathIndexPrivatePath(scope: WorkspacePathIndexPathScope, relPath: string): boolean {
  let candidate = path.resolve(scope.workspaceRoot, relPath);
  while (true) {
    let real: string;
    try { real = fs.realpathSync.native(workspacePathIndexFsPath(candidate)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw workspacePathIndexPathFailure(relPath, error);
      try { fs.lstatSync(workspacePathIndexFsPath(candidate)); }
      catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw workspacePathIndexPathFailure(relPath, statError);
        const parent = path.dirname(candidate);
        if (parent === candidate) throw workspacePathIndexPathFailure(relPath, error);
        candidate = parent;
        continue;
      }
      throw workspacePathIndexPathFailure(relPath, error);
    }
    const relative = path.relative(scope.workspaceRoot, real).replace(/\\/g, "/");
    if (/^\.codeflow(?:ai)?(?:\/|$)/iu.test(relative)) return true;
    if (!scope.privateRuntimeRoot) return false;
    const privateRelative = path.relative(scope.privateRuntimeRoot, real);
    return privateRelative === "" || (!privateRelative.startsWith(`..${path.sep}`) && privateRelative !== ".." && !path.isAbsolute(privateRelative));
  }
}

/** 固定诊断字段避免把任意异常正文带入响应和日志。 */
export function workspacePathIndexPathFailure(relPath: string, error: unknown): WorkspacePathIndexPathError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new WorkspacePathIndexPathError("WORKSPACE_FILE_INDEX_PATH_CHECK_FAILED", relPath,
    typeof code === "string" && /^E[A-Z0-9_]{1,40}$/u.test(code) ? code : "PATH_IDENTITY_ERROR", { cause: error });
}

const defaultExclusions = flattenWorkspacePathIndexDefaultExclusions();
const DEFAULT_EXCLUDED_DIRECTORY_NAMES = new Set(defaultExclusions.directoryNames);
const DEFAULT_EXCLUDED_ROOT_DIRECTORY_NAMES = new Set(defaultExclusions.rootDirectoryNames);
const DEFAULT_EXCLUDED_PATHS = new Set(defaultExclusions.paths);
const DEFAULT_EXCLUDED_PATH_PREFIXES = new Set(defaultExclusions.pathPrefixes);

/** 生成固定的工作区索引库路径；索引文件不允许由配置覆盖。 */
export function workspacePathIndexDatabasePath(workspacePath: string): string {
  return `${String(workspacePath ?? "").replace(/[\\/]+$/g, "")}/${WORKSPACE_PATH_INDEX_DATABASE_REL_PATH}`;
}

/**
 * 判断相对路径是否属于索引库、SQLite sidecar 或损坏恢复副本。
 * 只排除明确的系统缓存名称，避免误伤 file-index.db-notes 等业务文件。
 */
export function isWorkspacePathIndexStorageRelPath(
  value: unknown,
  options: { caseSensitive?: boolean } = {},
): boolean {
  const relPath = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!relPath) return false;
  const caseSensitive = options.caseSensitive ?? (process.platform !== "win32" && process.platform !== "darwin");
  const comparison = caseSensitive ? relPath : relPath.toLowerCase();
  return [WORKSPACE_PATH_INDEX_DATABASE_REL_PATH, ".codeflow/file-index.db", "codeflowai/file-index.db"].some((value) => {
    const base = caseSensitive ? value : value.toLowerCase();
    if ([base, `${base}-wal`, `${base}-shm`, `${base}-journal`].includes(comparison)) return true;
    const recoveryPrefix = `${base}.recovery-`;
    if (!comparison.startsWith(recoveryPrefix)) return false;
    const recoverySuffix = comparison.slice(recoveryPrefix.length);
    return Boolean(recoverySuffix) && !recoverySuffix.includes("/");
  });
}

/** 规则用规范化值匹配，真实目标检查保留文件名空格，不能改写路径身份。 */
export function isWorkspacePathIndexPathExcluded(
  value: unknown,
  isDirectory: boolean,
  options: { excludeDirNames?: readonly string[]; excludePathPrefixes?: readonly string[]; pathScope?: WorkspacePathIndexPathScope } = {},
): boolean {
  const filesystemPath = String(value ?? "");
  const relPath = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!filesystemPath || isWorkspacePathIndexStorageRelPath(relPath)) return true;
  const normalizedPath = relPath.toLowerCase();
  const parts = normalizedPath.split("/");
  const directoryParts = isDirectory ? parts : parts.slice(0, -1);
  if (directoryParts.some((part) => part.startsWith("."))) return true;
  const customDirectoryNames = new Set((options.excludeDirNames ?? []).map((item) => String(item).toLowerCase()));
  if (directoryParts.some((part) => DEFAULT_EXCLUDED_DIRECTORY_NAMES.has(part) || customDirectoryNames.has(part))) return true;
  if (directoryParts.length > 0 && DEFAULT_EXCLUDED_ROOT_DIRECTORY_NAMES.has(directoryParts[0] ?? "")) return true;
  if (DEFAULT_EXCLUDED_PATHS.has(normalizedPath)) return true;
  if (matchesWorkspacePathIndexPrefix(normalizedPath, DEFAULT_EXCLUDED_PATH_PREFIXES)) return true;
  if (normalizedPath.includes("/vendor/bundle/") || normalizedPath.endsWith("/vendor/bundle")) return true;
  const customPrefixes = new Set((options.excludePathPrefixes ?? []).map((item) => String(item).toLowerCase()));
  if (matchesWorkspacePathIndexPrefix(normalizedPath, customPrefixes)) return true;
  if (options.pathScope && isWorkspacePathIndexPrivatePath(options.pathScope, filesystemPath)) return true;
  if (isDirectory) return false;
  const name = parts.at(-1) ?? "";
  return name.endsWith(".tsbuildinfo") || name.endsWith(".pyc") || name.endsWith(".pyo");
}

function matchesWorkspacePathIndexPrefix(normalizedPath: string, prefixes: ReadonlySet<string>): boolean {
  for (const prefix of prefixes) {
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** 归一化索引规模上限；环境变量和服务兜底使用 fallback。 */
export function normalizeWorkspacePathIndexMaxEntries(value: unknown, fallback = DEFAULT_WORKSPACE_PATH_INDEX_MAX_ENTRIES): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return normalizeWorkspacePathIndexMaxEntriesFallback(fallback);
  return clampWorkspacePathIndexMaxEntries(parsed);
}

/** 归一化用户显式配置；空值表示继续使用 Client 级默认。 */
export function normalizeOptionalWorkspacePathIndexMaxEntries(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("参数错误：fileIndex.maxEntries 必须是正整数");
  }
  return clampWorkspacePathIndexMaxEntries(parsed);
}

/** 将数值限制在索引资源保护范围内。 */
function clampWorkspacePathIndexMaxEntries(value: number): number {
  return Math.min(MAX_WORKSPACE_PATH_INDEX_MAX_ENTRIES, Math.max(MIN_WORKSPACE_PATH_INDEX_MAX_ENTRIES, Math.floor(value)));
}

/** 归一化 fallback，避免递归调用和非法兜底值。 */
function normalizeWorkspacePathIndexMaxEntriesFallback(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WORKSPACE_PATH_INDEX_MAX_ENTRIES;
  return clampWorkspacePathIndexMaxEntries(parsed);
}
