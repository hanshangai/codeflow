<script setup lang="ts">
import { computed, watch } from "vue";
import { message } from "ant-design-vue";
import type { WorkspaceId } from "@codeflowai/shared";
import { createApiResultError, type ApiRequestContext } from "../../../api/request";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { useExplorerStore } from "../../../store/explorer";
import { usePresenceStore } from "../../../store/presence";
import { isDesktopWorkspace } from "../../../services/desktop";
import { useUiStore, type PreviewWindow } from "../../../store/ui";
import { fetchGitDiffFiles, fetchGitShowFileDiff } from "../../../api/git";
import { loadWorkspaceFilePreview, type WorkspaceFilePreviewResult } from "../workspaceFilePreview";
import ExplorerSidebar from "./explorer-sidebar.vue";

defineOptions({ name: "ExplorerRightPanel" });

const props = defineProps<{
  workspaceId: WorkspaceId;
}>();

const { ctx } = useApiContext();
const config = useConfigStore();
const explorer = useExplorerStore();
const presence = usePresenceStore();
const ui = useUiStore();

let _winIdCounter = 0;
function nextWinId() { return `pw_${++_winIdCounter}_${Date.now()}`; }
const NON_TEXT_DIFF_PREVIEW_TYPES = new Set(["image", "spreadsheet", "pdf", "word", "presentation", "binary"]);
const PREVIEW_OPEN_DEDUPE_MS = 500;
const openingPreviewKeys = new Set<string>();
const recentlyOpenedPreviewAt = new Map<string, number>();

/** 判断当前预览类型是否适合展示文本 diff。 */
function isTextDiffPreview(result: WorkspaceFilePreviewResult | null): boolean {
  return Boolean(result && !NON_TEXT_DIFF_PREVIEW_TYPES.has(result.previewType));
}

/** 把统一预览结果映射为预览窗口字段。 */
function previewFields(result: WorkspaceFilePreviewResult | null): Pick<PreviewWindow, "previewType" | "content" | "base64" | "mimeType" | "spreadsheet"
  | "size" | "mtimeMs" | "truncated" | "encoding"> {
  return {
    previewType: result?.previewType ?? "none",
    content: result?.preview?.content ?? null,
    base64: result?.preview?.base64 ?? null,
    mimeType: result?.preview?.mimeType ?? result?.spreadsheet?.mimeType ?? null,
    spreadsheet: result?.spreadsheet ?? null,
    size: result?.preview?.size ?? null,
    mtimeMs: result?.preview?.mtimeMs ?? null,
    truncated: result?.preview?.truncated ?? null,
    encoding: result?.preview?.encoding ?? null,
  };
}

/** 加载独立窗口使用的工作区文件预览。 */
async function loadPreview(path: string): Promise<WorkspaceFilePreviewResult> {
  return await loadWorkspaceFilePreview(ctx.value, props.workspaceId, path);
}

/** 固定预览读取的工作区和认证身份；失效响应按作用域取消处理，不进入新会话展示。 */
function capturePreviewReadScope(): { workspaceId: WorkspaceId; apiContext: ApiRequestContext; isCurrent: () => boolean } {
  const workspaceId = props.workspaceId;
  const apiContext = { ...ctx.value };
  return {
    workspaceId,
    apiContext,
    isCurrent: () => props.workspaceId === workspaceId
      && ctx.value.serverWsOrigin === apiContext.serverWsOrigin
      && ctx.value.webSessionId === apiContext.webSessionId
      && ctx.value.desktopClientId === apiContext.desktopClientId
      && ctx.value.sessionToken === apiContext.sessionToken,
  };
}

/** 生成右侧预览窗口打开防重 key，区分不同来源下的同一路径。 */
function previewOpenKey(kind: "file" | "git" | "commit", path: string, scope = ""): string {
  return [props.workspaceId, kind, scope, path].join(":");
}

/** 判断并标记一次预览打开，短时间重复触发会被跳过。 */
function beginPreviewOpen(key: string): boolean {
  const now = Date.now();
  for (const [cachedKey, openedAt] of recentlyOpenedPreviewAt) {
    if (now - openedAt > PREVIEW_OPEN_DEDUPE_MS) {
      recentlyOpenedPreviewAt.delete(cachedKey);
    }
  }
  if (openingPreviewKeys.has(key)) return false;
  const lastOpenedAt = recentlyOpenedPreviewAt.get(key);
  if (lastOpenedAt != null && now - lastOpenedAt <= PREVIEW_OPEN_DEDUPE_MS) return false;
  openingPreviewKeys.add(key);
  return true;
}

/** 结束预览打开；成功创建窗口后记录短时间防重时间。 */
function finishPreviewOpen(key: string, opened: boolean): void {
  openingPreviewKeys.delete(key);
  if (opened) {
    recentlyOpenedPreviewAt.set(key, Date.now());
  }
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

/** 选中文件 → 异步加载并打开独立预览窗口 */
async function onSelectFile(path: string) {
  explorer.selectedPath = path;
  const openKey = previewOpenKey("file", path);
  if (!beginPreviewOpen(openKey)) return;
  let opened = false;
  try {
    const result = await loadPreview(path);
    const win: PreviewWindow = {
      id: nextWinId(),
      workspaceId: props.workspaceId,
      filePath: path,
      type: "file",
      ...previewFields(result),
      diffOriginal: null,
      diffModified: null,
      diffStaged: false,
      diffVersionOld: null,
      diffVersionNew: null,
      cascadeIndex: ui.explorerPreviewWindows.length,
      zIndex: 0,
    };
    ui.openPreviewWindow(win);
    opened = true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "读取文件失败");
  } finally {
    finishPreviewOpen(openKey, opened);
  }
}

/** 并发读取工作区 diff 和文件内容；作用域失效取消展示，当前 diff 失败中止。 */
async function onSelectGitFile(path: string, staged: boolean) {
  explorer.selectedPath = path;
  const openKey = previewOpenKey("git", path, staged ? "staged" : "unstaged");
  if (!beginPreviewOpen(openKey)) return;
  const scope = capturePreviewReadScope();
  let opened = false;
  try {
    const [diffResult, previewResult] = await Promise.allSettled([
      fetchGitDiffFiles(scope.apiContext, { ...explorer.gitRequestScope(scope.workspaceId), path, staged }),
      loadWorkspaceFilePreview(scope.apiContext, scope.workspaceId, path),
    ]);
    if (!scope.isCurrent()) return;
    if (diffResult.status === "rejected") throw diffResult.reason;
    const diffData = diffResult.value;
    if (!diffData.ok) throw createApiResultError(diffData);
    let filePreview: WorkspaceFilePreviewResult | null = null;
    if (previewResult.status === "fulfilled") filePreview = previewResult.value;
    else {
      const error = previewResult.reason;
      message.warning(error instanceof Error ? `文件预览加载失败：${error.message}` : "文件预览加载失败");
    }

    // 判断是否有实际 diff（新文件 original 为空时不走 diff 视图）
    const hasDiff = diffData && diffData.original;
    const showTextDiff = Boolean(hasDiff && isTextDiffPreview(filePreview));

    const headShort = explorer.gitStatus?.headCommit?.substring(0, 7) ?? "HEAD";
    const win: PreviewWindow = {
      id: nextWinId(),
      workspaceId: scope.workspaceId,
      filePath: path,
      type: showTextDiff ? "diff" : "file",
      ...previewFields(filePreview),
      diffOriginal: diffData?.original ?? null,
      diffModified: diffData?.modified ?? null,
      diffStaged: staged,
      diffVersionOld: showTextDiff ? headShort : null,
      diffVersionNew: showTextDiff ? (staged ? "暂存区" : "工作区") : null,
      cascadeIndex: ui.explorerPreviewWindows.length,
      zIndex: 0,
    };
    ui.openPreviewWindow(win);
    opened = true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "读取文件变更失败");
  } finally {
    finishPreviewOpen(openKey, opened);
  }
}

/** 并发读取固定提交 diff 和文件内容；沿工作区预览的作用域与失败边界处理。 */
async function onSelectCommitFile(path: string) {
  if (!explorer.gitCommitDetail) return;
  const entry = explorer.gitCommitDetail.entry;
  const hash = entry.hash;
  const openKey = previewOpenKey("commit", path, hash);
  if (!beginPreviewOpen(openKey)) return;
  const scope = capturePreviewReadScope();
  let opened = false;

  try {
    const [diffResult, previewResult] = await Promise.allSettled([
      fetchGitShowFileDiff(scope.apiContext, { ...explorer.gitRequestScope(scope.workspaceId), hash, path }),
      loadWorkspaceFilePreview(scope.apiContext, scope.workspaceId, path),
    ]);
    if (!scope.isCurrent()) return;
    if (diffResult.status === "rejected") throw diffResult.reason;
    const diffData = diffResult.value;
    if (!diffData.ok) throw createApiResultError(diffData);
    let filePreview: WorkspaceFilePreviewResult | null = null;
    if (previewResult.status === "fulfilled") filePreview = previewResult.value;
    else {
      const error = previewResult.reason;
      message.warning(error instanceof Error ? `文件预览加载失败：${error.message}` : "文件预览加载失败");
    }

    const parentShort = entry.parents?.[0]?.substring(0, 7) ?? "初始提交";
    const showTextDiff = Boolean(diffData && isTextDiffPreview(filePreview));
    const win: PreviewWindow = {
      id: nextWinId(),
      workspaceId: scope.workspaceId,
      filePath: path,
      type: showTextDiff ? "diff" : "file",
      ...previewFields(filePreview),
      diffOriginal: diffData?.original ?? null,
      diffModified: diffData?.modified ?? null,
      diffStaged: false,
      diffVersionOld: showTextDiff ? parentShort : null,
      diffVersionNew: showTextDiff ? entry.hashShort : null,
      cascadeIndex: ui.explorerPreviewWindows.length,
      zIndex: 0,
    };
    ui.openPreviewWindow(win);
    opened = true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "读取提交文件失败");
  } finally {
    finishPreviewOpen(openKey, opened);
  }
}
</script>

<template>
  <div class="explorer-right-panel">
    <ExplorerSidebar
      :workspace-id="workspaceId"
      :ctx="ctx"
      @select-file="onSelectFile"
      @select-git-file="onSelectGitFile"
      @select-commit-file="onSelectCommitFile"
    />
  </div>
</template>

<style scoped>
.explorer-right-panel {
  width: 100%;
  height: 100%;
  padding: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
</style>

