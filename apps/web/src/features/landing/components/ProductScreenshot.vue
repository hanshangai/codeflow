<script setup lang="ts">
import { ref } from "vue";

defineProps<{ src: string; alt: string; eager?: boolean; portrait?: boolean }>();
const failed = ref(false);

/** 图片失败明确展示错误并记录素材路径，不用旧图掩盖素材问题。 */
function handleError(event: Event): void {
  failed.value = true;
  console.error("[LANDING_IMAGE_LOAD_FAILED]", {
    errorCode: "LANDING_IMAGE_LOAD_FAILED", requestId: `landing-image-${Date.now()}`,
    asset: (event.target as HTMLImageElement).getAttribute("src"), rootCause: "Product screenshot could not be loaded",
  });
}
</script>

<template>
  <figure class="product-shot" :class="{ 'product-shot--portrait': portrait }">
    <a v-if="!failed" :href="src" target="_blank" rel="noopener noreferrer" :aria-label="`${alt}，打开原图`">
      <img :src="src" :alt="alt" :loading="eager ? 'eager' : 'lazy'" :fetchpriority="eager ? 'high' : 'auto'"
        :width="portrait ? 390 : 1440" :height="portrait ? 844 : 900" decoding="async" @error="handleError" />
    </a>
    <div v-else class="product-shot__error" role="status">图片加载失败，请刷新页面重试。</div>
    <figcaption>桌面端演示界面 · 非实时执行<span v-if="!failed"> · 点击查看原图</span></figcaption>
  </figure>
</template>

<style scoped>
.product-shot { margin: 0; min-width: 0; }
.product-shot a { display: block; overflow: hidden; border: 1px solid var(--landing-border); border-radius: 16px; background: var(--app-panel-bg); box-shadow: var(--landing-shadow-window); }
.product-shot img { display: block; width: 100%; height: auto; }
.product-shot figcaption { margin-top: 10px; color: var(--landing-muted); font-size: 11px; text-align: center; }
.product-shot--portrait { width: 230px; max-width: 100%; margin-inline: auto; }
.product-shot--portrait a { border-radius: 25px; }
.product-shot__error { display: grid; place-items: center; min-height: 240px; padding: 20px; border: 1px solid var(--landing-border); border-radius: 16px; color: var(--app-danger); }
</style>
