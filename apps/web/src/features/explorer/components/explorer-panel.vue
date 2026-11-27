<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { EyeOutlined, CodeOutlined, ColumnWidthOutlined, ColumnHeightOutlined, CompressOutlined, ExpandOutlined, UpOutlined, DownOutlined, MinusOutlined, PlusOutlined, SaveOutlined, RollbackOutlined } from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import type { WorkspaceId } from "@codeflowai/shared";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { useExplorerStore } from "../../../store/explorer";
import { usePresenceStore } from "../../../store/presence";
import { isDesktopWorkspace } from "../../../services/desktop";
import { useUiStore, type PreviewWindow } from "../../../store/ui";
import ExplorerSidebar from "./explorer-sidebar.vue";
import FilePreview from "./file-preview.vue";
import DiffViewer from "../../chat/components/diff-viewer.vue";
import GitBranchManager from "./git-branch-manager.vue";
import GitCommitDetail from "./git-commit-detail.vue";
import { usePreviewZoom, type PreviewZoomKind } from "../usePreviewZoom";
import { discardFileEditorDraft, getFileEditorDraft, isFileEditorDirty, saveFileEditorDraft } from "../fileEditorState";

defineOptions({ name: "ExplorerPanel" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  surface?: "default" | "h5";
  /** 隐藏左侧 sidebar（用于预览弹窗场景） */
  hideSidebar?: boolean;
}>();

const { ctx } = useApiContext();
const config = useConfigStore();
const explorer = useExplorerStore();
const presence = usePresenceStore();
const ui = useUiStore();
const activeTab = ref<"preview" | "branches">("preview");
const showRawMarkdown = ref(false);

/** 是否为移动端视口 */
const isMobile = computed(() => props.surface === "h5" || (typeof window !== "undefined" && window.innerWidth <= 767));

/** 当前预览的是否是 Markdown 文件 */
const isMarkdownPreview = computed(() => {
  return activeTab.value === "preview"
    && explorer.previewType === "markdown"
    && explorer.preview?.content != null
    && !explorer.gitCommitDetail
    && !(explorer.gitDiffContent != null && explorer.gitDiffPath);
});

/** 图片文件扩展名集合 */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"]);

/** 当前 diff 文件是否为图片 */
const isImageFile = computed(() => {
  const path = explorer.gitDiffPath;
  if (!path) return false;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
});
const NON_TEXT_DIFF_PREVIEW_TYPES = new Set(["image", "spreadsheet", "pdf", "word", "presentation", "binary"]);

/** 当前 diff 文件是否应回退到普通预览。 */
const useFilePreviewForDiff = computed(() => {
  return (isImageFile.value && explorer.previewType === "image") || NON_TEXT_DIFF_PREVIEW_TYPES.has(explorer.previewType);
});

/** 选中文件预览 */
async function onSelectFile(path: string) {
  if (isMobile.value) {
    await explorer.selectFile(ctx.value, props.workspaceId, path);
    openMobilePreviewWindow({
      filePath: path,
      type: "file",
      diffOriginal: null,
      diffModified: null,
      diffStaged: false,
      diffVersionOld: null,
      diffVersionNew: null,
    });
    return;
  }
  activeTab.value = "preview";
  explorer.selectFile(ctx.value, props.workspaceId, path);
}

/** Git 视图选中变更文件 → 加载 diff + 文件内容 */
async function onSelectGitFile(path: string, staged: boolean) {
  if (isMobile.value) {
    explorer.selectedPath = path;
    await Promise.all([
      explorer.loadGitDiff(ctx.value, props.workspaceId, path, staged),
      explorer.loadPreview(ctx.value, props.workspaceId, path),
    ]);
    const headShort = explorer.gitStatus?.headCommit?.substring(0, 7) ?? "HEAD";
    openMobilePreviewWindow({
      filePath: path,
      type: "diff",
      diffOriginal: explorer.gitDiffOriginal,
      diffModified: explorer.gitDiffModified,
      diffStaged: staged,
      diffVersionOld: headShort,
      diffVersionNew: staged ? "暂存区" : "工作区",
    });
    return;
  }
  activeTab.value = "preview";
  explorer.selectedPath = path;
  await Promise.all([
    explorer.loadGitDiff(ctx.value, props.workspaceId, path, staged),
    // 同时加载文件内容，以便 diff 为空时（如未跟踪文件）可以回退到文件预览
    explorer.loadPreview(ctx.value, props.workspaceId, path),
  ]);
}

/** 完整提交差异由用户明确展开，失败保留详情页错误并记录请求上下文。 */
async function loadFullCommitDiff(): Promise<void> {
  const hash = explorer.gitCommitDetail?.entry.hash;
  if (!hash || explorer.gitCommitDetailLoading) return;
  try {
    await explorer.loadGitCommitDetail(ctx.value, props.workspaceId, hash, true);
  } catch (error) {
    const failure = error as { code?: unknown; details?: { requestId?: unknown; serverRequestId?: unknown } };
    console.error("[GIT_COMMIT_DIFF_LOAD_FAILED]", { code: failure?.code ?? "GIT_COMMIT_DIFF_LOAD_FAILED",
      requestId: failure?.details?.requestId ?? failure?.details?.serverRequestId ?? null,
      workspaceId: props.workspaceId, repositoryPath: explorer.selectedGitRepositoryPath, hash,
      cause: error instanceof Error ? error.message : String(error) });
  }
}

/** 修订记录中选中文件 → 加载 commit 级别 diff + 文件预览（图片等需要） */
async function onSelectCommitFile(path: string) {
  if (!explorer.gitCommitDetail) return;
  const hash = explorer.gitCommitDetail.entry.hash;
  const oldVersion = explorer.gitCommitDetail.entry.parents?.[0]?.substring(0, 7) ?? "初始提交";
  const newVersion = explorer.gitCommitDetail.entry.hashShort;
  if (isMobile.value) {
    explorer.selectedPath = path;
    await Promise.all([
      explorer.loadCommitFileDiff(ctx.value, props.workspaceId, hash, path),
      explorer.loadPreview(ctx.value, props.workspaceId, path),
    ]);
    openMobilePreviewWindow({
      filePath: path,
      type: "diff",
      diffOriginal: explorer.gitDiffOriginal,
      diffModified: explorer.gitDiffModified,
      diffStaged: false,
      diffVersionOld: oldVersion,
      diffVersionNew: newVersion,
    });
    return;
  }
  activeTab.value = "preview";
  await Promise.all([
    explorer.loadCommitFileDiff(ctx.value, props.workspaceId, hash, path),
    explorer.loadPreview(ctx.value, props.workspaceId, path),
  ]);
}

/** 是否在 diff 视图（图片文件走预览，不显示 diff 工具栏） */
const isDiffView = computed(() => {
  if (useFilePreviewForDiff.value) return false;
  return rightPanelMode.value === "diff" || rightPanelMode.value === "commit-file-diff";
});

/** Diff 版本信息（显示在 diff 区域上方，图片文件不显示） */
const diffVersionInfo = computed<{ old: string; new: string } | null>(() => {
  if (useFilePreviewForDiff.value) return null;
  if (rightPanelMode.value === "commit-file-diff" && explorer.gitCommitDetail) {
    const entry = explorer.gitCommitDetail.entry;
    const parentShort = entry.parents?.[0]?.substring(0, 7) ?? "初始提交";
    return { old: parentShort, new: entry.hashShort };
  }
  if (rightPanelMode.value === "diff") {
    const headShort = explorer.gitStatus?.headCommit?.substring(0, 7) ?? "HEAD";
    if (explorer.gitDiffStaged) {
      return { old: headShort, new: "暂存区" };
    }
    return { old: headShort, new: "工作区" };
  }
  return null;
});

/** 右侧面板模式 */
const rightPanelMode = computed(() => {
  // 当 commit detail 存在且选中了文件时，走 commit-file-diff 模式
  if (explorer.gitCommitDetail && explorer.commitDetailSelectedPath && explorer.gitDiffContent && explorer.gitDiffPath) {
    return "commit-file-diff";
  }
  // 有 commit detail 但没选文件时，显示 commit-detail 全览
  if (explorer.gitCommitDetail && !explorer.commitDetailSelectedPath) return "commit-detail";
  // 只有 diff 内容非空时才显示 diff 视图，空 diff（如未跟踪文件）回退到普通预览
  if (explorer.gitDiffContent && explorer.gitDiffPath) return "diff";
  if (explorer.selectedPath) return "preview";
  return "empty";
});

/** 当前文件草稿；diff/分支视图不展示保存操作。 */
const editorDraft = computed(() => {
  if (activeTab.value !== "preview" || isDiffView.value || !explorer.selectedPath) return null;
  return getFileEditorDraft(props.workspaceId, explorer.selectedPath);
});
const editorDirty = computed(() => isFileEditorDirty(editorDraft.value));
const savingEdits = computed(() => editorDraft.value?.saving === true);

/** 保存后同步预览快照，确认弹窗复制与 Markdown 渲染使用最新内容。 */
async function savePreviewEdits(): Promise<void> {
  const draft = editorDraft.value, path = explorer.selectedPath;
  if (!draft || !path) return;
  try {
    const result = await saveFileEditorDraft(ctx.value, draft, props.workspaceId, path);
    // 保存期间可能已切换文件；只允许写回仍选中的路径。
    if (explorer.selectedPath === path && explorer.preview) {
      explorer.preview = { ...explorer.preview, content: draft.content, size: result.size, mtimeMs: result.mtimeMs, truncated: false };
    }
    message.success("已保存");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存失败");
  }
}

function discardPreviewEdits(): void {
  if (editorDraft.value) discardFileEditorDraft(editorDraft.value);
}

/** Tab 栏文件路径显示 */
const tabFilePath = computed(() => {
  if (rightPanelMode.value === "commit-file-diff" && explorer.gitCommitDetail) {
    const hashShort = explorer.gitCommitDetail.entry.hashShort;
    return `${hashShort} · ${explorer.gitDiffPath}`;
  }
  return explorer.selectedPath;
});

const diffInline = ref(false);
const diffHideUnchanged = ref(false);
const diffViewerRef = ref<InstanceType<typeof DiffViewer> | null>(null);
const previewZoomKind = computed<PreviewZoomKind | null>(() => {
  if (isDiffView.value) return "diff";
  if (explorer.previewType === "code") return "code";
  if (explorer.previewType === "markdown") return "markdown";
  if (explorer.previewType === "image") return "image";
  return null;
});
const { scale, scaleLabel, canZoom, canZoomIn, canZoomOut, zoomIn, zoomOut, resetZoom } = usePreviewZoom(previewZoomKind);

/** 切换预览页签时关闭详情，并使在途提交读取失效。 */
function switchTab(v: string | number) {
  explorer.clearGitCommitDetail();
  explorer.gitDiffPath = null;
  explorer.gitDiffContent = null;
  explorer.gitDiffOriginal = null;
  explorer.gitDiffModified = null;
  activeTab.value = v as any;
}

function openMobilePreviewWindow(input: {
  filePath: string;
  type: PreviewWindow["type"];
  diffOriginal: string | null;
  diffModified: string | null;
  diffStaged: boolean;
  diffVersionOld: string | null;
  diffVersionNew: string | null;
}): void {
  const ext = input.filePath.split(".").pop()?.toLowerCase() ?? "";
  const previewType = IMAGE_EXTS.has(ext) ? "image" as const : (explorer.previewType ?? "code") as PreviewWindow["previewType"];
  const win: PreviewWindow = {
    id: `mobile-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    workspaceId: props.workspaceId,
    filePath: input.filePath,
    type: input.type,
    previewType,
    content: explorer.preview?.content ?? null,
    base64: explorer.preview?.base64 ?? null,
    mimeType: explorer.preview?.mimeType ?? null,
    spreadsheet: explorer.spreadsheetPreview ?? null,
    diffOriginal: input.diffOriginal,
    diffModified: input.diffModified,
    diffStaged: input.diffStaged,
    diffVersionOld: input.diffVersionOld,
    diffVersionNew: input.diffVersionNew,
    cascadeIndex: 0,
    zIndex: 0,
  };
  // 移动端：推入页面栈而非打开 modal
  ui.pushMobilePage({ type: "explorer-preview", context: { win } });
}

/** 桌面本机工作区不依赖 Server 连接；其余工作区仍需 Server 与 Client 在线。 */
const workspaceClientOnline = computed(() =>
  presence.isCurrentWorkspaceClientOnline
  && (config.connected || isDesktopWorkspace(config, props.workspaceId)));

/** 当前工作区 Client 在线后只刷新文件树；Git 状态由工具事件与 Git 面板按需刷新。 */
async function refreshWorkspaceExplorer(wid: WorkspaceId): Promise<void> {
  await explorer.loadTree(ctx.value, wid);
}

/** 初始加载和 Client 在线恢复后刷新 */
watch(
  () => [props.workspaceId, workspaceClientOnline.value] as const,
  ([wid, clientOnline]) => {
    if (!wid || !clientOnline) return;
    void refreshWorkspaceExplorer(wid).catch((error) => {
      message.error(error instanceof Error ? error.message : String(error));
    });
  },
  { immediate: true },
);
</script>

<template>
  <div class="explorer-panel" :class="{ 'explorer-panel--h5': props.surface === 'h5' }">
    <div v-if="!hideSidebar" class="explorer-panel__sidebar">
      <ExplorerSidebar
        :workspace-id="workspaceId"
        :ctx="ctx"
        :surface="props.surface"
        @select-file="onSelectFile"
        @select-git-file="onSelectGitFile"
        @select-commit-file="onSelectCommitFile"
      />
    </div>

    <div class="explorer-panel__main">
      <!-- 顶部 tab 栏（预览 / 分支） -->
      <div class="explorer-panel__tabs">
        <a-segmented
          :value="activeTab"
          :options="[
            { label: '预览', value: 'preview' },
            { label: '分支', value: 'branches' },
          ]"
          @change="switchTab"
        />
        <span v-if="tabFilePath" class="explorer-panel__filepath">
          {{ tabFilePath }}
        </span>
        <template v-if="editorDraft">
          <span v-if="editorDirty" class="explorer-panel__dirty">未保存</span>
          <a-button v-if="editorDirty" size="small" type="text" class="explorer-panel__raw-btn" title="放弃修改" @click="discardPreviewEdits">
            <RollbackOutlined />
          </a-button>
          <a-button size="small" type="text" class="explorer-panel__raw-btn" title="保存 (Ctrl+S)" :loading="savingEdits" :disabled="!editorDirty" @click="savePreviewEdits">
            <SaveOutlined />
          </a-button>
        </template>
        <a-button
          v-if="isMarkdownPreview"
          size="small"
          type="text"
          class="explorer-panel__raw-btn"
          @click="showRawMarkdown = !showRawMarkdown"
        >
          <EyeOutlined v-if="showRawMarkdown" />
          <CodeOutlined v-else />
          {{ showRawMarkdown ? '预览' : '原文' }}
        </a-button>
        <a-button
          v-if="isDiffView"
          size="small"
          type="text"
          class="explorer-panel__raw-btn"
          :title="diffInline ? '左右对比' : '上下对比'"
          @click="diffInline = !diffInline"
        >
          <ColumnWidthOutlined v-if="diffInline" />
          <ColumnHeightOutlined v-else />
          {{ diffInline ? '左右对比' : '上下对比' }}
        </a-button>
        <a-button
          v-if="isDiffView"
          size="small"
          type="text"
          class="explorer-panel__raw-btn"
          :title="diffHideUnchanged ? '显示全文' : '只看差异'"
          @click="diffHideUnchanged = !diffHideUnchanged"
        >
          <ExpandOutlined v-if="diffHideUnchanged" />
          <CompressOutlined v-else />
          {{ diffHideUnchanged ? '显示全文' : '只看差异' }}
        </a-button>
        <a-button
          v-if="isDiffView"
          size="small"
          type="text"
          class="explorer-panel__raw-btn"
          title="上一处差异"
          @click="diffViewerRef?.goToPrevDiff()"
        >
          <UpOutlined />
          上一处
        </a-button>
        <a-button
          v-if="isDiffView"
          size="small"
          type="text"
          class="explorer-panel__raw-btn"
          title="下一处差异"
          @click="diffViewerRef?.goToNextDiff()"
        >
          <DownOutlined />
          下一处
        </a-button>
        <template v-if="canZoom">
          <a-button size="small" type="text" class="explorer-panel__raw-btn" title="缩小" :disabled="!canZoomOut" @click="zoomOut">
            <MinusOutlined />
          </a-button>
          <a-button size="small" type="text" class="explorer-panel__raw-btn" title="重置缩放" @click="resetZoom">{{ scaleLabel }}</a-button>
          <a-button size="small" type="text" class="explorer-panel__raw-btn" title="放大" :disabled="!canZoomIn" @click="zoomIn">
            <PlusOutlined />
          </a-button>
        </template>
      </div>

      <!-- Diff 版本信息条 -->
      <div v-if="diffVersionInfo" class="explorer-panel__diff-version">
        <span class="explorer-panel__diff-version-label">{{ diffVersionInfo.old }}</span>
        <span class="explorer-panel__diff-version-arrow">→</span>
        <span class="explorer-panel__diff-version-label">{{ diffVersionInfo.new }}</span>
      </div>

      <div class="explorer-panel__content">
        <!-- Commit 文件 Diff（图片文件走预览） -->
        <FilePreview
          v-if="rightPanelMode === 'commit-file-diff' && useFilePreviewForDiff"
          :workspace-id="workspaceId"
          :show-raw-markdown="false"
          :zoom-scale="scale"
        />
        <DiffViewer
          v-else-if="rightPanelMode === 'commit-file-diff'"
          ref="diffViewerRef"
          :original="explorer.gitDiffOriginal ?? ''"
          :modified="explorer.gitDiffModified ?? ''"
          :file-path="explorer.gitDiffPath ?? ''"
          :inline="diffInline"
          :hide-unchanged="diffHideUnchanged"
          :font-scale="scale"
        />

        <!-- Commit 详情（未选文件时的降级视图） -->
        <GitCommitDetail
          v-else-if="rightPanelMode === 'commit-detail' && explorer.gitCommitDetail"
          :detail="explorer.gitCommitDetail"
          :loading="explorer.gitCommitDetailLoading"
          :error="explorer.gitCommitDetailError"
          @load-diff="loadFullCommitDiff"
        />

        <!-- Diff 查看（图片文件走预览） -->
        <FilePreview
          v-else-if="rightPanelMode === 'diff' && useFilePreviewForDiff"
          :workspace-id="workspaceId"
          :show-raw-markdown="false"
          :zoom-scale="scale"
        />
        <DiffViewer
          v-else-if="rightPanelMode === 'diff'"
          ref="diffViewerRef"
          :original="explorer.gitDiffOriginal ?? ''"
          :modified="explorer.gitDiffModified ?? ''"
          :file-path="explorer.gitDiffPath ?? ''"
          :inline="diffInline"
          :hide-unchanged="diffHideUnchanged"
          :font-scale="scale"
        />

        <!-- 文件预览 -->
        <FilePreview v-else-if="activeTab === 'preview'" :workspace-id="workspaceId" :show-raw-markdown="showRawMarkdown" :zoom-scale="scale" @save="savePreviewEdits" />

        <!-- 分支管理 -->
        <GitBranchManager
          v-else-if="activeTab === 'branches'"
          :workspace-id="workspaceId"
          :ctx="ctx"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.explorer-panel {
  display: flex;
  height: 100%;
}

.explorer-panel__sidebar {
  width: 440px;
  min-width: 320px;
  max-width: 560px;
  border-right: 1px solid var(--app-divider, #f0f0f0);
  overflow: hidden;
  flex-shrink: 0;
}

.explorer-panel__main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* 不加 overflow: hidden — Monaco tooltip（.context-view）需要向上溢出 */
}

.explorer-panel__tabs {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
  flex-shrink: 0;
}

.explorer-panel__filepath {
  flex: 1;
  font-size: 12px;
  color: var(--app-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.explorer-panel__raw-btn {
  flex-shrink: 0;
}

.explorer-panel__dirty {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-warning, #d97706) 14%, transparent);
  color: var(--app-warning, #d97706);
  font-size: 12px;
  white-space: nowrap;
}

.explorer-panel__diff-version {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 3px 12px;
  font-size: 12px;
  background: var(--app-hover, rgba(0, 0, 0, 0.02));
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
  flex-shrink: 0;
}

.explorer-panel__diff-version-label {
  font-family: monospace;
  font-weight: 600;
  color: var(--app-accent, #c96442);
}

.explorer-panel__diff-version-arrow {
  color: var(--app-muted);
}

.explorer-panel__content {
  flex: 1;
  min-height: 0;
  /* 提升层级：Monaco tooltip 向上溢出时渲染在 tabs 栏上方 */
  position: relative;
  z-index: 1;
}

/* H5 只保留文件浏览列表，预览交给移动页面栈全屏承载。 */
.explorer-panel--h5 {
  flex-direction: column;
  overflow: hidden;
  background: color-mix(in srgb, var(--app-bg) 96%, var(--app-surface));
}

.explorer-panel--h5 .explorer-panel__sidebar {
  width: 100%;
  min-width: 0;
  max-width: none;
  flex: 1;
  border-right: 0;
  overflow: hidden;
}

.explorer-panel--h5 .explorer-panel__main {
  display: none;
}

@media (max-width: 767px) {
  .explorer-panel {
    flex-direction: column;
  }
  .explorer-panel__sidebar {
    width: 100% !important;
    min-width: unset !important;
    max-width: unset !important;
    border-right: none;
    flex: 1;
  }
  .explorer-panel__main {
    display: none;
  }
}
</style>

