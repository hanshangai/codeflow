<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { ClockCircleOutlined, DownOutlined, RightOutlined, SyncOutlined } from "@ant-design/icons-vue";
import type { RequirementCandidateDraft } from "@codeflowai/shared";
import {
  buildClarificationDraftFingerprint,
  createClarificationDraftAnswer,
  createClarificationDraftAnswers,
  type ClarificationItemInput,
} from "../clarificationDraftState";

defineOptions({ name: "RequirementClarificationPanel" });

type ClarificationCandidate = Pick<
  RequirementCandidateDraft,
  "id" | "title" | "clarificationItems"
> & {
  recommendedApproach?: string | null;
  phasingAssessment?: RequirementCandidateDraft["phasingAssessment"] | null;
  sizeAssessment?: RequirementCandidateDraft["sizeAssessment"] | null;
};

const props = withDefaults(defineProps<{
  candidate: ClarificationCandidate;
  compact?: boolean;
  disabled?: boolean;
  sending?: boolean;
  staged?: boolean;
}>(), {
  compact: false,
  disabled: false,
  sending: false,
  staged: false,
});

const emit = defineEmits<{
  (event: "submit", payload: { candidateId: string; title: string; text: string; clarificationCount: number }): void;
}>();

const resolvedRecommendedApproach = computed(() => String(props.candidate.recommendedApproach ?? "").trim());
const resolvedPhasingAssessment = computed<RequirementCandidateDraft["phasingAssessment"]>(() => {
  const raw = props.candidate.phasingAssessment;
  return {
    model: raw?.model === "mmf-phase-gate-v2" ? "mmf-phase-gate-v2" : "legacy-mmf-fallback-v1",
    scopeDecision: raw?.scopeDecision === "needs-split" ? "needs-split" : "fit",
    deliverySlice: raw?.deliverySlice === "phase-1" || raw?.deliverySlice === "follow-up"
      ? raw.deliverySlice
      : "single-phase",
    summary: String(raw?.summary ?? "").trim(),
    reasoning: String(raw?.reasoning ?? "").trim(),
    signals: {
      benefitHypothesisCount: Number(raw?.signals?.benefitHypothesisCount ?? 1) || 1,
      acceptanceLoopCount: Number(raw?.signals?.acceptanceLoopCount ?? 1) || 1,
      actorSurfaceCount: Number(raw?.signals?.actorSurfaceCount ?? 1) || 1,
      externalSystemCount: Number(raw?.signals?.externalSystemCount ?? 0) || 0,
      newCoreModelCount: Number(raw?.signals?.newCoreModelCount ?? 0) || 0,
    },
    outOfScope: Array.isArray(raw?.outOfScope)
      ? raw.outOfScope.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [],
  };
});
const resolvedSizeAssessment = computed<RequirementCandidateDraft["sizeAssessment"]>(() => {
  const raw = props.candidate.sizeAssessment;
  return {
    model: raw?.model === "legacy-matrix-v1" ? "legacy-matrix-v1" : "functional-size-v2",
    size: raw?.size ?? "unknown",
    score: Number(raw?.score ?? 0) > 0 ? Number(raw?.score ?? 0) : 0,
    summary: String(raw?.summary ?? "").trim(),
    reasoning: String(raw?.reasoning ?? "").trim(),
    signals: {
      functionalProcessCount: Number(raw?.signals?.functionalProcessCount ?? 0) || 0,
      domainEntityCount: Number(raw?.signals?.domainEntityCount ?? 0) || 0,
      stateTransitionCount: Number(raw?.signals?.stateTransitionCount ?? 0) || 0,
      interactionSurfaceCount: Number(raw?.signals?.interactionSurfaceCount ?? 0) || 0,
      externalIntegrationCount: Number(raw?.signals?.externalIntegrationCount ?? 0) || 0,
      asyncConsistencyRiskCount: Number(raw?.signals?.asyncConsistencyRiskCount ?? 0) || 0,
      clientSurfaceCount: Number(raw?.signals?.clientSurfaceCount ?? 1) || 1,
    },
    legacySignals: raw?.legacySignals
      ? {
        menuCount: Number(raw.legacySignals.menuCount ?? 0) || 0,
        featurePointCount: Number(raw.legacySignals.featurePointCount ?? 0) || 0,
        businessFlowCount: Number(raw.legacySignals.businessFlowCount ?? 0) || 0,
        interactionPointCount: Number(raw.legacySignals.interactionPointCount ?? 0) || 0,
        integrationCount: Number(raw.legacySignals.integrationCount ?? 0) || 0,
        platformCount: Number(raw.legacySignals.platformCount ?? 1) || 1,
      }
      : null,
  };
});

const dialogOpen = ref(false);
const detailsOpen = ref(false);
const draftAnswers = reactive<Record<string, { optionId: string | null; customText: string }>>({});
const clarificationFingerprint = computed(() =>
  buildClarificationDraftFingerprint(props.candidate.id, props.candidate.clarificationItems),
);

watch(
  clarificationFingerprint,
  () => {
    dialogOpen.value = false;
    detailsOpen.value = false;
    for (const key of Object.keys(draftAnswers)) {
      delete draftAnswers[key];
    }
    Object.assign(draftAnswers, createClarificationDraftAnswers(props.candidate.clarificationItems));
  },
  { immediate: true },
);

const clarificationCount = computed(() => props.candidate.clarificationItems.length);
const questionSummary = computed(() => {
  const items = props.candidate.clarificationItems;
  if (!items.length) return "当前没有待澄清项";
  const first = String(items[0]?.question ?? "").trim();
  const preview = first.length > 28 ? `${first.slice(0, 28)}...` : first;
  if (items.length === 1) return preview;
  return `${preview} 等 ${items.length} 项`;
});
const summaryCopy = computed(() => {
  if (!clarificationCount.value) return "当前没有待澄清项。";
  if (props.staged) {
    return `这条候选的澄清已暂存，等剩余候选补齐后会统一发送给需求助手。`;
  }
  return `当前还有 ${clarificationCount.value} 项信息待补充，先暂存这条候选的澄清；等全部候选补齐后才会统一发送给需求助手。`;
});
const compactSummary = computed(() => {
  const title = String(props.candidate.title ?? "").trim();
  if (!props.compact) return questionSummary.value;
  if (!title) return questionSummary.value;
  return `${title} · ${questionSummary.value}`;
});
const compactStateLabel = computed(() => {
  if (props.sending) return "AI 处理中";
  if (props.staged) return "已暂存";
  if (props.disabled) return "暂不可补充";
  return "可继续输入";
});

const actionLabel = computed(() => {
  if (props.compact) return props.staged ? "修改" : "补充";
  return props.staged ? "修改补充" : "补充输入";
});
const dialogWidth = computed(() => (
  isMobileViewport()
    ? "calc(100vw - 24px)"
    : "min(920px, calc(100vw - 48px))"
));

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth <= 767;
}

function pickOption(question: string, optionId: string) {
  const current = ensureDraftAnswerByQuestion(question);
  current.optionId = current.optionId === optionId ? null : optionId;
}

function fillRecommendedOptions() {
  for (const item of props.candidate.clarificationItems) {
    const recommended = item.options.find((option) => option.recommended);
    if (!recommended) continue;
    ensureDraftAnswer(item).optionId = recommended.id;
  }
}

function shouldShowReason(reason: string): boolean {
  return String(reason ?? "").trim() !== "需要先补齐这项信息，才能继续确认流程和验收边界。";
}

function openDialog() {
  if (props.disabled || props.sending) return;
  dialogOpen.value = true;
}

function closeDialog() {
  dialogOpen.value = false;
}

function ensureDraftAnswer(item: ClarificationItemInput): { optionId: string | null; customText: string } {
  const existing = draftAnswers[item.question];
  if (existing) return existing;
  const created = createClarificationDraftAnswer(item);
  draftAnswers[item.question] = created;
  return created;
}

function ensureDraftAnswerByQuestion(question: string): { optionId: string | null; customText: string } {
  const existing = draftAnswers[question];
  if (existing) return existing;
  const item = props.candidate.clarificationItems.find((entry) => entry.question === question);
  const created = item ? createClarificationDraftAnswer(item) : { optionId: null, customText: "" };
  draftAnswers[question] = created;
  return created;
}

function readDraftAnswer(item: ClarificationItemInput): { optionId: string | null; customText: string } {
  return draftAnswers[item.question] ?? createClarificationDraftAnswer(item);
}

function updateCustomText(question: string, value: string) {
  ensureDraftAnswerByQuestion(question).customText = value;
}

function handleCustomTextInput(question: string, event: Event) {
  const target = event.target;
  updateCustomText(question, target instanceof HTMLTextAreaElement ? target.value : "");
}

function submitClarification() {
  if (props.disabled || props.sending) return;
  const answeredBlocks = props.candidate.clarificationItems.flatMap((item, index) => {
    const state = draftAnswers[item.question];
    const selected = item.options.find((option) => option.id === state?.optionId) ?? null;
    const customText = String(state?.customText ?? "").trim();
    if (!selected && !customText) return [];
    const lines = [`${index + 1}. ${item.question}`];
    if (selected?.value) lines.push(`- 我的选择：${selected.value}`);
    if (customText) lines.push(`- 我的补充：${customText}`);
    return [lines.join("\n")];
  });
  if (!answeredBlocks.length) {
    message.info("先选择至少一条 AI 建议，或自己补充一项澄清信息。");
    return;
  }
  const unansweredCount = Math.max(props.candidate.clarificationItems.length - answeredBlocks.length, 0);
  if (unansweredCount > 0) {
    message.info(`当前候选还有 ${unansweredCount} 项未补充，先补齐后再暂存。`);
    return;
  }
  emit("submit", {
    candidateId: props.candidate.id,
    title: props.candidate.title,
    text: [
      `关于候选需求「${props.candidate.title}」，我补充以下澄清反馈：`,
      answeredBlocks.join("\n\n"),
    ].join("\n\n"),
    clarificationCount: props.candidate.clarificationItems.length,
  });
  closeDialog();
}
</script>

<template>
  <div class="msg msg--tool msg--user-input msg--approval clar-request" :class="{ 'clar-request--compact': compact }">
    <div class="msg__approval-header">
      <div class="msg__approval-left">
        <span class="msg__role">{{ compact ? "待补充" : "待澄清" }}</span>
        <span
          v-if="compact"
          class="clar-request__compact-summary"
          :title="compactSummary"
        >
          {{ compactSummary }}
        </span>
        <span v-else class="msg__hint-inline">{{ questionSummary }}</span>
      </div>
      <div class="clar-request__header-actions">
        <span
          v-if="compact"
          class="clar-request__state"
          :class="{
            'clar-request__state--running': sending,
            'clar-request__state--disabled': disabled && !sending,
          }"
        >
          {{ compactStateLabel }}
        </span>
        <a-button
          size="small"
          type="primary"
          :disabled="disabled || sending"
          @click="openDialog"
        >
          {{ actionLabel }}
        </a-button>
        <SyncOutlined v-if="sending" class="msg__status-icon msg__status-icon--running" spin />
        <ClockCircleOutlined v-else-if="disabled" class="msg__status-icon msg__status-icon--expired" />
      </div>
    </div>

    <template v-if="!compact">
      <div class="clar-request__title">{{ candidate.title }}</div>
      <div class="clar-request__summary">{{ summaryCopy }}</div>
      <div v-if="resolvedRecommendedApproach" class="clar-request__line">
        <span class="clar-request__line-label">推荐方案</span>
        <span>{{ resolvedRecommendedApproach }}</span>
      </div>
      <div v-if="resolvedPhasingAssessment.summary" class="clar-request__line">
        <span class="clar-request__line-label">分期判断</span>
        <span>{{ resolvedPhasingAssessment.summary }}</span>
      </div>
      <div v-if="resolvedSizeAssessment.summary" class="clar-request__line">
        <span class="clar-request__line-label">规模评估</span>
        <span>{{ resolvedSizeAssessment.summary }}</span>
      </div>

      <div class="msg__approval-details">
        <button type="button" class="msg__approval-details-toggle" @click="detailsOpen = !detailsOpen">
          <RightOutlined v-if="!detailsOpen" style="font-size: 10px" />
          <DownOutlined v-else style="font-size: 10px" />
          查看待澄清项
        </button>
        <div v-show="detailsOpen" class="clar-request__details">
          <div
            v-for="(item, index) in candidate.clarificationItems"
            :key="`${candidate.id}-${item.question}`"
            class="clar-request__detail-item"
          >
            <div class="clar-request__detail-head">
              <strong>{{ index + 1 }}. {{ item.question }}</strong>
              <span class="clar-request__impact">{{ item.impact }}</span>
            </div>
            <div v-if="shouldShowReason(item.reason)" class="clar-request__detail-copy">{{ item.reason }}</div>
            <div class="clar-request__detail-copy">建议：{{ item.suggestion }}</div>
          </div>
        </div>
      </div>
    </template>
  </div>

  <a-modal
    :open="dialogOpen"
    title="补充待澄清信息"
    :width="dialogWidth"
    :body-style="{ maxHeight: isMobileViewport() ? '72vh' : '68vh', overflow: 'auto', padding: '16px' }"
    :mask-closable="!sending"
    @cancel="closeDialog"
  >
    <div class="clar-modal">
      <div class="clar-modal__summary">
        <strong>{{ candidate.title }}</strong>
        <div class="clar-modal__summary-copy">
          当前还有 {{ clarificationCount }} 项信息待补充。您可以直接采用 AI 建议，也可以自己补充更精确的要求。
        </div>
        <div class="clar-modal__summary-copy">
          {{ staged ? "当前候选的澄清已暂存，您可以继续修改；全部候选补齐后才会统一发送给需求助手。" : "这次提交会先暂存当前候选的澄清；全部候选补齐后才会统一发送给需求助手。" }}
        </div>
      </div>

      <div class="clar-modal__actions">
        <a-button size="small" :disabled="disabled || sending" @click="fillRecommendedOptions">全部采用 AI 建议</a-button>
        <span class="msg__hint-inline">不会立刻发给 AI；全部候选补齐后才会统一发送。</span>
      </div>

      <div class="clar-modal__list">
        <article
          v-for="(item, index) in candidate.clarificationItems"
          :key="`${candidate.id}-${item.question}`"
          class="clar-modal__item"
        >
          <div class="clar-modal__item-head">
            <strong>{{ index + 1 }}. {{ item.question }}</strong>
            <span class="clar-request__impact">{{ item.impact }}</span>
          </div>

          <div v-if="shouldShowReason(item.reason)" class="clar-modal__item-copy">
            {{ item.reason }}
          </div>
          <div class="clar-modal__item-copy">
            建议：{{ item.suggestion }}
          </div>

          <div v-if="item.options.length > 0" class="clar-modal__options">
            <button
              v-for="option in item.options"
              :key="option.id"
              class="clar-modal__option"
              :class="{
                'clar-modal__option--active': readDraftAnswer(item).optionId === option.id,
                'clar-modal__option--recommended': option.recommended,
              }"
              type="button"
              :disabled="disabled || sending"
              @click="pickOption(item.question, option.id)"
            >
              <span>{{ option.label }}</span>
              <small v-if="option.recommended">AI 建议</small>
            </button>
          </div>

          <textarea
            v-if="item.allowCustom !== false"
            :value="readDraftAnswer(item).customText"
            class="clar-modal__textarea"
            :disabled="disabled || sending"
            :placeholder="item.answerPlaceholder || '也可以直接补充您的想法。'"
            rows="3"
            @input="handleCustomTextInput(item.question, $event)"
          />
        </article>
      </div>
    </div>

    <template #footer>
      <a-button size="small" :disabled="sending" @click="closeDialog">取消</a-button>
      <a-button type="primary" size="small" :disabled="disabled || sending" @click="submitClarification">
        {{ sending ? "发送中..." : "暂存补充" }}
      </a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.clar-request {
  display: grid;
  gap: 8px;
}

.clar-request--compact {
  gap: 6px;
}

.clar-request__header-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: auto;
}

.clar-request :deep(.msg__approval-header) {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.clar-request :deep(.msg__role) {
  flex: 0 0 auto;
  white-space: nowrap;
}

.clar-request :deep(.msg__approval-left) {
  flex: 1 1 auto;
  min-width: 0;
}

.clar-request__compact-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--app-muted);
}

.clar-request__state {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, white);
  color: color-mix(in srgb, var(--app-primary, #1677ff) 72%, #334155);
  font-size: 11px;
  white-space: nowrap;
}

.clar-request__state--running {
  background: color-mix(in srgb, var(--app-primary, #1677ff) 14%, white);
}

.clar-request__state--disabled {
  background: color-mix(in srgb, var(--app-warning, #d97706) 10%, white);
  color: color-mix(in srgb, var(--app-warning, #d97706) 75%, #7c2d12);
}

.clar-request__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text);
}

.clar-request__summary,
.clar-request__line,
.clar-request__detail-copy,
.clar-modal__summary-copy,
.clar-modal__item-copy {
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-muted);
}

.clar-request__line {
  display: grid;
  gap: 2px;
}

.clar-request__line-label {
  font-weight: 600;
  color: var(--app-text);
}

.clar-request__details {
  display: grid;
  gap: 8px;
  margin-top: 6px;
}

.clar-request__detail-item {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 92%, #f8fafc);
  display: grid;
  gap: 4px;
}

.clar-request__detail-head,
.clar-modal__item-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.clar-request__detail-head strong,
.clar-modal__item-head strong {
  font-size: 13px;
  line-height: 1.6;
  color: var(--app-text);
}

.clar-request__impact {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, white);
  color: color-mix(in srgb, var(--app-primary, #1677ff) 72%, #334155);
  font-size: 11px;
  text-transform: uppercase;
  flex-shrink: 0;
}

.clar-modal {
  display: grid;
  gap: 14px;
}

.clar-modal__summary {
  display: grid;
  gap: 4px;
}

.clar-modal__summary strong {
  font-size: 14px;
  color: var(--app-text);
}

.clar-modal__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.clar-modal__list {
  display: grid;
  gap: 10px;
}

.clar-modal__item {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 10%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 94%, transparent);
}

.clar-modal__options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.clar-modal__option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 16%, var(--app-border, #d9d9d9));
  border-radius: 999px;
  background: var(--app-panel-bg, #fff);
  color: var(--app-text);
  font-size: 12px;
  cursor: pointer;
}

.clar-modal__option small {
  color: var(--app-primary, #1677ff);
}

.clar-modal__option--recommended {
  border-style: dashed;
}

.clar-modal__option--active {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 48%, #93c5fd);
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, var(--app-panel-bg, #fff));
}

.clar-modal__textarea {
  width: 100%;
  min-height: 88px;
  padding: 10px 12px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 12px;
  resize: vertical;
  font: inherit;
  line-height: 1.6;
  color: var(--app-text, #1f2937);
  background: var(--app-panel-bg, #fff);
}

@media (max-width: 767px) {
  .clar-request__header-actions,
  .clar-modal__actions,
  .clar-request__detail-head,
  .clar-modal__item-head {
    flex-wrap: wrap;
  }
}
</style>

