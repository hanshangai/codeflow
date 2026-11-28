<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, reactive, ref, watch, watchEffect } from "vue";
import { message, Modal } from "ant-design-vue";
import { RightOutlined, DownOutlined, CheckCircleFilled, SyncOutlined, ClockCircleOutlined, CloseOutlined } from "@ant-design/icons-vue";
import type { ConversationUserInputRequest, WorkspaceId } from "@codeflowai/shared";

import { copyToClipboard } from "@/composables/useClipboard";
import { createApiResultError } from "../../../../api/request";
import { useApiContext } from "../../../../composables/useApiContext";
import { respondUserInput } from "../../../../api/interactions";
import { isDesktopWorkspace } from "../../../../services/desktop";
import { useChatStore } from "../../../../store/chat";
import { useConfigStore } from "../../../../store/config";
import { useUiStore } from "../../../../store/ui";

defineOptions({ name: "UserInputRequestItem" });

const submittingRequestIds = reactive(new Set<string>());
type UserInputAnswers = Record<string, { answers: string[] }>;
type ResumeWithInputHandler = (payload: { item: ConversationUserInputRequest; answers: UserInputAnswers; text: string }) => Promise<void>;

type Props = {
  item: ConversationUserInputRequest;
  workspaceId?: WorkspaceId;
  compact?: boolean;
  /** 嵌入容器明确指定可见性；普通时间线沿用当前聊天选择。 */
  active?: boolean;
  resumeWithInput?: ResumeWithInputHandler;
};

const props = withDefaults(defineProps<Props>(), { active: undefined });

const config = useConfigStore();
const chat = useChatStore();
const ui = useUiStore();
const { ctx } = useApiContext();
// 共享线程的 item 可能保留 Host workspaceId；写操作必须优先使用当前聊天上下文。
const operationWorkspaceId = computed(() => props.workspaceId ?? props.item.workspaceId);
const localReady = computed(() => isDesktopWorkspace(config, operationWorkspaceId.value));

const requestKey = computed(() => String(props.item.requestId ?? ""));

/** 多选值（checkbox-group，string[]）。 */
const selected = reactive<Record<string, string[]>>({});
/** 单选值（radio-group，string）。 */
const radioSelected = reactive<Record<string, string>>({});
const freeText = reactive<Record<string, string>>({});
const otherText = reactive<Record<string, string>>({});

watchEffect(() => {
  for (const q of props.item.questions) {
    if (!(q.id in selected)) selected[q.id] = [];
    if (!(q.id in radioSelected)) radioSelected[q.id] = "";
    if (!(q.id in freeText)) freeText[q.id] = "";
    if (!(q.id in otherText)) otherText[q.id] = "";
  }
});

const submitting = ref(false);
const dialogOpen = ref(false);
const interactionActive = computed(() => props.active ?? (chat.selectedThreadId === props.item.threadId && ui.mainView === "chat"));
/** 会话或页面不可见时关闭弹层；问题到达不自动弹出，统一由用户点击打开。 */
watch(interactionActive, () => {
  if (!interactionActive.value) dialogOpen.value = false;
}, { immediate: true });
const sharedSubmitting = computed(() => submittingRequestIds.has(requestKey.value));
const busy = computed(() => submitting.value || sharedSubmitting.value);
const disabled = computed(() => !(config.connected || localReady.value) || props.item.state !== "pending" || busy.value);
const pendingActionLabel = computed(() => props.compact ? "填写" : "回答");
const submittedActionLabel = computed(() => "查看");
const isMobileViewport = ref(false);

/** 提交或换题时关闭旧表单；状态不变时保留用户主动打开的只读答案。 */
watch(
  () => [props.item.id, props.item.requestId, props.item.state] as const,
  (current, previous) => {
    if (previous && (current[0] !== previous[0] || current[1] !== previous[1] || current[2] !== previous[2])
      || props.item.state !== "pending" && props.item.state !== "submitted") {
      dialogOpen.value = false;
    }
  },
  { immediate: true },
);

function syncViewportMode(): void {
  if (typeof window === "undefined") return;
  isMobileViewport.value = window.innerWidth <= 767;
}

function onWindowResize(): void {
  syncViewportMode();
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") dialogOpen.value = false;
}

if (typeof window !== "undefined") {
  syncViewportMode();
  window.addEventListener("resize", onWindowResize);
  window.addEventListener("keydown", onWindowKeydown);
}

onDeactivated(() => {
  dialogOpen.value = false;
});

onBeforeUnmount(() => {
  if (typeof window !== "undefined") {
    window.removeEventListener("resize", onWindowResize);
    window.removeEventListener("keydown", onWindowKeydown);
  }
});

/* ---- 摘要文本 ---- */
const questionSummary = computed(() => {
  const qs = props.item.questions;
  if (!qs?.length) return "";
  const first = qs[0]!.question ?? "";
  const preview = first.length > 30 ? first.slice(0, 30) + "…" : first;
  if (qs.length === 1) return preview;
  return `${preview} 等${qs.length}个问题`;
});

/* ---- 已提交回答摘要 ---- */
const answersSummary = computed(() => {
  const sa = props.item.submittedAnswers;
  if (!sa) return "";
  const all: string[] = [];
  for (const q of props.item.questions) {
    const a = sa[q.id]?.answers;
    if (a?.length) all.push(...a);
  }
  if (!all.length) return "";
  const joined = all.join(", ");
  return joined.length > 50 ? joined.slice(0, 50) + "…" : joined;
});

/** 按 questionId 获取已提交的选项回答（匹配 option label 的部分）。 */
function getSubmittedSelections(qId: string): string[] {
  const answers = props.item.submittedAnswers?.[qId]?.answers ?? [];
  const q = props.item.questions.find((x) => x.id === qId);
  if (!q?.options?.length) return answers; // 纯文本问题：全部作为回答展示
  const optionLabels = new Set(q.options.map((o) => o.label));
  return answers.filter((a) => optionLabels.has(a));
}

/** 按 questionId 获取用户的自定义输入（不匹配任何 option label 的部分）。 */
function getSubmittedOtherText(qId: string): string | null {
  const answers = props.item.submittedAnswers?.[qId]?.answers ?? [];
  const q = props.item.questions.find((x) => x.id === qId);
  if (!q?.options?.length) return null; // 纯文本问题：没有 "other" 概念
  const optionLabels = new Set(q.options.map((o) => o.label));
  const others = answers.filter((a) => !optionLabels.has(a));
  return others.length ? others.join("；") : null;
}

/* ---- 完整参数 ---- */
const detailsOpen = ref(false);
const copyingDetails = ref(false);

async function copyDetails(): Promise<void> {
  if (copyingDetails.value) return;
  copyingDetails.value = true;
  try {
    await copyToClipboard(JSON.stringify(props.item, null, 2));
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  } finally {
    copyingDetails.value = false;
  }
}

const dialogTitle = computed(() => {
  if (props.item.state === "submitted") return props.item.header || "已提交回答";
  return props.item.header || "需要您补充输入";
});

/** 从当前表单状态构造 userInput.respond 的 answers payload。 */
function collectAnswers(): UserInputAnswers {
  const answers: UserInputAnswers = {};
  for (const q of props.item.questions) {
    const out: string[] = [];
    if (q.options?.length) {
      if (q.multiSelect) {
        out.push(...(selected[q.id] ?? []));
      } else {
        const v = radioSelected[q.id];
        if (v) out.push(v);
      }
    }
    if (q.options?.length && otherText[q.id]?.trim()) out.push(otherText[q.id]!.trim());
    if (!q.options?.length && freeText[q.id]?.trim()) out.push(freeText[q.id]!.trim());
    answers[q.id] = { answers: out.filter(Boolean) };
  }
  return answers;
}

/** 把结构化回答转成节点 resume_with_input 可读文本，供显式兜底使用。 */
function formatAnswersAsFeedback(answers: UserInputAnswers): string {
  const lines = [
    `来自 Claude Code 待补充输入（requestId: ${String(props.item.requestId)}）：`,
  ];
  const prompt = String(props.item.prompt ?? "").trim();
  if (prompt) lines.push(prompt);
  for (const q of props.item.questions) {
    const label = String(q.header || q.question || q.id).trim();
    const values = answers[q.id]?.answers ?? [];
    lines.push(`- ${label}: ${values.length ? values.join("；") : "（未填写）"}`);
  }
  return lines.join("\n");
}

/** 判断 Claude AskUserQuestion 是否已经失效，允许显式转节点补充输入。 */
function isClaudeUserInputUnavailable(messageText: string): boolean {
  const text = String(messageText ?? "");
  const lower = text.toLowerCase();
  return text.includes("AskUserQuestion request 不存在或已处理")
    || text.includes("Claude stdin 不可写")
    || text.includes("request 不存在或已处理")
    || text.includes("control_request request_id not found")
    || (lower.includes("control_request") && lower.includes("not found"));
}

/** Claude 请求失效后，显式确认是否转为节点 resume_with_input 兜底。 */
function confirmResumeWithInput(answers: UserInputAnswers, cause: string): void {
  if (!props.resumeWithInput) {
    message.error(`提交失败：${cause}`);
    return;
  }
  Modal.confirm({
    title: "Claude 请求已失效",
    content: "当前 Claude Code 待补充请求已不再等待回答。确认后会把这次回答转成节点补充输入继续执行，不会静默替代原请求。",
    okText: "转为节点补充输入",
    cancelText: "取消",
    async onOk() {
      try {
        await props.resumeWithInput!({
          item: props.item,
          answers,
          text: formatAnswersAsFeedback(answers),
        });
        dialogOpen.value = false;
        message.success("已转为节点补充输入");
      } catch (error) {
        message.error(error instanceof Error ? error.message : "转为节点补充输入失败");
        throw error;
      }
    },
  });
}

/** 提交回答到原 Claude userInput 请求；失败必须显式提示或转确认流程。 */
async function submitAnswers(answers: UserInputAnswers): Promise<void> {
  submitting.value = true;
  submittingRequestIds.add(requestKey.value);
  try {
    const requestWorkspaceId = operationWorkspaceId.value;
    const res = await respondUserInput(ctx.value, {
      workspaceId: requestWorkspaceId,
      threadId: props.item.threadId,
      requestId: props.item.requestId,
      answers,
    });
    if (!res.ok) throw createApiResultError(res);
    message.success("已提交输入");
    dialogOpen.value = false;
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (isClaudeUserInputUnavailable(errMsg)) {
      confirmResumeWithInput(answers, errMsg);
      return;
    }
    message.error(`提交失败：${errMsg}`);
  } finally {
    submitting.value = false;
    submittingRequestIds.delete(requestKey.value);
  }
}

/** 表单提交入口：先收集回答，再走原 userInput.respond 链路。 */
const submit = async () => {
  if (disabled.value || busy.value) return;
  await submitAnswers(collectAnswers());
};

/** 输入框按 Enter 直接提交；输入法组合态与带修饰键时保留原始输入行为。 */
function onAnswerEnter(event: KeyboardEvent): void {
  if (disabled.value || busy.value) return;
  if (event.isComposing || event.keyCode === 229) return;
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
  // 阻止多行输入框在提交同时插入换行；提交失败时保留原文本便于重试。
  event.preventDefault();
  void submit();
}
</script>

<template>
  <div class="msg msg--tool msg--user-input" :class="{ 'msg--expired': item.state === 'expired', 'msg--user-input-compact': compact }">
    <div class="msg__approval-header">
      <div class="msg__approval-left">
        <span class="msg__role">补充输入</span>
        <span v-if="item.state === 'submitted' && answersSummary" class="msg__hint-inline">{{ answersSummary }}</span>
        <span v-else class="msg__hint-inline">{{ questionSummary }}</span>
      </div>
      <div class="msg__summary-right">
        <a-button
          v-if="item.state === 'pending'"
          size="small"
          type="primary"
          @click="dialogOpen = true"
        >{{ pendingActionLabel }}</a-button>
        <a-button
          v-else-if="item.state === 'submitted' && item.submittedAnswers"
          size="small"
          type="link"
          @click="dialogOpen = true"
        >{{ submittedActionLabel }}</a-button>
        <CheckCircleFilled v-if="props.item.state === 'submitted'" class="msg__status-icon msg__status-icon--done" />
        <SyncOutlined v-else-if="props.item.state === 'pending'" class="msg__status-icon msg__status-icon--running" :spin="true" />
        <ClockCircleOutlined v-else class="msg__status-icon msg__status-icon--expired" />
      </div>
    </div>

    <!-- 完整参数（仅在调试侧栏开启时显示） -->
    <div v-if="!compact && ui.inspectorVisible" class="msg__approval-details">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <button type="button" class="msg__approval-details-toggle" @click="detailsOpen = !detailsOpen">
          <RightOutlined v-if="!detailsOpen" style="font-size: 10px" />
          <DownOutlined v-else style="font-size: 10px" />
          完整参数
        </button>
        <button v-show="detailsOpen" type="button" class="msg__mini-btn" @click.stop="copyDetails">
          {{ copyingDetails ? "..." : "复制 JSON" }}
        </button>
      </div>
      <pre v-show="detailsOpen" class="msg__approval-details-body">{{ JSON.stringify(item, null, 2) }}</pre>
    </div>
  </div>

  <teleport to="body">
    <div
      v-if="dialogOpen"
      class="uir-dialog-layer"
      :class="{ 'uir-dialog-layer--mobile': isMobileViewport }"
    >
      <section
        class="uir-dialog"
        :class="{ 'uir-dialog--mobile': isMobileViewport }"
        role="dialog"
        aria-modal="false"
        :aria-label="dialogTitle"
      >
        <header class="uir-dialog__header">
          <div class="uir-dialog__title-block">
            <strong class="uir-dialog__title">{{ dialogTitle }}</strong>
            <span v-if="item.prompt" class="uir-dialog__subtitle">{{ item.prompt }}</span>
          </div>
          <button type="button" class="uir-dialog__close" @click="dialogOpen = false">
            <CloseOutlined />
          </button>
        </header>

        <div class="uir-dialog__body">
          <template v-if="item.state === 'submitted' && item.submittedAnswers">
            <div v-for="q in item.questions" :key="q.id" class="uir-question">
              <div class="uir-question__header">{{ q.header }}</div>
              <div class="uir-question__text">{{ q.question }}</div>
              <div class="uir-question__answers">
                <span v-for="a in getSubmittedSelections(q.id)" :key="a" class="uir-question__answer-tag">{{ a }}</span>
                <span v-if="!getSubmittedSelections(q.id).length && !getSubmittedOtherText(q.id)" class="uir-question__answer-empty">（未填写）</span>
              </div>
              <div v-if="getSubmittedOtherText(q.id)" class="uir-question__other">
                <span class="uir-question__other-label">补充输入：</span>
                <span class="uir-question__other-text">{{ getSubmittedOtherText(q.id) }}</span>
              </div>
            </div>
          </template>

          <template v-else>
            <div v-for="q in item.questions" :key="q.id" class="uir-question">
              <div class="uir-question__header">{{ q.header }}</div>
              <div class="uir-question__text">{{ q.question }}</div>
              <div v-if="q.options?.length" style="margin-top: 8px">
                <a-checkbox-group v-if="q.multiSelect" v-model:value="selected[q.id]" :disabled="disabled">
                  <a-space direction="vertical">
                    <a-checkbox v-for="opt in q.options" :key="opt.label" :value="opt.label">
                      <span class="uir-option">
                        <span class="uir-option__label">{{ opt.label }}</span>
                        <span class="uir-option__desc">{{ opt.description }}</span>
                      </span>
                    </a-checkbox>
                  </a-space>
                </a-checkbox-group>
                <a-radio-group v-else v-model:value="radioSelected[q.id]" :disabled="disabled">
                  <a-space direction="vertical">
                    <a-radio v-for="opt in q.options" :key="opt.label" :value="opt.label">
                      <span class="uir-option">
                        <span class="uir-option__label">{{ opt.label }}</span>
                        <span class="uir-option__desc">{{ opt.description }}</span>
                      </span>
                    </a-radio>
                  </a-space>
                </a-radio-group>
                <a-input
                  v-model:value="otherText[q.id]"
                  :disabled="disabled"
                  style="margin-top: 8px"
                  placeholder="其他（可选）"
                  @press-enter="onAnswerEnter"
                />
              </div>
              <div v-else style="margin-top: 8px">
                <a-textarea v-model:value="freeText[q.id]" :disabled="disabled" :auto-size="{ minRows: 2, maxRows: 4 }" placeholder="请输入您的回答" @press-enter="onAnswerEnter" />
              </div>
            </div>
          </template>
        </div>

        <footer class="uir-dialog__footer">
          <span v-if="item.state === 'pending'" class="uir-dialog__hint">Enter 提交，Shift+Enter 换行</span>
          <a-button :size="isMobileViewport ? 'large' : 'small'" @click="dialogOpen = false">关闭</a-button>
          <a-button
            v-if="item.state === 'pending'"
            type="primary"
            :size="isMobileViewport ? 'large' : 'small'"
            :loading="busy"
            :disabled="disabled"
            @click="submit"
          >提交</a-button>
        </footer>
      </section>
    </div>
  </teleport>
</template>

<style scoped>
.msg--expired {
  opacity: 0.55;
}

.msg--user-input-compact {
  padding: 8px 12px;
}

.uir-dialog-layer {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  padding: 24px;
}

.uir-dialog-layer--mobile {
  align-items: flex-end;
  padding: 12px;
}

.uir-dialog {
  pointer-events: auto;
  /* 宽度随内容收缩，同时限制最小可读宽度和桌面最大宽度。 */
  width: fit-content;
  min-width: min(420px, calc(100vw - 48px));
  max-width: min(1120px, calc(100vw - 48px));
  max-height: 72vh;
  border: 1px solid var(--app-border, #e5e7eb);
  border-radius: 16px;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 98%, transparent);
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.16);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
}

.uir-dialog--mobile {
  width: min(100%, 760px);
  min-width: 0;
  /* 移动端层内边距为 12px，覆盖桌面端 48px 的最大宽度限制。 */
  max-width: calc(100vw - 24px);
  max-height: 82vh;
  border-radius: 18px 18px 0 0;
}

.uir-dialog__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--app-border, #f0f0f0);
}

.uir-dialog__title-block {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.uir-dialog__title {
  font-size: 14px;
  line-height: 1.4;
  color: var(--app-text);
  overflow-wrap: anywhere;
}

.uir-dialog__subtitle {
  font-size: 12px;
  line-height: 1.45;
  color: var(--app-muted);
  white-space: pre-wrap;
  word-break: break-word;
}

.uir-dialog__close {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
}

.uir-dialog__close:hover {
  background: color-mix(in srgb, var(--app-accent) 8%, transparent);
  color: var(--app-text);
}

.uir-dialog__body {
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px;
  display: grid;
  gap: 12px;
}

.uir-question + .uir-question {
  padding-top: 12px;
  border-top: 1px solid var(--app-border, #f0f0f0);
}

.uir-question__header {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 2px;
}

.uir-question__text {
  font-size: 13px;
  color: var(--app-text-secondary, #666);
  white-space: pre-wrap;
  word-break: break-word;
}

.uir-question__answers {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.uir-question__answer-tag {
  display: inline-block;
  padding: 2px 8px;
  font-size: 12px;
  line-height: 1.5;
  background: var(--app-bg-soft, #f5f5f5);
  border-radius: 4px;
  color: var(--app-text, #333);
}

.uir-question__answer-empty {
  font-size: 12px;
  color: var(--app-muted);
}

.uir-question__other {
  margin-top: 8px;
  padding: 6px 8px;
  font-size: 12px;
  background: var(--app-bg-soft, #fafafa);
  border-left: 2px solid var(--app-primary, #1677ff);
  border-radius: 2px;
}

.uir-question__other-label {
  color: var(--app-muted);
  margin-right: 4px;
}

.uir-question__other-text {
  color: var(--app-text, #333);
  white-space: pre-wrap;
  word-break: break-word;
}

.uir-dialog__hint {
  color: var(--app-muted);
  font-size: 12px;
  margin-right: auto;
}

.uir-option {
  display: grid;
  gap: 2px;
  min-width: 0;
  width: 100%;
  max-width: 100%;
}

.uir-option__label {
  color: var(--app-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  white-space: normal;
  word-break: break-word;
}

.uir-option__desc {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
  white-space: normal;
  word-break: break-word;
}

.uir-dialog :deep(.ant-radio-group),
.uir-dialog :deep(.ant-checkbox-group) {
  width: 100%;
}

.uir-dialog :deep(.ant-space) {
  width: 100%;
}

.uir-dialog :deep(.ant-space-item) {
  width: 100%;
}

.uir-dialog :deep(.ant-radio-wrapper),
.uir-dialog :deep(.ant-checkbox-wrapper) {
  width: 100%;
  align-items: flex-start;
  white-space: normal;
}

.uir-dialog :deep(.ant-radio-wrapper > span:last-child),
.uir-dialog :deep(.ant-checkbox-wrapper > span:last-child) {
  flex: 1 1 auto;
  min-width: 0;
}

.uir-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px 14px;
  border-top: 1px solid var(--app-border, #f0f0f0);
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 98%, transparent);
}

@media (max-width: 767px) {
  .uir-dialog-layer {
    padding: 12px 12px 0;
  }

  .uir-dialog__hint {
    display: none;
  }

  .uir-dialog__footer > .ant-btn {
    flex: 1 1 120px;
    min-height: 44px;
    font-size: 15px;
  }
}
</style>
