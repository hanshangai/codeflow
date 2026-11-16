<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import {
  CheckCircleFilled,
  SyncOutlined,
  ClockCircleOutlined,
  UnorderedListOutlined,
  CaretDownOutlined,
  CaretUpOutlined,
} from "@ant-design/icons-vue";
import type { ThreadConversationState, TodolistRow } from "../chatTypes";

defineOptions({ name: "TodolistBar" });

type Props = {
  conversation: ThreadConversationState | null;
  mode?: "default" | "toolbar";
};

const props = withDefaults(defineProps<Props>(), {
  mode: "default",
});

const expanded = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const PANEL_SOURCE = "todolist";
const isToolbarMode = computed(() => props.mode === "toolbar");

const todolist = computed(() => props.conversation?.currentTodolist ?? null);
const isConversationRunning = computed(() => Boolean(props.conversation?.runningTurnId && props.conversation?.runningTurnStartedAt));

const summary = computed(() => {
  const t = todolist.value;
  if (!t) return "";
  const done = t.rows.filter((r) => r.statusColor === "green").length;
  if (!isConversationRunning.value && done < t.rows.length) return "已结束";
  return `${done}/${t.rows.length}`;
});

const currentStep = computed(() => {
  const t = todolist.value;
  if (!t || !isConversationRunning.value) return "";
  return t.rows.find((r) => r.statusColor === "blue")?.step ?? "";
});

/** 仅在当前 turn 仍运行时展示旋转中的任务行，避免历史计划快照误导为仍在执行。 */
function isRowInProgress(row: TodolistRow): boolean {
  return isConversationRunning.value && row.statusColor === "blue";
}

function toggleExpanded(): void {
  expanded.value = !expanded.value;
  if (expanded.value) {
    window.dispatchEvent(new CustomEvent("chat-floatbox:expand", { detail: { source: PANEL_SOURCE } }));
  }
}

function handleOtherExpand(event: Event): void {
  const source = (event as CustomEvent<{ source?: string }>).detail?.source;
  if (source !== PANEL_SOURCE) expanded.value = false;
}

function handleWindowPointerDown(event: PointerEvent): void {
  if (!expanded.value || !isToolbarMode.value) return;
  const root = rootEl.value;
  const target = event.target as Node | null;
  if (!root || !target) return;
  if (!root.contains(target)) expanded.value = false;
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
    v-if="todolist"
    ref="rootEl"
    class="todolist-bar-wrap"
    :class="{ 'todolist-bar-wrap--expanded': expanded, 'todolist-bar-wrap--toolbar': isToolbarMode }"
  >
    <button
      v-if="isToolbarMode"
      type="button"
      class="todolist-bar__chip"
      :aria-expanded="expanded"
      aria-label="切换任务"
      @click="toggleExpanded"
    >
      <UnorderedListOutlined class="todolist-bar__chip-icon" />
      <span class="todolist-bar__chip-progress">{{ summary }}</span>
      <span class="todolist-bar__chip-toggle"><CaretDownOutlined v-if="expanded" /><CaretUpOutlined v-else /></span>
    </button>
    <button v-if="expanded && !isToolbarMode" type="button" class="todolist-bar__backdrop" aria-label="关闭任务" @click="expanded = false" />
    <div
      v-if="!isToolbarMode || expanded"
      class="todolist-bar"
      :class="{ 'todolist-bar--expanded': expanded, 'todolist-bar--toolbar-popup': isToolbarMode }"
    >
      <div class="todolist-bar__header" @click="toggleExpanded">
        <UnorderedListOutlined class="todolist-bar__icon" />
        <span class="todolist-bar__title">任务</span>
        <span class="todolist-bar__current-step">{{ currentStep }}</span>
        <span class="todolist-bar__progress">{{ summary }}</span>
        <span class="todolist-bar__toggle"><CaretDownOutlined v-if="expanded" /><CaretUpOutlined v-else /></span>
      </div>

      <div v-if="expanded" class="todolist-bar__body">
        <div v-if="todolist.explanation" class="todolist-bar__explanation">{{ todolist.explanation }}</div>
        <div class="todolist-bar__rows">
          <div
            v-for="row in todolist.rows"
            :key="`${row.step}__${row.status}`"
            class="todolist-bar__row"
          >
            <CheckCircleFilled
              v-if="row.statusColor === 'green'"
              class="todolist-bar__row-icon todolist-bar__row-icon--done"
            />
            <SyncOutlined
              v-else-if="isRowInProgress(row)"
              class="todolist-bar__row-icon todolist-bar__row-icon--progress"
              :spin="true"
            />
            <ClockCircleOutlined
              v-else
              class="todolist-bar__row-icon todolist-bar__row-icon--pending"
            />
            <span
              class="todolist-bar__step"
              :class="{ 'todolist-bar__step--done': row.statusColor === 'green' }"
            >{{ row.step }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
