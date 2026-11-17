<script setup lang="ts">
import { Code2, KeyRound, ShieldCheck } from "lucide-vue-next";
import { SOURCE_REPOSITORY_URL } from "../../landingLinks";

defineOptions({ name: "SecuritySection" });

const items = [
  { icon: Code2, title: "代码透明，可审查", desc: "桌面版源码开放，实现与变更可查看；具体授权范围以源码仓库许可证为准。" },
  { icon: KeyRound, title: "数据边界，清楚可见", desc: "本地工作区与私有 Key 沿现有方式保存使用。模型请求会向选定服务发送必要上下文，远程操作经授权链路传输。" },
  { icon: ShieldCheck, title: "操作权限，由你掌握", desc: "文件、终端与流程动作遵循访问权限和确认机制，改动与执行记录可检查。" },
];
</script>

<template>
  <section class="security panel">
    <header class="security__head">
      <span class="eyebrow">放心开始，也能看清背后如何运行</span>
      <h2 class="security__title">系统开源，安全可控</h2>
      <p class="security__sub">代码透明可审查，本地执行与权限可控。</p>
    </header>
    <div class="security__grid">
      <article v-for="i in items" :key="i.title" class="security__item">
        <span class="security__icon">
          <component :is="i.icon" :size="28" />
        </span>
        <div class="security__copy">
          <h3>{{ i.title }}</h3>
          <p>{{ i.desc }}</p>
        </div>
      </article>
    </div>
    <div class="security__links"><a :href="SOURCE_REPOSITORY_URL" target="_blank" rel="noopener noreferrer">查看源码 ↗</a><RouterLink to="/data-security-commitment">了解数据安全 →</RouterLink></div>
  </section>
</template>

<style scoped>
.security { display: grid; gap: 24px; }
.security__head { display: grid; justify-items: center; text-align: center; gap: 8px; }
.security__title { margin: 0; font-size: clamp(22px, 2.4vw, 32px); letter-spacing: -0.03em; color: var(--landing-text, #1a140d); }
.security__sub { margin: 0; font-size: 14.5px; color: var(--landing-muted, rgba(23, 21, 17, 0.66)); }

.security__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.security__links { display: flex; justify-content: center; gap: 28px; font-size: 13px; }
.security__links a { color: var(--app-accent); }
.security__item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 16px;
  border-radius: 18px;
  border: 1px solid var(--landing-border-soft, rgba(89, 69, 46, 0.08));
  background: var(--landing-panel-solid, #fff);
}
.security__icon {
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  border: 1.5px solid var(--landing-border-soft, rgba(89, 69, 46, 0.1));
  color: var(--app-accent, #c96442);
  background: var(--landing-surface-soft, linear-gradient(135deg, #f7f2ec 0%, #faf6f0 100%));
}
.security__copy h3 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 800;
  color: var(--landing-text, #1a140d);
}
.security__copy p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--landing-muted, rgba(23, 21, 17, 0.66));
}

@media (max-width: 1100px) {
  .security__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .security__grid { grid-template-columns: 1fr; }
}
</style>
