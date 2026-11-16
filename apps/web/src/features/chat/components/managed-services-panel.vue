<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  CaretDownOutlined,
  CaretUpOutlined,
  CloudServerOutlined,
  EyeOutlined,
  PoweroffOutlined,
  ReloadOutlined,
} from "@ant-design/icons-vue";
import type { ManagedServiceSnapshot } from "@codeflowai/shared";

defineOptions({ name: "ManagedServicesPanel" });

type Props = {
  loading: boolean;
  items: ManagedServiceSnapshot[];
  error?: string | null;
  mode?: "default" | "toolbar";
  disabled?: boolean;
  expanded?: boolean;
};

type Emits = {
  (e: "refresh"): void;
  (e: "stop", serviceId: string): void;
  (e: "inspect", serviceId: string): void;
  (e: "expandedChange", value: boolean): void;
};

const props = withDefaults(defineProps<Props>(), {
  mode: "default",
  disabled: false,
  expanded: false,
});
const emit = defineEmits<Emits>();

const rootEl = ref<HTMLElement | null>(null);
const PANEL_SOURCE = "managed-services";
const isToolbarMode = computed(() => props.mode === "toolbar");

const readyCount = computed(() =>
  props.items.filter((item) => item.status === "ready").length,
);
const startingCount = computed(() =>
  props.items.filter((item) => item.status === "starting").length,
);
const activeCount = computed(() => readyCount.value + startingCount.value);
const historyCount = computed(() => Math.max(0, props.items.length - activeCount.value));
const totalCount = computed(() => activeCount.value);
const headerSummary = computed(() => {
  const total = props.items.length;
  const active = activeCount.value;
  const history = historyCount.value;
  if (!total) return "暂无进程";
  if (!active) return history ? `无运行进程 · 历史 ${history}` : "暂无进程";
  if (readyCount.value === active) return history ? `运行 ${readyCount.value} · 历史 ${history}` : `运行 ${readyCount.value}`;
  if (!readyCount.value) return history ? `启动中 ${startingCount.value} · 历史 ${history}` : `启动中 ${startingCount.value}`;
  if (!startingCount.value) return history ? `运行 ${readyCount.value} · 历史 ${history}` : `运行 ${readyCount.value}`;
  return history ? `运行 ${readyCount.value} · 启动中 ${startingCount.value} · 历史 ${history}` : `运行 ${readyCount.value} · 启动中 ${startingCount.value}`;
});

function toggleExpanded(): void {
  const next = !props.expanded;
  emit("expandedChange", next);
  if (next) {
    window.dispatchEvent(new CustomEvent("chat-floatbox:expand", { detail: { source: PANEL_SOURCE } }));
  }
}

function handleOtherExpand(event: Event): void {
  const source = (event as CustomEvent<{ source?: string }>).detail?.source;
  if (source !== PANEL_SOURCE && props.expanded) emit("expandedChange", false);
}

function handleWindowPointerDown(event: PointerEvent): void {
  if (!props.expanded || !isToolbarMode.value) return;
  const root = rootEl.value;
  const target = event.target as Node | null;
  if (!root || !target) return;
  if (!root.contains(target)) emit("expandedChange", false);
}

function canStop(item: ManagedServiceSnapshot): boolean {
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

function statusClass(status: ManagedServiceSnapshot["status"]): string {
  switch (status) {
    case "ready":
      return "svc-bar__status svc-bar__status--ready";
    case "starting":
      return "svc-bar__status svc-bar__status--starting";
    case "exited":
      return "svc-bar__status svc-bar__status--exited";
    default:
      return "svc-bar__status";
  }
}

function formatCommand(item: ManagedServiceSnapshot): string {
  return [item.command, ...(item.args ?? [])].join(" ").trim();
}

function summarizeCommand(item: ManagedServiceSnapshot): string {
  const summary = formatCommand(item);
  if (!summary) return displayName(item);
  return summary.length > 72 ? `${summary.slice(0, 69)}...` : summary;
}

function displayName(item: ManagedServiceSnapshot): string {
  const text = String(item.displayName ?? "").trim();
  if (text) return text;
  return item.serviceId;
}

function summarizeState(item: ManagedServiceSnapshot): string {
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

function sourceLabel(item: ManagedServiceSnapshot): string {
  return item.source === "engine" ? "引擎" : "平台";
}

onMounted(() => {
  window.addEventListener("chat-floatbox:expand", handleOtherExpand as EventListener);
  window.addEventListener("pointerdown", handleWindowPointerDown);
});

onBeforeUnmount(() => {
  window.removeEventListener("chat-floatbox:expand", handleOtherExpand as EventListener);
  window.removeEventListener("pointerdown", handleWindowPointerDown);
});
</script>

<template>
  <div
    v-if="props.items.length > 0"
    ref="rootEl"
    class="fc-bar-wrap svc-bar-wrap"
    :class="{ 'fc-bar-wrap--expanded': props.expanded, 'fc-bar-wrap--toolbar': isToolbarMode }"
  >
    <button
      v-if="isToolbarMode"
      type="button"
      class="fc-bar__chip"
      :aria-expanded="props.expanded"
      aria-label="切换进程"
      @click="toggleExpanded"
    >
      <CloudServerOutlined class="fc-bar__chip-icon" />
      <span class="fc-bar__chip-title">进程</span>
      <span class="fc-bar__chip-count">{{ totalCount }}</span>
      <span class="fc-bar__chip-toggle">
        <CaretDownOutlined v-if="props.expanded" />
        <CaretUpOutlined v-else />
      </span>
    </button>
    <button
      v-if="props.expanded && !isToolbarMode"
      type="button"
      class="fc-bar__backdrop"
      aria-label="关闭进程"
      @click="emit('expandedChange', false)"
    />
    <div
      v-if="!isToolbarMode || props.expanded"
      class="fc-bar svc-bar"
      :class="{ 'fc-bar--expanded': props.expanded, 'fc-bar--toolbar-popup': isToolbarMode }"
    >
      <div class="fc-bar__header" @click="toggleExpanded">
        <CloudServerOutlined class="fc-bar__icon" />
        <span class="fc-bar__title">进程</span>
        <span class="fc-bar__summary">{{ headerSummary }}</span>
        <span class="fc-bar__count">{{ totalCount }}</span>
        <span class="fc-bar__toggle"><CaretDownOutlined v-if="props.expanded" /><CaretUpOutlined v-else /></span>
      </div>

      <template v-if="props.expanded">
        <div class="fc-bar__body svc-bar__body">
          <a-alert v-if="props.error" type="error" show-icon :message="props.error" style="margin-bottom: 8px" />
          <div class="svc-bar__list">
            <div v-for="item in props.items" :key="item.serviceId" class="svc-bar__row">
              <span :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span>
              <div class="svc-bar__service">
                <button
                  type="button"
                  class="svc-bar__service-link mono"
                  :title="displayName(item)"
                  @click.stop="emit('inspect', item.serviceId)"
                >
                  {{ displayName(item) }}
                </button>
                <span class="svc-bar__source">{{ sourceLabel(item) }}</span>
              </div>
              <span class="svc-bar__command mono" :title="formatCommand(item)">{{ summarizeCommand(item) }}</span>
              <span class="svc-bar__summary-text" :title="summarizeState(item)">{{ summarizeState(item) }}</span>
              <span class="svc-bar__actions">
                <a-tooltip title="查看命令">
                  <button type="button" class="fc-table__action svc-bar__icon-btn" @click.stop="emit('inspect', item.serviceId)">
                    <EyeOutlined />
                  </button>
                </a-tooltip>
                <a-tooltip title="停止进程">
                  <button
                    type="button"
                    class="fc-table__action fc-table__action--danger svc-bar__icon-btn"
                    :class="{ 'fc-table__action--disabled': !canStop(item) }"
                    :disabled="!canStop(item)"
                    @click.stop="emit('stop', item.serviceId)"
                  >
                    <PoweroffOutlined />
                  </button>
                </a-tooltip>
              </span>
            </div>
          </div>
        </div>
        <div class="fc-bar__toolbar svc-bar__toolbar">
          <span class="fc-bar__tool-btn" :class="{ 'fc-bar__tool-btn--loading': props.loading }" @click="emit('refresh')">
            <ReloadOutlined :spin="props.loading" />
            刷新
          </span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.svc-bar__service-link,
.svc-bar__icon-btn {
  border: 0;
  background: none;
  cursor: pointer;
  font: inherit;
}

.svc-bar__body {
  display: grid;
  gap: 10px;
}

.svc-bar__toolbar {
  justify-content: flex-end;
}

.svc-bar__list {
  display: flex;
  flex-direction: column;
}

.svc-bar__row {
  display: grid;
  grid-template-columns: auto minmax(168px, 1fr) minmax(96px, 148px) minmax(56px, auto) auto;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
}

.svc-bar__row + .svc-bar__row {
  border-top: 1px solid color-mix(in srgb, var(--app-divider, #d9d9d9) 40%, transparent);
}

.svc-bar__service {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.svc-bar__service-link {
  padding: 0;
  min-width: 0;
  color: var(--app-text, #222);
  font-weight: 600;
  font-size: 12px;
  line-height: 1.4;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.svc-bar__source {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent, #1677ff) 10%, transparent);
  color: var(--app-accent, #1677ff);
  font-size: 11px;
  flex-shrink: 0;
}

.svc-bar__service-link:hover {
  color: var(--app-accent, #1677ff);
}

.svc-bar__command,
.svc-bar__summary-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.svc-bar__command,
.svc-bar__summary-text,
.svc-bar__meta {
  color: var(--app-muted, #666);
  font-size: 11px;
}

.svc-bar__actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.svc-bar__icon-btn {
  padding: 0;
}

.svc-bar__icon-btn:disabled,
.fc-bar__tool-btn--loading {
  cursor: not-allowed;
  opacity: 0.5;
}

.svc-bar__status {
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-muted, #666) 12%, transparent);
  color: var(--app-muted, #666);
  font-size: 12px;
}

.svc-bar__status--ready {
  background: color-mix(in srgb, #52c41a 14%, transparent);
  color: #389e0d;
}

.svc-bar__status--starting {
  background: color-mix(in srgb, var(--app-accent, #1677ff) 14%, transparent);
  color: var(--app-accent, #1677ff);
}

.svc-bar__status--exited {
  background: color-mix(in srgb, var(--app-danger, #ff4d4f) 12%, transparent);
  color: #cf1322;
}

@media (max-width: 767px) {
  .svc-bar__toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .svc-bar__row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "service actions"
      "command actions"
      "summary actions";
    row-gap: 6px;
  }

  .svc-bar__status {
    display: none;
  }

  .svc-bar__service-link {
    grid-area: service;
  }

  .svc-bar__service {
    grid-area: service;
  }

  .svc-bar__command {
    grid-area: command;
  }

  .svc-bar__summary-text {
    grid-area: summary;
  }

  .svc-bar__actions {
    grid-area: actions;
    align-self: start;
  }
}

:root[data-theme="dark"] .svc-bar__service-link {
  color: #d9d9d9;
}

:root[data-theme="dark"] .svc-bar__service-link:hover {
  color: #69b1ff;
}
</style>
