<script setup lang="ts">
// 电脑官网：研发效率展示与桌面下载；手机沿既有路由进入 H5。
import { onActivated } from "vue";
import { SOURCE_REPOSITORY_URL } from "../landingLinks";
import { useDesktopDownloadEntry } from "../../desktop/desktopDownloadEntry";
import LandingNav from "./LandingNav.vue";
import LandingRecords from "./LandingRecords.vue";
import LandingFloatingQr from "./LandingFloatingQr.vue";
import HeroSection from "./sections/HeroSection.vue";
import CoreFeaturesSection from "./sections/CoreFeaturesSection.vue";
import TaskDemoSection from "./sections/TaskDemoSection.vue";
import ProductivitySection from "./sections/ProductivitySection.vue";
import CostSection from "./sections/CostSection.vue";
import SecuritySection from "./sections/SecuritySection.vue";

defineOptions({ name: "LandingPage" });

const emit = defineEmits<{
  (e: "open-settings"): void;
  (e: "enter-app"): void;
}>();

const { download } = useDesktopDownloadEntry("homepage");

/** 官网主操作按用户系统直达对应安装包；未提供的平台进入下载页说明。 */
function handlePrimary() {
  void download();
}

/** 缓存页重新激活时恢复首页锚点位置。 */
function activateLanding(): void {
  const hash = window.location.hash.slice(1);
  if (hash) document.getElementById(hash)?.scrollIntoView();
}
onActivated(activateLanding);
</script>

<template>
  <div class="landing">
    <LandingNav @open-settings="emit('open-settings')" @enter-app="emit('enter-app')" />

    <section class="landing__section landing__section--hero">
      <HeroSection @primary="handlePrimary" />
    </section>

    <div class="landing__section landing__section--features">
      <CoreFeaturesSection />
    </div>

    <div class="landing__section">
      <TaskDemoSection />
    </div>

    <div class="landing__section">
      <ProductivitySection />
    </div>

    <div class="landing__section">
      <CostSection />
    </div>

    <div class="landing__section">
      <SecuritySection />
    </div>

    <footer class="landing__footer"><strong>CodeFlow · 规格约束的软件开发工作流平台</strong><div><RouterLink to="/best-practices">最佳实践</RouterLink><RouterLink to="/upgrade">更新日志</RouterLink><RouterLink to="/data-security-commitment">数据安全</RouterLink><RouterLink to="/contact">联系我们</RouterLink><a :href="SOURCE_REPOSITORY_URL" target="_blank" rel="noopener noreferrer">查看源码</a></div></footer>
    <LandingRecords />

    <LandingFloatingQr />
  </div>
</template>

<style scoped>
.landing__footer { width: min(1180px, calc(100% - 48px)); margin: 70px auto 0; padding-block: 30px; border-top: 1px solid var(--landing-border); display: flex; align-items: center; justify-content: space-between; gap: 20px; font-size: 13px; }
.landing__footer div { display: flex; flex-wrap: wrap; gap: 18px; }
.landing__footer a { color: var(--landing-muted); }
:deep([id]) { scroll-margin-top: 120px; }
:deep(.section-head) { text-align: center; }
:deep(.section-head h2) { margin: 12px 0; font-size: clamp(26px, 3vw, 36px); letter-spacing: -.035em; line-height: 1.5; }
:deep(.section-head p) { margin: 0; font-size: 15px; color: var(--landing-muted); }
:deep(.eyebrow) { color: var(--app-accent); font-size: 12px; font-weight: 600; letter-spacing: .06em; }

.landing {
  --landing-bg: var(--app-bg, #faf9f5);
  --landing-panel: color-mix(in srgb, var(--app-panel-bg, #fff) 82%, transparent);
  --landing-panel-solid: var(--app-panel-bg, #fff);
  --landing-surface: color-mix(in srgb, var(--app-panel-bg, #fff) 78%, var(--app-bg, #faf9f5));
  --landing-surface-soft: linear-gradient(135deg, color-mix(in srgb, var(--app-panel-bg, #fff) 72%, var(--app-bg, #faf9f5)) 0%, color-mix(in srgb, var(--app-panel-bg, #fff) 92%, var(--app-bg, #faf9f5)) 100%);
  --landing-accent-wash: color-mix(in srgb, var(--app-accent, #c96442) 12%, transparent);
  --landing-nav-bg: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #faf9f5) 88%, transparent), color-mix(in srgb, var(--app-bg, #faf9f5) 52%, transparent) 72%, transparent);
  --landing-border: var(--app-border, rgba(89, 69, 46, 0.12));
  --landing-border-soft: color-mix(in srgb, var(--app-border, rgba(89, 69, 46, 0.08)) 80%, transparent);
  --landing-card-border: color-mix(in srgb, var(--app-border, rgba(0, 0, 0, 0.05)) 72%, transparent);
  --landing-accent-border: color-mix(in srgb, var(--app-accent, #c96442) 36%, transparent);
  --landing-text: var(--app-text, #1a140d);
  --landing-muted: var(--app-muted, rgba(23, 21, 17, 0.66));
  --landing-muted-soft: color-mix(in srgb, var(--app-muted, #5e5d59) 76%, transparent);
  --landing-warning: color-mix(in srgb, var(--app-accent, #c96442) 72%, var(--app-text, #141413));
  --landing-shadow-soft: 0 12px 36px color-mix(in srgb, #000 10%, transparent);
  --landing-shadow-card: 0 6px 16px color-mix(in srgb, #000 8%, transparent);
  --landing-shadow-raised: 0 22px 48px color-mix(in srgb, #000 14%, transparent);
  --landing-shadow-window: 0 0 0 1px color-mix(in srgb, #000 8%, transparent), 0 4px 12px color-mix(in srgb, #000 8%, transparent), 0 16px 32px color-mix(in srgb, #000 10%, transparent);
  width: 100%;
  flex: 0 0 auto;
  min-height: 100vh;
  overflow-x: clip;
  overflow-y: visible;
  background: var(--landing-bg);
  color: var(--landing-text, var(--app-text, #171511));
}

.landing__section {
  width: min(1180px, calc(100% - 48px));
  margin: 0 auto;
  padding-top: 90px;
}
.landing__section--hero { padding-top: 12px; }
.landing__section--features { padding-top: 30px; }

/* 子组件复用的工具类（按规范保留在父级） */
:deep(.panel) {
  position: relative;
  border: 1px solid var(--landing-border);
  border-radius: 32px;
  background: var(--landing-panel);
  box-shadow: var(--landing-shadow-soft);
  padding: 36px 36px;
}
:deep(.btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 46px;
  padding: 0 22px;
  border-radius: 14px;
  border: 1px solid transparent;
  font-size: 14px;
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
:deep(.btn:hover) { transform: translateY(-2px); }

/* 主 CTA：温暖橙渐变（亮一档），与暖白背景协调，不再"沉重深橙" */
:deep(.btn--primary) {
  background: linear-gradient(135deg, #e8886a 0%, #d97757 50%, #b85a3b 100%);
  color: #fff;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.25) inset,
    0 8px 16px rgba(217, 119, 87, 0.22),
    0 16px 32px rgba(217, 119, 87, 0.16);
}
:deep(.btn--primary:hover) {
  background: linear-gradient(135deg, #ee9176 0%, #df8062 50%, #c2633e 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.3) inset,
    0 12px 24px rgba(217, 119, 87, 0.3),
    0 24px 48px rgba(217, 119, 87, 0.2);
}

/* 次 CTA：白底橙边橙字，与主按钮同色系呼应 */
:deep(.btn--ghost) {
  background: var(--landing-panel-solid, #fff);
  border-color: var(--landing-accent-border, rgba(201, 100, 66, 0.28));
  color: var(--app-accent, #c96442);
  box-shadow: var(--landing-shadow-card, 0 4px 10px rgba(40, 28, 16, 0.04));
}
:deep(.btn--ghost:hover) {
  background: var(--landing-accent-wash, rgba(255, 245, 235, 0.7));
  border-color: var(--app-accent, #c96442);
  box-shadow: var(--landing-shadow-card, 0 8px 16px rgba(40, 28, 16, 0.06));
}

:deep(.btn--lg) { min-height: 54px; padding: 0 28px; font-size: 15px; }

@media (max-width: 1100px) {
  :deep(.panel) { padding: 28px 24px; }
}
@media (max-width: 720px) {
  .landing__section { width: min(100%, calc(100% - 28px)); }
  .landing__section--hero { padding-top: 0; }
  :deep(.panel) { padding: 22px 18px; border-radius: 24px; }
}
</style>
