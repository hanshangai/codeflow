<script setup lang="ts">
import { ArrowDownToLine, ArrowRight } from "lucide-vue-next";
import ProductScreenshot from "../ProductScreenshot.vue";

defineOptions({ name: "HeroSection" });

const emit = defineEmits<{
  (e: "primary"): void;
}>();

/** 首页内滚动到功能演示区块，不写入 URL hash。 */
function scrollToDemo(): void {
  document.querySelector(".productivity")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
</script>

<template>
  <section class="hero">
    <div class="hero__copy">
      <p class="hero__eyebrow">企业级AI协作研发平台</p>
      <h1 class="hero__title">把研发规范变成可执行的工作流</h1>
      <p class="hero__highlight">规格先行，工作流执行。<br />内置 Harness、Loop 与 TDD。</p>
      <p class="hero__desc">从需求与规格出发，选择合适的模型和内置/自定义工作流推进开发；用度量、会话、文件、终端与 Git 记录每一次执行，结果可核对、过程可回看。</p>
      <div class="hero__cta"><a-button type="primary" size="large" @click="emit('primary')"><ArrowDownToLine :size="18" />下载桌面版</a-button><a href="#" @click.prevent="scrollToDemo">查看功能演示 <ArrowRight :size="16" /></a></div>
      <p class="hero__trust">系统开源，安全可控 · 内置模型 Token 流量享折扣</p>
    </div>
    <div class="hero__visual">
      <ProductScreenshot eager src="/images/landing/desktop-workbench.png" alt="CodeFlow 当前研发工作台：会话、项目文件与任务操作" />
    </div>
  </section>
</template>

<style scoped>
.hero {
  display: grid;
  grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr);
  gap: 32px;
  align-items: center;
  padding: 0 0 36px;
}
.hero__copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.hero__eyebrow {
  margin: 0 0 14px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--app-accent, #c96442);
}
.hero__title {
  margin: 0 0 16px;
  font-size: clamp(30px, 3.2vw, 42px);
  line-height: 1.24;
  letter-spacing: -0.02em;
  font-weight: 700;
  color: var(--landing-text, #1a140d);
  text-wrap: balance;
  word-break: normal;
}
.hero__trust { margin: 16px 0 0; font-size: 12px; color: var(--landing-muted); }
.hero__cta { align-items: center; }
.hero__cta > a { display: inline-flex; align-items: center; gap: 8px; color: var(--landing-text); font-size: 14px; }
.hero__cta :deep(.ant-btn) { display: inline-flex; align-items: center; gap: 8px; }
.hero__highlight {
  margin: 0 0 18px;
  font-size: clamp(17px, 1.7vw, 20px);
  font-weight: 700;
  line-height: 1.5;
  color: var(--app-accent, #c96442);
}
.hero__desc {
  margin: 0 0 22px;
  max-width: 52ch;
  font-size: clamp(14px, 1.2vw, 16px);
  line-height: 1.9;
  color: var(--landing-muted, rgba(23, 21, 17, 0.7));
}
.hero__cta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0;
}
.hero__visual {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  min-width: 0;
}

@media (max-width: 1100px) {
  .hero { gap: 28px; padding: 0 0 30px; }
}
@media (max-width: 720px) {
  .hero { padding: 0 12px 12px; }
}
</style>
