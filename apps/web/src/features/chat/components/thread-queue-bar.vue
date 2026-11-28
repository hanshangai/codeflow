<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { Modal } from "ant-design-vue";
import { CaretDownOutlined, CaretUpOutlined, DeleteOutlined, EyeOutlined, InboxOutlined, PauseCircleOutlined, PlayCircleOutlined } from "@ant-design/icons-vue";

import type { ThreadId, ThreadMessageQueueItem, ThreadQueuePauseReason, ThreadQueueSendOptions, WorkspaceId } from "@codeflowai/shared";
import { useApiContext } from "../../../composables/useApiContext";
import { useThreadQueueStore } from "../../../store/threadQueue";

defineOptions({ name: "ThreadQueueBar" });

type Props = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  disabled?: boolean;
  /** "toolbar" 模式渲染为一颗 chip + 浮层；"default" 渲染为内嵌面板 */
  mode?: "default" | "toolbar";
  expanded?: boolean;
};
type Emits = {
  (e: "expandedChange", value: boolean): void;
};
const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  mode: "default",
  expanded: false,
});
const emit = defineEmits<Emits>();

const { ctx } = useApiContext();
const queueStore = useThreadQueueStore();

const PANEL_SOURCE = "thread-queue";
const rootEl = ref<HTMLElement | null>(null);
const isToolbarMode = computed(() => props.mode === "toolbar");

/** 当前 thread 活跃项 + 暂停状态。从 store 派生 */
const items = computed(() => queueStore.itemsFor(props.threadId));
const pendingItems = computed(() => items.value.filter((item) => item.status === "pending"));
const hasSendingItem = computed(() => items.value.some((item) => item.status === "sending"));
const paused = computed(() => queueStore.pausedFor(props.threadId));
const pausedReason = computed(() => queueStore.pausedReasonFor(props.threadId));
const headerSummary = computed(() => {
  return paused.value ? `已暂停 · ${pendingItems.value.length} 项待投递` : `${pendingItems.value.length} 项待投递`;
});

const pausedReasonLabel = computed((): string => {
  const reason: ThreadQueuePauseReason | null = pausedReason.value;
  switch (reason) {
    case "user_pause": return "你暂停了队列";
    case "user_stop": return "发送已中止";
    case "turn_error": return "上一回合失败";
    case "send_failed": return "发送失败";
    case "session_invalidated": return "会话发送已暂停";
    case "rollback": return "已回滚到历史 turn";
    case "transient_cleanup": return "引擎短暂清理";
    default: return "已暂停";
  }
});
const pausedBannerText = computed(() => {
  if (!paused.value) return "";
  const prefix = `已暂停（${pausedReasonLabel.value}）。`;
  if (pendingItems.value.length > 0) return `${prefix}点击下方「继续投递」恢复。`;
  if (hasSendingItem.value) return `${prefix}当前投递尚未确认，暂无待投递项。`;
  return `${prefix}暂无待投递项。`;
});

function truncate(s: string, n: number): string {
  const text = String(s ?? "");
  if (text.length <= n) return text;
  return `${text.slice(0, n)}…`;
}

/** 计算 pending 项在可编辑队列里的位置；sending 项不参与排序。 */
function pendingIndexOf(item: ThreadMessageQueueItem): number {
  return pendingItems.value.findIndex((it) => it.id === item.id);
}

/** 队列项状态标签：只表达队列投递状态，不表达 AI 回合执行状态。 */
function itemStatusLabel(item: ThreadMessageQueueItem): string {
  if (item.status === "sending") return "投递中";
  return pendingIndexOf(item) === 0 ? "下一条" : "";
}

/** pending 项才允许上移，且只能在 pending 子队列内移动。 */
function canMoveItemUp(item: ThreadMessageQueueItem): boolean {
  return !props.disabled && item.status === "pending" && pendingIndexOf(item) > 0;
}

/** pending 项才允许下移，且只能在 pending 子队列内移动。 */
function canMoveItemDown(item: ThreadMessageQueueItem): boolean {
  const index = pendingIndexOf(item);
  return !props.disabled && item.status === "pending" && index >= 0 && index < pendingItems.value.length - 1;
}

/** 只有 pending 项允许用户删除；sending 必须等待运行态终态收尾。 */
function canRemoveItem(item: ThreadMessageQueueItem): boolean {
  return !props.disabled && item.status === "pending";
}

/** 入队时锁定的发送选项展示：仅显示有意义的字段，避免堆叠默认值。 */
function formatSendOptions(item: { sendOptions: Pick<ThreadQueueSendOptions, "model" | "effort" | "serviceTier"> }): string {
  const parts: string[] = [];
  if (item.sendOptions.model) parts.push(item.sendOptions.model);
  if (item.sendOptions.effort) parts.push(item.sendOptions.effort);
  if (item.sendOptions.serviceTier === "fast") parts.push("Fast");
  return parts.join(" · ");
}

/** 汇总附件数量与文件名，供详情区排查入队内容。 */
function formatAttachmentDetail(item: ThreadMessageQueueItem): string {
  const parts: string[] = [];
  if (item.images.length > 0) parts.push(`${item.images.length} 张图片`);
  if (item.files.length > 0) {
    const names = item.files.map((file) => file.displayName || file.name).filter(Boolean);
    parts.push(`${item.files.length} 个文件${names.length ? `：${names.join("、")}` : ""}`);
  }
  return parts.join("；");
}

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

/** toolbar 模式下点击队列与详情浮层外部时收起队列。 */
function handleWindowPointerDown(event: PointerEvent): void {
  if (!props.expanded || !isToolbarMode.value) return;
  const root = rootEl.value;
  const target = event.target as Node | null;
  if (!root || !target) return;
  if (root.contains(target) || isDetailPopupTarget(target)) return;
  emit("expandedChange", false);
}

/** 判断事件目标是否落在队列详情浮层内，保留选中文本和复制操作。 */
function isDetailPopupTarget(target: Node): boolean {
  const element = target instanceof Element ? target : target.parentElement;
  return Boolean(element?.closest(".tq-bar__detail-popover"));
}

/** 队列详情浮层挂到 body，避免队列面板卸载时破坏 Ant Popover 的 DOM 锚点。 */
function getDetailPopupContainer(): HTMLElement {
  return document.body;
}

onMounted(() => {
  window.addEventListener("chat-floatbox:expand", handleOtherExpand as EventListener);
  window.addEventListener("pointerdown", handleWindowPointerDown);
});
onBeforeUnmount(() => {
  window.removeEventListener("chat-floatbox:expand", handleOtherExpand as EventListener);
  window.removeEventListener("pointerdown", handleWindowPointerDown);
});

watch(() => [props.workspaceId, props.threadId] as const, () => {
  emit("expandedChange", false);
});

async function moveUp(itemId: string): Promise<void> {
  if (props.disabled) return;
  await queueStore.moveUp(ctx.value, props.workspaceId, props.threadId, itemId);
}
async function moveDown(itemId: string): Promise<void> {
  if (props.disabled) return;
  await queueStore.moveDown(ctx.value, props.workspaceId, props.threadId, itemId);
}
async function removeItem(itemId: string): Promise<void> {
  if (props.disabled) return;
  await queueStore.remove(ctx.value, props.workspaceId, props.threadId, itemId);
}
async function clearAll(): Promise<void> {
  if (props.disabled || pendingItems.value.length === 0) return;
  Modal.confirm({
    title: "清空待投递队列",
    content: `将清空当前 thread ${pendingItems.value.length} 个待投递项；投递中的项不会被删除。`,
    okText: "清空",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      await queueStore.clear(ctx.value, props.workspaceId, props.threadId);
    },
  });
}
async function resumeNext(): Promise<void> {
  if (props.disabled || pendingItems.value.length === 0) return;
  await queueStore.resume(ctx.value, props.workspaceId, props.threadId);
}
async function pauseNow(): Promise<void> {
  if (props.disabled) return;
  await queueStore.pause(ctx.value, props.workspaceId, props.threadId, "user_pause");
}
</script>

<template>
  <div
    ref="rootEl"
    class="fc-bar-wrap tq-bar-wrap"
    :class="{
      'fc-bar-wrap--expanded': props.expanded,
      'fc-bar-wrap--toolbar': isToolbarMode,
      'tq-bar-wrap--sending': hasSendingItem,
    }"
  >
    <button
      v-if="isToolbarMode"
      type="button"
      class="fc-bar__chip"
      :aria-expanded="props.expanded"
      aria-label="切换队列"
      @click="toggleExpanded"
    >
      <InboxOutlined class="fc-bar__chip-icon" />
      <span class="fc-bar__chip-count">{{ items.length }}</span>
      <span v-if="paused" class="tq-bar__chip-state">暂停</span>
      <span class="fc-bar__chip-toggle">
        <CaretDownOutlined v-if="props.expanded" />
        <CaretUpOutlined v-else />
      </span>
    </button>
    <button v-if="props.expanded && !isToolbarMode" type="button" class="fc-bar__backdrop" aria-label="关闭队列" @click="emit('expandedChange', false)" />
    <div
      v-if="!isToolbarMode || props.expanded"
      class="fc-bar tq-bar"
      :class="{ 'fc-bar--expanded': props.expanded, 'fc-bar--toolbar-popup': isToolbarMode }"
    >
      <div class="fc-bar__header" @click="toggleExpanded">
        <InboxOutlined class="fc-bar__icon" />
        <span class="fc-bar__title">队列</span>
        <span class="fc-bar__summary">{{ headerSummary }}</span>
        <span class="fc-bar__count">{{ items.length }}</span>
        <span class="fc-bar__toggle"><CaretDownOutlined v-if="props.expanded" /><CaretUpOutlined v-else /></span>
      </div>

      <template v-if="props.expanded">
        <div class="fc-bar__body tq-bar__body">
          <div v-if="paused" class="tq-bar__paused-banner">
            <PauseCircleOutlined class="tq-bar__paused-icon" />
            <span>{{ pausedBannerText }}</span>
          </div>

          <div v-if="items.length === 0" class="tq-bar__empty">队列为空。</div>

          <ul v-else class="tq-bar__list">
            <li
              v-for="(item, i) in items"
              :key="item.id"
              class="tq-bar__row"
              :class="{ 'tq-bar__row--sending': item.status === 'sending' }"
            >
              <span class="tq-bar__seq">{{ i + 1 }}</span>
              <div class="tq-bar__main">
                <span class="tq-bar__preview">{{ truncate(item.text, 100) || "（仅附件）" }}</span>
                <div v-if="itemStatusLabel(item) || item.images.length || item.files.length || formatSendOptions(item)" class="tq-bar__meta">
                  <span
                    v-if="itemStatusLabel(item)"
                    class="tq-bar__next"
                    :class="{ 'tq-bar__next--sending': item.status === 'sending' }"
                  >{{ itemStatusLabel(item) }}</span>
                  <span v-if="item.images.length || item.files.length" class="tq-bar__attach">
                    +{{ item.images.length + item.files.length }} 附件
                  </span>
                  <span v-if="formatSendOptions(item)" class="tq-bar__opts" :title="`入队时锁定：${formatSendOptions(item)}`">
                    {{ formatSendOptions(item) }}
                  </span>
                </div>
              </div>
              <span class="tq-bar__actions">
                <a-tooltip title="查看详情" placement="top">
                  <a-popover
                    trigger="click"
                    placement="leftTop"
                    overlay-class-name="tq-bar__detail-popover"
                    :get-popup-container="getDetailPopupContainer"
                  >
                    <template #title>队列详情</template>
                    <template #content>
                      <div class="tq-bar__detail-content">
                        <div class="tq-bar__detail-label">完整内容</div>
                        <div class="tq-bar__detail-text">{{ item.text || "（仅附件）" }}</div>
                        <div v-if="formatAttachmentDetail(item)" class="tq-bar__detail-line">
                          附件：{{ formatAttachmentDetail(item) }}
                        </div>
                        <div v-if="formatSendOptions(item)" class="tq-bar__detail-line">
                          入队选项：{{ formatSendOptions(item) }}
                        </div>
                      </div>
                    </template>
                    <button
                      type="button"
                      class="fc-table__action tq-bar__icon-btn"
                      aria-label="查看队列详情"
                      @click.stop
                    >
                      <EyeOutlined />
                    </button>
                  </a-popover>
                </a-tooltip>
                <a-tooltip title="上移">
                  <button
                    type="button"
                    class="fc-table__action tq-bar__icon-btn"
                    :class="{ 'fc-table__action--disabled': !canMoveItemUp(item) }"
                    :disabled="!canMoveItemUp(item)"
                    @click.stop="moveUp(item.id)"
                  >
                    <CaretUpOutlined />
                  </button>
                </a-tooltip>
                <a-tooltip title="下移">
                  <button
                    type="button"
                    class="fc-table__action tq-bar__icon-btn"
                    :class="{ 'fc-table__action--disabled': !canMoveItemDown(item) }"
                    :disabled="!canMoveItemDown(item)"
                    @click.stop="moveDown(item.id)"
                  >
                    <CaretDownOutlined />
                  </button>
                </a-tooltip>
                <a-tooltip title="删除">
                  <button
                    type="button"
                    class="fc-table__action fc-table__action--danger tq-bar__icon-btn"
                    :class="{ 'fc-table__action--disabled': !canRemoveItem(item) }"
                    :disabled="!canRemoveItem(item)"
                    @click.stop="removeItem(item.id)"
                  >
                    <DeleteOutlined />
                  </button>
                </a-tooltip>
              </span>
            </li>
          </ul>
        </div>

        <footer v-if="!paused || pendingItems.length > 0" class="fc-bar__toolbar tq-bar__toolbar">
          <span
            v-if="paused && pendingItems.length > 0"
            class="fc-bar__tool-btn tq-bar__tool-btn--primary"
            :class="{ 'fc-bar__tool-btn--disabled': props.disabled || pendingItems.length === 0 }"
            @click="!props.disabled && pendingItems.length > 0 && resumeNext()"
          >
            <PlayCircleOutlined />
            继续投递
          </span>
          <span
            v-else-if="!paused"
            class="fc-bar__tool-btn"
            :class="{ 'fc-bar__tool-btn--disabled': props.disabled || items.length === 0 }"
            @click="!props.disabled && items.length > 0 && pauseNow()"
          >
            <PauseCircleOutlined />
            暂停
          </span>
          <span
            v-if="pendingItems.length > 0"
            class="fc-bar__tool-btn fc-bar__tool-btn--danger"
            :class="{ 'fc-bar__tool-btn--disabled': props.disabled || pendingItems.length === 0 }"
            @click="!props.disabled && pendingItems.length > 0 && clearAll()"
          >
            <DeleteOutlined />
            清空待投递
          </span>
        </footer>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tq-bar.fc-bar--toolbar-popup {
  width: min(100%, 520px);
}

.tq-bar__chip-state {
  color: #d48806;
  font-size: 10px;
  font-weight: 700;
}

.tq-bar-wrap--sending .fc-bar__chip {
  animation: tq-sending-breathe 1.8s ease-in-out infinite;
}

.tq-bar__body {
  display: grid;
  gap: 8px;
  padding-bottom: 8px;
}

.tq-bar__paused-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 10px;
  background: color-mix(in srgb, #faad14 12%, transparent);
  color: #ad6800;
  font-size: 12px;
}

.tq-bar__paused-icon {
  color: #d48806;
}

.tq-bar__empty {
  text-align: center;
  color: var(--app-muted, #666);
  padding: 14px;
  font-size: 12px;
}

.tq-bar__list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}

.tq-bar__row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
}

.tq-bar__row--sending {
  margin: 0 -4px;
  padding: 7px 4px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-accent, #1677ff) 8%, transparent);
}

.tq-bar__row + .tq-bar__row {
  border-top: 1px solid color-mix(in srgb, var(--app-divider, #d9d9d9) 40%, transparent);
}

.tq-bar__row--sending + .tq-bar__row,
.tq-bar__row + .tq-bar__row--sending {
  border-top-color: transparent;
}

.tq-bar__seq {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  min-height: 22px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-muted, #666) 12%, transparent);
  color: var(--app-muted, #666);
  font-size: 11px;
  font-weight: 700;
}

.tq-bar__main {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.tq-bar__preview {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--app-text, #222);
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tq-bar__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--app-muted, #666);
  font-size: 11px;
  flex: 0 0 auto;
  flex-wrap: nowrap;
}

.tq-bar__next {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent, #1677ff) 10%, transparent);
  color: var(--app-accent, #1677ff);
  font-size: 11px;
  font-weight: 700;
}

.tq-bar__next--sending {
  background: color-mix(in srgb, var(--app-accent, #1677ff) 16%, transparent);
  color: color-mix(in srgb, var(--app-accent, #1677ff) 86%, #000 14%);
}

.tq-bar__attach {
  flex: 0 0 auto;
}

.tq-bar__opts {
  min-width: 0;
  max-width: 220px;
  font-family: var(--app-font-mono, var(--ant-font-family-code, monospace));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tq-bar__actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.tq-bar__icon-btn {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
}

.tq-bar__icon-btn:disabled {
  cursor: not-allowed;
}

.tq-bar__detail-content {
  display: grid;
  gap: 6px;
  max-width: min(420px, 72vw);
}

.tq-bar__detail-label {
  color: var(--app-muted, #666);
  font-size: 11px;
  font-weight: 700;
}

.tq-bar__detail-text {
  color: var(--app-text, #222);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tq-bar__detail-line {
  color: var(--app-muted, #666);
  font-size: 11px;
  overflow-wrap: anywhere;
}

:global(.tq-bar__detail-popover) {
  max-width: min(460px, 84vw);
}

.tq-bar__toolbar {
  justify-content: flex-end;
}

.tq-bar__tool-btn--primary {
  color: var(--app-accent, #1677ff);
}

.tq-bar__tool-btn--primary:hover {
  color: color-mix(in srgb, var(--app-accent, #1677ff) 78%, #000 22%);
}

@keyframes tq-sending-breathe {
  0%, 100% {
    border-color: color-mix(in srgb, var(--app-accent, #1677ff) 18%, var(--app-border, #d9d9d9) 82%);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--app-accent, #1677ff) 0%, transparent);
  }
  50% {
    border-color: color-mix(in srgb, var(--app-accent, #1677ff) 46%, var(--app-border, #d9d9d9) 54%);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--app-accent, #1677ff) 10%, transparent);
  }
}

@media (max-width: 767px) {
  .tq-bar.fc-bar--expanded {
    width: min(92vw, 440px);
  }

  .tq-bar__row {
    align-items: start;
  }

  .tq-bar__actions {
    flex-direction: column;
  }

  .tq-bar__opts {
    max-width: 100%;
  }
}
</style>
