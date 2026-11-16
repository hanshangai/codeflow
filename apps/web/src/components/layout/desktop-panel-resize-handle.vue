<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

defineOptions({ name: "DesktopPanelResizeHandle" });

const props = withDefaults(defineProps<{
  value: number;
  min: number;
  max: number;
  ariaLabel?: string;
  side?: "left" | "right";
}>(), {
  ariaLabel: "调整左侧边栏宽度",
  side: "right",
});

const emit = defineEmits<{
  (event: "resize-start"): void;
  (event: "resize-preview", value: number): void;
  (event: "resize-commit", value: number): void;
  (event: "resize-cancel"): void;
}>();

const active = ref(false);
const moved = ref(false);
let pointerId: number | null = null;
let startX = 0;
let startValue = 0;
let latestValue = 0;

const normalizedValue = computed(() => clamp(props.value));
const resizeDirection = computed(() => props.side === "left" ? -1 : 1);

function clamp(value: number): number {
  return Math.round(Math.min(props.max, Math.max(props.min, value)));
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || active.value) return;
  pointerId = event.pointerId;
  startX = event.clientX;
  startValue = normalizedValue.value;
  latestValue = startValue;
  moved.value = false;
  active.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  emit("resize-start");
}

/** 根据分界线所在边缘，把指针位移换算为面板宽度。 */
function onPointerMove(event: PointerEvent): void {
  if (!active.value || event.pointerId !== pointerId) return;
  const nextValue = clamp(startValue + (event.clientX - startX) * resizeDirection.value);
  if (nextValue === latestValue) return;
  moved.value = true;
  latestValue = nextValue;
  emit("resize-preview", nextValue);
}

function finishPointer(commit: boolean): void {
  if (!active.value) return;
  active.value = false;
  pointerId = null;
  if (commit && moved.value) emit("resize-commit", clamp(latestValue));
  else emit("resize-cancel");
  moved.value = false;
}

function onPointerUp(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return;
  finishPointer(true);
}

function onPointerCancel(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return;
  finishPointer(false);
}

function onLostPointerCapture(): void {
  finishPointer(false);
}

/** 方向键沿分界线的移动方向调宽，Home/End 定位宽度上下限。 */
function onKeydown(event: KeyboardEvent): void {
  let nextValue: number | null = null;
  if (event.key === "ArrowLeft") nextValue = clamp(normalizedValue.value - 16 * resizeDirection.value);
  else if (event.key === "ArrowRight") nextValue = clamp(normalizedValue.value + 16 * resizeDirection.value);
  else if (event.key === "Home") nextValue = clamp(props.min);
  else if (event.key === "End") nextValue = clamp(props.max);
  if (nextValue === null) return;
  event.preventDefault();
  if (nextValue !== normalizedValue.value) emit("resize-commit", nextValue);
}

onBeforeUnmount(() => finishPointer(false));
</script>

<template>
  <div
    class="desktop-panel-resize-handle"
    data-testid="left-sidebar-resize-handle"
    :class="{ 'desktop-panel-resize-handle--active': active, 'desktop-panel-resize-handle--left': side === 'left' }"
    role="separator"
    aria-orientation="vertical"
    :aria-label="ariaLabel"
    :aria-valuetext="`${normalizedValue} 像素`"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="normalizedValue"
    tabindex="0"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @lostpointercapture="onLostPointerCapture"
    @keydown="onKeydown"
  />
</template>

<style scoped>
.desktop-panel-resize-handle {
  position: absolute;
  inset: 0 -4px 0 auto;
  width: 8px;
  z-index: 20;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}

.desktop-panel-resize-handle::after {
  content: "";
  position: absolute;
  inset: 0 3px;
  background: var(--app-divider);
  transition: background-color 150ms ease, opacity 150ms ease;
}

.desktop-panel-resize-handle--left {
  inset: 0 auto 0 -4px;
}

.desktop-panel-resize-handle:hover::after,
.desktop-panel-resize-handle:focus-visible::after,
.desktop-panel-resize-handle--active::after {
  background: var(--app-accent);
  opacity: 0.8;
}
</style>
