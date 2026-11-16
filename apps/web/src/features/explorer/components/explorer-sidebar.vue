<script setup lang="ts">
import { computed, h, onBeforeUnmount, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import {
  PlusOutlined, MinusOutlined, UndoOutlined,
  UnorderedListOutlined, ApartmentOutlined,
  ExpandAltOutlined, ShrinkOutlined,
  CheckOutlined, ArrowLeftOutlined,
  ReloadOutlined, SwapOutlined,
  EyeOutlined, EyeInvisibleOutlined,
  DatabaseOutlined, LoadingOutlined,
} from "@ant-design/icons-vue";
import { parseSharedWorkspaceSelectionId, type FsSearchIndexStatus, type GitRepositoryInfo, type WorkspaceId } from "@codeflowai/shared";
import type { ApiRequestContext } from "../../../api/request";
import { fetchFsSearch, uploadWorkspaceFile } from "../../../api/fs";
import { getSharedWorkspaceFileTransferPolicy } from "../../../api/sharedWorkspaces";
import { trackProductEvent } from "../../../analytics/analytics";
import { useConfigStore } from "../../../store/config";
import { useExplorerStore } from "../../../store/explorer";
import { usePresenceStore } from "../../../store/presence";
import { useWorkspacesStore } from "../../../store/workspaces";
import { isDesktopWorkspace } from "../../../services/desktop";
import FileTree from "./file-tree.vue";
import GitChangesPanel from "./git-changes-panel.vue";
import GitStatusBar from "./git-status-bar.vue";
import GitCommitFilesPanel from "./git-commit-files-panel.vue";
import GitLogPanel from "./git-log-panel.vue";

defineOptions({ name: "ExplorerSidebar" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  ctx: ApiRequestContext;
  surface?: "default" | "h5";
}>();

const emit = defineEmits<{
  (e: "selectFile", path: string): void;
  (e: "selectGitFile", path: string, staged: boolean): void;
  (e: "selectCommitFile", path: string): void;
}>();

const explorer = useExplorerStore();
const config = useConfigStore();
const presence = usePresenceStore();
const workspaces = useWorkspacesStore();
/** 桌面本机工作区不依赖 Server 连接；其余工作区仍需 Server 与 Client 在线。 */
const workspaceClientOnline = computed(() =>
  presence.isCurrentWorkspaceClientOnline
  && (config.connected || isDesktopWorkspace(config, props.workspaceId)));
const searchInput = ref("");
const searchKeyword = ref("");
const searchRevision = ref(0);
const repositorySearchInput = ref("");
const gitPanelRef = ref<InstanceType<typeof GitChangesPanel>>();
const uploadInputRef = ref<HTMLInputElement | null>(null);
const uploadTargetDir = ref<string | null>(null);
const uploadingFile = ref(false);
const checkingUploadPermission = ref(false);
const fileIndexStatus = ref<FsSearchIndexStatus | null>(null);
const fileIndexStatusNotice = ref("");
const fileIndexPolling = ref(false);
let fileIndexStatusTimer: ReturnType<typeof setTimeout> | null = null;
const FILE_INDEX_MESSAGE_KEY = "explorer-file-index-build";
const GIT_AHEAD_REFRESH_INTERVAL_MS = 60_000;
// 使用非目录查询探测索引状态，避免空查询走目录枚举快路径而缺少 indexStatus。
const FILE_INDEX_STATUS_PROBE_QUERY = "__codeflow_file_index_status_probe__";
let gitAheadRefreshTimer: ReturnType<typeof setTimeout> | null = null;

const viewMode = computed({
  get: () => explorer.viewMode,
  set: (v) => explorer.setViewMode(v),
});

const viewModeOptions = [
  { label: '文件', value: 'files' },
  { label: 'Git 视图', value: 'git' },
  { label: 'Git 历史', value: 'log' },
];

const repositoryOptions = computed(() => explorer.gitRepositories.map((repo) => ({
  label: gitRepositoryLabel(repo),
  value: repo.path,
  title: repo.path || "工作区根仓库",
})));

/** 仓库切换弹层按展示名和路径做本地过滤。 */
const filteredRepositoryOptions = computed(() => {
  const keyword = repositorySearchInput.value.trim().toLowerCase();
  if (!keyword) return repositoryOptions.value;
  return repositoryOptions.value.filter((option) => (
    option.label.toLowerCase().includes(keyword)
    || option.value.toLowerCase().includes(keyword)
    || option.title.toLowerCase().includes(keyword)
  ));
});

const repositorySelectValue = computed(() => explorer.selectedGitRepositoryPath ?? explorer.gitRepositories[0]?.path ?? "");
const showRepositorySwitcher = computed(() => explorer.gitRepositories.length > 1);
const currentWorkspace = computed(() => workspaces.byId.get(props.workspaceId) ?? null);
const selectedRepositoryLabel = computed(() => {
  const selectedPath = repositorySelectValue.value;
  const repo = explorer.gitRepositories.find((item) => item.path === selectedPath) ?? explorer.gitRepositories[0];
  return repo ? gitRepositoryLabel(repo) : "";
});
const sharedUploadUnavailableReason = computed(() => {
  const workspace = currentWorkspace.value;
  if (!workspace || (workspace.kind !== "shared" && !workspace.shared)) return "";
  if (workspace.entryStatus && workspace.entryStatus !== "available") {
    return workspace.disabledReason || "共享工作区当前不可用";
  }
  return "";
});
const fileIndexStatusClass = computed(() => ({
  "explorer-sidebar__index-status--active": fileIndexPolling.value || fileIndexStatus.value === "queued" || fileIndexStatus.value === "building",
  "explorer-sidebar__index-status--ready": fileIndexStatus.value === "ready",
  "explorer-sidebar__index-status--error": fileIndexStatus.value === "failed" || fileIndexStatus.value === "disabled",
}));

/** 展示仓库名；子仓库优先展示 workspace 相对路径，避免同名目录混淆。 */
function gitRepositoryLabel(repo: GitRepositoryInfo): string {
  return repo.path || repo.name;
}

/** 当用户切离 log 模式时，清空 commit detail 相关状态 */
watch(
  () => explorer.viewMode,
  (mode) => {
    if (mode !== "log") {
      explorer.clearGitCommitDetail();
    }
  },
);

/** workspace 切换时清理当前索引状态提示，避免展示上一个工作区的信息。 */
watch(
  () => props.workspaceId,
  () => {
    uploadTargetDir.value = null;
    clearFileIndexStatusTimer();
    fileIndexStatus.value = null;
    fileIndexStatusNotice.value = "";
    fileIndexPolling.value = false;
    closeFileIndexBuildMessage();
  },
);

function onSelectFile(path: string) {
  emit("selectFile", path);
}

function onSelectGitFile(path: string, staged: boolean) {
  emit("selectGitFile", path, staged);
}

function onSelectCommitFile(path: string) {
  emit("selectCommitFile", path);
}

/** 是否在历史模式下查看 commit 详情（需要显示返回按钮） */
const isCommitDetailInLog = computed(() => explorer.viewMode === "log" && !!explorer.gitCommitDetail);

/** 返回历史列表 */
function goBackToLog() {
  explorer.clearGitCommitDetail();
  explorer.gitDiffPath = null;
  explorer.gitDiffContent = null;
  explorer.gitDiffOriginal = null;
  explorer.gitDiffModified = null;
}

function doSearch() {
  searchKeyword.value = searchInput.value;
}

function onSearchClear() {
  searchInput.value = "";
  searchKeyword.value = "";
}

/** 切换隐藏文件展示状态；搜索结果由 FileTree 按关键词重新拉取。 */
async function toggleHiddenFiles() {
  await explorer.setShowHiddenFiles(props.ctx, props.workspaceId, !explorer.showHiddenFiles, false);
}

/** 切换当前 Git 视图仓库，并记住该 workspace 的选择。 */
async function onRepositoryChange(value: string | number) {
  await explorer.selectGitRepository(props.ctx, props.workspaceId, String(value));
}

/** 从状态栏仓库菜单切换仓库。 */
async function onRepositoryMenuClick(info: { key: string | number }) {
  await onRepositoryChange(info.key);
  repositorySearchInput.value = "";
}

const refreshing = ref(false);

/** 通过 Store 统一刷新 Git 视图，历史读取保留当前分页并合并 watcher 请求。 */
async function doRefresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    if (viewMode.value === "files") {
      await explorer.loadTree(props.ctx, props.workspaceId);
    } else {
      await explorer.refreshGitView(props.ctx, props.workspaceId, true);
    }
  } catch (error) {
    const failure = error as { code?: unknown; details?: { requestId?: unknown; serverRequestId?: unknown } };
    console.error("[EXPLORER_REFRESH_FAILED]", { code: failure?.code ?? "EXPLORER_REFRESH_FAILED",
      requestId: failure?.details?.requestId ?? failure?.details?.serverRequestId ?? null,
      workspaceId: props.workspaceId, repositoryPath: explorer.selectedGitRepositoryPath, viewMode: viewMode.value,
      cause: error instanceof Error ? error.message : String(error) });
    message.error(error instanceof Error ? error.message : "刷新失败");
  } finally {
    refreshing.value = false;
  }
}

/** 判断当前 Explorer 是否正在展示 Git 相关面板。 */
function isGitPanelVisible(): boolean {
  return (viewMode.value === "git" || viewMode.value === "log")
    && typeof document !== "undefined"
    && !document.hidden;
}

/** 仅在 Git 面板可见时刷新状态，并继续安排 ahead 低频复查。 */
async function refreshVisibleGitStatus(): Promise<void> {
  if (
    !isGitPanelVisible()
    || !workspaceClientOnline.value
    || String(config.workspaceId ?? "") !== String(props.workspaceId)
  ) return;
  if (explorer.gitStatusLoading) {
    scheduleGitAheadRefresh();
    return;
  }
  try {
    await explorer.refreshGitStatusCached(props.ctx, props.workspaceId);
    scheduleGitAheadRefresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : "刷新 Git 状态失败");
  }
}

/** Git 面板可见且 ahead 非零时低频复查，归零或切离面板后立即停止。 */
function scheduleGitAheadRefresh(): void {
  clearGitAheadRefreshTimer();
  if (
    !isGitPanelVisible()
    || Number(explorer.gitStatus?.ahead ?? 0) <= 0
    || !workspaceClientOnline.value
    || String(config.workspaceId ?? "") !== String(props.workspaceId)
  ) return;
  gitAheadRefreshTimer = setTimeout(() => {
    gitAheadRefreshTimer = null;
    void refreshVisibleGitStatus();
  }, GIT_AHEAD_REFRESH_INTERVAL_MS);
}

/** 清理 ahead 状态刷新计时器。 */
function clearGitAheadRefreshTimer(): void {
  if (!gitAheadRefreshTimer) return;
  clearTimeout(gitAheadRefreshTimer);
  gitAheadRefreshTimer = null;
}

watch(
  () => [explorer.gitStatus?.ahead, explorer.viewMode, workspaceClientOnline.value, props.workspaceId] as const,
  scheduleGitAheadRefresh,
  { immediate: true },
);

/** 进入 Git 相关面板或 Host 恢复在线时才主动读取一次状态。 */
watch(
  () => [explorer.viewMode, props.workspaceId, workspaceClientOnline.value] as const,
  ([mode, , clientOnline]) => {
    clearGitAheadRefreshTimer();
    if ((mode !== "git" && mode !== "log") || !clientOnline) return;
    void refreshVisibleGitStatus();
  },
  { immediate: true },
);

/** 轮询索引状态，直到后台构建完成或进入终态。 */
async function pollFileIndexStatus(): Promise<void> {
  clearFileIndexStatusTimer();
  try {
    const result = await fetchFsSearch(props.ctx, {
      workspaceId: props.workspaceId,
      query: FILE_INDEX_STATUS_PROBE_QUERY,
      limit: 1,
      includeHidden: explorer.showHiddenFiles,
      kind: "all",
    });
    if (!result.ok) {
      fileIndexPolling.value = false;
      fileIndexStatus.value = "failed";
      fileIndexStatusNotice.value = result.message || "文件索引状态刷新失败";
      message.error({ content: fileIndexStatusNotice.value, key: FILE_INDEX_MESSAGE_KEY, duration: 3 });
      return;
    }
    updateFileIndexStatusNotice(result);
    if (shouldPollFileIndexStatus(result.indexStatus)) {
      fileIndexPolling.value = true;
      scheduleFileIndexStatusPoll(1500);
      return;
    }
    fileIndexPolling.value = false;
    closeFileIndexBuildMessage();
    if (result.indexStatus === "ready") {
      scheduleFileIndexStatusClear();
    }
  } catch (error) {
    fileIndexPolling.value = false;
    fileIndexStatus.value = "failed";
    fileIndexStatusNotice.value = error instanceof Error ? error.message : "文件索引状态刷新失败";
    message.error({ content: fileIndexStatusNotice.value, key: FILE_INDEX_MESSAGE_KEY, duration: 3 });
  }
}

/** 关闭构建中的全局提示；完成信息只保留在侧栏状态条。 */
function closeFileIndexBuildMessage(): void {
  message.destroy(FILE_INDEX_MESSAGE_KEY);
}

/** 根据索引响应生成侧栏状态提示文案。 */
function updateFileIndexStatusNotice(input: {
  indexStatus?: FsSearchIndexStatus;
  indexedCount?: number;
  partial?: boolean;
  message?: string | null;
}): void {
  const status = input.indexStatus ?? null;
  fileIndexStatus.value = status;
  const countText = Number.isFinite(Number(input.indexedCount)) ? `，已索引 ${Number(input.indexedCount)} 个路径` : "";
  if (status === "queued") {
    fileIndexStatusNotice.value = `${input.message || "文件索引等待后台构建"}${countText}`;
  } else if (status === "building") {
    fileIndexStatusNotice.value = `${input.message || "文件索引正在后台构建"}${countText}`;
  } else if (status === "ready") {
    fileIndexStatusNotice.value = `文件索引已完成${countText}`;
  } else if (status === "stale") {
    fileIndexStatusNotice.value = `${input.message || "文件索引已完成，但结果可能不完整"}${countText}`;
  } else if (status === "failed" || status === "disabled") {
    fileIndexStatusNotice.value = input.message || "文件索引不可用";
  } else {
    fileIndexStatusNotice.value = input.message || "";
  }
}

/** 判断当前索引状态是否仍需要继续刷新。 */
function shouldPollFileIndexStatus(status: FsSearchIndexStatus | undefined): boolean {
  return status === "queued" || status === "building";
}

/** 安排下一次索引状态轮询。 */
function scheduleFileIndexStatusPoll(delayMs: number): void {
  clearFileIndexStatusTimer();
  fileIndexStatusTimer = setTimeout(() => {
    fileIndexStatusTimer = null;
    void pollFileIndexStatus();
  }, delayMs);
}

/** 构建完成后延迟收起成功提示，避免占用文件树空间。 */
function scheduleFileIndexStatusClear(): void {
  clearFileIndexStatusTimer();
  fileIndexStatusTimer = setTimeout(() => {
    fileIndexStatusTimer = null;
    if (!fileIndexPolling.value && fileIndexStatus.value === "ready") {
      fileIndexStatusNotice.value = "";
    }
  }, 4000);
}

/** 清理索引状态提示计时器。 */
function clearFileIndexStatusTimer(): void {
  if (!fileIndexStatusTimer) return;
  clearTimeout(fileIndexStatusTimer);
  fileIndexStatusTimer = null;
}

/** 推断上传目标目录，优先沿用当前选中文件所在目录，其次最后展开目录。 */
function resolveUploadTargetDir(): string {
  const selected = explorer.selectedPath ? parentDirOf(explorer.selectedPath) : "";
  if (selected) return selected;
  const expanded = explorer.expandedKeys.at(-1);
  return typeof expanded === "string" ? expanded : "";
}

/** 展示上传目标目录，根目录使用更易读的文案。 */
function uploadTargetLabel(targetDir: string): string {
  return targetDir || "工作区根目录";
}

/** 把文件字节数格式化为上传确认框可读文本。 */
function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知大小";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

/** 返回文件路径所在目录；根目录下文件返回空字符串。 */
function parentDirOf(filePath: string): string {
  const normalized = String(filePath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

/** 解析当前共享工作区 ID；非共享工作区返回 null。 */
function resolveSharedWorkspaceId(): string | null {
  const workspace = currentWorkspace.value;
  return workspace?.shared?.sharedWorkspaceId ?? parseSharedWorkspaceSelectionId(props.workspaceId);
}

/** 点击上传时实时校验共享上传权限，避免依赖页面旧缓存。 */
async function ensureUploadAllowed(): Promise<boolean> {
  const unavailableReason = sharedUploadUnavailableReason.value;
  if (unavailableReason) {
    message.warning(unavailableReason);
    return false;
  }
  const sharedWorkspaceId = resolveSharedWorkspaceId();
  if (!sharedWorkspaceId) return true;
  const result = await getSharedWorkspaceFileTransferPolicy(props.ctx, sharedWorkspaceId);
  if (!result.ok) {
    message.error(result.message || "检查上传权限失败");
    return false;
  }
  const workspace = currentWorkspace.value;
  if (workspace) workspace.fileTransferPolicy = result.policy;
  if (!result.policy.uploadEnabled) {
    message.warning("共享工作区未开启上传权限");
    return false;
  }
  return true;
}

/** 打开原生文件选择器，仅允许单文件上传。 */
async function openUploadPicker(targetDir?: string): Promise<void> {
  if (uploadingFile.value || checkingUploadPermission.value) return;
  uploadTargetDir.value = targetDir ?? null;
  checkingUploadPermission.value = true;
  try {
    if (!await ensureUploadAllowed()) {
      uploadTargetDir.value = null;
      return;
    }
    uploadInputRef.value?.click();
  } finally {
    checkingUploadPermission.value = false;
  }
}

/** 从目录右键菜单打开上传选择器，并锁定本次上传的目标目录。 */
function onUploadToDirectory(targetDir: string): void {
  void openUploadPicker(targetDir);
}

/** 执行上传前再次校验共享上传权限，覆盖文件选择期间策略被关闭的情况。 */
async function ensureUploadAllowedBeforeSend(): Promise<boolean> {
  if (!await ensureUploadAllowed()) {
    return false;
  }
  return true;
}

/** 执行单文件上传，成功后刷新文件树。 */
async function performUpload(file: File, overwrite: boolean, targetDir: string): Promise<boolean> {
  const result = await uploadWorkspaceFile(props.ctx, {
    workspaceId: props.workspaceId,
    targetDir,
    file,
    overwrite,
  });
  if (!result.ok) {
    if (result.code === "FILE_ALREADY_EXISTS" && !overwrite) {
      return await confirmOverwriteUpload(file, targetDir);
    }
    message.error(result.message || "上传文件失败");
    return false;
  }
  await Promise.all([
    explorer.loadTree(props.ctx, props.workspaceId),
    explorer.refreshGitStatus(props.ctx, props.workspaceId),
  ]);
  message.success(`已上传：${result.fileName}`);
  trackProductEvent("workspace_file_transfer", {
    direction: "upload",
    source: "explorer_toolbar",
    workspace_type: parseSharedWorkspaceSelectionId(String(props.workspaceId)) ? "shared" : "local",
  });
  return true;
}

/** 上传前确认目标目录，避免用户误传到错误路径。 */
async function confirmUpload(file: File, targetDir: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: "上传文件",
      content: h("div", [
        h("div", `文件：${file.name}`),
        h("div", `大小：${formatFileSize(file.size)}`),
        h("div", `位置：${uploadTargetLabel(targetDir)}`),
      ]),
      okText: "上传",
      cancelText: "取消",
      onOk() {
        resolve(true);
      },
      onCancel() {
        resolve(false);
      },
    });
  });
}

/** 同名文件上传前二次确认，确认后以覆盖模式重试。 */
async function confirmOverwriteUpload(file: File, targetDir: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    Modal.confirm({
      title: "文件已存在",
      content: `目标目录已存在“${file.name}”，是否覆盖？`,
      okText: "覆盖",
      cancelText: "取消",
      async onOk() {
        try {
          settle(await performUpload(file, true, targetDir));
        } catch (error) {
          settled = true;
          reject(error);
        }
      },
      onCancel() {
        settle(false);
      },
    });
  });
}

/** 处理用户选择的单个文件。 */
async function onUploadFileSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  input.value = "";
  const selectedTargetDir = uploadTargetDir.value;
  uploadTargetDir.value = null;
  if (!file || uploadingFile.value) return;
  const targetDir = selectedTargetDir ?? resolveUploadTargetDir();
  if (!await ensureUploadAllowedBeforeSend()) return;
  if (!await confirmUpload(file, targetDir)) return;
  uploadingFile.value = true;
  try {
    await performUpload(file, false, targetDir);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "上传文件失败");
  } finally {
    uploadingFile.value = false;
  }
}

onBeforeUnmount(() => {
  clearGitAheadRefreshTimer();
  clearFileIndexStatusTimer();
});
</script>

<template>
  <div class="explorer-sidebar" :class="{ 'explorer-sidebar--h5': props.surface === 'h5' }">
    <!-- 顶部工具栏 -->
    <div class="explorer-sidebar__toolbar">
      <div class="explorer-sidebar__toolbar-row">
        <a-segmented
          v-model:value="viewMode"
          :options="viewModeOptions"
          class="explorer-sidebar__view-switch"
          block
        />
        <a-button
          size="small"
          type="text"
          class="explorer-sidebar__toolbar-icon-btn explorer-sidebar__hidden-toggle"
          :class="{ 'explorer-sidebar__hidden-toggle--active': explorer.showHiddenFiles }"
          :title="explorer.showHiddenFiles ? '隐藏点文件' : '显示隐藏文件'"
          :aria-pressed="explorer.showHiddenFiles"
          @click="toggleHiddenFiles"
        >
          <EyeOutlined v-if="explorer.showHiddenFiles" />
          <EyeInvisibleOutlined v-else />
        </a-button>
        <a-button
          size="small"
          type="text"
          class="explorer-sidebar__toolbar-icon-btn explorer-sidebar__refresh-btn"
          aria-label="刷新"
          :loading="refreshing"
          @click="doRefresh"
        >
          <template #icon><ReloadOutlined /></template>
        </a-button>
        <input ref="uploadInputRef" class="explorer-sidebar__upload-input" type="file" @change="onUploadFileSelected" />
      </div>
    </div>

    <!-- 搜索框（历史模式下查看 commit 详情时显示返回按钮） -->
    <div class="explorer-sidebar__search">
      <a-button
        v-if="isCommitDetailInLog"
        size="small"
        type="text"
        class="explorer-sidebar__back-btn"
        title="返回历史列表"
        @click="goBackToLog"
      >
        <ArrowLeftOutlined />
      </a-button>
      <a-input-search
        v-model:value="searchInput"
        placeholder="输入文件名，回车搜索"
        allow-clear
        @search="doSearch"
        @change="() => { if (!searchInput) onSearchClear(); }"
      />
    </div>

    <div
      v-if="viewMode === 'files' && fileIndexStatusNotice"
      class="explorer-sidebar__index-status"
      :class="fileIndexStatusClass"
    >
      <LoadingOutlined v-if="fileIndexPolling || fileIndexStatus === 'queued' || fileIndexStatus === 'building'" />
      <DatabaseOutlined v-else />
      <span>{{ fileIndexStatusNotice }}</span>
    </div>

    <!-- Git 状态栏 + 工具栏 -->
    <GitStatusBar v-if="explorer.gitStatus?.isRepo" :status="explorer.gitStatus">
      <template v-if="showRepositorySwitcher" #after-branch>
        <a-dropdown :trigger="['click']" overlay-class-name="explorer-sidebar__repo-dropdown">
          <button type="button" class="explorer-sidebar__repo-switcher" title="切换 Git 仓库">
            <SwapOutlined />
            <span class="explorer-sidebar__repo-switcher-name">{{ selectedRepositoryLabel }}</span>
          </button>
          <template #overlay>
            <div class="explorer-sidebar__repo-menu">
              <div class="explorer-sidebar__repo-menu-search" @mousedown.stop @mouseup.stop @click.stop>
                <a-input
                  v-model:value="repositorySearchInput"
                  size="small"
                  allow-clear
                  autocomplete="off"
                  name="codeflow-git-repository-search"
                  placeholder="搜索 Git 仓库"
                  @keydown.stop
                />
              </div>
              <a-menu
                :selected-keys="[repositorySelectValue]"
                class="explorer-sidebar__repo-menu-list"
                @click="onRepositoryMenuClick"
              >
                <a-menu-item v-for="option in filteredRepositoryOptions" :key="option.value" :title="option.title">
                  {{ option.label }}
                </a-menu-item>
                <a-menu-item v-if="filteredRepositoryOptions.length === 0" key="__empty" disabled>
                  未找到匹配仓库
                </a-menu-item>
              </a-menu>
            </div>
          </template>
        </a-dropdown>
      </template>
      <template v-if="viewMode === 'git' && gitPanelRef" #default>
        <span class="explorer-sidebar__git-actions">
          <!-- 操作按钮（选中文件后才出现） -->
          <a-button v-if="gitPanelRef.canStage" size="small" type="text" title="Stage 选中文件" :disabled="explorer.operating" @click="gitPanelRef.doStage()">
            <PlusOutlined />
          </a-button>
          <a-button v-if="gitPanelRef.canUnstage" size="small" type="text" title="Unstage 选中文件" :disabled="explorer.operating" @click="gitPanelRef.doUnstage()">
            <MinusOutlined />
          </a-button>
          <a-button v-if="gitPanelRef.canDiscard" size="small" type="text" title="丢弃选中文件的更改" :disabled="explorer.operating" @click="gitPanelRef.doDiscard()">
            <UndoOutlined />
          </a-button>
          <a-button v-if="gitPanelRef.canCommit" size="small" type="primary" title="提交选中文件" :disabled="explorer.operating" @click="gitPanelRef.doOpenCommit()">
            <CheckOutlined />
          </a-button>
          <!-- 分隔线（有操作按钮时显示） -->
          <span v-if="gitPanelRef.canStage || gitPanelRef.canUnstage || gitPanelRef.canDiscard || gitPanelRef.canCommit" class="explorer-sidebar__separator" />
          <!-- 视图切换（始终在最右边） -->
          <a-button size="small" type="text" :class="{ 'explorer-sidebar__btn--active': gitPanelRef.layout === 'flat' }" title="列表视图" @click="gitPanelRef.layout = 'flat'">
            <UnorderedListOutlined />
          </a-button>
          <a-button size="small" type="text" :class="{ 'explorer-sidebar__btn--active': gitPanelRef.layout === 'tree' }" title="树状视图" @click="gitPanelRef.layout = 'tree'">
            <ApartmentOutlined />
          </a-button>
          <template v-if="gitPanelRef.layout === 'tree'">
            <a-button size="small" type="text" title="全部展开" @click="gitPanelRef.expandAll()"><ExpandAltOutlined /></a-button>
            <a-button size="small" type="text" title="全部折叠" @click="gitPanelRef.collapseAll()"><ShrinkOutlined /></a-button>
          </template>
        </span>
      </template>
    </GitStatusBar>

    <!-- 文件树（全部文件模式） -->
    <div v-if="viewMode === 'files'" class="explorer-sidebar__tree">
      <FileTree
        :workspace-id="workspaceId"
        :ctx="ctx"
        :search-keyword="searchKeyword"
        :search-revision="searchRevision"
        @select-file="onSelectFile"
        @upload-to-directory="onUploadToDirectory"
      />
    </div>

    <!-- Git 变更列表（Git 视图模式） -->
    <div v-else-if="viewMode === 'git'" class="explorer-sidebar__git">
      <GitChangesPanel
        ref="gitPanelRef"
        :workspace-id="workspaceId"
        :ctx="ctx"
        :search-keyword="searchKeyword"
        @select-file="onSelectGitFile"
      />
    </div>

    <!-- 历史（log 视图模式） -->
    <div v-else-if="viewMode === 'log'" class="explorer-sidebar__git">
      <!-- 有 commit detail 时显示修订记录文件列表 -->
      <GitCommitFilesPanel v-if="explorer.gitCommitDetail" @select-file="onSelectCommitFile" />
      <!-- 否则显示提交历史列表 -->
      <GitLogPanel v-else :workspace-id="workspaceId" :ctx="ctx" />
    </div>
  </div>
</template>

<style scoped>
.explorer-sidebar {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  overflow: hidden;
}

.explorer-sidebar__toolbar {
  /* 顶部只留 4px：与 .explorer-right-panel 的 8px 合计 12px，和会话侧栏搜索框距面板顶的距离对齐。 */
  padding: 4px 0 8px;
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
  flex-shrink: 0;
}

.explorer-sidebar__toolbar-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 三个 tab 平分图标按钮以外的全部宽度（等宽由模板 block 提供）；
   不用 max-content 限制，否则可用宽度不足时 tab 文案会被省略号截断。 */
.explorer-sidebar__view-switch {
  flex: 1;
  min-width: 0;
}

/* 与会话页分类 tab（.thread-list__segmented）保持同一套分段控件尺寸与选中态。 */
.explorer-sidebar__view-switch :deep(.ant-segmented) {
  background: color-mix(in srgb, var(--app-muted) 6%, transparent);
  padding: 3px;
  border-radius: 8px;
}

.explorer-sidebar__view-switch :deep(.ant-segmented-item) {
  font-size: 13px;
  color: var(--app-muted);
  transition: color 150ms ease;
  border-radius: 6px;
}

.explorer-sidebar__view-switch :deep(.ant-segmented-item-label) {
  min-height: 32px;
  line-height: 32px;
  padding: 0 10px;
}

.explorer-sidebar__view-switch :deep(.ant-segmented-item-selected),
.explorer-sidebar__view-switch :deep(.ant-segmented-thumb) {
  color: var(--app-accent);
  font-weight: 600;
  background: var(--app-panel-bg);
  box-shadow: none;
  border-radius: 6px;
}

.explorer-sidebar__view-switch :deep(.ant-segmented-item-selected .ant-segmented-item-label) {
  color: var(--app-accent);
  font-weight: 600;
}

.explorer-sidebar__view-switch :deep(.ant-segmented-item:hover:not(.ant-segmented-item-selected)) {
  color: var(--app-text);
}

.explorer-sidebar__refresh-btn {
  flex-shrink: 0;
}

.explorer-sidebar__upload-input {
  display: none;
}

.explorer-sidebar__toolbar-icon-btn {
  flex-shrink: 0;
  border-radius: 6px;
  color: var(--app-muted, #6b7280);
}

.explorer-sidebar__toolbar-icon-btn:hover,
.explorer-sidebar__toolbar-icon-btn:focus-visible {
  color: var(--app-accent, #c96442);
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

.explorer-sidebar__toolbar-icon-btn :deep(.anticon) {
  font-size: 14px;
}

.explorer-sidebar__hidden-toggle--active,
.explorer-sidebar__refresh-btn.ant-btn-loading {
  color: var(--app-accent, #c96442);
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

.explorer-sidebar__search {
  display: flex;
  align-items: center;
  padding: 0;
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
  flex-shrink: 0;
}

.explorer-sidebar__search :deep(.ant-input::placeholder) {
  font-size: 12px;
}

.explorer-sidebar__back-btn {
  flex-shrink: 0;
  margin-left: 4px;
}

.explorer-sidebar__index-status {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
  color: var(--app-muted, #6b7280);
  background: rgba(0, 0, 0, 0.02);
  font-size: 12px;
  line-height: 18px;
  flex-shrink: 0;
}

.explorer-sidebar__index-status span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.explorer-sidebar__index-status--active {
  color: #ad6800;
  background: #fffbe6;
}

.explorer-sidebar__index-status--ready {
  color: #237804;
  background: #f6ffed;
}

.explorer-sidebar__index-status--error {
  color: #a8071a;
  background: #fff1f0;
}

.explorer-sidebar__tree {
  flex: 1;
  display: flex;
  width: 100%;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
}

.explorer-sidebar__git {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.explorer-sidebar__git-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.explorer-sidebar__repo-switcher {
  display: inline-flex;
  align-items: center;
  max-width: 150px;
  height: 22px;
  gap: 4px;
  padding: 0 6px;
  border: 0;
  border-radius: 4px;
  color: var(--app-muted, #6b7280);
  background: transparent;
  font-size: 12px;
  line-height: 22px;
  cursor: pointer;
}

.explorer-sidebar__repo-switcher:hover {
  color: var(--app-accent, #c96442);
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

.explorer-sidebar__repo-switcher-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.explorer-sidebar__repo-dropdown .ant-dropdown-menu) {
  max-height: none;
  overflow: visible;
}

:deep(.explorer-sidebar__repo-menu) {
  display: flex;
  flex-direction: column;
  width: min(360px, calc(100vw - 48px));
  max-height: min(520px, calc(100vh - 96px));
  overflow: hidden;
  border-radius: 8px;
  background: var(--app-panel-bg, #fff);
  box-shadow: 0 6px 16px rgba(15, 23, 42, 0.12);
}

:deep(.explorer-sidebar__repo-menu-search) {
  flex-shrink: 0;
  padding: 8px;
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
}

:deep(.explorer-sidebar__repo-menu-list) {
  flex: 1;
  min-height: 0;
  max-height: min(460px, calc(100vh - 152px));
  overflow-x: hidden;
  overflow-y: auto;
}

:deep(.explorer-sidebar__repo-menu-list .ant-dropdown-menu-title-content) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.explorer-sidebar__separator {
  width: 1px;
  height: 14px;
  background: var(--app-divider, #d9d9d9);
  margin: 0 2px;
  flex-shrink: 0;
}

.explorer-sidebar__btn--active {
  color: var(--app-accent, #c96442);
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

/* 文件树背景透明（继承父级面板背景，避免 Ant Design 默认白色） */
.explorer-sidebar :deep(.ant-tree) {
  background: transparent !important;
  border-radius: 0 !important;
}

.explorer-sidebar :deep(.ant-tree.ant-tree-directory .ant-tree-treenode-selected::before) {
  background: rgba(0, 0, 0, 0.08) !important;
}

.explorer-sidebar :deep(.ant-tree.ant-tree-directory .ant-tree-treenode-selected:hover::before) {
  background: rgba(0, 0, 0, 0.12) !important;
}

.explorer-sidebar :deep(.ant-tree.ant-tree-directory .ant-tree-treenode-selected .ant-tree-node-content-wrapper),
.explorer-sidebar :deep(.ant-tree.ant-tree-directory .ant-tree-treenode-selected .ant-tree-switcher) {
  color: inherit !important;
}

.explorer-sidebar :deep(.ant-spin-nested-loading),
.explorer-sidebar :deep(.ant-spin-container) {
  background: transparent !important;
}

/* H5 工具区采用移动分段和圆角搜索，文件内容在单一内层区域滚动。 */
.explorer-sidebar--h5 {
  gap: 0;
  padding: 0 12px 8px;
  background: color-mix(in srgb, var(--app-bg) 96%, var(--app-surface));
}

.explorer-sidebar--h5 .explorer-sidebar__toolbar {
  padding: 10px 0 8px;
  border-bottom: 0;
}

.explorer-sidebar--h5 .explorer-sidebar__toolbar-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(2, 40px);
  gap: 7px;
}

.explorer-sidebar--h5 .explorer-sidebar__view-switch {
  width: 100%;
  max-width: none;
}

/* 与会话页分类 tab（.thread-list__segmented）同一套口径：等宽与居中由模板 block 提供，
   这里只对齐容器与 item 尺寸；选中态文字颜色见上方基础规则。 */
.explorer-sidebar--h5 .explorer-sidebar__view-switch :deep(.ant-segmented) {
  background: color-mix(in srgb, var(--app-muted) 6%, transparent);
  padding: 3px;
  border-radius: 8px;
}

.explorer-sidebar--h5 .explorer-sidebar__view-switch :deep(.ant-segmented-item) {
  font-size: 13px;
  color: var(--app-muted);
  transition: color 150ms ease;
  border-radius: 6px;
}

.explorer-sidebar--h5 .explorer-sidebar__view-switch :deep(.ant-segmented-item-label) {
  min-height: 32px;
  line-height: 32px;
  padding: 0 10px;
}

.explorer-sidebar--h5 .explorer-sidebar__view-switch :deep(.ant-segmented-item:hover:not(.ant-segmented-item-selected)) {
  color: var(--app-text);
}

.explorer-sidebar--h5 .explorer-sidebar__toolbar-icon-btn {
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--app-divider) 78%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-surface) 94%, transparent);
}

/* 上面这条 H5 按钮底色特异性高于基础激活态，需在此显式还原「显示隐藏文件」的激活外观。 */
.explorer-sidebar--h5 .explorer-sidebar__toolbar-icon-btn.explorer-sidebar__hidden-toggle--active {
  color: var(--app-accent, #c96442);
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

.explorer-sidebar--h5 .explorer-sidebar__search {
  padding: 0 0 9px;
  border-bottom: 0;
}

.explorer-sidebar--h5 .explorer-sidebar__search :deep(.ant-input-affix-wrapper),
.explorer-sidebar--h5 .explorer-sidebar__search :deep(.ant-input-group-addon .ant-btn) {
  min-height: 44px;
  border-color: color-mix(in srgb, var(--app-divider) 78%, transparent);
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel-bg) 94%, var(--app-bg));
}

.explorer-sidebar--h5 .explorer-sidebar__search :deep(.ant-input-affix-wrapper) {
  border-radius: 14px 0 0 14px;
}

.explorer-sidebar--h5 .explorer-sidebar__search :deep(.ant-input-affix-wrapper .ant-input) {
  color: var(--app-text);
  background: transparent;
  caret-color: var(--app-accent);
}

.explorer-sidebar--h5 .explorer-sidebar__search :deep(.ant-input::placeholder),
.explorer-sidebar--h5 .explorer-sidebar__search :deep(.ant-input-clear-icon),
.explorer-sidebar--h5 .explorer-sidebar__search :deep(.ant-input-group-addon .ant-btn .anticon) {
  color: var(--app-muted);
}

.explorer-sidebar--h5 .explorer-sidebar__search :deep(.ant-input-affix-wrapper-focused),
.explorer-sidebar--h5 .explorer-sidebar__search :deep(.ant-input-affix-wrapper:focus-within) {
  border-color: color-mix(in srgb, var(--app-accent) 42%, var(--app-border));
  box-shadow: var(--app-ring);
}

.explorer-sidebar--h5 .explorer-sidebar__search :deep(.ant-input-group-addon .ant-btn) {
  border-radius: 0 14px 14px 0;
}

.explorer-sidebar--h5 .explorer-sidebar__index-status {
  min-height: 34px;
  margin-bottom: 8px;
  border: 0;
  border-radius: 11px;
}

.explorer-sidebar--h5 :deep(.git-status-bar) {
  margin-bottom: 8px;
  border-radius: 12px;
}

.explorer-sidebar--h5 .explorer-sidebar__tree,
.explorer-sidebar--h5 .explorer-sidebar__git {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-divider) 78%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--app-surface) 95%, transparent);
  box-shadow: 0 8px 22px color-mix(in srgb, #000 4%, transparent);
}

.explorer-sidebar--h5 .explorer-sidebar__tree :deep(.ant-tree) {
  padding: 6px 4px 14px;
}

/* 文件树滚动由 .file-tree__host 承担，移动端同样保留原生滚动但隐藏滚动条。 */
.explorer-sidebar--h5 .explorer-sidebar__tree :deep(.file-tree__host) {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.explorer-sidebar--h5 .explorer-sidebar__tree :deep(.file-tree__host::-webkit-scrollbar) {
  display: none;
}

.explorer-sidebar--h5 .explorer-sidebar__tree :deep(.ant-tree-treenode) {
  min-height: 44px;
  align-items: center;
}

.explorer-sidebar--h5 .explorer-sidebar__tree :deep(.ant-tree-node-content-wrapper) {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  border-radius: 10px;
}

.explorer-sidebar--h5 .explorer-sidebar__tree :deep(.ant-tree-switcher) {
  height: 44px;
  line-height: 44px;
}
</style>

