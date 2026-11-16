<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { DeleteOutlined, EyeInvisibleOutlined, EyeOutlined, FileTextOutlined, Loading3QuartersOutlined, PlusOutlined, ReloadOutlined, RobotOutlined, SearchOutlined } from "@ant-design/icons-vue";
import { message, Modal } from "ant-design-vue";
import { getTaskIntakeTitle, type EngineType, type IntakeId, type OrchestrationStatus, type PendingMineListStatus, type RequirementAnalysisSession, type RequirementDraftListStatus, type TaskIntakeListStatus, type WorkspaceId } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { isApiResultError, isCancelledRequestError } from "../../../api/request";
import { isConversationActivelyProcessing } from "../../chat/chatTypes";
import { useChatStore } from "../../../store/chat";
import { useConfigStore } from "../../../store/config";
import { OrchIntakeDeleteConflictError, useOrchestrationStore } from "../../../store/orchestration";
import { holdRefreshFeedback } from "../../../utils/refreshFeedback";
import { usePresenceStore } from "../../../store/presence";
import { resolveRequirementAnalysisRuntimeThreadId, useRequirementAnalysisStore } from "../../../store/requirementAnalysis";
import { useReminderStore } from "../../../store/reminders";
import { useSharedWorkspacesStore } from "../../../store/sharedWorkspaces";
import { useWorkspacesStore } from "../../../store/workspaces";
import { notifyWorkspaceClientOffline, resolveWorkspaceRuntimeUnavailableMessage } from "../../../utils/clientOfflineNotice";
import { isSharedWorkspaceSelectionId, parseSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { deriveIntakeRunSummary, type IntakeRunSummary } from "../task-intake-run-summary";
import CreateThreadModal from "../../threads/components/create-thread-modal.vue";
import { useCreateThreadEngineAvailability } from "../../threads/useCreateThreadEngineAvailability";

defineOptions({ name: "TaskEntrySidebar" });

const props = defineProps<{ workspaceId: WorkspaceId }>();

const chat = useChatStore();
const config = useConfigStore();
const orch = useOrchestrationStore();
const presence = usePresenceStore();
const analysis = useRequirementAnalysisStore();
const reminders = useReminderStore();
const sharedWorkspaces = useSharedWorkspacesStore();
const workspaces = useWorkspacesStore();
const { ctx } = useApiContext();
const searchText = ref("");
const workspaceRuntimeLoadingText = computed(() => {
  const runtime = presence.activeWorkspaceRuntimeState;
  if (runtime.kind !== "shared") return "等待 Client 连接后加载...";
  if (runtime.status === "unknown") return "正在确认共享 Host 状态...";
  if (runtime.status === "unbound") return "等待共享 Host 绑定后加载...";
  if (runtime.status === "forbidden") return "共享工作区当前不可用";
  return "等待共享 Host 连接后加载...";
});

/** 显示当前工作区运行时不可用提示，并区分本地 Client 与共享 Host。 */
function notifyWorkspaceRuntimeUnavailable(local: string, sharedOffline: string): void {
  notifyWorkspaceClientOffline(resolveWorkspaceRuntimeUnavailableMessage(
    presence.activeWorkspaceRuntimeState,
    { local, sharedOffline },
  ));
}
const serverSearchText = ref("");
const selectedDraftStatuses = ref<RequirementDraftListStatus[]>([]);
const selectedIntakeStatuses = ref<TaskIntakeListStatus[]>([]);
const selectedScheduledStatuses = ref<TaskIntakeListStatus[]>([]);
const selectedPendingMineStatuses = ref<PendingMineListStatus[]>([]);
const listRef = ref<HTMLElement | null>(null);
const listScrollTop = ref(0);
const listViewportHeight = ref(0);
type SelectedDraftTarget = { sessionId: string; title: string };
type SelectedIntakeTarget = { intakeId: IntakeId; title: string };
type IntakeListItem = (typeof orch.intakes | typeof orch.scheduledIntakes)[number];
type SidebarTab = "drafts" | "intakes" | "scheduledIntakes" | "pendingMine";
type StatusSelectOption = { label: string; value: string };
type VirtualListState<T> = { items: T[]; topPad: number; bottomPad: number };

const selectedDraftTargets = ref<SelectedDraftTarget[]>([]);
const selectedIntakeTargets = ref<SelectedIntakeTarget[]>([]);
const draftCreateOpen = ref(false);
const draftCreating = ref(false);
const searchDebounceTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const pendingMineMode = ref(false);
const intakeTabMode = ref<"intakes" | "scheduledIntakes">("intakes");
const isSharedWorkspace = computed(() => isSharedWorkspaceSelectionId(props.workspaceId));
const sharedWorkspaceId = computed(() => parseSharedWorkspaceSelectionId(String(props.workspaceId ?? "")));
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
const { disabledEngines: draftDisabledEngines, refreshEngineAvailability } = useCreateThreadEngineAvailability(computed(() => props.workspaceId));

// 不再做本地分页:列表全部 filtered 数据一次性渲染,「加载更多」仅在后端确实还有未拉取数据时显示
const activeSidebarTab = computed<SidebarTab>(() =>
  analysis.viewMode === "analysis"
    ? "drafts"
    : (pendingMineMode.value && isSharedWorkspace.value ? "pendingMine" : intakeTabMode.value),
);
/** segmented 双向绑定模型，setter 分发到原有 tab 切换方法以保持副作用一致。 */
const activeSidebarTabModel = computed<SidebarTab>({
  get: () => activeSidebarTab.value,
  set: (value) => {
    if (value === activeSidebarTab.value) return;
    if (value === "drafts") openDraftTab();
    else if (value === "pendingMine") openPendingMineTab();
    else if (value === "scheduledIntakes") openScheduledIntakeTab();
    else openIntakeTab();
  },
});
const baseSidebarTabOptions = [
  { label: "原始需求", value: "drafts" as const },
  { label: "需求编排", value: "intakes" as const },
  { label: "定时任务", value: "scheduledIntakes" as const },
];
const sidebarTabOptions = computed(() =>
  isSharedWorkspace.value
    ? [...baseSidebarTabOptions, { label: "待我处理", value: "pendingMine" as const }]
    : baseSidebarTabOptions,
);
const currentWorkspace = computed(() => workspaces.byId.get(props.workspaceId) ?? null);
const currentSharedRole = computed(() =>
  currentWorkspace.value?.capabilities?.effectiveAssetRole
  ?? currentWorkspace.value?.shared?.effectiveAssetRole
  ?? currentWorkspace.value?.shared?.currentUserRole
  ?? null,
);
const sharedRoleResolved = computed(() => currentSharedRole.value != null);
const isSharedMemberView = computed(() => currentSharedRole.value === "member");
const showSharedRelationFilter = computed(() =>
  isSharedWorkspace.value && isSharedMemberView.value,
);
const sharedOnlyRelatedToMe = computed({
  get: () => activeSidebarTab.value === "drafts" ? analysis.sessionListOnlyRelatedToMe : orch.intakeListOnlyRelatedToMe,
  set: (value: boolean) => {
    analysis.sessionListOnlyRelatedToMe = value;
    orch.intakeListOnlyRelatedToMe = value;
  },
});
/** 「待我处理」tab 本身就只展示与我相关的需求，「只看我」按钮在此 tab 下需锁定为开启态且不可切换，避免按钮消失导致头部抖动。 */
const isScopeChipForcedOn = computed(() => activeSidebarTab.value === "pendingMine");
/** 「只看我」按钮的视觉开启态：pendingMine 锁定为开，其余 tab 跟随用户开关。 */
const scopeChipDisplayOn = computed(() => isScopeChipForcedOn.value || sharedOnlyRelatedToMe.value);
/** 管理员默认读取全部共享需求上下文；普通成员才使用“只看与我有关”过滤。 */
const effectiveSharedOnlyRelatedToMe = computed(() =>
  isSharedWorkspace.value ? (!sharedRoleResolved.value ? true : (isSharedMemberView.value ? sharedOnlyRelatedToMe.value : false)) : null,
);

/** 切换共享工作区“只看我”筛选；待我处理 tab 下保持锁定开启。 */
function toggleSharedRelationFilter(): void {
  if (isScopeChipForcedOn.value) return;
  sharedOnlyRelatedToMe.value = !sharedOnlyRelatedToMe.value;
}

const filteredSessions = computed(() => analysis.sessions);
const visibleSessions = computed(() => draftVirtualList.value.items);
const filteredIntakes = computed(() => activeSidebarTab.value === "scheduledIntakes" ? orch.scheduledIntakes : orch.intakes);
const filteredVisibleIntakes = computed(() =>
  activeSidebarTab.value === "pendingMine"
    ? orch.pendingMineItems.map((item) => item.intake)
    : filteredIntakes.value,
);
const visibleIntakes = computed(() => intakeVirtualList.value.items);
// hasMore 只取决于后端是否还有未拉取数据,本地数据再多也不再显示「加载更多」
const hasMore = computed(() =>
  activeSidebarTab.value === "drafts"
    ? analysis.sessionsHasMore
    : activeSidebarTab.value === "pendingMine" ? orch.pendingMineHasMore : activeSidebarTab.value === "scheduledIntakes" ? orch.scheduledIntakesHasMore : orch.intakesHasMore,
);
const loadingMore = computed(() =>
  activeSidebarTab.value === "drafts"
    ? analysis.sessionsLoadingMore
    : activeSidebarTab.value === "pendingMine" ? orch.pendingMineLoadingMore : activeSidebarTab.value === "scheduledIntakes" ? orch.scheduledIntakesLoadingMore : orch.intakesLoadingMore,
);
const intakeListLoading = computed(() =>
  activeSidebarTab.value === "pendingMine" ? orch.pendingMineLoading : activeSidebarTab.value === "scheduledIntakes" ? orch.scheduledIntakesLoading : orch.intakesLoading,
);
const intakeListLength = computed(() =>
  activeSidebarTab.value === "pendingMine" ? orch.pendingMineItems.length : activeSidebarTab.value === "scheduledIntakes" ? orch.scheduledIntakes.length : orch.intakes.length,
);
const awaitingWorkspaceClient = computed(() =>
  !presence.isCurrentWorkspaceClientOnline
  && orch.intakes.length === 0
  && orch.scheduledIntakes.length === 0
  && analysis.sessions.length === 0
  && !orch.intakesLoading
  && !orch.scheduledIntakesLoading
  && !analysis.sessionsLoading
  && !searchText.value.trim(),
);
const runSummaryByIntakeId = computed(() =>
  new Map(
    [...orch.intakes, ...orch.scheduledIntakes].map((intake) => [intake.id, deriveIntakeRunSummary(intake.id, orch.instanceSummaries)] as const),
  ),
);
const pendingMineByIntakeId = computed(() =>
  new Map(orch.pendingMineItems.map((item) => [String(item.intake.id), item] as const)),
);
const instanceCountByIntakeId = computed(() =>
  Object.entries(orch.instanceTotalCountByIntake).reduce((map, [intakeId, count]) => {
    map.set(intakeId as IntakeId, count);
    return map;
  }, orch.instanceSummaries.reduce((map, instance) => {
    map.set(instance.intakeId, (map.get(instance.intakeId) ?? 0) + 1);
    return map;
  }, new Map<IntakeId, number>())),
);
const shouldShowPendingInstanceCount = computed(() =>
  orch.instancesLoading && orch.instanceSummaries.length === 0,
);
const currentSearchPlaceholder = computed(() =>
  activeSidebarTab.value === "drafts"
    ? "搜索需求..."
    : activeSidebarTab.value === "pendingMine" ? "搜索待我处理..." : activeSidebarTab.value === "scheduledIntakes" ? "搜索定时编排..." : "搜索需求...",
);
const currentStatusOptions = computed<StatusSelectOption[]>(() => {
  const counts = activeSidebarTab.value === "drafts"
    ? analysis.sessionStatusCounts
    : activeSidebarTab.value === "pendingMine"
      ? orch.pendingMineStatusCounts
      : activeSidebarTab.value === "scheduledIntakes"
        ? orch.scheduledIntakeStatusCounts
        : orch.intakeStatusCounts;
  return counts.map((item) => ({
    value: item.status,
    label: `${item.label} ${item.count}`,
  }));
});
const currentSelectedStatuses = computed<string[]>({
  get: () => {
    if (activeSidebarTab.value === "drafts") return selectedDraftStatuses.value;
    if (activeSidebarTab.value === "pendingMine") return selectedPendingMineStatuses.value;
    if (activeSidebarTab.value === "scheduledIntakes") return selectedScheduledStatuses.value;
    return selectedIntakeStatuses.value;
  },
  set: (value) => {
    const normalized = Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
    if (activeSidebarTab.value === "drafts") selectedDraftStatuses.value = normalized as RequirementDraftListStatus[];
    else if (activeSidebarTab.value === "pendingMine") selectedPendingMineStatuses.value = normalized as PendingMineListStatus[];
    else if (activeSidebarTab.value === "scheduledIntakes") selectedScheduledStatuses.value = normalized as TaskIntakeListStatus[];
    else selectedIntakeStatuses.value = normalized as TaskIntakeListStatus[];
  },
});
const currentTotalCount = computed(() =>
  activeSidebarTab.value === "drafts"
    ? analysis.sessionTotalCount
    : activeSidebarTab.value === "pendingMine"
      ? orch.pendingMineTotalCount
      : activeSidebarTab.value === "scheduledIntakes"
        ? orch.scheduledIntakeTotalCount
        : orch.intakeTotalCount,
);
const statusSelectPlaceholder = computed(() => `全部 ${currentTotalCount.value || 0}`);
const virtualRowHeight = computed(() => activeSidebarTab.value === "drafts" ? 86 : 88);
const draftVirtualList = computed(() => buildVirtualList(filteredSessions.value, virtualRowHeight.value));
const intakeVirtualList = computed(() => buildVirtualList(filteredVisibleIntakes.value, virtualRowHeight.value));
const selectedStatusLabels = computed(() => {
  const labelByValue = new Map(currentStatusOptions.value.map((item) => [item.value, item.label.replace(/\s+\d+$/, "")] as const));
  return currentSelectedStatuses.value.map((value) => ({ value, label: labelByValue.get(value) ?? value }));
});
const emptyIntakeText = computed(() => {
  if (activeSidebarTab.value === "pendingMine") {
    return searchText.value.trim() ? "没有匹配的待处理需求" : "暂无待你处理的需求";
  }
  if (activeSidebarTab.value === "scheduledIntakes") {
    return searchText.value.trim() ? "没有匹配的定时编排" : "暂无定时编排";
  }
  return searchText.value.trim() ? "没有匹配的正式需求" : "暂无需求记录";
});
const selectedDraftSessionIds = computed(() => selectedDraftTargets.value.map((target) => target.sessionId));
const selectedIntakeIds = computed(() => selectedIntakeTargets.value.map((target) => target.intakeId));
const selectedDraftSessionIdSet = computed(() => new Set(selectedDraftSessionIds.value));
const selectedIntakeIdSet = computed(() => new Set(selectedIntakeIds.value));
const selectedDraftCount = computed(() => selectedDraftTargets.value.length);
const selectedIntakeCount = computed(() => selectedIntakeTargets.value.length);
const currentSelectionCount = computed(() =>
  activeSidebarTab.value === "drafts" ? selectedDraftCount.value : selectedIntakeCount.value,
);
const currentSelectionLabel = computed(() =>
  activeSidebarTab.value === "drafts" ? "草稿" : activeSidebarTab.value === "scheduledIntakes" ? "定时编排" : "需求",
);
const initialInstancesLoading = computed(() => orch.instancesLoading && orch.instanceSummaries.length === 0);
const reminderByIntakeId = computed(() =>
  new Map(
    reminders.currentItems
      .filter((item) =>
        item.sourceType === "orchestration"
        && String(item.workspaceId ?? "").trim() === String(props.workspaceId ?? "").trim(),
      )
      .map((item) => [String(item.routeTarget.intakeId ?? ""), item] as const)
      .filter((entry) => Boolean(entry[0])),
  ),
);

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    discover: "待识别",
    clarify: "澄清中",
    split: "拆分中",
    recommend: "推荐中",
    confirm: "待创建",
    done: "已完成",
  };
  return labels[phase] ?? phase;
}

/** 草稿列表优先展示候选需求的聚合创建状态，避免会话阶段和候选状态口径不一致。 */
function draftStatusLabel(session: RequirementAnalysisSession): string {
  const meta = analysis.sessionListMetaById[String(session.id)];
  if (meta?.listStatusLabel) return meta.listStatusLabel;
  const candidateCount = sessionCandidateCount(session);
  const readyCount = sessionReadyCount(session);
  const createdCount = sessionCreatedCount(session);
  const pendingCount = sessionPendingCount(session);
  if (candidateCount > 0 && createdCount >= candidateCount) return "已创建";
  if (createdCount > 0) return "部分创建";
  if (readyCount > 0) return "待创建";
  if (pendingCount > 0) return "待澄清";
  return phaseLabel(session.phase);
}

function instanceCount(intakeId: IntakeId): number {
  const meta = intakeListMeta(intakeId);
  if (meta) return Number(meta.instanceCount ?? 0);
  return instanceCountByIntakeId.value.get(intakeId) ?? 0;
}

/** 需求列表里的执行次数在首次加载前可显示未知态，后续轮询保持稳定数字避免抖动。 */
function instanceCountLabel(intakeId: IntakeId): string {
  if (shouldShowPendingInstanceCount.value) return "...";
  return String(instanceCount(intakeId));
}

function intakeRunSummary(intakeId: IntakeId): IntakeRunSummary | null {
  const meta = intakeListMeta(intakeId);
  if (meta?.latestInstance?.runSummary) return meta.latestInstance.runSummary;
  return runSummaryByIntakeId.value.get(intakeId) ?? null;
}

/** 普通需求列表忽略查收提醒，查收态仅在个人提醒入口展示。 */
function intakeReminder(intakeId: IntakeId) {
  const pending = pendingMineByIntakeId.value.get(String(intakeId));
  const reminder = pending?.reminder ?? reminderByIntakeId.value.get(String(intakeId)) ?? null;
  if (activeSidebarTab.value !== "pendingMine" && reminder?.displayKind === "receipt") return null;
  return reminder;
}

/** 优先展示可操作关注态和运行摘要，并兼容过滤旧列表投影中的查收态。 */
function intakeStatusLabel(intakeId: IntakeId): string | null {
  const meta = intakeListMeta(intakeId);
  const summary = intakeRunSummary(intakeId);
  if (summary?.activeNodeStatus === "waiting-feedback") return summary.statusLabel;
  return intakeReminder(intakeId)?.statusLabel
    ?? (meta?.attentionStatus === "receipt" ? null : meta?.attentionLabel)
    ?? summary?.statusLabel
    ?? meta?.listStatusLabel
    ?? null;
}

/** 等待反馈节点沿用运行摘要色调，确保异常中断不会被通用提醒降为警告色。 */
function intakeStatusTone(intakeId: IntakeId): string {
  const summary = intakeRunSummary(intakeId);
  if (summary?.activeNodeStatus === "waiting-feedback") return summary.statusTone;
  return intakeReminder(intakeId)?.tone ?? summary?.statusTone ?? "neutral";
}

/** 读取需求卡片当前活跃节点的有效处理人；空数组表示当前没有可展示处理人。 */
function intakeAssigneeUserIds(intakeId: IntakeId): string[] {
  const source = intakeRunSummary(intakeId)?.activeNodeAssigneeUserIds;
  if (!Array.isArray(source)) return [];
  return Array.from(new Set(source.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

/** 把需求卡片处理人 ID 转成可读名称；缺资料时保留 ID 方便定位。 */
function formatIntakeAssigneeLabel(userId: string): string {
  return sharedMemberNameByUserId.value.get(userId) ?? formatCurrentUserLabel(userId) ?? userId;
}

/** 本地列表只能可靠识别当前登录账号，其他历史用户仍按 ID 展示。 */
function formatCurrentUserLabel(userId: string): string | null {
  const currentUserId = String(config.userSummary?.userId ?? "").trim();
  if (!currentUserId || currentUserId !== userId) return null;
  return String(config.userSummary?.fullName || config.userSummary?.email || currentUserId).trim() || currentUserId;
}

/** 压缩需求卡片处理人标签，避免多人配置挤占列表宽度。 */
function intakeAssigneeText(intakeId: IntakeId): string | null {
  const labels = intakeAssigneeUserIds(intakeId).map(formatIntakeAssigneeLabel);
  if (!labels.length) return null;
  if (labels.length <= 2) return `处理人 ${labels.join("、")}`;
  return `处理人 ${labels.slice(0, 2).join("、")} 等 ${labels.length} 人`;
}

/** 返回需求卡片处理人完整名单，用于鼠标悬停查看。 */
function intakeAssigneeTitle(intakeId: IntakeId): string {
  return intakeAssigneeUserIds(intakeId).map(formatIntakeAssigneeLabel).join("、");
}

function intakeListMeta(intakeId: IntakeId) {
  if (activeSidebarTab.value === "pendingMine") return pendingMineByIntakeId.value.get(String(intakeId))?.listMeta ?? null;
  if (activeSidebarTab.value === "scheduledIntakes") return orch.scheduledIntakeListMetaById[String(intakeId)] ?? null;
  return orch.intakeListMetaById[String(intakeId)] ?? null;
}

function sessionCandidateCount(session: RequirementAnalysisSession): number {
  return Number(session.candidateCount ?? 0);
}

function sessionReadyCount(session: RequirementAnalysisSession): number {
  return Number(session.readyCandidateCount ?? 0);
}

function sessionCreatedCount(session: RequirementAnalysisSession): number {
  return Number(session.createdCandidateCount ?? 0);
}

function sessionPendingCount(session: RequirementAnalysisSession): number {
  return Number(session.pendingCandidateCount ?? 0);
}

function isSessionRunning(session: RequirementAnalysisSession): boolean {
  const runtimeThreadId = resolveRequirementAnalysisRuntimeThreadId(session, session.id);
  if (!runtimeThreadId) return false;
  const displayConversation = chat.threadDisplayConversationForThread(runtimeThreadId as any);
  if (displayConversation) {
    return isConversationActivelyProcessing(displayConversation);
  }
  return Boolean(chat.threadDisplayRunningStateForThread(runtimeThreadId as any)?.runningTurnId);
}

/** 共享团队可见但非本人相关的需求/草稿只能查看，不能编辑、删除或执行。 */
function isReadonlySharedRecord(item: { readOnly?: boolean; sharedContext?: { readOnly?: boolean } | null }): boolean {
  return Boolean(item.readOnly || item.sharedContext?.readOnly);
}

function draftSummary(session: RequirementAnalysisSession): string {
  return session.latestTurnSummary || "等待开始梳理";
}

function draftMetricSummary(session: RequirementAnalysisSession): string {
  const metrics: string[] = [];
  const candidateCount = sessionCandidateCount(session);
  const readyCount = sessionReadyCount(session);
  const createdCount = sessionCreatedCount(session);
  const pendingCount = sessionPendingCount(session);

  if (candidateCount > 0) metrics.push(`候选 ${candidateCount}`);
  if (readyCount > 0) metrics.push(`可创建 ${readyCount}`);
  if (createdCount > 0) metrics.push(`已创建 ${createdCount}`);
  if (pendingCount > 0) metrics.push(`待澄清 ${pendingCount}`);

  return metrics.length > 0 ? metrics.join(" · ") : "等待 AI 开始梳理";
}

/** 原始需求列表推荐流程展示，优先消费服务端列表元数据。 */
function draftWorkflowLabel(session: RequirementAnalysisSession): string {
  return analysis.sessionListMetaById[String(session.id)]?.recommendedWorkflowName || "暂无推荐流程";
}

/** 编排列表关联流程展示，优先消费服务端列表元数据。 */
function intakeWorkflowLabel(intakeId: IntakeId): string {
  return intakeListMeta(intakeId)?.workflowName || "暂无关联流程";
}

function isDraftSelected(sessionId: string): boolean {
  return analysis.viewMode === "analysis" && sessionId === analysis.selectedSessionId;
}

function isDraftChecked(sessionId: string): boolean {
  return selectedDraftSessionIdSet.value.has(sessionId);
}

function isIntakeSelected(intakeId: IntakeId): boolean {
  return analysis.viewMode === "intakes" && intakeId === orch.selectedIntakeId;
}

function isIntakeChecked(intakeId: IntakeId): boolean {
  return selectedIntakeIdSet.value.has(intakeId);
}

function isActiveInstanceStatus(status: OrchestrationStatus): boolean {
  return status === "pending"
    || status === "running"
    || status === "paused"
    || status === "waiting-start"
    || status === "waiting-approval"
    || status === "waiting-feedback";
}

function openDraftTab() {
  pendingMineMode.value = false;
  analysis.openAnalysisMode();
}

function openIntakeTab() {
  pendingMineMode.value = false;
  intakeTabMode.value = "intakes";
  analysis.openIntakeMode();
}

function openScheduledIntakeTab() {
  pendingMineMode.value = false;
  intakeTabMode.value = "scheduledIntakes";
  analysis.openIntakeMode();
}

function openPendingMineTab() {
  pendingMineMode.value = true;
  intakeTabMode.value = "intakes";
  analysis.openIntakeMode();
}

function selectIntake(intakeId: IntakeId) {
  analysis.openIntakeMode();
  orch.intakeComposerOpen = false;
  orch.selectedIntakeId = intakeId;
  orch.selectedIntakeSnapshot = orch.intakes.find((intake) => intake.id === intakeId)
    ?? orch.scheduledIntakes.find((intake) => intake.id === intakeId)
    ?? pendingMineByIntakeId.value.get(String(intakeId))?.intake
    ?? null;
}

function handleDraftItemClick(sessionId: string) {
  void selectDraftSession(sessionId);
}

function handleIntakeItemClick(intakeId: IntakeId) {
  selectIntake(intakeId);
}

async function selectDraftSession(sessionId: string) {
  try {
    analysis.openAnalysisMode();
    orch.intakeComposerOpen = false;
    await analysis.loadSession(ctx.value, props.workspaceId, sessionId as any);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "读取需求分析草稿失败";
    if (await recoverMissingSession(messageText)) return;
    message.error(messageText);
  }
}

function openStatusAction(intakeId: IntakeId, event: Event): void {
  event.stopPropagation();
  const reminder = intakeReminder(intakeId);
  if (!reminder) return;
  selectIntake(intakeId);
  if (reminder.primaryActionKind === "open_orch_metric_review") {
    orch.dispatchUiIntent({ kind: "open_metric_review", intakeId, instanceId: null, nodeId: null });
    return;
  }
  const instanceId = String(reminder.routeTarget.instanceId ?? "").trim() || null;
  const nodeId = String(reminder.routeTarget.nodeId ?? "").trim() || null;
  if (reminder.primaryActionKind === "open_orch_primary_action") {
    orch.dispatchUiIntent({ kind: "open_primary_action", intakeId, instanceId: instanceId as any, nodeId });
    return;
  }
  if (reminder.primaryActionKind === "open_orch_artifacts") {
    orch.dispatchUiIntent({ kind: "open_artifacts", intakeId, instanceId: instanceId as any, nodeId });
    return;
  }
  if (reminder.primaryActionKind === "open_orch_monitor") {
    orch.dispatchUiIntent({ kind: "open_monitor", intakeId, instanceId: instanceId as any, nodeId });
  }
}

function newRequirement() {
  if (isSharedWorkspace.value) {
    orch.intakeListOnlyRelatedToMe = true;
  }
  intakeTabMode.value = "intakes";
  analysis.openIntakeMode();
  orch.openIntakeComposer();
}

/** 打开 AI 草稿创建弹框；Client 离线时只给合并提示。 */
let engineAvailabilityRequestGeneration = 0;
/** 仅在当前工作区弹框中处理本次模型检查，旧请求不污染新草稿。 */
function createRequirementDraft() {
  if (!presence.isCurrentWorkspaceClientOnline) {
    notifyWorkspaceRuntimeUnavailable(
      "当前工作区 Client 未连接，连接后才能创建需求分析草稿。",
      "共享工作区 Host 当前离线，连接后才能创建需求分析草稿。",
    );
    return;
  }
  if (isSharedWorkspace.value) {
    analysis.sessionListOnlyRelatedToMe = true;
  }
  draftCreateOpen.value = true;
  const workspaceId = props.workspaceId, generation = ++engineAvailabilityRequestGeneration;
  void refreshEngineAvailability().catch(error => {
    if (isCancelledRequestError(error) || props.workspaceId !== workspaceId || !draftCreateOpen.value || generation !== engineAvailabilityRequestGeneration) return;
    const details = isApiResultError(error) ? error.details as Record<string, unknown> | undefined : undefined;
    const rootCause = error instanceof Error ? error.message : String(error);
    console.error("[task-entry] engine availability failed", { errorCode: "ENGINE_AVAILABILITY_FAILED",
      requestId: details?.requestId ?? (error as { requestId?: string })?.requestId ?? null, workspaceId, rootCause });
    message.error(rootCause);
  });
}

/** 根据弹框提交的标题和引擎创建需求分析草稿。 */
async function onDraftCreateConfirm(payload: { engine: EngineType; title: string }) {
  if (draftCreating.value) return;
  try {
    draftCreating.value = true;
    await analysis.createSession(ctx.value, props.workspaceId, payload);
    orch.intakeComposerOpen = false;
    draftCreateOpen.value = false;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "创建需求分析草稿失败");
  } finally {
    draftCreating.value = false;
  }
}

function archiveSessionAction(sessionId: string, title: string, event: Event) {
  event.stopPropagation();
  const session = analysis.sessions.find((item) => item.id === sessionId);
  if (session && isReadonlySharedRecord(session)) {
    message.info("这条共享草稿只读，不能归档");
    return;
  }
  Modal.confirm({
    title: "归档需求分析草稿",
    content: `确定归档「${title}」吗？归档后会从当前草稿列表移除，但不会删除消息和候选需求；后续可从会话列表的“已归档”中恢复。`,
    okText: "归档",
    cancelText: "取消",
    async onOk() {
      try {
        await analysis.archiveSession(ctx.value, props.workspaceId, sessionId as any, "archived");
        message.success("已归档");
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "归档失败";
        if (await recoverMissingSession(messageText)) return;
        message.error(messageText);
      }
    },
  });
}

function deleteDraftSessionAction(sessionId: string, title: string, event: Event) {
  event.stopPropagation();
  const session = analysis.sessions.find((item) => item.id === sessionId);
  if (session && isReadonlySharedRecord(session)) {
    message.info("这条共享草稿只读，不能删除");
    return;
  }
  Modal.confirm({
    title: "删除需求分析草稿",
    content: `确定删除「${title}」吗？删除后会永久清除这条草稿会话的消息与候选需求，不会删除已经创建出来的正式需求或方案，且不可恢复。`,
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    async onOk() {
      await deleteDraftTargets([{ sessionId, title }]);
    },
  });
}

function confirmDelete(intakeId: IntakeId, title: string, event: Event) {
  event.stopPropagation();
  const intake = orch.intakes.find((item) => item.id === intakeId)
    ?? orch.scheduledIntakes.find((item) => item.id === intakeId);
  if (intake && isReadonlySharedRecord(intake)) {
    message.info("这条共享需求只读，不能删除");
    return;
  }
  confirmDeleteIntakes([{ intakeId, title }]);
}

function toggleDraftSelection(session: RequirementAnalysisSession) {
  if (isReadonlySharedRecord(session)) return;
  selectedDraftTargets.value = toggleSelectionTarget(
    selectedDraftTargets.value,
    session.id,
    () => ({ sessionId: session.id, title: session.title }),
    (target) => target.sessionId,
  );
}

function toggleIntakeSelection(intake: IntakeListItem) {
  if (isReadonlySharedRecord(intake)) return;
  selectedIntakeTargets.value = toggleSelectionTarget(
    selectedIntakeTargets.value,
    intake.id,
    () => ({ intakeId: intake.id, title: getTaskIntakeTitle(intake) }),
    (target) => target.intakeId,
  );
}

function confirmDeleteSelectedDrafts() {
  const targets = selectedDraftTargets.value.map((target) => ({ ...target }));
  if (!targets.length) return;
  Modal.confirm({
    title: "批量删除草稿",
    content: `确定删除选中的 ${targets.length} 条需求分析草稿吗？删除后会永久清除消息与候选需求，不会删除已经创建出来的正式需求或方案，且不可恢复。`,
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    async onOk() {
      await deleteDraftTargets(targets);
    },
  });
}

async function deleteDraftTargets(targets: Array<{ sessionId: string; title: string }>): Promise<void> {
  let removedCount = 0;
  const failedSessionIds = new Set<string>();
  const failures: string[] = [];
  for (const target of targets) {
    const session = analysis.sessions.find((item) => item.id === target.sessionId);
    if (session && isReadonlySharedRecord(session)) {
      failedSessionIds.add(target.sessionId);
      failures.push(`${target.title}：共享草稿只读`);
      continue;
    }
    try {
      await analysis.deleteSession(ctx.value, props.workspaceId, target.sessionId as any);
      removedCount += 1;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "删除草稿失败";
      if (await recoverMissingSession(messageText)) {
        removedCount += 1;
        continue;
      }
      failedSessionIds.add(target.sessionId);
      failures.push(`${target.title}：${messageText}`);
    }
  }
  selectedDraftTargets.value = targets.filter((target) => failedSessionIds.has(target.sessionId));
  if (removedCount > 0) {
    message.success(removedCount === 1 ? "草稿已删除" : `已删除 ${removedCount} 条草稿`);
  }
  if (failures.length > 0) {
    message.error(failures[0] ?? "批量删除草稿失败");
  }
}

function confirmDeleteSelectedIntakes() {
  const targets = selectedIntakeTargets.value.map((target) => ({ ...target }));
  if (!targets.length) return;
  confirmDeleteIntakes(targets);
}

function confirmDeleteIntakes(
  targets: Array<{ intakeId: IntakeId; title: string }>,
  options: {
    forceDeleteRunning?: boolean;
    alreadyRemovedCount?: number;
    alreadyCancelledCount?: number;
    retainedSelectionIds?: IntakeId[];
  } = {},
) {
  if (!targets.length) return;
  const readonlyTarget = targets.find((target) => {
    const intake = orch.intakes.find((item) => item.id === target.intakeId);
    return intake ? isReadonlySharedRecord(intake) : false;
  });
  if (readonlyTarget) {
    message.info(`需求「${readonlyTarget.title}」只读，不能删除`);
    return;
  }
  const activeTargets = targets.filter((target) => hasActiveInstancesForIntake(target.intakeId));
  const forceDeleteRunning = options.forceDeleteRunning ?? activeTargets.length > 0;
  const content = buildIntakeDeleteConfirmContent(targets, {
    forceDeleteRunning,
    activeTitles: activeTargets.map((target) => target.title),
    alreadyRemovedCount: options.alreadyRemovedCount ?? 0,
  });
  Modal.confirm({
    title: targets.length > 1 ? "批量删除需求" : "删除需求",
    content,
    okText: forceDeleteRunning ? "继续删除" : "删除",
    okType: "danger",
    cancelText: "取消",
    async onOk() {
      await deleteIntakeTargets(targets, {
        forceDeleteRunning,
        alreadyRemovedCount: options.alreadyRemovedCount ?? 0,
        alreadyCancelledCount: options.alreadyCancelledCount ?? 0,
        retainedSelectionIds: options.retainedSelectionIds ?? [],
      });
    },
  });
}

async function deleteIntakeTargets(
  targets: Array<{ intakeId: IntakeId; title: string }>,
  options: {
    forceDeleteRunning: boolean;
    alreadyRemovedCount?: number;
    alreadyCancelledCount?: number;
    retainedSelectionIds?: IntakeId[];
  },
): Promise<void> {
  const previousSelectedIntakeId = orch.selectedIntakeId;
  let removedCount = options.alreadyRemovedCount ?? 0;
  let cancelledCount = options.alreadyCancelledCount ?? 0;
  const conflicts: Array<{ intakeId: IntakeId; title: string }> = [];
  const failedTargets: Array<{ intakeId: IntakeId; title: string }> = [];
  const failures: string[] = [];
  for (const target of targets) {
    try {
      const res = await orch.removeIntake(ctx.value, props.workspaceId, target.intakeId, {
        forceDeleteRunning: options.forceDeleteRunning,
        preserveSelection: true,
      });
      removedCount += 1;
      cancelledCount += Number((res as { cancelledActiveInstanceCount?: number }).cancelledActiveInstanceCount ?? 0);
    } catch (error) {
      if (!options.forceDeleteRunning && error instanceof OrchIntakeDeleteConflictError) {
        conflicts.push(target);
        continue;
      }
      failedTargets.push(target);
      failures.push(`${target.title}：${error instanceof Error ? error.message : "删除需求失败"}`);
    }
  }

  if (conflicts.length > 0 && !options.forceDeleteRunning) {
    selectedIntakeTargets.value = mergeSelectedIntakeTargets(
      [...failedTargets, ...conflicts],
      options.retainedSelectionIds ?? [],
    );
    if (removedCount > 0) {
      message.success(formatIntakeDeleteSuccessMessage(removedCount, cancelledCount));
    }
    if (failures.length > 0) {
      message.error(failures[0] ?? "删除需求失败");
    }
    confirmDeleteIntakes(conflicts, {
      forceDeleteRunning: true,
      alreadyRemovedCount: 0,
      alreadyCancelledCount: 0,
      retainedSelectionIds: [...(options.retainedSelectionIds ?? []), ...failedTargets.map((target) => target.intakeId)],
    });
    return;
  }

  const unresolvedTargets = [...failedTargets, ...conflicts];
  selectedIntakeTargets.value = mergeSelectedIntakeTargets(unresolvedTargets, options.retainedSelectionIds ?? []);
  const removedTargetIds = new Set(targets.map((target) => target.intakeId));
  if (previousSelectedIntakeId && removedTargetIds.has(previousSelectedIntakeId) && !selectedIntakeIds.value.includes(previousSelectedIntakeId)) {
    const fallback = orch.intakes[0] ?? null;
    orch.selectedIntakeId = fallback?.id ?? null;
    orch.selectedIntakeSnapshot = fallback;
  }
  if (removedCount > 0) {
    message.success(formatIntakeDeleteSuccessMessage(removedCount, cancelledCount));
  }
  if (failures.length > 0) {
    message.error(failures[0] ?? "删除需求失败");
  }
}

function buildIntakeDeleteConfirmContent(
  targets: Array<{ intakeId: IntakeId; title: string }>,
  options: { forceDeleteRunning: boolean; activeTitles?: string[]; alreadyRemovedCount?: number },
): string {
  const prefix = options.alreadyRemovedCount && options.alreadyRemovedCount > 0
    ? `刚才已经删除 ${options.alreadyRemovedCount} 条需求。`
    : "";
  if (options.forceDeleteRunning) {
    const activeLabel = options.activeTitles?.length
      ? `其中仍在运行的需求：${options.activeTitles.join("、")}。`
      : "";
    return `${prefix}${targets.length > 1 ? `选中的 ${targets.length} 条需求` : `需求「${targets[0]!.title}」`}${activeLabel}继续删除会先主动停止相关执行，再删除需求下的方案、执行记录、结果索引、关联会话以及这些需求在会话里的工作流卡片，但不会自动回滚已写入工作区的代码或文档。`;
  }
  return `${prefix}${targets.length > 1 ? `确定删除选中的 ${targets.length} 条需求吗？` : `确定要删除需求「${targets[0]!.title}」吗？`}会同时删除这些需求下的方案、执行记录、结果索引、关联会话以及这些需求在会话里的工作流卡片，但不会自动回滚已写入工作区的代码或文档。`;
}

function formatIntakeDeleteSuccessMessage(removedCount: number, cancelledCount: number): string {
  const base = removedCount === 1 ? "需求已删除" : `已删除 ${removedCount} 条需求`;
  if (cancelledCount > 0) {
    return `${base}，并主动停止 ${cancelledCount} 个进行中的执行`;
  }
  return base;
}

function hasActiveInstancesForIntake(intakeId: IntakeId): boolean {
  return orch.instanceSummaries.some((instance) =>
    instance.intakeId === intakeId && isActiveInstanceStatus(instance.status));
}

function toggleSelectionTarget<T extends { [key: string]: unknown }, Id extends string>(
  targets: T[],
  id: Id,
  createTarget: () => T,
  getId: (target: T) => Id,
): T[] {
  return targets.some((target) => getId(target) === id)
    ? targets.filter((target) => getId(target) !== id)
    : [...targets, createTarget()];
}

function mergeSelectedIntakeTargets(
  unresolvedTargets: Array<{ intakeId: IntakeId; title: string }>,
  retainedSelectionIds: IntakeId[],
): SelectedIntakeTarget[] {
  const nextTargets = new Map<IntakeId, SelectedIntakeTarget>();
  for (const target of selectedIntakeTargets.value) {
    if (retainedSelectionIds.includes(target.intakeId)) {
      nextTargets.set(target.intakeId, target);
    }
  }
  for (const target of unresolvedTargets) {
    nextTargets.set(target.intakeId, { intakeId: target.intakeId, title: target.title });
  }
  return Array.from(nextTargets.values());
}

function clearCurrentSelection() {
  if (activeSidebarTab.value === "drafts") {
    selectedDraftTargets.value = [];
    return;
  }
  selectedIntakeTargets.value = [];
}

function confirmDeleteCurrentSelection() {
  if (activeSidebarTab.value === "drafts") {
    confirmDeleteSelectedDrafts();
    return;
  }
  confirmDeleteSelectedIntakes();
}

/** 刷新进行中：图标转圈展示过程，同时挡住重复点击。 */
const refreshing = ref(false);

/** 手动刷新需求和草稿；Client 离线时避免重复请求。 */
async function refreshWorkspace() {
  if (refreshing.value) return;
  if (!presence.isCurrentWorkspaceClientOnline) {
    notifyWorkspaceRuntimeUnavailable(
      "当前工作区 Client 未连接，连接后会自动加载需求和草稿。",
      "共享工作区 Host 当前离线，连接后会自动加载需求和草稿。",
    );
    return;
  }
  refreshing.value = true;
  const startedAt = Date.now();
  try {
    await refreshCurrentList();
  } catch (error) {
    message.error(error instanceof Error ? error.message : "刷新列表失败");
    return;
  } finally {
    // 请求常在几十毫秒内返回，补足最短时长让转圈看得见。
    await holdRefreshFeedback(startedAt);
    refreshing.value = false;
  }
  // 刷新通常瞬间完成，列表看不出变化，用提示告诉用户这次点击确实生效了。
  message.success("列表已刷新");
}

/** 按当前 Tab 的搜索、状态和共享范围刷新第一页。 */
async function refreshCurrentList(): Promise<void> {
  const search = serverSearchText.value.trim() || null;
  if (activeSidebarTab.value === "drafts") {
    await analysis.refreshSessions(ctx.value, props.workspaceId, {
      onlyRelatedToMe: effectiveSharedOnlyRelatedToMe.value,
      search,
      statuses: selectedDraftStatuses.value,
    });
    return;
  }
  if (activeSidebarTab.value === "scheduledIntakes") {
    await orch.refreshScheduledIntakes(ctx.value, props.workspaceId, {
      search,
      statuses: selectedScheduledStatuses.value,
    });
    return;
  }
  if (activeSidebarTab.value === "pendingMine") {
    await orch.refreshPendingMine(ctx.value, props.workspaceId, {
      onlyRelatedToMe: effectiveSharedOnlyRelatedToMe.value,
      search,
      statuses: selectedPendingMineStatuses.value,
    });
    return;
  }
  await orch.refreshIntakes(ctx.value, props.workspaceId, {
    onlyRelatedToMe: effectiveSharedOnlyRelatedToMe.value,
    search,
    statuses: selectedIntakeStatuses.value,
  });
}

function loadMore(): void {
  if (activeSidebarTab.value === "drafts") {
    if (!analysis.sessionsHasMore || analysis.sessionsLoadingMore) return;
    analysis.loadMoreSessions(ctx.value, props.workspaceId, {
      onlyRelatedToMe: effectiveSharedOnlyRelatedToMe.value,
      search: serverSearchText.value.trim() || null,
      statuses: selectedDraftStatuses.value,
    })
      .catch((error) => {
        message.error(error instanceof Error ? error.message : "加载更多草稿失败");
      });
    return;
  }
  if (activeSidebarTab.value === "scheduledIntakes") {
    if (!orch.scheduledIntakesHasMore || orch.scheduledIntakesLoadingMore) return;
    orch.loadMoreScheduledIntakes(ctx.value, props.workspaceId, {
      search: serverSearchText.value.trim() || null,
      statuses: selectedScheduledStatuses.value,
    })
      .catch((error) => {
        message.error(error instanceof Error ? error.message : "加载更多定时编排失败");
      });
    return;
  }
  if (activeSidebarTab.value === "pendingMine") {
    if (!orch.pendingMineHasMore || orch.pendingMineLoadingMore) return;
    orch.loadMorePendingMine(ctx.value, props.workspaceId, {
      onlyRelatedToMe: effectiveSharedOnlyRelatedToMe.value,
      search: serverSearchText.value.trim() || null,
      statuses: selectedPendingMineStatuses.value,
    })
      .catch((error) => {
        message.error(error instanceof Error ? error.message : "加载更多待我处理失败");
      });
    return;
  }
  if (!orch.intakesHasMore || orch.intakesLoadingMore) return;
  orch.loadMoreIntakes(ctx.value, props.workspaceId, {
    onlyRelatedToMe: effectiveSharedOnlyRelatedToMe.value,
    search: serverSearchText.value.trim() || null,
    statuses: selectedIntakeStatuses.value,
  })
    .catch((error) => {
      message.error(error instanceof Error ? error.message : "加载更多需求失败");
    });
}

function onListScroll(): void {
  const el = listRef.value;
  if (!el) return;
  listScrollTop.value = el.scrollTop;
  listViewportHeight.value = el.clientHeight;
  if (!hasMore.value) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
    loadMore();
  }
}

/** 计算侧栏列表窗口，避免几百上千条卡片同时挂载。 */
function buildVirtualList<T>(items: T[], rowHeight: number): VirtualListState<T> {
  const viewport = listViewportHeight.value || 600;
  const overscan = 8;
  const start = Math.max(0, Math.floor(listScrollTop.value / rowHeight) - overscan);
  const visibleCount = Math.ceil(viewport / rowHeight) + overscan * 2;
  const end = Math.min(items.length, start + visibleCount);
  return {
    items: items.slice(start, end),
    topPad: start * rowHeight,
    bottomPad: Math.max(0, (items.length - end) * rowHeight),
  };
}

function syncListViewport(): void {
  const el = listRef.value;
  listScrollTop.value = el?.scrollTop ?? 0;
  listViewportHeight.value = el?.clientHeight ?? 0;
}

async function recoverMissingSession(messageText: string): Promise<boolean> {
  if (!/需求分析会话不存在|thread 不存在/.test(messageText)) return false;
  await analysis.refreshSessions(ctx.value, props.workspaceId);
  message.warning("该需求分析草稿对应的底层会话已不存在，已从列表移除。");
  return true;
}

watch(searchText, () => {
  nextTick(() => {
    listRef.value?.scrollTo({ top: 0 });
  });
  if (searchDebounceTimer.value) clearTimeout(searchDebounceTimer.value);
  searchDebounceTimer.value = setTimeout(() => {
    serverSearchText.value = searchText.value.trim();
    if (!presence.isCurrentWorkspaceClientOnline) return;
    refreshCurrentList().catch((error) => {
      message.error(error instanceof Error ? error.message : "刷新列表失败");
    });
  }, 300);
});

watch(sharedOnlyRelatedToMe, async () => {
  if (!showSharedRelationFilter.value) return;
  selectedDraftTargets.value = [];
  selectedIntakeTargets.value = [];
  await refreshCurrentList();
});

watch(
  () => [activeSidebarTab.value, currentSelectedStatuses.value.join(","), props.workspaceId] as const,
  () => {
    if (!presence.isCurrentWorkspaceClientOnline) return;
    nextTick(() => {
      listRef.value?.scrollTo({ top: 0 });
    });
    refreshCurrentList().catch((error) => {
      message.error(error instanceof Error ? error.message : "刷新列表失败");
    });
  },
);

watch(() => [analysis.sessions.length, filteredVisibleIntakes.value.length] as const, () => {
  nextTick(syncListViewport);
});

watch(() => [props.workspaceId, currentSharedRole.value] as const, () => {
  if (!isSharedWorkspace.value) {
    pendingMineMode.value = false;
    return;
  }
  if (!sharedRoleResolved.value) return;
  const nextFilter = isSharedMemberView.value;
  orch.intakeListOnlyRelatedToMe = nextFilter;
  analysis.sessionListOnlyRelatedToMe = nextFilter;
}, { immediate: true });

watch(sharedWorkspaceId, (id) => {
  if (id && !sharedWorkspaces.membersByWorkspaceId[id]?.length) void sharedWorkspaces.loadMembers(id);
}, { immediate: true });

watch(
  () => analysis.sessions,
  (sessions) => {
    if (selectedDraftTargets.value.length === 0) return;
    const titleById = new Map(sessions.map((session) => [session.id, session.title] as const));
    selectedDraftTargets.value = selectedDraftTargets.value.map((target) => ({
      ...target,
      title: titleById.get(target.sessionId) ?? target.title,
    }));
  },
);

watch(
  () => [...orch.intakes, ...orch.scheduledIntakes],
  (intakes) => {
    if (selectedIntakeTargets.value.length === 0) return;
    const titleById = new Map(intakes.map((intake) => [intake.id, getTaskIntakeTitle(intake)] as const));
    selectedIntakeTargets.value = selectedIntakeTargets.value.map((target) => ({
      ...target,
      title: titleById.get(target.intakeId) ?? target.title,
    }));
  },
);

onMounted(() => {
  syncListViewport();
  listRef.value?.addEventListener("scroll", onListScroll, { passive: true });
  window.addEventListener("resize", syncListViewport, { passive: true });
});

onBeforeUnmount(() => {
  listRef.value?.removeEventListener("scroll", onListScroll);
  window.removeEventListener("resize", syncListViewport);
  if (searchDebounceTimer.value) clearTimeout(searchDebounceTimer.value);
});
</script>

<template>
  <div class="task-sidebar">
    <div class="thread-list__fixed task-sidebar__fixed">
      <div class="task-sidebar__top-row">
        <a-input
          v-model:value="searchText"
          class="thread-list__search-input task-sidebar__top-search"
          :placeholder="currentSearchPlaceholder"
          allow-clear
        >
          <template #prefix><SearchOutlined /></template>
        </a-input>
        <div class="task-sidebar__top-actions">
          <a-tooltip title="AI 创建需求" placement="bottom">
            <button
              type="button"
              class="task-sidebar__icon-btn task-sidebar__icon-btn--ai"
              aria-label="AI 创建需求"
              @click="createRequirementDraft"
            >
              <RobotOutlined />
              <span class="task-sidebar__icon-btn-text">AI</span>
            </button>
          </a-tooltip>
          <a-tooltip title="手工创建需求" placement="bottom">
            <button
              type="button"
              class="task-sidebar__icon-btn"
              aria-label="手工创建需求"
              @click="newRequirement"
            >
              <PlusOutlined />
            </button>
          </a-tooltip>
          <button
            type="button"
            class="task-sidebar__icon-btn"
            aria-label="刷新"
            @click="refreshWorkspace"
          >
            <!-- 刷新中换成 3/4 圆弧 loading：4 段均匀弧与圆环箭头自转在小尺寸下都看不出转动。 -->
            <Loading3QuartersOutlined v-if="refreshing" spin />
            <ReloadOutlined v-else />
          </button>
        </div>
      </div>

      <div class="thread-list__tabs-row">
        <a-segmented
          v-model:value="activeSidebarTabModel"
          :options="sidebarTabOptions"
          class="thread-list__segmented"
          block
        />
        <a-tooltip :title="scopeChipDisplayOn ? '关闭只看我' : '只看我'" placement="bottom">
          <button
            v-if="showSharedRelationFilter"
            type="button"
            class="thread-list__scope-chip thread-list__scope-chip-icon"
            :class="{ 'thread-list__scope-chip--on': scopeChipDisplayOn }"
            :aria-pressed="scopeChipDisplayOn"
            :aria-label="isScopeChipForcedOn ? '只看我，待我处理已锁定开启' : (scopeChipDisplayOn ? '关闭只看我' : '只看我')"
            :disabled="isScopeChipForcedOn"
            @click="toggleSharedRelationFilter"
          >
            <EyeOutlined v-if="!scopeChipDisplayOn" aria-hidden="true" />
            <EyeInvisibleOutlined v-else aria-hidden="true" />
          </button>
        </a-tooltip>
        <slot name="sidebar-toggle" />
      </div>

      <div class="task-sidebar__filter-row">
        <a-select
          v-model:value="currentSelectedStatuses"
          class="task-sidebar__status-select"
          mode="multiple"
          :options="currentStatusOptions"
          :placeholder="statusSelectPlaceholder"
          allow-clear
          max-tag-count="responsive"
        />
      </div>
      <div v-if="selectedStatusLabels.length > 0" class="task-sidebar__selected-statuses">
        <span
          v-for="item in selectedStatusLabels"
          :key="item.value"
          class="task-sidebar__status-tag"
        >
          {{ item.label }}
          <button
            type="button"
            aria-label="移除状态筛选"
            @click="currentSelectedStatuses = currentSelectedStatuses.filter((value) => value !== item.value)"
          >
            ×
          </button>
        </span>
        <button type="button" class="task-sidebar__status-clear" @click="currentSelectedStatuses = []">清空</button>
      </div>
    </div>

    <div ref="listRef" class="task-sidebar__items thread-list__scroll">
      <section v-if="activeSidebarTab === 'drafts'" class="task-sidebar__group">
        <div
          v-if="analysis.sessionsLoading && analysis.sessions.length === 0"
          class="task-sidebar__empty task-sidebar__empty--compact"
        >
          加载草稿中...
        </div>
        <div
          v-else-if="filteredSessions.length === 0"
          class="task-sidebar__empty task-sidebar__empty--compact"
        >
          {{
            awaitingWorkspaceClient
              ? workspaceRuntimeLoadingText
              : searchText.trim()
                ? "没有匹配的草稿会话"
                : "还没有 AI 草稿，点上方“AI创建需求”开始。"
          }}
        </div>
        <div
          v-else-if="draftVirtualList.topPad > 0"
          class="task-sidebar__virtual-spacer"
          :style="{ height: `${draftVirtualList.topPad}px` }"
          aria-hidden="true"
        />

        <div
          v-for="session in visibleSessions"
          :key="session.id"
          class="task-sidebar__card task-sidebar__card--draft"
          :class="{
            'task-sidebar__card--active': isDraftSelected(session.id),
            'task-sidebar__card--checked': isDraftChecked(session.id),
          }"
          @click="handleDraftItemClick(session.id)"
        >
          <input
            v-if="!isReadonlySharedRecord(session)"
            class="task-sidebar__card-check"
            type="checkbox"
            :checked="isDraftChecked(session.id)"
            @click.stop="toggleDraftSelection(session)"
          />
          <span class="task-sidebar__type-icon task-sidebar__type-icon--draft" aria-hidden="true">
            <RobotOutlined />
          </span>
          <div class="task-sidebar__card-body">
            <div class="task-sidebar__card-top">
              <span class="task-sidebar__card-title" :title="draftSummary(session) || session.title">{{ session.title }}</span>
            </div>
            <div class="task-sidebar__card-meta">
              <span class="task-sidebar__card-time">{{ new Date(session.lastMessageAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) }}</span>
              <span v-if="isReadonlySharedRecord(session)" class="task-sidebar__meta-tag">只读</span>
            </div>
            <div class="task-sidebar__card-workflow" :title="draftWorkflowLabel(session)">
              推荐: {{ draftWorkflowLabel(session) }}
            </div>
            <span
              v-if="isSessionRunning(session)"
              class="thread-list__status-badge thread-list__status-badge--running task-sidebar__card-status"
            >
              运行中
            </span>
            <span
              v-else
              class="thread-list__status-badge thread-list__status-badge--info task-sidebar__card-status"
            >
              {{ draftStatusLabel(session) }}
            </span>
            <a-dropdown v-if="!isReadonlySharedRecord(session)" :trigger="['click']">
              <button
                class="task-sidebar__card-menu"
                type="button"
                aria-label="更多"
                @click.stop
              >
                ⋯
              </button>
              <template #overlay>
                <a-menu>
                  <a-menu-item @click="archiveSessionAction(session.id, session.title, $event as Event)">归档（仅隐藏，保留内容）</a-menu-item>
                  <a-menu-divider />
                  <a-menu-item danger @click="deleteDraftSessionAction(session.id, session.title, $event as Event)">删除（永久清除）</a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
          </div>
        </div>
        <div
          v-if="draftVirtualList.bottomPad > 0"
          class="task-sidebar__virtual-spacer"
          :style="{ height: `${draftVirtualList.bottomPad}px` }"
          aria-hidden="true"
        />
      </section>

      <section v-else class="task-sidebar__group">
        <div v-if="intakeListLoading && intakeListLength === 0" class="task-sidebar__empty task-sidebar__empty--compact">
          {{ activeSidebarTab === "scheduledIntakes" ? "加载定时编排中..." : "加载需求中..." }}
        </div>
        <div
          v-else-if="intakeVirtualList.topPad > 0"
          class="task-sidebar__virtual-spacer"
          :style="{ height: `${intakeVirtualList.topPad}px` }"
          aria-hidden="true"
        />

        <div
          v-for="intake in visibleIntakes"
          :key="intake.id"
          class="task-sidebar__card task-sidebar__card--intake"
          :class="{
            'task-sidebar__card--active': isIntakeSelected(intake.id),
            'task-sidebar__card--checked': isIntakeChecked(intake.id),
          }"
          @click="handleIntakeItemClick(intake.id)"
        >
          <input
            v-if="!isReadonlySharedRecord(intake)"
            class="task-sidebar__card-check"
            type="checkbox"
            :checked="isIntakeChecked(intake.id)"
            @click.stop="toggleIntakeSelection(intake)"
          />
          <span class="task-sidebar__type-icon task-sidebar__type-icon--intake" aria-hidden="true">
            <FileTextOutlined />
          </span>
          <div class="task-sidebar__card-body">
            <div class="task-sidebar__card-top">
              <span
                class="task-sidebar__card-title"
                :title="intakeRunSummary(intake.id)?.detailText || getTaskIntakeTitle(intake)"
              >{{ getTaskIntakeTitle(intake) }}</span>
            </div>
            <div class="task-sidebar__card-meta">
              <span class="task-sidebar__card-time">{{ new Date(intake.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) }}</span>
              <span class="task-sidebar__meta-tag">{{ instanceCountLabel(intake.id) }} 次</span>
              <span v-if="intakeRunSummary(intake.id)?.progressText" class="task-sidebar__meta-tag task-sidebar__meta-tag--progress">{{ intakeRunSummary(intake.id)?.progressText }}</span>
              <span v-if="intake.requester?.source === 'chat'" class="task-sidebar__meta-tag">AI</span>
              <span v-if="isReadonlySharedRecord(intake)" class="task-sidebar__meta-tag">只读</span>
            </div>
            <div class="task-sidebar__card-detail">
              <span class="task-sidebar__card-workflow" :title="intakeWorkflowLabel(intake.id)">
                流程: {{ intakeWorkflowLabel(intake.id) }}
              </span>
              <span
                v-if="intakeAssigneeText(intake.id)"
                class="task-sidebar__card-assignee"
                :title="intakeAssigneeTitle(intake.id)"
              >{{ intakeAssigneeText(intake.id) }}</span>
            </div>
            <button
              v-if="intakeReminder(intake.id)"
              class="thread-list__status-badge task-sidebar__status-btn task-sidebar__card-status"
              :class="`thread-list__status-badge--${intakeStatusTone(intake.id)}`"
              type="button"
              :title="intakeReminder(intake.id)?.primaryActionLabel ?? intakeStatusLabel(intake.id) ?? ''"
              @click="openStatusAction(intake.id, $event)"
            >
              {{ intakeStatusLabel(intake.id) }}
            </button>
            <span
              v-else-if="intakeRunSummary(intake.id)"
              class="thread-list__status-badge task-sidebar__card-status"
              :class="`thread-list__status-badge--${intakeStatusTone(intake.id)}`"
            >
              {{ intakeStatusLabel(intake.id) }}
            </span>
            <button
              v-if="!isReadonlySharedRecord(intake)"
              class="task-sidebar__card-menu"
              type="button"
              aria-label="删除需求"
              title="删除需求"
              @click="confirmDelete(intake.id, getTaskIntakeTitle(intake), $event)"
            >
              <DeleteOutlined />
            </button>
            <div
              v-if="intakeRunSummary(intake.id)"
              class="task-sidebar__card-progress"
              :title="intakeRunSummary(intake.id)?.detailText ?? ''"
            >
              <div
                class="task-sidebar__card-progress-fill"
                :class="`task-sidebar__card-progress-fill--${intakeRunSummary(intake.id)?.statusTone}`"
                :style="{ width: `${Math.max(8, Math.round((intakeRunSummary(intake.id)?.progressRatio ?? 0) * 100))}%` }"
              />
            </div>
          </div>
        </div>
        <div
          v-if="intakeVirtualList.bottomPad > 0"
          class="task-sidebar__virtual-spacer"
          :style="{ height: `${intakeVirtualList.bottomPad}px` }"
          aria-hidden="true"
        />

        <div v-if="awaitingWorkspaceClient" class="task-sidebar__empty task-sidebar__empty--compact">
          {{ workspaceRuntimeLoadingText }}
        </div>
        <div v-else-if="!intakeListLoading && filteredVisibleIntakes.length === 0" class="task-sidebar__empty task-sidebar__empty--compact">
          {{ emptyIntakeText }}
        </div>
      </section>

      <div v-if="hasMore" class="thread-list__load-more" @click="loadMore">
        <template v-if="loadingMore">加载中...</template>
        <template v-else>点击或滚动加载更多</template>
      </div>
    </div>

    <div v-if="currentSelectionCount > 0" class="task-sidebar__selection-bar">
      <div class="task-sidebar__selection-copy">
        <strong>已选 {{ currentSelectionCount }} 项</strong>
        <span>批量处理已勾选的{{ currentSelectionLabel }}</span>
      </div>
      <div class="task-sidebar__selection-actions">
        <button class="task-sidebar__selection-btn task-sidebar__selection-btn--danger" type="button" @click="confirmDeleteCurrentSelection">
          删除
        </button>
        <button class="task-sidebar__selection-btn" type="button" @click="clearCurrentSelection">
          取消
        </button>
      </div>
    </div>
  </div>

  <CreateThreadModal
    v-model:open="draftCreateOpen"
    :creating="draftCreating"
    default-engine="codex"
    :disabled-engines="draftDisabledEngines"
    modal-title="新建 AI 需求草稿"
    title-label="草稿标题"
    title-placeholder="例如：首页改版一期 / 支付回调排查"
    @confirm="onDraftCreateConfirm"
  />
</template>

<style scoped>
.task-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.task-sidebar__fixed {
  padding: 0 12px 0 0;
}

/* 顶部紧凑工具栏：搜索 + 右侧 AI/手工/刷新 三按钮，对齐会话列表风格 */
.task-sidebar__top-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding-right: 4px;
  min-width: 0;
}

.task-sidebar__top-search {
  flex: 1 1 auto;
  min-width: 0;
}

.task-sidebar__top-actions {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* 顶部图标按钮：默认灰，hover 时着色；AI 按钮额外带主色高亮 */
/* 与资产库侧栏工具栏按钮同一套规格：30×30、9px 圆角、accent 描边与底色。 */
.task-sidebar__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 30px;
  min-width: 30px;
  padding: 0 8px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 22%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent) 5%, var(--app-panel-bg, #fff));
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-text, #334155));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--app-accent) 8%, transparent);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.16s ease, background-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
}

.task-sidebar__icon-btn:hover {
  border-color: color-mix(in srgb, var(--app-accent) 34%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent) 9%, var(--app-panel-bg, #fff));
  color: var(--app-accent, #d97757);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--app-accent) 12%, transparent);
}

.task-sidebar__icon-btn-text {
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}

.task-sidebar__icon-btn--ai {
  border-color: color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent) 10%, var(--app-bg));
  color: var(--app-accent);
  padding: 0 10px;
}

.task-sidebar__icon-btn--ai:hover {
  border-color: color-mix(in srgb, var(--app-accent) 48%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent) 16%, var(--app-bg));
}

.task-sidebar__items {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  margin-top: 8px;
  padding: 2px 4px 14px 0;
}

.task-sidebar__virtual-spacer {
  flex: 0 0 auto;
  pointer-events: none;
}

.task-sidebar :deep(.thread-list__segmented.ant-segmented) {
  background: color-mix(in srgb, var(--app-muted) 6%, transparent);
}

.task-sidebar :deep(.thread-list__segmented .ant-segmented-item-selected),
.task-sidebar :deep(.thread-list__segmented .ant-segmented-thumb) {
  background: var(--app-panel-bg);
}

.task-sidebar__filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  min-width: 0;
}

.task-sidebar__status-select {
  width: 100%;
  min-width: 0;
}

.task-sidebar__selected-statuses {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.task-sidebar__status-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  min-height: 24px;
  padding: 0 7px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 22%, var(--app-border));
  border-radius: 6px;
  background: color-mix(in srgb, var(--app-accent) 7%, var(--app-panel-bg));
  color: var(--app-text);
  font-size: 12px;
  line-height: 1.2;
}

.task-sidebar__status-tag button,
.task-sidebar__status-clear {
  border: 0;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0;
}

.task-sidebar__status-clear {
  min-height: 24px;
  padding: 0 4px;
}

/* ────────── 卡片：与会话列表 v2 视觉同源；grid + 右侧 aside 列对齐 ────────── */
.task-sidebar__card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 8px 12px;
  margin-bottom: 2px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  transition: background 100ms ease;
}

.task-sidebar__card:hover {
  background: var(--app-sidebar-hover-bg);
}

.task-sidebar__card--active,
.task-sidebar__card--active:hover {
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
}

.task-sidebar__card--checked {
  border-color: color-mix(in srgb, var(--app-accent) 32%, var(--app-border));
}

.task-sidebar__card-check {
  flex: 0 0 auto;
  margin: 0;
  width: 14px;
  height: 14px;
  accent-color: var(--app-accent);
  cursor: pointer;
}

.task-sidebar__type-icon {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 13px;
}

.task-sidebar__type-icon--draft {
  background: linear-gradient(135deg, #10b981, #0d9488);
}

.task-sidebar__type-icon--intake {
  background: var(--app-accent);
}

.task-sidebar__card-body {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 8px;
  row-gap: 2px;
  align-items: center;
}

.task-sidebar__card-top {
  grid-column: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.task-sidebar__card-title {
  flex: 1 1 auto;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.task-sidebar__card--active .task-sidebar__card-title {
  color: var(--app-accent);
  font-weight: 600;
}

.task-sidebar__card-meta {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 28px;
  font-size: 11.5px;
  color: var(--app-muted);
  overflow: hidden;
  min-width: 0;
}

.task-sidebar__card-time {
  flex: 0 0 auto;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.task-sidebar__meta-tag {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  height: 16px;
  font-size: 10.5px;
  line-height: 1;
  color: var(--app-muted);
  background: color-mix(in srgb, var(--app-muted) 12%, transparent);
  border-radius: 4px;
  white-space: nowrap;
}

.task-sidebar__meta-tag--progress {
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent) 12%, transparent);
}

.task-sidebar__card-detail {
  grid-column: 1 / -1;
  grid-row: 3;
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--app-muted);
  font-size: 10.25px;
  line-height: 1.2;
}

.task-sidebar__card-workflow {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 1.3;
  color: var(--app-muted);
}

.task-sidebar__card-assignee {
  flex: 0 1 52%;
  min-width: 72px;
  max-width: 168px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
}

/* status 与 title 同行右对齐，删除按钮悬浮在右侧，避免占用卡片行布局。 */
.task-sidebar__card-status {
  grid-column: 2;
  grid-row: 1;
  justify-self: end;
}

.task-sidebar__card-menu {
  position: absolute;
  right: 8px;
  top: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  margin: 0;
  box-sizing: border-box;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--app-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
}

.task-sidebar__card:hover .task-sidebar__card-menu,
.task-sidebar__card--active .task-sidebar__card-menu {
  opacity: 1;
}

.task-sidebar__card-menu:hover {
  background: color-mix(in srgb, var(--app-muted) 14%, transparent);
  color: var(--app-text);
}

/* 状态按钮（沿用 thread-list 状态色，无 hover 浮起阴影） */
.task-sidebar__status-btn {
  border: none;
  cursor: pointer;
  transition: opacity 120ms ease;
}

.task-sidebar__status-btn:hover {
  opacity: 0.85;
}

/* 进度条：底部独占一行，明确「属于该需求」的视觉归属 */
.task-sidebar__card-progress {
  grid-column: 1 / -1;
  grid-row: 4;
  height: 3px;
  border-radius: 999px;
  overflow: hidden;
  background: color-mix(in srgb, var(--app-border) 60%, transparent);
}

.task-sidebar__card-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--app-accent);
  transition: width 0.16s ease;
}

.task-sidebar__card-progress-fill--neutral { background: #94a3b8; }
.task-sidebar__card-progress-fill--info { background: #3b82f6; }
.task-sidebar__card-progress-fill--success { background: #22c55e; }
.task-sidebar__card-progress-fill--warning { background: #f59e0b; }
.task-sidebar__card-progress-fill--danger { background: #ef4444; }

.task-sidebar__empty {
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  color: var(--app-muted, #999);
  font-size: 13px;
}

.task-sidebar__empty--compact {
  min-height: 88px;
  border: 1px dashed color-mix(in srgb, var(--app-accent) 10%, var(--app-border, #e8e8e8));
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 96%, #faf8f3);
}

.task-sidebar__selection-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px calc(12px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid color-mix(in srgb, var(--app-accent) 10%, var(--app-border, #e8e8e8));
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 94%, #faf6ef);
  box-shadow: 0 -10px 24px rgba(15, 23, 42, 0.05);
}

.task-sidebar__selection-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.task-sidebar__selection-copy strong {
  font-size: 13px;
  line-height: 1.3;
}

.task-sidebar__selection-copy span {
  font-size: 11px;
  color: var(--app-muted, #667085);
}

.task-sidebar__selection-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.task-sidebar__selection-btn {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 92%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 96%, var(--app-bg, #fff));
  color: var(--app-text, #334155);
  font-size: 12px;
  cursor: pointer;
}

.task-sidebar__selection-btn--danger {
  border-color: color-mix(in srgb, #ff4d4f 28%, var(--app-border, #d9d9d9));
  color: #cf1322;
}

:root[data-theme="dark"] .task-sidebar__card:hover {
  background: rgba(255, 255, 255, 0.04);
}

:root[data-theme="dark"] .task-sidebar__card--active,
:root[data-theme="dark"] .task-sidebar__card--active:hover {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
}

:root[data-theme="dark"] .task-sidebar__card--checked {
  border-color: color-mix(in srgb, var(--app-accent) 36%, transparent);
}

:root[data-theme="dark"] .task-sidebar__meta-tag {
  background: rgba(255, 255, 255, 0.06);
}

:root[data-theme="dark"] .task-sidebar__card-progress-track {
  background: rgba(255, 255, 255, 0.08);
}

:root[data-theme="dark"] .task-sidebar__item-progress-copy span:last-child {
  color: #d6dbe4;
}

:root[data-theme="dark"] .task-sidebar__draft-metrics {
  color: #9fb0c2;
}

:root[data-theme="dark"] .task-sidebar__empty--compact {
  border-color: rgba(255, 255, 255, 0.08);
  background: #1b1b19;
}

:root[data-theme="dark"] .task-sidebar__selection-bar {
  border-top-color: rgba(255, 255, 255, 0.08);
  background: linear-gradient(180deg, rgba(31, 34, 40, 0.98), rgba(24, 27, 33, 0.98));
}

:root[data-theme="dark"] .task-sidebar__selection-copy span {
  color: #9fb0c2;
}

:root[data-theme="dark"] .task-sidebar__selection-btn {
  border-color: #3b4c63;
  background: linear-gradient(180deg, #181d24, #13171d);
  color: #d6dbe4;
}
</style>
