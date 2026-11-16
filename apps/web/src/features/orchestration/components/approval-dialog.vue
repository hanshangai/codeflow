<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { CloseOutlined, QuestionCircleOutlined } from "@ant-design/icons-vue";
import {
  validateInlineThreadPayload,
  type FeedbackAction,
  type NodeExecutionState,
  type OrchestrationId,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkspaceId,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useChatStore } from "../../../store/chat";
import { useOrchestrationStore } from "../../../store/orchestration";
import { useComposerAttachments } from "../../composer/useComposerAttachments";
import { resolveAllowedReworkTargets } from "../rework-targets";

defineOptions({ name: "ApprovalDialog" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
  nodeState: NodeExecutionState;
  nodeLabel: string;
  workflowNodes?: WorkflowNode[];
  workflowEdges?: WorkflowEdge[];
}>();

const orch = useOrchestrationStore();
const chat = useChatStore();
const { ctx } = useApiContext();
const feedbackText = ref("");
const canAddFeedbackImages = computed(() => true);
const {
  imageAttachments: feedbackImages,
  removeImage: removeFeedbackImage,
  onPaste: onFeedbackPaste,
  clearAttachments: clearFeedbackAttachments,
} = useComposerAttachments({
  canAdd: canAddFeedbackImages,
  allowImages: canAddFeedbackImages,
  allowTextFiles: computed(() => false),
});
const reworkDialogOpen = ref(false);
const reworkMode = ref<"current" | "target">("current");
const reworkTargetNodeId = ref("");
const conclusion = computed(() => props.nodeState.conclusion ?? null);
const isReworkSuggestion = computed(() => conclusion.value?.nextAction === "rework");
const workflowNodeLabelById = computed<Record<string, string>>(() =>
  Object.fromEntries(
    (props.workflowNodes ?? [])
      .map((workflowNode) => {
        const nodeId = String(workflowNode.id ?? "").trim();
        const label = String(workflowNode.label ?? "").trim() || nodeId;
        return [nodeId, label] as const;
      })
      .filter(([nodeId]) => Boolean(nodeId)),
  ),
);
const allowedReworkTargets = computed(() =>
  resolveAllowedReworkTargets(props.workflowNodes ?? [], props.workflowEdges ?? [], props.nodeId),
);
const canReworkToTarget = computed(() => allowedReworkTargets.value.length > 0);
const reworkDialogButtonLabel = computed(() => isReworkSuggestion.value ? "选择驳回目标" : "驳回到上游");
const reworkDialogTitle = computed(() => isReworkSuggestion.value ? "驳回到指定节点" : "驳回处理");
const reworkTargetLabel = computed(() => resolveWorkflowNodeLabel(conclusion.value?.rework?.targetNodeId) ?? "上游节点");
const primaryActionLabel = computed(() =>
  isReworkSuggestion.value
    ? `驳回到 ${reworkTargetLabel.value}`
    : "通过并继续",
);
const secondaryActionLabel = computed(() =>
  isReworkSuggestion.value
    ? "继续"
    : "驳回",
);
const secondaryAction = computed<FeedbackAction>(() =>
  isReworkSuggestion.value
    ? "override"
    : (hasSupplementInput.value ? "resume_with_input" : "retry"),
);
const hasFeedbackText = computed(() => Boolean(feedbackText.value.trim()));
const hasFeedbackImages = computed(() => feedbackImages.value.length > 0);
const hasFeedbackContent = computed(() => hasFeedbackText.value || hasFeedbackImages.value);
const hasSupplementInput = computed(() => hasFeedbackContent.value);
const displayNodeLabel = computed(() => String(props.nodeLabel ?? "").trim() || props.nodeId);
const primaryActionToneClass = computed(() =>
  isReworkSuggestion.value ? "approval-dialog__btn--warning" : "approval-dialog__btn--primary",
);
const secondaryActionToneClass = computed(() =>
  isReworkSuggestion.value ? "" : "approval-dialog__btn--warning",
);
const feedbackLabel = computed(() =>
  isReworkSuggestion.value ? "改进意见（必填）" : "审核意见（可选）",
);
const reworkFeedbackSourceLabel = computed(() => isReworkSuggestion.value ? "改进意见" : "审核意见");
const feedbackPlaceholder = computed(() =>
  isReworkSuggestion.value
    ? "请明确说明要改哪些地方、为什么要改，以及这次重做时必须关注的验收点。"
    : "例如：方向正确，但下一节点实现时要严格遵守这里的边界；或补充某些限制后重新生成。",
);
const isTargetReworkMode = computed(() => isReworkSuggestion.value || reworkMode.value === "target");
const canSubmitReworkDialog = computed(() =>
  isTargetReworkMode.value
    ? Boolean(reworkTargetNodeId.value && hasFeedbackContent.value)
    : hasFeedbackContent.value,
);
const reworkDialogNote = computed(() => {
  if (!hasFeedbackContent.value) {
    return isTargetReworkMode.value
      ? "请先在主面板填写退回说明或粘贴附图，再确认驳回。"
      : "请先在主面板填写改进意见或粘贴附图，再确认驳回。";
  }
  return isTargetReworkMode.value
    ? "已检测到退回说明或附图，可直接确认驳回到目标节点。"
    : "已检测到改进意见或附图，可直接确认重跑当前节点。";
});
const visibleAcceptanceChecks = computed(() =>
  (conclusion.value?.acceptanceChecks ?? []).filter((check) => check.verdict === "pass" || check.verdict === "fail"),
);
const approvalHelpLines = computed(() => {
  if (isReworkSuggestion.value) {
    return [
      "左侧保存修订后，会生成整份交付的新版本，不会按单个文件分别记版本。",
      `驳回后，系统会把最新版本带回上游节点「${reworkTargetLabel.value}」继续处理。`,
      "忽略建议并继续，则不回退上游，而是直接进入后续节点。",
    ];
  }
  return [
    "左侧如果直接修改交付物，保存后会生成新的版本。",
    "通过并继续会带着最新交付件进入下一节点；如果填写了审核意见，也会一并带过去。",
    canReworkToTarget.value
      ? "如果结果方向不对，可以填写审核意见后重跑当前节点，或驳回到配置允许的上游节点。"
      : "如果结果方向不对，可以填写审核意见后让当前节点重跑。",
  ];
});
const feedbackHelpLines = computed(() =>
  isReworkSuggestion.value
    ? [
        "这里建议写清楚要改什么、为什么要改，以及重做时必须满足的点。",
        "这段意见会和退回指令一起带回原节点会话，作为下一轮重做要求。",
      ]
    : [
        "这里可以补充审核意见；通过时会带到下一节点，重跑时也会带回当前节点。",
        canReworkToTarget.value
          ? "定向驳回到上游节点时必须填写退回说明，说明会带回目标节点。"
          : "如果不填，也可以直接通过或退回重跑。",
      ],
);
const acceptanceCheckHelpLines = computed(() =>
  visibleAcceptanceChecks.value.map((check) => {
    const evidence = String(check.evidence ?? "").trim();
    return `${acceptanceVerdictLabel(check.verdict)} · ${check.label}${evidence ? `：${evidence}` : ""}`;
  }),
);
watch(
  () => allowedReworkTargets.value.map((item) => item.id).join("|"),
  () => {
    if (allowedReworkTargets.value.some((item) => item.id === reworkTargetNodeId.value)) return;
    reworkTargetNodeId.value = allowedReworkTargets.value[0]?.id ?? "";
  },
  { immediate: true },
);

watch(canReworkToTarget, (enabled) => {
  if (!enabled && reworkMode.value === "target") reworkMode.value = "current";
  if (!enabled && isReworkSuggestion.value) reworkDialogOpen.value = false;
});

function acceptanceVerdictLabel(verdict: string | null | undefined): string {
  if (verdict === "fail") return "未通过";
  if (verdict === "pass") return "通过";
  return "";
}

function resolveWorkflowNodeLabel(nodeId: string | null | undefined): string | null {
  const normalizedId = String(nodeId ?? "").trim();
  if (!normalizedId) return null;
  return workflowNodeLabelById.value[normalizedId] ?? normalizedId;
}

function requiredImprovementFeedbackMessage(action: FeedbackAction): string | null {
  if (action === "approve" && isReworkSuggestion.value) {
    return "驳回前必须填写改进意见或附图";
  }
  if (!isReworkSuggestion.value && (action === "retry" || action === "resume_with_input")) {
    return "驳回重跑前必须填写改进意见或附图";
  }
  return null;
}

function resolveConfirmConfig(action: FeedbackAction): {
  title: string;
  content: string;
  okText: string;
  okButtonProps?: { danger?: boolean };
} | null {
  if (action === "approve") {
    if (isReworkSuggestion.value) {
      return {
        title: `确认驳回到「${reworkTargetLabel.value}」？`,
        content: hasFeedbackContent.value
          ? `确认后，系统会把当前结果和您填写的改进意见或附图一起退回上游节点「${reworkTargetLabel.value}」继续处理。`
          : `确认后，系统会把当前结果退回上游节点「${reworkTargetLabel.value}」继续处理。`,
        okText: "确认驳回",
        okButtonProps: { danger: true },
      };
    }
    return {
      title: `确认通过节点「${displayNodeLabel.value}」？`,
      content: hasFeedbackContent.value
        ? "确认后，系统会记录当前审核意见或附图，并把它和最新交付件一起带到下一节点。"
        : "确认后，系统会带着最新交付件继续执行下一节点。",
      okText: "确认通过",
    };
  }
  if (action === "retry" || action === "resume_with_input") {
    return {
      title: `确认驳回节点「${displayNodeLabel.value}」？`,
      content: action === "resume_with_input"
        ? "确认后，系统会带着当前填写的审核意见或附图重新执行当前节点。"
        : "确认后，系统会重新执行当前节点。",
      okText: "确认驳回",
      okButtonProps: { danger: true },
    };
  }
  return null;
}

/** 打开人工审核场景下的定向驳回选择框。 */
function openReworkDialog(): void {
  if (!canReworkToTarget.value) return;
  reworkMode.value = "target";
  reworkDialogOpen.value = true;
}

/** 打开普通人工审核的驳回方式选择框；无目标时退回当前节点确认。 */
function requestSecondaryAction(): void {
  if (isReworkSuggestion.value) {
    requestSubmitAction(secondaryAction.value);
    return;
  }
  if (!canReworkToTarget.value) {
    requestSubmitAction(secondaryAction.value);
    return;
  }
  reworkMode.value = "current";
  reworkDialogOpen.value = true;
}

/** 关闭定向驳回选择框，不清空审核意见。 */
function closeReworkDialog(): void {
  reworkDialogOpen.value = false;
}

/** 根据弹窗里选择的驳回方式提交当前节点重跑或定向驳回。 */
async function submitReworkDialog(): Promise<void> {
  if (!isTargetReworkMode.value) {
    const succeeded = await submitAction(secondaryAction.value);
    if (succeeded) closeReworkDialog();
    return;
  }
  await submitReworkToTarget();
}

/** 校验目标与退回说明后，提交定向驳回动作。 */
async function submitReworkToTarget(): Promise<void> {
  const targetNodeId = String(reworkTargetNodeId.value ?? "").trim();
  if (!targetNodeId) {
    message.warning("请先选择驳回目标节点");
    return;
  }
  if (!hasFeedbackContent.value) {
    message.warning("驳回到指定节点时必须填写退回说明或附图");
    return;
  }
  const succeeded = await submitAction("rework_to_target", { targetNodeId });
  if (succeeded) closeReworkDialog();
}

/** 发起人工审核动作；需要二次确认的动作先弹出确认框。 */
function requestSubmitAction(action: FeedbackAction): void {
  const requiredMessage = requiredImprovementFeedbackMessage(action);
  if (requiredMessage && !hasFeedbackContent.value) {
    message.warning(requiredMessage);
    return;
  }
  const confirmConfig = resolveConfirmConfig(action);
  if (!confirmConfig) {
    void submitAction(action);
    return;
  }
  Modal.confirm({
    title: confirmConfig.title,
    content: confirmConfig.content,
    okText: confirmConfig.okText,
    cancelText: "取消",
    okButtonProps: confirmConfig.okButtonProps,
    onOk: () => submitAction(action),
  });
}

/** 提交人工审核/定向驳回结果，并在成功后同步关联节点会话状态。 */
async function submitAction(action: FeedbackAction, options?: { targetNodeId?: string | null }): Promise<boolean> {
  const requiredMessage = requiredImprovementFeedbackMessage(action);
  if (requiredMessage && !hasFeedbackContent.value) {
    message.warning(requiredMessage);
    return false;
  }
  const images = feedbackImages.value.map((item) => item.dataUrl);
  const feedback = feedbackText.value.trim();
  const budgetCheck = validateInlineThreadPayload(
    { text: feedback, images },
    { contextLabel: "当前审核意见" },
  );
  if (!budgetCheck.ok) {
    message.warning(budgetCheck.message);
    return false;
  }
  try {
    await orch.submitFeedback(
      ctx.value,
      props.workspaceId,
      props.instanceId,
      props.nodeId,
      action,
      feedback || undefined,
      [],
      options?.targetNodeId ?? null,
      images.length ? images : null,
    );
    const threadId = String(props.nodeState.threadId ?? "").trim();
    if (threadId && (action === "retry" || action === "resume_with_input")) {
      try {
        await chat.syncThreadSummaryState(ctx.value, {
          workspaceId: props.workspaceId,
          threadId: threadId as any,
          waitForRunning: true,
        });
      } catch (error) {
        console.warn("[ApprovalDialog] failed to sync node thread running state:", error);
      }
    }
    message.success(
      action === "approve"
        ? isReworkSuggestion.value
          ? `已驳回到 ${reworkTargetLabel.value}`
          : "已通过审核，继续执行下一节点"
        : action === "rework_to_target"
          ? `已退回到 ${resolveWorkflowNodeLabel(options?.targetNodeId ?? null) ?? "指定节点"}`
          : action === "resume_with_input"
            ? "已驳回并带补充说明重跑当前节点"
            : action === "retry"
              ? "已驳回并重新执行当前节点"
              : action === "override"
                ? "已继续后续流程"
                : "已终止编排",
    );
    feedbackText.value = "";
    clearFeedbackAttachments();
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "操作失败");
    return false;
  }
}
</script>

<template>
  <div class="approval-dialog">
    <div class="approval-dialog__header">
      <span class="approval-dialog__badge">待审核</span>
      <div class="approval-dialog__summary">
        <div class="approval-dialog__title-row">
          <h4>{{ nodeLabel }}</h4>
          <a-popover trigger="click" placement="bottomLeft" :arrow="false">
            <template #content>
              <div class="approval-dialog__help-popover">
                <strong>审核说明</strong>
                <p v-for="line in approvalHelpLines" :key="line">{{ line }}</p>
              </div>
            </template>
            <button type="button" class="approval-dialog__help-btn" aria-label="查看审核说明">
              <QuestionCircleOutlined />
            </button>
          </a-popover>
          <span v-if="hasFeedbackContent" class="approval-dialog__chip">已填写审核意见</span>
        </div>
      </div>
    </div>

    <div class="approval-dialog__body">
      <div v-if="isReworkSuggestion" class="approval-dialog__meta">
        <span v-if="isReworkSuggestion" class="approval-dialog__chip">{{ `模型建议驳回到 ${reworkTargetLabel}` }}</span>
      </div>

      <div v-if="conclusion" class="approval-dialog__conclusion">
        <div class="approval-dialog__conclusion-head">
          <strong>业务结论：{{ conclusion.reviewVerdict === "fail" ? "不通过" : conclusion.reviewVerdict === "partial" ? "部分满足" : "通过" }}</strong>
          <span>{{ conclusion.summary || "未填写结论摘要" }}</span>
        </div>
        <div v-if="visibleAcceptanceChecks.length" class="approval-dialog__check-summary">
          <span>{{ `验收检查 ${visibleAcceptanceChecks.length} 条` }}</span>
          <a-popover trigger="click" placement="bottomLeft" :arrow="false">
            <template #content>
              <div class="approval-dialog__help-popover">
                <strong>验收检查明细</strong>
                <p v-for="line in acceptanceCheckHelpLines" :key="line">{{ line }}</p>
              </div>
            </template>
            <button type="button" class="approval-dialog__help-btn" aria-label="查看验收检查明细">
              <QuestionCircleOutlined />
            </button>
          </a-popover>
        </div>
      </div>

      <div class="approval-dialog__panel approval-dialog__panel--feedback">
        <div class="approval-dialog__field-head">
          <label>{{ feedbackLabel }}</label>
          <a-popover trigger="click" placement="bottomLeft" :arrow="false">
            <template #content>
              <div class="approval-dialog__help-popover">
                <strong>改进意见说明</strong>
                <p v-for="line in feedbackHelpLines" :key="line">{{ line }}</p>
              </div>
            </template>
            <button type="button" class="approval-dialog__help-btn" aria-label="查看改进意见说明">
              <QuestionCircleOutlined />
            </button>
          </a-popover>
        </div>
        <textarea
          v-model="feedbackText"
          class="approval-dialog__textarea"
          rows="6"
          data-testid="approval-feedback"
          :placeholder="feedbackPlaceholder"
          @paste="onFeedbackPaste"
        />
        <div v-if="feedbackImages.length" class="approval-dialog__attachments" aria-label="审核意见附图">
          <div v-for="image in feedbackImages" :key="image.id" class="approval-dialog__attachment">
            <img :src="image.dataUrl" :alt="image.name" />
            <button type="button" title="移除附图" aria-label="移除附图" @click="removeFeedbackImage(image.id)">
              <CloseOutlined />
            </button>
          </div>
        </div>
      </div>

    </div>

    <div class="approval-dialog__footer">
      <div class="approval-dialog__action-row">
        <button
          :class="[
            'approval-dialog__btn',
            secondaryActionToneClass,
          ]"
          @click="requestSecondaryAction"
        >
          {{ secondaryActionLabel }}
        </button>
        <button
          :class="['approval-dialog__btn', primaryActionToneClass]"
          data-testid="approval-submit-approve"
          @click="requestSubmitAction('approve')"
        >
          {{ primaryActionLabel }}
        </button>
        <button
          v-if="isReworkSuggestion && canReworkToTarget"
          class="approval-dialog__btn approval-dialog__btn--warning"
          @click="openReworkDialog"
        >
          {{ reworkDialogButtonLabel }}
        </button>
        <button class="approval-dialog__btn approval-dialog__btn--danger" @click="submitAction('abort')">
          终止编排
        </button>
      </div>
    </div>
  </div>

  <a-modal
    :open="reworkDialogOpen"
    :title="reworkDialogTitle"
    :width="480"
    :mask-closable="false"
    destroy-on-close
    @cancel="closeReworkDialog"
  >
    <div class="approval-dialog__rework-modal">
      <div class="approval-dialog__rework-copy">
        <strong>{{ isReworkSuggestion ? "选择退回目标" : "选择驳回方式" }}</strong>
        <span>
          {{
            isReworkSuggestion
              ? `退回说明会直接使用主面板里的“${reworkFeedbackSourceLabel}”，并和驳回动作一起带回目标节点。`
              : "可以重跑当前节点，也可以把当前结果和改进意见退回到配置允许的上游节点。"
          }}
        </span>
      </div>
      <div v-if="!isReworkSuggestion" class="approval-dialog__rework-options">
        <label class="approval-dialog__rework-option">
          <input v-model="reworkMode" type="radio" value="current" />
          <span>
            <strong>重跑当前节点</strong>
            <small>重新执行「{{ displayNodeLabel }}」，改进意见会带回当前节点。</small>
          </span>
        </label>
        <label class="approval-dialog__rework-option">
          <input v-model="reworkMode" type="radio" value="target" />
          <span>
            <strong>驳回到指定节点</strong>
            <small>退回到上游节点重新处理，并重置目标节点之后的产出。</small>
          </span>
        </label>
      </div>
      <div v-if="isTargetReworkMode" class="approval-dialog__rework-field">
        <label for="approval-dialog-rework-target">目标节点</label>
        <select id="approval-dialog-rework-target" v-model="reworkTargetNodeId" class="approval-dialog__select">
          <option v-for="target in allowedReworkTargets" :key="target.id" :value="target.id">
            {{ target.label }}
          </option>
        </select>
      </div>
      <div
        class="approval-dialog__rework-note"
        :class="{ 'approval-dialog__rework-note--warning': !hasFeedbackContent }"
      >
        {{ reworkDialogNote }}
      </div>
    </div>
    <template #footer>
      <div class="approval-dialog__modal-footer">
        <button class="approval-dialog__btn approval-dialog__btn--subtle" @click="closeReworkDialog">
          取消
        </button>
        <button
          class="approval-dialog__btn approval-dialog__btn--warning"
          :disabled="!canSubmitReworkDialog"
          @click="submitReworkDialog"
        >
          确认驳回
        </button>
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
.approval-dialog {
  border: 1px solid color-mix(in srgb, #1677ff 30%, var(--app-border, #d9d9d9));
  border-radius: 12px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  padding: 14px;
  background: color-mix(in srgb, #1677ff 4%, var(--app-bg, #fff));
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 100%;
  overflow: hidden;
}

.approval-dialog__header {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.approval-dialog__summary {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.approval-dialog__title-row,
.approval-dialog__field-head,
.approval-dialog__check-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.approval-dialog__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 58px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, #1677ff 12%, transparent);
  color: #0958d9;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}

.approval-dialog__summary h4 {
  margin: 0;
  font-size: 14px;
  color: var(--app-text, #222);
}

.approval-dialog__body {
  display: flex;
  flex: 1 1 auto;
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  min-height: 0;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
  padding-right: 4px;
}

.approval-dialog__footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--app-border, #d9d9d9);
}

.approval-dialog__action-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  min-width: 0;
}

.approval-dialog__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 999px;
  background: var(--app-bg, #fff);
  cursor: pointer;
  font-size: 12px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--app-text, #222);
  transition: transform 0.16s ease, border-color 0.16s ease, background-color 0.16s ease, color 0.16s ease;
}

.approval-dialog__btn:hover {
  transform: translateY(-1px);
}

.approval-dialog__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none;
}

.approval-dialog__btn--primary {
  background: #1677ff;
  color: #fff;
  border-color: #1677ff;
}

.approval-dialog__btn--warning {
  color: #ad6800;
  border-color: color-mix(in srgb, #faad14 40%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #faad14 12%, var(--app-bg, #fff));
}

.approval-dialog__btn--danger {
  color: #cf1322;
  border-color: color-mix(in srgb, #ff4d4f 38%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #ff4d4f 10%, var(--app-bg, #fff));
}

.approval-dialog__btn--subtle {
  color: var(--app-muted, #666);
}

.approval-dialog__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.approval-dialog__conclusion {
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border, #d9d9d9);
  background: var(--app-bg, #fff);
  display: grid;
  gap: 10px;
}

.approval-dialog__conclusion-head {
  display: grid;
  gap: 4px;
}

.approval-dialog__conclusion-head strong {
  font-size: 13px;
  color: var(--app-text, #222);
}

.approval-dialog__conclusion-head span,
.approval-dialog__check-summary {
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted, #666);
}

.approval-dialog__chip {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-bg, #fff) 92%, var(--app-hover-bg, #fafafa));
  border: 1px solid var(--app-border, #e8e8e8);
  color: var(--app-muted, #666);
  font-size: 12px;
}

.approval-dialog__panel {
  padding: 12px;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  border-radius: 10px;
  border: 1px solid var(--app-border, #d9d9d9);
  background: var(--app-bg, #fff);
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
}

.approval-dialog__panel label {
  font-size: 12px;
  color: var(--app-muted, #666);
}

.approval-dialog__textarea {
  display: block;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  flex: 0 0 auto;
  height: 180px;
  min-height: 140px;
  max-height: 180px;
  padding: 8px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 8px;
  font-size: 13px;
  resize: none;
  outline: none;
  background: var(--app-bg, #fff);
  color: var(--app-text, #222);
}

.approval-dialog__attachments {
  display: flex;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  padding-bottom: 2px;
}

.approval-dialog__attachment {
  position: relative;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 8px;
  overflow: hidden;
  background: color-mix(in srgb, var(--app-bg, #fff) 92%, var(--app-hover-bg, #fafafa));
}

.approval-dialog__attachment img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.approval-dialog__attachment button {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 999px;
  background: rgb(0 0 0 / 62%);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
}

.approval-dialog__panel--feedback {
  flex: 0 0 auto;
}

.approval-dialog__select {
  width: 100%;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 10px;
  background: var(--app-bg, #fff);
  color: var(--app-text, #222);
  font-size: 12px;
}

.approval-dialog__textarea:focus {
  border-color: #1677ff;
}

.approval-dialog__help-btn {
  width: 24px;
  height: 24px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 18%, var(--app-border, #d9d9d9));
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, #fff);
  color: color-mix(in srgb, var(--app-primary, #1677ff) 72%, #1f2937);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
  flex-shrink: 0;
}

.approval-dialog__help-btn:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 32%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 12%, #fff);
}

.approval-dialog__help-popover {
  max-width: 320px;
  display: grid;
  gap: 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-text, #334155);
}

.approval-dialog__help-popover strong,
.approval-dialog__help-popover p {
  margin: 0;
}

.approval-dialog__rework-modal {
  display: grid;
  gap: 14px;
}

.approval-dialog__rework-copy,
.approval-dialog__rework-field {
  display: grid;
  gap: 8px;
}

.approval-dialog__rework-options {
  display: grid;
  gap: 10px;
}

.approval-dialog__rework-option {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-bg, #fff) 96%, var(--app-hover-bg, #fafafa));
  cursor: pointer;
}

.approval-dialog__rework-option input {
  margin-top: 3px;
}

.approval-dialog__rework-option span {
  display: grid;
  gap: 4px;
}

.approval-dialog__rework-copy strong,
.approval-dialog__rework-field label,
.approval-dialog__rework-option strong {
  font-size: 13px;
  color: var(--app-text, #222);
}

.approval-dialog__rework-copy span,
.approval-dialog__rework-note,
.approval-dialog__rework-option small {
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted, #666);
}

.approval-dialog__rework-note {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 14%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 5%, var(--app-bg, #fff));
}

.approval-dialog__rework-note--warning {
  color: #ad6800;
  border-color: color-mix(in srgb, #faad14 34%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #faad14 10%, var(--app-bg, #fff));
}

.approval-dialog__modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

:root[data-theme="dark"] .approval-dialog {
  background: #111821;
  border-color: #1f4068;
}

:root[data-theme="dark"] .approval-dialog__badge {
  color: #69b1ff;
}

:root[data-theme="dark"] .approval-dialog__chip,
:root[data-theme="dark"] .approval-dialog__panel,
:root[data-theme="dark"] .approval-dialog__btn,
:root[data-theme="dark"] .approval-dialog__textarea,
:root[data-theme="dark"] .approval-dialog__select,
:root[data-theme="dark"] .approval-dialog__conclusion,
:root[data-theme="dark"] .approval-dialog__help-btn {
  background: #141414;
  border-color: #303030;
}

:root[data-theme="dark"] .approval-dialog__btn--primary {
  background: #1668dc;
  border-color: #1668dc;
  color: #fff;
}

:root[data-theme="dark"] .approval-dialog__btn--warning {
  color: #ad6800;
  border-color: color-mix(in srgb, #faad14 44%, #303030);
  background: color-mix(in srgb, #faad14 16%, #141414);
}

:root[data-theme="dark"] .approval-dialog__btn--danger {
  color: #ff9c9c;
  border-color: color-mix(in srgb, #ff7875 50%, #303030);
  background: color-mix(in srgb, #ff4d4f 18%, #141414);
}

@media (max-width: 767px) {
  .approval-dialog__header {
    flex-direction: column;
  }

  .approval-dialog__action-row {
    grid-template-columns: 1fr;
  }
}
</style>
