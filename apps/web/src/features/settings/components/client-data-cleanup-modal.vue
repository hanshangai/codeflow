<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { DeleteOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import dayjs, { type Dayjs } from "dayjs";
import type {
  ClientDbCleanupPhase,
  ClientDbCleanupStatus,
  ClientDbStorageSummary,
  ClientId,
} from "@codeflowai/shared";

import { createApiResultError, isCancelledRequestError } from "../../../api/request";
import { getClientDbCleanupStatus, startClientDbCleanup } from "../../../api/threads";
import { useApiContext } from "../../../composables/useApiContext";

defineOptions({ name: "ClientDataCleanupModal" });

type Props = {
  clientId: ClientId;
  disabled?: boolean;
  open: boolean;
};

const props = defineProps<Props>();
const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const { ctx } = useApiContext();
const cleanupDate = ref<Dayjs | null>(null);
const storage = ref<ClientDbStorageSummary | null>(null);
const statusLoading = ref(false);
const starting = ref(false);
const statusError = ref<string | null>(null);
const POLL_INTERVAL_MS = 2_000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let statusRequestController: AbortController | null = null;
let clientScopeEpoch = 0;
let startRequestSequence = 0;

const modalOpen = computed({
  get: () => props.open,
  set: (value: boolean) => {
    if (!value && starting.value) return;
    emit("update:open", value);
  },
});
const cleanup = computed(() => storage.value?.cleanup ?? null);
const cleanupStatus = computed<ClientDbCleanupStatus>(() => cleanup.value?.status ?? "idle");
const cleanupActive = computed(() => cleanupStatus.value === "queued" || cleanupStatus.value === "running");
const canStartCleanup = computed(() => Boolean(
  !props.disabled
  && String(props.clientId ?? "").trim()
  && cleanupDate.value
  && storage.value
  && !statusError.value
  && !statusLoading.value
  && !starting.value
  && !cleanupActive.value
));
const cleanupAlertType = computed<"success" | "info" | "warning" | "error">(() => {
  if (cleanupStatus.value === "completed") return "success";
  if (cleanupStatus.value === "failed") return "error";
  if (cleanupStatus.value === "cancelled") return "warning";
  return "info";
});
const cleanupStatusMessage = computed(() => {
  if (cleanupStatus.value === "queued") return "清理任务已排队";
  if (cleanupStatus.value === "running") return "正在后台分批清理";
  if (cleanupStatus.value === "completed") return "清理完成";
  if (cleanupStatus.value === "failed") return "清理失败";
  if (cleanupStatus.value === "cancelled") return "清理已取消";
  return "尚未运行清理任务";
});
const cleanupStatusDescription = computed(() => {
  const snapshot = cleanup.value;
  if (!snapshot) return "";
  if (snapshot.status === "failed") return snapshot.error || "后台任务未返回错误原因";
  if (snapshot.status === "cancelled") return snapshot.error || "任务未完成，可重新选择截止日期后发起清理。";
  if (snapshot.status === "queued") return "等待 Client 开始处理；关闭弹窗不影响任务。";
  if (snapshot.status === "running") {
    const phase = cleanupPhaseLabel(snapshot.phase);
    return `${phase ? `${phase}；` : ""}关闭弹窗不影响任务。`;
  }
  if (snapshot.status === "completed") return "历史数据已删除，空间已转为数据库内部可复用空间。";
  return "";
});

/** 将字节数格式化为紧凑的可读容量。 */
function formatBytes(value: number | null | undefined): string {
  const bytes = Math.max(0, Number(value ?? 0));
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

/** 将毫秒时间戳格式化为固定中文年月日时分。 */
function formatDateTime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 把后台清理阶段转换为用户可读文案，不推导百分比。 */
function cleanupPhaseLabel(phase: ClientDbCleanupPhase): string {
  if (phase === "selecting_threads") return "正在筛选旧会话";
  if (phase === "conversation_events") return "正在清理会话正文";
  if (phase === "raw_engine_events") return "正在清理原始引擎事件";
  if (phase === "prompt_snapshots") return "正在清理编排提示快照";
  if (phase === "file_blobs") return "正在清理无引用附件";
  return "";
}

/** 禁止选择今天之后的日期，避免把未来边界误当作历史范围。 */
function disableFutureDate(value: Dayjs): boolean {
  return value.startOf("day").isAfter(dayjs().startOf("day"));
}

/** 判断异步结果是否仍属于当前打开的 Client 弹窗。 */
function isCurrentClientScope(clientId: ClientId, epoch: number): boolean {
  return props.open
    && !props.disabled
    && epoch === clientScopeEpoch
    && String(props.clientId ?? "").trim() === String(clientId);
}

/** 停止下一轮状态查询。 */
function clearPollTimer(): void {
  if (!pollTimer) return;
  clearTimeout(pollTimer);
  pollTimer = null;
}

/** 取消当前只读状态请求；后台清理任务本身不受影响。 */
function cancelStatusRequest(): void {
  const controller = statusRequestController;
  statusRequestController = null;
  controller?.abort();
}

/** 仅在弹窗打开、Client 在线且任务活跃时安排下一次轮询。 */
function scheduleStatusPoll(): void {
  clearPollTimer();
  if (!props.open || props.disabled || !cleanupActive.value) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void loadCleanupStatus(false);
  }, POLL_INTERVAL_MS);
}

/** 查询 Client 权威清理状态；真实失败会停止轮询并留在页面。 */
async function loadCleanupStatus(showLoading = true): Promise<void> {
  const clientId = String(props.clientId ?? "").trim() as ClientId;
  const scopeEpoch = clientScopeEpoch;
  if (props.disabled || !props.open || !clientId || starting.value) return;
  clearPollTimer();
  cancelStatusRequest();
  const controller = new AbortController();
  statusRequestController = controller;
  if (showLoading) statusLoading.value = true;
  statusError.value = null;
  try {
    const result = await getClientDbCleanupStatus(ctx.value, clientId, { signal: controller.signal });
    if (!result.ok) throw createApiResultError(result);
    if (!isCurrentClientScope(clientId, scopeEpoch) || statusRequestController !== controller) return;
    const wasActive = cleanupActive.value;
    storage.value = result.storage;
    if (cleanupActive.value && result.storage.cleanup.inactiveBefore != null) {
      cleanupDate.value = dayjs(result.storage.cleanup.inactiveBefore);
    } else if (wasActive) {
      cleanupDate.value = null;
    }
    scheduleStatusPoll();
  } catch (error) {
    if (controller.signal.aborted || isCancelledRequestError(error)) return;
    if (!isCurrentClientScope(clientId, scopeEpoch) || statusRequestController !== controller) return;
    statusError.value = error instanceof Error ? error.message : String(error);
    message.error(statusError.value);
  } finally {
    if (statusRequestController === controller) {
      statusRequestController = null;
      statusLoading.value = false;
    }
  }
}

/** 二次确认按所选日期的当地零点启动清理。 */
function confirmCleanup(): void {
  if (!canStartCleanup.value || !cleanupDate.value) return;
  const inactiveBefore = cleanupDate.value.startOf("day").valueOf();
  Modal.confirm({
    title: `确认清理 ${formatDateTime(inactiveBefore)} 以前的历史数据？`,
    content: "符合条件的会话正文、原始引擎事件、过期编排提示快照和无引用附件将被永久删除；正在运行的会话会跳过。任务在后台分批执行，关闭弹窗不影响任务。",
    okText: "确认清理",
    okType: "danger",
    cancelText: "取消",
    onOk: () => runCleanup(inactiveBefore),
  });
}

/** 提交后台清理任务并使用 ACK 返回的权威状态开始轮询。 */
async function runCleanup(inactiveBefore: number): Promise<void> {
  const clientId = String(props.clientId ?? "").trim() as ClientId;
  const scopeEpoch = clientScopeEpoch;
  if (!canStartCleanup.value || !clientId) return;
  const requestSequence = ++startRequestSequence;
  clearPollTimer();
  cancelStatusRequest();
  starting.value = true;
  statusError.value = null;
  try {
    const result = await startClientDbCleanup(ctx.value, { clientId, inactiveBefore });
    if (!result.ok) throw createApiResultError(result);
    if (!isCurrentClientScope(clientId, scopeEpoch)) return;
    storage.value = result.storage;
    if (!cleanupActive.value) cleanupDate.value = null;
    scheduleStatusPoll();
    message.success("历史数据清理任务已提交");
  } catch (error) {
    if (!isCurrentClientScope(clientId, scopeEpoch)) return;
    statusError.value = error instanceof Error ? error.message : String(error);
    message.error(statusError.value);
  } finally {
    if (requestSequence === startRequestSequence) {
      starting.value = false;
      if (props.open && !props.disabled && scopeEpoch !== clientScopeEpoch) void loadCleanupStatus();
    }
  }
}

/** Client 变化时丢弃旧任务展示与日期输入。 */
function resetClientState(): void {
  clientScopeEpoch += 1;
  startRequestSequence += 1;
  clearPollTimer();
  cancelStatusRequest();
  cleanupDate.value = null;
  storage.value = null;
  statusLoading.value = false;
  starting.value = false;
  statusError.value = null;
}

watch(() => props.clientId, () => {
  resetClientState();
  if (props.open && !props.disabled) void loadCleanupStatus();
});
watch(() => props.disabled, (disabled) => {
  clientScopeEpoch += 1;
  clearPollTimer();
  cancelStatusRequest();
  statusLoading.value = false;
  if (!disabled && props.open) void loadCleanupStatus();
});
watch(() => props.open, (open) => {
  if (open && !props.disabled) {
    void loadCleanupStatus();
    return;
  }
  clientScopeEpoch += 1;
  clearPollTimer();
  cancelStatusRequest();
  statusLoading.value = false;
  if (!open) cleanupDate.value = null;
}, { immediate: true });
onBeforeUnmount(() => {
  clientScopeEpoch += 1;
  startRequestSequence += 1;
  clearPollTimer();
  cancelStatusRequest();
});
</script>

<template>
  <a-modal
    v-model:open="modalOpen"
    title="Client 历史数据清理"
    width="min(560px, calc(100vw - 24px))"
    :mask-closable="!starting"
    :closable="!starting"
    :keyboard="!starting"
  >
    <a-space class="client-cleanup" direction="vertical" :size="16">
      <a-alert
        v-if="disabled"
        type="warning"
        show-icon
        message="Client 已离线"
        description="Client 重新上线后才能查询状态或重新发起清理。"
      />

      <a-form layout="vertical">
        <a-form-item label="清理最后活动早于">
          <a-date-picker
            v-model:value="cleanupDate"
            class="client-cleanup__date"
            format="YYYY-MM-DD"
            placeholder="选择截止日期"
            :disabled-date="disableFutureDate"
            :disabled="disabled || starting || cleanupActive"
            allow-clear
          />
        </a-form-item>
      </a-form>

      <a-alert v-if="statusError" type="error" show-icon :message="statusError" />
      <a-alert
        v-if="cleanup && cleanupStatus !== 'idle'"
        :type="cleanupAlertType"
        show-icon
        :message="cleanupStatusMessage"
        :description="cleanupStatusDescription"
      />

      <a-descriptions v-if="storage" size="small" bordered :column="1">
        <a-descriptions-item label="数据库文件">
          {{ formatBytes(storage.databaseBytes) }}
        </a-descriptions-item>
        <a-descriptions-item label="数据库内部可复用空间">
          {{ formatBytes(storage.reusableBytes) }}
        </a-descriptions-item>
        <template v-if="cleanup && cleanupStatus !== 'idle'">
          <a-descriptions-item label="截止时间">
            {{ formatDateTime(cleanup.inactiveBefore) }}
          </a-descriptions-item>
          <a-descriptions-item label="符合条件会话">
            {{ cleanup.selectedThreadCount }} 个
          </a-descriptions-item>
          <a-descriptions-item label="已处理 / 已跳过会话">
            {{ cleanup.processedThreadCount }} / {{ cleanup.skippedThreadCount }} 个
          </a-descriptions-item>
          <a-descriptions-item label="已执行批次">
            {{ cleanup.batchCount }} 批
          </a-descriptions-item>
          <a-descriptions-item label="已删除会话正文">
            {{ cleanup.deletedConversationEventCount }} 条
          </a-descriptions-item>
          <a-descriptions-item label="已删除原始引擎事件">
            {{ cleanup.deletedRawEngineEventCount }} 条
          </a-descriptions-item>
          <a-descriptions-item label="已删除编排提示快照">
            {{ cleanup.deletedPromptSnapshotCount }} 条
          </a-descriptions-item>
          <a-descriptions-item label="已删除无引用附件">
            {{ cleanup.deletedFileBlobCount }} 个（{{ formatBytes(cleanup.deletedFileBlobBytes) }}）
          </a-descriptions-item>
          <a-descriptions-item v-if="cleanup.reusableBytesBefore != null" label="清理前内部可复用空间">
            {{ formatBytes(cleanup.reusableBytesBefore) }}
          </a-descriptions-item>
          <a-descriptions-item v-if="cleanup.reusableBytesAfter != null" label="清理后内部可复用空间">
            {{ formatBytes(cleanup.reusableBytesAfter) }}
          </a-descriptions-item>
        </template>
      </a-descriptions>
    </a-space>

    <template #footer>
      <a-space>
        <a-button
          :disabled="disabled || starting"
          :loading="statusLoading"
          @click="loadCleanupStatus()"
        >
          <template #icon><ReloadOutlined /></template>
          刷新状态
        </a-button>
        <a-button :disabled="starting" @click="modalOpen = false">关闭</a-button>
        <a-button
          type="primary"
          danger
          :disabled="!canStartCleanup"
          :loading="starting"
          @click="confirmCleanup"
        >
          <template #icon><DeleteOutlined /></template>
          开始清理
        </a-button>
      </a-space>
    </template>
  </a-modal>
</template>

<style scoped>
.client-cleanup,
.client-cleanup__date {
  width: 100%;
}
</style>
