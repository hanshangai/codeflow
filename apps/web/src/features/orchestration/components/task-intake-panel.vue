<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import {
  CloseOutlined,
  DeleteOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons-vue";
import { message, Modal } from "ant-design-vue";
import {
  TASK_INTAKE_TITLE_MAX_LENGTH,
  createStandaloneRoleWorkflow,
  createTaskAcceptanceCriteriaFromLines,
  getTaskIntakeTitle,
  isRoleExecutionEngineEnabled,
  normalizeOrchestrationRunMode,
  normalizeOrchestrationRunPlanAssignees,
  normalizeOrchestrationRunPlanSkippedNodeIds,
  parseStandaloneRoleWorkflowId,
  type AssigneeTemplate,
  type EngineType,
  type IntakeId,
  type OrchestrationExecutionEngineStrategy,
  type OrchestrationId,
  type OrchestrationRunMode,
  type OrchestrationRunPlan,
  type OrchestrationRoleExecutionOverride,
  type RoleDefinition,
  type RoleId,
  type SharedWorkspaceMemberItem,
  type TaskIntake,
  type TaskIntakeExecutionPlan,
  type TaskIntakeMetricCohortPairEvidenceRef,
  type TaskIntakeMetricCohortSnapshot,
  type TaskIntakeMetricEvidenceConclusion,
  type TaskIntakeMetricReviewReason,
  type TaskIntakeMetricReviewSnapshot,
  type TaskIntakeMetricReviewStatus,
  type WorkspaceId,
  type WorkflowDefinition,
  type WorkflowExecutionDefault,
  type WorkflowId,
} from "@codeflowai/shared";

import { getOrchestrationMetricExperiments } from "../../../api/orchestration-metrics";
import { useApiContext } from "../../../composables/useApiContext";
import { buildModelSelectOptionGroups, type ModelSelectOptionGroup } from "../../../composables/modelSelectOptions";
import {
  resolveCatalogRoleExecutionConfigForEngine,
  resolveCatalogRoleExecutionConfigForStrategy,
} from "../../../composables/runtimeRoleExecutionConfig";
import { useEngineStore } from "../../../store/engine";
import { useConfigStore } from "../../../store/config";
import {
  applyHydratedPlannerDraftIfCurrent,
  OrchIntakeDeleteConflictError,
  shouldApplyHydratedPlannerDraft,
  useOrchestrationStore,
} from "../../../store/orchestration";
import { useReminderStore } from "../../../store/reminders";
import { useSharedWorkspacesStore } from "../../../store/sharedWorkspaces";
import { useUiStore } from "../../../store/ui";
import { parseSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { resolveNodeWorkbenchDescriptor } from "../node-workbench";
import {
  applyRoleExecutionOverrideBatch,
  disableRoleExecutionOverrideBatch,
  listCommonRoleExecutionEngines,
  type RoleExecutionOverrideBatchDraft,
  type RoleExecutionOverrideBatchTarget,
  type RoleExecutionOverrideDraft,
} from "../role-execution-override-batch";
import ArtifactBrowser from "./artifact-browser.vue";
import OrchestrationMonitor from "./orchestration-monitor.vue";
import WorkflowGraphView from "./workflow-graph-view.vue";
import {
  buildTaskIntakeMetricReviewFilters,
  createTaskIntakeMetricReviewSnapshot,
  resolveTaskIntakeMetricReviewStatus,
} from "./task-intake-metric-review";

defineOptions({ name: "TaskIntakePanel" });

const props = defineProps<{ workspaceId: WorkspaceId }>();

const orch = useOrchestrationStore();
const engines = useEngineStore();
const config = useConfigStore();
const reminders = useReminderStore();
const sharedWorkspaces = useSharedWorkspacesStore();
const ui = useUiStore();
const { ctx } = useApiContext();
const router = useRouter();
const engineModels = (engine: EngineType) => engines.byTypeForWorkspace(props.workspaceId).get(engine)?.models ?? [];

const title = ref("");
const goal = ref("");
const acceptanceText = ref("");
const nodeApprovalMode = ref<"auto" | "manual">("auto");
const executionTargetType = ref<"workflow" | "role">("workflow");
const workflowId = ref("");
const roleId = ref("");
const workflowRunMode = ref<OrchestrationRunMode>("independent");
const executionEngineStrategy = ref<OrchestrationExecutionEngineStrategy>("follow-role");
const roleExecutionOverrideDrafts = ref<Record<string, RoleExecutionOverrideDraft>>({});
const roleOverrideBatchDraft = ref<RoleExecutionOverrideBatchDraft>({
  engine: "codex",
  model: "",
  effort: "",
  autoCompactPct: null,
});
const requirementSaving = ref(false);
const executionPlanSaving = ref(false);
const applyingSavedExecutionPlan = ref(false);
const editingIntakeId = ref<IntakeId | null>(null);
const requirementDetailModalOpen = ref(false);
const requirementDetailModalFullscreen = ref(false);
const requirementDetailModalViewportHeight = ref(720);
const metricReviewLoading = ref(false);
const metricReviewSaving = ref(false);
const metricReviewError = ref("");
const metricReviewStatus = ref<TaskIntakeMetricReviewStatus | null>(null);
const metricReviewPreview = ref<TaskIntakeMetricReviewSnapshot | null>(null);
const rerunComposerOpen = ref(false);
const artifactModalOpen = ref(false);
const artifactModalFullscreen = ref(false);
// 角色模型配置弹框开关：把原本 inline 撑爆面板的 N×5 列表收进 a-modal
const roleOverrideModalOpen = ref(false);
const assigneePlanModalOpen = ref(false);
const nodeAssigneeDrafts = ref<Record<string, string[]>>({});
const skipNodeModalOpen = ref(false);
const skippedNodeDrafts = ref<string[]>([]);
// 用 undefined 而非空串：a-select 把空串视为"已选空值"，会渲染一个空 selection-item 而吞掉 placeholder
const assigneeTemplateId = ref<string | undefined>(undefined);
const assigneeTemplateNameDraft = ref("");
const assigneeTemplateSaving = ref(false);
// 控制"另存为新模板"输入面板的展开；仅在用户主动点击下拉项后出现，避免常驻噪音
const assigneeSaveAsOpen = ref(false);
const ENTERPRISE_LIMITED_MESSAGE = "当前企业访问受限，请联系管理员检查企业及成员状态。";
const monitorRef = ref<{
  openEventsModal: () => void;
  openPrimaryNodeAction: () => void;
  hasReworkEdges: boolean;
  showReworkEdges: boolean;
  reworkEdgePreferenceError: string | null;
  toggleReworkEdges: () => void;
} | null>(null);
const EXECUTION_MONITOR_SYNC_INTERVAL_MS = 30000;
let executionMonitorSyncTimer: number | null = null;
let executionMonitorSyncInFlight = false;
let executionMonitorSyncBlockedKey: string | null = null;
const executionMonitorViewActive = ref(true);
let plannerDataHydratedKey: string | null = null;
let plannerDataHydrationInFlight: Promise<void> | null = null;
let plannerDataHydrationInFlightKey: string | null = null;
let plannerExecutionPlanAppliedKey: string | null = null;
let plannerSelectionGeneration = 0;
let plannerDraftEditVersion = 0;
let plannerDraftCleanVersion = 0;
let lastAppliedAssigneeSelectionKey: string | null = null;
let lastReconciledSharedMembersKey: string | null = null;
let lastHydratedAssigneeTemplateKey: string | null = null;
let assigneeTemplateHydrationInFlight: Promise<void> | null = null;
let assigneeTemplateHydrationInFlightKey: string | null = null;
let assigneeTemplateHydrationRequestSeq = 0;
const sharedMemberHydrationInFlight = new Map<string, Promise<void>>();
let executionPlanApplySeq = 0;
let metricReviewRequestVersion = 0;

/** 提取 API 诊断字段，日志只记录稳定 code/requestId 和实体上下文。 */
function errorDiagnosticContext(error: unknown, fallbackCode: string): { errorCode: string; requestId: string | null } {
  const raw = error && typeof error === "object" ? error as Record<string, any> : {};
  return {
    errorCode: String(raw.code ?? fallbackCode).trim() || fallbackCode,
    requestId: String(raw.requestId ?? raw.request_id ?? raw.meta?.requestId ?? "").trim() || null,
  };
}

const selectedIntake = computed(() => orch.selectedIntake);
const selectedIntakeReadOnly = computed(() => Boolean(selectedIntake.value?.readOnly || selectedIntake.value?.sharedContext?.readOnly));
const isCreateMode = computed(() => orch.intakeComposerOpen);
const isEditMode = computed(() => Boolean(selectedIntake.value && editingIntakeId.value === selectedIntake.value.id));
const showEditor = computed(() => isCreateMode.value || isEditMode.value);
const canSubmit = computed(() => (
  !requirementSaving.value
  && !selectedIntakeReadOnly.value
  && title.value.trim().length > 0
  && goal.value.trim().length > 0
));
const titleCount = computed(() => Array.from(title.value.trim()).length);
const requirementModalTitle = computed(() => isEditMode.value ? "编辑需求" : "发起新需求");
const requirementModalDescription = computed(() =>
  isEditMode.value
    ? "直接修改这条需求的需求描述、验收标准和执行偏好，保存后后续执行会继续挂在同一条需求下。"
    : "先把需求描述和验收标准记录下来，形成一条可追踪的需求，再选择流程模板或单角色开始执行。",
);
const relatedProposals = computed(() => {
  const intakeId = selectedIntake.value?.id;
  if (!intakeId) return [];
  return [...orch.proposals]
    .filter((proposal) => proposal.intakeId === intakeId)
    .sort((left, right) => right.updatedAt - left.updatedAt);
});
const selectedScopedProposal = computed(() => {
  const intakeId = selectedIntake.value?.id;
  const proposal = orch.selectedProposal;
  if (!intakeId || !proposal || proposal.intakeId !== intakeId) return null;
  return proposal;
});
const relatedInstances = computed(() => {
  const intakeId = selectedIntake.value?.id;
  if (!intakeId) return [];
  return [...orch.instanceSummaries]
    .filter((instance) => instance.intakeId === intakeId)
    .sort((left, right) => right.updatedAt - left.updatedAt);
});
const latestProposal = computed(() => selectedScopedProposal.value ?? relatedProposals.value[0] ?? null);
const activeInstance = computed(() => relatedInstances.value.find((instance) => (
  instance.status === "pending"
  || instance.status === "running"
  || instance.status === "paused"
  || instance.status === "waiting-start"
  || instance.status === "waiting-approval"
  || instance.status === "waiting-feedback"
)) ?? null);
const hasExecutionHistory = computed(() => relatedInstances.value.length > 0);
const showRunComposer = computed(() => !hasExecutionHistory.value || rerunComposerOpen.value);
const showExecutionMonitor = computed(() => hasExecutionHistory.value && !showRunComposer.value);
const selectedWorkflow = computed(() => orch.workflows.find((workflow) => workflow.id === workflowId.value) ?? null);
const selectedRole = computed(() => orch.roles.find((role) => role.id === roleId.value) ?? null);
const previewWorkflow = computed<WorkflowDefinition | null>(() => {
  if (executionTargetType.value === "workflow") {
    return selectedWorkflow.value;
  }
  if (!selectedRole.value) return null;
  return buildStandaloneRolePreviewWorkflow(selectedRole.value);
});
/** 当前流程在本工作区配置的统一执行模型；单角色执行不读取流程配置。 */
const selectedWorkflowExecutionDefault = ref<WorkflowExecutionDefault | null>(null);
const selectedWorkflowExecutionDefaultSummary = computed(() => {
  const configured = selectedWorkflowExecutionDefault.value;
  if (!configured) return "";
  return `${configured.engine === "codex" ? "Codex" : "Claude"} · ${configured.model}`;
});
watch(
  () => (executionTargetType.value === "workflow" ? String(selectedWorkflow.value?.id ?? "") : ""),
  async (targetWorkflowId) => {
    if (!targetWorkflowId) {
      selectedWorkflowExecutionDefault.value = null;
      return;
    }
    try {
      selectedWorkflowExecutionDefault.value = await orch.loadWorkflowExecutionDefault(
        ctx.value,
        props.workspaceId,
        targetWorkflowId as WorkflowId,
      );
    } catch (error) {
      // 读取失败时清空展示并显式提示，避免把过期配置当成当前口径。
      selectedWorkflowExecutionDefault.value = null;
      message.warning(error instanceof Error ? error.message : "流程模型配置读取失败");
    }
  },
  { immediate: true },
);
/** 按唯一角色汇总流程节点，保证同一角色的运行覆盖只展示和提交一次。 */
const executionWorkflowRoles = computed(() => {
  if (!previewWorkflow.value) return [] as Array<{ roleId: string; roleName: string; nodeLabel: string }>;
  const grouped = new Map<string, { roleId: string; roleName: string; firstNodeLabel: string; nodeCount: number }>();
  for (const node of previewWorkflow.value.nodes) {
    if (node.type !== "role" || !node.roleId) continue;
    const roleId = String(node.roleId);
    const role = orch.roles.find((item) => item.id === node.roleId) ?? null;
    const nodeLabel = String(node.label ?? "").trim() || role?.name || roleId;
    const existing = grouped.get(roleId);
    if (existing) {
      existing.nodeCount += 1;
      continue;
    }
    grouped.set(roleId, {
      roleId,
      roleName: role?.name ?? nodeLabel,
      firstNodeLabel: nodeLabel,
      nodeCount: 1,
    });
  }
  return Array.from(grouped.values(), (row) => ({
    roleId: row.roleId,
    roleName: row.roleName,
    nodeLabel: row.nodeCount > 1 ? `${row.firstNodeLabel} 等 ${row.nodeCount} 个节点` : row.firstNodeLabel,
  }));
});
const skippableNodeRows = computed(() => {
  if (executionTargetType.value !== "workflow" || !previewWorkflow.value) return [] as Array<{ nodeId: string; label: string; typeLabel: string }>;
  return previewWorkflow.value.nodes
    .filter((node) => node.type !== "start" && node.type !== "end")
    .map((node) => ({
      nodeId: String(node.id ?? "").trim(),
      label: String(node.label ?? "").trim() || String(node.id ?? "").trim(),
      typeLabel: workflowNodeTypeLabel(node.type),
    }))
    .filter((row) => row.nodeId);
});
const skippedNodeIdSet = computed(() => new Set(skippedNodeDrafts.value.map((nodeId) => String(nodeId ?? "").trim()).filter(Boolean)));
const skippedNodeCount = computed(() => skippableNodeRows.value.filter((row) => skippedNodeIdSet.value.has(row.nodeId)).length);
const skipNodePlanSummary = computed(() =>
  skippedNodeCount.value > 0 ? `已跳过 ${skippedNodeCount.value} 个节点` : "不跳过节点",
);
const forceCodexBlockedRoles = computed(() => resolveExecutionStrategyBlockedRoles("codex"));
const forceClaudeBlockedRoles = computed(() => resolveExecutionStrategyBlockedRoles("claude"));
const executionWorkflowSelectionKey = computed(() => [
  executionTargetType.value,
  workflowId.value,
  roleId.value,
  executionWorkflowRoles.value.map((item) => item.roleId).join("|"),
].join("::"));
const assigneePlanSelectionKey = computed(() => [
  executionTargetType.value,
  workflowId.value,
  workflowRunMode.value,
  skippedNodeDrafts.value.join("|"),
  previewWorkflow.value?.nodes
    .filter((node) => node.type === "role" && node.roleId)
    .map((node) => `${String(node.id ?? "")}:${String(node.roleId)}`)
    .join("|") ?? "",
].join("::"));
const showWorkflowRunModeSelector = computed(() =>
  Boolean(sharedWorkspaceId.value && executionTargetType.value === "workflow" && selectedWorkflow.value),
);
const executionEngineOptions = computed<Array<{
  value: OrchestrationExecutionEngineStrategy;
  label: string;
  disabled?: boolean;
}>>(() => [
  { value: "follow-role", label: "跟随角色定义" },
  { value: "force-codex", label: "使用 Codex", disabled: forceCodexBlockedRoles.value.length > 0 },
  { value: "force-claude", label: "使用 Claude Code", disabled: forceClaudeBlockedRoles.value.length > 0 },
  { value: "smart-planning", label: "根据需求智能规划（预留）", disabled: true },
]);
const executionEngineStrategyHint = computed(() => {
  if (executionEngineStrategy.value === "force-codex" && forceCodexBlockedRoles.value.length > 0) {
    return `当前流程仍有角色未启用 Codex：${forceCodexBlockedRoles.value.join("、")}`;
  }
  if (executionEngineStrategy.value === "force-claude" && forceClaudeBlockedRoles.value.length > 0) {
    return `当前流程仍有角色未启用 Claude：${forceClaudeBlockedRoles.value.join("、")}`;
  }
  return null;
});
const hasRoleExecutionOverrides = computed(() =>
  Object.entries(roleExecutionOverrideDrafts.value).some(([roleId, draft]) =>
    executionWorkflowRoles.value.some((row) => row.roleId === roleId) && draft.enabled,
  ),
);
// 概要条统计：在弹框入口直接显示「已启用覆盖 / 角色总数」
const enabledRoleOverrideCount = computed(() =>
  executionWorkflowRoles.value.reduce((count, row) => (
    roleExecutionOverrideDrafts.value[row.roleId]?.enabled ? count + 1 : count
  ), 0),
);
const roleOverrideBatchRoleIds = computed(() => executionWorkflowRoles.value.map((row) => row.roleId));
const roleOverrideBatchTargets = computed<RoleExecutionOverrideBatchTarget[]>(() => {
  const targets: RoleExecutionOverrideBatchTarget[] = [];
  for (const row of executionWorkflowRoles.value) {
    const role = orch.roles.find((item) => String(item.id) === row.roleId);
    if (role) targets.push({ roleId: row.roleId, executionConfig: role.executionConfig });
  }
  return targets;
});
const roleOverrideBatchMissingRoleNames = computed(() => (
  executionWorkflowRoles.value
    .filter((row) => !orch.roles.some((role) => String(role.id) === row.roleId))
    .map((row) => row.roleName)
));
const roleOverrideBatchEngineOptions = computed(() => (
  listCommonRoleExecutionEngines(roleOverrideBatchTargets.value)
    .map((engine) => ({ value: engine, label: engine === "codex" ? "Codex" : "Claude Code" }))
));
const roleOverrideBatchModelOptionGroups = computed(() => modelOptionGroupsForDraft(roleOverrideBatchDraft.value));
const roleOverrideBatchEffortOptions = computed(() => effortOptionsForDraft(roleOverrideBatchDraft.value));
const roleOverrideBatchUnavailableMessage = computed(() => {
  if (roleOverrideBatchMissingRoleNames.value.length > 0) {
    return `当前流程缺少角色定义，不能批量设置：${roleOverrideBatchMissingRoleNames.value.join("、")}`;
  }
  if (roleOverrideBatchTargets.value.length === 0) return "当前流程没有可批量设置的角色";
  if (roleOverrideBatchEngineOptions.value.length === 0) return "当前角色没有共同启用的执行引擎，请保留逐角色配置";
  return null;
});
const roleNameById = computed<Record<string, string>>(() =>
  Object.fromEntries(
    orch.roles
      .map((role) => [String(role.id), String(role.name ?? "").trim()] as const)
      .filter((entry) => entry[0] && entry[1]),
  ),
);
const sharedWorkspaceId = computed(() => parseSharedWorkspaceSelectionId(String(props.workspaceId ?? "")));
const activeSharedMembers = computed<SharedWorkspaceMemberItem[]>(() => {
  const id = sharedWorkspaceId.value;
  if (!id) return [];
  return (sharedWorkspaces.membersByWorkspaceId[id] ?? []).filter((member) => member.status === "active");
});
const activeSharedMemberOptions = computed(() =>
  activeSharedMembers.value.map((member) => ({
    userId: String(member.userId ?? "").trim(),
    label: formatSharedMemberLabel(member),
    // 搜索匹配范围扩展到姓名 + 邮箱 + userId，避免只显示姓名时无法用邮箱搜到
    searchKey: [member.displayName, member.email, member.userId]
      .map((field) => String(field ?? "").trim())
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  })).filter((item) => item.userId),
);
const collaborativeAssigneeRows = computed(() => {
  if (!sharedWorkspaceId.value || executionTargetType.value !== "workflow" || workflowRunMode.value !== "collaborative" || !selectedWorkflow.value) return [];
  return selectedWorkflow.value.nodes
    .filter((node) => node.type === "role" && !skippedNodeIdSet.value.has(String(node.id ?? "").trim()))
    .map((node) => ({
      nodeId: node.id,
      label: node.label || node.id,
      roleName: node.roleId ? roleNameById.value[String(node.roleId)] ?? "" : "",
    }));
});
const needsAssigneeRunPlan = computed(() => collaborativeAssigneeRows.value.length > 0);
const collaborativeAssigneeTemplates = computed(() => {
  const targetWorkflowId = String(selectedWorkflow.value?.id ?? "");
  if (!targetWorkflowId) return [] as AssigneeTemplate[];
  return orch.assigneeTemplates
    .filter((template) => String(template.workflowId) === targetWorkflowId && template.status !== "archived")
    .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
});
const selectedAssigneeTemplate = computed(() =>
  collaborativeAssigneeTemplates.value.find((template) => template.id === assigneeTemplateId.value) ?? null,
);
const selectedAssigneeTemplateReady = computed(() => selectedAssigneeTemplate.value?.status === "published");
const assignedNodeCount = computed(() =>
  collaborativeAssigneeRows.value.filter((row) => (nodeAssigneeDrafts.value[row.nodeId]?.length ?? 0) > 0).length,
);
/** a-select 候选项格式：直接喂 :options，避免重复渲染 11 份相同 <option>。 */
const memberSelectOptions = computed(() =>
  activeSharedMemberOptions.value.map((member) => ({
    label: member.label,
    value: member.userId,
    searchKey: member.searchKey,
  })),
);

/** a-select 多选搜索过滤：按 searchKey（姓名/邮箱/userId 拼接）匹配，支持任一字段命中。 */
function filterMemberOption(input: string, option: { searchKey?: string; label?: string }): boolean {
  const keyword = String(input ?? "").trim().toLowerCase();
  if (!keyword) return true;
  const haystack = option.searchKey ?? String(option.label ?? "").toLowerCase();
  return haystack.includes(keyword);
}
/** 当前用户是否在共享成员候选中，决定"全部分配给我"是否可用。 */
const hasCurrentUserCandidate = computed(() => {
  const currentUserId = String(config.userSummary?.userId ?? "").trim();
  if (!currentUserId) return false;
  return activeSharedMemberOptions.value.some((member) => member.userId === currentUserId);
});
/** 当前节点处理人草稿是否相对所选模板有改动，用于显示"·已修改"和高亮保存。 */
const assigneeDraftDirty = computed(() => {
  const template = selectedAssigneeTemplate.value;
  if (!template) return false;
  for (const row of collaborativeAssigneeRows.value) {
    const draft = [...(nodeAssigneeDrafts.value[row.nodeId] ?? [])]
      .map((u) => String(u ?? "").trim()).filter(Boolean).sort();
    const original = [...(template.nodeAssigneeUserIdsByNodeId[row.nodeId] ?? [])]
      .map((u) => String(u ?? "").trim()).filter(Boolean).sort();
    if (draft.length !== original.length) return true;
    for (let i = 0; i < draft.length; i++) if (draft[i] !== original[i]) return true;
  }
  return false;
});
const assigneePlanReady = computed(() =>
  !needsAssigneeRunPlan.value || (selectedAssigneeTemplateReady.value && assignedNodeCount.value === collaborativeAssigneeRows.value.length),
);
const assigneePlanSummary = computed(() => {
  if (!needsAssigneeRunPlan.value) return "无需处理人计划";
  if (assigneePlanReady.value) return selectedAssigneeTemplate.value ? `已选择 ${selectedAssigneeTemplate.value.name}` : "已配置本次处理人";
  if (!assigneeTemplateId.value) return "待选择模板";
  if (!selectedAssigneeTemplateReady.value) return "模板未发布";
  return "待补齐处理人";
});

/** 展示共享成员处理人候选，优先使用姓名，缺省显示邮箱或用户 ID。 */
function formatSharedMemberLabel(member: SharedWorkspaceMemberItem): string {
  return member.displayName || member.email || member.userId;
}

/** 同步协作运行节点处理人草稿；未选模板时新节点默认分配给当前用户以降低启动成本。 */
function syncAssigneeDrafts(): void {
  const currentUserId = String(config.userSummary?.userId ?? "").trim();
  const activeUserIds = new Set(activeSharedMemberOptions.value.map((member) => member.userId));
  const defaultAssignee = currentUserId && activeUserIds.has(currentUserId) ? [currentUserId] : [];
  const shouldFillDefault = !assigneeTemplateId.value;
  const next: Record<string, string[]> = {};
  for (const row of collaborativeAssigneeRows.value) {
    const existing = nodeAssigneeDrafts.value[row.nodeId] ?? defaultAssignee;
    next[row.nodeId] = existing.filter((userId) => activeUserIds.has(userId));
    if (next[row.nodeId].length === 0 && shouldFillDefault) next[row.nodeId] = [...defaultAssignee];
  }
  nodeAssigneeDrafts.value = next;
}

/** 把模板节点处理人复制到本次运行草稿；失效成员会被过滤并要求用户补齐。 */
function applyAssigneeTemplate(template: AssigneeTemplate): void {
  const activeUserIds = new Set(activeSharedMemberOptions.value.map((member) => member.userId));
  const next: Record<string, string[]> = {};
  for (const row of collaborativeAssigneeRows.value) {
    next[row.nodeId] = (template.nodeAssigneeUserIdsByNodeId[row.nodeId] ?? [])
      .map((userId) => String(userId ?? "").trim())
      .filter((userId) => userId && activeUserIds.has(userId));
  }
  nodeAssigneeDrafts.value = next;
  assigneeTemplateNameDraft.value = template.name;
}

/** 处理模板下拉切换，选择后立即作为本次运行计划基线。 */
function onAssigneeTemplateChanged(): void {
  markPlannerDraftEdited();
  const template = selectedAssigneeTemplate.value;
  if (template) {
    applyAssigneeTemplate(template);
    return;
  }
  assigneeTemplateNameDraft.value = "";
  syncAssigneeDrafts();
}

/** 收集当前节点处理人草稿，返回启动和模板保存共用的严格映射。 */
function collectNodeAssigneeDrafts(): Record<string, string[]> {
  const nodeAssigneeUserIdsByNodeId: Record<string, string[]> = {};
  for (const row of collaborativeAssigneeRows.value) {
    const userIds = Array.from(new Set((nodeAssigneeDrafts.value[row.nodeId] ?? []).map((item) => String(item ?? "").trim()).filter(Boolean)));
    if (userIds.length > 0) nodeAssigneeUserIdsByNodeId[row.nodeId] = userIds;
  }
  return nodeAssigneeUserIdsByNodeId;
}

/** 收集启动跳过节点草稿，只保留当前 workflow 仍可跳过的节点。 */
function collectSkippedNodeDrafts(): string[] {
  const allowedNodeIds = new Set(skippableNodeRows.value.map((row) => row.nodeId));
  return normalizeOrchestrationRunPlanSkippedNodeIds(skippedNodeDrafts.value)
    .filter((nodeId) => allowedNodeIds.has(nodeId));
}

/** 同步跳过节点草稿，避免切换流程后保留失效节点 ID。 */
function syncSkippedNodeDrafts(): void {
  skippedNodeDrafts.value = collectSkippedNodeDrafts();
}

/** 勾选或取消单个启动跳过节点，输入来自原生 checkbox。 */
function setSkippedNodeDraft(nodeId: string, checked: boolean): void {
  markPlannerDraftEdited();
  const current = new Set(collectSkippedNodeDrafts());
  if (checked) current.add(nodeId);
  else current.delete(nodeId);
  skippedNodeDrafts.value = Array.from(current);
}

/** 打开启动跳过节点弹框前先清理失效草稿。 */
function openSkipNodeModal(): void {
  syncSkippedNodeDrafts();
  skipNodeModalOpen.value = true;
}

/** 清空所有启动跳过节点草稿。 */
function clearSkippedNodeDrafts(): void {
  markPlannerDraftEdited();
  skippedNodeDrafts.value = [];
}

/** 读取节点处理人草稿，保证多选框始终绑定数组值。 */
function getNodeAssigneeDraft(nodeId: string): string[] {
  return nodeAssigneeDrafts.value[nodeId] ?? [];
}

/** a-select 多选 v-model 直接给数组，统一去空白与去重。 */
function setNodeAssigneeDraftValue(nodeId: string, value: string[] | undefined): void {
  markPlannerDraftEdited();
  const next = Array.isArray(value)
    ? Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)))
    : [];
  nodeAssigneeDrafts.value = { ...nodeAssigneeDrafts.value, [nodeId]: next };
}

/** 批量分配：把当前用户写入所有节点；前置已确认当前用户是有效候选。 */
function assignAllNodesToCurrentUser(): void {
  const currentUserId = String(config.userSummary?.userId ?? "").trim();
  if (!currentUserId) return;
  markPlannerDraftEdited();
  const next: Record<string, string[]> = {};
  for (const row of collaborativeAssigneeRows.value) next[row.nodeId] = [currentUserId];
  nodeAssigneeDrafts.value = next;
}

/** 按当前模板重置节点处理人草稿，丢弃本次未保存修改。 */
function resetAssigneeDraftsToTemplate(): void {
  const template = selectedAssigneeTemplate.value;
  if (template) {
    markPlannerDraftEdited();
    applyAssigneeTemplate(template);
  }
}

/** 清空所有节点处理人草稿；用户需要后续重新分配才能启动。 */
function clearAllNodeAssignees(): void {
  markPlannerDraftEdited();
  const next: Record<string, string[]> = {};
  for (const row of collaborativeAssigneeRows.value) next[row.nodeId] = [];
  nodeAssigneeDrafts.value = next;
}

/** 展开"另存为新模板"输入面板，预填一个建议名称便于一次按 Enter 完成。 */
function openSaveAsTemplateDialog(): void {
  const suggestion = selectedAssigneeTemplate.value?.name
    ? `${selectedAssigneeTemplate.value.name} 副本`
    : "默认协作模板";
  if (!assigneeTemplateNameDraft.value.trim()) assigneeTemplateNameDraft.value = suggestion;
  assigneeSaveAsOpen.value = true;
}

/** 确认另存为新模板：保存成功后自动收起输入面板。 */
async function confirmSaveAsNewTemplate(): Promise<void> {
  await saveAssigneeTemplate(true);
  if (!assigneeTemplateSaving.value) assigneeSaveAsOpen.value = false;
}

/** 构造启动接口使用的运行计划，包含启动跳过节点和可选协作处理人。 */
function buildRunPlanForStart(): OrchestrationRunPlan | null {
  if (executionTargetType.value !== "workflow" || !selectedWorkflow.value) return null;
  const skippedNodeIds = collectSkippedNodeDrafts();
  if (!sharedWorkspaceId.value || workflowRunMode.value !== "collaborative") return { runMode: "independent", skippedNodeIds };
  return {
    runMode: "collaborative",
    skippedNodeIds,
    assigneeTemplateId: assigneeTemplateId.value || null,
    nodeAssigneeUserIdsByNodeId: collectNodeAssigneeDrafts(),
    profilePrecheckResults: null,
  };
}

/** 构造需求侧保存的运行计划草稿；跳过节点和协作草稿都会随需求保存。 */
function buildRunPlanForSave(): OrchestrationRunPlan | null {
  if (executionTargetType.value !== "workflow") return null;
  const skippedNodeIds = collectSkippedNodeDrafts();
  if (!sharedWorkspaceId.value || workflowRunMode.value !== "collaborative") return { runMode: "independent", skippedNodeIds };
  return {
    runMode: "collaborative",
    skippedNodeIds,
    assigneeTemplateId: assigneeTemplateId.value || null,
    nodeAssigneeUserIdsByNodeId: collectNodeAssigneeDrafts(),
    profilePrecheckResults: null,
  };
}

/** 构造需求侧执行配置草稿；保存后不会启动实例。 */
function buildExecutionPlanDraftForSave(): TaskIntakeExecutionPlan {
  const targetType = executionTargetType.value === "role" ? "role" : "workflow";
  return {
    targetType,
    workflowId: targetType === "workflow" ? (String(workflowId.value ?? "").trim() as WorkflowId) || null : null,
    roleId: targetType === "role" ? (String(roleId.value ?? "").trim() as RoleId) || null : null,
    executionEngineStrategy: executionEngineStrategy.value,
    roleExecutionOverrides: buildRoleExecutionOverridesForStart(),
    runPlan: buildRunPlanForSave(),
    updatedAt: Date.now(),
  };
}

/** 把保存过的执行配置恢复到面板草稿；缺省仍按最新 proposal / 可用资产兜底。 */
async function applyExecutionPlanFromIntake(intake: TaskIntake | null): Promise<void> {
  const plan = intake?.executionPlan ?? null;
  const applySeq = ++executionPlanApplySeq;
  applyingSavedExecutionPlan.value = true;
  try {
    if (!plan) {
      executionEngineStrategy.value = "follow-role";
      workflowRunMode.value = "independent";
      resetExecutionTargetSelection();
      resetRoleExecutionOverrideDrafts();
      assigneeTemplateId.value = undefined;
      assigneeTemplateNameDraft.value = "";
      nodeAssigneeDrafts.value = {};
      skippedNodeDrafts.value = [];
      await nextTick();
      return;
    }
    const targetType = plan.targetType === "role" ? "role" : "workflow";
    executionTargetType.value = targetType;
    workflowId.value = targetType === "workflow" ? String(plan.workflowId ?? "").trim() : "";
    roleId.value = targetType === "role" ? String(plan.roleId ?? "").trim() : "";
    executionEngineStrategy.value = plan.executionEngineStrategy ?? "follow-role";
    workflowRunMode.value = normalizeOrchestrationRunMode(plan.runPlan?.runMode);
    skippedNodeDrafts.value = normalizeOrchestrationRunPlanSkippedNodeIds(plan.runPlan?.skippedNodeIds);
    assigneeTemplateId.value = String(plan.runPlan?.assigneeTemplateId ?? "").trim() || undefined;
    assigneeTemplateNameDraft.value = "";
    nodeAssigneeDrafts.value = workflowRunMode.value === "collaborative"
      ? normalizeOrchestrationRunPlanAssignees(plan.runPlan?.nodeAssigneeUserIdsByNodeId)
      : {};
    roleExecutionOverrideDrafts.value = {};
    syncRoleExecutionOverrideDrafts();
    applySavedRoleExecutionOverrides(plan.roleExecutionOverrides);
    resetRoleOverrideBatchDraft();
    await nextTick();
    syncSkippedNodeDrafts();
  } finally {
    if (applySeq === executionPlanApplySeq) applyingSavedExecutionPlan.value = false;
  }

  void refreshAssigneeTemplatesForCurrentWorkflow().catch((error) => {
    message.error(error instanceof Error ? error.message : "加载处理人模板失败");
  });
}

/** 把已保存的角色覆盖转换回 UI 草稿；失效角色留到启动校验提示。 */
function applySavedRoleExecutionOverrides(overrides: TaskIntakeExecutionPlan["roleExecutionOverrides"]): void {
  if (!overrides) return;
  const activeRoleIds = new Set(executionWorkflowRoles.value.map((row) => row.roleId));
  const next = { ...roleExecutionOverrideDrafts.value };
  for (const [roleId, override] of Object.entries(overrides)) {
    if (!activeRoleIds.has(roleId)) continue;
    const base = next[roleId];
    if (!base) continue;
    const engine = override?.engine === "claude" || override?.engine === "codex" ? override.engine : base.engine;
    const hasEffort = Boolean(override && Object.prototype.hasOwnProperty.call(override, "effort"));
    const hasServiceTier = Boolean(override && Object.prototype.hasOwnProperty.call(override, "serviceTier"));
    next[roleId] = {
      enabled: true,
      engine,
      model: String(override?.model ?? base.model ?? "").trim(),
      effort: hasEffort ? String(override?.effort ?? "").trim() : String(base.effort ?? "").trim(),
      autoCompactPct: parseSavedDraftNumber(override?.autoCompactPct, base.autoCompactPct),
      serviceTier: hasServiceTier ? (override?.serviceTier === "fast" ? "fast" : null) : base.serviceTier,
    };
  }
  roleExecutionOverrideDrafts.value = next;
}

/** 解析已保存的可选数值；非法历史值不进入 UI 草稿。 */
function parseSavedDraftNumber(value: unknown, fallback: number | null): number | null {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

/** 拉取当前流程模板的处理人模板。 */
async function refreshAssigneeTemplatesForCurrentWorkflow(): Promise<void> {
  if (!selectedIntake.value || !isOrchestrationViewActive()) return;
  if (!needsAssigneeRunPlan.value || !selectedWorkflow.value) return;
  const workflow = selectedWorkflow.value;
  const key = `${String(props.workspaceId)}::${String(workflow.id)}`;
  if (lastHydratedAssigneeTemplateKey === key) return;
  if (assigneeTemplateHydrationInFlight && assigneeTemplateHydrationInFlightKey === key) {
    return await assigneeTemplateHydrationInFlight;
  }
  const requestSeq = ++assigneeTemplateHydrationRequestSeq;
  const hydration = orch.refreshAssigneeTemplates(ctx.value, props.workspaceId, workflow.id).then(() => {
    if (
      requestSeq === assigneeTemplateHydrationRequestSeq
      && selectedWorkflow.value?.id === workflow.id
      && isOrchestrationViewActive()
    ) {
      lastHydratedAssigneeTemplateKey = key;
    }
  });
  assigneeTemplateHydrationInFlight = hydration;
  assigneeTemplateHydrationInFlightKey = key;
  try {
    await hydration;
  } finally {
    if (assigneeTemplateHydrationInFlight === hydration) {
      assigneeTemplateHydrationInFlight = null;
      assigneeTemplateHydrationInFlightKey = null;
    }
  }
}

/** 打开本次协作处理人配置弹窗，并确保共享成员候选已加载。 */
async function openAssigneePlanModal(): Promise<void> {
  if (!selectedIntake.value || !isOrchestrationViewActive()) return;
  const id = sharedWorkspaceId.value;
  try {
    if (id && !sharedWorkspaces.membersByWorkspaceId[id]?.length) await ensureSharedMembersLoaded(id);
    await refreshAssigneeTemplatesForCurrentWorkflow();
  } catch (error) {
    console.error("[TaskIntakePanel] assignee plan hydration failed", {
      ...errorDiagnosticContext(error, "ORCH_ASSIGNEE_PLAN_HYDRATION_FAILED"),
      workspaceId: String(props.workspaceId),
      intakeId: String(selectedIntake.value.id),
      sharedWorkspaceId: id,
      workflowId: String(selectedWorkflow.value?.id ?? ""),
    });
    message.error(error instanceof Error ? error.message : "加载协作处理人配置失败");
    return;
  }
  if (!assigneeTemplateId.value && collaborativeAssigneeTemplates.value.length > 0) {
    const firstTemplate = collaborativeAssigneeTemplates.value.find((template) => template.status === "published")
      ?? collaborativeAssigneeTemplates.value[0]!;
    assigneeTemplateId.value = firstTemplate.id;
    applyAssigneeTemplate(firstTemplate);
  }
  syncAssigneeDrafts();
  markPlannerDraftEdited();
  assigneeSaveAsOpen.value = false;
  assigneePlanModalOpen.value = true;
}

/** 保存当前节点处理人为模板；更新当前模板或另存为新模板由调用方决定。 */
async function saveAssigneeTemplate(createNew: boolean): Promise<void> {
  if (!selectedWorkflow.value || !needsAssigneeRunPlan.value) return;
  // 更新当前模板时复用模板原名，避免顶部一直常驻一个低频输入框；另存时才需要用户填名
  const name = createNew
    ? assigneeTemplateNameDraft.value.trim()
    : (selectedAssigneeTemplate.value?.name ?? "").trim();
  if (!name) {
    message.error(createNew ? "请填写新模板名称" : "未找到当前模板名称");
    return;
  }
  if (assignedNodeCount.value !== collaborativeAssigneeRows.value.length) {
    message.error("请先补齐每个角色节点的处理人");
    return;
  }
  const nodeAssigneeUserIdsByNodeId = collectNodeAssigneeDrafts();
  assigneeTemplateSaving.value = true;
  try {
    const saved = await orch.saveAssigneeTemplate(ctx.value, props.workspaceId, {
      id: createNew ? null : assigneeTemplateId.value || null,
      workspaceId: props.workspaceId,
      workflowId: selectedWorkflow.value.id,
      name,
      status: "published",
      nodeAssigneeUserIdsByNodeId,
    });
    assigneeTemplateId.value = saved.id;
    assigneeTemplateNameDraft.value = saved.name;
    applyAssigneeTemplate(saved);
    message.success(createNew ? "处理人模板已创建" : "处理人模板已更新");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存处理人模板失败");
  } finally {
    assigneeTemplateSaving.value = false;
  }
}

/** 计算角色在当前执行策略下的默认执行配置，用于流程级覆盖的初始值。 */
function resolveBaseRoleExecutionDraft(role: RoleDefinition): RoleExecutionOverrideDraft {
  const config = resolveCatalogRoleExecutionConfigForStrategy(
    role.executionConfig,
    executionEngineStrategy.value,
    engineModels,
    role.executionConfig.preferredEngine,
  );
  return {
    enabled: false,
    engine: config.engine,
    model: config.model,
    effort: config.effort,
    autoCompactPct: config.autoCompactPct ?? null,
    // 默认值即角色自身配置（内置 Loop 角色为 fast）；草稿未改动时不写回 override。
    serviceTier: config.serviceTier ?? null,
  };
}

/** 同步当前流程角色对应的覆盖草稿；已启用覆盖的角色保留用户输入。 */
function syncRoleExecutionOverrideDrafts(): void {
  const next: Record<string, RoleExecutionOverrideDraft> = {};
  for (const row of executionWorkflowRoles.value) {
    const role = orch.roles.find((item) => item.id === row.roleId);
    if (!role) continue;
    const existing = roleExecutionOverrideDrafts.value[row.roleId];
    next[row.roleId] = existing?.enabled ? existing : resolveBaseRoleExecutionDraft(role);
  }
  roleExecutionOverrideDrafts.value = next;
}

/** 重置本次流程级角色覆盖草稿，避免重跑弹窗生命周期之间串值。 */
function resetRoleExecutionOverrideDrafts(): void {
  roleExecutionOverrideDrafts.value = {};
  syncRoleExecutionOverrideDrafts();
  resetRoleOverrideBatchDraft();
}

/** 用首个目标角色的当前有效草稿初始化批量草稿。 */
function resetRoleOverrideBatchDraft(requestedEngine?: EngineType): void {
  const availableEngines = roleOverrideBatchEngineOptions.value.map((option) => option.value);
  const source = roleOverrideBatchTargets.value[0] ?? null;
  const sourceDraft = source ? roleExecutionOverrideDrafts.value[source.roleId] ?? null : null;
  const sourceConfig = source
    ? resolveCatalogRoleExecutionConfigForStrategy(
        source.executionConfig,
        executionEngineStrategy.value,
        engineModels,
        source.executionConfig.preferredEngine,
      )
    : null;
  const sourceEngine = sourceDraft?.engine ?? sourceConfig?.engine;
  const engine = requestedEngine && availableEngines.includes(requestedEngine)
    ? requestedEngine
    : sourceEngine && availableEngines.includes(sourceEngine)
      ? sourceEngine
      : availableEngines[0] ?? "codex";
  if (!source) {
    roleOverrideBatchDraft.value = { engine, model: "", effort: "", autoCompactPct: null };
    return;
  }
  if (sourceDraft?.engine === engine) {
    roleOverrideBatchDraft.value = {
      engine,
      model: sourceDraft.model,
      effort: sourceDraft.effort,
      autoCompactPct: sourceDraft.autoCompactPct,
    };
    return;
  }
  const config = sourceConfig?.engine === engine
    ? sourceConfig
    : resolveCatalogRoleExecutionConfigForEngine(
        source.executionConfig,
        engine,
        engineModels(engine),
        source.executionConfig.preferredEngine,
      );
  roleOverrideBatchDraft.value = {
    engine,
    model: config.model,
    effort: config.effort,
    autoCompactPct: config.autoCompactPct ?? null,
  };
}

/** 确保打开弹框时批量草稿仍适用于当前唯一角色集合。 */
function ensureRoleOverrideBatchDraft(): void {
  const current = roleOverrideBatchDraft.value;
  if (roleOverrideBatchEngineOptions.value.some((option) => option.value === current.engine) && current.model.trim()) return;
  resetRoleOverrideBatchDraft(current.engine);
}

/** 切换批量引擎后按首个目标角色重置模型相关字段。 */
function onRoleOverrideBatchEngineChanged(): void {
  resetRoleOverrideBatchDraft(roleOverrideBatchDraft.value.engine);
}

/** 切换批量模型后同步目录中的默认思考强度。 */
function onRoleOverrideBatchModelChanged(): void {
  syncRoleOverrideModelDefaults(roleOverrideBatchDraft.value);
}

/** 校验批量草稿与公共引擎边界，避免生成部分兼容的角色覆盖。 */
function validateRoleOverrideBatchDraft(): string | null {
  if (roleOverrideBatchUnavailableMessage.value) return roleOverrideBatchUnavailableMessage.value;
  const draft = roleOverrideBatchDraft.value;
  if (!roleOverrideBatchEngineOptions.value.some((option) => option.value === draft.engine)) {
    return "请选择全部角色共同启用的执行引擎";
  }
  const models = engineModels(draft.engine);
  if (!models.length) return `${draft.engine === "codex" ? "Codex" : "Claude Code"} 模型目录尚未加载或没有可用模型`;
  const modelId = String(draft.model ?? "").trim();
  if (!modelId) return "请选择批量应用的模型";
  if (!models.some((model) => model.id === modelId)) return `模型「${modelId}」已从模型目录移除，请重新选择`;
  const effort = String(draft.effort ?? "").trim();
  if (effort && !roleOverrideBatchEffortOptions.value.some((option) => option.value === effort)) {
    return `模型「${draft.model}」不支持思考强度「${effort}」`;
  }
  const autoCompactPct = parseDraftOptionalNumber(draft.autoCompactPct);
  if (autoCompactPct != null && (!Number.isFinite(autoCompactPct) || autoCompactPct < 50 || autoCompactPct > 99)) {
    return "自动压缩比例应在 50-99 之间";
  }
  return null;
}

/** 将公共草稿应用到当前流程全部唯一角色，实际保存仍由外层执行配置入口负责。 */
function applyRoleOverrideBatchToAll(): void {
  const issue = validateRoleOverrideBatchDraft();
  if (issue) {
    message.error(issue);
    return;
  }
  roleExecutionOverrideDrafts.value = applyRoleExecutionOverrideBatch(
    roleExecutionOverrideDrafts.value,
    roleOverrideBatchRoleIds.value,
    roleOverrideBatchDraft.value,
  );
  markPlannerDraftEdited();
  message.success(`已应用到 ${roleOverrideBatchRoleIds.value.length} 个角色草稿，保存执行配置或立即执行后生效`);
}

/** 关闭当前流程全部唯一角色的本次覆盖，恢复跟随角色定义。 */
function disableAllRoleExecutionOverrides(): void {
  roleExecutionOverrideDrafts.value = disableRoleExecutionOverrideBatch(
    roleExecutionOverrideDrafts.value,
    roleOverrideBatchRoleIds.value,
  );
  markPlannerDraftEdited();
  message.success("已恢复全部角色跟随定义，保存执行配置或立即执行后生效");
}

/** 切换某个角色的覆盖引擎，并把模型/思考强度重置为该引擎下的角色默认值。 */
function setRoleOverrideEngine(roleId: string, engine: EngineType): void {
  const role = orch.roles.find((item) => item.id === roleId);
  if (!role) return;
  markPlannerDraftEdited();
  const config = resolveCatalogRoleExecutionConfigForEngine(
    role.executionConfig,
    engine,
    engineModels(engine),
    role.executionConfig.preferredEngine,
  );
  roleExecutionOverrideDrafts.value[roleId] = {
    enabled: roleExecutionOverrideDrafts.value[roleId]?.enabled ?? true,
    engine,
    model: config.model,
    effort: config.effort,
    autoCompactPct: config.autoCompactPct ?? null,
  };
}

/** 构造启动实例时提交的角色执行覆盖；未启用覆盖的角色不传。 */
function buildRoleExecutionOverridesForStart(): Record<string, OrchestrationRoleExecutionOverride> | null {
  const overrides: Record<string, OrchestrationRoleExecutionOverride> = {};
  const activeRoleIds = new Set(executionWorkflowRoles.value.map((row) => row.roleId));
  for (const [roleId, draft] of Object.entries(roleExecutionOverrideDrafts.value)) {
    if (!activeRoleIds.has(roleId)) continue;
    if (!draft.enabled) continue;
    const override: OrchestrationRoleExecutionOverride = {
      engine: draft.engine,
      model: String(draft.model ?? "").trim() || null,
      effort: String(draft.effort ?? "").trim() || null,
    };
    const autoCompactPct = parseDraftOptionalNumber(draft.autoCompactPct);
    if (autoCompactPct != null) {
      override.autoCompactPct = Math.round(autoCompactPct);
    }
    // 透传服务档位：显式 null 表示关闭角色默认的 Fast，不能被一次往返保存抹掉。
    if (draft.serviceTier !== undefined) override.serviceTier = draft.serviceTier === "fast" ? "fast" : null;
    overrides[roleId] = override;
  }
  return Object.keys(overrides).length ? overrides : null;
}

/** 校验已启用的流程级角色覆盖，提前阻止无效启动请求。 */
function validateRoleExecutionOverrideDrafts(): string | null {
  const activeRoleIds = new Set(executionWorkflowRoles.value.map((row) => row.roleId));
  for (const [roleId, draft] of Object.entries(roleExecutionOverrideDrafts.value)) {
    if (!activeRoleIds.has(roleId)) continue;
    if (!draft.enabled) continue;
    const roleName = roleNameById.value[roleId] ?? roleId;
    const role = orch.roles.find((item) => item.id === roleId);
    if (!role) return `当前流程中的角色不存在：${roleName}`;
    if (!isRoleExecutionEngineEnabled(role.executionConfig, draft.engine, role.executionConfig.preferredEngine)) {
      return `「${roleName}」未启用 ${draft.engine === "codex" ? "Codex" : "Claude Code"}，不能作为本次角色覆盖引擎`;
    }
    const models = engineModels(draft.engine);
    if (!models.length) return `${draft.engine === "codex" ? "Codex" : "Claude Code"} 模型目录尚未加载或没有可用模型`;
    const modelId = String(draft.model ?? "").trim();
    if (!modelId) return `请先选择「${roleName}」的模型`;
    const model = models.find((item) => item.id === modelId) ?? null;
    if (!model) return `「${roleName}」的模型「${modelId}」已从模型目录移除，请重新选择`;
    const effort = String(draft.effort ?? "").trim();
    if (effort && !(model.supportedReasoningEfforts ?? []).some((item) => item.reasoningEffort === effort)) {
      return `「${roleName}」的模型「${modelId}」不支持思考强度「${effort}」`;
    }
    const autoCompactPct = parseDraftOptionalNumber(draft.autoCompactPct);
    if (autoCompactPct != null) {
      if (!Number.isFinite(autoCompactPct) || autoCompactPct < 50 || autoCompactPct > 99) {
        return `「${roleName}」的自动压缩比例应在 50-99 之间`;
      }
    }
  }
  return null;
}

/** 校验本次实际会执行的角色配置，阻止 auto 或历史自定义配置回退到静态模型。 */
function validateExecutionModelCatalog(): string | null {
  for (const row of executionWorkflowRoles.value) {
    const role = orch.roles.find((item) => String(item.id) === row.roleId) ?? null;
    if (!role) continue;
    const override = roleExecutionOverrideDrafts.value[row.roleId];
    let engine: EngineType;
    let modelId: string;
    let effort: string;
    try {
      if (override?.enabled) {
        engine = override.engine;
        modelId = String(override.model ?? "").trim();
        effort = String(override.effort ?? "").trim();
      } else {
        const resolved = resolveCatalogRoleExecutionConfigForStrategy(
          role.executionConfig,
          executionEngineStrategy.value,
          engineModels,
          role.executionConfig.preferredEngine,
        );
        engine = resolved.engine;
        modelId = String(resolved.model ?? "").trim();
        effort = String(resolved.effort ?? "").trim();
      }
    } catch (error) {
      return error instanceof Error ? error.message : `无法解析「${row.roleName}」的执行配置`;
    }
    const models = engineModels(engine);
    const engineLabel = engine === "codex" ? "Codex" : "Claude Code";
    if (!models.length) return `${engineLabel} 模型目录尚未加载或没有可用模型`;
    if (!modelId) return `请先选择「${row.roleName}」的模型`;
    const model = models.find((item) => item.id === modelId) ?? null;
    if (!model) return `「${row.roleName}」的模型「${modelId}」已从模型目录移除，请重新选择`;
    if (effort && !(model.supportedReasoningEfforts ?? []).some((item) => item.reasoningEffort === effort)) {
      return `「${row.roleName}」的模型「${modelId}」不支持思考强度「${effort}」`;
    }
  }
  return null;
}

/** 表单数值允许留空；非空时必须能解析为有限数值。 */
function parseDraftOptionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : Number.NaN;
}

/** 当前引擎可选模型，按供应商分组并包含当前值兜底。 */
function modelOptionGroupsForDraft(draft: Pick<RoleExecutionOverrideDraft, "engine" | "model">): ModelSelectOptionGroup[] {
  return buildModelSelectOptionGroups(engineModels(draft.engine), draft.model);
}

/** 当前模型可选思考强度；空数组表示启动时不发送 effort。 */
function effortOptionsForDraft(draft: Pick<RoleExecutionOverrideDraft, "engine" | "model">): Array<{ value: string; label: string }> {
  const model = engineModels(draft.engine).find((item) => item.id === draft.model) ?? null;
  return (model?.supportedReasoningEfforts ?? []).map((effort) => ({
    value: effort.reasoningEffort,
    label: effort.reasoningEffort,
  }));
}

/** 角色覆盖模型变更时同步默认思考强度。 */
function onRoleOverrideModelChanged(roleId: string): void {
  const draft = roleExecutionOverrideDrafts.value[roleId];
  if (!draft) return;
  markPlannerDraftEdited();
  syncRoleOverrideModelDefaults(draft);
}

/** 把模型目录默认值写回覆盖草稿；目录缺失时显式清空 effort。 */
function syncRoleOverrideModelDefaults(draft: Pick<RoleExecutionOverrideDraft, "engine" | "model" | "effort">): void {
  const model = engineModels(draft.engine).find((item) => item.id === draft.model) ?? null;
  draft.effort = model?.defaultReasoningEffort ?? "";
}

/** 返回角色覆盖可用的引擎选项，仅包含该角色已启用的引擎。 */
function roleOverrideEngineOptions(roleId: string): Array<{ value: EngineType; label: string }> {
  const role = orch.roles.find((item) => item.id === roleId);
  if (!role) return [];
  return (["codex", "claude"] as EngineType[])
    .filter((engine) => isRoleExecutionEngineEnabled(role.executionConfig, engine, role.executionConfig.preferredEngine))
    .map((engine) => ({ value: engine, label: engine === "codex" ? "Codex" : "Claude Code" }));
}

const selectedMonitorInstanceId = computed(() => {
  const selectedId = String(orch.selectedInstanceId ?? "").trim();
  if (selectedId && relatedInstances.value.some((instance) => instance.id === selectedId)) {
    return selectedId as OrchestrationId;
  }
  return (relatedInstances.value[0]?.id ?? null) as OrchestrationId | null;
});
const selectedMonitorInstance = computed(() =>
  relatedInstances.value.find((instance) => instance.id === selectedMonitorInstanceId.value)
  ?? relatedInstances.value[0]
  ?? null,
);
const selectedMonitorInstanceDetail = computed(() =>
  orch.selectedInstance?.id === selectedMonitorInstanceId.value ? orch.selectedInstance : null,
);
const selectedMonitorReviewNode = computed(() => {
  const instance = selectedMonitorInstanceDetail.value;
  if (!instance) return null;
  if (instance.status === "completed" || instance.status === "failed" || instance.status === "cancelled") {
    return null;
  }
  for (const node of instance.workflowSnapshot.nodes ?? []) {
    const state = instance.nodeStates[node.id];
    if (!state) continue;
    if (state.status === "waiting-start" || state.status === "waiting-approval" || state.status === "waiting-feedback") {
      return { node, state };
    }
  }
  return null;
});
const selectedMonitorWorkbench = computed(() =>
  selectedMonitorReviewNode.value ? resolveNodeWorkbenchDescriptor(selectedMonitorReviewNode.value.state) : null,
);
const selectedMonitorReminderItems = computed(() => {
  const intakeId = String(selectedIntake.value?.id ?? "").trim();
  const instanceId = String(selectedMonitorInstanceId.value ?? "").trim();
  if (!intakeId || !instanceId) return [];
  return reminders.currentItems.filter((entry) =>
    entry.sourceType === "orchestration"
    && String(entry.workspaceId ?? "").trim() === String(props.workspaceId ?? "").trim()
    && String(entry.routeTarget.intakeId ?? "").trim() === intakeId
    && String(entry.routeTarget.instanceId ?? "").trim() === instanceId,
  );
});
const selectedMonitorPrimaryActionLabel = computed(() => {
  if (!selectedMonitorReviewNode.value) return null;
  const fallback = selectedMonitorReviewNode.value.state.status === "waiting-approval"
    ? "查看结果并审核"
    : selectedMonitorReviewNode.value.state.status === "waiting-start"
      ? "启动节点"
    : "查看结果并处理";
  const label = selectedMonitorWorkbench.value?.actionLabel ?? fallback;
  return label === "补充信息并继续" ? "补充并继续" : label;
});
const selectedMonitorPrimaryActionDisabledReason = computed(() =>
  selectedMonitorReviewNode.value && selectedIntakeReadOnly.value
    ? "这条共享需求只读，只能查看，不能推进节点。"
    : null,
);
const canCancelSelectedMonitorInstance = computed(() => isCancelableInstanceStatus(selectedMonitorInstance.value?.status));
const canCancelActiveInstance = computed(() => isCancelableInstanceStatus(activeInstance.value?.status));
const requirementMeta = computed(() => {
  if (!selectedIntake.value) return "";
  return `创建于 ${formatDetailTime(selectedIntake.value.createdAt)}，最近更新于 ${formatDetailTime(selectedIntake.value.updatedAt)}`;
});
const requirementSummaryCopy = computed(() => {
  const intake = selectedIntake.value;
  if (!intake) return "";
  const summary = requirementPreview(intake.goal, 138);
  return summary === "-" ? "这条需求还没有填写明确的需求描述。" : summary;
});
const requirementSummaryChips = computed(() => {
  const intake = selectedIntake.value;
  if (!intake) return [] as string[];
  const chips = [`节点审核: ${approvalModeLabel(intake.constraints?.nodeApprovalMode)}`];
  chips.push(intake.acceptanceCriteria?.length ? `验收 ${intake.acceptanceCriteria.length} 条` : "未写验收标准");
  return chips;
});
const latestMetricEvidenceRef = computed(() => [...(selectedIntake.value?.metricEvidenceRefs ?? [])]
  .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null);
const latestMetricReviewHistory = computed(() => latestMetricEvidenceRef.value?.kind === "orchestration_evaluation_cohort_pair"
  ? [...(latestMetricEvidenceRef.value.reviews ?? [])].sort((left, right) => right.evaluatedAt - left.evaluatedAt)
  : []);
const metricReviewAlreadySaved = computed(() => Boolean(metricReviewPreview.value
  && latestMetricReviewHistory.value.some((item) => item.evidenceFingerprint === metricReviewPreview.value!.evidenceFingerprint)));
const metricReviewUnavailableReason = computed(() => {
  const evidence = latestMetricEvidenceRef.value;
  if (evidence?.kind !== "orchestration_evaluation_cohort_pair" || metricReviewStatus.value !== "insufficient_evidence") return "";
  return !evidence.metricSchemaVersion || !evidence.metricDefinitionVersion || !evidence.comparabilityPolicy
    ? "创建时指标版本缺失，不能按当前口径重解释"
    : "";
});

/** Returns the selected side of a paired reference while preserving legacy single-cohort links. */
function metricEvidenceCohortKey(side: "baseline" | "candidate"): string | null {
  const evidence = latestMetricEvidenceRef.value;
  if (!evidence) return null;
  if (evidence.kind === "orchestration_evaluation_cohort_pair") return evidence[side].cohortKey;
  return evidence.cohortKey;
}

/** 从需求详情回到关联的评估实验，并保留冻结范围和 Cohort 定位。 */
function openLinkedMetricExperiment(side: "baseline" | "candidate" = "baseline"): void {
  if (metricReviewSaving.value) return;
  const evidence = latestMetricEvidenceRef.value;
  const cohortKey = metricEvidenceCohortKey(side);
  if (!evidence || !cohortKey) return;
  closeRequirementDetailModal();
  void router.push({ path: "/admin", query: {
    panel: "orchestration-metrics", om_tab: "experiments", om_scope: evidence.scopeKind,
    om_scope_id: evidence.scopeId ?? undefined, om_cohort: cohortKey,
  } });
}

/** 将创建改进需求时的 Cohort 结论转换为需求侧业务文案。 */
function metricEvidenceConclusionLabel(value: TaskIntakeMetricEvidenceConclusion): string {
  if (value === "improved") return "创建时检测到改善";
  if (value === "regressed") return "创建时检测到退化";
  if (value === "no_detectable_change") return "创建时未检测到差异";
  return "创建时不可比较";
}

/** Formats one frozen cohort identity without treating the target description as an identity. */
function metricEvidenceCohortLabel(cohort: TaskIntakeMetricCohortSnapshot): string {
  const shortIdentity = (value: string) => value.length > 10 ? `${value.slice(0, 10)}...` : value;
  return `Workflow ${shortIdentity(cohort.workflowSnapshotHash)} / 节点 ${cohort.nodeId} / Role ${shortIdentity(cohort.roleSnapshotHash)} / Prompt ${shortIdentity(cohort.promptDefinitionHash)} / ${cohort.engine}/${cohort.model || "未记录"}/${cohort.effort || "未记录"}`;
}

/** Maps the finite review state to concise business text. */
function metricReviewStatusLabel(status: TaskIntakeMetricReviewStatus | null): string {
  const labels: Record<TaskIntakeMetricReviewStatus, string> = {
    candidate_unbound: "待绑定候选", waiting_observation: "观察中", ready_to_evaluate: "可复评",
    insufficient_evidence: "证据不足", verified_improved: "已验证改善", not_improved: "未验证改善",
  };
  return status ? labels[status] : "未进入复评";
}

/** Maps one review state to an Ant Design status color. */
function metricReviewStatusColor(status: TaskIntakeMetricReviewStatus | null): string {
  if (status === "verified_improved") return "success";
  if (status === "not_improved" || status === "insufficient_evidence") return "warning";
  if (status === "ready_to_evaluate") return "processing";
  return "default";
}

/** Maps saved insufficiency codes without exposing internal identifiers. */
function metricReviewReasonLabel(reason: TaskIntakeMetricReviewReason): string {
  const labels: Record<TaskIntakeMetricReviewReason, string> = {
    metric_version_unavailable: "创建时指标版本缺失", metric_version_mismatch: "指标版本已变化",
    comparability_policy_mismatch: "比较策略已变化", baseline_cohort_missing: "基线 Cohort 缺失",
    candidate_cohort_missing: "候选 Cohort 缺失", cohort_identity_mismatch: "Cohort 身份不一致",
    baseline_sample_below_minimum: "基线样本不足", candidate_sample_below_minimum: "候选样本不足",
    baseline_evidence_incomplete: "基线覆盖不完整", candidate_evidence_incomplete: "候选覆盖不完整",
    baseline_interval_unavailable: "基线区间不可用", candidate_interval_unavailable: "候选区间不可用",
  };
  return labels[reason];
}

/** Formats one review rate without converting missing evidence to zero. */
function metricReviewRate(value: number | null): string {
  return value == null ? "不可用" : `${Math.round(value * 1000) / 10}%`;
}

/** Formats one cohort side from the immutable review snapshot. */
function metricReviewEvidenceLabel(side: TaskIntakeMetricReviewSnapshot["baseline"]): string {
  if (!side) return "Cohort 缺失";
  const summary = side.summary;
  const interval = summary.confidenceLow == null || summary.confidenceHigh == null
    ? "区间不可用"
    : `95% CI ${metricReviewRate(summary.confidenceLow)} - ${metricReviewRate(summary.confidenceHigh)}`;
  return `${summary.evaluatedCount} 个有效样本 / 覆盖 ${metricReviewRate(summary.coverageRate)} / 通过 ${metricReviewRate(summary.passRate)} / ${interval}`;
}

/** Reads both exact Cohorts and derives the current review state without writing Intake history. */
async function refreshMetricReview(): Promise<void> {
  const evidence = latestMetricEvidenceRef.value;
  const requestVersion = ++metricReviewRequestVersion;
  metricReviewPreview.value = null;
  metricReviewError.value = "";
  metricReviewLoading.value = false;
  if (!evidence) {
    metricReviewStatus.value = null;
    return;
  }
  metricReviewStatus.value = resolveTaskIntakeMetricReviewStatus(evidence, Date.now());
  if (evidence.kind !== "orchestration_evaluation_cohort_pair" || metricReviewStatus.value !== "ready_to_evaluate") return;
  metricReviewLoading.value = true;
  try {
    const [baselineResult, candidateResult] = await Promise.all([
      getOrchestrationMetricExperiments(ctx.value, buildTaskIntakeMetricReviewFilters(evidence, evidence.baseline.cohortKey)),
      getOrchestrationMetricExperiments(ctx.value, buildTaskIntakeMetricReviewFilters(evidence, evidence.candidate.cohortKey)),
    ]);
    if (requestVersion !== metricReviewRequestVersion) return;
    if (!baselineResult.ok) throw new Error(baselineResult.message || "基线复评证据加载失败");
    if (!candidateResult.ok) throw new Error(candidateResult.message || "候选复评证据加载失败");
    const preview = await createTaskIntakeMetricReviewSnapshot(evidence, baselineResult, candidateResult);
    if (requestVersion !== metricReviewRequestVersion) return;
    metricReviewPreview.value = preview;
    metricReviewStatus.value = resolveTaskIntakeMetricReviewStatus(evidence, Date.now(), preview);
  } catch (error) {
    if (requestVersion === metricReviewRequestVersion) {
      metricReviewError.value = error instanceof Error ? error.message : "复评证据加载失败";
    }
  } finally {
    if (requestVersion === metricReviewRequestVersion) metricReviewLoading.value = false;
  }
}

/** Appends one reviewed evidence snapshot while preserving all prior Intake fields and reviews. */
async function saveMetricReview(): Promise<void> {
  const intake = selectedIntake.value;
  const evidence = latestMetricEvidenceRef.value;
  const preview = metricReviewPreview.value;
  if (!intake || !preview || evidence?.kind !== "orchestration_evaluation_cohort_pair" || selectedIntakeReadOnly.value || metricReviewSaving.value) return;
  if (metricReviewAlreadySaved.value) {
    message.info("相同复评证据已保存");
    return;
  }
  const reviews = evidence.reviews ?? [];
  if (reviews.length >= 20) {
    message.error("复评历史已达到 20 条，请新建改进需求继续观察");
    return;
  }
  const updatedEvidence: TaskIntakeMetricCohortPairEvidenceRef = { ...evidence, reviews: [...reviews, preview] };
  const metricEvidenceRefs = (intake.metricEvidenceRefs ?? []).map((item) => item.kind === "orchestration_evaluation_cohort_pair"
    && item.createdAt === evidence.createdAt && item.baseline.cohortKey === evidence.baseline.cohortKey
    && item.candidate.cohortKey === evidence.candidate.cohortKey ? updatedEvidence : item);
  metricReviewSaving.value = true;
  try {
    await orch.saveIntake(ctx.value, props.workspaceId, {
      id: intake.id, triggerMode: intake.triggerMode, taskType: intake.taskType, title: getTaskIntakeTitle(intake), goal: intake.goal,
      background: intake.background ?? null, acceptanceCriteria: intake.acceptanceCriteria ?? null,
      workbenchItemRefs: intake.workbenchItemRefs ?? null, seedArtifactRefs: intake.seedArtifactRefs ?? null,
      metricEvidenceRefs, constraints: intake.constraints ?? null, executionPlan: intake.executionPlan ?? null,
      requester: intake.requester ?? { source: "ui" },
    });
    message.success("本次复评证据已保存");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "复评证据保存失败");
  } finally {
    metricReviewSaving.value = false;
  }
}
const selectedArtifactCount = computed(() =>
  selectedMonitorInstance.value?.runSummary.artifactCount ?? 0,
);
const requirementDetailModalWrapClassName = computed(() =>
  requirementDetailModalFullscreen.value
    ? "task-detail__requirement-modal-wrap task-detail__requirement-modal-wrap--fullscreen"
    : "task-detail__requirement-modal-wrap",
);
const requirementDetailModalStyle = computed(() => {
  const viewportHeight = Math.max(540, requirementDetailModalViewportHeight.value);
  const shellHeight = requirementDetailModalFullscreen.value
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
const requirementDetailModalBodyStyle = computed(() => {
  const viewportHeight = Math.max(540, requirementDetailModalViewportHeight.value);
  const bodyHeight = requirementDetailModalFullscreen.value
    ? Math.max(300, viewportHeight - 84)
    : Math.max(260, viewportHeight - 124);
  return {
    padding: "16px 18px",
    height: `${bodyHeight}px`,
    minHeight: `${bodyHeight}px`,
    maxHeight: `${bodyHeight}px`,
    overflow: "hidden",
  } as const;
});
const executeBlockedReason = computed(() => {
  if (!selectedIntake.value || !showRunComposer.value) return null;
  if (selectedIntakeReadOnly.value) return "这条共享需求只读，不能执行或重新执行。";
  if (activeInstance.value) {
    return `当前需求已有进行中的执行：${activeInstance.value.id}。请先处理当前执行，再重新发起新一轮执行。`;
  }
  if (executionTargetType.value === "workflow") {
    if (!workflowId.value) {
      return "必须先选择流程模板，系统会按您当前选中的模板冻结本次执行蓝图。";
    }
    if (!selectedWorkflow.value) {
      return "当前选中的流程模板不存在，请重新选择。";
    }
    if (!isSpecAssetAvailable(selectedWorkflow.value)) {
      return ENTERPRISE_LIMITED_MESSAGE;
    }
    if (!selectedWorkflow.value.nodes.some((node) => node.type === "role" && node.roleId)) {
      return "当前流程模板没有可执行角色节点，请先补齐模板定义。";
    }
    const overrideIssue = validateRoleExecutionOverrideDrafts();
    if (overrideIssue) return overrideIssue;
    const catalogIssue = validateExecutionModelCatalog();
    if (catalogIssue) return catalogIssue;
    if (workflowRunMode.value === "collaborative" && collaborativeAssigneeRows.value.length === 0) {
      return "协作运行至少保留一个角色节点，不能全部启动跳过。";
    }
    if (needsAssigneeRunPlan.value) {
      if (activeSharedMemberOptions.value.length === 0) return "共享成员列表尚未加载，暂不能启动协作运行。";
      if (!assigneeTemplateId.value) return "协作运行前必须选择或保存一套处理人模板。";
      if (!selectedAssigneeTemplateReady.value) return "协作运行前必须选择已发布的处理人模板。";
      if (!assigneePlanReady.value) return "协作运行前必须为每个角色节点选择处理人。";
    }
    return null;
  }
  if (!roleId.value) return "必须先选择一个角色，系统会按该角色自动包装成单节点执行蓝图。";
  if (!selectedRole.value) return "当前选中的角色不存在，请重新选择。";
  if (!isSpecAssetAvailable(selectedRole.value)) return ENTERPRISE_LIMITED_MESSAGE;
  const overrideIssue = validateRoleExecutionOverrideDrafts();
  if (overrideIssue) return overrideIssue;
  const catalogIssue = validateExecutionModelCatalog();
  if (catalogIssue) return catalogIssue;
  return null;
});
const executeButtonLabel = computed(() => hasExecutionHistory.value ? "立即重新执行" : "立即执行");
const canSaveExecutionPlan = computed(() =>
  Boolean(selectedIntake.value && showRunComposer.value && !selectedIntakeReadOnly.value && !executionPlanSaving.value),
);

/** 本地工作区不携带共享可见性筛选，避免沿用上一个共享工作区的列表偏好。 */
function resolvePlannerOnlyRelatedToMe(): boolean | null {
  return sharedWorkspaceId.value ? orch.intakeListOnlyRelatedToMe : null;
}

/** 用工作区和共享可见性标识 planner 数据，筛选变化后必须重新加载。 */
function buildPlannerDataHydrationKey(): string {
  const onlyRelatedToMe = resolvePlannerOnlyRelatedToMe();
  return `${String(props.workspaceId)}::${onlyRelatedToMe == null ? "all" : onlyRelatedToMe ? "mine" : "workspace"}`;
}

/** 只在明确 UI 编辑入口推进版本，资产水合导致的程序性草稿变化不计为用户编辑。 */
function markPlannerDraftEdited(): void {
  if (applyingSavedExecutionPlan.value) return;
  plannerDraftEditVersion += 1;
}

/** 切换需求时建立新的干净基线，旧需求的慢请求不能恢复到新需求。 */
function resetPlannerDraftBaseline(): void {
  plannerSelectionGeneration += 1;
  plannerDraftEditVersion += 1;
  plannerDraftCleanVersion = plannerDraftEditVersion;
}

type PlannerHydrationFence = {
  hydrationKey: string;
  intakeId: string;
  selectionGeneration: number;
  draftRevision: number;
};

/** 捕获 planner 请求开始时的选择和草稿版本。 */
function capturePlannerHydrationFence(hydrationKey: string): PlannerHydrationFence | null {
  const intakeId = String(selectedIntake.value?.id ?? "").trim();
  if (!intakeId) return null;
  return {
    hydrationKey,
    intakeId,
    selectionGeneration: plannerSelectionGeneration,
    draftRevision: plannerDraftEditVersion,
  };
}

/** 资产加载完成后只恢复一次当前需求计划，避免每次 KeepAlive 激活覆盖用户编辑。 */
async function applyHydratedExecutionPlanForSelectedIntake(
  hydrationKey: string,
  fence: PlannerHydrationFence | null,
): Promise<void> {
  const intake = selectedIntake.value;
  if (!intake || !fence) return;
  const applyKey = `${hydrationKey}::${String(intake.id)}`;
  if (plannerExecutionPlanAppliedKey === applyKey) return;
  const applyFence = {
    active: isOrchestrationViewActive() && plannerDraftEditVersion === plannerDraftCleanVersion,
    startHydrationKey: fence.hydrationKey,
    currentHydrationKey: buildPlannerDataHydrationKey(),
    startIntakeId: fence.intakeId,
    currentIntakeId: String(intake.id),
    startSelectionGeneration: fence.selectionGeneration,
    currentSelectionGeneration: plannerSelectionGeneration,
    startDraftRevision: fence.draftRevision,
    currentDraftRevision: plannerDraftEditVersion,
  };
  if (!shouldApplyHydratedPlannerDraft(applyFence)) return;
  // 先占用 key，避免多个等待同一 hydration 的调用并发二次恢复。
  plannerExecutionPlanAppliedKey = applyKey;
  try {
    const applied = await applyHydratedPlannerDraftIfCurrent(
      applyFence,
      () => applyExecutionPlanFromIntake(intake),
    );
    if (!applied && plannerExecutionPlanAppliedKey === applyKey) plannerExecutionPlanAppliedKey = null;
  } catch (error) {
    if (plannerExecutionPlanAppliedKey === applyKey) plannerExecutionPlanAppliedKey = null;
    throw error;
  }
}

/** 选择需求后读取目标 Client 的执行资产；不同缓存键串行复用在途请求。 */
async function ensurePlannerDataForSelectedIntake(): Promise<void> {
  while (selectedIntake.value && isOrchestrationViewActive()) {
    const workspaceId = props.workspaceId;
    const hydrationKey = buildPlannerDataHydrationKey();
    if (plannerDataHydratedKey === hydrationKey) {
      const hydrationFence = capturePlannerHydrationFence(hydrationKey);
      await Promise.all([
        orch.ensureAssetListLoaded(ctx.value, workspaceId, "role", "execution"),
        orch.ensureAssetListLoaded(ctx.value, workspaceId, "workflow", "execution"),
      ]);
      await applyHydratedExecutionPlanForSelectedIntake(hydrationKey, hydrationFence);
      return;
    }
    if (plannerDataHydrationInFlight) {
      const inFlightKey = plannerDataHydrationInFlightKey;
      try {
        await plannerDataHydrationInFlight;
      } catch (error) {
        if (inFlightKey === buildPlannerDataHydrationKey()) throw error;
        console.error("[TaskIntakePanel] stale planner hydration failed", {
          ...errorDiagnosticContext(error, "ORCH_PLANNER_STALE_HYDRATION_FAILED"),
          workspaceId: String(workspaceId),
          hydrationKey: inFlightKey,
        });
      }
      continue;
    }

    const onlyRelatedToMe = resolvePlannerOnlyRelatedToMe();
    const hydrationFence = capturePlannerHydrationFence(hydrationKey);
    const hydration = Promise.all([
      orch.refreshRoles(ctx.value, workspaceId, "execution"),
      orch.refreshWorkflows(ctx.value, workspaceId, "execution"),
      orch.refreshProposals(ctx.value, workspaceId, { onlyRelatedToMe }),
      orch.refreshInstances(ctx.value, workspaceId, { onlyRelatedToMe }),
    ]).then(() => undefined);
    plannerDataHydrationInFlight = hydration;
    plannerDataHydrationInFlightKey = hydrationKey;
    let hydrationStillCurrent = false;
    try {
      await hydration;
      hydrationStillCurrent = buildPlannerDataHydrationKey() === hydrationKey;
      if (hydrationStillCurrent) plannerDataHydratedKey = hydrationKey;
    } catch (error) {
      if (buildPlannerDataHydrationKey() === hydrationKey) throw error;
      console.error("[TaskIntakePanel] stale planner hydration failed", {
        ...errorDiagnosticContext(error, "ORCH_PLANNER_STALE_HYDRATION_FAILED"),
        workspaceId: String(workspaceId),
        hydrationKey,
      });
    } finally {
      if (plannerDataHydrationInFlight === hydration) {
        plannerDataHydrationInFlight = null;
        plannerDataHydrationInFlightKey = null;
      }
    }
    if (hydrationStillCurrent) {
      await applyHydratedExecutionPlanForSelectedIntake(hydrationKey, hydrationFence);
      return;
    }
  }
}

/** 调度 planner 数据加载，并在页面边界记录和展示失败。 */
function schedulePlannerDataHydration(): void {
  if (!selectedIntake.value || !isOrchestrationViewActive()) return;
  void ensurePlannerDataForSelectedIntake().catch((error) => {
    console.error("[TaskIntakePanel] planner hydration failed", {
      ...errorDiagnosticContext(error, "ORCH_PLANNER_HYDRATION_FAILED"),
      workspaceId: String(props.workspaceId),
      intakeId: String(selectedIntake.value?.id ?? ""),
    });
    message.error(error instanceof Error ? error.message : "加载需求执行配置失败");
  });
}

/** 加载共享成员并把业务失败转成含诊断字段的异常。 */
async function ensureSharedMembersLoaded(sharedId: string): Promise<void> {
  const existing = sharedMemberHydrationInFlight.get(sharedId);
  if (existing) return await existing;
  const hydration = (async () => {
    const result = await sharedWorkspaces.loadMembers(sharedId);
    if (result.ok) return;
    const raw = result as Record<string, any>;
    const error = new Error(String(raw.message ?? "").trim() || "加载共享成员失败") as Error & {
      code?: string;
      requestId?: string | null;
    };
    error.code = String(raw.code ?? "SHARED_MEMBERS_LOAD_FAILED").trim() || "SHARED_MEMBERS_LOAD_FAILED";
    error.requestId = String(raw.requestId ?? raw.request_id ?? "").trim() || null;
    throw error;
  })();
  sharedMemberHydrationInFlight.set(sharedId, hydration);
  try {
    await hydration;
  } finally {
    if (sharedMemberHydrationInFlight.get(sharedId) === hydration) sharedMemberHydrationInFlight.delete(sharedId);
  }
}

/** 仅在编排页激活且有选中需求时补齐成员候选。 */
function requestSharedMembersForSelectedIntake(sharedId: string): void {
  if (!selectedIntake.value || !isOrchestrationViewActive()) return;
  void ensureSharedMembersLoaded(sharedId).catch((error) => {
    console.error("[TaskIntakePanel] shared member hydration failed", {
      ...errorDiagnosticContext(error, "ORCH_SHARED_MEMBERS_HYDRATION_FAILED"),
      workspaceId: String(props.workspaceId),
      intakeId: String(selectedIntake.value?.id ?? ""),
      sharedWorkspaceId: sharedId,
    });
    message.error(error instanceof Error ? error.message : "加载共享成员失败");
  });
}

/** 按当前 planner 选择同步处理人草稿；隐藏态不推进 key，激活后再恢复。 */
function reconcileAssigneePlanSelection(): void {
  if (!selectedIntake.value || !isOrchestrationViewActive()) return;
  const selectionKey = assigneePlanSelectionKey.value;
  if (applyingSavedExecutionPlan.value) {
    lastAppliedAssigneeSelectionKey = selectionKey;
    return;
  }
  if (lastAppliedAssigneeSelectionKey === selectionKey) return;
  lastAppliedAssigneeSelectionKey = selectionKey;
  assigneeTemplateId.value = undefined;
  assigneeTemplateNameDraft.value = "";
  syncAssigneeDrafts();
  void refreshAssigneeTemplatesForCurrentWorkflow().catch((error) => {
    console.error("[TaskIntakePanel] assignee template hydration failed", {
      ...errorDiagnosticContext(error, "ORCH_ASSIGNEE_TEMPLATE_HYDRATION_FAILED"),
      workspaceId: String(props.workspaceId),
      intakeId: String(selectedIntake.value?.id ?? ""),
      workflowId: String(selectedWorkflow.value?.id ?? ""),
    });
    message.error(error instanceof Error ? error.message : "加载处理人模板失败");
  });
}

/** 成员列表变化时只清理失效处理人；同一成员签名再次激活不覆盖用户主动清空。 */
function reconcileSharedWorkspaceMembers(): void {
  if (!selectedIntake.value || !isOrchestrationViewActive()) return;
  const sharedId = sharedWorkspaceId.value;
  const memberKey = [
    sharedId ?? "local",
    ...activeSharedMembers.value.map((member) => String(member.userId ?? "").trim()).filter(Boolean).sort(),
  ].join("::");
  if (sharedId && !sharedWorkspaces.membersByWorkspaceId[sharedId]?.length) {
    requestSharedMembersForSelectedIntake(sharedId);
  }
  if (applyingSavedExecutionPlan.value) {
    lastReconciledSharedMembersKey = memberKey;
    return;
  }
  if (lastReconciledSharedMembersKey === memberKey) return;
  lastReconciledSharedMembersKey = memberKey;
  syncAssigneeDrafts();
}

watch(() => selectedIntake.value?.id, () => {
  resetPlannerDraftBaseline();
  lastAppliedAssigneeSelectionKey = null;
  lastReconciledSharedMembersKey = null;
  lastHydratedAssigneeTemplateKey = null;
  requirementDetailModalOpen.value = false;
  requirementDetailModalFullscreen.value = false;
  rerunComposerOpen.value = false;
  artifactModalOpen.value = false;
  artifactModalFullscreen.value = false;
  roleOverrideModalOpen.value = false;
  assigneePlanModalOpen.value = false;
  skipNodeModalOpen.value = false;
  executionEngineStrategy.value = "follow-role";
  workflowRunMode.value = "independent";
  plannerExecutionPlanAppliedKey = null;
  void applyExecutionPlanFromIntake(selectedIntake.value).catch((error) => {
    console.error("[TaskIntakePanel] execution plan restore failed", {
      ...errorDiagnosticContext(error, "ORCH_EXECUTION_PLAN_RESTORE_FAILED"),
      workspaceId: String(props.workspaceId),
      intakeId: String(selectedIntake.value?.id ?? ""),
    });
    message.error(error instanceof Error ? error.message : "恢复需求执行配置失败");
  });
  schedulePlannerDataHydration();
  if (editingIntakeId.value && editingIntakeId.value !== selectedIntake.value?.id) {
    editingIntakeId.value = null;
  }
}, { immediate: true });

watch(buildPlannerDataHydrationKey, () => {
  schedulePlannerDataHydration();
});

watch([previewWorkflow, forceCodexBlockedRoles, forceClaudeBlockedRoles], () => {
  if (executionEngineStrategy.value === "force-codex" && forceCodexBlockedRoles.value.length > 0) {
    executionEngineStrategy.value = "follow-role";
  }
  if (executionEngineStrategy.value === "force-claude" && forceClaudeBlockedRoles.value.length > 0) {
    executionEngineStrategy.value = "follow-role";
  }
}, { immediate: true });

watch(previewWorkflow, () => {
  if (applyingSavedExecutionPlan.value) return;
  syncSkippedNodeDrafts();
}, { immediate: true });

watch(executionWorkflowSelectionKey, () => {
  if (applyingSavedExecutionPlan.value) return;
  resetRoleExecutionOverrideDrafts();
}, { immediate: true });

watch([
  assigneePlanSelectionKey,
  executionMonitorViewActive,
  () => ui.mainView,
  () => selectedIntake.value?.id ?? "",
], reconcileAssigneePlanSelection, { immediate: true });

watch(() => [executionTargetType.value, workflowId.value] as const, () => {
  if (applyingSavedExecutionPlan.value) return;
  workflowRunMode.value = "independent";
  assigneePlanModalOpen.value = false;
  skipNodeModalOpen.value = false;
  skippedNodeDrafts.value = [];
}, { immediate: false });

watch(executionEngineStrategy, () => {
  if (applyingSavedExecutionPlan.value) return;
  syncRoleExecutionOverrideDrafts();
  resetRoleOverrideBatchDraft();
}, { immediate: true });

watch([
  sharedWorkspaceId,
  activeSharedMembers,
  executionMonitorViewActive,
  () => ui.mainView,
  () => selectedIntake.value?.id ?? "",
], reconcileSharedWorkspaceMembers, { immediate: true });

watch([
  relatedInstances,
  () => orch.selectedInstanceId,
  showExecutionMonitor,
  executionMonitorViewActive,
  () => ui.mainView,
], ([instances, currentId, monitorOpen]) => {
  if (!isOrchestrationViewActive()) return;
  if (!monitorOpen) return;
  const selectedId = String(currentId ?? "").trim();
  if (selectedId && instances.some((instance) => instance.id === selectedId)) return;
  const first = instances[0];
  orch.selectedInstanceId = (first?.id ?? null) as OrchestrationId | null;
  if (first) {
    void orch.loadInstance(ctx.value, props.workspaceId, first.id as OrchestrationId, { force: false }).catch((error) => {
      console.error("[TaskIntakePanel] automatic instance hydration failed", {
        ...errorDiagnosticContext(error, "ORCH_INSTANCE_AUTO_HYDRATION_FAILED"),
        workspaceId: String(props.workspaceId),
        intakeId: String(selectedIntake.value?.id ?? ""),
        instanceId: String(first.id),
      });
      message.error(error instanceof Error ? error.message : "加载执行实例失败");
    });
  }
}, { immediate: true });

watch(
  [
    showExecutionMonitor,
    selectedMonitorInstanceId,
    () => selectedMonitorInstance.value?.status ?? "",
    () => selectedMonitorInstance.value?.updatedAt ?? 0,
  ],
  () => {
    const nextKey = buildExecutionMonitorSyncKey();
    if (executionMonitorSyncBlockedKey && executionMonitorSyncBlockedKey !== nextKey) {
      executionMonitorSyncBlockedKey = null;
    }
    scheduleExecutionMonitorSync();
  },
  { immediate: true },
);

watch(
  () => [
    orch.pendingUiIntent?.id ?? 0,
    selectedIntake.value?.id ?? "",
    executionMonitorViewActive.value,
    ui.mainView,
  ] as const,
  async () => {
    if (!isOrchestrationViewActive()) return;
    const intent = orch.pendingUiIntent;
    if (!intent || String(selectedIntake.value?.id ?? "") !== String(intent.intakeId ?? "")) return;
    try {
      if (intent.kind === "open_metric_review") {
        openRequirementDetail();
        return;
      }
      if (intent.instanceId) {
        orch.selectedInstanceId = intent.instanceId;
        await orch.loadInstance(ctx.value, props.workspaceId, intent.instanceId, { force: false });
      }
      if (intent.kind === "open_primary_action") {
        await nextTick();
        openMonitorPrimaryNodeAction();
        return;
      }
      if (intent.kind === "open_artifacts") {
        await openArtifactModal();
        return;
      }
    } finally {
      orch.clearUiIntent(intent.id);
    }
  },
  { immediate: true },
);

watch(
  () => [
    showExecutionMonitor.value,
    selectedIntake.value?.id ?? "",
    selectedMonitorInstanceId.value ?? "",
    selectedMonitorReminderItems.value.map((item) => item.id).join("|"),
  ] as const,
  ([monitorOpen, intakeId, instanceId, reminderSignature]) => {
    if (!isOrchestrationViewActive() || !monitorOpen || !intakeId || !instanceId || !reminderSignature) return;
    void reminders.consumeItems(ctx.value, selectedMonitorReminderItems.value).catch((error) => {
      console.error("[TaskIntakePanel] reminder consumption failed", {
        ...errorDiagnosticContext(error, "ORCH_REMINDER_CONSUME_FAILED"),
        workspaceId: String(props.workspaceId),
        intakeId,
        instanceId,
      });
      message.error(error instanceof Error ? error.message : "更新需求提醒状态失败");
    });
  },
  { immediate: true },
);

watch(() => orch.intakeComposerOpen, (open) => {
  if (!open) return;
  editingIntakeId.value = null;
  resetForm();
}, { immediate: true });

onMounted(() => {
  syncRequirementDetailModalViewportHeight();
  window.addEventListener("resize", syncRequirementDetailModalViewportHeight);
  document.addEventListener("visibilitychange", handleExecutionMonitorVisibilityChange);
});

onActivated(() => {
  executionMonitorViewActive.value = true;
  executionMonitorSyncBlockedKey = null;
  schedulePlannerDataHydration();
  reconcileAssigneePlanSelection();
  reconcileSharedWorkspaceMembers();
  scheduleExecutionMonitorSync();
});

onDeactivated(() => {
  executionMonitorViewActive.value = false;
  clearExecutionMonitorSyncTimer();
});

onBeforeUnmount(() => {
  metricReviewRequestVersion += 1;
  window.removeEventListener("resize", syncRequirementDetailModalViewportHeight);
  document.removeEventListener("visibilitychange", handleExecutionMonitorVisibilityChange);
  clearExecutionMonitorSyncTimer();
});

watch(executionTargetType, (nextType) => {
  if (nextType === "workflow") {
    roleId.value = "";
    if (!workflowId.value) workflowId.value = resolveLatestProposalWorkflowId() || resolveFallbackWorkflowId();
    return;
  }
  workflowId.value = "";
}, { immediate: false });

/** 重置需求编辑表单。 */
function resetForm() {
  title.value = "";
  goal.value = "";
  acceptanceText.value = "";
  nodeApprovalMode.value = "auto";
}

/** 将需求记录回填到当前表单，不再回填历史背景字段。 */
function fillFormFromIntake(intake: NonNullable<typeof selectedIntake.value>) {
  title.value = getTaskIntakeTitle(intake);
  goal.value = intake.goal;
  acceptanceText.value = (intake.acceptanceCriteria ?? []).map((item) => item.text).join("\n");
  nodeApprovalMode.value = intake.constraints?.nodeApprovalMode === "manual" ? "manual" : "auto";
}

/** Opens the requirement editor unless a review save still owns the current detail session. */
function startEditRequirement() {
  if (!selectedIntake.value || metricReviewSaving.value) return;
  if (selectedIntakeReadOnly.value) {
    message.info("这条共享需求只读，不能编辑");
    return;
  }
  closeRequirementDetailModal();
  editingIntakeId.value = selectedIntake.value.id;
  orch.intakeComposerOpen = false;
  fillFormFromIntake(selectedIntake.value);
}

function openRequirementDetail() {
  if (!selectedIntake.value) return;
  requirementDetailModalFullscreen.value = false;
  syncRequirementDetailModalViewportHeight();
  requirementDetailModalOpen.value = true;
  void refreshMetricReview();
}

function toggleRequirementDetailModalFullscreen() {
  requirementDetailModalFullscreen.value = !requirementDetailModalFullscreen.value;
}

/** Closes the detail session only when no review save can still update its selection. */
function closeRequirementDetailModal() {
  if (metricReviewSaving.value) return;
  metricReviewRequestVersion += 1;
  metricReviewLoading.value = false;
  requirementDetailModalOpen.value = false;
  requirementDetailModalFullscreen.value = false;
}

/** 打开角色模型配置弹框，并确保批量草稿匹配当前流程角色。 */
function openRoleOverrideModal(): void {
  ensureRoleOverrideBatchDraft();
  roleOverrideModalOpen.value = true;
}

/** 关闭角色模型配置弹框；逐角色和批量草稿均保留当前编辑。 */
function closeRoleOverrideModal(): void {
  roleOverrideModalOpen.value = false;
}

function syncRequirementDetailModalViewportHeight() {
  if (typeof window === "undefined") return;
  requirementDetailModalViewportHeight.value = Math.max(480, Math.floor(window.innerHeight));
}

function cancelEditRequirement() {
  editingIntakeId.value = null;
  resetForm();
}

/** 关闭需求编辑弹窗；保存期间保留表单，避免旧请求回写新状态。 */
function closeRequirementModal() {
  if (requirementSaving.value) return;
  if (isEditMode.value) {
    cancelEditRequirement();
    return;
  }
  orch.intakeComposerOpen = false;
  resetForm();
}

function confirmDeleteRequirement() {
  const intake = selectedIntake.value;
  if (!intake) return;
  if (selectedIntakeReadOnly.value) {
    message.info("这条共享需求只读，不能删除");
    return;
  }
  const forceDeleteRunning = Boolean(activeInstance.value);
  Modal.confirm({
    title: "删除需求",
    content: forceDeleteRunning
      ? `需求「${getTaskIntakeTitle(intake)}」当前仍有进行中的执行。继续删除会先主动停止当前执行，再删除这条需求下的方案、执行记录、结果索引和关联会话，但不会自动回滚已写入工作区的代码或文档。`
      : `确定要删除需求「${getTaskIntakeTitle(intake)}」吗？会同时删除这条需求下的方案、执行记录、结果索引和关联会话，但不会自动回滚已写入工作区的代码或文档。`,
    okText: forceDeleteRunning ? "继续删除" : "删除",
    okType: "danger",
    cancelText: "取消",
    async onOk() {
      try {
        const res = await orch.removeIntake(ctx.value, props.workspaceId, intake.id, {
          forceDeleteRunning,
        });
        const cancelledCount = Number((res as { cancelledActiveInstanceCount?: number }).cancelledActiveInstanceCount ?? 0);
        if (cancelledCount > 0) {
          message.success(`需求已删除，并主动停止 ${cancelledCount} 个进行中的执行`);
          return;
        }
        message.success("需求已删除");
      } catch (error) {
        if (!forceDeleteRunning && error instanceof OrchIntakeDeleteConflictError) {
          confirmForceDeleteRequirement(intake.id, getTaskIntakeTitle(intake));
          return;
        }
        message.error(error instanceof Error ? error.message : "删除需求失败");
      }
    },
  });
}

function confirmForceDeleteRequirement(intakeId: IntakeId, title: string) {
  Modal.confirm({
    title: "继续删除需求",
    content: `需求「${title}」当前仍有进行中的执行。继续删除会先主动停止当前执行，再删除这条需求下的方案、执行记录、结果索引和关联会话，但不会自动回滚已写入工作区的代码或文档。`,
    okText: "继续删除",
    okType: "danger",
    cancelText: "取消",
    async onOk() {
      try {
        const res = await orch.removeIntake(ctx.value, props.workspaceId, intakeId, {
          forceDeleteRunning: true,
        });
        const cancelledCount = Number((res as { cancelledActiveInstanceCount?: number }).cancelledActiveInstanceCount ?? 0);
        if (cancelledCount > 0) {
          message.success(`需求已删除，并主动停止 ${cancelledCount} 个进行中的执行`);
          return;
        }
        message.success("需求已删除");
      } catch (error) {
        message.error(error instanceof Error ? error.message : "删除需求失败");
      }
    },
  });
}

/** 单次提交保存精简后的需求内容，并清空已废弃的背景字段。 */
async function saveRequirement() {
  if (requirementSaving.value || !canSubmit.value) return;
  requirementSaving.value = true;
  try {
    const baseIntake = selectedIntake.value;
    const wasEditing = isEditMode.value;
    const payload = {
      triggerMode: baseIntake?.triggerMode ?? "manual",
      taskType: baseIntake?.taskType ?? "unknown",
      title: title.value.trim(),
      goal: goal.value.trim(),
      background: null,
      acceptanceCriteria: createTaskAcceptanceCriteriaFromLines(splitLines(acceptanceText.value)),
      workbenchItemRefs: baseIntake?.workbenchItemRefs ?? null,
      seedArtifactRefs: baseIntake?.seedArtifactRefs ?? null,
      metricEvidenceRefs: baseIntake?.metricEvidenceRefs ?? null,
      constraints: {
        requireUserConfirmation: false,
        nodeApprovalMode: nodeApprovalMode.value,
      },
      executionPlan: baseIntake?.executionPlan ?? null,
      requester: baseIntake?.requester ?? { source: "ui" as const },
    };
    const intake = isEditMode.value && baseIntake
      ? await orch.saveIntake(ctx.value, props.workspaceId, { id: baseIntake.id, ...payload })
      : await orch.createIntake(ctx.value, props.workspaceId, payload);
    orch.selectedIntakeId = intake.id;
    orch.selectedIntakeSnapshot = intake;
    orch.intakeComposerOpen = false;
    editingIntakeId.value = null;
    message.success(wasEditing ? "需求已更新" : "需求已保存");
    resetForm();
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存需求失败");
  } finally {
    requirementSaving.value = false;
  }
}

/** 保存当前需求的执行配置草稿，不创建 proposal，也不启动流程实例。 */
async function saveExecutionPlan(options: { silent?: boolean } = {}): Promise<boolean> {
  if (!selectedIntake.value || selectedIntakeReadOnly.value || executionPlanSaving.value) return false;
  const baseIntake = selectedIntake.value;
  const savedEditVersion = plannerDraftEditVersion;
  executionPlanSaving.value = true;
  try {
    await orch.saveIntake(ctx.value, props.workspaceId, {
      id: baseIntake.id,
      triggerMode: baseIntake.triggerMode ?? "manual",
      taskType: baseIntake.taskType ?? "unknown",
      title: getTaskIntakeTitle(baseIntake),
      goal: baseIntake.goal,
      background: null,
      acceptanceCriteria: baseIntake.acceptanceCriteria ?? null,
      workbenchItemRefs: baseIntake.workbenchItemRefs ?? null,
      seedArtifactRefs: baseIntake.seedArtifactRefs ?? null,
      metricEvidenceRefs: baseIntake.metricEvidenceRefs ?? null,
      constraints: baseIntake.constraints ?? null,
      executionPlan: buildExecutionPlanDraftForSave(),
      requester: baseIntake.requester ?? { source: "ui" as const },
    });
    // 保存期间若用户继续编辑，不能把后续编辑误标为已保存。
    if (plannerDraftEditVersion === savedEditVersion) plannerDraftCleanVersion = savedEditVersion;
    if (!options.silent) message.success("执行配置已保存");
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存执行配置失败");
    return false;
  } finally {
    executionPlanSaving.value = false;
  }
}

async function executeRequirement() {
  if (!selectedIntake.value || activeInstance.value) return;
  if (selectedIntakeReadOnly.value) {
    message.info("这条共享需求只读，不能执行");
    return;
  }
  if (executeBlockedReason.value) {
    message.error(executeBlockedReason.value);
    return;
  }
  if (executionTargetType.value === "workflow" && !selectedWorkflow.value) return;
  if (executionTargetType.value === "role" && !selectedRole.value) return;
  try {
    const saved = await saveExecutionPlan({ silent: true });
    if (!saved) return;
    await orch.executeIntake(ctx.value, props.workspaceId, {
      intakeId: selectedIntake.value.id,
      workflowId: executionTargetType.value === "workflow" ? selectedWorkflow.value?.id ?? null : null,
      roleId: executionTargetType.value === "role" ? selectedRole.value?.id ?? null : null,
      executionEngineStrategy: executionEngineStrategy.value,
      roleExecutionOverrides: buildRoleExecutionOverridesForStart(),
      runPlan: buildRunPlanForStart(),
    });
    rerunComposerOpen.value = false;
    resetRoleExecutionOverrideDrafts();
    message.success(hasExecutionHistory.value ? "已创建新的执行记录" : "执行已启动");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "启动执行失败");
  }
}

function shouldPollExecutionMonitor(status: string | null | undefined): boolean {
  return status === "pending"
    || status === "running"
    || status === "result-submitted"
    || status === "finalizing"
    || status === "artifact-writing"
    || status === "gate-checking"
    || status === "waiting-start"
    || status === "waiting-approval"
    || status === "waiting-feedback";
}

function clearExecutionMonitorSyncTimer(): void {
  if (executionMonitorSyncTimer === null) return;
  window.clearTimeout(executionMonitorSyncTimer);
  executionMonitorSyncTimer = null;
}

/** 页面隐藏或 KeepAlive 停用时暂停执行监控轮询，恢复可见后再调度一次。 */
function handleExecutionMonitorVisibilityChange(): void {
  if (document.hidden) {
    clearExecutionMonitorSyncTimer();
    return;
  }
  executionMonitorSyncBlockedKey = null;
  scheduleExecutionMonitorSync();
}

/** KeepAlive 页面仍激活且主视图为编排时，才允许派生 planner 或实例请求。 */
function isOrchestrationViewActive(): boolean {
  return ui.mainView === "orchestration"
    && executionMonitorViewActive.value;
}

/** 只有编排视图仍激活且浏览器页面可见时，才允许发起执行监控兜底请求。 */
function canPollExecutionMonitor(): boolean {
  return isOrchestrationViewActive()
    && (typeof document === "undefined" || !document.hidden);
}

/** 用实例状态版本标识一次轮询；WebSocket 更新后会生成新 key 并解除失败停机。 */
function buildExecutionMonitorSyncKey(): string | null {
  const instance = selectedMonitorInstance.value;
  if (!instance) return null;
  return [
    String(props.workspaceId),
    String(instance.id),
    String(instance.status ?? ""),
    String(instance.updatedAt ?? 0),
  ].join("::");
}

/** 为当前运行中实例安排单次兜底同步，完成后再按状态决定是否续排。 */
function scheduleExecutionMonitorSync(): void {
  clearExecutionMonitorSyncTimer();
  if (typeof window === "undefined") return;
  if (!canPollExecutionMonitor()) return;
  const instanceId = selectedMonitorInstanceId.value;
  const status = selectedMonitorInstance.value?.status;
  if (!showExecutionMonitor.value || !instanceId || !shouldPollExecutionMonitor(status)) return;
  if (executionMonitorSyncBlockedKey === buildExecutionMonitorSyncKey()) return;
  executionMonitorSyncTimer = window.setTimeout(() => {
    executionMonitorSyncTimer = null;
    void syncExecutionMonitorFromServer(instanceId);
  }, EXECUTION_MONITOR_SYNC_INTERVAL_MS);
}

/** 拉取一次轻量运行态补丁；离开编排视图后不再继续派生详情请求。 */
async function syncExecutionMonitorFromServer(expectedInstanceId: OrchestrationId | null): Promise<void> {
  if (executionMonitorSyncInFlight) return;
  if (!canPollExecutionMonitor()) return;
  const instanceId = expectedInstanceId ?? selectedMonitorInstanceId.value;
  if (!showExecutionMonitor.value || !instanceId) return;
  const currentInstance = selectedMonitorInstance.value;
  if (!currentInstance || currentInstance.id !== instanceId || !shouldPollExecutionMonitor(currentInstance.status)) return;
  const currentStatus = currentInstance.status;
  const attemptKey = buildExecutionMonitorSyncKey();
  executionMonitorSyncInFlight = true;
  try {
    await orch.loadTrackedInstanceRuntimePatch(ctx.value, props.workspaceId, instanceId, { syncSelection: true });
    const nextId = selectedMonitorInstanceId.value;
    const nextInstance = selectedMonitorInstance.value;
    if (!canPollExecutionMonitor()) return;
    if (!nextId || !nextInstance || nextId !== instanceId) return;
    if (!shouldPollExecutionMonitor(nextInstance.status)) {
      if (currentStatus !== nextInstance.status) {
        await orch.ensureSelectedInstanceDetails(ctx.value, props.workspaceId, nextId, {
          force: true,
          allowNetworkHydration: isOrchestrationViewActive,
        });
      }
      return;
    }
  } catch (error) {
    executionMonitorSyncBlockedKey = attemptKey;
    console.error("[TaskIntakePanel] execution monitor sync failed", {
      ...errorDiagnosticContext(error, "ORCH_EXECUTION_MONITOR_SYNC_FAILED"),
      workspaceId: String(props.workspaceId),
      intakeId: String(selectedIntake.value?.id ?? ""),
      instanceId: String(instanceId),
    });
    message.error(error instanceof Error ? error.message : "执行状态同步失败，已暂停自动重试");
  } finally {
    executionMonitorSyncInFlight = false;
    scheduleExecutionMonitorSync();
  }
}

function splitLines(raw: string): string[] | null {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines : null;
}

/** 把流程节点类型转成启动跳过列表使用的短标签。 */
function workflowNodeTypeLabel(type: WorkflowDefinition["nodes"][number]["type"]): string {
  if (type === "role") return "角色";
  if (type === "condition") return "条件";
  if (type === "parallel-fork") return "分叉";
  if (type === "parallel-join") return "汇合";
  return type;
}

function approvalModeLabel(mode: "auto" | "manual" | null | undefined): string {
  return mode === "manual" ? "人工审核后继续" : "自动通过";
}

function requirementPreview(text: string | null | undefined, max = 110): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return "-";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** 打开当前执行记录，并优先恢复本地完整实例快照。 */
async function openActiveInstance() {
  if (!activeInstance.value) return;
  rerunComposerOpen.value = false;
  orch.selectedInstanceId = activeInstance.value.id as OrchestrationId;
  await orch.loadInstance(ctx.value, props.workspaceId, activeInstance.value.id as OrchestrationId, { force: false });
}

/** 切换监控实例；缓存命中时不重复拉取完整实例。 */
async function changeMonitorInstance(instanceId: string) {
  const nextId = String(instanceId ?? "").trim() as OrchestrationId;
  if (!nextId || nextId === selectedMonitorInstanceId.value) return;
  orch.selectedInstanceId = nextId;
  await orch.loadInstance(ctx.value, props.workspaceId, nextId, { force: false });
}

/** 打开产物弹窗，并按需补齐当前实例的详情目录。 */
async function openArtifactModal() {
  artifactModalFullscreen.value = false;
  artifactModalOpen.value = true;
  const instanceId = selectedMonitorInstanceId.value;
  if (!instanceId) return;
  orch.selectedInstanceId = instanceId;
  try {
    await orch.loadInstance(ctx.value, props.workspaceId, instanceId, {
      force: false,
      loadDetails: true,
      allowNetworkHydration: isOrchestrationViewActive,
    });
  } catch (error) {
    console.error("[TaskIntakePanel] artifact detail hydration failed", {
      ...errorDiagnosticContext(error, "ORCH_ARTIFACT_DETAILS_HYDRATION_FAILED"),
      workspaceId: String(props.workspaceId),
      intakeId: String(selectedIntake.value?.id ?? ""),
      instanceId: String(instanceId),
    });
    message.error(error instanceof Error ? error.message : "加载产出物失败");
  }
}

function toggleArtifactModalFullscreen() {
  artifactModalFullscreen.value = !artifactModalFullscreen.value;
}

function closeArtifactModal() {
  artifactModalOpen.value = false;
  artifactModalFullscreen.value = false;
}

function openMonitorEvents() {
  monitorRef.value?.openEventsModal();
}

function openMonitorPrimaryNodeAction() {
  if (selectedMonitorPrimaryActionDisabledReason.value) {
    message.info(selectedMonitorPrimaryActionDisabledReason.value);
    return;
  }
  monitorRef.value?.openPrimaryNodeAction();
}

/** 暂停所选实例，失败在当前操作边界记录并显示原始原因。 */
async function pauseMonitorInstance() {
  const instanceId = selectedMonitorInstanceId.value;
  if (!instanceId) return;
  if (selectedIntakeReadOnly.value) {
    message.info("这条共享需求只读，不能暂停流程");
    return;
  }
  try {
    await orch.pauseInstance(ctx.value, props.workspaceId, instanceId);
    message.success("编排已暂停");
  } catch (error) {
    console.error("[TaskIntakePanel] pause instance failed", {
      ...errorDiagnosticContext(error, "ORCH_INTAKE_PAUSE_FAILED"),
      workspaceId: String(props.workspaceId),
      instanceId: String(instanceId),
      rootCause: error instanceof Error ? error.message : String(error),
    });
    message.error(error instanceof Error ? error.message : "暂停失败");
  }
}

async function resumeMonitorInstance() {
  const instanceId = selectedMonitorInstanceId.value;
  if (!instanceId) return;
  if (selectedIntakeReadOnly.value) {
    message.info("这条共享需求只读，不能恢复流程");
    return;
  }
  try {
    await orch.resumeInstance(ctx.value, props.workspaceId, instanceId);
    message.success("编排已恢复");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "恢复失败");
  }
}

async function cancelMonitorInstance() {
  const instance = selectedMonitorInstance.value;
  if (!instance) return;
  if (selectedIntakeReadOnly.value) {
    message.info("这条共享需求只读，不能终止流程");
    return;
  }
  confirmTerminateInstance(instance.id as OrchestrationId, instance.intakeTitle || (selectedIntake.value ? getTaskIntakeTitle(selectedIntake.value) : "当前需求"));
}

async function cancelActiveInstance() {
  const instance = activeInstance.value;
  if (!instance) return;
  if (selectedIntakeReadOnly.value) {
    message.info("这条共享需求只读，不能终止流程");
    return;
  }
  confirmTerminateInstance(instance.id as OrchestrationId, instance.intakeTitle || (selectedIntake.value ? getTaskIntakeTitle(selectedIntake.value) : "当前需求"), {
    afterSuccess: () => {
      rerunComposerOpen.value = false;
    },
  });
}

function startRerun() {
  if (selectedIntakeReadOnly.value) {
    message.info("这条共享需求只读，不能重新执行");
    return;
  }
  rerunComposerOpen.value = true;
  void applyExecutionPlanFromIntake(selectedIntake.value);
}

function cancelRerun() {
  rerunComposerOpen.value = false;
  resetExecutionTargetSelection();
  executionEngineStrategy.value = "follow-role";
  resetRoleExecutionOverrideDrafts();
}

/** 解析最新方案里的普通流程，避免正式需求详情误回落到单角色。 */
function resolveLatestProposalWorkflowId(): string {
  const latestWorkflowId = String(latestProposal.value?.draftWorkflow?.id ?? "").trim();
  if (
    latestWorkflowId
    && !parseStandaloneRoleWorkflowId(latestWorkflowId)
    && orch.workflows.some((workflow) => workflow.id === latestWorkflowId && isSpecAssetAvailable(workflow))
  ) {
    return latestWorkflowId;
  }
  return "";
}

/** 解析最新方案里的单角色包装流程，只在 proposal 明确为单角色时使用。 */
function resolveLatestProposalRoleId(): string {
  const latestRoleId = parseStandaloneRoleWorkflowId(latestProposal.value?.draftWorkflow?.id ?? null);
  if (latestRoleId && orch.roles.some((role) => role.id === latestRoleId && isSpecAssetAvailable(role))) {
    return latestRoleId;
  }
  return "";
}

/** 选择可用的普通流程兜底，供没有历史方案时初始化执行面板。 */
function resolveFallbackWorkflowId(): string {
  return orch.workflows.find((workflow) => isSpecAssetAvailable(workflow))?.id ?? "";
}

/** 选择可用的角色兜底，供历史方案是单角色或缺少流程时使用。 */
function resolveFallbackRoleId(): string {
  return orch.roles.find((role) => isSpecAssetAvailable(role))?.id ?? "";
}

/** 按正式 proposal 优先恢复执行方式，防止流程方案被角色兜底覆盖。 */
function resetExecutionTargetSelection() {
  const latestWorkflowId = resolveLatestProposalWorkflowId();
  if (latestWorkflowId) {
    executionTargetType.value = "workflow";
    workflowId.value = latestWorkflowId;
    roleId.value = "";
    return;
  }
  const latestRoleId = resolveLatestProposalRoleId();
  if (latestRoleId) {
    executionTargetType.value = "role";
    roleId.value = latestRoleId;
    workflowId.value = "";
    return;
  }
  const fallbackWorkflowId = resolveFallbackWorkflowId();
  if (fallbackWorkflowId) {
    executionTargetType.value = "workflow";
    workflowId.value = fallbackWorkflowId;
    roleId.value = "";
    return;
  }
  const fallbackRoleId = resolveFallbackRoleId();
  if (fallbackRoleId) {
    executionTargetType.value = "role";
    roleId.value = fallbackRoleId;
    workflowId.value = "";
    return;
  }
  executionTargetType.value = "workflow";
  workflowId.value = "";
  roleId.value = "";
}

function resolveExecutionStrategyBlockedRoles(targetEngine: "claude" | "codex"): string[] {
  if (!previewWorkflow.value) return [];
  return executionWorkflowRoles.value
    .filter((entry) => {
      const role = orch.roles.find((item) => item.id === entry.roleId) ?? null;
      if (!role) return true;
      return !isRoleExecutionEngineEnabled(role.executionConfig, targetEngine, role.executionConfig.preferredEngine);
    })
    .map((entry) => entry.roleName || entry.nodeLabel || entry.roleId);
}

/** 服务端若把规格资产标记为不可用，这里统一按只读可见处理。 */
function isSpecAssetAvailable(asset: unknown): boolean {
  const availability = (asset as { availability?: { available?: boolean } | null } | null | undefined)?.availability;
  return availability?.available !== false;
}

function formatShortTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDetailTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const requirementDetailHelp = {
  title: "需求内容说明",
  lines: [
    "当前执行会把“需求描述 / 验收标准”统一带入节点任务。",
    "标题主要用于需求识别、左侧列表展示和结果目录命名，不直接替代任务正文。",
    "如果某个节点需要额外说明或覆写输入，可继续在流程模板节点里配置；单角色模式则沿用角色自身定义。",
  ],
} as const;

const executionPlanHelp = computed(() => ({
  title: showExecutionMonitor.value ? "执行工作区说明" : "执行方案说明",
  lines: showExecutionMonitor.value
    ? [
        "这里直接展示这条需求当前选中的真实执行过程，保留节点详情、会话、审核、反馈、事件和人工处理等完整能力。",
        "如果同一条需求执行过多次，可在执行工作区顶部切换执行记录；“产出物”弹框会跟随当前选中的这次执行。",
        "如需重新选择流程模板或单角色并发起新一轮执行，点击右上角“重新执行”。",
      ]
    : showRunComposer.value
    ? [
        "这里同时负责三件事：选择本次要执行的运行方式（流程 / 单角色）、选择本次实例的执行引擎，以及预览这次准备冻结下来的执行结构。",
        "点击“保存执行配置”只更新这条需求的默认执行草稿；点击“立即执行”才会创建 proposal 并启动流程实例。",
        "模型、思考强度和自动压缩比例可通过本次角色配置覆盖，上下文窗口自动使用模型最大容量；未覆盖的访问模式和重试次数沿用角色自身配置。",
        "执行引擎只对未在“角色模型配置”里单独覆盖的角色生效；角色覆盖只冻结到本次执行实例，不回写角色模板。",
        "如果当前已有进行中的执行，需要先查看或结束当前执行，才能重新发起新一轮执行。",
      ]
    : [
        "这里展示本次准备执行的蓝图。",
        "如需按其他流程模板或角色重新执行，点击右上角“重新执行”后重新选择执行方式，再发起新一轮执行。",
      ],
}) as const);

const executionSummaryChips = computed(() => {
  if (showExecutionMonitor.value) {
    return [`已执行 ${relatedInstances.value.length} 次`];
  }

  const chips = [`节点审核: ${approvalModeLabel(selectedIntake.value?.constraints?.nodeApprovalMode)}`];
  if (hasExecutionHistory.value) {
    chips.push(`已执行 ${relatedInstances.value.length} 次`);
  }
  if (previewWorkflow.value) {
    chips.push(executionTargetType.value === "role" ? "执行方式: 单角色" : `流程类型: ${previewWorkflow.value.family ?? "auto"}`);
    chips.push(`${previewWorkflow.value.nodes.length} 个节点`);
    chips.push(`${previewWorkflow.value.edges.length} 条连线`);
    if (skippedNodeCount.value > 0) chips.push(`启动跳过 ${skippedNodeCount.value} 个`);
  }
  return chips;
});

function resolvePreviewWorkflowFamily(): WorkflowDefinition["family"] {
  const taskType = selectedIntake.value?.taskType;
  if (taskType === "bugfix") return "bugfix";
  if (taskType === "analysis") return "analysis";
  return "feature-dev";
}

function buildStandaloneRolePreviewWorkflow(role: RoleDefinition): WorkflowDefinition {
  return createStandaloneRoleWorkflow({
    workspaceId: props.workspaceId,
    role,
    family: resolvePreviewWorkflowFamily(),
    description: `按单角色方式直接运行 ${role.name}。`,
  });
}

function instanceStatusLabel(status: string | null | undefined): string {
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
  return map[String(status ?? "")] ?? String(status ?? "-");
}

function isCancelableInstanceStatus(status: string | null | undefined): boolean {
  return status === "running"
    || status === "paused"
    || status === "waiting-start"
    || status === "waiting-approval"
    || status === "waiting-feedback";
}

/** 确认终止指定实例，只有请求成功才执行后续页面操作。 */
function confirmTerminateInstance(
  instanceId: OrchestrationId,
  requirementTitle: string,
  options?: { afterSuccess?: () => void },
) {
  const normalizedTitle = String(requirementTitle ?? "").trim() || "当前需求";
  Modal.confirm({
    title: "终止流程",
    content: `需求「${normalizedTitle}」的当前流程仍在进行中。终止后，这一轮执行会立即停止，但不会自动回滚已写入工作区的代码或文档。确定继续吗？`,
    okText: "终止流程",
    okType: "danger",
    cancelText: "取消",
    /** 终止失败保留诊断并中止成功回调。 */
    async onOk() {
      try {
        await orch.cancelInstance(ctx.value, props.workspaceId, instanceId);
        message.success("流程已终止");
        options?.afterSuccess?.();
      } catch (error) {
        console.error("[TaskIntakePanel] cancel instance failed", {
          ...errorDiagnosticContext(error, "ORCH_INTAKE_CANCEL_FAILED"),
          workspaceId: String(props.workspaceId),
          instanceId: String(instanceId),
          rootCause: error instanceof Error ? error.message : String(error),
        });
        message.error(error instanceof Error ? error.message : "终止失败");
      }
    },
  });
}
</script>

<template>
  <a-modal
    :open="showEditor"
    :title="requirementModalTitle"
    :footer="null"
    :width="960"
    :body-style="{ padding: '18px 20px', maxHeight: 'calc(100vh - 160px)', overflowY: 'auto' }"
    :closable="!requirementSaving"
    :keyboard="!requirementSaving"
    :mask-closable="!requirementSaving"
    destroy-on-close
    @cancel="closeRequirementModal"
  >
    <div class="task-panel task-panel--modal">
      <p class="task-panel__modal-copy">{{ requirementModalDescription }}</p>

      <div class="task-panel__grid">
        <section class="task-panel__card">
          <h4>需求内容</h4>
          <label class="task-panel__field">
            <span>标题</span>
            <input
              v-model="title"
              name="codeflow-requirement-title"
              autocomplete="new-password"
              :maxlength="TASK_INTAKE_TITLE_MAX_LENGTH"
              class="task-panel__input"
              placeholder="例如：任务看板首页改版 / 角色编辑流程修复 / Codex 编排回归测试"
            />
            <small class="task-panel__field-help">标题用于左侧需求列表、当前需求标题和结果目录命名。建议写成短标题，不要把完整需求描述塞进来。{{ titleCount }}/{{ TASK_INTAKE_TITLE_MAX_LENGTH }}</small>
          </label>
          <label class="task-panel__field">
            <span>需求描述</span>
            <textarea v-model="goal" rows="5" class="task-panel__textarea" placeholder="描述具体需求、预期结果、交付物和必要边界。" />
          </label>
          <label class="task-panel__field">
            <span>验收标准</span>
            <textarea v-model="acceptanceText" rows="5" class="task-panel__textarea" placeholder="一行一个验收条件，例如：&#10;- 类型检查通过&#10;- 执行过程可回放&#10;- 结果可审阅" />
          </label>
        </section>

        <section class="task-panel__card">
          <h4>执行默认设置</h4>
          <label class="task-panel__field">
            <span>节点审核默认方式</span>
            <select v-model="nodeApprovalMode" class="task-panel__select">
              <option value="auto">自动通过，节点成功后直接进入下一步</option>
              <option value="manual">人工审核，节点成功后先等待我确认</option>
            </select>
          </label>

          <div class="task-panel__note">
            这里仅定义这条需求默认采用“自动通过”还是“节点成功后必须人工审核”。真正执行哪条流程，或直接运行哪个角色，由您在保存需求后决定。
          </div>
        </section>
      </div>

      <div class="task-panel__modal-footer">
        <button class="task-detail__ghost" type="button" :disabled="requirementSaving" @click="closeRequirementModal">取消</button>
        <button class="task-panel__submit" type="button" :disabled="!canSubmit" @click="saveRequirement">
          {{ requirementSaving ? "保存中..." : isEditMode ? "保存修改" : "保存需求" }}
        </button>
      </div>
    </div>
  </a-modal>

  <div v-if="selectedIntake" class="task-detail">
    <div class="task-detail__grid">
      <section class="task-detail__card task-detail__card--requirement-summary">
        <div class="task-detail__summary-layout">
          <div class="task-detail__summary-main">
            <div class="task-detail__summary-eyebrow-row">
              <span class="task-detail__summary-eyebrow">当前需求</span>
              <a-popover trigger="click" placement="bottomLeft" :arrow="false">
                <template #content>
                  <div class="task-detail__help-popover">
                    <strong>{{ requirementDetailHelp.title }}</strong>
                    <p v-for="line in requirementDetailHelp.lines" :key="line">{{ line }}</p>
                  </div>
                </template>
                <button type="button" class="task-detail__help-btn" aria-label="查看需求内容说明">
                  <QuestionCircleOutlined />
                </button>
              </a-popover>
            </div>
            <h4 class="task-detail__summary-title">{{ getTaskIntakeTitle(selectedIntake) }}</h4>
            <p class="task-detail__summary-copy">{{ requirementSummaryCopy }}</p>
            <div class="task-detail__chips">
              <span v-for="chip in requirementSummaryChips" :key="chip" class="task-detail__chip">{{ chip }}</span>
            </div>
          </div>
          <div class="task-detail__header-side task-detail__header-side--summary">
            <small v-if="requirementMeta" class="task-detail__meta">{{ requirementMeta }}</small>
            <div class="task-panel__actions task-detail__actions task-detail__actions--wrap">
              <button class="task-detail__ghost" @click="openRequirementDetail">原始需求</button>
              <button class="task-detail__ghost" @click="openArtifactModal">
                产出物
                <span class="task-detail__ghost-badge">{{ selectedArtifactCount }}</span>
              </button>
              <button
                class="task-detail__ghost task-detail__ghost--danger"
                :disabled="selectedIntakeReadOnly"
                @click="confirmDeleteRequirement"
              >
                <DeleteOutlined />
                删除需求
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="task-detail__card task-detail__card--execution-plan">
        <div class="task-detail__section-head task-detail__section-head--stacked">
          <div class="task-detail__section-main">
            <div class="task-detail__section-title">
              <h4>{{ showExecutionMonitor ? "执行工作区" : "执行方案" }}</h4>
              <span
                v-if="showExecutionMonitor && executionSummaryChips[0]"
                class="task-detail__chip task-detail__chip--inline"
              >
                {{ executionSummaryChips[0] }}
              </span>
              <a-popover trigger="click" placement="bottomLeft" :arrow="false">
                <template #content>
                  <div class="task-detail__help-popover">
                    <strong>{{ executionPlanHelp.title }}</strong>
                    <p v-for="line in executionPlanHelp.lines" :key="line">{{ line }}</p>
                  </div>
                </template>
                <button type="button" class="task-detail__help-btn" aria-label="查看执行方案说明">
                  <QuestionCircleOutlined />
                </button>
              </a-popover>
            </div>
            <div v-if="!showExecutionMonitor" class="task-detail__chips task-detail__chips--header">
              <span v-for="chip in executionSummaryChips" :key="chip" class="task-detail__chip">{{ chip }}</span>
            </div>
          </div>
          <div class="task-panel__actions task-detail__actions task-detail__actions--wrap">
            <button
              v-if="showExecutionMonitor && monitorRef?.hasReworkEdges"
              class="task-detail__ghost"
              type="button"
              :aria-pressed="monitorRef.showReworkEdges"
              :disabled="!!monitorRef.reworkEdgePreferenceError"
              @click="monitorRef.toggleReworkEdges()"
            >
              {{ monitorRef.showReworkEdges ? "隐藏退回线" : "显示退回线" }}
            </button>
            <label v-if="showExecutionMonitor && relatedInstances.length > 1" class="task-detail__instance-switcher">
              <span>执行记录</span>
              <select
                :value="selectedMonitorInstanceId ?? ''"
                class="task-panel__select task-detail__instance-select"
                @change="changeMonitorInstance(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="instance in relatedInstances" :key="instance.id" :value="instance.id">
                  {{ formatShortTime(instance.createdAt) }} · {{ instanceStatusLabel(instance.status) }}
                </option>
              </select>
            </label>
            <button
              v-if="showExecutionMonitor && selectedMonitorReviewNode"
              class="task-detail__ghost task-detail__ghost--priority"
              type="button"
              :disabled="Boolean(selectedMonitorPrimaryActionDisabledReason)"
              :title="selectedMonitorPrimaryActionDisabledReason ?? ''"
              @click="openMonitorPrimaryNodeAction"
            >
              {{ selectedMonitorPrimaryActionLabel }}
            </button>
            <button
              v-if="showExecutionMonitor && selectedMonitorInstance?.status === 'running' && !selectedIntakeReadOnly"
              class="task-detail__ghost"
              type="button"
              @click="pauseMonitorInstance"
            >
              暂停
            </button>
            <button
              v-if="showExecutionMonitor && selectedMonitorInstance?.status === 'paused' && !selectedIntakeReadOnly"
              class="task-detail__ghost"
              type="button"
              @click="resumeMonitorInstance"
            >
              恢复
            </button>
            <button
              v-if="showExecutionMonitor && canCancelSelectedMonitorInstance && !selectedIntakeReadOnly"
              class="task-detail__ghost task-detail__ghost--danger"
              type="button"
              @click="cancelMonitorInstance"
            >
              终止流程
            </button>
            <button
              v-if="showRunComposer && activeInstance"
              class="task-detail__ghost"
              type="button"
              @click="openActiveInstance"
            >
              查看当前执行
            </button>
            <button
              v-if="showRunComposer && canCancelActiveInstance && !selectedIntakeReadOnly"
              class="task-detail__ghost task-detail__ghost--danger"
              type="button"
              @click="cancelActiveInstance"
            >
              终止流程
            </button>
            <button
              v-if="showRunComposer && !activeInstance && !selectedIntakeReadOnly"
              class="task-detail__ghost task-detail__ghost--priority"
              type="button"
              :disabled="!canSaveExecutionPlan"
              title="只保存这条需求的执行配置，不启动流程"
              @click="saveExecutionPlan()"
            >
              {{ executionPlanSaving ? "保存中..." : "保存执行配置" }}
            </button>
            <button
              v-if="showRunComposer && !activeInstance"
              class="task-panel__submit task-panel__submit--execute"
              type="button"
              :disabled="Boolean(executeBlockedReason)"
              @click="executeRequirement"
            >
              {{ executeButtonLabel }}
            </button>
            <button
              v-else-if="!selectedIntakeReadOnly"
              class="task-detail__ghost"
              type="button"
              @click="startRerun"
            >
              重新执行
            </button>
            <button
              v-if="showExecutionMonitor"
              class="task-detail__ghost"
              type="button"
              @click="openMonitorEvents"
            >
              执行事件
            </button>
          </div>
        </div>

        <div v-if="showRunComposer" class="task-detail__planner">
          <div class="task-detail__planner-toolbar">
            <label class="task-panel__field task-detail__planner-field">
              <span>执行方式</span>
              <select v-model="executionTargetType" class="task-panel__select" @change="markPlannerDraftEdited">
                <option value="workflow">流程</option>
                <option value="role">单角色</option>
              </select>
            </label>
            <label class="task-panel__field task-detail__planner-field">
              <span>{{ executionTargetType === "workflow" ? "流程模板" : "角色" }}</span>
              <select v-if="executionTargetType === 'workflow'" v-model="workflowId" class="task-panel__select" @change="markPlannerDraftEdited">
                <option value="">请选择流程模板</option>
                <option
                  v-for="workflow in orch.workflows"
                  :key="workflow.id"
                  :value="workflow.id"
                  :disabled="!isSpecAssetAvailable(workflow)"
                >
                  {{ workflow.name }}{{ isSpecAssetAvailable(workflow) ? "" : "（已到期）" }}
                </option>
              </select>
              <select v-else v-model="roleId" class="task-panel__select" @change="markPlannerDraftEdited">
                <option value="">请选择角色</option>
                <option
                  v-for="role in orch.roles"
                  :key="role.id"
                  :value="role.id"
                  :disabled="!isSpecAssetAvailable(role)"
                >
                  {{ role.name }}{{ isSpecAssetAvailable(role) ? "" : "（已到期）" }}
                </option>
              </select>
            </label>
            <label v-if="showWorkflowRunModeSelector" class="task-panel__field task-detail__planner-field">
              <span>运行模式</span>
              <select v-model="workflowRunMode" class="task-panel__select" @change="markPlannerDraftEdited">
                <option value="independent">独立运行</option>
                <option value="collaborative">协作运行</option>
              </select>
            </label>
            <label class="task-panel__field task-detail__planner-field">
              <span>执行引擎</span>
              <select v-model="executionEngineStrategy" class="task-panel__select" @change="markPlannerDraftEdited">
                <option
                  v-for="option in executionEngineOptions"
                  :key="option.value"
                  :value="option.value"
                  :disabled="Boolean(option.disabled)"
                >
                  {{ option.label }}
                </option>
              </select>
            </label>
            <div
              v-if="executionWorkflowRoles.length"
              class="task-panel__field task-detail__planner-field task-detail__planner-field--action"
            >
              <span>角色模型配置</span>
              <button
                type="button"
                class="task-detail__planner-action-btn"
                :class="{ 'task-detail__planner-action-btn--active': hasRoleExecutionOverrides }"
                @click="openRoleOverrideModal"
              >
                <span class="task-detail__planner-action-text">
                  {{ hasRoleExecutionOverrides ? "已启用本次覆盖" : "跟随角色定义" }}
                </span>
                <span class="task-detail__planner-action-count">{{ enabledRoleOverrideCount }} / {{ executionWorkflowRoles.length }}</span>
              </button>
            </div>
            <small v-if="selectedWorkflowExecutionDefaultSummary" class="task-detail__planner-hint">
              本流程已在流程设置中统一配置 {{ selectedWorkflowExecutionDefaultSummary }}；未在此单独覆盖的角色将按该配置执行。
            </small>
            <div
              v-if="skippableNodeRows.length"
              class="task-panel__field task-detail__planner-field task-detail__planner-field--action"
            >
              <span>启动跳过</span>
              <button
                type="button"
                class="task-detail__planner-action-btn"
                :class="{ 'task-detail__planner-action-btn--active': skippedNodeCount > 0 }"
                @click="openSkipNodeModal"
              >
                <span class="task-detail__planner-action-text">{{ skipNodePlanSummary }}</span>
                <span class="task-detail__planner-action-count">{{ skippedNodeCount }} / {{ skippableNodeRows.length }}</span>
              </button>
            </div>
            <div
              v-if="needsAssigneeRunPlan"
              class="task-panel__field task-detail__planner-field task-detail__planner-field--action"
            >
              <span>协作处理人</span>
              <button
                type="button"
                class="task-detail__planner-action-btn"
                :class="{ 'task-detail__planner-action-btn--active': assigneePlanReady }"
                @click="openAssigneePlanModal"
              >
                <span class="task-detail__planner-action-text">{{ assigneePlanSummary }}</span>
                <span class="task-detail__planner-action-count">{{ assignedNodeCount }} / {{ collaborativeAssigneeRows.length }}</span>
              </button>
            </div>
            <div v-if="hasExecutionHistory && rerunComposerOpen" class="task-panel__actions task-panel__actions--inline-end task-detail__planner-toolbar-tail">
              <button class="task-detail__ghost" type="button" @click="cancelRerun">取消重新执行</button>
            </div>
          </div>
          <div v-if="executionEngineStrategyHint" class="task-panel__note task-detail__planner-note task-detail__planner-note--warning">
            {{ executionEngineStrategyHint }}
          </div>
        </div>

        <div v-if="showRunComposer && executeBlockedReason" class="task-detail__empty task-detail__empty--warning">
          {{ executeBlockedReason }}
        </div>

        <template v-if="showExecutionMonitor && selectedMonitorInstanceId">
          <OrchestrationMonitor
            ref="monitorRef"
            class="task-detail__monitor"
            :workspace-id="workspaceId"
            :instance-id="selectedMonitorInstanceId"
            :show-header="false"
            :read-only="selectedIntakeReadOnly"
          />
        </template>

        <template v-else-if="previewWorkflow">
          <WorkflowGraphView
            class="task-detail__workflow-graph"
            :workflow="previewWorkflow"
            :role-name-by-id="roleNameById"
            min-height="0"
            fill-height
            :show-controls="true"
            :show-mini-map="true"
          />
        </template>
        <div v-else class="task-detail__empty">
          {{ showRunComposer ? "请先选择流程模板或单角色，再开始执行这个需求。" : "这条需求还没有历史执行版本。" }}
        </div>
      </section>
    </div>
  </div>

  <a-modal
    :open="requirementDetailModalOpen"
    :footer="null"
    :width="requirementDetailModalFullscreen ? '100vw' : 1080"
    :style="requirementDetailModalStyle"
    :body-style="requirementDetailModalBodyStyle"
    :wrap-class-name="requirementDetailModalWrapClassName"
    :closable="false"
    :keyboard="!metricReviewSaving"
    :mask-closable="!metricReviewSaving"
    destroy-on-close
    @cancel="closeRequirementDetailModal"
  >
    <template #title>
      <div class="task-detail__modal-titlebar task-detail__modal-titlebar--requirement">
        <span class="task-detail__modal-titletext">
          {{ selectedIntake ? `${getTaskIntakeTitle(selectedIntake)} · 原始需求` : "原始需求" }}
        </span>
        <div class="task-detail__modal-title-actions task-detail__modal-title-actions--icon">
          <a-tooltip :title="requirementDetailModalFullscreen ? '还原' : '全屏查看'" placement="bottom">
            <a-button
              class="task-detail__modal-icon-action task-detail__modal-icon-action--fullscreen"
              type="text"
              shape="circle"
              :aria-label="requirementDetailModalFullscreen ? '还原原始需求弹框' : '全屏查看原始需求弹框'"
              @mousedown.stop
              @click.stop="toggleRequirementDetailModalFullscreen"
            >
              <template #icon>
                <component :is="requirementDetailModalFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
              </template>
            </a-button>
          </a-tooltip>
          <a-tooltip title="关闭" placement="bottom">
            <a-button
              class="task-detail__modal-icon-action task-detail__modal-icon-action--close"
              type="text"
              shape="circle"
              aria-label="关闭原始需求弹框"
              :disabled="metricReviewSaving"
              @mousedown.stop
              @click.stop="closeRequirementDetailModal"
            >
              <template #icon>
                <CloseOutlined />
              </template>
            </a-button>
          </a-tooltip>
        </div>
      </div>
    </template>

    <div v-if="selectedIntake" class="task-detail__requirement-modal-shell">
      <div class="task-detail__requirement-modal">
        <div class="task-detail__requirement-modal-head">
          <div class="task-detail__requirement-modal-copy">
            <strong>原始需求详情</strong>
            <small v-if="requirementMeta">{{ requirementMeta }}</small>
          </div>
        </div>

        <div class="task-panel__note">
          当前执行会统一带入“需求描述 / 验收标准”。标题主要用于需求识别、左侧列表展示和结果目录命名。
        </div>

        <section class="task-detail__requirement-section">
          <span>标题</span>
          <p>{{ getTaskIntakeTitle(selectedIntake) }}</p>
        </section>

        <section class="task-detail__requirement-section">
          <span>需求描述</span>
          <p>{{ selectedIntake.goal }}</p>
        </section>

        <section v-if="selectedIntake.acceptanceCriteria?.length" class="task-detail__requirement-section">
          <span>验收标准</span>
          <ul class="task-detail__list task-detail__list--full">
            <li v-for="item in selectedIntake.acceptanceCriteria" :key="item.id">{{ item.text }}</li>
          </ul>
        </section>

        <section v-if="latestMetricEvidenceRef" class="task-detail__requirement-section">
          <span>编排度量验证</span>
          <p>{{ latestMetricEvidenceRef.hypothesis || "未记录待验证假设" }}</p>
          <ul class="task-detail__list task-detail__list--full">
            <li>目标说明：{{ latestMetricEvidenceRef.targetVersion || "未记录" }}</li>
            <template v-if="latestMetricEvidenceRef.kind === 'orchestration_evaluation_cohort_pair'">
              <li>基线：{{ metricEvidenceCohortLabel(latestMetricEvidenceRef.baseline) }}；{{ metricEvidenceConclusionLabel(latestMetricEvidenceRef.baseline.conclusion) }}</li>
              <li>候选：{{ metricEvidenceCohortLabel(latestMetricEvidenceRef.candidate) }}；{{ metricEvidenceConclusionLabel(latestMetricEvidenceRef.candidate.conclusion) }}</li>
            </template>
            <li v-else>{{ metricEvidenceConclusionLabel(latestMetricEvidenceRef.conclusion) }}</li>
            <li v-if="latestMetricEvidenceRef.observationWindow">观察窗口：{{ formatDetailTime(latestMetricEvidenceRef.observationWindow.from) }} 至 {{ formatDetailTime(latestMetricEvidenceRef.observationWindow.to) }}</li>
          </ul>
          <div class="task-panel__actions task-detail__actions task-detail__actions--wrap">
            <a-tag :color="metricReviewStatusColor(metricReviewStatus)">{{ metricReviewStatusLabel(metricReviewStatus) }}</a-tag>
            <span v-if="metricReviewLoading">正在读取当前复评证据</span>
          </div>
          <a-alert v-if="metricReviewUnavailableReason" type="warning" show-icon :message="metricReviewUnavailableReason" />
          <a-alert v-if="metricReviewError" type="error" show-icon :message="metricReviewError" />
          <template v-if="metricReviewPreview">
            <ul class="task-detail__list task-detail__list--full">
              <li>基线证据：{{ metricReviewEvidenceLabel(metricReviewPreview.baseline) }}</li>
              <li>候选证据：{{ metricReviewEvidenceLabel(metricReviewPreview.candidate) }}</li>
              <li v-if="metricReviewPreview.reasonCodes.length">不可判定原因：{{ metricReviewPreview.reasonCodes.map(metricReviewReasonLabel).join("、") }}</li>
              <li>证据性质：观察性 Cohort，不代表因果归因</li>
            </ul>
            <button
              v-if="!selectedIntakeReadOnly"
              class="task-detail__ghost"
              type="button"
              :disabled="metricReviewSaving || metricReviewAlreadySaved"
              @click="saveMetricReview"
            >{{ metricReviewAlreadySaved ? "本次证据已保存" : "保存本次复评" }}</button>
          </template>
          <details v-if="latestMetricReviewHistory.length">
            <summary>复评历史（{{ latestMetricReviewHistory.length }}）</summary>
            <ul class="task-detail__list task-detail__list--full">
              <li v-for="review in latestMetricReviewHistory" :key="review.reviewId">
                {{ formatDetailTime(review.evaluatedAt) }} · {{ metricReviewStatusLabel(review.status) }}<template v-if="review.reasonCodes.length"> · {{ review.reasonCodes.map(metricReviewReasonLabel).join("、") }}</template>
              </li>
            </ul>
          </details>
          <template v-if="latestMetricEvidenceRef.kind === 'orchestration_evaluation_cohort_pair'">
            <div class="task-panel__actions task-detail__actions task-detail__actions--wrap">
              <button class="task-detail__ghost" type="button" :disabled="metricReviewSaving" @click="openLinkedMetricExperiment('baseline')">查看基线 Cohort</button>
              <button class="task-detail__ghost" type="button" :disabled="metricReviewSaving" @click="openLinkedMetricExperiment('candidate')">查看候选 Cohort</button>
            </div>
          </template>
          <button v-else class="task-detail__ghost" type="button" :disabled="metricReviewSaving" @click="openLinkedMetricExperiment()">回到评估实验验证</button>
        </section>

        <section class="task-detail__requirement-section">
          <span>执行默认设置</span>
          <p>节点审核默认方式：{{ approvalModeLabel(selectedIntake.constraints?.nodeApprovalMode) }}</p>
        </section>
      </div>

      <div class="task-detail__requirement-footer">
        <button class="task-detail__ghost" type="button" :disabled="metricReviewSaving" @click="closeRequirementDetailModal">关闭</button>
        <button v-if="!selectedIntakeReadOnly" class="task-panel__submit" type="button" :disabled="metricReviewSaving" @click="startEditRequirement">编辑需求</button>
      </div>
    </div>
  </a-modal>

  <a-modal
    :open="artifactModalOpen"
    :footer="null"
    :width="artifactModalFullscreen ? '100vw' : 'min(96vw, 1760px)'"
    :wrap-class-name="artifactModalFullscreen
      ? 'task-detail__artifact-modal-wrap task-detail__artifact-modal-wrap--fullscreen'
      : 'task-detail__artifact-modal-wrap'"
    :body-style="artifactModalFullscreen
      ? { padding: '16px 18px', height: 'calc(100dvh - 64px)', maxHeight: 'calc(100dvh - 64px)', overflow: 'hidden' }
      : { padding: '16px 18px', height: '82vh', maxHeight: '82vh', overflow: 'hidden' }"
    :closable="false"
    destroy-on-close
    @cancel="closeArtifactModal"
  >
    <template #title>
      <div class="task-detail__modal-titlebar">
        <span class="task-detail__modal-titletext">
          {{ selectedIntake ? `${getTaskIntakeTitle(selectedIntake)} · 产出物` : "产出物" }}
        </span>
        <div class="task-detail__modal-title-actions task-detail__modal-title-actions--icon">
          <a-tooltip :title="artifactModalFullscreen ? '还原' : '全屏查看'" placement="bottom">
            <a-button
              class="task-detail__modal-icon-action task-detail__modal-icon-action--fullscreen"
              type="text"
              shape="circle"
              :aria-label="artifactModalFullscreen ? '还原产出物弹框' : '全屏查看产出物弹框'"
              @mousedown.stop
              @click.stop="toggleArtifactModalFullscreen"
            >
              <template #icon>
                <component :is="artifactModalFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
              </template>
            </a-button>
          </a-tooltip>
          <a-tooltip title="关闭" placement="bottom">
            <a-button
              class="task-detail__modal-icon-action task-detail__modal-icon-action--close"
              type="text"
              shape="circle"
              aria-label="关闭产出物弹框"
              @mousedown.stop
              @click.stop="closeArtifactModal"
            >
              <template #icon>
                <CloseOutlined />
              </template>
            </a-button>
          </a-tooltip>
        </div>
      </div>
    </template>
    <div class="task-detail__artifact-modal">
      <div class="task-detail__artifact-toolbar">
        <div class="task-detail__artifact-copy">
          <strong>当前需求产出物</strong>
          <small v-if="relatedInstances.length > 0">
            共 {{ relatedInstances.length }} 次执行，当前查看 {{ selectedArtifactCount }} 项产出物
          </small>
          <small v-else>当前需求还没有执行记录，先发起执行后再查看产出物。</small>
        </div>
        <label v-if="relatedInstances.length > 1" class="task-detail__instance-switcher">
          <span>执行记录</span>
          <select
            :value="selectedMonitorInstanceId ?? ''"
            class="task-panel__select task-detail__instance-select"
            @change="changeMonitorInstance(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="instance in relatedInstances" :key="instance.id" :value="instance.id">
              {{ formatShortTime(instance.createdAt) }} · {{ instanceStatusLabel(instance.status) }}
            </option>
          </select>
        </label>
      </div>

      <div v-if="relatedInstances.length === 0" class="task-detail__empty task-detail__artifact-empty">
        当前需求还没有执行记录，先在下方执行工作区启动一条执行，再查看这里的产出物。
      </div>
      <ArtifactBrowser v-else class="task-detail__artifact-browser" :workspace-id="workspaceId" />
    </div>
  </a-modal>

  <a-modal
    :open="roleOverrideModalOpen"
    :width="960"
    :body-style="{ padding: '16px 18px', maxHeight: 'calc(100vh - 160px)', overflowY: 'auto' }"
    destroy-on-close
    @cancel="closeRoleOverrideModal"
  >
    <template #title>
      <div class="task-detail__modal-titlebar">
        <span class="task-detail__modal-titletext">
          角色模型配置 · 已覆盖 {{ enabledRoleOverrideCount }} / {{ executionWorkflowRoles.length }}
        </span>
      </div>
    </template>
    <template #footer>
      <button class="task-detail__ghost" type="button" @click="closeRoleOverrideModal">关闭</button>
    </template>
    <div class="task-detail__role-overrides task-detail__role-overrides--modal">
      <div class="task-detail__role-overrides-modal-note">
        {{ hasRoleExecutionOverrides ? "已启用本次覆盖" : "默认跟随角色定义" }} · 配置只冻结到本次执行实例，不回写角色模板。
      </div>
      <section class="task-detail__role-override-batch" aria-label="批量设置角色模型配置">
        <div class="task-detail__role-override-batch-head">
          <div>
            <strong>批量设置</strong>
            <small>先统一应用一套配置，再在下方调整少数例外角色。</small>
          </div>
          <button
            class="task-detail__chip-btn"
            type="button"
            :disabled="enabledRoleOverrideCount === 0"
            @click="disableAllRoleExecutionOverrides"
          >
            全部恢复跟随角色定义
          </button>
        </div>
        <a-alert
          v-if="roleOverrideBatchUnavailableMessage"
          type="warning"
          show-icon
          :message="roleOverrideBatchUnavailableMessage"
        />
        <template v-else>
          <div class="task-detail__role-override-batch-fields">
            <label class="task-detail__role-override-batch-field">
              <span>执行引擎</span>
              <select
                v-model="roleOverrideBatchDraft.engine"
                class="task-panel__select"
                @change="onRoleOverrideBatchEngineChanged"
              >
                <option v-for="option in roleOverrideBatchEngineOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </label>
            <label class="task-detail__role-override-batch-field">
              <span>模型</span>
              <select
                v-model="roleOverrideBatchDraft.model"
                class="task-panel__select"
                :disabled="roleOverrideBatchModelOptionGroups.length === 0"
                @change="onRoleOverrideBatchModelChanged"
              >
                <option v-if="roleOverrideBatchModelOptionGroups.length === 0" value="" disabled>模型目录尚未加载</option>
                <optgroup
                  v-for="group in roleOverrideBatchModelOptionGroups"
                  :key="group.label"
                  :label="group.label"
                >
                  <option v-for="option in group.options" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </optgroup>
              </select>
            </label>
            <label class="task-detail__role-override-batch-field">
              <span>思考强度</span>
              <select
                v-if="roleOverrideBatchEffortOptions.length"
                v-model="roleOverrideBatchDraft.effort"
                class="task-panel__select"
              >
                <option v-for="option in roleOverrideBatchEffortOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
              <input v-else class="task-panel__input" :value="roleOverrideBatchDraft.effort || '不发送'" disabled />
            </label>
            <label class="task-detail__role-override-batch-field">
              <span>自动压缩比例</span>
              <input
                v-model.number="roleOverrideBatchDraft.autoCompactPct"
                class="task-panel__input"
                type="number"
                min="50"
                max="99"
                placeholder="继承当前值"
              />
            </label>
          </div>
          <div class="task-detail__role-override-batch-actions">
            <small>仅覆盖本次执行的 5 项参数；访问模式和重试次数继续沿用角色定义。</small>
            <button
              class="task-detail__ghost task-detail__ghost--priority"
              type="button"
              @click="applyRoleOverrideBatchToAll"
            >
              应用到全部 {{ roleOverrideBatchRoleIds.length }} 个角色
            </button>
          </div>
        </template>
      </section>
      <div
        v-for="row in executionWorkflowRoles"
        :key="row.roleId"
        class="task-detail__role-override-row"
      >
        <template v-if="roleExecutionOverrideDrafts[row.roleId]">
          <label class="task-detail__role-override-check">
            <input v-model="roleExecutionOverrideDrafts[row.roleId].enabled" type="checkbox" @change="markPlannerDraftEdited" />
            <span>{{ row.roleName }}</span>
            <small>{{ row.nodeLabel }}</small>
          </label>
          <div class="task-detail__role-override-fields" :class="{ 'task-detail__role-override-fields--disabled': !roleExecutionOverrideDrafts[row.roleId].enabled }">
            <select
              v-model="roleExecutionOverrideDrafts[row.roleId].engine"
              class="task-panel__select task-detail__role-override-select"
              :disabled="!roleExecutionOverrideDrafts[row.roleId].enabled"
              @change="setRoleOverrideEngine(row.roleId, roleExecutionOverrideDrafts[row.roleId].engine)"
            >
              <option
                v-for="option in roleOverrideEngineOptions(row.roleId)"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <select
              v-model="roleExecutionOverrideDrafts[row.roleId].model"
              class="task-panel__select task-detail__role-override-model"
              :disabled="!roleExecutionOverrideDrafts[row.roleId].enabled || modelOptionGroupsForDraft(roleExecutionOverrideDrafts[row.roleId]).length === 0"
              @change="onRoleOverrideModelChanged(row.roleId)"
            >
              <option v-if="modelOptionGroupsForDraft(roleExecutionOverrideDrafts[row.roleId]).length === 0" value="" disabled>模型目录尚未加载</option>
              <optgroup
                v-for="group in modelOptionGroupsForDraft(roleExecutionOverrideDrafts[row.roleId])"
                :key="group.label"
                :label="group.label"
              >
                <option
                  v-for="option in group.options"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </optgroup>
            </select>
            <select
              v-if="effortOptionsForDraft(roleExecutionOverrideDrafts[row.roleId]).length"
              v-model="roleExecutionOverrideDrafts[row.roleId].effort"
              class="task-panel__select task-detail__role-override-effort"
              :disabled="!roleExecutionOverrideDrafts[row.roleId].enabled"
              @change="markPlannerDraftEdited"
            >
              <option
                v-for="option in effortOptionsForDraft(roleExecutionOverrideDrafts[row.roleId])"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <input
              v-else
              class="task-panel__input task-detail__role-override-effort"
              disabled
              value="不发送"
            />
            <input
              v-model.number="roleExecutionOverrideDrafts[row.roleId].autoCompactPct"
              class="task-panel__input task-detail__role-override-number"
              :disabled="!roleExecutionOverrideDrafts[row.roleId].enabled"
              type="number"
              min="50"
              max="99"
              placeholder="压缩%"
              @input="markPlannerDraftEdited"
            />
          </div>
        </template>
      </div>
    </div>
  </a-modal>

  <a-modal
    :open="skipNodeModalOpen"
    :width="640"
    :body-style="{ padding: '16px 18px', maxHeight: 'calc(100vh - 160px)', overflowY: 'auto' }"
    destroy-on-close
    @cancel="skipNodeModalOpen = false"
  >
    <template #title>
      <div class="task-detail__modal-titlebar">
        <span class="task-detail__modal-titletext">
          启动跳过 · 已选择 {{ skippedNodeCount }} / {{ skippableNodeRows.length }}
        </span>
      </div>
    </template>
    <template #footer>
      <button class="task-detail__ghost" type="button" @click="clearSkippedNodeDrafts">全部清空</button>
      <button class="task-panel__submit" type="button" @click="skipNodeModalOpen = false">完成</button>
    </template>
    <div class="task-detail__skip-plan">
      <div class="task-detail__skip-modal-note">
        启动实例时，已选择节点会直接进入跳过状态。
      </div>
      <div class="task-detail__skip-list">
        <label
          v-for="row in skippableNodeRows"
          :key="row.nodeId"
          class="task-detail__skip-row"
          :class="{ 'task-detail__skip-row--selected': skippedNodeIdSet.has(row.nodeId) }"
        >
          <input
            type="checkbox"
            :checked="skippedNodeIdSet.has(row.nodeId)"
            @change="setSkippedNodeDraft(row.nodeId, ($event.target as HTMLInputElement).checked)"
          />
          <span>
            <strong>{{ row.label }}</strong>
            <small>{{ row.typeLabel }}</small>
          </span>
        </label>
      </div>
    </div>
  </a-modal>

  <a-modal
    :open="assigneePlanModalOpen"
    :width="780"
    :body-style="{ padding: '0', maxHeight: 'calc(100vh - 160px)', overflowY: 'auto' }"
    destroy-on-close
    @cancel="assigneePlanModalOpen = false"
  >
    <template #title>
      <div class="task-detail__assignee-modal-titlebar">
        <span class="task-detail__assignee-modal-title">协作处理人</span>
        <span
          class="task-detail__assignee-progress"
          :class="{ 'task-detail__assignee-progress--ready': assignedNodeCount === collaborativeAssigneeRows.length && collaborativeAssigneeRows.length > 0 }"
        >
          已配置 {{ assignedNodeCount }} / {{ collaborativeAssigneeRows.length }}
        </span>
      </div>
    </template>
    <template #footer>
      <button class="task-detail__ghost" type="button" @click="assigneePlanModalOpen = false">取消</button>
      <button class="task-panel__submit" type="button" @click="assigneePlanModalOpen = false">完成</button>
    </template>
    <div class="task-detail__assignee-plan">
      <p class="task-detail__assignee-modal-note">
        选择或编辑一套处理人模板，再为本次运行临时覆盖节点处理人；启动后会冻结到执行实例。
      </p>

      <div class="task-detail__assignee-toolbar">
        <div class="task-detail__assignee-toolbar-template">
          <a-select
            v-model:value="assigneeTemplateId"
            class="task-detail__assignee-toolbar-template-select"
            :disabled="orch.assigneeTemplatesLoading"
            :placeholder="collaborativeAssigneeTemplates.length > 0 ? '选择已保存的处理人模板' : '暂无可选模板，可在下方配置后通过右上角“保存模板”另存'"
            allow-clear
            @change="onAssigneeTemplateChanged"
          >
            <a-select-option
              v-for="template in collaborativeAssigneeTemplates"
              :key="template.id"
              :value="template.id"
              :label="template.name"
            >
              {{ template.name }} · v{{ template.version }}{{ template.status === "draft" ? "（草稿）" : "" }}
            </a-select-option>
          </a-select>
          <span v-if="assigneeDraftDirty" class="task-detail__assignee-dirty-tag" title="本次有未保存改动">· 已修改</span>
        </div>

        <div class="task-detail__assignee-toolbar-batch">
          <button
            class="task-detail__chip-btn"
            type="button"
            :disabled="!hasCurrentUserCandidate || collaborativeAssigneeRows.length === 0"
            @click="assignAllNodesToCurrentUser"
          >全部分配给我</button>
          <button
            class="task-detail__chip-btn"
            type="button"
            :disabled="!selectedAssigneeTemplate"
            @click="resetAssigneeDraftsToTemplate"
          >按模板重置</button>
          <button
            class="task-detail__chip-btn task-detail__chip-btn--danger"
            type="button"
            :disabled="assignedNodeCount === 0"
            @click="clearAllNodeAssignees"
          >全部清空</button>
        </div>

        <a-dropdown :trigger="['click']" placement="bottomRight">
          <button
            class="task-detail__ghost task-detail__assignee-save-trigger"
            :class="{ 'task-detail__ghost--priority': assigneeDraftDirty }"
            type="button"
            :disabled="assigneeTemplateSaving"
          >
            保存模板
            <span class="task-detail__assignee-save-chevron" aria-hidden="true">▾</span>
          </button>
          <template #overlay>
            <a-menu>
              <a-menu-item
                key="update"
                :disabled="!assigneeTemplateId || assigneeTemplateSaving"
                @click="saveAssigneeTemplate(false)"
              >更新到当前模板</a-menu-item>
              <a-menu-item
                key="create"
                :disabled="assigneeTemplateSaving"
                @click="openSaveAsTemplateDialog"
              >另存为新模板…</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </div>

      <div v-if="assigneeSaveAsOpen" class="task-detail__assignee-saveas">
        <input
          v-model="assigneeTemplateNameDraft"
          name="codeflow-assignee-template-name"
          autocomplete="new-password"
          class="task-panel__input task-detail__assignee-saveas-input"
          placeholder="新模板名称，例如：默认协作模板"
          @keydown.enter.prevent="confirmSaveAsNewTemplate"
        />
        <button
          class="task-detail__ghost task-detail__ghost--priority"
          type="button"
          :disabled="assigneeTemplateSaving || !assigneeTemplateNameDraft.trim()"
          @click="confirmSaveAsNewTemplate"
        >保存</button>
        <button
          class="task-detail__chip-btn"
          type="button"
          @click="assigneeSaveAsOpen = false"
        >取消</button>
      </div>

      <div class="task-detail__assignee-list">
        <div
          v-for="row in collaborativeAssigneeRows"
          :key="row.nodeId"
          class="task-detail__assignee-row"
          :class="{ 'task-detail__assignee-row--unfilled': (nodeAssigneeDrafts[row.nodeId]?.length ?? 0) === 0 }"
        >
          <div class="task-detail__assignee-copy">
            <strong>{{ row.label }}</strong>
            <small>{{ row.roleName || "未绑定角色名称" }}</small>
          </div>
          <div class="task-detail__assignee-select-wrap">
            <a-select
              mode="multiple"
              :value="getNodeAssigneeDraft(row.nodeId)"
              class="task-detail__assignee-select"
              placeholder="输入姓名或邮箱搜索处理人"
              :max-tag-count="3"
              :max-tag-text-length="10"
              :options="memberSelectOptions"
              :filter-option="filterMemberOption"
              @update:value="(value: string[]) => setNodeAssigneeDraftValue(row.nodeId, value)"
            />
            <span
              v-if="(nodeAssigneeDrafts[row.nodeId]?.length ?? 0) === 0"
              class="task-detail__assignee-unfilled-hint"
            >待补齐</span>
          </div>
        </div>
      </div>

      <div v-if="activeSharedMemberOptions.length === 0" class="task-detail__empty task-detail__empty--warning task-detail__assignee-empty">
        共享成员列表为空或尚未加载，暂不能启动协作运行。
      </div>
    </div>
  </a-modal>

  <div v-if="!selectedIntake" class="task-detail__empty">
    左侧选择一条需求，或使用左侧上方的“AI创建需求”或“手工创建”发起新的编排需求。
  </div>
</template>

<style scoped>
.task-panel,
.task-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.task-panel--modal {
  gap: 12px;
}
.task-detail {
  height: 100%;
  min-height: 0;
}
.task-panel__header,
.task-detail__header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}
.task-panel__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-panel__actions--inline-end {
  justify-content: flex-end;
}
.task-panel__modal-copy {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--app-muted, #666);
}
.task-panel__modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.task-panel__header h3,
.task-detail__header h3 {
  margin: 0 0 6px;
  font-size: 20px;
}
.task-panel__header p,
.task-detail__header p {
  margin: 0;
  font-size: 13px;
  color: var(--app-muted, #666);
  line-height: 1.7;
}
.task-panel__submit,
.task-detail__ghost {
  min-height: 36px;
  padding: 7px 14px;
  border-radius: 10px;
  font-size: 13px;
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
}
.task-panel__submit {
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 24%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, #fff);
  color: var(--app-primary, #1677ff);
}
.task-panel__submit--execute {
  border-color: color-mix(in srgb, var(--app-accent, #c96442) 86%, #7c2d12);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--app-accent, #c96442) 88%, #fff 12%),
    color-mix(in srgb, var(--app-accent, #c96442) 96%, #7c2d12 4%)
  );
  color: #fff;
  box-shadow: 0 8px 18px color-mix(in srgb, var(--app-accent, #c96442) 22%, transparent);
}
.task-panel__submit:disabled,
.task-detail__ghost:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.task-detail__ghost {
  border: 1px solid var(--app-border, #d9d9d9);
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 94%, #f7f9fc), var(--app-bg, #fff));
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.task-panel__submit:hover:not(:disabled),
.task-detail__ghost:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 28%, var(--app-border, #d9d9d9));
  box-shadow: 0 10px 22px rgba(15, 23, 42, 0.06);
}
.task-panel__submit--execute:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-accent, #c96442) 92%, #7c2d12);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--app-accent, #c96442) 82%, #fff 18%),
    color-mix(in srgb, var(--app-accent, #c96442) 92%, #7c2d12 8%)
  );
  box-shadow: 0 12px 24px color-mix(in srgb, var(--app-accent, #c96442) 28%, transparent);
}
.task-panel__grid,
.task-detail__grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
.task-detail__grid {
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr) auto;
}
.task-panel__card,
.task-detail__card {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 16px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 95%, #f7f9fc), var(--app-bg, #fff));
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.04);
}
.task-detail__card--execution-plan {
  order: 1;
  min-height: 0;
  height: 100%;
}
.task-detail__card--requirement-summary {
  order: 2;
  gap: 0;
}
.task-panel__card h4,
.task-detail__card h4 {
  margin: 0;
  font-size: 15px;
}
.task-panel__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.task-panel__field span,
.task-detail__kv span {
  font-size: 12px;
  font-weight: 600;
  color: color-mix(in srgb, var(--app-text, #1f2937) 82%, #4b5563);
}
.task-panel__input,
.task-panel__textarea,
.task-panel__select {
  width: 100%;
  min-height: 40px;
  /* 输入框背景跟随主题 panel-bg，边框走主题 border 变量，避免在暖色面板里嵌一块异色蓝白 */
  border: 1px solid var(--app-border);
  border-radius: 10px;
  padding: 9px 12px;
  font-size: 13px;
  background: var(--app-panel-bg);
  color: var(--app-text);
  outline: none;
  box-shadow: var(--app-shadow-sm);
  transition: border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease;
}
.task-panel__input:hover,
.task-panel__textarea:hover,
.task-panel__select:hover {
  border-color: color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
  background: var(--app-panel-bg);
}
.task-panel__input:focus,
.task-panel__textarea:focus,
.task-panel__select:focus {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 18%, transparent);
  background: var(--app-panel-bg);
}
.task-panel__input::placeholder,
.task-panel__textarea::placeholder {
  color: var(--app-muted);
}
.task-panel__field-help {
  font-size: 11px;
  line-height: 1.6;
  color: var(--app-muted, #7a8699);
}
.task-panel__toggles {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
}
.task-panel__note {
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 10%, var(--app-border, #d9d9d9));
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-muted, #666);
  background: color-mix(in srgb, var(--app-primary, #1677ff) 6%, #f7fbff);
}
.task-detail__section-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.task-detail__help-btn {
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
}
.task-detail__help-btn:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 32%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 12%, #fff);
}
.task-detail__help-popover {
  max-width: 320px;
  display: grid;
  gap: 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-text, #334155);
}
.task-detail__help-popover strong {
  font-size: 12px;
  color: var(--app-text, #1f2937);
}
.task-detail__help-popover p {
  margin: 0;
}
.task-detail__summary-layout {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.task-detail__summary-main {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.task-detail__summary-eyebrow-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.task-detail__summary-eyebrow {
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--app-primary, #1677ff) 72%, #475569);
}
.task-detail__summary-title {
  font-size: 16px;
  line-height: 1.45;
}
.task-detail__summary-copy {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--app-muted, #667085);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.task-detail__kv {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 10px;
  align-items: start;
  font-size: 13px;
}
.task-detail__kv--compact {
  align-items: stretch;
}
.task-detail__kv-value {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.task-detail__kv-inline {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
  min-width: 0;
}
.task-detail__inline-toggle {
  align-self: flex-start;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 18%, var(--app-border, #d9d9d9));
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, #fff);
  color: color-mix(in srgb, var(--app-primary, #1677ff) 72%, #1f2937);
  padding: 2px 10px;
  font-size: 11px;
  line-height: 20px;
  cursor: pointer;
}
.task-detail__kv-text--collapsed {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--app-muted, #666);
}
.task-detail__list {
  margin: 0;
  padding-left: 18px;
  max-height: 168px;
  overflow-y: auto;
  padding-right: 6px;
}

.task-detail__list li + li {
  margin-top: 6px;
}
.task-detail__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.task-detail__chips--header {
  margin-top: 8px;
}
.task-detail__chip {
  border-radius: 999px;
  /* chip 用主题 accent + panel-bg 混色，浅暗主题都贴合主调 */
  background: color-mix(in srgb, var(--app-accent) 14%, var(--app-panel-bg));
  padding: 3px 9px;
  font-size: 12px;
  color: color-mix(in srgb, var(--app-accent) 70%, var(--app-text));
  font-weight: 600;
}
.task-detail__chip--inline {
  white-space: nowrap;
}
.task-detail__planner {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.task-detail__planner-note {
  margin: 0;
}
.task-detail__monitor {
  flex: 1 1 auto;
  min-height: 0;
}
.task-detail__instance-switcher {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.task-detail__instance-switcher span {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--app-muted, #666);
}
.task-detail__instance-select {
  min-width: 220px;
}
.task-detail__workflow-graph {
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
}
.task-detail__planner-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  gap: 10px;
  flex-wrap: wrap;
}
/* 字段靠左自然排列；这里用 flex-start + gap 替代原 space-between，避免子项间被撑出大段空白 */
.task-detail__planner-field {
  flex: 0 1 220px;
  min-width: 180px;
}
/* 工具栏尾部（取消重新执行）自动靠右，避免和左侧字段拉开 space-between 的空白 */
.task-detail__planner-toolbar-tail {
  margin-left: auto;
}
/* 角色模型配置：作为第 4 个等宽字段呈现，按钮与 select 同高同对齐 */
.task-detail__planner-field--action {
  display: flex;
  flex-direction: column;
}
/* 流程统一模型提示独占一行，避免挤占字段宽度 */
.task-detail__planner-hint {
  flex: 1 0 100%;
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-muted, #6b7280);
}
.task-detail__planner-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 7px 12px;
  border-radius: 10px;
  /* 默认态：底色与输入框一致（panel-bg），仅描浅 accent 边、文字走 muted 中性色，整体低调可点 */
  border: 1px solid color-mix(in srgb, var(--app-accent) 22%, var(--app-border));
  background: var(--app-panel-bg);
  color: var(--app-muted);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}
.task-detail__planner-action-btn:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--app-accent) 50%, var(--app-border));
  color: color-mix(in srgb, var(--app-accent) 60%, var(--app-text));
}
/* 已启用覆盖态：底色仍是 panel-bg（不引入任何染色），靠深 accent 边 + accent 主字 + 角标实色 accent 做"激活"提示 */
.task-detail__planner-action-btn--active {
  background: var(--app-panel-bg);
  border-color: color-mix(in srgb, var(--app-accent) 60%, var(--app-border));
  color: color-mix(in srgb, var(--app-accent) 78%, var(--app-text));
  font-weight: 700;
}
.task-detail__planner-action-btn--active:hover {
  background: var(--app-panel-bg);
  border-color: color-mix(in srgb, var(--app-accent) 75%, var(--app-border));
}
.task-detail__planner-action-text {
  flex: 1 1 auto;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 默认角标：用 app-bg 米色作底（比 panel-bg 略沉一点形成 outline 感），accent 字 */
.task-detail__planner-action-count {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  background: var(--app-bg);
  color: color-mix(in srgb, var(--app-accent) 70%, var(--app-muted));
}
/* 激活角标：accent 实色 + 白字，是整个按钮里唯一的实色块，作为"已启用"的强提示锚点 */
.task-detail__planner-action-btn--active .task-detail__planner-action-count {
  background: var(--app-accent);
  color: #fff;
}
.task-detail__role-overrides {
  display: grid;
  gap: 8px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 12px;
  padding: 10px;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 94%, var(--app-primary, #1677ff));
}
/* 弹框内列表：复用原 5 列 grid，由 modal body 提供垂直滚动 */
.task-detail__role-overrides--modal {
  border: none;
  background: transparent;
  padding: 0;
  gap: 10px;
}
.task-detail__role-overrides-modal-note {
  font-size: 12px;
  color: var(--app-muted, #666);
  line-height: 1.6;
  padding-bottom: 4px;
  border-bottom: 1px dashed color-mix(in srgb, var(--app-border, #d9d9d9) 80%, transparent);
}
.task-detail__role-override-batch {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 26%, var(--app-border, #d9d9d9));
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 5%, var(--app-panel-bg, #fff));
}
.task-detail__role-override-batch-head,
.task-detail__role-override-batch-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.task-detail__role-override-batch-head > div {
  display: grid;
  gap: 2px;
}
.task-detail__role-override-batch-head small,
.task-detail__role-override-batch-actions small {
  color: var(--app-muted, #666);
  line-height: 1.5;
}
.task-detail__role-override-batch-fields {
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) minmax(180px, 1.4fr) minmax(110px, 0.8fr) minmax(100px, 0.6fr);
  gap: 8px;
}
.task-detail__role-override-batch-field {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.task-detail__role-override-batch-field > span {
  color: var(--app-muted, #666);
  font-size: 12px;
  font-weight: 600;
}
.task-detail__role-override-batch-field > input,
.task-detail__role-override-batch-field > select {
  width: 100%;
  min-width: 0;
}
.task-detail__role-override-batch-actions {
  align-items: flex-end;
}
.task-detail__skip-plan {
  display: grid;
  gap: 12px;
}
.task-detail__skip-modal-note {
  font-size: 12px;
  color: var(--app-muted, #666);
  line-height: 1.6;
  padding-bottom: 4px;
  border-bottom: 1px dashed color-mix(in srgb, var(--app-border, #d9d9d9) 80%, transparent);
}
.task-detail__skip-list {
  display: grid;
  gap: 8px;
}
.task-detail__skip-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border, #d9d9d9);
  background: color-mix(in srgb, var(--app-bg, #fff) 82%, transparent);
  cursor: pointer;
}
.task-detail__skip-row--selected {
  border-color: color-mix(in srgb, var(--app-accent, #1677ff) 58%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent, #1677ff) 7%, var(--app-bg, #fff));
}
.task-detail__skip-row span {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.task-detail__skip-row strong {
  font-size: 13px;
  color: var(--app-text, #222);
}
.task-detail__skip-row small {
  font-size: 12px;
  color: var(--app-muted, #666);
}
.task-detail__role-overrides-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-weight: 700;
}
.task-detail__role-overrides-head small,
.task-detail__role-override-check small {
  color: var(--app-muted, #666);
  font-weight: 500;
}
.task-detail__role-override-row {
  display: grid;
  gap: 8px;
  padding: 8px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-bg, #fff) 78%, transparent);
}
.task-detail__role-override-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.task-detail__role-override-fields {
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) minmax(180px, 1.4fr) minmax(110px, 0.8fr) minmax(86px, 0.5fr);
  gap: 8px;
}
.task-detail__role-override-fields--disabled {
  opacity: 0.55;
}
.task-detail__assignee-plan {
  display: flex;
  flex-direction: column;
  padding: 16px 20px 8px;
}
.task-detail__assignee-modal-titlebar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.task-detail__assignee-modal-title {
  font-size: 16px;
  font-weight: 600;
}
.task-detail__assignee-progress {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-muted, #666);
  background: color-mix(in srgb, var(--app-border, #d9d9d9) 30%, transparent);
}
.task-detail__assignee-progress--ready {
  color: #52c41a;
  background: color-mix(in srgb, #52c41a 14%, transparent);
}
.task-detail__assignee-modal-note {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-muted, #666);
}
.task-detail__assignee-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  margin-bottom: 4px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 70%, transparent);
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 92%, var(--app-primary, #1677ff));
}
.task-detail__assignee-toolbar-template {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 220px;
  flex: 1 1 220px;
}
.task-detail__assignee-toolbar-template-select {
  flex: 1 1 auto;
  min-width: 0;
}
.task-detail__assignee-dirty-tag {
  font-size: 12px;
  font-weight: 600;
  color: #d4383a;
  white-space: nowrap;
}
.task-detail__assignee-toolbar-batch {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.task-detail__chip-btn {
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 80%, transparent);
  background: var(--app-panel-bg, #fff);
  color: var(--app-text, #1f2937);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.16s ease, background-color 0.16s ease, color 0.16s ease;
}
.task-detail__chip-btn:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 50%, var(--app-border, #d9d9d9));
  color: var(--app-primary, #1677ff);
}
.task-detail__chip-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.task-detail__chip-btn--danger {
  color: #d4383a;
  border-color: color-mix(in srgb, #ff4d4f 26%, var(--app-border, #d9d9d9));
}
.task-detail__chip-btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, #ff4d4f 8%, var(--app-panel-bg, #fff));
  border-color: color-mix(in srgb, #ff4d4f 55%, var(--app-border, #d9d9d9));
  color: #cf1322;
}
.task-detail__assignee-save-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.task-detail__assignee-save-chevron {
  font-size: 10px;
  line-height: 1;
}
.task-detail__assignee-saveas {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
  margin-bottom: 4px;
  border-radius: 10px;
  border: 1px dashed color-mix(in srgb, var(--app-primary, #1677ff) 36%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 4%, var(--app-panel-bg, #fff));
}
.task-detail__assignee-saveas-input {
  flex: 1 1 auto;
  min-width: 0;
}
.task-detail__assignee-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.task-detail__assignee-row {
  display: grid;
  grid-template-columns: minmax(160px, 0.7fr) minmax(260px, 1.6fr);
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  transition: border-color 0.16s ease, background-color 0.16s ease;
}
.task-detail__assignee-row:hover {
  background: color-mix(in srgb, var(--app-primary, #1677ff) 3%, transparent);
}
.task-detail__assignee-row--unfilled {
  border-color: color-mix(in srgb, #ff4d4f 32%, transparent);
  background: color-mix(in srgb, #ff4d4f 5%, transparent);
}
.task-detail__assignee-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.task-detail__assignee-copy strong {
  font-size: 13px;
  line-height: 1.4;
}
.task-detail__assignee-copy small {
  font-size: 12px;
  color: var(--app-muted, #666);
}
.task-detail__assignee-select-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.task-detail__assignee-select {
  flex: 1 1 auto;
  min-width: 0;
}
.task-detail__assignee-unfilled-hint {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 600;
  color: #d4383a;
  white-space: nowrap;
}
.task-detail__assignee-empty {
  margin-top: 10px;
}
.task-detail__role-override-select,
.task-detail__role-override-model,
.task-detail__role-override-effort,
.task-detail__role-override-number {
  min-width: 0;
}
.task-detail__ghost--inline {
  align-self: flex-start;
}
.task-detail__ghost--danger {
  border-color: color-mix(in srgb, #ff4d4f 28%, var(--app-border, #d9d9d9));
  color: #d4383a;
}
.task-detail__ghost--priority {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 30%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, #fff);
  color: color-mix(in srgb, var(--app-primary, #1677ff) 80%, #0f172a);
}
.task-detail__ghost--danger:hover {
  border-color: color-mix(in srgb, #ff4d4f 55%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #ff4d4f 7%, var(--app-bg, #fff));
  color: #cf1322;
}
.task-detail__ghost-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, #fff);
  color: var(--app-primary, #1677ff);
  font-size: 11px;
  font-weight: 700;
}
.task-detail__section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.task-detail__header-side {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.task-detail__section-head--stacked {
  align-items: flex-start;
}
.task-detail__meta {
  font-size: 11px;
  line-height: 1.5;
  color: var(--app-muted, #8b95a7);
  text-align: right;
}
.task-detail__actions--wrap {
  flex-wrap: wrap;
}
.task-detail__header-side--summary {
  flex: 0 0 auto;
}
.task-detail__section-main {
  min-width: 0;
  flex: 1 1 auto;
}
.task-detail__actions {
  flex: 0 0 auto;
  justify-content: flex-end;
}
.task-detail__section-head span {
  font-size: 12px;
  color: var(--app-muted, #666);
}
.task-detail__link-row {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 10px;
  background: none;
  padding: 8px 10px;
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.task-detail__link-row strong {
  font-size: 13px;
}
.task-detail__link-row span,
.task-detail__link-row small {
  color: var(--app-muted, #666);
  font-size: 12px;
}
.task-detail__empty {
  border: 1px dashed var(--app-border, #d9d9d9);
  border-radius: 10px;
  padding: 18px;
  text-align: center;
  color: var(--app-muted, #999);
  font-size: 13px;
}

.task-detail__empty--warning {
  border-style: solid;
  border-color: color-mix(in srgb, #faad14 34%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #faad14 8%, #fff);
  color: #8d5b00;
}
.task-detail__modal-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.task-detail__modal-titlebar--requirement {
  width: 100%;
  min-height: 56px;
}
.task-detail__modal-titletext {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-detail__modal-titlebar--requirement .task-detail__modal-titletext {
  flex: 1 1 auto;
  color: var(--app-text, #1f2937);
  font-size: 16px;
  font-weight: 600;
}
.task-detail__modal-title-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.task-detail__modal-title-actions--icon {
  gap: 0;
  margin-right: -6px;
}
.task-detail__modal-icon-action.ant-btn {
  position: relative;
  width: 44px;
  min-width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  color: var(--app-muted, #667085);
  box-shadow: none;
}
.task-detail__modal-icon-action.ant-btn::before {
  content: "";
  position: absolute;
  inset: 6px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.task-detail__modal-icon-action.ant-btn:hover,
.task-detail__modal-icon-action.ant-btn:focus-visible {
  color: var(--app-primary, #1677ff);
  background: transparent;
}
.task-detail__modal-icon-action.ant-btn:hover::before,
.task-detail__modal-icon-action.ant-btn:focus-visible::before {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 28%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, var(--app-bg, #fff));
}
.task-detail__modal-icon-action.ant-btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--app-primary, #1677ff) 55%, transparent);
  outline-offset: -4px;
}
.task-detail__modal-icon-action :deep(.anticon) {
  position: relative;
  z-index: 1;
  font-size: 15px;
}
.task-detail__modal-icon-action--close.ant-btn:hover,
.task-detail__modal-icon-action--close.ant-btn:focus-visible {
  color: #d92d20;
}
.task-detail__modal-icon-action--close.ant-btn:hover::before,
.task-detail__modal-icon-action--close.ant-btn:focus-visible::before {
  border-color: color-mix(in srgb, #d92d20 26%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #d92d20 7%, var(--app-bg, #fff));
}
.task-detail__artifact-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
}
.task-detail__artifact-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.task-detail__artifact-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.task-detail__artifact-copy strong {
  font-size: 14px;
  line-height: 1.4;
  color: var(--app-text, #1f2937);
}
.task-detail__artifact-copy small {
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-muted, #667085);
}
.task-detail__artifact-browser {
  flex: 1 1 auto;
  min-height: 0;
}
.task-detail__artifact-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
}
.task-detail__requirement-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}
.task-detail__requirement-modal-shell {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
}
.task-detail__requirement-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.task-detail__requirement-modal-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.task-detail__requirement-modal-copy strong {
  font-size: 14px;
  line-height: 1.5;
  color: var(--app-text, #1f2937);
}
.task-detail__requirement-modal-copy small {
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-muted, #667085);
}
.task-detail__requirement-section {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: color-mix(in srgb, var(--app-bg, #fff) 94%, #f7f9fc);
}
.task-detail__requirement-section span {
  font-size: 12px;
  font-weight: 600;
  color: color-mix(in srgb, var(--app-text, #1f2937) 82%, #4b5563);
}
.task-detail__requirement-section p {
  margin: 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--app-text, #334155);
  white-space: pre-wrap;
}
.task-detail__list--full {
  max-height: none;
  padding-right: 0;
}
.task-detail__requirement-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex: 0 0 auto;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 86%, transparent);
}

@media (max-width: 1100px) {
  .task-panel__grid,
  .task-detail__grid {
    grid-template-columns: 1fr;
  }
  .task-detail__grid {
    height: auto;
    grid-template-rows: minmax(320px, 1fr) auto;
  }
  .task-detail__kv {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .task-detail__section-head,
  .task-detail__planner-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .task-detail__modal-titlebar {
    align-items: flex-start;
    flex-direction: column;
  }
  .task-detail__modal-title-actions {
    width: 100%;
    justify-content: flex-end;
  }
  .task-detail__modal-titlebar--requirement {
    align-items: center;
    flex-direction: row;
  }
  .task-detail__modal-titlebar--requirement .task-detail__modal-title-actions--icon {
    width: auto;
    margin-left: auto;
  }
  .task-detail__summary-layout {
    flex-direction: column;
    align-items: stretch;
  }
  .task-detail__artifact-toolbar,
  .task-detail__header-side {
    align-items: stretch;
  }
  .task-detail__meta {
    text-align: left;
  }
  .task-detail__instance-switcher {
    width: 100%;
    flex-direction: column;
    align-items: stretch;
  }
  .task-detail__instance-select {
    min-width: 0;
    width: 100%;
  }
  .task-detail__role-override-fields {
    grid-template-columns: 1fr;
  }
  .task-detail__role-override-batch-head,
  .task-detail__role-override-batch-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .task-detail__role-override-batch-fields {
    grid-template-columns: 1fr;
  }
  .task-detail__role-override-batch-actions .task-detail__ghost {
    width: 100%;
  }
  .task-detail__assignee-toolbar {
    align-items: stretch;
  }
  .task-detail__assignee-toolbar-template,
  .task-detail__assignee-toolbar-batch {
    flex: 1 1 100%;
    min-width: 0;
  }
  .task-detail__assignee-row {
    grid-template-columns: 1fr;
    align-items: stretch;
  }
  .task-detail__assignee-select-wrap {
    flex-wrap: wrap;
  }
  .task-detail__actions {
    justify-content: flex-start;
  }
}

@media (max-width: 640px) {
  .task-detail__modal-titlebar--requirement {
    min-height: 52px;
  }
  .task-detail__modal-icon-action--fullscreen {
    display: none !important;
  }
}

:root[data-theme="dark"] .task-panel__card,
:root[data-theme="dark"] .task-detail__card,
:root[data-theme="dark"] .task-detail__link-row,
:root[data-theme="dark"] .task-detail__preview-item,
:root[data-theme="dark"] .task-detail__requirement-section {
  border-color: #303030;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.01));
}
:root[data-theme="dark"] .task-panel__input,
:root[data-theme="dark"] .task-panel__textarea,
:root[data-theme="dark"] .task-panel__select {
  /* 暗色：用比 panel-bg 稍暗的混色作底，区别于面板，避免之前钢蓝渐变跟暖灰主题冲突 */
  background: color-mix(in srgb, var(--app-bg) 55%, var(--app-panel-bg));
  border-color: var(--app-border);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28);
}
:root[data-theme="dark"] .task-panel__submit {
  background: rgba(22, 119, 255, 0.12);
  color: #8eb7ff;
}
:root[data-theme="dark"] .task-panel__submit--execute {
  border-color: color-mix(in srgb, var(--app-accent) 78%, #f6ad8c);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--app-accent) 86%, #f6ad8c 14%),
    color-mix(in srgb, var(--app-accent) 92%, #6b2b1c 8%)
  );
  color: #fff7ed;
  box-shadow: 0 10px 22px color-mix(in srgb, var(--app-accent) 18%, transparent);
}
:root[data-theme="dark"] .task-panel__submit--execute:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-accent) 70%, #ffd0b8);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--app-accent) 78%, #ffd0b8 22%),
    color-mix(in srgb, var(--app-accent) 90%, #6b2b1c 10%)
  );
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .task-panel__submit--execute {
    border-color: color-mix(in srgb, var(--app-accent) 78%, #f6ad8c);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--app-accent) 86%, #f6ad8c 14%),
      color-mix(in srgb, var(--app-accent) 92%, #6b2b1c 8%)
    );
    color: #fff7ed;
    box-shadow: 0 10px 22px color-mix(in srgb, var(--app-accent) 18%, transparent);
  }
  :root:not([data-theme]) .task-panel__submit--execute:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--app-accent) 70%, #ffd0b8);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--app-accent) 78%, #ffd0b8 22%),
      color-mix(in srgb, var(--app-accent) 90%, #6b2b1c 10%)
    );
  }
}
:root[data-theme="dark"] .task-detail__ghost {
  background: #16181d;
}
:root[data-theme="dark"] .task-detail__ghost--priority {
  background: rgba(22, 119, 255, 0.18);
  color: #9cc2ff;
  border-color: rgba(22, 119, 255, 0.34);
}
:root[data-theme="dark"] .task-detail__ghost--danger {
  color: #ff9c9c;
  border-color: rgba(255, 77, 79, 0.42);
}
:root[data-theme="dark"] .task-detail__ghost--danger:hover {
  background: rgba(255, 77, 79, 0.12);
}
:root[data-theme="dark"] .task-detail__assignee-toolbar {
  border-color: #303644;
  background: rgba(255, 255, 255, 0.02);
}
:root[data-theme="dark"] .task-detail__assignee-saveas {
  background: rgba(22, 119, 255, 0.08);
  border-color: rgba(22, 119, 255, 0.38);
}
:root[data-theme="dark"] .task-detail__chip-btn {
  background: var(--app-panel-bg);
  border-color: var(--app-border);
  color: var(--app-text);
}
:root[data-theme="dark"] .task-detail__chip-btn:hover:not(:disabled) {
  border-color: rgba(22, 119, 255, 0.5);
  color: #8eb7ff;
}
:root[data-theme="dark"] .task-detail__chip-btn--danger {
  color: #ff9c9c;
  border-color: rgba(255, 77, 79, 0.34);
}
:root[data-theme="dark"] .task-detail__chip-btn--danger:hover:not(:disabled) {
  background: rgba(255, 77, 79, 0.12);
}
:root[data-theme="dark"] .task-detail__assignee-row:hover {
  background: rgba(22, 119, 255, 0.06);
}
:root[data-theme="dark"] .task-detail__assignee-row--unfilled {
  background: rgba(255, 77, 79, 0.08);
  border-color: rgba(255, 77, 79, 0.36);
}
:root[data-theme="dark"] .task-detail__assignee-progress {
  background: rgba(255, 255, 255, 0.06);
  color: var(--app-muted);
}
:root[data-theme="dark"] .task-detail__assignee-progress--ready {
  background: rgba(82, 196, 26, 0.16);
  color: #95de64;
}
:root[data-theme="dark"] .task-detail__assignee-dirty-tag,
:root[data-theme="dark"] .task-detail__assignee-unfilled-hint {
  color: #ff9c9c;
}
:root[data-theme="dark"] .task-panel__note {
  background: #1a2230;
}
/* 暗色 chip：用 accent 主题色染底 + accent 文字，统一覆盖前面 submit 块里写的钢蓝色 */
:root[data-theme="dark"] .task-detail__chip {
  background: color-mix(in srgb, var(--app-accent) 22%, var(--app-panel-bg));
  color: color-mix(in srgb, var(--app-accent) 60%, var(--app-text));
}
/* 暗色 planner-action-btn：default/active 都用 panel-bg，仅靠 accent 边/字/角标做层级 */
:root[data-theme="dark"] .task-detail__planner-action-btn {
  background: var(--app-panel-bg);
  border-color: color-mix(in srgb, var(--app-accent) 22%, var(--app-border));
  color: var(--app-muted);
}
:root[data-theme="dark"] .task-detail__planner-action-btn:hover {
  background: var(--app-panel-bg);
  border-color: color-mix(in srgb, var(--app-accent) 50%, var(--app-border));
  color: color-mix(in srgb, var(--app-accent) 60%, var(--app-text));
}
:root[data-theme="dark"] .task-detail__planner-action-btn--active {
  background: var(--app-panel-bg);
  border-color: color-mix(in srgb, var(--app-accent) 60%, var(--app-border));
  color: color-mix(in srgb, var(--app-accent) 70%, var(--app-text));
}
:root[data-theme="dark"] .task-detail__planner-action-btn--active:hover {
  background: var(--app-panel-bg);
  border-color: color-mix(in srgb, var(--app-accent) 75%, var(--app-border));
}
/* 暗色默认角标：用 app-bg（比 panel-bg 更暗的暖灰）做凹陷感 */
:root[data-theme="dark"] .task-detail__planner-action-count {
  background: var(--app-bg);
  color: color-mix(in srgb, var(--app-accent) 65%, var(--app-muted));
}
:root[data-theme="dark"] .task-detail__planner-action-btn--active .task-detail__planner-action-count {
  background: var(--app-accent);
  color: #fff;
}
:root[data-theme="dark"] .task-detail__ghost-badge {
  background: rgba(22, 119, 255, 0.16);
  color: #8eb7ff;
}
:root[data-theme="dark"] .task-panel__field span,
:root[data-theme="dark"] .task-detail__kv span {
  color: #d6dbe4;
}
:root[data-theme="dark"] .task-detail__inline-toggle {
  background: rgba(22, 119, 255, 0.12);
  color: #8eb7ff;
  border-color: rgba(22, 119, 255, 0.28);
}
:root[data-theme="dark"] .task-detail__modal-titlebar--requirement .task-detail__modal-titletext {
  color: #f3f4f6;
}
:root[data-theme="dark"] .task-detail__modal-icon-action.ant-btn {
  color: #d6dbe4;
}
:root[data-theme="dark"] .task-detail__modal-icon-action.ant-btn:hover,
:root[data-theme="dark"] .task-detail__modal-icon-action.ant-btn:focus-visible {
  color: #8eb7ff;
}
:root[data-theme="dark"] .task-detail__modal-icon-action.ant-btn:hover::before,
:root[data-theme="dark"] .task-detail__modal-icon-action.ant-btn:focus-visible::before {
  border-color: #3b4c63;
  background: rgba(22, 119, 255, 0.12);
}
:root[data-theme="dark"] .task-detail__modal-icon-action--close.ant-btn:hover,
:root[data-theme="dark"] .task-detail__modal-icon-action--close.ant-btn:focus-visible {
  color: #ff9c9c;
}
:root[data-theme="dark"] .task-detail__modal-icon-action--close.ant-btn:hover::before,
:root[data-theme="dark"] .task-detail__modal-icon-action--close.ant-btn:focus-visible::before {
  border-color: rgba(255, 77, 79, 0.42);
  background: rgba(255, 77, 79, 0.12);
}
:root[data-theme="dark"] .task-detail__help-btn {
  background: rgba(22, 119, 255, 0.12);
  color: #8eb7ff;
  border-color: rgba(22, 119, 255, 0.28);
}
:root[data-theme="dark"] .task-detail__help-popover,
:root[data-theme="dark"] .task-detail__help-popover strong {
  color: #d6dbe4;
}
:root[data-theme="dark"] .task-panel__modal-copy {
  color: #9fb0c2;
}
:root[data-theme="dark"] .task-detail__meta,
:root[data-theme="dark"] .task-detail__artifact-copy small,
:root[data-theme="dark"] .task-detail__requirement-modal-copy small,
:root[data-theme="dark"] .task-detail__summary-copy {
  color: #9fb0c2;
}
:root[data-theme="dark"] .task-detail__artifact-copy strong,
:root[data-theme="dark"] .task-detail__requirement-modal-copy strong,
:root[data-theme="dark"] .task-detail__requirement-section p {
  color: #f3f4f6;
}
</style>

<style>
.task-detail__requirement-modal-wrap {
  display: flex !important;
  align-items: flex-start;
  justify-content: center;
  overflow: hidden !important;
  padding: 20px 0;
}

.task-detail__requirement-modal-wrap .ant-modal {
  width: min(1080px, calc(100vw - 32px)) !important;
  max-width: min(1080px, calc(100vw - 32px)) !important;
  height: calc(100dvh - 40px) !important;
  min-height: calc(100dvh - 40px) !important;
  max-height: calc(100dvh - 40px) !important;
  margin: 0 auto;
  top: 0;
  padding-bottom: 0;
}

.task-detail__requirement-modal-wrap .ant-modal-content {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.task-detail__requirement-modal-wrap .ant-modal-header {
  flex: 0 0 auto;
  min-height: 56px;
  padding: 0 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 86%, transparent);
}

.task-detail__requirement-modal-wrap .ant-modal-title {
  width: 100%;
  min-width: 0;
}

@media (max-width: 640px) {
  .task-detail__requirement-modal-wrap .ant-modal-header {
    min-height: 52px;
  }
}

.task-detail__requirement-modal-wrap .ant-modal-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden !important;
}

.task-detail__requirement-modal-wrap--fullscreen {
  padding: 0;
}

.task-detail__requirement-modal-wrap--fullscreen .ant-modal {
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100dvh !important;
  min-height: 100dvh !important;
  max-height: 100dvh !important;
  margin: 0 !important;
  top: 0 !important;
  padding-bottom: 0 !important;
}

.task-detail__requirement-modal-wrap--fullscreen .ant-modal-content {
  border-radius: 0;
  height: 100dvh !important;
  max-height: 100dvh !important;
}

.task-detail__requirement-modal-wrap--fullscreen .ant-modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden !important;
}

.task-detail__artifact-modal-wrap {
  display: flex !important;
  align-items: flex-start;
  justify-content: center;
  overflow: hidden !important;
  padding: 20px 0;
}

.task-detail__artifact-modal-wrap .ant-modal {
  width: min(1760px, calc(100vw - 32px)) !important;
  max-width: min(1760px, calc(100vw - 32px)) !important;
  height: calc(100dvh - 40px) !important;
  min-height: calc(100dvh - 40px) !important;
  max-height: calc(100dvh - 40px) !important;
  margin: 0 auto;
  top: 0;
  padding-bottom: 0;
}

.task-detail__artifact-modal-wrap .ant-modal-content {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.task-detail__artifact-modal-wrap .ant-modal-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden !important;
}

.task-detail__artifact-modal-wrap--fullscreen {
  padding: 0;
}

.task-detail__artifact-modal-wrap--fullscreen .ant-modal {
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100dvh !important;
  min-height: 100dvh !important;
  max-height: 100dvh !important;
  margin: 0 !important;
  top: 0 !important;
  padding-bottom: 0 !important;
}

.task-detail__artifact-modal-wrap--fullscreen .ant-modal-content {
  border-radius: 0;
  height: 100dvh !important;
  max-height: 100dvh !important;
}

.task-detail__artifact-modal-wrap--fullscreen .ant-modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden !important;
}
</style>
