<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { Layers2 } from "lucide-vue-next";
import {
  CheckOutlined,
  ClockCircleOutlined,
  PlusOutlined,
  PushpinFilled,
  SearchOutlined,
  SwapOutlined,
} from "@ant-design/icons-vue";
import {
  canAccessThreadFrom,
  isOrchestrationScopedThread,
  matchesThreadListScope,
  normalizeThreadListSort,
  type EngineType,
  type ThreadGroupId,
  type ThreadListScope,
  type ThreadSummary,
  type WorkspaceId,
} from "@codeflowai/shared";

import IconClaude from "@/shared/icons/IconClaude.vue";
import IconCodex from "@/shared/icons/IconCodex.vue";

import { getPendingInteractionState, isConversationActivelyProcessing } from "../../chat/chatTypes";
import { resolveThreadRowStatusBadge, type ThreadListStatusBadge } from "../../threads/threadStatusBadge";
import { useApiContext } from "../../../composables/useApiContext";
import { useChatStore } from "../../../store/chat";
import { useConfigStore } from "../../../store/config";
import { useAccountStore, type AccountDrawerTab } from "../../../store/account";
import { useUiStore, type MobilePageEntry } from "../../../store/ui";
import { useWorkspacesStore } from "../../../store/workspaces";
import { useReminderStore } from "../../../store/reminders";
import { getWorkspaceDisplayTitle, getWorkspaceKindLabel } from "../../../utils/workspaceDisplay";
import CreateThreadModal from "../../threads/components/create-thread-modal.vue";
import { isKnowledgeConversation, resolveKnowledgeConversationLocation } from "../../threads/thread-list-navigation";
import { resolveAccountH5DeepLink } from "../accountH5DeepLink";
import H5PendingPanel from "./H5PendingPanel.vue";
import H5SettingsPanel from "./H5SettingsPanel.vue";
import MobileThreadGroups from "../../threads/components/mobile-thread-groups.vue";
import { isCancelledRequestError } from "../../../api/request";
import { isDesktopWorkspace } from "../../../services/desktop";

defineOptions({ name: "H5WorkbenchHome" });

const emit = defineEmits<{
  (event: "navigate", entry: MobilePageEntry): void;
  (event: "logout"): void;
}>();

/** 会话分类：与桌面侧同一套会话范围（已下线「全部」），另加移动端独有的「待办」入口。 */
type HomeFilter = Exclude<ThreadListScope, "all"> | "pending";

const FILTER_OPTIONS: Array<{ key: HomeFilter; label: string }> = [
  { key: "current", label: "自建会话" },
  { key: "orchestration", label: "编排会话" },
  { key: "archived", label: "归档会话" },
  { key: "pending", label: "待办" },
];
const SEARCH_DEBOUNCE_MS = 250;

const route = useRoute();
const router = useRouter();
const { ctx } = useApiContext();
const chat = useChatStore();
const config = useConfigStore();
/** 桌面本机工作区走本地桥，未登录 Server 也可加载会话与分组。 */
const workspaceReady = computed(() => Boolean(
  config.workspaceId && (config.connected || isDesktopWorkspace(config, config.workspaceId)),
));
const account = useAccountStore();
const ui = useUiStore();
const workspaces = useWorkspacesStore();
const reminders = useReminderStore();

// 桌面端可能把范围停在归档/编排：移动端进入时归一到自身默认分类，避免拉取范围与本地过滤分叉。
if (ui.threadFilterTab !== "current") ui.setThreadFilterTab("current");
chat.setActiveThreadGroupId(null);

const activeFilter = ref<HomeFilter>(resolveAccountH5DeepLink(route.query as Record<string, unknown>).tab === "pending" ? "pending" : "current");
const query = ref("");
const loading = ref(false);
const loadingMore = ref(false);
const errorMessage = ref("");
const createOpen = ref(false);
const creating = ref(false);
const profileOpen = ref(false);
const accountSubPageOpen = ref(false);
const workspaceOpen = ref(false);
const groupsOpen = ref(false);
const groupsError = ref("");
const selectedGroupLabel = computed(() => chat.activeThreadGroupId === "ungrouped" ? "未分组"
  : chat.threadGroups.find((group) => group.id === chat.activeThreadGroupId)?.name ?? "全部分组");
const groupOptions = computed(() => [
  { label: "未分组", value: "__ungrouped" },
  ...chat.threadGroups.map((group) => ({ label: group.name, value: String(group.id) })),
]);
const defaultGroupId = computed(() => chat.activeThreadGroupId === "ungrouped" ? null : chat.activeThreadGroupId);
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let requestSequence = 0;

const currentWorkspace = computed(() => workspaces.byId.get(config.workspaceId as WorkspaceId) ?? null);
const workspaceLabel = computed(() => currentWorkspace.value ? getWorkspaceDisplayTitle(currentWorkspace.value) : "选择工作区");
const userLabel = computed(() => config.userSummary?.fullName || config.userSummary?.email || "个人账号");
const threadReminderByThreadId = computed(() => {
  const map = new Map<string, ThreadListStatusBadge>();
  if (String(reminders.currentWorkspaceId ?? "") !== String(config.workspaceId ?? "")) return map;
  for (const item of reminders.currentItems) {
    if (item.sourceType !== "chat" || String(item.workspaceId ?? "").trim() !== String(config.workspaceId ?? "").trim()) continue;
    const threadId = String(item.routeTarget.threadId ?? "").trim();
    if (!threadId || map.has(threadId)) continue;
    map.set(threadId, { label: item.statusLabel, tone: item.tone });
  }
  return map;
});
const userInitial = computed(() => Array.from(userLabel.value.trim())[0] || "我");
const visibleThreads = computed(() => {
  const filter = activeFilter.value;
  if (filter === "pending") return [];
  // 分类判定复用 shared 的会话范围口径，避免移动端另造一套与服务端分页不一致的过滤。
  return chat.threads.filter((thread) => (
    canAccessThreadFrom(thread, "threadList") && matchesThreadListScope(thread, filter)
    && (filter !== "current" || !chat.activeThreadGroupId
      || (chat.activeThreadGroupId === "ungrouped" ? !thread.groupId : thread.groupId === chat.activeThreadGroupId))
  ));
});
const emptyTitle = computed(() => query.value.trim() ? "没有找到相关内容" : "这里还没有内容");
const emptyDescription = computed(() => query.value.trim()
  ? "尝试更换关键词，或切换到其他分类查看。"
  : activeFilter.value === "orchestration" ? "新流程运行后，会话会显示在这里。"
    : activeFilter.value === "archived" ? "归档后的会话会显示在这里。" : "新建一个会话开始工作。"
);

/** 请求当前分类的第一页，会话 Store 仍是列表的唯一数据源。 */
async function refreshThreads(): Promise<void> {
  if (activeFilter.value === "pending" || !workspaceReady.value) return;
  const sequence = ++requestSequence;
  loading.value = true;
  errorMessage.value = "";
  try {
    await chat.refreshThreads(ctx.value, config.workspaceId as WorkspaceId, {
      search: query.value,
      sort: normalizeThreadListSort(ui.threadListSort, "activity_desc"),
      groupId: chat.activeThreadGroupId,
      onlyRelatedToMe: chat.threadListOnlyRelatedToMe,
    });
  } catch (error) {
    if (sequence !== requestSequence) return;
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (sequence === requestSequence) loading.value = false;
  }
}

/** 取消旧定时器并延迟发起标题搜索，减少连续输入请求。 */
function scheduleSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void refreshThreads();
  }, SEARCH_DEBOUNCE_MS);
}

/** 切换 H5 分类并同步既有会话范围，确保后续分页口径一致。 */
function selectFilter(filter: HomeFilter): void {
  if (activeFilter.value === filter) return;
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  activeFilter.value = filter;
  if (filter !== "current") chat.setActiveThreadGroupId(null);
  if (filter === "pending") return;
  if (ui.threadFilterTab !== filter) ui.setThreadFilterTab(filter);
  void refreshThreads();
}

function selectGroup(groupId: ThreadGroupId | "ungrouped" | null): void {
  chat.setActiveThreadGroupId(groupId);
  if (activeFilter.value !== "current") selectFilter("current");
  else void refreshThreads();
}

function threadGroupLabel(thread: ThreadSummary): string {
  if (isOrchestrationScopedThread(thread)) return "";
  if (!thread.groupId) return "未分组";
  return chat.threadGroups.find((group) => group.id === thread.groupId)?.name ?? "已分组";
}

async function refreshGroups(): Promise<void> {
  if (!workspaceReady.value) return;
  const workspaceId = config.workspaceId as WorkspaceId;
  groupsError.value = "";
  try {
    await chat.refreshThreadGroups(ctx.value, workspaceId);
  } catch (error) {
    if (isCancelledRequestError(error) || workspaceId !== config.workspaceId) return;
    groupsError.value = "分组加载失败，请重试";
    console.error({ code: "MOBILE_THREAD_GROUP_LIST_FAILED", requestId: null, workspaceId: config.workspaceId,
      cause: error instanceof Error ? error.message : String(error) });
  }
}

function navigateSettings(entry: MobilePageEntry): void {
  profileOpen.value = false;
  emit("navigate", entry);
}

/** 打开会话；知识入口携带当前项目，其他会话沿用 MobileLayout 页面栈。 */
function openThread(thread: ThreadSummary): void {
  const knowledgeLocation = resolveKnowledgeConversationLocation(thread, config.workspaceId);
  if (knowledgeLocation) {
    void router.push(knowledgeLocation);
    return;
  }
  chat.selectPrimaryThread(thread, { route: "ignore" });
}

/** 打开新建弹框；无可用工作区时给出明确恢复入口。 */
function openCreate(): void {
  if (!workspaceReady.value) {
    message.warning("请先选择工作区");
    workspaceOpen.value = true;
    return;
  }
  createOpen.value = true;
}

/** 使用既有 Store 创建会话，成功后直接进入全屏详情。 */
async function createThread(payload: { engine: EngineType; title: string; groupId?: ThreadGroupId | null }): Promise<void> {
  if (!config.workspaceId) return;
  creating.value = true;
  try {
    const threadId = await chat.createThread(ctx.value, {
      workspaceId: config.workspaceId as WorkspaceId,
      engine: payload.engine,
      title: payload.title,
      groupId: payload.groupId ?? null,
    });
    createOpen.value = false;
    chat.selectPrimaryThread(threadId, { route: "ignore" });
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    creating.value = false;
  }
}

/** 切换工作区并刷新页面，避免继续使用旧工作区局部状态。 */
function switchWorkspace(workspaceId: string): void {
  if (workspaceId === config.workspaceId) {
    workspaceOpen.value = false;
    return;
  }
  config.switchWorkspace(workspaceId, { reloadPage: true });
}

/** 加载下一页会话，失败时保留当前列表并显示错误。 */
async function loadMoreThreads(): Promise<void> {
  if (!chat.threadsHasMore || loadingMore.value || !config.workspaceId) return;
  loadingMore.value = true;
  errorMessage.value = "";
  try {
    await chat.loadMoreThreads(ctx.value, config.workspaceId as WorkspaceId, {
      search: query.value,
      sort: normalizeThreadListSort(ui.threadListSort, "activity_desc"),
      groupId: chat.activeThreadGroupId,
      onlyRelatedToMe: chat.threadListOnlyRelatedToMe,
    });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loadingMore.value = false;
  }
}

/** 展示适合移动端扫读的相对活动时间。 */
function formatActivityTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const elapsed = Date.now() - value;
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`;
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/** 生成会话类型标签，普通会话不重复显示类型。 */
function threadKindLabel(thread: ThreadSummary): string {
  if (isKnowledgeConversation(thread)) return "知识会话";
  if (!isOrchestrationScopedThread(thread)) return thread.engine.toUpperCase();
  if (thread.threadSubtype === "requirement-analysis") return "需求分析";
  if (thread.threadSubtype === "node-discussion") return "节点讨论";
  if (thread.threadSubtype === "node") return "流程节点";
  return "流程";
}

/** 移动列表复用现有待办优先级，避免待补充输入仍显示为运行中。 */
function threadStatusBadge(thread: ThreadSummary): ThreadListStatusBadge | null {
  const conversation = chat.threadDisplayConversationForThread(thread.id);
  return resolveThreadRowStatusBadge({
    reminder: threadReminderByThreadId.value.get(String(thread.id)) ?? null,
    pendingInteraction: getPendingInteractionState(conversation),
    conversationProcessing: isConversationActivelyProcessing(conversation),
    hasRunningTurn: Boolean(chat.threadDisplayRunningStateForThread(thread.id)?.runningTurnId),
    workflow: chat.threadWorkflowByThreadId[String(thread.id)] ?? null,
  }) ?? (thread.readOnly || thread.sharedContext?.readOnly ? { label: "只读", tone: "neutral" } : null);
}

/** 从头像个人中心进入指定账号内容页，复用现有账号业务能力。 */
async function openAccountSection(tab: AccountDrawerTab): Promise<void> {
  accountSubPageOpen.value = true;
  profileOpen.value = false;
  await account.openAccountDrawer({ tab, surface: "h5" });
}

/** H5 账号子页返回时恢复头像设置层，而不是回到会话首页。 */
watch(
  () => account.accountDrawerOpen,
  (open, previousOpen) => {
    if (open || !previousOpen || !accountSubPageOpen.value) return;
    accountSubPageOpen.value = false;
    profileOpen.value = true;
  },
);

/** 头像设置层被遮罩关闭时，清除待恢复的账号子页标记。 */
function handleProfileOpenChange(open: boolean): void {
  profileOpen.value = open;
  if (!open && !account.accountDrawerOpen) accountSubPageOpen.value = false;
}

/** 从移动设置二级页返回时重新展示头像设置层。 */
function restoreProfileSettings(): void {
  profileOpen.value = true;
}

defineExpose({ restoreProfileSettings });

watch(query, scheduleSearch);
watch(() => config.workspaceId, () => {
  chat.setActiveThreadGroupId(null);
  groupsOpen.value = false;
});

watch(
  () => [route.query.tab, route.query.targetId] as const,
  () => {
    if (resolveAccountH5DeepLink(route.query as Record<string, unknown>).tab === "pending") selectFilter("pending");
  },
);

watch(
  () => [config.workspaceId, workspaceReady.value, config.webSessionId] as const,
  () => {
    void refreshGroups();
    if (activeFilter.value !== "pending") void refreshThreads();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  requestSequence += 1;
});
</script>

<template>
  <section class="h5-workbench-home">
    <header class="h5-workbench-home__header">
      <button type="button" class="h5-workbench-home__avatar" aria-label="打开个人信息" @click="profileOpen = true">
        <img v-if="config.userSummary?.avatarUrl" :src="config.userSummary.avatarUrl" alt="" />
        <span v-else>{{ userInitial }}</span>
        <i aria-hidden="true" />
      </button>
      <div class="h5-workbench-home__title">
        <strong>会话</strong>
        <span>{{ workspaceLabel }}</span>
      </div>
      <div class="h5-workbench-home__actions">
        <button type="button" aria-label="切换工作区" title="切换工作区" @click="workspaceOpen = true">
          <SwapOutlined />
        </button>
        <button type="button" class="h5-workbench-home__group-switch" aria-label="分组管理与切换" :title="`当前分组：${selectedGroupLabel}`" aria-haspopup="dialog" :aria-expanded="groupsOpen" :disabled="!workspaceReady" @click="groupsOpen = true; refreshGroups()">
          <Layers2 :size="20" :stroke-width="1.75" />
          <span>{{ selectedGroupLabel }}</span>
        </button>
        <button type="button" aria-label="新建会话" title="新建会话" @click="openCreate">
          <PlusOutlined />
        </button>
      </div>
    </header>

    <div class="h5-workbench-home__toolbar">
      <label class="h5-workbench-home__search">
        <SearchOutlined />
        <input
          v-model="query"
          type="search"
          autocomplete="off"
          :disabled="activeFilter === 'pending'"
          :placeholder="activeFilter === 'pending' ? '待办可在列表中直接处理' : '搜索会话与流程'"
        />
        <button v-if="query" type="button" aria-label="清空搜索" @click="query = ''">清除</button>
      </label>
      <div class="h5-workbench-home__filters" role="tablist" aria-label="会话类型筛选">
        <button
          v-for="filter in FILTER_OPTIONS"
          :key="filter.key"
          type="button"
          role="tab"
          :aria-selected="activeFilter === filter.key"
          :class="{ active: activeFilter === filter.key }"
          @click="selectFilter(filter.key)"
        >
          {{ filter.label }}
        </button>
      </div>
    </div>

    <div v-if="activeFilter === 'pending'" class="h5-workbench-home__pending">
      <H5PendingPanel />
    </div>

    <div v-else class="h5-workbench-home__content">
      <div v-if="errorMessage" class="h5-workbench-home__notice" role="alert">
        <span>{{ errorMessage }}</span>
        <button type="button" @click="refreshThreads">重试</button>
      </div>

      <div v-if="loading && !visibleThreads.length" class="h5-workbench-home__skeleton" aria-label="正在加载会话">
        <span v-for="index in 5" :key="index" />
      </div>

      <div v-else-if="!visibleThreads.length" class="h5-workbench-home__empty">
        <div><SearchOutlined /></div>
        <strong>{{ emptyTitle }}</strong>
        <p>{{ emptyDescription }}</p>
        <button v-if="!query && activeFilter !== 'orchestration'" type="button" @click="openCreate">新建会话</button>
      </div>

      <div v-else class="h5-workbench-home__list">
        <button
          v-for="thread in visibleThreads"
          :key="thread.id"
          type="button"
          class="h5-thread-row"
          @click="openThread(thread)"
        >
          <span class="h5-thread-row__icon" :class="`h5-thread-row__icon--${thread.engine ?? 'codex'}`">
            <IconClaude v-if="(thread.engine ?? 'codex') === 'claude'" :size="26" />
            <IconCodex v-else :size="24" />
          </span>
          <span class="h5-thread-row__body">
            <span class="h5-thread-row__topline">
              <strong>{{ thread.title || "未命名会话" }}</strong>
              <time>{{ formatActivityTime(thread.updatedAt || thread.createdAt) }}</time>
            </span>
            <span class="h5-thread-row__meta">
              <span v-if="threadGroupLabel(thread)" class="h5-thread-row__group">{{ threadGroupLabel(thread) }}</span>
              <span>{{ threadKindLabel(thread) }}</span>
              <span v-if="threadStatusBadge(thread)" class="h5-thread-row__status" :class="`h5-thread-row__status--${threadStatusBadge(thread)?.tone}`">{{ threadStatusBadge(thread)?.label }}</span>
              <span v-if="thread.pinnedAt" class="h5-thread-row__pinned"><PushpinFilled /> 已置顶</span>
            </span>
          </span>
        </button>
        <button v-if="chat.threadsHasMore" type="button" class="h5-workbench-home__more" :disabled="loadingMore" @click="loadMoreThreads">
          {{ loadingMore ? "加载中" : "加载更多" }}
        </button>
      </div>
    </div>

    <a-drawer :open="profileOpen" placement="left" width="min(340px, calc(100vw - 36px))" :closable="false" root-class-name="h5-profile-drawer" @update:open="handleProfileOpenChange">
      <div class="h5-profile">
        <div class="h5-profile__identity">
          <span class="h5-profile__avatar">
            <img v-if="config.userSummary?.avatarUrl" :src="config.userSummary.avatarUrl" alt="" />
            <span v-else>{{ userInitial }}</span>
          </span>
          <div>
            <strong>{{ userLabel }}</strong>
            <span>{{ config.userSummary?.email || "账号信息" }}</span>
            <small>{{ workspaceReady ? "服务已连接" : "服务未连接" }}</small>
          </div>
        </div>
        <H5SettingsPanel embedded @navigate="navigateSettings" @account="openAccountSection" @logout="profileOpen = false; emit('logout')" />
      </div>
    </a-drawer>

    <a-drawer v-model:open="workspaceOpen" placement="bottom" height="min(72dvh, 620px)" :closable="false" root-class-name="h5-workspace-drawer">
      <div class="h5-workspace-sheet">
        <header>
          <div>
            <span>当前工作环境</span>
            <strong>切换工作区</strong>
          </div>
          <button type="button" @click="workspaceOpen = false">完成</button>
        </header>
        <div class="h5-workspace-sheet__list">
          <button
            v-for="workspace in workspaces.workspaces"
            :key="workspace.id"
            type="button"
            :disabled="Boolean(workspace.disabledReason)"
            :class="{ active: workspace.id === config.workspaceId }"
            @click="switchWorkspace(workspace.id)"
          >
            <span class="h5-workspace-sheet__mark">{{ Array.from(getWorkspaceDisplayTitle(workspace))[0] || '工' }}</span>
            <span class="h5-workspace-sheet__copy">
              <strong>{{ getWorkspaceDisplayTitle(workspace) }}</strong>
              <small>{{ getWorkspaceKindLabel(workspace) }}{{ workspace.disabledReason ? ` · ${workspace.disabledReason}` : '' }}</small>
            </span>
            <CheckOutlined v-if="workspace.id === config.workspaceId" />
          </button>
          <div v-if="!workspaces.workspaces.length" class="h5-workspace-sheet__empty">
            <ClockCircleOutlined />
            <span>暂时没有可切换的工作区</span>
          </div>
        </div>
      </div>
    </a-drawer>

    <CreateThreadModal
      v-model:open="createOpen"
      :creating="creating"
      modal-title="新建会话"
      surface="h5"
      :group-options="groupOptions"
      :default-group-id="defaultGroupId"
      show-group-select
      title-placeholder="例如：移动工作台交互评审"
      @confirm="createThread"
    />
    <MobileThreadGroups v-model:open="groupsOpen" :load-error="groupsError" @retry="refreshGroups" @select="selectGroup" @changed="refreshThreads" />
  </section>
</template>

<style scoped>
.h5-workbench-home {
  --h5-brand: #16825d;
  --h5-brand-soft: color-mix(in srgb, var(--h5-brand) 10%, var(--app-panel-bg));
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--app-text);
  background: var(--app-bg);
}

.h5-workbench-home__header {
  flex: 0 0 auto;
  min-height: calc(58px + var(--safe-top));
  padding: var(--safe-top) 12px 0;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-divider) 76%, transparent);
  background: color-mix(in srgb, var(--app-panel-bg) 88%, transparent);
  backdrop-filter: blur(20px) saturate(1.18);
}

.h5-workbench-home__avatar,
.h5-workbench-home__actions button {
  width: 44px;
  height: 44px;
  border: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.h5-workbench-home__avatar {
  position: relative;
  border-radius: 50%;
  color: #fff;
  background: linear-gradient(145deg, #287f69, #125a46);
  font-size: 16px;
  font-weight: 800;
  box-shadow: 0 6px 16px rgba(17, 88, 66, 0.2);
}

.h5-workbench-home__avatar img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}

.h5-workbench-home__avatar i {
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 10px;
  height: 10px;
  border: 2px solid var(--app-panel-bg);
  border-radius: 50%;
  background: #39b77d;
}

.h5-workbench-home__title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.2;
}

.h5-workbench-home__title strong {
  font-size: 17px;
  font-weight: 750;
}

.h5-workbench-home__title span {
  max-width: 100%;
  margin-top: 3px;
  overflow: hidden;
  color: var(--app-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.h5-workbench-home__actions {
  display: flex;
  gap: 2px;
}

.h5-workbench-home__actions button {
  border-radius: 14px;
  color: var(--app-text);
  background: transparent;
  font-size: 18px;
}

.h5-workbench-home__actions button:active {
  background: var(--h5-brand-soft);
  color: var(--h5-brand);
}

.h5-workbench-home__toolbar {
  flex: 0 0 auto;
  padding: 10px 12px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-divider) 72%, transparent);
  background: color-mix(in srgb, var(--app-panel-bg) 76%, var(--app-bg));
}

.h5-workbench-home__actions .h5-workbench-home__group-switch {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 3px 0;
  color: var(--h5-brand);
}

.h5-workbench-home__group-switch span {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 9px;
  line-height: 12px;
  font-weight: 600;
}
.h5-thread-row__group { max-width: 40%; padding: 2px 6px; border-radius: 5px; background: var(--h5-brand-soft); color: var(--h5-brand); font-size: 11px; }
.h5-workbench-home__actions button:disabled { opacity: .4; }

.h5-workbench-home__search {
  height: 42px;
  padding: 0 12px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
  border-radius: 14px;
  color: var(--app-muted);
  background: color-mix(in srgb, var(--app-bg-secondary) 80%, var(--app-panel-bg));
}

.h5-workbench-home__search:focus-within {
  border-color: color-mix(in srgb, var(--h5-brand) 42%, var(--app-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--h5-brand) 10%, transparent);
}

.h5-workbench-home__search input {
  min-width: 0;
  border: 0;
  outline: 0;
  color: var(--app-text);
  background: transparent;
  font-size: 14px;
}

.h5-workbench-home__search input:disabled {
  opacity: 0.7;
}

.h5-workbench-home__search button {
  min-width: 44px;
  min-height: 36px;
  border: 0;
  color: var(--app-muted);
  background: transparent;
  font-size: 12px;
}

.h5-workbench-home__filters {
  height: 42px;
  margin-top: 8px;
  padding: 3px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 2px;
  border-radius: 13px;
  background: color-mix(in srgb, var(--app-bg-secondary) 86%, var(--app-panel-bg));
}

.h5-workbench-home__filters button {
  min-width: 0;
  border: 0;
  border-radius: 10px;
  color: var(--app-muted);
  background: transparent;
  font-size: 13px;
  font-weight: 650;
}

.h5-workbench-home__filters button.active {
  color: var(--h5-brand);
  background: var(--app-panel-bg);
  box-shadow: 0 2px 9px rgba(24, 53, 45, 0.08);
}

.h5-workbench-home__content,
.h5-workbench-home__pending {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.h5-workbench-home__pending {
  padding: 10px;
}

.h5-workbench-home__notice {
  min-height: 48px;
  margin: 10px 12px 0;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid color-mix(in srgb, var(--app-danger) 28%, var(--app-divider));
  border-radius: 12px;
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 7%, var(--app-panel-bg));
  font-size: 12px;
}

.h5-workbench-home__notice span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.h5-workbench-home__notice button {
  min-width: 44px;
  min-height: 36px;
  border: 0;
  color: inherit;
  background: transparent;
  font-weight: 700;
}

.h5-workbench-home__list {
  min-height: 100%;
  padding: 4px 0 16px;
}

.h5-thread-row {
  width: 100%;
  min-height: 78px;
  padding: 10px 14px;
  border: 0;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  color: var(--app-text);
  background: transparent;
  text-align: left;
}

.h5-thread-row:active {
  background: color-mix(in srgb, var(--h5-brand) 7%, var(--app-panel-bg));
}

.h5-thread-row__icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 15px;
  color: #fff;
  background: linear-gradient(135deg, #10b981, #0d9488);
  box-shadow: 0 8px 16px rgba(24, 109, 82, 0.16);
}

/* 引擎底色沿用桌面会话列表口径：Codex 绿渐变，Claude 走品牌强调色。 */
.h5-thread-row__icon--codex {
  background: linear-gradient(135deg, #10b981, #0d9488);
}

.h5-thread-row__icon--claude {
  background: var(--app-accent);
  box-shadow: 0 8px 16px color-mix(in srgb, var(--app-accent) 24%, transparent);
}

.h5-thread-row__body {
  min-width: 0;
  min-height: 58px;
  padding: 4px 0 11px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-divider) 78%, transparent);
}

.h5-thread-row__topline,
.h5-thread-row__meta {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
}

.h5-thread-row__topline strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 680;
}

.h5-thread-row__topline time {
  flex: 0 0 auto;
  color: var(--app-muted);
  font-size: 11px;
}

.h5-thread-row__meta {
  color: var(--app-muted);
  font-size: 12px;
}

.h5-thread-row__meta > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.h5-thread-row__status {
  color: #c87127;
}

.h5-thread-row__status--warning,
.h5-thread-row__status--info {
  color: var(--h5-brand);
}

.h5-thread-row__status--neutral {
  color: var(--app-muted);
}

.h5-thread-row__pinned {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--h5-brand);
}

.h5-workbench-home__more {
  width: calc(100% - 28px);
  min-height: 44px;
  margin: 10px 14px 0;
  border: 1px solid color-mix(in srgb, var(--h5-brand) 20%, var(--app-border));
  border-radius: 12px;
  color: var(--h5-brand);
  background: var(--h5-brand-soft);
  font-weight: 700;
}

.h5-workbench-home__empty,
.h5-workbench-home__skeleton {
  min-height: 100%;
  padding: 32px 24px;
}

.h5-workbench-home__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--app-muted);
  text-align: center;
}

.h5-workbench-home__empty > div {
  width: 54px;
  height: 54px;
  margin-bottom: 14px;
  display: grid;
  place-items: center;
  border-radius: 18px;
  color: var(--h5-brand);
  background: var(--h5-brand-soft);
  font-size: 22px;
}

.h5-workbench-home__empty strong {
  color: var(--app-text);
  font-size: 16px;
}

.h5-workbench-home__empty p {
  max-width: 260px;
  margin: 7px 0 16px;
  font-size: 13px;
  line-height: 1.55;
}

.h5-workbench-home__empty button {
  min-height: 44px;
  padding: 0 18px;
  border: 0;
  border-radius: 13px;
  color: #fff;
  background: var(--h5-brand);
  font-weight: 700;
}

.h5-workbench-home__skeleton {
  display: grid;
  align-content: start;
  gap: 14px;
}

.h5-workbench-home__skeleton span {
  height: 60px;
  border-radius: 14px;
  background: linear-gradient(90deg, var(--app-bg-secondary), var(--app-panel-bg), var(--app-bg-secondary));
  background-size: 200% 100%;
  animation: h5-skeleton 1.2s ease infinite;
}

.h5-profile {
  min-height: 100%;
  color: var(--app-text);
}

.h5-profile__identity {
  padding: calc(16px + var(--safe-top)) 4px 22px;
  display: flex;
  align-items: center;
  gap: 14px;
}

.h5-profile__avatar {
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  overflow: hidden;
  border-radius: 19px;
  color: #fff;
  background: linear-gradient(145deg, #2d8e70, #155b47);
  font-size: 21px;
  font-weight: 800;
}

.h5-profile__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.h5-profile__identity div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.h5-profile__identity strong,
.h5-profile__identity span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.h5-profile__identity strong {
  font-size: 18px;
}

.h5-profile__identity div > span {
  color: var(--app-muted);
  font-size: 12px;
}

.h5-profile__identity small {
  color: #21855f;
  font-size: 11px;
}

.h5-workspace-sheet {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--app-text);
}

.h5-workspace-sheet header {
  min-height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.h5-workspace-sheet header div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.h5-workspace-sheet header span {
  color: var(--app-muted);
  font-size: 11px;
}

.h5-workspace-sheet header strong {
  font-size: 18px;
}

.h5-workspace-sheet header button {
  min-width: 48px;
  min-height: 44px;
  border: 0;
  color: var(--h5-brand);
  background: transparent;
  font-weight: 700;
}

.h5-workspace-sheet__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: var(--safe-bottom);
}

.h5-workspace-sheet__list > button {
  width: 100%;
  min-height: 72px;
  padding: 9px 4px;
  border: 0;
  border-bottom: 1px solid var(--app-divider);
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr) 28px;
  align-items: center;
  gap: 12px;
  color: var(--app-text);
  background: transparent;
  text-align: left;
}

.h5-workspace-sheet__list > button.active {
  color: var(--h5-brand);
  background: color-mix(in srgb, var(--h5-brand) 6%, transparent);
}

.h5-workspace-sheet__mark {
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  color: #fff;
  background: linear-gradient(145deg, #4e83bd, #315f93);
  font-weight: 800;
}

.h5-workspace-sheet__copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.h5-workspace-sheet__copy strong,
.h5-workspace-sheet__copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.h5-workspace-sheet__copy small {
  color: var(--app-muted);
  font-size: 11px;
}

.h5-workspace-sheet__empty {
  min-height: 180px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  color: var(--app-muted);
}

@keyframes h5-skeleton {
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
}

@media (max-width: 340px) {
  .h5-workbench-home__header {
    padding-right: 7px;
    padding-left: 8px;
    grid-template-columns: 44px minmax(0, 1fr) auto;
  }

  .h5-workbench-home__actions button {
    width: 40px;
  }

  .h5-thread-row {
    padding-right: 10px;
    padding-left: 10px;
    grid-template-columns: 44px minmax(0, 1fr);
    gap: 9px;
  }

  .h5-thread-row__icon {
    width: 44px;
    height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .h5-workbench-home__skeleton span {
    animation: none;
  }
}
</style>

<style>
.h5-profile-drawer .ant-drawer-content,
.h5-workspace-drawer .ant-drawer-content {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel-bg) 94%, transparent);
  backdrop-filter: blur(24px) saturate(1.12);
}

.h5-profile-drawer .ant-drawer-body,
.h5-workspace-drawer .ant-drawer-body {
  padding: 16px;
}

.h5-profile-drawer .ant-drawer-body {
  padding-bottom: max(12px, min(env(safe-area-inset-bottom, 0px), 8px));
}

.h5-workspace-drawer .ant-drawer-content-wrapper,
.h5-workspace-drawer .ant-drawer-content {
  border-radius: 22px 22px 0 0;
  overflow: hidden;
}
</style>
