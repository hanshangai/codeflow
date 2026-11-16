<script setup lang="ts">
import { computed } from "vue";
import { LoadingOutlined } from "@ant-design/icons-vue";
import { getPathDisplayInfo } from "@codeflowai/shared";
import type { GitLogEntry, GitFileStatus } from "@codeflowai/shared";
import { useExplorerStore } from "../../../store/explorer";

defineOptions({ name: "GitCommitFilesPanel" });

const emit = defineEmits<{
  (e: "selectFile", path: string): void;
}>();

const explorer = useExplorerStore();

const detail = computed(() => explorer.gitCommitDetail);
const entry = computed(() => detail.value?.entry ?? null);
const files = computed(() => detail.value?.files ?? []);

/** 是否有文件 diff 正在加载 */
const isDiffLoading = computed(() => explorer.gitDiffLoading);
/** 正在加载 diff 的文件路径 */
const loadingPath = computed(() => isDiffLoading.value ? explorer.gitDiffPath : null);

function statusColor(letter: string): string {
  if (letter === "M") return "var(--explorer-status-modified, #1890ff)";
  if (letter === "A") return "var(--explorer-status-added, #52c41a)";
  if (letter === "D") return "var(--explorer-status-deleted, #ff4d4f)";
  if (letter === "R") return "var(--explorer-status-renamed, #722ed1)";
  return "var(--app-muted)";
}

function fileName(p: string): string { return getPathDisplayInfo(p).fileName; }
function fileDir(p: string): string { return getPathDisplayInfo(p).dirPath; }

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function onClickFile(path: string) {
  emit("selectFile", path);
}
</script>

<template>
  <div class="commit-files">
    <template v-if="entry">
      <!-- Commit 摘要 -->
      <div class="commit-files__summary">
        <div class="commit-files__meta">
          <span class="commit-files__hash">{{ entry.hashShort }}</span>
          <span class="commit-files__date">{{ formatDate(entry.date) }}</span>
        </div>
        <div class="commit-files__message">{{ entry.message }}</div>
        <div class="commit-files__author">{{ entry.author }}</div>
      </div>

      <!-- 变更文件列表 -->
      <div class="commit-files__header">
        变更文件 ({{ files.length }})
      </div>
      <div class="commit-files__list" :class="{ 'commit-files__list--loading': isDiffLoading }">
        <div
          v-for="f in files"
          :key="f.path"
          class="commit-files__item"
          :class="{
            'commit-files__item--selected': explorer.commitDetailSelectedPath === f.path,
            'commit-files__item--dimmed': isDiffLoading && loadingPath !== f.path,
          }"
          @click="onClickFile(f.path)"
        >
          <span class="commit-files__path" :title="f.path" :style="{ color: statusColor(f.index) }">{{ fileName(f.path) }}</span>
          <span class="commit-files__dir">{{ fileDir(f.path) }}</span>
          <LoadingOutlined v-if="loadingPath === f.path" class="commit-files__spinner" />
          <span v-else class="commit-files__status" :style="{ color: statusColor(f.index) }">{{ f.index }}</span>
        </div>
      </div>
    </template>

    <div v-else class="commit-files__empty">
      <a-spin v-if="explorer.gitCommitDetailLoading" />
      <span v-else>选择一个 commit 查看变更</span>
    </div>
  </div>
</template>

<style scoped>
.commit-files {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.commit-files__summary {
  padding: 10px 12px;
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
}

.commit-files__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 12px;
}

.commit-files__hash {
  font-family: monospace;
  color: var(--app-accent, #c96442);
  font-weight: 600;
}

.commit-files__date {
  color: var(--app-muted);
  margin-left: auto;
  font-size: 11px;
}

.commit-files__message {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-files__author {
  font-size: 11px;
  color: var(--app-muted);
  margin-top: 2px;
}

.commit-files__header {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  background: var(--app-hover, rgba(0, 0, 0, 0.02));
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
}

.commit-files__list {
  padding: 2px 0;
}

.commit-files__list--loading {
  pointer-events: none;
}

.commit-files__item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 12px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.1s, opacity 0.15s;
}

.commit-files__item--dimmed {
  opacity: 0.5;
}

.commit-files__item:hover {
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

.commit-files__item--selected {
  background: var(--app-hover, rgba(0, 0, 0, 0.06));
}

.commit-files__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-files__dir {
  flex-shrink: 1;
  color: var(--app-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}

.commit-files__status {
  font-weight: 600;
  width: 16px;
  text-align: center;
  flex-shrink: 0;
  margin-left: 4px;
}

.commit-files__spinner {
  color: var(--app-accent, #c96442);
  flex-shrink: 0;
  margin-left: 4px;
  animation: commit-files-spin 1s linear infinite;
}

@keyframes commit-files-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.commit-files__empty {
  padding: 24px;
  text-align: center;
  color: var(--app-muted);
  font-size: 13px;
}
</style>

