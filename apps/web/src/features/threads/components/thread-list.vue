<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Modal, message } from "ant-design-vue";
import { BugOutlined, ClearOutlined, DeleteOutlined, EditOutlined, EyeInvisibleOutlined, EyeOutlined, InboxOutlined, Loading3QuartersOutlined, PlusOutlined, PushpinOutlined, ReloadOutlined, SearchOutlined, SettingOutlined, SortAscendingOutlined, SwapOutlined } from "@ant-design/icons-vue";
import { matchesThreadListScope, normalizeThreadListSort } from "@codeflowai/shared";
import type { EngineType, IntakeId, OrchestrationId, ThreadGroupId, ThreadId, ThreadListScope, ThreadListSort, ThreadSubtype, ThreadSummary, WorkspaceId } from "@codeflowai/shared";
import IconClaude from "@/shared/icons/IconClaude.vue";
import IconCodex from "@/shared/icons/IconCodex.vue";

import { useApiContext } from "../../../composables/useApiContext";
import { isApiResultError, isCancelledRequestError } from "../../../api/request";
import { useChatStore } from "../../../store/chat";
import { useConfigStore } from "../../../store/config";
import { useOrchestrationStore } from "../../../store/orchestration";
import { holdRefreshFeedback } from "../../../utils/refreshFeedback";
import { useReminderStore } from "../../../store/reminders";
import { useUiStore, type ThreadFilterTab } from "../../../store/ui";
import { useWorkspacesStore } from "../../../store/workspaces";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { isDesktopWorkspace } from "../../../services/desktop";
import { getPendingInteractionState, isConversationActivelyProcessing } from "../../chat/chatTypes";
import {
  resolveThreadRowStatusBadge,
  type ThreadListStatusBadge,
  type ThreadListStatusTone,
} from "../threadStatusBadge";

import CreateThreadModal from "./create-thread-modal.vue";
import RenameThreadModal from "./rename-thread-modal.vue";
import { useCreateThreadEngineAvailability } from "../useCreateThreadEngineAvailability";
import { isKnowledgeConversation, isKnowledgeExecution, isKnowledgeThread, resolveKnowledgeThreadLocation, shouldClearPrimarySelectionForListFilter } from "../thread-list-navigation";

defineOptions({ name: "ThreadList" });

type Props = {
  compact?: boolean;
};

defineProps<Props>();

const config = useConfigStore();
const chat = useChatStore();
const reminders = useReminderStore();
const ui = useUiStore();
const workspaces = useWorkspacesStore();
const orch = useOrchestrationStore();
const route = useRoute();
const router = useRouter();
const { ctx } = useApiContext();
const isMobileViewport = typeof window !== "undefined" && window.innerWidth <= 767;
const { disabledEngines: createDisabledEngines, refreshEngineAvailability } = useCreateThreadEngineAvailability(computed(() => config.workspaceId));

const createOpen = ref(false);
const creating = ref(false);
const renameOpen = ref(false);
const renaming = ref(false);
const renameTarget = ref<ThreadSummary | null>(null);
const archiveBusyThreadId = ref<ThreadId | null>(null);
const pinBusyThreadId = ref<ThreadId | null>(null);
const restartCodexBusy = ref(false);
const groupManageOpen = ref(false);
const groupCreating = ref(false);
const groupDraftName = ref("");
const groupRenameId = ref<ThreadGroupId | null>(null);
const groupRenameName = ref("");
const groupBusyId = ref<ThreadGroupId | null>(null);
const moveGroupOpen = ref(false);
const moveGroupTarget = ref<ThreadSummary | null>(null);
const moveGroupSearch = ref("");
const movingGroup = ref(false);

/** 桌面本机工作区走本地桥，未登录 Server 也允许列表读写。 */
const canOperate = computed(() => Boolean(
  config.workspaceId.trim() && (config.connected || isDesktopWorkspace(config, config.workspaceId)),
));
const canCreateThread = computed(() => canOperate.value);
const canRead = computed(() => canOperate.value);
const emptyWorkspaceMessage = computed(() =>
  config.connected || isDesktopWorkspace(config, config.workspaceId) ? "请先创建或选择工作区" : "请先连接 Server",
);
const isSharedWorkspace = computed(() => isSharedWorkspaceSelectionId(config.workspaceId));
const currentWorkspace = computed(() => workspaces.byId.get(config.workspaceId as WorkspaceId) ?? null);
const currentSharedRole = computed(() =>
  currentWorkspace.value?.capabilities?.effectiveAssetRole
  ?? currentWorkspace.value?.shared?.effectiveAssetRole
  ?? currentWorkspace.value?.shared?.currentUserRole
  ?? null,
);
const sharedRoleResolved = computed(() => currentSharedRole.value != null);
const isSharedMemberView = computed(() => currentSharedRole.value === "member");
const showSharedRelationFilter = computed(() => isSharedWorkspace.value && isSharedMemberView.value);
const sharedOnlyRelatedToMe = computed({
  get: () => chat.threadListOnlyRelatedToMe,
  set: (value: boolean) => {
    chat.threadListOnlyRelatedToMe = value;
  },
});
/** 管理员默认读取全部共享上下文；普通成员才使用“只看与我有关”过滤。 */
const effectiveSharedOnlyRelatedToMe = computed(() =>
  isSharedWorkspace.value ? (!sharedRoleResolved.value ? true : (isSharedMemberView.value ? sharedOnlyRelatedToMe.value : false)) : null,
);
const query = ref("");
/** 文件工作摘要可先展示；讨论列表以服务端分页为准，避免缓存重新带回后台空宿主。 */
function matchesVisibleThreadScope(thread: ThreadSummary, scope: ThreadListScope): boolean {
  return scope === "knowledge" ? isKnowledgeThread(thread) && !thread.archived : matchesThreadListScope(thread, scope);
}
const tabFilteredThreads = computed(() => {
  const filter = ui.threadFilterTab;
  const visible = chat.threads.filter((thread) => matchesVisibleThreadScope(thread, filter));
  if (filter !== "knowledge" && filter !== "all") return visible;
  const ids = new Set(visible.map((thread) => String(thread.id)));
  const search = query.value.trim().toLowerCase();
  const cached = Object.values(chat.extraThreadSummariesById)
    .filter((thread) => !isKnowledgeConversation(thread) && !ids.has(String(thread.id)) && matchesVisibleThreadScope(thread, filter)
      && (!search || thread.title.toLowerCase().includes(search)));
  return [...visible, ...cached].sort(compareThreadsForCurrentSort);
});
const SERVER_SEARCH_DEBOUNCE_MS = 250;
const CREATE_THREAD_UNGROUPED_GROUP_VALUE = "__ungrouped";
let searchRefreshTimer: ReturnType<typeof setTimeout> | null = null;

const filteredThreads = computed(() => {
  return tabFilteredThreads.value;
});
const showThreadGroupBar = computed(() => canRead.value && ui.threadFilterTab === "current");
const activeThreadGroupValue = computed<string>({
  get: () => {
    if (chat.activeThreadGroupId === "ungrouped") return "__ungrouped";
    return chat.activeThreadGroupId ? String(chat.activeThreadGroupId) : "__all";
  },
  set: (value) => {
    const next = value === "__all" ? null : value === "__ungrouped" ? "ungrouped" : (value as ThreadGroupId);
    changeThreadGroupFilter(next);
  },
});
const threadGroupSelectOptions = computed(() => [
  { label: "全部分组", value: "__all" },
  ...chat.threadGroups.map((group) => ({ label: group.name, value: String(group.id) })),
  { label: "未分组", value: "__ungrouped" },
]);
const defaultCreateThreadGroupId = computed<ThreadGroupId | null>(() => {
  if (ui.threadFilterTab !== "current") return null;
  const activeGroupId = chat.activeThreadGroupId;
  if (!activeGroupId || activeGroupId === "ungrouped") return null;
  return activeGroupId;
});
const createThreadGroupOptions = computed(() => {
  const options = chat.threadGroups.map((group) => ({ label: group.name, value: String(group.id) }));
  const defaultGroupId = defaultCreateThreadGroupId.value;
  if (defaultGroupId && !options.some((option) => option.value === String(defaultGroupId))) {
    options.unshift({ label: "当前分组", value: String(defaultGroupId) });
  }
  options.push({ label: "未分组", value: CREATE_THREAD_UNGROUPED_GROUP_VALUE });
  return options;
});
const filteredMoveGroups = computed(() => {
  const search = moveGroupSearch.value.trim().toLowerCase();
  if (!search) return chat.threadGroups;
  return chat.threadGroups.filter((group) => group.name.toLowerCase().includes(search));
});

/** segmented tab 配置：所有用户共用一套，归档收入选项内部。 */
const threadTabOptions = computed(() => [
  { title: "普通会话", payload: { name: "普通" }, value: "current" as ThreadFilterTab },
  { title: "流程会话", payload: { name: "流程" }, value: "orchestration" as ThreadFilterTab },
  { title: "归档会话", payload: { name: "归档" }, value: "archived" as ThreadFilterTab },
]);

/** 「规格」不再作为会话列表 tab；历史持久化选择静默回退到普通会话。 */
watch(
  () => ui.threadFilterTab,
  (tab) => { if (tab === "knowledge") ui.threadFilterTab = "current"; },
  { immediate: true },
);

const threadSortOptions: Array<{ label: string; value: ThreadListSort }> = [
  { label: "最近活动 新到旧", value: "activity_desc" },
  { label: "最近活动 旧到新", value: "activity_asc" },
  { label: "创建时间 新到旧", value: "created_desc" },
  { label: "创建时间 旧到新", value: "created_asc" },
  { label: "标题 A-Z", value: "title_asc" },
  { label: "标题 Z-A", value: "title_desc" },
];

/** 当前 tab 的双向绑定，写回时走原有的副作用清理逻辑。 */
const activeThreadTab = computed<ThreadFilterTab>({
  get: () => ui.threadFilterTab,
  set: (value) => { switchThreadFilter(value); },
});

/** 当前会话列表排序，写回后由 watcher 重新拉取第一页。 */
const activeThreadSort = computed<ThreadListSort>({
  get: () => normalizeThreadListSort(ui.threadListSort, "activity_desc"),
  set: (value) => { ui.setThreadListSort(value); },
});

const activeThreadSortOption = computed(() =>
  threadSortOptions.find((item) => item.value === activeThreadSort.value) ?? threadSortOptions[0]!,
);

const threadReminderByThreadId = computed(() => {
  const map = new Map<string, { statusLabel: string; tone: ThreadListStatusTone }>();
  if (String(reminders.currentWorkspaceId ?? "") !== String(config.workspaceId ?? "")) {
    return map;
  }
  for (const item of reminders.currentItems) {
    if (
      item.sourceType !== "chat"
      || String(item.workspaceId ?? "").trim() !== String(config.workspaceId ?? "").trim()
    ) continue;
    const threadId = String(item.routeTarget.threadId ?? "").trim();
    if (!threadId || map.has(threadId)) continue;
    map.set(threadId, {
      statusLabel: item.statusLabel,
      tone: item.tone,
    });
  }
  return map;
});

/* ── 滚动分页 ── */
const PAGE_SIZE = 30;
const visibleCount = ref(PAGE_SIZE);
const listRef = ref<HTMLElement | null>(null);
const tabViewState = new Map<ThreadFilterTab, { visibleCount: number; scrollTop: number }>();

const visibleThreads = computed(() => filteredThreads.value.slice(0, visibleCount.value));
const hasMore = computed(() => visibleCount.value < filteredThreads.value.length || chat.threadsHasMore);
const loadingMore = ref(false);

/** 当前展开的 intake（需求）id 集合；流程 tab 下三级树的第一层。 */
const expandedIntakeIds = ref<Set<IntakeId>>(new Set());
/** 当前展开的实例 id 集合；流程 tab 下三级树的第二层（点击触发详情懒加载）。 */
const expandedInstanceIds = ref<Set<OrchestrationId>>(new Set());
/** 正在补齐会话摘要的实例 id 集合，避免详情已加载但摘要未返回时闪空态。 */
const hydratingInstanceThreadIds = ref<Set<OrchestrationId>>(new Set());

/** 切换单个实例的会话摘要加载态，用显式状态覆盖详情与摘要之间的空档。 */
function setInstanceThreadHydrating(instanceId: OrchestrationId, hydrating: boolean): void {
  const next = new Set(hydratingInstanceThreadIds.value);
  if (hydrating) next.add(instanceId);
  else next.delete(instanceId);
  hydratingInstanceThreadIds.value = next;
}

/** 切换 intake 折叠态;展开 intake 时顺手把最新一次执行的实例也打开,免去用户再点一次。 */
function toggleIntakeExpanded(intakeId: IntakeId): void {
  const next = new Set(expandedIntakeIds.value);
  const isOpening = !next.has(intakeId);
  if (isOpening) next.add(intakeId);
  else next.delete(intakeId);
  expandedIntakeIds.value = next;

  if (!isOpening) return;
  // 找该 intake 下 updatedAt 最大的实例(最新一次执行),若尚未展开则触发展开+懒加载
  let latestId: OrchestrationId | null = null;
  let latestUpdatedAt = -Infinity;
  for (const summary of orch.instanceSummaries) {
    if (summary.intakeId !== intakeId) continue;
    if (summary.updatedAt > latestUpdatedAt) {
      latestUpdatedAt = summary.updatedAt;
      latestId = summary.id;
    }
  }
  if (latestId && !expandedInstanceIds.value.has(latestId)) {
    void toggleInstanceExpanded(latestId);
  }
}

/** 从已加载详情的实例的 nodeStates 中收集所有相关 threadId（含主控/讨论/历史）。 */
function collectInstanceThreadIds(instanceId: OrchestrationId): Set<ThreadId> {
  const ids = new Set<ThreadId>();
  const inst = orch.instances.find((i) => i.id === instanceId);
  if (!inst) return ids;
  if (inst.masterThreadId) ids.add(inst.masterThreadId);
  for (const ns of Object.values(inst.nodeStates ?? {})) {
    if (ns.threadId) ids.add(ns.threadId);
    if (ns.discussionThreadId) ids.add(ns.discussionThreadId);
    for (const id of ns.previousThreadIds ?? []) ids.add(id);
  }
  return ids;
}

/** 判断补齐的单会话摘要是否仍符合当前 tab 与标题搜索条件。 */
function matchesCurrentThreadListView(thread: ThreadSummary): boolean {
  if (!matchesThreadListScope(thread, ui.threadFilterTab)) return false;
  const search = query.value.trim().toLowerCase();
  if (!search) return true;
  return String(thread.title ?? "").toLowerCase().includes(search);
}

/** 会话列表时间：优先展示最近活动时间，缺失时回退创建时间。 */
function resolveThreadActivityAt(thread: Pick<ThreadSummary, "createdAt" | "updatedAt">): number {
  const updatedAt = Number(thread.updatedAt ?? 0);
  if (Number.isFinite(updatedAt) && updatedAt > 0) return updatedAt;
  const createdAt = Number(thread.createdAt ?? 0);
  return Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0;
}

/** 已加载实例 → 该实例下的会话列表，允许使用按实例 threadId 补齐的摘要。 */
function getInstanceThreadsForRender(instanceId: OrchestrationId): ThreadSummary[] {
  const idSet = collectInstanceThreadIds(instanceId);
  if (idSet.size === 0) return [];
  const visibleById = new Map(visibleThreads.value.map((thread) => [String(thread.id), thread]));
  const threads: ThreadSummary[] = [];
  for (const threadId of idSet) {
    const thread = visibleById.get(String(threadId)) ?? chat.getThreadSummary(threadId);
    if (!thread || !matchesCurrentThreadListView(thread)) continue;
    threads.push(thread);
  }
  return threads.sort(compareThreadsForCurrentSort);
}

/** 展开流程实例后补齐节点会话摘要，避免共享 thread context 列表漏掉 Host 侧节点会话。 */
async function hydrateInstanceThreadSummaries(instanceId: OrchestrationId): Promise<void> {
  const threadIds = [...collectInstanceThreadIds(instanceId)];
  const missingThreadIds = threadIds.filter((threadId) => !chat.getThreadSummary(threadId));
  if (missingThreadIds.length === 0) return;
  await Promise.all(missingThreadIds.map((threadId) =>
    chat.syncThreadSummaryState(ctx.value, {
      workspaceId: config.workspaceId as WorkspaceId,
      threadId,
    }),
  ));
}

type InstanceTreeNode = {
  id: OrchestrationId;
  /** 实例时间标签：用 updatedAt 格式化的简短日期，作为同一需求多次执行的区分 */
  timeLabel: string;
  /** 同一 intake 内的执行序号(列表顺序新→旧,故最新一次记为 1) */
  runOrdinal: number;
  statusLabel: string | null;
  updatedAt: number;
  workflowName: string;
  expanded: boolean;
  loaded: boolean;
  hydratingThreads: boolean;
  threads: ThreadSummary[];
};

type IntakeTreeNode = {
  intakeId: IntakeId;
  title: string;
  /** 该需求下的实例数量(仅内部使用,不再在 header 展示) */
  instanceCount: number;
  /** 用于排序：取该 intake 下最新实例的 updatedAt */
  latestUpdatedAt: number;
  /** intake header 右侧展示：取最新一次实例的状态/进度,用户更关注当前进展而非执行次数 */
  latestStatusLabel: string | null;
  expanded: boolean;
  instances: InstanceTreeNode[];
};

/** 简短日期格式：M/D HH:mm，用于实例 header 区分同一需求的多次执行。 */
function formatInstanceTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** 切换会话列表排序；相同排序不重复触发刷新。 */
function selectThreadSort(sort: ThreadListSort): void {
  if (activeThreadSort.value === sort) return;
  activeThreadSort.value = sort;
}

/** 当前排序下列表时间字段的业务标签。 */
function getThreadTimeLabel(): string {
  return activeThreadSort.value.startsWith("created") ? "创建" : "活动";
}

/** 当前排序下列表展示的时间值。 */
function getThreadTimeValue(item: ThreadSummary): number {
  return activeThreadSort.value.startsWith("created") ? item.createdAt : resolveThreadActivityAt(item);
}

/** 格式化会话列表时间；无效时间戳不展示。 */
function formatThreadListTime(item: ThreadSummary): string {
  const timestamp = getThreadTimeValue(item);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp).toLocaleString();
}

/** 会话时间 tooltip，说明当前展示的是创建时间还是活动时间。 */
function getThreadTimeTitle(item: ThreadSummary): string {
  const value = formatThreadListTime(item);
  return value ? `${getThreadTimeLabel()}时间：${value}` : "";
}

/** 按当前排序比较补齐的节点会话摘要，保持与列表排序大体一致。 */
function compareThreadsForCurrentSort(a: ThreadSummary, b: ThreadSummary): number {
  const pinnedDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
  if (pinnedDiff !== 0) return pinnedDiff;
  const sort = activeThreadSort.value;
  if (sort === "activity_asc") return resolveThreadActivityAt(a) - resolveThreadActivityAt(b) || String(a.id).localeCompare(String(b.id));
  if (sort === "created_desc") return b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id));
  if (sort === "created_asc") return a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id));
  if (sort === "title_asc") return String(a.title ?? "").toLowerCase().localeCompare(String(b.title ?? "").toLowerCase()) || String(a.id).localeCompare(String(b.id));
  if (sort === "title_desc") return String(b.title ?? "").toLowerCase().localeCompare(String(a.title ?? "").toLowerCase()) || String(b.id).localeCompare(String(a.id));
  return resolveThreadActivityAt(b) - resolveThreadActivityAt(a) || String(b.id).localeCompare(String(a.id));
}

/** 节点会话标题展示格式化：剥离后端持久化的「[编排] 」前缀与「 - {workflowName}」后缀，
 * 这两段在流程列表里已分别由 tab 上下文和外层实例 header 表达，重复展示会挤掉真正的角色名。 */
function formatThreadDisplayTitle(rawTitle: string, workflowName?: string | null): string {
  let title = String(rawTitle ?? "").trim();
  const prefix = "[编排] ";
  if (title.startsWith(prefix)) title = title.slice(prefix.length).trim();
  const wfName = String(workflowName ?? "").trim();
  if (wfName) {
    const suffix = ` - ${wfName}`;
    if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
  }
  return title || rawTitle;
}

/** 流程 tab 的三级树：按 intakeId 聚合实例，每个 intake 节点下挂多个 instance 节点。 */
const intakeTreeNodes = computed<IntakeTreeNode[]>(() => {
  if (ui.threadFilterTab !== "orchestration") return [];
  // 1. 按 intakeId 分桶；同一个需求的多次执行聚到同一组
  const buckets = new Map<IntakeId, typeof orch.instanceSummaries>();
  for (const summary of orch.instanceSummaries) {
    const list = buckets.get(summary.intakeId) ?? [];
    list.push(summary);
    buckets.set(summary.intakeId, list);
  }
  // 2. 转成 intake 节点，内部按 updatedAt desc 排序实例
  const nodes: IntakeTreeNode[] = [];
  for (const [intakeId, summaries] of buckets.entries()) {
    const sorted = [...summaries].sort((a, b) => b.updatedAt - a.updatedAt);
    const instances: InstanceTreeNode[] = sorted.map((summary, index) => {
      const expanded = expandedInstanceIds.value.has(summary.id);
      const loaded = orch.instances.some((inst) => inst.id === summary.id);
      return {
        id: summary.id,
        timeLabel: formatInstanceTime(summary.updatedAt),
        runOrdinal: index + 1,
        statusLabel: summary.runSummary?.statusLabel ?? null,
        updatedAt: summary.updatedAt,
        workflowName: String(summary.workflowName ?? "").trim(),
        expanded,
        loaded,
        hydratingThreads: hydratingInstanceThreadIds.value.has(summary.id),
        threads: expanded && loaded ? getInstanceThreadsForRender(summary.id) : [],
      };
    });
    nodes.push({
      intakeId,
      title: sorted[0]?.intakeTitle || "未命名需求",
      instanceCount: instances.length,
      latestUpdatedAt: instances[0]?.updatedAt ?? 0,
      latestStatusLabel: instances[0]?.statusLabel ?? null,
      expanded: expandedIntakeIds.value.has(intakeId),
      instances,
    });
  }
  // 3. 按最新实例时间倒序排 intake，让最近活跃的需求在最上面
  nodes.sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);
  return nodes;
});

/** 未被任何已加载实例认领的编排会话（孤儿 / 需求分析等），渲染在树末尾。 */
const orphanOrchestrationThreads = computed<ThreadSummary[]>(() => {
  if (ui.threadFilterTab !== "orchestration") return [];
  const claimed = new Set<ThreadId>();
  for (const inst of orch.instances) {
    for (const id of collectInstanceThreadIds(inst.id)) claimed.add(id);
  }
  return visibleThreads.value.filter((t) => !claimed.has(t.id));
});

/** 切换实例展开态；首次展开会触发详情懒加载（拿到 nodeStates 才能列出会话）。 */
async function toggleInstanceExpanded(instanceId: OrchestrationId): Promise<void> {
  const next = new Set(expandedInstanceIds.value);
  if (next.has(instanceId)) {
    next.delete(instanceId);
    expandedInstanceIds.value = next;
    return;
  }
  next.add(instanceId);
  expandedInstanceIds.value = next;
  const alreadyLoaded = orch.instances.some((inst) => inst.id === instanceId);
  if (canOperate.value) {
    setInstanceThreadHydrating(instanceId, true);
    try {
      // 用 loadTrackedInstance 而非 loadInstance：仅把实例快照塞进 instances 数组，
      // 不会改写 selectedInstanceId，避免连续展开多个实例时互相并发抢占导致前一个早退。
      if (!alreadyLoaded) {
        await orch.loadTrackedInstance(ctx.value, config.workspaceId as WorkspaceId, instanceId);
      }
      await hydrateInstanceThreadSummaries(instanceId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setInstanceThreadHydrating(instanceId, false);
    }
  }
}

/** 刷新流程 tab 所需实例摘要，确保共享可见范围与会话列表一致；返回值表示本次是否刷新成功。 */
async function refreshOrchestrationInstancesForCurrentScope(preferCache = false): Promise<boolean> {
  if (ui.threadFilterTab !== "orchestration" || !canOperate.value) return false;
  try {
    await orch.refreshInstances(ctx.value, config.workspaceId as WorkspaceId, { onlyRelatedToMe: effectiveSharedOnlyRelatedToMe.value, preferCache });
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** 切到流程 tab 时复用当前作用域的实例摘要，首次访问才读取。 */
watch(() => ui.threadFilterTab, (tab) => {
  if (tab !== "orchestration") return;
  void refreshOrchestrationInstancesForCurrentScope(true);
}, { immediate: true });

function switchThreadFilter(tab: ThreadFilterTab): void {
  if (ui.threadFilterTab === tab) return;
  const selectedSummary = chat.getThreadSummary(chat.selectedThreadId);
  if (shouldClearPrimarySelectionForListFilter({
    currentScope: ui.threadFilterTab,
    nextScope: tab,
    knowledgePageActive: ui.mainView === "knowledge",
    selectedThreadId: chat.selectedThreadId,
    selectedThread: selectedSummary,
  })) {
    chat.clearPrimaryThreadSelection({ clearUrl: true, reason: "scope-change" });
    chat.clearPrimaryRouteResolution();
  }
  ui.setThreadFilterTab(tab);
}

/** 桌面侧已下线「全部会话」tab：历史持久化或 H5 侧写入的 all 统一回落到「自建会话」。 */
watch(() => ui.threadFilterTab, (tab) => {
  if (tab === "all") switchThreadFilter("current");
}, { immediate: true });

/** 历史翻页复用统一 API，本机读取不等待云端连接。 */
function loadMore(): void {
  // 客户端分页：先展示更多已加载的数据
  if (visibleCount.value < filteredThreads.value.length) {
    visibleCount.value = Math.min(visibleCount.value + PAGE_SIZE, filteredThreads.value.length);
    return;
  }
  // 服务端翻页：所有已加载数据已展示完，请求下一页
  if (chat.threadsHasMore && !loadingMore.value && canRead.value) {
    const tab = ui.threadFilterTab;
    const workspaceId = config.workspaceId;
    loadingMore.value = true;
    chat.loadMoreThreads(ctx.value, config.workspaceId, { search: query.value, sort: activeThreadSort.value, groupId: chat.activeThreadGroupId, onlyRelatedToMe: effectiveSharedOnlyRelatedToMe.value })
      .then(() => {
        if (tab === ui.threadFilterTab && workspaceId === config.workspaceId) visibleCount.value = filteredThreads.value.length;
      })
      .catch((e: unknown) => {
        message.error(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (tab === ui.threadFilterTab && workspaceId === config.workspaceId) loadingMore.value = false;
      });
  }
}

/** 读取当前工作区分组；非普通分类的新建弹框可显式读取，分类往返允许复用。 */
async function refreshThreadGroupsForCurrentWorkspace(opts?: { allowHidden?: boolean; preferCache?: boolean }): Promise<boolean> {
  const workspaceId = String(config.workspaceId ?? "").trim() as WorkspaceId;
  if ((!opts?.allowHidden && !showThreadGroupBar.value) || !workspaceId) return false;
  const previousGroupId = chat.activeThreadGroupId;
  try {
    await chat.refreshThreadGroups(ctx.value, workspaceId, { preferCache: opts?.preferCache });
    if (previousGroupId !== chat.activeThreadGroupId) return await refreshThreadsForCurrentSearch();
    return true;
  } catch (error) {
    const details = isApiResultError(error) ? error.details as Record<string, unknown> | undefined : undefined;
    console.error("[thread-groups.load.failed]", {
      code: isApiResultError(error) ? error.code : "THREAD_GROUPS_LOAD_FAILED", requestId: details?.requestId ?? null,
      workspaceId, groupId: chat.activeThreadGroupId, rootCause: error instanceof Error ? error.message : String(error),
    });
    message.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** 下拉打开时复用成功分组，首次或上次失败时重试读取。 */
function handleThreadGroupDropdownVisibleChange(open: boolean): void {
  if (!open) return;
  void refreshThreadGroupsForCurrentWorkspace({ preferCache: true });
}

/** 切换分组筛选时恢复已加载列表，首次访问才读取服务端。 */
function changeThreadGroupFilter(groupId: ThreadGroupId | "ungrouped" | null): void {
  const selectedSummary = chat.getThreadSummary(chat.selectedThreadId);
  if (chat.selectedThreadId && !matchesThreadGroupFilter(selectedSummary, groupId)) {
    chat.clearPrimaryThreadSelection({ clearUrl: true, reason: "scope-change" });
    chat.clearPrimaryRouteResolution();
  }
  chat.setActiveThreadGroupId(groupId);
  visibleCount.value = PAGE_SIZE;
  loadingMore.value = false;
  nextTick(() => { listRef.value?.scrollTo({ top: 0 }); });
  void refreshThreadsForCurrentSearch(true);
}

/** 判断会话是否属于当前分组筛选；空分组表示全部，缺少摘要时不保留选中态。 */
function matchesThreadGroupFilter(item: ThreadSummary | null, groupId: ThreadGroupId | "ungrouped" | null): boolean {
  if (!item) return false;
  const itemGroupId = String(item.groupId ?? "").trim();
  if (!groupId) return true;
  if (groupId === "ungrouped") return !itemGroupId;
  return itemGroupId === String(groupId);
}

function onListScroll(): void {
  const el = listRef.value;
  if (!el || !hasMore.value) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
    loadMore();
  }
}

/** 清理待触发的服务端标题搜索刷新，避免旧输入覆盖新列表。 */
function clearSearchRefreshTimer(): void {
  if (!searchRefreshTimer) return;
  clearTimeout(searchRefreshTimer);
  searchRefreshTimer = null;
}

/** 按当前筛选读取列表；分类和分组切换可复用，手动刷新始终读取真值。 */
async function refreshThreadsForCurrentSearch(preferCache = false): Promise<boolean> {
  clearSearchRefreshTimer();
  if (!canRead.value) return false;
  try {
    await chat.refreshThreads(ctx.value, config.workspaceId, { search: query.value, sort: activeThreadSort.value, groupId: chat.activeThreadGroupId, onlyRelatedToMe: effectiveSharedOnlyRelatedToMe.value, preferCache });
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** 刷新进行中：图标转圈展示过程，同时挡住重复点击。 */
const refreshing = ref(false);

/**
 * 手动刷新当前列表：普通分类同时刷新分组，流程分类重取实例摘要，其余重取会话第一页。
 * 直接复用既有刷新入口，保持搜索词、排序、分组与共享可见范围的口径一致。
 */
async function refreshActiveThreadList(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  const startedAt = Date.now();
  let refreshed = false;
  try {
    if (ui.threadFilterTab === "orchestration") {
      refreshed = await refreshOrchestrationInstancesForCurrentScope();
    } else if (ui.threadFilterTab === "current") {
      refreshed = (await Promise.all([refreshThreadsForCurrentSearch(), refreshThreadGroupsForCurrentWorkspace()])).every(Boolean);
    } else {
      refreshed = await refreshThreadsForCurrentSearch();
    }
  } finally {
    // 请求常在几十毫秒内返回，补足最短时长让转圈看得见。
    await holdRefreshFeedback(startedAt);
    refreshing.value = false;
    await nextTick();
  }
  // 刷新通常瞬间完成，列表看不出变化，用提示告诉用户这次点击确实生效了。
  if (refreshed) message.success("列表已刷新");
}

/** 延迟触发服务端标题搜索，减少连续输入时的无效请求。 */
function scheduleServerSearchRefresh(): void {
  clearSearchRefreshTimer();
  searchRefreshTimer = setTimeout(() => {
    searchRefreshTimer = null;
    void refreshThreadsForCurrentSearch();
  }, SERVER_SEARCH_DEBOUNCE_MS);
}

// 搜索条件变化时请求服务端第一页，搜索范围仅限会话标题。
watch(query, () => {
  visibleCount.value = PAGE_SIZE;
  loadingMore.value = false;
  nextTick(() => { listRef.value?.scrollTo({ top: 0 }); });
  scheduleServerSearchRefresh();
});

// 分类往返恢复已加载页的展示位置，列表数据由 Store 按作用域隔离。
watch(() => ui.threadFilterTab, (tab, previous) => {
  tabViewState.set(previous, { visibleCount: visibleCount.value, scrollTop: listRef.value?.scrollTop ?? 0 });
  const view = tabViewState.get(tab);
  visibleCount.value = view?.visibleCount ?? PAGE_SIZE;
  loadingMore.value = false;
  void refreshThreadsForCurrentSearch(true).then(async () => {
    await nextTick();
    if (ui.threadFilterTab === tab) listRef.value?.scrollTo({ top: view?.scrollTop ?? 0 });
  });
});

// 身份和筛选变化后不沿用旧分类的滚动位置。
watch(() => [config.workspaceId, config.serverWsOrigin, config.webSessionId, config.desktopClient?.clientId,
  query.value, ui.threadListSort, chat.activeThreadGroupId, effectiveSharedOnlyRelatedToMe.value], () => {
  tabViewState.clear();
}, { flush: "sync" });

// 排序切换必须重新拉第一页，避免沿用旧排序游标。
watch(() => ui.threadListSort, () => {
  visibleCount.value = PAGE_SIZE;
  loadingMore.value = false;
  nextTick(() => { listRef.value?.scrollTo({ top: 0 }); });
  void refreshThreadsForCurrentSearch();
});

watch(() => [config.workspaceId, ui.threadFilterTab, canRead.value, config.webSessionId] as const, ([workspaceId, tab, readable], previous) => {
  const workspaceKey = String(workspaceId ?? "").trim();
  const previousWorkspaceKey = String(previous?.[0] ?? "").trim();
  if (workspaceKey !== previousWorkspaceKey) {
    chat.resetThreadGroupState();
  }
  if (tab !== "current" || !workspaceKey || !readable) return;
  void refreshThreadGroupsForCurrentWorkspace({ preferCache: true });
}, { immediate: true });

// 切换共享工作区可见范围时重新拉服务端第一页，避免混合旧列表分页游标。
watch(sharedOnlyRelatedToMe, () => {
  if (!showSharedRelationFilter.value) return;
  visibleCount.value = PAGE_SIZE;
  loadingMore.value = false;
  nextTick(() => { listRef.value?.scrollTo({ top: 0 }); });
  void refreshThreadsForCurrentSearch();
  void refreshOrchestrationInstancesForCurrentScope();
});

watch(() => [config.workspaceId, currentSharedRole.value] as const, () => {
  if (!isSharedWorkspace.value || !sharedRoleResolved.value) return;
  chat.threadListOnlyRelatedToMe = isSharedMemberView.value;
}, { immediate: true });

// 监听会话选择变化，同步到 URL（处理其他地方触发的选择）
onMounted(() => {
  listRef.value?.addEventListener("scroll", onListScroll, { passive: true });
});
onBeforeUnmount(() => {
  clearSearchRefreshTimer();
  listRef.value?.removeEventListener("scroll", onListScroll);
});

/** 规格会话通过主会话路由直开，刷新及前进后退沿用原线程。 */
const selectThread = (thread: ThreadSummary) => {
  const knowledgeLocation = resolveKnowledgeThreadLocation(thread, config.workspaceId);
  if (knowledgeLocation) {
    chat.upsertThreadSummary(thread);
    void router.push(knowledgeLocation).catch(error => {
      console.error("[knowledge-thread.open.failed]", { code: "KNOWLEDGE_THREAD_ROUTE_FAILED", requestId: `knowledge-thread-open-${thread.id}`, workspaceId: config.workspaceId, threadId: thread.id, rootCause: error instanceof Error ? error.message : String(error) });
      message.error(error instanceof Error ? error.message : "规格会话打开失败");
    });
    return;
  }
  chat.selectPrimaryThread(thread, { route: isMobileViewport ? "ignore" : "replace" });
};

function isThreadActive(thread: ThreadSummary): boolean {
  if (ui.mainView === "knowledge" && isKnowledgeConversation(thread)) {
    return route.name === "project-knowledge" && route.query.threadId === thread.id;
  }
  if (ui.mainView === "knowledge" && isKnowledgeExecution(thread)) {
    return route.name === "project-knowledge" && route.query.executionThreadId === thread.id;
  }
  return ui.mainView !== "knowledge" && thread.id === chat.selectedThreadId;
}

/** 共享团队可见但非本人相关的会话只能查看，不能维护或继续输入。 */
function isReadonlyThread(item: ThreadSummary): boolean {
  return Boolean(item.readOnly || item.sharedContext?.readOnly);
}

const openRename = (item: ThreadSummary) => {
  if (!canOperate.value) return;
  if (isReadonlyThread(item)) {
    message.info("这条共享会话只读，不能重命名");
    return;
  }
  renameTarget.value = item;
  renameOpen.value = true;
};

const onRenameConfirm = async (payload: { title: string }) => {
  if (!canOperate.value) return;
  const item = renameTarget.value;
  if (!item) return;
  renaming.value = true;
  try {
    await chat.renameThread(ctx.value, { workspaceId: config.workspaceId, threadId: item.id, title: payload.title });
    renameOpen.value = false;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    renaming.value = false;
  }
};

const toggleArchive = async (item: ThreadSummary) => {
  if (!canOperate.value || archiveBusyThreadId.value === item.id) return;
  if (isReadonlyThread(item)) {
    message.info("这条共享会话只读，不能归档");
    return;
  }
  archiveBusyThreadId.value = item.id;
  const hide = message.loading(item.archived ? "正在取消归档..." : "正在归档...", 0);
  try {
    await chat.setThreadArchived(ctx.value, { workspaceId: config.workspaceId, threadId: item.id, archived: !item.archived });
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    archiveBusyThreadId.value = null;
    hide();
  }
};

function archiveActionLabel(item: ThreadSummary): string {
  if (archiveBusyThreadId.value !== item.id) {
    return item.archived ? "取消归档" : "归档";
  }
  return item.archived ? "取消归档中..." : "归档中...";
}

function isArchiveBusy(threadId: ThreadId): boolean {
  return String(archiveBusyThreadId.value ?? "") === String(threadId);
}

/** 置顶/取消置顶当前会话，并让列表按持久化状态重新排序。 */
const togglePinned = async (item: ThreadSummary) => {
  if (!canOperate.value || pinBusyThreadId.value === item.id) return;
  if (isReadonlyThread(item)) {
    message.info("这条共享会话只读，不能置顶");
    return;
  }
  const nextPinned = !item.pinnedAt;
  pinBusyThreadId.value = item.id;
  const hide = message.loading(nextPinned ? "正在置顶..." : "正在取消置顶...", 0);
  try {
    await chat.setThreadPinned(ctx.value, { workspaceId: config.workspaceId, threadId: item.id, pinned: nextPinned });
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    pinBusyThreadId.value = null;
    hide();
  }
};

/** 根据置顶状态和提交状态返回菜单文案。 */
function pinActionLabel(item: ThreadSummary): string {
  if (pinBusyThreadId.value !== item.id) {
    return item.pinnedAt ? "取消置顶" : "置顶";
  }
  return item.pinnedAt ? "取消置顶中..." : "置顶中...";
}

/** 判断指定会话是否正在提交置顶状态变更。 */
function isPinBusy(threadId: ThreadId): boolean {
  return String(pinBusyThreadId.value ?? "") === String(threadId);
}

/** 调试面板菜单项文案：根据当前 inspectorVisible 切换「调试 / 关闭调试」。 */
const inspectorMenuLabel = computed(() => (ui.inspectorVisible ? "关闭调试" : "调试"));

/** 切换全局调试（Inspector）面板的显隐。 */
function toggleInspector(): void {
  ui.toggleInspector();
}

/** 判断会话是否属于本地 Codex；连接状态只决定是否可执行。 */
function isLocalCodexThread(item: ThreadSummary): boolean {
  return item.engine === "codex" && !isSharedWorkspace.value && !isKnowledgeThread(item);
}

/** 判断当前连接是否允许提交本地 Codex 重启请求；桌面本机工作区走本地桥。 */
function canRestartCodexAppServer(item: ThreadSummary): boolean {
  return canOperate.value && isLocalCodexThread(item);
}

/** 断线时保留重启入口，并把不可执行原因写在菜单项上。 */
function restartCodexMenuLabel(): string {
  return canOperate.value ? "重启 Codex" : "重启 Codex（CodeFlow 未连接）";
}

/** 从会话列表确认并重启 Codex；终止失败由 Client 显式返回。 */
function confirmRestartCodexAppServer(item: ThreadSummary): void {
  if (!canOperate.value || !canRestartCodexAppServer(item) || restartCodexBusy.value) return;
  if (isReadonlyThread(item)) {
    message.info("这条共享会话只读，不能重启 Codex");
    return;
  }
  Modal.confirm({
    title: "重启 Codex",
    content: "将终止当前会话的 Codex app-server 进程，并结束尚未完成的回合。其他会话可继续执行；下一次请求会沿用原会话启动新进程。",
    okText: "重启",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      restartCodexBusy.value = true;
      try {
        const notice = await chat.restartCodexAppServer(ctx.value, { workspaceId: config.workspaceId, threadId: item.id });
        message.success(notice);
      } catch (e) {
        message.error(e instanceof Error ? e.message : String(e));
      } finally {
        restartCodexBusy.value = false;
      }
    },
  });
}

const confirmClear = (item: ThreadSummary) => {
  if (!canOperate.value || isKnowledgeThread(item)) return;
  if (isReadonlyThread(item)) {
    message.info("这条共享会话只读，不能清空历史");
    return;
  }
  Modal.confirm({
    title: "清空会话历史",
    content: "将清空本地历史事件，并重置引擎 session（后续对话将从新上下文开始）。",
    okText: "清空",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      await chat.clearThread(ctx.value, { workspaceId: config.workspaceId, threadId: item.id, resetSession: true });
      message.success("已清空");
    },
  });
};

/** 删除会话；Client 的工作流运行态门禁错误由请求结果原样提示。 */
const confirmDelete = (item: ThreadSummary) => {
  if (!canOperate.value || isKnowledgeThread(item)) return;
  if (isReadonlyThread(item)) {
    message.info("这条共享会话只读，不能删除");
    return;
  }
  // 删除结果由服务端广播同步。
  Modal.confirm({
    title: "删除会话",
    content: "将删除该会话的本地元数据与历史事件（不可恢复）。",
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      try {
        await chat.deleteThread(ctx.value, { workspaceId: config.workspaceId, threadId: item.id });
        message.success("已删除");
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
      }
    },
  });
};

/** 新建普通会话复用现有引擎检查，本机不开放其他列表写操作。 */
const openCreate = () => {
  if (!canCreateThread.value) return;
  createOpen.value = true;
  void refreshThreadGroupsForCurrentWorkspace({ allowHidden: true, preferCache: true });
  const workspaceId = config.workspaceId;
  void refreshEngineAvailability().catch(error => {
    if (isCancelledRequestError(error) || config.workspaceId !== workspaceId || !createOpen.value) return;
    const details = isApiResultError(error) ? error.details as Record<string, unknown> | undefined : undefined;
    const rootCause = error instanceof Error ? error.message : String(error);
    console.error("[thread-list] create engine availability failed", {
      code: "THREAD_CREATE_ENGINE_AVAILABILITY_FAILED",
      requestId: details?.requestId ?? (error && typeof error === "object" && "requestId" in error ? error.requestId : null),
      workspaceId, rootCause,
    });
    message.error(`无法读取引擎状态：${rootCause}`);
  });
};

/** 创建失败由弹框边界展示并保留来源，成功后只打开新建会话。 */
const onCreateConfirm = async (payload: { engine: EngineType; title: string; groupId?: ThreadGroupId | null }) => {
  if (!canCreateThread.value) return;
  creating.value = true;
  try {
    const threadId = await chat.createThread(ctx.value, { workspaceId: config.workspaceId, engine: payload.engine, title: payload.title, groupId: payload.groupId ?? null });
    chat.selectPrimaryThread(threadId, { route: isMobileViewport ? "ignore" : "replace" });
    createOpen.value = false;
  } catch (e) {
    const details = isApiResultError(e) ? e.details as { requestId?: unknown } | undefined : undefined;
    console.error("[thread.create.failed]", { code: isApiResultError(e) ? e.code : "THREAD_CREATE_FAILED",
      requestId: details?.requestId ?? null, workspaceId: config.workspaceId,
      rootCause: e instanceof Error ? e.message : String(e) });
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    creating.value = false;
  }
};

/** 打开分组管理弹框，并刷新最新分组列表。 */
function openGroupManager(): void {
  if (!canOperate.value) return;
  groupManageOpen.value = true;
  void refreshThreadGroupsForCurrentWorkspace();
}

/** 创建分组；名称校验由后端再做一次权威判断。 */
async function createGroupFromManager(): Promise<void> {
  const name = groupDraftName.value.trim();
  if (!name) {
    message.info("请输入分组名称");
    return;
  }
  groupCreating.value = true;
  try {
    await chat.createThreadGroup(ctx.value, { workspaceId: config.workspaceId as WorkspaceId, name });
    groupDraftName.value = "";
    message.success("已创建分组");
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    groupCreating.value = false;
  }
}

/** 进入单个分组的行内重命名状态。 */
function beginRenameGroup(groupId: ThreadGroupId, name: string): void {
  groupRenameId.value = groupId;
  groupRenameName.value = name;
}

/** 提交分组重命名，权限与唯一性由后端校验。 */
async function confirmRenameGroup(groupId: ThreadGroupId): Promise<void> {
  const name = groupRenameName.value.trim();
  if (!name) {
    message.info("请输入分组名称");
    return;
  }
  groupBusyId.value = groupId;
  try {
    await chat.renameThreadGroup(ctx.value, { workspaceId: config.workspaceId as WorkspaceId, groupId, name });
    groupRenameId.value = null;
    groupRenameName.value = "";
    message.success("已重命名");
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    groupBusyId.value = null;
  }
}

/** 二次确认删除分组；删除后会话回到未分组。 */
function confirmDeleteGroup(groupId: ThreadGroupId, name: string): void {
  Modal.confirm({
    title: "删除会话分组",
    content: `删除“${name}”后，组内会话会回到未分组。`,
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      groupBusyId.value = groupId;
      try {
        await chat.deleteThreadGroup(ctx.value, { workspaceId: config.workspaceId as WorkspaceId, groupId });
        message.success("已删除分组");
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        groupBusyId.value = null;
      }
    },
  });
}

/** 仅自建会话支持移动分组，流程/草稿/讨论会话不展示入口。 */
function canMoveThreadGroup(item: ThreadSummary): boolean {
  return showThreadGroupBar.value && item.threadType === "chat" && item.threadSubtype == null;
}

/** 打开移动分组弹框，先刷新可选分组避免使用旧列表。 */
function openMoveGroup(item: ThreadSummary): void {
  if (!canMoveThreadGroup(item)) return;
  moveGroupTarget.value = item;
  moveGroupSearch.value = "";
  moveGroupOpen.value = true;
  void refreshThreadGroupsForCurrentWorkspace();
}

/** 移动会话分组；共享只读会话也允许组织归类。 */
async function assignMoveGroup(groupId: ThreadGroupId | null): Promise<void> {
  const item = moveGroupTarget.value;
  if (!item) return;
  movingGroup.value = true;
  try {
    await chat.assignThreadGroup(ctx.value, { workspaceId: config.workspaceId as WorkspaceId, threadId: item.id, groupId });
    moveGroupOpen.value = false;
    message.success(groupId ? "已移动分组" : "已移至未分组");
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    movingGroup.value = false;
  }
}

/** 组装会话行标签判定的输入，判定链本身在 threadStatusBadge.ts 中，便于单测直接覆盖。 */
function resolveThreadStatusBadge(threadId: ThreadId): ThreadListStatusBadge | null {
  const key = String(threadId);
  const reminder = threadReminderByThreadId.value.get(key);
  const displayConversation = chat.threadDisplayConversationForThread(threadId);
  return resolveThreadRowStatusBadge({
    reminder: reminder ? { label: reminder.statusLabel, tone: reminder.tone } : null,
    pendingInteraction: getPendingInteractionState(displayConversation),
    conversationProcessing: isConversationActivelyProcessing(displayConversation),
    hasRunningTurn: Boolean(chat.threadDisplayRunningStateForThread(threadId)?.runningTurnId),
    workflow: chat.threadWorkflowByThreadId[key] ?? null,
  });
}

/** 将内部会话子类型映射为列表中的产品名称。 */
function getThreadSubtypeLabel(subtype: ThreadSubtype | null): string {
  if (subtype === "knowledge-conversation") return "规格";
  if (subtype === "knowledge-assets") return "规格执行";
  if (subtype === "master") return "主线程";
  if (subtype === "node") return "节点";
  if (subtype === "node-discussion") return "讨论";
  if (subtype === "asset-draft") return "草稿";
  if (subtype === "requirement-analysis") return "需求助手";
  return "流程";
}

</script>

<template>
  <div class="thread-list thread-list--v2">
    <!-- 固定头部区域 -->
    <div class="thread-list__fixed">
      <div class="thread-list__search">
        <a-input
          v-model:value="query"
          class="thread-list__search-input"
          placeholder="搜索会话标题"
          :disabled="!canRead"
          allow-clear
        >
          <template #prefix><SearchOutlined /></template>
        </a-input>
        <a-button size="small" class="thread-list__action-btn" data-workspace-tour="new-thread" :disabled="!canCreateThread" @click="openCreate">+ 新建</a-button>
        <a-dropdown :trigger="['click']">
          <a-button
            size="small"
            class="thread-list__action-btn thread-list__sort-btn"
            :disabled="!canRead"
            aria-label="会话排序"
            :title="`排序：${activeThreadSortOption.label}`"
          >
            <template #icon><SortAscendingOutlined /></template>
          </a-button>
          <template #overlay>
            <a-menu :selected-keys="[activeThreadSort]">
              <a-menu-item
                v-for="option in threadSortOptions"
                :key="option.value"
                @click="selectThreadSort(option.value)"
              >
                {{ option.label }}
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
        <a-button
          size="small"
          class="thread-list__action-btn"
          :disabled="!canRead || refreshing"
          :aria-busy="refreshing"
          aria-label="刷新列表"
          @click="refreshActiveThreadList"
        >
          <template #icon>
            <Loading3QuartersOutlined v-if="refreshing" class="thread-list__refresh-spinner" />
            <ReloadOutlined v-else />
          </template>
        </a-button>
      </div>

      <div class="thread-list__tabs-row">
        <a-segmented
          v-model:value="activeThreadTab"
          :options="threadTabOptions"
          class="thread-list__segmented"
          :disabled="!canRead"
          block
        >
          <template #label="{ payload }">
            <span>{{ payload.name }}<span class="thread-list__tab-suffix">会话</span></span>
          </template>
        </a-segmented>
        <a-tooltip :title="sharedOnlyRelatedToMe ? '关闭只看我' : '只看我'" placement="bottom">
          <button
            v-if="showSharedRelationFilter"
            type="button"
            class="thread-list__scope-chip thread-list__scope-chip-icon"
            :class="{ 'thread-list__scope-chip--on': sharedOnlyRelatedToMe }"
            :aria-pressed="sharedOnlyRelatedToMe"
            :aria-label="sharedOnlyRelatedToMe ? '关闭只看我' : '只看我'"
            @click="sharedOnlyRelatedToMe = !sharedOnlyRelatedToMe"
          >
            <EyeOutlined v-if="!sharedOnlyRelatedToMe" aria-hidden="true" />
            <EyeInvisibleOutlined v-else aria-hidden="true" />
          </button>
        </a-tooltip>
        <slot name="sidebar-toggle" />
      </div>

      <div v-if="showThreadGroupBar" class="thread-list__group-row">
        <a-select
          v-model:value="activeThreadGroupValue"
          class="thread-list__group-select"
          size="small"
          :options="threadGroupSelectOptions"
          :loading="chat.threadGroupsLoading"
          :disabled="!canRead"
          @dropdownVisibleChange="handleThreadGroupDropdownVisibleChange"
        />
        <a-tooltip title="新建分组" placement="bottom">
          <a-button size="small" class="thread-list__group-icon-btn" :disabled="!canOperate" @click="openGroupManager">
            <template #icon><PlusOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="管理分组" placement="bottom">
          <a-button size="small" class="thread-list__group-icon-btn" :disabled="!canOperate" @click="openGroupManager">
            <template #icon><SettingOutlined /></template>
          </a-button>
        </a-tooltip>
      </div>
    </div>

    <!-- 可滚动列表区域 -->
    <div ref="listRef" class="thread-list__scroll">
      <div v-if="!canRead" class="thread-list__hint">
        {{ emptyWorkspaceMessage }}
      </div>
      <template v-else-if="ui.threadFilterTab === 'orchestration'">
        <div
          v-if="orch.instancesLoading && intakeTreeNodes.length === 0"
          class="thread-list__hint"
        >
          加载流程实例中...
        </div>
        <div
          v-else-if="intakeTreeNodes.length === 0"
          class="thread-list__hint"
        >
          暂无流程实例
        </div>

        <!-- 第一层：intake（需求） -->
        <section
          v-for="intake in intakeTreeNodes"
          :key="intake.intakeId"
          class="thread-list__intake"
          :class="{ 'thread-list__intake--expanded': intake.expanded }"
        >
          <button
            type="button"
            class="thread-list__intake-header"
            :aria-expanded="intake.expanded"
            @click="toggleIntakeExpanded(intake.intakeId)"
          >
            <span class="thread-list__intake-caret">{{ intake.expanded ? "▾" : "▸" }}</span>
            <span class="thread-list__intake-title">{{ intake.title }}</span>
            <span v-if="intake.latestStatusLabel" class="thread-list__intake-status">{{ intake.latestStatusLabel }}</span>
          </button>

          <div v-if="intake.expanded" class="thread-list__intake-body">
            <!-- 第二层：instance（流程实例） -->
            <section
              v-for="node in intake.instances"
              :key="node.id"
              class="thread-list__instance"
              :class="{ 'thread-list__instance--expanded': node.expanded }"
            >
              <button
                type="button"
                class="thread-list__instance-header"
                :aria-expanded="node.expanded"
                @click="toggleInstanceExpanded(node.id)"
              >
                <span class="thread-list__instance-caret">{{ node.expanded ? "▾" : "▸" }}</span>
                <span class="thread-list__instance-ordinal">第{{ node.runOrdinal }}次执行</span>
                <span class="thread-list__instance-title">{{ node.timeLabel }}</span>
                <span v-if="node.statusLabel" class="thread-list__instance-status">{{ node.statusLabel }}</span>
              </button>

              <div v-if="node.expanded" class="thread-list__instance-body">
                <div
                  v-if="!node.loaded"
                  class="thread-list__hint thread-list__hint--inline"
                >
                  加载实例详情中...
                </div>
                <div
                  v-else-if="node.hydratingThreads"
                  class="thread-list__hint thread-list__hint--inline"
                >
                  加载会话中...
                </div>
                <div
                  v-else-if="node.threads.length === 0"
                  class="thread-list__hint thread-list__hint--inline"
                >
                  该实例下暂无会话
                </div>
                <!-- 第三层：thread（节点会话） -->
                <div
                  v-for="item in node.threads"
                  :key="item.id"
                  class="thread-list__item thread-list__item--nested"
                  :class="{
                    'thread-list__item--active': isThreadActive(item),
                    'thread-list__item--pinned': Boolean(item.pinnedAt),
                  }"
                  @click="selectThread(item)"
                >
                  <span class="thread-list__engine-icon" :class="`thread-list__engine-icon--${item.engine ?? 'codex'}`">
                    <IconClaude v-if="(item.engine ?? 'codex') === 'claude'" :size="16" />
                    <IconCodex v-else :size="14" />
                  </span>
                  <div class="thread-list__item-body">
                    <div class="thread-list__item-top">
                      <span class="thread-list__item-title" :title="item.title">{{ formatThreadDisplayTitle(item.title, node.workflowName) }}</span>
                    </div>
                    <div class="thread-list__item-meta">
                      <span class="thread-list__item-time" :title="getThreadTimeTitle(item)">{{ getThreadTimeLabel() }} {{ formatThreadListTime(item) }}</span>
                      <span v-if="item.threadSubtype" class="thread-list__meta-tag">{{ getThreadSubtypeLabel(item.threadSubtype ?? null) }}</span>
                      <span v-if="isReadonlyThread(item)" class="thread-list__meta-tag">只读</span>
                    </div>
                    <span
                      v-if="resolveThreadStatusBadge(item.id)"
                      class="thread-list__status-badge thread-list__status-badge--row1"
                      :class="`thread-list__status-badge--${resolveThreadStatusBadge(item.id)?.tone ?? 'neutral'}`"
                    >
                      {{ resolveThreadStatusBadge(item.id)?.label }}
                    </span>
                    <a-dropdown v-if="!isKnowledgeThread(item) || !isReadonlyThread(item)" :trigger="['click']">
                      <button
                        type="button"
                        class="thread-list__item-menu"
                        :disabled="isArchiveBusy(item.id) || isPinBusy(item.id) || restartCodexBusy"
                        aria-label="更多"
                        @click.stop
                      >
                        ⋯
                      </button>
                      <template #overlay>
                        <a-menu>
                          <template v-if="canOperate">
                            <a-menu-item v-if="canMoveThreadGroup(item)" @click="openMoveGroup(item)">
                              <template #icon><SwapOutlined /></template>
                              切换分组
                            </a-menu-item>
                            <a-menu-divider v-if="canMoveThreadGroup(item)" />
                          </template>
                          <template v-if="!isReadonlyThread(item)">
                            <a-menu-item @click="openRename(item)">
                              <template #icon><EditOutlined /></template>
                              重命名
                            </a-menu-item>
                            <a-menu-item :disabled="pinBusyThreadId === item.id" @click="togglePinned(item)">
                              <template #icon><PushpinOutlined /></template>
                              {{ pinActionLabel(item) }}
                            </a-menu-item>
                            <a-menu-item :disabled="archiveBusyThreadId === item.id" @click="toggleArchive(item)">
                              <template #icon><InboxOutlined /></template>
                              {{ archiveActionLabel(item) }}
                            </a-menu-item>
                            <a-menu-divider v-if="!isKnowledgeThread(item)" />
                            <a-menu-item v-if="!isKnowledgeThread(item)" @click="confirmClear(item)">
                              <template #icon><ClearOutlined /></template>
                              清空历史
                            </a-menu-item>
                            <template v-if="canRead && !isKnowledgeThread(item)">
                              <a-menu-item @click="toggleInspector">
                                <template #icon><BugOutlined /></template>
                                {{ inspectorMenuLabel }}
                              </a-menu-item>
                            </template>
                            <a-menu-item v-if="isLocalCodexThread(item)" :disabled="!canRestartCodexAppServer(item) || restartCodexBusy" :title="!canOperate ? 'CodeFlow 未连接' : undefined" @click="confirmRestartCodexAppServer(item)">
                              <template #icon><ReloadOutlined /></template>
                              {{ restartCodexMenuLabel() }}
                            </a-menu-item>
                            <a-menu-item v-if="!isKnowledgeThread(item)" @click="confirmDelete(item)">
                              <template #icon><DeleteOutlined /></template>
                              删除
                            </a-menu-item>
                          </template>
                          <template v-else>
                            <a-menu-item v-if="canRead && !isKnowledgeThread(item)" @click="toggleInspector">
                              <template #icon><BugOutlined /></template>
                              {{ inspectorMenuLabel }}
                            </a-menu-item>
                            <a-menu-item v-if="isLocalCodexThread(item)" :disabled="!canRestartCodexAppServer(item) || restartCodexBusy" :title="!canOperate ? 'CodeFlow 未连接' : undefined" @click="confirmRestartCodexAppServer(item)">
                              <template #icon><ReloadOutlined /></template>
                              {{ restartCodexMenuLabel() }}
                            </a-menu-item>
                          </template>
                        </a-menu>
                      </template>
                    </a-dropdown>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </section>

        <section v-if="orphanOrchestrationThreads.length" class="thread-list__instance thread-list__instance--orphan">
          <header class="thread-list__instance-header thread-list__instance-header--static">
            <span class="thread-list__instance-caret thread-list__instance-caret--placeholder">·</span>
            <span class="thread-list__instance-title">其他编排会话</span>
            <span class="thread-list__instance-status">{{ orphanOrchestrationThreads.length }}</span>
          </header>
          <div class="thread-list__instance-body">
            <div
              v-for="item in orphanOrchestrationThreads"
              :key="item.id"
              class="thread-list__item thread-list__item--nested"
              :class="{
                'thread-list__item--active': isThreadActive(item),
                'thread-list__item--pinned': Boolean(item.pinnedAt),
              }"
              @click="selectThread(item)"
            >
              <span class="thread-list__engine-icon" :class="`thread-list__engine-icon--${item.engine ?? 'codex'}`">
                <IconClaude v-if="(item.engine ?? 'codex') === 'claude'" :size="16" />
                <IconCodex v-else :size="14" />
              </span>
              <div class="thread-list__item-body">
                <div class="thread-list__item-top">
                  <span class="thread-list__item-title" :title="item.title">{{ formatThreadDisplayTitle(item.title) }}</span>
                </div>
                <div class="thread-list__item-meta">
                  <span class="thread-list__item-time" :title="getThreadTimeTitle(item)">{{ getThreadTimeLabel() }} {{ formatThreadListTime(item) }}</span>
                  <span v-if="item.threadSubtype" class="thread-list__meta-tag">{{ getThreadSubtypeLabel(item.threadSubtype ?? null) }}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </template>
      <template v-else>
        <div v-if="ui.threadFilterTab === 'knowledge' && !visibleThreads.length" class="thread-list__hint">
          {{ query.trim() ? '没有匹配的规格会话' : '暂无规格会话，可进入规格库开始讨论。会话保存在当前 Client，共享资产跟随项目。' }}
        </div>
        <div
          v-for="item in visibleThreads"
          :key="item.id"
          class="thread-list__item"
          :class="{
            'thread-list__item--active': isThreadActive(item),
            'thread-list__item--pinned': Boolean(item.pinnedAt),
          }"
          @click="selectThread(item)"
        >
          <span class="thread-list__engine-icon" :class="`thread-list__engine-icon--${item.engine ?? 'codex'}`">
            <IconClaude v-if="(item.engine ?? 'codex') === 'claude'" :size="16" />
            <IconCodex v-else :size="14" />
          </span>
          <div class="thread-list__item-body">
            <div class="thread-list__item-top">
              <span class="thread-list__item-title" :title="item.title">{{ formatThreadDisplayTitle(item.title) }}</span>
            </div>
            <div class="thread-list__item-meta">
              <span class="thread-list__item-time" :title="getThreadTimeTitle(item)">{{ getThreadTimeLabel() }} {{ formatThreadListTime(item) }}</span>
              <span v-if="item.threadSubtype" class="thread-list__meta-tag">{{ getThreadSubtypeLabel(item.threadSubtype ?? null) }}</span>
              <span v-if="isReadonlyThread(item)" class="thread-list__meta-tag">只读</span>
              <span v-if="isPinBusy(item.id) || isArchiveBusy(item.id)" class="thread-list__meta-tag">
                {{ isPinBusy(item.id) ? pinActionLabel(item) : archiveActionLabel(item) }}
              </span>
            </div>
            <span
              v-if="resolveThreadStatusBadge(item.id)"
              class="thread-list__status-badge thread-list__status-badge--row1"
              :class="`thread-list__status-badge--${resolveThreadStatusBadge(item.id)?.tone ?? 'neutral'}`"
            >
              {{ resolveThreadStatusBadge(item.id)?.label }}
            </span>
            <a-dropdown v-if="!isKnowledgeThread(item) || !isReadonlyThread(item)" :trigger="['click']">
              <button
                type="button"
                class="thread-list__item-menu"
                :disabled="isArchiveBusy(item.id) || isPinBusy(item.id) || restartCodexBusy"
                aria-label="更多"
                @click.stop
              >
                ⋯
              </button>
              <template #overlay>
                <a-menu>
                  <template v-if="canOperate">
                    <a-menu-item v-if="canMoveThreadGroup(item)" @click="openMoveGroup(item)">
                      <template #icon><SwapOutlined /></template>
                      切换分组
                    </a-menu-item>
                    <a-menu-divider v-if="canMoveThreadGroup(item)" />
                  </template>
                  <template v-if="!isReadonlyThread(item)">
                    <a-menu-item @click="openRename(item)">
                      <template #icon><EditOutlined /></template>
                      重命名
                    </a-menu-item>
                    <a-menu-item :disabled="pinBusyThreadId === item.id" @click="togglePinned(item)">
                      <template #icon><PushpinOutlined /></template>
                      {{ pinActionLabel(item) }}
                    </a-menu-item>
                    <a-menu-item :disabled="archiveBusyThreadId === item.id" @click="toggleArchive(item)">
                      <template #icon><InboxOutlined /></template>
                      {{ archiveActionLabel(item) }}
                    </a-menu-item>
                    <a-menu-divider v-if="!isKnowledgeThread(item)" />
                    <a-menu-item v-if="!isKnowledgeThread(item)" @click="confirmClear(item)">
                      <template #icon><ClearOutlined /></template>
                      清空历史
                    </a-menu-item>
                    <template v-if="canRead && !isKnowledgeThread(item)">
                      <a-menu-item @click="toggleInspector">
                        <template #icon><BugOutlined /></template>
                        {{ inspectorMenuLabel }}
                      </a-menu-item>
                    </template>
                    <a-menu-item v-if="isLocalCodexThread(item)" :disabled="!canRestartCodexAppServer(item) || restartCodexBusy" :title="!canOperate ? 'CodeFlow 未连接' : undefined" @click="confirmRestartCodexAppServer(item)">
                      <template #icon><ReloadOutlined /></template>
                      {{ restartCodexMenuLabel() }}
                    </a-menu-item>
                    <a-menu-item v-if="!isKnowledgeThread(item)" @click="confirmDelete(item)">
                      <template #icon><DeleteOutlined /></template>
                      删除
                    </a-menu-item>
                  </template>
                  <template v-else>
                    <a-menu-item v-if="canRead && !isKnowledgeThread(item)" @click="toggleInspector">
                      <template #icon><BugOutlined /></template>
                      {{ inspectorMenuLabel }}
                    </a-menu-item>
                    <a-menu-item v-if="isLocalCodexThread(item)" :disabled="!canRestartCodexAppServer(item) || restartCodexBusy" :title="!canOperate ? 'CodeFlow 未连接' : undefined" @click="confirmRestartCodexAppServer(item)">
                      <template #icon><ReloadOutlined /></template>
                      {{ restartCodexMenuLabel() }}
                    </a-menu-item>
                  </template>
                </a-menu>
              </template>
            </a-dropdown>
          </div>
        </div>
      </template>
      <div v-if="hasMore" class="thread-list__load-more" @click="loadMore">
        <template v-if="loadingMore">加载中...</template>
        <template v-else>点击或滚动加载更多 ({{ visibleThreads.length }}/{{ filteredThreads.length }}{{ chat.threadsHasMore ? '+' : '' }})</template>
      </div>
    </div>

    <CreateThreadModal
      v-model:open="createOpen"
      :creating="creating"
      default-engine="codex"
      :default-group-id="defaultCreateThreadGroupId"
      :group-options="createThreadGroupOptions"
      show-group-select
      :disabled-engines="createDisabledEngines"
      @confirm="onCreateConfirm"
    />
    <RenameThreadModal
      v-model:open="renameOpen"
      :saving="renaming"
      :initial-title="renameTarget?.title ?? ''"
      @confirm="onRenameConfirm"
    />
    <a-modal
      v-model:open="groupManageOpen"
      title="会话分组管理"
      :footer="null"
      width="520px"
    >
      <div class="thread-list__group-create">
        <a-input
          v-model:value="groupDraftName"
          placeholder="新分组名称"
          :maxlength="60"
          allow-clear
          @press-enter="createGroupFromManager"
        />
        <a-button type="primary" :loading="groupCreating" @click="createGroupFromManager">创建</a-button>
      </div>
      <div class="thread-list__group-manager">
        <div v-if="chat.threadGroupsLoading" class="thread-list__hint thread-list__hint--inline">加载分组中...</div>
        <div v-else-if="chat.threadGroups.length === 0" class="thread-list__hint thread-list__hint--inline">暂无分组</div>
        <template v-else>
          <div
            v-for="group in chat.threadGroups"
            :key="group.id"
            class="thread-list__group-manager-row"
          >
            <template v-if="groupRenameId === group.id">
              <a-input
                v-model:value="groupRenameName"
                class="thread-list__group-rename-input"
                :maxlength="60"
                @press-enter="confirmRenameGroup(group.id)"
              />
              <a-button size="small" type="primary" :loading="groupBusyId === group.id" @click="confirmRenameGroup(group.id)">保存</a-button>
              <a-button size="small" @click="groupRenameId = null">取消</a-button>
            </template>
            <template v-else>
              <div class="thread-list__group-manager-main">
                <span class="thread-list__group-manager-name">{{ group.name }}</span>
                <span v-if="!group.canManage" class="thread-list__meta-tag">只读</span>
              </div>
              <div class="thread-list__group-manager-actions">
                <a-button size="small" :disabled="!group.canManage" @click="beginRenameGroup(group.id, group.name)">重命名</a-button>
                <a-button size="small" danger :disabled="!group.canManage" :loading="groupBusyId === group.id" @click="confirmDeleteGroup(group.id, group.name)">删除</a-button>
              </div>
            </template>
          </div>
        </template>
      </div>
    </a-modal>
    <a-modal
      v-model:open="moveGroupOpen"
      title="切换分组"
      :footer="null"
      width="420px"
    >
      <div class="thread-list__move-group">
        <a-input
          v-model:value="moveGroupSearch"
          placeholder="搜索分组..."
          allow-clear
        />
        <button
          type="button"
          class="thread-list__move-group-item"
          :disabled="movingGroup"
          @click="assignMoveGroup(null)"
        >
          未分组
        </button>
        <button
          v-for="group in filteredMoveGroups"
          :key="group.id"
          type="button"
          class="thread-list__move-group-item"
          :disabled="movingGroup"
          @click="assignMoveGroup(group.id)"
        >
          {{ group.name }}
        </button>
        <div v-if="filteredMoveGroups.length === 0" class="thread-list__hint thread-list__hint--inline">没有匹配的分组</div>
        <a-button block size="small" @click="openGroupManager">
          <template #icon><PlusOutlined /></template>
          新建分组
        </a-button>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
/* 小号图标按钮会缩放外层 anticon；在内层 SVG 旋转，避免 transform 插值只产生缩放。 */
.thread-list__refresh-spinner :deep(svg) {
  animation: thread-list-refresh-spin 1s linear infinite;
}

@keyframes thread-list-refresh-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.thread-list__fixed {
  container-type: inline-size;
  container-name: thread-list-header;
}

.thread-list__segmented :deep(.ant-segmented-item) {
  min-width: 0;
}

.thread-list__segmented :deep(.ant-segmented-item-label) {
  padding-inline: 4px;
}

@container thread-list-header (max-width: 395px) {
  .thread-list__tab-suffix {
    display: none;
  }
}

/* 分组栏上下空隙来自共享规则（`.thread-list__tabs-row` margin-bottom 10px、`.thread-list__scroll` margin-top 8px）。
   那两条规则资产库与任务侧栏也在用，因此只在「会话侧栏且渲染了分组栏」时收紧，避免牵连其它侧栏。 */
.thread-list:has(.thread-list__group-row) .thread-list__tabs-row { margin-bottom: 4px; }
.thread-list:has(.thread-list__group-row) .thread-list__scroll { margin-top: 4px; }

/* 分组栏三个控件统一 30px（与侧栏顶部工具按钮一致）；左右不再自带内边距，
   与顶部 tab/搜索区共用容器的 12px 缩进对齐（此前多出 10px，比 tab 区窄一截）。 */
.thread-list__group-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 30px 30px;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}

.thread-list__group-icon-btn {
  width: 30px;
  min-width: 30px;
  height: 30px;
  padding: 0;
}

.thread-list__group-select {
  min-width: 0;
}

/* antd 的 `.ant-select-sm` 规则带更多类名，普通覆盖会被压回 24px，必须用 !important 才能与按钮等高。 */
.thread-list__group-select :deep(.ant-select-selector) {
  height: 30px !important;
  align-items: center;
}

.thread-list__group-select :deep(.ant-select-selection-item),
.thread-list__group-select :deep(.ant-select-selection-placeholder) {
  line-height: 28px !important;
}

.thread-list__group-create {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  margin-bottom: 12px;
}

.thread-list__group-manager {
  display: grid;
  gap: 8px;
  max-height: 420px;
  overflow: auto;
}

.thread-list__group-manager-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 6px 0;
  border-bottom: 1px solid var(--app-divider);
}

.thread-list__group-manager-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.thread-list__group-manager-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thread-list__group-manager-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.thread-list__group-rename-input {
  min-width: 0;
}

.thread-list__move-group {
  display: grid;
  gap: 8px;
}

.thread-list__move-group-item {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 12%, var(--app-divider));
  border-radius: 6px;
  background: color-mix(in srgb, var(--app-panel-bg) 94%, var(--app-bg));
  color: var(--app-text);
  cursor: pointer;
  text-align: left;
}

.thread-list__move-group-item:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-accent) 34%, var(--app-divider));
  background: color-mix(in srgb, var(--app-accent) 8%, var(--app-panel-bg));
}

.thread-list__move-group-item:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
