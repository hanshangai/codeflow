<script setup lang="ts">
import { ref, watch } from "vue";
import { LoadingOutlined } from "@ant-design/icons-vue";
import type { WorkspaceId } from "@codeflowai/shared";
import type { ApiRequestContext } from "../../../api/request";
import { useExplorerStore } from "../../../store/explorer";
import ExplorerPanelState from "./explorer-panel-state.vue";

defineOptions({ name: "GitLogPanel" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  ctx: ApiRequestContext;
}>();

const explorer = useExplorerStore();

/** 正在加载详情的 commit hash（用于显示 per-item loading 状态） */
const loadingHash = ref<string | null>(null);

/** 读取错误保留页面失败态，并在消费边界记录可追踪上下文。 */
function reportHistoryFailure(error: unknown): void {
  const failure = error as { code?: unknown; details?: { requestId?: unknown; serverRequestId?: unknown } };
  console.error("[GIT_HISTORY_LOAD_FAILED]", { code: failure?.code ?? "GIT_HISTORY_LOAD_FAILED",
    requestId: failure?.details?.requestId ?? failure?.details?.serverRequestId ?? null,
    workspaceId: props.workspaceId, repositoryPath: explorer.selectedGitRepositoryPath,
    cause: error instanceof Error ? error.message : String(error) });
}

/** 按已加载页数读取当前历史；显式重试才绕过完整仓库的 HEAD 缓存。 */
function loadHistory(force = false): void {
  const count = explorer.gitHistoryRequestedCount(props.ctx, props.workspaceId);
  void explorer.loadGitLog(props.ctx, props.workspaceId, count, 0, force).catch(reportHistoryFailure);
}

watch(
  [() => props.workspaceId, () => explorer.selectedGitRepositoryPath, () => explorer.gitStatus?.isRepo, () => explorer.gitStatus?.headCommit,
    () => explorer.gitStatus?.historyCacheable === false ? explorer.gitStatus : null,
    () => explorer.gitStatus?.historyCacheable === false ? explorer._gitHistoryInvalidationVersion : null],
  ([wid, , isRepo]) => {
    if (wid && isRepo) loadHistory();
  },
  { immediate: true },
);

/** 只补读下一页，失败保留已有列表。 */
function loadMore(): void {
  void explorer.loadGitLog(props.ctx, props.workspaceId, 20, explorer.gitLogEntries.length).catch(reportHistoryFailure);
}

/** 打开所选提交的元数据；错误由列表展示，完整 patch 留待显式展开。 */
async function showDetail(hash: string) {
  if (loadingHash.value) return;
  loadingHash.value = hash;
  try {
    await explorer.loadGitCommitDetail(props.ctx, props.workspaceId, hash);
  } catch (error) {
    reportHistoryFailure(error);
  } finally {
    loadingHash.value = null;
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}
</script>

<template>
  <div class="git-log">
    <a-alert v-if="explorer.gitLogError" type="error" show-icon :message="explorer.gitLogError">
      <template #action><a-button size="small" :loading="explorer.gitLogLoading" @click="loadHistory(true)">重试历史</a-button></template>
    </a-alert>
    <a-alert v-if="explorer.gitCommitDetailError" type="error" show-icon
      :message="`${explorer.gitCommitDetailError}，请再次点击提交重试`" />
    <div v-if="explorer.gitLogEntries.length" class="git-log__list" :class="{ 'git-log__list--loading': !!loadingHash }">
      <div
        v-for="entry in explorer.gitLogEntries"
        :key="entry.hash"
        class="git-log__entry"
        :class="{ 'git-log__entry--loading': loadingHash === entry.hash, 'git-log__entry--dimmed': !!loadingHash && loadingHash !== entry.hash }"
        @click="showDetail(entry.hash)"
      >
        <div class="git-log__header">
          <span class="git-log__hash">{{ entry.hashShort }}</span>
          <LoadingOutlined v-if="loadingHash === entry.hash" class="git-log__spinner" />
          <span class="git-log__date">{{ formatDate(entry.date) }}</span>
        </div>
        <div class="git-log__message">{{ entry.message }}</div>
        <div class="git-log__author">{{ entry.author }}</div>
        <div v-if="entry.refs" class="git-log__refs">
          <a-tag v-for="ref in entry.refs.split(',').map(r => r.trim()).filter(Boolean)" :key="ref" size="small" color="blue">{{ ref }}</a-tag>
        </div>
      </div>
    </div>
    <ExplorerPanelState v-else-if="explorer.gitLogLoading" loading text="加载中" />
    <ExplorerPanelState v-else text="无提交记录" />

    <div v-if="explorer.gitLogEntries.length < explorer.gitLogTotal" class="git-log__footer">
      <a-button size="small" type="link" :loading="explorer.gitLogLoading" @click="loadMore">
        加载更多（{{ explorer.gitLogEntries.length }}/{{ explorer.gitLogTotal }}）
      </a-button>
    </div>
  </div>
</template>

<style scoped>
.git-log {
  height: 100%;
  overflow: auto;
  padding: 8px;
}

.git-log__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.git-log__list--loading {
  pointer-events: none;
}

.git-log__entry {
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s, opacity 0.15s;
}

.git-log__entry:hover {
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

.git-log__entry--dimmed {
  opacity: 0.5;
}

.git-log__entry--loading {
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

.git-log__spinner {
  color: var(--app-accent, #c96442);
  animation: spin 1s linear infinite;
}

.git-log__header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
}

.git-log__hash {
  font-family: monospace;
  font-size: 12px;
  color: var(--app-accent, #c96442);
  font-weight: 600;
}

.git-log__date {
  font-size: 11px;
  color: var(--app-muted);
  margin-left: auto;
}

.git-log__message {
  font-size: 13px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-log__author {
  font-size: 11px;
  color: var(--app-muted);
  margin-top: 2px;
}

.git-log__refs {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.git-log__footer {
  display: flex;
  justify-content: center;
  padding: 8px;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>

