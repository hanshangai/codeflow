<script setup lang="ts">
import { computed } from "vue";
import { ReloadOutlined, PoweroffOutlined } from "@ant-design/icons-vue";
import type { ManagedServiceSnapshot } from "@codeflowai/shared";

defineOptions({ name: "ManagedServicesModal" });

type Props = {
  open: boolean;
  loading: boolean;
  items: ManagedServiceSnapshot[];
  selectedServiceId?: string | null;
  error?: string | null;
  disabled?: boolean;
};

type Emits = {
  (e: "update:open", value: boolean): void;
  (e: "refresh"): void;
  (e: "stop", serviceId: string): void;
};

const props = withDefaults(defineProps<Props>(), {
  selectedServiceId: null,
  disabled: false,
});
const emit = defineEmits<Emits>();
const modalWidth = computed(() =>
  typeof window !== "undefined" && window.innerWidth <= 767 ? "calc(100vw - 24px)" : 760,
);

const selectedService = computed(() => {
  const selectedId = String(props.selectedServiceId ?? "").trim();
  if (!props.items.length) return null;
  return props.items.find((item) => item.serviceId === selectedId) ?? props.items[0] ?? null;
});

function canStop(item: ManagedServiceSnapshot | null): boolean {
  if (!item) return false;
  return !props.disabled && item.stopSupported !== false && item.status !== "stopped" && item.status !== "exited";
}

function statusLabel(status: ManagedServiceSnapshot["status"]): string {
  switch (status) {
    case "starting":
      return "启动中";
    case "ready":
      return "运行中";
    case "exited":
      return "已退出";
    case "stopped":
      return "已停止";
    default:
      return status;
  }
}

function statusColor(status: ManagedServiceSnapshot["status"]): string {
  switch (status) {
    case "ready":
      return "success";
    case "starting":
      return "processing";
    case "exited":
      return "error";
    default:
      return "default";
  }
}

function formatCommand(item: ManagedServiceSnapshot | null): string {
  if (!item) return "";
  return [item.command, ...(item.args ?? [])].join(" ").trim();
}

function displayName(item: ManagedServiceSnapshot | null): string {
  if (!item) return "";
  const text = String(item.displayName ?? "").trim();
  return text || item.serviceId;
}

function formatTime(ts: number | null): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function stateDescription(item: ManagedServiceSnapshot | null): string {
  if (!item) return "-";
  const readySummary = String(item.readySummary ?? "").trim();
  if (readySummary) {
    const normalized = readySummary.toLowerCase();
    if (normalized === "starting") return "等待就绪中";
    if (normalized === "ready") return "已可用";
    if (normalized === "stopped") return "已停止";
    if (normalized === "exited") return "已退出";
    return readySummary;
  }
  if (item.status === "starting") return "等待就绪中";
  if (item.status === "ready") return "已可用";
  if (item.status === "exited") return "进程已退出";
  return "进程已停止";
}

function sourceLabel(item: ManagedServiceSnapshot | null): string {
  if (!item) return "平台";
  return item.source === "engine" ? "引擎" : "平台";
}
</script>

<template>
  <a-modal
    :open="props.open"
    title="进程详情"
    :footer="null"
    :width="modalWidth"
    centered
    @cancel="emit('update:open', false)"
  >
    <a-alert v-if="props.error" type="error" show-icon :message="props.error" style="margin-bottom: 12px" />

    <template v-if="selectedService">
      <div class="svc-modal__hero">
        <div class="svc-modal__hero-main">
          <div class="svc-modal__title-row">
            <strong class="svc-modal__title">{{ displayName(selectedService) }}</strong>
            <a-tag color="blue" style="margin: 0">
              {{ sourceLabel(selectedService) }}
            </a-tag>
            <a-tag :color="statusColor(selectedService.status)" style="margin: 0">
              {{ statusLabel(selectedService.status) }}
            </a-tag>
            <span v-if="selectedService.pid" class="svc-modal__meta">PID {{ selectedService.pid }}</span>
          </div>
          <div class="svc-modal__meta">目录：{{ selectedService.workingDirectory }}</div>
        </div>
        <div class="svc-modal__hero-actions">
          <a-button size="small" :loading="props.loading" @click="emit('refresh')">
            <ReloadOutlined />
            刷新
          </a-button>
          <a-button
            size="small"
            danger
            :disabled="!canStop(selectedService)"
            @click="selectedService && emit('stop', selectedService.serviceId)"
          >
            <PoweroffOutlined />
            停止
          </a-button>
        </div>
      </div>

      <div class="svc-modal__section">
        <div class="svc-modal__label">命令</div>
        <pre class="svc-modal__code">{{ formatCommand(selectedService) }}</pre>
      </div>

      <div class="svc-modal__facts">
        <div class="svc-modal__fact">
          <span class="svc-modal__label">启动时间</span>
          <span>{{ formatTime(selectedService.startedAt) }}</span>
        </div>
        <div class="svc-modal__fact">
          <span class="svc-modal__label">就绪时间</span>
          <span>{{ formatTime(selectedService.readyAt) }}</span>
        </div>
        <div class="svc-modal__fact">
          <span class="svc-modal__label">退出时间</span>
          <span>{{ formatTime(selectedService.exitedAt) }}</span>
        </div>
        <div class="svc-modal__fact">
          <span class="svc-modal__label">退出码</span>
          <span>{{ selectedService.exitCode ?? "-" }}</span>
        </div>
        <div class="svc-modal__fact">
          <span class="svc-modal__label">退出信号</span>
          <span>{{ selectedService.exitSignal || "-" }}</span>
        </div>
        <div class="svc-modal__fact">
          <span class="svc-modal__label">状态说明</span>
          <span>{{ stateDescription(selectedService) }}</span>
        </div>
      </div>
    </template>

    <a-empty v-else description="当前没有进程" />
  </a-modal>
</template>

<style scoped>
.svc-modal__hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.svc-modal__hero-main {
  min-width: 0;
}

.svc-modal__title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}

.svc-modal__title {
  font-size: 16px;
  font-weight: 700;
  color: var(--app-text, #222);
}

.svc-modal__meta,
.svc-modal__label {
  color: var(--app-muted, #666);
  font-size: 12px;
}

.svc-modal__hero-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.svc-modal__section {
  display: grid;
  gap: 6px;
  margin-bottom: 16px;
}

.svc-modal__code {
  margin: 0;
  padding: 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 92%, #0f172a 8%);
  border: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 84%, var(--app-accent, #1677ff) 16%);
  color: var(--app-text, #222);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

.svc-modal__facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.svc-modal__fact {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 88%, var(--app-accent, #1677ff) 12%);
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 96%, var(--app-accent, #1677ff) 4%);
}

@media (max-width: 767px) {
  .svc-modal__hero {
    flex-direction: column;
  }

  .svc-modal__hero-actions {
    width: 100%;
    justify-content: flex-end;
  }

  .svc-modal__facts {
    grid-template-columns: 1fr;
  }
}

:root[data-theme="dark"] .svc-modal__title {
  color: #d9d9d9;
}

:root[data-theme="dark"] .svc-modal__code {
  background: #111827;
  border-color: #303030;
  color: #d9d9d9;
}

:root[data-theme="dark"] .svc-modal__fact {
  border-color: #303030;
  background: color-mix(in srgb, #141414 92%, #111d2c 8%);
}
</style>
