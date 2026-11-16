<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { FsDocumentPreviewResponseBody, FsReadFileResponseBody, FsSpreadsheetPreviewResponseBody, WorkspaceId } from "@codeflowai/shared";

import { fetchFsDocumentPreview, fetchFsReadFile, fetchFsSpreadsheetPreview } from "../../../api/fs";
import { useApiContext } from "../../../composables/useApiContext";
import HtmlPreview from "../../explorer/components/html-preview.vue";
import ImagePreview from "../../explorer/components/image-preview.vue";
import MarkdownPreview from "../../explorer/components/markdown-preview.vue";
import PdfPreview from "../../explorer/components/pdf-preview.vue";
import PresentationPreview from "../../explorer/components/presentation-preview.vue";
import SpreadsheetPreview from "../../explorer/components/spreadsheet-preview.vue";
import WordPreview from "../../explorer/components/word-preview.vue";
import type { ArtifactPresentationFile } from "./artifact-preview-utils";
import { isDocumentArtifactPath, isImageArtifactPath, isSpreadsheetArtifactPath } from "./artifact-preview-utils";

defineOptions({ name: "ArtifactFilePreview" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  preview: ArtifactPresentationFile;
  showRawMarkdown?: boolean;
  emptyMarkdownText?: string;
  loading?: boolean;
  loadingText?: string;
  error?: string | null;
}>();
const emit = defineEmits<{ retry: [] }>();

const { ctx } = useApiContext();

const imagePreview = ref<FsReadFileResponseBody | null>(null);
const imageLoading = ref(false);
const imageError = ref<string | null>(null);
const spreadsheetPreview = ref<FsSpreadsheetPreviewResponseBody | null>(null);
const spreadsheetLoading = ref(false);
const spreadsheetError = ref<string | null>(null);
const documentPreview = ref<FsDocumentPreviewResponseBody | null>(null);
const documentLoading = ref(false);
const documentError = ref<string | null>(null);
let imageRequestToken = 0;
let spreadsheetRequestToken = 0;
let documentRequestToken = 0;

const isImageFile = computed(() => isImageArtifactPath(props.preview.filePath));
const isSpreadsheetFile = computed(() => props.preview.renderMode === "spreadsheet" || isSpreadsheetArtifactPath(props.preview.filePath));
const isDocumentFile = computed(() => props.preview.renderMode === "document" || isDocumentArtifactPath(props.preview.filePath));
const imagePath = computed(() => props.preview.workspacePreviewPath ?? null);
const spreadsheetPath = computed(() => props.preview.workspacePreviewPath ?? null);
const documentPath = computed(() => props.preview.workspacePreviewPath ?? null);
const markdownContent = computed(() => props.preview.content || props.emptyMarkdownText || "*当前内容没有可预览正文*");

watch(
  [() => props.workspaceId, () => props.preview.filePath, () => props.preview.workspacePreviewPath, isImageFile, () => props.loading, () => props.error],
  async ([workspaceId, _filePath, workspacePreviewPath, image]) => {
    imageRequestToken += 1;
    const requestToken = imageRequestToken;
    imagePreview.value = null;
    imageError.value = null;
    imageLoading.value = false;

    if (!image || props.loading || props.error) return;
    if (!workspacePreviewPath) {
      imageError.value = "当前图片工件没有可读取的工作区路径。";
      return;
    }

    imageLoading.value = true;
    try {
      const res = await fetchFsReadFile(ctx.value, { workspaceId, path: workspacePreviewPath });
      if (requestToken !== imageRequestToken) return;
      if (!res.ok) throw new Error(res.message || "加载图片失败");
      const data = res as FsReadFileResponseBody;
      if (!(data.base64 && data.mimeType?.startsWith("image/"))) {
        throw new Error("当前文件不是可预览图片。");
      }
      imagePreview.value = data;
    } catch (error) {
      if (requestToken !== imageRequestToken) return;
      imageError.value = error instanceof Error ? error.message : "加载图片失败";
    } finally {
      if (requestToken === imageRequestToken) {
        imageLoading.value = false;
      }
    }
  },
  { immediate: true },
);

watch(
  [() => props.workspaceId, () => props.preview.filePath, () => props.preview.workspacePreviewPath, isSpreadsheetFile, () => props.loading, () => props.error],
  async ([workspaceId, _filePath, workspacePreviewPath, spreadsheet]) => {
    spreadsheetRequestToken += 1;
    const requestToken = spreadsheetRequestToken;
    spreadsheetPreview.value = null;
    spreadsheetError.value = null;
    spreadsheetLoading.value = false;

    if (!spreadsheet || props.loading || props.error) return;
    if (!workspacePreviewPath) {
      spreadsheetError.value = "当前表格工件没有可读取的工作区路径。";
      return;
    }

    spreadsheetLoading.value = true;
    try {
      const res = await fetchFsSpreadsheetPreview(ctx.value, { workspaceId, path: workspacePreviewPath });
      if (requestToken !== spreadsheetRequestToken) return;
      if (!res.ok) throw new Error(res.message || "加载表格失败");
      spreadsheetPreview.value = res;
    } catch (error) {
      if (requestToken !== spreadsheetRequestToken) return;
      spreadsheetError.value = error instanceof Error ? error.message : "加载表格失败";
    } finally {
      if (requestToken === spreadsheetRequestToken) {
        spreadsheetLoading.value = false;
      }
    }
  },
  { immediate: true },
);

watch(
  [() => props.workspaceId, () => props.preview.filePath, () => props.preview.workspacePreviewPath, isDocumentFile, () => props.loading, () => props.error],
  async ([workspaceId, _filePath, workspacePreviewPath, document]) => {
    documentRequestToken += 1;
    const requestToken = documentRequestToken;
    documentPreview.value = null;
    documentError.value = null;
    documentLoading.value = false;

    if (!document || props.loading || props.error) return;
    if (!workspacePreviewPath) {
      documentError.value = "当前文档工件没有可读取的工作区路径。";
      return;
    }

    documentLoading.value = true;
    try {
      const res = await fetchFsDocumentPreview(ctx.value, { workspaceId, path: workspacePreviewPath });
      if (requestToken !== documentRequestToken) return;
      if (!res.ok) throw new Error(res.message || "加载文档失败");
      documentPreview.value = res;
    } catch (error) {
      if (requestToken !== documentRequestToken) return;
      documentError.value = error instanceof Error ? error.message : "加载文档失败";
    } finally {
      if (requestToken === documentRequestToken) {
        documentLoading.value = false;
      }
    }
  },
  { immediate: true },
);

/** 切换产物表格预览的工作表。 */
async function onSpreadsheetSheetChange(sheetName: string): Promise<void> {
  const path = spreadsheetPath.value;
  if (!path) {
    spreadsheetError.value = "当前表格工件没有可读取的工作区路径。";
    return;
  }
  spreadsheetLoading.value = true;
  try {
    const res = await fetchFsSpreadsheetPreview(ctx.value, { workspaceId: props.workspaceId, path, sheetName });
    if (!res.ok) throw new Error(res.message || "加载表格失败");
    spreadsheetPreview.value = res;
    spreadsheetError.value = null;
  } catch (error) {
    spreadsheetError.value = error instanceof Error ? error.message : "加载表格失败";
  } finally {
    spreadsheetLoading.value = false;
  }
}
</script>

<template>
  <div v-if="loading" class="artifact-preview__placeholder" role="status" aria-busy="true">
    <a-spin size="large" />
    <span>{{ loadingText || "正在加载正文..." }}</span>
  </div>
  <div v-else-if="error" class="artifact-preview__placeholder" role="alert">
    <p>{{ error }}</p>
    <a-button size="small" @click="emit('retry')">重试</a-button>
  </div>
  <div v-else-if="isImageFile" class="artifact-preview">
    <div v-if="imageLoading" class="artifact-preview__placeholder">
      <a-spin size="large" />
    </div>
    <ImagePreview
      v-else-if="imagePreview?.base64"
      :base64="imagePreview.base64"
      :mime-type="imagePreview.mimeType ?? 'image/png'"
      :file-path="imagePath ?? preview.filePath"
    />
    <div v-else class="artifact-preview__placeholder">
      <strong>{{ preview.filePath.split("/").pop() ?? preview.filePath }}</strong>
      <p>{{ imageError || "该图片暂时无法预览。" }}</p>
    </div>
  </div>
  <div v-else-if="isSpreadsheetFile" class="artifact-preview">
    <div v-if="spreadsheetLoading" class="artifact-preview__placeholder">
      <a-spin size="large" />
    </div>
    <SpreadsheetPreview
      v-else-if="spreadsheetPreview"
      :preview="spreadsheetPreview"
      @sheet-change="onSpreadsheetSheetChange"
    />
    <div v-else class="artifact-preview__placeholder">
      <strong>{{ preview.filePath.split("/").pop() ?? preview.filePath }}</strong>
      <p>{{ spreadsheetError || "该表格暂时无法预览。" }}</p>
    </div>
  </div>
  <div v-else-if="isDocumentFile" class="artifact-preview">
    <div v-if="documentLoading" class="artifact-preview__placeholder">
      <a-spin size="large" />
    </div>
    <PdfPreview
      v-else-if="documentPreview?.kind === 'pdf' && documentPreview.base64"
      :base64="documentPreview.base64"
      :mime-type="documentPreview.mimeType"
      :file-path="documentPath ?? preview.filePath"
    />
    <WordPreview
      v-else-if="documentPreview?.kind === 'word' && documentPreview.content != null"
      :content="documentPreview.content"
      :file-path="documentPath ?? preview.filePath"
    />
    <PresentationPreview
      v-else-if="documentPreview?.kind === 'presentation' && documentPreview.base64"
      :base64="documentPreview.base64"
      :file-path="documentPath ?? preview.filePath"
    />
    <div v-else class="artifact-preview__placeholder">
      <strong>{{ preview.filePath.split("/").pop() ?? preview.filePath }}</strong>
      <p>{{ documentError || "该文档暂时无法预览。" }}</p>
    </div>
  </div>
  <MarkdownPreview
    v-else-if="preview.renderMode === 'markdown'"
    class="artifact-preview__markdown"
    :content="markdownContent"
    :file-path="preview.filePath"
    :workspace-id="workspaceId"
    :resource-file-path="preview.workspacePreviewPath ?? preview.filePath"
    :show-raw="showRawMarkdown"
  />
  <HtmlPreview
    v-else-if="preview.renderMode === 'html'"
    class="artifact-preview__html"
    :content="preview.content"
    :file-path="preview.filePath"
    :min-viewport-width="1200"
  />
  <pre v-else class="artifact-preview__pre">{{ preview.content }}</pre>
</template>

<style scoped>
.artifact-preview {
  height: 100%;
}

.artifact-preview__markdown {
  height: 100%;
}

.artifact-preview__html {
  height: 100%;
}

.artifact-preview__pre {
  margin: 0;
  height: 100%;
  max-height: none;
  padding: 12px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.7;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

.artifact-preview__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  padding: 24px;
  text-align: center;
  color: var(--app-muted, #666);
  font-size: 12px;
}

.artifact-preview__placeholder strong {
  color: var(--app-text, #1f2937);
}

.artifact-preview__placeholder p {
  margin: 0;
  line-height: 1.6;
}
</style>
