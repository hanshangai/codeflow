<script setup lang="ts">
import { computed } from "vue";

import type { RequirementAnalysisDisplayItem } from "../../prepareConversationItems";

defineOptions({ name: "RequirementAnalysisItem" });

const props = defineProps<{
  item: RequirementAnalysisDisplayItem;
}>();

const phaseLabel = computed(() => {
  switch (props.item.payload.phase) {
    case "clarify":
      return "待补充";
    case "recommend":
      return "待确认";
    case "confirm":
      return "已收敛";
    case "done":
      return "已完成";
    case "split":
      return "已拆分";
    default:
      return "进行中";
  }
});

const statusTone = computed(() => {
  if (props.item.payload.needUserInput) return "warning";
  if (props.item.payload.nextAction?.type === "ready-to-create") return "success";
  return "info";
});

const statusLabel = computed(() => {
  if (props.item.payload.needUserInput) return "等待补充";
  if (props.item.payload.nextAction?.type === "ready-to-create") return "可创建";
  return "已更新";
});

const summaryLabel = computed(() => {
  if (props.item.payload.nextAction?.type === "ready-to-create" && !props.item.payload.needUserInput) {
    return "AI 已按默认假设补齐待澄清项";
  }
  return "需求分析助手";
});

const candidateTitles = computed(() =>
  (props.item.payload.candidates ?? [])
    .map((candidate) => {
      const title = String(candidate.title ?? "").trim();
      if (!title) return "";
      const deliverySlice = String(candidate.phasingAssessment?.deliverySlice ?? "").trim();
      if (deliverySlice === "phase-1") return `一期 · ${title}`;
      if (deliverySlice === "follow-up") return `后续 · ${title}`;
      return title;
    })
    .filter(Boolean),
);

const assumptionLines = computed(() => {
  const first = props.item.payload.candidates?.[0];
  return (first?.assumptions ?? []).filter((item) => String(item ?? "").trim()).slice(0, 4);
});

const questionLines = computed(() =>
  (props.item.payload.questions ?? [])
    .map((question) => String(question.question ?? "").trim())
    .filter(Boolean)
    .slice(0, 3),
);
</script>

<template>
  <article class="ra-card" :class="`ra-card--${statusTone}`">
    <div class="ra-card__head">
      <div class="ra-card__title-wrap">
        <strong>{{ summaryLabel }}</strong>
        <span class="ra-card__phase">{{ phaseLabel }}</span>
      </div>
      <span class="ra-card__status" :class="`ra-card__status--${statusTone}`">{{ statusLabel }}</span>
    </div>

    <p v-if="item.payload.assistantReply" class="ra-card__reply">{{ item.payload.assistantReply }}</p>
    <p v-else-if="item.payload.conversationSummary" class="ra-card__reply">{{ item.payload.conversationSummary }}</p>

    <div v-if="candidateTitles.length" class="ra-card__section">
      <span class="ra-card__label">当前候选</span>
      <div class="ra-card__chips">
        <span v-for="title in candidateTitles" :key="title" class="ra-card__chip">{{ title }}</span>
      </div>
    </div>

    <div v-if="questionLines.length" class="ra-card__section">
      <span class="ra-card__label">仍待确认</span>
      <ul class="ra-card__list">
        <li v-for="line in questionLines" :key="line">{{ line }}</li>
      </ul>
    </div>

    <div v-else-if="assumptionLines.length" class="ra-card__section">
      <span class="ra-card__label">本轮自动补齐</span>
      <ul class="ra-card__list">
        <li v-for="line in assumptionLines" :key="line">{{ line }}</li>
      </ul>
    </div>
  </article>
</template>

<style scoped>
.ra-card {
  display: grid;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid var(--app-border, #d9d9d9);
  background: color-mix(in srgb, var(--app-bg, #fff) 95%, transparent);
}

.ra-card--success {
  border-color: color-mix(in srgb, #52c41a 24%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #f6ffed 68%, var(--app-bg, #fff));
}

.ra-card--warning {
  border-color: color-mix(in srgb, #faad14 24%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #fff7e6 74%, var(--app-bg, #fff));
}

.ra-card--info {
  border-color: color-mix(in srgb, #1677ff 18%, var(--app-border, #d9d9d9));
}

.ra-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.ra-card__title-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ra-card__phase {
  font-size: 12px;
  color: var(--app-muted, #667085);
}

.ra-card__status {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.ra-card__status--success {
  background: color-mix(in srgb, #52c41a 12%, transparent);
  color: #237804;
}

.ra-card__status--warning {
  background: color-mix(in srgb, #faad14 14%, transparent);
  color: #ad6800;
}

.ra-card__status--info {
  background: color-mix(in srgb, #1677ff 10%, transparent);
  color: #0958d9;
}

.ra-card__reply {
  margin: 0;
  line-height: 1.7;
  color: var(--app-text, #1f2937);
}

.ra-card__section {
  display: grid;
  gap: 8px;
}

.ra-card__label {
  font-size: 12px;
  color: var(--app-muted, #667085);
}

.ra-card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ra-card__chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent, #1677ff) 12%, transparent);
  color: var(--app-text, #1f2937);
  font-size: 12px;
}

.ra-card__list {
  margin: 0;
  padding-left: 18px;
  color: var(--app-text, #1f2937);
  line-height: 1.7;
}

:root[data-theme="dark"] .ra-card {
  border-color: color-mix(in srgb, var(--app-border, #374151) 84%, #475569);
  background: color-mix(in srgb, var(--app-panel-bg, #1f2937) 94%, #0f172a);
}

:root[data-theme="dark"] .ra-card--success {
  border-color: color-mix(in srgb, #22c55e 34%, var(--app-border, #374151));
  background: color-mix(in srgb, #14532d 24%, var(--app-panel-bg, #1f2937));
}

:root[data-theme="dark"] .ra-card--warning {
  border-color: color-mix(in srgb, #f59e0b 38%, var(--app-border, #374151));
  background: color-mix(in srgb, #7c2d12 24%, var(--app-panel-bg, #1f2937));
}

:root[data-theme="dark"] .ra-card--info {
  border-color: color-mix(in srgb, #3b82f6 34%, var(--app-border, #374151));
  background: color-mix(in srgb, #1e3a8a 18%, var(--app-panel-bg, #1f2937));
}

:root[data-theme="dark"] .ra-card__status--success {
  background: color-mix(in srgb, #22c55e 22%, transparent);
  color: #86efac;
}

:root[data-theme="dark"] .ra-card__status--warning {
  background: color-mix(in srgb, #f59e0b 24%, transparent);
  color: #fcd34d;
}

:root[data-theme="dark"] .ra-card__status--info {
  background: color-mix(in srgb, #3b82f6 24%, transparent);
  color: #93c5fd;
}

:root[data-theme="dark"] .ra-card__chip {
  background: color-mix(in srgb, var(--app-accent, #1677ff) 20%, var(--app-panel-bg, #1f2937));
  color: var(--app-text, #e5e7eb);
}
</style>
