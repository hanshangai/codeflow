<script setup lang="ts">
import { ref, computed, reactive, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import {
  EyeOutlined, CodeOutlined, ColumnWidthOutlined, ColumnHeightOutlined,
  CompressOutlined, ExpandOutlined, UpOutlined, DownOutlined,
  MinusOutlined, PlusOutlined, CopyOutlined, UnorderedListOutlined,
  DownloadOutlined, FullscreenExitOutlined, FullscreenOutlined, CloseOutlined,
  SaveOutlined, RollbackOutlined,
} from "@ant-design/icons-vue";
import { useUiStore, type PreviewWindow } from "../../../store/ui";
import { useConfigStore } from "../../../store/config";
import { useApiContext } from "../../../composables/useApiContext";
import { copyToClipboard } from "@/composables/useClipboard";
import CodePreview from "./code-preview.vue";
import HtmlPreview from "./html-preview.vue";
import ImagePreview from "./image-preview.vue";
import MarkdownPreview from "./markdown-preview.vue";
import PdfPreview from "./pdf-preview.vue";
import PresentationPreview from "./presentation-preview.vue";
import SpreadsheetPreview from "./spreadsheet-preview.vue";
import WordPreview from "./word-preview.vue";
import DiffViewer from "../../chat/components/diff-viewer.vue";
import { downloadWorkspaceFile } from "../../../api/fs";
import { trackProductEvent } from "../../../analytics/analytics";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { usePreviewZoom, type PreviewZoomKind } from "../usePreviewZoom";
import { loadWorkspaceFilePreview } from "../workspaceFilePreview";
import { canEditFilePreview, discardFileEditorDraft, ensureFileEditorDraft, isFileEditorDirty,
  saveFileEditorDraft, updateFileEditorContent, type FileEditorDraft, type FileEditorSource } from "../fileEditorState";

defineOptions({ name: "ExplorerPreviewWindow" });

const props = defineProps<{
  win: PreviewWindow;
  /** 嵌入模式（移动端页面栈），不渲染 a-modal 外壳 */
  embedded?: boolean;
}>();

const ui = useUiStore();
const config = useConfigStore();
const { ctx } = useApiContext();
const isMobile = computed(() => typeof window !== "undefined" && window.innerWidth <= 767);

const showRawMarkdown = ref(false);
const showToc = ref(false);
const copyingContent = ref(false);
const previewFullscreen = ref(false);
const spreadsheetPreview = ref(props.win.spreadsheet ?? null);
const spreadsheetLoading = ref(false);
const downloadingFile = ref(false);

watch(() => props.win.spreadsheet, (next) => {
  spreadsheetPreview.value = next ?? null;
});

async function doCopy(): Promise<void> {
  if (copyingContent.value) return;
  copyingContent.value = true;
  try {
    const text = showDiff.value ? (props.win.diffModified ?? "") : (props.win.content ?? "");
    await copyToClipboard(text);
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  } finally {
    copyingContent.value = false;
  }
}
const diffInline = ref(isMobile.value);
const diffHideUnchanged = ref(isMobile.value);
const diffViewerRef = ref<InstanceType<typeof DiffViewer> | null>(null);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"]);
const NON_TEXT_DIFF_PREVIEW_TYPES = new Set(["image", "spreadsheet", "pdf", "word", "presentation", "binary"]);

const isImageFile = computed(() => {
  const ext = props.win.filePath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
});

const showDiff = computed(() => {
  if (props.win.type !== "diff") return false;
  if (NON_TEXT_DIFF_PREVIEW_TYPES.has(props.win.previewType)) return false;
  if (isImageFile.value && props.win.previewType === "image") return false;
  return props.win.diffOriginal != null || props.win.diffModified != null;
});

const isMarkdownPreview = computed(() => {
  return !showDiff.value && props.win.previewType === "markdown" && props.win.content != null;
});
const zoomKind = computed<PreviewZoomKind | null>(() => {
  if (showDiff.value) return "diff";
  if (props.win.previewType === "code") return "code";
  if (props.win.previewType === "markdown") return "markdown";
  if (props.win.previewType === "image") return "image";
  return null;
});
const { scale, scaleLabel, canZoom, canZoomIn, canZoomOut, zoomIn, zoomOut, resetZoom } = usePreviewZoom(zoomKind);

const fileName = computed(() => props.win.filePath.split("/").pop() ?? props.win.filePath);
const previewFullscreenTitle = computed(() => previewFullscreen.value ? "退出全屏" : "全屏查看");
const canDownloadPreviewFile = computed(() =>
  Boolean(props.win.workspaceId && props.win.filePath),
);
const canCopyPreviewContent = computed(() =>
  !["image", "binary", "spreadsheet", "pdf", "word", "presentation"].includes(props.win.previewType),
);

/** 独立窗口只按快照事实判断可编辑性；缺少修改时间的历史窗口保持只读。 */
const editorPreview = computed<FileEditorSource | null>(() => {
  if (props.win.content == null) return null;
  return { content: props.win.content, size: props.win.size ?? 0, mtimeMs: props.win.mtimeMs ?? null,
    truncated: props.win.truncated ?? false, encoding: props.win.encoding ?? "utf8" };
});
const editablePreview = computed(() => !isMobile.value && !showDiff.value && Boolean(props.win.workspaceId)
  && canEditFilePreview({ workspaceId: props.win.workspaceId!, previewType: props.win.previewType,
    preview: editorPreview.value, rawMarkdown: showRawMarkdown.value }));
const editorDraft = ref<FileEditorDraft | null>(null);
const editorDirty = computed(() => isFileEditorDirty(editorDraft.value));
const editorContent = computed(() => editorDraft.value?.content ?? props.win.content ?? "");

/** Markdown 原文与代码文件共用同一草稿；只读预览不建立草稿。 */
watch([editorPreview, editablePreview], () => {
  if (!editablePreview.value || !props.win.workspaceId || !editorPreview.value) { editorDraft.value = null; return; }
  editorDraft.value = ensureFileEditorDraft(props.win.workspaceId, props.win.filePath, editorPreview.value);
}, { immediate: true });

function onEditorChange(value: string): void {
  if (editorDraft.value) updateFileEditorContent(editorDraft.value, value);
}

/** 保存后同步窗口快照，复制与后续渲染使用新内容。 */
async function saveEdits(): Promise<void> {
  const draft = editorDraft.value, workspaceId = props.win.workspaceId;
  if (!draft || !workspaceId) return;
  try {
    const result = await saveFileEditorDraft(ctx.value, draft, workspaceId, props.win.filePath);
    props.win.content = draft.content;
    props.win.size = result.size;
    props.win.mtimeMs = result.mtimeMs;
    props.win.truncated = false;
    message.success("已保存");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存失败");
  }
}

function discardEdits(): void {
  if (editorDraft.value) discardFileEditorDraft(editorDraft.value);
}

/** 关闭前确认丢弃未保存修改，避免直接丢失编辑内容。 */
function closeWindow(): void {
  const draft = editorDraft.value;
  if (draft && isFileEditorDirty(draft)) {
    Modal.confirm({ title: "有未保存的修改", content: "关闭后这些修改将丢失。", okText: "放弃修改并关闭", cancelText: "继续编辑",
      onOk: () => { discardFileEditorDraft(draft); ui.closePreviewWindow(props.win.id); } });
    return;
  }
  ui.closePreviewWindow(props.win.id);
}

// ---- z-index：用 antd 原生 zIndex prop 控制 wrap 层级 ----
const BASE_Z = 2101;
const FULLSCREEN_BASE_Z = 2200;
const modalZIndex = computed(() => (previewFullscreen.value ? FULLSCREEN_BASE_Z : BASE_Z) + props.win.zIndex);
/** 桌面全屏只覆盖内容区，保留 44px 应用顶栏与窗口控制。 */
const desktopFullscreen = computed(() => previewFullscreen.value && config.isDesktop);
const modalWrapClassName = computed(() => [
  "explorer-preview-modal",
  previewFullscreen.value ? "explorer-preview-modal--fullscreen" : "",
  desktopFullscreen.value ? "explorer-preview-modal--desktop-fullscreen" : "",
].filter(Boolean).join(" "));
const modalWidth = computed(() => previewFullscreen.value ? "100vw" : "72%");
const modalBodyStyle = computed(() => {
  if (!previewFullscreen.value) return { padding: "0", height: "70vh", overflow: "hidden" };
  // 全屏由 content 的 flex 布局撑满，避免固定高度与标题栏实际高度不一致。
  return { padding: "0", overflow: "hidden" };
});
const modalBinding = computed<Record<string, unknown>>(() => {
  if (props.embedded) return { class: "preview-window--embedded" };
  return {
    open: true,
    footer: null,
    mask: false,
    maskClosable: false,
    // 关闭按钮统一放在自定义标题栏，避免与默认按钮叠在右上角。
    closable: false,
    zIndex: modalZIndex.value,
    width: modalWidth.value,
    bodyStyle: modalBodyStyle.value,
    destroyOnClose: true,
    wrapClassName: modalWrapClassName.value,
  };
});

// ---- 级联偏移 + 拖拽 ----
const CASCADE_STEP = 28;
const drag = reactive({
  x: props.win.cascadeIndex * CASCADE_STEP,
  y: props.win.cascadeIndex * CASCADE_STEP,
});

const transformStyle = computed(() => {
  if (isMobile.value) {
    return {
      width: "100%",
      height: "100%",
    };
  }
  if (previewFullscreen.value) {
    return {
      width: "100%",
      height: "100%",
    };
  }
  return {
    width: "100%",
    height: "100%",
    transform: `translate(${drag.x}px, ${drag.y}px)`,
  };
});

/** 切换桌面文件预览弹框全屏状态，保留当前预览内容与滚动上下文。 */
function togglePreviewFullscreen(): void {
  ui.bringPreviewWindowToFront(props.win.id);
  previewFullscreen.value = !previewFullscreen.value;
}

/** 切换独立预览窗中的表格工作表。 */
async function onSpreadsheetSheetChange(sheetName: string): Promise<void> {
  if (!props.win.workspaceId) {
    message.error("缺少 workspaceId，无法切换工作表");
    return;
  }
  spreadsheetLoading.value = true;
  try {
    const result = await loadWorkspaceFilePreview(ctx.value, props.win.workspaceId, props.win.filePath, { sheetName });
    if (result.previewType !== "spreadsheet" || !result.spreadsheet) {
      throw new Error("当前文件不是可预览表格");
    }
    spreadsheetPreview.value = result.spreadsheet;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "切换工作表失败");
  } finally {
    spreadsheetLoading.value = false;
  }
}

/** 下载当前预览的原始文件，失败时把后端返回原因直接展示给用户。 */
async function downloadPreviewFile(): Promise<void> {
  if (downloadingFile.value) return;
  const workspaceId = props.win.workspaceId;
  if (!workspaceId) {
    message.error("缺少 workspaceId，无法下载文件");
    return;
  }

  downloadingFile.value = true;
  try {
    const res = await downloadWorkspaceFile(ctx.value, { workspaceId, path: props.win.filePath });
    if (!res.ok) throw new Error(res.message || "下载文件失败");
    saveBlob(res.blob, res.filename || fileName.value || "download");
    message.success("已开始下载");
    trackProductEvent("workspace_file_transfer", {
      direction: "download",
      source: "preview",
      workspace_type: isSharedWorkspaceSelectionId(workspaceId) ? "shared" : "local",
    });
  } catch (error) {
    message.error(error instanceof Error ? error.message : "下载文件失败");
  } finally {
    downloadingFile.value = false;
  }
}

/** 触发浏览器下载并及时释放对象 URL。 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * mousedown 处理：
 * 1. 任何位置点击 → 置顶（bringToFront）
 * 2. 点击在 .ant-modal-body 或 .ant-modal-close 之外的 .ant-modal-content 区域 → 启动拖拽
 *    （即 header 行 + content padding + title 文本 + close 按钮旁空白 = 整个"窗口框架"区域）
 */
function onWindowMousedown(e: MouseEvent) {
  ui.bringPreviewWindowToFront(props.win.id);
  if (previewFullscreen.value) return;

  const el = e.target as HTMLElement;
  // 必须在 modal content 内
  if (!el.closest(".ant-modal-content")) return;
  // 排除内容区（代码/diff/图片等）
  if (el.closest(".ant-modal-body")) return;
  // 排除关闭按钮（让它走 @cancel）
  if (el.closest(".ant-modal-close")) return;
  // 排除标题栏操作按钮，避免全屏按钮触发拖拽。
  if (el.closest(".preview-window__title-action")) return;
  // 移动端禁用拖拽（全屏模式）
  if (window.innerWidth <= 767) return;

  e.preventDefault();
  const startX = e.clientX - drag.x;
  const startY = e.clientY - drag.y;

  const onMove = (ev: MouseEvent) => {
    drag.x = ev.clientX - startX;
    drag.y = ev.clientY - startY;
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
</script>

<template>
  <component
    :is="embedded ? 'div' : Modal"
    v-bind="modalBinding"
    v-on="!embedded ? { cancel: closeWindow } : {}"
  >
    <template v-if="!embedded" #title>
      <div class="preview-window__titlebar">
        <span class="preview-window__title-text" :title="win.filePath">{{ fileName }}</span>
        <a-tooltip v-if="canDownloadPreviewFile" title="下载文件">
          <a-button
            class="preview-window__title-action"
            type="text"
            size="small"
            aria-label="下载文件"
            :loading="downloadingFile"
            @mousedown.stop
            @click.stop="downloadPreviewFile"
          >
            <DownloadOutlined />
          </a-button>
        </a-tooltip>
        <a-tooltip :title="previewFullscreenTitle">
          <a-button
            class="preview-window__title-action"
            type="text"
            size="small"
            :aria-label="previewFullscreenTitle"
            @mousedown.stop
            @click.stop="togglePreviewFullscreen"
          >
            <component :is="previewFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
          </a-button>
        </a-tooltip>
        <a-tooltip title="关闭预览">
          <a-button
            class="preview-window__title-action"
            type="text"
            size="small"
            aria-label="关闭预览"
            @mousedown.stop
            @click.stop="closeWindow"
          >
            <CloseOutlined />
          </a-button>
        </a-tooltip>
      </div>
    </template>

    <template v-if="!embedded" #modalRender="{ originVNode }">
      <div class="preview-window__modal-shell" :style="transformStyle" @mousedown.capture="onWindowMousedown">
        <component :is="originVNode" />
      </div>
    </template>

    <div class="preview-window">
      <!-- 工具栏 -->
      <div class="preview-window__toolbar">
        <span class="preview-window__filepath" :title="win.filePath">{{ win.filePath }}</span>
        <template v-if="editorDraft">
          <span v-if="editorDirty" class="preview-window__dirty">未保存</span>
          <a-button v-if="editorDirty" size="small" type="text" title="放弃修改" @click="discardEdits">
            <RollbackOutlined />
          </a-button>
          <a-button size="small" type="text" title="保存 (Ctrl+S)" :loading="editorDraft.saving" :disabled="!editorDirty" @click="saveEdits">
            <SaveOutlined />
          </a-button>
        </template>
        <a-button
          v-if="canCopyPreviewContent"
          size="small"
          type="text"
          title="复制"
          :disabled="copyingContent"
          @click="doCopy"
        >
          <CopyOutlined />
        </a-button>
        <a-button
          v-if="isMarkdownPreview"
          size="small"
          type="text"
          :title="showRawMarkdown ? '预览' : '原文'"
          @click="showRawMarkdown = !showRawMarkdown"
        >
          <EyeOutlined v-if="showRawMarkdown" />
          <CodeOutlined v-else />
        </a-button>
        <a-button
          v-if="isMarkdownPreview && !showRawMarkdown"
          size="small"
          type="text"
          title="章节导航"
          @click="showToc = !showToc"
        >
          <UnorderedListOutlined />
        </a-button>
        <a-button
          v-if="showDiff && !isMobile"
          size="small"
          type="text"
          :title="diffInline ? '左右对比' : '上下对比'"
          @click="diffInline = !diffInline"
        >
          <ColumnWidthOutlined v-if="diffInline" />
          <ColumnHeightOutlined v-else />
          {{ diffInline ? '左右对比' : '上下对比' }}
        </a-button>
        <a-button
          v-if="showDiff"
          size="small"
          type="text"
          :title="diffHideUnchanged ? '显示全文' : '只看差异'"
          @click="diffHideUnchanged = !diffHideUnchanged"
        >
          <ExpandOutlined v-if="diffHideUnchanged" />
          <CompressOutlined v-else />
          {{ diffHideUnchanged ? '显示全文' : '只看差异' }}
        </a-button>
        <a-button v-if="showDiff" size="small" type="text" title="上一处差异" @click="diffViewerRef?.goToPrevDiff()">
          <UpOutlined /> 上一处
        </a-button>
        <a-button v-if="showDiff" size="small" type="text" title="下一处差异" @click="diffViewerRef?.goToNextDiff()">
          <DownOutlined /> 下一处
        </a-button>
        <span v-if="canZoom" class="preview-window__zoom-group">
          <a-button size="small" type="text" title="缩小" :disabled="!canZoomOut" @click="zoomOut"><MinusOutlined /></a-button>
          <a-button size="small" type="text" title="重置缩放" @click="resetZoom">{{ scaleLabel }}</a-button>
          <a-button size="small" type="text" title="放大" :disabled="!canZoomIn" @click="zoomIn"><PlusOutlined /></a-button>
        </span>
      </div>

      <!-- Diff 版本信息条 -->
      <div v-if="showDiff && win.diffVersionOld && win.diffVersionNew" class="preview-window__diff-version">
        <span class="preview-window__diff-version-label">{{ win.diffVersionOld }}</span>
        <span class="preview-window__diff-version-arrow">→</span>
        <span class="preview-window__diff-version-label">{{ win.diffVersionNew }}</span>
      </div>

      <!-- 内容区 -->
      <div class="preview-window__content">
        <DiffViewer
          v-if="showDiff"
          ref="diffViewerRef"
          :original="win.diffOriginal ?? ''"
          :modified="win.diffModified ?? ''"
          :file-path="win.filePath"
          :inline="diffInline"
          :hide-unchanged="diffHideUnchanged"
          :font-scale="scale"
        />
        <ImagePreview
          v-else-if="win.previewType === 'image' && win.base64"
          :base64="win.base64"
          :mime-type="win.mimeType ?? 'image/png'"
          :file-path="win.filePath"
          :zoom-scale="scale"
        />
        <div v-else-if="win.previewType === 'spreadsheet'" class="preview-window__spreadsheet">
          <div v-if="spreadsheetLoading" class="preview-window__placeholder">
            <a-spin size="large" />
          </div>
          <SpreadsheetPreview
            v-else-if="spreadsheetPreview"
            :preview="spreadsheetPreview"
            @sheet-change="onSpreadsheetSheetChange"
          />
          <div v-else class="preview-window__placeholder">
            <p>{{ fileName || '无法预览' }}</p>
          </div>
        </div>
        <PdfPreview
          v-else-if="win.previewType === 'pdf' && win.base64"
          :base64="win.base64"
          :mime-type="win.mimeType"
          :file-path="win.filePath"
        />
        <WordPreview
          v-else-if="win.previewType === 'word' && win.content != null"
          :content="win.content"
          :file-path="win.filePath"
        />
        <PresentationPreview
          v-else-if="win.previewType === 'presentation' && win.base64"
          :base64="win.base64"
          :file-path="win.filePath"
        />
        <CodePreview
          v-else-if="win.previewType === 'markdown' && showRawMarkdown && win.content != null"
          :content="editorContent"
          :file-path="win.filePath"
          :font-scale="scale"
          :editable="editablePreview"
          @change="onEditorChange"
          @save="saveEdits"
        />
        <MarkdownPreview
          v-else-if="win.previewType === 'markdown' && win.content != null"
          :content="win.content"
          :file-path="win.filePath"
          :workspace-id="win.workspaceId ?? null"
          :show-raw="showRawMarkdown"
          :font-scale="scale"
          v-model:toc-visible="showToc"
        />
        <HtmlPreview
          v-else-if="win.previewType === 'html' && win.content != null"
          :content="win.content"
          :file-path="win.filePath"
        />
        <CodePreview
          v-else-if="win.previewType === 'code' && win.content != null"
          :content="editorContent"
          :file-path="win.filePath"
          :font-scale="scale"
          :editable="editablePreview"
          @change="onEditorChange"
          @save="saveEdits"
        />
        <div v-else-if="win.previewType === 'binary'" class="preview-window__placeholder">
          <p>{{ fileName }}</p>
          <p style="font-size: 12px; color: var(--app-muted)">二进制文件，无法预览</p>
        </div>
        <div v-else class="preview-window__placeholder">
          <p>{{ fileName || '无法预览' }}</p>
        </div>
      </div>
    </div>
  </component>
</template>

<style scoped>
.preview-window__modal-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.preview-window__modal-shell > * {
  flex: 1 1 auto;
  min-height: 0;
}

.preview-window__titlebar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.preview-window__title-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-window__title-action {
  flex: 0 0 auto;
}

.preview-window {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.preview-window__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
  flex-shrink: 0;
}

.preview-window__filepath {
  flex: 1;
  font-size: 12px;
  color: var(--app-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.preview-window__dirty {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-warning, #d97706) 14%, transparent);
  color: var(--app-warning, #d97706);
  font-size: 12px;
  white-space: nowrap;
}

.preview-window__zoom-group {
  display: inline-flex;
  align-items: center;
  gap: 0;
}

.preview-window__zoom-group :deep(.ant-btn) {
  padding-inline: 4px;
}

.preview-window__diff-version {
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

.preview-window__diff-version-label {
  font-family: monospace;
  font-weight: 600;
  color: var(--app-accent, #c96442);
}

.preview-window__diff-version-arrow {
  color: var(--app-muted);
}

.preview-window__content {
  flex: 1;
  min-height: 0;
  position: relative;
}

.preview-window__spreadsheet {
  height: 100%;
  min-height: 0;
}

.preview-window__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--app-muted);
  font-size: 14px;
}

/* ── embedded 模式：撑满页面栈容器 ── */
.preview-window--embedded {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.preview-window--embedded .preview-window {
  flex: 1;
  min-height: 0;
}

.preview-window--embedded .preview-window__content {
  overflow-y: auto;
}

:global(.explorer-preview-modal--fullscreen.ant-modal-wrap) {
  pointer-events: auto;
  overflow: hidden !important;
}

/* 桌面全屏从 44px 应用顶栏下方开始并锚定到窗口底部，避免视口单位推算产生缝隙。 */
:global(.explorer-preview-modal--desktop-fullscreen.ant-modal-wrap) {
  top: 44px !important;
  bottom: 0 !important;
  height: auto !important;
}

:global(.explorer-preview-modal--fullscreen .ant-modal) {
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100dvh !important;
  min-height: 100dvh !important;
  max-height: 100dvh !important;
  margin: 0 !important;
  top: 0 !important;
  padding-bottom: 0 !important;
}

:global(.explorer-preview-modal--desktop-fullscreen .ant-modal) {
  height: 100% !important;
  min-height: 100% !important;
  max-height: 100% !important;
}

/* 补齐 Ant Design 焦点容器的高度，让自定义外壳的百分比高度沿全屏弹框传递。 */
:global(.explorer-preview-modal--desktop-fullscreen .ant-modal > div:first-child) {
  height: 100%;
}

:global(.explorer-preview-modal--fullscreen .ant-modal-content) {
  display: flex;
  flex-direction: column;
  height: 100dvh !important;
  max-height: 100dvh !important;
  border-radius: 0;
  overflow: hidden;
  cursor: default;
}

:global(.explorer-preview-modal--desktop-fullscreen .ant-modal-content) {
  height: 100% !important;
  max-height: 100% !important;
}

:global(.explorer-preview-modal--fullscreen .ant-modal-body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden !important;
}

@media (max-width: 767px) {
  .preview-window__toolbar {
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
  }
}
</style>
