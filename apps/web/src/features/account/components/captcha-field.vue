<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { CaptchaChallengeResponseBody } from "@codeflowai/shared";
import { ReloadOutlined } from "@ant-design/icons-vue";

import { useAccountStore } from "../../../store/account";

defineOptions({ name: "CaptchaField" });

type TrackMetrics = {
  left: number;
  draggableWidth: number;
};

const THUMB_SIZE = 38;
const KEYBOARD_STEP = 6;

const props = defineProps<{
  modelValue: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "update:token", value: string): void;
}>();

const account = useAccountStore();
const challenge = ref<CaptchaChallengeResponseBody | null>(null);
const sliderTrackRef = ref<HTMLElement | null>(null);
const sliderValue = ref(0);
const loading = ref(false);
const verified = ref(false);
const dragging = ref(false);
const errorText = ref("");
const verifiedToken = ref("");
let resetTimer: ReturnType<typeof setTimeout> | null = null;
let activePointerId: number | null = null;
let dragMetrics: TrackMetrics | null = null;
let pendingClientX: number | null = null;
let sliderFrameId: number | null = null;

const maxLeft = computed(() => {
  if (!challenge.value) return 0;
  return Math.max(0, challenge.value.imageWidth - challenge.value.pieceSize);
});

const pieceOffsetPercent = computed(() => {
  if (!challenge.value || challenge.value.imageWidth <= 0) return 0;
  return (sliderValue.value / challenge.value.imageWidth) * 100;
});

const progressRatio = computed(() => {
  if (maxLeft.value <= 0) return 0;
  return Math.max(0, Math.min(1, sliderValue.value / maxLeft.value));
});

const pieceStyle = computed(() => {
  if (!challenge.value) return {};
  return {
    width: `${(challenge.value.pieceSize / challenge.value.imageWidth) * 100}%`,
    height: `${(challenge.value.pieceSize / challenge.value.imageHeight) * 100}%`,
    left: `${pieceOffsetPercent.value}%`,
    top: `${(challenge.value.pieceTop / challenge.value.imageHeight) * 100}%`,
  };
});

const visualStyle = computed(() => {
  if (!challenge.value) return {};
  return {
    aspectRatio: `${challenge.value.imageWidth} / ${challenge.value.imageHeight}`,
  };
});

const sliderStyle = computed(() => ({
  "--slider-ratio": progressRatio.value.toFixed(6),
}));

const statusText = computed(() => {
  if (loading.value) return "正在加载验证...";
  if (verified.value) return "验证通过";
  if (errorText.value) return errorText.value;
  return challenge.value ? "拖动滑块完成拼图" : "滑动验证加载失败";
});

const sliderText = computed(() => {
  if (verified.value) return "验证通过";
  if (errorText.value) return "松开后自动重试";
  return "按住滑块，拖动完成拼图";
});

const statusClass = computed(() => {
  if (verified.value) return "captcha-field__status--success";
  if (errorText.value) return "captcha-field__status--error";
  return "";
});

function clearResetTimer() {
  if (!resetTimer) return;
  clearTimeout(resetTimer);
  resetTimer = null;
}

/** Reset slider and token state so later submits never reuse stale captcha data. */
function clearVerificationState() {
  clearResetTimer();
  cancelPendingSliderFrame();
  dragging.value = false;
  errorText.value = "";
  verified.value = false;
  verifiedToken.value = "";
  activePointerId = null;
  dragMetrics = null;
  sliderValue.value = 0;
  emit("update:modelValue", "");
  emit("update:token", "");
}

/** Any slider movement invalidates the previous verified token immediately. */
function updateModelValue(nextValue: number) {
  sliderValue.value = nextValue;
  verifiedToken.value = "";
  emit("update:modelValue", String(nextValue));
  emit("update:token", "");
}

function captureTrackMetrics(): TrackMetrics | null {
  const track = sliderTrackRef.value;
  if (!track) return null;
  const rect = track.getBoundingClientRect();
  const draggableWidth = Math.max(0, rect.width - THUMB_SIZE);
  return { left: rect.left, draggableWidth };
}

function cancelPendingSliderFrame() {
  pendingClientX = null;
  if (sliderFrameId === null) return;
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(sliderFrameId);
  }
  sliderFrameId = null;
}

function queueSliderUpdate(clientX: number) {
  pendingClientX = clientX;
  if (sliderFrameId !== null) return;
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    const nextClientX = pendingClientX;
    pendingClientX = null;
    if (typeof nextClientX === "number") {
      updateSliderFromClientX(nextClientX);
    }
    return;
  }

  sliderFrameId = window.requestAnimationFrame(() => {
    sliderFrameId = null;
    const nextClientX = pendingClientX;
    pendingClientX = null;
    if (typeof nextClientX === "number") {
      updateSliderFromClientX(nextClientX);
    }
  });
}

function clampSliderValue(nextValue: number) {
  return Math.max(0, Math.min(maxLeft.value, Math.round(nextValue)));
}

function updateSliderFromClientX(clientX: number) {
  const metrics = dragMetrics ?? captureTrackMetrics();
  if (!metrics) return;

  const offset = Math.max(0, Math.min(metrics.draggableWidth, clientX - metrics.left - (THUMB_SIZE / 2)));
  const ratio = metrics.draggableWidth > 0 ? offset / metrics.draggableWidth : 0;
  updateModelValue(clampSliderValue(ratio * maxLeft.value));
}

async function resetChallenge() {
  loading.value = true;
  challenge.value = null;
  clearVerificationState();

  try {
    const result = await account.fetchCaptchaChallenge();
    if (!result.ok) {
      errorText.value = result.message || "加载滑动验证失败";
      return;
    }
    challenge.value = result;
  } finally {
    loading.value = false;
  }
}

function beginDrag(clientX: number) {
  if (!challenge.value || loading.value || verified.value) return;
  clearResetTimer();
  dragMetrics = captureTrackMetrics();
  dragging.value = true;
  errorText.value = "";
  queueSliderUpdate(clientX);
}

/** Emit a token only after local verification succeeds against the active challenge. */
function verifySliderPosition() {
  if (!challenge.value) return;
  const actualLeft = clampSliderValue(sliderValue.value);
  if (Math.abs(actualLeft - challenge.value.slotLeft) <= challenge.value.tolerance) {
    const token = `puzzle:${challenge.value.challengeId}:${actualLeft}`;
    verified.value = true;
    verifiedToken.value = token;
    errorText.value = "";
    emit("update:modelValue", String(actualLeft));
    emit("update:token", token);
    return;
  }

  errorText.value = "未对齐，请重试";
  verifiedToken.value = "";
  emit("update:token", "");
  resetTimer = setTimeout(() => {
    sliderValue.value = 0;
    emit("update:modelValue", "");
    resetTimer = null;
  }, 120);
}

function endDrag(clientX?: number) {
  if (!challenge.value || !dragging.value) return;
  cancelPendingSliderFrame();
  if (typeof clientX === "number") {
    updateSliderFromClientX(clientX);
  }
  dragging.value = false;
  dragMetrics = null;
  verifySliderPosition();
}

function handleTrackPointerDown(event: PointerEvent) {
  if (!challenge.value || loading.value || verified.value) return;
  if (!event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  activePointerId = event.pointerId;
  sliderTrackRef.value?.setPointerCapture(event.pointerId);
  beginDrag(event.clientX);
}

function handleTrackPointerMove(event: PointerEvent) {
  if (!dragging.value || activePointerId !== event.pointerId) return;
  queueSliderUpdate(event.clientX);
}

function handleTrackPointerUp(event: PointerEvent) {
  if (activePointerId !== event.pointerId) return;
  sliderTrackRef.value?.releasePointerCapture(event.pointerId);
  activePointerId = null;
  endDrag(event.clientX);
}

function handleTrackPointerCancel(event: PointerEvent) {
  if (activePointerId !== event.pointerId) return;
  sliderTrackRef.value?.releasePointerCapture(event.pointerId);
  activePointerId = null;
  cancelPendingSliderFrame();
  dragging.value = false;
  dragMetrics = null;
}

function handleTrackLostPointerCapture() {
  activePointerId = null;
  cancelPendingSliderFrame();
  dragging.value = false;
  dragMetrics = null;
}

function handleThumbKeydown(event: KeyboardEvent) {
  if (!challenge.value || loading.value || verified.value) return;

  const key = event.key;
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Enter", " "].includes(key)) {
    return;
  }

  event.preventDefault();
  clearResetTimer();
  errorText.value = "";

  if (key === "Enter" || key === " ") {
    verifySliderPosition();
    return;
  }

  if (key === "Home") {
    updateModelValue(0);
    return;
  }

  if (key === "End") {
    updateModelValue(maxLeft.value);
    return;
  }

  const delta = key === "ArrowLeft" || key === "ArrowDown" ? -KEYBOARD_STEP : KEYBOARD_STEP;
  updateModelValue(clampSliderValue(sliderValue.value + delta));
}

watch(
  () => props.modelValue,
  (value) => {
    if (String(value ?? "").trim()) return;
    if (!verified.value) return;
    verified.value = false;
    verifiedToken.value = "";
    sliderValue.value = 0;
    emit("update:token", "");
  },
);

/** Expose the latest verified token so the parent can read it right before submit. */
function getVerifiedToken() {
  return verifiedToken.value;
}

defineExpose({ resetChallenge, getVerifiedToken });

onMounted(() => {
  void resetChallenge();
});

onUnmounted(() => {
  clearResetTimer();
  cancelPendingSliderFrame();
});
</script>

<template>
  <div class="captcha-field">
    <div class="captcha-field__visual-shell">
      <div class="captcha-field__visual" :style="visualStyle">
        <img
          v-if="challenge"
          :src="challenge.backgroundImage"
          class="captcha-field__background"
          alt="滑动验证背景"
          draggable="false"
        />
        <img
          v-if="challenge"
          :src="challenge.pieceImage"
          class="captcha-field__piece"
          :class="{
            'captcha-field__piece--verified': verified,
            'captcha-field__piece--dragging': dragging,
          }"
          :style="pieceStyle"
          alt="滑动验证拼块"
          draggable="false"
        />
        <div v-if="loading || !challenge" class="captcha-field__overlay">
          {{ loading ? "加载滑动验证中..." : statusText }}
        </div>
      </div>
    </div>

    <div class="captcha-field__toolbar">
      <span class="captcha-field__status" :class="statusClass">{{ statusText }}</span>
      <a-button
        type="text"
        class="captcha-field__refresh"
        :loading="loading"
        aria-label="刷新滑动验证"
        @click="resetChallenge"
      >
        <template #icon>
          <ReloadOutlined />
        </template>
      </a-button>
    </div>

    <div
      ref="sliderTrackRef"
      class="captcha-field__slider"
      :class="{
        'captcha-field__slider--dragging': dragging,
        'captcha-field__slider--verified': verified,
      }"
      :style="sliderStyle"
      role="slider"
      tabindex="0"
      :aria-valuemin="0"
      :aria-valuemax="maxLeft"
      :aria-valuenow="sliderValue"
      aria-label="滑动完成验证"
      @pointerdown="handleTrackPointerDown"
      @pointermove="handleTrackPointerMove"
      @pointerup="handleTrackPointerUp"
      @pointercancel="handleTrackPointerCancel"
      @lostpointercapture="handleTrackLostPointerCapture"
      @keydown="handleThumbKeydown"
    >
      <div class="captcha-field__slider-fill" />
      <div class="captcha-field__slider-text">{{ sliderText }}</div>
      <div class="captcha-field__slider-thumb">
        <span class="captcha-field__slider-chevron" />
        <span class="captcha-field__slider-chevron" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.captcha-field {
  --captcha-shell-bg:
    radial-gradient(circle at 12% 18%, rgba(255, 255, 255, 0.9), transparent 34%),
    linear-gradient(180deg, rgba(255, 250, 243, 0.96), rgba(246, 239, 229, 0.92));
  --captcha-shell-border: rgba(229, 198, 168, 0.52);
  --captcha-shell-shadow: 0 18px 36px rgba(184, 117, 56, 0.14);
  --captcha-slider-bg: linear-gradient(180deg, #f8fafc, #eef3f8);
  --captcha-slider-fill-start: #1d4ed8;
  --captcha-slider-fill-end: #14b8a6;
  --captcha-slider-border: rgba(37, 99, 235, 0.18);
  --captcha-slider-text: #516070;
  --captcha-thumb-bg-start: #ffffff;
  --captcha-thumb-bg-end: #e8eef7;
  --captcha-thumb-border: rgba(30, 64, 175, 0.18);
  --captcha-thumb-chevron: #2563eb;
  display: grid;
  gap: 12px;
  width: min(100%, 398px);
  margin: 0 auto;
}

:root[data-theme="dark"] .captcha-field {
  --captcha-shell-border: rgba(255, 255, 255, 0.14);
  --captcha-shell-shadow: 0 18px 36px rgba(0, 0, 0, 0.28);
  --captcha-slider-bg: linear-gradient(180deg, #343431, #262624);
  --captcha-slider-border: rgba(255, 255, 255, 0.14);
  --captcha-slider-text: #d6d3cc;
  --captcha-thumb-bg-start: #4a4945;
  --captcha-thumb-bg-end: #30302e;
  --captcha-thumb-border: rgba(255, 255, 255, 0.18);
  --captcha-thumb-chevron: #f1b19a;
}

.captcha-field__visual-shell {
  width: 100%;
  margin: 0;
  padding: 0;
}

.captcha-field__visual {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 16%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-bg) 94%, #eef4fb);
  box-shadow:
    0 14px 30px rgba(15, 23, 42, 0.11),
    inset 0 1px 0 rgba(255, 255, 255, 0.58);
}

:root[data-theme="dark"] .captcha-field__visual {
  box-shadow:
    0 14px 30px rgba(0, 0, 0, 0.28),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.captcha-field__background,
.captcha-field__piece {
  position: absolute;
  display: block;
  user-select: none;
  -webkit-user-drag: none;
}

.captcha-field__background {
  inset: 0;
  width: 100%;
  height: 100%;
}

.captcha-field__piece {
  z-index: 1;
  pointer-events: none;
  will-change: left, filter;
  filter:
    drop-shadow(0 14px 24px rgba(15, 23, 42, 0.30))
    drop-shadow(0 0 2px rgba(255, 255, 255, 0.88));
  transition: left 0.1s ease-out, filter 0.16s ease-out;
  transform: translateZ(0);
}

.captcha-field__piece--dragging {
  transition: none;
}

.captcha-field__piece--verified {
  filter: drop-shadow(0 10px 18px rgba(34, 197, 94, 0.22));
}

.captcha-field__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  text-align: center;
  color: var(--app-muted);
  background: color-mix(in srgb, var(--app-panel-bg) 78%, rgba(255, 255, 255, 0.2));
  backdrop-filter: blur(6px);
}

.captcha-field__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 28px;
}

.captcha-field__status {
  min-width: 0;
  color: #526071;
  font-size: 13px;
  line-height: 1.5;
}

:root[data-theme="dark"] .captcha-field__status {
  color: #c7c3b9;
}

.captcha-field__status--success {
  color: #389e0d;
}

:root[data-theme="dark"] .captcha-field__status--success {
  color: #86efac;
}

.captcha-field__status--error {
  color: #cf1322;
}

:root[data-theme="dark"] .captcha-field__status--error {
  color: #fda4af;
}

.captcha-field__refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: #64748b;
  background: color-mix(in srgb, var(--app-panel-bg) 82%, #f1f5f9);
  border: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
}

:root[data-theme="dark"] .captcha-field__refresh {
  color: #c7c3b9;
  background: color-mix(in srgb, var(--app-panel-bg) 86%, #f1b19a 14%);
  border-color: rgba(255, 255, 255, 0.14);
}

.captcha-field__slider {
  --slider-thumb-size: 38px;
  position: relative;
  display: flex;
  align-items: center;
  height: 44px;
  padding: 3px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid var(--captcha-slider-border);
  background: var(--captcha-slider-bg);
  box-shadow:
    inset 0 1px 2px rgba(255, 255, 255, 0.72),
    inset 0 -1px 3px rgba(15, 23, 42, 0.08),
    0 8px 18px rgba(15, 23, 42, 0.07);
  cursor: pointer;
  user-select: none;
  touch-action: none;
  outline: none;
}

:root[data-theme="dark"] .captcha-field__slider {
  box-shadow:
    inset 0 1px 2px rgba(255, 255, 255, 0.08),
    inset 0 -1px 3px rgba(0, 0, 0, 0.24),
    0 8px 18px rgba(0, 0, 0, 0.22);
}

.captcha-field__slider:focus-visible {
  box-shadow:
    inset 0 1px 3px rgba(15, 23, 42, 0.08),
    0 0 0 3px color-mix(in srgb, var(--app-accent) 18%, transparent);
}

.captcha-field__slider--verified {
  border-color: rgba(22, 163, 74, 0.34);
}

.captcha-field__slider-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: calc(var(--slider-thumb-size) + ((100% - var(--slider-thumb-size)) * var(--slider-ratio)));
  border-radius: inherit;
  background: linear-gradient(90deg, var(--captcha-slider-fill-start), var(--captcha-slider-fill-end));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.24),
    0 0 22px rgba(20, 184, 166, 0.22);
  transition: width 0.1s ease-out, background 0.16s ease-out;
}

.captcha-field__slider--dragging .captcha-field__slider-fill {
  transition: none;
}

.captcha-field__slider-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-inline: 58px 18px;
  color: var(--captcha-slider-text);
  font-size: 13px;
  pointer-events: none;
}

.captcha-field__slider-thumb {
  position: absolute;
  inset-block-start: 50%;
  left: calc((var(--slider-thumb-size) / 2) + ((100% - var(--slider-thumb-size)) * var(--slider-ratio)));
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: var(--slider-thumb-size);
  height: var(--slider-thumb-size);
  border-radius: 10px;
  background: linear-gradient(180deg, var(--captcha-thumb-bg-start), var(--captcha-thumb-bg-end));
  border: 1px solid var(--captcha-thumb-border);
  box-shadow:
    0 8px 18px rgba(15, 23, 42, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.9);
  transform: translate(-50%, -50%);
  will-change: left;
  transition: left 0.1s ease-out, box-shadow 0.16s ease-out, transform 0.16s ease-out;
  pointer-events: none;
}

.captcha-field__slider--dragging .captcha-field__slider-thumb {
  transition: none;
  box-shadow:
    0 12px 24px rgba(15, 23, 42, 0.24),
    inset 0 1px 0 rgba(255, 255, 255, 0.95);
}

.captcha-field__slider--verified .captcha-field__slider-thumb {
  border-color: rgba(22, 163, 74, 0.28);
  background: linear-gradient(180deg, #ffffff, #eaf8ef);
}

:root[data-theme="dark"] .captcha-field__slider--verified .captcha-field__slider-thumb {
  border-color: rgba(134, 239, 172, 0.36);
  background: linear-gradient(180deg, #405945, #2d3f31);
}

.captcha-field__slider-chevron {
  width: 6px;
  height: 6px;
  border-top: 2px solid var(--captcha-thumb-chevron);
  border-right: 2px solid var(--captcha-thumb-chevron);
  transform: rotate(45deg);
}

@media (max-width: 640px) {
  .captcha-field__toolbar {
    gap: 8px;
  }

  .captcha-field__status,
  .captcha-field__slider-text {
    font-size: 12px;
  }

  .captcha-field__slider {
    height: 38px;
  }
}
</style>
