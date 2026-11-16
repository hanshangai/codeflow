<script setup lang="ts">
import { computed } from "vue";

defineOptions({ name: "ImagePreview" });

const props = defineProps<{
  base64: string;
  mimeType: string;
  filePath: string;
  zoomScale?: number;
}>();

const src = computed(() => `data:${props.mimeType};base64,${props.base64}`);
const fileName = computed(() => props.filePath.split("/").pop() ?? props.filePath);
const imageStyle = computed(() => ({
  width: `${100 * (props.zoomScale ?? 1)}%`,
}));
</script>

<template>
  <div class="image-preview">
    <div class="image-preview__viewport">
      <img :src="src" :alt="fileName" class="image-preview__img" :style="imageStyle" />
    </div>
    <div class="image-preview__info">{{ fileName }}</div>
  </div>
</template>

<style scoped>
.image-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  padding: 24px;
}

.image-preview__viewport {
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: auto;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}

.image-preview__img {
  max-width: none;
  max-height: none;
  object-fit: contain;
  display: block;
}

.image-preview__info {
  font-size: 12px;
  color: var(--app-muted);
}
</style>
