<script setup lang="ts">
import { computed, defineAsyncComponent, inject, onUnmounted, ref, watch } from "vue";
import { BarChartOutlined, BellOutlined, BookOutlined, CloseOutlined, ClusterOutlined, CodeOutlined, DesktopOutlined, FolderOutlined, MessageOutlined, NodeIndexOutlined, SettingOutlined } from "@ant-design/icons-vue";
import { message, Modal } from "ant-design-vue";
import type { AccountMeSummaryResponseBody, ActiveInAppNoticeItem, PackageSummary, ReminderItem, WorkspaceId } from "@codeflowai/shared";
import {
  buildReminderAttentionSignature,
  isReminderActionItem,
  isReminderReceiptItem,
  isReminderStatusItem,
} from "@codeflowai/shared";

import WorkspaceSelector from "../../features/workspaces/components/workspace-selector.vue";
import UserMenuTrigger from "../../features/account/components/user-menu-trigger.vue";
import AppWindowControls from "./window-controls.vue";
import {
  resolveOrchestrationEntryForTopLevelNavigation,
  resolveOrchestrationEntryFromRouteName,
  type OrchestrationEntry,
} from "../../features/orchestration/orchestration-entry";
import type { AppShellBindings } from "../../composables/useAppShell";
import { useDesktopWindowControls } from "../../composables/useDesktopWindowControls";
import { useAccountStore } from "../../store/account";
import { useOrchestrationStore } from "../../store/orchestration";
import { useReminderStore } from "../../store/reminders";
import { useRequirementAnalysisStore } from "../../store/requirementAnalysis";
import { useWorkspacesStore } from "../../store/workspaces";
import { trackProductEvent } from "../../analytics/analytics";
import { getDesktopBridge, getDesktopUpdateDetails, isDesktopWorkspace } from "../../services/desktop";
import { APP_MODALS_KEY } from "../../services/appModals";
import { requestDesktopUpdateCheck } from "../../features/settings/desktopUpdateCheckRequest";
import { isCancelledRequestError } from "../../api/request";
import { isSharedWorkspaceSelectionId, workspaceIdsReferToSameWorkspace } from "../../utils/workspaceId";
import { resolveWorkspaceDisplayTitle } from "../../utils/workspaceTitle";
import { resolveRuntimeEnvironmentBadge } from "../../utils/runtimeEnvironment";
import { resolveWorkspaceRuntimeDisplay } from "../../utils/workspaceRuntimeDisplay";
import {
  resolveDesktopAppVersionLabel,
  resolveDesktopRuntimeStatusHint,
  shouldShowDesktopLocalClientPopover,
} from "./desktopLocalClientStatus";

defineOptions({ name: "AppTopbar" });

const props = defineProps<{
  shell: AppShellBindings;
}>();

const account = useAccountStore();
const orch = useOrchestrationStore();
const reminders = useReminderStore();
const analysis = useRequirementAnalysisStore();
const workspaces = useWorkspacesStore();
const appModals = inject(APP_MODALS_KEY, null);
const environmentBadge = resolveRuntimeEnvironmentBadge();

const accountSummary = computed(() => props.shell.config.userSummary);

const {
  controls: desktopWindowControls,
  maximized: windowMaximized,
  minimize: minimizeDesktopWindow,
  toggleMaximize: toggleDesktopWindowMaximize,
  close: closeDesktopWindow,
} = useDesktopWindowControls();
/** macOS 使用原生红绿灯，不再渲染 Web 窗口按钮。 */
const isMacDesktop = typeof window !== "undefined" && window.codeflowDesktop?.platform === "darwin";
const currentWorkspaceId = computed(() => (String(props.shell.config.workspaceId ?? "").trim() || null) as WorkspaceId | null);
const isCurrentSharedWorkspace = computed(() => {
  const workspaceId = currentWorkspaceId.value;
  if (!workspaceId) return false;
  const workspace = workspaces.byId.get(workspaceId) ?? null;
  return workspace?.kind === "shared" || Boolean(workspace?.shared) || isSharedWorkspaceSelectionId(workspaceId);
});
const canShowClientPopover = computed(() => !props.shell.config.isDesktop && props.shell.config.authMode === "account" && !isCurrentSharedWorkspace.value);
const desktopLocalPopoverOpen = ref(false);
/** 本机模式或账号关联失败可查看本机状态；共享工作区仍使用原 Client 入口。 */
const showDesktopLocalPopover = computed(() => shouldShowDesktopLocalClientPopover({
  isDesktop: props.shell.config.isDesktop,
  hasActiveSession: props.shell.config.hasActiveSession,
  isCurrentSharedWorkspace: isCurrentSharedWorkspace.value,
}) || (props.shell.config.isDesktop && !isCurrentSharedWorkspace.value && Boolean(props.shell.desktopAccountFailureDescription)));
const desktopAppVersionLabel = ref<string | null>(null);
let desktopAppVersionLoading = false;

/** 读取与更新弹窗同源的桌面壳+资源版本；缺失时明确未知，不借Client号代填。 */
async function loadDesktopAppVersion(): Promise<void> {
  if (!props.shell.config.isDesktop || desktopAppVersionLabel.value || desktopAppVersionLoading) return;
  desktopAppVersionLoading = true;
  try {
    const label = resolveDesktopAppVersionLabel(await getDesktopUpdateDetails());
    if (label) desktopAppVersionLabel.value = label;
  } catch (error) {
    if (isCancelledRequestError(error)) return;
    const failure = error as { code?: string; requestId?: string; details?: { requestId?: string } };
    console.warn("[DESKTOP_APP_VERSION_READ_FAILED]", {
      code: failure?.code ?? "DESKTOP_APP_VERSION_READ_FAILED",
      requestId: failure?.requestId ?? failure?.details?.requestId ?? null,
      rootCause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    desktopAppVersionLoading = false;
  }
}

const desktopVersionDisplay = computed(() => desktopAppVersionLabel.value || "未知");
const desktopPlatformLabel = computed(() => {
  const platform = props.shell.config.desktopClient?.platform;
  if (!platform) return "";
  return { win32: "Windows", darwin: "macOS", linux: "Linux" }[platform] ?? platform;
});
const desktopLocalWorkspaces = computed(() => (props.shell.config.desktopClient?.workspaceIds ?? []).map((wid) => ({
  id: wid,
  title: resolveWorkspaceDisplayTitle(wid, (id) => workspaces.byId.get(id as WorkspaceId)?.title),
})));
const desktopRuntimeStatusHint = computed(() => resolveDesktopRuntimeStatusHint({
  ready: props.shell.config.localRuntimeReady,
  status: props.shell.config.desktopRuntime?.status,
  error: props.shell.config.desktopError,
}));
watch(showDesktopLocalPopover, (visible) => {
  if (!visible) {
    desktopLocalPopoverOpen.value = false;
    return;
  }
  void loadDesktopAppVersion();
}, { immediate: true });
const pendingInviteCount = computed(() => account.meSummary?.pendingEnterpriseInvitations.length ?? 0);
/** Load the redemption modal on demand. */
const RedemptionCodeModal = defineAsyncComponent(() => import("../../features/account/components/redemption-code-modal.vue"));
const loadActiveInAppNotices = () => import("../../api/in-app-notices");
const redemptionModalOpen = ref(false);
const orchestrationEntry = computed<OrchestrationEntry>(() =>
  resolveOrchestrationEntryFromRouteName(props.shell.router.currentRoute.name)
  ?? props.shell.ui.lastOrchestrationEntry,
);
const workspaceEntryActive = computed(() =>
  props.shell.ui.mainView === "orchestration" && orchestrationEntry.value === "workspace",
);
const assetsEntryActive = computed(() =>
  props.shell.ui.mainView === "orchestration" && orchestrationEntry.value === "assets",
);
const orchestrationMetricsEntryActive = computed(() =>
  props.shell.ui.mainView === "admin" && props.shell.router.currentRoute.query.panel === "orchestration-metrics",
);
const systemEntryActive = computed(() => props.shell.ui.mainView === "admin" && !orchestrationMetricsEntryActive.value);
const workspaceRuntimeDisplay = computed(() => resolveWorkspaceRuntimeDisplay(
  props.shell.presence.activeWorkspaceRuntimeState,
  props.shell.presence.accountClientState,
));
const showClientOfflinePopover = computed(() =>
  workspaceRuntimeDisplay.value.subject === "client"
  && workspaceRuntimeDisplay.value.status === "offline"
  && canShowClientPopover.value,
);
/** 桌面消费 Client 认证事实，普通浏览器沿用当前工作区在线文案。 */
const clientButtonLabel = computed(() => props.shell.config.isDesktop && !isCurrentSharedWorkspace.value
  ? props.shell.connectionLabel
  : workspaceRuntimeDisplay.value.label);
const clientButtonTitle = computed(() => {
  if (showDesktopLocalPopover.value) {
    return props.shell.config.localRuntimeReady ? "本机应用: 运行中" : "本机应用: 未就绪";
  }
  return showClientOfflinePopover.value
    ? "Client: 离线（点击下载桌面版）"
    : workspaceRuntimeDisplay.value.title;
});
const clientButtonClass = computed(() => ({
  "app-topbar__client-btn--offline-guide": showClientOfflinePopover.value,
}));
const clientIconClass = computed(() => {
  if (showDesktopLocalPopover.value) {
    return {
      "app-topbar__client-icon": true,
      "app-topbar__client-icon--online": props.shell.config.localRuntimeReady,
      "app-topbar__client-icon--unknown": !props.shell.config.localRuntimeReady,
    };
  }
  return {
    "app-topbar__client-icon": true,
    "app-topbar__client-icon--online": workspaceRuntimeDisplay.value.tone === "online",
    "app-topbar__client-icon--unknown": workspaceRuntimeDisplay.value.tone === "unknown",
    "app-topbar__client-icon--offline": workspaceRuntimeDisplay.value.tone === "offline",
  };
});

/** 下载与迁移说明使用应用内路由，避免新开浏览器页面。 */
function openDownloadPage(hash = ""): void {
  void props.shell.router.push({ path: "/download", hash });
}

const TOPBAR_ME_SUMMARY_BACKGROUND_MAX_AGE_MS = 120_000;
const IN_APP_NOTICE_SWITCH_INTERVAL_MS = 7_000;
const IN_APP_NOTICE_DISMISS_STORAGE_PREFIX = "codeflow:in-app-notice:dismissed";
const IN_APP_NOTICE_CLOSE_TITLE = "\u5173\u95ed";
const IN_APP_NOTICE_LOAD_FAILED_MESSAGE = "通知加载失败，稍后自动重试";

type TopbarReminderItem = ReminderItem;

const clientPopoverOpen = ref(false);
const reminderPopoverOpen = ref(false);
const activeInAppNotices = ref<ActiveInAppNoticeItem[]>([]);
const dismissedInAppNoticeVersion = ref(0);
const currentInAppNoticeIndex = ref(0);
const inMemoryDismissedInAppNoticeIds = ref<Set<string>>(new Set());
const isMobile = computed(() => typeof window !== "undefined" && window.innerWidth <= 767);
/** 账号会话有效时保留主导航，避免工作区切换刷新后的重连窗口隐藏顶部菜单。 */
const canShowPrimaryNavigation = computed(() => props.shell.config.isDesktop || props.shell.config.connected || props.shell.config.canConnectServer);
/** 桌面本地工作区未登录也可进入设置与度量；浏览器仍要求账号会话。 */
const canOpenSystemViews = computed(() => props.shell.config.isDesktop || props.shell.config.hasActiveSession);
/** 桌面本机工作区走本地桥，未登录 Server 也保留文件入口。 */
const canShowExplorerToggle = computed(() => (
  (props.shell.config.connected || isDesktopWorkspace(props.shell.config, props.shell.config.workspaceId))
  && props.shell.mode === "desktop"
));
const reminderSummary = computed(() => {
  const workspaceId = currentWorkspaceId.value;
  if (!workspaceId) return null;
  return workspaceIdsReferToSameWorkspace(reminders.currentSummary?.workspaceId, workspaceId)
    ? reminders.currentSummary
    : reminders.workspaceSummaryById(workspaceId);
});
const pendingReminderCount = computed(() => reminderSummary.value?.pendingActionCount ?? 0);
const pendingReceiptCount = computed(() => reminderSummary.value?.pendingReceiptCount ?? 0);
const reminderHasAttention = computed(() => pendingReminderCount.value > 0 || pendingReceiptCount.value > 0);
const currentWorkspaceReminderItems = computed(() => {
  const workspaceId = String(currentWorkspaceId.value ?? "").trim();
  if (!workspaceId) return [];
  return reminders.currentItems.filter((item) => String(item.workspaceId ?? "").trim() === workspaceId);
});
const serverActionReminderItems = computed(() => currentWorkspaceReminderItems.value.filter((item) => isReminderActionItem(item)));
const actionReminderItems = computed<TopbarReminderItem[]>(() => [
  ...serverActionReminderItems.value,
]);
const statusReminderItems = computed<TopbarReminderItem[]>(() => currentWorkspaceReminderItems.value.filter((item) => isReminderStatusItem(item)));
const receiptReminderItems = computed<TopbarReminderItem[]>(() => currentWorkspaceReminderItems.value.filter((item) => isReminderReceiptItem(item)));
const reminderGroups = computed<Array<{ key: string; title: string; items: TopbarReminderItem[] }>>(() => [
  { key: "action", title: "待处理", items: actionReminderItems.value },
  { key: "status", title: "最近状态", items: statusReminderItems.value },
  { key: "receipt", title: "待查收", items: receiptReminderItems.value },
].filter((group) => group.items.length > 0));
const visibleReminderItems = computed<TopbarReminderItem[]>(() => reminderGroups.value.flatMap((group) => group.items));
const selectedReminderIds = ref<string[]>([]);
const selectedReminderIdSet = computed(() => new Set(selectedReminderIds.value));
const reminderSelectionMode = ref(false);
const reminderIgnoreLoading = ref(false);
const selectedReminderItems = computed(() =>
  visibleReminderItems.value.filter((item) => selectedReminderIdSet.value.has(item.id)),
);
const allVisibleReminderSelected = computed(() =>
  visibleReminderItems.value.length > 0
  && visibleReminderItems.value.every((item) => selectedReminderIdSet.value.has(item.id)),
);
const currentVisibleChatThreadId = computed(() => {
  if (props.shell.ui.mainView !== "chat") return "";
  if (String(props.shell.router.currentRoute.name ?? "") !== "chat") return "";
  return String(props.shell.chat.selectedThreadId ?? "").trim();
});
const reminderAutoOpenItems = computed(() => visibleReminderItems.value.filter((item) => {
  if (!isReminderReceiptItem(item) || item.sourceType !== "chat") return true;
  const reminderThreadId = String(item.routeTarget.threadId ?? "").trim();
  return !reminderThreadId || reminderThreadId !== currentVisibleChatThreadId.value;
}));
/** Read notice ids hidden for this login session. */
const dismissedInAppNoticeIds = computed(() => {
  dismissedInAppNoticeVersion.value;
  return readDismissedInAppNoticeIds();
});

/** Hide notices closed in the current login session. */
const visibleInAppNotices = computed(() =>
  activeInAppNotices.value.filter((notice) => !dismissedInAppNoticeIds.value.has(notice.noticeId)),
);

/** Notice currently rendered in the topbar. */
const currentInAppNotice = computed<ActiveInAppNoticeItem | null>(() => {
  const notices = visibleInAppNotices.value;
  if (!notices.length) return null;
  return notices[currentInAppNoticeIndex.value % notices.length] ?? notices[0];
});

/** Build a storage key scoped to the current login session. */
function buildInAppNoticeDismissStorageKey(): string | null {
  const userId = String(accountSummary.value?.userId ?? "").trim();
  const sessionToken = String(props.shell.config.sessionToken ?? "").trim();
  if (!userId || !sessionToken) return null;
  return `${IN_APP_NOTICE_DISMISS_STORAGE_PREFIX}:${userId}:${fingerprintSessionToken(sessionToken)}`;
}

/** Fingerprint the session token without persisting the token itself. */
function fingerprintSessionToken(token: string): string {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Read notice ids dismissed in the current login session. */
function readDismissedInAppNoticeIds(): Set<string> {
  const ids = new Set(inMemoryDismissedInAppNoticeIds.value);
  const storageKey = buildInAppNoticeDismissStorageKey();
  if (!storageKey || typeof sessionStorage === "undefined") return ids;
  const raw = sessionStorage.getItem(storageKey) ?? "";
  for (const noticeId of raw.split("\n").map((item) => item.trim()).filter(Boolean)) ids.add(noticeId);
  return ids;
}

let meSummaryRefreshTimer: number | null = null;
let reminderRefreshTimer: number | null = null;
const REMINDER_REFRESH_INTERVAL_MS = 60_000;
let inAppNoticeRefreshTimer: number | null = null;
let inAppNoticeSwitchTimer: number | null = null;
let reminderHydrated = false;
let lastInAppNoticeError = "";

watch(
  () => visibleReminderItems.value.map((item) => item.id).join("|"),
  () => {
    const visibleIds = new Set(visibleReminderItems.value.map((item) => item.id));
    selectedReminderIds.value = selectedReminderIds.value.filter((id) => visibleIds.has(id));
    if (!visibleIds.size) reminderSelectionMode.value = false;
  },
  { immediate: true },
);

function stopMeSummaryRefresh() {
  if (meSummaryRefreshTimer != null) {
    clearInterval(meSummaryRefreshTimer);
    meSummaryRefreshTimer = null;
  }
}

function stopReminderRefresh() {
  if (reminderRefreshTimer != null) {
    clearInterval(reminderRefreshTimer);
    reminderRefreshTimer = null;
  }
}

function stopInAppNoticeRefresh() {
  if (inAppNoticeRefreshTimer != null) {
    clearInterval(inAppNoticeRefreshTimer);
    inAppNoticeRefreshTimer = null;
  }
}

/** 清理顶部站内通知状态，并关闭轮询与轮播。 */
function resetInAppNotices(): void {
  activeInAppNotices.value = [];
  currentInAppNoticeIndex.value = 0;
  lastInAppNoticeError = "";
  stopInAppNoticeRefresh();
  stopInAppNoticeSwitch();
}

/** Stop the in-app notice rotation timer. */
function stopInAppNoticeSwitch() {
  if (inAppNoticeSwitchTimer != null) {
    clearInterval(inAppNoticeSwitchTimer);
    inAppNoticeSwitchTimer = null;
  }
}

/** 启动顶部栏账号概况后台刷新；短时间内复用缓存，避免聊天首屏持续打重接口。 */
function startMeSummaryRefresh() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  void account.loadMeSummary(true, { silent: true, maxAgeMs: TOPBAR_ME_SUMMARY_BACKGROUND_MAX_AGE_MS });
  if (meSummaryRefreshTimer != null) return;
  meSummaryRefreshTimer = window.setInterval(() => {
    if (document.hidden) return;
    void account.loadMeSummary(true, { silent: true, maxAgeMs: TOPBAR_ME_SUMMARY_BACKGROUND_MAX_AGE_MS });
  }, 30_000);
}

watch(
  () => [props.shell.config.authMode, props.shell.config.sessionToken] as const,
  ([authMode, sessionToken]) => {
    if (authMode === "account" && sessionToken) {
      startMeSummaryRefresh();
      return;
    }
    stopMeSummaryRefresh();
  },
  { immediate: true },
);

onUnmounted(() => {
  stopMeSummaryRefresh();
  stopReminderRefresh();
  stopInAppNoticeRefresh();
  stopInAppNoticeSwitch();
});

watch(
  () => [
    props.shell.presence.accountClientState,
    canShowClientPopover.value,
  ] as const,
  ([clientStateValue, showClientPopover]) => {
    const clientOnline = clientStateValue === "online";
    if (clientOnline || !showClientPopover) {
      clientPopoverOpen.value = false;
      return;
    }
  },
  { immediate: true },
);

/** 本机待办按运行时就绪读取；失败保留 store 错误态并记录当前范围。 */
async function refreshReminders(): Promise<void> {
  const workspaceId = currentWorkspaceId.value;
  if (!props.shell.config.connected && !isDesktopWorkspace(props.shell.config, workspaceId ?? "")) return;
  const requestContext = { ...props.shell.ctx };
  const scope = [workspaceId, props.shell.config.desktopRuntime?.requestId, props.shell.config.serverWsOrigin, props.shell.config.sessionToken];
  /** 摘要返回后只继续原工作区读取，避免切换时发出新范围的请求。 */
  const isCurrent = () => scope.every((value, index) => value === [currentWorkspaceId.value, props.shell.config.desktopRuntime?.requestId,
    props.shell.config.serverWsOrigin, props.shell.config.sessionToken][index]);
  try {
    if (isCurrentSharedWorkspace.value && workspaceId) {
      await reminders.refreshCurrentWorkspace(requestContext, workspaceId);
      return;
    }
    await reminders.refreshWorkspaceSummaries(requestContext);
    if (!isCurrent()) return;
    if (workspaceId) {
      await reminders.refreshCurrentWorkspace(requestContext, workspaceId);
    }
  } catch (error) {
    if (isCancelledRequestError(error)) return;
    console.error("[reminders.refresh_failed]", { code: "REMINDER_REFRESH_FAILED", requestId: `reminders-${Date.now()}`,
      workspaceId, rootCause: error instanceof Error ? error.message : String(error) });
  }
}

/** 刷新顶部站内通知；失败只影响顶部通知展示，不打断主工作台。 */
async function refreshInAppNotices(): Promise<void> {
  if (props.shell.config.authMode !== "account" || !props.shell.config.hasActiveSession) {
    resetInAppNotices();
    return;
  }
  const api = await loadActiveInAppNotices();
  const result = await api.listActiveInAppNotices(props.shell.ctx);
  if (!result.ok) {
    handleInAppNoticeLoadFailure(result);
    return;
  }
  lastInAppNoticeError = "";
  activeInAppNotices.value = result.items;
}

/** 降级范围：站内通知是非关键顶部 UI，失败时清空通知并等待轮询重试；Server 日志标识 in_app_notice.active_list.degraded。 */
function handleInAppNoticeLoadFailure(result: { code?: string; details?: unknown }): void {
  activeInAppNotices.value = [];
  const nextError = String(result.code ?? "UNKNOWN");
  if (nextError === lastInAppNoticeError) return;
  lastInAppNoticeError = nextError;
  message.warning(IN_APP_NOTICE_LOAD_FAILED_MESSAGE);
  console.warn("[in-app-notice.active-list] load failed", resolveInAppNoticeFailureTrace(result.details));
}

/** 只向浏览器控制台输出后端提供的可检索标识，避免泄露底层数据库错误。 */
function resolveInAppNoticeFailureTrace(details: unknown): { requestId?: string; logEvent?: string } {
  if (typeof details !== "object" || details === null) return {};
  const record = details as { requestId?: unknown; logEvent?: unknown };
  return {
    requestId: typeof record.requestId === "string" ? record.requestId : undefined,
    logEvent: typeof record.logEvent === "string" ? record.logEvent : undefined,
  };
}

/** 页面可见时低频兜底刷新提醒；实时变化由 workspace 定向事件驱动。 */
function startReminderRefresh() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  void refreshReminders();
  if (reminderRefreshTimer != null) return;
  reminderRefreshTimer = window.setInterval(() => {
    if (document.hidden) return;
    void refreshReminders();
  }, REMINDER_REFRESH_INTERVAL_MS);
}

function startInAppNoticeRefresh() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  void refreshInAppNotices();
  if (inAppNoticeRefreshTimer != null) return;
  inAppNoticeRefreshTimer = window.setInterval(() => {
    if (document.hidden) return;
    void refreshInAppNotices();
  }, 60_000);
}

/** Rotate multiple in-app notices at a fixed interval. */
function startInAppNoticeSwitch() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  stopInAppNoticeSwitch();
  if (visibleInAppNotices.value.length <= 1) return;
  inAppNoticeSwitchTimer = window.setInterval(() => {
    if (document.hidden) return;
    const count = visibleInAppNotices.value.length;
    if (count <= 1) {
      stopInAppNoticeSwitch();
      return;
    }
    currentInAppNoticeIndex.value = (currentInAppNoticeIndex.value + 1) % count;
  }, IN_APP_NOTICE_SWITCH_INTERVAL_MS);
}

watch(
  () => [props.shell.config.connected || isDesktopWorkspace(props.shell.config, currentWorkspaceId.value ?? ""), currentWorkspaceId.value] as const,
  ([connected, workspaceId]) => {
    reminderHydrated = false;
    if (!connected || !workspaceId) {
      reminderPopoverOpen.value = false;
      resetReminderSelection();
      reminders.reset();
      stopReminderRefresh();
      return;
    }
    startReminderRefresh();
  },
  { immediate: true },
);

watch(
  () => [props.shell.config.authMode, props.shell.config.hasActiveSession] as const,
  ([authMode, hasActiveSession]) => {
    if (authMode === "account" && hasActiveSession) {
      startInAppNoticeRefresh();
      return;
    }
    resetInAppNotices();
  },
  { immediate: true },
);

watch(
  () => props.shell.config.sessionToken,
  () => {
    currentInAppNoticeIndex.value = 0;
    inMemoryDismissedInAppNoticeIds.value = new Set();
    dismissedInAppNoticeVersion.value += 1;
  },
);

watch(
  () => visibleInAppNotices.value.map((notice) => notice.noticeId).join("|"),
  () => {
    currentInAppNoticeIndex.value = 0;
    if (visibleInAppNotices.value.length > 1) startInAppNoticeSwitch();
    else stopInAppNoticeSwitch();
  },
  { immediate: true },
);

watch(
  () => buildReminderAttentionSignature(reminderAutoOpenItems.value),
  (signature, previous) => {
    if (!signature) {
      reminderHydrated = true;
      return;
    }
    if (!reminderHydrated) {
      reminderHydrated = true;
      return;
    }
    if (signature !== previous && !isMobile.value) {
      reminderPopoverOpen.value = true;
    }
  },
);

function handleReminderPopoverChange(nextOpen: boolean) {
  reminderPopoverOpen.value = nextOpen;
  if (nextOpen) {
    void refreshReminders();
    return;
  }
  resetReminderSelection();
}

function closeReminderPopover() {
  reminderPopoverOpen.value = false;
  resetReminderSelection();
}

function reminderSourceLabel(item: TopbarReminderItem): string {
  return item.sourceType === "orchestration" ? "编排" : "会话";
}

function reminderUpdatedAt(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function resetReminderSelection() {
  reminderSelectionMode.value = false;
  selectedReminderIds.value = [];
}

function toggleReminderSelectionMode() {
  if (reminderSelectionMode.value) {
    resetReminderSelection();
    return;
  }
  reminderSelectionMode.value = true;
}

function isReminderItemSelected(item: TopbarReminderItem): boolean {
  return selectedReminderIdSet.value.has(item.id);
}

function toggleReminderItemSelection(item: TopbarReminderItem) {
  const selected = new Set(selectedReminderIds.value);
  if (selected.has(item.id)) selected.delete(item.id);
  else selected.add(item.id);
  selectedReminderIds.value = [...selected];
}

function toggleAllReminderItems() {
  if (allVisibleReminderSelected.value) {
    selectedReminderIds.value = [];
    return;
  }
  selectedReminderIds.value = visibleReminderItems.value.map((item) => item.id);
}

function handleReminderItemClick(item: TopbarReminderItem) {
  if (reminderSelectionMode.value) {
    toggleReminderItemSelection(item);
    return;
  }
  void openReminderItem(item);
}

/** 待办统一交给现有服务消费，不再生成本地套餐提醒。 */
async function consumeTopbarReminderItems(items: TopbarReminderItem[]): Promise<string[]> {
  return await reminders.consumeItems(props.shell.ctx, items);
}

/** 清掉多选模式下选中的提醒，并保留状态已变化的条目。 */
async function ignoreSelectedReminderItems(): Promise<void> {
  const items = [...selectedReminderItems.value];
  if (!items.length || reminderIgnoreLoading.value) return;
  reminderIgnoreLoading.value = true;
  try {
    const ignoredIds = await consumeTopbarReminderItems(items);
    if (!ignoredIds.length) {
      message.info("选中的提醒已变化，请重新打开待办列表后重试");
      return;
    }
    trackProductEvent("reminder_clear", {
      scope: "selected",
      cleared_count: ignoredIds.length,
      changed_count: items.length - ignoredIds.length,
    });
    selectedReminderIds.value = selectedReminderIds.value.filter((id) => !ignoredIds.includes(id));
    if (!visibleReminderItems.value.length) reminderSelectionMode.value = false;
    message.success(ignoredIds.length > 1 ? `已清掉 ${ignoredIds.length} 条提醒` : "已清掉提醒");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "清掉提醒失败");
  } finally {
    reminderIgnoreLoading.value = false;
  }
}

/** 清掉确认弹框打开时可见的全部待办，失败时保留弹框供用户重试。 */
async function clearAllReminderItems(items: TopbarReminderItem[]): Promise<void> {
  if (!items.length || reminderIgnoreLoading.value) return;
  reminderIgnoreLoading.value = true;
  try {
    const ignoredIds = await consumeTopbarReminderItems(items);
    if (!ignoredIds.length) {
      message.info("待办内容已变化，请重新打开待办列表后重试");
      return;
    }
    resetReminderSelection();
    const changedCount = items.length - ignoredIds.length;
    trackProductEvent("reminder_clear", {
      scope: "all",
      cleared_count: ignoredIds.length,
      changed_count: changedCount,
    });
    if (changedCount > 0) {
      message.warning(`已清除 ${ignoredIds.length} 条待办，另有 ${changedCount} 条状态已变化，请重新确认`);
      return;
    }
    message.success(`已清除全部 ${ignoredIds.length} 条待办`);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "清除全部待办失败");
    throw error;
  } finally {
    reminderIgnoreLoading.value = false;
  }
}

/** 二次确认后清掉当前工作区当前展示的全部待办。 */
function confirmClearAllReminderItems(): void {
  const items = [...visibleReminderItems.value];
  if (!items.length || reminderIgnoreLoading.value) return;
  Modal.confirm({
    title: "确认清除全部待办？",
    content: `将清除当前工作区的 ${items.length} 条待办，此操作不可撤销。`,
    okText: "清除全部",
    okType: "danger",
    cancelText: "取消",
    onOk: () => clearAllReminderItems(items),
  });
}

/** 已在会话时再次点击切换左侧会话列表。 */
function toggleChatEntry(): void {
  if (props.shell.ui.mainView === "chat" && props.shell.mode === "desktop") {
    props.shell.ui.toggleLeftSidebar();
    return;
  }
  openChat();
}

/** 已在规格库时再次点击切换左侧会话列表。 */
function toggleKnowledgeEntry(): void {
  if (props.shell.ui.mainView === "knowledge" && props.shell.mode === "desktop") {
    props.shell.ui.toggleLeftSidebar();
    return;
  }
  openProjectKnowledge();
}

/** 已在编排工作台时再次点击切换左侧需求列表。 */
function toggleWorkspaceEntry(): void {
  if (workspaceEntryActive.value && props.shell.mode === "desktop") {
    props.shell.ui.toggleLeftSidebar();
    return;
  }
  openOrchestration("workspace");
}

/** 已在资产库时再次点击切换左侧列表，和文件按钮保持一致。 */
function toggleAssetsEntry(): void {
  if (assetsEntryActive.value && props.shell.mode === "desktop") {
    props.shell.ui.toggleLeftSidebar();
    return;
  }
  openOrchestration("assets");
}

/** 从顶层导航进入编排视图，并记录实际入口类型。 */
function openOrchestration(entry?: OrchestrationEntry) {
  const targetEntry = entry ?? resolveOrchestrationEntryForTopLevelNavigation({
    routeName: props.shell.router.currentRoute.name,
    lastVisitedEntry: props.shell.ui.lastOrchestrationEntry,
  });
  const path = targetEntry === "assets" ? "/orchestration/assets" : "/orchestration/workspace";
  trackProductEvent("top_nav_click", {
    target: "orchestration",
    orchestration_entry: targetEntry,
  });
  props.shell.ui.rememberOrchestrationEntry(targetEntry);
  void props.shell.router.push(path);
}

/** 从顶层导航回到会话视图，保留当前会话上下文。 */
function openChat() {
  const selectedThreadId = props.shell.chat.selectedThreadId;
  trackProductEvent("top_nav_click", {
    target: "chat",
    has_thread: Boolean(selectedThreadId),
  });
  if (selectedThreadId) {
    void props.shell.router.push({ path: "/chat", query: { threadId: selectedThreadId } });
    return;
  }
  void props.shell.router.push("/chat");
}

/** 从顶层导航进入当前工作区的规格知识库。 */
function openProjectKnowledge(): void {
  trackProductEvent("top_nav_click", {
    target: "project_knowledge",
  });
  void props.shell.router.push({ path: "/knowledge", query: { workspaceId: currentWorkspaceId.value ?? undefined } });
}

/** 从顶层导航进入系统管理。 */
function openAdmin(): void {
  trackProductEvent("top_nav_click", {
    target: "admin",
  });
  void props.shell.router.push("/admin");
}

/** 从顶层导航进入编排度量，复用现有权限与查询上下文。 */
function openOrchestrationMetrics(): void {
  trackProductEvent("top_nav_click", {
    target: "orchestration_metrics",
  });
  void props.shell.router.push({ path: "/admin", query: { panel: "orchestration-metrics" } });
}

/** 打开待办对应页面，仅上报分类信息，不上传具体任务或会话标识。 */
async function openReminderItem(item: TopbarReminderItem): Promise<void> {
  reminderPopoverOpen.value = false;
  resetReminderSelection();
  trackProductEvent("reminder_open", {
    source_type: item.sourceType,
    primary_action_kind: item.primaryActionKind ?? null,
  });
  if (item.sourceType === "chat") {
    const threadId = String(item.routeTarget.threadId ?? "").trim();
    if (!threadId) return;
    await props.shell.router.push({ path: "/chat", query: { threadId } });
    return;
  }

  const intakeId = String(item.routeTarget.intakeId ?? "").trim();
  const instanceId = String(item.routeTarget.instanceId ?? "").trim();
  const nodeId = String(item.routeTarget.nodeId ?? "").trim();
  if (!intakeId) return;
  analysis.openIntakeMode();
  orch.selectedIntakeId = intakeId as any;
  orch.selectedIntakeSnapshot = orch.intakes.find((intake) => String(intake.id) === intakeId) ?? null;
  if (instanceId) {
    orch.selectedInstanceId = instanceId as any;
  }
  await props.shell.router.push("/orchestration/workspace");
  if (item.primaryActionKind === "open_orch_metric_review") {
    orch.dispatchUiIntent({
      kind: "open_metric_review",
      intakeId: intakeId as any,
      instanceId: null,
      nodeId: null,
    });
    return;
  }
  if (item.primaryActionKind === "open_orch_primary_action") {
    orch.dispatchUiIntent({
      kind: "open_primary_action",
      intakeId: intakeId as any,
      instanceId: (instanceId || null) as any,
      nodeId: nodeId || null,
    });
    return;
  }
  if (item.primaryActionKind === "open_orch_artifacts") {
    orch.dispatchUiIntent({
      kind: "open_artifacts",
      intakeId: intakeId as any,
      instanceId: (instanceId || null) as any,
      nodeId: nodeId || null,
    });
    return;
  }
  orch.dispatchUiIntent({
    kind: "open_monitor",
    intakeId: intakeId as any,
    instanceId: (instanceId || null) as any,
    nodeId: nodeId || null,
  });
}

function openAccountCenter() {
  void account.openAccountDrawer();
}

/** 退出整个桌面应用；宿主拒绝时保留窗口并明确提示。 */
async function exitDesktopApp(): Promise<void> {
  const bridge = getDesktopBridge();
  if (!bridge) return;
  try {
    await bridge.exit();
  } catch (error) {
    console.error("[desktop.exit.failed]", {
      code: "DESKTOP_EXIT_FAILED",
      requestId: null,
      rootCause: error instanceof Error ? error.message : String(error),
    });
    message.error("退出应用失败，请重试");
  }
}

/** Open redemption code modal from account menu. */
function openRedemptionModal(): void {
  clientPopoverOpen.value = false;
  reminderPopoverOpen.value = false;
  trackProductEvent("redemption_modal_open", {
    source: "account_menu",
  });
  redemptionModalOpen.value = true;
}

/** Refresh account summary so package or token balances are visible after redemption. */
function handleRedemptionSuccess(): void {
  void account.loadMeSummary(true, { silent: true });
}

/** 打开 Client 管理；离线启动提示打开时先收起提示层。 */
function openClientManagement(): void {
  clientPopoverOpen.value = false;
  trackProductEvent("client_management_open", {
    source: "topbar",
  });
  props.shell.clientManagementOpen = true;
}

/** 桌面本机模式从状态浮层打开与托盘一致的检查更新弹框。 */
function openAppUpdate(): void {
  desktopLocalPopoverOpen.value = false;
  requestDesktopUpdateCheck();
}

/** Client 顶部入口：离线可引导时交给 popover，其余状态打开管理框。 */
function handleClientButtonClick(): void {
  if (showClientOfflinePopover.value) return;
  openClientManagement();
}

/** Hide the notice until the current login session ends. */
function dismissInAppNotice(notice: ActiveInAppNoticeItem, event?: MouseEvent): void {
  event?.stopPropagation();
  const noticeId = String(notice.noticeId ?? "").trim();
  if (!noticeId) return;
  const next = new Set(dismissedInAppNoticeIds.value);
  next.add(noticeId);
  inMemoryDismissedInAppNoticeIds.value = next;
  const storageKey = buildInAppNoticeDismissStorageKey();
  if (storageKey && typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(storageKey, [...next].sort().join("\n"));
  }
  dismissedInAppNoticeVersion.value += 1;
  currentInAppNoticeIndex.value = Math.min(currentInAppNoticeIndex.value, Math.max(visibleInAppNotices.value.length - 1, 0));
}

/** 点击顶部通知时按服务端配置链接打开。 */
function openInAppNotice(notice: ActiveInAppNoticeItem): void {
  trackProductEvent("in_app_notice_open", {
    notice_type: "custom",
    link_type: notice.linkType,
  });
  if (typeof window === "undefined") return;
  // 站内通知走应用内路由；只有外链才交给浏览器弹窗。
  if (notice.linkType === "internal") {
    void props.shell.router.push(notice.linkTarget);
    return;
  }
  const targetUrl = notice.linkTarget;
  const popup = window.open(
    targetUrl,
    `codeflow_notice_${notice.noticeId}`,
    "popup=yes,width=1200,height=820,resizable=yes,scrollbars=yes",
  );
  if (!popup) {
    message.error("浏览器拦截了站内通知弹窗，请允许弹窗后重试");
    return;
  }
  popup.focus();
}
</script>

<template>
  <div class="app-topbar" :class="{ 'app-topbar--desktop': !!desktopWindowControls, 'app-topbar--mac': isMacDesktop }">
    <div class="app-topbar__row">
      <div class="app-topbar__brand app-topbar__brand--clickable" @click="shell.router.push('/')">
        <span class="app-topbar__brand-mark">
          <img src="/favicon.svg" alt="" class="app-topbar__logo" />
        </span>
        CodeFlow
        <a-tooltip v-if="environmentBadge" :title="environmentBadge.title">
          <span
            class="app-topbar__env-badge"
            :class="`app-topbar__env-badge--${environmentBadge.label.toLowerCase()}`"
          >{{ environmentBadge.label }}</span>
        </a-tooltip>
      </div>
      <div v-if="canShowPrimaryNavigation" class="app-topbar__view-switch">
        <button class="app-topbar__view-tab" :class="{ 'app-topbar__view-tab--active': shell.ui.mainView === 'chat' }" @click="toggleChatEntry">
          <MessageOutlined style="font-size: 13px" />
          会话
        </button>
        <button
          class="app-topbar__view-tab"
          :class="{ 'app-topbar__view-tab--active': workspaceEntryActive }"
          @click="toggleWorkspaceEntry"
        >
          <NodeIndexOutlined style="font-size: 13px" />
          编排
        </button>
        
        <button
          class="app-topbar__view-tab"
          :class="{ 'app-topbar__view-tab--active': assetsEntryActive }"
          @click="toggleAssetsEntry"
        >
          <ClusterOutlined style="font-size: 13px" />
          资产库
        </button>

        <button
          class="app-topbar__view-tab"
          :class="{ 'app-topbar__view-tab--active': shell.ui.mainView === 'knowledge' }"
          @click="toggleKnowledgeEntry"
        >
          <BookOutlined style="font-size: 13px" />
          规格
        </button>

        <button
          v-if="canOpenSystemViews"
          class="app-topbar__view-tab"
          :class="{ 'app-topbar__view-tab--active': orchestrationMetricsEntryActive }"
          @click="openOrchestrationMetrics"
        >
          <BarChartOutlined style="font-size: 13px" />
          度量
        </button>

        <button
          v-if="canOpenSystemViews"
          class="app-topbar__view-tab"
          :class="{ 'app-topbar__view-tab--active': systemEntryActive }"
          @click="openAdmin"
        >
          <SettingOutlined style="font-size: 13px" />
          设置
        </button>
      </div>
      <div v-if="canShowPrimaryNavigation" class="app-topbar__workspace">
        <WorkspaceSelector compact />
      </div>
      <div v-if="currentInAppNotice" class="app-topbar__notice-slot">
        <button
          type="button"
          class="app-topbar__notice-item"
          :title="currentInAppNotice.content"
          @click="openInAppNotice(currentInAppNotice)"
        >
          <BellOutlined class="app-topbar__notice-icon" />
          <span class="app-topbar__notice-text">{{ currentInAppNotice.content }}</span>
        </button>
        <button
          type="button"
          class="app-topbar__notice-close"
          :title="IN_APP_NOTICE_CLOSE_TITLE"
          :aria-label="IN_APP_NOTICE_CLOSE_TITLE"
          @click.stop="dismissInAppNotice(currentInAppNotice, $event)"
        >
          <CloseOutlined />
        </button>
      </div>
      <span class="app-topbar__spacer" />
      <button v-if="canShowExplorerToggle" class="app-topbar__view-tab" :class="{ 'app-topbar__view-tab--active': shell.ui.explorerPanelVisible }" title="文件" aria-label="文件" @click="shell.ui.toggleExplorerPanel()">
        <FolderOutlined style="font-size: 13px" />
        文件
      </button>
      <button
        class="app-topbar__view-tab app-topbar__terminal-btn"
        :class="{ 'app-topbar__view-tab--active': shell.ui.rightPanelMode === 'terminal' }"
        :disabled="!shell.canUseTerminal"
        :title="shell.terminalStore.hasOnlineRunningTerminal ? '终端运行中' : shell.terminalStore.hasOfflineCachedTerminal ? shell.terminalStore.onlineClientIds.length ? '部分 Client 离线，可查看终端历史' : 'Client 离线，可查看终端历史' : '终端'"
        aria-label="终端"
        @click="shell.openTerminal()"
      >
        <span class="app-topbar__terminal-icon">
          <CodeOutlined style="font-size: 13px" />
          <span v-if="shell.terminalStore.hasOnlineRunningTerminal" class="app-topbar__terminal-state app-topbar__terminal-state--running" />
          <span v-else-if="shell.terminalStore.hasOfflineCachedTerminal" class="app-topbar__terminal-state app-topbar__terminal-state--offline" />
        </span>
        终端
      </button>
      <div v-if="shell.config.isDesktop || shell.config.connected" class="app-topbar__client-group">
        <a-popover
          v-if="showClientOfflinePopover"
          v-model:open="clientPopoverOpen"
          placement="bottomLeft"
          trigger="click"
          :overlay-style="{ maxWidth: '460px', width: '460px' }"
        >
          <template #title>
            <span style="font-size: 13px; font-weight: 600">使用桌面版继续工作</span>
          </template>
          <template #content>
            <div class="topbar-client-popover">
              <div class="topbar-client-popover__tip">独立 Client 已停止安装和更新。请在原电脑上安装桌面版，并按启动提示确认迁移。</div>
              <div class="topbar-client-popover__actions">
                <a-button type="primary" size="small" @click="openDownloadPage()">下载桌面版</a-button>
                <a href="/download#migration" @click.prevent="openDownloadPage('#migration')">迁移说明</a>
                <a-button size="small" @click="openClientManagement">Client 管理</a-button>
              </div>
            </div>
          </template>
          <button
            class="app-topbar__view-tab app-topbar__client-btn"
            :class="clientButtonClass"
            :title="clientButtonTitle"
            @click="handleClientButtonClick"
          >
            <DesktopOutlined :class="clientIconClass" />
            {{ clientButtonLabel }}
          </button>
        </a-popover>
        <a-popover
          v-else-if="showDesktopLocalPopover"
          v-model:open="desktopLocalPopoverOpen"
          placement="bottomLeft"
          trigger="click"
        >
          <template #title>
            <span style="font-size: 13px; font-weight: 600">本机应用</span>
          </template>
          <template #content>
            <div class="topbar-client-popover topbar-local-status">
              <div class="topbar-local-status__head">
                <span
                  class="topbar-local-status__dot"
                  :class="{ 'topbar-local-status__dot--online': props.shell.config.localRuntimeReady }"
                />
                <strong>{{ props.shell.config.localRuntimeReady ? '本机运行中' : '本机未就绪' }}</strong>
              </div>
              <div class="topbar-local-status__row">
                <span>版本</span>
                <code>{{ desktopVersionDisplay }}</code>
              </div>
              <div v-if="desktopPlatformLabel" class="topbar-local-status__row">
                <span>平台</span>
                <span>{{ desktopPlatformLabel }}</span>
              </div>
              <div v-if="desktopLocalWorkspaces.length" class="topbar-local-status__row topbar-local-status__row--wrap">
                <span>关联工作区</span>
                <span class="topbar-local-status__tags">
                  <a-tag v-for="item in desktopLocalWorkspaces.slice(0, 3)" :key="item.id" :bordered="false" size="small">
                    {{ item.title }}
                  </a-tag>
                  <span v-if="desktopLocalWorkspaces.length > 3" class="topbar-local-status__more">
                    +{{ desktopLocalWorkspaces.length - 3 }}
                  </span>
                </span>
              </div>
              <p v-if="desktopRuntimeStatusHint" class="topbar-local-status__tip">
                {{ desktopRuntimeStatusHint }}
              </p>
              <a-alert v-if="props.shell.desktopAccountFailureDescription" type="error" show-icon
                message="账号关联失败" :description="props.shell.desktopAccountFailureDescription" />
              <div class="topbar-client-popover__actions">
                <a-button size="small" type="primary" @click="openAppUpdate">应用更新</a-button>
                <a-button v-if="props.shell.desktopAccountFailureDescription" size="small" @click="props.shell.syncDesktopAccount(true)">重试关联</a-button>
              </div>
            </div>
          </template>
          <button
            class="app-topbar__view-tab app-topbar__client-btn"
            :class="clientButtonClass"
            :title="clientButtonTitle"
          >
            <DesktopOutlined :class="clientIconClass" />
            {{ clientButtonLabel }}
          </button>
        </a-popover>
        <button
          v-else
          class="app-topbar__view-tab app-topbar__client-btn"
          :class="clientButtonClass"
          :title="clientButtonTitle"
          @click="handleClientButtonClick"
        >
          <DesktopOutlined :class="clientIconClass" />
          {{ clientButtonLabel }}
        </button>
      </div>
      <a-popover
        v-if="(shell.config.connected || isDesktopWorkspace(shell.config, currentWorkspaceId ?? '')) && currentWorkspaceId"
        :open="reminderPopoverOpen"
        placement="bottomLeft"
        trigger="click"
        :overlay-style="{ width: '360px', maxWidth: 'calc(100vw - 24px)' }"
        @update:open="handleReminderPopoverChange"
      >
        <template #title>
          <div class="topbar-reminder__titlebar">
            <span>当前待办</span>
            <div class="topbar-reminder__title-actions">
              <span v-if="reminderSelectionMode" class="topbar-reminder__selection-hint">已选 {{ selectedReminderIds.length }}</span>
              <button
                v-if="visibleReminderItems.length"
                type="button"
                class="topbar-reminder__action"
                @click.stop="reminderSelectionMode ? toggleAllReminderItems() : toggleReminderSelectionMode()"
              >
                {{ reminderSelectionMode ? (allVisibleReminderSelected ? "清空" : "全选") : "多选" }}
              </button>
              <button
                v-if="reminderSelectionMode"
                type="button"
                class="topbar-reminder__action topbar-reminder__action--danger"
                :disabled="!selectedReminderIds.length || reminderIgnoreLoading"
                @click.stop="ignoreSelectedReminderItems"
              >
                {{ reminderIgnoreLoading ? "清掉中..." : "清掉所选" }}
              </button>
              <button
                v-if="reminderSelectionMode"
                type="button"
                class="topbar-reminder__action"
                @click.stop="toggleReminderSelectionMode"
              >
                完成
              </button>
              <button
                v-if="!reminderSelectionMode && visibleReminderItems.length"
                type="button"
                class="topbar-reminder__action topbar-reminder__action--danger"
                :disabled="reminderIgnoreLoading"
                @click.stop="confirmClearAllReminderItems"
              >
                {{ reminderIgnoreLoading ? "清除中..." : "清除全部" }}
              </button>
              <button type="button" class="topbar-reminder__action" @click.stop="closeReminderPopover">关闭</button>
            </div>
          </div>
        </template>
        <template #content>
          <div class="topbar-reminder">
            <a-alert v-if="reminders.lastError" type="error" show-icon :message="reminders.lastError" />
            <div class="topbar-reminder__body">
              <div v-if="!visibleReminderItems.length && !reminders.lastError" class="topbar-reminder__empty">
                当前工作区暂无待办或待查收。
              </div>
              <template v-else>
                <div v-for="group in reminderGroups" :key="group.key" class="topbar-reminder__group">
                  <div class="topbar-reminder__group-title">{{ group.title }}</div>
                  <button
                    v-for="item in group.items"
                    :key="item.id"
                    type="button"
                    class="topbar-reminder__item"
                    :class="{
                      'topbar-reminder__item--selection': reminderSelectionMode,
                      'topbar-reminder__item--selected': isReminderItemSelected(item),
                    }"
                    @click="handleReminderItemClick(item)"
                  >
                    <div class="topbar-reminder__item-head">
                      <span
                        v-if="reminderSelectionMode"
                        class="topbar-reminder__item-check"
                        :class="{ 'topbar-reminder__item-check--selected': isReminderItemSelected(item) }"
                      />
                      <span class="topbar-reminder__item-status" :class="`topbar-reminder__item-status--${item.tone}`">{{ item.statusLabel }}</span>
                      <span class="topbar-reminder__item-source">{{ reminderSourceLabel(item) }}</span>
                      <span class="topbar-reminder__item-time">{{ reminderUpdatedAt(item.updatedAt) }}</span>
                    </div>
                    <strong class="topbar-reminder__item-title">{{ item.title }}</strong>
                    <span v-if="item.summary" class="topbar-reminder__item-summary">{{ item.summary }}</span>
                    <span v-if="item.primaryActionLabel" class="topbar-reminder__item-action">{{ item.primaryActionLabel }}</span>
                  </button>
                </div>
              </template>
            </div>
          </div>
        </template>
        <button
          class="app-topbar__view-tab app-topbar__reminder-btn"
          title="待办"
          aria-label="待办"
          :class="{ 'app-topbar__view-tab--active': reminderPopoverOpen }"
        >
          <BellOutlined style="font-size: 13px" />
          待办
          <span
            v-if="pendingReminderCount > 0"
            class="app-topbar__terminal-badge"
            :class="{ 'app-topbar__terminal-badge--attention': reminderHasAttention }"
          >
            {{ pendingReminderCount }}
          </span>
          <span
            v-if="pendingReceiptCount > 0"
            class="app-topbar__reminder-receipt-badge"
            :class="{ 'app-topbar__reminder-receipt-badge--attention': reminderHasAttention }"
          >
            {{ pendingReceiptCount }}
          </span>
        </button>
      </a-popover>
      <a-button
        v-if="shell.config.isDesktop && !shell.config.hasActiveSession"
        class="app-topbar__auth-button"
        type="primary"
        size="small"
        @click="shell.openDesktopAuthModal()"
      >
        登录
      </a-button>
      <UserMenuTrigger
        v-if="accountSummary"
        :display-name="accountSummary.fullName"
        :avatar-url="accountSummary.avatarUrl"
        :account-role="shell.config.accountRole"
        :access-context="shell.config.accessContext"
        :enterprise-name="accountSummary.enterpriseName"
        :pending-invite-count="pendingInviteCount"
        :show-check-update="shell.config.isDesktop"
        :show-exit-app="shell.config.isDesktop"
        hide-display-name
        @open-account="openAccountCenter"
        @open-redemption="openRedemptionModal"
        @open-feedback="appModals?.openFeedback()"
        @check-update="openAppUpdate"
        @exit-app="exitDesktopApp"
      />
      <RedemptionCodeModal
        v-model:open="redemptionModalOpen"
        @redeemed="handleRedemptionSuccess"
      />
      <AppWindowControls
        v-if="desktopWindowControls && !isMacDesktop"
        :maximized="windowMaximized"
        @minimize="minimizeDesktopWindow"
        @toggle="toggleDesktopWindowMaximize"
        @close="closeDesktopWindow"
      />
    </div>
  </div>
</template>
