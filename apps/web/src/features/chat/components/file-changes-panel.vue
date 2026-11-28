<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { CaretDownOutlined, CaretUpOutlined, CheckCircleOutlined, FileTextOutlined, FileExclamationOutlined, EyeOutlined, SwapOutlined, UndoOutlined, ReloadOutlined, CodeOutlined, MinusOutlined, PlusOutlined, CopyOutlined, LoadingOutlined, FullscreenExitOutlined, FullscreenOutlined } from "@ant-design/icons-vue";
import { copyToClipboard } from "@/composables/useClipboard";
import { getPathDisplayInfo } from "@codeflowai/shared";
import type { GetThreadFileChangeDiffResponseBody, ThreadFileChangeSummary, ThreadId, WorkspaceId } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { getThreadFileChangeDiff } from "../../../api/threads";
import { createCancelledRequestError, isCancelledRequestError, type AbortKind } from "../../../api/request";
import { useUiStore, type PreviewWindow } from "../../../store/ui";
import { useConfigStore } from "../../../store/config";
import DiffViewer from "./diff-viewer.vue";
import CodePreview from "../../explorer/components/code-preview.vue";
import HtmlPreview from "../../explorer/components/html-preview.vue";
import MarkdownPreview from "../../explorer/components/markdown-preview.vue";
import PdfPreview from "../../explorer/components/pdf-preview.vue";
import PresentationPreview from "../../explorer/components/presentation-preview.vue";
import SpreadsheetPreview from "../../explorer/components/spreadsheet-preview.vue";
import WordPreview from "../../explorer/components/word-preview.vue";
import { usePreviewZoom, type PreviewZoomKind } from "../../explorer/usePreviewZoom";
import { isDocumentPreviewPath, isSpreadsheetPreviewPath, loadWorkspaceFilePreview } from "../../explorer/workspaceFilePreview";

defineOptions({ name: "FileChangesPanel" });

type Props = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  loading: boolean;
  items: ThreadFileChangeSummary[];
  error?: string | null;
  mode?: "default" | "toolbar";
  disabled?: boolean;
  expanded?: boolean;
};

type Emits = {
  (e: "refresh"): void;
  (e: "undo", paths: string[] | null): void;
  (e: "accept", paths: string[]): void;
  (e: "expandedChange", value: boolean): void;
};

const props = withDefaults(defineProps<Props>(), {
  mode: "default",
  disabled: false,
  expanded: false,
});
const emit = defineEmits<Emits>();

const { ctx } = useApiContext();
const ui = useUiStore();
const config = useConfigStore();

const isMobile = typeof window !== "undefined" && window.innerWidth <= 767;

const rootEl = ref<HTMLElement | null>(null);
const PANEL_SOURCE = "file-changes";
const isToolbarMode = computed(() => props.mode === "toolbar");
const selectedPaths = ref<string[]>([]);
const viewing = ref(false);
const viewOpen = ref(false);
const viewFullscreen = ref(false);
const viewData = ref<GetThreadFileChangeDiffResponseBody | null>(null);
const inlineDiff = ref(false);
const viewPath = ref("");
const viewAccepted = ref(false);

const previewOpen = ref(false);
const previewFullscreen = ref(false);
type FileChangePreviewType = "code" | "markdown" | "html" | "spreadsheet" | "pdf" | "word" | "presentation" | "image" | "binary" | "deleted";
const previewData = ref<{
  content: string;
  path: string;
  type: FileChangePreviewType;
  base64?: string | null;
  mimeType?: string | null;
  spreadsheet?: PreviewWindow["spreadsheet"];
} | null>(null);
const previewShowRaw = ref(false);
const copyingDiff = ref(false);
const copyingPreview = ref(false);
/** 正在加载预览的文件路径（用于显示 loading 状态） */
const previewLoadingPath = ref<string | null>(null);
/** 正在加载差异的文件路径（用于显示 loading 状态） */
const viewLoadingPath = ref<string | null>(null);
let panelScopeVersion = 0;
let viewAbortController: AbortController | null = null;
let previewAbortController: AbortController | null = null;

async function copyDiffContent(): Promise<void> {
  if (copyingDiff.value || !viewData.value) return;
  copyingDiff.value = true;
  try {
    await copyToClipboard(viewData.value.afterText ?? "");
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  } finally {
    copyingDiff.value = false;
  }
}

async function copyPreviewContent(): Promise<void> {
  if (copyingPreview.value || !previewData.value) return;
  copyingPreview.value = true;
  try {
    await copyToClipboard(previewData.value.content);
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  } finally {
    copyingPreview.value = false;
  }
}

const previewZoomKind = computed<PreviewZoomKind | null>(() => {
  if (viewOpen.value && viewData.value && !viewData.value.isBinary) return "diff";
  if (!previewOpen.value || !previewData.value) return null;
  if (previewData.value.type === "code") return "code";
  if (previewData.value.type === "markdown") return "markdown";
  return null;
});
const { scale, scaleLabel, canZoom, canZoomIn, canZoomOut, zoomIn, zoomOut, resetZoom } = usePreviewZoom(previewZoomKind);
const viewFullscreenTitle = computed(() => viewFullscreen.value ? "还原差异预览" : "全屏查看差异预览");
const previewFullscreenTitle = computed(() => previewFullscreen.value ? "还原文件预览" : "全屏查看文件预览");
const viewModalWidth = computed(() => viewFullscreen.value ? "100vw" : "90%");
const previewModalWidth = computed(() => previewFullscreen.value ? "100vw" : "80%");
/** 桌面全屏只覆盖内容区，保留 44px 应用顶栏与窗口控制。 */
const viewDesktopFullscreen = computed(() => viewFullscreen.value && config.isDesktop);
const previewDesktopFullscreen = computed(() => previewFullscreen.value && config.isDesktop);
const viewModalBodyStyle = computed(() => {
  if (!viewFullscreen.value) return { padding: "2px 0" };
  if (viewDesktopFullscreen.value) return { padding: "2px 0", overflow: "hidden" };
  return { padding: "2px 0", height: "calc(100dvh - 56px)", maxHeight: "calc(100dvh - 56px)", overflow: "hidden" };
});
const previewModalBodyStyle = computed(() => {
  if (!previewFullscreen.value) return { padding: "2px 0" };
  if (previewDesktopFullscreen.value) return { padding: "2px 0", overflow: "hidden" };
  return { padding: "2px 0", height: "calc(100dvh - 56px)", maxHeight: "calc(100dvh - 56px)", overflow: "hidden" };
});
const viewModalWrapClassName = computed(() => [
  "file-changes-diff-modal",
  viewFullscreen.value ? "file-changes-diff-modal--fullscreen" : "",
  viewDesktopFullscreen.value ? "file-changes-diff-modal--desktop-fullscreen" : "",
].filter(Boolean).join(" "));
const previewModalWrapClassName = computed(() => [
  "file-changes-preview-modal",
  previewFullscreen.value ? "file-changes-preview-modal--fullscreen" : "",
  previewDesktopFullscreen.value ? "file-changes-preview-modal--desktop-fullscreen" : "",
].filter(Boolean).join(" "));

/** 根据路径和 diff 响应推断文件变更面板的兜底预览类型。 */
function detectPreviewType(path: string, isBinary: boolean, isDeleted: boolean): FileChangePreviewType {
  if (isDeleted) return "deleted";
  if (isSpreadsheetPreviewPath(path)) return "spreadsheet";
  if (isDocumentPreviewPath(path)) return path.toLowerCase().endsWith(".pdf") ? "pdf" : "word";
  if (isBinary) return "binary";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"].includes(ext)) return "image";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["html", "htm"].includes(ext)) return "html";
  return "code";
}

const canUndoSelected = computed(() => !props.disabled && selectedPaths.value.length > 0);
const canUndoAll = computed(() => !props.disabled && props.items.some((i) => !i.isAccepted && i.canUndo));
const canAcceptSelected = computed(() => !props.disabled && selectedPaths.value.some((p) => !props.items.find((i) => i.path === p)?.isAccepted));

const modifiedCount = computed(() => props.items.filter((i) => i.status !== "created" && i.status !== "deleted").length);
const createdCount = computed(() => props.items.filter((i) => i.status === "created").length);
const deletedCount = computed(() => props.items.filter((i) => i.status === "deleted").length);

const headerSummary = computed(() => {
  const parts: string[] = [];
  if (modifiedCount.value > 0) parts.push(`修改 ${modifiedCount.value}`);
  if (createdCount.value > 0) parts.push(`新增 ${createdCount.value}`);
  if (deletedCount.value > 0) parts.push(`删除 ${deletedCount.value}`);
  return parts.join(" · ");
});

function statusLabel(s: ThreadFileChangeSummary["status"]): string {
  if (s === "created") return "新建";
  if (s === "deleted") return "删除";
  return "修改";
}

function statusClass(s: ThreadFileChangeSummary["status"]): string {
  if (s === "created") return "fc-status--created";
  if (s === "deleted") return "fc-status--deleted";
  return "fc-status--modified";
}

function fileName(p: string): string { return getPathDisplayInfo(p).fileName; }
function fileDir(p: string): string { return getPathDisplayInfo(p).dirPath; }

/** 关闭差异预览并取消进行中的差异读取请求。 */
function closeView(): void {
  cancelViewRequest("scope-change");
  viewFullscreen.value = false;
  viewOpen.value = false;
  viewData.value = null;
  viewAccepted.value = false;
  viewLoadingPath.value = null;
}

/** 切换文件差异弹框全屏状态，保留当前 diff 和缩放上下文。 */
function toggleViewFullscreen(): void {
  viewFullscreen.value = !viewFullscreen.value;
}

async function openView(item: ThreadFileChangeSummary): Promise<void> {
  if (viewing.value) return;
  cancelViewRequest("scope-change");
  const scopeVersion = panelScopeVersion;
  const controller = new AbortController();
  viewAbortController = controller;
  viewPath.value = item.path;
  viewAccepted.value = item.isAccepted ?? false;
  viewing.value = true;
  viewLoadingPath.value = item.path;
  try {
    const res = await getThreadFileChangeDiff(
      ctx.value,
      { workspaceId: props.workspaceId, threadId: props.threadId, path: item.path },
      { signal: controller.signal },
    );
    if (!res.ok) throw new Error(res.message);
    if (controller.signal.aborted || scopeVersion !== panelScopeVersion) {
      throw createCancelledRequestError("stale-result");
    }
    if (isMobile) {
      const win: PreviewWindow = {
        id: `fc-diff-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        workspaceId: props.workspaceId,
        filePath: item.path,
        type: "diff",
        previewType: "code",
        content: res.afterText ?? null,
        base64: null, mimeType: null,
        diffOriginal: (item.isAccepted ? res.afterText : res.beforeText) ?? null,
        diffModified: res.afterText ?? null,
        diffStaged: false,
        diffVersionOld: null, diffVersionNew: null,
        cascadeIndex: 0, zIndex: 0,
      };
      ui.pushMobilePage({ type: "explorer-preview", context: { win } });
      return;
    }
    viewData.value = res;
    viewOpen.value = true;
  } catch (e) {
    if (isCancelledRequestError(e)) return;
    message.error(e instanceof Error ? e.message : "读取差异失败");
  } finally {
    if (viewAbortController === controller) viewAbortController = null;
    viewing.value = false;
    viewLoadingPath.value = null;
  }
}

/** 关闭文件预览并取消进行中的预览读取请求。 */
function closePreview(): void {
  cancelPreviewRequest("scope-change");
  previewFullscreen.value = false;
  previewOpen.value = false;
  previewData.value = null;
  previewShowRaw.value = false;
  previewLoadingPath.value = null;
}

/** 切换文件预览弹框全屏状态，保留当前预览内容和缩放上下文。 */
function togglePreviewFullscreen(): void {
  previewFullscreen.value = !previewFullscreen.value;
}

async function openPreview(item: ThreadFileChangeSummary): Promise<void> {
  if (previewLoadingPath.value) return;
  const isDeleted = item.status === "deleted";
  cancelPreviewRequest("scope-change");
  const scopeVersion = panelScopeVersion;
  const controller = new AbortController();
  previewAbortController = controller;
  previewLoadingPath.value = item.path;
  try {
    if (!isDeleted && (isSpreadsheetPreviewPath(item.path) || isDocumentPreviewPath(item.path))) {
      const preview = await loadWorkspaceFilePreview(ctx.value, props.workspaceId, item.path, { signal: controller.signal });
      if (controller.signal.aborted || scopeVersion !== panelScopeVersion) {
        throw createCancelledRequestError("stale-result");
      }
      if (
        (preview.previewType === "spreadsheet" && !preview.spreadsheet)
        || (preview.previewType === "pdf" && !preview.preview?.base64)
        || (preview.previewType === "presentation" && !preview.preview?.base64)
        || (preview.previewType === "word" && preview.preview?.content == null)
        || !["spreadsheet", "pdf", "word", "presentation"].includes(preview.previewType)
      ) {
        throw new Error("当前文件不是可预览文档");
      }
      if (isMobile) {
        const win: PreviewWindow = {
          id: `fc-preview-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          workspaceId: props.workspaceId,
          filePath: item.path,
          type: "file",
          previewType: preview.previewType,
          content: preview.preview?.content ?? null,
          base64: preview.preview?.base64 ?? null,
          mimeType: preview.preview?.mimeType ?? preview.spreadsheet?.mimeType ?? null,
          spreadsheet: preview.spreadsheet ?? null,
          diffOriginal: null, diffModified: null, diffStaged: false,
          diffVersionOld: null, diffVersionNew: null,
          cascadeIndex: 0, zIndex: 0,
        };
        ui.pushMobilePage({ type: "explorer-preview", context: { win } });
        return;
      }
      previewData.value = {
        content: preview.preview?.content ?? "",
        path: item.path,
        type: preview.previewType as FileChangePreviewType,
        base64: preview.preview?.base64 ?? null,
        mimeType: preview.preview?.mimeType ?? preview.spreadsheet?.mimeType ?? null,
        spreadsheet: preview.spreadsheet ?? undefined,
      };
      previewOpen.value = true;
      return;
    }

    const res = await getThreadFileChangeDiff(
      ctx.value,
      { workspaceId: props.workspaceId, threadId: props.threadId, path: item.path },
      { signal: controller.signal },
    );
    if (!res.ok) throw new Error(res.message);
    if (controller.signal.aborted || scopeVersion !== panelScopeVersion) {
      throw createCancelledRequestError("stale-result");
    }
    if (isMobile) {
      const type = detectPreviewType(item.path, !!res.isBinary, isDeleted);
      const pt: PreviewWindow["previewType"] = type === "deleted" ? "binary" : type;
      const win: PreviewWindow = {
        id: `fc-preview-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        workspaceId: props.workspaceId,
        filePath: item.path,
        type: "file",
        previewType: pt,
        content: res.afterText ?? null,
        base64: null, mimeType: null,
        spreadsheet: null,
        diffOriginal: null, diffModified: null, diffStaged: false,
        diffVersionOld: null, diffVersionNew: null,
        cascadeIndex: 0, zIndex: 0,
      };
      ui.pushMobilePage({ type: "explorer-preview", context: { win } });
      return;
    }
    const type = detectPreviewType(item.path, !!res.isBinary, isDeleted);
    previewData.value = { content: res.afterText ?? "", path: item.path, type };
    previewOpen.value = true;
  } catch (e) {
    if (isCancelledRequestError(e)) return;
    message.error(e instanceof Error ? e.message : "读取文件失败");
  } finally {
    if (previewAbortController === controller) previewAbortController = null;
    previewLoadingPath.value = null;
  }
}

/** 切换文件变更预览弹框中的表格工作表。 */
async function onPreviewSheetChange(sheetName: string): Promise<void> {
  if (!previewData.value || previewData.value.type !== "spreadsheet") return;
  try {
    const preview = await loadWorkspaceFilePreview(ctx.value, props.workspaceId, previewData.value.path, { sheetName });
    if (preview.previewType !== "spreadsheet" || !preview.spreadsheet) {
      throw new Error("当前文件不是可预览表格");
    }
    previewData.value = { ...previewData.value, spreadsheet: preview.spreadsheet };
  } catch (error) {
    message.error(error instanceof Error ? error.message : "切换工作表失败");
  }
}

function handleAccept(path: string): void {
  if (props.disabled) return;
  emit("accept", [path]);
}

function confirmUndo(paths: string[] | null): void {
  if (props.disabled) return;
  const title = paths?.length ? "撤销所选文件变更" : "撤销全部文件变更";
  const count = paths?.length ?? props.items.length;
  Modal.confirm({
    title,
    content: `将撤销 ${count} 个文件的会话变更（只影响该会话记录过的文件）。`,
    okText: "撤销",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      emit("undo", paths);
      selectedPaths.value = [];
    },
  });
}

function toggleExpanded(): void {
  const next = !props.expanded;
  emit("expandedChange", next);
  if (next) {
    window.dispatchEvent(new CustomEvent("chat-floatbox:expand", { detail: { source: PANEL_SOURCE } }));
  }
}

function handleOtherExpand(event: Event): void {
  const source = (event as CustomEvent<{ source?: string }>).detail?.source;
  if (source !== PANEL_SOURCE && props.expanded) emit("expandedChange", false);
}

function handleWindowPointerDown(event: PointerEvent): void {
  if (!props.expanded || !isToolbarMode.value) return;
  if (viewOpen.value || previewOpen.value) return;
  const root = rootEl.value;
  const target = event.target as Node | null;
  if (!root || !target) return;
  if (!root.contains(target)) emit("expandedChange", false);
}

onMounted(() => {
  window.addEventListener("chat-floatbox:expand", handleOtherExpand as EventListener);
  window.addEventListener("pointerdown", handleWindowPointerDown);
});

onBeforeUnmount(() => {
  cancelViewRequest("component-unmount");
  cancelPreviewRequest("component-unmount");
  window.removeEventListener("chat-floatbox:expand", handleOtherExpand as EventListener);
  window.removeEventListener("pointerdown", handleWindowPointerDown);
});

watch(
  () => [props.workspaceId, props.threadId] as const,
  () => {
    panelScopeVersion += 1;
    emit("expandedChange", false);
    selectedPaths.value = [];
    closeView();
    closePreview();
  },
);

function cancelViewRequest(reason: AbortKind): void {
  if (!viewAbortController) return;
  viewAbortController.abort(createCancelledRequestError(reason));
  viewAbortController = null;
}

function cancelPreviewRequest(reason: AbortKind): void {
  if (!previewAbortController) return;
  previewAbortController.abort(createCancelledRequestError(reason));
  previewAbortController = null;
}
</script>

<template>
  <div
    ref="rootEl"
    class="fc-bar-wrap"
    :class="{ 'fc-bar-wrap--expanded': props.expanded, 'fc-bar-wrap--toolbar': isToolbarMode }"
  >
    <button
      v-if="isToolbarMode"
      type="button"
      class="fc-bar__chip"
      :aria-expanded="props.expanded"
      aria-label="切换文件"
      @click="toggleExpanded"
    >
      <FileTextOutlined class="fc-bar__chip-icon" />
      <span class="fc-bar__chip-count">{{ props.items.length }}</span>
      <span class="fc-bar__chip-toggle">
        <CaretDownOutlined v-if="props.expanded" />
        <CaretUpOutlined v-else />
      </span>
    </button>
    <button v-if="props.expanded && !isToolbarMode" type="button" class="fc-bar__backdrop" aria-label="关闭文件" @click="emit('expandedChange', false)" />
    <div
      v-if="!isToolbarMode || props.expanded"
      class="fc-bar"
      :class="{ 'fc-bar--expanded': props.expanded, 'fc-bar--toolbar-popup': isToolbarMode }"
    >
      <div class="fc-bar__header" @click="toggleExpanded">
        <FileTextOutlined class="fc-bar__icon" />
        <span class="fc-bar__title">文件</span>
        <span class="fc-bar__summary">{{ headerSummary }}</span>
        <span class="fc-bar__count">{{ props.items.length }}</span>
        <span class="fc-bar__toggle"><CaretDownOutlined v-if="props.expanded" /><CaretUpOutlined v-else /></span>
      </div>

      <template v-if="props.expanded">
        <div class="fc-bar__body">
          <div class="fc-bar__explanation">{{ headerSummary }}</div>
          <a-alert v-if="props.error" type="error" show-icon :message="props.error" style="margin-bottom: 6px" />
          <a-spin :spinning="props.loading">
            <a-checkbox-group v-model:value="selectedPaths" class="fc-check-group">
              <!--
                单一 grid 容器，所有单元格都是直接子元素，
                保证 状态/文件名/路径/操作 各列严格对齐。
              -->
              <div class="fc-table">
                <template v-for="it in props.items" :key="it.path">
                  <a-checkbox :value="it.path" :disabled="props.disabled || !it.canUndo" class="fc-table__check" />
                  <span class="fc-table__status" :class="statusClass(it.status)">{{ statusLabel(it.status) }}</span>
                  <span class="fc-table__name mono fc-table__name--clickable" :title="it.path" @click.stop="openPreview(it)">
                    <LoadingOutlined v-if="previewLoadingPath === it.path" class="fc-table__spinner" />
                    {{ fileName(it.path) }}<span v-if="!it.canUndo" class="fc-table__warn">缺快照</span>
                  </span>
                  <span class="fc-table__dir mono" :title="it.path">{{ fileDir(it.path) }}</span>
                  <span class="fc-table__actions">
                    <a-tooltip title="预览文件" placement="top">
                      <span class="fc-table__action" aria-label="预览文件" @click.stop="openPreview(it)"><LoadingOutlined v-if="previewLoadingPath === it.path" /><EyeOutlined v-else /></span>
                    </a-tooltip>
                    <a-tooltip title="查看差异" placement="top">
                      <span class="fc-table__action" aria-label="查看差异" @click.stop="openView(it)"><LoadingOutlined v-if="viewLoadingPath === it.path" /><SwapOutlined v-else /></span>
                    </a-tooltip>
                    <a-tooltip v-if="it.isAccepted" title="已接受" placement="top">
                      <span class="fc-table__action fc-table__action--accepted" aria-label="已接受"><CheckCircleOutlined /></span>
                    </a-tooltip>
                    <a-tooltip v-else title="接受变更" placement="top">
                      <span class="fc-table__action fc-table__action--commit" :class="{ 'fc-table__action--disabled': props.disabled }" aria-label="接受变更" @click.stop="!props.disabled && handleAccept(it.path)"><CheckCircleOutlined /></span>
                    </a-tooltip>
                    <a-tooltip v-if="!it.isAccepted" title="撤销" placement="top">
                      <span class="fc-table__action fc-table__action--danger" :class="{ 'fc-table__action--disabled': props.disabled || !it.canUndo }" aria-label="撤销" @click.stop="!props.disabled && it.canUndo && confirmUndo([it.path])"><UndoOutlined /></span>
                    </a-tooltip>
                  </span>
                </template>
              </div>
            </a-checkbox-group>
          </a-spin>
        </div>

        <div class="fc-bar__toolbar">
          <span class="fc-bar__tool-btn fc-bar__tool-btn--accept" :class="{ 'fc-bar__tool-btn--disabled': !canAcceptSelected }" @click="canAcceptSelected && emit('accept', selectedPaths)">接受所选</span>
          <span class="fc-bar__tool-btn fc-bar__tool-btn--danger" :class="{ 'fc-bar__tool-btn--disabled': !canUndoSelected }" @click="canUndoSelected && confirmUndo(selectedPaths)">撤销所选</span>
          <span class="fc-bar__tool-btn fc-bar__tool-btn--danger" :class="{ 'fc-bar__tool-btn--disabled': !canUndoAll }" @click="canUndoAll && confirmUndo(null)">撤销全部</span>
          <span class="fc-bar__tool-btn" :class="{ 'fc-bar__tool-btn--loading': props.loading }" @click="emit('refresh')"><ReloadOutlined :spin="props.loading" /> 刷新</span>
        </div>
      </template>
    </div>
  </div>

  <a-modal
    :open="viewOpen"
    :footer="null"
    :width="viewModalWidth"
    :body-style="viewModalBodyStyle"
    :wrap-class-name="viewModalWrapClassName"
    @cancel="closeView"
  >
    <template #title>
      <div class="diff-modal__header">
        <span class="diff-modal__path mono">{{ viewPath }}</span>
        <div class="diff-modal__tools">
          <a-tooltip :title="viewFullscreenTitle">
            <a-button size="small" type="text" :aria-label="viewFullscreenTitle" @click.stop="toggleViewFullscreen">
              <component :is="viewFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
            </a-button>
          </a-tooltip>
          <a-tooltip v-if="viewData && !viewData.isBinary" title="复制" placement="bottom">
            <a-button size="small" type="text" aria-label="复制" :disabled="copyingDiff" @click="copyDiffContent"><CopyOutlined /></a-button>
          </a-tooltip>
          <a-switch v-if="!viewAccepted" v-model:checked="inlineDiff" size="small" checked-children="单列" un-checked-children="对比" />
          <a-tooltip title="缩小" placement="bottom">
            <a-button size="small" type="text" aria-label="缩小" :disabled="!canZoomOut" @click="zoomOut"><MinusOutlined /></a-button>
          </a-tooltip>
          <a-tooltip title="重置缩放" placement="bottom">
            <a-button size="small" type="text" aria-label="重置缩放" @click="resetZoom">{{ scaleLabel }}</a-button>
          </a-tooltip>
          <a-tooltip title="放大" placement="bottom">
            <a-button size="small" type="text" aria-label="放大" :disabled="!canZoomIn" @click="zoomIn"><PlusOutlined /></a-button>
          </a-tooltip>
        </div>
      </div>
    </template>
    <div v-if="viewData" class="diff-modal__body" :class="{ 'diff-modal__body--fullscreen': viewFullscreen }">
      <a-alert v-if="viewAccepted" type="success" show-icon message="该文件变更已接受" style="margin-bottom: 8px; flex-shrink: 0;" />
      <a-alert v-if="viewData.isBinary" type="warning" show-icon message="该文件为二进制或过大，无法预览。" />
      <div v-else class="diff-modal__diff-frame">
        <DiffViewer
          :original="viewAccepted ? (viewData.afterText ?? '') : (viewData.beforeText ?? '')"
          :modified="viewData.afterText ?? ''"
          :file-path="viewData.path"
          :inline="viewAccepted || inlineDiff"
          :font-scale="scale"
        />
      </div>
    </div>
  </a-modal>

  <a-modal
    :open="previewOpen"
    :footer="null"
    :width="previewModalWidth"
    :body-style="previewModalBodyStyle"
    :wrap-class-name="previewModalWrapClassName"
    @cancel="closePreview"
  >
    <template #title>
      <div class="diff-modal__header">
        <span class="diff-modal__path mono">{{ previewData?.path }}</span>
        <div class="diff-modal__tools">
          <a-tooltip :title="previewFullscreenTitle">
            <a-button size="small" type="text" :aria-label="previewFullscreenTitle" @click.stop="togglePreviewFullscreen">
              <component :is="previewFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
            </a-button>
          </a-tooltip>
          <a-tooltip v-if="previewData && (previewData.type === 'code' || previewData.type === 'markdown' || previewData.type === 'html')" title="复制" placement="bottom">
            <a-button size="small" type="text" aria-label="复制" :disabled="copyingPreview" @click="copyPreviewContent"><CopyOutlined /></a-button>
          </a-tooltip>
          <a-tooltip v-if="previewData?.type === 'markdown'" :title="previewShowRaw ? '渲染预览' : '查看源码'">
            <span class="fc-table__action" style="cursor: pointer; font-size: 16px;" @click="previewShowRaw = !previewShowRaw"><CodeOutlined /></span>
          </a-tooltip>
          <template v-if="canZoom">
            <a-tooltip title="缩小" placement="bottom">
              <a-button size="small" type="text" aria-label="缩小" :disabled="!canZoomOut" @click="zoomOut"><MinusOutlined /></a-button>
            </a-tooltip>
            <a-tooltip title="重置缩放" placement="bottom">
              <a-button size="small" type="text" aria-label="重置缩放" @click="resetZoom">{{ scaleLabel }}</a-button>
            </a-tooltip>
            <a-tooltip title="放大" placement="bottom">
              <a-button size="small" type="text" aria-label="放大" :disabled="!canZoomIn" @click="zoomIn"><PlusOutlined /></a-button>
            </a-tooltip>
          </template>
        </div>
      </div>
    </template>
    <div v-if="previewData" class="diff-modal__body" :class="{ 'diff-modal__body--fullscreen': previewFullscreen }">
      <template v-if="previewData.type === 'deleted'">
        <div style="display: flex; align-items: center; justify-content: center; height: 200px; flex-direction: column; gap: 8px; color: var(--app-muted);">
          <FileExclamationOutlined style="font-size: 48px" />
          <p>文件已删除，无内容可预览</p>
        </div>
      </template>
      <template v-else-if="previewData.type === 'binary' || previewData.type === 'image'">
        <div style="display: flex; align-items: center; justify-content: center; height: 200px; flex-direction: column; gap: 8px; color: var(--app-muted);">
          <FileExclamationOutlined style="font-size: 48px" />
          <p>该文件无法预览</p>
        </div>
      </template>
      <template v-else-if="previewData.type === 'markdown'">
        <div class="diff-modal__preview-frame diff-modal__preview-frame--scroll">
          <MarkdownPreview :content="previewData.content" :file-path="previewData.path" :workspace-id="workspaceId" :show-raw="previewShowRaw" :font-scale="scale" />
        </div>
      </template>
      <template v-else-if="previewData.type === 'html'">
        <div class="diff-modal__preview-frame">
          <HtmlPreview :content="previewData.content" :file-path="previewData.path" />
        </div>
      </template>
      <template v-else-if="previewData.type === 'spreadsheet' && previewData.spreadsheet">
        <div class="diff-modal__preview-frame">
          <SpreadsheetPreview :preview="previewData.spreadsheet" @sheet-change="onPreviewSheetChange" />
        </div>
      </template>
      <template v-else-if="previewData.type === 'pdf' && previewData.base64">
        <div class="diff-modal__preview-frame diff-modal__preview-frame--document">
          <PdfPreview :base64="previewData.base64" :mime-type="previewData.mimeType" :file-path="previewData.path" />
        </div>
      </template>
      <template v-else-if="previewData.type === 'word'">
        <div class="diff-modal__preview-frame diff-modal__preview-frame--document">
          <WordPreview :content="previewData.content" :file-path="previewData.path" />
        </div>
      </template>
      <template v-else-if="previewData.type === 'presentation' && previewData.base64">
        <div class="diff-modal__preview-frame diff-modal__preview-frame--document">
          <PresentationPreview :base64="previewData.base64" :file-path="previewData.path" />
        </div>
      </template>
      <template v-else>
        <div class="diff-modal__preview-frame">
          <CodePreview :content="previewData.content" :file-path="previewData.path" :font-scale="scale" />
        </div>
      </template>
    </div>
  </a-modal>
</template>

<style scoped>
.diff-modal__header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: calc(100% - 44px);
  box-sizing: border-box;
}

.diff-modal__path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-modal__tools {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.diff-modal__tools :deep(.ant-btn) {
  padding-inline: 6px;
}

.diff-modal__body {
  display: flex;
  flex-direction: column;
  height: 70vh;
  min-height: 0;
}

.diff-modal__diff-frame,
.diff-modal__preview-frame {
  flex: 1;
  min-height: 300px;
  max-height: 70vh;
  overflow: hidden;
}

.diff-modal__preview-frame--scroll {
  overflow: auto;
}

.diff-modal__preview-frame--document {
  height: 70vh;
}

:global(.file-changes-diff-modal--fullscreen.ant-modal-wrap),
:global(.file-changes-preview-modal--fullscreen.ant-modal-wrap) {
  overflow: hidden !important;
}

/* 桌面全屏从 44px 应用顶栏下方开始，保留导航与窗口控制可点击。 */
:global(.file-changes-diff-modal--desktop-fullscreen.ant-modal-wrap),
:global(.file-changes-preview-modal--desktop-fullscreen.ant-modal-wrap) {
  top: 44px !important;
  height: calc(100dvh - 44px) !important;
}

:global(.file-changes-diff-modal--fullscreen .ant-modal),
:global(.file-changes-preview-modal--fullscreen .ant-modal) {
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100dvh !important;
  min-height: 100dvh !important;
  max-height: 100dvh !important;
  margin: 0 !important;
  top: 0 !important;
  padding-bottom: 0 !important;
}

:global(.file-changes-diff-modal--desktop-fullscreen .ant-modal),
:global(.file-changes-preview-modal--desktop-fullscreen .ant-modal) {
  height: 100% !important;
  min-height: 100% !important;
  max-height: 100% !important;
}

:global(.file-changes-diff-modal--fullscreen .ant-modal-content),
:global(.file-changes-preview-modal--fullscreen .ant-modal-content) {
  display: flex;
  flex-direction: column;
  height: 100dvh !important;
  max-height: 100dvh !important;
  border-radius: 0;
  overflow: hidden;
}

:global(.file-changes-diff-modal--desktop-fullscreen .ant-modal-content),
:global(.file-changes-preview-modal--desktop-fullscreen .ant-modal-content) {
  height: 100% !important;
  max-height: 100% !important;
}

:global(.file-changes-diff-modal--fullscreen .ant-modal-body),
:global(.file-changes-preview-modal--fullscreen .ant-modal-body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden !important;
}

:global(.file-changes-diff-modal--fullscreen) .diff-modal__body,
:global(.file-changes-preview-modal--fullscreen) .diff-modal__body,
:global(.file-changes-diff-modal--fullscreen) .diff-modal__diff-frame,
:global(.file-changes-preview-modal--fullscreen) .diff-modal__preview-frame {
  height: 100%;
  max-height: none;
  min-height: 0;
}

.diff-modal__body--fullscreen {
  height: 100%;
  max-height: none;
  min-height: 0;
}

.diff-modal__body--fullscreen .diff-modal__diff-frame,
.diff-modal__body--fullscreen .diff-modal__preview-frame {
  flex: 1 1 auto;
  height: auto;
  max-height: none;
  min-height: 0;
}

@media (max-width: 767px) {
  .diff-modal__header {
    width: calc(100% - 48px);
  }

  .diff-modal__tools {
    gap: 2px;
  }
}
</style>
