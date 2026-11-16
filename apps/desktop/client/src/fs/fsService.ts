import fs from "node:fs";
import fsp from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";

import type {
  ClientDirectoryNode,
  FsDownloadChunkResponseBody,
  FsDownloadFileResponseBody,
  FsDownloadStatResponseBody,
  FsDocumentPreviewResponseBody,
  FsSearchResponseBody,
  FsSearchResult,
  FsUploadBeginResponseBody,
  FsUploadChunkResponseBody,
  FsUploadCompleteResponseBody,
  FsSpreadsheetCellValue,
  FsSpreadsheetPreviewResponseBody,
  FsTreeNode,
  FsReadFileResponseBody,
} from "@codeflowai/shared";
import { getMimeType, isBinaryFile, isDocumentPreviewFile, isImageFile, isSpreadsheetFile, resolveWorkspacePath, resolveWorkspaceReadPath } from "./fsHelpers.js";
import { decodeTextBuffer } from "./textEncoding.js";
import { isWorkspacePathIndexPathExcluded, readWorkspacePathIndexPathScope, workspacePathIndexFsPath } from "./workspacePathIndexConfig.js";

const DEFAULT_MAX_BYTES = 512 * 1024; // 512KB
const SPREADSHEET_MAX_BYTES = 10 * 1024 * 1024;
const DOCUMENT_PREVIEW_MAX_BYTES = 15 * 1024 * 1024;
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const WORD_PREVIEW_MAX_HTML_CHARS = 200_000;
const SPREADSHEET_DEFAULT_MAX_ROWS = 200;
const SPREADSHEET_DEFAULT_MAX_COLUMNS = 50;
const TRANSFER_UPLOAD_CHUNK_SIZE = 256 * 1024;
const CLIENT_DIRECTORY_MAX_CHILDREN = 1000;
const FS_SEARCH_DEFAULT_LIMIT = 50;
const FS_SEARCH_MAX_LIMIT = 100;
const FS_SEARCH_MAX_VISITED = 100_000;
const FS_SEARCH_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".pnpm",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "target",
  "coverage",
  ".turbo",
  ".cache",
]);
const CLIENT_DIRECTORY_EXCLUDED_NAMES = new Set([
  "$recycle.bin",
  "$windows.~bt",
  "$winreagent",
  "appdata",
  "config.msi",
  "msocache",
  "programdata",
  "recovery",
  "system volume information",
]);
const CLIENT_DIRECTORY_WINDOWS_ROOT_EXCLUDED_NAMES = new Set([
  "documents and settings",
  "perflogs",
  "program files",
  "program files (arm)",
  "program files (x86)",
  "windows",
]);
const CLIENT_DIRECTORY_DARWIN_ROOT_EXCLUDED_NAMES = new Set([
  "bin",
  "cores",
  "dev",
  "etc",
  "library",
  "private",
  "sbin",
  "system",
  "tmp",
  "usr",
  "var",
]);
const CLIENT_DIRECTORY_LINUX_ROOT_EXCLUDED_NAMES = new Set([
  "bin",
  "boot",
  "dev",
  "etc",
  "lib",
  "lib32",
  "lib64",
  "libx32",
  "lost+found",
  "proc",
  "root",
  "run",
  "sbin",
  "sys",
  "tmp",
  "usr",
  "var",
]);

type UploadSession = {
  uploadId: string;
  workspacePath: string;
  targetDir: string;
  fileName: string;
  finalPath: string;
  tempPath: string;
  sizeBytes: number;
  receivedBytes: number;
  mimeType: string | null;
  overwrite: boolean;
  createdAt: number;
};

export type FsUploadCompleteInternalResult = FsUploadCompleteResponseBody & {
  /** 仅供 Client handler 更新本地索引使用，不透传给 Server/Web。 */
  workspacePath: string;
};

const uploadSessions = new Map<string, UploadSession>();

/** 只从本机原上传会话读取可信工作区路径；未知ID不推测归属。 */
export function getUploadWorkspacePath(uploadId: string): string | null {
  return uploadSessions.get(String(uploadId ?? "").trim())?.workspacePath ?? null;
}

/**
 * 列出目录树（懒加载）。
 * @param workspacePath workspace 绝对路径
 * @param dirPath 相对路径（POSIX），空表示根
 * @param depth 递归深度（1=仅当前层级）
 * @param showHidden 是否展示名称以 "." 开头的文件或文件夹
 */
export function listTree(workspacePath: string, dirPath: string, depth: number, showHidden = false): FsTreeNode[] {
  const absDir = resolveWorkspaceReadPath(workspacePath, dirPath);
  return walkDir(workspacePath, absDir, 0, depth, createVisitedDirs(absDir, dirPath || "."), showHidden, dirPath);
}

/** RPC 分段驱动原文件树遍历；每轮32ms后让出，避免小批次在持续输出下反复排队。 */
export async function listTreeAsync(workspacePath: string, dirPath: string, depth: number, showHidden = false): Promise<FsTreeNode[]> {
  const realRoot = fs.realpathSync.native(workspacePath);
  const rootIdentity = fs.statSync(realRoot);
  const absDir = resolveWorkspaceReadPath(workspacePath, dirPath);
  const traversal = walkDirSteps(workspacePath, absDir, 0, depth, createVisitedDirs(absDir, dirPath || "."), showHidden, dirPath, realRoot);
  let startedAt = performance.now();
  while (true) {
    const step = traversal.next();
    if (step.done) return step.value;
    if (performance.now() - startedAt >= 32) {
      await yieldImmediate();
      const currentRoot = fs.realpathSync.native(workspacePath), identity = fs.statSync(currentRoot);
      if (currentRoot !== realRoot || identity.ino !== rootIdentity.ino
        || identity.dev !== rootIdentity.dev && identity.dev !== 0 && rootIdentity.dev !== 0) {
        throw Object.assign(new Error("文件树工作区根在读取期间已变化"), { code: "FILE_TRANSFER_PATH_INVALID" });
      }
      startedAt = performance.now();
    }
  }
}

/**
 * 搜索时共用本次真实根与私有目录排除，空 query 仍返回根候选。
 */
export function searchPaths(
  workspacePath: string,
  query: string,
  opts?: {
    limit?: number | null;
    cursor?: string | null;
    includeHidden?: boolean | null;
    kind?: "file" | "directory" | "all" | null;
    excludeDirNames?: readonly string[];
    excludePathPrefixes?: readonly string[];
  },
): FsSearchResponseBody {
  const workspaceRoot = resolveWorkspacePath(workspacePath, "");
  const exclusions = { ...opts, pathScope: readWorkspacePathIndexPathScope(workspaceRoot) };
  const limit = normalizeSearchLimit(opts?.limit);
  const offset = normalizeSearchCursor(opts?.cursor);
  const includeHidden = opts?.includeHidden === true;
  const kind = opts?.kind === "file" || opts?.kind === "directory" ? opts.kind : "all";
  const directoryQuery = parseDirectorySearchQuery(query);
  if (directoryQuery) return listDirectorySearchPage(workspaceRoot, directoryQuery, offset, limit, includeHidden, kind, exclusions);

  const normalizedQuery = normalizeSearchQuery(query);

  const results: Array<FsSearchResult & { score: number }> = [];
  const visitedDirs = createVisitedDirs(workspaceRoot, ".");
  let visited = 0;

  const walk = (dirAbs: string): void => {
    if (visited >= FS_SEARCH_MAX_VISITED) {
      throw new Error(`文件搜索范围过大（超过 ${FS_SEARCH_MAX_VISITED} 个条目），请继续输入更精确的路径关键词`);
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(workspacePathIndexFsPath(dirAbs), { withFileTypes: true });
    } catch (error) {
      const relPath = path.relative(workspaceRoot, dirAbs).split(path.sep).join("/") || ".";
      throw new Error(`无法搜索目录：${relPath}（${error instanceof Error ? error.message : String(error)}）`);
    }

    for (const entry of entries) {
      visited += 1;
      if (visited > FS_SEARCH_MAX_VISITED) {
        throw new Error(`文件搜索范围过大（超过 ${FS_SEARCH_MAX_VISITED} 个条目），请继续输入更精确的路径关键词`);
      }
      if (!shouldIncludeSearchDirent(entry.name, includeHidden)) continue;
      const abs = path.join(dirAbs, entry.name);
      const relPath = path.relative(workspaceRoot, abs).split(path.sep).join("/");
      if (isWorkspacePathIndexPathExcluded(relPath, entry.isDirectory(), exclusions)) continue;
      const resolved = resolveDirentKind(entry, workspacePathIndexFsPath(abs), relPath);
      if (!resolved) continue;
      const isDir = resolved.isDir;
      if (isDir !== entry.isDirectory() && isWorkspacePathIndexPathExcluded(relPath, isDir, exclusions)) continue;
      if (isDir && FS_SEARCH_EXCLUDED_DIRS.has(entry.name)) continue;

      const allowedKind = kind === "all" || (kind === "directory" ? isDir : !isDir);
      const score = allowedKind ? scoreSearchCandidate(relPath, entry.name, normalizedQuery, isDir) : -1;
      if (score >= 0) {
        const stat = resolved.stat ?? (isDir ? null : readFileStat(workspacePathIndexFsPath(abs), relPath));
        results.push({
          name: entry.name,
          path: relPath,
          isDir,
          size: isDir ? undefined : stat?.size,
          mtime: stat?.mtime?.toISOString(),
          score,
        });
      }

      if (isDir) {
        const nextVisited = createChildVisitedDirs(visitedDirs, abs, relPath);
        if (nextVisited) {
          for (const dir of nextVisited) visitedDirs.add(dir);
          walk(abs);
        }
      }
    }
  };

  walk(workspaceRoot);
  const sorted = results
    .sort((a, b) => a.score - b.score || Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path))
    .map(({ score: _score, ...item }) => item);
  return sliceSearchPage(sorted, offset, limit);
}

/** 保留逻辑目录名称；递归前校验真实目标仍在工作区内，访问失败显式抛出。 */
function walkDir(workspacePath: string, dirAbs: string, currentDepth: number, maxDepth: number, visitedDirs: Set<string>, showHidden: boolean, relativeDir = path.relative(workspacePath, dirAbs)): FsTreeNode[] {
  const traversal = walkDirSteps(workspacePath, dirAbs, currentDepth, maxDepth, visitedDirs, showHidden, relativeDir, fs.realpathSync.native(workspacePath));
  while (true) { const step = traversal.next(); if (step.done) return step.value; }
}

/** 同步与分段RPC共用节点处理及排序，yield仅出现在节点之间。 */
function* walkDirSteps(workspacePath: string, dirAbs: string, currentDepth: number, maxDepth: number, visitedDirs: Set<string>, showHidden: boolean, relativeDir: string, realRoot: string): Generator<void, FsTreeNode[]> {
  if (currentDepth >= maxDepth) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch (error) {
    const relPath = path.relative(workspacePath, dirAbs).split(path.sep).join("/") || ".";
    throw Object.assign(new Error(`无法读取目录：${relPath}（${error instanceof Error ? error.message : String(error)}）`, { cause: error }),
      { code: (error as NodeJS.ErrnoException).code });
  }

  const dirs: FsTreeNode[] = [];
  const files: FsTreeNode[] = [];

  for (const entry of entries) {
    if (!shouldIncludeDirent(entry.name, showHidden)) continue;
    yield;
    const abs = path.join(dirAbs, entry.name);
    const relPath = path.posix.join(relativeDir.replace(/\\/g, "/"), entry.name);
    const realPath = fs.realpathSync.native(workspacePathIndexFsPath(abs));
    const realRelativePath = path.relative(realRoot, realPath);
    if (realRelativePath === ".." || realRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(realRelativePath)) {
      throw Object.assign(new Error("文件树真实目标超出工作区边界"), { code: "FILE_TRANSFER_PATH_INVALID" });
    }
    const kind = resolveDirentKind(entry, workspacePathIndexFsPath(abs), relPath);
    if (!kind) continue;

    if (kind.isDir) {
      const nextVisited = currentDepth + 1 < maxDepth ? createChildVisitedDirs(visitedDirs, abs, relPath) : null;
      const children = nextVisited ? yield* walkDirSteps(workspacePath, abs, currentDepth + 1, maxDepth, nextVisited, showHidden, relPath, realRoot) : currentDepth + 1 < maxDepth ? [] : undefined;
      dirs.push({ name: entry.name, path: relPath, isDir: true, children });
    } else if (kind.isFile) {
      const stat = kind.stat ?? readFileStat(workspacePathIndexFsPath(abs), relPath);
      files.push({
        name: entry.name,
        path: relPath,
        isDir: false,
        size: stat?.size,
        mtime: stat?.mtime?.toISOString(),
      });
    }
  }

  // 目录在前，文件在后；各自按名称排序
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

/** 判断目录项是否展示；隐藏文件定义为名称以 "." 开头。 */
function shouldIncludeDirent(name: string, showHidden: boolean): boolean {
  return showHidden || !name.startsWith(".");
}

/** 搜索结果同样默认隐藏 "." 开头路径。 */
function shouldIncludeSearchDirent(name: string, includeHidden: boolean): boolean {
  return includeHidden || !name.startsWith(".");
}

type DirectorySearchQuery = {
  dirRelPath: string;
  filter: string;
};

/**
 * 目录补全保留路径字符；纯空白仍是原根查询，普通关键词仍交评分归一化。
 */
export function parseDirectorySearchQuery(query: unknown): DirectorySearchQuery | null {
  const normalized = String(query ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\/+/, "");
  if (!normalized.trim()) return { dirRelPath: "", filter: "" };
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex < 0) return null;
  return {
    dirRelPath: normalized.slice(0, slashIndex).replace(/\/+$/g, ""),
    filter: normalized.slice(slashIndex + 1),
  };
}

/**
 * 目录补全先核查询目录及候选的私有目标，再按 cursor 分页并只 stat 当前页。
 */
function listDirectorySearchPage(
  workspaceRoot: string,
  directoryQuery: DirectorySearchQuery,
  offset: number,
  limit: number,
  includeHidden: boolean,
  kind: "file" | "directory" | "all",
  exclusions: { excludeDirNames?: readonly string[]; excludePathPrefixes?: readonly string[]; pathScope: ReturnType<typeof readWorkspacePathIndexPathScope> },
): FsSearchResponseBody {
  let dirAbs: string;
  try {
    resolveWorkspacePath(workspaceRoot, directoryQuery.dirRelPath);
    dirAbs = path.resolve(workspaceRoot, directoryQuery.dirRelPath);
  } catch {
    return emptySearchPage();
  }
  if (directoryQuery.dirRelPath && isWorkspacePathIndexPathExcluded(directoryQuery.dirRelPath, true, exclusions)) return emptySearchPage();

  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(workspacePathIndexFsPath(dirAbs));
  } catch (error) {
    if (isMissingDirectoryError(error)) return emptySearchPage();
    const relPath = directoryQuery.dirRelPath || ".";
    throw new Error(`无法搜索目录：${relPath}（${error instanceof Error ? error.message : String(error)}）`);
  }

  const results: FsSearchResult[] = [];
  const filterQuery = normalizeSearchQuery(directoryQuery.filter);
  let matched = 0;
  let hasMore = false;
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (!shouldIncludeSearchDirent(entry.name, includeHidden)) continue;
      const relPath = joinWorkspaceSearchPath(directoryQuery.dirRelPath, entry.name);
      const abs = path.join(dirAbs, entry.name);
      if (isWorkspacePathIndexPathExcluded(relPath, entry.isDirectory(), exclusions)) continue;
      const resolved = resolveDirentKind(entry, workspacePathIndexFsPath(abs), relPath);
      if (!resolved) continue;
      const isDir = resolved.isDir;
      if (isDir !== entry.isDirectory() && isWorkspacePathIndexPathExcluded(relPath, isDir, exclusions)) continue;
      if (kind !== "all" && (kind === "directory" ? !isDir : isDir)) continue;
      if (filterQuery && scoreSearchCandidate(relPath, entry.name, filterQuery, isDir) < 0) continue;

      if (matched < offset) {
        matched += 1;
        continue;
      }
      if (results.length >= limit) {
        hasMore = true;
        break;
      }
      const stat = !isDir ? (resolved.stat ?? readFileStat(workspacePathIndexFsPath(abs), relPath)) : null;
      results.push({
        name: entry.name,
        path: relPath,
        isDir,
        size: isDir ? undefined : stat?.size,
        mtime: stat?.mtime?.toISOString(),
      });
      matched += 1;
    }
  } finally {
    dir.closeSync();
  }

  return {
    results,
    hasMore,
    nextCursor: hasMore ? String(offset + results.length) : null,
  };
}

/** 按 offset/limit 切出一页候选，避免前端一次接收大列表。 */
function sliceSearchPage(results: FsSearchResult[], offset: number, limit: number): FsSearchResponseBody {
  const safeOffset = Math.min(Math.max(0, offset), results.length);
  const page = results.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + page.length;
  const hasMore = nextOffset < results.length;
  return {
    results: page,
    hasMore,
    nextCursor: hasMore ? String(nextOffset) : null,
  };
}

/** 构造空搜索页，供不存在的目录型查询直接返回。 */
export function emptySearchPage(): FsSearchResponseBody {
  return { results: [], hasMore: false, nextCursor: null };
}

/** 判断 opendir 失败是否表示目标目录不可作为候选目录。 */
function isMissingDirectoryError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? String((error as { code?: unknown }).code ?? "") : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 拼接 workspace 相对 POSIX 路径。 */
function joinWorkspaceSearchPath(dirRelPath: string, name: string): string {
  const dir = String(dirRelPath ?? "").replace(/^\/+|\/+$/g, "");
  return dir ? `${dir}/${name}` : name;
}

/** 归一化传输文件名，只允许单个文件名，禁止携带路径段。 */
function normalizeTransferFileName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("文件名不能包含路径分隔符");
  }
  return name;
}

/** 归一化传输相对路径；非法路径保留原提示并携带明确错误码。 */
function normalizeTransferRelPath(value: unknown, allowEmpty: boolean): string {
  const raw = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!raw) {
    if (allowEmpty) return "";
    throw new Error("工作区文件路径不能为空");
  }
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw Object.assign(new Error("工作区文件路径非法"), { code: "FILE_TRANSFER_PATH_INVALID" });
  }
  return parts.join("/");
}

/** 读取非负整数大小参数，供上传声明和分片偏移复用。 */
function normalizeTransferSize(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("文件传输大小参数非法");
  return Math.floor(parsed);
}

/** 读取上传会话，缺失时显式失败，避免误判为成功。 */
function requireUploadSession(uploadId: string): UploadSession {
  const session = uploadSessions.get(String(uploadId ?? "").trim());
  if (!session) throw new Error(`上传会话不存在或已过期：${uploadId}`);
  return session;
}

/** 规范化搜索数量，避免一次请求把本地目录扫爆。 */
export function normalizeSearchLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return FS_SEARCH_DEFAULT_LIMIT;
  return Math.min(FS_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

/** 解析搜索分页游标；非法游标按第一页处理。 */
export function normalizeSearchCursor(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) return Number.MAX_SAFE_INTEGER;
  return parsed;
}

/** 搜索统一大小写和路径分隔符。 */
export function normalizeSearchQuery(value: unknown): string {
  return String(value ?? "").trim().replace(/\\/g, "/").toLowerCase();
}

/** 分数越小越靠前：basename 前缀 > basename 包含 > path 包含，目录略优先。 */
export function scoreSearchCandidate(relPath: string, name: string, query: string, isDir: boolean): number {
  const pathText = relPath.toLowerCase();
  const nameText = name.toLowerCase();
  const dirBias = isDir ? -0.2 : 0;
  if (nameText === query) return 0 + dirBias;
  if (nameText.startsWith(query)) return 10 + nameText.length + dirBias;
  if (pathText.startsWith(query)) return 40 + pathText.length + dirBias;
  const nameIndex = nameText.indexOf(query);
  if (nameIndex >= 0) return 80 + nameIndex + nameText.length + dirBias;
  const pathIndex = pathText.indexOf(query);
  if (pathIndex >= 0) return 140 + pathIndex + pathText.length + dirBias;
  return -1;
}

/** 判断目录选择器是否展示该 Client 本机目录项。 */
function shouldIncludeClientDirectoryEntry(parentDir: string, name: string, showHidden: boolean): boolean {
  if (!shouldIncludeDirent(name, showHidden)) return false;
  const normalizedName = name.toLowerCase();
  if (CLIENT_DIRECTORY_EXCLUDED_NAMES.has(normalizedName)) return false;
  return !isClientDirectoryRoot(parentDir) || !clientDirectoryRootExcludedNames().has(normalizedName);
}

/** 判断当前枚举目录是否为文件系统根目录，用于过滤根级系统目录。 */
function isClientDirectoryRoot(dirAbs: string): boolean {
  const resolved = path.resolve(dirAbs);
  return resolved === path.resolve(path.parse(resolved).root);
}

/** 获取当前平台根目录下需要隐藏的系统目录名集合。 */
function clientDirectoryRootExcludedNames(): Set<string> {
  if (process.platform === "win32") return CLIENT_DIRECTORY_WINDOWS_ROOT_EXCLUDED_NAMES;
  if (process.platform === "darwin") return CLIENT_DIRECTORY_DARWIN_ROOT_EXCLUDED_NAMES;
  return CLIENT_DIRECTORY_LINUX_ROOT_EXCLUDED_NAMES;
}

/** 读取文件元数据；保留 errno 供 RPC 边界分类失败。 */
function readFileStat(abs: string, relPath: string): fs.Stats {
  try {
    return fs.statSync(abs);
  } catch (error) {
    throw Object.assign(new Error(`无法读取文件信息：${relPath}（${error instanceof Error ? error.message : String(error)}）`, { cause: error }),
      { code: (error as NodeJS.ErrnoException).code });
  }
}

/** 判断目录项真实类型；symlink 跟随目标，失败保留 errno。 */
function resolveDirentKind(entry: fs.Dirent, abs: string, relPath: string): { isDir: boolean; isFile: boolean; stat?: fs.Stats } | null {
  if (entry.isDirectory()) return { isDir: true, isFile: false };
  if (entry.isFile()) return { isDir: false, isFile: true };
  if (!entry.isSymbolicLink()) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (error) {
    throw Object.assign(new Error(`无法解析软连接：${relPath}（${error instanceof Error ? error.message : String(error)}）`, { cause: error }),
      { code: (error as NodeJS.ErrnoException).code });
  }

  if (stat.isDirectory()) return { isDir: true, isFile: false, stat };
  if (stat.isFile()) return { isDir: false, isFile: true, stat };
  return null;
}

/** 记录当前递归分支已访问目录真实路径，避免 symlink 环路递归。 */
function createVisitedDirs(absDir: string, relPath: string): Set<string> {
  const visited = new Set<string>();
  visited.add(resolveRealDir(absDir, relPath));
  return visited;
}

/** 为子目录创建分支访问集；已访问过的真实目录不再递归展开。 */
function createChildVisitedDirs(visitedDirs: Set<string>, absDir: string, relPath: string): Set<string> | null {
  const realDir = resolveRealDir(absDir, relPath);
  if (visitedDirs.has(realDir)) return null;
  const next = new Set(visitedDirs);
  next.add(realDir);
  return next;
}

/** 获取目录真实路径；失败保留 errno，避免误报空目录或内部错误。 */
function resolveRealDir(absDir: string, relPath: string): string {
  try {
    return fs.realpathSync(absDir);
  } catch (error) {
    throw Object.assign(new Error(`无法读取目录真实路径：${relPath}（${error instanceof Error ? error.message : String(error)}）`, { cause: error }),
      { code: (error as NodeJS.ErrnoException).code });
  }
}

/**
 * 读取文件内容。
 * - 实际目标必须位于真实 workspace 内，格式仍按请求路径判断
 * - 文本文件返回解码后的 content
 * - 图片返回 base64
 * - 其他二进制文件不返回内容
 */
export function readFile(workspacePath: string, relPath: string, maxBytes?: number | null): FsReadFileResponseBody {
  const abs = resolveWorkspacePath(workspacePath, relPath);
  const readPath = resolveWorkspaceReadPath(workspacePath, relPath);
  const limit = Math.min(Math.max(Number(maxBytes) || DEFAULT_MAX_BYTES, 1024), 5 * 1024 * 1024);

  const stat = readFileStat(readPath, relPath);

  if (!stat.isFile()) throw new Error(`不是文件：${relPath}`);

  const binary = isBinaryFile(abs);
  const image = isImageFile(abs);
  const mime = getMimeType(abs);

  if (binary && !image) {
    return { path: relPath, content: null, isBinary: true, size: stat.size, mimeType: mime };
  }

  if (image) {
    // 图片限 5MB
    if (stat.size > 5 * 1024 * 1024) {
      return { path: relPath, content: null, isBinary: true, size: stat.size, mimeType: mime };
    }
    const buf = fs.readFileSync(readPath);
    return {
      path: relPath,
      content: null,
      isBinary: true,
      size: stat.size,
      base64: buf.toString("base64"),
      mimeType: mime,
    };
  }

  // 文本文件
  if (stat.size > limit) {
    const fd = fs.openSync(readPath, "r");
    const buf = Buffer.alloc(limit);
    const bytesRead = fs.readSync(fd, buf, 0, limit, 0);
    fs.closeSync(fd);
    const decoded = decodeTextBuffer(buf.subarray(0, bytesRead), { allowPartialTail: true });
    return {
      path: relPath,
      content: decoded.content + "\n…(文件过大，已截断)",
      isBinary: false,
      size: stat.size,
      mimeType: mime,
      encoding: decoded.encoding,
    };
  }

  const decoded = decodeTextBuffer(fs.readFileSync(readPath));
  return { path: relPath, content: decoded.content, isBinary: false, size: stat.size, mimeType: mime, encoding: decoded.encoding };
}

/** 小预览同轮完成避免线程池排队；超过64KB后异步有界读取，保持原编码与截断合同。 */
export async function readFileAsync(workspacePath: string, relPath: string, maxBytes?: number | null): Promise<FsReadFileResponseBody> {
  const abs = resolveWorkspacePath(workspacePath, relPath);
  const readPath = resolveWorkspaceReadPath(workspacePath, relPath);
  const limit = Math.min(Math.max(Number(maxBytes) || DEFAULT_MAX_BYTES, 1024), 5 * 1024 * 1024);
  const stat = readFileStat(readPath, relPath);
  if (!stat.isFile()) throw new Error(`不是文件：${relPath}`);
  if (stat.size <= 64 * 1024) return readFile(workspacePath, relPath, maxBytes);
  const image = isImageFile(abs), binary = isBinaryFile(abs), mimeType = getMimeType(abs);
  if (binary && !image || image && stat.size > 5 * 1024 * 1024) return { path: relPath, content: null, isBinary: true, size: stat.size, mimeType };
  resolveWorkspaceReadPath(workspacePath, relPath);
  const file = await fsp.open(readPath, "r");
  let failure: { error: unknown } | undefined;
  try {
    const opened = await file.stat();
    if (resolveWorkspaceReadPath(workspacePath, relPath) !== readPath || !opened.isFile() || opened.ino !== stat.ino
      || opened.dev !== stat.dev && opened.dev !== 0 && stat.dev !== 0) {
      throw Object.assign(new Error("文件预览目标在打开期间已变化"), { code: "FILE_TRANSFER_PATH_INVALID" });
    }
    const bytes = Buffer.alloc(Math.min(stat.size, image ? 5 * 1024 * 1024 : limit));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const content = bytes.subarray(0, offset);
    if (image) return { path: relPath, content: null, isBinary: true, size: stat.size, base64: content.toString("base64"), mimeType };
    const decoded = decodeTextBuffer(content, { allowPartialTail: stat.size > limit });
    return { path: relPath, content: decoded.content + (stat.size > limit ? "\n…(文件过大，已截断)" : ""), isBinary: false, size: stat.size, mimeType, encoding: decoded.encoding };
  } catch (error) { failure = { error }; throw error; }
  finally {
    try { await file.close(); }
    catch (error) { if (failure) throw new AggregateError([failure.error, error], "FS_PREVIEW_READ_CLOSE_FAILED", { cause: failure.error }); throw error; }
  }
}

/** 返回工作区内真实文件的下载字节，沿原 RPC 传输 base64。 */
export function readFileForDownload(workspacePath: string, relPath: string): FsDownloadFileResponseBody {
  const abs = resolveWorkspaceReadPath(workspacePath, relPath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (error) {
    throw new Error(`无法读取文件信息：${relPath}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (!stat.isFile()) throw new Error(`不是文件：${relPath}`);
  if (stat.size > DOWNLOAD_MAX_BYTES) {
    throw new Error(`文件过大，无法下载：${relPath}（最大 ${formatBytes(DOWNLOAD_MAX_BYTES)}）`);
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(abs);
  } catch (error) {
    throw new Error(`无法读取文件：${relPath}（${error instanceof Error ? error.message : String(error)}）`);
  }

  return {
    path: relPath,
    fileName: relPath.split(/[\\/]/).filter(Boolean).pop() ?? "download",
    size: stat.size,
    mimeType: getMimeType(abs),
    base64: buffer.toString("base64"),
  };
}

/** 初始化单文件上传会话，先写入工作区内临时文件，complete 后再原子替换目标文件。 */
export function beginUpload(
  workspacePath: string,
  input: {
    targetDir?: string | null;
    fileName: string;
    sizeBytes: number;
    mimeType?: string | null;
    overwrite?: boolean | null;
  },
): FsUploadBeginResponseBody {
  const targetDir = normalizeTransferRelPath(input.targetDir ?? "", true);
  const fileName = normalizeTransferFileName(input.fileName);
  const finalRelPath = joinWorkspaceSearchPath(targetDir, fileName);
  const finalPath = resolveWorkspacePath(workspacePath, finalRelPath);
  const parentDir = resolveWorkspacePath(workspacePath, targetDir);
  const sizeBytes = normalizeTransferSize(input.sizeBytes);
  const overwrite = input.overwrite === true;

  const parentStat = fs.existsSync(parentDir) ? fs.statSync(parentDir) : null;
  if (!parentStat || !parentStat.isDirectory()) throw new Error(`上传目录不存在：${targetDir || "."}`);
  if (!overwrite && fs.existsSync(finalPath)) throw Object.assign(new Error(`文件已存在：${finalRelPath}`), { code: "FILE_ALREADY_EXISTS" });

  const tempDir = path.join(parentDir, ".codeflow-transfer-tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const uploadId = randomUUID();
  const tempPath = path.join(tempDir, `${uploadId}.part`);
  fs.closeSync(fs.openSync(tempPath, "wx"));
  uploadSessions.set(uploadId, {
    uploadId,
    workspacePath,
    targetDir,
    fileName,
    finalPath,
    tempPath,
    sizeBytes,
    receivedBytes: 0,
    mimeType: String(input.mimeType ?? "").trim() || null,
    overwrite,
    createdAt: Date.now(),
  });
  return { uploadId, path: finalRelPath, chunkSizeBytes: TRANSFER_UPLOAD_CHUNK_SIZE };
}

/** 写入上传分片，offset 必须严格等于已接收字节数，避免乱序覆盖。 */
export function writeUploadChunk(input: { uploadId: string; offset: number; base64: string }): FsUploadChunkResponseBody {
  const session = requireUploadSession(input.uploadId);
  const offset = normalizeTransferSize(input.offset);
  if (offset !== session.receivedBytes) throw new Error(`上传分片 offset 不连续：${offset} != ${session.receivedBytes}`);
  const buffer = Buffer.from(String(input.base64 ?? ""), "base64");
  if (session.receivedBytes + buffer.length > session.sizeBytes) throw new Error("上传内容超过声明大小");
  fs.appendFileSync(session.tempPath, buffer);
  session.receivedBytes += buffer.length;
  return { uploadId: session.uploadId, receivedBytes: session.receivedBytes };
}

/** 完成上传并把临时文件移动到目标路径，失败会保留临时文件供 cancel 清理。 */
export function completeUpload(uploadId: string): FsUploadCompleteInternalResult {
  const session = requireUploadSession(uploadId);
  if (session.receivedBytes !== session.sizeBytes) throw new Error(`上传内容大小不一致：${session.receivedBytes}/${session.sizeBytes}`);
  if (!session.overwrite && fs.existsSync(session.finalPath)) throw Object.assign(new Error(`文件已存在：${session.fileName}`), { code: "FILE_ALREADY_EXISTS" });
  fs.renameSync(session.tempPath, session.finalPath);
  uploadSessions.delete(uploadId);
  return {
    path: joinWorkspaceSearchPath(session.targetDir, session.fileName),
    fileName: session.fileName,
    size: session.sizeBytes,
    mimeType: session.mimeType ?? getMimeType(session.finalPath),
    workspacePath: session.workspacePath,
  };
}

/** 取消上传并删除临时文件；若临时文件清理失败则显式抛错。 */
export function cancelUpload(uploadId: string): { uploadId: string; cancelled: true } {
  const session = uploadSessions.get(String(uploadId ?? "").trim());
  if (!session) return { uploadId, cancelled: true };
  try {
    if (fs.existsSync(session.tempPath)) fs.unlinkSync(session.tempPath);
  } catch (error) {
    throw new Error(`清理上传临时文件失败：${session.tempPath}（${error instanceof Error ? error.message : String(error)}）`);
  } finally {
    uploadSessions.delete(session.uploadId);
  }
  return { uploadId: session.uploadId, cancelled: true };
}

/** 获取工作区内真实下载目标的元数据，不读取正文。 */
export function statFileForDownload(workspacePath: string, relPath: string): FsDownloadStatResponseBody {
  const normalizedPath = normalizeTransferRelPath(relPath, false);
  const abs = resolveWorkspaceReadPath(workspacePath, normalizedPath);
  const stat = readFileStat(abs, normalizedPath);
  if (!stat.isFile()) throw new Error(`不是文件：${normalizedPath}`);
  return {
    path: normalizedPath,
    fileName: normalizedPath.split(/[\\/]/).filter(Boolean).pop() ?? "download",
    size: stat.size,
    mimeType: getMimeType(abs),
  };
}

/** 每个下载分片重新校验真实目标，再按 offset/length 读取。 */
export function readFileChunkForDownload(
  workspacePath: string,
  input: { path: string; offset: number; length: number },
): FsDownloadChunkResponseBody {
  const normalizedPath = normalizeTransferRelPath(input.path, false);
  const abs = resolveWorkspaceReadPath(workspacePath, normalizedPath);
  const stat = readFileStat(abs, normalizedPath);
  if (!stat.isFile()) throw new Error(`不是文件：${normalizedPath}`);
  const offset = normalizeTransferSize(input.offset);
  const length = Math.min(Math.max(normalizeTransferSize(input.length), 1), TRANSFER_UPLOAD_CHUNK_SIZE);
  if (offset > stat.size) throw new Error(`下载 offset 超出文件大小：${offset}/${stat.size}`);
  const fd = fs.openSync(abs, "r");
  try {
    const buffer = Buffer.alloc(Math.min(length, Math.max(0, stat.size - offset)));
    const bytesRead = buffer.length ? fs.readSync(fd, buffer, 0, buffer.length, offset) : 0;
    return {
      path: normalizedPath,
      offset,
      bytesRead,
      base64: buffer.subarray(0, bytesRead).toString("base64"),
      done: offset + bytesRead >= stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 读取已校验真实目标的表格预览；只返回指定行列范围。
 */
export function readSpreadsheetPreview(
  workspacePath: string,
  relPath: string,
  opts?: { sheetName?: string | null; maxRows?: number | null; maxColumns?: number | null },
): FsSpreadsheetPreviewResponseBody {
  const abs = resolveWorkspacePath(workspacePath, relPath);
  const readPath = resolveWorkspaceReadPath(workspacePath, relPath);
  const maxRows = clampPreviewLimit(opts?.maxRows, SPREADSHEET_DEFAULT_MAX_ROWS, 1, 1000);
  const maxColumns = clampPreviewLimit(opts?.maxColumns, SPREADSHEET_DEFAULT_MAX_COLUMNS, 1, 200);

  if (!isSpreadsheetFile(abs)) throw new Error(`不是支持的表格文件：${relPath}`);

  const stat = readFileStat(readPath, relPath);
  if (!stat.isFile()) throw new Error(`不是文件：${relPath}`);
  if (stat.size > SPREADSHEET_MAX_BYTES) {
    throw new Error(`表格文件过大，无法预览：${relPath}（最大 ${formatBytes(SPREADSHEET_MAX_BYTES)}）`);
  }

  const workbook = XLSX.read(fs.readFileSync(readPath), { type: "buffer", cellDates: true });
  const sheets = workbook.SheetNames.map((name) => {
    const stats = getWorksheetStats(workbook.Sheets[name]);
    return { name, rowCount: stats.rowCount, columnCount: stats.columnCount };
  });
  if (!sheets.length) throw new Error(`表格文件没有可读取的工作表：${relPath}`);

  const requestedSheet = String(opts?.sheetName ?? "").trim();
  const sheetName = requestedSheet || sheets[0]!.name;
  if (!workbook.Sheets[sheetName]) {
    throw new Error(`工作表不存在：${sheetName}`);
  }

  const sheet = workbook.Sheets[sheetName]!;
  const stats = getWorksheetStats(sheet);
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: null,
    blankrows: false,
  }) as unknown[][];
  const inferredColumnCount = Math.max(stats.columnCount, ...rawRows.map((row) => Array.isArray(row) ? row.length : 0), 0);
  const columnCount = Math.min(inferredColumnCount, maxColumns);
  const rows = rawRows.slice(0, maxRows).map((row) => normalizeSpreadsheetRow(row, columnCount));
  const truncatedColumns = inferredColumnCount > maxColumns || rawRows.some((row) => Array.isArray(row) && row.length > maxColumns);

  return {
    path: relPath,
    size: stat.size,
    mimeType: getMimeType(abs),
    sheetName,
    sheets,
    rows,
    rowCount: Math.max(stats.rowCount, rawRows.length),
    columnCount,
    maxRows,
    maxColumns,
    truncatedRows: rawRows.length > maxRows || stats.rowCount > maxRows,
    truncatedColumns,
  };
}

/**
 * 读取真实工作区内 PDF / Word / PPTX 的受限预览数据。
 * - PDF 返回 base64，供浏览器原生 PDF viewer 展示
 * - DOCX 返回简化 HTML，不支持旧版 .doc 二进制格式
 * - PPTX 返回 base64，供浏览器端演示文稿渲染器展示
 */
export function readDocumentPreview(workspacePath: string, relPath: string): FsDocumentPreviewResponseBody {
  const abs = resolveWorkspacePath(workspacePath, relPath);
  const readPath = resolveWorkspaceReadPath(workspacePath, relPath);
  if (!isDocumentPreviewFile(abs)) throw new Error(`不是支持的文档文件：${relPath}`);

  const stat = readFileStat(readPath, relPath);
  if (!stat.isFile()) throw new Error(`不是文件：${relPath}`);
  if (stat.size > DOCUMENT_PREVIEW_MAX_BYTES) {
    throw new Error(`文档文件过大，无法预览：${relPath}（最大 ${formatBytes(DOCUMENT_PREVIEW_MAX_BYTES)}）`);
  }

  const ext = path.extname(abs).replace(/^\./, "").toLowerCase();
  const mimeType = getMimeType(abs);
  const fileBuffer = fs.readFileSync(readPath);
  if (ext === "pdf") {
    return {
      path: relPath,
      size: stat.size,
      mimeType,
      kind: "pdf",
      base64: fileBuffer.toString("base64"),
    };
  }
  if (ext === "pptx") {
    return {
      path: relPath,
      size: stat.size,
      mimeType,
      kind: "presentation",
      base64: fileBuffer.toString("base64"),
    };
  }
  if (ext === "docx") {
    const word = buildDocxHtml(fileBuffer);
    return {
      path: relPath,
      size: stat.size,
      mimeType,
      kind: "word",
      content: word.html,
      truncated: word.truncated,
    };
  }
  throw new Error(`暂不支持该文档格式预览：${relPath}`);
}

/** 约束表格预览行列参数，避免一次性解析出过大的响应。 */
function clampPreviewLimit(value: number | null | undefined, fallback: number, min: number, max: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** 读取 worksheet 的声明范围；空表返回 0 行 0 列。 */
function getWorksheetStats(sheet: XLSX.WorkSheet | undefined): { rowCount: number; columnCount: number } {
  const ref = sheet?.["!ref"];
  if (!ref) return { rowCount: 0, columnCount: 0 };
  const range = XLSX.utils.decode_range(ref);
  return {
    rowCount: Math.max(range.e.r - range.s.r + 1, 0),
    columnCount: Math.max(range.e.c - range.s.c + 1, 0),
  };
}

/** 把 SheetJS 单元格值规整成前端表格可直接渲染的基础类型。 */
function normalizeSpreadsheetCell(value: unknown): FsSpreadsheetCellValue {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** 固定每行列数，保证前端表格列宽和表头稳定。 */
function normalizeSpreadsheetRow(row: unknown[], columnCount: number): FsSpreadsheetCellValue[] {
  const source = Array.isArray(row) ? row : [];
  return Array.from({ length: columnCount }, (_, index) => normalizeSpreadsheetCell(source[index]));
}

/** 从 DOCX 包中读取正文 XML 并转换为简化 HTML。 */
function buildDocxHtml(buffer: Buffer): { html: string; truncated: boolean } {
  const documentXml = readZipEntry(buffer, "word/document.xml").toString("utf8");
  return wordDocumentXmlToHtml(documentXml);
}

type WordPreviewBuildState = {
  parts: string[];
  total: number;
  truncated: boolean;
};

type WordBlockRef = {
  kind: "p" | "tbl";
  start: number;
};

/** 把 WordprocessingML 正文转换为只含白名单标签和转义文本的安全 HTML。 */
function wordDocumentXmlToHtml(xml: string): { html: string; truncated: boolean } {
  const bodyXml = extractWordBodyXml(xml);
  const state: WordPreviewBuildState = { parts: [], total: 0, truncated: false };
  for (const block of renderWordBlocks(bodyXml)) {
    appendWordPreviewBlock(state, block);
    if (state.truncated) break;
  }
  if (state.truncated) state.parts.push("<p>…(文档内容过大，已截断)</p>");
  return { html: state.parts.join("\n") || "<p>文档没有可预览文本内容。</p>", truncated: state.truncated };
}

/** 截取 DOCX 正文部分，避免页属性等非正文节点参与预览。 */
function extractWordBodyXml(xml: string): string {
  const bodyMatch = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/);
  return bodyMatch?.[1] ?? xml;
}

/** 渲染一段 WordprocessingML 块级内容，保留段落和表格结构。 */
function renderWordBlocks(xml: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  for (let next = findNextWordBlock(xml, cursor); next; next = findNextWordBlock(xml, cursor)) {
    const end = findMatchingWordTagEnd(xml, next.kind, next.start);
    const blockXml = xml.slice(next.start, end);
    cursor = end;
    const html = next.kind === "p" ? renderWordParagraph(blockXml) : renderWordTable(blockXml);
    if (html) blocks.push(html);
  }
  return blocks;
}

/** 查找下一个段落或表格起点；调用方负责按匹配标签跳过内部节点。 */
function findNextWordBlock(xml: string, fromIndex: number): WordBlockRef | null {
  const re = /<w:(p|tbl)\b[^>]*>/g;
  re.lastIndex = fromIndex;
  const match = re.exec(xml);
  if (!match?.[1]) return null;
  return { kind: match[1] === "tbl" ? "tbl" : "p", start: match.index };
}

/** 查找指定 Word 标签的结束位置，支持表格嵌套。 */
function findMatchingWordTagEnd(xml: string, tagName: "p" | "tbl" | "tr" | "tc", startIndex: number): number {
  const re = new RegExp(`<\\/?w:${tagName}\\b[^>]*>`, "g");
  re.lastIndex = startIndex;
  let depth = 0;
  for (let match = re.exec(xml); match; match = re.exec(xml)) {
    const token = match[0];
    if (token.startsWith("</")) {
      depth -= 1;
      if (depth === 0) return re.lastIndex;
    } else if (token.endsWith("/>")) {
      if (depth === 0) return re.lastIndex;
    } else {
      depth += 1;
    }
  }
  throw new Error(`DOCX 标签结构不完整：w:${tagName}`);
}

/** 渲染 Word 段落，只输出安全文本和换行。 */
function renderWordParagraph(xml: string): string {
  const content = renderWordInlineContent(xml).trim();
  return content ? `<p>${content}</p>` : "";
}

/** 渲染 Word 表格，保留行、单元格和基础 colspan。 */
function renderWordTable(xml: string): string {
  const rows: string[] = [];
  let cursor = 0;
  for (let start = findNextWordTag(xml, "tr", cursor); start >= 0; start = findNextWordTag(xml, "tr", cursor)) {
    const end = findMatchingWordTagEnd(xml, "tr", start);
    const row = renderWordTableRow(xml.slice(start, end));
    cursor = end;
    if (row) rows.push(row);
  }
  return rows.length ? `<table><tbody>${rows.join("")}</tbody></table>` : "";
}

/** 渲染 Word 表格行。 */
function renderWordTableRow(xml: string): string {
  const cells: string[] = [];
  let cursor = 0;
  for (let start = findNextWordTag(xml, "tc", cursor); start >= 0; start = findNextWordTag(xml, "tc", cursor)) {
    const end = findMatchingWordTagEnd(xml, "tc", start);
    cells.push(renderWordTableCell(xml.slice(start, end)));
    cursor = end;
  }
  return cells.length ? `<tr>${cells.join("")}</tr>` : "";
}

/** 渲染 Word 表格单元格；空单元格保留占位，避免列结构塌陷。 */
function renderWordTableCell(xml: string): string {
  const colspan = readWordGridSpan(xml);
  const content = renderWordBlocks(xml).join("") || renderWordInlineContent(xml).trim() || "&nbsp;";
  return `<td${colspan > 1 ? ` colspan="${colspan}"` : ""}>${content}</td>`;
}

/** 查找下一个指定 Word 标签。 */
function findNextWordTag(xml: string, tagName: "tr" | "tc", fromIndex: number): number {
  const re = new RegExp(`<w:${tagName}\\b[^>]*>`, "g");
  re.lastIndex = fromIndex;
  const match = re.exec(xml);
  return match?.index ?? -1;
}

/** 读取 Word 表格单元格横向合并数量。 */
function readWordGridSpan(xml: string): number {
  const match = xml.match(/<w:gridSpan\b[^>]*\bw:val="(\d+)"/);
  const parsed = Number(match?.[1]);
  return Number.isFinite(parsed) && parsed > 1 ? Math.min(Math.floor(parsed), 100) : 1;
}

/** 渲染段落内文本 token，避免把文档内容当作 HTML 执行。 */
function renderWordInlineContent(xml: string): string {
  let content = "";
  const tokenRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
  for (let match = tokenRe.exec(xml); match; match = tokenRe.exec(xml)) {
    if (match[1] != null) {
      content += escapeHtml(decodeXmlEntities(match[1]));
    } else if (match[0].startsWith("<w:tab")) {
      content += "    ";
    } else {
      content += "<br>";
    }
  }
  return content;
}

/** 追加预览 HTML 块并执行总体大小限制。 */
function appendWordPreviewBlock(state: WordPreviewBuildState, html: string): void {
  if (!html || state.truncated) return;
  const remaining = WORD_PREVIEW_MAX_HTML_CHARS - state.total;
  if (html.length > remaining) {
    state.truncated = true;
    return;
  }
  state.parts.push(html);
  state.total += html.length;
}

/** 读取 DOCX ZIP 内指定文件；仅支持普通 store/deflate 条目。 */
function readZipEntry(buffer: Buffer, entryName: string): Buffer {
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  const centralDirectorySize = readUInt32LE(buffer, eocdOffset + 12, "central directory size");
  const centralDirectoryOffset = readUInt32LE(buffer, eocdOffset + 16, "central directory offset");
  const end = centralDirectoryOffset + centralDirectorySize;
  if (end > buffer.length) throw new Error("DOCX 中央目录越界");

  let cursor = centralDirectoryOffset;
  while (cursor < end) {
    if (readUInt32LE(buffer, cursor, "central directory signature") !== 0x02014b50) {
      throw new Error("DOCX 中央目录结构不正确");
    }
    const compressionMethod = readUInt16LE(buffer, cursor + 10, "compression method");
    const compressedSize = readUInt32LE(buffer, cursor + 20, "compressed size");
    const fileNameLength = readUInt16LE(buffer, cursor + 28, "file name length");
    const extraLength = readUInt16LE(buffer, cursor + 30, "extra field length");
    const commentLength = readUInt16LE(buffer, cursor + 32, "file comment length");
    const localHeaderOffset = readUInt32LE(buffer, cursor + 42, "local header offset");
    const nameStart = cursor + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > buffer.length) throw new Error("DOCX 条目名称越界");
    const name = buffer.toString("utf8", nameStart, nameEnd);
    if (name === entryName) {
      return readZipLocalEntry(buffer, { compressionMethod, compressedSize, localHeaderOffset });
    }
    cursor = nameEnd + extraLength + commentLength;
  }
  throw new Error(`DOCX 缺少必要文件：${entryName}`);
}

/** 根据本地文件头读取 ZIP 条目内容。 */
function readZipLocalEntry(
  buffer: Buffer,
  entry: { compressionMethod: number; compressedSize: number; localHeaderOffset: number },
): Buffer {
  const offset = entry.localHeaderOffset;
  if (readUInt32LE(buffer, offset, "local file signature") !== 0x04034b50) {
    throw new Error("DOCX 本地文件头结构不正确");
  }
  const fileNameLength = readUInt16LE(buffer, offset + 26, "local file name length");
  const extraLength = readUInt16LE(buffer, offset + 28, "local extra field length");
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new Error("DOCX 条目数据越界");
  const compressed = buffer.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod === 8) return inflateRawSync(compressed);
  throw new Error(`DOCX 使用了不支持的压缩方式：${entry.compressionMethod}`);
}

/** 查找 ZIP EOCD 记录，避免依赖外部解压库。 */
function findZipEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("不是有效的 DOCX ZIP 文件");
}

/** 带边界检查读取 uint16。 */
function readUInt16LE(buffer: Buffer, offset: number, label: string): number {
  if (offset < 0 || offset + 2 > buffer.length) throw new Error(`DOCX 读取越界：${label}`);
  return buffer.readUInt16LE(offset);
}

/** 带边界检查读取 uint32。 */
function readUInt32LE(buffer: Buffer, offset: number, label: string): number {
  if (offset < 0 || offset + 4 > buffer.length) throw new Error(`DOCX 读取越界：${label}`);
  return buffer.readUInt32LE(offset);
}

/** 解码 Word XML 文本实体。 */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 转义 HTML，确保 Word 预览不会执行文档内 HTML。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 展示文件大小，用于错误信息。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 读取工作区内真实目标元信息；仅文件缺失返回 exists=false。
 */
export function statPath(workspacePath: string, relPath: string): { path: string; isDir: boolean; size: number; mtime: string; exists: boolean } {
  const abs = resolveWorkspaceReadPath(workspacePath, relPath, true);
  try {
    const stat = fs.statSync(abs);
    return {
      path: relPath,
      isDir: stat.isDirectory(),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      exists: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { path: relPath, isDir: false, size: 0, mtime: "", exists: false };
  }
}

/**
 * 列出目标 Client 本机目录树。
 * @param dirPath 目标 Client 上的绝对目录路径；空表示列出可选根目录
 * @param depth 兼容参数；当前目录选择器始终按 1 层懒加载
 * @param showHidden 是否展示名称以 "." 开头的目录
 */
export function listClientDirectoryTree(dirPath: string | null | undefined, depth: number, showHidden = false): ClientDirectoryNode[] {
  const normalizedDirPath = String(dirPath ?? "").trim();
  if (!normalizedDirPath) return listClientDirectoryRoots();

  const absDir = resolveClientAbsoluteDirectory(normalizedDirPath);
  const maxDepth = 1;
  return walkClientDirectory(absDir, 0, maxDepth, createVisitedDirs(absDir, absDir), showHidden);
}

/** RPC 根目录以8路异步探测盘符；普通目录沿一层懒加载，缺失根与真实读错误分开处理。 */
export async function listClientDirectoryTreeAsync(dirPath: string | null | undefined, depth: number, showHidden = false): Promise<ClientDirectoryNode[]> {
  if (String(dirPath ?? "").trim()) return listClientDirectoryTree(dirPath, depth, showHidden);
  const candidates = [{ name: "用户目录", path: os.homedir() }, ...(process.platform === "win32"
    ? Array.from({ length: 26 }, (_, index) => { const root = `${String.fromCharCode(65 + index)}:\\`; return { name: root, path: root }; })
    : [{ name: "根目录", path: "/" }])];
  const roots = new Map<string, ClientDirectoryNode>();
  for (let cursor = 0; cursor < candidates.length; cursor += 8) {
    const settled = await Promise.allSettled(candidates.slice(cursor, cursor + 8).map(async candidate => {
      const target = path.resolve(candidate.path);
      // 保留原目录选择器的可访问根探测合同；类型读取失败仍明确拒绝。
      if (!await new Promise<boolean>(resolve => fs.exists(target, resolve))) return null;
      const stat = await fsp.stat(target);
      return stat.isDirectory() ? { name: candidate.name, path: target, isDir: true as const } : null;
    }));
    const errors = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected").map(item => item.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "FS_DIRECTORY_ROOTS_FAILED", { cause: errors[0] });
    for (const item of settled) if (item.status === "fulfilled" && item.value && !roots.has(item.value.path)) roots.set(item.value.path, item.value);
  }
  return [...roots.values()];
}

/** 列出当前 Client 上可作为浏览入口的根目录。 */
function listClientDirectoryRoots(): ClientDirectoryNode[] {
  const roots = new Map<string, ClientDirectoryNode>();
  addClientRoot(roots, "用户目录", os.homedir());

  if (process.platform === "win32") {
    for (const driveRoot of listWindowsDriveRoots()) {
      addClientRoot(roots, driveRoot, driveRoot);
    }
  } else {
    addClientRoot(roots, "根目录", "/");
  }

  return Array.from(roots.values());
}

/** 归一化 Windows 盘符环境变量，避免刷新根目录时扫描所有盘符。 */
function normalizeWindowsDriveRoot(rawPath: string | undefined): string {
  const value = String(rawPath ?? "").trim();
  const match = value.match(/^([a-zA-Z]):[\\/]*$/);
  return match ? `${match[1]!.toUpperCase()}:\\` : value;
}

/** 枚举 Windows 可访问盘符根目录，用盘符作为目录选择入口。 */
function listWindowsDriveRoots(): string[] {
  const roots: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const driveRoot = normalizeWindowsDriveRoot(`${String.fromCharCode(code)}:\\`);
    if (fs.existsSync(driveRoot)) roots.push(driveRoot);
  }
  return roots;
}

/** 将一个候选根目录加入结果；不存在的盘符会自然跳过。 */
function addClientRoot(roots: Map<string, ClientDirectoryNode>, name: string, rawPath: string): void {
  const rootPath = String(rawPath ?? "").trim();
  if (!rootPath) return;
  const resolved = path.resolve(rootPath);
  if (!path.isAbsolute(resolved) || !fs.existsSync(resolved)) return;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new Error(`无法读取目录：${rootPath}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (!stat.isDirectory() || roots.has(resolved)) return;
  roots.set(resolved, { name, path: resolved, isDir: true });
}

/** 校验并解析目标 Client 上的绝对目录路径。 */
function resolveClientAbsoluteDirectory(rawPath: string): string {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) throw Object.assign(new Error("目录路径不能为空"), { code: "FILE_TRANSFER_PATH_INVALID" });
  if (!path.isAbsolute(trimmed)) {
    throw Object.assign(new Error(`目录路径必须是目标 Client 上的绝对路径：${rawPath}`), { code: "FILE_TRANSFER_PATH_INVALID" });
  }

  const abs = path.resolve(trimmed);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (error) {
    throw Object.assign(new Error(`目录不存在：${rawPath}（${error instanceof Error ? error.message : String(error)}）`, { cause: error }),
      { code: (error as NodeJS.ErrnoException).code });
  }
  if (!stat.isDirectory()) throw Object.assign(new Error(`不是目录：${rawPath}`), { code: "ENOTDIR" });
  return abs;
}

/** 列出有界本机目录节点；读取失败保留 errno 供 RPC 分类。 */
function walkClientDirectory(dirAbs: string, currentDepth: number, maxDepth: number, visitedDirs: Set<string>, showHidden: boolean): ClientDirectoryNode[] {
  if (currentDepth >= maxDepth) return [];

  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(dirAbs);
  } catch (error) {
    throw Object.assign(new Error(`无法读取目录：${dirAbs}（${error instanceof Error ? error.message : String(error)}）`, { cause: error }),
      { code: (error as NodeJS.ErrnoException).code });
  }

  const dirs: ClientDirectoryNode[] = [];
  try {
    for (;;) {
      let entry: fs.Dirent | null;
      try {
        entry = dir.readSync();
      } catch (error) {
        throw Object.assign(new Error(`无法读取目录：${dirAbs}（${error instanceof Error ? error.message : String(error)}）`, { cause: error }),
          { code: (error as NodeJS.ErrnoException).code });
      }
      if (!entry) break;
      if (!shouldIncludeClientDirectoryEntry(dirAbs, entry.name, showHidden)) continue;
      const abs = path.join(dirAbs, entry.name);
      if (!resolveClientDirentIsDirectory(entry)) continue;

      let children: ClientDirectoryNode[] | undefined;
      if (currentDepth + 1 < maxDepth) {
        const nextVisited = createChildVisitedDirs(visitedDirs, abs, abs);
        children = nextVisited ? walkClientDirectory(abs, currentDepth + 1, maxDepth, nextVisited, showHidden) : [];
      }

      if (dirs.length >= CLIENT_DIRECTORY_MAX_CHILDREN) {
        throw new Error(`目录子目录过多：${dirAbs}（超过 ${CLIENT_DIRECTORY_MAX_CHILDREN} 个），请手动输入更精确路径`);
      }
      dirs.push({
        name: entry.name,
        path: abs,
        isDir: true,
        isLeaf: children ? children.length === 0 : undefined,
        children,
      });
    }
  } finally {
    dir.closeSync();
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return dirs;
}

/** 判断目录项是否为可选择目录；目录选择器不跟随 symlink，避免跨请求环路。 */
function resolveClientDirentIsDirectory(entry: fs.Dirent): boolean {
  return entry.isDirectory() && !entry.isSymbolicLink();
}

