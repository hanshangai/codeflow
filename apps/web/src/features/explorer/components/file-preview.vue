<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { FileExclamationOutlined } from "@ant-design/icons-vue";
import type { WorkspaceId } from "@codeflowai/shared";
import { useApiContext } from "../../../composables/useApiContext";
import { useExplorerStore } from "../../../store/explorer";
import { canEditFilePreview, ensureFileEditorDraft, updateFileEditorContent, type FileEditorDraft } from "../fileEditorState";
import CodePreview from "./code-preview.vue";
import HtmlPreview from "./html-preview.vue";
import ImagePreview from "./image-preview.vue";
import MarkdownPreview from "./markdown-preview.vue";
import PdfPreview from "./pdf-preview.vue";
import PresentationPreview from "./presentation-preview.vue";
import SpreadsheetPreview from "./spreadsheet-preview.vue";
import WordPreview from "./word-preview.vue";

defineOptions({ name: "FilePreview" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  showRawMarkdown?: boolean;
  zoomScale?: number;
}>();
const emit = defineEmits<{
  (e: "save"): void;
}>();

const explorer = useExplorerStore();
const { ctx } = useApiContext();
const isMobile = typeof window !== "undefined" && window.innerWidth <= 767;
const editorDraft = ref<FileEditorDraft | null>(null);
const editable = computed(() => !isMobile && canEditFilePreview({ workspaceId: props.workspaceId,
  previewType: explorer.previewType, preview: explorer.preview, rawMarkdown: props.showRawMarkdown === true }));
const editorContent = computed(() => editorDraft.value?.content ?? explorer.preview?.content ?? "");

/** 预览切换后按当前内容建立或复用草稿；有未保存修改时保留用户输入。 */
watch([() => explorer.preview, () => explorer.selectedPath, () => props.workspaceId, editable], () => {
  const preview = explorer.preview, content = preview?.content;
  if (!editable.value || !explorer.selectedPath || content == null) { editorDraft.value = null; return; }
  editorDraft.value = ensureFileEditorDraft(props.workspaceId, explorer.selectedPath, {
    content,
    mtimeMs: preview?.mtimeMs,
    size: preview?.size,
    truncated: preview?.truncated,
    encoding: preview?.encoding,
  });
}, { immediate: true });

/** 编辑事件只更新共享草稿；保存由面板工具栏或 Ctrl+S 触发。 */
function onEditorChange(value: string): void {
  if (editorDraft.value) updateFileEditorContent(editorDraft.value, value);
}

const fileName = computed(() => {
  if (!explorer.selectedPath) return "";
  return explorer.selectedPath.split("/").pop() ?? explorer.selectedPath;
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 切换资源管理器内嵌表格预览的工作表。 */
function onSheetChange(sheetName: string): void {
  if (!explorer.selectedPath) return;
  void explorer.loadSpreadsheetSheet(ctx.value, props.workspaceId, explorer.selectedPath, sheetName);
}
</script>

<template>
  <div class="file-preview">
    <!-- 加载中 -->
    <div v-if="explorer.previewLoading" class="file-preview__center">
      <a-spin size="large" />
    </div>

    <!-- 无选中文件 -->
    <div v-else-if="!explorer.selectedPath" class="file-preview__center">
      <div class="file-preview__placeholder">
        <FileExclamationOutlined style="font-size: 48px; color: var(--app-muted)" />
        <p>选择文件以预览</p>
      </div>
    </div>

    <!-- 二进制（非图片） -->
    <div v-else-if="explorer.previewType === 'binary'" class="file-preview__center">
      <div class="file-preview__placeholder">
        <FileExclamationOutlined style="font-size: 48px; color: var(--app-muted)" />
        <p>{{ fileName }}</p>
        <p style="font-size: 12px; color: var(--app-muted)">二进制文件，无法预览</p>
        <p v-if="explorer.preview?.size" style="font-size: 12px; color: var(--app-muted)">
          大小：{{ formatSize(explorer.preview.size) }}
        </p>
      </div>
    </div>

    <!-- 图片 -->
    <ImagePreview
      v-else-if="explorer.previewType === 'image' && explorer.preview?.base64"
      :base64="explorer.preview.base64"
      :mime-type="explorer.preview.mimeType ?? 'image/png'"
      :file-path="explorer.selectedPath"
      :zoom-scale="zoomScale"
    />

    <!-- Markdown 原文编辑 -->
    <CodePreview
      v-else-if="explorer.previewType === 'markdown' && showRawMarkdown && explorer.preview?.content != null"
      :content="editorContent"
      :file-path="explorer.selectedPath"
      :font-scale="zoomScale"
      :editable="editable"
      @change="onEditorChange"
      @save="emit('save')"
    />

    <!-- Markdown -->
    <MarkdownPreview
      v-else-if="explorer.previewType === 'markdown' && explorer.preview?.content != null"
      :content="explorer.preview.content"
      :file-path="explorer.selectedPath"
      :workspace-id="workspaceId"
      :show-raw="showRawMarkdown"
      :font-scale="zoomScale"
    />

    <!-- HTML -->
    <HtmlPreview
      v-else-if="explorer.previewType === 'html' && explorer.preview?.content != null"
      :content="explorer.preview.content"
      :file-path="explorer.selectedPath"
    />

    <!-- 表格 -->
    <SpreadsheetPreview
      v-else-if="explorer.previewType === 'spreadsheet' && explorer.spreadsheetPreview"
      :preview="explorer.spreadsheetPreview"
      @sheet-change="onSheetChange"
    />

    <!-- PDF -->
    <PdfPreview
      v-else-if="explorer.previewType === 'pdf' && explorer.preview?.base64"
      :base64="explorer.preview.base64"
      :mime-type="explorer.preview.mimeType"
      :file-path="explorer.selectedPath"
    />

    <!-- Word -->
    <WordPreview
      v-else-if="explorer.previewType === 'word' && explorer.preview?.content != null"
      :content="explorer.preview.content"
      :file-path="explorer.selectedPath"
    />

    <!-- PPTX -->
    <PresentationPreview
      v-else-if="explorer.previewType === 'presentation' && explorer.preview?.base64"
      :base64="explorer.preview.base64"
      :file-path="explorer.selectedPath"
    />

    <!-- 代码 -->
    <CodePreview
      v-else-if="explorer.previewType === 'code' && explorer.preview?.content != null"
      :content="editorContent"
      :file-path="explorer.selectedPath"
      :font-scale="zoomScale"
      :editable="editable"
      @change="onEditorChange"
      @save="emit('save')"
    />

    <!-- 无内容 -->
    <div v-else class="file-preview__center">
      <div class="file-preview__placeholder">
        <FileExclamationOutlined style="font-size: 48px; color: var(--app-muted)" />
        <p>{{ fileName || '无法预览' }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-preview {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.file-preview__center {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.file-preview__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--app-muted);
  font-size: 14px;
}
</style>
