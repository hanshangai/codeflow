import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { simpleGit, type SimpleGit } from "simple-git";
import { parsePatch, type StructuredPatch } from "diff";
import type {
  GitStatusResult,
  GitLogEntry,
  GitBranchInfo,
  GitFileStatus,
  GitFileStat,
  GitRepositoryInfo,
} from "@codeflowai/shared";
import { resolveWorkspacePath, resolveWorkspaceReadPath } from "../fs/fsHelpers.js";
import { decodeTextBuffer } from "../fs/textEncoding.js";
import { logger } from "../logger.js";

type ResolvedGitRepository = GitRepositoryInfo & { absPath: string; isDetectedRepo: boolean };

export type GitCommitAttributionFile = {
  path: string;
  previousPath: string | null;
  changeType: "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed";
  isBinary: boolean;
  addedLines: string[];
  commitEvidenceSha256: string;
};

export type GitCommitAttributionSnapshot = {
  repositoryPath: string;
  repository: string;
  commitSha: string;
  parentShas: string[];
  committedAt: number;
  commitEvidenceSha256: string;
  files: GitCommitAttributionFile[];
};

export type GitCommitRetentionObservation =
  | {
    status: "complete";
    observationRef: string;
    targetCommitLines: string[];
    evidenceSha256: string;
  }
  | {
    status: "unavailable";
    observationRef: string | null;
    reason: "history_rewritten" | "retention_observation_missing";
  };

type RawCommitChange = {
  path: string;
  previousPath: string | null;
  status: string;
  isNonTextMode: boolean;
  changeType: GitCommitAttributionFile["changeType"];
};

const GIT_REPOSITORY_SCAN_MAX_DEPTH = 4;
const GIT_REPOSITORY_SCAN_CONCURRENCY = 8;
const GIT_REPOSITORY_DISCOVERY_TTL_MS = 30_000;
const GIT_REPOSITORY_DISCOVERY_CACHE_MAX = 32;
const GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_FILE_STAT_CONCURRENCY = 64;
const GIT_PROCESS_TREE_TERMINATION_TIMEOUT_MS = 5_000;
const GIT_REPOSITORY_SCAN_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".pnpm",
  ".cache",
  ".turbo",
  ".vite",
  "dist",
  "build",
  "coverage",
]);
type GitStatusMetadataFailure = { path: string; reason: unknown };
type GitStatusRead = { result: PromiseSettledResult<GitStatusResult>; metadataFailures: GitStatusMetadataFailure[] };
export type GitStatusLogContext = {
  workspaceId: string; requestId: string; clientId: string; method: string;
  writeWorkspaceLog(entry: { level: "warn"; tag: string; message: string; data: Record<string, unknown> }): void | Promise<void>;
};
const gitStatusInFlight = new Map<string, Promise<GitStatusRead>>();
const gitMutationGenerationByWorkspace = new Map<string, number>();
const gitRepositoryDiscoveryInFlight = new Map<string, Promise<GitRepositoryInfo[]>>();
const gitRepositoryDiscoveryCache = new Map<string, { expiresAt: number; repositories: GitRepositoryInfo[] }>();
const gitCommitCounts = new Map<string, Promise<number>>();

/** 表示 Git 子进程正常退出但返回非 0，调用方可按 stderr 判断是否为缺失对象。 */
class GitCommandExitError extends Error {
  constructor(message: string, readonly code: number | null, readonly signal: NodeJS.Signals | null) {
    super(message);
    this.name = "GitCommandExitError";
  }
}

/** 为指定 Git 根路径创建 simple-git 实例。 */
function git(gitRootPath: string): SimpleGit {
  return simpleGit(gitRootPath, { trimmed: true });
}

/** 获取 Git 状态；同一仓库代次内只执行一个在途请求。 */
export async function status(workspacePath: string, repositoryPath?: string | null, logContext?: GitStatusLogContext): Promise<GitStatusResult> {
  const workspaceKey = normalizedGitWorkspaceKey(workspacePath);
  const scopeKey = gitStatusScopeKey(workspaceKey, repositoryPath);
  const generation = gitMutationGenerationByWorkspace.get(workspaceKey) ?? 0;
  const requestKey = `${scopeKey}|generation:${generation}`;
  let pending = gitStatusInFlight.get(requestKey);
  if (!pending) {
    const metadataFailures: GitStatusMetadataFailure[] = [];
    const reading = readStatus(workspacePath, repositoryPath, metadataFailures);
    pending = reading.then<GitStatusRead, GitStatusRead>(
      value => ({ result: { status: "fulfilled", value }, metadataFailures }),
      reason => ({ result: { status: "rejected", reason }, metadataFailures }),
    ).finally(() => { if (gitStatusInFlight.get(requestKey) === pending) gitStatusInFlight.delete(requestKey); });
    gitStatusInFlight.set(requestKey, pending);
  }
  const read = await pending;
  if (read.metadataFailures.length) {
    const original = new AggregateError([...read.metadataFailures.map(item => item.reason),
      ...(read.result.status === "rejected" ? [read.result.reason] : [])], "GIT_STATUS_METADATA_READ_FAILED", { cause: read.metadataFailures[0]!.reason });
    try {
      const failures = read.metadataFailures.filter(item => {
        const error = item.reason;
        const code = error !== null && (typeof error === "object" || typeof error === "function") ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
        return !(code && "value" in code && (code.value === "ENOENT" || code.value === "ENOTDIR"));
      });
      if (failures.length) {
        const data = { code: "GIT_STATUS_METADATA_READ_FAILED", errorCode: "GIT_STATUS_METADATA_READ_FAILED",
          event: { category: "git", action: "git.status", outcome: "fail" }, workspacePath: path.resolve(workspacePath),
          failedCount: failures.length, failedSample: failures.slice(0, 8).map(item => ({ path: item.path, reason: describeGitMetadataFailure(item.reason) })),
          ...(logContext ? { workspaceId: logContext.workspaceId, requestId: logContext.requestId, clientId: logContext.clientId, method: logContext.method } : {}) };
        const message = `git 变更文件元信息读取失败 ${failures.length} 条（tag=git-status）`;
        if (logContext) await logContext.writeWorkspaceLog({ level: "warn", tag: "git-status", message, data });
        else logger.warn("git-status", message, data);
      }
    } catch (failure) {
      throw Object.assign(new AggregateError([original, failure], "GIT_STATUS_METADATA_LOG_FAILED", { cause: original }), { code: "GIT_STATUS_METADATA_LOG_FAILED" });
    }
  }
  if (read.result.status === "rejected") throw read.result.reason;
  return read.result.value;
}

/** 元信息日志只读自有字段并使用指纹；未知访问器和正文不进入日志。 */
function describeGitMetadataFailure(error: unknown): Record<string, unknown> {
  const type = error === null ? "null" : typeof error;
  const fields: Record<string, unknown> = {};
  if (error !== null && (type === "object" || type === "function")) {
    for (const key of ["code", "message"]) { const item = Object.getOwnPropertyDescriptor(error, key); if (item && "value" in item) fields[key] = item.value; }
  }
  return { type, code: typeof fields.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(fields.code) ? fields.code : undefined,
    fingerprint: crypto.createHash("sha256").update(typeof fields.message === "string" ? fields.message : type).digest("hex") };
}

/** 读取真实状态及历史缓存条件；缓存发现结果也须复验仓库真实路径。 */
async function readStatus(workspacePath: string, repositoryPath: string | null | undefined, metadataFailures: GitStatusMetadataFailure[]): Promise<GitStatusResult> {
  const repositories = await listRepositories(workspacePath);
  const repo = selectRepository(workspacePath, repositories, repositoryPath, { fallbackOnMissing: true });
  if (!repo) return createEmptyGitStatus(repositories);
  const repoReadPath = resolveWorkspaceReadPath(workspacePath, repo.path);

  const statusOutput = decodeTextBuffer(await runGitBuffer(
    repoReadPath,
    ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"],
  )).content;
  const parsed = parseGitStatusPorcelain(statusOutput, repo.path);
  const fileStats = await readChangedFileStats(workspacePath, [
    ...parsed.staged.map((file) => file.path),
    ...parsed.unstaged.map((file) => file.path),
    ...parsed.untracked,
  ], metadataFailures);
  let headCommit: string | null = null;
  try {
    headCommit = decodeTextBuffer(await runGitBuffer(resolveWorkspaceReadPath(workspacePath, repo.path), ["rev-parse", "--verify", "HEAD"])).content.trim() || null;
  } catch (error) {
    if (!isUnbornHeadError(error)) throw error;
  }

  return {
    isRepo: true,
    repositoryPath: repo.path,
    repositories,
    ...parsed,
    fileStats,
    headCommit,
    historyCacheable: headCommit !== null && await gitHistoryCountKey(repoReadPath, headCommit) !== null,
  };
}

/** 批量读取变更文件元信息；真实路径越界显式失败，stat 降级沿用原边界。 */
async function readChangedFileStats(workspacePath: string, paths: string[], metadataFailures: GitStatusMetadataFailure[]): Promise<Record<string, GitFileStat>> {
  const uniquePaths = [...new Set(paths)];
  if (!uniquePaths.length) return {};
  const workspaceRoot = path.resolve(workspacePath);
  const fileStats: Record<string, GitFileStat> = {};
  const failures: GitStatusMetadataFailure[] = [];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(GIT_FILE_STAT_CONCURRENCY, uniquePaths.length) },
    async () => {
      while (cursor < uniquePaths.length) {
        const index = cursor++, relPath = uniquePaths[index];
        if (relPath === undefined) return;
        const readPath = resolveWorkspaceReadPath(workspaceRoot, relPath, true);
        try {
          const stat = await fs.stat(readPath);
          // 子模块 gitlink 等非普通文件不参与变更列表元信息展示。
          if (!stat.isFile()) continue;
          fileStats[relPath] = { size: stat.size, mtime: stat.mtime.toISOString() };
        } catch (error) {
          // 原值按输入序保留；每个 caller 在保因 try 内判定缺失与生成告警。
          // 降级（已确认）：非缺失类 stat 失败（权限、网络盘超时等）只跳过该条，
          // 影响范围仅限 Git 变更列表该行的 mtime/size 留空，其余条目与整个 status 结果照常返回；
          // 失败会聚合为一条 warn（tag=git-status），不做静默忽略。
          failures[index] = { path: relPath, reason: error };
        }
      }
    },
  );
  const settled = await Promise.allSettled(workers);
  metadataFailures.push(...failures.filter(item => item !== undefined));
  for (const item of settled) if (item.status === "rejected") throw item.reason;
  return fileStats;
}

/** 解析 `git status --porcelain=v1 -z --branch`，保持路径和状态字段与既有 API 一致。 */
function parseGitStatusPorcelain(output: string, repositoryPath: string): Omit<GitStatusResult, "isRepo" | "repositoryPath" | "repositories" | "headCommit"> {
  const records = output.split("\0");
  const header = records[0]?.startsWith("## ") ? records.shift()!.slice(3) : "";
  const branchState = parseGitBranchHeader(header);
  const staged: GitFileStatus[] = [];
  const unstaged: GitFileStatus[] = [];
  const untracked: string[] = [];
  let merging = false;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 3) continue;
    const stagedCode = record[0] ?? " ";
    const workingCode = record[1] ?? " ";
    const filePath = record.slice(3);
    const workspaceFilePath = toWorkspaceGitPath(repositoryPath, filePath);
    if (stagedCode === "?" && workingCode === "?") {
      untracked.push(workspaceFilePath);
      continue;
    }
    if (stagedCode !== " " && stagedCode !== "?") {
      staged.push({ path: workspaceFilePath, index: stagedCode, working: workingCode });
    }
    if (workingCode !== " " && workingCode !== "?") {
      unstaged.push({ path: workspaceFilePath, index: stagedCode, working: workingCode });
    }
    if (isGitConflictStatus(stagedCode, workingCode)) merging = true;
    if (stagedCode === "R" || stagedCode === "C" || workingCode === "R" || workingCode === "C") index += 1;
  }

  return {
    ...branchState,
    staged,
    unstaged,
    untracked,
    merging,
    rebasing: false,
  };
}

/** 从 porcelain 分支头提取当前分支、上游以及 ahead/behind。 */
function parseGitBranchHeader(header: string): Pick<GitStatusResult, "branch" | "tracking" | "ahead" | "behind"> {
  const text = header.trim();
  if (!text) return { branch: null, tracking: null, ahead: 0, behind: 0 };
  const unbornMatch = /^(?:No commits yet on|Initial commit on)\s+(.+)$/.exec(text);
  if (unbornMatch) return { branch: unbornMatch[1]?.trim() || null, tracking: null, ahead: 0, behind: 0 };
  if (text === "HEAD (no branch)" || text.startsWith("HEAD ")) {
    return { branch: null, tracking: null, ahead: 0, behind: 0 };
  }
  const match = /^(.+?)\.\.\.([^\s]+)(?:\s+\[([^\]]+)\])?$/.exec(text);
  if (!match) return { branch: text, tracking: null, ahead: 0, behind: 0 };
  const relation = match[3] ?? "";
  const ahead = Number(/(?:^|,\s*)ahead\s+(\d+)/.exec(relation)?.[1] ?? 0);
  const behind = Number(/(?:^|,\s*)behind\s+(\d+)/.exec(relation)?.[1] ?? 0);
  return {
    branch: match[1]?.trim() || null,
    tracking: match[2]?.trim() || null,
    ahead,
    behind,
  };
}

/** 识别 Git porcelain 的冲突组合。 */
function isGitConflictStatus(stagedCode: string, workingCode: string): boolean {
  return stagedCode === "U" || workingCode === "U" || `${stagedCode}${workingCode}` === "AA" || `${stagedCode}${workingCode}` === "DD";
}

/** 获取文件 diff；仓库和工作树目标须仍位于真实工作区内。 */
export async function diff(workspacePath: string, filePath: string, staged: boolean, repositoryPath?: string | null): Promise<string> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const repoReadPath = resolveWorkspaceReadPath(workspacePath, repo.path);
  const { relPath, absPath } = resolveGitWorkspaceFilePath(workspacePath, repo, filePath);
  resolveWorkspaceReadPath(workspacePath, absPath, true);
  const args = staged ? ["--cached", "--", relPath] : ["--", relPath];
  return await readGitDiffText(repoReadPath, args);
}

/** 获取真实工作区内文件的前后内容；删除文件保留空工作树内容。 */
export async function diffFiles(
  workspacePath: string,
  filePath: string,
  staged: boolean,
  repositoryPath?: string | null,
): Promise<{ original: string; modified: string }> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const repoReadPath = resolveWorkspaceReadPath(workspacePath, repo.path);
  const { relPath, absPath } = resolveGitWorkspaceFilePath(workspacePath, repo, filePath);
  resolveWorkspaceReadPath(workspacePath, absPath, true);

  let original = "";
  let modified = "";

  if (repo.isDetectedRepo) {
    try {
      // 获取 HEAD 中的原始文件内容
      original = await readGitTextObject(repoReadPath, `HEAD:${relPath}`);
    } catch (error) {
      if (!isMissingGitObjectError(error)) throw error;
      // 新文件或 empty repo，original 为空
      original = "";
    }
  }

  if (staged) {
    // staged: modified = 暂存区内容
    if (repo.isDetectedRepo) {
      try {
        modified = await readGitTextObject(resolveWorkspaceReadPath(workspacePath, repo.path), `:${relPath}`);
      } catch (error) {
        if (!isMissingGitObjectError(error)) throw error;
        // 删除的文件，modified 为空
        modified = "";
      }
    }
  } else {
    // working tree: modified = 工作区磁盘文件
    const readPath = resolveWorkspaceReadPath(workspacePath, absPath, true);
    try {
      modified = decodeTextBuffer(await fs.readFile(readPath)).content;
    } catch (error) {
      if (!isFileMissingError(error)) throw error;
      // 被删除的文件
      modified = "";
    }
  }

  return { original, modified };
}

/** Stage 文件 */
export async function stage(workspacePath: string, paths: string[], repositoryPath?: string | null): Promise<void> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const g = git(repo.absPath);
  await g.add(normalizeGitWorkspacePaths(workspacePath, repo, paths));
  advanceGitMutationGeneration(workspacePath);
}

/** Unstage 文件 */
export async function unstage(workspacePath: string, paths: string[], repositoryPath?: string | null): Promise<void> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const g = git(repo.absPath);
  await g.reset(["HEAD", "--", ...normalizeGitWorkspacePaths(workspacePath, repo, paths)]);
  advanceGitMutationGeneration(workspacePath);
}

/** 丢弃文件的工作区更改 */
export async function discard(workspacePath: string, paths: string[], repositoryPath?: string | null): Promise<void> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const g = git(repo.absPath);
  await g.checkout(["--", ...normalizeGitWorkspacePaths(workspacePath, repo, paths)]);
  advanceGitMutationGeneration(workspacePath);
}

/** 提交 */
export async function commit(workspacePath: string, message: string, amend: boolean, repositoryPath?: string | null): Promise<{ hash: string; message: string }> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const g = git(repo.absPath);
  const opts: string[] = amend ? ["--amend"] : [];
  const result = await g.commit(message, opts);
  advanceGitMutationGeneration(workspacePath);
  return {
    hash: result.commit || "",
    message,
  };
}

/** 按固定 HEAD 分页，提交总数只在同一仓库/HEAD 首次读取时统计。 */
export async function log(workspacePath: string, maxCount: number, skip: number, repositoryPath?: string | null, headCommit?: string | null): Promise<{ entries: GitLogEntry[]; total: number }> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const g = git(repo.absPath);
  const head = headCommit ?? decodeTextBuffer(await runGitBuffer(repo.absPath, ["rev-parse", "--verify", "HEAD"])).content.trim();
  if (typeof head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) throw new Error("GIT_HISTORY_HEAD_INVALID");

  const result = await g.log({
    maxCount,
    // skip as string option
    "--skip": skip,
    [head]: null,
    "--": null,
    format: {
      hash: "%H",
      hashShort: "%h",
      message: "%s",
      body: "%b",
      author: "%an",
      authorEmail: "%ae",
      date: "%aI",
      parents: "%P",
      refs: "%D",
    },
  } as any);

  const entries: GitLogEntry[] = result.all.map((e: any) => ({
    hash: e.hash,
    hashShort: e.hashShort,
    message: e.message,
    body: e.body ?? "",
    author: e.author,
    authorEmail: e.authorEmail,
    date: e.date,
    parents: (e.parents ?? "").split(" ").filter(Boolean),
    refs: e.refs ?? "",
  }));

  const countKey = await gitHistoryCountKey(repo.absPath, head);
  let counting = countKey === null ? undefined : gitCommitCounts.get(countKey);
  if (!counting) {
    counting = g.raw(["rev-list", "--count", head, "--"]).then(value => {
      const total = Number(value.trim());
      if (!Number.isSafeInteger(total) || total < 1) throw new Error("GIT_HISTORY_COUNT_INVALID");
      return total;
    }).catch(error => { if (countKey !== null) gitCommitCounts.delete(countKey); throw error; });
    if (countKey !== null) {
      gitCommitCounts.set(countKey, counting);
      if (gitCommitCounts.size > 64) gitCommitCounts.delete(gitCommitCounts.keys().next().value!);
    }
  }
  const total = await counting;
  return { entries, total };
}

/** 只复用普通完整仓库和可指纹化的全局配置；权限等真实错误继续抛出。 */
async function gitHistoryCountKey(repositoryRoot: string, head: string): Promise<string | null> {
  if (Object.keys(process.env).some(key => /^GIT_/i.test(key) && !/^GIT_(?:TRACE.*|OPTIONAL_LOCKS|PAGER|CONFIG_GLOBAL)$/i.test(key))) return null;
  const globalConfig = process.env.GIT_CONFIG_GLOBAL;
  let configFingerprint: [string, string | null] | null = null;
  if (globalConfig !== undefined) {
    if (!globalConfig || !path.isAbsolute(globalConfig)) return null;
    try {
      const config = await fs.lstat(globalConfig);
      if (!config.isFile() || config.isSymbolicLink()) return null;
      const contents = await fs.readFile(globalConfig);
      if (/\[\s*(?:include|includeIf)\b/i.test(contents.toString("utf8"))) return null;
      configFingerprint = [path.resolve(globalConfig), crypto.createHash("sha256").update(contents).digest("hex")];
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      configFingerprint = [path.resolve(globalConfig), null];
    }
  }
  const marker = path.join(repositoryRoot, ".git");
  const directory = await fs.lstat(marker).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!directory?.isDirectory() || directory.isSymbolicLink()) return null;
  for (const relative of ["shallow", "commondir", "info/grafts", "refs/replace"]) {
    try { await fs.lstat(path.join(marker, relative)); return null; }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; }
  }
  try {
    if ((await fs.readFile(path.join(marker, "packed-refs"), "utf8")).includes(" refs/replace/")) return null;
  } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; }
  return JSON.stringify([repositoryRoot, head, directory.dev, directory.ino, configFingerprint]);
}

/** 先读提交元数据；明确请求完整 diff 时才生成整份 patch，旧调用保持原行为。 */
export async function show(workspacePath: string, hash: string, repositoryPath?: string | null, includeDiff = true): Promise<{ entry: GitLogEntry; files: GitFileStatus[]; diff: string; diffLoaded: boolean }> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const g = git(repo.absPath);

  // 获取 commit 信息（使用 raw + %x00 分隔符，避免 from/to range 为空的问题）
  const format = "%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%aI%x00%P%x00%D";
  const rawLog = await g.raw(["log", "-1", `--format=${format}`, hash]);
  const parts = rawLog.trimEnd().split("\0");
  if (!parts[0]) throw new Error(`commit 不存在：${hash}`);

  const entry: GitLogEntry = {
    hash: parts[0] ?? "",
    hashShort: parts[1] ?? "",
    message: parts[2] ?? "",
    body: (parts[3] ?? "").trim(),
    author: parts[4] ?? "",
    authorEmail: parts[5] ?? "",
    date: parts[6] ?? "",
    parents: (parts[7] ?? "").split(" ").filter(Boolean),
    refs: parts[8] ?? "",
  };

  // 获取变更文件列表
  const nameStatusRaw = await g.raw(["diff-tree", "--no-commit-id", "-r", "--name-status", hash]);
  const files: GitFileStatus[] = nameStatusRaw
    .split("\n")
    .filter(Boolean)
    .map((line: string) => {
      const parts = line.split("\t");
      const repoFilePath = parts.length > 2 ? parts[2] ?? "" : parts[1] ?? "";
      return { path: toWorkspaceGitPath(repo.path, repoFilePath), index: parts[0] ?? "", working: " " };
    });

  // 获取 diff
  const diffText = includeDiff ? decodeTextBuffer(await runGitBuffer(repo.absPath, ["diff-tree", "-p", "--no-commit-id", hash])).content : "";

  return { entry, files, diff: diffText, diffLoaded: includeDiff };
}

/** 读取一个权威 Git commit 的脱敏归因输入，不返回 remote 凭据或本地仓库路径。 */
export async function readCommitAttributionSnapshot(
  workspacePath: string,
  commitSha: string,
  repositoryPath?: string | null,
): Promise<GitCommitAttributionSnapshot> {
  const requestedCommitSha = String(commitSha ?? "").trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(requestedCommitSha)) {
    throw new Error("代码归因只接受完整 commit SHA");
  }
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  if (!repo.isDetectedRepo) throw new Error("所选目录不是 Git 仓库");

  const metadataBuffer = await runGitBuffer(repo.absPath, [
    "show",
    "-s",
    "--no-show-signature",
    "--format=%H%x00%P%x00%cI",
    `${requestedCommitSha}^{commit}`,
  ]);
  const metadata = decodeTextBuffer(metadataBuffer).content.trimEnd().split("\0");
  const resolvedCommitSha = String(metadata[0] ?? "").trim().toLowerCase();
  const parentShas = String(metadata[1] ?? "").trim().split(/\s+/u).filter(Boolean).map((item) => item.toLowerCase());
  const committedAt = Date.parse(String(metadata[2] ?? "").trim());
  if (resolvedCommitSha !== requestedCommitSha || !Number.isSafeInteger(committedAt) || committedAt <= 0) {
    throw new Error("Git commit 身份或提交时间无效");
  }
  if (parentShas.some((item) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(item))) {
    throw new Error("Git commit 父提交身份无效");
  }

  const repository = await resolveCanonicalRepositoryKey(repo.absPath, resolvedCommitSha);
  if (parentShas.length > 1) {
    return {
      repositoryPath: repo.path,
      repository,
      commitSha: resolvedCommitSha,
      parentShas,
      committedAt,
      commitEvidenceSha256: sha256Buffers([metadataBuffer]),
      files: [],
    };
  }

  const rawChangesBuffer = await runGitBuffer(repo.absPath, [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "-r",
    "--raw",
    "-z",
    "-M",
    "-C",
    "--find-copies-harder",
    resolvedCommitSha,
  ]);
  const rawChanges = parseRawCommitChanges(rawChangesBuffer);
  const patchBuffer = await runGitBuffer(repo.absPath, [
    "-c",
    "core.quotePath=false",
    "diff-tree",
    "--root",
    "--no-commit-id",
    "-r",
    "-p",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=0",
    "-M",
    "-C",
    "--find-copies-harder",
    resolvedCommitSha,
  ]);
  const patchText = decodeTextBuffer(patchBuffer).content;
  const parsedPatches = patchText.length === 0 ? [] : parsePatch(patchText);
  const files = mapCommitChangesToPatches(rawChanges, parsedPatches);
  return {
    repositoryPath: repo.path,
    repository,
    commitSha: resolvedCommitSha,
    parentShas,
    committedAt,
    commitEvidenceSha256: sha256Buffers([metadataBuffer, rawChangesBuffer, patchBuffer]),
    files,
  };
}

/** Reads Git-lineage evidence at the current checked-out commit for one local retention task. */
export async function readCommitRetentionObservation(
  workspacePath: string,
  input: {
    repositoryPath?: string | null;
    repository: string;
    commitSha: string;
    filePath: string;
    fileIdentitySha256: string;
  },
): Promise<GitCommitRetentionObservation> {
  const commitSha = String(input.commitSha ?? "").trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commitSha)) throw new Error("代码留存观察只接受完整 commit SHA");
  const filePath = requireRepositoryRelativeGitPath(input.filePath);
  if (!/^[a-f0-9]{64}$/u.test(input.fileIdentitySha256)) throw new Error("代码留存观察文件身份无效");
  const repo = await resolveRepositoryForOperation(workspacePath, input.repositoryPath);
  if (!repo.isDetectedRepo) throw new Error("代码留存观察目录不是 Git 仓库");
  const observationRef = decodeTextBuffer(await runGitBuffer(repo.absPath, ["rev-parse", "--verify", "HEAD^{commit}"]))
    .content.trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(observationRef)) throw new Error("代码留存观察引用无效");
  try {
    await runGitBuffer(repo.absPath, ["merge-base", "--is-ancestor", commitSha, observationRef]);
  } catch (error) {
    if ((error instanceof GitCommandExitError && error.code === 1) || isMissingRetentionCommitError(error)) {
      return { status: "unavailable", observationRef, reason: "history_rewritten" };
    }
    throw error;
  }

  const repository = await resolveCanonicalRepositoryKey(repo.absPath, commitSha);
  if (repository !== input.repository || sha256Text(`${repository}\0${filePath}`) !== input.fileIdentitySha256) {
    throw new Error("代码留存观察仓库或文件身份不一致");
  }

  const observedFilePath = await resolveRetentionObservationPath(repo.absPath, commitSha, observationRef, filePath);
  if (observedFilePath === null) {
    return {
      status: "complete",
      observationRef,
      targetCommitLines: [],
      evidenceSha256: sha256Buffers([Buffer.from(JSON.stringify({
        repository,
        commitSha,
        observationRef,
        fileIdentitySha256: input.fileIdentitySha256,
        observedFileIdentitySha256: null,
        targetCommitLines: [],
        fileStatus: "deleted",
      }), "utf8")]),
    };
  }
  let blameBuffer: Buffer;
  try {
    blameBuffer = await runGitBuffer(repo.absPath, [
      "-c", "core.quotePath=false", "blame", "--line-porcelain", "--root", "--follow",
      observationRef, "--", observedFilePath,
    ]);
  } catch (error) {
    if (isMissingGitBlamePathError(error)) {
      return { status: "unavailable", observationRef, reason: "retention_observation_missing" };
    }
    throw error;
  }
  const targetCommitLines = parseGitBlameTargetLines(decodeTextBuffer(blameBuffer).content, commitSha);
  return {
    status: "complete",
    observationRef,
    targetCommitLines,
    evidenceSha256: sha256Buffers([Buffer.from(JSON.stringify({
      repository,
      commitSha,
      observationRef,
      fileIdentitySha256: input.fileIdentitySha256,
      observedFileIdentitySha256: sha256Text(`${repository}\0${observedFilePath}`),
      targetCommitLines,
    }), "utf8")]),
  };
}

/** Resolves a net Git rename and returns null when Git proves the original lineage was deleted. */
async function resolveRetentionObservationPath(
  gitRootPath: string,
  commitSha: string,
  observationRef: string,
  originalPath: string,
): Promise<string | null> {
  const buffer = await runGitBuffer(gitRootPath, [
    "-c", "core.quotePath=false", "diff", "--name-status", "-z", "-M", commitSha, observationRef,
  ]);
  const changes = parseGitNameStatus(buffer);
  const renames = changes.filter((change) => change.status === "R" && change.previousPath === originalPath);
  if (renames.length > 1) throw new Error("代码留存观察发现重复的 Git 重命名目标");
  const deleted = changes.some((change) => change.status === "D" && change.path === originalPath);
  if (deleted && renames.length > 0) throw new Error("代码留存观察发现冲突的 Git 文件血缘");
  if (deleted) return null;
  return renames[0]?.path ?? originalPath;
}

/** Parses NUL-delimited Git name-status output with explicit rename/copy paths. */
function parseGitNameStatus(buffer: Buffer): Array<{ status: string; path: string; previousPath: string | null }> {
  const tokens = decodeTextBuffer(buffer).content.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const changes: Array<{ status: string; path: string; previousPath: string | null }> = [];
  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index++] ?? "";
    const status = statusToken.slice(0, 1);
    if (!/^[ACDMRTUXB]$/u.test(status)) throw new Error("代码留存观察 Git 文件状态无效");
    const firstPath = requireRepositoryRelativeGitPath(tokens[index++] ?? "");
    if (status === "R" || status === "C") {
      const secondPath = requireRepositoryRelativeGitPath(tokens[index++] ?? "");
      changes.push({ status, path: secondPath, previousPath: firstPath });
    } else {
      changes.push({ status, path: firstPath, previousPath: null });
    }
  }
  return changes;
}

/** 获取某个 commit 中某文件的 original/modified 内容（用于逐文件 diff） */
export async function showFileDiff(
  workspacePath: string,
  hash: string,
  filePath: string,
  repositoryPath?: string | null,
): Promise<{ original: string; modified: string }> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const { relPath } = resolveGitWorkspaceFilePath(workspacePath, repo, filePath);
  let original = "";
  let modified = "";
  if (repo.isDetectedRepo) {
    try {
      original = await readGitTextObject(repo.absPath, `${hash}^:${relPath}`);
    } catch (error) {
      if (!isMissingGitObjectError(error)) throw error;
      // 首次提交或新文件，original 为空
      original = "";
    }
    try {
      modified = await readGitTextObject(repo.absPath, `${hash}:${relPath}`);
    } catch (error) {
      if (!isMissingGitObjectError(error)) throw error;
      // 删除的文件，modified 为空
      modified = "";
    }
  }
  return { original, modified };
}

/** 从 Git 对象库读取原始 blob 字节，再按文本编码检测解码。 */
async function readGitTextObject(gitRootPath: string, objectSpec: string): Promise<string> {
  const output = await runGitBuffer(gitRootPath, ["cat-file", "-p", objectSpec]);
  return decodeTextBuffer(output).content;
}

/** 按字面路径读取单文件 Git patch，保持原文本编码检测策略。 */
async function readGitDiffText(gitRootPath: string, args: string[]): Promise<string> {
  const output = await runGitBuffer(gitRootPath, ["--literal-pathspecs", "diff", ...args]);
  return decodeTextBuffer(output).content;
}

/** 解析 Git `--raw -z` 结果并保留 rename/copy 的双路径身份。 */
function parseRawCommitChanges(buffer: Buffer): RawCommitChange[] {
  const tokens = decodeTextBuffer(buffer).content.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const changes: RawCommitChange[] = [];
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++] ?? "";
    const match = /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])([0-9]{0,3})$/u.exec(header);
    if (!match) throw new Error("Git commit raw diff 结构无效");
    const status = match[3]!;
    const firstPath = requireRepositoryRelativeGitPath(tokens[index++] ?? "");
    const hasSecondPath = status === "R" || status === "C";
    const secondPath = hasSecondPath ? requireRepositoryRelativeGitPath(tokens[index++] ?? "") : null;
    changes.push({
      path: secondPath ?? firstPath,
      previousPath: hasSecondPath ? firstPath : null,
      status,
      isNonTextMode: isNonTextGitMode(match[1]!) || isNonTextGitMode(match[2]!),
      changeType: rawStatusToChangeType(status),
    });
  }
  const identities = new Set<string>();
  for (const change of changes) {
    if (identities.has(change.path)) throw new Error("Git commit 包含重复目标文件路径");
    identities.add(change.path);
  }
  return changes;
}

/** 将 Git raw 文件顺序与 patch 文件段严格对齐并提取新增行。 */
function mapCommitChangesToPatches(
  changes: RawCommitChange[],
  patches: StructuredPatch[],
): GitCommitAttributionFile[] {
  if (changes.length !== patches.length) throw new Error("Git commit raw diff 与 patch 文件数量不一致");
  return changes.map((change, index) => {
    const patch = patches[index]!;
    const patchOldPath = structuredPatchPath(patch.oldFileName);
    const patchNewPath = structuredPatchPath(patch.newFileName);
    const actualPath = change.status === "D" ? patchOldPath : patchNewPath;
    if (actualPath !== change.path || (change.previousPath && patchOldPath !== change.previousPath)) {
      throw new Error("Git commit raw diff 与 patch 文件身份不一致");
    }
    const isBinary = Boolean(patch.isBinary) || change.isNonTextMode;
    const addedLines = isBinary
      ? []
      : patch.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1)));
    return {
      path: change.path,
      previousPath: change.previousPath,
      changeType: change.changeType,
      isBinary,
      addedLines,
      commitEvidenceSha256: sha256Text(JSON.stringify({
        status: change.status,
        path: change.path,
        previousPath: change.previousPath,
        isBinary,
        hunks: patch.hunks,
      })),
    };
  });
}

/** Treats symlinks and gitlinks as non-code files while allowing regular executable blobs. */
function isNonTextGitMode(mode: string): boolean {
  return mode !== "000000" && !mode.startsWith("100");
}

/** 规范化 `diff` 解析器返回的 a/b 路径并拒绝缺失身份。 */
function structuredPatchPath(value: string | undefined): string | null {
  const text = String(value ?? "");
  if (!text || text === "/dev/null") return null;
  const unprefixed = text.startsWith("a/") || text.startsWith("b/") ? text.slice(2) : text;
  return requireRepositoryRelativeGitPath(unprefixed);
}

/** 将 Git raw 状态收敛为度量使用的有限变更类型。 */
function rawStatusToChangeType(status: string): GitCommitAttributionFile["changeType"] {
  if (status === "A") return "added";
  if (status === "M") return "modified";
  if (status === "D") return "deleted";
  if (status === "R") return "renamed";
  if (status === "C") return "copied";
  if (status === "T") return "type_changed";
  throw new Error(`代码归因不支持 Git 变更状态：${status}`);
}

/** 校验 Git 返回的仓库相对路径，控制字符和越界路径不得进入哈希或 patch 对账。 */
function requireRepositoryRelativeGitPath(value: string): string {
  const normalized = String(value ?? "").replace(/\\/gu, "/");
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[A-Za-z]:/u.test(normalized)
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Git commit 包含不安全的文件路径");
  }
  return normalized;
}

/** 选择去凭据的网络 remote；没有网络 remote 时使用根提交集合生成本地仓库键。 */
async function resolveCanonicalRepositoryKey(gitRootPath: string, commitSha: string): Promise<string> {
  const remoteNamesText = decodeTextBuffer(await runGitBuffer(gitRootPath, ["remote"])).content;
  const remoteNames = remoteNamesText.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  remoteNames.sort((left, right) => {
    if (left === "origin") return -1;
    if (right === "origin") return 1;
    return left.localeCompare(right, "en");
  });
  for (const remoteName of remoteNames) {
    if (/[\u0000-\u001f\u007f]/u.test(remoteName)) throw new Error("Git remote 名称无效");
    const urlsText = decodeTextBuffer(await runGitBuffer(gitRootPath, ["remote", "get-url", "--all", remoteName])).content;
    for (const remoteUrl of urlsText.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
      const canonical = canonicalizeNetworkRemote(remoteUrl);
      if (canonical) return canonical;
    }
  }

  const rootsText = decodeTextBuffer(await runGitBuffer(gitRootPath, [
    "rev-list",
    "--max-parents=0",
    "--reverse",
    commitSha,
  ])).content;
  const roots = rootsText.split(/\r?\n/u).map((item) => item.trim().toLowerCase()).filter(Boolean).sort();
  if (!roots.length || roots.some((item) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(item))) {
    throw new Error("无远端仓库缺少可用的根提交身份");
  }
  return `local:${sha256Text(roots.join("\n"))}`;
}

/** 清洗 HTTPS/SSH/Git/scp remote，丢弃用户名、密码、查询参数和协议差异。 */
function canonicalizeNetworkRemote(remoteUrl: string): string | null {
  if (!remoteUrl || /[\u0000-\u001f\u007f]/u.test(remoteUrl)) return null;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(remoteUrl)) {
    if (/^[A-Za-z]:[\\/]/u.test(remoteUrl) || remoteUrl.startsWith("/") || remoteUrl.startsWith("\\\\")) return null;
    const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(.+)$/u.exec(remoteUrl);
    if (!scp) return null;
    return canonicalRemoteHostPath(scp[1]!, scp[2]!.split(/[?#]/u, 1)[0]!);
  }
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol) || !parsed.hostname) return null;
  const host = `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}`;
  return canonicalRemoteHostPath(host, parsed.pathname);
}

/** 生成不含协议和凭据的稳定 host/repository 路径。 */
function canonicalRemoteHostPath(host: string, rawPath: string): string | null {
  let repositoryPath = rawPath.replace(/^\/+|\/+$/gu, "");
  if (repositoryPath.toLowerCase().endsWith(".git")) repositoryPath = repositoryPath.slice(0, -4);
  const segments = repositoryPath.split("/");
  if (
    !host
    || !repositoryPath
    || /[\u0000-\u001f\u007f\\]/u.test(repositoryPath)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) return null;
  return `${host.toLowerCase()}/${repositoryPath}`;
}

/** 计算一组权威 Git 字节的顺序敏感摘要。 */
function sha256Buffers(buffers: Buffer[]): string {
  const digest = crypto.createHash("sha256");
  for (const buffer of buffers) {
    digest.update(String(buffer.length));
    digest.update("\0");
    digest.update(buffer);
  }
  return digest.digest("hex");
}

/** 计算一段 UTF-8 文本的 SHA-256。 */
function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** 执行有硬超时的 Git 命令并保留 stdout 原始字节；Windows 超时会等待整棵进程树回收结果。 */
function runGitBuffer(gitRootPath: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timeoutStarted = false;
    let timeout: NodeJS.Timeout | null = null;

    const finish = (error: Error | null, output?: Buffer) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output ?? Buffer.alloc(0));
    };

    let child: ChildProcess;
    try {
      child = spawn("git", args, { cwd: gitRootPath, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      finish(new Error(`Git 命令启动失败：${formatGitCommand(gitRootPath, args)}（${error instanceof Error ? error.message : String(error)}）`));
      return;
    }

    timeout = setTimeout(() => {
      if (settled) return;
      timeoutStarted = true;
      void terminateGitProcessTree(child).then((terminationError) => {
        const suffix = terminationError
          ? `；进程树回收失败：${terminationError}`
          : "；进程树已回收";
        finish(new Error(`Git 命令超时 ${GIT_COMMAND_TIMEOUT_MS}ms：${formatGitCommand(gitRootPath, args)}${suffix}`));
      }, (error) => {
        finish(new Error(
          `Git 命令超时 ${GIT_COMMAND_TIMEOUT_MS}ms：${formatGitCommand(gitRootPath, args)}；进程树回收失败：${error instanceof Error ? error.message : String(error)}`,
        ));
      });
    }, GIT_COMMAND_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (timeoutStarted) return;
      finish(new Error(`Git 命令启动失败：${formatGitCommand(gitRootPath, args)}（${error.message}）`));
    });
    child.on("close", (code, signal) => {
      if (timeoutStarted) return;
      if (code === 0) {
        finish(null, Buffer.concat(stdout));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      finish(new GitCommandExitError(
        `Git 命令失败：${formatGitCommand(gitRootPath, args)}（code=${code ?? "null"} signal=${signal ?? "null"}）${detail ? `：${detail}` : ""}`,
        code,
        signal,
      ));
    });
  });
}

/** Windows 通过 taskkill /T /F 回收并确认 Git 进程树；其它平台终止根进程。 */
async function terminateGitProcessTree(child: ChildProcess): Promise<string | null> {
  if (process.platform !== "win32") {
    if (childHasExited(child)) return null;
    try {
      const killed = child.kill("SIGKILL");
      return killed || childHasExited(child) ? null : "child.kill(SIGKILL) returned false";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  const pid = Number(child.pid ?? 0);
  if (!Number.isSafeInteger(pid) || pid <= 0) return "Git child PID is unavailable";
  return await new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let terminationTimeout: NodeJS.Timeout | null = null;
    const settle = (error: string | null) => {
      if (settled) return;
      settled = true;
      if (terminationTimeout) clearTimeout(terminationTimeout);
      resolve(error);
    };

    let taskkill: ChildProcess;
    try {
      taskkill = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      settle(`taskkill spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    taskkill.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    taskkill.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    taskkill.on("error", (error) => settle(`taskkill spawn failed: ${error.message}`));
    terminationTimeout = setTimeout(() => {
      taskkill.kill();
      settle(`taskkill timed out after ${GIT_PROCESS_TREE_TERMINATION_TIMEOUT_MS}ms; process tree termination is unconfirmed`);
    }, GIT_PROCESS_TREE_TERMINATION_TIMEOUT_MS);
    terminationTimeout.unref?.();
    taskkill.on("close", (code) => {
      if (code === 0) {
        settle(null);
        return;
      }
      const detail = decodeTextBuffer(Buffer.concat(stderr.length ? stderr : stdout)).content.trim()
        || `taskkill exit code=${code}`;
      settle(childHasExited(child)
        ? `${detail}; root process exited before tree termination could be confirmed`
        : detail);
    });
  });
}

/** 判断 Git 根进程是否已由操作系统结算。 */
function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** 生成可检索的 Git 命令上下文，不省略仓库路径。 */
function formatGitCommand(gitRootPath: string, args: string[]): string {
  return `cwd=${gitRootPath} git ${args.join(" ")}`;
}

/** 判断 Git blob 不存在的预期场景；其他 Git 失败继续向上暴露。 */
function isMissingGitObjectError(error: unknown): boolean {
  if (!(error instanceof GitCommandExitError)) return false;
  return /invalid object name|does not exist|not exist|exists on disk, but not in/.test(error.message);
}

/** Recognizes a deleted or absent path while preserving all other blame failures. */
function isMissingGitBlamePathError(error: unknown): boolean {
  return error instanceof GitCommandExitError
    && /no such path|path .* does not exist|fatal: no such path|cannot stat path/i.test(error.message);
}

/** Recognizes a target commit removed by history rewrite and object pruning. */
function isMissingRetentionCommitError(error: unknown): boolean {
  return error instanceof GitCommandExitError
    && /not a valid (?:object|commit) name|bad object|unknown revision|invalid object name|does not exist|not exist/i.test(error.message);
}

/** Extracts only lines whose Git blame origin is the target commit. */
function parseGitBlameTargetLines(value: string, targetCommitSha: string): string[] {
  const lines = value.split(/\r?\n/u);
  const result: string[] = [];
  let currentCommit = "";
  for (const line of lines) {
    const header = /^(\^?[a-f0-9]{40,64}) \d+ \d+(?: \d+)?$/u.exec(line);
    if (header) {
      currentCommit = header[1]!.replace(/^\^/u, "").toLowerCase();
      continue;
    }
    if (line.startsWith("\t") && currentCommit === targetCommitSha) result.push(line.slice(1));
  }
  return result;
}

/** 只有未创建首个 commit 时允许 HEAD 为空，其它 rev-parse 失败继续上抛。 */
function isUnbornHeadError(error: unknown): boolean {
  return error instanceof GitCommandExitError
    && /Needed a single revision|unknown revision|ambiguous argument ['\"]?HEAD|does not have any commits/i.test(error.message);
}

/** 列出 workspace 下可切换的 Git 仓库，并在短 TTL 内复用四层扫描结果。 */
export async function listRepositories(workspacePath: string): Promise<GitRepositoryInfo[]> {
  const workspaceKey = normalizedGitWorkspaceKey(workspacePath);
  const now = Date.now();
  const cached = gitRepositoryDiscoveryCache.get(workspaceKey);
  if (cached && cached.expiresAt > now) return cloneGitRepositories(cached.repositories);
  if (cached) gitRepositoryDiscoveryCache.delete(workspaceKey);

  const existing = gitRepositoryDiscoveryInFlight.get(workspaceKey);
  if (existing) return cloneGitRepositories(await existing);

  const pending = scanRepositories(workspacePath).then((repositories) => {
    cacheGitRepositoryDiscovery(workspaceKey, repositories);
    return repositories;
  }).finally(() => {
    if (gitRepositoryDiscoveryInFlight.get(workspaceKey) === pending) {
      gitRepositoryDiscoveryInFlight.delete(workspaceKey);
    }
  });
  gitRepositoryDiscoveryInFlight.set(workspaceKey, pending);
  return cloneGitRepositories(await pending);
}

/** 四层扫描按批并发读取；保留 marker 优先边界，失败等待同批收口后上抛。 */
async function scanRepositories(workspacePath: string): Promise<GitRepositoryInfo[]> {
  const workspaceRoot = path.resolve(workspacePath);
  const repositories: GitRepositoryInfo[] = [];
  type ScanDirectory = { absDir: string; relPath: string; depth: number };
  const queue: ScanDirectory[] = [{ absDir: workspaceRoot, relPath: "", depth: 0 }];

  /** 只返回本目录的待查子目录；达到深度上限时保留仅检查 marker 的边界。 */
  async function readDirectory({ absDir, relPath, depth }: ScanDirectory): Promise<ScanDirectory[]> {
    if (await hasGitMarker(absDir)) {
      repositories.push({
        path: relPath,
        name: relPath ? path.basename(relPath) : path.basename(workspaceRoot),
      });
      if (relPath) return [];
    }
    if (depth >= GIT_REPOSITORY_SCAN_MAX_DEPTH) return [];
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && !GIT_REPOSITORY_SCAN_SKIP_DIRS.has(entry.name))
      .map(entry => ({ absDir: path.join(absDir, entry.name), relPath: relPath ? `${relPath}/${entry.name}` : entry.name, depth: depth + 1 }));
  }

  for (let cursor = 0; cursor < queue.length;) {
    const batch = queue.slice(cursor, cursor + GIT_REPOSITORY_SCAN_CONCURRENCY);
    cursor += batch.length;
    const settled = await Promise.allSettled(batch.map(readDirectory));
    const failures = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failures.length === 1) throw failures[0]!.reason;
    if (failures.length > 1) throw new AggregateError(failures.map(item => item.reason), "GIT_REPOSITORY_DISCOVERY_FAILED", { cause: failures[0]!.reason });
    for (const item of settled) {
      if (item.status === "fulfilled") for (const child of item.value) queue.push(child);
    }
  }
  return repositories.sort((a, b) => compareRepositoryPath(a.path, b.path));
}

/** 写入有界仓库发现缓存，并清理过期或最早的条目。 */
function cacheGitRepositoryDiscovery(workspaceKey: string, repositories: GitRepositoryInfo[]): void {
  const now = Date.now();
  for (const [key, entry] of gitRepositoryDiscoveryCache) {
    if (entry.expiresAt <= now) gitRepositoryDiscoveryCache.delete(key);
  }
  gitRepositoryDiscoveryCache.set(workspaceKey, {
    expiresAt: now + GIT_REPOSITORY_DISCOVERY_TTL_MS,
    repositories: cloneGitRepositories(repositories),
  });
  while (gitRepositoryDiscoveryCache.size > GIT_REPOSITORY_DISCOVERY_CACHE_MAX) {
    const oldestKey = gitRepositoryDiscoveryCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    gitRepositoryDiscoveryCache.delete(oldestKey);
  }
}

/** 克隆仓库列表，避免调用方改写 Client 级缓存。 */
function cloneGitRepositories(repositories: GitRepositoryInfo[]): GitRepositoryInfo[] {
  return repositories.map((repository) => ({ ...repository }));
}

/** 选择本次 Git 操作的仓库；未指定时按发现列表的第一个仓库作为默认值。 */
async function resolveRepositoryForOperation(workspacePath: string, repositoryPath?: string | null): Promise<ResolvedGitRepository> {
  const repositories = await listRepositories(workspacePath);
  const repo = selectRepository(workspacePath, repositories, repositoryPath, { fallbackOnMissing: repositoryPath == null });
  if (repo) return repo;
  if (repositoryPath != null) {
    const requested = normalizeRepositoryPath(repositoryPath);
    throw new Error(`Git 仓库不存在：${requested || "."}`);
  }
  const workspaceRoot = path.resolve(workspacePath);
  return { path: "", name: path.basename(workspaceRoot), absPath: workspaceRoot, isDetectedRepo: false };
}

/** 按请求路径选择仓库；status 可回落到第一个仓库用于修正陈旧选择。 */
function selectRepository(
  workspacePath: string,
  repositories: GitRepositoryInfo[],
  repositoryPath: string | null | undefined,
  options: { fallbackOnMissing: boolean },
): ResolvedGitRepository | null {
  if (!repositories.length) return null;
  const requested = repositoryPath == null ? null : normalizeRepositoryPath(repositoryPath);
  const selected = requested == null
    ? repositories[0]
    : repositories.find((repo) => repo.path === requested) ?? (options.fallbackOnMissing ? repositories[0] : null);
  if (!selected) return null;
  return toResolvedRepository(workspacePath, selected);
}

/** 给仓库信息补充绝对路径。 */
function toResolvedRepository(workspacePath: string, repo: GitRepositoryInfo): ResolvedGitRepository {
  return {
    ...repo,
    absPath: resolveWorkspacePath(path.resolve(workspacePath), repo.path),
    isDetectedRepo: true,
  };
}

/** 识别目录是否是 Git 仓库根；只把缺失 .git 视为非仓库。 */
async function hasGitMarker(absDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(absDir, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch (error) {
    if (isFsErrorCode(error, "ENOENT") || isFsErrorCode(error, "ENOTDIR")) return false;
    throw new Error(`无法检查 Git 标记：${absDir}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

/** 规范化 workspace 相对仓库路径，禁止绝对路径和越界路径。 */
function normalizeRepositoryPath(repositoryPath: string | null | undefined): string {
  const raw = String(repositoryPath ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw === ".") return "";
  if (/^[a-zA-Z]:/.test(raw) || path.posix.isAbsolute(raw)) {
    throw new Error(`非法 Git 仓库路径：${repositoryPath}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === "") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`非法 Git 仓库路径：${repositoryPath}`);
  }
  return normalized;
}

/** 将 repo 相对 Git 路径转为 workspace 相对路径，供文件预览复用。 */
function toWorkspaceGitPath(repositoryPath: string, gitPath: string): string {
  const normalized = String(gitPath ?? "").replace(/\\/g, "/");
  return repositoryPath ? `${repositoryPath}/${normalized}` : normalized;
}

/** 将 Git 文件路径限定在当前仓库内，并转成 Git 期望的 POSIX 相对路径。 */
function resolveGitWorkspaceFilePath(workspacePath: string, repo: ResolvedGitRepository, filePath: string): { relPath: string; absPath: string } {
  const rawPath = String(filePath ?? "").trim();
  if (!rawPath) throw new Error("参数错误：path");
  const root = path.resolve(workspacePath);
  const scopedPath = scopeFilePathToRepository(repo.path, rawPath);
  const absPath = resolveWorkspacePath(root, scopedPath);
  const relPath = path.relative(repo.absPath, absPath).split(path.sep).join("/");
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    throw new Error(`路径不属于当前 Git 仓库：${filePath}`);
  }
  return { relPath, absPath };
}

/** 兼容旧调用方传 repo 相对路径，同时优先支持 workspace 相对路径。 */
function scopeFilePathToRepository(repositoryPath: string, filePath: string): string {
  if (!repositoryPath || path.isAbsolute(filePath)) return filePath;
  const posixPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (posixPath === repositoryPath || posixPath.startsWith(`${repositoryPath}/`)) return filePath;
  return `${repositoryPath}/${posixPath}`;
}

/** 批量规整 Git pathspec，避免 Web 输入越界读写 workspace 外文件。 */
function normalizeGitWorkspacePaths(workspacePath: string, repo: ResolvedGitRepository, paths: string[]): string[] {
  return paths.map((item) => resolveGitWorkspaceFilePath(workspacePath, repo, item).relPath);
}

/** 仅原生文件错误的自有 ENOENT 允许删除预览，未知对象交原请求边界保因。 */
function isFileMissingError(error: unknown): boolean {
  if (!types.isNativeError(error)) return false;
  const code = Object.getOwnPropertyDescriptor(error, "code");
  return Boolean(code && "value" in code && code.value === "ENOENT");
}

/** 判断文件系统异常 code，避免把权限等真实错误误判为缺失。 */
function isFsErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error != null && "code" in error && (error as { code?: unknown }).code === code;
}

/** Git 仓库排序：根仓库优先，其余按路径稳定排序。 */
function compareRepositoryPath(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

/** 构造无仓库时的 status 响应，保留发现到的仓库列表。 */
function createEmptyGitStatus(repositories: GitRepositoryInfo[]): GitStatusResult {
  return {
    isRepo: false,
    repositoryPath: null,
    repositories,
    branch: null,
    tracking: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    fileStats: {},
    merging: false,
    rebasing: false,
    headCommit: null,
  };
}

/** 列出所有分支 */
export async function branchList(workspacePath: string, repositoryPath?: string | null): Promise<GitBranchInfo[]> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const g = git(repo.absPath);
  const result = await g.branch(["-a", "-v"]);

  const branches: GitBranchInfo[] = [];
  for (const [name, rawInfo] of Object.entries(result.branches)) {
    const info = rawInfo as { name: string; current: boolean; commit: string; tracking?: string };
    branches.push({
      name: info.name,
      current: info.current,
      tracking: info.tracking ?? null,
      commit: info.commit,
      isRemote: name.startsWith("remotes/"),
    });
  }
  return branches;
}

/** 创建分支 */
export async function branchCreate(workspacePath: string, name: string, startPoint?: string, repositoryPath?: string | null): Promise<void> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const g = git(repo.absPath);
  const args = startPoint ? [name, startPoint] : [name];
  await g.branch(args);
  advanceGitMutationGeneration(workspacePath);
}

/** 切换分支 */
export async function branchSwitch(workspacePath: string, name: string, repositoryPath?: string | null): Promise<void> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const g = git(repo.absPath);
  await g.checkout(name);
  advanceGitMutationGeneration(workspacePath);
}

/** 删除分支 */
export async function branchDelete(workspacePath: string, name: string, force: boolean, repositoryPath?: string | null): Promise<void> {
  const repo = await resolveRepositoryForOperation(workspacePath, repositoryPath);
  const g = git(repo.absPath);
  const flag = force ? "-D" : "-d";
  await g.branch([flag, name]);
  advanceGitMutationGeneration(workspacePath);
}

/** 生成用于状态隔离的规范化 workspace 键。 */
function normalizedGitWorkspaceKey(workspacePath: string): string {
  const resolvedWorkspacePath = path.normalize(path.resolve(workspacePath));
  return process.platform === "win32"
    ? resolvedWorkspacePath.toLowerCase()
    : resolvedWorkspacePath;
}

/** 将仓库选择拼入状态请求键，同时区分默认选择和显式根仓库。 */
function gitStatusScopeKey(workspaceKey: string, repositoryPath?: string | null): string {
  const normalizedRepositoryPath = repositoryPath == null
    ? "default"
    : `repository:${normalizeRepositoryPath(repositoryPath)}`;
  return `${workspaceKey.length}:${workspaceKey}|${normalizedRepositoryPath}`;
}

/** 仅在 Git 写操作成功后推进 workspace 级代次。 */
function advanceGitMutationGeneration(workspacePath: string): void {
  const workspaceKey = normalizedGitWorkspaceKey(workspacePath);
  gitMutationGenerationByWorkspace.set(workspaceKey, (gitMutationGenerationByWorkspace.get(workspaceKey) ?? 0) + 1);
}

