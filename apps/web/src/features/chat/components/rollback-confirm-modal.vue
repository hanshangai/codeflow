<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { WarningOutlined, FileOutlined, DeleteOutlined, UndoOutlined } from "@ant-design/icons-vue";
import type { RollbackEvidenceIssue, RollbackFileInfo, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { previewRollback } from "../../../api/threads";
import { canConfirmRollback, isRollbackFileSelectable } from "../rollbackUiState";

defineOptions({ name: "RollbackConfirmModal" });

type Props = {
  open: boolean;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  toTurnId: TurnId;
};

type RollbackResult = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  toTurnId: TurnId;
  rollbackFiles: boolean;
  skipPaths: string[];
};

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "confirmed", result: RollbackResult): void;
}>();

const { ctx } = useApiContext();

const loading = ref(false);
const error = ref<string | null>(null);
const previewReady = ref(false);
const droppedTurnCount = ref(0);
const files = ref<RollbackFileInfo[]>([]);
const evidenceComplete = ref(false);
const evidenceIssues = ref<RollbackEvidenceIssue[]>([]);
const rollbackFilesChecked = ref(true);
const previewScopeKey = ref<string | null>(null);
let previewRequestSeq = 0;
/** Per-file checked state, keyed by path. */
const fileCheckedMap = ref<Record<string, boolean>>({});

const hasFiles = computed(() => files.value.length > 0);
const conflictCount = computed(() => files.value.filter((f) => f.hasConflict).length);
const checkedFileCount = computed(() => {
  if (!rollbackFilesChecked.value) return 0;
  return files.value.filter((f) => fileCheckedMap.value[f.path]).length;
});
const currentScopeKey = computed(() => buildRollbackScopeKey(props.workspaceId, props.threadId, props.toTurnId));
const canConfirm = computed(() => canConfirmRollback({
  previewReady: previewReady.value,
  previewError: error.value,
  previewScopeMatches: previewScopeKey.value === currentScopeKey.value,
  rollbackFiles: rollbackFilesChecked.value,
  evidenceComplete: evidenceComplete.value,
  selectedFileCount: checkedFileCount.value,
}));
const confirmText = computed(() => {
  if (loading.value) return "加载中…";
  if (error.value) return "预览失败";
  return rollbackFilesChecked.value ? "回滚对话与所选文件" : "仅回滚对话";
});

const skipPaths = computed(() => {
  if (!rollbackFilesChecked.value) return files.value.map((f) => f.path);
  return files.value.filter((f) => !fileCheckedMap.value[f.path]).map((f) => f.path);
});

/** 生成预览与提交共用的稳定目标标识。 */
function buildRollbackScopeKey(workspaceId: WorkspaceId, threadId: ThreadId, toTurnId: TurnId): string {
  return JSON.stringify([String(workspaceId), String(threadId), String(toTurnId)]);
}

/** 使所有尚未返回的旧预览失效，并清空其可提交状态。 */
function invalidatePreviewRequest(): void {
  previewRequestSeq += 1;
  previewScopeKey.value = null;
  previewReady.value = false;
  loading.value = false;
}

/** 仅允许当前仍打开、目标未变化的最新预览写入界面状态。 */
function isCurrentPreviewRequest(requestSeq: number, scopeKey: string): boolean {
  return requestSeq === previewRequestSeq
    && props.open
    && currentScopeKey.value === scopeKey;
}

/** 读取权威回滚预览；旧 Client 缺少证据字段时按证据不完整展示。 */
async function fetchPreview(): Promise<void> {
  const requestSeq = ++previewRequestSeq;
  const workspaceId = props.workspaceId;
  const threadId = props.threadId;
  const toTurnId = props.toTurnId;
  const scopeKey = buildRollbackScopeKey(workspaceId, threadId, toTurnId);
  loading.value = true;
  error.value = null;
  previewReady.value = false;
  files.value = [];
  evidenceComplete.value = false;
  evidenceIssues.value = [];
  droppedTurnCount.value = 0;
  fileCheckedMap.value = {};
  rollbackFilesChecked.value = false;

  try {
    const res = await previewRollback(ctx.value, {
      workspaceId,
      threadId,
      toTurnId,
    });
    if (!isCurrentPreviewRequest(requestSeq, scopeKey)) return;
    if (!res.ok) throw new Error(res.message);

    droppedTurnCount.value = res.droppedTurnCount;
    files.value = res.files;
    evidenceComplete.value = res.evidenceComplete === true;
    evidenceIssues.value = Array.isArray(res.evidenceIssues) ? res.evidenceIssues : [];
    if (!evidenceComplete.value && evidenceIssues.value.length === 0) {
      evidenceIssues.value = [{
        code: "diff_event_missing",
        path: null,
        message: "当前 Client 未返回完整的文件回滚证据",
      }];
    }

    const map: Record<string, boolean> = {};
    for (const f of res.files) {
      map[f.path] = isRollbackFileSelectable(f, evidenceComplete.value);
    }
    fileCheckedMap.value = map;

    rollbackFilesChecked.value = evidenceComplete.value && res.files.length > 0;
    previewScopeKey.value = scopeKey;
    previewReady.value = true;
  } catch (e) {
    if (!isCurrentPreviewRequest(requestSeq, scopeKey)) return;
    previewScopeKey.value = null;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (isCurrentPreviewRequest(requestSeq, scopeKey)) loading.value = false;
  }
}

/** 仅在预览成功且当前选择满足安全条件时提交。 */
function onConfirm(): void {
  if (!canConfirm.value) return;
  const rollbackFiles = rollbackFilesChecked.value && hasFiles.value;
  emit("confirmed", {
    workspaceId: props.workspaceId,
    threadId: props.threadId,
    toTurnId: props.toTurnId,
    rollbackFiles,
    skipPaths: rollbackFiles ? skipPaths.value : [],
  });
  emit("update:open", false);
}

function onCancel(): void {
  invalidatePreviewRequest();
  emit("update:open", false);
}

// 打开时读取预览；已打开期间目标变化则关闭，避免跨目标复用选择结果。
watch(
  () => [props.open, currentScopeKey.value] as const,
  ([isOpen, scopeKey], previous) => {
    const previousOpen = previous?.[0] ?? false;
    const previousScopeKey = previous?.[1] ?? null;
    if (!isOpen) {
      invalidatePreviewRequest();
      return;
    }
    if (previousOpen && previousScopeKey !== null && previousScopeKey !== scopeKey) {
      invalidatePreviewRequest();
      emit("update:open", false);
      return;
    }
    void fetchPreview();
  },
  { immediate: true },
);
</script>

<template>
  <a-modal
    :open="props.open"
    title="回滚确认"
    :ok-text="confirmText"
    cancel-text="取消"
    :ok-button-props="{ danger: true, disabled: !canConfirm }"
    :mask-closable="!loading"
    @ok="onConfirm"
    @cancel="onCancel"
    width="520px"
  >
    <div class="rollback-modal">
      <div class="rollback-modal__hint">
        <template v-if="loading">
          <a-spin size="small" style="margin-right: 8px" />
          正在分析受影响的文件…
        </template>
        <template v-else-if="error">
          <a-alert type="error" :message="error" show-icon style="margin-bottom: 12px">
            <template #action>
              <a-button size="small" @click="fetchPreview">重新预览</a-button>
            </template>
          </a-alert>
        </template>
        <template v-else>
          将删除该轮及之后的 <strong>{{ droppedTurnCount }}</strong> 轮对话。
        </template>
      </div>

      <a-alert
        v-if="!loading && !error && previewReady && !evidenceComplete"
        type="error"
        show-icon
        message="文件回滚证据不完整，只能回滚对话历史"
        style="margin-bottom: 12px"
      >
        <template #description>
          <div v-for="issue in evidenceIssues" :key="`${issue.code}:${issue.path ?? ''}:${issue.message}`">
            <span v-if="issue.path" class="rollback-modal__issue-path">{{ issue.path }}：</span>{{ issue.message }}
          </div>
        </template>
      </a-alert>

      <template v-if="!loading && !error && hasFiles">
        <div class="rollback-modal__file-toggle">
          <a-checkbox v-model:checked="rollbackFilesChecked" :disabled="!evidenceComplete">
            同时回滚文件变更
          </a-checkbox>
        </div>

        <template v-if="rollbackFilesChecked">
          <div class="rollback-modal__summary">
            共 {{ files.length }} 个文件<template v-if="conflictCount > 0">，<span class="rollback-modal__conflict-count">{{ conflictCount }} 个有冲突</span></template>
            <template v-if="checkedFileCount > 0">
              ，已选 {{ checkedFileCount }} 个
            </template>
          </div>

          <a-alert
            v-if="conflictCount > 0"
            type="warning"
            show-icon
            message="部分文件在会话外被修改，不能自动回滚，已取消勾选"
            style="margin-bottom: 8px"
          />

          <div class="rollback-modal__file-list">
            <div
              v-for="f in files"
              :key="f.path"
              class="rollback-modal__file-item"
              :class="{ 'rollback-modal__file-item--conflict': f.hasConflict }"
            >
              <a-checkbox
                :checked="fileCheckedMap[f.path] ?? false"
                :disabled="!isRollbackFileSelectable(f, evidenceComplete)"
                @update:checked="(v: boolean) => { fileCheckedMap[f.path] = v }"
              />
              <a-tag
                :color="f.rollbackOp === 'restore' ? 'blue' : 'red'"
                class="rollback-modal__op-tag"
              >
                <UndoOutlined v-if="f.rollbackOp === 'restore'" />
                <DeleteOutlined v-else />
                {{ f.rollbackOp === 'restore' ? '恢复' : '删除' }}
              </a-tag>
              <span class="rollback-modal__file-path">{{ f.path }}</span>
              <template v-if="f.hasConflict">
                <WarningOutlined class="rollback-modal__conflict-icon" />
                <span class="rollback-modal__conflict-reason">{{ f.conflictReason }}</span>
              </template>
              <a-tag v-if="!f.canRollback" color="default" class="rollback-modal__no-snap">
                缺快照
              </a-tag>
            </div>
          </div>
        </template>
      </template>

      <template v-if="!loading && !error && evidenceComplete && !hasFiles">
        <div class="rollback-modal__no-files">
          <FileOutlined style="margin-right: 4px" />
          该范围内无文件变更
        </div>
      </template>
    </div>
  </a-modal>
</template>

<style scoped>
.rollback-modal {
  min-height: 60px;
}

.rollback-modal__hint {
  margin-bottom: 12px;
  font-size: 14px;
  line-height: 1.6;
}

.rollback-modal__file-toggle {
  margin-bottom: 10px;
}

.rollback-modal__summary {
  font-size: 13px;
  color: var(--color-text-secondary, #666);
  margin-bottom: 8px;
}

.rollback-modal__conflict-count {
  color: var(--color-warning, #faad14);
  font-weight: 500;
}

.rollback-modal__file-list {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--color-border, #d9d9d9);
  border-radius: 6px;
  padding: 4px 0;
}

.rollback-modal__file-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 13px;
  line-height: 1.4;
}

.rollback-modal__file-item--conflict {
  background: var(--color-warning-bg, #fffbe6);
}

.rollback-modal__op-tag {
  flex-shrink: 0;
  font-size: 11px;
}

.rollback-modal__file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
  font-size: 12px;
}

.rollback-modal__conflict-icon {
  color: var(--color-warning, #faad14);
  flex-shrink: 0;
}

.rollback-modal__conflict-reason {
  font-size: 11px;
  color: var(--color-warning, #faad14);
  flex-shrink: 0;
}

.rollback-modal__issue-path {
  font-family: monospace;
}

.rollback-modal__no-snap {
  flex-shrink: 0;
  font-size: 11px;
}

.rollback-modal__no-files {
  color: var(--color-text-secondary, #999);
  font-size: 13px;
  padding: 8px 0;
}
</style>

