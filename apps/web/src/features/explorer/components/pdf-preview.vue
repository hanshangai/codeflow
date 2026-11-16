<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";

defineOptions({ name: "PdfPreview" });

const props = defineProps<{
  base64: string;
  mimeType?: string | null;
  filePath: string;
}>();

const src = ref("");
const errorMessage = ref("");
let objectUrl: string | null = null;

/** 释放当前 PDF Blob URL，避免预览切换后保留大对象。 */
function revokePdfObjectUrl(): void {
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

/** 将服务端返回的 base64 PDF 转为浏览器 PDF viewer 更稳定的 Blob URL。 */
function createPdfObjectUrl(base64: string, mimeType?: string | null): string {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType || "application/pdf" }));
}

watch(
  () => [props.base64, props.mimeType] as const,
  ([base64, mimeType]) => {
    revokePdfObjectUrl();
    src.value = "";
    errorMessage.value = "";
    try {
      objectUrl = createPdfObjectUrl(base64, mimeType);
      src.value = objectUrl;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "PDF 预览数据解析失败";
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  revokePdfObjectUrl();
});
</script>

<template>
  <iframe v-if="src" class="pdf-preview" :src="src" :title="filePath" />
  <div v-else class="pdf-preview__placeholder">
    <strong>{{ filePath.split("/").pop() ?? filePath }}</strong>
    <p>{{ errorMessage || "PDF 暂时无法预览。" }}</p>
  </div>
</template>

<style scoped>
.pdf-preview {
  width: 100%;
  height: 100%;
  border: 0;
  background: #f7f7f7;
}

.pdf-preview__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  padding: 24px;
  text-align: center;
  color: var(--app-muted, #666);
  background: #f7f7f7;
}

.pdf-preview__placeholder strong {
  color: var(--app-text, #1f2937);
  word-break: break-all;
}

.pdf-preview__placeholder p {
  margin: 0;
  line-height: 1.6;
}
</style>
