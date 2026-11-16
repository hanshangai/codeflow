<script setup lang="ts">
import { computed } from "vue";
import type { GitLogEntry, GitFileStatus } from "@codeflowai/shared";

defineOptions({ name: "GitCommitDetail" });

const props = defineProps<{
  detail: {
    entry: GitLogEntry;
    files: GitFileStatus[];
    diff: string;
    diffLoaded?: boolean;
  };
  loading?: boolean;
  error?: string | null;
}>();
const emit = defineEmits<{ (event: "loadDiff"): void }>();

function statusColor(letter: string): string {
  if (letter === "M") return "var(--explorer-status-modified, #1890ff)";
  if (letter === "A") return "var(--explorer-status-added, #52c41a)";
  if (letter === "D") return "var(--explorer-status-deleted, #ff4d4f)";
  if (letter === "R") return "var(--explorer-status-renamed, #722ed1)";
  return "var(--app-muted)";
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN");
  } catch {
    return iso;
  }
}

const entry = computed(() => props.detail.entry);
</script>

<template>
  <div class="git-commit-detail">
    <div class="git-commit-detail__header">
      <div class="git-commit-detail__meta">
        <span class="git-commit-detail__hash">{{ entry.hashShort }}</span>
        <span class="git-commit-detail__author">{{ entry.author }} &lt;{{ entry.authorEmail }}&gt;</span>
        <span class="git-commit-detail__date">{{ formatDate(entry.date) }}</span>
      </div>
      <div class="git-commit-detail__message">{{ entry.message }}</div>
      <div v-if="entry.body" class="git-commit-detail__body">{{ entry.body }}</div>
    </div>

    <div class="git-commit-detail__files">
      <div class="git-commit-detail__files-header">变更文件 ({{ detail.files.length }})</div>
      <div v-for="f in detail.files" :key="f.path" class="git-commit-detail__file">
        <span class="git-commit-detail__file-status" :style="{ color: statusColor(f.index) }">{{ f.index }}</span>
        <span class="git-commit-detail__file-path">{{ f.path }}</span>
      </div>
    </div>

    <a-alert v-if="error" type="error" :message="error" show-icon />
    <a-button v-if="detail.diffLoaded === false" :loading="loading" @click="emit('loadDiff')">查看完整差异</a-button>
    <div v-if="detail.diff" class="git-commit-detail__diff">
      <div class="git-commit-detail__diff-header">Diff</div>
      <pre class="git-commit-detail__diff-content">{{ detail.diff }}</pre>
    </div>
  </div>
</template>

<style scoped>
.git-commit-detail {
  height: 100%;
  overflow: auto;
  padding: 16px;
}

.git-commit-detail__header {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
}

.git-commit-detail__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 12px;
}

.git-commit-detail__hash {
  font-family: monospace;
  color: var(--app-accent, #c96442);
  font-weight: 600;
}

.git-commit-detail__author {
  color: var(--app-text);
}

.git-commit-detail__date {
  color: var(--app-muted);
  margin-left: auto;
}

.git-commit-detail__message {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}

.git-commit-detail__body {
  margin-top: 8px;
  font-size: 13px;
  color: var(--app-muted);
  white-space: pre-wrap;
}

.git-commit-detail__files {
  margin-bottom: 16px;
}

.git-commit-detail__files-header {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.git-commit-detail__file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
}

.git-commit-detail__file-status {
  font-weight: 600;
  width: 14px;
  text-align: center;
}

.git-commit-detail__file-path {
  font-family: monospace;
}

.git-commit-detail__diff {
  border-top: 1px solid var(--app-divider, #f0f0f0);
  padding-top: 12px;
}

.git-commit-detail__diff-header {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.git-commit-detail__diff-content {
  font-family: monospace;
  font-size: 12px;
  line-height: 1.5;
  background: var(--app-hover, rgba(0, 0, 0, 0.02));
  padding: 12px;
  border-radius: 6px;
  overflow: auto;
  max-height: 600px;
  white-space: pre;
  tab-size: 4;
}
</style>

