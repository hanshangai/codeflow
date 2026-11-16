<script setup lang="ts">
// 营销首页右下角悬浮：展示微信群 / 公众号二维码缩略图，鼠标悬停时弹出大图
import { computed, ref, watch } from "vue";

import { useApiContext } from "../../../composables/useApiContext";
import {
  createDefaultSiteContactInfo,
  fetchPublicSiteContactInfo,
  getCachedPublicSiteContactInfo,
} from "../../../composables/siteContactInfo";

defineOptions({ name: "LandingFloatingQr" });

const { ctx } = useApiContext();
const contactInfo = ref(getCachedPublicSiteContactInfo() ?? createDefaultSiteContactInfo());

const items = computed(() =>
  [
    {
      key: "wechat",
      label: "微信群",
      caption: "扫码加入微信群",
      src: contactInfo.value.wechatGroupQrImage,
    },
    {
      key: "official",
      label: "公众号",
      caption: "扫码关注公众号",
      src: contactInfo.value.officialAccountQrImage,
    },
  ].filter((item) => Boolean(item.src)),
);

watch(
  () => ctx.value.serverWsOrigin,
  () => {
    void (async () => {
      contactInfo.value = await fetchPublicSiteContactInfo(ctx.value);
    })();
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="items.length" class="floating-qr" aria-label="联系方式二维码">
    <div v-for="item in items" :key="item.key" class="floating-qr__item">
      <div class="floating-qr__thumb">
        <img :src="item.src" :alt="`${item.label}二维码`" class="floating-qr__thumb-image" />
        <span class="floating-qr__thumb-label">{{ item.label }}</span>
      </div>
      <div class="floating-qr__popover" role="tooltip">
        <img :src="item.src" :alt="`${item.label}二维码大图`" class="floating-qr__popover-image" />
        <p class="floating-qr__popover-caption">{{ item.caption }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.floating-qr {
  position: fixed;
  right: 20px;
  bottom: 24px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 12px;
  pointer-events: none;
}

.floating-qr__item {
  position: relative;
  pointer-events: auto;
}

.floating-qr__thumb {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 140px;
  padding: 11px 11px 9px;
  border-radius: 16px;
  border: 1px solid var(--landing-accent-border, rgba(205, 145, 56, 0.24));
  background: var(--landing-panel, rgba(255, 253, 248, 0.96));
  box-shadow: var(--landing-shadow-card, 0 10px 24px rgba(46, 33, 16, 0.14));
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.floating-qr__item:hover .floating-qr__thumb {
  transform: translateY(-2px);
  box-shadow: var(--landing-shadow-raised, 0 14px 30px rgba(46, 33, 16, 0.2));
}

.floating-qr__thumb-image {
  width: 119px;
  height: 119px;
  object-fit: contain;
  border-radius: 10px;
  background: #fff;
}

.floating-qr__thumb-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--landing-muted-strong, rgba(31, 26, 22, 0.82));
  letter-spacing: 0.04em;
}

.floating-qr__popover {
  position: absolute;
  bottom: 0;
  right: calc(100% + 12px);
  transform: scale(0.96);
  transform-origin: right bottom;
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: 13px;
  border-radius: 18px;
  border: 1px solid var(--landing-accent-border, rgba(205, 145, 56, 0.24));
  background: var(--landing-panel-solid, rgba(255, 253, 248, 0.98));
  box-shadow: var(--landing-shadow-raised, 0 22px 48px rgba(46, 33, 16, 0.22));
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.18s ease, transform 0.18s ease, visibility 0.18s ease;
}

.floating-qr__item:hover .floating-qr__popover,
.floating-qr__item:focus-within .floating-qr__popover {
  opacity: 1;
  visibility: visible;
  transform: scale(1);
}

.floating-qr__popover-image {
  width: 198px;
  height: 198px;
  object-fit: contain;
  border-radius: 12px;
  background: #fff;
  box-shadow: var(--landing-shadow-card, 0 14px 30px rgba(46, 33, 16, 0.12));
}

.floating-qr__popover-caption {
  margin: 0;
  font-size: 13px;
  color: var(--landing-muted, rgba(31, 26, 22, 0.7));
  line-height: 1.5;
}

@media (max-width: 767px) {
  .floating-qr {
    display: none;
  }
}
</style>
