<script setup lang="ts">
import { Clock3, FolderOpen, Puzzle, Users } from "lucide-vue-next";
import ProductScreenshot from "../ProductScreenshot.vue";

const scenes = [
  { id: "specs", label: "可视化规格管理", title: "需求、约束和验收标准，写进可执行的规格", description: "把需求目标、项目规范、验收标准和现有代码上下文放在同一份规格里。变更保留来源，任务执行时按规格约束，完成后可回看依据。", image: "knowledge", alt: "CodeFlow 规格与项目知识管理界面", detail: "规格不是一次性文档，而是随研发推进持续维护的约束。" },
  { id: "workflow", label: "开箱即用工作流", title: "Harness、Loop 与 TDD，按任务直接开始", description: "选用内置工作流，或在画布中调整节点、角色、模型与确认点；简单改动直接会话，复杂任务按流程推进。", image: "workflow", alt: "CodeFlow 内置与自定义工作流画布", detail: "需要几步，就推进几步；关键结果，由你确认。" },
  { id: "changes", label: "文件 · Git · 终端", title: "改了什么、执行了什么，放在一起检查", description: "把文件差异、Git 状态、终端与任务记录放回研发上下文。看清改动和验证结果，继续调整或提交都更有依据。", image: "changes", alt: "CodeFlow 文件改动与差异视图", detail: "AI 执行之后，你仍然掌握下一步。" },
  { id: "models", label: "多模型与自定义能力", title: "一键切换模型，自由编排 Agent、Skill 与 MCP", description: "在 Claude Code、Codex 与已接入模型间切换；在可视化界面配置工作流、角色、Skill 和 MCP 工具，把团队方法沉淀为资产。", image: "models", alt: "CodeFlow 模型切换与 Agent 配置界面", detail: "跨引擎沿新建会话规则使用，模型可用性取决于接入渠道。" },
];
const extras = [
  { icon: FolderOpen, title: "多工作区", description: "在不同项目之间切换，让任务留在各自的上下文。" },
  { icon: Puzzle, title: "Skill 与 MCP", description: "复用技能与工具，把常用能力接进工作台。" },
  { icon: Clock3, title: "定时任务", description: "按时间安排任务，在设备满足运行条件时执行。" },
  { icon: Users, title: "团队共享", description: "共享工作区与研发资产，按权限协作。" },
];
</script>

<template>
  <section class="productivity" aria-label="研发效率场景">
    <article v-for="(scene, index) in scenes" :key="scene.id" class="scene" :class="{ 'scene--reverse': index % 2 === 1 }">
      <div class="scene__copy"><span class="eyebrow">{{ scene.label }}</span><h2>{{ scene.title }}</h2><p>{{ scene.description }}</p><p class="scene__detail">{{ scene.detail }}</p></div>
      <ProductScreenshot :src="`/images/landing/desktop-${scene.image}.png`" :alt="scene.alt" />
    </article>
    <article class="scene scene--remote">
      <div class="scene__devices"><ProductScreenshot src="/images/landing/desktop-workbench.png" alt="电脑上的 CodeFlow 研发工作台" /><ProductScreenshot portrait src="/images/landing/efficiency-mobile.png" alt="手机 H5 会话工作台" /></div>
      <div class="scene__copy"><span class="eyebrow">移动远程操作</span><h2>电脑负责执行，手机随时跟进</h2><p>通过手机 H5 发起任务、查看进度和结果，处理允许的确认或继续补充要求。离开电脑，也能持续推进研发。</p><p class="scene__detail">执行电脑需保持在线，完成账号关联，并拥有相应工作区权限。</p><RouterLink to="/chat">进入 H5 工作台 →</RouterLink></div>
    </article>
    <div class="extras"><article v-for="extra in extras" :key="extra.title"><component :is="extra.icon" :size="22" aria-hidden="true" /><h3>{{ extra.title }}</h3><p>{{ extra.description }}</p></article></div>
  </section>
</template>

<style scoped>
.productivity { display: grid; gap: 58px; }
.scene { display: grid; grid-template-columns: minmax(0, .85fr) minmax(0, 1.15fr); gap: 36px; align-items: center; }
.scene--reverse { grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); }
.scene--reverse .scene__copy { order: 2; }
.scene__copy h2 { margin: 10px 0 14px; color: var(--landing-text); font-size: clamp(24px, 2.45vw, 32px); line-height: 1.5; letter-spacing: -.035em; }
.scene__copy p { color: var(--landing-muted); font-size: 14px; line-height: 1.8; }
.scene__copy .scene__detail { margin-top: 14px; font-size: 12px; padding-left: 13px; border-left: 2px solid var(--app-accent); }
.scene__copy a { color: var(--app-accent); font-size: 13px; }
.scene--remote { grid-template-columns: minmax(0, 1.2fr) minmax(0, .8fr); }
.scene__devices { position: relative; min-width: 0; padding: 25px 70px 35px 0; }
.scene__devices :deep(.product-shot--portrait) { position: absolute; right: 0; bottom: 0; width: 135px; }
.scene__devices :deep(figcaption) { display: none; }
.extras { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-block: 1px solid var(--landing-border); padding-block: 26px; gap: 24px; }
.extras svg { color: var(--app-accent); }
.extras h3 { margin: 14px 0 8px; font-size: 16px; }
.extras p { margin: 0; color: var(--landing-muted); font-size: 13px; line-height: 1.8; }
@media (max-width: 1000px) { .scene { gap: 28px; } .extras { gap: 18px; } }
</style>
