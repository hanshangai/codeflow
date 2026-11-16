<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";

// 多根组件不会自动继承外部 class，显式透传到缩略图容器上，调用方才改得动它的间距。
defineOptions({ inheritAttrs: false });

/**
 * 消息图片缩略图 + 全屏预览。
 * 从 message-item 抽出，供消息气泡与「用户消息浮窗」共用同一套渲染与灯箱行为。
 */
defineProps<{
  /** 图片源列表：data URL 或 http(s) 链接；为空时不渲染。 */
  images?: string[];
  /** 无障碍替代文本前缀，消息里按角色传 user / assistant。 */
  altPrefix?: string;
}>();

const lightboxOpen = ref(false);
const lightboxSrc = ref<string | null>(null);
const imageLightboxKeydownOptions = { capture: true } as const;

/** 只渲染可信的图片源，其余降级为文本，避免把任意字符串塞进 img。 */
function isRenderableImage(src: string): boolean {
  const s = String(src ?? "").trim();
  if (!s) return false;
  if (s.startsWith("data:image/")) return true;
  if (s.startsWith("http://") || s.startsWith("https://")) return true;
  return false;
}

function openImageLightbox(src: string): void {
  lightboxSrc.value = src;
  lightboxOpen.value = true;
}

/** 关闭图片预览并清理当前图片地址。 */
function closeImageLightbox(): void {
  lightboxOpen.value = false;
  lightboxSrc.value = null;
}

/** 图片预览打开时支持 Esc 关闭，并阻止穿透到下层弹框。 */
function onImageLightboxKeydown(event: KeyboardEvent): void {
  if (!lightboxOpen.value || event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closeImageLightbox();
}

watch(lightboxOpen, (open) => {
  if (typeof document === "undefined") return;
  if (open) {
    document.addEventListener("keydown", onImageLightboxKeydown, imageLightboxKeydownOptions);
    return;
  }
  document.removeEventListener("keydown", onImageLightboxKeydown, imageLightboxKeydownOptions);
});

onBeforeUnmount(() => {
  if (typeof document === "undefined") return;
  document.removeEventListener("keydown", onImageLightboxKeydown, imageLightboxKeydownOptions);
});
</script>

<template>
  <div v-if="images?.length" class="msg__images" v-bind="$attrs">
    <template v-for="src in images" :key="src">
      <button v-if="isRenderableImage(src)" type="button" class="msg__image-link" @click="openImageLightbox(src)">
        <img :src="src" class="msg__image-thumb" :alt="`${altPrefix ?? 'message'} image`" loading="lazy" />
      </button>
      <div v-else class="msg__image">{{ src }}</div>
    </template>
  </div>

  <!-- 传送到 body：浮窗用了 backdrop-filter，会把 position: fixed 的包含块锁在浮窗内部，
       导致灯箱只占浮窗范围。挂到 body 后与消息里的预览保持同一全屏效果。 -->
  <Teleport to="body">
    <div v-if="lightboxOpen && lightboxSrc" class="msg__lightbox" @click.self="closeImageLightbox">
      <div class="msg__lightbox-content">
        <button type="button" class="msg__lightbox-close" @click="closeImageLightbox">×</button>
        <img :src="lightboxSrc" alt="image preview" class="msg__lightbox-img" />
      </div>
    </div>
  </Teleport>
</template>
