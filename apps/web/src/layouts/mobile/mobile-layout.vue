<script setup lang="ts">
import { computed, defineAsyncComponent, inject, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Modal, message } from "ant-design-vue";
import {
  ClearOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOutlined,
  InboxOutlined,
  LeftOutlined,
  MessageOutlined,
  MoreOutlined,
  PushpinOutlined,
  RightOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
} from "@ant-design/icons-vue";

import ChatPanel from "../../features/chat/components/chat-panel.vue";
import ThreadList from "../../features/threads/components/thread-list.vue";
import H5WorkbenchHome from "../../features/office-h5/components/H5WorkbenchHome.vue";
import H5FilesPanel from "../../features/office-h5/components/H5FilesPanel.vue";
import H5ThreadHistoryPanel from "../../features/office-h5/components/H5ThreadHistoryPanel.vue";
import H5ThreadPreferencesPanel from "../../features/office-h5/components/H5ThreadPreferencesPanel.vue";
import RenameThreadModal from "../../features/threads/components/rename-thread-modal.vue";
import {
  isMigratedAdminPanel,
  resolveAdminConsoleUrl,
  resolveAllowedSystemPanels,
  resolveAvailableSystemPanels,
  resolveRouteSystemPanel,
  resolveSystemGroupLabels,
  resolveSystemScope,
  type SystemPanelGroup,
} from "../../features/admin/systemPanelAccess";
import { useAdminStore, type AdminPanel } from "../../store/admin";
import { APP_MODALS_KEY } from "../../services/appModals";
import { WS_CLIENT_KEY } from "../../services/ws";
import { useChatStore } from "../../store/chat";
import { useConfigStore } from "../../store/config";
import {
  resolveMobileTabForEntrySurface,
  resolveMobileTabForMainView,
  resolveStandardApplicationEntryPath,
  shouldRestoreMobileChatPageForThreadRoute,
  shouldSyncMobileAdminPanelRoute,
  useUiStore,
  type MobilePageEntry,
  type PreviewWindow,
} from "../../store/ui";
import { useApiContext } from "../../composables/useApiContext";
import { useViewport } from "../../composables/useViewport";
import { getMyRelayKeyStatus } from "../../api/account";
import { pushLoginRoute } from "../../features/account/loginRedirect";
import { isConversationActivelyProcessing, isConversationAwaitingInteraction, getPendingInteractionState } from "../../features/chat/chatTypes";
import { isSharedWorkspaceSelectionId } from "../../utils/workspaceId";
import { buildThreadUrl, getThreadIdFromUrl, THREAD_URL_CHANGED_EVENT } from "../../features/threads/thread-url";
import { useMobilePageHistory } from "./useMobilePageHistory";

defineOptions({ name: "MobileLayout" });

const emit = defineEmits<{
  (e: "logout"): void;
}>();

/** 非首屏移动页面按需加载，避免 H5 深链预取文件预览、设置和管理依赖。 */
const ExplorerPanel = defineAsyncComponent(() => import("../../features/explorer/components/explorer-panel.vue"));
const InspectorPanel = defineAsyncComponent(() => import("../../features/inspector/components/inspector-panel.vue"));
const LandingPage = defineAsyncComponent(() => import("../../features/landing/components/landing-page.vue"));
const BestPracticePage = defineAsyncComponent(() => import("../../features/best-practices/components/BestPracticePage.vue"));
const ContactPage = defineAsyncComponent(() => import("../../features/landing/components/contact-page.vue"));
const UpgradePage = defineAsyncComponent(() => import("../../features/landing/components/upgrade-page.vue"));
const MobileSettingsTab = defineAsyncComponent(() => import("./mobile-settings-tab.vue"));
const EngineKeysPanel = defineAsyncComponent(() => import("../../features/settings/components/engine-keys-panel.vue"));
const AdminScheduledTasksPanel = defineAsyncComponent(() => import("../../features/admin/components/AdminScheduledTasksPanel.vue"));
const MessageNotificationsPanel = defineAsyncComponent(() => import("../../features/settings/components/message-notifications-panel.vue"));
const CodeflowaiConfigPanel = defineAsyncComponent(() => import("../../features/settings/components/codeflowai-config-panel.vue"));
const SoftwareUpdatePanel = defineAsyncComponent(() => import("../../features/settings/components/software-update-panel.vue"));
const DesktopUpdatePanel = defineAsyncComponent(() => import("../../features/settings/components/desktop-update-panel.vue"));
const ClientUpgradeModal = defineAsyncComponent(() => import("../../features/settings/components/client-upgrade-modal.vue"));
const ClientManagementModal = defineAsyncComponent(() => import("../../features/settings/components/client-management-modal.vue"));
const WorkspaceManager = defineAsyncComponent(() => import("../../features/workspaces/components/workspace-manager.vue"));
const TerminalModal = defineAsyncComponent(() => import("../../features/terminal/components/terminal-modal.vue"));
const ExplorerPreviewWindow = defineAsyncComponent(() => import("../../features/explorer/components/explorer-preview-window.vue"));
const AdminSettingsPanel = defineAsyncComponent(() => import("../../features/admin/components/admin-settings-panel.vue"));
const AdminEngineKeysPanel = defineAsyncComponent(() => import("../../features/admin/components/admin-engine-keys-panel.vue"));
const AdminMobileSettingsPanel = defineAsyncComponent(() => import("../../features/admin/components/admin-mobile-settings-panel.vue"));
const AccountRelayUsagePanel = defineAsyncComponent(() => import("../../features/admin/components/account-relay-usage-panel.vue"));
const RelayPricingReadonlyPanel = defineAsyncComponent(() => import("../../features/admin/components/relay-pricing-readonly-panel.vue"));
const SharedWorkspacePanel = defineAsyncComponent(() => import("../../features/admin/components/shared-workspace-panel.vue"));
const EnterpriseManagementPanel = defineAsyncComponent(() => import("../../features/admin/components/enterprise-management-panel.vue"));
const EnterpriseTokenPanel = defineAsyncComponent(() => import("../../features/admin/components/enterprise-token-panel.vue"));
const EnterpriseAuditPanel = defineAsyncComponent(() => import("../../features/admin/components/enterprise-audit-panel.vue"));
const AdminSessionsPanel = defineAsyncComponent(() => import("../../features/admin/components/admin-sessions-panel.vue"));

const AccountOrderInfoPackagesPanel = defineAsyncComponent(() => import("../../features/admin/components/account-order-info-packages-panel.vue"));
const AccountOrderInfoPaymentOrdersPanel = defineAsyncComponent(() => import("../../features/admin/components/account-order-info-payment-orders-panel.vue"));
const OrchestrationMetricsEntry = defineAsyncComponent(() => import("../../features/orchestration-metrics/OrchestrationMetricsEntry.vue"));

const router = useRouter();
const route = useRoute();
const config = useConfigStore();
const chat = useChatStore();
const ui = useUiStore();
const admin = useAdminStore();
const appModals = inject(APP_MODALS_KEY, null);
const ws = inject(WS_CLIENT_KEY, null);
const { ctx } = useApiContext();
const { visualViewportHeight, visualViewportTop } = useViewport();
const mobilePageStyle = computed(() => ({
  top: `${visualViewportTop.value}px`,
  height: `${visualViewportHeight.value}px`,
  bottom: "auto",
}));
// Public pages keep their navigation; every mobile workbench uses the former H5 design.
const isH5Surface = computed(() => !["landing", "best-practices", "guide", "contact", "upgrade"].includes(ui.mainView));

const systemScope = computed(() =>
  resolveSystemScope({
    accountRole: config.accountRole,
    enterpriseId: config.userSummary?.enterpriseId ?? null,
  }),
);
const panelAvailability = computed(() => ({}));
const isMigratedSuperAdmin = computed(() => isMigratedAdminPanel(systemScope.value, route.query.panel));

/** 从当前 Server 打开控制台，不把公开端 token 带入迁移链接。 */
function openAdminConsole(): void {
  window.open(resolveAdminConsoleUrl(config.serverWsOrigin), "_blank", "noopener");
}
type MobileAdminMenuItem = { key: AdminPanel; label: string; group: SystemPanelGroup };
const adminMenuItems = computed<MobileAdminMenuItem[]>(() =>
  resolveAvailableSystemPanels(systemScope.value, panelAvailability.value).map((item) => ({ key: item.key, label: item.label, group: item.group })),
);
const allowedAdminPanels = computed(() => resolveAllowedSystemPanels(systemScope.value, panelAvailability.value));
const adminMenuGroupOrder: SystemPanelGroup[] = ["settings", "enterprise", "platform", "analytics"];
const adminMenuGroups = computed(() => {
  const labels = resolveSystemGroupLabels(systemScope.value);
  return adminMenuGroupOrder
    .map((group) => ({
      key: group,
      label: labels[group],
      items: adminMenuItems.value.filter((item) => item.group === group),
    }))
    .filter((group) => group.items.length > 0);
});
const adminPanelLabel = computed(() => adminMenuItems.value.find((i) => i.key === admin.activePanel)?.label ?? "系统");
const h5AdminPanelLabel = computed(() => {
  const labels: Partial<Record<AdminPanel, string>> = {
    "enterprise-member-management": "企业成员",
    "enterprise-token": "企业流量",
    "enterprise-audit": "操作审计",
    audit: "操作审计",
    packages: "历史人月与 Token",
    "payment-orders": "支付订单",
  };
  return labels[admin.activePanel] ?? adminPanelLabel.value;
});

/** 判断移动端系统面板是否属于当前可见菜单，非菜单面板不覆盖返回记忆。 */
function isVisibleAdminMenuPanel(panel: AdminPanel): boolean {
  return adminMenuItems.value.some((item) => item.key === panel);
}

/** 可见菜单面板进入时记录最近选择，供度量等独立面板返回设置复用。 */
function rememberVisibleAdminMenuPanel(panel: AdminPanel): void {
  if (isVisibleAdminMenuPanel(panel)) admin.rememberMenuPanel(panel);
}

/** 通过 URL 切换移动端系统面板，使刷新后仍停留在当前页面，并记录可见菜单选择。 */
async function handleAdminPanelMenuClick(info: { key: string | number }): Promise<void> {
  const panel = String(info.key) as AdminPanel;
  if (route.query.panel !== panel) await router.replace({ query: { ...route.query, panel } });
  rememberVisibleAdminMenuPanel(panel);
  if (admin.activePanel !== panel) admin.setPanel(panel);
}

/** 兼容旧面板深链（办公 H5、发票管理、支付订单）；仅允许进入当前账号可见的移动端系统面板。 */
function resolveRouteAdminPanel(allowedPanels: AdminPanel[]): AdminPanel | null {
  const raw = route.query.panel;
  const panel = Array.isArray(raw) ? raw[0] : raw;
  if (typeof panel !== "string" || !panel.trim()) return null;
  return resolveRouteSystemPanel(panel as AdminPanel, allowedPanels);
}

/** 判断 URL 是否显式指定移动端系统面板，用于区分缺省入口和非法深链。 */
function hasRouteAdminPanelQuery(): boolean {
  const raw = route.query.panel;
  const panel = Array.isArray(raw) ? raw[0] : raw;
  return typeof panel === "string" && panel.trim().length > 0;
}

/** 无 panel 参数进入系统时保留上次可见菜单；非法或不可见面板仍回退首个面板。 */
function resolveFallbackAdminPanel(allowedPanels: AdminPanel[]): AdminPanel {
  if (!hasRouteAdminPanelQuery()) {
    if (isVisibleAdminMenuPanel(admin.lastMenuPanel)) return admin.lastMenuPanel;
    if (isVisibleAdminMenuPanel(admin.activePanel)) return admin.activePanel;
  }
  return allowedPanels[0]!;
}

const settingsConnectError = ref<string | null>(null);
const renameOpen = ref(false);
const renaming = ref(false);
const threadMenuOpen = ref(false);
const pinning = ref(false);
const archiving = ref(false);
const threadUrlTick = ref(0);
const chatPanelRef = ref<{ locateMessage: (messageId: string) => boolean } | null>(null);
const mobileHistory = useMobilePageHistory(ui, router, () => {
  const top = ui.currentMobilePage;
  if (top) restoreSettingsParent(top);
  threadMenuOpen.value = false;
  navigating = false;
});
const { animate: animatePages, transition: pageTransition } = mobileHistory;
const h5WorkbenchHomeRef = ref<{ restoreProfileSettings: () => void } | null>(null);

const activeTab = computed({
  get: () => resolveMobileTabForEntrySurface("standard", ui.activeMobileTab),
  set: (value) => ui.setActiveMobileTab(resolveMobileTabForEntrySurface("standard", value)),
});

// Notification links always open their target, not a previously visited settings page.
watch(() => route.fullPath, () => {
  if (route.name !== "chat") return;
  if (route.query.threadId || route.query.targetId || route.query.tab) {
    ui.clearMobilePages();
    ui.setActiveMobileTab("sessions");
  }
}, { immediate: true });

/** 归一当前入口的 Tab 和页面栈，清理已下线的办公绑定页面。 */
function normalizeMobileStateForSurface(): void {
  const currentSettingsTab = ui.currentMobilePage?.type === "settings"
    ? String(ui.currentMobilePage.context?.tab ?? "")
    : "";
  if (currentSettingsTab === "office-bindings") {
    ui.clearMobilePages();
  }
  const normalized = isH5Surface.value && ["home", "workspace", "orders"].includes(ui.activeMobileTab) ? "sessions" : resolveMobileTabForEntrySurface("standard", ui.activeMobileTab);
  if (normalized !== ui.activeMobileTab) ui.setActiveMobileTab(normalized);
}

watch(
  () => [
    ui.mainView,
    ui.activeMobileTab,
    ui.currentMobilePage?.type ?? "",
    String(ui.currentMobilePage?.context?.tab ?? ""),
  ] as const,
  normalizeMobileStateForSurface,
  { immediate: true },
);

const selectedThread = computed(() => chat.selectedThread);
const conversation = computed(() => chat.selectedDisplayConversation);
const runningState = computed(() => chat.threadDisplayRunningStateForThread(chat.selectedThreadId));
const pendingInteraction = computed(() => getPendingInteractionState(conversation.value));
const showRunningTag = computed(() =>
  isConversationActivelyProcessing(conversation.value)
  || (!conversation.value && Boolean(runningState.value?.runningTurnId)),
);
const showPendingTag = computed(() =>
  isConversationAwaitingInteraction(conversation.value),
);
const h5ThreadStatusLabel = computed(() => {
  if (showRunningTag.value) return "CodeFlow 正在处理";
  if (showPendingTag.value) return pendingInteraction.value === "approval" ? "等待确认" : "等待补充输入";
  return config.connected ? "CodeFlow 在线" : "CodeFlow 未连接";
});
const h5ThreadMenuSummary = computed(() => {
  const engine = selectedThread.value?.engine === "claude" ? "Claude" : "Codex";
  return `${engine} · Agent、模型、强度与计划模式`;
});
// ── 设置页面 ──
const settingsPageTab = computed(() => {
  const page = ui.currentMobilePage;
  if (page?.type !== "settings") return "";
  return (page.context?.tab as string) ?? "";
});
const settingsPageTitle = computed(() => {
  const map: Record<string, string> = {
    connection: "连接配置",
    "engine-keys": "模型与密钥",
    "scheduled-tasks": "定时任务",
    "app-update": "应用更新",
    "relay-self-usage": "流量统计",
    orders: "支付订单",
    "message-notifications": "消息通知",
    "office-bindings": "办公平台账号绑定",
    workspaces: "工作区管理",
    "codeflowai-config": "基础配置",
    "software-update": "大模型CLI",
    "client-upgrade": "客户端升级",
    "client-management": "设备与运行状态",
    terminal: "终端管理",
  };
  return map[settingsPageTab.value] ?? "设置";
});
const isSimpleSettingsTab = computed(() =>
  ["connection", "engine-keys", "message-notifications", "office-bindings", "workspaces", "codeflowai-config", "software-update", "client-upgrade", "client-management"].includes(settingsPageTab.value),
);
const hasWorkspace = computed(() => Boolean(String(config.workspaceId ?? "").trim()));
const isCurrentSharedWorkspace = computed(() => isSharedWorkspaceSelectionId(String(config.workspaceId ?? "")));
// ── 文件预览页面 ──
const previewPageWindow = computed<PreviewWindow | null>(() => {
  const page = ui.currentMobilePage;
  if (page?.type !== "explorer-preview") return null;
  return (page.context?.win as PreviewWindow) ?? null;
});
const previewPageTitle = computed(() => {
  const win = previewPageWindow.value;
  if (!win) return "文件预览";
  return win.filePath.split("/").pop() ?? "文件预览";
});

/** Enters the standard mobile workbench without switching to a dedicated H5 route. */
function enterApplication() {
  const targetPath = resolveStandardApplicationEntryPath({ homePath: config.homePath });
  activeTab.value = "sessions";
  if (config.authMode === "account" && config.hasActiveSession) {
    void router.push(targetPath);
    return;
  }
  void pushLoginRoute(router, { currentFullPath: targetPath });
}

async function handleSettingsConnect() {
  settingsConnectError.value = null;
  try {
    await ws?.connect();
  } catch (e) {
    settingsConnectError.value = e instanceof Error ? e.message : String(e);
    message.error(settingsConnectError.value);
  }
}
function handleSettingsDisconnect() {
  ws?.disconnect();
}

async function goLoginFromMobileSettings() {
  await popPage();
  void pushLoginRoute(router);
}

// ── 页面栈导航 ──
let navigating = false; // 防止过渡期间重复触发
let restoringThreadRoutePage = false;

/** 压入移动端子页，并仅在系统路由中同步管理面板查询参数。 */
function pushPage(entry: MobilePageEntry) {
  if (navigating) return;
  const requestedPanel = entry.type === "admin" ? String(entry.context?.panel ?? "") as AdminPanel : null;
  if (requestedPanel && allowedAdminPanels.value.includes(requestedPanel)) {
    admin.setPanel(requestedPanel);
    if (shouldSyncMobileAdminPanelRoute(route.name)) {
      void router.replace({ query: { ...route.query, panel: requestedPanel } });
    }
  }
  navigating = true;
  pageTransition.value = "slide-left";
  ui.pushMobilePage(entry);
  setTimeout(() => { navigating = false; }, 300);
}

/** 会话选择由 watcher 的栈顶守卫去重，不受通用页面过渡锁阻挡。 */
function pushChatPage(threadId: string) {
  pageTransition.value = "slide-left";
  // 关键：先把当前（会话列表）历史项清成无 threadId，再为新压栈的 chat 页面写 threadId。
  // 这样浏览器返回时会回到“干净”的列表页，而不会把旧 query 带回来。
  clearThreadIdQuery();
  ui.pushMobilePage({ type: "chat" }, { url: buildThreadUrl(threadId as any) });
  chat.syncPrimaryThreadUrl(threadId as any, { mode: "replace" });
}

function clearThreadIdQuery(): void {
  chat.syncPrimaryThreadUrl(null, { mode: "replace" });
}

/** 读取普通移动端或 H5 地址栏中的目标会话，兼容 history API 直接改 URL。 */
function resolveRouteThreadIdForMobilePage(): string | null {
  threadUrlTick.value;
  void route.fullPath;
  const expectedRouteName = "chat";
  if (String(route.name ?? "") !== expectedRouteName) return null;
  if (typeof window !== "undefined") {
    const threadId = getThreadIdFromUrl();
    return threadId ? String(threadId) : null;
  }
  const threadId = String(route.query.threadId ?? "").trim();
  return threadId || null;
}

/** 标记 threadId URL 变化，驱动移动端深链页面栈自愈。 */
function handleThreadUrlChanged(): void {
  threadUrlTick.value += 1;
}

let routeThreadRestoreRunId = 0;

/** 从普通移动端或 H5 的 threadId 深链恢复聊天页面，确保 ChatPanel 挂载读取事件。 */
async function restoreChatPageFromThreadRoute(): Promise<void> {
  const runId = ++routeThreadRestoreRunId;
  const requestedThreadId = resolveRouteThreadIdForMobilePage();
  if (!shouldRestoreMobileChatPageForThreadRoute({
    routeName: route.name,
    requestedThreadId,
    currentPageType: ui.currentMobilePage?.type ?? null,
    entrySurface: "standard",
  })) {
    return;
  }

  restoringThreadRoutePage = true;
  try {
    if (activeTab.value !== "sessions") {
      activeTab.value = "sessions";
      await nextTick();
      if (runId !== routeThreadRestoreRunId) return;
    }

    if (!shouldRestoreMobileChatPageForThreadRoute({
      routeName: route.name,
      requestedThreadId: resolveRouteThreadIdForMobilePage(),
      currentPageType: ui.currentMobilePage?.type ?? null,
      entrySurface: "standard",
    })) {
      return;
    }

    ui.pushMobilePage({ type: "chat" }, { history: "replace" });
    await nextTick();
  } finally {
    if (runId === routeThreadRestoreRunId) {
      window.setTimeout(() => {
        if (runId === routeThreadRestoreRunId) {
          restoringThreadRoutePage = false;
        }
      }, 0);
    }
  }
}

/** 判断是否为首页派生移动页，返回时统一复位到首页路由。 */
function isMobileHomeSubPage(type: MobilePageEntry["type"] | undefined): boolean {
  return type === "best-practices" || type === "contact" || type === "upgrade";
}

const bestPracticeBackLabel = computed(() => route.name === "best-practice-detail" ? "列表" : "首页");

/** 仅将头像设置打开的二级页返回到头像设置层。 */
function restoreSettingsParent(entry: MobilePageEntry | null): void {
  if (entry?.type !== "settings" || entry.context?.returnTo !== "profile-settings") return;
  void nextTick(() => h5WorkbenchHomeRef.value?.restoreProfileSettings());
}

/** 最佳实践详情返回列表，列表页再退出到移动首页。 */
function handleBestPracticeBack(): void {
  if (route.name === "best-practice-detail") {
    void router.push("/best-practices");
    return;
  }
  popPage();
}

/** 弹出移动端页栈并同步浏览器历史，离开聊天时同时关闭 H5 操作面板。 */
async function popPage(): Promise<void> {
  if (!ui.currentMobilePage) return;
  threadMenuOpen.value = false;
  const popped = ui.currentMobilePage;
  if (await mobileHistory.back()) return;
  restoreSettingsParent(popped);
  // 直接打开深链时没有应用内上一项，回到当前功能的根页。
  ui.clearMobilePages();
  if (popped?.type === "chat") {
    clearThreadIdQuery();
  }
  if (isMobileHomeSubPage(popped?.type)) {
    await router.replace("/");
  }
}

/** 从历史搜索返回聊天页，并在聊天 DOM 恢复后定位目标消息。 */
async function locateThreadMessage(messageId: string): Promise<void> {
  await popPage();
  await nextTick();
  window.setTimeout(() => {
    const located = chatPanelRef.value?.locateMessage(messageId) ?? false;
    if (!located) message.warning("未能定位该消息，请先在会话中向上加载更多历史");
  }, 320);
}

onMounted(() => {
  window.addEventListener("popstate", handleThreadUrlChanged);
  window.addEventListener(THREAD_URL_CHANGED_EVENT, handleThreadUrlChanged as EventListener);
});
onUnmounted(() => {
  window.removeEventListener("popstate", handleThreadUrlChanged);
  window.removeEventListener(THREAD_URL_CHANGED_EVENT, handleThreadUrlChanged as EventListener);
});

// Tab 切换时清空页面栈
watch(activeTab, () => {
  if (restoringThreadRoutePage || mobileHistory.restoring.value) return;
  if (!isH5Surface.value && activeTab.value !== "home") {
    void router.push("/chat");
  }
  if (
    activeTab.value === "sessions"
    && ui.currentMobilePage?.type === "chat"
    && resolveRouteThreadIdForMobilePage()
  ) {
    return;
  }
  const leavingChatFlow = ui.mobilePageStack.some((p) => p.type === "chat");
  ui.clearMobilePages();
  if (leavingChatFlow) clearThreadIdQuery();
});

/** 在移动端路由、权限与当前系统面板之间保持单一有效状态。 */
watch(
  [() => route.name, allowedAdminPanels, () => route.query.panel, () => admin.activePanel, () => ui.mainView],
  ([routeName, panels]) => {
    if (ui.mainView !== "admin" || !shouldSyncMobileAdminPanelRoute(routeName) || !panels.length) return;
    if (isMigratedSuperAdmin.value) return;
    const requestedPanel = resolveRouteAdminPanel(panels);
    if (requestedPanel && requestedPanel !== admin.activePanel) {
      rememberVisibleAdminMenuPanel(requestedPanel);
      admin.setPanel(requestedPanel);
      return;
    }
    if (requestedPanel) {
      rememberVisibleAdminMenuPanel(requestedPanel);
      return;
    }
    const nextPanel = resolveFallbackAdminPanel(panels);
    if (nextPanel !== admin.activePanel) admin.setPanel(nextPanel);
    if (route.query.panel !== nextPanel) void router.replace({ query: { ...route.query, panel: nextPanel } });
  },
  { immediate: true },
);

// 监听会话选择，自动进入会话页面
watch(
  () => chat.threadSelectCounter,
  () => {
    if (chat.selectedThreadId && activeTab.value === "sessions") {
      // 栈顶已是 chat 页面时不重复 push（WS 重连、URL 恢复等可能多次触发 selectThread）
      if (ui.currentMobilePage?.type === "chat") return;
      pushChatPage(String(chat.selectedThreadId));
    }
  },
);

// 监听首页派生路由，在移动端改为页面栈导航
watch(
  () => [ui.mainView, route.path] as const,
  async ([view]) => {
    const normalizedTab = resolveMobileTabForMainView(view, activeTab.value);
    if (normalizedTab !== activeTab.value) {
      activeTab.value = normalizedTab;
      await nextTick();
      if (ui.mainView !== view) return;
    }

    if (view === "landing") {
      if (isMobileHomeSubPage(ui.currentMobilePage?.type)) ui.clearMobilePages();
      return;
    }
    if (view === "admin") {
      if (ui.currentMobilePage?.type !== "admin") pushPage({ type: "admin" });
      return;
    }
    if (view === "best-practices") {
      if (ui.currentMobilePage?.type === "best-practices") return;
      pushPage({ type: "best-practices" });
      return;
    }
    if (view === "contact") {
      if (ui.currentMobilePage?.type === "contact") return;
      pushPage({ type: "contact" });
      return;
    }
    if (view === "upgrade") {
      if (ui.currentMobilePage?.type === "upgrade") return;
      pushPage({ type: "upgrade" });
    }
  },
  { immediate: true },
);

watch(
  () => [ui.mainView, String(route.name ?? ""), route.fullPath, threadUrlTick.value, ui.currentMobilePage?.type ?? null] as const,
  () => {
    void restoreChatPageFromThreadRoute();
  },
  { immediate: true },
);

// ── 会话操作 ──
/** 打开重命名弹窗，并关闭可能存在的 H5 会话操作面板。 */
function openRename(): void {
  if (!selectedThread.value) return;
  threadMenuOpen.value = false;
  renameOpen.value = true;
}

/** 提交当前会话的新名称，失败时保留弹窗供用户重试。 */
async function onRenameConfirm(payload: { title: string }): Promise<void> {
  if (!selectedThread.value || !config.workspaceId) return;
  renaming.value = true;
  try {
    await chat.renameThread(ctx.value, { workspaceId: config.workspaceId, threadId: selectedThread.value.id, title: payload.title });
    renameOpen.value = false;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    renaming.value = false;
  }
}

/** 置顶或取消置顶当前会话，提交期间阻止重复操作。 */
async function togglePinned(): Promise<void> {
  if (!selectedThread.value || !config.workspaceId || pinning.value) return;
  const nextPinned = !selectedThread.value.pinnedAt;
  threadMenuOpen.value = false;
  pinning.value = true;
  try {
    await chat.setThreadPinned(ctx.value, {
      workspaceId: config.workspaceId,
      threadId: selectedThread.value.id,
      pinned: nextPinned,
    });
    message.success(nextPinned ? "会话已置顶" : "已取消置顶");
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    pinning.value = false;
  }
}

/** 归档或取消归档当前会话，失败时显式反馈。 */
async function toggleArchive(): Promise<void> {
  if (!selectedThread.value || !config.workspaceId || archiving.value) return;
  const nextArchived = !selectedThread.value.archived;
  threadMenuOpen.value = false;
  archiving.value = true;
  try {
    await chat.setThreadArchived(ctx.value, {
      workspaceId: config.workspaceId,
      threadId: selectedThread.value.id,
      archived: nextArchived,
    });
    message.success(nextArchived ? "会话已归档" : "已取消归档");
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    archiving.value = false;
  }
}

/** 从 H5 操作面板进入会话工具页，并保持聊天页作为返回目标。 */
function openH5ThreadTool(type: "thread-history" | "thread-preferences"): void {
  threadMenuOpen.value = false;
  pushPage({ type });
}

/** 打开清空历史确认框，确认后重置当前会话上下文。 */
function confirmClear(): void {
  if (!selectedThread.value || !config.workspaceId) return;
  threadMenuOpen.value = false;
  const wid = config.workspaceId;
  const tid = selectedThread.value.id;
  Modal.confirm({
    title: "清空会话历史",
    content: "将清空本地历史事件，并重置引擎 session（后续对话将从新上下文开始）。",
    okText: "清空",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      await chat.clearThread(ctx.value, { workspaceId: wid, threadId: tid, resetSession: true });
      message.success("已清空");
    },
  });
}

/** 打开删除确认框，删除成功后返回会话列表。 */
function confirmDelete(): void {
  if (!selectedThread.value || !config.workspaceId) return;
  threadMenuOpen.value = false;
  const wid = config.workspaceId;
  const tid = selectedThread.value.id;
  Modal.confirm({
    title: "删除会话",
    content: "将删除该会话的本地元数据与历史事件（不可恢复）。",
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      try {
        await chat.deleteThread(ctx.value, { workspaceId: wid, threadId: tid });
        message.success("已删除");
        popPage();
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
      }
    },
  });
}

</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--h5': isH5Surface }">
    <!-- 页面栈覆盖层 -->
    <Transition :name="pageTransition" :css="animatePages">
      <div
        v-if="ui.currentMobilePage"
        class="mobile-page"
        :style="mobilePageStyle"
        :class="{ 'mobile-page--h5-chat': isH5Surface && ui.currentMobilePage.type === 'chat' }"
        :key="ui.currentMobilePage.type"
      >
        <!-- 聊天页面 -->
        <template v-if="ui.currentMobilePage.type === 'chat'">
          <div class="mobile-page__header" :class="{ 'mobile-page__header--h5-chat': isH5Surface }">
            <button class="mobile-page__back mobile-page__back--icon" aria-label="返回会话列表" @click="popPage">
              <LeftOutlined />
            </button>
            <div class="mobile-page__header-main" :class="{ 'mobile-page__header-main--h5': isH5Surface }">
              <div class="mobile-page__header-title">{{ selectedThread?.title }}</div>
              <div v-if="isH5Surface" class="mobile-page__header-subtitle" :class="{ offline: !config.connected }">
                {{ h5ThreadStatusLabel }}
              </div>
            </div>
            <button
              v-if="isH5Surface"
              class="mobile-page__menu-btn"
              aria-label="更多会话操作"
              title="更多会话操作"
              @click="threadMenuOpen = true"
            >
              <MoreOutlined />
            </button>
            <div v-else class="mobile-page__header-meta">
              <span class="mobile-page__engine-badge">{{ selectedThread?.engine }}</span>
              <div class="mobile-page__header-status">
                <a-tag v-if="showRunningTag" color="orange" :bordered="false">运行中</a-tag>
                <a-tag v-else-if="showPendingTag" color="blue" :bordered="false">
                  {{ pendingInteraction === 'approval' ? '待确认' : '待补充输入' }}
                </a-tag>
              </div>
              <a-dropdown :trigger="['click']" overlay-class-name="mobile-page__menu-dropdown">
                <button class="mobile-page__menu-btn" aria-label="更多操作">
                  <MoreOutlined />
                </button>
                <template #overlay>
                  <a-menu>
                    <a-menu-item @click="pushPage({ type: 'debug' })">调试面板</a-menu-item>
                    <a-menu-divider />
                    <a-menu-item @click="openRename">重命名</a-menu-item>
                    <a-menu-item @click="toggleArchive">{{ selectedThread?.archived ? '取消归档' : '归档' }}</a-menu-item>
                    <a-menu-item @click="confirmClear">清空历史</a-menu-item>
                    <a-menu-item @click="confirmDelete">删除</a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </div>
          </div>
          <div class="mobile-page__content">
            <div v-if="!hasWorkspace" class="mobile-empty-workspace">
              <strong>请先创建或选择工作区</strong>
              <span>工作区创建后才能打开会话内容。</span>
            </div>
            <div v-else class="mobile-page__chat">
              <ChatPanel :workspace-id="config.workspaceId"
                ref="chatPanelRef"
                :surface="isH5Surface ? 'h5' : 'default'"
              />
            </div>
          </div>
        </template>

        <!-- H5 会话历史搜索 -->
        <template v-else-if="ui.currentMobilePage.type === 'thread-history'">
          <div class="mobile-page__header mobile-page__header--centered">
            <button class="mobile-page__back mobile-page__back--plain" @click="popPage">
              <LeftOutlined />
              <span>返回</span>
            </button>
            <span class="mobile-page__standalone-title">搜索会话历史</span>
            <span class="mobile-page__header-spacer" aria-hidden="true" />
          </div>
          <div class="mobile-page__content">
            <H5ThreadHistoryPanel
              v-if="selectedThread && config.workspaceId"
              :workspace-id="config.workspaceId"
              :thread-id="selectedThread.id"
              @locate="locateThreadMessage"
            />
          </div>
        </template>

        <!-- H5 会话运行设置 -->
        <template v-else-if="ui.currentMobilePage.type === 'thread-preferences'">
          <div class="mobile-page__header mobile-page__header--centered">
            <button class="mobile-page__back mobile-page__back--plain" @click="popPage">
              <LeftOutlined />
              <span>返回</span>
            </button>
            <span class="mobile-page__standalone-title">会话设置</span>
            <span class="mobile-page__header-spacer" aria-hidden="true" />
          </div>
          <div class="mobile-page__content">
            <H5ThreadPreferencesPanel
              v-if="selectedThread && config.workspaceId"
              :workspace-id="config.workspaceId"
              :thread-id="selectedThread.id"
              :engine="selectedThread.engine"
            />
          </div>
        </template>

        <!-- 调试页面 -->
        <template v-else-if="ui.currentMobilePage.type === 'debug'">
          <div class="mobile-page__header">
            <button class="mobile-page__back mobile-page__back--plain" @click="popPage">
              <LeftOutlined />
              <span>返回</span>
            </button>
            <span style="font-weight: 600">调试面板</span>
            <span />
          </div>
          <div class="mobile-page__content">
            <div class="mobile-page__debug">
              <InspectorPanel />
            </div>
          </div>
        </template>

        <template v-else-if="ui.currentMobilePage.type === 'best-practices'">
          <div class="mobile-page__header">
            <button class="mobile-page__back" @click="handleBestPracticeBack">
              <LeftOutlined />
              <span>{{ bestPracticeBackLabel }}</span>
            </button>
            <span style="font-weight: 600">最佳实践</span>
            <span />
          </div>
          <div class="mobile-page__content">
            <div class="mobile-page__guide">
              <BestPracticePage embedded />
            </div>
          </div>
        </template>

        <template v-else-if="ui.currentMobilePage.type === 'contact'">
          <div class="mobile-page__header">
            <button class="mobile-page__back" @click="popPage()">
              <LeftOutlined />
              <span>首页</span>
            </button>
            <span style="font-weight: 600">联系我们</span>
            <span />
          </div>
          <div class="mobile-page__content">
            <div class="mobile-page__guide">
              <ContactPage
                @open-settings="appModals?.openSettings()"
                @enter-app="enterApplication"
              />
            </div>
          </div>
        </template>

        <template v-else-if="ui.currentMobilePage.type === 'upgrade'">
          <div class="mobile-page__header">
            <button class="mobile-page__back" @click="popPage()">
              <LeftOutlined />
              <span>首页</span>
            </button>
            <span style="font-weight: 600">更新日志</span>
            <span />
          </div>
          <div class="mobile-page__content">
            <div class="mobile-page__guide">
              <UpgradePage
                @open-settings="appModals?.openSettings()"
                @enter-app="enterApplication"
              />
            </div>
          </div>
        </template>

        <!-- 设置子页面（替代 a-modal，解决真机顶部遮挡） -->
        <template v-else-if="ui.currentMobilePage.type === 'settings'">
          <div class="mobile-page__header">
            <button class="mobile-page__back mobile-page__back--plain" @click="popPage">
              <LeftOutlined />
              <span>返回</span>
            </button>
            <span style="font-weight: 600">{{ settingsPageTitle }}</span>
            <span />
          </div>
          <div class="mobile-page__content">
            <!-- 简单配置面板：带内边距和滚动 -->
            <div v-if="settingsPageTab === 'scheduled-tasks' && config.isDesktop" style="height: 100%; min-height: 0; overflow: hidden; padding: 12px; box-sizing: border-box">
              <AdminScheduledTasksPanel source="local" :active="true" />
            </div>
            <div v-else-if="settingsPageTab === 'app-update' && config.isDesktop" style="height: 100%; min-height: 0; overflow: hidden; display: flex; padding: 12px; box-sizing: border-box">
              <DesktopUpdatePanel :active="ui.currentMobilePage?.type === 'settings' && settingsPageTab === 'app-update'" />
            </div>
            <AccountRelayUsagePanel v-else-if="settingsPageTab === 'relay-self-usage'" mobile />
            <AccountOrderInfoPaymentOrdersPanel v-else-if="settingsPageTab === 'orders'" h5 />
            <div v-else-if="isSimpleSettingsTab" class="mobile-tab-scroll" :style="{ padding: '12px', overflow: settingsPageTab === 'engine-keys' ? 'hidden' : 'auto' }">
              <template v-if="settingsPageTab === 'connection'">
                <div style="display: grid; gap: 16px">
                  <a-form layout="vertical" :colon="false">
                    <a-form-item label="当前服务地址">
                      <a-input :value="config.serverWsOrigin" readonly />
                    </a-form-item>
                  </a-form>
                  <a-alert v-if="!config.hasActiveSession" type="info" message="Web 端仅支持账号登录，请先登录账号后再建立连接。" show-icon />
                  <a-alert v-if="settingsConnectError" type="error" :message="settingsConnectError" show-icon closable @close="settingsConnectError = null" />
                  <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
                    <a-button
                      v-if="config.hasActiveSession"
                      type="primary"
                      :disabled="config.connected"
                      :loading="config.connectionStatus === 'connecting' || config.connectionStatus === 'reconnecting'"
                      @click="handleSettingsConnect"
                    >
                      {{ config.connectionStatus === 'connecting' || config.connectionStatus === 'reconnecting' ? '连接中' : '重试连接' }}
                    </a-button>
                    <a-button v-else type="primary" @click="goLoginFromMobileSettings">去登录</a-button>
                    <a-button :disabled="!config.connected" @click="handleSettingsDisconnect">断开</a-button>
                  </div>
                  <div v-if="config.connected" style="font-size: 12px; color: var(--app-muted); display: grid; gap: 4px; border-top: 1px solid var(--app-divider); padding-top: 12px">
                    <div>webSessionId：<span class="mono">{{ config.webSessionId || "-" }}</span></div>
                  </div>
                </div>
              </template>
              <EngineKeysPanel v-else-if="settingsPageTab === 'engine-keys'" :active="settingsPageTab === 'engine-keys'" :surface="isH5Surface ? 'h5' : 'default'" />
              <MessageNotificationsPanel v-else-if="isH5Surface && settingsPageTab === 'message-notifications'" surface="h5" />
              <WorkspaceManager v-else-if="settingsPageTab === 'workspaces'" :active="settingsPageTab === 'workspaces'" :surface="isH5Surface ? 'h5' : 'default'" />
              <CodeflowaiConfigPanel v-else-if="settingsPageTab === 'codeflowai-config' && config.workspaceId" :workspace-id="config.workspaceId" />
              <a-alert
                v-else-if="settingsPageTab === 'codeflowai-config'"
                type="info"
                show-icon
                message="请先创建或选择工作区"
                description="工作区创建后才能维护 CodeFlow 功能参数。"
              />
              <SoftwareUpdatePanel v-else-if="settingsPageTab === 'software-update'" />
              <ClientUpgradeModal v-else-if="settingsPageTab === 'client-upgrade'" embedded :open="true" />
              <ClientManagementModal v-else-if="settingsPageTab === 'client-management'" embedded :open="true" />
            </div>
            <!-- 工具面板：撑满可用空间 -->
            <TerminalModal v-else-if="settingsPageTab === 'terminal' && hasWorkspace" embedded :open="true" />
            <a-alert
              v-else-if="settingsPageTab === 'terminal'"
              type="info"
              show-icon
              message="请先创建或选择工作区"
              description="终端需要绑定到本地工作区后才能使用。"
              style="margin: 16px"
            />
          </div>
        </template>

        <!-- 文件预览页面（替代 a-modal，解决真机顶部遮挡） -->
        <template v-else-if="ui.currentMobilePage.type === 'explorer-preview' && previewPageWindow">
          <div class="mobile-page__header">
            <button class="mobile-page__back mobile-page__back--plain" @click="popPage">
              <LeftOutlined />
              <span>返回</span>
            </button>
            <span style="font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ previewPageTitle }}</span>
            <span />
          </div>
          <div class="mobile-page__content">
            <ExplorerPreviewWindow embedded :win="previewPageWindow" />
          </div>
        </template>

        <!-- 一级业务与系统页面 -->
        <template v-else-if="ui.currentMobilePage.type === 'admin'">
          <div class="mobile-page__header">
            <button class="mobile-page__back mobile-page__back--plain" @click="popPage">
              <LeftOutlined />
              <span>返回</span>
            </button>
            <span style="flex: 1; font-weight: 600">{{ isH5Surface ? h5AdminPanelLabel : admin.activePanel === 'orchestration-metrics' ? '编排度量' : '系统' }}</span>
            <a-dropdown v-if="admin.activePanel !== 'orchestration-metrics'" :trigger="['click']" overlay-class-name="mobile-admin__menu-dropdown" placement="bottomRight">
              <button class="mobile-admin__panel-selector">
                {{ adminPanelLabel }}
                <DownOutlined style="font-size: 10px; opacity: 0.5" />
              </button>
              <template #overlay>
                <a-menu :selected-keys="[admin.activePanel]" @click="handleAdminPanelMenuClick">
                  <a-menu-item-group v-for="group in adminMenuGroups" :key="group.key">
                    <template #title>{{ group.label }}</template>
                    <a-menu-item v-for="item in group.items" :key="item.key">{{ item.label }}</a-menu-item>
                  </a-menu-item-group>
                </a-menu>
              </template>
            </a-dropdown>
            <span v-else-if="isH5Surface" class="mobile-page__header-spacer" aria-hidden="true" />
          </div>
          <div v-if="isMigratedSuperAdmin" class="mobile-page__content mobile-admin mobile-admin--migration">
            <a-result status="info" title="超级管理员功能已迁至管理控制台">
              <template #subTitle>请使用管理控制台访问平台级配置、审计和运营能力。</template>
              <template #extra><a-button type="primary" @click="openAdminConsole">打开管理控制台</a-button></template>
            </a-result>
          </div>
          <div v-else class="mobile-page__content mobile-admin">
            <div class="mobile-admin__body" :class="{ 'mobile-admin__body--sessions': admin.activePanel === 'sessions', 'mobile-admin__body--metrics': admin.activePanel === 'orchestration-metrics' }">
              <AdminSettingsPanel v-if="admin.activePanel === 'settings'" view="settings" />
              <AdminSettingsPanel v-else-if="admin.activePanel === 'workspaces'" view="workspaces" />
              <AdminEngineKeysPanel v-else-if="admin.activePanel === 'engine-keys'" />
              <AccountRelayUsagePanel v-else-if="admin.activePanel === 'relay-self-usage'" />
              <AdminMobileSettingsPanel v-else-if="admin.activePanel === 'message-notifications'" />
              <SharedWorkspacePanel v-else-if="admin.activePanel === 'shared-workspaces'" />
              <EnterpriseManagementPanel v-else-if="admin.activePanel === 'enterprise-member-management'" />
              <EnterpriseTokenPanel v-else-if="admin.activePanel === 'enterprise-token'" />
              <EnterpriseAuditPanel v-else-if="admin.activePanel === 'enterprise-audit'" />
              <AdminSessionsPanel v-else-if="admin.activePanel === 'sessions'" />
              <AccountOrderInfoPackagesPanel v-else-if="admin.activePanel === 'packages'" />
              <AdminScheduledTasksPanel v-else-if="admin.activePanel === 'scheduled-tasks'" />
              <AccountOrderInfoPaymentOrdersPanel v-else-if="admin.activePanel === 'payment-orders'" />
              <RelayPricingReadonlyPanel v-else-if="admin.activePanel === 'relay-price-config'" />
              <!-- 度量面板需保活：KeepAlive 不能作为 v-else-if 分支（会随分支一起卸载而丢缓存），故独立于上方面板链渲染。 -->
              <KeepAlive>
                <OrchestrationMetricsEntry v-if="admin.activePanel === 'orchestration-metrics'" />
              </KeepAlive>
            </div>
          </div>
        </template>
      </div>
    </Transition>

    <!-- 主内容区（Tab内容） -->
    <div v-show="!ui.currentMobilePage" class="app-content app-content--mobile" :class="{ 'app-content--h5': isH5Surface }">
      <div v-if="!isH5Surface" v-show="activeTab === 'home'" class="mobile-tab-scroll">
        <LandingPage @open-settings="appModals?.openSettings()" @enter-app="enterApplication" />
      </div>

      <div v-show="activeTab === 'sessions'" class="mobile-sessions-tab">
        <H5WorkbenchHome v-if="isH5Surface" ref="h5WorkbenchHomeRef" @navigate="pushPage" @logout="emit('logout')" />
        <div v-else class="mobile-sessions-tab__list">
          <ThreadList />
        </div>
      </div>

      <div v-if="!isH5Surface || activeTab === 'explorer'" v-show="activeTab === 'explorer'" class="mobile-tab-scroll" style="height: 100%; overflow: hidden">
        <H5FilesPanel
          v-if="isH5Surface"
          @open-workspaces="pushPage({ type: 'settings', context: { tab: 'workspaces' } })"
        />
        <template v-else>
          <div v-if="!hasWorkspace" class="mobile-empty-workspace">
            <strong>请先创建或选择工作区</strong>
            <span>工作区创建后才能浏览文件。</span>
          </div>
          <ExplorerPanel v-else :workspace-id="config.workspaceId" />
        </template>
      </div>

      <div v-if="!isH5Surface" v-show="activeTab === 'workspace'" class="mobile-tab-scroll">
        <MobileSettingsTab entry-surface="standard" @navigate="pushPage" @logout="emit('logout')" />
      </div>
    </div>

    <!-- 底部导航栏 -->
    <div class="mobile-tabs">
      <template v-if="isH5Surface">
        <button aria-label="会话" class="tab-btn tab-btn--h5" :class="{ active: activeTab === 'sessions' }" @click="activeTab = 'sessions'"><MessageOutlined /><span>会话</span></button>
        <button aria-label="文件" class="tab-btn tab-btn--h5" :class="{ active: activeTab === 'explorer' }" @click="activeTab = 'explorer'"><FolderOutlined /><span>文件</span></button>
      </template>
      <template v-else>
        <button class="tab-btn" :class="{ active: activeTab === 'home' }" @click="activeTab = 'home'">首页</button>
        <button class="tab-btn" :class="{ active: activeTab === 'sessions' }" @click="activeTab = 'sessions'">会话</button>
        <button class="tab-btn" :class="{ active: activeTab === 'explorer' }" @click="activeTab = 'explorer'">文件</button>
        <button class="tab-btn" :class="{ active: activeTab === 'workspace' }" @click="activeTab = 'workspace'">设置</button>
      </template>
    </div>

    <a-drawer
      v-if="isH5Surface"
      v-model:open="threadMenuOpen"
      placement="bottom"
      height="min(72dvh, 610px)"
      :closable="false"
      root-class-name="h5-thread-menu-drawer"
    >
      <section class="h5-thread-menu" aria-label="会话操作">
        <header class="h5-thread-menu__header">
          <strong>会话操作</strong>
          <button type="button" @click="threadMenuOpen = false">完成</button>
        </header>
        <div class="h5-thread-menu__context">
          <span><RobotOutlined /></span>
          <div>
            <strong>{{ selectedThread?.title || '当前会话' }}</strong>
            <small>{{ h5ThreadMenuSummary }}</small>
          </div>
        </div>
        <div class="h5-thread-menu__group">
          <button type="button" @click="openH5ThreadTool('thread-history')">
            <span class="h5-thread-menu__icon search"><SearchOutlined /></span>
            <span class="h5-thread-menu__copy"><strong>搜索会话历史</strong><small>按关键词与日期查找消息</small></span>
            <RightOutlined class="h5-thread-menu__chevron" aria-hidden="true" />
          </button>
          <button type="button" @click="openH5ThreadTool('thread-preferences')">
            <span class="h5-thread-menu__icon settings"><SettingOutlined /></span>
            <span class="h5-thread-menu__copy"><strong>会话设置</strong><small>Agent、模型、强度与计划模式</small></span>
            <RightOutlined class="h5-thread-menu__chevron" aria-hidden="true" />
          </button>
        </div>
        <div class="h5-thread-menu__group">
          <button type="button" @click="openRename">
            <span class="h5-thread-menu__icon edit"><EditOutlined /></span>
            <span class="h5-thread-menu__copy"><strong>重命名</strong><small>修改当前会话名称</small></span>
            <span class="h5-thread-menu__chevron" aria-hidden="true">›</span>
          </button>
          <button type="button" :disabled="pinning || selectedThread?.readOnly" @click="togglePinned">
            <span class="h5-thread-menu__icon pin"><PushpinOutlined /></span>
            <span class="h5-thread-menu__copy"><strong>{{ selectedThread?.pinnedAt ? '取消置顶' : '置顶会话' }}</strong><small>调整会话在列表中的位置</small></span>
          </button>
          <button type="button" :disabled="archiving || selectedThread?.readOnly" @click="toggleArchive">
            <span class="h5-thread-menu__icon archive"><InboxOutlined /></span>
            <span class="h5-thread-menu__copy"><strong>{{ selectedThread?.archived ? '取消归档' : '归档会话' }}</strong><small>从默认列表中收起当前会话</small></span>
          </button>
        </div>
        <div class="h5-thread-menu__group">
          <button type="button" class="danger" :disabled="selectedThread?.readOnly" @click="confirmClear">
            <span class="h5-thread-menu__icon"><ClearOutlined /></span>
            <span class="h5-thread-menu__copy"><strong>清空历史</strong><small>重置本会话上下文</small></span>
          </button>
          <button type="button" class="danger" :disabled="selectedThread?.readOnly" @click="confirmDelete">
            <span class="h5-thread-menu__icon"><DeleteOutlined /></span>
            <span class="h5-thread-menu__copy"><strong>删除会话</strong><small>删除后不可恢复</small></span>
          </button>
        </div>
      </section>
    </a-drawer>

    <!-- 重命名弹窗 -->
    <RenameThreadModal
      v-if="selectedThread"
      v-model:open="renameOpen"
      :saving="renaming"
      :initial-title="selectedThread.title"
      @confirm="onRenameConfirm"
  />
  </div>
</template>

<style scoped>
.mobile-admin__body--metrics {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.app-content--h5 {
  padding: 0;
}

.mobile-page--h5-chat {
  --h5-chat-brand: #16825d;
  background: color-mix(in srgb, var(--app-bg) 96%, var(--app-panel-bg));
}

.mobile-page__header--h5-chat {
  min-height: calc(58px + var(--safe-top));
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr) 54px;
  gap: 0;
  border-bottom-color: color-mix(in srgb, var(--app-divider) 68%, transparent);
  background: color-mix(in srgb, var(--app-panel-bg) 86%, transparent);
  background-image: none;
  box-shadow: none;
  backdrop-filter: blur(24px) saturate(1.28);
}

.mobile-page__header--h5-chat .mobile-page__back,
.mobile-page__header--h5-chat .mobile-page__menu-btn {
  width: 54px;
  min-width: 54px;
  height: 54px;
  min-height: 54px;
  border-radius: 0;
}

.mobile-page__header-main--h5 {
  text-align: center;
}

.mobile-page__header-main--h5 .mobile-page__header-title {
  font-size: 15px;
  font-weight: 700;
  text-align: center;
}

.mobile-page__header-subtitle {
  margin-top: 2px;
  overflow: hidden;
  color: var(--h5-chat-brand);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-page__header-subtitle.offline {
  color: var(--app-muted);
}

.mobile-orders-tab {
  overflow: hidden;
}

.mobile-page__header--centered {
  display: grid;
  grid-template-columns: minmax(72px, 1fr) minmax(0, auto) minmax(72px, 1fr);
}

.mobile-page__standalone-title {
  overflow: hidden;
  color: var(--app-text);
  font-size: 15px;
  font-weight: 650;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-page__header-spacer {
  min-width: 72px;
}

.tab-btn--h5 {
  min-height: 48px;
  height: 48px;
  flex-direction: column;
  gap: 3px;
  border-radius: 12px;
  font-size: 11px;
  line-height: 1;
}

.tab-btn--h5 :deep(.anticon) {
  font-size: 19px;
}

.mobile-sessions-tab__list {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.mobile-empty-workspace {
  min-height: 100%;
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--app-muted);
  text-align: center;
}

.mobile-empty-workspace strong {
  color: var(--app-text);
  font-size: 16px;
}

.h5-thread-menu {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px calc(16px + var(--safe-bottom));
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-bg) 94%, var(--app-panel-bg));
}

.h5-thread-menu__header {
  position: sticky;
  z-index: 2;
  top: 0;
  min-height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
  background: color-mix(in srgb, var(--app-bg) 90%, transparent);
  backdrop-filter: blur(18px);
}

.h5-thread-menu__header strong {
  font-size: 16px;
}

.h5-thread-menu__header button {
  min-width: 52px;
  min-height: 44px;
  border: 0;
  color: var(--h5-chat-brand, #16825d);
  background: transparent;
  font-size: 14px;
  font-weight: 650;
}

.h5-thread-menu__context {
  min-height: 72px;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  align-items: center;
  gap: 11px;
  margin-bottom: 10px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--app-border) 76%, transparent);
  border-radius: 18px;
  background: color-mix(in srgb, var(--app-panel-bg) 94%, transparent);
  box-shadow: 0 9px 24px rgba(20, 20, 19, 0.055);
}

.h5-thread-menu__context > span {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  color: #fff;
  background: #287f69;
  font-size: 20px;
}

.h5-thread-menu__context div,
.h5-thread-menu__copy {
  min-width: 0;
}

.h5-thread-menu__context strong,
.h5-thread-menu__context small,
.h5-thread-menu__copy strong,
.h5-thread-menu__copy small {
  display: block;
}

.h5-thread-menu__context strong {
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.h5-thread-menu__context small,
.h5-thread-menu__copy small {
  margin-top: 3px;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.35;
}

.h5-thread-menu__group {
  overflow: hidden;
  margin-top: 10px;
  border: 1px solid color-mix(in srgb, var(--app-border) 76%, transparent);
  border-radius: 18px;
  background: color-mix(in srgb, var(--app-panel-bg) 94%, transparent);
  box-shadow: 0 9px 24px rgba(20, 20, 19, 0.045);
}

.h5-thread-menu__group > button {
  width: 100%;
  min-height: 62px;
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 10px;
  padding: 8px 13px;
  border: 0;
  border-bottom: 1px solid var(--app-divider);
  color: var(--app-text);
  background: transparent;
  text-align: left;
}

.h5-thread-menu__group > button:last-child {
  border-bottom: 0;
}

.h5-thread-menu__group > button:active {
  background: color-mix(in srgb, var(--h5-chat-brand, #16825d) 7%, var(--app-panel-bg));
}

.h5-thread-menu__group > button:disabled {
  opacity: 0.45;
}

.h5-thread-menu__icon {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  color: #fff;
  background: #66717d;
  font-size: 17px;
}

.h5-thread-menu__icon.search { background: #3977c6; }
.h5-thread-menu__icon.settings { background: #287f69; }
.h5-thread-menu__icon.edit { background: #3f7b68; }
.h5-thread-menu__icon.pin { background: #a66b1f; }
.h5-thread-menu__icon.archive { background: #657383; }

.h5-thread-menu__copy strong {
  font-size: 14px;
}

.h5-thread-menu__chevron {
  color: var(--app-muted);
  font-size: 13px;
}

.h5-thread-menu__group > button.danger,
.h5-thread-menu__group > button.danger .h5-thread-menu__copy strong {
  color: var(--app-danger);
}

.h5-thread-menu__group > button.danger .h5-thread-menu__icon {
  background: color-mix(in srgb, var(--app-danger) 82%, #944);
}
</style>

<style>
.h5-thread-menu-drawer .ant-drawer-content-wrapper,
.h5-thread-menu-drawer .ant-drawer-content {
  overflow: hidden;
  border-radius: 22px 22px 0 0;
}

.h5-thread-menu-drawer .ant-drawer-body {
  padding: 0;
  background: color-mix(in srgb, var(--app-bg) 94%, var(--app-panel-bg));
}
</style>
