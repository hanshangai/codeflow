<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { CloseOutlined, QuestionCircleOutlined } from "@ant-design/icons-vue";
import {
  isOrchestrationDeterministicRecoveryDiagnostic,
  resolveOrchestrationUserFacingMessage,
  validateInlineThreadPayload,
  type Artifact,
  type ArtifactId,
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
import { resolveNodeWorkbenchDescriptor } from "../node-workbench";
import { resolveAllowedReworkTargets } from "../rework-targets";

defineOptions({ name: "FeedbackDialog" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
  nodeState: NodeExecutionState;
  nodeLabel: string;
  artifacts?: Artifact[];
  workflowNodes?: WorkflowNode[];
  workflowEdges?: WorkflowEdge[];
}>();

const orch = useOrchestrationStore();
const chat = useChatStore();
const { ctx } = useApiContext();

const feedbackText = ref("");
const reworkDialogOpen = ref(false);
const reworkTargetNodeId = ref("");
const branchTargetNodeId = ref("");

const workbench = computed(() => resolveNodeWorkbenchDescriptor(props.nodeState));
const conclusion = computed(() => props.nodeState.conclusion ?? null);
const isBranchDecision = computed(() => workbench.value.attentionKind === "branch_decision");
const needsHumanInput = computed(() => workbench.value.attentionKind === "human_input");
const isExecutionRecovery = computed(() => workbench.value.attentionKind === "execution_error");
// 汇总节点诊断，确保历史错误也沿用自动恢复提示而不是要求用户介入。
const recoveryDiagnosticText = computed(() => [
  props.nodeState.error,
  conclusion.value?.summary,
  conclusion.value?.humanInput?.summary,
].filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("\n"));
const isDeterministicRecovery = computed(() =>
  isOrchestrationDeterministicRecoveryDiagnostic(recoveryDiagnosticText.value),
);
const displayError = computed(() => {
  const rawError = String(props.nodeState.error ?? "").trim();
  if (!rawError) return "";
  if (isDeterministicRecovery.value) {
    return resolveOrchestrationUserFacingMessage(recoveryDiagnosticText.value, "系统会先自动校对当前节点并重试。你现在不用操作，已完成内容会保留。");
  }
  if (isExecutionRecovery.value) return "节点会话在执行过程中中断了，请查看会话后再决定是否重新生成。";
  return resolveOrchestrationUserFacingMessage(rawError, "当前节点处理遇到问题，请查看当前会话后再继续。");
});
const displayConclusionSummary = computed(() =>
  resolveOrchestrationUserFacingMessage(conclusion.value?.summary, "未填写结论摘要"),
);
const displayHumanInputSummary = computed(() =>
  resolveOrchestrationUserFacingMessage(conclusion.value?.humanInput?.summary, ""),
);
const canReevaluateGates = computed(() =>
  workbench.value.attentionKind === "gate_failure"
  && (props.nodeState.gateResults ?? []).some((result) => result.evaluatorKind === "ai"),
);
const canAddFeedbackImages = computed(() => !isBranchDecision.value);
const {
  imageAttachments: feedbackImages,
  removeImage: removeFeedbackImage,
  onPaste: onFeedbackPaste,
} = useComposerAttachments({
  canAdd: canAddFeedbackImages,
  allowImages: canAddFeedbackImages,
  allowTextFiles: computed(() => false),
});
const hasFeedbackText = computed(() => Boolean(feedbackText.value.trim()));
const hasFeedbackImages = computed(() => feedbackImages.value.length > 0);
const hasSupplementInput = computed(() => hasFeedbackText.value || hasFeedbackImages.value);
const primaryAction = computed<FeedbackAction>(() => {
  if (needsHumanInput.value) return "resume_with_input";
  if (canReevaluateGates.value) return "reevaluate_gates";
  return "retry";
});
const primaryActionLabel = computed(() => {
  if (needsHumanInput.value) return "提交";
  if (canReevaluateGates.value) return "重新评估门禁";
  return "重新生成";
});
const primaryActionDisabled = computed(() =>
  needsHumanInput.value && !hasSupplementInput.value,
);
const overrideActionLabel = computed(() => {
  if (isExecutionRecovery.value) return "强制继续";
  if (workbench.value.attentionKind === "gate_failure") return "忽略门禁继续";
  return "通过";
});
// 用户填了补充说明后，"带补充继续"接管主按钮位置；此时"重新生成"降级为次要白底样式，避免双主按钮抢色
const showResumeWithSupplement = computed(() =>
  hasSupplementInput.value && !needsHumanInput.value,
);
const primaryButtonClass = computed(() =>
  showResumeWithSupplement.value ? "" : "feedback-dialog__btn--primary",
);
const summaryChipLabel = computed(() => {
  if (workbench.value.attentionKind === "branch_decision") return "当前节点等待选择分支";
  if (workbench.value.attentionKind === "human_input") return "当前节点等待补充信息";
  if (workbench.value.attentionKind === "review_decision") return "当前节点等待人工决策";
  if (workbench.value.attentionKind === "gate_failure") return "当前节点未通过门禁检查";
  if (workbench.value.attentionKind === "execution_error") return "当前节点会话异常中断";
  return "当前节点需要人工处理";
});
const visibleAcceptanceChecks = computed(() =>
  (conclusion.value?.acceptanceChecks ?? []).filter((check) => check.verdict === "pass" || check.verdict === "fail"),
);
const feedbackArtifacts = computed(() => resolveFeedbackArtifacts());
const feedbackArtifactIds = computed<ArtifactId[]>(() => feedbackArtifacts.value.map((artifact) => artifact.id));
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
const branchDecisionOptions = computed(() =>
  (props.workflowEdges ?? [])
    .filter((edge) => edge.sourceNodeId === props.nodeId)
    .map((edge) => {
      const targetNodeId = String(edge.targetNodeId ?? "").trim();
      return {
        targetNodeId,
        branchLabel: String(edge.conditionBranch ?? "").trim() || "默认分支",
        targetLabel: resolveWorkflowNodeLabel(targetNodeId),
      };
    })
    .filter((item) => item.targetNodeId),
);
const canReworkToTarget = computed(() =>
  !isExecutionRecovery.value
  && !isBranchDecision.value
  && allowedReworkTargets.value.length > 0,
);
type FeedbackConfirmConfig = {
  title: string;
  content: string;
  okText: string;
  danger?: boolean;
};
const feedbackHelpLines = computed(() => {
  if (isBranchDecision.value) {
    return [
      "选择后系统会写入当前条件节点的分支结果。",
      "未选中的命名分支会被标记为跳过。",
    ];
  }
  if (isExecutionRecovery.value) {
    return [
      "这次不是审核不通过，而是节点会话在执行过程中中断了。",
      "建议先回到左侧查看会话与错误信息，再决定是否直接重新生成。",
    ];
  }
  if (needsHumanInput.value) {
    return [
      "这里填写的是继续执行当前节点所需的补充信息或确认意见。",
      canReworkToTarget.value
        ? "如果判断应该退回上游，也可以先写退回说明，再点击驳回选择目标节点。"
        : "如果左侧交付物本身有问题，也可以先直接修订再回来提交。",
    ];
  }
  return [
    "这里可以补充为什么要重跑、应该怎么改，帮助 AI 在下一轮更准确地处理。",
    canReworkToTarget.value
      ? "如果要驳回到指定节点，这段说明会和驳回动作一起带回目标节点。点击驳回后再确认目标。"
      : "如果只是结果内容不对，也可以先去左侧直接修改交付物。",
  ];
});
const dialogHelpLines = computed(() => {
  if (isBranchDecision.value) {
    return [
      "当前条件节点配置为人工选择分支。",
      "确认选择后，流程会沿选中分支继续推进。",
    ];
  }
  if (isExecutionRecovery.value) {
    return [
      "当前节点没有形成可审核结果，而是会话执行异常中断。",
      "重新生成会以当前输入重新执行该节点；如果需要诊断原因，先查看节点会话。",
    ];
  }
  if (needsHumanInput.value) {
    return [
      "当前节点缺少必要信息，补齐后才能继续执行。",
      canReworkToTarget.value
        ? "您也可以不补齐当前节点，而是先写退回说明，再通过驳回弹框选择上游节点重做。"
        : "提交补充并继续时，会带着您填写的内容恢复当前节点。",
    ];
  }
  return [
    "重新生成会重做当前节点。",
    "通过会放行当前节点并进入后续流程。",
    canReworkToTarget.value
      ? "驳回会把问题退回指定上游节点重做。"
      : "忽略门禁或跳过节点只适合明确接受风险时使用。",
  ];
});
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

watch(
  () => branchDecisionOptions.value.map((item) => item.targetNodeId).join("|"),
  () => {
    if (branchDecisionOptions.value.some((item) => item.targetNodeId === branchTargetNodeId.value)) return;
    branchTargetNodeId.value = branchDecisionOptions.value[0]?.targetNodeId ?? "";
  },
  { immediate: true },
);

watch(canReworkToTarget, (enabled) => {
  if (!enabled) reworkDialogOpen.value = false;
});

function acceptanceVerdictLabel(verdict: string | null | undefined): string {
  if (verdict === "fail") return "未通过";
  if (verdict === "pass") return "通过";
  return "";
}

/** 将门禁原始说明转换为面向用户的短文案，保留详细诊断在运行记录中。 */
function displayGateMessage(messageText: string | null | undefined): string {
  return resolveOrchestrationUserFacingMessage(messageText, "检查未通过，请查看当前结果。");
}

/** 解析 Ask/反馈面板应随人工反馈携带的当前节点结果工件。 */
function resolveFeedbackArtifacts(): Artifact[] {
  const artifactById = new Map((props.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
  const explicitArtifacts = (props.nodeState.outputArtifactIds ?? [])
    .map((artifactId) => artifactById.get(String(artifactId) as ArtifactId))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
  if (explicitArtifacts.length) return sortArtifactsByRecency(explicitArtifacts);
  if (props.nodeState.status !== "waiting-feedback") return [];
  return sortArtifactsByRecency((props.artifacts ?? []).filter((artifact) => artifact.nodeId === props.nodeId && artifact.status !== "superseded"));
}

/** 按版本和更新时间倒序展示，保证用户先看到本轮最新结果。 */
function sortArtifactsByRecency(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((left, right) => {
    const byVersion = Number(right.version ?? 0) - Number(left.version ?? 0);
    if (byVersion !== 0) return byVersion;
    return Number(right.updatedAt ?? right.createdAt ?? 0) - Number(left.updatedAt ?? left.createdAt ?? 0);
  });
}

/** 提取工件摘要，避免反馈弹框直接展开大段正文。 */
function summarizeArtifact(artifact: Artifact): string {
  const manifestSummary = String(artifact.manifest?.summary ?? "").trim();
  if (manifestSummary) return manifestSummary;
  try {
    const parsed = JSON.parse(String(artifact.contentJson ?? "{}")) as { summary?: unknown; text?: unknown };
    const summary = String(parsed.summary ?? "").trim();
    if (summary) return summary;
    const text = String(parsed.text ?? "").replace(/\s+/g, " ").trim();
    if (text) return text.length > 140 ? `${text.slice(0, 140)}...` : text;
  } catch {
    // contentJson 不是对象时按原文摘要兜底。
  }
  const raw = String(artifact.contentJson ?? "").replace(/\s+/g, " ").trim();
  return raw.length > 140 ? `${raw.slice(0, 140)}...` : raw;
}

/** 把工件状态转成反馈面板里的短标签。 */
function artifactStatusLabel(status: Artifact["status"]): string {
  if (status === "approved") return "已通过";
  if (status === "rejected") return "已驳回";
  if (status === "superseded") return "已被替换";
  return "草稿";
}

function resolveWorkflowNodeLabel(nodeId: string | null | undefined): string {
  const normalizedId = String(nodeId ?? "").trim();
  if (!normalizedId) return "指定节点";
  return workflowNodeLabelById.value[normalizedId] ?? normalizedId;
}

/** 提交反馈动作，并把补充文本与附图一并交给编排引擎。 */
async function submitAction(action: FeedbackAction, options?: { targetNodeId?: string | null }): Promise<boolean> {
  const feedback = isBranchDecision.value ? "" : feedbackText.value.trim();
  const images = isBranchDecision.value ? [] : feedbackImages.value.map((item) => item.dataUrl);
  const budgetCheck = validateInlineThreadPayload(
    { text: feedback, images },
    { contextLabel: "当前补充说明" },
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
      feedbackArtifactIds.value,
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
        console.warn("[FeedbackDialog] failed to sync node thread running state:", error);
      }
    }
    message.success(resolveSuccessMessage(action, options?.targetNodeId ?? null));
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "操作失败");
    return false;
  }
}

function openReworkDialog() {
  if (!canReworkToTarget.value) return;
  reworkDialogOpen.value = true;
}

function closeReworkDialog() {
  reworkDialogOpen.value = false;
}

/** 二次确认会改变节点状态的反馈动作，避免误点后直接推进编排。 */
function requestFeedbackAction(action: FeedbackAction): void {
  const confirmConfig = resolveFeedbackActionConfirmConfig(action);
  if (!confirmConfig) {
    void submitAction(action);
    return;
  }
  Modal.confirm({
    title: confirmConfig.title,
    content: confirmConfig.content,
    okText: confirmConfig.okText,
    cancelText: "取消",
    okButtonProps: confirmConfig.danger ? { danger: true } : undefined,
    onOk: () => submitAction(action),
  });
}

/** 根据反馈动作生成确认文案；仅最终执行动作需要确认。 */
function resolveFeedbackActionConfirmConfig(action: FeedbackAction): FeedbackConfirmConfig | null {
  const nodeLabel = props.nodeLabel || props.nodeId;
  if (action === "abort") {
    return {
      title: "确认终止本次流程？",
      content: "确认后，当前节点会标记为失败，本次流程执行会停止；已写入工作区的文件不会自动回滚。",
      okText: "确认终止流程",
      danger: true,
    };
  }
  if (action === "skip") {
    return {
      title: `确认跳过节点「${nodeLabel}」？`,
      content: "确认后，系统会跳过当前节点并继续后续流程；如果下游依赖当前节点输出，后续节点可能失败。",
      okText: "确认跳过",
      danger: true,
    };
  }
  if (action === "retry") {
    return {
      title: `确认重新生成节点「${nodeLabel}」？`,
      content: "确认后，系统会重做当前节点，新的执行结果可能改变当前结论和产物。",
      okText: "确认重新生成",
    };
  }
  if (action === "resume_with_input") {
    return {
      title: "确认提交补充信息？",
      content: "确认后，系统会带着当前补充说明或附图恢复当前节点执行；节点不会因为提交补充而直接通过，最终结果以重新执行后的结论为准。",
      okText: "确认提交",
    };
  }
  if (action === "reevaluate_gates") {
    return {
      title: `确认重新评估门禁「${nodeLabel}」？`,
      content: "确认后将复用当前 Artifact，仅重新执行 AI 门禁评估，不重新生成产物。",
      okText: "确认重新评估",
    };
  }
  if (action === "override") {
    return resolveOverrideConfirmConfig(nodeLabel);
  }
  return null;
}

/** 根据当前待处理类型生成人工通过/放行确认文案。 */
function resolveOverrideConfirmConfig(nodeLabel: string): FeedbackConfirmConfig {
  if (isExecutionRecovery.value) {
    return {
      title: `确认强制放行节点「${nodeLabel}」？`,
      content: "确认后，系统会强制放行当前节点并继续后续流程；如果当前节点没有可靠结果，下游节点可能因为缺少输入而失败。",
      okText: "确认强制放行",
      danger: true,
    };
  }
  if (workbench.value.attentionKind === "gate_failure") {
    return {
      title: `确认忽略门禁并通过节点「${nodeLabel}」？`,
      content: "确认后，系统会忽略当前门禁未通过结果，把节点标记为通过并继续后续流程。",
      okText: "确认忽略门禁",
      danger: true,
    };
  }
  return {
    title: `确认通过节点「${nodeLabel}」？`,
    content: "确认后，系统会把当前节点标记为通过，并继续执行后续流程。",
    okText: "确认通过",
  };
}

/** 提交定向驳回，退回说明允许使用文本或附图。 */
async function submitReworkToTarget() {
  const targetNodeId = String(reworkTargetNodeId.value ?? "").trim();
  if (!targetNodeId) {
    message.warning("请先选择驳回目标节点");
    return;
  }
  if (!hasSupplementInput.value) {
    message.warning("驳回到指定节点时必须填写退回说明或粘贴附图");
    return;
  }
  const succeeded = await submitAction("rework_to_target", { targetNodeId });
  if (succeeded) closeReworkDialog();
}

/** 提交人工分支选择；目标节点必须来自当前条件节点出边。 */
async function submitBranchChoice(): Promise<void> {
  const targetNodeId = String(branchTargetNodeId.value ?? "").trim();
  if (!targetNodeId) {
    message.warning("请先选择分支");
    return;
  }
  await submitAction("choose_branch", { targetNodeId });
}

/** 根据反馈动作生成提交后的短提示。 */
function resolveSuccessMessage(action: FeedbackAction, targetNodeId: string | null): string {
  if (action === "retry") return "将重新执行当前节点";
  if (action === "reevaluate_gates") return "已发起门禁重新评估，当前 Artifact 保持不变";
  if (action === "resume_with_input") {
    return needsHumanInput.value ? "已提交补充信息，当前节点将继续执行" : "已带着补充说明继续执行";
  }
  if (action === "override") {
    if (isExecutionRecovery.value) return "已强制放行当前节点并继续后续流程";
    if (workbench.value.attentionKind === "gate_failure") return "已忽略门禁并继续后续流程";
    return "已通过节点并继续后续流程";
  }
  if (action === "rework_to_target") {
    return `已退回到 ${resolveWorkflowNodeLabel(targetNodeId)}`;
  }
  if (action === "choose_branch") return `已选择分支，后续将进入 ${resolveWorkflowNodeLabel(targetNodeId)}`;
  if (action === "skip") return "已跳过节点";
  return "已终止编排";
}

</script>

<template>
  <div class="feedback-dialog">
    <div class="feedback-dialog__header">
      <span class="feedback-dialog__badge">{{ workbench.badgeLabel ?? "需处理" }}</span>
      <div class="feedback-dialog__summary">
        <div class="feedback-dialog__title-row">
          <h4>{{ nodeLabel }}</h4>
          <a-popover trigger="click" placement="bottomLeft" :arrow="false">
            <template #content>
              <div class="feedback-dialog__help-popover">
                <strong>处理说明</strong>
                <p v-for="line in dialogHelpLines" :key="line">{{ line }}</p>
              </div>
            </template>
            <button type="button" class="feedback-dialog__help-btn" aria-label="查看处理说明">
              <QuestionCircleOutlined />
            </button>
          </a-popover>
        </div>
      </div>
    </div>

    <div class="feedback-dialog__body">
      <div class="feedback-dialog__meta">
        <span class="feedback-dialog__chip">{{ summaryChipLabel }}</span>
        <span v-if="nodeState.gateResults?.length" class="feedback-dialog__chip">未通过 {{ nodeState.gateResults?.length }} 条检查</span>
        <span v-else-if="isExecutionRecovery" class="feedback-dialog__chip">建议先查看会话与错误信息</span>
      </div>

      <div v-if="displayError" class="feedback-dialog__error">
        <strong>{{ isExecutionRecovery ? "中断原因" : "当前原因" }}</strong>
        <pre>{{ displayError }}</pre>
      </div>

      <div v-if="conclusion" class="feedback-dialog__conclusion">
        <div class="feedback-dialog__conclusion-head">
          <strong>业务结论：{{ conclusion.reviewVerdict === "fail" ? "不通过" : conclusion.reviewVerdict === "partial" ? "部分满足" : "通过" }}</strong>
          <span>{{ displayConclusionSummary }}</span>
        </div>
        <div v-if="displayHumanInputSummary" class="feedback-dialog__conclusion-note">
          {{ displayHumanInputSummary }}
        </div>
        <div v-if="visibleAcceptanceChecks.length" class="feedback-dialog__check-summary">
          <span>{{ `验收检查 ${visibleAcceptanceChecks.length} 条` }}</span>
          <a-popover trigger="click" placement="bottomLeft" :arrow="false">
            <template #content>
              <div class="feedback-dialog__help-popover">
                <strong>验收检查明细</strong>
                <p v-for="line in acceptanceCheckHelpLines" :key="line">{{ line }}</p>
              </div>
            </template>
            <button type="button" class="feedback-dialog__help-btn" aria-label="查看验收检查明细">
              <QuestionCircleOutlined />
            </button>
          </a-popover>
        </div>
      </div>

      <div v-if="!isBranchDecision && feedbackArtifacts.length" class="feedback-dialog__panel feedback-dialog__panel--artifacts">
        <div class="feedback-dialog__field-head">
          <label>关联结果</label>
          <span class="feedback-dialog__artifact-count">{{ feedbackArtifacts.length }} 份</span>
        </div>
        <div class="feedback-dialog__artifact-list">
          <div v-for="artifact in feedbackArtifacts" :key="artifact.id" class="feedback-dialog__artifact-item">
            <div class="feedback-dialog__artifact-title">
              <strong>{{ artifact.title || artifact.kind }}</strong>
              <span>{{ artifactStatusLabel(artifact.status) }}</span>
            </div>
            <p>{{ summarizeArtifact(artifact) || "暂无摘要" }}</p>
          </div>
        </div>
      </div>

      <div v-if="nodeState.gateResults?.length" class="feedback-dialog__results">
        <div class="feedback-dialog__results-list">
          <div v-for="gr in nodeState.gateResults" :key="gr.criterionId" class="feedback-dialog__result-item">
            <span class="feedback-dialog__dot" :style="{ backgroundColor: gr.passed ? '#52c41a' : '#ff4d4f' }" />
            <span :class="gr.passed ? '' : 'feedback-dialog__fail'">{{ displayGateMessage(gr.message) }}</span>
          </div>
        </div>
      </div>

      <div v-if="isBranchDecision" class="feedback-dialog__panel feedback-dialog__panel--branch">
        <div class="feedback-dialog__field-head">
          <label>选择分支</label>
          <a-popover trigger="click" placement="bottomLeft" :arrow="false">
            <template #content>
              <div class="feedback-dialog__help-popover">
                <strong>分支选择</strong>
                <p v-for="line in feedbackHelpLines" :key="line">{{ line }}</p>
              </div>
            </template>
            <button type="button" class="feedback-dialog__help-btn" aria-label="查看分支选择提示">
              <QuestionCircleOutlined />
            </button>
          </a-popover>
        </div>
        <div v-if="branchDecisionOptions.length" class="feedback-dialog__branch-list">
          <label
            v-for="option in branchDecisionOptions"
            :key="option.targetNodeId"
            class="feedback-dialog__branch-option"
            :class="{ 'feedback-dialog__branch-option--active': branchTargetNodeId === option.targetNodeId }"
          >
            <input v-model="branchTargetNodeId" type="radio" :value="option.targetNodeId" />
            <span>
              <strong>{{ option.branchLabel }}</strong>
              <small>{{ option.targetLabel }}</small>
            </span>
          </label>
        </div>
        <div v-else class="feedback-dialog__hint-inline">
          当前条件节点没有可选出边，请关闭弹框后终止流程并修正流程模板。
        </div>
      </div>

      <div v-else class="feedback-dialog__panel feedback-dialog__panel--feedback">
        <div class="feedback-dialog__field-head">
          <label>补充说明（可选）</label>
          <a-popover trigger="click" placement="bottomLeft" :arrow="false">
            <template #content>
              <div class="feedback-dialog__help-popover">
                <strong>补充说明</strong>
                <p v-for="line in feedbackHelpLines" :key="line">{{ line }}</p>
              </div>
            </template>
            <button type="button" class="feedback-dialog__help-btn" aria-label="查看补充说明提示">
              <QuestionCircleOutlined />
            </button>
          </a-popover>
        </div>
        <textarea
          v-model="feedbackText"
          class="feedback-dialog__textarea"
          rows="6"
          :placeholder="needsHumanInput ? '按上面的补充要求填写缺失信息、文件路径或确认意见。' : '例如：请补齐测试方式，或明确写出这次驳回需要修改的地方。'"
          @paste="onFeedbackPaste"
        />
        <div v-if="feedbackImages.length" class="feedback-dialog__attachments" aria-label="补充说明附图">
          <div v-for="image in feedbackImages" :key="image.id" class="feedback-dialog__attachment">
            <img :src="image.dataUrl" :alt="image.name" />
            <button type="button" title="移除附图" aria-label="移除附图" @click="removeFeedbackImage(image.id)">
              <CloseOutlined />
            </button>
          </div>
        </div>
      </div>

    </div>

    <div v-if="isBranchDecision" class="feedback-dialog__footer">
      <span class="feedback-dialog__footer-spacer" aria-hidden="true" />
      <button
        class="feedback-dialog__btn feedback-dialog__btn--primary"
        :disabled="!branchTargetNodeId"
        @click="submitBranchChoice"
      >
        确认选择
      </button>
    </div>

    <div v-else class="feedback-dialog__footer">
      <!-- 左侧：破坏/退出动作，使用 outline/灰，远离主按钮防误点 -->
      <button class="feedback-dialog__btn feedback-dialog__btn--danger-outline" @click="requestFeedbackAction('abort')">
        终止流程
      </button>
      <button class="feedback-dialog__btn feedback-dialog__btn--subtle" @click="requestFeedbackAction('skip')">
        跳过
      </button>
      <span class="feedback-dialog__footer-spacer" aria-hidden="true" />
      <!-- 右侧：推进/采纳动作，由弱到强；主按钮在最右 -->
      <button
        v-if="canReworkToTarget"
        class="feedback-dialog__btn feedback-dialog__btn--warning-outline"
        @click="openReworkDialog"
      >
        驳回
      </button>
      <button class="feedback-dialog__btn feedback-dialog__btn--warning" @click="requestFeedbackAction('override')">
        {{ overrideActionLabel }}
      </button>
      <button
        class="feedback-dialog__btn"
        :class="primaryButtonClass"
        :disabled="primaryActionDisabled"
        @click="requestFeedbackAction(primaryAction)"
      >
        {{ primaryActionLabel }}
      </button>
      <button
        v-if="showResumeWithSupplement"
        class="feedback-dialog__btn feedback-dialog__btn--primary"
        @click="requestFeedbackAction('resume_with_input')"
      >
        带补充继续
      </button>
    </div>
  </div>

  <a-modal
    :open="reworkDialogOpen"
    title="驳回到指定节点"
    :width="480"
    :mask-closable="false"
    destroy-on-close
    @cancel="closeReworkDialog"
  >
    <div class="feedback-dialog__rework-modal">
      <div class="feedback-dialog__rework-copy">
        <strong>选择退回目标</strong>
        <span>退回说明会直接使用主面板里的“补充说明”，并和驳回动作一起带回目标节点。</span>
      </div>
      <div class="feedback-dialog__rework-field">
        <label for="feedback-dialog-rework-target">目标节点</label>
        <select id="feedback-dialog-rework-target" v-model="reworkTargetNodeId" class="feedback-dialog__select">
          <option v-for="target in allowedReworkTargets" :key="target.id" :value="target.id">
            {{ target.label }}
          </option>
        </select>
      </div>
      <div
        class="feedback-dialog__rework-note"
        :class="{ 'feedback-dialog__rework-note--warning': !hasSupplementInput }"
      >
        {{ hasSupplementInput ? "已检测到退回说明或附图，可直接确认驳回。" : "请先在主面板填写退回说明或粘贴附图，再确认驳回。" }}
      </div>
    </div>
    <template #footer>
      <div class="feedback-dialog__modal-footer">
        <button class="feedback-dialog__btn feedback-dialog__btn--subtle" @click="closeReworkDialog">
          取消
        </button>
        <button
          class="feedback-dialog__btn feedback-dialog__btn--warning-outline"
          :disabled="!reworkTargetNodeId || !hasSupplementInput"
          @click="submitReworkToTarget"
        >
          确认驳回
        </button>
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
.feedback-dialog {
  border: 1px solid color-mix(in srgb, #faad14 35%, var(--app-border, #d9d9d9));
  border-radius: 12px;
  padding: 14px;
  background: color-mix(in srgb, #faad14 4%, var(--app-bg, #fff));
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 100%;
  overflow: hidden;
}

.feedback-dialog__header {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.feedback-dialog__summary {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.feedback-dialog__title-row,
.feedback-dialog__field-head,
.feedback-dialog__check-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.feedback-dialog__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 58px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, #faad14 18%, transparent);
  color: #ad6800;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}

.feedback-dialog__summary h4 {
  margin: 0;
  color: var(--app-text, #222);
  font-size: 14px;
}

.feedback-dialog__body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
  padding-right: 4px;
}

.feedback-dialog__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.feedback-dialog__chip {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, #1677ff 8%, var(--app-bg, #fff));
  color: var(--app-muted, #666);
  font-size: 12px;
}

.feedback-dialog__error {
  display: grid;
  gap: 6px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, #ff4d4f 28%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #ff4d4f 6%, var(--app-bg, #fff));
}

.feedback-dialog__error strong {
  font-size: 12px;
  color: #cf1322;
}

.feedback-dialog__error pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-text, #222);
}

.feedback-dialog__conclusion,
.feedback-dialog__panel {
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border, #d9d9d9);
  background: var(--app-bg, #fff);
  display: grid;
  gap: 10px;
}

.feedback-dialog__panel--feedback {
  display: flex;
  flex: 1 0 180px;
  min-height: 180px;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
}

.feedback-dialog__panel--branch {
  gap: 12px;
}

.feedback-dialog__panel--artifacts {
  gap: 8px;
}

.feedback-dialog__artifact-count {
  color: var(--app-muted, #666);
  font-size: 12px;
}

.feedback-dialog__artifact-list {
  display: grid;
  gap: 8px;
}

.feedback-dialog__artifact-item {
  display: grid;
  gap: 4px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 72%, transparent);
}

.feedback-dialog__artifact-item:first-child {
  padding-top: 0;
  border-top: 0;
}

.feedback-dialog__artifact-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.feedback-dialog__artifact-title strong {
  min-width: 0;
  overflow: hidden;
  color: var(--app-text, #222);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feedback-dialog__artifact-title span {
  flex-shrink: 0;
  color: var(--app-muted, #666);
  font-size: 11px;
}

.feedback-dialog__artifact-item p {
  margin: 0;
  color: var(--app-muted, #666);
  font-size: 12px;
  line-height: 1.6;
}

.feedback-dialog__branch-list {
  display: grid;
  gap: 8px;
}

.feedback-dialog__branch-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border, #d9d9d9);
  background: var(--app-bg, #fff);
  cursor: pointer;
}

.feedback-dialog__branch-option--active {
  border-color: color-mix(in srgb, #1677ff 58%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #1677ff 7%, var(--app-bg, #fff));
}

.feedback-dialog__branch-option span {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.feedback-dialog__branch-option strong {
  font-size: 13px;
  color: var(--app-text, #222);
}

.feedback-dialog__branch-option small {
  font-size: 12px;
  color: var(--app-muted, #666);
}

.feedback-dialog__conclusion-head {
  display: grid;
  gap: 4px;
}

.feedback-dialog__conclusion-head strong {
  font-size: 13px;
  color: var(--app-text, #222);
}

.feedback-dialog__conclusion-head span,
.feedback-dialog__conclusion-note,
.feedback-dialog__result-item,
.feedback-dialog__help-popover p,
.feedback-dialog__hint-inline {
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-muted, #666);
}

.feedback-dialog__results-list {
  display: grid;
  gap: 8px;
}

.feedback-dialog__result-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.feedback-dialog__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.feedback-dialog__fail {
  color: #cf1322;
}

.feedback-dialog__textarea,
.feedback-dialog__select {
  width: 100%;
  border-radius: 10px;
  border: 1px solid var(--app-border, #d9d9d9);
  background: var(--app-bg, #fff);
  color: var(--app-text, #222);
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
}

.feedback-dialog__textarea {
  flex: 1 1 auto;
  resize: vertical;
  min-height: 120px;
  height: 100%;
}

.feedback-dialog__attachments {
  display: flex;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  padding-bottom: 2px;
}

.feedback-dialog__attachment {
  position: relative;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 8px;
  overflow: hidden;
  background: color-mix(in srgb, var(--app-bg, #fff) 92%, var(--app-hover-bg, #fafafa));
}

.feedback-dialog__attachment img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.feedback-dialog__attachment button {
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

.feedback-dialog__radio-line {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #595959;
  font-size: 13px;
  line-height: 1.5;
}

.feedback-dialog__select {
  min-height: 40px;
  padding-top: 0;
  padding-bottom: 0;
}

.feedback-dialog__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--app-border, #d9d9d9);
}

/* 左右分组的弹性占位：宽屏时把推进组推到右侧；窄屏 wrap 后 spacer 自动收缩 */
.feedback-dialog__footer-spacer {
  flex: 1 1 auto;
  min-width: 0;
}

.feedback-dialog__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 8px 14px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 999px;
  background: var(--app-bg, #fff);
  cursor: pointer;
  font-size: 12px;
  color: var(--app-text, #222);
}

.feedback-dialog__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.feedback-dialog__btn--primary {
  background: #1677ff;
  color: #fff;
  border-color: #1677ff;
}

.feedback-dialog__btn--warning {
  color: #ad6800;
  border-color: color-mix(in srgb, #faad14 40%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #faad14 12%, var(--app-bg, #fff));
}

.feedback-dialog__btn--warning-outline {
  color: #ad6800;
  border-color: color-mix(in srgb, #faad14 48%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #faad14 7%, var(--app-bg, #fff));
}

.feedback-dialog__btn--danger-outline {
  color: #cf1322;
  border-color: color-mix(in srgb, #ff4d4f 42%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #ff4d4f 5%, var(--app-bg, #fff));
}

.feedback-dialog__btn--subtle {
  color: var(--app-muted, #666);
}

.feedback-dialog__btn--danger {
  border-color: color-mix(in srgb, #ff4d4f 42%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #ff4d4f 8%, var(--app-bg, #fff));
  color: #cf1322;
  font-weight: 600;
}

.feedback-dialog__help-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 999px;
  background: transparent;
  color: var(--app-muted, #666);
  cursor: pointer;
}

.feedback-dialog__help-popover {
  max-width: 360px;
  display: grid;
  gap: 6px;
}

.feedback-dialog__help-popover strong {
  font-size: 12px;
  color: var(--app-text, #222);
}

.feedback-dialog__help-popover p {
  margin: 0;
}

.feedback-dialog__rework-modal {
  display: grid;
  gap: 14px;
}

.feedback-dialog__rework-copy,
.feedback-dialog__rework-field {
  display: grid;
  gap: 8px;
}

.feedback-dialog__rework-copy strong,
.feedback-dialog__rework-field label {
  font-size: 13px;
  color: var(--app-text, #222);
}

.feedback-dialog__rework-copy span,
.feedback-dialog__rework-note {
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted, #666);
}

.feedback-dialog__rework-note {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 14%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 5%, var(--app-bg, #fff));
}

.feedback-dialog__rework-note--warning {
  color: #ad6800;
  border-color: color-mix(in srgb, #faad14 34%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #faad14 10%, var(--app-bg, #fff));
}

.feedback-dialog__modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
