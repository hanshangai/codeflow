<script setup lang="ts">
import { computed } from "vue";
import { ArrowUpRight } from "lucide-vue-next";
import { useRoute, useRouter } from "vue-router";
import { useConfigStore } from "../../../store/config";
import { useUiStore } from "../../../store/ui";
import { useDesktopDownloadEntry } from "../../desktop/desktopDownloadEntry";
import { SOURCE_REPOSITORY_URL } from "../landingLinks";

defineOptions({ name: "LandingNav" });

const emit = defineEmits<{
  (e: "open-settings"): void;
  (e: "enter-app"): void;
}>();

const router = useRouter();
const route = useRoute();
const config = useConfigStore();
const ui = useUiStore();
const { download } = useDesktopDownloadEntry("landing_nav");

const hasAccountSession = computed(() => config.authMode === "account" && config.hasActiveSession);
/** Web 是辅助入口，账号状态只影响文案，登录流程由应用壳处理。 */
const primaryActionLabel = computed(() => hasAccountSession.value ? "Web 工作台" : "Web 登录");
const isHome = computed(() => ui.mainView === "landing");
/** 公开内容页沿既有路由高亮，文章详情也归属最佳实践入口。 */
const isBestPractices = computed(() => route.path === "/best-practices" || route.path.startsWith("/best-practices/"));
const isUpgrade = computed(() => route.path === "/upgrade");
const isDownload = computed(() => route.path === "/download");

/** 首页导航用真实锚点；其他公开页保留返回对应首页区块的入口。 */
const navLinks = [
  { label: "产品能力", anchor: "features" },
];
</script>

<template>
  <nav class="landing-nav">
    <div class="landing-nav__inner">
      <button class="landing-nav__brand" type="button" @click="router.push('/')">
        <img src="/favicon.svg" alt="" class="landing-nav__logo" />
        <span class="landing-nav__brand-copy">
          <strong>CodeFlow</strong>
          <small>规格约束的开发工作流</small>
        </span>
      </button>

      <div class="landing-nav__links">
        <a
          v-for="link in navLinks"
          :key="link.label"
          class="landing-nav__link"
          :href="`${isHome ? '' : '/'}#${link.anchor}`"
        >
          {{ link.label }}
        </a>
        <RouterLink to="/best-practices" class="landing-nav__link" :class="{ 'landing-nav__link--active': isBestPractices }">最佳实践</RouterLink>
        <RouterLink to="/upgrade" class="landing-nav__link" :class="{ 'landing-nav__link--active': isUpgrade }">更新日志</RouterLink>
        <RouterLink to="/download" class="landing-nav__link" :class="{ 'landing-nav__link--active': isDownload }">软件下载</RouterLink>
        <a :href="SOURCE_REPOSITORY_URL" target="_blank" rel="noopener noreferrer" class="landing-nav__link">
          GitHub 开源
          <ArrowUpRight :size="14" aria-hidden="true" />
        </a>
      </div>

      <div class="landing-nav__actions">
        <a-button type="link" @click="emit('enter-app')">{{ primaryActionLabel }}</a-button>
        <a
          class="landing-nav__action landing-nav__action--primary"
          href="/download"
          @click.prevent="download"
        >
          下载桌面版
        </a>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.landing-nav {
  position: sticky;
  top: 0;
  z-index: 120;
  padding: 14px 0 0;
  background: var(--landing-nav-bg, linear-gradient(180deg, rgba(252, 251, 247, 0.88), rgba(252, 251, 247, 0.52) 72%, transparent));
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.landing-nav__inner {
  /* 中等屏宽下若链接 + 操作按钮挤不下，允许自然换行兜底，避免横向溢出 */
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  width: min(1180px, calc(100% - 48px));
  min-height: 70px;
  margin: 0 auto;
  padding: 10px 18px;
  border-radius: 24px;
  border: 1px solid var(--landing-border, rgba(123, 104, 78, 0.12));
  background: var(--landing-panel, rgba(255, 255, 255, 0.76));
  box-shadow: var(--landing-shadow-soft, 0 18px 48px rgba(46, 33, 16, 0.08));
}

.landing-nav__brand {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--landing-text, #1f1a16);
}

.landing-nav__logo {
  display: block;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
}

.landing-nav__brand-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
}

.landing-nav__brand-copy strong {
  font-size: 15px;
  line-height: 1;
}

.landing-nav__brand-copy small {
  font-size: 11px;
  color: var(--landing-muted-soft, rgba(31, 26, 22, 0.56));
  line-height: 1.2;
}

.landing-nav__links {
  /* 链接按钮自身也允许换行，进一步避免单条链接被压缩或溢出 */
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: 10px;
}

.landing-nav__link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-decoration: none;
  min-height: 38px;
  padding: 0 14px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--landing-muted, rgba(31, 26, 22, 0.64));
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease;
}

.landing-nav__link:hover,
.landing-nav__link--active {
  background: var(--landing-accent-wash, rgba(209, 121, 52, 0.12));
  color: var(--landing-warning, #8c5620);
}

.landing-nav__actions {
  display: flex;
  align-items: center;
  margin-left: auto;
  gap: 10px;
}

.landing-nav__action {
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 42px;
  padding: 0 16px;
  border-radius: 12px;
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease,
    background 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease;
}

.landing-nav__action:hover {
  transform: translateY(-1px);
}

/* Primary: 温暖橙渐变（与 .btn--primary 同款，亮一档） */
.landing-nav__action--primary {
  background: linear-gradient(135deg, #e8886a 0%, #d97757 50%, #b85a3b 100%);
  color: #fff;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.25) inset,
    0 6px 12px rgba(217, 119, 87, 0.22),
    0 12px 24px rgba(217, 119, 87, 0.16);
}
.landing-nav__action--primary:hover {
  background: linear-gradient(135deg, #ee9176 0%, #df8062 50%, #c2633e 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.3) inset,
    0 10px 20px rgba(217, 119, 87, 0.28),
    0 18px 36px rgba(217, 119, 87, 0.18);
}


@media (max-width: 767px) {
  .landing-nav {
    display: none;
  }
}
</style>
