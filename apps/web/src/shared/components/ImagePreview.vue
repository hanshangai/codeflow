<script setup lang="ts">
import { ref, watch, onUnmounted } from "vue";
import { CloseOutlined } from "@ant-design/icons-vue";

defineOptions({ name: "ImagePreview" });

const props = defineProps<{ src: string; visible: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const imgRef = ref<HTMLImageElement | null>(null);

const scale = ref(1);
const tx = ref(0);
const ty = ref(0);

let startDist = 0;
let startScale = 1;
let panStartX = 0;
let panStartY = 0;
let startTx = 0;
let startTy = 0;
let isPanning = false;

function getDistance(t1: Touch, t2: Touch): number {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function onTouchStart(e: TouchEvent) {
  if (e.touches.length === 2) {
    e.preventDefault();
    startDist = getDistance(e.touches[0], e.touches[1]);
    startScale = scale.value;
    isPanning = false;
  } else if (e.touches.length === 1 && scale.value > 1) {
    isPanning = true;
    panStartX = e.touches[0].clientX;
    panStartY = e.touches[0].clientY;
    startTx = tx.value;
    startTy = ty.value;
  }
}

function onTouchMove(e: TouchEvent) {
  if (e.touches.length === 2) {
    e.preventDefault();
    const dist = getDistance(e.touches[0], e.touches[1]);
    const ratio = dist / startDist;
    scale.value = Math.min(Math.max(startScale * ratio, 1), 5);
    if (scale.value <= 1) {
      tx.value = 0;
      ty.value = 0;
    }
  } else if (e.touches.length === 1 && isPanning && scale.value > 1) {
    e.preventDefault();
    tx.value = startTx + (e.touches[0].clientX - panStartX);
    ty.value = startTy + (e.touches[0].clientY - panStartY);
  }
}

function onTouchEnd(e: TouchEvent) {
  if (e.touches.length < 2) isPanning = false;
  if (scale.value <= 1) {
    tx.value = 0;
    ty.value = 0;
  }
}

function onTap() {
  if (scale.value > 1) return;
  close();
}

function close() {
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
  emit("close");
}

watch(() => props.visible, (visible) => {
  if (!visible) {
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
  }
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

watch(() => props.visible, (visible) => {
  if (visible) document.addEventListener("keydown", onKeydown);
  else document.removeEventListener("keydown", onKeydown);
}, { immediate: true });

onUnmounted(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition name="imgpv-fade">
      <div v-if="visible" class="imgpv" @click.self="onTap">
        <button class="imgpv__close" aria-label="关闭" @click="close">
          <CloseOutlined />
        </button>
        <img
          ref="imgRef"
          :src="src"
          class="imgpv__img"
          :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
          draggable="false"
          @touchstart="onTouchStart"
          @touchmove="onTouchMove"
          @touchend="onTouchEnd"
          @click.stop="onTap"
        />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.imgpv {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
}

.imgpv__close {
  position: absolute;
  top: max(12px, env(safe-area-inset-top, 12px));
  right: 12px;
  z-index: 1;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.imgpv__img {
  max-width: 95vw;
  max-height: 90vh;
  object-fit: contain;
  transform-origin: center center;
  will-change: transform;
  user-select: none;
  -webkit-user-drag: none;
}

.imgpv-fade-enter-active,
.imgpv-fade-leave-active {
  transition: opacity 200ms ease;
}

.imgpv-fade-enter-from,
.imgpv-fade-leave-to {
  opacity: 0;
}
</style>
