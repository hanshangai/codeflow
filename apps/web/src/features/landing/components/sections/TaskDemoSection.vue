<script setup lang="ts">
import { ref } from "vue";
import { trackProductEvent } from "../../../../analytics/analytics";
import ProductScreenshot from "../ProductScreenshot.vue";

const steps = [
  { label: "01 明确规格", title: "先把需求、约束和验收标准写清楚", description: "例如为现有列表增加导出功能：把目标、项目规范、验收标准与代码上下文放进规格，明确范围后再开始。", image: "workbench", alt: "CodeFlow 规格与项目工作区" },
  { label: "02 按工作流开发", title: "用内置或自定义工作流推进开发与验证", description: "选择 Harness、Loop 或 TDD 等工作流，按任务切换模型；开发、验证与确认在同一工作台衔接。", image: "models", alt: "CodeFlow 工作流与模型选择" },
  { label: "03 度量与回看", title: "用度量、差异与记录确认结果", description: "检查文件变更、Git 状态、终端输出与任务度量，确认结果符合规格，再提交或继续调整。", image: "changes", alt: "CodeFlow 文件差异与执行记录" },
];
const selected = ref(0);

/** 手动切换静态功能演示，只记录交互，不发起模型或任务请求。 */
function selectStep(index: number): void {
  selected.value = index;
  trackProductEvent("homepage_demo_step", { source: "homepage", action: `step_${index + 1}` });
}
</script>

<template>
  <section id="demo" class="demo">
    <header class="section-head"><span class="eyebrow">从一个真实需求开始</span><h2>从想法到改动，放在一个工作台里</h2><p>少切换工具，把注意力留给问题本身。</p></header>
    <div class="demo__controls" role="group" aria-label="选择功能演示步骤">
      <button v-for="(step, index) in steps" :key="step.label" type="button" :aria-pressed="selected === index"
        aria-controls="demo-panel" @click="selectStep(index)">{{ step.label }}</button>
    </div>
    <div id="demo-panel" class="demo__panel" aria-live="polite">
      <div class="demo__copy"><span class="eyebrow">{{ steps[selected]!.label }}</span><h3>{{ steps[selected]!.title }}</h3><p>{{ steps[selected]!.description }}</p></div>
      <ProductScreenshot :key="selected" :src="`/images/landing/efficiency-${steps[selected]!.image}.png`" :alt="steps[selected]!.alt" />
    </div>
  </section>
</template>

<style scoped>
.demo__controls { display: flex; gap: 10px; justify-content: center; margin: 30px 0; }
.demo__controls button { padding: 13px 22px; background: transparent; color: var(--landing-muted); border: 1px solid var(--landing-border); border-radius: 10px; cursor: pointer; font: inherit; font-size: 14px; }
.demo__controls button[aria-pressed="true"] { background: var(--landing-accent-wash); color: var(--app-accent); border-color: var(--app-accent); }
.demo__panel { display: grid; grid-template-columns: minmax(0, .65fr) minmax(0, 1.35fr); align-items: center; gap: 40px; padding: 34px; border-radius: 20px; background: var(--landing-panel-solid); border: 1px solid var(--landing-border); }
.demo__copy h3 { margin: 14px 0; font-size: 25px; line-height: 1.45; }
.demo__copy p { min-height: 100px; color: var(--landing-muted); font-size: 14px; line-height: 1.9; }
@media (max-width: 1000px) { .demo__panel { gap: 24px; padding: 25px; } .demo__copy h3 { font-size: 21px; } }
</style>
