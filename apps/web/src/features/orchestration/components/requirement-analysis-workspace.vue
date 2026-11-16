<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { resolveThreadPrefsWithCatalogDefaults } from "@codeflowai/shared";
import type { EngineType, RequirementAnalysisQuestionImpact, RequirementCandidateDraft, RequirementCandidateId, TaskIntake, ThreadId, WorkflowId, WorkflowProposal, WorkspaceId } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { isApiResultError, isCancelledRequestError } from "../../../api/request";
import ChatPanel from "../../chat/components/chat-panel.vue";
import CreateThreadModal from "../../threads/components/create-thread-modal.vue";
import WorkflowGraphView from "./workflow-graph-view.vue";
import RequirementClarificationPanel from "./requirement-clarification-panel.vue";
import {
  areAllClarificationsStaged,
  buildClarificationBatchFingerprint,
  buildCombinedClarificationReply,
  countRemainingClarificationCandidates,
  countRemainingClarificationItems,
  countStagedClarificationCandidates,
  findClarificationBatchCandidateFingerprint,
  pruneStagedClarificationEntries,
  type ClarificationBatchCandidateInput,
  type StagedClarificationEntryMap,
} from "../clarificationBatchState";
import { useChatStore } from "../../../store/chat";
import { useEngineStore } from "../../../store/engine";
import { useOrchestrationStore } from "../../../store/orchestration";
import { resolveRequirementAnalysisRuntimeThreadId, useRequirementAnalysisStore } from "../../../store/requirementAnalysis";
import { useCreateThreadEngineAvailability } from "../../threads/useCreateThreadEngineAvailability";

defineOptions({ name: "RequirementAnalysisWorkspace" });

const props = defineProps<{ workspaceId: WorkspaceId }>();

const { ctx } = useApiContext();
const chat = useChatStore();
const engines = useEngineStore();
const orch = useOrchestrationStore();
const analysis = useRequirementAnalysisStore();
const selectedCandidateIds = ref<RequirementCandidateId[]>([]);
const candidateWorkflowOverrides = ref<Record<string, WorkflowId | null>>({});
const createOpen = ref(false);
const creating = ref(false);
const candidateDetailOpen = ref(false);
const activeCandidateId = ref<RequirementCandidateId | null>(null);
const clarificationDispatching = ref(false);
const stagedClarificationReplies = ref<StagedClarificationEntryMap>({});
const dispatchedClarificationBatchFingerprint = ref<string | null>(null);
const { disabledEngines: createDisabledEngines, refreshEngineAvailability } = useCreateThreadEngineAvailability(computed(() => props.workspaceId));

type CandidateWorkflowChoiceLike = {
  id?: string | null;
  creationState?: string | null;
  readyToCreate: boolean;
  recommendedWorkflowId?: string | null;
  clarificationItems?: ClarificationViewItem[];
  openQuestions: string[];
  assetGaps: Array<{ severity?: string | null; suggestion?: string | null; message: string }>;
  phasingAssessment?: RequirementCandidateDraft["phasingAssessment"] | null;
};

function isCreatedCandidate(candidate: { creationState?: string | null }): boolean {
  return candidate.creationState === "created";
}

function resolveCandidateWorkflowId(candidate: CandidateWorkflowChoiceLike | null | undefined): WorkflowId | null {
  const candidateId = String(candidate?.id ?? "").trim();
  const overrideWorkflowId = candidateId ? String(candidateWorkflowOverrides.value[candidateId] ?? "").trim() : "";
  if (overrideWorkflowId) return overrideWorkflowId as WorkflowId;
  const recommendedWorkflowId = String(candidate?.recommendedWorkflowId ?? "").trim();
  return recommendedWorkflowId ? recommendedWorkflowId as WorkflowId : null;
}

function resolveCandidateWorkflow(
  candidate: CandidateWorkflowChoiceLike | null | undefined,
) {
  const workflowId = resolveCandidateWorkflowId(candidate);
  if (!workflowId) return null;
  return orch.workflows.find((item) => item.id === workflowId) ?? null;
}

function candidateHasBlockingGap(candidate: CandidateWorkflowChoiceLike): boolean {
  return candidate.assetGaps.some((gap) => gap.severity === "blocking");
}

function canCreateCandidate(candidate: CandidateWorkflowChoiceLike): boolean {
  if (isCreatedCandidate(candidate)) return false;
  if (!resolveCandidateWorkflow(candidate)) return false;
  if (candidateHasBlockingGap(candidate)) return false;
  if (resolvePhasingAssessment(candidate).scopeDecision === "needs-split") return false;
  if (resolvedClarificationItems(candidate).length > 0) return false;
  return Boolean(candidate.readyToCreate || !candidate.recommendedWorkflowId);
}

function candidateNeedsWorkflowChoice(candidate: CandidateWorkflowChoiceLike): boolean {
  return !isCreatedCandidate(candidate)
    && !resolveCandidateWorkflow(candidate)
    && !candidateHasBlockingGap(candidate)
    && resolvedClarificationItems(candidate).length === 0;
}

function candidateStatusLabel(candidate: CandidateWorkflowChoiceLike): string {
  if (isCreatedCandidate(candidate)) return "已创建";
  if (candidateNeedsWorkflowChoice(candidate)) return "待选流程";
  return canCreateCandidate(candidate) ? "可创建" : "待澄清";
}

function candidateStatusVariant(candidate: CandidateWorkflowChoiceLike): "created" | "true" | "blocked" {
  if (isCreatedCandidate(candidate)) return "created";
  return canCreateCandidate(candidate) ? "true" : "blocked";
}

type ClarificationViewItem = {
  question: string;
  reason: string;
  suggestion: string;
  impact: RequirementAnalysisQuestionImpact;
  options: Array<{ id: string; label: string; value: string; recommended?: boolean }>;
  allowCustom?: boolean;
  answerPlaceholder?: string | null;
};

type CandidateViewLike = {
  creationState?: string | null;
  title: string;
  complexity?: string | null;
  recommendedApproach?: string | null;
  recommendedWorkflowName?: string | null;
  clarificationItems?: ClarificationViewItem[];
  openQuestions: string[];
  assetGaps: Array<{ message: string; suggestion?: string | null }>;
  phasingAssessment?: RequirementCandidateDraft["phasingAssessment"] | null;
  sizeAssessment?: RequirementCandidateDraft["sizeAssessment"] | null;
};

const GENERIC_CLARIFICATION_OPTION_LABELS = new Set(["直接补充", "按 AI 建议补充"]);

function firstClarification(candidate: {
  creationState?: string | null;
  clarificationItems?: ClarificationViewItem[];
  openQuestions: string[];
  assetGaps: Array<{ message: string; suggestion?: string | null }>;
}): { question: string; suggestion: string; optionLabel: string } | null {
  if (isCreatedCandidate(candidate)) {
    return null;
  }
  const firstItem = resolvedClarificationItems(candidate)[0];
  const recommendedOptionLabel = firstItem
    ? resolveMeaningfulClarificationOptionLabel(firstItem.options.find((option) => option.recommended)?.label)
    : "";
  if (firstItem) {
    return {
      question: firstItem.question,
      suggestion: firstItem.suggestion,
      optionLabel: recommendedOptionLabel,
    };
  }
  return null;
}

/** 解析真正阻塞创建的澄清项；非阻塞 openQuestions 不进入补充交互。 */
function resolvedClarificationItems(candidate: {
  creationState?: string | null;
  clarificationItems?: ClarificationViewItem[];
  openQuestions: string[];
  assetGaps: Array<{ message: string; suggestion?: string | null }>;
}): ClarificationViewItem[] {
  if (isCreatedCandidate(candidate)) return [];
  if (Array.isArray(candidate.clarificationItems) && candidate.clarificationItems.length > 0) {
    return candidate.clarificationItems.map((item) => ({
      question: item.question,
      reason: item.reason || "需要先补齐这项信息，才能继续确认流程和验收边界。",
      suggestion: item.suggestion,
      impact: item.impact || "scope",
      options: Array.isArray(item.options) && item.options.length > 0
        ? item.options
        : [{
          id: "direct-input",
          label: "直接补充",
          value: "我来直接补充这项信息：",
          recommended: true,
        }],
      allowCustom: item.allowCustom !== false,
      answerPlaceholder: item.answerPlaceholder || "直接补充您的选择、范围、字段或交互要求。",
    }));
  }
  if (candidate.assetGaps[0]?.message) {
    return [{
      question: candidate.assetGaps[0].message,
      reason: "当前工作区仍缺少关键业务资料或可复用执行资产，暂时不能直接创建需求。",
      suggestion: candidate.assetGaps[0].suggestion || "请先补齐这部分业务资料或执行资产，必要时再新增相关流程、角色、知识库或工具后继续。",
      impact: "assets",
      options: [{
        id: "follow-suggestion",
        label: "按 AI 建议补充",
        value: candidate.assetGaps[0].suggestion || "请先补齐这部分业务资料或执行资产，必要时再新增相关流程、角色、知识库或工具后继续。",
        recommended: true,
      }],
      allowCustom: true,
      answerPlaceholder: "也可以直接补充业务资料、规则约束，或说明需要新增的流程、角色、知识库或工具信息。",
    }];
  }
  return [];
}

function shouldShowClarificationReason(reason: string): boolean {
  return String(reason ?? "").trim() !== "需要先补齐这项信息，才能继续确认流程和验收边界。";
}

function sizeLabel(size: string | null | undefined): string {
  if (size === "small") return "小型需求";
  if (size === "large") return "大型需求";
  if (size === "standard") return "中型需求";
  return "规模待评估";
}

function deliverySliceLabel(slice: string | null | undefined): string {
  if (slice === "phase-1") return "一期候选";
  if (slice === "follow-up") return "后续候选";
  return "单阶段候选";
}

function scopeDecisionLabel(scopeDecision: string | null | undefined): string {
  return scopeDecision === "needs-split" ? "仍需拆分" : "边界已收敛";
}

function resolveMeaningfulClarificationOptionLabel(label: string | null | undefined): string {
  const normalized = String(label ?? "").trim();
  if (!normalized || GENERIC_CLARIFICATION_OPTION_LABELS.has(normalized)) {
    return "";
  }
  return normalized;
}

function buildRecommendedApproachFallback(candidate: CandidateViewLike): string {
  const workflowName = String(candidate.recommendedWorkflowName ?? "").trim();
  const needsClarification = resolvedClarificationItems(candidate).length > 0;
  if (needsClarification) {
    return `建议先把“${candidate.title}”的范围、交互和验收口径补齐，再进入 ${workflowName || "正式流程"}，避免前端页面边界反复返工。`;
  }
  return `建议按当前推荐流程 ${workflowName || "继续推进"}，先锁定页面边界、演示链路和后续 Node.js 对接预留，再直接创建需求并同步生成方案。`;
}

function resolveRecommendedApproach(candidate: CandidateViewLike | null | undefined): string {
  if (!candidate) return "";
  const fromCandidate = String(candidate.recommendedApproach ?? "").trim();
  return fromCandidate || buildRecommendedApproachFallback(candidate);
}

function buildSizeAssessmentSummaryFallback(candidate: CandidateViewLike, size: string): string {
  const label = sizeLabel(size);
  const needsClarification = resolvedClarificationItems(candidate).length > 0;
  if (needsClarification) {
    return `当前先按已有信息把这条候选归为${label}；不过历史候选或旧版运行结果未记录功能过程、领域对象、状态流转等详细规模维度，建议补齐澄清后再细化评分。`;
  }
  return `当前先按已有候选信息把这条需求归为${label}；如果需要更细的规模拆解，请在下一轮补充功能过程、领域对象、状态流转、交互界面、外部集成、异步一致性风险和交付端面。`;
}

function resolveSizeAssessment(candidate: CandidateViewLike | null | undefined): RequirementCandidateDraft["sizeAssessment"] {
  const raw = candidate?.sizeAssessment;
  const rawSize = String(raw?.size ?? "").trim();
  const normalizedSize = rawSize && rawSize !== "unknown"
    ? rawSize
    : String(candidate?.complexity ?? "").trim() || "unknown";
  return {
    model: raw?.model === "legacy-matrix-v1" ? "legacy-matrix-v1" : "functional-size-v2",
    size: normalizedSize as RequirementCandidateDraft["sizeAssessment"]["size"],
    score: Number(raw?.score ?? 0) > 0 ? Number(raw?.score ?? 0) : 0,
    summary: String(raw?.summary ?? "").trim() || buildSizeAssessmentSummaryFallback(candidate ?? {
      title: "",
      openQuestions: [],
      assetGaps: [],
    }, normalizedSize),
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
}

function resolvePhasingAssessment(
  candidate: { phasingAssessment?: RequirementCandidateDraft["phasingAssessment"] | null } | null | undefined,
): RequirementCandidateDraft["phasingAssessment"] {
  const raw = candidate?.phasingAssessment;
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
}

const selectedSession = computed(() => analysis.selectedSession);
const selectedSessionReadOnly = computed(() => Boolean(selectedSession.value?.readOnly || selectedSession.value?.sharedContext?.readOnly));
const selectedThreadId = computed(() => resolveRequirementAnalysisRuntimeThreadId(selectedSession.value));
const selectedConversation = computed(() => chat.threadDisplayConversationForThread(selectedThreadId.value));
const selectedRunningTurnId = computed(() => chat.threadDisplayRunningStateForThread(selectedThreadId.value)?.runningTurnId ?? null);
const candidates = computed(() => analysis.candidates);
const selectedCount = computed(() => selectedCandidateIds.value.length);
const readyCount = computed(() => candidates.value.filter((item) => canCreateCandidate(item)).length);
const createdCount = computed(() => candidates.value.filter((item) => isCreatedCandidate(item)).length);
const pendingCount = computed(() => Math.max(candidates.value.length - readyCount.value - createdCount.value, 0));
const activeCandidate = computed(() =>
  candidates.value.find((item) => item.id === activeCandidateId.value) ?? null,
);
const pendingClarificationCandidates = computed(() =>
  candidates.value.filter((item) => !isCreatedCandidate(item) && !canCreateCandidate(item) && resolvedClarificationItems(item).length > 0),
);
const clarificationBatchCandidates = computed<ClarificationBatchCandidateInput[]>(() =>
  pendingClarificationCandidates.value.map((candidate) => ({
    candidateId: candidate.id,
    title: candidate.title,
    clarificationItems: resolvedClarificationItems(candidate),
  })),
);
const clarificationBatchFingerprint = computed(() =>
  buildClarificationBatchFingerprint(clarificationBatchCandidates.value),
);
const stagedClarificationCount = computed(() =>
  countStagedClarificationCandidates(clarificationBatchCandidates.value, stagedClarificationReplies.value),
);
const remainingClarificationCandidateCount = computed(() =>
  countRemainingClarificationCandidates(clarificationBatchCandidates.value, stagedClarificationReplies.value),
);
const remainingClarificationItemCount = computed(() =>
  countRemainingClarificationItems(clarificationBatchCandidates.value, stagedClarificationReplies.value),
);
const totalClarificationItemCount = computed(() =>
  clarificationBatchCandidates.value.reduce((sum, candidate) => sum + candidate.clarificationItems.length, 0),
);
const activeWorkflow = computed(() => {
  return resolveCandidateWorkflow(activeCandidate.value);
});
const activeCandidateWorkflowId = computed(() => String(resolveCandidateWorkflowId(activeCandidate.value) ?? ""));
const workflowChoices = computed(() => orch.workflows.map((item) => ({
  id: item.id,
  name: item.name,
  family: item.family,
  nodeCount: item.nodes.length,
})));
const roleNameById = computed<Record<string, string>>(() =>
  Object.fromEntries(
    orch.roles
      .map((role) => [String(role.id), String(role.name ?? "").trim()] as const)
      .filter((entry) => entry[0] && entry[1]),
  ),
);
const activeWorkflowSummaryChips = computed(() => {
  if (!activeWorkflow.value) return [];
  const chips = [];
  if (activeWorkflow.value.family) chips.push(`流程类型：${activeWorkflow.value.family}`);
  chips.push(`${activeWorkflow.value.nodes.length} 个节点`);
  chips.push(`${activeWorkflow.value.edges.length} 条连线`);
  return chips;
});
const createDisabledReason = computed(() => {
  if (selectedSessionReadOnly.value) return "这条共享草稿只读，不能创建正式需求。";
  if (analysis.creatingIntakes) return "正在创建中，请稍候。";
  if (!candidates.value.length) return "还没有识别到候选需求。";
  if (selectedCount.value > 0) return "";
  if (readyCount.value > 0) return "请先勾选至少一个已匹配流程的候选需求。";
  if (pendingCount.value > 0) return "当前候选需求都还待澄清，先补充信息后才能创建。";
  return "当前还没有可创建的候选需求。";
});
const candidateActionsHint = computed(() => {
  if (!createDisabledReason.value) return "";
  if (selectedCount.value === 0 && readyCount.value === 0 && pendingCount.value > 0) return "";
  return createDisabledReason.value;
});
const catalogSyncBlocked = computed(() => {
  const state = engines.byWorkspaceId[String(props.workspaceId)]?.hostCatalogSyncState ?? null;
  return state === "waiting" || state === "unsupported" || state === "offline";
});
const canSubmitClarification = computed(() =>
  Boolean(selectedThreadId.value)
  && !selectedSessionReadOnly.value
  && !selectedConversation.value?.invalidated
  && !catalogSyncBlocked.value
  && !selectedRunningTurnId.value,
);
const clarificationBatchSending = computed(() =>
  clarificationDispatching.value || Boolean(selectedRunningTurnId.value),
);
const clarificationBatchDispatched = computed(() =>
  Boolean(
    dispatchedClarificationBatchFingerprint.value
    && dispatchedClarificationBatchFingerprint.value === clarificationBatchFingerprint.value,
  ),
);
const clarificationBatchReminder = computed(() => {
  const candidateCount = clarificationBatchCandidates.value.length;
  if (!candidateCount) return "";
  if (clarificationBatchSending.value && clarificationBatchDispatched.value) {
    return "已把全部澄清发给需求助手，等待本轮更新。";
  }
  if (clarificationBatchDispatched.value) {
    return "全部澄清已发送，等待需求助手更新候选结果。";
  }
  if (stagedClarificationCount.value === 0) {
    return `当前共有 ${candidateCount} 条候选、${totalClarificationItemCount.value} 项待补充；全部补齐后才会统一发送给需求助手。`;
  }
  return `已暂存 ${stagedClarificationCount.value}/${candidateCount} 条候选澄清，还差 ${remainingClarificationCandidateCount.value} 条候选 / ${remainingClarificationItemCount.value} 项，补齐后才会统一发送给需求助手。`;
});
const clarificationInlineSummary = computed(() => {
  const candidateCount = clarificationBatchCandidates.value.length;
  if (!candidateCount) return "";
  if (clarificationBatchSending.value && clarificationBatchDispatched.value) {
    return "统一发送中";
  }
  if (clarificationBatchDispatched.value) {
    return "已发送";
  }
  if (stagedClarificationCount.value === 0) {
    return `待补 ${totalClarificationItemCount.value} 项`;
  }
  if (areAllClarificationsStaged(clarificationBatchCandidates.value, stagedClarificationReplies.value)) {
    return "待发送";
  }
  return `还差 ${remainingClarificationCandidateCount.value} 条候选 / ${remainingClarificationItemCount.value} 项`;
});

watch([candidates, candidateWorkflowOverrides], ([next]) => {
  const existing = new Set(next.map((item) => item.id));
  const readySet = new Set(next.filter((item) => canCreateCandidate(item)).map((item) => item.id));
  const prunedOverrides = Object.fromEntries(
    Object.entries(candidateWorkflowOverrides.value).filter(([candidateId, workflowId]) => {
      if (!existing.has(candidateId as RequirementCandidateId)) return false;
      const normalizedWorkflowId = String(workflowId ?? "").trim();
      if (!normalizedWorkflowId) return false;
      return orch.workflows.some((workflow) => workflow.id === normalizedWorkflowId);
    }),
  ) as Record<string, WorkflowId | null>;
  const currentOverrideEntries = Object.entries(candidateWorkflowOverrides.value);
  const prunedOverrideEntries = Object.entries(prunedOverrides);
  const overridesChanged = currentOverrideEntries.length !== prunedOverrideEntries.length
    || currentOverrideEntries.some(([candidateId, workflowId]) => prunedOverrides[candidateId] !== workflowId);
  if (overridesChanged) {
    candidateWorkflowOverrides.value = prunedOverrides;
    return;
  }
  if (activeCandidateId.value && !existing.has(activeCandidateId.value)) {
    activeCandidateId.value = null;
    candidateDetailOpen.value = false;
  }
  const stillSelected = selectedCandidateIds.value.filter((id) => existing.has(id) && readySet.has(id));
  if (stillSelected.length) {
    selectedCandidateIds.value = stillSelected;
    return;
  }
  const readyIds = next.filter((item) => canCreateCandidate(item)).map((item) => item.id);
  selectedCandidateIds.value = readyIds.slice(0, 8) as RequirementCandidateId[];
}, { deep: true, immediate: true });

watch(
  clarificationBatchFingerprint,
  () => {
    stagedClarificationReplies.value = pruneStagedClarificationEntries(
      clarificationBatchCandidates.value,
      stagedClarificationReplies.value,
    );
    if (dispatchedClarificationBatchFingerprint.value && dispatchedClarificationBatchFingerprint.value !== clarificationBatchFingerprint.value) {
      dispatchedClarificationBatchFingerprint.value = null;
    }
    clarificationDispatching.value = false;
  },
  { immediate: true },
);

watch(
  () => selectedRunningTurnId.value,
  (next, prev) => {
    if (!prev || next) return;
    dispatchedClarificationBatchFingerprint.value = null;
  },
);

function toggleCandidate(candidateId: RequirementCandidateId) {
  const candidate = candidates.value.find((item) => item.id === candidateId);
  if (!candidate || !canCreateCandidate(candidate)) return;
  if (selectedCandidateIds.value.includes(candidateId)) {
    selectedCandidateIds.value = selectedCandidateIds.value.filter((id) => id !== candidateId);
    return;
  }
  selectedCandidateIds.value = [...selectedCandidateIds.value, candidateId];
}

function openCandidateDetail(candidateId: RequirementCandidateId) {
  activeCandidateId.value = candidateId;
  candidateDetailOpen.value = true;
}

function setCandidateWorkflowOverride(candidateId: RequirementCandidateId, workflowId: string) {
  const candidate = candidates.value.find((item) => item.id === candidateId);
  if (!candidate) return;
  const normalizedWorkflowId = String(workflowId ?? "").trim();
  const recommendedWorkflowId = String(candidate.recommendedWorkflowId ?? "").trim();
  if (!normalizedWorkflowId || normalizedWorkflowId === recommendedWorkflowId) {
    if (candidateWorkflowOverrides.value[candidateId]) {
      const next = { ...candidateWorkflowOverrides.value };
      delete next[candidateId];
      candidateWorkflowOverrides.value = next;
    }
    return;
  }
  candidateWorkflowOverrides.value = {
    ...candidateWorkflowOverrides.value,
    [candidateId]: normalizedWorkflowId as WorkflowId,
  };
}

function onActiveCandidateWorkflowChange(workflowId: string) {
  if (!activeCandidate.value) return;
  setCandidateWorkflowOverride(activeCandidate.value.id, workflowId);
}

function closeCandidateDetail() {
  candidateDetailOpen.value = false;
}

function toggleActiveCandidateSelection() {
  if (!activeCandidate.value || !canCreateCandidate(activeCandidate.value)) return;
  toggleCandidate(activeCandidate.value.id);
}

async function sendClarificationReply(text: string, opts?: { successMessage?: string }): Promise<boolean> {
  const threadId = selectedThreadId.value;
  const session = selectedSession.value;
  if (!threadId || !session) {
    message.error("当前没有可用的需求助手会话");
    return false;
  }
  if (selectedSessionReadOnly.value) {
    message.info("这条共享草稿只读，不能继续澄清");
    return false;
  }
  if (!canSubmitClarification.value) {
    message.info("当前会话正在处理中，等这轮结束后再补充。");
    return false;
  }
  const engineStatus = engines.byTypeForWorkspace(props.workspaceId).get(session.engine);
  if (!engineStatus?.models?.length) {
    message.error("模型目录尚未加载，请稍后重试");
    return false;
  }
  const resolvedPrefs = resolveThreadPrefsWithCatalogDefaults(
    session.engine,
    chat.threadPrefsByThreadId[String(threadId)] ?? {},
    engineStatus?.models,
  );
  const resolvedModel = String(resolvedPrefs.model ?? "").trim();
  if (!resolvedModel || !engineStatus.models.some((model) => model.id === resolvedModel)) {
    message.error(resolvedModel
      ? `当前模型 ${resolvedModel} 已从模型目录移除，请重新选择模型`
      : "当前会话未配置可用模型，请重新选择模型");
    return false;
  }
  await chat.sendMessage(ctx.value, {
    workspaceId: props.workspaceId,
    threadId,
    text,
    workMode: "general",
    planMode: Boolean((chat.threadPrefsByThreadId[String(threadId)] ?? {}).planMode ?? false),
    accessMode: resolvedPrefs.accessMode,
    model: resolvedModel,
    effort: resolvedPrefs.effort ?? null,
    images: [],
    files: [],
    contextWindow: resolvedPrefs.contextWindow ?? undefined,
    autoCompactPct: resolvedPrefs.autoCompactPct,
    serviceTier: resolvedPrefs.serviceTier,
  });
  message.success(opts?.successMessage || "已把澄清反馈发给需求助手");
  return true;
}

function isClarificationCandidateStaged(candidateId: string): boolean {
  return Boolean(stagedClarificationReplies.value[String(candidateId ?? "").trim()]);
}

async function dispatchClarificationBatch(): Promise<boolean> {
  const batchText = buildCombinedClarificationReply(clarificationBatchCandidates.value, stagedClarificationReplies.value);
  if (!batchText) return false;
  const batchFingerprint = clarificationBatchFingerprint.value;
  clarificationDispatching.value = true;
  try {
    const sent = await sendClarificationReply(batchText, {
      successMessage: "已把全部澄清汇总发给需求助手",
    });
    if (!sent) return false;
    dispatchedClarificationBatchFingerprint.value = batchFingerprint;
    stagedClarificationReplies.value = {};
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "发送汇总澄清反馈失败");
    return false;
  } finally {
    clarificationDispatching.value = false;
  }
}

async function onClarificationSubmit(payload: {
  candidateId: string;
  title: string;
  text: string;
  clarificationCount: number;
}) {
  try {
    stagedClarificationReplies.value = {
      ...stagedClarificationReplies.value,
      [payload.candidateId]: {
        candidateId: payload.candidateId,
        title: payload.title,
        text: payload.text,
        clarificationCount: payload.clarificationCount,
        candidateFingerprint: findClarificationBatchCandidateFingerprint(
          clarificationBatchCandidates.value,
          payload.candidateId,
        ) || clarificationBatchFingerprint.value,
        submittedAt: Date.now(),
      },
    };
    dispatchedClarificationBatchFingerprint.value = null;
    if (!areAllClarificationsStaged(clarificationBatchCandidates.value, stagedClarificationReplies.value)) {
      message.info(`已暂存“${payload.title}”的澄清，还差 ${remainingClarificationCandidateCount.value} 条候选 / ${remainingClarificationItemCount.value} 项。`);
      return;
    }
    await dispatchClarificationBatch();
  } catch (error) {
    message.error(error instanceof Error ? error.message : "暂存澄清反馈失败");
  }
}

let engineAvailabilityRequestGeneration = 0;
/** 打开创建弹框；迟到失败仅归属发起时仍打开的工作区。 */
function createSessionAction() {
  const workspaceId = props.workspaceId, generation = ++engineAvailabilityRequestGeneration;
  createOpen.value = true;
  void refreshEngineAvailability().catch(error => {
    if (isCancelledRequestError(error) || props.workspaceId !== workspaceId || !createOpen.value || generation !== engineAvailabilityRequestGeneration) return;
    const details = isApiResultError(error) ? error.details as Record<string, unknown> | undefined : undefined;
    const rootCause = error instanceof Error ? error.message : String(error);
    console.error("[requirement-analysis] engine availability failed", { errorCode: "ENGINE_AVAILABILITY_FAILED",
      requestId: details?.requestId ?? (error as { requestId?: string })?.requestId ?? null, workspaceId, rootCause });
    message.error(rootCause);
  });
}

async function onCreateConfirm(payload: { engine: EngineType; title: string }) {
  try {
    creating.value = true;
    await analysis.createSession(ctx.value, props.workspaceId, payload);
    createOpen.value = false;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "创建需求分析会话失败");
  } finally {
    creating.value = false;
  }
}

function focusCreatedIntakeTarget(
  target: {
    intake?: { id?: string | null };
    proposal?: { id?: string | null } | null;
  } | null | undefined,
  closeDetail = false,
) {
  const intakeId = String(target?.intake?.id ?? "").trim();
  if (!intakeId) return;
  analysis.openIntakeMode();
  orch.selectedIntakeId = intakeId as any;
  orch.selectedIntakeSnapshot = orch.intakes.find((intake) => String(intake.id) === intakeId) ?? null;
  orch.selectedProposalId = (String(target?.proposal?.id ?? "").trim() || null) as any;
  if (closeDetail) {
    candidateDetailOpen.value = false;
  }
}

function notifyCreatedIntakes(
  created: Array<{ intake: { id: string; title: string }; proposal?: { id?: string | null } | null }>,
) {
  const firstCreated = created[0];
  if (!firstCreated?.intake?.id) {
    message.success(`已创建 ${created.length} 条需求，左侧正式需求已同步更新。`);
    return;
  }
  message.success(
    created.length === 1
      ? `已创建“${firstCreated.intake.title}”，左侧正式需求已同步更新。`
      : `已创建 ${created.length} 条需求，左侧正式需求已同步更新。`,
  );
}

async function createCandidates(candidateIds: RequirementCandidateId[]) {
  if (selectedSessionReadOnly.value) {
    message.info("这条共享草稿只读，不能创建正式需求");
    return;
  }
  const readySet = new Set(candidates.value.filter((item) => canCreateCandidate(item)).map((item) => item.id));
  const normalizedIds = candidateIds.filter((id, index, list) => readySet.has(id) && list.indexOf(id) === index);
  if (!normalizedIds.length) {
    message.info("当前选择的候选需求仍待澄清，暂时不能创建");
    return;
  }
  try {
    const workflowSelections = normalizedIds
      .map((candidateId) => {
        const candidate = candidates.value.find((item) => item.id === candidateId);
        const workflowId = resolveCandidateWorkflowId(candidate);
        if (!candidate || !workflowId) return null;
        return { candidateId, workflowId };
      })
      .filter((item): item is { candidateId: RequirementCandidateId; workflowId: WorkflowId } => Boolean(item));
    const res = await analysis.createIntakes(ctx.value, props.workspaceId, normalizedIds, workflowSelections);
    await Promise.all([
      orch.refreshIntakes(ctx.value, props.workspaceId),
      orch.refreshProposals(ctx.value, props.workspaceId),
      orch.refreshInstances(ctx.value, props.workspaceId),
    ]);
    selectedCandidateIds.value = [];
    const created = ((res as any).created ?? []) as Array<{
      intake: TaskIntake;
      proposal?: WorkflowProposal | null;
    }>;
    created.forEach((item) => {
      upsertStoreEntity(orch.intakes, item.intake);
      if (item.proposal) {
        upsertStoreEntity(orch.proposals, item.proposal);
      }
    });
    notifyCreatedIntakes(created);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "创建需求失败");
  }
}

function confirmCreateCandidates(candidateIds: RequirementCandidateId[]) {
  if (selectedSessionReadOnly.value) {
    message.info("这条共享草稿只读，不能创建正式需求");
    return;
  }
  const candidateMap = new Map(candidates.value.map((item) => [item.id, item] as const));
  const normalizedIds = candidateIds.filter((id, index, list) =>
    list.indexOf(id) === index && canCreateCandidate(candidateMap.get(id) ?? {
      readyToCreate: false,
      openQuestions: [],
      assetGaps: [],
    }),
  );
  if (!normalizedIds.length) {
    message.info("当前没有可创建的候选需求");
    return;
  }
  const titles = normalizedIds
    .map((id) => candidateMap.get(id)?.title)
    .filter((item): item is string => Boolean(item));
  Modal.confirm({
    title: "确认创建需求",
    content: titles.length === 1
      ? `将创建“${titles[0]}”，并同步生成对应方案与流程。确认继续吗？`
      : `将创建 ${titles.length} 条需求，并同步生成对应方案与流程。确认继续吗？`,
    okText: "确认创建",
    cancelText: "取消",
    centered: true,
    async onOk() {
      await createCandidates(normalizedIds);
    },
  });
}

function createIntakesAction() {
  confirmCreateCandidates(selectedCandidateIds.value);
}

function createActiveCandidateAction() {
  if (!activeCandidate.value) return;
  confirmCreateCandidates([activeCandidate.value.id]);
}

function focusCreatedCandidateTarget() {
  if (!activeCandidate.value || !isCreatedCandidate(activeCandidate.value) || !activeCandidate.value.createdIntakeId) return;
  focusCreatedIntakeTarget({
    intake: { id: activeCandidate.value.createdIntakeId },
    proposal: { id: activeCandidate.value.createdProposalId ?? null },
  }, true);
}

function upsertStoreEntity<T extends { id: string }>(list: T[], value: T) {
  const index = list.findIndex((item) => item.id === value.id);
  if (index >= 0) {
    list[index] = value;
    return;
  }
  list.unshift(value);
}

watch(
  () => selectedRunningTurnId.value,
  async (next, prev) => {
    if (!selectedSession.value) return;
    if (!prev || next) return;
    try {
      await analysis.loadSession(ctx.value, props.workspaceId, selectedSession.value.id);
      await analysis.refreshSessions(ctx.value, props.workspaceId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "刷新需求分析状态失败");
    }
  },
);

</script>

<template>
  <div v-if="selectedSession" class="analysis-workspace">
    <ChatPanel
      class="analysis-workspace__chat"
      :workspace-id="workspaceId"
      :thread-id="selectedThreadId"
      assistant-mode
    >
      <template #assistant-helper="{ canWrite, busy }">
        <div v-if="pendingClarificationCandidates.length > 0" class="analysis-workspace__clarification-stack">
          <RequirementClarificationPanel
            v-for="candidate in pendingClarificationCandidates"
            :key="candidate.id"
            :candidate="{
              id: candidate.id,
              title: candidate.title,
              recommendedApproach: resolveRecommendedApproach(candidate),
              sizeAssessment: resolveSizeAssessment(candidate),
              clarificationItems: resolvedClarificationItems(candidate),
            }"
            :disabled="selectedSessionReadOnly || !canWrite || clarificationBatchSending"
            :sending="busy || clarificationBatchSending"
            :staged="isClarificationCandidateStaged(candidate.id)"
            compact
            @submit="onClarificationSubmit"
          />
        </div>
      </template>
    </ChatPanel>

    <aside class="analysis-workspace__candidates">
      <header class="analysis-workspace__candidates-header">
        <div class="analysis-workspace__candidate-header-copy">
          <div class="analysis-workspace__candidate-title-row">
            <strong>候选需求</strong>
            <template v-if="pendingClarificationCandidates.length > 0">
              <span class="analysis-workspace__clarification-inline-badge">
                澄清 {{ stagedClarificationCount }}/{{ pendingClarificationCandidates.length }}
              </span>
              <span
                class="analysis-workspace__clarification-inline-copy"
                :title="clarificationBatchReminder"
              >
                {{ clarificationInlineSummary }}
              </span>
            </template>
          </div>
          <div class="analysis-workspace__candidate-subtitle">
            已选 {{ selectedCount }} / 可创建 {{ readyCount }} / 已创建 {{ createdCount }} / 待澄清 {{ pendingCount }}
          </div>
          <div v-if="pendingCount > 0" class="analysis-workspace__candidate-tip">
            橙色项还不能创建，蓝灰色项表示已落成正式需求。
          </div>
        </div>
        <div class="analysis-workspace__candidate-actions-block">
          <div class="analysis-workspace__candidate-actions">
            <button
              class="orch-action-btn orch-action-btn--primary"
              type="button"
              :title="createDisabledReason || undefined"
              :disabled="selectedSessionReadOnly || analysis.creatingIntakes || selectedCount === 0"
              @click="createIntakesAction"
            >
              创建
            </button>
          </div>
          <div v-if="candidateActionsHint" class="analysis-workspace__candidate-actions-hint">
            {{ candidateActionsHint }}
          </div>
        </div>
      </header>

      <div v-if="candidates.length === 0" class="analysis-workspace__candidate-empty">
        还没有识别到候选需求。先在左侧输入您的目标，我会开始拆解。
      </div>

      <div v-else class="analysis-workspace__candidate-list">
        <article
          v-for="candidate in candidates"
          :key="candidate.id"
          class="analysis-workspace__candidate-card"
          :class="{
            'analysis-workspace__candidate-card--selected': selectedCandidateIds.includes(candidate.id),
            'analysis-workspace__candidate-card--blocked': !canCreateCandidate(candidate),
            'analysis-workspace__candidate-card--created': isCreatedCandidate(candidate),
          }"
        >
          <div class="analysis-workspace__candidate-row">
            <div class="analysis-workspace__candidate-checkbox-wrap" @click.stop>
              <input
                class="analysis-workspace__candidate-checkbox"
                type="checkbox"
                :checked="selectedCandidateIds.includes(candidate.id)"
                :disabled="!canCreateCandidate(candidate)"
                @click.stop
                @change.stop="toggleCandidate(candidate.id)"
              />
            </div>
            <div class="analysis-workspace__candidate-main">
              <div class="analysis-workspace__candidate-main-top">
                <strong class="analysis-workspace__candidate-title">{{ candidate.title }}</strong>
                <div class="analysis-workspace__candidate-title-actions">
                  <span
                    class="analysis-workspace__candidate-ready"
                    :class="{
                      'analysis-workspace__candidate-ready--true': candidateStatusVariant(candidate) === 'true',
                      'analysis-workspace__candidate-ready--blocked': candidateStatusVariant(candidate) === 'blocked',
                      'analysis-workspace__candidate-ready--created': candidateStatusVariant(candidate) === 'created',
                    }"
                  >
                    {{ candidateStatusLabel(candidate) }}
                  </span>
                  <button
                    class="analysis-workspace__candidate-detail-trigger orch-action-btn orch-action-btn--primary"
                    type="button"
                    @click.stop="openCandidateDetail(candidate.id)"
                  >
                    详情
                  </button>
                </div>
              </div>

              <div class="analysis-workspace__candidate-summary">{{ candidate.goal }}</div>

              <div class="analysis-workspace__candidate-meta">
                <span class="analysis-workspace__tag">{{ deliverySliceLabel(resolvePhasingAssessment(candidate).deliverySlice) }}</span>
                <span class="analysis-workspace__tag">{{ scopeDecisionLabel(resolvePhasingAssessment(candidate).scopeDecision) }}</span>
                <span class="analysis-workspace__tag">{{ sizeLabel(candidate.sizeAssessment?.size || candidate.complexity) }}</span>
                <span class="analysis-workspace__tag">{{ candidate.uiScope }}</span>
                <span class="analysis-workspace__tag">{{ candidate.architectureRisk }}</span>
                <span v-if="candidate.sizeAssessment?.score" class="analysis-workspace__tag">
                  {{ candidate.sizeAssessment.score }} 分
                </span>
                <span class="analysis-workspace__candidate-workflow">
                  {{ resolveCandidateWorkflow(candidate)?.name || candidate.recommendedWorkflowName || "流程待确认" }}
                </span>
              </div>

              <div v-if="resolveRecommendedApproach(candidate)" class="analysis-workspace__candidate-approach">
                推荐方案：{{ resolveRecommendedApproach(candidate) }}
              </div>

              <div
                v-if="!canCreateCandidate(candidate)"
                class="analysis-workspace__candidate-warning"
                :class="{ 'analysis-workspace__candidate-warning--created': isCreatedCandidate(candidate) }"
              >
                <template v-if="isCreatedCandidate(candidate)">
                  这条候选需求已经创建为正式需求，并同步生成了方案。
                </template>
                <template v-else-if="candidateNeedsWorkflowChoice(candidate)">
                  <div class="analysis-workspace__candidate-warning-title">
                    还没选流程
                  </div>
                  <div class="analysis-workspace__candidate-warning-suggestion">
                    先点详情，在右侧挑一条合适的流程模板，再创建这条需求。
                  </div>
                </template>
                <template v-else>
                  <div class="analysis-workspace__candidate-warning-title">
                    待澄清：{{ firstClarification(candidate)?.question }}
                  </div>
                  <div v-if="firstClarification(candidate)?.optionLabel" class="analysis-workspace__candidate-warning-suggestion">
                    AI 建议：{{ firstClarification(candidate)?.optionLabel }}
                  </div>
                  <div class="analysis-workspace__candidate-warning-suggestion">
                    建议：{{ firstClarification(candidate)?.suggestion }}
                  </div>
                </template>
              </div>
            </div>
          </div>
        </article>
      </div>
    </aside>
  </div>

  <div v-else class="analysis-workspace__empty">
    <div class="analysis-workspace__empty-title">AI 梳理需求</div>
    <div class="analysis-workspace__empty-copy">
      新建一个会话后，先描述您的目标、范围和验收预期。我会持续整理候选需求，并给出合适的工作流建议。
    </div>
    <button class="orch-action-btn orch-action-btn--primary" type="button" @click="createSessionAction">
      新建会话
    </button>
  </div>

  <CreateThreadModal
    v-model:open="createOpen"
    :creating="creating"
    default-engine="codex"
    :disabled-engines="createDisabledEngines"
    @confirm="onCreateConfirm"
  />

  <a-modal
    :open="candidateDetailOpen"
    :title="activeCandidate?.title || '候选需求详情'"
    :width="'90vw'"
    :style="{ top: '4vh' }"
    :body-style="{ padding: '16px 18px', height: '84vh', maxHeight: '84vh', overflow: 'hidden' }"
    @cancel="closeCandidateDetail"
  >
    <template v-if="activeCandidate">
      <div class="analysis-workspace__candidate-modal">
        <div class="analysis-workspace__candidate-modal-main">
          <div class="analysis-workspace__candidate-modal-summary">
            <span
              class="analysis-workspace__candidate-ready"
              :class="{
                'analysis-workspace__candidate-ready--true': candidateStatusVariant(activeCandidate) === 'true',
                'analysis-workspace__candidate-ready--blocked': candidateStatusVariant(activeCandidate) === 'blocked',
                'analysis-workspace__candidate-ready--created': candidateStatusVariant(activeCandidate) === 'created',
              }"
            >
              {{ candidateStatusLabel(activeCandidate) }}
            </span>
            <div class="analysis-workspace__candidate-copy">
              {{
                isCreatedCandidate(activeCandidate)
                  ? "该候选需求已经创建为正式需求，并同步生成了对应方案。"
                  : canCreateCandidate(activeCandidate)
                  ? "该候选需求已具备创建条件，可以直接创建需求并同步生成方案。"
                  : candidateNeedsWorkflowChoice(activeCandidate)
                  ? "该候选需求目前缺少执行流程，您可以直接在这里手动选择一条流程模板后再创建。"
                  : "该候选需求还有澄清项未完成，当前不能直接创建。"
              }}
            </div>
          </div>

          <div class="analysis-workspace__candidate-goal">{{ activeCandidate.goal }}</div>

          <div class="analysis-workspace__candidate-tags">
            <span class="analysis-workspace__tag">{{ deliverySliceLabel(resolvePhasingAssessment(activeCandidate).deliverySlice) }}</span>
            <span class="analysis-workspace__tag">{{ scopeDecisionLabel(resolvePhasingAssessment(activeCandidate).scopeDecision) }}</span>
            <span class="analysis-workspace__tag">{{ sizeLabel(activeCandidate.sizeAssessment?.size || activeCandidate.complexity) }}</span>
            <span class="analysis-workspace__tag">{{ activeCandidate.uiScope }}</span>
            <span class="analysis-workspace__tag">{{ activeCandidate.architectureRisk }}</span>
            <span v-if="activeCandidate.sizeAssessment?.score" class="analysis-workspace__tag">
              {{ activeCandidate.sizeAssessment.score }} 分
            </span>
          </div>

          <div v-if="resolveRecommendedApproach(activeCandidate)" class="analysis-workspace__candidate-section">
            <div class="analysis-workspace__candidate-label">推荐方案</div>
            <div class="analysis-workspace__candidate-copy">{{ resolveRecommendedApproach(activeCandidate) }}</div>
          </div>

          <div v-if="resolvePhasingAssessment(activeCandidate).summary" class="analysis-workspace__candidate-section">
            <div class="analysis-workspace__candidate-label">分期判断</div>
            <div class="analysis-workspace__candidate-copy">{{ resolvePhasingAssessment(activeCandidate).summary }}</div>
            <div class="analysis-workspace__candidate-size-metrics">
              <span class="analysis-workspace__tag">价值假设 {{ resolvePhasingAssessment(activeCandidate).signals.benefitHypothesisCount }}</span>
              <span class="analysis-workspace__tag">验收闭环 {{ resolvePhasingAssessment(activeCandidate).signals.acceptanceLoopCount }}</span>
              <span class="analysis-workspace__tag">角色端面 {{ resolvePhasingAssessment(activeCandidate).signals.actorSurfaceCount }}</span>
              <span class="analysis-workspace__tag">外部系统 {{ resolvePhasingAssessment(activeCandidate).signals.externalSystemCount }}</span>
              <span class="analysis-workspace__tag">新核心模型 {{ resolvePhasingAssessment(activeCandidate).signals.newCoreModelCount }}</span>
            </div>
            <ul v-if="resolvePhasingAssessment(activeCandidate).outOfScope.length" class="analysis-workspace__candidate-list-copy">
              <li v-for="item in resolvePhasingAssessment(activeCandidate).outOfScope" :key="item">当前不纳入：{{ item }}</li>
            </ul>
          </div>

          <div v-if="resolveSizeAssessment(activeCandidate).summary" class="analysis-workspace__candidate-section">
            <div class="analysis-workspace__candidate-label">需求大小评估</div>
            <div class="analysis-workspace__candidate-copy">{{ resolveSizeAssessment(activeCandidate).summary }}</div>
            <div v-if="resolveSizeAssessment(activeCandidate).score > 0" class="analysis-workspace__candidate-size-metrics">
              <template v-if="resolveSizeAssessment(activeCandidate).legacySignals">
                <span class="analysis-workspace__tag">菜单 {{ resolveSizeAssessment(activeCandidate).legacySignals?.menuCount }}</span>
                <span class="analysis-workspace__tag">功能点 {{ resolveSizeAssessment(activeCandidate).legacySignals?.featurePointCount }}</span>
                <span class="analysis-workspace__tag">流程 {{ resolveSizeAssessment(activeCandidate).legacySignals?.businessFlowCount }}</span>
                <span class="analysis-workspace__tag">交互 {{ resolveSizeAssessment(activeCandidate).legacySignals?.interactionPointCount }}</span>
                <span class="analysis-workspace__tag">集成 {{ resolveSizeAssessment(activeCandidate).legacySignals?.integrationCount }}</span>
                <span class="analysis-workspace__tag">平台 {{ resolveSizeAssessment(activeCandidate).legacySignals?.platformCount }}</span>
              </template>
              <template v-else>
                <span class="analysis-workspace__tag">功能过程 {{ resolveSizeAssessment(activeCandidate).signals.functionalProcessCount }}</span>
                <span class="analysis-workspace__tag">领域对象 {{ resolveSizeAssessment(activeCandidate).signals.domainEntityCount }}</span>
                <span class="analysis-workspace__tag">状态流转 {{ resolveSizeAssessment(activeCandidate).signals.stateTransitionCount }}</span>
                <span class="analysis-workspace__tag">交互界面 {{ resolveSizeAssessment(activeCandidate).signals.interactionSurfaceCount }}</span>
                <span class="analysis-workspace__tag">外部集成 {{ resolveSizeAssessment(activeCandidate).signals.externalIntegrationCount }}</span>
                <span class="analysis-workspace__tag">异步一致性 {{ resolveSizeAssessment(activeCandidate).signals.asyncConsistencyRiskCount }}</span>
                <span class="analysis-workspace__tag">交付端面 {{ resolveSizeAssessment(activeCandidate).signals.clientSurfaceCount }}</span>
              </template>
            </div>
          </div>

          <div v-if="activeCandidate.background" class="analysis-workspace__candidate-section">
            <div class="analysis-workspace__candidate-label">背景补充</div>
            <div class="analysis-workspace__candidate-copy">{{ activeCandidate.background }}</div>
          </div>

          <div class="analysis-workspace__candidate-section">
            <div class="analysis-workspace__candidate-label">执行流程</div>
            <select
              class="analysis-workspace__candidate-select"
              :value="activeCandidateWorkflowId"
              @change="onActiveCandidateWorkflowChange(($event.target as HTMLSelectElement).value)"
            >
              <option value="">请选择流程模板</option>
              <option v-for="workflow in workflowChoices" :key="workflow.id" :value="workflow.id">
                {{ workflow.name }} · {{ workflow.nodeCount }} 节点
              </option>
            </select>
            <div v-if="activeCandidate.recommendedWorkflowName || activeCandidate.recommendedWorkflowReason" class="analysis-workspace__candidate-copy">
              AI 推荐：{{ activeCandidate.recommendedWorkflowName || "暂未锁定" }}
              <template v-if="activeCandidate.recommendedWorkflowReason">，{{ activeCandidate.recommendedWorkflowReason }}</template>
            </div>
            <div class="analysis-workspace__candidate-copy">
              这里可以直接改成当前工作区里的其他流程模板；创建需求时会按您这里选中的流程落正式方案。
            </div>
          </div>

          <div v-if="activeCandidate.acceptanceCriteria?.length" class="analysis-workspace__candidate-section">
            <div class="analysis-workspace__candidate-label">验收标准</div>
            <ul class="analysis-workspace__candidate-list-copy">
              <li v-for="item in activeCandidate.acceptanceCriteria" :key="item.text">{{ item.text }}</li>
            </ul>
          </div>

          <div v-if="(activeCandidate.assumptions ?? []).length" class="analysis-workspace__candidate-section">
            <div class="analysis-workspace__candidate-label">当前假设</div>
            <ul class="analysis-workspace__candidate-list-copy">
              <li v-for="item in (activeCandidate.assumptions ?? [])" :key="item">{{ item }}</li>
            </ul>
          </div>

          <div v-if="resolvedClarificationItems(activeCandidate).length" class="analysis-workspace__candidate-section">
            <div class="analysis-workspace__candidate-label">待澄清事项</div>
            <div class="analysis-workspace__candidate-clarification-list">
              <div
                v-for="item in resolvedClarificationItems(activeCandidate)"
                :key="`${item.question}-${item.suggestion}`"
                class="analysis-workspace__candidate-clarification-card"
              >
                <div class="analysis-workspace__candidate-clarification-question">{{ item.question }}</div>
                <div v-if="shouldShowClarificationReason(item.reason)" class="analysis-workspace__candidate-copy">{{ item.reason }}</div>
                <div class="analysis-workspace__candidate-clarification-options">
                  <span
                    v-for="option in item.options"
                    :key="option.id"
                    class="analysis-workspace__candidate-clarification-option"
                    :class="{ 'analysis-workspace__candidate-clarification-option--recommended': option.recommended }"
                  >
                    {{ option.label }}
                  </span>
                </div>
                <div class="analysis-workspace__candidate-clarification-suggestion">建议：{{ item.suggestion }}</div>
              </div>
            </div>
          </div>

          <RequirementClarificationPanel
            v-if="!canCreateCandidate(activeCandidate) && !isCreatedCandidate(activeCandidate) && resolvedClarificationItems(activeCandidate).length > 0"
            :candidate="{
              id: activeCandidate.id,
              title: activeCandidate.title,
              recommendedApproach: resolveRecommendedApproach(activeCandidate),
              sizeAssessment: resolveSizeAssessment(activeCandidate),
              clarificationItems: resolvedClarificationItems(activeCandidate),
            }"
            :disabled="selectedSessionReadOnly || !canSubmitClarification || clarificationBatchSending"
            :sending="clarificationBatchSending"
            :staged="isClarificationCandidateStaged(activeCandidate.id)"
            @submit="onClarificationSubmit"
          />

          <div v-if="(activeCandidate.assetGaps ?? []).length" class="analysis-workspace__candidate-section">
            <div class="analysis-workspace__candidate-label">资产缺口</div>
            <ul class="analysis-workspace__candidate-list-copy">
              <li v-for="gap in (activeCandidate.assetGaps ?? [])" :key="`${gap.kind}-${gap.code}`">
                {{ gap.kind }} / {{ gap.severity }}：{{ gap.message }}
              </li>
            </ul>
          </div>
        </div>

        <aside class="analysis-workspace__candidate-modal-preview">
          <div class="analysis-workspace__candidate-preview-card">
            <div class="analysis-workspace__candidate-preview-head">
              <div class="analysis-workspace__candidate-preview-title">
                <div class="analysis-workspace__candidate-label">对应流程图</div>
                <strong>{{ activeWorkflow?.name || "暂未锁定流程" }}</strong>
              </div>
              <div v-if="activeWorkflowSummaryChips.length" class="analysis-workspace__candidate-preview-meta">
                <span v-for="chip in activeWorkflowSummaryChips" :key="chip" class="analysis-workspace__tag">
                  {{ chip }}
                </span>
              </div>
            </div>

            <div class="analysis-workspace__candidate-copy">
              这里展示当前候选需求最终准备带入创建动作的流程图；上方改流程后，这里的预览会同步切换。
            </div>

            <WorkflowGraphView
              v-if="activeWorkflow"
              class="analysis-workspace__candidate-preview-graph"
              :workflow="activeWorkflow"
              :role-name-by-id="roleNameById"
              min-height="0"
              :show-controls="true"
              :show-mini-map="true"
            />
            <div v-else class="analysis-workspace__candidate-preview-empty">
              {{
                activeCandidateWorkflowId
                  ? orch.workflowsLoading
                    ? "正在加载对应流程定义..."
                    : "当前选中的流程模板在工作区里不存在，无法预览。"
                  : "当前候选需求还没有锁定可预览的流程。"
              }}
            </div>
          </div>
        </aside>
      </div>
    </template>

    <template #footer>
      <div class="analysis-workspace__candidate-modal-footer">
        <div
          v-if="activeCandidate && !canCreateCandidate(activeCandidate) && !isCreatedCandidate(activeCandidate)"
          class="analysis-workspace__candidate-modal-hint"
        >
          {{ candidateNeedsWorkflowChoice(activeCandidate) ? "先选择一条流程模板，再创建这条需求。" : "待澄清项暂不可创建，先补齐问题后再勾选。" }}
        </div>
        <button class="orch-action-btn orch-action-btn--secondary" type="button" @click="closeCandidateDetail">
          关闭
        </button>
        <template v-if="activeCandidate && isCreatedCandidate(activeCandidate)">
          <button
            class="orch-action-btn orch-action-btn--primary"
            type="button"
            :disabled="!activeCandidate.createdIntakeId"
            @click="focusCreatedCandidateTarget"
          >
            查看已创建需求
          </button>
        </template>
        <template v-if="activeCandidate && canCreateCandidate(activeCandidate)">
          <button
            class="orch-action-btn orch-action-btn--secondary"
            type="button"
            :disabled="selectedSessionReadOnly"
            @click="toggleActiveCandidateSelection"
          >
            {{ activeCandidate && selectedCandidateIds.includes(activeCandidate.id) ? "取消勾选" : "加入待创建" }}
          </button>
          <button
            class="orch-action-btn orch-action-btn--primary"
            type="button"
            :disabled="selectedSessionReadOnly || analysis.creatingIntakes"
            @click="createActiveCandidateAction"
          >
            创建
          </button>
        </template>
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
.analysis-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.95fr);
  gap: 16px;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  padding: 14px 18px 4px 14px;
}
.analysis-workspace__chat,
.analysis-workspace__candidates {
  min-height: 0;
}

.analysis-workspace__chat :deep(.chat-panel__composer) {
  padding-bottom: 2px;
}

.analysis-workspace__clarification-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}

.analysis-workspace__candidate-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  flex-wrap: wrap;
}

.analysis-workspace__clarification-inline-badge {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent, #c96442) 12%, var(--app-panel-bg, #fff));
  color: color-mix(in srgb, var(--app-accent, #c96442) 72%, var(--app-text, #141413) 28%);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.analysis-workspace__clarification-inline-copy {
  min-width: 0;
  color: color-mix(in srgb, var(--app-text, #141413) 58%, var(--app-muted, #5e5d59) 42%);
  font-size: 12px;
  line-height: 1.5;
}

.analysis-workspace__candidates {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 18px;
  background: var(--app-bg, #fff);
  overflow: hidden;
}

.analysis-workspace__candidates-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--app-border, #eef1f5);
}

.analysis-workspace__tag,
.analysis-workspace__candidate-ready {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 999px;
  background: #f3f6fb;
  color: #425466;
  font-size: 12px;
}

.analysis-workspace__candidate-ready--true {
  background: color-mix(in srgb, #52c41a 14%, white);
  color: #2f7d17;
}

.analysis-workspace__candidate-ready--blocked {
  background: color-mix(in srgb, #f59e0b 16%, white);
  color: #b45309;
}

.analysis-workspace__candidate-ready--created {
  background: color-mix(in srgb, #2563eb 12%, white);
  color: #1d4ed8;
}

.analysis-workspace__candidate-subtitle,
.analysis-workspace__candidate-copy {
  color: var(--app-muted, #667085);
  font-size: 12px;
  line-height: 1.6;
}

.analysis-workspace__candidate-header-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.analysis-workspace__candidate-tip {
  font-size: 12px;
  line-height: 1.5;
  color: #b45309;
}

.analysis-workspace__candidate-actions-block {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.analysis-workspace__candidate-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.analysis-workspace__candidate-actions-hint {
  max-width: 320px;
  text-align: right;
  color: var(--app-muted, #667085);
  font-size: 12px;
  line-height: 1.6;
}

.analysis-workspace__candidate-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  scrollbar-gutter: stable;
}
.analysis-workspace__candidate-card {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 16px;
  padding: 14px;
  background: linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%);
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}

.analysis-workspace__candidate-card:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 18%, var(--app-border, #e8e8e8));
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
}

.analysis-workspace__candidate-card--selected {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 30%, var(--app-border, #e8e8e8));
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.07);
}

.analysis-workspace__candidate-card--blocked {
  border-color: color-mix(in srgb, #f59e0b 24%, var(--app-border, #e8e8e8));
  background: linear-gradient(180deg, color-mix(in srgb, #fff7ed 78%, #fff), #ffffff);
}

.analysis-workspace__candidate-card--created {
  border-color: color-mix(in srgb, #2563eb 20%, var(--app-border, #e8e8e8));
  background: linear-gradient(180deg, color-mix(in srgb, #eff6ff 76%, #fff), #ffffff);
}

.analysis-workspace__candidate-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.analysis-workspace__candidate-checkbox-wrap {
  padding-top: 2px;
}

.analysis-workspace__candidate-checkbox {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--app-primary, #1677ff);
  cursor: pointer;
}

.analysis-workspace__candidate-checkbox:disabled {
  cursor: not-allowed;
  opacity: 0.42;
  filter: grayscale(1);
}

.analysis-workspace__candidate-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.analysis-workspace__candidate-main-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.analysis-workspace__candidate-title-actions {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.analysis-workspace__candidate-title {
  font-size: 14px;
  line-height: 1.5;
  min-width: 0;
}

.analysis-workspace__candidate-summary,
.analysis-workspace__candidate-goal {
  font-size: 13px;
  line-height: 1.7;
  color: var(--app-text, #1f2937);
}

.analysis-workspace__candidate-summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.analysis-workspace__candidate-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.analysis-workspace__candidate-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.analysis-workspace__candidate-workflow {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, white);
  color: color-mix(in srgb, var(--app-primary, #1677ff) 70%, #1f2937);
  font-size: 12px;
}

.analysis-workspace__candidate-approach {
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted, #667085);
}

.analysis-workspace__candidate-warning {
  padding: 8px 10px;
  border-radius: 12px;
  background: color-mix(in srgb, #f59e0b 12%, white);
  color: #b45309;
  font-size: 12px;
  line-height: 1.6;
}

.analysis-workspace__candidate-warning-title {
  font-weight: 600;
}

.analysis-workspace__candidate-warning-suggestion {
  margin-top: 2px;
}

.analysis-workspace__candidate-warning--created {
  background: color-mix(in srgb, #2563eb 10%, white);
  color: #1d4ed8;
}

.analysis-workspace__candidate-detail-trigger {
  min-height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 12px;
}

.analysis-workspace__candidate-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.analysis-workspace__candidate-select {
  width: 100%;
  min-height: 38px;
  padding: 8px 12px;
  border-radius: 12px;
  border: 1px solid var(--app-border, #d0d7e2);
  background: color-mix(in srgb, var(--app-bg, #fff) 92%, white);
  color: var(--app-text, #1f2937);
}

.analysis-workspace__candidate-select:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 40%, var(--app-border, #d0d7e2));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-primary, #1677ff) 12%, transparent);
}

.analysis-workspace__candidate-clarification-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.analysis-workspace__candidate-clarification-card {
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, #f59e0b 20%, var(--app-border, #e8e8e8));
  border-radius: 14px;
  background: color-mix(in srgb, #fff7ed 66%, white);
}

.analysis-workspace__candidate-clarification-question {
  font-size: 13px;
  font-weight: 600;
  color: #9a3412;
}

.analysis-workspace__candidate-clarification-suggestion {
  margin-top: 4px;
  color: #b45309;
  line-height: 1.6;
}

.analysis-workspace__candidate-clarification-options,
.analysis-workspace__candidate-size-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.analysis-workspace__candidate-clarification-option {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, #f59e0b 12%, white);
  color: #9a3412;
  font-size: 12px;
}

.analysis-workspace__candidate-clarification-option--recommended {
  border: 1px dashed color-mix(in srgb, #f59e0b 34%, #fdba74);
}

.analysis-workspace__candidate-label {
  font-size: 12px;
  font-weight: 600;
  color: #425466;
}
.analysis-workspace__candidate-list-copy {
  margin: 0;
  padding-left: 18px;
  color: var(--app-muted, #667085);
  line-height: 1.7;
}

.analysis-workspace__candidate-modal {
  display: grid;
  grid-template-columns: minmax(0, 0.92fr) minmax(360px, 1.08fr);
  gap: 16px;
  height: 100%;
  min-height: 0;
}

.analysis-workspace__candidate-modal-main,
.analysis-workspace__candidate-modal-preview {
  min-height: 0;
}

.analysis-workspace__candidate-modal-preview {
  display: flex;
  overflow: hidden;
}

.analysis-workspace__candidate-modal-main {
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  padding-right: 6px;
}

.analysis-workspace__candidate-preview-card {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  height: 100%;
  min-height: 0;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 18px;
  overflow: hidden;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 97%, #f8fafc), var(--app-bg, #fff));
}

.analysis-workspace__candidate-preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.analysis-workspace__candidate-preview-title {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.analysis-workspace__candidate-preview-title strong {
  font-size: 14px;
  line-height: 1.5;
  color: var(--app-text, #1f2937);
}

.analysis-workspace__candidate-preview-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.analysis-workspace__candidate-preview-graph {
  flex: 1 1 auto;
  min-height: 0;
  height: 0;
  overflow: hidden;
}

.analysis-workspace__candidate-preview-empty {
  flex: 1 1 auto;
  min-height: 260px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  border: 1px dashed var(--app-border, #d9d9d9);
  border-radius: 16px;
  text-align: center;
  color: var(--app-muted, #667085);
  line-height: 1.7;
  background: color-mix(in srgb, var(--app-bg, #fff) 95%, #f7f9fc);
}

.analysis-workspace__candidate-modal-summary {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.analysis-workspace__candidate-modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.analysis-workspace__candidate-modal-hint {
  margin-right: auto;
  color: #b45309;
  font-size: 12px;
  line-height: 1.6;
}

:root[data-theme="dark"] .analysis-workspace__tag,
:root[data-theme="dark"] .analysis-workspace__candidate-ready {
  background: color-mix(in srgb, var(--app-panel-bg, #1f2937) 84%, #0f172a);
  color: color-mix(in srgb, var(--app-text, #e5e7eb) 82%, #94a3b8);
}

:root[data-theme="dark"] .analysis-workspace__candidate-card {
  border-color: color-mix(in srgb, var(--app-border, #374151) 84%, #475569);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--app-panel-bg, #1f2937) 94%, #111827),
    color-mix(in srgb, var(--app-panel-bg, #1f2937) 88%, #0f172a)
  );
}

:root[data-theme="dark"] .analysis-workspace__candidate-card--blocked {
  border-color: color-mix(in srgb, #f59e0b 36%, var(--app-border, #374151));
  background: linear-gradient(
    180deg,
    color-mix(in srgb, #5b3a12 28%, var(--app-panel-bg, #1f2937)),
    color-mix(in srgb, #42270d 20%, var(--app-panel-bg, #1f2937))
  );
}

:root[data-theme="dark"] .analysis-workspace__candidate-card--created {
  border-color: color-mix(in srgb, #2563eb 34%, var(--app-border, #374151));
  background: linear-gradient(
    180deg,
    color-mix(in srgb, #1e3a8a 20%, var(--app-panel-bg, #1f2937)),
    color-mix(in srgb, #1e40af 14%, var(--app-panel-bg, #1f2937))
  );
}

:root[data-theme="dark"] .analysis-workspace__candidate-workflow {
  background: color-mix(in srgb, var(--app-primary, #1677ff) 22%, var(--app-panel-bg, #1f2937));
  color: color-mix(in srgb, var(--app-primary, #60a5fa) 74%, #e2e8f0);
}

:root[data-theme="dark"] .analysis-workspace__candidate-tip,
:root[data-theme="dark"] .analysis-workspace__candidate-warning,
:root[data-theme="dark"] .analysis-workspace__candidate-modal-hint {
  color: #fbbf24;
}

:root[data-theme="dark"] .analysis-workspace__candidate-warning {
  background: color-mix(in srgb, #b45309 24%, var(--app-panel-bg, #1f2937));
}

:root[data-theme="dark"] .analysis-workspace__candidate-warning--created {
  background: color-mix(in srgb, #1d4ed8 24%, var(--app-panel-bg, #1f2937));
  color: #93c5fd;
}

:root[data-theme="dark"] .analysis-workspace__candidate-clarification-card {
  border-color: color-mix(in srgb, #f59e0b 34%, var(--app-border, #374151));
  background: color-mix(in srgb, #7c2d12 20%, var(--app-panel-bg, #1f2937));
}

:root[data-theme="dark"] .analysis-workspace__candidate-clarification-question,
:root[data-theme="dark"] .analysis-workspace__candidate-clarification-suggestion {
  color: #fdba74;
}

:root[data-theme="dark"] .analysis-workspace__candidate-clarification-option {
  background: color-mix(in srgb, #b45309 24%, var(--app-panel-bg, #1f2937));
  color: #fdba74;
}

:root[data-theme="dark"] .analysis-workspace__candidate-label {
  color: color-mix(in srgb, var(--app-text, #e5e7eb) 78%, #94a3b8);
}

.analysis-workspace__candidate-empty,
.analysis-workspace__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 280px;
  color: var(--app-muted, #667085);
  text-align: center;
  padding: 24px;
}
.analysis-workspace__empty-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--app-text, #1f2937);
}
.analysis-workspace__empty-copy {
  max-width: 560px;
  line-height: 1.7;
}
@media (max-width: 1280px) {
  .analysis-workspace {
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
    padding: 12px 14px 8px;
  }

  .analysis-workspace__candidates-header {
    flex-direction: column;
  }

  .analysis-workspace__candidate-actions-block {
    width: 100%;
    align-items: flex-start;
  }

  .analysis-workspace__candidate-actions-hint {
    max-width: none;
    text-align: left;
  }
}

@media (max-width: 1200px) {
  .analysis-workspace__candidate-modal {
    grid-template-columns: minmax(0, 1fr);
  }

  .analysis-workspace__candidate-preview-card {
    min-height: 420px;
  }
}
</style>

