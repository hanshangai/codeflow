import type { WorkspaceId } from "./ids.js";

/** 单个文件的 git 状态 */
export type GitFileStatus = {
  path: string;
  /** index 状态字符：M/A/D/R/C/? 等 */
  index: string;
  /** working tree 状态字符 */
  working: string;
};

/** 单个变更文件在工作区磁盘上的元信息；仅用于变更列表展示。 */
export type GitFileStat = {
  /** 字节数 */
  size: number;
  /** 最后修改时间 ISO8601 */
  mtime: string;
};

/** 工作区内发现的 Git 仓库；path 为空表示工作区根目录。 */
export type GitRepositoryInfo = {
  path: string;
  name: string;
};

/** git status 完整结果 */
export type GitStatusResult = {
  isRepo: boolean;
  /** 当前 Git 视图选中的仓库路径；无仓库时为 null。 */
  repositoryPath: string | null;
  /** 当前 workspace 下可切换的 Git 仓库列表。 */
  repositories: GitRepositoryInfo[];
  branch: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: string[];
  /** 变更文件元信息映射：workspace 相对路径 → { size, mtime }；已删除或读取失败的文件不在其中。 */
  fileStats?: Record<string, GitFileStat>;
  merging: boolean;
  rebasing: boolean;
  headCommit: string | null;
  /** false 表示浅库等历史可在 HEAD 不变时变化，状态刷新后须重读历史。 */
  historyCacheable?: boolean;
};

/** git log 单条记录 */
export type GitLogEntry = {
  hash: string;
  hashShort: string;
  message: string;
  body: string;
  author: string;
  authorEmail: string;
  date: string;
  parents: string[];
  refs: string;
};

/** 分支信息 */
export type GitBranchInfo = {
  name: string;
  current: boolean;
  tracking: string | null;
  commit: string | null;
  isRemote: boolean;
};

// ---- RPC Request/Response Bodies ----

export type GitRepositoryScopedRequest = {
  workspaceId: WorkspaceId;
  /** workspace 相对路径；为空字符串表示 workspace 根仓库。 */
  repositoryPath?: string | null;
};

export type GitStatusRequestBody = GitRepositoryScopedRequest;
export type GitStatusResponseBody = GitStatusResult;

export type GitDiffRequestBody = GitRepositoryScopedRequest & {
  path: string;
  /** true: staged diff; false: working tree diff */
  staged?: boolean;
};
export type GitDiffResponseBody = { path: string; diff: string };

export type GitDiffFilesRequestBody = GitRepositoryScopedRequest & {
  path: string;
  staged?: boolean;
};
export type GitDiffFilesResponseBody = { path: string; original: string; modified: string };

export type GitStageRequestBody = GitRepositoryScopedRequest & { paths: string[] };
export type GitStageResponseBody = { ok: true };

export type GitUnstageRequestBody = GitRepositoryScopedRequest & { paths: string[] };
export type GitUnstageResponseBody = { ok: true };

export type GitDiscardRequestBody = GitRepositoryScopedRequest & { paths: string[] };
export type GitDiscardResponseBody = { ok: true };

export type GitCommitRequestBody = GitRepositoryScopedRequest & {
  message: string;
  amend?: boolean;
};
export type GitCommitResponseBody = { hash: string; message: string };

export type GitLogRequestBody = GitRepositoryScopedRequest & {
  maxCount?: number;
  skip?: number;
  /** 固定分页所依据的 HEAD，避免连续页跨越新提交。 */
  headCommit?: string | null;
};
export type GitLogResponseBody = { entries: GitLogEntry[]; total: number };

export type GitShowRequestBody = GitRepositoryScopedRequest & {
  hash: string;
  /** 默认 true；列表预览传 false 仅读取元数据。 */
  includeDiff?: boolean;
};
export type GitShowResponseBody = {
  entry: GitLogEntry;
  files: GitFileStatus[];
  diff: string;
  /** false 表示尚未请求完整 patch，区别于已读取的空差异。 */
  diffLoaded?: boolean;
};

export type GitBranchListRequestBody = GitRepositoryScopedRequest;
export type GitBranchListResponseBody = { branches: GitBranchInfo[] };

export type GitBranchCreateRequestBody = GitRepositoryScopedRequest & {
  name: string;
  startPoint?: string;
};
export type GitBranchCreateResponseBody = { name: string };

export type GitBranchSwitchRequestBody = GitRepositoryScopedRequest & { name: string };
export type GitBranchSwitchResponseBody = { name: string };

export type GitBranchDeleteRequestBody = GitRepositoryScopedRequest & { name: string; force?: boolean };
export type GitBranchDeleteResponseBody = { name: string };

export type GitShowFileDiffRequestBody = GitRepositoryScopedRequest & {
  hash: string;
  path: string;
};
export type GitShowFileDiffResponseBody = { path: string; original: string; modified: string };
