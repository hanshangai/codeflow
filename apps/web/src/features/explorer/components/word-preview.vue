<script setup lang="ts">
defineOptions({ name: "WordPreview" });

defineProps<{
  content: string;
  filePath: string;
}>();
</script>

<template>
  <article class="word-preview" :aria-label="filePath">
    <!-- content 来自 Client 端 OOXML 白名单转换结果，仅包含安全文本和基础文档标签。 -->
    <div class="word-preview__page" v-html="content"></div>
  </article>
</template>

<style scoped>
.word-preview {
  height: 100%;
  overflow: auto;
  padding: 24px;
  background: #eceff3;
}

.word-preview__page {
  max-width: 860px;
  min-height: 100%;
  margin: 0 auto;
  padding: 42px 54px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 6px;
  background: #fff;
  color: var(--app-text, #1f2933);
  font-size: 14px;
  line-height: 1.75;
  overflow-x: auto;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12);
}

.word-preview__page :deep(p) {
  margin: 0 0 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.word-preview__page :deep(table) {
  width: 100%;
  margin: 12px 0 18px;
  border-collapse: collapse;
  table-layout: auto;
  overflow-wrap: anywhere;
}

.word-preview__page :deep(td) {
  min-width: 96px;
  padding: 7px 10px;
  border: 1px solid var(--app-border, #d9d9d9);
  vertical-align: top;
  white-space: pre-wrap;
}

.word-preview__page :deep(td > p:last-child) {
  margin-bottom: 0;
}
</style>
