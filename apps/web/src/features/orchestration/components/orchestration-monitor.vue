<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import {
  PauseCircleOutlined,
  CaretRightOutlined,
  StopOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  CloseOutlined,
} from "@ant-design/icons-vue";
import {
  type ConversationUserInputRequest,
  getTaskIntakeTitle,
  validateInlineThreadPayload,
  isRoleExecutionEngineEnabled,
  type DownstreamThreadReusePolicy,
  type EngineType,
  type NodeExecutionStatus,
  type NodeExecutionState,
  type NodeThreadReusePolicy,
  type OrchestrationId,
  type OrchestrationRoleExecutionOverride,
  type RoleDefinition,
  type RoleRuntimeDefinition,
  type SharedWorkspaceMemberItem,
  type ThreadId,
  type WorkspaceId,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { resolveCatalogRoleExecutionConfigForEngine } from "../../../composables/runtimeRoleExecutionConfig";
import { useChatStore } from "../../../store/chat";
import { useConfigStore } from "../../../store/config";
import { useEngineStore } from "../../../store/engine";
import { useOrchestrationStore } from "../../../store/orchestration";
import { useSharedWorkspacesStore } from "../../../store/sharedWorkspaces";
import { useUiStore } from "../../../store/ui";
import { useWorkspacesStore } from "../../../store/workspaces";
import { isSharedWorkspaceSelectionId, parseSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { useComposerAttachments } from "../../composer/useComposerAttachments";
import type { PendingInteractionItem, ThreadConversationState } from "../../chat/chatTypes";
import {
  isRunningLikeStatus,
  requiresStructuredNodeThreadAction,
  resolveNodeWorkbenchDescriptor,
} from "../node-workbench";
import { buildModelSelectOptionGroups, type ModelSelectOptionGroup } from "../../../composables/modelSelectOptions";
import {
  buildRerunNodeIds,
  buildRerunRoleExecutionOverrides,
  collectRerunAffectedNodeIds,
  collectRerunScopeRoleIds,
  type RerunExecutionOverrideDraft,
  type RerunExecutionOverrideScope,
  type RerunNodeScope,
  validateRerunExecutionOverrideDraft,
  validateRerunNodeIds,
} from "../rerun-execution-config";
import ChatPanel from "../../chat/components/chat-panel.vue";
import PendingInteractionStack from "../../chat/components/pending-interaction-stack.vue";
import ApprovalDialog from "./approval-dialog.vue";
import FeedbackDialog from "./feedback-dialog.vue";
import NodeExecutionDetail from "./node-execution-detail.vue";
import WorkflowGraphView from "./workflow-graph-view.vue";

defineOptions({ name: "OrchestrationMonitor" });

const props = withDefaults(defineProps<{
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  showHeader?: boolean;
  readOnly?: boolean;
}>(), {
  showHeader: true,
  readOnly: false,
});

const orch = useOrchestrationStore();
const chat = useChatStore();
const config = useConfigStore();
const engines = useEngineStore();
const engineModels = (engine: EngineType) => engines.byTypeForWorkspace(props.workspaceId).get(engine)?.models ?? [];
const workspaces = useWorkspacesStore();
const sharedWorkspaces = useSharedWorkspacesStore();
const ui = useUiStore();
const { ctx } = useApiContext();
const monitorViewActive = ref(true);
const graphRef = ref<InstanceType<typeof WorkflowGraphView> | null>(null);
const hasReworkEdges = computed(() => graphRef.value?.hasReworkEdges ?? false);
const showReworkEdges = computed(() => graphRef.value?.showReworkEdges ?? true);
const reworkEdgePreferenceError = computed(() => graphRef.value?.reworkEdgePreferenceError ?? null);

/** 顶部操作复用图组件的显示偏好，避免维护两份开关状态。 */
function toggleReworkEdges(): void {
  graphRef.value?.toggleReworkEdges();
}

/** 日志只记录稳定诊断字段和实体 ID，避免输出接口正文或凭据。 */
function errorDiagnosticContext(error: unknown, fallbackCode: string): { errorCode: string; requestId: string | null } {
  const raw = error && typeof error === "object" ? error as Record<string, any> : {};
  return {
    errorCode: String(raw.code ?? fallbackCode).trim() || fallbackCode,
    requestId: String(raw.requestId ?? raw.request_id ?? raw.meta?.requestId ?? "").trim() || null,
  };
}

const canAddRerunImages = computed(() => true);
const disallowRerunTextFiles = computed(() => false);
/** 管理“从此节点重跑”说明中的粘贴图片附件。 */
const {
  imageAttachments: rerunImageAttachments,
  removeImage: removeRerunImage,
  onPaste: onRerunPaste,
  clearAttachments: clearRerunAttachments,
} = useComposerAttachments({
  canAdd: canAddRerunImages,
  allowImages: canAddRerunImages,
  allowTextFiles: disallowRerunTextFiles,
});

const instance = computed(() =>
  orch.selectedInstance?.id === props.instanceId ? orch.selectedInstance : null,
);
const focusedNodeId = ref<string | null>(null);
const suppressAutoNodeSelection = ref(false);
const detailModalOpen = ref(false);
const detailModalFullscreen = ref(false);
const detailModalView = ref<"detail" | "chat">("detail");
const detailThreadLoading = ref(false);
const detailThreadIdOverride = ref<ThreadId | null>(null);
const detailModalViewportHeight = ref(720);
const eventsModalOpen = ref(false);
const reassignModalOpen = ref(false);
const reassignNodeId = ref<string | null>(null);
const reassignAssigneeDraft = ref<string[]>([]);
const reassigningNodeAssignees = ref(false);
const rerunModalOpen = ref(false);
const rerunSubmitting = ref(false);
const rerunNodeId = ref<string | null>(null);
const rerunNote = ref("");
const rerunTargetThreadPolicy = ref<NodeThreadReusePolicy>("reuse-existing");
const rerunDownstreamThreadPolicy = ref<DownstreamThreadReusePolicy>("preserve-existing");
const rerunNodeScope = ref<RerunNodeScope>("downstream");
const rerunCustomNodeIds = ref<string[]>([]);
const rerunExecutionOverrideEnabled = ref(false);
const rerunExecutionOverrideScope = ref<RerunExecutionOverrideScope>("affected");
const rerunApplyLatestWorkItemPolicy = ref(true);
const rerunExecutionOverrideDraft = ref<RerunExecutionOverrideDraft>({
  engine: "codex",
  model: "",
  effort: "",
  autoCompactPct: null,
});
const manualStartFeedbackText = ref("");
const graphContextMenu = ref<{
  kind: "node" | "edge";
  id: string;
  x: number;
  y: number;
  title: string;
} | null>(null);
const relatedInstances = computed(() => {
  const current = instance.value;
  if (!current) return [];
  const intakeId = String(current.intakeSnapshot.id ?? "");
  return orch.instanceSummaries
    .filter((item) => String(item.intakeId ?? "") === intakeId)
    .sort((left, right) => right.createdAt - left.createdAt);
});
const selectedInstanceDetailsErrorText = computed(() => {
  const errors = orch.selectedInstanceDetailErrors;
  const parts = [
    errors.artifacts ? `交付物：${errors.artifacts}` : "",
    errors.events ? `事件：${errors.events}` : "",
    errors.promptSnapshots ? `Prompt：${errors.promptSnapshots}` : "",
    errors.artifactFiles ? `文件：${errors.artifactFiles}` : "",
  ].filter(Boolean);
  return parts.join("；");
});

/** 仅在 Monitor 所属 KeepAlive 页面激活且仍处于编排主视图时选择缓存或补运行态。 */
function canHydrateMonitorInstance(): boolean {
  return monitorViewActive.value && ui.mainView === "orchestration";
}

/** 选择缓存实例；KeepAlive 恢复仅对活动缓存实例补一次轻量运行态。 */
function requestMonitorInstanceHydration(
  instanceId: OrchestrationId,
  options: { refreshRuntimePatch?: boolean } = {},
): void {
  if (!canHydrateMonitorInstance()) return;
  const cachedBeforeLoad = orch.selectedInstance?.id === instanceId
    || orch.instances.some((item) => item.id === instanceId);
  void orch.loadInstance(ctx.value, props.workspaceId, instanceId, { force: false }).then(async (loaded) => {
    if (!loaded || !cachedBeforeLoad || !options.refreshRuntimePatch || !canHydrateMonitorInstance()) return;
    if (loaded.status === "completed" || loaded.status === "failed" || loaded.status === "cancelled") return;
    await orch.loadTrackedInstanceRuntimePatch(ctx.value, props.workspaceId, instanceId, { syncSelection: true });
  }).catch((error) => {
    console.error("[OrchestrationMonitor] instance hydration failed", {
      ...errorDiagnosticContext(error, "ORCH_MONITOR_INSTANCE_HYDRATION_FAILED"),
      workspaceId: String(props.workspaceId),
      instanceId: String(instanceId),
    });
    message.error(error instanceof Error ? error.message : "加载实例详情失败");
  });
}

watch(() => props.instanceId, (id) => {
  focusedNodeId.value = null;
  suppressAutoNodeSelection.value = false;
  detailModalOpen.value = false;
  detailModalFullscreen.value = false;
  detailModalView.value = "detail";
  detailThreadLoading.value = false;
  detailThreadIdOverride.value = null;
  eventsModalOpen.value = false;
  reassignModalOpen.value = false;
  reassignNodeId.value = null;
  reassignAssigneeDraft.value = [];
  rerunModalOpen.value = false;
  rerunSubmitting.value = false;
  rerunNodeId.value = null;
  rerunNote.value = "";
  rerunNodeScope.value = "downstream";
  rerunCustomNodeIds.value = [];
  rerunExecutionOverrideEnabled.value = false;
  closeGraphContextMenu();
  if (id) requestMonitorInstanceHydration(id, { refreshRuntimePatch: true });
}, { immediate: true });

onMounted(() => {
  syncDetailModalViewportHeight();
  window.addEventListener("pointerdown", handleGlobalPointerDown, true);
  window.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("resize", handleWindowResize);
});

onActivated(() => {
  const wasInactive = !monitorViewActive.value;
  monitorViewActive.value = true;
  if (wasInactive && props.instanceId) {
    requestMonitorInstanceHydration(props.instanceId, { refreshRuntimePatch: true });
  }
});

onDeactivated(() => {
  monitorViewActive.value = false;
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", handleGlobalPointerDown, true);
  window.removeEventListener("keydown", handleGlobalKeydown);
  window.removeEventListener("resize", handleWindowResize);
});

const requirementTitle = computed(() => getTaskIntakeTitle(instance.value?.intakeSnapshot));
const workflowTitle = computed(() => instance.value?.workflowSnapshot?.name ?? "执行流程");
const selectedNodeId = computed(() => {
  if (!instance.value) return null;
  if (focusedNodeId.value && instance.value.nodeStates[focusedNodeId.value]) {
    return focusedNodeId.value;
  }
  if (suppressAutoNodeSelection.value) {
    return null;
  }
  const states = instance.value.nodeStates;
  for (const [id, state] of Object.entries(states)) {
    if (isRunningLikeStatus(state.status) || state.status === "waiting-start" || state.status === "waiting-approval" || state.status === "waiting-feedback") {
      return id;
    }
  }
  const nextActionableNode = findNextActionableNode(instance.value);
  if (nextActionableNode) {
    return nextActionableNode.id;
  }
  const reversedNodes = [...(instance.value.workflowSnapshot?.nodes ?? [])].reverse();
  const informativeNode = reversedNodes.find((node) => {
    const state = states[node.id];
    if (!state) return false;
    return Boolean(state.threadId) || (state.outputArtifactIds?.length ?? 0) > 0 || state.status === "failed";
  });
  if (informativeNode) return informativeNode.id;
  return instance.value.workflowSnapshot?.nodes?.find((node) => states[node.id])?.id ?? null;
});
const selectedNodeState = computed(() => {
  if (!instance.value || !selectedNodeId.value) return null;
  return instance.value.nodeStates[selectedNodeId.value] ?? null;
});
const selectedNodeWorkbench = computed(() => resolveNodeWorkbenchDescriptor(selectedNodeState.value));
const selectedNode = computed(() =>
  instance.value?.workflowSnapshot?.nodes?.find((node) => node.id === selectedNodeId.value) ?? null,
);
const selectedNodeLabel = computed(() => selectedNode.value?.label ?? selectedNodeId.value ?? "");
const selectedManualStartPrompt = computed(() => String(selectedNode.value?.manualStartPrompt ?? "").trim());
const currentWorkspace = computed(() => workspaces.byId.get(props.workspaceId) ?? null);
const currentSharedRole = computed(() =>
  currentWorkspace.value?.capabilities?.effectiveAssetRole
  ?? currentWorkspace.value?.shared?.effectiveAssetRole
  ?? currentWorkspace.value?.shared?.currentUserRole
  ?? null,
);
const sharedWorkspaceId = computed(() => parseSharedWorkspaceSelectionId(String(props.workspaceId ?? "")));
/** 共享工作区内的负责人管理以服务端返回的有效资产角色为准。 */
const canManageNodeAssignees = computed(() => {
  if (!isSharedWorkspaceSelectionId(String(props.workspaceId))) return true;
  const role = String(currentSharedRole.value ?? "");
  return role === "enterprise_admin"
    || role === "workspace_admin";
});
const canBypassNodeAssignee = computed(() => {
  if (!isSharedWorkspaceSelectionId(String(props.workspaceId))) return true;
  return canManageNodeAssignees.value;
});
const activeSharedMemberOptions = computed(() => {
  const id = sharedWorkspaceId.value;
  if (!id) return [] as Array<{ userId: string; label: string }>;
  return (sharedWorkspaces.membersByWorkspaceId[id] ?? [])
    .filter((member: SharedWorkspaceMemberItem) => member.status === "active")
    .map((member: SharedWorkspaceMemberItem) => ({
      userId: String(member.userId ?? "").trim(),
      label: formatSharedMemberLabel(member),
    }))
    .filter((item) => item.userId);
});
const sharedMemberNameByUserId = computed(() => {
  const id = sharedWorkspaceId.value;
  if (!id) return new Map<string, string>();
  return new Map(
    (sharedWorkspaces.membersByWorkspaceId[id] ?? [])
      .map((member) => {
        const userId = String(member.userId ?? "").trim();
        const label = String(member.displayName || member.email || userId).trim();
        return [userId, label] as const;
      })
      .filter(([userId, label]) => Boolean(userId && label)),
  );
});
const selectedNodeAssigneeLabels = computed(() =>
  selectedNodeId.value ? nodeDisplayAssigneeUserIds(selectedNodeId.value, selectedNode.value?.type).map(formatNodeAssigneeLabel) : [],
);
const nodeAssigneeLabelsByNodeId = computed<Record<string, string[]>>(() => {
  const current = instance.value;
  if (!current) return {};
  const entries = (current.workflowSnapshot?.nodes ?? [])
    .map((node) => {
      const labels = nodeDisplayAssigneeUserIds(node.id, node.type).map(formatNodeAssigneeLabel);
      return [node.id, labels] as const;
    })
    .filter(([, labels]) => labels.length > 0);
  return Object.fromEntries(entries);
});
const canOperateSelectedNode = computed(() => canOperateNode(selectedNodeId.value));
const isSelectedNodeBranchDecision = computed(() =>
  selectedNodeState.value?.status === "waiting-feedback"
  && selectedNodeWorkbench.value.attentionKind === "branch_decision",
);
const selectedNodeThreadId = computed(() => {
  if (!selectedNodeId.value) return null;
  return nodeThreadId(selectedNodeId.value);
});
const detailThreadId = computed(() => detailThreadIdOverride.value ?? selectedNodeThreadId.value);
const selectedNodeChatThread = computed(() => {
  const threadId = detailThreadId.value;
  if (!threadId) return null;
  return chat.threadSummaryById(threadId);
});
// 分支选择没有产物审阅区，使用单栏操作弹框避免左侧空白。
const showBranchDecisionDialog = computed(() =>
  detailModalView.value === "detail" && canOperateSelectedNode.value && isSelectedNodeBranchDecision.value,
);
const detailModalTitle = computed(() => {
  if (detailModalView.value === "chat") {
    return selectedNodeLabel.value ? `节点会话：${selectedNodeLabel.value}` : "节点会话";
  }
  if (showBranchDecisionDialog.value) {
    return selectedNodeLabel.value ? `选择分支：${selectedNodeLabel.value}` : "选择分支";
  }
  return selectedNodeLabel.value ? `节点详情：${selectedNodeLabel.value}` : "节点详情";
});
const detailModalWrapClassName = computed(() => {
  const classes = ["orch-monitor__detail-modal-wrap"];
  if (showBranchDecisionDialog.value) {
    classes.push("orch-monitor__detail-modal-wrap--branch");
  } else if (detailModalFullscreen.value) {
    classes.push("orch-monitor__detail-modal-wrap--fullscreen");
  }
  return classes.join(" ");
});
const detailModalStyle = computed(() => {
  if (showBranchDecisionDialog.value) {
    return {
      top: "0",
      paddingBottom: "0",
      overflow: "hidden",
    } as const;
  }
  const viewportHeight = Math.max(540, detailModalViewportHeight.value);
  const shellHeight = detailModalFullscreen.value
    ? viewportHeight
    : Math.max(420, viewportHeight - 40);
  return {
    top: "0",
    height: `${shellHeight}px`,
    minHeight: `${shellHeight}px`,
    maxHeight: `${shellHeight}px`,
    paddingBottom: "0",
    overflow: "hidden",
  } as const;
});
const detailModalBodyStyle = computed(() => {
  if (showBranchDecisionDialog.value) {
    return {
      padding: "12px 14px 14px",
      maxHeight: "calc(100dvh - 140px)",
      overflow: "auto",
    } as const;
  }
  const viewportHeight = Math.max(540, detailModalViewportHeight.value);
  const bodyHeight = detailModalFullscreen.value
    ? Math.max(300, viewportHeight - 84)
    : Math.max(260, viewportHeight - 124);
  return {
    padding: "10px 14px",
    height: `${bodyHeight}px`,
    minHeight: `${bodyHeight}px`,
    maxHeight: `${bodyHeight}px`,
    overflow: "hidden",
  } as const;
});
const detailModalWidth = computed(() => {
  if (showBranchDecisionDialog.value) return "min(680px, calc(100vw - 32px))";
  return detailModalFullscreen.value ? "100vw" : "90%";
});
const reviewNode = computed(() => {
  if (!instance.value) return null;
  for (const node of instance.value.workflowSnapshot?.nodes ?? []) {
    const state = instance.value.nodeStates[node.id];
    if (!state) continue;
    if (state.status === "waiting-start" || state.status === "waiting-feedback" || state.status === "waiting-approval") {
      return { node, state };
    }
  }
  return null;
});
const reviewNodeWorkbench = computed(() =>
  reviewNode.value ? resolveNodeWorkbenchDescriptor(reviewNode.value.state) : null,
);
const canOperateReviewNode = computed(() => canOperateNode(reviewNode.value?.node.id));
const isSelectedNodeAwaitingAction = computed(() =>
  selectedNodeState.value?.status === "waiting-start" || selectedNodeState.value?.status === "waiting-approval" || selectedNodeState.value?.status === "waiting-feedback",
);
const isSelectedNodeReviewAction = computed(() =>
  selectedNodeState.value?.status === "waiting-approval" || selectedNodeState.value?.status === "waiting-feedback",
);
const selectedNodeThreadGuardActive = computed(() =>
  detailModalView.value === "chat"
  && (
    requiresStructuredNodeThreadAction(selectedNodeState.value)
    || !canAcceptFreeTextNodeInput(selectedNodeState.value)
  ),
);
/** 判断节点执行会话是否仍能把自由文本解释为当前节点输入。 */
function canAcceptFreeTextNodeInput(state: NodeExecutionState | null | undefined): boolean {
  if (!state) return false;
  if (requiresStructuredNodeThreadAction(state)) return false;
  if (state.status === "running") return true;
  return state.status === "pending"
    || state.status === "ready"
    || state.status === "queued"
    || state.status === "waiting-feedback";
}
/** 为不能由自由文本表达的节点动作提供直接、可执行的提示。 */
const selectedNodeThreadGuardCopy = computed(() => {
  if (selectedNodeState.value?.status === "waiting-start") {
    return {
      message: "当前节点需要明确启动或跳过，不能用自由文本代替。",
      action: "启动或跳过",
    };
  }
  if (selectedNodeState.value?.status === "waiting-approval") {
    return {
      message: "当前节点需要明确审批，不能用自由文本代替。",
      action: "审批",
    };
  }
  if (isSelectedNodeBranchDecision.value) {
    return {
      message: "当前节点需要明确选择分支，不能用自由文本代替。",
      action: "选择分支",
    };
  }
  if (!canAcceptFreeTextNodeInput(selectedNodeState.value)) {
    return {
      message: "当前节点已不再接收输入；如需继续修改，请从节点详情发起重跑。",
      action: "查看节点详情",
    };
  }
  return {
    message: "当前节点需要明确操作，不能用自由文本代替。",
    action: "处理",
  };
});
const selectedNodeThreadComposerDisabled = computed(() => !canOperateSelectedNode.value || selectedNodeThreadGuardActive.value);
const selectedNodeThreadReadonlyGuardActive = computed(() => detailModalView.value === "chat" && !canOperateSelectedNode.value);
const selectedNodeConversation = computed(() =>
  selectedNodeThreadId.value ? chat.threadDisplayConversationForThread(selectedNodeThreadId.value) : null,
);
const selectedNodePendingInteractionItems = computed(() =>
  collectPendingInteractionItems(selectedNodeConversation.value),
);
const selectedNodePendingInteractionText = computed(() => {
  const count = selectedNodePendingInteractionItems.value.length;
  if (count <= 0) return "";
  const hasUserInput = selectedNodePendingInteractionItems.value.some((item) => item.kind === "userInputRequest");
  const hasApproval = selectedNodePendingInteractionItems.value.some((item) => item.kind === "approvalRequest");
  if (count === 1 && hasUserInput) return "需要补充输入";
  if (count === 1 && hasApproval) return "需要确认";
  return `${count} 项待处理`;
});
const pendingInteractionHydratedThreadIds = new Set<string>();
const pendingInteractionHydrateStatuses = new Set<NodeExecutionStatus>([
  "running",
  "result-submitted",
  "finalizing",
  "artifact-writing",
  "gate-checking",
  "waiting-approval",
  "waiting-feedback",
]);

watch(() => selectedNodeId.value, () => {
  detailThreadIdOverride.value = null;
});
watch([selectedNodeId, () => selectedNodeState.value?.status], () => {
  manualStartFeedbackText.value = "";
});
watch([
  selectedNodeThreadId,
  () => selectedNodeState.value?.status,
  monitorViewActive,
  () => ui.mainView,
], ([threadId, status]) => {
  if (!canHydrateMonitorInstance()) return;
  if (!threadId || !status || !pendingInteractionHydrateStatuses.has(status)) return;
  void ensureSelectedNodePendingInteractions(threadId);
}, { immediate: true });
function hydrateSharedMembers(id: string | null): void {
  if (!canHydrateMonitorInstance() || !id) return;
  void sharedWorkspaces.loadMembers(id).then((result) => {
    if (!result.ok) throw new Error(result.message || "加载共享成员失败");
  }).catch((error) => {
    console.error("[OrchestrationMonitor] shared member hydration failed", {
      ...errorDiagnosticContext(error, "ORCH_MONITOR_SHARED_MEMBERS_HYDRATION_FAILED"),
      workspaceId: String(props.workspaceId),
      instanceId: String(props.instanceId),
      sharedWorkspaceId: id,
    });
    message.error(error instanceof Error ? error.message : "加载共享成员失败");
  });
}

watch([
  sharedWorkspaceId,
  monitorViewActive,
  () => ui.mainView,
  () => config.userSummary?.userId,
  () => instance.value?.updatedAt,
], ([id]) => {
  // 成员接口可能早于账号会话或实例详情完成；上下文恢复后再补一次，避免永久回退到 userId。
  if (!id || sharedWorkspaces.membersByWorkspaceId[id]?.length) return;
  hydrateSharedMembers(id);
}, { immediate: true });
const showReviewWorkspace = computed(() =>
  detailModalView.value === "detail"
  && canOperateSelectedNode.value
  && isSelectedNodeReviewAction.value
  && !isSelectedNodeBranchDecision.value,
);
const showManualStartWorkspace = computed(() =>
  detailModalView.value === "detail"
  && canOperateSelectedNode.value
  && selectedNodeState.value?.status === "waiting-start",
);
const forceCompletableStatuses = new Set<NodeExecutionStatus>([
  "ready",
  "queued",
  "running",
  "result-submitted",
  "finalizing",
  "artifact-writing",
  "gate-checking",
  "waiting-feedback",
  "failed",
]);
// 仅活跃执行态允许停止节点；其他状态无 in-flight turn，按钮不显示。
const cancellableNodeStatuses = new Set<NodeExecutionStatus>([
  "running",
  "queued",
  "result-submitted",
  "finalizing",
  "artifact-writing",
  "gate-checking",
]);
/** 判断当前账号是否可以推进指定节点；共享节点处理人配置会进一步收窄成员写权。 */
function canOperateNode(nodeId: string | null | undefined): boolean {
  if (props.readOnly) return false;
  if (!nodeId || !instance.value) return true;
  const assigneeUserIds = nodeAssigneeUserIds(nodeId);
  if (assigneeUserIds.length === 0 || canBypassNodeAssignee.value) return true;
  const currentUserId = String(config.userSummary?.userId ?? "").trim();
  return Boolean(currentUserId && assigneeUserIds.includes(currentUserId));
}

/** 读取实例冻结的节点处理人；流程快照不再承载默认处理人。 */
function nodeAssigneeUserIds(nodeId: string): string[] {
  const source = instance.value?.nodeStates?.[nodeId]?.assigneeUserIds;
  if (!Array.isArray(source)) return [];
  return Array.from(new Set(source.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

/** 读取节点展示用的当前处理人；独立运行的角色节点回退到发起人账号。 */
function nodeDisplayAssigneeUserIds(nodeId: string, nodeType: string | null | undefined): string[] {
  const assigneeUserIds = nodeAssigneeUserIds(nodeId);
  if (assigneeUserIds.length || nodeType !== "role") return assigneeUserIds;
  const initiatorUserId = String(instance.value?.runtimeConfig?.initiatorUserId ?? "").trim();
  return initiatorUserId ? [initiatorUserId] : [];
}

/** 把节点处理人 ID 映射成成员或当前用户展示名；资料尚未加载时保留 ID 便于排障。 */
function formatNodeAssigneeLabel(userId: string): string {
  return sharedMemberNameByUserId.value.get(userId) ?? formatCurrentUserLabel(userId) ?? userId;
}

/** 本地独立运行只能可靠识别当前账号，其他历史用户仍保留 userId。 */
function formatCurrentUserLabel(userId: string): string | null {
  const currentUserId = String(config.userSummary?.userId ?? "").trim();
  if (!currentUserId || currentUserId !== userId) return null;
  return String(config.userSummary?.fullName || config.userSummary?.email || currentUserId).trim() || currentUserId;
}

/** 展示共享成员候选名称，成员资料缺失时保留用户 ID。 */
function formatSharedMemberLabel(member: SharedWorkspaceMemberItem): string {
  return member.displayName || member.email || member.userId;
}

/** 汇总节点处理人展示，避免多人配置时挤占节点状态栏。 */
function summarizeNodeAssigneeLabels(labels: string[]): string {
  if (labels.length <= 3) return labels.join("、");
  return `${labels.slice(0, 3).join("、")} 等 ${labels.length} 人`;
}

/** 统一节点处理人限制下的提示文案。 */
function nodeReadonlyMessage(action: string): string {
  return `当前节点已指定其他处理人或只读，不能${action}`;
}

/** 判断当前账号是否能转派实例节点处理人；仅共享空间管理员或企业/平台管理员开放。 */
function canReassignNodeAssignees(nodeId: string | null | undefined): boolean {
  if (props.readOnly || !sharedWorkspaceId.value || !canManageNodeAssignees.value || !nodeId || !instance.value) return false;
  const node = instance.value.workflowSnapshot?.nodes?.find((item) => item.id === nodeId);
  return node?.type === "role" && Boolean(instance.value.nodeStates[nodeId]);
}

const canForceCompleteSelectedNode = computed(() => {
  return canOperateSelectedNode.value && canForceCompleteNode(selectedNodeState.value);
});
const canCancelSelectedNode = computed(() => canOperateSelectedNode.value && canCancelNode(selectedNodeState.value));
const canStartSelectedNode = computed(() => canOperateSelectedNode.value && canStartNode(selectedNodeState.value));
const canSkipSelectedNode = computed(() => canOperateSelectedNode.value && canSkipWaitingNode(selectedNodeState.value));
const contextMenuNodeState = computed(() => {
  if (!instance.value || graphContextMenu.value?.kind !== "node") return null;
  return instance.value.nodeStates[graphContextMenu.value.id] ?? null;
});
const contextMenuWorkbench = computed(() => resolveNodeWorkbenchDescriptor(contextMenuNodeState.value));
const contextMenuNodeThreadId = computed(() => {
  if (graphContextMenu.value?.kind !== "node") return null;
  return nodeThreadId(graphContextMenu.value.id);
});
const contextMenuNeedsReview = computed(() =>
  canOperateNode(graphContextMenu.value?.kind === "node" ? graphContextMenu.value.id : null)
  && (contextMenuNodeState.value?.status === "waiting-approval" || contextMenuNodeState.value?.status === "waiting-feedback"),
);
const contextMenuCanStart = computed(() =>
  canOperateNode(graphContextMenu.value?.kind === "node" ? graphContextMenu.value.id : null) && canStartNode(contextMenuNodeState.value),
);
const contextMenuCanSkip = computed(() =>
  canOperateNode(graphContextMenu.value?.kind === "node" ? graphContextMenu.value.id : null) && canSkipWaitingNode(contextMenuNodeState.value),
);
const contextMenuCanForceComplete = computed(() =>
  canOperateNode(graphContextMenu.value?.kind === "node" ? graphContextMenu.value.id : null) && canForceCompleteNode(contextMenuNodeState.value),
);
const contextMenuCanCancel = computed(() =>
  canOperateNode(graphContextMenu.value?.kind === "node" ? graphContextMenu.value.id : null) && canCancelNode(contextMenuNodeState.value),
);
const canReassignSelectedNode = computed(() => canReassignNodeAssignees(selectedNodeId.value));
const contextMenuCanReassign = computed(() =>
  graphContextMenu.value?.kind === "node" && canReassignNodeAssignees(graphContextMenu.value.id),
);
const runSummary = computed(() => {
  if (!instance.value) return "";
  const parts = [
    `需求：${requirementTitle.value}`,
    `创建于 ${formatDateTime(instance.value.createdAt)}`,
  ];
  if (relatedInstances.value.length > 1) {
    parts.push(`同一需求共 ${relatedInstances.value.length} 次执行`);
  }
  return parts.join(" · ");
});
const roleNameById = computed<Record<string, string>>(() =>
  Object.fromEntries(
    orch.roles
      .map((role) => [String(role.id), String(role.name ?? "").trim()] as const)
      .filter((entry) => entry[0] && entry[1]),
  ),
);
const selectedNodeFacts = computed(() => {
  const state = selectedNodeState.value;
  if (!state) return [];
  const facts = [
    `输入 ${state.inputArtifactIds?.length ?? 0} · 输出 ${state.outputArtifactIds?.length ?? 0}`,
    `会话 ${selectedNodeThreadId.value ? "已创建" : "暂无"} · 人工 ${isSelectedNodeAwaitingAction.value ? "需要" : "无需"} · 重试 ${state.retryCount}`,
  ];
  if (selectedNodeAssigneeLabels.value.length) {
    facts.push(`处理人 ${summarizeNodeAssigneeLabels(selectedNodeAssigneeLabels.value)}`);
  }
  const verdict = state.conclusion?.reviewVerdict
    ? state.conclusion.reviewVerdict === "fail"
      ? "不通过"
      : state.conclusion.reviewVerdict === "partial"
        ? "部分满足"
        : "通过"
    : null;
  const duration = formatNodeDuration(state.startedAt ?? null, state.completedAt ?? null);
  if (verdict && duration !== "-") {
    facts.push(`结论 ${verdict} · 耗时 ${duration}`);
  } else if (verdict) {
    facts.push(`结论 ${verdict}`);
  } else if (duration !== "-") {
    facts.push(`耗时 ${duration}`);
  }
  return facts;
});
const selectedNodeTimeline = computed(() => {
  const state = selectedNodeState.value;
  if (!state?.startedAt && !state?.completedAt) return null;
  if (state?.startedAt && state?.completedAt) {
    return `${formatDateTime(state.startedAt)} -> ${formatDateTime(state.completedAt)}`;
  }
  if (state?.startedAt) return `开始 ${formatDateTime(state.startedAt)}`;
  return state?.completedAt ? `完成 ${formatDateTime(state.completedAt)}` : null;
});
const reviewBannerText = computed(() => {
  return reviewNodeWorkbench.value?.bannerText ?? "";
});
const reviewActionLabel = computed(() => reviewNodeWorkbench.value?.actionLabel ?? "查看结果并处理");
const reviewBadgeLabel = computed(() => reviewNodeWorkbench.value?.badgeLabel ?? "待处理");
const contextMenuActionLabel = computed(() => contextMenuWorkbench.value?.actionLabel ?? "查看结果并处理");

function formatDateTime(ts: number): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function syncDetailModalViewportHeight() {
  if (typeof window === "undefined") return;
  detailModalViewportHeight.value = Math.max(480, Math.floor(window.innerHeight));
}

function handleWindowResize() {
  closeGraphContextMenu();
  syncDetailModalViewportHeight();
}

function formatEventTime(ts: number): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatInstanceOptionLabel(createdAt: number): string {
  return new Date(createdAt).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatNodeDuration(startTs: number | null | undefined, completedTs: number | null | undefined): string {
  if (!startTs) return "-";
  const endTs = completedTs && completedTs >= startTs ? completedTs : Date.now();
  const elapsed = Math.max(0, Math.floor((endTs - startTs) / 1000));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}m ${seconds}s`;
}

function findNextActionableNode(current: NonNullable<typeof instance.value>) {
  const states = current.nodeStates;
  const hasProgress = Object.values(states).some((state) =>
    state.status !== "pending" && state.status !== "ready" && state.status !== "queued",
  );
  if (!hasProgress) return null;
  return current.workflowSnapshot?.nodes?.find((node) => {
    const state = states[node.id];
    if (!state) return false;
    return state.status === "ready" || state.status === "queued" || state.status === "pending";
  }) ?? null;
}

function canForceCompleteNode(nodeState: { status: NodeExecutionStatus } | null | undefined): boolean {
  if (!instance.value || !nodeState) return false;
  if (
    instance.value.status !== "running"
    && instance.value.status !== "paused"
    && instance.value.status !== "waiting-approval"
    && instance.value.status !== "waiting-feedback"
  ) {
    return false;
  }
  return forceCompletableStatuses.has(nodeState.status);
}

/** 是否允许启动该节点：仅 waiting-start 节点可放行，实例必须仍处于活跃等待态。 */
function canStartNode(nodeState: { status: NodeExecutionStatus } | null | undefined): boolean {
  if (!instance.value || !nodeState) return false;
  if (
    instance.value.status !== "running"
    && instance.value.status !== "waiting-start"
    && instance.value.status !== "waiting-approval"
    && instance.value.status !== "waiting-feedback"
  ) {
    return false;
  }
  return nodeState.status === "waiting-start";
}

/** 是否允许跳过待启动节点：只处理 waiting-start，避免绕过未就绪节点的前置条件。 */
function canSkipWaitingNode(nodeState: { status: NodeExecutionStatus } | null | undefined): boolean {
  if (!instance.value || !nodeState) return false;
  if (
    instance.value.status !== "running"
    && instance.value.status !== "waiting-start"
    && instance.value.status !== "waiting-approval"
    && instance.value.status !== "waiting-feedback"
  ) {
    return false;
  }
  return nodeState.status === "waiting-start";
}

/** 是否允许停止该节点：instance 必须仍活跃，节点必须处于活跃执行态（有 in-flight turn 可中断）。 */
function canCancelNode(nodeState: { status: NodeExecutionStatus } | null | undefined): boolean {
  if (!instance.value || !nodeState) return false;
  if (
    instance.value.status !== "running"
    && instance.value.status !== "waiting-start"
    && instance.value.status !== "waiting-approval"
    && instance.value.status !== "waiting-feedback"
  ) {
    return false;
  }
  return cancellableNodeStatuses.has(nodeState.status);
}

/**
 * 判断指定节点是否允许「从此节点重跑」。
 * 规则：仅 role 类型节点、且 instance 不处于 cancelled 过渡态；节点状态不限（引擎会先 cancelAndWait 再重置）。
 */
function canRerunFromNodeId(nodeId: string | null | undefined): boolean {
  if (!canOperateNode(nodeId)) return false;
  if (!instance.value || !nodeId) return false;
  const node = instance.value.workflowSnapshot?.nodes?.find((item) => item.id === nodeId) ?? null;
  if (!node || node.type !== "role") return false;
  const nodeState = instance.value.nodeStates[nodeId];
  return Boolean(nodeState);
}

/** 计算实际重跑集合中的下游 role 节点，用于展示级联新建会话选项。 */
function collectAffectedDownstreamRoleNodeIds(targetNodeId: string, nodeIds: string[] | null): string[] {
  const current = instance.value;
  if (!current) return [];
  const affectedNodeIds = new Set(nodeIds ?? collectRerunAffectedNodeIds(current.workflowSnapshot, targetNodeId));
  affectedNodeIds.delete(targetNodeId);
  return current.workflowSnapshot.nodes
    .filter((node) => node.type === "role" && affectedNodeIds.has(node.id))
    .map((node) => node.id);
}

const rerunTargetNode = computed(() => {
  const current = instance.value;
  const nodeId = rerunNodeId.value;
  if (!current || !nodeId) return null;
  return current.workflowSnapshot.nodes.find((node) => node.id === nodeId) ?? null;
});
const rerunTargetNodeLabel = computed(() => String(rerunTargetNode.value?.label ?? rerunNodeId.value ?? "").trim() || "未选择节点");
const rerunTargetRoleId = computed(() => String(rerunTargetNode.value?.roleId ?? "").trim());
const rerunNodeIds = computed<string[] | null>(() => {
  const current = instance.value;
  const nodeId = rerunNodeId.value;
  if (!current || !nodeId) return null;
  return buildRerunNodeIds(current.workflowSnapshot, nodeId, rerunNodeScope.value, rerunCustomNodeIds.value);
});
const rerunNodeSelectionError = computed(() => {
  const current = instance.value;
  const nodeId = rerunNodeId.value;
  if (!current || !nodeId) return null;
  return validateRerunNodeIds(current.workflowSnapshot, nodeId, rerunNodeIds.value);
});
/** 返回重跑范围内已启用顺序工作项的快照节点。 */
const rerunWorkItemNodes = computed(() => {
  const current = instance.value;
  const nodeId = rerunNodeId.value;
  if (!current || !nodeId) return [];
  const affectedNodeIds = new Set(rerunNodeIds.value ?? collectRerunAffectedNodeIds(current.workflowSnapshot, nodeId));
  return current.workflowSnapshot.nodes.filter((node) => (
    affectedNodeIds.has(node.id) && node.type === "role" && node.workItemPolicy?.mode === "sequential"
  ));
});
const rerunLiveWorkflow = computed(() => {
  const workflowId = instance.value?.workflowId;
  return workflowId ? orch.workflows.find((workflow) => workflow.id === workflowId) ?? null : null;
});
/** 只允许同节点、同角色且仍为顺序工作项的当前策略覆盖历史运行。 */
const rerunWorkItemPolicySyncAvailable = computed(() => {
  const liveWorkflow = rerunLiveWorkflow.value;
  const nodes = rerunWorkItemNodes.value;
  if (!liveWorkflow || nodes.length === 0) return false;
  return nodes.every((snapshotNode) => {
    const liveNode = liveWorkflow.nodes.find((node) => node.id === snapshotNode.id) ?? null;
    return liveNode?.type === "role"
      && liveNode.roleId === snapshotNode.roleId
      && liveNode.workItemPolicy?.mode === "sequential";
  });
});
const rerunCustomNodeOptions = computed(() => {
  const current = instance.value;
  const nodeId = rerunNodeId.value;
  if (!current || !nodeId) return [];
  const affectedNodeIds = new Set(collectRerunAffectedNodeIds(current.workflowSnapshot, nodeId));
  affectedNodeIds.delete(nodeId);
  return current.workflowSnapshot.nodes
    .filter((node) => affectedNodeIds.has(node.id))
    .map((node) => ({ value: node.id, label: `${node.label}（${node.type === "role" ? "角色" : "流程"}）` }));
});
/** 运行新 attempt 时引擎使用当前工作区角色；实例快照只作为旧数据加载时的只读兜底。 */
const rerunLiveRolesById = computed(() => new Map<string, RoleDefinition>(
  orch.roles
    .filter((role) => role.workspaceId === props.workspaceId)
    .map((role) => [String(role.id), role]),
));
/** 解析重跑角色定义，优先与执行引擎一致的 live Role。 */
function resolveRerunRoleDefinition(roleId: string): RoleRuntimeDefinition | null {
  return rerunLiveRolesById.value.get(roleId)
    ?? instance.value?.roleSnapshots?.[roleId]
    ?? null;
}
const rerunTargetRole = computed(() => {
  const roleId = rerunTargetRoleId.value;
  return roleId ? resolveRerunRoleDefinition(roleId) : null;
});
const rerunTargetHasThread = computed(() => {
  const nodeId = rerunNodeId.value;
  return Boolean(nodeId && String(instance.value?.nodeStates[nodeId]?.threadId ?? "").trim());
});
const rerunDownstreamRoleNodeIds = computed(() => {
  const nodeId = rerunNodeId.value;
  return nodeId ? collectAffectedDownstreamRoleNodeIds(nodeId, rerunNodeIds.value) : [];
});
const rerunDownstreamThreadCount = computed(() =>
  rerunDownstreamRoleNodeIds.value.filter((nodeId) => String(instance.value?.nodeStates[nodeId]?.threadId ?? "").trim()).length,
);
const rerunExecutionOverrideMutable = computed(() => {
  const status = instance.value?.status;
  return Boolean(status && status !== "running");
});
const rerunScopeRoleIds = computed(() => {
  const current = instance.value;
  const nodeId = rerunNodeId.value;
  if (!current || !nodeId) return [];
  return collectRerunScopeRoleIds(current.workflowSnapshot, nodeId, rerunExecutionOverrideScope.value, rerunNodeIds.value);
});
const rerunScopeRoles = computed(() =>
  rerunScopeRoleIds.value.map((roleId) => {
    const role = resolveRerunRoleDefinition(roleId);
    return {
      roleId,
      role,
      name: String(role?.name ?? roleId).trim() || roleId,
    };
  }),
);
const rerunMissingRoleIds = computed(() =>
  rerunScopeRoles.value.filter((item) => !item.role).map((item) => item.roleId),
);
const rerunExecutionEngineOptions = computed<Array<{ value: EngineType; label: string }>>(() => {
  if (rerunScopeRoles.value.length === 0 || rerunMissingRoleIds.value.length > 0) return [];
  return (["codex", "claude"] as EngineType[])
    .filter((engine) => rerunScopeRoles.value.every((item) => (
      item.role && isRoleExecutionEngineEnabled(item.role.executionConfig, engine, item.role.executionConfig.preferredEngine)
    )))
    .map((engine) => ({ value: engine, label: engine === "codex" ? "Codex" : "Claude Code" }));
});
const rerunIncompatibleRoleNames = computed(() =>
  rerunScopeRoles.value
    .filter((item) => item.role && !isRoleExecutionEngineEnabled(
      item.role.executionConfig,
      rerunExecutionOverrideDraft.value.engine,
      item.role.executionConfig.preferredEngine,
    ))
    .map((item) => item.name),
);
const rerunModelOptionGroups = computed<ModelSelectOptionGroup[]>(() =>
  buildModelSelectOptionGroups(
    engineModels(rerunExecutionOverrideDraft.value.engine),
    rerunExecutionOverrideDraft.value.model,
    { engine: rerunExecutionOverrideDraft.value.engine },
  ),
);
const rerunEffortOptions = computed<Array<{ value: string; label: string }>>(() => {
  const model = engineModels(rerunExecutionOverrideDraft.value.engine)
    .find((item) => item.id === rerunExecutionOverrideDraft.value.model) ?? null;
  return (model?.supportedReasoningEfforts ?? []).map((effort) => ({
    value: effort.reasoningEffort,
    label: effort.reasoningEffort,
  }));
});
const rerunScopeRoleSummary = computed(() => rerunScopeRoles.value.map((item) => item.name).join("、"));
const rerunFlowHint = computed(() => {
  const status = instance.value?.status;
  const isActive = status === "running"
    || status === "paused"
    || status === "waiting-start"
    || status === "waiting-approval"
    || status === "waiting-feedback";
  const scopeText = rerunNodeScope.value === "downstream"
    ? "此节点及全部有效下游"
    : rerunNodeScope.value === "single"
      ? "仅此节点"
      : `所选 ${rerunNodeIds.value?.length ?? 0} 个连续节点`;
  return isActive
    ? `系统会先终止本次运行中受影响的节点，再将${scopeText}重置为等待状态并继续调度。`
    : `系统会将${scopeText}重置为等待状态并继续调度。`;
});

/** 根据目标角色当前冻结配置初始化运行覆盖草稿，避免重跑弹窗意外带入其他节点的值。 */
function seedRerunExecutionOverrideDraft(): void {
  const role = rerunTargetRole.value;
  if (!role) {
    rerunExecutionOverrideDraft.value = {
      engine: "codex",
      model: "",
      effort: "",
      autoCompactPct: null,
    };
    return;
  }
  const previous = instance.value?.runtimeConfig?.roleExecutionOverrides?.[role.id] ?? null;
  const engine = previous?.engine === "claude" || previous?.engine === "codex"
    ? previous.engine
    : role.executionConfig.preferredEngine;
  const base = resolveCatalogRoleExecutionConfigForEngine(
    role.executionConfig,
    engine,
    engineModels(engine),
    role.executionConfig.preferredEngine,
  );
  const previousHasEffort = Boolean(previous && Object.prototype.hasOwnProperty.call(previous, "effort"));
  rerunExecutionOverrideDraft.value = {
    engine,
    model: String(previous?.model ?? base.model ?? "").trim(),
    effort: previousHasEffort ? String(previous?.effort ?? "").trim() : String(base.effort ?? "").trim(),
    autoCompactPct: normalizeRerunOptionalNumber(previous?.autoCompactPct, base.autoCompactPct),
  };
  ensureRerunExecutionOverrideEngine();
}

/** 归一化已有可选数值，防止历史无效值直接进入可提交草稿。 */
function normalizeRerunOptionalNumber(value: unknown, fallback: number | null | undefined): number | null {
  const normalized = Number(value);
  if (Number.isFinite(normalized) && normalized > 0) return Math.round(normalized);
  const normalizedFallback = Number(fallback);
  return Number.isFinite(normalizedFallback) && normalizedFallback > 0 ? Math.round(normalizedFallback) : null;
}

/** 切换运行覆盖引擎时，使用该引擎的角色默认配置重置相关模型字段。 */
function setRerunExecutionOverrideEngine(engine: EngineType): void {
  const role = rerunTargetRole.value;
  if (!role) return;
  const base = resolveCatalogRoleExecutionConfigForEngine(
    role.executionConfig,
    engine,
    engineModels(engine),
    role.executionConfig.preferredEngine,
  );
  rerunExecutionOverrideDraft.value = {
    engine,
    model: String(base.model ?? "").trim(),
    effort: String(base.effort ?? "").trim(),
    autoCompactPct: base.autoCompactPct ?? null,
  };
}

/** 将组件事件的松散值收窄为受支持的引擎，非法值不改变当前草稿。 */
function onRerunExecutionOverrideEngineChanged(value: unknown): void {
  if (value !== "codex" && value !== "claude") return;
  setRerunExecutionOverrideEngine(value);
}

/** 当前范围不支持已选引擎时，回退到所有目标角色均可用的第一个引擎。 */
function ensureRerunExecutionOverrideEngine(): void {
  const currentEngine = rerunExecutionOverrideDraft.value.engine;
  if (rerunExecutionEngineOptions.value.some((item) => item.value === currentEngine)) return;
  const fallback = rerunExecutionEngineOptions.value[0]?.value;
  if (fallback) setRerunExecutionOverrideEngine(fallback);
}

/** 模型变更后同步目录默认思考强度，保留手工输入的其他字段。 */
function onRerunExecutionOverrideModelChanged(): void {
  const draft = rerunExecutionOverrideDraft.value;
  const model = engineModels(draft.engine).find((item) => item.id === draft.model) ?? null;
  draft.effort = model?.defaultReasoningEffort ?? "";
}

/** 启用配置变更时强制受影响旧会话新建，避免用旧模型上下文继续执行新模型。 */
function onRerunExecutionOverrideEnabledChange(enabled: boolean): void {
  rerunExecutionOverrideEnabled.value = Boolean(enabled);
  if (!rerunExecutionOverrideEnabled.value) return;
  ensureRerunExecutionOverrideEngine();
  rerunTargetThreadPolicy.value = "new-thread";
  rerunDownstreamThreadPolicy.value = "cascade-new-thread";
}

/** 范围变更后检查当前引擎仍可被全部目标角色使用。 */
function onRerunExecutionOverrideScopeChanged(): void {
  if (!rerunExecutionOverrideEnabled.value) return;
  ensureRerunExecutionOverrideEngine();
}

/** 仅在实例未运行时构造角色覆盖，运行中实例必须先停止以避免并发配置漂移。 */
function buildValidatedRerunExecutionOverrides(): Record<string, OrchestrationRoleExecutionOverride> | null {
  if (!rerunExecutionOverrideEnabled.value) return null;
  if (!rerunExecutionOverrideMutable.value) {
    throw new Error("请先停止或暂停流程，再修改后续节点的模型与思考强度");
  }
  if (rerunScopeRoleIds.value.length === 0) throw new Error("重跑范围内没有可更新的角色");
  if (rerunMissingRoleIds.value.length > 0) {
    throw new Error(`当前工作区缺少角色，不能安全更新运行配置：${rerunMissingRoleIds.value.join("、")}`);
  }
  if (rerunIncompatibleRoleNames.value.length > 0) {
    throw new Error(`以下角色未启用 ${rerunExecutionOverrideDraft.value.engine === "codex" ? "Codex" : "Claude Code"}：${rerunIncompatibleRoleNames.value.join("、")}`);
  }
  const models = engineModels(rerunExecutionOverrideDraft.value.engine);
  const engineLabel = rerunExecutionOverrideDraft.value.engine === "codex" ? "Codex" : "Claude Code";
  if (!models.length) throw new Error(`${engineLabel} 模型目录尚未加载或没有可用模型`);
  const validationMessage = validateRerunExecutionOverrideDraft(rerunExecutionOverrideDraft.value);
  if (validationMessage) throw new Error(validationMessage);
  const modelId = String(rerunExecutionOverrideDraft.value.model ?? "").trim();
  const model = models.find((item) => item.id === modelId) ?? null;
  if (!model) throw new Error(`模型「${modelId}」已从模型目录移除，请重新选择`);
  const effort = String(rerunExecutionOverrideDraft.value.effort ?? "").trim();
  if (effort && !rerunEffortOptions.value.some((item) => item.value === effort)) {
    throw new Error(`模型「${rerunExecutionOverrideDraft.value.model}」不支持思考强度「${effort}」`);
  }
  return buildRerunRoleExecutionOverrides(rerunScopeRoleIds.value, rerunExecutionOverrideDraft.value);
}

function nodeStatusColor(status: NodeExecutionStatus): string {
  switch (status) {
    case "completed": return "#52c41a";
    case "running": return "#1677ff";
    case "result-submitted": return "#1677ff";
    case "finalizing": return "#2f54eb";
    case "failed": return "#ff4d4f";
    case "waiting-start": return "#fa8c16";
    case "waiting-approval": return "#0958d9";
    case "waiting-feedback": return "#faad14";
    case "gate-checking": return "#722ed1";
    case "ready": return "#13c2c2";
    case "artifact-writing": return "#2f54eb";
    case "cancelled": return "#8c8c8c";
    case "skipped": return "#999999";
    case "queued": return "#13c2c2";
    default: return "#d9d9d9";
  }
}

function nodeStatusDisplayColor(state: { status: NodeExecutionStatus } | null | undefined): string {
  const descriptor = resolveNodeWorkbenchDescriptor(state as any);
  if (descriptor.attentionKind === "execution_error") return "#ff4d4f";
  return nodeStatusColor(state?.status ?? "pending");
}

function nodeStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "等待",
    ready: "就绪",
    queued: "排队",
    running: "运行中",
    "result-submitted": "结果已提交",
    finalizing: "正在收尾",
    "artifact-writing": "写入结果",
    "gate-checking": "门禁检查",
    "waiting-start": "等待启动",
    "waiting-approval": "等待审核",
    "waiting-feedback": "等待反馈",
    completed: "已完成",
    failed: "失败",
    skipped: "跳过",
    cancelled: "已取消",
  };
  return map[status] ?? status;
}

function instanceStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "等待中",
    running: "执行中",
    paused: "已暂停",
    "waiting-start": "等待启动",
    "waiting-approval": "等待审核",
    "waiting-feedback": "等待补充",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return map[status] ?? status;
}

/** 事件文案里的节点名按 nodeId 取当前实例快照（服务端已按当前定义改名），取不到时回退事件内冻结名。 */
function eventNodeLabel(payload: Record<string, unknown>): string {
  const nodeId = String(payload.nodeId ?? "").trim();
  if (!nodeId) return String(payload.nodeLabel ?? "");
  return instance.value?.workflowSnapshot?.nodes?.find((node) => node.id === nodeId)?.label
    ?? String(payload.nodeLabel ?? nodeId);
}

function eventSummary(event: { type: string; payloadJson: string }): string {
  try {
    const payload = JSON.parse(String(event.payloadJson ?? "{}")) as Record<string, unknown>;
    if (event.type === "orchestration.artifactWritten") {
      return `${eventNodeLabel(payload)} 生成结果 ${String(payload.artifactKind ?? "")}`;
    }
    if (event.type === "orchestration.promptSnapshotCreated") {
      return `${eventNodeLabel(payload)} 生成本次提示词`;
    }
    if (event.type === "orchestration.artifactWorkspaceWritten") {
      return `${eventNodeLabel(payload)} 写入工作区 ${String(payload.stagingPath ?? payload.publishedPath ?? "")}`;
    }
    if (event.type === "orchestration.artifactRevised") {
      return `${eventNodeLabel(payload)} 基于 v${String(payload.basedOnVersion ?? "-")} 生成人工修订版`;
    }
    if (event.type === "orchestration.artifactPublished") {
      return `${eventNodeLabel(payload)} 产出物已发布 ${String(payload.publishedPath ?? "")}`;
    }
    if (event.type === "orchestration.artifactDiscarded") {
      return `${eventNodeLabel(payload)} 标记结果为已驳回`;
    }
    if (event.type === "orchestration.gateResult") {
      return `${eventNodeLabel(payload)} 完成门禁检查`;
    }
    if (event.type === "orchestration.approvalRequested") {
      const nodeLabelText = eventNodeLabel(payload);
      if (String(payload.nextAction ?? "") === "rework") {
        return `${nodeLabelText} 建议退回上游，等待人工确认`;
      }
      return `${nodeLabelText} 等待人工审核`;
    }
    if (event.type === "orchestration.feedbackRequested") {
      const source = String(payload.source ?? "").trim();
      const nodeLabelText = eventNodeLabel(payload);
      if (source === "human_input") return `${nodeLabelText} 等待补充信息`;
      if (source === "review") return `${nodeLabelText} 等待人工决策`;
      if (source === "gate") return `${nodeLabelText} 门禁未通过，等待处理`;
      if (source === "execution") return `${nodeLabelText} 会话异常中断`;
      return `${nodeLabelText} 等待人工处理`;
    }
    if (event.type === "orchestration.reworkRequested") {
      const fromNodeText = eventNodeLabel({ nodeId: payload.fromNodeId, nodeLabel: payload.fromNodeLabel });
      const targetNodeText = eventNodeLabel({ nodeId: payload.targetNodeId, nodeLabel: payload.targetNodeLabel });
      return `${fromNodeText} 退回到 ${targetNodeText}`;
    }
    if (event.type === "orchestration.nodeStateChanged") {
      const payloadNodeState = payload.nodeState && typeof payload.nodeState === "object"
        ? resolveNodeWorkbenchDescriptor(payload.nodeState as any)
        : null;
      return `${eventNodeLabel(payload)} 状态变为 ${payloadNodeState?.statusLabel ?? nodeStatusLabel(String(payload.status ?? ""))}`;
    }
    return event.type;
  } catch {
    return event.type;
  }
}

/** 切换执行记录时优先恢复缓存，后台轻量同步由实例监听统一触发。 */
async function onSwitchInstance(event: Event) {
  const nextId = String((event.target as HTMLSelectElement | null)?.value ?? "").trim();
  if (!nextId || nextId === props.instanceId) return;
  focusedNodeId.value = null;
  suppressAutoNodeSelection.value = false;
  detailModalOpen.value = false;
  closeGraphContextMenu();
  orch.selectedInstanceId = nextId as OrchestrationId;
  await orch.loadInstance(ctx.value, props.workspaceId, nextId as OrchestrationId, { force: false });
}

/** 暂停失败在操作边界记录诊断并显示原始原因，成功后才提示状态。 */
async function onPause() {
  if (props.readOnly) {
    message.info("这条共享需求只读，不能暂停流程");
    return;
  }
  try {
    await orch.pauseInstance(ctx.value, props.workspaceId, props.instanceId);
    message.success("编排已暂停");
  } catch (error) {
    console.error("[OrchestrationMonitor] pause instance failed", {
      ...errorDiagnosticContext(error, "ORCH_MONITOR_PAUSE_FAILED"),
      workspaceId: String(props.workspaceId),
      instanceId: String(props.instanceId),
      rootCause: error instanceof Error ? error.message : String(error),
    });
    message.error(error instanceof Error ? error.message : "暂停失败");
  }
}

async function onResume() {
  if (props.readOnly) {
    message.info("这条共享需求只读，不能恢复流程");
    return;
  }
  try {
    await orch.resumeInstance(ctx.value, props.workspaceId, props.instanceId);
    message.success("编排已恢复");
  } catch {
    message.error("恢复失败");
  }
}

/** 确认终止流程；失败保留原始原因并停止成功提示。 */
async function onCancel() {
  const currentInstance = instance.value;
  if (!currentInstance) return;
  if (props.readOnly) {
    message.info("这条共享需求只读，不能终止流程");
    return;
  }
  const requirementTitle = getTaskIntakeTitle(currentInstance.intakeSnapshot);
  Modal.confirm({
    title: "终止流程",
    content: `需求「${requirementTitle}」的当前流程仍在进行中。终止后，这一轮执行会立即停止，但不会自动回滚已写入工作区的代码或文档。确定继续吗？`,
    okText: "终止流程",
    okType: "danger",
    cancelText: "取消",
    /** 终止请求失败只在当前操作边界记录一次。 */
    async onOk() {
      try {
        await orch.cancelInstance(ctx.value, props.workspaceId, props.instanceId);
        message.success("流程已终止");
      } catch (error) {
        console.error("[OrchestrationMonitor] cancel instance failed", {
          ...errorDiagnosticContext(error, "ORCH_MONITOR_CANCEL_FAILED"),
          workspaceId: String(props.workspaceId),
          instanceId: String(props.instanceId),
          rootCause: error instanceof Error ? error.message : String(error),
        });
        message.error(error instanceof Error ? error.message : "终止失败");
      }
    },
  });
}

function selectNode(nodeId: string) {
  suppressAutoNodeSelection.value = false;
  focusedNodeId.value = nodeId;
  closeGraphContextMenu();
}

function clearNodeSelection() {
  focusedNodeId.value = null;
  suppressAutoNodeSelection.value = true;
  closeGraphContextMenu();
}

function openNodeDetail(nodeId?: string | null) {
  if (nodeId) {
    suppressAutoNodeSelection.value = false;
    focusedNodeId.value = nodeId;
  }
  if (!selectedNodeId.value) return;
  detailThreadIdOverride.value = null;
  detailModalView.value = "detail";
  detailModalOpen.value = true;
  void orch.ensureSelectedInstanceDetails(ctx.value, props.workspaceId, props.instanceId, {
    allowNetworkHydration: canHydrateMonitorInstance,
  }).catch((error) => {
    console.error("[OrchestrationMonitor] node detail hydration failed", {
      ...errorDiagnosticContext(error, "ORCH_MONITOR_NODE_DETAILS_HYDRATION_FAILED"),
      workspaceId: String(props.workspaceId),
      instanceId: String(props.instanceId),
      nodeId: String(selectedNodeId.value ?? ""),
    });
    message.error(error instanceof Error ? error.message : "加载节点详情失败");
  });
}

/** 手动重试选中实例的后台详情加载，不影响已渲染的流程图。 */
async function retrySelectedInstanceDetails(): Promise<void> {
  try {
    await orch.loadSelectedInstanceDetails(ctx.value, props.workspaceId, props.instanceId, {
      force: true,
      allowNetworkHydration: canHydrateMonitorInstance,
    });
  } catch (error) {
    console.error("[OrchestrationMonitor] detail retry failed", {
      ...errorDiagnosticContext(error, "ORCH_MONITOR_DETAILS_RETRY_FAILED"),
      workspaceId: String(props.workspaceId),
      instanceId: String(props.instanceId),
    });
    message.error(error instanceof Error ? error.message : "重试加载详情失败");
  }
}

function openPreferredNodeAction(nodeId?: string | null) {
  const targetNodeId = String(nodeId ?? selectedNodeId.value ?? "").trim();
  if (!instance.value || !targetNodeId) return;
  const targetState = instance.value.nodeStates[targetNodeId] ?? null;
  const workbench = resolveNodeWorkbenchDescriptor(targetState);
  if (workbench.preferredView === "chat") {
    const threadId = nodeThreadId(targetNodeId);
    if (threadId) {
      void openNodeThread(threadId, targetNodeId);
      return;
    }
  }
  openNodeDetail(targetNodeId);
}

function closeNodeDetail() {
  detailModalOpen.value = false;
  detailModalFullscreen.value = false;
  detailModalView.value = "detail";
  detailThreadLoading.value = false;
  detailThreadIdOverride.value = null;
}

function toggleDetailModalFullscreen() {
  detailModalFullscreen.value = !detailModalFullscreen.value;
}

function onGraphNodeDoubleClick(nodeId: string) {
  suppressAutoNodeSelection.value = false;
  focusedNodeId.value = nodeId;
  closeGraphContextMenu();
  openPreferredNodeAction(nodeId);
}

function nodeLabel(nodeId: string): string {
  return instance.value?.workflowSnapshot?.nodes?.find((node) => node.id === nodeId)?.label ?? nodeId;
}

function edgeLabel(edgeId: string): string {
  const edge = instance.value?.workflowSnapshot?.edges?.find((item) => item.id === edgeId);
  if (!edge) return edgeId;
  return `${nodeLabel(edge.sourceNodeId)} -> ${nodeLabel(edge.targetNodeId)}`;
}

function nodeThreadId(nodeId: string): ThreadId | null {
  const inst = instance.value;
  if (!inst) return null;
  const threadId = String(inst.nodeStates[nodeId]?.threadId ?? "").trim() as ThreadId;
  return threadId || null;
}

/** 流程详情侧按卡片状态收集待处理项，覆盖 turn 已中断但卡片仍 pending 的边界。 */
function collectPendingInteractionItems(conv: ThreadConversationState | null | undefined): PendingInteractionItem[] {
  if (!conv?.items?.length) return [];
  return conv.items.filter((item): item is PendingInteractionItem => {
    if (item.kind === "approvalRequest") return item.state === "pending";
    if (item.kind === "userInputRequest") return item.state === "pending";
    return false;
  });
}

/** 按节点会话反查节点 ID，用于把失效的 Claude 待补充输入转成节点反馈。 */
function nodeIdForThreadId(threadId: ThreadId): string | null {
  const current = instance.value;
  if (!current) return null;
  const target = String(threadId ?? "").trim();
  if (!target) return null;
  for (const [nodeId, state] of Object.entries(current.nodeStates)) {
    if (String(state.threadId ?? "").trim() === target) return nodeId;
  }
  return null;
}

/** 轻量加载选中节点会话，供流程详情直接显示 Claude/审批待处理项。 */
async function ensureSelectedNodePendingInteractions(threadId: ThreadId): Promise<void> {
  const key = String(threadId ?? "").trim();
  if (!key || pendingInteractionHydratedThreadIds.has(key)) return;
  try {
    await chat.activateEmbeddedThread(ctx.value, {
      workspaceId: props.workspaceId,
      threadId,
      key: `orch-pending:${String(props.instanceId)}:${key}`,
      owner: "embedded",
    });
    pendingInteractionHydratedThreadIds.add(key);
  } catch (error) {
    console.error("[OrchestrationMonitor] pending interaction hydration failed", {
      ...errorDiagnosticContext(error, "ORCH_MONITOR_PENDING_INTERACTION_HYDRATION_FAILED"),
      workspaceId: String(props.workspaceId),
      instanceId: String(props.instanceId),
      threadId: key,
    });
    message.error(error instanceof Error ? error.message : "加载待处理输入失败");
  }
}

/** Claude AskUserQuestion 失效后的显式兜底：把回答提交为当前节点 resume_with_input。 */
async function resumeUserInputAsNodeFeedback(payload: {
  item: ConversationUserInputRequest;
  answers: Record<string, { answers: string[] }>;
  text: string;
}): Promise<void> {
  const nodeId = nodeIdForThreadId(payload.item.threadId);
  if (!nodeId) throw new Error("找不到待补充输入对应的流程节点");
  if (!canOperateNode(nodeId)) throw new Error(nodeReadonlyMessage("提交节点补充输入"));
  const nodeState = instance.value?.nodeStates[nodeId] ?? null;
  if (nodeState?.status !== "waiting-feedback") {
    throw new Error("当前节点不在等待补充状态，不能转为节点补充输入");
  }
  await orch.submitFeedback(
    ctx.value,
    props.workspaceId,
    props.instanceId,
    nodeId,
    "resume_with_input",
    payload.text,
    [],
    null,
  );
  await orch.loadInstance(ctx.value, props.workspaceId, props.instanceId);
}

async function openSelectedNodeThread() {
  if (!selectedNodeThreadId.value) return;
  await openNodeThread(selectedNodeThreadId.value, selectedNodeId.value);
}

async function openNodeThread(threadId: ThreadId, nodeId?: string | null): Promise<void> {
  if (nodeId) {
    suppressAutoNodeSelection.value = false;
    focusedNodeId.value = nodeId;
  }
  try {
    detailThreadIdOverride.value = threadId;
    detailModalOpen.value = true;
    detailModalView.value = "chat";
    detailThreadLoading.value = true;
    closeGraphContextMenu();
    await chat.activateEmbeddedThread(ctx.value, {
      workspaceId: props.workspaceId,
      threadId,
      key: `orch-detail:${String(props.instanceId)}:${String(threadId)}`,
      owner: "embedded",
    });
  } catch (error) {
    detailModalView.value = "detail";
    message.error(error instanceof Error ? error.message : "加载节点会话失败");
  } finally {
    detailThreadLoading.value = false;
  }
}

function showFeedbackPanel() {
  if (!canOperateSelectedNode.value) {
    message.info(nodeReadonlyMessage("提交节点反馈"));
    return;
  }
  detailThreadIdOverride.value = null;
  detailModalView.value = "detail";
}

/** 启动 waiting-start 节点，并把当前面板里的补充说明一并提交。 */
async function onStartSelectedNode(targetNodeId?: string | null, feedback?: string | null): Promise<void> {
  const nodeId = String(targetNodeId ?? selectedNodeId.value ?? "").trim();
  if (!canOperateNode(nodeId)) {
    message.info(nodeReadonlyMessage("启动节点"));
    return;
  }
  const nodeState = nodeId ? instance.value?.nodeStates[nodeId] ?? null : null;
  if (!nodeId || !nodeState || !canStartNode(nodeState)) return;
  const manualStartFeedback = feedback !== undefined
    ? feedback
    : nodeId === selectedNodeId.value ? manualStartFeedbackText.value : null;
  try {
    await orch.startNode(ctx.value, props.workspaceId, props.instanceId, nodeId, manualStartFeedback);
    await orch.loadInstance(ctx.value, props.workspaceId, props.instanceId);
    if (nodeId === selectedNodeId.value) manualStartFeedbackText.value = "";
    message.success(`已启动节点「${nodeLabel(nodeId)}」`);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "启动节点失败");
  }
}

/** 跳过 waiting-start 节点，确认后由后端继续调度下游。 */
function onSkipSelectedNode(targetNodeId?: string | null): void {
  const nodeId = String(targetNodeId ?? selectedNodeId.value ?? "").trim();
  if (!canOperateNode(nodeId)) {
    message.info(nodeReadonlyMessage("跳过节点"));
    return;
  }
  const nodeState = nodeId ? instance.value?.nodeStates[nodeId] ?? null : null;
  if (!nodeId || !nodeState || !canSkipWaitingNode(nodeState)) return;
  const targetNodeLabel = nodeLabel(nodeId);
  Modal.confirm({
    title: `确认跳过待启动节点「${targetNodeLabel}」？`,
    okText: "确认跳过",
    cancelText: "取消",
    okButtonProps: { danger: true },
    content: "确认后，系统会把当前节点标记为跳过并继续后续流程；如果下游依赖当前节点输出，后续节点可能失败。",
    onOk: async () => {
      try {
        await orch.skipNode(ctx.value, props.workspaceId, props.instanceId, nodeId);
        await orch.loadInstance(ctx.value, props.workspaceId, props.instanceId);
        message.success(`已跳过节点「${targetNodeLabel}」`);
      } catch (error) {
        message.error(error instanceof Error ? error.message : "跳过节点失败");
      }
    },
  });
}

function normalizeContextMenuPosition(
  clientX: number,
  clientY: number,
  dimensions: { width: number; height: number },
): { x: number; y: number } {
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 720;
  const margin = 12;
  return {
    x: Math.max(margin, Math.min(clientX, viewportWidth - dimensions.width - margin)),
    y: Math.max(margin, Math.min(clientY, viewportHeight - dimensions.height - margin)),
  };
}

function openGraphNodeContextMenu(payload: { id: string; clientX: number; clientY: number }) {
  const position = normalizeContextMenuPosition(payload.clientX, payload.clientY, { width: 300, height: 260 });
  suppressAutoNodeSelection.value = false;
  focusedNodeId.value = payload.id;
  graphContextMenu.value = {
    kind: "node",
    id: payload.id,
    x: position.x,
    y: position.y,
    title: nodeLabel(payload.id),
  };
}

function openGraphEdgeContextMenu(payload: { id: string; clientX: number; clientY: number }) {
  const position = normalizeContextMenuPosition(payload.clientX, payload.clientY, { width: 260, height: 120 });
  graphContextMenu.value = {
    kind: "edge",
    id: payload.id,
    x: position.x,
    y: position.y,
    title: edgeLabel(payload.id),
  };
}

function closeGraphContextMenu() {
  graphContextMenu.value = null;
}

function handleGraphContextAction(action: "detail" | "thread" | "review" | "events" | "start-node" | "skip-node" | "force-complete" | "cancel-node" | "reassign-node") {
  if (!graphContextMenu.value) return;
  const nodeId = graphContextMenu.value.kind === "node" ? graphContextMenu.value.id : null;
  if (action === "events") {
    closeGraphContextMenu();
    eventsModalOpen.value = true;
    return;
  }
  if (!nodeId) return;
  suppressAutoNodeSelection.value = false;
  focusedNodeId.value = nodeId;
  if (action === "detail" || action === "review") {
    closeGraphContextMenu();
    if (action === "review") {
      openPreferredNodeAction(nodeId);
    } else {
      openNodeDetail(nodeId);
    }
    return;
  }
  if (action === "thread") {
    const threadId = nodeThreadId(nodeId);
    closeGraphContextMenu();
    if (threadId) {
      void openNodeThread(threadId, nodeId);
    }
    return;
  }
  if (action === "force-complete") {
    closeGraphContextMenu();
    onForceCompleteSelectedNode(nodeId);
    return;
  }
  if (action === "start-node") {
    closeGraphContextMenu();
    openNodeDetail(nodeId);
    return;
  }
  if (action === "skip-node") {
    closeGraphContextMenu();
    onSkipSelectedNode(nodeId);
    return;
  }
  if (action === "cancel-node") {
    closeGraphContextMenu();
    onCancelSelectedNode(nodeId);
    return;
  }
  if (action === "reassign-node") {
    closeGraphContextMenu();
    void openReassignNodeAssigneeModal(nodeId);
  }
}

/** 打开节点转派弹窗，并以实例当前冻结处理人为默认值。 */
async function openReassignNodeAssigneeModal(targetNodeId?: string | null): Promise<void> {
  const nodeId = String(targetNodeId ?? selectedNodeId.value ?? "").trim();
  if (!canReassignNodeAssignees(nodeId)) return;
  const id = sharedWorkspaceId.value;
  if (id && !sharedWorkspaces.membersByWorkspaceId[id]?.length) {
    const result = await sharedWorkspaces.loadMembers(id);
    if (!result.ok) {
      message.error(result.message || "加载共享成员失败");
      return;
    }
  }
  reassignNodeId.value = nodeId;
  reassignAssigneeDraft.value = nodeAssigneeUserIds(nodeId).filter((userId) =>
    activeSharedMemberOptions.value.some((option) => option.userId === userId),
  );
  reassignModalOpen.value = true;
}

/** 提交节点转派，只更新本次实例节点处理人快照。 */
async function submitReassignNodeAssignees(): Promise<void> {
  const nodeId = String(reassignNodeId.value ?? "").trim();
  const assigneeUserIds = Array.from(new Set(reassignAssigneeDraft.value.map((item) => String(item ?? "").trim()).filter(Boolean)));
  if (!nodeId || !canReassignNodeAssignees(nodeId)) return;
  if (assigneeUserIds.length === 0) {
    message.error("请至少选择一个处理人");
    return;
  }
  reassigningNodeAssignees.value = true;
  try {
    await orch.reassignNodeAssignees(ctx.value, props.workspaceId, props.instanceId, nodeId, assigneeUserIds);
    message.success(`已转派节点「${nodeLabel(nodeId)}」`);
    reassignModalOpen.value = false;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "转派节点处理人失败");
  } finally {
    reassigningNodeAssignees.value = false;
  }
}

function handleGlobalPointerDown(event: Event) {
  if (!graphContextMenu.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest(".orch-monitor__context-menu")) return;
  closeGraphContextMenu();
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    closeGraphContextMenu();
  }
}

function onForceCompleteSelectedNode(targetNodeId?: string | null) {
  const nodeId = String(targetNodeId ?? selectedNodeId.value ?? "").trim();
  if (!canOperateNode(nodeId)) {
    message.info(nodeReadonlyMessage("手动完成节点"));
    return;
  }
  const nodeState = nodeId ? instance.value?.nodeStates[nodeId] ?? null : null;
  if (!nodeId || !nodeState || !canForceCompleteNode(nodeState)) return;
  const targetNodeLabel = nodeLabel(nodeId);
  Modal.confirm({
    title: `手动完成节点「${targetNodeLabel}」？`,
    okText: "确认完成",
    cancelText: "取消",
    okButtonProps: { danger: true },
    content: "这是应急放行动作。系统会直接把当前节点标记为已完成并继续后续流程；如果当前节点还没有可靠结果，下游节点可能因为缺少输入而失败。",
    onOk: async () => {
      try {
        await orch.submitFeedback(
          ctx.value,
          props.workspaceId,
          props.instanceId,
          nodeId,
          "override",
          `用户手动完成节点：${targetNodeLabel}`,
          [],
        );
        await orch.loadInstance(ctx.value, props.workspaceId, props.instanceId);
        message.success(`已手动完成节点「${targetNodeLabel}」`);
      } catch (error) {
        message.error(error instanceof Error ? error.message : "手动完成失败");
      }
    },
  });
}

/**
 * 「停止节点」入口：硬中断当前节点 in-flight turn，节点会进入 waiting-feedback。
 * 已落盘的 artifact 保留；用户可在节点会话里继续发消息补充说明恢复执行。
 */
function onCancelSelectedNode(targetNodeId?: string | null) {
  const nodeId = String(targetNodeId ?? selectedNodeId.value ?? "").trim();
  if (!canOperateNode(nodeId)) {
    message.info(nodeReadonlyMessage("停止节点"));
    return;
  }
  const nodeState = nodeId ? instance.value?.nodeStates[nodeId] ?? null : null;
  if (!nodeId || !nodeState || !canCancelNode(nodeState)) return;
  const targetNodeLabel = nodeLabel(nodeId);
  Modal.confirm({
    title: `停止节点「${targetNodeLabel}」？`,
    okText: "停止节点",
    cancelText: "取消",
    okButtonProps: { danger: true },
    content: "会立即中断该节点当前的 AI 会话，已落盘的结果会保留。停止后节点会进入“待反馈”，你可以在节点会话里补充说明继续执行。",
    /** 停止失败不继续刷新实例，并保留节点诊断上下文。 */
    onOk: async () => {
      try {
        await orch.cancelNode(ctx.value, props.workspaceId, props.instanceId, nodeId);
        await orch.loadInstance(ctx.value, props.workspaceId, props.instanceId);
        message.success(`已停止节点「${targetNodeLabel}」`);
      } catch (error) {
        console.error("[OrchestrationMonitor] cancel node failed", {
          ...errorDiagnosticContext(error, "ORCH_MONITOR_CANCEL_NODE_FAILED"),
          workspaceId: String(props.workspaceId),
          instanceId: String(props.instanceId),
          nodeId,
          rootCause: error instanceof Error ? error.message : String(error),
        });
        message.error(error instanceof Error ? error.message : "停止节点失败");
      }
    },
  });
}

/**
 * 「从此节点重跑」入口：初始化重跑范围、会话策略和可选的后续角色运行配置。
 * 引擎内部仍负责 cancelAndWait → 子图重置 → resume，前端不直接修改节点状态。
 */
function onRerunFromNode(nodeId: string | null | undefined) {
  if (!canOperateNode(nodeId)) {
    message.info(nodeReadonlyMessage("重新执行节点"));
    return;
  }
  if (!nodeId || !instance.value) return;
  if (!canRerunFromNodeId(nodeId)) {
    message.warning("仅 role 节点支持重跑");
    return;
  }
  clearRerunAttachments();
  rerunNodeId.value = nodeId;
  rerunNote.value = "";
  rerunTargetThreadPolicy.value = "reuse-existing";
  rerunDownstreamThreadPolicy.value = "preserve-existing";
  rerunNodeScope.value = "downstream";
  rerunCustomNodeIds.value = [];
  rerunExecutionOverrideEnabled.value = false;
  rerunExecutionOverrideScope.value = "affected";
  rerunApplyLatestWorkItemPolicy.value = true;
  seedRerunExecutionOverrideDraft();
  rerunModalOpen.value = true;
}

/** 关闭重跑确认框；提交中不允许关闭，避免用户误以为请求已取消。 */
function closeRerunModal(): void {
  if (rerunSubmitting.value) return;
  clearRerunAttachments();
  rerunModalOpen.value = false;
}

/** 提交重跑请求，并在启用配置变更时为重跑范围强制新建会话。 */
async function submitRerunFromNode(): Promise<void> {
  const nodeId = rerunNodeId.value;
  if (!nodeId || !instance.value || !canRerunFromNodeId(nodeId)) {
    message.error("当前节点已不可重跑，请刷新流程状态后重试");
    return;
  }
  if (rerunNodeSelectionError.value) {
    message.error(rerunNodeSelectionError.value);
    return;
  }
  const note = rerunNote.value.trim();
  const images = rerunImageAttachments.value.map((item) => item.dataUrl);
  const budgetCheck = validateInlineThreadPayload({ text: note, images }, { contextLabel: "当前重跑说明" });
  if (!budgetCheck.ok) {
    message.warning(budgetCheck.message);
    return;
  }

  let roleExecutionOverrides: Record<string, OrchestrationRoleExecutionOverride> | null;
  try {
    roleExecutionOverrides = buildValidatedRerunExecutionOverrides();
  } catch (error) {
    message.error(error instanceof Error ? error.message : "运行配置校验失败");
    return;
  }

  rerunSubmitting.value = true;
  const nodeLabel = rerunTargetNodeLabel.value;
  try {
    await orch.rerunInstanceFromNode(
      ctx.value,
      props.workspaceId,
      props.instanceId,
      nodeId,
      note || null,
      {
        threadReusePolicy: rerunExecutionOverrideEnabled.value ? "new-thread" : rerunTargetThreadPolicy.value,
        downstreamThreadReusePolicy: rerunExecutionOverrideEnabled.value ? "cascade-new-thread" : rerunDownstreamThreadPolicy.value,
        images: images.length ? images : null,
        rerunNodeIds: rerunNodeIds.value,
        roleExecutionOverrides,
        applyLatestWorkItemPolicy: rerunWorkItemNodes.value.length > 0
          && rerunWorkItemPolicySyncAvailable.value
          && rerunApplyLatestWorkItemPolicy.value,
      },
    );
    clearRerunAttachments();
    rerunModalOpen.value = false;
    message.success(`已从节点「${nodeLabel}」开始重跑`);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "重跑失败");
  } finally {
    rerunSubmitting.value = false;
  }
}

function onRerunFromContextMenuNode() {
  const nodeId = graphContextMenu.value?.kind === "node" ? graphContextMenu.value.id : null;
  closeGraphContextMenu();
  if (!nodeId) return;
  onRerunFromNode(nodeId);
}

function onRerunFromSelectedNode() {
  onRerunFromNode(selectedNodeId.value);
}

function openEventsModal() {
  eventsModalOpen.value = true;
  void orch.ensureSelectedInstanceDetails(ctx.value, props.workspaceId, props.instanceId, {
    allowNetworkHydration: canHydrateMonitorInstance,
  }).catch((error) => {
    console.error("[OrchestrationMonitor] event detail hydration failed", {
      ...errorDiagnosticContext(error, "ORCH_MONITOR_EVENT_DETAILS_HYDRATION_FAILED"),
      workspaceId: String(props.workspaceId),
      instanceId: String(props.instanceId),
    });
    message.error(error instanceof Error ? error.message : "加载执行事件失败");
  });
}

function openReviewNodeDetail() {
  if (!reviewNode.value) return;
  if (!canOperateReviewNode.value) {
    openNodeDetail(reviewNode.value.node.id);
    return;
  }
  if (reviewNode.value.state.status === "waiting-start") {
    openNodeDetail(reviewNode.value.node.id);
    return;
  }
  openPreferredNodeAction(reviewNode.value.node.id);
}

defineExpose({
  openEventsModal,
  openPrimaryNodeAction: openReviewNodeDetail,
  hasReworkEdges,
  showReworkEdges,
  reworkEdgePreferenceError,
  toggleReworkEdges,
});
</script>

<template>
  <div v-if="instance" class="orch-monitor">
    <div v-if="showHeader" class="orch-monitor__header">
      <div class="orch-monitor__title">
        <div class="orch-monitor__title-row">
          <span class="orch-monitor__title-text">{{ workflowTitle }}</span>
          <span class="orch-monitor__status" :style="{ color: nodeStatusColor(instance.status as NodeExecutionStatus) }">
            {{ instanceStatusLabel(instance.status) }}
          </span>
        </div>
        <div v-if="runSummary" class="orch-monitor__meta">{{ runSummary }}</div>
      </div>

      <div class="orch-monitor__actions">
        <button
          v-if="hasReworkEdges"
          class="orch-monitor__action-btn"
          type="button"
          :aria-pressed="showReworkEdges"
          :disabled="!!reworkEdgePreferenceError"
          @click="toggleReworkEdges"
        >
          {{ showReworkEdges ? "隐藏退回线" : "显示退回线" }}
        </button>
        <label v-if="relatedInstances.length > 1" class="orch-monitor__switcher">
          <span>切换执行</span>
          <select :value="instance.id" @change="onSwitchInstance">
            <option v-for="item in relatedInstances" :key="item.id" :value="item.id">
              {{ formatInstanceOptionLabel(item.createdAt) }} · {{ instanceStatusLabel(item.status) }}
            </option>
          </select>
        </label>

        <button class="orch-monitor__action-btn" type="button" @click="openEventsModal">
          查看执行事件
        </button>
        <button
          v-if="reviewNode && canOperateReviewNode"
          class="orch-monitor__action-btn orch-monitor__action-btn--primary"
          type="button"
          @click="openReviewNodeDetail"
        >
          {{ reviewActionLabel }}
        </button>
        <button v-if="instance.status === 'running' && !readOnly" class="orch-monitor__action-btn" type="button" @click="onPause">
          <PauseCircleOutlined /> 暂停
        </button>
        <button
          v-if="instance.status === 'paused' && !readOnly"
          class="orch-monitor__action-btn orch-monitor__action-btn--primary"
          type="button"
          @click="onResume"
        >
          <CaretRightOutlined /> 恢复
        </button>
        <button
          v-if="!readOnly && (instance.status === 'running' || instance.status === 'paused' || instance.status === 'waiting-start' || instance.status === 'waiting-approval' || instance.status === 'waiting-feedback')"
          class="orch-monitor__action-btn orch-monitor__action-btn--danger"
          type="button"
          @click="onCancel"
        >
          <StopOutlined /> 终止流程
        </button>
      </div>
    </div>

    <div v-if="reviewNode && showHeader" class="orch-monitor__review-banner">
      <div class="orch-monitor__review-copy">
        <span class="orch-monitor__review-badge">{{ reviewBadgeLabel }}</span>
        <strong>{{ reviewNode.node.label }}</strong>
        <span>{{ reviewBannerText }}</span>
      </div>
      <button v-if="canOperateReviewNode" class="orch-monitor__action-btn orch-monitor__action-btn--primary" type="button" @click="openReviewNodeDetail">
        {{ reviewActionLabel }}
      </button>
    </div>

    <div
      v-if="selectedNodePendingInteractionItems.length"
      class="orch-monitor__pending-bar"
      data-testid="orch-pending-interactions"
    >
      <div class="orch-monitor__pending-copy">
        <span class="orch-monitor__pending-badge">待处理</span>
        <strong>{{ selectedNodeLabel }}</strong>
        <span>{{ selectedNodePendingInteractionText }}</span>
      </div>
      <PendingInteractionStack
        class="orch-monitor__pending-stack"
        :workspace-id="props.workspaceId"
        :items="selectedNodePendingInteractionItems"
        :user-input-resume-with-input="resumeUserInputAsNodeFeedback"
        :active="monitorViewActive && ui.mainView === 'orchestration' && !detailModalOpen"
      />
    </div>

    <div class="orch-monitor__graph-stage">
      <WorkflowGraphView
        ref="graphRef"
        class="orch-monitor__graph"
        :workflow="instance.workflowSnapshot"
        :node-states="instance.nodeStates"
        :node-assignee-labels-by-node-id="nodeAssigneeLabelsByNodeId"
        :role-name-by-id="roleNameById"
        :selected-node-id="selectedNodeId"
        min-height="0"
        fill-height
        :show-controls="true"
        :show-mini-map="true"
        :show-rework-edge-toggle="false"
        @node-click="selectNode"
        @node-double-click="onGraphNodeDoubleClick"
        @work-items-click="openNodeDetail"
        @node-contextmenu="openGraphNodeContextMenu"
        @edge-contextmenu="openGraphEdgeContextMenu"
        @pane-click="clearNodeSelection"
      />

      <div v-if="selectedNodeState" class="orch-monitor__selection-float">
        <div class="orch-monitor__selection-bar orch-monitor__selection-bar--floating">
          <div class="orch-monitor__selection-copy">
            <div class="orch-monitor__selection-title">
              <strong>{{ selectedNodeLabel }}</strong>
              <span class="orch-monitor__selection-status" :style="{ color: nodeStatusDisplayColor(selectedNodeState) }">
                {{ selectedNodeWorkbench.statusLabel }}
              </span>
            </div>
            <div class="orch-monitor__selection-meta">
              <span v-for="fact in selectedNodeFacts" :key="fact">{{ fact }}</span>
              <span v-if="selectedNodeTimeline">{{ selectedNodeTimeline }}</span>
            </div>
          </div>

          <div class="orch-monitor__selection-actions">
            <button class="orch-monitor__action-btn" type="button" @click="openNodeDetail(selectedNodeId)">
              查看节点详情
            </button>
            <button
              v-if="selectedNodeThreadId"
              class="orch-monitor__action-btn"
              type="button"
              @click="openSelectedNodeThread"
            >
              前往会话
            </button>
            <button
              v-if="canStartSelectedNode"
              class="orch-monitor__action-btn orch-monitor__action-btn--primary"
              type="button"
              @click="() => openNodeDetail(selectedNodeId)"
            >
              启动节点
            </button>
            <button
              v-if="canSkipSelectedNode"
              class="orch-monitor__action-btn orch-monitor__action-btn--warning"
              type="button"
              @click="() => onSkipSelectedNode()"
            >
              跳过节点
            </button>
            <button
              v-if="canReassignSelectedNode"
              class="orch-monitor__action-btn"
              type="button"
              @click="() => openReassignNodeAssigneeModal(selectedNodeId)"
            >
              转派处理人
            </button>
            <button
              v-if="canForceCompleteSelectedNode"
              class="orch-monitor__action-btn orch-monitor__action-btn--warning"
              type="button"
              @click="() => onForceCompleteSelectedNode()"
            >
              手动完成
            </button>
            <button
              v-if="canCancelSelectedNode"
              class="orch-monitor__action-btn orch-monitor__action-btn--danger"
              type="button"
              @click="() => onCancelSelectedNode()"
            >
              停止节点
            </button>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="graphContextMenu"
      class="orch-monitor__context-menu"
      :style="{ left: `${graphContextMenu.x}px`, top: `${graphContextMenu.y}px` }"
    >
      <div class="orch-monitor__context-title">
        {{ graphContextMenu.kind === "node" ? "节点" : "连线" }} · {{ graphContextMenu.title }}
      </div>
      <template v-if="graphContextMenu.kind === 'node'">
        <button class="orch-monitor__context-item" type="button" @click="handleGraphContextAction('detail')">查看节点详情</button>
        <button
          v-if="contextMenuNodeThreadId"
          class="orch-monitor__context-item"
          type="button"
          @click="handleGraphContextAction('thread')"
        >
          前往会话
        </button>
        <button
          v-if="contextMenuNeedsReview"
          class="orch-monitor__context-item"
          type="button"
          @click="handleGraphContextAction('review')"
        >
          {{ contextMenuActionLabel }}
        </button>
        <button
          v-if="contextMenuCanStart"
          class="orch-monitor__context-item"
          type="button"
          @click="handleGraphContextAction('start-node')"
        >
          启动节点
        </button>
        <button
          v-if="contextMenuCanSkip"
          class="orch-monitor__context-item orch-monitor__context-item--warning"
          type="button"
          @click="handleGraphContextAction('skip-node')"
        >
          跳过节点
        </button>
        <button
          v-if="contextMenuCanReassign"
          class="orch-monitor__context-item"
          type="button"
          @click="handleGraphContextAction('reassign-node')"
        >
          转派处理人
        </button>
        <button
          v-if="contextMenuCanCancel"
          class="orch-monitor__context-item orch-monitor__context-item--danger"
          type="button"
          @click="handleGraphContextAction('cancel-node')"
        >
          停止节点
        </button>
        <button
          v-if="contextMenuCanForceComplete"
          class="orch-monitor__context-item orch-monitor__context-item--warning"
          type="button"
          @click="handleGraphContextAction('force-complete')"
        >
          手动完成当前节点
        </button>
        <button
          v-if="graphContextMenu && canRerunFromNodeId(graphContextMenu.id)"
          class="orch-monitor__context-item orch-monitor__context-item--warning"
          type="button"
          @click="onRerunFromContextMenuNode"
        >
          从此节点重跑
        </button>
      </template>
      <button class="orch-monitor__context-item" type="button" @click="handleGraphContextAction('events')">查看执行事件</button>
    </div>


    <a-modal
      :open="detailModalOpen"
      :footer="null"
      :width="detailModalWidth"
      :style="detailModalStyle"
      :body-style="detailModalBodyStyle"
      :wrap-class-name="detailModalWrapClassName"
      :closable="false"
      destroy-on-close
      @cancel="closeNodeDetail"
    >
      <template #title>
        <div class="orch-monitor__detail-titlebar">
          <span class="orch-monitor__detail-title-text">{{ detailModalTitle }}</span>
          <div class="orch-monitor__detail-title-actions">
            <a-tooltip
              v-if="!showBranchDecisionDialog"
              :title="detailModalFullscreen ? '还原' : '全屏查看'"
              placement="bottom"
            >
              <a-button
                class="orch-monitor__detail-icon-action orch-monitor__detail-icon-action--fullscreen"
                type="text"
                shape="circle"
                :aria-label="detailModalFullscreen ? '还原节点详情弹框' : '全屏查看节点详情弹框'"
                @mousedown.stop
                @click.stop="toggleDetailModalFullscreen"
              >
                <template #icon>
                  <component :is="detailModalFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
                </template>
              </a-button>
            </a-tooltip>
            <a-tooltip title="关闭" placement="bottom">
              <a-button
                class="orch-monitor__detail-icon-action orch-monitor__detail-icon-action--close"
                type="text"
                shape="circle"
                aria-label="关闭节点详情弹框"
                @mousedown.stop
                @click.stop="closeNodeDetail"
              >
                <template #icon>
                  <CloseOutlined />
                </template>
              </a-button>
            </a-tooltip>
          </div>
        </div>
      </template>
      <div
        v-if="selectedNodeState"
        class="orch-monitor__detail-modal"
        :class="{
          'orch-monitor__detail-modal--chat': detailModalView === 'chat',
          'orch-monitor__detail-modal--branch': showBranchDecisionDialog,
          'orch-monitor__detail-modal--review': showReviewWorkspace || showManualStartWorkspace,
          'orch-monitor__detail-modal--fullscreen': detailModalFullscreen,
        }"
      >
        <div
          v-if="detailModalView === 'detail' && (orch.selectedInstanceDetailsLoading || selectedInstanceDetailsErrorText)"
          class="orch-monitor__detail-hydration"
          :class="{ 'orch-monitor__detail-hydration--error': Boolean(selectedInstanceDetailsErrorText) }"
        >
          <span>{{ selectedInstanceDetailsErrorText || "正在加载节点详情数据..." }}</span>
          <button
            v-if="selectedInstanceDetailsErrorText"
            class="orch-monitor__detail-retry"
            type="button"
            @click="retrySelectedInstanceDetails"
          >
            重试
          </button>
        </div>
        <template v-if="detailModalView === 'detail'">
          <div
            v-if="showBranchDecisionDialog && selectedNode"
            class="orch-monitor__branch-decision-panel"
            data-testid="orch-branch-decision-panel"
          >
            <FeedbackDialog
              :workspace-id="workspaceId"
              :instance-id="instanceId"
              :node-id="selectedNode.id"
              :node-state="selectedNodeState"
              :node-label="selectedNode.label"
              :artifacts="orch.selectedInstanceArtifacts"
              :workflow-nodes="instance.workflowSnapshot?.nodes ?? []"
              :workflow-edges="instance.workflowSnapshot?.edges ?? []"
            />
          </div>

          <div
            v-else-if="showManualStartWorkspace && selectedNode"
            class="orch-monitor__review-workspace"
            data-testid="orch-manual-start-workspace"
          >
            <div class="orch-monitor__review-pane orch-monitor__review-pane--detail" data-testid="orch-manual-start-detail-pane">
              <NodeExecutionDetail
                :workspace-id="workspaceId"
                :instance-id="instanceId"
                :node-state="selectedNodeState"
                :node="selectedNode"
                :workflow-nodes="instance.workflowSnapshot?.nodes ?? []"
                :show-attention-note="false"
                fill-height
                :artifacts="orch.selectedInstanceArtifacts"
                :prompt-snapshots="orch.selectedInstancePromptSnapshots"
              >
                <template #header-actions>
                  <button
                    v-if="canSkipSelectedNode"
                    class="orch-monitor__action-btn orch-monitor__action-btn--warning"
                    type="button"
                    @click="() => onSkipSelectedNode()"
                  >
                    跳过节点
                  </button>
                  <button
                    v-if="selectedNodeThreadId"
                    class="orch-monitor__action-btn"
                    type="button"
                    @click="openSelectedNodeThread"
                  >
                    查看会话
                  </button>
                  <button
                    v-if="canReassignSelectedNode"
                    class="orch-monitor__action-btn"
                    type="button"
                    @click="() => openReassignNodeAssigneeModal(selectedNodeId)"
                  >
                    转派处理人
                  </button>
                </template>
              </NodeExecutionDetail>
            </div>

            <div class="orch-monitor__review-pane orch-monitor__review-pane--action" data-testid="orch-manual-start-action-pane">
              <div class="orch-monitor__manual-start-panel" data-testid="orch-manual-start-panel">
                <div class="orch-monitor__manual-start-heading">
                  <span>待启动</span>
                  <strong>{{ selectedNode.label }}</strong>
                  <p>{{ selectedNodeWorkbench.bannerText }}</p>
                </div>

                <div v-if="selectedManualStartPrompt" class="orch-monitor__manual-start-prompt">
                  <span>启动前置提示说明</span>
                  <p>{{ selectedManualStartPrompt }}</p>
                </div>

                <label class="orch-monitor__manual-start-field">
                  <span>补充说明（可选）</span>
                  <textarea
                    v-model="manualStartFeedbackText"
                    name="manual-start-feedback"
                    autocomplete="off"
                    rows="5"
                    placeholder="填写启动前需要补充的上下文信息。"
                  />
                </label>

                <div class="orch-monitor__manual-start-actions">
                  <button
                    v-if="canSkipSelectedNode"
                    class="orch-monitor__action-btn orch-monitor__action-btn--warning"
                    type="button"
                    @click="() => onSkipSelectedNode(selectedNodeId)"
                  >
                    跳过节点
                  </button>
                  <button
                    class="orch-monitor__action-btn orch-monitor__action-btn--primary"
                    type="button"
                    :disabled="!canStartSelectedNode"
                    @click="() => onStartSelectedNode(selectedNodeId, manualStartFeedbackText)"
                  >
                    启动
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div
            v-else-if="showReviewWorkspace && selectedNode"
            class="orch-monitor__review-workspace"
            data-testid="orch-review-workspace"
          >
            <div class="orch-monitor__review-pane orch-monitor__review-pane--detail" data-testid="orch-review-detail-pane">
              <NodeExecutionDetail
                :workspace-id="workspaceId"
                :instance-id="instanceId"
                :node-state="selectedNodeState"
                :node="selectedNode"
                :workflow-nodes="instance.workflowSnapshot?.nodes ?? []"
                :show-attention-note="false"
                fill-height
                :artifacts="orch.selectedInstanceArtifacts"
                :prompt-snapshots="orch.selectedInstancePromptSnapshots"
              >
                <template #header-actions>
                  <button
                    v-if="canSkipSelectedNode"
                    class="orch-monitor__action-btn orch-monitor__action-btn--warning"
                    type="button"
                    @click="() => onSkipSelectedNode()"
                  >
                    跳过节点
                  </button>
                  <button
                    v-if="selectedNodeThreadId"
                    class="orch-monitor__action-btn"
                    type="button"
                    @click="openSelectedNodeThread"
                  >
                    查看会话
                  </button>
                  <button
                    v-if="canReassignSelectedNode"
                    class="orch-monitor__action-btn"
                    type="button"
                    @click="() => openReassignNodeAssigneeModal(selectedNodeId)"
                  >
                    转派处理人
                  </button>
                  <button
                    v-if="canForceCompleteSelectedNode"
                    class="orch-monitor__action-btn orch-monitor__action-btn--warning"
                    type="button"
                    @click="() => onForceCompleteSelectedNode()"
                  >
                    手动完成
                  </button>
                  <button
                    v-if="canRerunFromNodeId(selectedNodeId)"
                    class="orch-monitor__action-btn orch-monitor__action-btn--warning"
                    type="button"
                    @click="onRerunFromSelectedNode"
                  >
                    从此节点重跑
                  </button>
                </template>
              </NodeExecutionDetail>
            </div>

            <div class="orch-monitor__review-pane orch-monitor__review-pane--action" data-testid="orch-review-action-pane">
              <ApprovalDialog
                v-if="selectedNodeState.status === 'waiting-approval'"
                :workspace-id="workspaceId"
                :instance-id="instanceId"
                :node-id="selectedNode.id"
                :node-state="selectedNodeState"
                :node-label="selectedNode.label"
                :artifacts="orch.selectedInstanceArtifacts"
                :workflow-nodes="instance.workflowSnapshot?.nodes ?? []"
                :workflow-edges="instance.workflowSnapshot?.edges ?? []"
              />

              <FeedbackDialog
                v-else-if="selectedNodeState.status === 'waiting-feedback'"
                :workspace-id="workspaceId"
                :instance-id="instanceId"
                :node-id="selectedNode.id"
                :node-state="selectedNodeState"
                :node-label="selectedNode.label"
                :artifacts="orch.selectedInstanceArtifacts"
                :workflow-nodes="instance.workflowSnapshot?.nodes ?? []"
                :workflow-edges="instance.workflowSnapshot?.edges ?? []"
              />
            </div>
          </div>

          <NodeExecutionDetail
            v-else
            :workspace-id="workspaceId"
            :instance-id="instanceId"
            :node-state="selectedNodeState"
            :node="selectedNode"
            :workflow-nodes="instance.workflowSnapshot?.nodes ?? []"
            fill-height
            :artifacts="orch.selectedInstanceArtifacts"
            :prompt-snapshots="orch.selectedInstancePromptSnapshots"
          >
            <template #header-actions>
              <button
                v-if="canStartSelectedNode"
                class="orch-monitor__action-btn orch-monitor__action-btn--primary"
                type="button"
                @click="() => onStartSelectedNode()"
              >
                启动节点
              </button>
              <button
                v-if="canSkipSelectedNode"
                class="orch-monitor__action-btn orch-monitor__action-btn--warning"
                type="button"
                @click="() => onSkipSelectedNode()"
              >
                跳过节点
              </button>
              <button
                v-if="selectedNodeThreadId"
                class="orch-monitor__action-btn"
                type="button"
                @click="openSelectedNodeThread"
              >
                查看会话
              </button>
              <button
                v-if="canReassignSelectedNode"
                class="orch-monitor__action-btn"
                type="button"
                @click="() => openReassignNodeAssigneeModal(selectedNodeId)"
              >
                转派处理人
              </button>
              <button
                v-if="canForceCompleteSelectedNode"
                class="orch-monitor__action-btn orch-monitor__action-btn--warning"
                type="button"
                @click="() => onForceCompleteSelectedNode()"
              >
                手动完成
              </button>
              <button
                v-if="canRerunFromNodeId(selectedNodeId)"
                class="orch-monitor__action-btn orch-monitor__action-btn--warning"
                type="button"
                @click="onRerunFromSelectedNode"
              >
                从此节点重跑
              </button>
            </template>
          </NodeExecutionDetail>
        </template>

        <template v-else>
          <div class="orch-monitor__thread-view">
            <div class="orch-monitor__thread-view-bar">
              <div class="orch-monitor__thread-view-copy">
                <div class="orch-monitor__thread-view-heading">
                  <span class="orch-monitor__thread-view-badge">节点会话</span>
                  <strong>{{ selectedNodeLabel }}</strong>
                </div>
                <span class="orch-monitor__thread-view-meta">{{ selectedNodeChatThread?.title ?? detailThreadId ?? "正在准备会话…" }}</span>
              </div>
              <div class="orch-monitor__thread-view-actions">
                <button
                  class="orch-monitor__action-btn orch-monitor__action-btn--primary"
                  type="button"
                  @click="detailModalView = 'detail'"
                >
                  节点详情
                </button>
              </div>
            </div>

            <div v-if="detailThreadLoading && !selectedNodeChatThread" class="orch-monitor__thread-loading">
              <a-spin />
              <span>正在加载节点会话...</span>
            </div>
            <ChatPanel
              v-else-if="detailThreadId"
              class="orch-monitor__thread-panel"
              :workspace-id="workspaceId"
              :thread-id="detailThreadId"
              :interaction-active="monitorViewActive && ui.mainView === 'orchestration' && detailModalOpen"
              :composer-disabled="selectedNodeThreadComposerDisabled"
              :hide-thread-read-only-notice="selectedNodeThreadReadonlyGuardActive"
            >
              <template v-if="selectedNodeThreadGuardActive || selectedNodeThreadReadonlyGuardActive" #composer-guard>
                <div class="orch-monitor__thread-guard">
                  <div class="orch-monitor__thread-guard-copy">
                    <strong>{{ selectedNodeThreadReadonlyGuardActive ? "当前节点只读" : selectedNodeThreadGuardCopy.message }}</strong>
                    <span v-if="selectedNodeThreadReadonlyGuardActive">你可以查看节点会话，但不能输入或推进该节点。</span>
                  </div>
                  <div v-if="canOperateSelectedNode" class="orch-monitor__thread-guard-actions">
                    <button class="orch-monitor__action-btn" type="button" @click="showFeedbackPanel">
                      {{ selectedNodeThreadGuardCopy.action }}
                    </button>
                  </div>
                </div>
              </template>
            </ChatPanel>
          </div>
        </template>
      </div>
    </a-modal>

    <a-modal
      :open="rerunModalOpen"
      :title="`从节点「${rerunTargetNodeLabel}」重跑`"
      :width="720"
      :confirm-loading="rerunSubmitting"
      ok-text="应用并重跑"
      cancel-text="取消"
      :ok-button-props="{ danger: true }"
      destroy-on-close
      @ok="submitRerunFromNode"
      @cancel="closeRerunModal"
    >
      <div class="orch-monitor__rerun">
        <p class="orch-monitor__rerun-hint">{{ rerunFlowHint }}</p>
        <p class="orch-monitor__rerun-hint orch-monitor__rerun-hint--muted">
          只有重跑范围内的旧交付物会被标记为失效，历史会话、反馈和事件会保留用于审计。
        </p>

        <section class="orch-monitor__rerun-section">
          <strong>重跑范围</strong>
          <a-radio-group v-model:value="rerunNodeScope">
            <a-radio value="downstream">此节点及全部下游</a-radio>
            <a-radio value="single">仅此节点</a-radio>
            <a-radio value="custom">自定义连续节点</a-radio>
          </a-radio-group>
          <a-select
            v-if="rerunNodeScope === 'custom'"
            v-model:value="rerunCustomNodeIds"
            mode="multiple"
            :options="rerunCustomNodeOptions"
            placeholder="选择起点之后需要重跑的节点；起点已自动包含"
          />
          <a-alert
            v-if="rerunNodeSelectionError"
            type="error"
            show-icon
            :message="rerunNodeSelectionError"
          />
        </section>

        <section v-if="rerunWorkItemNodes.length" class="orch-monitor__rerun-section">
          <div class="orch-monitor__rerun-section-head">
            <div>
              <strong>同步最新工作项策略</strong>
              <span>更新所选节点的逐项验收、固定收口项和会话换段规则；不修改流程结构、Agent 提示或冻结源码快照。</span>
            </div>
            <a-switch
              v-model:checked="rerunApplyLatestWorkItemPolicy"
              :disabled="!rerunWorkItemPolicySyncAvailable"
            />
          </div>
          <a-alert
            v-if="!rerunWorkItemPolicySyncAvailable"
            type="error"
            show-icon
            message="当前工作流中的工作项节点与实例快照不兼容，不能自动同步。"
          />
        </section>

        <section class="orch-monitor__rerun-section">
          <div class="orch-monitor__rerun-section-head">
            <div>
              <strong>后续角色运行配置</strong>
              <span>流程未执行时可统一更新模型、思考强度和上下文参数。</span>
            </div>
            <a-switch
              :checked="rerunExecutionOverrideEnabled"
              :disabled="!rerunExecutionOverrideMutable"
              @change="onRerunExecutionOverrideEnabledChange"
            />
          </div>

          <a-alert
            v-if="!rerunExecutionOverrideMutable"
            type="warning"
            show-icon
            message="当前流程仍在执行，停止或暂停后才能修改运行配置。"
          />

          <template v-else-if="rerunExecutionOverrideEnabled">
            <div class="orch-monitor__rerun-scope">
              <span>应用范围</span>
              <a-radio-group v-model:value="rerunExecutionOverrideScope" @change="onRerunExecutionOverrideScopeChanged">
                <a-radio value="affected">重跑范围内角色</a-radio>
                <a-radio value="all">整个流程全部角色</a-radio>
              </a-radio-group>
              <small v-if="rerunScopeRoleSummary">{{ rerunScopeRoleSummary }}</small>
            </div>

            <a-alert
              v-if="rerunMissingRoleIds.length"
              type="error"
              show-icon
              :message="`当前工作区缺少角色：${rerunMissingRoleIds.join('、')}`"
            />

            <div v-else class="orch-monitor__rerun-config-grid">
              <label class="orch-monitor__rerun-field">
                <span>执行引擎</span>
                <a-select
                  :value="rerunExecutionOverrideDraft.engine"
                  :options="rerunExecutionEngineOptions"
                  :disabled="rerunExecutionEngineOptions.length === 0"
                  @change="onRerunExecutionOverrideEngineChanged"
                />
              </label>
              <label class="orch-monitor__rerun-field">
                <span>模型</span>
                <a-select
                  v-model:value="rerunExecutionOverrideDraft.model"
                  :disabled="rerunModelOptionGroups.length === 0"
                  :placeholder="rerunModelOptionGroups.length ? '请选择模型' : '模型目录尚未加载'"
                  @change="onRerunExecutionOverrideModelChanged"
                >
                  <a-select-opt-group v-for="group in rerunModelOptionGroups" :key="group.label" :label="group.label">
                    <a-select-option v-for="option in group.options" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </a-select-option>
                  </a-select-opt-group>
                </a-select>
              </label>
              <label class="orch-monitor__rerun-field">
                <span>思考强度</span>
                <a-select
                  v-if="rerunEffortOptions.length"
                  v-model:value="rerunExecutionOverrideDraft.effort"
                  :options="rerunEffortOptions"
                  allow-clear
                  placeholder="不发送"
                />
                <a-input v-else value="不发送" disabled />
              </label>
              <label class="orch-monitor__rerun-field">
                <span>自动压缩比例</span>
                <a-input-number
                  v-model:value="rerunExecutionOverrideDraft.autoCompactPct"
                  :min="50"
                  :max="99"
                  :precision="0"
                  placeholder="继承当前值"
                  style="width: 100%"
                />
              </label>
            </div>

            <a-alert
              type="info"
              show-icon
              message="修改运行配置会自动为重跑起点和已有下游会话新建会话，确保新模型不会继承旧模型上下文。"
            />
          </template>
        </section>

        <section v-if="!rerunExecutionOverrideEnabled" class="orch-monitor__rerun-section">
          <template v-if="rerunTargetHasThread">
            <strong>起点节点会话策略</strong>
            <a-radio-group v-model:value="rerunTargetThreadPolicy">
              <a-radio value="reuse-existing">复用当前会话重跑</a-radio>
              <a-radio value="new-thread">新建会话重跑</a-radio>
            </a-radio-group>
          </template>
          <template v-if="rerunDownstreamThreadCount > 0">
            <strong>下游会话策略（{{ rerunDownstreamThreadCount }} 个下游节点已有会话）</strong>
            <a-radio-group v-model:value="rerunDownstreamThreadPolicy">
              <a-radio value="preserve-existing">保留下游已有会话</a-radio>
              <a-radio value="cascade-new-thread">级联新建下游已运行节点会话</a-radio>
            </a-radio-group>
          </template>
        </section>

        <div class="orch-monitor__rerun-field">
          <span>重跑说明</span>
          <a-textarea
            v-model:value="rerunNote"
            :rows="3"
            placeholder="选填：说明重跑原因，这段内容会作为下一轮节点上下文。"
            @paste="onRerunPaste"
          />
          <div class="orch-monitor__rerun-attachments">
            <span>可直接在说明框中粘贴截图或图片，图片会作为下一轮补充上下文。</span>
            <div v-if="rerunImageAttachments.length" class="orch-monitor__rerun-attachment-list" aria-label="重跑说明附图">
              <div v-for="image in rerunImageAttachments" :key="image.id" class="orch-monitor__rerun-attachment">
                <img :src="image.dataUrl" :alt="image.name" :title="image.name" />
                <button
                  type="button"
                  title="移除附图"
                  :aria-label="'移除附图 ' + image.name"
                  @click.stop="removeRerunImage(image.id)"
                >
                  <CloseOutlined />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </a-modal>

    <a-modal
      :open="reassignModalOpen"
      title="转派节点处理人"
      :width="560"
      :confirm-loading="reassigningNodeAssignees"
      ok-text="确认转派"
      cancel-text="取消"
      :ok-button-props="{ disabled: reassignAssigneeDraft.length === 0 }"
      destroy-on-close
      @ok="submitReassignNodeAssignees"
      @cancel="reassignModalOpen = false"
    >
      <div class="orch-monitor__reassign">
        <div class="orch-monitor__reassign-copy">
          <strong>{{ reassignNodeId ? nodeLabel(reassignNodeId) : "未选择节点" }}</strong>
          <span>仅修改本次执行实例的节点处理人，不会回写流程模板或处理人模板。</span>
        </div>
        <label class="orch-monitor__reassign-field">
          <span>处理人</span>
          <select v-model="reassignAssigneeDraft" multiple>
            <option v-for="member in activeSharedMemberOptions" :key="member.userId" :value="member.userId">
              {{ member.label }}
            </option>
          </select>
        </label>
        <div v-if="activeSharedMemberOptions.length === 0" class="orch-monitor__empty">
          当前没有可选择的有效共享成员。
        </div>
        <div v-else class="orch-monitor__reassign-hint">
          可多选；普通成员仍只能推进自己被分配到的节点。
        </div>
      </div>
    </a-modal>

    <a-modal
      :open="eventsModalOpen"
      title="执行事件"
      :footer="null"
      :width="1100"
      :body-style="{ padding: '16px 20px', maxHeight: 'calc(100vh - 160px)', overflowY: 'auto' }"
      destroy-on-close
      @cancel="eventsModalOpen = false"
    >
      <div v-if="orch.selectedInstanceEvents.length" class="orch-monitor__events">
        <div v-for="event in orch.selectedInstanceEvents.slice().reverse()" :key="event.id" class="orch-monitor__event-item">
          <span class="orch-monitor__event-time">{{ formatEventTime(event.createdAt) }}</span>
          <span class="orch-monitor__event-type">{{ event.type }}</span>
          <span class="orch-monitor__event-summary">{{ eventSummary(event) }}</span>
        </div>
      </div>
      <div v-else class="orch-monitor__empty">当前没有执行事件。</div>
    </a-modal>
  </div>

  <div v-else class="orch-monitor__loading">加载中...</div>
</template>

<style scoped>
.orch-monitor {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  gap: 10px;
  min-height: 0;
}

.orch-monitor__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.orch-monitor__title {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.orch-monitor__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.orch-monitor__title-text {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.45;
}

.orch-monitor__status {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, #fff);
  font-size: 12px;
  font-weight: 700;
}

.orch-monitor__meta {
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted, #666);
}

.orch-monitor__actions,
.orch-monitor__selection-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.orch-monitor__reassign {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.orch-monitor__rerun {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.orch-monitor__rerun-hint {
  margin: 0;
  color: var(--app-text, #1f2937);
  font-size: 13px;
  line-height: 1.65;
}

.orch-monitor__rerun-hint--muted {
  color: var(--app-muted, #666);
  font-size: 12px;
}

.orch-monitor__rerun-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--app-border, #e8e8e8);
}

.orch-monitor__rerun-section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.orch-monitor__rerun-section-head > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.orch-monitor__rerun-section-head strong,
.orch-monitor__rerun-section > strong,
.orch-monitor__rerun-field > span,
.orch-monitor__rerun-scope > span {
  color: var(--app-text, #1f2937);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}

.orch-monitor__rerun-section-head span,
.orch-monitor__rerun-scope small {
  color: var(--app-muted, #666);
  font-size: 12px;
  line-height: 1.55;
}

.orch-monitor__rerun-scope,
.orch-monitor__rerun-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}

.orch-monitor__rerun-scope small {
  overflow-wrap: anywhere;
}

.orch-monitor__rerun-attachments {
  display: flex;
  flex-direction: column;
  gap: 7px;
  color: var(--app-muted, #666);
  font-size: 12px;
  line-height: 1.55;
}

.orch-monitor__rerun-attachment-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.orch-monitor__rerun-attachment {
  position: relative;
  width: 56px;
  height: 56px;
  flex: 0 0 56px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 8px;
  overflow: hidden;
  background: color-mix(in srgb, var(--app-bg, #fff) 92%, var(--app-hover-bg, #fafafa));
}

.orch-monitor__rerun-attachment img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.orch-monitor__rerun-attachment button {
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
  font-size: 11px;
  line-height: 1;
}

.orch-monitor__rerun-scope :deep(.ant-radio-group),
.orch-monitor__rerun-section > :deep(.ant-radio-group) {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}

.orch-monitor__rerun-config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.orch-monitor__reassign-copy,
.orch-monitor__reassign-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.orch-monitor__reassign-copy span,
.orch-monitor__reassign-field span,
.orch-monitor__reassign-hint {
  color: var(--app-muted, #666);
  font-size: 12px;
  line-height: 1.6;
}

.orch-monitor__reassign-field select {
  min-height: 160px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 8px;
  padding: 8px;
  outline: none;
}

.orch-monitor__switcher {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--app-muted, #666);
}

.orch-monitor__switcher select {
  min-width: 210px;
  min-height: 38px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 14%, #b9c4d2);
  background: linear-gradient(180deg, #ffffff, #f7fbff);
  color: var(--app-text, #1f2937);
  box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.05), 0 1px 0 rgba(255, 255, 255, 0.9);
}

.orch-monitor__action-btn {
  min-height: 34px;
  padding: 6px 12px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 10px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 95%, #f7f9fc), var(--app-bg, #fff));
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}

.orch-monitor__action-btn:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 28%, var(--app-border, #d9d9d9));
  box-shadow: 0 10px 22px rgba(15, 23, 42, 0.06);
}

.orch-monitor__action-btn--primary {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 28%, var(--app-border, #d9d9d9));
  color: var(--app-primary, #1677ff);
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, #fff);
}

.orch-monitor__action-btn--danger {
  border-color: color-mix(in srgb, #ff4d4f 34%, var(--app-border, #d9d9d9));
  color: #cf1322;
  background: color-mix(in srgb, #ff4d4f 8%, #fff);
}

.orch-monitor__action-btn--warning {
  border-color: color-mix(in srgb, #faad14 34%, var(--app-border, #d9d9d9));
  color: #ad6800;
  background: color-mix(in srgb, #faad14 10%, #fff);
}

.orch-monitor__review-banner {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 18px;
  background: transparent;
  box-shadow: 0 14px 34px rgba(15, 23, 42, 0.05);
}

.orch-monitor__review-banner {
  padding: 8px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.orch-monitor__review-copy {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}

.orch-monitor__review-badge {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  background: color-mix(in srgb, #faad14 16%, #fff);
  color: #ad6800;
  font-size: 12px;
  font-weight: 700;
}

.orch-monitor__review-banner strong {
  font-size: 13px;
}

.orch-monitor__review-copy span:last-child {
  font-size: 12px;
  line-height: 1.5;
  color: var(--app-muted, #666);
}

.orch-monitor__pending-bar {
  display: grid;
  grid-template-columns: minmax(180px, 260px) minmax(0, 1fr);
  align-items: start;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, #faad14 34%, var(--app-border, #e8e8e8));
  border-radius: 12px;
  background: color-mix(in srgb, #faad14 8%, var(--app-panel-bg, #fff));
}

.orch-monitor__pending-copy {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
  color: var(--app-text, #1f2937);
  font-size: 12px;
  line-height: 1.6;
}

.orch-monitor__pending-copy strong {
  min-width: 0;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.orch-monitor__pending-badge {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  background: color-mix(in srgb, #faad14 18%, #fff);
  color: #ad6800;
  font-size: 12px;
  font-weight: 700;
}

.orch-monitor__pending-stack {
  min-width: 0;
}

.orch-monitor__graph {
  flex: 1 1 auto;
  min-height: 0;
}

.orch-monitor__graph-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.orch-monitor__selection-float {
  /* 选中节点的浮动操作栏：水平居中悬挂在画布上方 */
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  width: min(1080px, calc(100% - 24px));
  pointer-events: none;
}

.orch-monitor__selection-bar {
  display: flex;
  flex: 0 0 auto;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 10%, var(--app-border, #e8e8e8));
  border-radius: 16px;
  background: transparent;
}

.orch-monitor__selection-bar--floating {
  pointer-events: auto;
  background: color-mix(in srgb, var(--app-bg, #fff) 84%, rgba(247, 249, 252, 0.96));
  backdrop-filter: blur(14px);
  box-shadow: 0 16px 34px rgba(15, 23, 42, 0.12);
}

.orch-monitor__selection-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.orch-monitor__selection-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.orch-monitor__selection-title strong {
  font-size: 14px;
}

.orch-monitor__selection-status {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, #fff);
  font-size: 12px;
  font-weight: 700;
}

.orch-monitor__selection-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.orch-monitor__selection-meta span {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 6%, #fff);
  color: var(--app-muted, #666);
  font-size: 11px;
}

.orch-monitor__context-menu {
  position: fixed;
  z-index: 2200;
  min-width: 220px;
  padding: 8px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 14px;
  background: var(--app-panel-bg, #fff);
  box-shadow: 0 16px 34px rgba(15, 23, 42, 0.18);
}

.orch-monitor__context-title {
  padding: 4px 8px 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text, #1f2937);
  line-height: 1.5;
}

.orch-monitor__context-item {
  width: 100%;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--app-text, #1f2937);
  padding: 9px 10px;
  text-align: left;
  font-size: 13px;
  cursor: pointer;
}

.orch-monitor__context-item:hover {
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, var(--app-panel-bg, #fff));
}

.orch-monitor__detail-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-height: 56px;
  min-width: 0;
}

.orch-monitor__detail-title-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-text, #1f2937);
  font-size: 16px;
  font-weight: 600;
}

.orch-monitor__detail-title-actions {
  display: inline-flex;
  align-items: center;
  gap: 0;
  flex: 0 0 auto;
  margin-right: -6px;
}

.orch-monitor__detail-icon-action.ant-btn {
  position: relative;
  width: 44px;
  min-width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  color: var(--app-muted, #667085);
  box-shadow: none;
}

.orch-monitor__detail-icon-action.ant-btn::before {
  content: "";
  position: absolute;
  inset: 6px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.orch-monitor__detail-icon-action.ant-btn:hover,
.orch-monitor__detail-icon-action.ant-btn:focus-visible {
  color: var(--app-primary, #1677ff);
  background: transparent;
}

.orch-monitor__detail-icon-action.ant-btn:hover::before,
.orch-monitor__detail-icon-action.ant-btn:focus-visible::before {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 28%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, var(--app-bg, #fff));
}

.orch-monitor__detail-icon-action.ant-btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--app-primary, #1677ff) 55%, transparent);
  outline-offset: -4px;
}

.orch-monitor__detail-icon-action :deep(.anticon) {
  position: relative;
  z-index: 1;
  font-size: 15px;
}

.orch-monitor__detail-icon-action--close.ant-btn:hover,
.orch-monitor__detail-icon-action--close.ant-btn:focus-visible {
  color: #d92d20;
}

.orch-monitor__detail-icon-action--close.ant-btn:hover::before,
.orch-monitor__detail-icon-action--close.ant-btn:focus-visible::before {
  border-color: color-mix(in srgb, #d92d20 26%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #d92d20 7%, var(--app-bg, #fff));
}

.orch-monitor__context-item--warning {
  color: #ad6800;
}

.orch-monitor__context-item--danger {
  color: #cf1322;
}

.orch-monitor__detail-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}

.orch-monitor__detail-hydration {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex: 0 0 auto;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 24%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, transparent);
  color: var(--app-text-secondary, #5f6b7a);
  font-size: 12px;
  line-height: 1.5;
}

.orch-monitor__detail-hydration--error {
  border-color: color-mix(in srgb, #d93025 26%, transparent);
  background: color-mix(in srgb, #d93025 8%, transparent);
  color: #8a2b24;
}

.orch-monitor__detail-retry {
  flex: 0 0 auto;
  border: 0;
  border-radius: 6px;
  padding: 4px 8px;
  background: #ffffff;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
}

.orch-monitor__detail-modal--chat {
  overflow: hidden;
  padding-right: 0;
  height: calc(100dvh - 160px);
  max-height: calc(100dvh - 160px);
}

.orch-monitor__detail-modal--review {
  height: 100%;
  max-height: 100%;
  overflow: hidden;
  padding-right: 0;
}

.orch-monitor__detail-modal--fullscreen {
  height: 100%;
  max-height: 100%;
  padding-right: 0;
  overflow: auto;
}

.orch-monitor__detail-modal--fullscreen.orch-monitor__detail-modal--chat {
  height: 100%;
  max-height: 100%;
}

.orch-monitor__detail-modal--branch {
  height: auto;
  max-height: none;
  overflow: visible;
  padding-right: 0;
}

.orch-monitor__branch-decision-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.orch-monitor__branch-decision-panel :deep(.feedback-dialog) {
  height: auto;
  min-height: 0;
}

.orch-monitor__review-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(360px, 420px);
  gap: 16px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.orch-monitor__review-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.orch-monitor__review-pane--detail {
  padding-right: 4px;
}

.orch-monitor__review-pane--action {
  padding-right: 4px;
  overflow: auto;
}

.orch-monitor__review-pane--action :deep(.approval-dialog),
.orch-monitor__review-pane--action :deep(.feedback-dialog) {
  height: 100%;
  min-height: 0;
}

.orch-monitor__manual-start-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.orch-monitor__manual-start-heading {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--app-border, #e8e8e8);
}

.orch-monitor__manual-start-heading span {
  width: fit-content;
  min-height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: color-mix(in srgb, #fa8c16 12%, var(--app-bg, #fff));
  color: #d46b08;
  font-size: 12px;
  font-weight: 700;
  line-height: 22px;
}

.orch-monitor__manual-start-heading strong {
  color: var(--app-text, #1f1f1f);
  font-size: 16px;
}

.orch-monitor__manual-start-heading p,
.orch-monitor__manual-start-prompt p {
  margin: 0;
  color: var(--app-muted, #666);
  font-size: 13px;
  line-height: 1.7;
}

.orch-monitor__manual-start-prompt {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, #fa8c16 24%, var(--app-border, #e8e8e8));
  border-radius: 8px;
  background: color-mix(in srgb, #fa8c16 7%, var(--app-bg, #fff));
}

.orch-monitor__manual-start-prompt span,
.orch-monitor__manual-start-field span {
  color: var(--app-muted, #666);
  font-size: 12px;
  font-weight: 600;
}

.orch-monitor__manual-start-prompt p {
  white-space: pre-wrap;
}

.orch-monitor__manual-start-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.orch-monitor__manual-start-field textarea {
  width: 100%;
  min-height: 132px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--app-bg, #fff);
  color: var(--app-text, #1f1f1f);
  font-size: 13px;
  line-height: 1.6;
  outline: none;
  resize: vertical;
}

.orch-monitor__manual-start-field textarea:focus {
  border-color: var(--app-primary, #1677ff);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-primary, #1677ff) 16%, transparent);
}

.orch-monitor__manual-start-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.orch-monitor__manual-start-actions .orch-monitor__action-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.orch-monitor__thread-view,
.orch-monitor__thread-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.orch-monitor__thread-view {
  gap: 10px;
  height: 100%;
  max-height: 100%;
  overflow: hidden;
}

.orch-monitor__thread-view-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-bg, #fff) 96%, var(--app-border, #d9d9d9));
  box-shadow: 0 3px 10px rgba(15, 23, 42, 0.03);
}

.orch-monitor__thread-view-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
  flex: 1 1 auto;
}

.orch-monitor__thread-view-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.orch-monitor__thread-view-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  min-height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, var(--app-bg, #fff));
  color: var(--app-primary, #1677ff);
  font-size: 11px;
  font-weight: 700;
}

.orch-monitor__thread-view-heading strong {
  min-width: 0;
  font-size: 14px;
  line-height: 1.35;
}

.orch-monitor__thread-view-meta {
  font-size: 11px;
  line-height: 1.4;
  color: var(--app-muted, #666);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.orch-monitor__thread-view-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  flex: 0 0 auto;
}

.orch-monitor__thread-view-actions .orch-monitor__action-btn {
  min-height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  white-space: nowrap;
  font-size: 11px;
}

.orch-monitor__thread-loading {
  min-height: 260px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px dashed var(--app-border, #d9d9d9);
  border-radius: 14px;
  color: var(--app-muted, #666);
}

.orch-monitor__thread-panel {
  overflow: hidden;
  height: 100%;
  max-height: 100%;
}

.orch-monitor__thread-panel :deep(.chat-panel),
.orch-monitor__thread-panel :deep(.chat-panel__body),
.orch-monitor__thread-panel :deep(.chat-panel__messages),
.orch-monitor__thread-panel :deep(.chat-panel__composer),
.orch-monitor__thread-panel :deep(.chat-panel__composer-inner) {
  min-height: 0;
}

.orch-monitor__thread-panel :deep(.chat-panel) {
  height: 100%;
  overflow: hidden;
}

.orch-monitor__events {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.orch-monitor__event-item {
  display: grid;
  grid-template-columns: 72px 260px 1fr;
  gap: 10px;
  align-items: start;
  padding: 8px 10px;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 96%, #f8fafc), var(--app-bg, #fff));
  font-size: 12px;
}

.orch-monitor__event-time {
  color: var(--app-muted, #999);
}

.orch-monitor__event-type {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  color: var(--app-primary, #1677ff);
}

.orch-monitor__event-summary {
  color: var(--app-text, #333);
  line-height: 1.7;
}

.orch-monitor__empty,
.orch-monitor__loading {
  padding: 20px;
  text-align: center;
  color: var(--app-muted, #999);
  font-size: 13px;
}

:deep(.orch-monitor__detail-modal-wrap .ant-modal) {
  height: calc(100dvh - 40px);
  margin: 0 auto;
  max-width: min(90%, calc(100vw - 32px));
  top: 0;
  padding-bottom: 0;
}

:deep(.orch-monitor__detail-modal-wrap) {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow: hidden;
  padding: 20px 0;
}

:deep(.orch-monitor__detail-modal-wrap .ant-modal-content) {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

:deep(.orch-monitor__detail-modal-wrap .ant-modal-body) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

@media (max-width: 767px) {
  .orch-monitor__detail-titlebar {
    min-height: 52px;
  }

  .orch-monitor__detail-title-actions {
    width: auto;
    justify-content: flex-end;
    margin-left: auto;
  }

  .orch-monitor__detail-icon-action--fullscreen {
    display: none !important;
  }

  .orch-monitor__header,
  .orch-monitor__review-banner {
    flex-direction: column;
  }

  .orch-monitor__pending-bar {
    grid-template-columns: 1fr;
  }

  .orch-monitor__actions,
  .orch-monitor__selection-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .orch-monitor__switcher {
    width: 100%;
    flex-direction: column;
    align-items: stretch;
  }

  .orch-monitor__switcher select {
    width: 100%;
    min-width: 0;
  }

  .orch-monitor__event-item {
    grid-template-columns: 1fr;
  }

  .orch-monitor__review-workspace {
    grid-template-columns: 1fr;
  }

  .orch-monitor__thread-view-bar {
    align-items: flex-start;
    flex-direction: column;
  }

  .orch-monitor__thread-view-actions {
    justify-content: flex-start;
  }

  .orch-monitor__thread-view-meta {
    white-space: normal;
  }

  .orch-monitor__thread-guard {
    align-items: flex-start;
    flex-direction: column;
  }

  .orch-monitor__rerun-section-head {
    gap: 10px;
  }

  .orch-monitor__rerun-config-grid {
    grid-template-columns: 1fr;
  }
}

:root[data-theme="dark"] .orch-monitor__review-banner,
:root[data-theme="dark"] .orch-monitor__pending-bar,
:root[data-theme="dark"] .orch-monitor__selection-bar,
:root[data-theme="dark"] .orch-monitor__event-item {
  border-color: #303030;
  background: transparent;
}

:root[data-theme="dark"] .orch-monitor__selection-bar--floating {
  background: color-mix(in srgb, rgba(17, 24, 39, 0.92) 84%, transparent);
  box-shadow: 0 18px 36px rgba(0, 0, 0, 0.34);
}

:root[data-theme="dark"] .orch-monitor__manual-start-heading {
  border-bottom-color: #303030;
}

:root[data-theme="dark"] .orch-monitor__manual-start-heading span {
  background: rgba(250, 140, 22, 0.16);
  color: #ffd591;
}

:root[data-theme="dark"] .orch-monitor__manual-start-prompt,
:root[data-theme="dark"] .orch-monitor__manual-start-field textarea {
  border-color: #3b4c63;
  background: rgba(15, 23, 42, 0.72);
}

:root[data-theme="dark"] .orch-monitor__switcher select,
:root[data-theme="dark"] .orch-monitor__action-btn {
  border-color: #3b4c63;
  background: linear-gradient(180deg, #181d24, #13171d);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(59, 76, 99, 0.14);
  color: #d6dbe4;
}

:root[data-theme="dark"] .orch-monitor__action-btn--primary,
:root[data-theme="dark"] .orch-monitor__selection-status,
:root[data-theme="dark"] .orch-monitor__status {
  background: rgba(22, 119, 255, 0.12);
  color: #8eb7ff;
}

:root[data-theme="dark"] .orch-monitor__selection-meta span {
  background: rgba(255, 255, 255, 0.04);
  color: #9fb0c2;
}

:root[data-theme="dark"] .orch-monitor__review-badge {
  background: rgba(250, 173, 20, 0.18);
  color: #ffd666;
}

:root[data-theme="dark"] .orch-monitor__pending-badge {
  background: rgba(250, 173, 20, 0.18);
  color: #ffd666;
}

:root[data-theme="dark"] .orch-monitor__context-title,
:root[data-theme="dark"] .orch-monitor__context-item {
  color: #d6dbe4;
}

:root[data-theme="dark"] .orch-monitor__detail-title-text {
  color: #f3f4f6;
}

:root[data-theme="dark"] .orch-monitor__detail-icon-action.ant-btn {
  color: #d6dbe4;
}

:root[data-theme="dark"] .orch-monitor__detail-icon-action.ant-btn:hover,
:root[data-theme="dark"] .orch-monitor__detail-icon-action.ant-btn:focus-visible {
  color: #8eb7ff;
}

:root[data-theme="dark"] .orch-monitor__detail-icon-action.ant-btn:hover::before,
:root[data-theme="dark"] .orch-monitor__detail-icon-action.ant-btn:focus-visible::before {
  border-color: #3b4c63;
  background: rgba(22, 119, 255, 0.12);
}

:root[data-theme="dark"] .orch-monitor__detail-icon-action--close.ant-btn:hover,
:root[data-theme="dark"] .orch-monitor__detail-icon-action--close.ant-btn:focus-visible {
  color: #ff9c9c;
}

:root[data-theme="dark"] .orch-monitor__detail-icon-action--close.ant-btn:hover::before,
:root[data-theme="dark"] .orch-monitor__detail-icon-action--close.ant-btn:focus-visible::before {
  border-color: rgba(255, 77, 79, 0.42);
  background: rgba(255, 77, 79, 0.12);
}

.orch-monitor__thread-guard {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 0 2px 10px;
  border-left: 3px solid color-mix(in srgb, var(--app-primary, #1677ff) 52%, var(--app-border, #d9d9d9));
  background: transparent;
}

.orch-monitor__thread-guard-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.orch-monitor__thread-guard-copy strong {
  font-size: 12px;
  line-height: 1.4;
  color: var(--app-text, #222);
}

.orch-monitor__thread-guard-copy span {
  font-size: 11px;
  line-height: 1.45;
  color: var(--app-muted, #666);
}

.orch-monitor__thread-guard-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 0 0 auto;
}

.orch-monitor__thread-guard-actions .orch-monitor__action-btn {
  min-height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 11px;
}
</style>

<style>
.orch-monitor__detail-modal-wrap {
  display: flex !important;
  align-items: flex-start;
  justify-content: center;
  overflow: hidden !important;
  padding: 20px 0;
}

.orch-monitor__detail-modal-wrap .ant-modal {
  width: min(90%, calc(100vw - 32px)) !important;
  max-width: min(90%, calc(100vw - 32px)) !important;
  height: calc(100dvh - 40px) !important;
  min-height: calc(100dvh - 40px) !important;
  max-height: calc(100dvh - 40px) !important;
  margin: 0 auto;
  top: 0;
  padding-bottom: 0;
}

.orch-monitor__detail-modal-wrap .ant-modal-content {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.orch-monitor__detail-modal-wrap .ant-modal-header {
  flex: 0 0 auto;
  min-height: 56px;
  padding: 0 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 86%, transparent);
}

.orch-monitor__detail-modal-wrap .ant-modal-title {
  width: 100%;
  min-width: 0;
}

@media (max-width: 767px) {
  .orch-monitor__detail-modal-wrap .ant-modal-header {
    min-height: 52px;
  }
}

.orch-monitor__detail-modal-wrap .ant-modal-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden !important;
}

.orch-monitor__detail-modal-wrap--branch .ant-modal {
  width: min(680px, calc(100vw - 32px)) !important;
  max-width: min(680px, calc(100vw - 32px)) !important;
  height: auto !important;
  min-height: 0 !important;
  max-height: calc(100dvh - 40px) !important;
}

.orch-monitor__detail-modal-wrap--branch .ant-modal-content {
  height: auto;
  max-height: calc(100dvh - 40px);
}

.orch-monitor__detail-modal-wrap--branch .ant-modal-body {
  flex: 0 1 auto;
  overflow: auto !important;
}

.orch-monitor__detail-modal-wrap--fullscreen {
  padding: 0;
}

.orch-monitor__detail-modal-wrap--fullscreen .ant-modal {
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100dvh !important;
  max-height: 100dvh !important;
  margin: 0 !important;
  top: 0 !important;
  padding-bottom: 0 !important;
}

.orch-monitor__detail-modal-wrap--fullscreen .ant-modal-content {
  border-radius: 0;
  height: 100dvh !important;
  max-height: 100dvh !important;
}

.orch-monitor__detail-modal-wrap--fullscreen .ant-modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto !important;
}
</style>

