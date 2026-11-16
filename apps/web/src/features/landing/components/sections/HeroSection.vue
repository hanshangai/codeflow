<script setup lang="ts">
import { ArrowDownToLine, ArrowRight } from "lucide-vue-next";
import ProductScreenshot from "../ProductScreenshot.vue";

defineOptions({ name: "HeroSection" });

const emit = defineEmits<{
  (e: "primary"): void;
}>();
</script>

<template>
  <section class="hero">
    <div class="hero__copy">
      <span class="eyebrow">规格约束的软件开发工作流平台</span>
      <h1 class="hero__title"><span>CodeFlow · </span>把研发规范变成可执行的工作流</h1>
      <p class="hero__highlight">规格先行，工作流执行。<br />内置 Harness、Loop 与 TDD。</p>
      <p class="hero__desc">从需求与规格出发，选择合适的模型和内置/自定义工作流推进开发；用度量、会话、文件、终端与 Git 记录每一次执行，结果可核对、过程可回看。</p>
      <div class="hero__cta"><a-button type="primary" size="large" @click="emit('primary')"><ArrowDownToLine :size="18" />下载桌面版</a-button><a href="#demo">查看功能演示 <ArrowRight :size="16" /></a></div>
      <p class="hero__trust">系统开源，安全可控 · 内置模型 Token 流量享折扣</p>
    </div>
    <div class="hero__visual">
      <ProductScreenshot eager src="/images/landing/efficiency-workbench.png" alt="CodeFlow 当前研发工作台：会话、项目文件与任务操作" />
    </div>
  </section>
</template>

<style scoped>
.hero {
  display: grid;
  grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr);
  gap: 44px;
  align-items: center;
  padding: 75px 0 50px;
}
.hero__copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.hero__title {
  margin: 18px 0 22px;
  font-size: clamp(34px, 3.6vw, 49px);
  line-height: 1.24;
  letter-spacing: -0.02em;
  font-weight: 700;
  color: var(--landing-text, #1a140d);
  text-wrap: balance;
  word-break: normal;
}
.hero__title span { display: block; font-size: 19px; margin-bottom: 14px; font-weight: 500; letter-spacing: 0; }
.hero__trust { margin: 24px 0 0; font-size: 12px; color: var(--landing-muted); }
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
  margin: 0 0 32px;
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
  .hero { gap: 28px; padding: 45px 0 30px; }
}
@media (max-width: 720px) {
  .hero { padding: 24px 12px 12px; }
}
</style>
