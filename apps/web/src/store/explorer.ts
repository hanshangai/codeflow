import { defineStore } from "pinia";
import type {
  FsTreeNode, FsReadFileResponseBody, FsSpreadsheetPreviewResponseBody,
  GitStatusResult, GitLogEntry, GitBranchInfo, GitFileStatus, GitFileStat, GitRepositoryInfo, GitShowResponseBody,
  WorkspaceId,
} from "@codeflowai/shared";
import { createApiResultError, type ApiRequestContext } from "../api/request";
import { fetchFsTree } from "../api/fs";
import {
  fetchGitStatus, fetchGitDiffFiles, fetchGitStage, fetchGitUnstage, fetchGitDiscard,
  fetchGitCommit, fetchGitLog, fetchGitShow, fetchGitShowFileDiff,
  fetchGitBranchList, fetchGitBranchCreate, fetchGitBranchSwitch, fetchGitBranchDelete,
} from "../api/git";
import { loadWorkspaceFilePreview, type WorkspaceFilePreviewType } from "../features/explorer/workspaceFilePreview";

export type ExplorerViewMode = "files" | "git" | "log";
export type PreviewType = WorkspaceFilePreviewType;
type GitStatusRequestScope = { workspaceId: WorkspaceId; repositoryPath?: string | null };
type GitStatusApiResult = Awaited<ReturnType<typeof fetchGitStatus>>;
type GitStatusLoad = { epoch: number; scopeKey: string; historyCount: number; historyLoad?: GitLogLoad; promise: Promise<void> };
type GitLogLoad = { epoch: number; scopeKey: string; maxCount: number; skip: number; promise: Promise<void> };

const pendingGitStatusRequests = new Map<string, Promise<GitStatusApiResult>>();
const pendingGitStatusLoads = new WeakMap<object, GitStatusLoad>();
const pendingGitLogLoads = new WeakMap<object, Map<string, GitLogLoad>>();
const pendingPreviewLoads = new WeakMap<object, { epoch: number; scopeKey: string; promise: Promise<void> }>();
const GIT_STATUS_CACHE_TTL_MS = 60_000;
const GIT_STATUS_CACHE_MAX = 32;

type GitStatusCacheEntry = {
  expiresAt: number;
  result: GitStatusResult;
};

const gitStatusCache = new Map<string, GitStatusCacheEntry>();

/** 历史列表按工作区/仓库/HEAD 作用域缓存；面板重开时先展示再后台刷新。 */
const GIT_LOG_CACHE_MAX = 20;
type GitLogCacheEntry = { repositoryScopeKey: string; entries: GitLogEntry[]; total: number };
const gitLogCacheByScope = new Map<string, GitLogCacheEntry>();

/** 写入历史快照并按最近使用淘汰；重复写入会移到队尾。 */
function rememberGitLog(scopeKey: string, repositoryScopeKey: string, entries: GitLogEntry[], total: number): void {
  gitLogCacheByScope.delete(scopeKey);
  gitLogCacheByScope.set(scopeKey, { repositoryScopeKey, entries: [...entries], total });
  while (gitLogCacheByScope.size > GIT_LOG_CACHE_MAX) {
    const oldest = gitLogCacheByScope.keys().next().value;
    if (oldest === undefined) break;
    gitLogCacheByScope.delete(oldest);
  }
}

/** HEAD 变化时用同仓库最近一次列表兜底，避免历史区整块回到加载态。 */
function findRecentGitLog(repositoryScopeKey: string): GitLogCacheEntry | null {
  let recent: GitLogCacheEntry | null = null;
  for (const entry of gitLogCacheByScope.values()) {
    if (entry.repositoryScopeKey === repositoryScopeKey) recent = entry;
  }
  return recent;
}

/** 生成 Web Git 状态的请求/缓存键，避免不同会话间误复用。 */
function gitStatusRequestKey(ctx: ApiRequestContext, scope: GitStatusRequestScope): string {
  return JSON.stringify([
    String(ctx.serverWsOrigin),
    ctx.webSessionId ?? null,
    String(scope.workspaceId),
    scope.repositoryPath ?? null,
  ]);
}

/** 复制 Git 状态结果，避免缓存和 store 共享同一对象引用。 */
function cloneGitStatusResult(result: GitStatusResult): GitStatusResult {
  return {
    ...result,
    repositories: result.repositories.map((repository) => ({ ...repository })),
    staged: result.staged.map((file) => ({ ...file })),
    unstaged: result.unstaged.map((file) => ({ ...file })),
    untracked: [...result.untracked],
    fileStats: cloneGitFileStats(result.fileStats),
  };
}

/** 只比较可见的仓库与文件状态，忽略响应封套及元信息键的顺序。 */
function gitStatusSnapshotKey(status: GitStatusResult): string {
  return JSON.stringify([
    status.isRepo, status.repositoryPath, status.repositories, status.branch, status.tracking,
    status.ahead, status.behind, status.staged, status.unstaged, status.untracked,
    Object.entries(status.fileStats ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    status.merging, status.rebasing, status.headCommit, status.historyCacheable,
  ]);
}

/** 复制变更文件元信息映射，缺失归一为空对象，避免缓存条目与 store 共享同一引用。 */
function cloneGitFileStats(fileStats: GitStatusResult["fileStats"]): NonNullable<GitStatusResult["fileStats"]> {
  const cloned: Record<string, GitFileStat> = {};
  for (const [path, value] of Object.entries(fileStats ?? {})) {
    cloned[path] = { ...value };
  }
  return cloned;
}

/** 读取短 TTL 的 Git 状态缓存；过期项会顺手清理。 */
function readCachedGitStatusResult(requestKey: string): GitStatusResult | null {
  const now = Date.now();
  const cached = gitStatusCache.get(requestKey);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    gitStatusCache.delete(requestKey);
    return null;
  }
  return cloneGitStatusResult(cached.result);
}

/** 写入有界 Git 状态缓存，并清理过期与最旧项。 */
function writeCachedGitStatusResult(requestKey: string, result: GitStatusResult): void {
  const now = Date.now();
  for (const [key, entry] of gitStatusCache) {
    if (entry.expiresAt <= now) gitStatusCache.delete(key);
  }
  gitStatusCache.set(requestKey, {
    expiresAt: now + GIT_STATUS_CACHE_TTL_MS,
    result: cloneGitStatusResult(result),
  });
  while (gitStatusCache.size > GIT_STATUS_CACHE_MAX) {
    const oldestKey = gitStatusCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    gitStatusCache.delete(oldestKey);
  }
}

/** 缓存 Git 状态结果；首次自动发现仓库后同时缓存实际仓库路径。 */
function cacheGitStatusResult(ctx: ApiRequestContext, workspaceId: WorkspaceId, scope: GitStatusRequestScope, result: GitStatusResult): void {
  const requestKey = gitStatusRequestKey(ctx, scope);
  writeCachedGitStatusResult(requestKey, result);
  const resolvedScope = result.repositoryPath == null ? { workspaceId } : { workspaceId, repositoryPath: result.repositoryPath };
  const resolvedKey = gitStatusRequestKey(ctx, resolvedScope);
  if (resolvedKey !== requestKey) writeCachedGitStatusResult(resolvedKey, result);
}

/** 同一 Server、Web 会话和 Git 作用域仅复用当前在途状态请求。 */
function fetchGitStatusSingleflight(ctx: ApiRequestContext, scope: GitStatusRequestScope): Promise<GitStatusApiResult> {
  const requestKey = gitStatusRequestKey(ctx, scope);
  const existing = pendingGitStatusRequests.get(requestKey);
  if (existing) return existing;
  const pending = fetchGitStatus(ctx, scope).finally(() => {
    if (pendingGitStatusRequests.get(requestKey) === pending) pendingGitStatusRequests.delete(requestKey);
  });
  pendingGitStatusRequests.set(requestKey, pending);
  return pending;
}

export type ExplorerState = {
  /** 文件树根节点列表 */
  treeNodes: FsTreeNode[];
  /** 文件树重建代次，用于清理 Tree 内部的已加载缓存 */
  treeVersion: number;
  /** 展开的目录路径集合 */
  expandedKeys: string[];
  /** 当前选中的文件路径 */
  selectedPath: string | null;
  /** 文件预览数据 */
  preview: FsReadFileResponseBody | null;
  spreadsheetPreview: FsSpreadsheetPreviewResponseBody | null;
  previewType: PreviewType;
  previewLoading: boolean;
  /** 预览选择代次，隔离切文件、切工作表和工作区后的迟到响应。 */
  _previewRequestEpoch: number;

  /** 视图模式 */
  viewMode: ExplorerViewMode;

  /** Git 状态 */
  gitStatus: GitStatusResult | null;
  gitStatusLoading: boolean;
  /** Git 状态请求代次，阻止旧作用域响应和 loading 回写。 */
  _gitStatusRequestEpoch: number;
  /** 浅库同 HEAD 也可能补全历史；失效信号不依赖替换状态对象。 */
  _gitHistoryInvalidationVersion: number;
  gitRepositories: GitRepositoryInfo[];
  selectedGitRepositoryPath: string | null;
  selectedGitRepositoriesByWorkspace: Record<string, string>;

  /** Git 日志 */
  gitLogEntries: GitLogEntry[];
  gitLogTotal: number;
  gitLogLoading: boolean;
  gitLogError: string | null;
  _gitLogLoadedScope: string | null;
  _gitLogRequestEpoch: number;

  /** Git 分支 */
  gitBranches: GitBranchInfo[];
  gitBranchLoading: boolean;

  /** Git Diff 内容 */
  gitDiffPath: string | null;
  gitDiffContent: string | null;
  gitDiffOriginal: string | null;
  gitDiffModified: string | null;
  gitDiffStaged: boolean;
  gitDiffLoading: boolean;

  /** Git commit detail */
  gitCommitDetail: GitShowResponseBody | null;
  gitCommitDetailLoading: boolean;
  gitCommitDetailError: string | null;
  _gitCommitDetailRequestEpoch: number;

  /** 当前在修订记录中选中的文件路径 */
  commitDetailSelectedPath: string | null;

  /** 操作中标志 */
  operating: boolean;

  /** 树加载状态 */
  treeLoading: boolean;

  /** 是否已加载完整文件树 */
  _fullTreeLoaded: boolean;
  /** 是否展示名称以 "." 开头的文件或文件夹 */
  showHiddenFiles: boolean;
  /** 文件树目录路径索引，避免展开时递归扫描整棵树 */
  _treeNodeByPath: Map<string, FsTreeNode>;
};

export const useExplorerStore = defineStore("explorer", {
  state: (): ExplorerState => ({
    treeNodes: [],
    treeVersion: 0,
    expandedKeys: [],
    selectedPath: null,
    preview: null,
    spreadsheetPreview: null,
    previewType: "none",
    previewLoading: false,
    _previewRequestEpoch: 0,

    viewMode: "files",

    gitStatus: null,
    gitStatusLoading: false,
    _gitStatusRequestEpoch: 0,
    _gitHistoryInvalidationVersion: 0,
    gitRepositories: [],
    selectedGitRepositoryPath: null,
    selectedGitRepositoriesByWorkspace: {},

    gitLogEntries: [],
    gitLogTotal: 0,
    gitLogLoading: false,
    gitLogError: null,
    _gitLogLoadedScope: null,
    _gitLogRequestEpoch: 0,

    gitBranches: [],
    gitBranchLoading: false,

    gitDiffPath: null,
    gitDiffContent: null,
    gitDiffOriginal: null,
    gitDiffModified: null,
    gitDiffStaged: false,
    gitDiffLoading: false,

    gitCommitDetail: null,
    gitCommitDetailLoading: false,
    gitCommitDetailError: null,
    _gitCommitDetailRequestEpoch: 0,

    commitDetailSelectedPath: null,

    operating: false,
    treeLoading: false,
    _fullTreeLoaded: false,
    showHiddenFiles: false,
    _treeNodeByPath: new Map(),
  }),
  persist: {
    pick: ["selectedGitRepositoriesByWorkspace"],
  },

  actions: {
    /** 切工作区时清空投影并使在途读取失效，保留仓库选择偏好。 */
    resetForWorkspace() {
      const selectedGitRepositoriesByWorkspace = { ...this.selectedGitRepositoriesByWorkspace };
      const previewRequestEpoch = this._previewRequestEpoch + 1;
      const gitStatusRequestEpoch = this._gitStatusRequestEpoch + 1;
      const gitLogRequestEpoch = this._gitLogRequestEpoch + 1;
      const gitCommitDetailRequestEpoch = this._gitCommitDetailRequestEpoch + 1;
      this.$reset();
      this._previewRequestEpoch = previewRequestEpoch;
      this._gitStatusRequestEpoch = gitStatusRequestEpoch;
      this._gitLogRequestEpoch = gitLogRequestEpoch;
      this._gitCommitDetailRequestEpoch = gitCommitDetailRequestEpoch;
      pendingGitStatusLoads.delete(this);
      pendingGitLogLoads.delete(this);
      pendingPreviewLoads.delete(this);
      this.selectedGitRepositoriesByWorkspace = selectedGitRepositoriesByWorkspace;
    },

    /** 加载文件树根目录 */
    async loadTree(ctx: ApiRequestContext, workspaceId: WorkspaceId, dirPath?: string) {
      this.treeLoading = true;
      try {
        const res = await fetchFsTree(ctx, { workspaceId, dirPath: dirPath ?? "", depth: 1, showHidden: this.showHiddenFiles });
        if (res.ok) {
          if (!dirPath) {
            this.treeNodes = (res as any).nodes ?? [];
            this._rebuildTreeIndex();
            this._fullTreeLoaded = false;
            // 刷新后重新加载已展开目录的子节点（按深度排序，保证父目录先加载）
            await this._reExpandDirs(ctx, workspaceId);
            // 根树整体被重建后，强制重建 Tree，避免 antd 复用旧的 loadedKeys。
            this.treeVersion += 1;
          }
          return (res as any).nodes as FsTreeNode[] ?? [];
        }
        return [];
      } finally {
        this.treeLoading = false;
      }
    },

    /** 加载完整文件树（用于搜索），只加载一次 */
    async loadFullTree(ctx: ApiRequestContext, workspaceId: WorkspaceId) {
      if (this._fullTreeLoaded) return;
      this.treeLoading = true;
      try {
        const res = await fetchFsTree(ctx, { workspaceId, dirPath: "", depth: 99, showHidden: this.showHiddenFiles });
        if (res.ok) {
          this.treeNodes = (res as any).nodes ?? [];
          this._rebuildTreeIndex();
          this._fullTreeLoaded = true;
          this.treeVersion += 1;
        }
      } finally {
        this.treeLoading = false;
      }
    },

    /** 展开目录（懒加载子节点） */
    async expandDir(ctx: ApiRequestContext, workspaceId: WorkspaceId, dirPath: string) {
      const res = await fetchFsTree(ctx, { workspaceId, dirPath, depth: 1, showHidden: this.showHiddenFiles });
      if (res.ok) {
        const children = (res as any).nodes as FsTreeNode[] ?? [];
        this._insertChildren(dirPath, children);
        if (!this.expandedKeys.includes(dirPath)) {
          this.expandedKeys.push(dirPath);
        }
        return children;
      }
      return [];
    },

    /** 将子节点插入到指定目录下 */
    _insertChildren(dirPath: string, children: FsTreeNode[]) {
      const target = this._treeNodeByPath.get(dirPath);
      if (!target?.isDir) {
        this._rebuildTreeIndex();
        const retryTarget = this._treeNodeByPath.get(dirPath);
        if (!retryTarget?.isDir) {
          throw new Error(`文件树目录节点不存在：${dirPath}`);
        }
        this._deleteTreeIndexNodes(retryTarget.children ?? []);
        retryTarget.children = children;
        this._indexTreeNodes(children);
        return;
      }
      this._deleteTreeIndexNodes(target.children ?? []);
      target.children = children;
      this._indexTreeNodes(children);
    },

    /** 重建目录路径索引，供后续懒加载插入直接定位。 */
    _rebuildTreeIndex() {
      this._treeNodeByPath = new Map();
      this._indexTreeNodes(this.treeNodes);
    },

    /** 将新加载的子树写入路径索引。 */
    _indexTreeNodes(nodes: FsTreeNode[]) {
      for (const node of nodes) {
        if (node.isDir) {
          this._treeNodeByPath.set(node.path, node);
        }
        if (node.children) {
          this._indexTreeNodes(node.children);
        }
      }
    },

    /** 移除被替换子树的目录索引，避免刷新后残留旧路径。 */
    _deleteTreeIndexNodes(nodes: FsTreeNode[]) {
      for (const node of nodes) {
        if (node.isDir) {
          this._treeNodeByPath.delete(node.path);
        }
        if (node.children) {
          this._deleteTreeIndexNodes(node.children);
        }
      }
    },

    /** 切换隐藏文件展示状态，并按当前搜索模式重建文件树。 */
    async setShowHiddenFiles(ctx: ApiRequestContext, workspaceId: WorkspaceId, showHidden: boolean, loadFull: boolean) {
      if (this.showHiddenFiles === showHidden) return;
      this.showHiddenFiles = showHidden;
      this.expandedKeys = [];
      this.treeNodes = [];
      this._treeNodeByPath = new Map();
      this._fullTreeLoaded = false;
      this.treeVersion += 1;
      if (loadFull) {
        await this.loadFullTree(ctx, workspaceId);
      } else {
        await this.loadTree(ctx, workspaceId);
      }
    },

    /** 刷新后按深度逐层重新加载已展开目录的子节点 */
    async _reExpandDirs(ctx: ApiRequestContext, workspaceId: WorkspaceId) {
      const keys = [...this.expandedKeys];
      if (!keys.length) return;
      // 按路径深度分组（浅层先加载，确保父节点存在后再插入子节点）
      const byDepth = new Map<number, string[]>();
      for (const key of keys) {
        const depth = key.split("/").length;
        let list = byDepth.get(depth);
        if (!list) { list = []; byDepth.set(depth, list); }
        list.push(key);
      }
      const depths = [...byDepth.keys()].sort((a, b) => a - b);
      for (const depth of depths) {
        const batch = byDepth.get(depth)!;
        const existingBatch = batch.filter((dirPath) => {
          if (!this._treeNodeByPath.has(dirPath)) {
            this.expandedKeys = this.expandedKeys.filter((key) => key !== dirPath);
            return false;
          }
          return true;
        });
        await Promise.all(existingBatch.map((dirPath) => this.expandDir(ctx, workspaceId, dirPath)));
      }
    },

    /** 选中文件并复用预览读取入口，同时清除之前的 diff。 */
    async selectFile(ctx: ApiRequestContext, workspaceId: WorkspaceId, filePath: string) {
      this.selectedPath = filePath;
      // 清空 git diff（选文件时优先显示文件内容）
      this.gitDiffPath = null;
      this.gitDiffContent = null;
      this.gitDiffOriginal = null;
      this.gitDiffModified = null;

      await this.loadPreview(ctx, workspaceId, filePath);
    },

    /** 合并相同选择的在途预览；仅最新选择可写回，不缓存已完成内容或清除 diff。 */
    async loadPreview(ctx: ApiRequestContext, workspaceId: WorkspaceId, filePath: string) {
      const scopeKey = JSON.stringify([ctx.serverWsOrigin, ctx.webSessionId ?? null, ctx.desktopClientId ?? null, ctx.sessionToken ?? null, workspaceId, filePath]);
      const existing = pendingPreviewLoads.get(this);
      if (existing?.epoch === this._previewRequestEpoch && existing.scopeKey === scopeKey) return existing.promise;
      const epoch = ++this._previewRequestEpoch;
      this.previewLoading = true;
      this.preview = null;
      this.spreadsheetPreview = null;
      this.previewType = "none";
      const loading = (async () => {
        try {
          const result = await loadWorkspaceFilePreview(ctx, workspaceId, filePath);
          if (this._previewRequestEpoch !== epoch) return;
          this.preview = result.preview;
          this.spreadsheetPreview = result.spreadsheet;
          this.previewType = result.previewType;
        } finally {
          if (this._previewRequestEpoch === epoch) this.previewLoading = false;
          if (pendingPreviewLoads.get(this)?.epoch === epoch) pendingPreviewLoads.delete(this);
        }
      })();
      pendingPreviewLoads.set(this, { epoch, scopeKey, promise: loading });
      return loading;
    },

    /** 切换工作表并保留读取期间的内容；新选择或工作区切换后禁止旧结果写回。 */
    async loadSpreadsheetSheet(ctx: ApiRequestContext, workspaceId: WorkspaceId, filePath: string, sheetName: string) {
      const epoch = ++this._previewRequestEpoch;
      pendingPreviewLoads.delete(this);
      this.previewLoading = true;
      try {
        const result = await loadWorkspaceFilePreview(ctx, workspaceId, filePath, { sheetName });
        if (this._previewRequestEpoch !== epoch) return;
        this.preview = result.preview;
        this.spreadsheetPreview = result.spreadsheet;
        this.previewType = result.previewType;
      } finally {
        if (this._previewRequestEpoch === epoch) this.previewLoading = false;
      }
    },

    /** 切换视图模式 */
    setViewMode(mode: ExplorerViewMode) {
      this.viewMode = mode;
    },

    // ---- Git 操作 ----

    /** 生成当前 Git 请求作用域；repositoryPath 为空字符串表示 workspace 根仓库。 */
    gitRequestScope(workspaceId: WorkspaceId): { workspaceId: WorkspaceId; repositoryPath?: string | null } {
      const saved = this.selectedGitRepositoriesByWorkspace[String(workspaceId)];
      const repositoryPath = this.selectedGitRepositoryPath ?? saved;
      // 空字符串与 null 都表示工作区根仓库，统一作用域避免缓存键分叉。
      return repositoryPath ? { workspaceId, repositoryPath } : { workspaceId };
    },

    /** 记住指定 workspace 的 Git 仓库选择。 */
    rememberGitRepository(workspaceId: WorkspaceId, repositoryPath: string | null) {
      const key = String(workspaceId);
      const next = { ...this.selectedGitRepositoriesByWorkspace };
      if (repositoryPath == null) delete next[key];
      else next[key] = repositoryPath;
      this.selectedGitRepositoriesByWorkspace = next;
    },

    /** 切换 Git 仓库并清理旧仓库的 diff、历史和分支缓存。 */
    async selectGitRepository(ctx: ApiRequestContext, workspaceId: WorkspaceId, repositoryPath: string) {
      if (this.selectedGitRepositoryPath === repositoryPath) return;
      this.selectedGitRepositoryPath = repositoryPath;
      this.rememberGitRepository(workspaceId, repositoryPath);
      this.clearGitRepositoryViewState();
      this.gitStatus = null;
      await this.refreshGitStatus(ctx, workspaceId);
    },

    /** 清理依赖仓库根的 Git 视图状态，避免切换后展示旧仓库内容。 */
    clearGitRepositoryViewState() {
      this.selectedPath = null;
      this.preview = null;
      this.spreadsheetPreview = null;
      this.previewType = "none";
      this.gitDiffPath = null;
      this.gitDiffContent = null;
      this.gitDiffOriginal = null;
      this.gitDiffModified = null;
      this.clearGitCommitDetail();
      this.gitLogEntries = [];
      this.gitLogTotal = 0;
      this._gitLogLoadedScope = null;
      this._gitLogRequestEpoch++;
      this.gitLogLoading = false;
      this.gitLogError = null;
      pendingGitLogLoads.delete(this);
      this.gitBranches = [];
    },

    /** 同作用域复用读取；已有快照时后台检查，首次读取才进入加载展示。 */
    async refreshGitStatus(ctx: ApiRequestContext, workspaceId: WorkspaceId) {
      const scope = this.gitRequestScope(workspaceId);
      const scopeKey = this.gitRepositoryScopeKey(ctx, workspaceId);
      const existing = pendingGitStatusLoads.get(this);
      if (existing?.epoch === this._gitStatusRequestEpoch && existing.scopeKey === scopeKey) return existing.promise;
      const requestEpoch = ++this._gitStatusRequestEpoch;
      this.gitStatusLoading = !this.gitStatus;
      const loading = (async () => {
        try {
          const res = await fetchGitStatusSingleflight(ctx, scope);
          if (!res.ok) throw createApiResultError(res);
          if (this._gitStatusRequestEpoch !== requestEpoch || this.gitRepositoryScopeKey(ctx, workspaceId) !== scopeKey) return;
          const active = pendingGitStatusLoads.get(this);
          if (active?.epoch === requestEpoch) active.historyCount = Math.max(active.historyCount, this.gitHistoryRequestedCount(ctx, workspaceId));
          const data = res as GitStatusResult;
          this._applyGitStatusSnapshot(workspaceId, data);
          cacheGitStatusResult(ctx, workspaceId, scope, data);
        } finally {
          if (this._gitStatusRequestEpoch === requestEpoch) this.gitStatusLoading = false;
        }
      })().finally(() => {
        if (pendingGitStatusLoads.get(this)?.epoch === requestEpoch) pendingGitStatusLoads.delete(this);
      });
      pendingGitStatusLoads.set(this, { epoch: requestEpoch, scopeKey, historyCount: this.gitHistoryRequestedCount(ctx, workspaceId), promise: loading });
      return loading;
    },

    /** 统一刷新并保留页数；自动刷新复用同 HEAD，手动可强制，作用域失效后停止读取。 */
    async refreshGitView(ctx: ApiRequestContext, workspaceId: WorkspaceId, forceHistory = false): Promise<void> {
      const scopeKey = this.gitRepositoryScopeKey(ctx, workspaceId);
      const refreshing = this.refreshGitStatus(ctx, workspaceId);
      const statusLoad = pendingGitStatusLoads.get(this);
      const statusEpoch = this._gitStatusRequestEpoch;
      await refreshing;
      if (this._gitStatusRequestEpoch !== statusEpoch || this.gitRepositoryScopeKey(ctx, workspaceId) !== scopeKey
        || this.viewMode !== "log" || !this.gitStatus?.isRepo) return;
      const count = Math.max(statusLoad?.historyCount ?? 20, this.gitHistoryRequestedCount(ctx, workspaceId));
      const historyLoad = statusLoad?.historyLoad;
      if (historyLoad?.epoch === this._gitLogRequestEpoch && historyLoad.scopeKey === this.gitHistoryScopeKey(ctx, workspaceId)
        && historyLoad.skip === 0 && historyLoad.maxCount >= count) return historyLoad.promise;
      await this.loadGitLog(ctx, workspaceId, count, 0, forceHistory);
    },

    /**
     * 会话工具改动工作区后让 Git 状态缓存立即失效。
     * 即使 Git 面板当前不可见也要调用，否则 60s 内切回面板会命中命令前的旧快照。
     */
    invalidateGitStatus(ctx: ApiRequestContext, workspaceId: WorkspaceId): void {
      gitStatusCache.delete(gitStatusRequestKey(ctx, { workspaceId }));
      gitStatusCache.delete(gitStatusRequestKey(ctx, this.gitRequestScope(workspaceId)));
    },

    /** 自动刷新路径优先复用短 TTL 缓存；缓存失效时再回退到真实请求。 */
    async refreshGitStatusCached(ctx: ApiRequestContext, workspaceId: WorkspaceId) {
      const scope = this.gitRequestScope(workspaceId);
      const requestKey = gitStatusRequestKey(ctx, scope);
      const cached = readCachedGitStatusResult(requestKey);
      if (cached) {
        this._applyGitStatusSnapshot(workspaceId, cached);
        this.gitStatusLoading = false;
        return;
      }
      await this.refreshGitStatus(ctx, workspaceId);
    },

    /** 统一应用 Git 状态快照；不可缓存历史须失效旧分页及在途请求，即使 HEAD 不变。 */
    _applyGitStatusSnapshot(workspaceId: WorkspaceId, data: GitStatusResult) {
      if (data.historyCacheable === false) {
        this._gitLogRequestEpoch++;
        this._gitHistoryInvalidationVersion++;
        this._gitLogLoadedScope = null;
        this.gitLogLoading = false;
      }
      if (this.gitStatus && gitStatusSnapshotKey(this.gitStatus) === gitStatusSnapshotKey(data)) return;
      this.gitStatus = data;
      this.gitRepositories = data.repositories ?? [];
      this.selectedGitRepositoryPath = data.repositoryPath;
      this.rememberGitRepository(workspaceId, data.repositoryPath);
    },

    /** 读取当前仓库内指定文件的 diff 对比内容。 */
    async loadGitDiff(ctx: ApiRequestContext, workspaceId: WorkspaceId, path: string, staged: boolean) {
      this.gitDiffLoading = true;
      this.gitDiffPath = path;
      this.gitDiffStaged = staged;
      this.gitDiffOriginal = null;
      this.gitDiffModified = null;
      this.gitDiffContent = null;
      try {
        const res = await fetchGitDiffFiles(ctx, { ...this.gitRequestScope(workspaceId), path, staged });
        if (res.ok) {
          const data = res as any;
          this.gitDiffOriginal = data.original ?? "";
          this.gitDiffModified = data.modified ?? "";
          // 新增文件（original 为空）不走 diff 视图，回退到普通预览
          if (!this.gitDiffOriginal) {
            this.gitDiffContent = "";
          } else {
            this.gitDiffContent = (data.original !== data.modified) ? "has-diff" : "";
          }
        }
      } finally {
        this.gitDiffLoading = false;
      }
    },

    /** 将当前仓库内的指定文件加入暂存区。 */
    async gitStage(ctx: ApiRequestContext, workspaceId: WorkspaceId, paths: string[]) {
      this.operating = true;
      try {
        await fetchGitStage(ctx, { ...this.gitRequestScope(workspaceId), paths });
        await this.refreshGitStatus(ctx, workspaceId);
      } finally {
        this.operating = false;
      }
    },

    /** 将当前仓库内的指定文件移出暂存区。 */
    async gitUnstage(ctx: ApiRequestContext, workspaceId: WorkspaceId, paths: string[]) {
      this.operating = true;
      try {
        await fetchGitUnstage(ctx, { ...this.gitRequestScope(workspaceId), paths });
        await this.refreshGitStatus(ctx, workspaceId);
      } finally {
        this.operating = false;
      }
    },

    /** 丢弃当前仓库内指定文件的工作区改动。 */
    async gitDiscard(ctx: ApiRequestContext, workspaceId: WorkspaceId, paths: string[]) {
      this.operating = true;
      try {
        await fetchGitDiscard(ctx, { ...this.gitRequestScope(workspaceId), paths });
        await this.refreshGitStatus(ctx, workspaceId);
      } finally {
        this.operating = false;
      }
    },

    /** 使用当前仓库暂存区创建提交。 */
    async gitCommit(ctx: ApiRequestContext, workspaceId: WorkspaceId, message: string, amend: boolean) {
      this.operating = true;
      try {
        const res = await fetchGitCommit(ctx, { ...this.gitRequestScope(workspaceId), message, amend });
        if (res.ok) {
          await this.refreshGitStatus(ctx, workspaceId);
          return { ok: true as const, hash: (res as any).hash, message: (res as any).message };
        }
        return { ok: false as const, error: (res as any).message || "未知错误" };
      } finally {
        this.operating = false;
      }
    },

    /** 固定提交读取绑定身份、工作区和仓库，当前分支推进不改变指定提交身份。 */
    gitRepositoryScopeKey(ctx: ApiRequestContext, workspaceId: WorkspaceId): string {
      return JSON.stringify([gitStatusRequestKey(ctx, this.gitRequestScope(workspaceId)), ctx.desktopClientId ?? null]);
    },

    /** 列表额外绑定 HEAD 与历史缓存条件，不能把浅库与完整历史的列表互相复用。 */
    gitHistoryScopeKey(ctx: ApiRequestContext, workspaceId: WorkspaceId): string {
      return JSON.stringify([this.gitRepositoryScopeKey(ctx, workspaceId), this.gitStatus?.headCommit ?? null, this.gitStatus?.historyCacheable ?? null]);
    },

    /** 已展示条目和当前有效分页共同决定重读数量，旧作用域或被取代请求不扩大范围。 */
    gitHistoryRequestedCount(ctx: ApiRequestContext, workspaceId: WorkspaceId): number {
      const scopeKey = this.gitHistoryScopeKey(ctx, workspaceId);
      let count = Math.max(20, this.gitLogEntries.length);
      const statusLoad = pendingGitStatusLoads.get(this);
      if (statusLoad?.epoch === this._gitStatusRequestEpoch && statusLoad.scopeKey === this.gitRepositoryScopeKey(ctx, workspaceId)) {
        count = Math.max(count, statusLoad.historyCount);
      }
      for (const load of pendingGitLogLoads.get(this)?.values() ?? []) {
        if (load.epoch === this._gitLogRequestEpoch && load.scopeKey === scopeKey) count = Math.max(count, load.skip + load.maxCount);
      }
      return count;
    },

    /** 同页在途请求覆盖所需数量时复用；保留分页，手动可绕过缓存，失败可重试。 */
    async loadGitLog(ctx: ApiRequestContext, workspaceId: WorkspaceId, maxCount = 20, skip = 0, force = false): Promise<void> {
      const scopeKey = this.gitHistoryScopeKey(ctx, workspaceId);
      const pending = pendingGitLogLoads.get(this) ?? new Map<string, GitLogLoad>();
      if (this._gitLogLoadedScope !== scopeKey) skip = 0;
      const requestKey = JSON.stringify([scopeKey, maxCount, skip]);
      const existing = [...pending.values()].find(load => load.epoch === this._gitLogRequestEpoch
        && load.scopeKey === scopeKey && load.skip === skip && load.maxCount >= maxCount);
      if (existing) return existing.promise;
      if (!force && skip === 0 && this.gitStatus?.historyCacheable !== false && this._gitLogLoadedScope === scopeKey && !this.gitLogError) return;
      pendingGitLogLoads.set(this, pending);
      const epoch = ++this._gitLogRequestEpoch;
      const scope = this.gitRequestScope(workspaceId), headCommit = this.gitStatus?.headCommit;
      const repositoryScopeKey = this.gitRepositoryScopeKey(ctx, workspaceId);
      if (this._gitLogLoadedScope !== scopeKey) {
        // 同一 HEAD 用精确缓存，HEAD 刚变化时用同仓库最近列表兜底，随后仍以后台结果为准。
        const cached = this.gitStatus?.historyCacheable === false ? null
          : gitLogCacheByScope.get(scopeKey) ?? findRecentGitLog(repositoryScopeKey);
        if (cached) {
          this.gitLogEntries = [...cached.entries];
          this.gitLogTotal = cached.total;
          this._gitLogLoadedScope = scopeKey;
        } else {
          this.gitLogEntries = [];
          this.gitLogTotal = 0;
          this._gitLogLoadedScope = null;
        }
      }
      this.gitLogLoading = true;
      this.gitLogError = null;
      const loading = (async () => {
        try {
          const res = await fetchGitLog(ctx, { ...scope, maxCount, skip, headCommit });
          if (!res.ok) throw createApiResultError(res);
          if (this._gitLogRequestEpoch !== epoch || this.gitHistoryScopeKey(ctx, workspaceId) !== scopeKey) return;
          this.gitLogEntries = skip === 0 ? res.entries : [...new Map([...this.gitLogEntries, ...res.entries].map(entry => [entry.hash, entry])).values()];
          this.gitLogTotal = res.total;
          this._gitLogLoadedScope = scopeKey;
          if (this.gitStatus?.historyCacheable !== false) rememberGitLog(scopeKey, repositoryScopeKey, this.gitLogEntries, this.gitLogTotal);
        } catch (error) {
          if (this._gitLogRequestEpoch === epoch && this.gitHistoryScopeKey(ctx, workspaceId) === scopeKey) this.gitLogError = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          if (this._gitLogRequestEpoch === epoch) this.gitLogLoading = false;
          if (pending.get(requestKey)?.epoch === epoch) pending.delete(requestKey);
        }
      })();
      const load = { epoch, scopeKey, maxCount, skip, promise: loading };
      pending.set(requestKey, load);
      const statusLoad = pendingGitStatusLoads.get(this);
      if (skip === 0 && statusLoad?.epoch === this._gitStatusRequestEpoch && statusLoad.scopeKey === repositoryScopeKey) {
        statusLoad.historyLoad = load;
      }
      return loading;
    },

    /** 关闭详情并使在途读取失效，返回列表后迟到的 patch 不得重新打开页面。 */
    clearGitCommitDetail() {
      this._gitCommitDetailRequestEpoch++;
      this.gitCommitDetail = null;
      this.gitCommitDetailLoading = false;
      this.gitCommitDetailError = null;
      this.commitDetailSelectedPath = null;
    },

    /** 按指定 hash 读取元数据或 patch；HEAD 更新不丢弃响应，仓库切换和关闭仍使请求失效。 */
    async loadGitCommitDetail(ctx: ApiRequestContext, workspaceId: WorkspaceId, hash: string, includeDiff = false) {
      const epoch = ++this._gitCommitDetailRequestEpoch;
      const scopeKey = this.gitRepositoryScopeKey(ctx, workspaceId);
      this.gitCommitDetailLoading = true;
      this.gitCommitDetailError = null;
      if (this.gitCommitDetail?.entry.hash !== hash) this.gitCommitDetail = null;
      this.commitDetailSelectedPath = null;
      try {
        const res = await fetchGitShow(ctx, { ...this.gitRequestScope(workspaceId), hash, includeDiff });
        if (!res.ok) throw createApiResultError(res);
        if (this._gitCommitDetailRequestEpoch === epoch && this.gitRepositoryScopeKey(ctx, workspaceId) === scopeKey) this.gitCommitDetail = res;
      } catch (error) {
        if (this._gitCommitDetailRequestEpoch === epoch && this.gitRepositoryScopeKey(ctx, workspaceId) === scopeKey) this.gitCommitDetailError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        if (this._gitCommitDetailRequestEpoch === epoch) this.gitCommitDetailLoading = false;
      }
    },

    /** 加载当前仓库内某次提交的单文件 diff。 */
    async loadCommitFileDiff(ctx: ApiRequestContext, workspaceId: WorkspaceId, hash: string, path: string) {
      this.commitDetailSelectedPath = path;
      this.gitDiffLoading = true;
      this.gitDiffPath = path;
      this.gitDiffOriginal = null;
      this.gitDiffModified = null;
      this.gitDiffContent = null;
      try {
        const res = await fetchGitShowFileDiff(ctx, { ...this.gitRequestScope(workspaceId), hash, path });
        if (res.ok) {
          const data = res as any;
          this.gitDiffOriginal = data.original ?? "";
          this.gitDiffModified = data.modified ?? "";
          this.gitDiffContent = "has-diff";
        }
      } finally {
        this.gitDiffLoading = false;
      }
    },

    /** 加载当前仓库分支列表。 */
    async loadGitBranches(ctx: ApiRequestContext, workspaceId: WorkspaceId) {
      this.gitBranchLoading = true;
      try {
        const res = await fetchGitBranchList(ctx, this.gitRequestScope(workspaceId));
        if (res.ok) {
          this.gitBranches = (res as any).branches ?? [];
        }
      } finally {
        this.gitBranchLoading = false;
      }
    },

    /** 在当前仓库创建分支。 */
    async gitBranchCreate(ctx: ApiRequestContext, workspaceId: WorkspaceId, name: string, startPoint?: string) {
      this.operating = true;
      try {
        await fetchGitBranchCreate(ctx, { ...this.gitRequestScope(workspaceId), name, startPoint });
        await this.loadGitBranches(ctx, workspaceId);
      } finally {
        this.operating = false;
      }
    },

    /** 切换当前仓库分支，并刷新状态与分支列表。 */
    async gitBranchSwitch(ctx: ApiRequestContext, workspaceId: WorkspaceId, name: string) {
      this.operating = true;
      try {
        await fetchGitBranchSwitch(ctx, { ...this.gitRequestScope(workspaceId), name });
        await Promise.all([
          this.loadGitBranches(ctx, workspaceId),
          this.refreshGitStatus(ctx, workspaceId),
        ]);
      } finally {
        this.operating = false;
      }
    },

    /** 删除当前仓库分支。 */
    async gitBranchDelete(ctx: ApiRequestContext, workspaceId: WorkspaceId, name: string, force?: boolean) {
      this.operating = true;
      try {
        await fetchGitBranchDelete(ctx, { ...this.gitRequestScope(workspaceId), name, force });
        await this.loadGitBranches(ctx, workspaceId);
      } finally {
        this.operating = false;
      }
    },
  },
});

export type ExplorerStore = ReturnType<typeof useExplorerStore>;
