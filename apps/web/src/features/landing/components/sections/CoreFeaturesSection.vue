<script setup lang="ts">
import { BarChart3, Blocks, Cpu, FileText, GitBranch, Workflow } from "lucide-vue-next";

const features = [
  { icon: FileText, title: "可视化规格管理", description: "需求、约束、验收标准与代码上下文放在同一处，持续维护可执行规格。", href: "#specs" },
  { icon: Workflow, title: "内置工作流", description: "Harness、Loop 与 TDD 开箱即用，复杂任务按节点、角色与确认点推进。", href: "#workflow" },
  { icon: BarChart3, title: "研发度量体系", description: "从会话、任务与执行记录汇总效率、成本与交付观察。" },
  { icon: Cpu, title: "多模型一键切换", description: "Claude Code 与 Codex 按任务切换模型，平衡能力、速度与成本。", href: "#models" },
  { icon: Blocks, title: "可视化自定义", description: "在画布中编排工作流、Agent、Skill 与 MCP，把团队方法沉淀为资产。", href: "#custom" },
  { icon: GitBranch, title: "研发操作一体", description: "会话、文件、终端与 Git 在同一工作台衔接，改动与验证可追踪。", href: "#changes" },
];
</script>

<template>
  <section class="features" aria-label="六项核心能力">
    <component
      :is="feature.href ? 'a' : 'div'"
      v-for="feature in features"
      :key="feature.title"
      :href="feature.href || undefined"
      class="feature"
    >
      <component :is="feature.icon" :size="23" aria-hidden="true" />
      <h2>{{ feature.title }}</h2><p>{{ feature.description }}</p>
    </component>
  </section>
</template>

<style scoped>
.features { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-block: 1px solid var(--landing-border); }
.feature { display: block; padding: 30px 24px; color: var(--landing-text); text-decoration: none; border-bottom: 1px solid var(--landing-border); }
.feature:nth-child(n+4) { border-bottom: 0; }
.feature svg { color: var(--app-accent); margin-bottom: 15px; }
.feature h2 { margin: 0 0 9px; font-size: 17px; font-weight: 650; }
.feature p { margin: 0; color: var(--landing-muted); font-size: 13px; line-height: 1.8; }
.feature:hover { background: var(--landing-accent-wash); }
@media (max-width: 1000px) { .feature { padding: 25px 14px; } .feature h2 { font-size: 15px; } }
</style>
