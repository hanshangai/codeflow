import { computed, onMounted, onUnmounted, provide, reactive, ref, watch, watchEffect } from "vue";
import { Modal, message, theme } from "ant-design-vue";
import { useRouter } from "vue-router";
import { describeUserFacingError, getPathDisplayInfo, getThreadEntryVisibility } from "@codeflowai/shared";
import type { ClientCapabilitySnapshot, ThreadId, ThreadSummary, WorkspaceId } from "@codeflowai/shared";

import { useViewport } from "./useViewport";
import { useApiContext } from "./useApiContext";
import { WS_CLIENT_KEY, createWebSocketClient } from "../services/ws";
import { isDesktopWorkspace, isLocalDesktopTerminalMode, subscribeDesktopEvents } from "../services/desktop";
import { APP_MODALS_KEY } from "../services/appModals";
import { createCancelledRequestError, isCancelledRequestError, requestJson, type AbortKind } from "../api/request";
import { pushLoginRoute as navigateToLoginRoute } from "../features/account/loginRedirect";
import { isDesktopLoginPromptDismissed } from "../features/account/desktopLoginPrompt";
import { desktopAuthModalOpen } from "../features/account/desktopAuthPromptState";
import { clearFileEditorDrafts } from "../features/explorer/fileEditorState";
import { resetQuickPhraseSync, syncQuickPhrasesToAccount } from "../features/composer/quickPhraseSync";
import { resolveAccountH5DeepLink } from "../features/office-h5/accountH5DeepLink";
import { getThreadIdFromUrl, THREAD_URL_CHANGED_EVENT } from "../features/threads/thread-url";
import {
  isPrimaryThreadRoute,
  resolvePrimaryThreadFallbackForRoute,
  shouldClearPrimarySelectionForThreadUrlChange,
  shouldUseThreadOnlyActivationForRouteChange,
} from "../features/threads/primary-thread-selection";
import { getThreadSummary } from "../api/threads";
import { trackProductEvent } from "../analytics/analytics";
import { useChatStore } from "../store/chat";
import { useComposerStore } from "../store/composer";
import { resolveWorkspaceSwitchReloadUrl, useConfigStore, WORKSPACE_URL_SYNC_EVENT, type WorkspaceUrlSyncDetail } from "../store/config";
import { useEngineStore } from "../store/engine";
import { useExplorerStore } from "../store/explorer";
import { useAdminStore } from "../store/admin";
import { useOrchestrationStore } from "../store/orchestration";
import { usePresenceStore } from "../store/presence";
import { useRequirementAnalysisStore } from "../store/requirementAnalysis";
import { useReminderStore } from "../store/reminders";
import { useSharedWorkspacesStore } from "../store/sharedWorkspaces";
import { useTerminalStore } from "../store/terminal";
import { useThreadQueueStore } from "../store/threadQueue";
import { useEngineKeysStore } from "../store/engineKeys";
import { useUiStore } from "../store/ui";
import { useWorkspacesStore } from "../store/workspaces";
import { useAccountStore } from "../store/account";
import { useQuickPhrasesStore } from "../store/quickPhrases";
import { useBuiltInRelayAutoEnableStore } from "../store/builtInRelayAutoEnable";
import {
  isSharedWorkspaceSelectionId,
  parseSharedWorkspaceSelectionId,
  resolveStickyWorkspaceSelection,
  workspaceIdsContainMatch,
} from "../utils/workspaceId";
import { isWorkspaceClientOfflineError } from "../utils/clientOfflineNotice";


export type StatusClientVersionInfo = {
  clientId: string;
  version: string | null;
  workspaceIds: string[];
  capabilities?: ClientCapabilitySnapshot | null;
};

/** 为当前工作区选择 Client，版本和升级能力必须来自同一在线端。 */
export function resolveWorkspaceClientInfo(input: {
  workspaceId: string | null | undefined;
  ownerClientId?: string | null;
  hostClientId?: string | null;
  hostWorkspaceId?: string | null;
  clients?: StatusClientVersionInfo[] | null;
}): StatusClientVersionInfo | null {
  const workspaceId = String(input.workspaceId ?? "").trim();
  const ownerClientId = String(input.ownerClientId ?? "").trim();
  const hostClientId = String(input.hostClientId ?? "").trim();
  const hostWorkspaceId = String(input.hostWorkspaceId ?? "").trim();
  const clients = input.clients ?? [];
  if (hostClientId) {
    const matchedClient = clients.find((client) => client.clientId === hostClientId) ?? null;
    if (matchedClient) return matchedClient;
  }
  if (hostWorkspaceId) {
    const matchedClient = clients.find((client) => workspaceIdsContainMatch(client.workspaceIds, hostWorkspaceId)) ?? null;
    if (matchedClient) return matchedClient;
    return null;
  }
  if (ownerClientId) {
    return clients.find((client) => client.clientId === ownerClientId) ?? null;
  }
  if (workspaceId) {
    const matchedClient = clients.find((client) => client.workspaceIds.includes(workspaceId));
    if (matchedClient) return matchedClient;
    return null;
  }
  return clients[0] ?? null;
}

/** 保留旧 Server 的无工作区版本兜底，指定工作区时不得借用其他 Client。 */
export function resolveWorkspaceClientVersion(input: Parameters<typeof resolveWorkspaceClientInfo>[0] & {
  fallbackClientVersion?: string | null;
}): string | null {
  if (!String(input.workspaceId ?? "").trim() && !input.ownerClientId && !input.hostClientId && !input.hostWorkspaceId) {
    return input.fallbackClientVersion ?? null;
  }
  return resolveWorkspaceClientInfo(input)?.version ?? null;
}

export function useAppShell() {
  const AVAILABLE_SETTINGS_TABS = new Set(["workspaces", "engine-keys", "app-update"]);
  const WORKSPACE_PRESENCE_TIMEOUT_MS = 1_500;
  const ENGINE_STATUS_REFRESH_INTERVAL_MS = 10 * 60_000;
  const config = useConfigStore();
  const chat = useChatStore();
  const composer = useComposerStore();
  const engine = useEngineStore();
  const presence = usePresenceStore();
  const terminalStore = useTerminalStore();
  let terminalListTimeout: ReturnType<typeof setTimeout> | null = null;
  const ui = useUiStore();
  const workspaces = useWorkspacesStore();
  const explorer = useExplorerStore();
  const admin = useAdminStore();
  const orch = useOrchestrationStore();
  const analysis = useRequirementAnalysisStore();
  const reminders = useReminderStore();
  const sharedWorkspaces = useSharedWorkspacesStore();
  const threadQueue = useThreadQueueStore();
  const engineKeys = useEngineKeysStore();
  const account = useAccountStore();
  const quickPhrases = useQuickPhrasesStore();
  const builtInRelayAutoEnable = useBuiltInRelayAutoEnableStore();
  const { ctx } = useApiContext();
  const { mode } = useViewport();
  const router = useRouter();

  // Apply the notification workspace before connecting or resolving its thread.
  watch(() => [router.currentRoute.value.name, router.currentRoute.value.query.workspaceId] as const, () => {
    if (router.currentRoute.value.name !== "chat") return;
    const target = resolveAccountH5DeepLink(router.currentRoute.value.query);
    if (target.workspaceId && target.workspaceId !== config.workspaceId) {
      config.switchWorkspace(target.workspaceId, { preservePrimaryThreadUrl: true });
    }
  }, { immediate: true });

  const connectError = ref<string | null>(null);
  const desktopStartupComplete = ref(!config.isDesktop);
  let desktopStatusTimer: ReturnType<typeof setInterval> | null = null;
  let desktopStatusDisposed = false;
  let stopDesktopEvents: (() => void) | null = null;
  const logoutInProgress = ref(false);
  const workspaceSwitching = ref(false);
  const clientUpgradeOpen = ref(false);
  const clientManagementOpen = ref(false);
  const settingsOpen = ref(false);
  const feedbackOpen = ref(false);
  const feedbackSource = ref<"user_menu" | "slash_command">("user_menu");
  let desktopLoginPromptScheduled = false;
  /** 桌面设置弹窗只保留模型配置，其它端仍从工作区页进入。 */
  const defaultSettingsTab = () => config.isDesktop ? "engine-keys" : "workspaces";
  const settingsActiveTab = ref(defaultSettingsTab());
  const terminalOpen = ref(false);
  const explorerOpen = ref(false);
  const workspaceManagerOpen = ref(false);
  const threadUrlTick = ref(0);

  const clientPreemptModals = new Map<string, { destroy: () => void }>();
  type ShellReadTaskName = "clientVersion" | "workspacePrefs" | "engine";
  type ShellReadTask = {
    scopeKey: string;
    controller: AbortController;
    promise: Promise<void>;
  };
  const shellReadTasks: Record<ShellReadTaskName, ShellReadTask | null> = {
    clientVersion: null,
    workspacePrefs: null,
    engine: null,
  };
  const auxiliaryRefreshFailures = new WeakMap<object, Set<string>>();
  let engineStatusRefreshTimer: number | null = null;
  let engineStatusRefreshWorkspaceId = "";
  type WorkspaceActivationTask = {
    scopeKey: string;
    controller: AbortController;
    promise: Promise<void>;
  };
  let workspaceActivationTask: WorkspaceActivationTask | null = null;
  let activeWorkspaceActivationScopeKey = "";
  const ws = createWebSocketClient({
    config,
    chat,
    engine,
    presence,
    orchestration: orch,
    requirementAnalysis: analysis,
    reminders,
    sharedWorkspaces,
    ui,
    workspaces,
    terminal: terminalStore,
    explorer,
    threadQueue,
    engineKeys,
    quickPhrases,
    onError: (msg) => message.error(msg),
    onClientPreemptRequested: (req) => {
      if (clientPreemptModals.has(req.requestId)) return;
      const seconds = Math.max(0, Math.floor((req.expiresAt - Date.now()) / 1000));
      const modal = Modal.confirm({
        title: "检测到 Client 冲突",
        content: `当前已有 Client（${req.oldClientId}）在线，新 Client（${req.newClientId}）请求接入。是否抢占切换？（约 ${seconds}s 后超时）`,
        okText: "抢占并切换",
        cancelText: "拒绝",
        onOk: async () => {
          ws.send({ t: "client.preempt.respond", requestId: req.requestId, decision: "accept" });
        },
        onCancel: async () => {
          ws.send({ t: "client.preempt.respond", requestId: req.requestId, decision: "decline" });
        },
      });
      if (modal && typeof (modal as { destroy?: unknown }).destroy === "function") {
        clientPreemptModals.set(req.requestId, modal as { destroy: () => void });
      }
    },
    onClientPreemptResolved: (info) => {
      const existing = clientPreemptModals.get(info.requestId);
      if (existing) {
        try {
          existing.destroy();
        } catch {
          // ignore destroy failure
        }
        clientPreemptModals.delete(info.requestId);
      }
      const label = info.decision === "accepted"
        ? "已抢占并切换"
        : info.decision === "declined"
          ? "已拒绝"
          : info.decision === "failed"
            ? "激活失败"
            : "已超时";
      message.info(`Client 抢占处理：${label}`);
    },
  });
  const localWorkspaceReady = computed(() => isDesktopWorkspace(config, String(config.workspaceId ?? "")));
  /** 桌面身份和首次目录均完成后才激活会话，避免并发目录读取互相取消并遗漏列表。 */
  const currentWorkspaceReady = computed(() => {
    // 本机运行时不可用时，其他机器已在线的工作区仍可沿云端连接激活。
    const remoteOnline = presence.activeWorkspaceRuntimeState.status === "online";
    return (!config.isDesktop || desktopStartupComplete.value || remoteOnline)
      && (localWorkspaceReady.value || (config.connected && (!config.isDesktop || config.localRuntimeReady || remoteOnline)));
  });

  /** 设置入口只接收已登记页签；桌面弹窗只保留模型配置。 */
  function normalizeSettingsTab(tab?: string): string {
    const normalized = String(tab ?? "").trim();
    if (config.isDesktop) return "engine-keys";
    if (normalized === "app-update") return defaultSettingsTab();
    return AVAILABLE_SETTINGS_TABS.has(normalized) ? normalized : defaultSettingsTab();
  }

  /** 打开账号级终端中心；共享工作区和无工作区缓存场景仍允许只读/跨区使用。 */
  function openTerminal(): void {
    if (!config.workspaceId && terminalStore.terminals.length === 0) {
      message.warning("请先创建或选择工作区后再使用终端");
      return;
    }
    if (mode.value === "mobile") terminalOpen.value = true;
    else ui.toggleRightPanel("terminal");
    trackProductEvent("feature_open", {
      feature: "terminal",
      source: "app_shell",
    });
  }

  provide(WS_CLIENT_KEY, ws);
  provide(APP_MODALS_KEY, {
    openDesktopAuth: () => {
      openDesktopAuthModal();
    },
    openSettings: (tab?: string) => {
      if (!tab && isOnboardingRoute.value) {
        openSettingsOrWizard();
        return;
      }
      // 桌面设置只保留模型配置；工作区导入入口改开独立工作区管理框。
      if (config.isDesktop && String(tab ?? "").trim() === "workspaces") {
        workspaceManagerOpen.value = true;
        trackProductEvent("workspace_manager_open", { source: "app_shell" });
        return;
      }
      const nextTab = normalizeSettingsTab(tab);
      if (mode.value === "mobile") {
        ui.pushMobilePage({ type: "settings", context: { tab: nextTab } });
        trackProductEvent("settings_open", {
          settings_tab: nextTab,
          surface: "mobile",
        });
        return;
      }
      settingsOpen.value = true;
      settingsActiveTab.value = nextTab;
      trackProductEvent("settings_open", {
        settings_tab: nextTab,
        surface: "modal",
      });
    },
    openFeedback: (source = "user_menu") => {
      feedbackSource.value = source;
      feedbackOpen.value = true;
    },
    openClientUpgrade: () => {
      clientUpgradeOpen.value = true;
      trackProductEvent("client_upgrade_open", {
        source: "app_shell",
      });
    },
    openClientManagement: () => {
      clientManagementOpen.value = true;
      trackProductEvent("client_management_open", {
        source: "app_shell",
      });
    },
    openWorkspaceManager: () => {
      workspaceManagerOpen.value = true;
      trackProductEvent("workspace_manager_open", {
        source: "app_shell",
      });
    },
    openTerminal,
    logout,
    toggleTheme: () => { ui.toggleThemeMode(); },
  });

  const canUseTerminal = computed(() => {
    if (terminalStore.terminals.length > 0) return true;
    const workspaceId = String(config.workspaceId ?? "").trim();
    if (!workspaceId || isSharedWorkspaceSelection(workspaceId)) return false;
    // 未关联账号的本机工作区由桌面本机终端通道提供能力。
    if (isLocalDesktopTerminalMode(config, workspaceId)) return true;
    return config.connected && presence.isCurrentWorkspaceClientOnline;
  });
  const maxPreviewZ = computed(() => ui.explorerPreviewWindows.reduce((m, w) => Math.max(m, w.zIndex), 0));

  const connectionLabel = computed(() => {
    if (config.isDesktop) {
      if (config.desktopCloudAccount?.errorCode === "DESKTOP_CREDENTIAL_RELEASE_FAILED") return "凭据清理失败";
      if (config.desktopCloudAccountLinked && config.desktopCloudAccount?.builtInRelayErrorCode === "DESKTOP_BUILTIN_AUTO_ENABLE_MARKER_FAILED") return "已关联 · Key 初始化记录失败";
      if (config.desktopCloudAccountLinked && config.desktopCloudAccount?.builtInRelayErrorCode) return "已关联 · Key 启用失败";
      if (config.desktopCloudAccountLinked) return "已关联";
      if (config.desktopCloudAccount?.status === "failed") return "关联失败";
      if (config.desktopCloudAccount?.status === "linking") return "关联中";
      return config.localRuntimeReady ? "本机可用" : "本机未就绪";
    }
    if (config.connectionStatus === "connected") return "已连接";
    if (config.connectionStatus === "connecting") return "连接中";
    if (config.connectionStatus === "reconnecting") return "重连中";
    return "未连接";
  });

  const connectionTagColor = computed(() => {
    if (config.isDesktop) return config.desktopCloudAccount?.errorCode === "DESKTOP_CREDENTIAL_RELEASE_FAILED" || config.desktopCloudAccount?.status === "failed" ? "red" : config.desktopCloudAccountLinked && !config.desktopCloudAccount?.builtInRelayErrorCode ? "green" : "orange";
    if (config.connectionStatus === "connected") return "green";
    if (config.connectionStatus === "connecting" || config.connectionStatus === "reconnecting") return "orange";
    return "default";
  });

  /** 失败持续展示在账号状态中，后台重试无需反复弹窗。 */
  const desktopAccountFailureDescription = computed(() => config.isDesktop && config.desktopCloudAccount?.status === "failed"
    ? describeUserFacingError({ code: config.desktopCloudAccountError ?? config.desktopCloudAccount.errorCode }, "桌面账号关联失败，请检查账号服务器地址和网络后重试。") : null);

  const isMobileModalViewport = computed(() => mode.value === "mobile");
  const isLandingRoute = computed(() => router.currentRoute.value.name === "landing");
  const isOnboardingRoute = computed(() => {
    const routeName = String(router.currentRoute.value.name ?? "");
    return routeName === "landing" || routeName === "guide" || routeName === "pricing" || routeName === "contact" || routeName === "data-security-commitment";
  });
  const isPaymentVerificationRoute = computed(() => router.currentRoute.value.name === "payment-verification");

  function resolveCurrentRoutePathWithoutOneTimeFlags(): string {
    const query = { ...router.currentRoute.value.query };
    delete query.redirect;
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, rawValue]) => {
      if (Array.isArray(rawValue)) {
        rawValue.forEach((item) => {
          const value = String(item ?? "").trim();
          if (value) params.append(key, value);
        });
        return;
      }
      const value = String(rawValue ?? "").trim();
      if (value) params.append(key, value);
    });
    const search = params.toString();
    return `${router.currentRoute.value.path}${search ? `?${search}` : ""}${router.currentRoute.value.hash || ""}`;
  }

  const currentWorkspace = computed(() => {
    if (!config.workspaceId) return null;
    return workspaces.byId.get(config.workspaceId) ?? null;
  });
  const isCurrentSharedWorkspace = computed(() => {
    const workspaceId = String(config.workspaceId ?? "").trim();
    if (!workspaceId) return false;
    const workspace = currentWorkspace.value;
    return workspace?.kind === "shared" || Boolean(workspace?.shared) || isSharedWorkspaceSelectionId(workspaceId);
  });

  const systemThemeQuery = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const systemDark = ref(systemThemeQuery?.matches ?? false);
  const updateSystemTheme = (event: MediaQueryListEvent): void => { systemDark.value = event.matches; };
  onMounted(() => {
    systemDark.value = systemThemeQuery?.matches ?? false;
    systemThemeQuery?.addEventListener("change", updateSystemTheme);
  });
  onUnmounted(() => systemThemeQuery?.removeEventListener("change", updateSystemTheme));

  const actualTheme = computed(() => {
    if (ui.themeMode !== "auto") return ui.themeMode;
    return systemDark.value ? "dark" : "light";
  });

  const antdTheme = computed(() => {
    const isDark = actualTheme.value === "dark";
    return {
      token: {
        colorPrimary: isDark ? "#d97757" : "#c96442",
        borderRadius: 12,
      },
      algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    };
  });


  function currentAuthScopeKey(): string {
    return [
      String(config.authMode ?? ""),
      String(config.userSummary?.userId ?? ""),
      String(config.serverWsOrigin ?? "").trim(),
    ].join("::");
  }

  function buildShellReadScope(kind: string, workspaceId: string | null | undefined = config.workspaceId): string {
    return [
      kind,
      currentAuthScopeKey(),
      String(workspaceId ?? ""),
      config.connected ? "1" : "0",
    ].join("::");
  }

  function cancelShellReadTask(name: ShellReadTaskName, reason: AbortKind): void {
    const task = shellReadTasks[name];
    if (!task) return;
    task.controller.abort(createCancelledRequestError(reason));
    shellReadTasks[name] = null;
  }

  function cancelRuntimeReads(reason: AbortKind): void {
    cancelShellReadTask("clientVersion", reason);
    cancelShellReadTask("workspacePrefs", reason);
    cancelShellReadTask("engine", reason);
  }

  function runShellReadTask(
    name: ShellReadTaskName,
    scopeKey: string,
    start: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const existing = shellReadTasks[name];
    if (existing) {
      if (existing.scopeKey === scopeKey) return existing.promise;
      existing.controller.abort(createCancelledRequestError("scope-change"));
    }

    const controller = new AbortController();
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        await start(controller.signal);
      } catch (error) {
        if (isCancelledRequestError(error)) return;
        throw error;
      } finally {
        if (shellReadTasks[name]?.promise === promise) {
          shellReadTasks[name] = null;
        }
      }
    })();
    shellReadTasks[name] = { scopeKey, controller, promise };
    return promise;
  }

  /** 运行时换代使旧激活失效，避免把旧进程读取与新 SQLite 历史混合。 */
  function buildWorkspaceActivationScope(workspaceId: string, requestedThreadId: ThreadId | null): string {
    return [
      "workspace-activation",
      currentAuthScopeKey(),
      String(config.webSessionId ?? ""),
      workspaceId,
      String(requestedThreadId ?? ""),
      String(chat.workspaceHydrationRequestTick),
      isDesktopWorkspace(config, workspaceId) ? String(config.desktopRuntime?.requestId ?? "") : "",
    ].join("::");
  }

  function cancelWorkspaceActivationTask(reason: AbortKind): void {
    const task = workspaceActivationTask;
    activeWorkspaceActivationScopeKey = "";
    if (!task) return;
    task.controller.abort(createCancelledRequestError(reason));
    workspaceActivationTask = null;
  }

  function runWorkspaceActivationTask(
    scopeKey: string,
    start: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const existing = workspaceActivationTask;
    if (existing) {
      if (existing.scopeKey === scopeKey) return existing.promise;
      existing.controller.abort(createCancelledRequestError("scope-change"));
    }

    const controller = new AbortController();
    activeWorkspaceActivationScopeKey = scopeKey;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        await start(controller.signal);
      } catch (error) {
        if (isCancelledRequestError(error)) return;
        throw error;
      } finally {
        if (activeWorkspaceActivationScopeKey === scopeKey) {
          activeWorkspaceActivationScopeKey = "";
        }
        if (workspaceActivationTask?.promise === promise) {
          workspaceActivationTask = null;
        }
      }
    })();
    workspaceActivationTask = { scopeKey, controller, promise };
    return promise;
  }

  /** 读取标准会话页或账号 H5 地址栏中的目标主会话。 */
  function resolveRouteThreadId(): ThreadId | null {
    if (!isPrimaryThreadRoute(router.currentRoute.value.name)) return null;
    if (typeof window !== "undefined") {
      // 这里必须以真实地址栏为准。threadId 的清理由 `history.replaceState`
      // 驱动，Vue Router 的 query 在同一拍里可能还是旧值；如果回退读它，
      // 会把刚刚清掉的旧 threadId 再“复活”出来。
      return getThreadIdFromUrl();
    }
    const routeThreadId = String(router.currentRoute.value.query.threadId ?? "").trim();
    return routeThreadId ? (routeThreadId as ThreadId) : null;
  }

  /** 解析当前主会话路由请求，非会话路由不触发会话激活。 */
  function resolveRequestedThreadId(): ThreadId | null {
    return isPrimaryThreadRoute(router.currentRoute.value.name) ? resolveRouteThreadId() : null;
  }

  function handleThreadUrlChanged(): void {
    const requestedThreadId = resolveRequestedThreadId();
    if (shouldClearPrimarySelectionForThreadUrlChange({
      routeName: router.currentRoute.value.name,
      requestedThreadId,
      selectedThreadId: chat.selectedThreadId,
    })) {
      chat.clearPrimaryThreadSelection({ clearUrl: false, reason: "selection-change" });
    }
    threadUrlTick.value += 1;
  }

  /** 应用内切换后同步 Router 快照；只改 history 会让后续导航把旧 workspaceId 写回。 */
  function handleWorkspaceUrlSync(event: Event): void {
    const workspaceId = (event as CustomEvent<WorkspaceUrlSyncDetail>).detail?.workspaceId;
    if (!workspaceId) return;
    const href = resolveWorkspaceSwitchReloadUrl(window.location.href, workspaceId);
    if (href === window.location.href) return;
    // Router 的字符串参数是相对 path，传绝对地址会被再次拼到当前 origin 后面。
    const target = new URL(href);
    const nextHref = `${target.pathname}${target.search}${target.hash}`;
    void router.replace(nextHref).then((failure) => {
      if (!failure) return;
      console.warn("[workspace] workspace URL sync aborted", { workspaceId, href: nextHref, failureType: failure.type });
    }).catch((error: unknown) => {
      console.warn("[workspace] failed to sync workspace URL", {
        workspaceId, href: nextHref, reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** 保持用户已有工作区选择稳定；仅在没有当前选择时才自动挑默认工作区。 */
  function ensureWorkspaceSelectionStable(): boolean {
    const currentWorkspaceId = String(config.workspaceId ?? "").trim();
    const candidateWorkspaceIds = workspaces.workspaces.map((workspace) => String(workspace.id));
    const preferredWorkspaceId = resolveStickyWorkspaceSelection({
      currentWorkspaceId,
      candidates: candidateWorkspaceIds,
      onlineWorkspaceIds: presence.online.onlineClients.flatMap((client) => client.workspaceIds),
    });
    if (!preferredWorkspaceId) {
      return false;
    }

    if (preferredWorkspaceId !== currentWorkspaceId) {
      config.switchWorkspace(preferredWorkspaceId, { preservePrimaryThreadUrl: true });
      return false;
    }

    return true;
  }

  function isSharedWorkspaceSelection(workspaceId: string): boolean {
    const workspace = workspaces.byId.get(workspaceId as WorkspaceId) ?? null;
    return workspace?.kind === "shared" || Boolean(workspace?.shared) || isSharedWorkspaceSelectionId(workspaceId);
  }

  function resolveSharedWorkspaceTopicId(workspaceId: string): string | null {
    const workspace = workspaces.byId.get(workspaceId as WorkspaceId) ?? null;
    const routeAliasId = String(workspace?.shared?.sharedWorkspaceId ?? "").trim();
    return routeAliasId || parseSharedWorkspaceSelectionId(workspaceId);
  }

  /** 根据共享角色决定会话列表首屏筛选；管理员显式读取全部，成员沿用当前筛选。 */
  function resolveSharedThreadOnlyRelatedToMe(workspaceId: string): boolean | null {
    if (!isSharedWorkspaceSelection(workspaceId)) return null;
    const workspace = workspaces.byId.get(workspaceId as WorkspaceId) ?? null;
    const role = workspace?.capabilities?.effectiveAssetRole
      ?? workspace?.shared?.effectiveAssetRole
      ?? workspace?.shared?.currentUserRole
      ?? null;
    if (role === "member") return chat.threadListOnlyRelatedToMe;
    if (role) return false;
    return true;
  }

  function markWorkspacePresenceFromCurrentSnapshot(scopeKey: string, workspaceId: string): { degraded: boolean } {
    const snapshot = presence.activeWorkspaceSnapshot;
    if (!snapshot || snapshot.workspaceId !== workspaceId || !snapshot.resolved) {
      chat.markWorkspacePresenceDegraded({ key: scopeKey });
      return { degraded: true };
    }
    if (snapshot.state === "online") {
      chat.markWorkspacePresenceReady({ key: scopeKey });
      return { degraded: false };
    }
    chat.markWorkspacePresenceDegraded({ key: scopeKey });
    return { degraded: true };
  }

  async function resolveRouteThreadSummary(
    scopeKey: string,
    workspaceId: WorkspaceId,
    routeThreadId: ThreadId,
    signal: AbortSignal,
  ): Promise<ThreadSummary | null> {
    if (chat.selectedThreadId && String(chat.selectedThreadId) !== String(routeThreadId)) {
      chat.clearPrimaryThreadSelection({ clearUrl: false });
    }
    chat.beginPrimaryRouteResolution(routeThreadId);
    const res = await getThreadSummary(ctx.value, { workspaceId, threadId: routeThreadId }, { signal });
    if (signal.aborted) throw createCancelledRequestError("scope-change");
    if (!res.ok) {
      if (res.code === "NOT_FOUND") {
        message.warning("这个聊天窗口不存在，已回到默认状态。");
        chat.clearPrimaryThreadSelection({ clearUrl: true });
        chat.clearPrimaryRouteResolution();
        return null;
      }
      if (res.code === "CONFLICT") {
        const targetWorkspaceId = resolveRouteThreadConflictWorkspaceId(res.details, workspaceId);
        if (targetWorkspaceId) {
          config.switchWorkspace(targetWorkspaceId, { preservePrimaryThreadUrl: true });
          return null;
        }
        const switched = await switchToRouteThreadWorkspaceIfPossible(workspaceId, routeThreadId, signal);
        if (switched) return null;
        message.warning("这个聊天窗口不在当前工作区，已回到默认状态。");
        chat.clearPrimaryThreadSelection({ clearUrl: true });
        chat.clearPrimaryRouteResolution();
        return null;
      }
      chat.clearPrimaryThreadSelection({ clearUrl: false });
      chat.markPrimaryRouteRetryable(routeThreadId, res.message);
      return null;
    }
    if (!res.visibility?.routeDeepLink) {
      message.warning("这个聊天窗口不能直接通过地址打开，已回到默认状态。");
      chat.clearPrimaryThreadSelection({ clearUrl: true });
      chat.clearPrimaryRouteResolution();
      return null;
    }
    chat.upsertThreadSummary(res.thread);
    chat.clearThreadPendingDispatch(res.thread.id);
    chat.setThreadRunningHint(res.thread.id, res.running ?? null);
    chat.setThreadManagedServicesScope(res.thread.id, res.managedServices ?? null);
    chat.markThreadResolved({ key: scopeKey, threadId: res.thread.id, owner: "primary" });
    chat.markPrimaryRouteResolved(res.thread.id);
    return res.thread;
  }

  /** 从 Client 返回的 workspace 冲突详情中解析 thread 所属工作区。 */
  function resolveRouteThreadConflictWorkspaceId(details: unknown, currentWorkspaceId: WorkspaceId): WorkspaceId | null {
    if (!details || typeof details !== "object" || Array.isArray(details)) return null;
    const workspaceId = String((details as Record<string, unknown>).threadWorkspaceId ?? "").trim();
    if (!workspaceId || workspaceId === String(currentWorkspaceId)) return null;
    return workspaces.byId.get(workspaceId as WorkspaceId) ? (workspaceId as WorkspaceId) : null;
  }

  /** 深链 threadId 命中其它已知工作区时，切到所属工作区并保留 URL。 */
  async function switchToRouteThreadWorkspaceIfPossible(
    currentWorkspaceId: WorkspaceId,
    routeThreadId: ThreadId,
    signal: AbortSignal,
  ): Promise<boolean> {
    const current = String(currentWorkspaceId);
    const candidates = workspaces.workspaces
      .map((workspace) => String(workspace.id ?? "").trim())
      .filter((workspaceId) => workspaceId && workspaceId !== current);

    for (const candidate of candidates) {
      const res = await getThreadSummary(ctx.value, {
        workspaceId: candidate as WorkspaceId,
        threadId: routeThreadId,
      }, { signal });
      if (signal.aborted) throw createCancelledRequestError("scope-change");
      if (res.ok) {
        if (!res.visibility?.routeDeepLink) return false;
        config.switchWorkspace(candidate, { preservePrimaryThreadUrl: true });
        return true;
      }
      if (isExpectedRouteThreadWorkspaceProbeMiss(res.code)) continue;
      throw new Error(`解析会话所属工作区失败：${res.message}`);
    }
    return false;
  }

  /** 工作区探测中的预期未命中结果：表示该 thread 不属于候选工作区或当前账号不可直达。 */
  function isExpectedRouteThreadWorkspaceProbeMiss(code: unknown): boolean {
    return code === "NOT_FOUND" || code === "CONFLICT" || code === "FORBIDDEN";
  }

  async function settleRequestedThreadSelection(
    scopeKey: string,
    workspaceId: WorkspaceId,
    routeThreadId: ThreadId | null,
    requestedThreadId: ThreadId | null,
    signal: AbortSignal,
  ): Promise<ThreadId | null> {
    if (!requestedThreadId) {
      const fallbackThreadId = resolvePrimaryThreadFallbackForRoute({
        routeName: router.currentRoute.value.name,
        selectedThreadId: chat.selectedThreadId,
        hasSelectedThreadSummary: Boolean(chat.getThreadSummary(chat.selectedThreadId)),
      });
      chat.clearPrimaryRouteResolution();
      if (!fallbackThreadId) {
        if (router.currentRoute.value.name === "chat" && chat.selectedThreadId) {
          chat.clearPrimaryThreadSelection({ clearUrl: false });
        }
        return null;
      }
      const existing = chat.getThreadSummary(fallbackThreadId);
      if (!existing) return null;
      await chat.syncThreadSummaryState(ctx.value, {
        workspaceId,
        threadId: existing.id,
        waitForRunning: false,
      });
      if (signal.aborted) throw createCancelledRequestError("scope-change");
      chat.markThreadResolved({ key: scopeKey, threadId: existing.id, owner: "primary" });
      if (chat.selectedThreadId !== existing.id) chat.selectThread(existing.id);
      chat.markThreadSelected({ key: scopeKey, threadId: existing.id, owner: "primary" });
      return existing.id;
    }

    if (routeThreadId && String(routeThreadId) === String(requestedThreadId)) {
      const existing = chat.threads.find((item) => String(item.id) === String(routeThreadId)) ?? null;
      if (existing && getThreadEntryVisibility(existing).routeDeepLink) {
        if (chat.selectedThreadId && String(chat.selectedThreadId) !== String(routeThreadId)) {
          chat.clearPrimaryThreadSelection({ clearUrl: false });
        }
        chat.beginPrimaryRouteResolution(routeThreadId);
        chat.clearThreadPendingDispatch(existing.id);
        chat.markThreadResolved({ key: scopeKey, threadId: existing.id, owner: "primary" });
        chat.markPrimaryRouteResolved(existing.id);
        if (chat.selectedThreadId !== existing.id) chat.selectThread(existing.id);
        chat.markThreadSelected({ key: scopeKey, threadId: existing.id, owner: "primary" });
        return existing.id;
      }
      const resolved = await resolveRouteThreadSummary(scopeKey, workspaceId, routeThreadId, signal);
      if (!resolved) return null;
      if (chat.selectedThreadId !== resolved.id) chat.selectThread(resolved.id);
      chat.markThreadSelected({ key: scopeKey, threadId: resolved.id, owner: "primary" });
      return resolved.id;
    }

    const existing = chat.getThreadSummary(requestedThreadId);
    if (existing) {
      await chat.syncThreadSummaryState(ctx.value, {
        workspaceId,
        threadId: existing.id,
        waitForRunning: false,
      });
      if (signal.aborted) throw createCancelledRequestError("scope-change");
      chat.markThreadResolved({ key: scopeKey, threadId: existing.id, owner: "primary" });
      if (chat.selectedThreadId !== existing.id) chat.selectThread(existing.id);
      chat.markThreadSelected({ key: scopeKey, threadId: existing.id, owner: "primary" });
      chat.clearPrimaryRouteResolution();
      return existing.id;
    }
    if (chat.selectedThreadId === requestedThreadId) {
      chat.clearPrimaryThreadSelection({ clearUrl: false });
    }
    chat.clearPrimaryRouteResolution();
    return null;
  }

  /** 等待当前工作区 presence 快照；离线快照也视为降级，避免继续打 Client 依赖接口。 */
  async function waitForActiveWorkspacePresenceSnapshot(
    workspaceId: string,
    epoch: number,
    signal: AbortSignal,
  ): Promise<{ degraded: boolean }> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < WORKSPACE_PRESENCE_TIMEOUT_MS) {
      if (signal.aborted) throw createCancelledRequestError("scope-change");
      const snapshot = presence.activeWorkspaceSnapshotFor(workspaceId, epoch);
      if (snapshot) {
        return { degraded: snapshot.state !== "online" };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    presence.markActiveWorkspaceSnapshotDegraded(workspaceId, epoch);
    return { degraded: true };
  }

  /** 同一失败按工作区只记录提示一次，保留原请求拒绝和 Store 失败态。 */
  function observeAuxiliaryRefresh(operation: string, task: Promise<void>, workspaceId: string): void {
    void task.catch(error => {
      if (isCancelledRequestError(error)) return;
      if (error !== null && (typeof error === "object" || typeof error === "function")) {
        const scopes = auxiliaryRefreshFailures.get(error) ?? new Set<string>();
        if (scopes.has(workspaceId)) return;
        scopes.add(workspaceId);
        auxiliaryRefreshFailures.set(error, scopes);
      }
      const failure = error as { code?: string; details?: { requestId?: string; serverRequestId?: string } } | null;
      const rootCause = error instanceof Error ? error.message : String(error);
      console.error("[appShell.auxiliary_refresh_failed]", { code: failure?.code ?? "WORKSPACE_AUXILIARY_REFRESH_FAILED",
        requestId: failure?.details?.requestId ?? failure?.details?.serverRequestId ?? `workspace-refresh:${workspaceId}:${operation}`,
        workspaceId, operation, rootCause });
      if (config.workspaceId === workspaceId) message.error(`工作区刷新失败：${rootCause}`);
    });
  }

  /** 激活后独立刷新引擎与配置，CLI 探测不阻塞会话列表；shared 只读 Host 状态。 */
  function startAuxiliaryRefresh(workspaceId: string): void {
    observeAuxiliaryRefresh("clientVersion", fetchClientVersionInfo(), workspaceId);
    observeAuxiliaryRefresh("engineStatus", refreshEngineStatus(workspaceId), workspaceId);
    if (isSharedWorkspaceSelection(workspaceId)) {
      observeAuxiliaryRefresh("reminders", reminders.refreshCurrentWorkspace(ctx.value, workspaceId as WorkspaceId), workspaceId);
      return;
    }
    observeAuxiliaryRefresh("reminderSummaries", reminders.refreshWorkspaceSummaries(ctx.value), workspaceId);
    observeAuxiliaryRefresh("reminders", reminders.refreshCurrentWorkspace(ctx.value, workspaceId as WorkspaceId), workspaceId);
    observeAuxiliaryRefresh("workspacePreferences", loadWorkspacePrefs(workspaceId), workspaceId);
  }

  /** Host 重新在线后的恢复刷新；shared 工作区避免读取成员本机配置。 */
  function startClientOnlineRecoveryRefresh(workspaceId: string): void {
    if (isSharedWorkspaceSelection(workspaceId)) {
      startAuxiliaryRefresh(workspaceId);
      return;
    }
    observeAuxiliaryRefresh("threads", chat.refreshThreads(ctx.value, workspaceId as WorkspaceId), workspaceId);
    startAuxiliaryRefresh(workspaceId);
  }

  /** 停止 engine 状态兜底刷新，避免断线或切换工作区后继续请求旧 workspace。 */
  function stopEngineStatusAutoRefresh(): void {
    if (engineStatusRefreshTimer != null) {
      window.clearInterval(engineStatusRefreshTimer);
    }
    engineStatusRefreshTimer = null;
    engineStatusRefreshWorkspaceId = "";
  }

  /** 判断当前 workspace 是否仍允许刷新 engine 状态。 */
  function canRefreshEngineStatusForWorkspace(workspaceId: string): boolean {
    return Boolean(
      (config.connected || isDesktopWorkspace(config, workspaceId))
      && config.workspaceId === workspaceId
      && presence.isCurrentWorkspaceClientOnline
      && !isPaymentVerificationRoute.value,
    );
  }

  /** 前台恢复时补一次 engine 状态，修正页面隐藏期间可能产生的缓存陈旧。 */
  function refreshEngineStatusAfterVisible(): void {
    if (typeof document === "undefined" || document.hidden) return;
    const workspaceId = engineStatusRefreshWorkspaceId;
    if (!workspaceId || !canRefreshEngineStatusForWorkspace(workspaceId)) return;
    observeAuxiliaryRefresh("engineStatusVisible", refreshEngineStatus(workspaceId), workspaceId);
  }

  /** 在当前 workspace client 在线期间低频兜底刷新 CLI 状态，修正长久在线页面的陈旧缓存。 */
  function startEngineStatusAutoRefresh(workspaceId: string): void {
    if (engineStatusRefreshTimer != null && engineStatusRefreshWorkspaceId === workspaceId) return;
    stopEngineStatusAutoRefresh();
    engineStatusRefreshWorkspaceId = workspaceId;
    engineStatusRefreshTimer = window.setInterval(() => {
      if (!canRefreshEngineStatusForWorkspace(workspaceId)) {
        stopEngineStatusAutoRefresh();
        return;
      }
      if (typeof document !== "undefined" && document.hidden) return;
      observeAuxiliaryRefresh("engineStatusPeriodic", refreshEngineStatus(workspaceId), workspaceId);
    }, ENGINE_STATUS_REFRESH_INTERVAL_MS);
  }

  /** 归属和在线状态确认后并行读取辅助状态，模型目录不等待会话历史。 */
  async function runWorkspaceHydrationCoordinator(
    workspaceId: string,
    requestedThreadId: ThreadId | null,
    signal: AbortSignal,
  ): Promise<void> {
    const scopeKey = buildWorkspaceActivationScope(workspaceId, requestedThreadId);
    chat.beginWorkspaceActivation({
      key: scopeKey,
      workspaceId: workspaceId as WorkspaceId,
      threadId: requestedThreadId,
    });

    if (!workspaces.byId.has(workspaceId as WorkspaceId)
      || !isDesktopWorkspace(config, workspaceId)
      || isSharedWorkspaceSelection(workspaceId)) {
      await workspaces.refresh(ctx.value, { signal });
    }
    if (signal.aborted) throw createCancelledRequestError("scope-change");
    if (!ensureWorkspaceSelectionStable()) {
      chat.completeWorkspaceActivation({
        key: scopeKey,
        threadId: null,
        degraded: true,
      });
      return;
    }

    if (isSharedWorkspaceSelection(workspaceId)) {
      ws.replaceLocalWorkspaceSubscription(null);
      await ws.replaceWorkspaceSubscription(null);
      if (signal.aborted) throw createCancelledRequestError("scope-change");

      const snapshot = presence.captureActiveWorkspaceSnapshot(workspaceId, Date.now());
      const degraded = snapshot.state !== "online";
      let sharedDegraded = degraded;
      if (degraded) chat.markWorkspacePresenceDegraded({ key: scopeKey });
      else chat.markWorkspacePresenceReady({ key: scopeKey });
      startAuxiliaryRefresh(workspaceId);

      const sharedWorkspaceId = resolveSharedWorkspaceTopicId(workspaceId);
      if (sharedWorkspaceId) {
        await ws.subscribeSharedWorkspace(sharedWorkspaceId, {
          sinceSeq: chat.activeWorkspaceLastEventSeq,
        });
        if (signal.aborted) throw createCancelledRequestError("scope-change");
      } else {
        chat.markWorkspaceSubscribed();
      }
      let selectedThreadId: ThreadId | null = null;
      if (!degraded) {
        try {
          const onlyRelatedToMe = resolveSharedThreadOnlyRelatedToMe(workspaceId);
          if (onlyRelatedToMe != null) chat.threadListOnlyRelatedToMe = onlyRelatedToMe;
          await chat.refreshThreads(ctx.value, workspaceId as WorkspaceId, { onlyRelatedToMe });
          if (signal.aborted) throw createCancelledRequestError("scope-change");

          const routeThreadId = resolveRouteThreadId();
          selectedThreadId = await settleRequestedThreadSelection(
            scopeKey,
            workspaceId as WorkspaceId,
            routeThreadId,
            requestedThreadId,
            signal,
          );
          if (selectedThreadId) {
            if (!chat.loadedThreads[String(selectedThreadId)]) {
              await chat.ensureThreadHydrated(ctx.value, {
                workspaceId: workspaceId as WorkspaceId,
                threadId: selectedThreadId,
              });
            }
            chat.markVisibleThreadActivated({ key: scopeKey, threadId: selectedThreadId });
          }
        } catch (error) {
          if (isCancelledRequestError(error)) throw error;
          console.warn("[AppShell] shared workspace thread hydration failed:", error);
          sharedDegraded = true;
          chat.markWorkspacePresenceDegraded({ key: scopeKey });
        }
      }
      if (!signal.aborted) {
        try {
          await orch.resyncSelectedInstance(ctx.value, workspaceId);
        } catch (error) {
          console.warn("[AppShell] resyncSelectedInstance failed during shared workspace activation:", error);
        }
      }
      chat.completeWorkspaceActivation({
        key: scopeKey,
        threadId: selectedThreadId,
        degraded: sharedDegraded,
      });
      return;
    }

    const localWorkspace = isDesktopWorkspace(config, workspaceId);
    let presenceResult: { degraded: boolean };
    if (localWorkspace) {
      ws.replaceLocalWorkspaceSubscription(workspaceId as WorkspaceId);
      const snapshot = presence.captureActiveWorkspaceSnapshot(workspaceId, Date.now());
      presenceResult = { degraded: snapshot.state !== "online" };
    } else {
      ws.replaceLocalWorkspaceSubscription(null);
      const subscription = await ws.replaceWorkspaceSubscription(workspaceId as WorkspaceId, {
        sinceSeq: chat.activeWorkspaceLastEventSeq,
      });
      presenceResult = await waitForActiveWorkspacePresenceSnapshot(workspaceId, subscription.subscriptionEpoch, signal);
    }
    if (signal.aborted) throw createCancelledRequestError("scope-change");
    if (presenceResult.degraded) chat.markWorkspacePresenceDegraded({ key: scopeKey });
    else chat.markWorkspacePresenceReady({ key: scopeKey });
    if (!presenceResult.degraded) startAuxiliaryRefresh(workspaceId);

    let selectedThreadId: ThreadId | null = null;
    if (!presenceResult.degraded && !isSharedWorkspaceSelection(workspaceId)) {
      const onlyRelatedToMe = resolveSharedThreadOnlyRelatedToMe(workspaceId);
      if (onlyRelatedToMe != null) chat.threadListOnlyRelatedToMe = onlyRelatedToMe;
      await chat.refreshThreads(ctx.value, workspaceId as WorkspaceId, { onlyRelatedToMe });
      if (signal.aborted) throw createCancelledRequestError("scope-change");

      const routeThreadId = resolveRouteThreadId();
      selectedThreadId = await settleRequestedThreadSelection(
        scopeKey,
        workspaceId as WorkspaceId,
        routeThreadId,
        requestedThreadId,
        signal,
      );
      if (signal.aborted || config.workspaceId !== workspaceId) throw createCancelledRequestError("scope-change");
      if (activeWorkspaceActivationScopeKey === scopeKey) workspaceSwitching.value = false;
      if (selectedThreadId) {
        if (localWorkspace || !chat.loadedThreads[String(selectedThreadId)]) {
          await chat.ensureThreadHydrated(ctx.value, {
            workspaceId: workspaceId as WorkspaceId,
            threadId: selectedThreadId,
            forceReload: localWorkspace,
          });
        }
        if (signal.aborted) throw createCancelledRequestError("scope-change");
        chat.markVisibleThreadActivated({ key: scopeKey, threadId: selectedThreadId });
      }
    }

    if (!localWorkspace && !presenceResult.degraded && !signal.aborted) {
      try {
        await orch.resyncSelectedInstance(ctx.value, workspaceId);
      } catch (error) {
        console.warn("[AppShell] resyncSelectedInstance failed during workspace activation:", error);
      }
    }
    chat.completeWorkspaceActivation({
      key: scopeKey,
      threadId: selectedThreadId,
      degraded: presenceResult.degraded,
    });
  }

  /** 恢复会话表面并补齐被取消的首次检测；离线或明确失败不伪造可用状态。 */
  async function runVisibleThreadActivation(
    workspaceId: string,
    requestedThreadId: ThreadId | null,
    signal: AbortSignal,
  ): Promise<void> {
    const scopeKey = buildWorkspaceActivationScope(workspaceId, requestedThreadId);
    chat.beginWorkspaceActivation({
      key: scopeKey,
      workspaceId: workspaceId as WorkspaceId,
      threadId: requestedThreadId,
    });

    if (!ensureWorkspaceSelectionStable()) {
      chat.completeWorkspaceActivation({
        key: scopeKey,
        threadId: null,
        degraded: true,
      });
      return;
    }

    const presenceResult = markWorkspacePresenceFromCurrentSnapshot(scopeKey, workspaceId);
    const canHydrateThreadSurface = !presenceResult.degraded;
    const engineState = engine.byWorkspaceId[workspaceId];
    if (canHydrateThreadSurface && !engineState?.lastError && engineState?.lastUpdatedAt == null) {
      observeAuxiliaryRefresh("engineStatus", refreshEngineStatus(workspaceId).then(async () => {
        // 复用原在途读取；仅当前激活补查一次取消结果，真实失败仍由原边界处理。
        if (signal.aborted || config.workspaceId !== workspaceId) return;
        const current = engine.byWorkspaceId[workspaceId];
        if (!current?.loading && !current?.lastError && current?.lastUpdatedAt == null) await refreshEngineStatus(workspaceId);
      }), workspaceId);
    }
    const needsThreadRefresh = canHydrateThreadSurface && (
      !chat.threads.length || Boolean(requestedThreadId && !chat.getThreadSummary(requestedThreadId))
    );
    let selectedThreadId: ThreadId | null = null;
    if (needsThreadRefresh) {
      const onlyRelatedToMe = resolveSharedThreadOnlyRelatedToMe(workspaceId);
      if (onlyRelatedToMe != null) chat.threadListOnlyRelatedToMe = onlyRelatedToMe;
      await chat.refreshThreads(ctx.value, workspaceId as WorkspaceId, { onlyRelatedToMe, preferCache: true });
      if (signal.aborted) throw createCancelledRequestError("scope-change");
    }

    if (canHydrateThreadSurface) {
      const routeThreadId = resolveRouteThreadId();
      selectedThreadId = await settleRequestedThreadSelection(
        scopeKey,
        workspaceId as WorkspaceId,
        routeThreadId,
        requestedThreadId,
        signal,
      );
      if (selectedThreadId) {
        const localWorkspace = isDesktopWorkspace(config, workspaceId);
        if (localWorkspace || !chat.loadedThreads[String(selectedThreadId)]) {
          await chat.ensureThreadHydrated(ctx.value, {
            workspaceId: workspaceId as WorkspaceId,
            threadId: selectedThreadId,
            forceReload: localWorkspace,
          });
        }
        if (signal.aborted) throw createCancelledRequestError("scope-change");
        chat.markVisibleThreadActivated({ key: scopeKey, threadId: selectedThreadId });
      }
    }

    chat.completeWorkspaceActivation({
      key: scopeKey,
      threadId: selectedThreadId,
      degraded: presenceResult.degraded,
    });
  }

  /** 清理云端账号投影，桌面保留本机列表，业务会话仍从本地库重新读取。 */
  function resetAllStores(reason: AbortKind = "workspace-switch") {
    const hydrationTick = chat.workspaceHydrationRequestTick;
    const localClientId = config.desktopClient?.clientId;
    const localWorkspaces = config.isDesktop && localClientId ? workspaces.workspaces.filter((workspace) =>
      workspace.kind !== "shared" && !workspace.shared && !isSharedWorkspaceSelectionId(workspace.id)
      && workspace.ownerClientId === localClientId) : [];
    cancelWorkspaceActivationTask(reason);
    cancelRuntimeReads(reason);
    chat.resetForWorkspace(reason);
    workspaces.$reset();
    workspaces.workspaces = localWorkspaces;
    reminders.reset();
    sharedWorkspaces.$reset();
    explorer.resetForWorkspace();
    // 草稿含文件内容，退出账号/断开会话时必须清除；普通工作区切换保留各自草稿。
    if (reason === "disconnect") clearFileEditorDrafts();
    admin.$reset();
    terminalStore.$reset();
    presence.$reset();
    account.resetRuntimeState();
    quickPhrases.resetRuntimeState();
    builtInRelayAutoEnable.reset();
    if (localWorkspaceReady.value) {
      chat.workspaceHydrationRequestTick = hydrationTick;
      chat.requestWorkspaceHydration();
    }
  }

  /** 建立当前账号连接；退出过程中拒绝任何 watcher 触发的重连。 */
  async function connect() {
    if (logoutInProgress.value) return;
    connectError.value = null;
    try {
      await ws.connect();
    } catch (error) {
      if (isCancelledRequestError(error)) return;
      const msg = error instanceof Error ? error.message : String(error);
      connectError.value = msg;
      trackProductEvent("client_connection_change", {
        status: "failed",
        source: "websocket",
        error_code_group: "connect_error",
      });
    }
  }

  function disconnect() {
    ws.disconnect();
    resetAllStores("disconnect");
    if (router.currentRoute.value.name === "admin") {
      void router.push("/chat");
    }
  }

  /** 先关闭云端重连再退出账号；owner 取消向上传播，实际失败明确提示。 */
  async function logout() {
    if (logoutInProgress.value) return;
    const serverWsOrigin = config.serverWsOrigin;
    /** store 完成与壳恢复间也可能切换账号，各 await 后均禁止清理或导航新会话。 */
    function assertLoggedOut(): void {
      if (config.sessionToken || config.authMode === "account" || config.serverWsOrigin !== serverWsOrigin) {
        throw createCancelledRequestError("scope-change");
      }
    }
    logoutInProgress.value = true;
    config.setLogoutInProgress(true);
    cancelWorkspaceActivationTask("disconnect");
    cancelRuntimeReads("disconnect");
    ws.disconnect();
    try {
      await account.logout();
      assertLoggedOut();
      resetAllStores("disconnect");
      if (config.isDesktop) {
        await config.refreshDesktopRuntime();
        assertLoggedOut();
        const controller = new AbortController();
        const stopWatchingAccount = watch(
          () => [config.serverWsOrigin, config.authMode, config.sessionToken, config.userSummary?.userId],
          () => controller.abort(createCancelledRequestError("scope-change")),
          { flush: "sync" },
        );
        try {
          await workspaces.refresh(ctx.value, { signal: controller.signal, scopeKey: `logout:${serverWsOrigin}` });
        } finally {
          stopWatchingAccount();
        }
        assertLoggedOut();
        await router.push("/chat");
      } else if (router.currentRoute.value.name !== "auth-login") {
        await pushLoginRoute();
      }
    } catch (error) {
      if (!isCancelledRequestError(error) || error.kind !== "scope-change") {
        message.error(error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      logoutInProgress.value = false;
      config.setLogoutInProgress(false);
    }
  }

  function hasAccountSession(): boolean {
    return config.authMode === "account" && config.hasActiveSession;
  }

  /** 跳转登录页，可附带目标重定向路径。 */
  function pushLoginRoute(input?: { redirectPath?: string }) {
    return navigateToLoginRoute(router, {
      currentFullPath: input?.redirectPath,
      extras: undefined,
    });
  }

  /** 桌面端登录入口使用弹框，不离开工作台。 */
  function openDesktopAuthModal(): void {
    desktopAuthModalOpen.value = true;
  }

  function closeDesktopAuthModal(): void {
    desktopAuthModalOpen.value = false;
  }

  function previewWindowFileName(filePath: string): string {
    return getPathDisplayInfo(filePath).fileName;
  }

  /** 打开设置；未登录的浏览器用户先跳转登录。 */
  function openSettingsOrWizard() {
    if (!config.isDesktop && !hasAccountSession()) {
      pushLoginRoute();
      return;
    }
    settingsOpen.value = true;
    settingsActiveTab.value = defaultSettingsTab();
    trackProductEvent("settings_open", {
      settings_tab: defaultSettingsTab(),
      surface: "modal",
      source: "settings_or_wizard",
    });
  }

  /** 按当前工作区同步版本与升级能力，源码运行不触发升级提醒。 */
  function fetchClientVersionInfo(): Promise<void> {
    if (!config.connected) return Promise.resolve();
    const workspaceId = String(config.workspaceId ?? "");
    const scopeKey = buildShellReadScope("client-version", workspaceId);
    return runShellReadTask("clientVersion", scopeKey, async (signal) => {
      const res = await requestJson<{
        clientVersion: string | null;
        latestClientVersion: string | null;
        clients?: StatusClientVersionInfo[];
      }>(ctx.value, { method: "GET", path: "/api/status", signal });
      if (!res.ok) return;
      if (signal.aborted || scopeKey !== buildShellReadScope("client-version", workspaceId)) {
        throw createCancelledRequestError("stale-result");
      }
      const workspace = workspaces.byId.get(workspaceId as WorkspaceId) ?? null;
      const ownerClientId = String(workspace?.ownerClientId ?? "").trim();
      const sharedHostClientId = String(workspace?.shared?.hostClientId ?? "").trim();
      const sharedHostWorkspaceId = workspace?.shared?.isHostOwner
        ? String(workspace.shared.hostLocalWorkspaceId ?? "").trim()
        : "";
      const clientScope = {
        workspaceId,
        ownerClientId,
        hostClientId: sharedHostClientId,
        hostWorkspaceId: sharedHostWorkspaceId,
        clients: res.clients ?? [],
      };
      const clientVersion = resolveWorkspaceClientVersion({ ...clientScope, fallbackClientVersion: res.clientVersion ?? null });
      const client = resolveWorkspaceClientInfo(clientScope);
      config.setClientVersionInfo({
        clientVersion, latestClientVersion: res.latestClientVersion ?? null, selfUpgrade: client?.capabilities?.selfUpgrade,
      });
    });
  }

  /** 云端目录刷新独立结算失败，不改变本机启动状态；启动前仍遵守本机就绪围栏。 */
  function refreshWorkspaceListAfterConnect(): void {
    if (config.isDesktop && (!desktopStartupComplete.value
      || (!config.localRuntimeReady && presence.activeWorkspaceRuntimeState.status !== "online"))) return;
    void workspaces.refresh(ctx.value)
      .then(() => {
        ensureWorkspaceSelectionStable();
        return fetchClientVersionInfo();
      })
      .catch((error) => {
        if (isCancelledRequestError(error)) return;
        const failure = error as { code?: string; details?: { requestId?: string } };
        const rootCause = error instanceof Error ? error.message : String(error);
        console.error("[appShell.workspace_list_refresh_failed]", { code: failure.code ?? "WORKSPACE_LIST_REFRESH_FAILED",
          requestId: failure.details?.requestId ?? "workspace-list:connect", workspaceId: config.workspaceId, rootCause });
        message.error(`工作区刷新失败：${rootCause}`);
      });
  }

  /** 工作区偏好沿原任务去重入口读取，本机无需云端连接。 */
  function loadWorkspacePrefs(workspaceId: string): Promise<void> {
    if (!workspaceId || (!config.connected && !isDesktopWorkspace(config, workspaceId))) return Promise.resolve();
    const scopeKey = buildShellReadScope("workspace-prefs", workspaceId);
    return runShellReadTask("workspacePrefs", scopeKey, async (signal) => {
      await composer.loadWorkspacePrefs(ctx.value, workspaceId, { signal });
    });
  }

  /** 本机不等待云端连接，执行目录仍沿统一状态刷新入口读取。 */
  function refreshEngineStatus(workspaceId: string): Promise<void> {
    if (!workspaceId || (!config.connected && !isDesktopWorkspace(config, workspaceId))) return Promise.resolve();
    const scopeKey = buildShellReadScope("engine-status", workspaceId);
    return runShellReadTask("engine", scopeKey, async (signal) => {
      await engine.refresh(ctx.value, workspaceId, {
        signal,
        shouldApply: () => (config.connected || isDesktopWorkspace(config, workspaceId)) && config.workspaceId === workspaceId,
      });
    });
  }

  watchEffect(() => {
    const themeMode = ui.themeMode;
    const root = document.documentElement;
    if (themeMode === "auto") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", themeMode);
    }
  });

  onMounted(() => {
    if (config.isDesktop) {
      let refreshing = false;
      /** 启动先读本地目录，云账号同步保留原失败反馈；就绪后恢复常规轮询。 */
      const refreshDesktop = async (): Promise<void> => {
        if (refreshing || desktopStatusDisposed) return;
        refreshing = true;
        const initial = !desktopStartupComplete.value;
        try {
          if (!stopDesktopEvents) stopDesktopEvents = subscribeDesktopEvents(ws.receiveDesktopEvent);
          await config.refreshDesktopRuntime();
          if (desktopStatusDisposed) return;
          if (!config.localRuntimeReady) {
            if (initial && config.desktopError && desktopStatusTimer) {
              clearInterval(desktopStatusTimer);
              desktopStatusTimer = setInterval(() => { void refreshDesktop(); }, 5_000);
            }
            return;
          }
          if (initial) {
            await workspaces.refresh(ctx.value, { localOnly: true });
            if (desktopStatusDisposed) return;
            if (!workspaces.workspaces.length) openSettingsOrWizard();
            desktopStartupComplete.value = true;
            if (desktopStatusTimer) clearInterval(desktopStatusTimer);
            desktopStatusTimer = setInterval(() => { void refreshDesktop(); }, 5_000);
            if (config.connected) refreshWorkspaceListAfterConnect();
          }
          await syncDesktopAccount();
        } catch (error) {
          if (isCancelledRequestError(error)) return;
          // 退出中的结构化拒绝是正常收尾，不刷新为错误态或提示。
          if ((error as { code?: string } | null)?.code === "APP_SHUTTING_DOWN") return;
          config.desktopError = error instanceof Error ? error.message : String(error);
          config.desktopRuntime = { status: "failed", requestId: config.desktopRuntime?.requestId ?? null,
            releaseId: config.desktopRuntime?.releaseId ?? null, errorCode: "DESKTOP_RUNTIME_UNAVAILABLE" };
          if (initial && !desktopStatusDisposed && desktopStatusTimer) {
            clearInterval(desktopStatusTimer);
            desktopStatusTimer = setInterval(() => { void refreshDesktop(); }, 5_000);
          }
          console.error("[DESKTOP_RUNTIME_UNAVAILABLE]", { errorCode: "DESKTOP_RUNTIME_UNAVAILABLE",
            requestId: config.desktopRuntime.requestId, workspaceId: config.workspaceId, initial, rootCause: config.desktopError });
        } finally { refreshing = false; }
      };
      void refreshDesktop();
      desktopStatusTimer = setInterval(() => { void refreshDesktop(); }, 250);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("popstate", handleThreadUrlChanged);
      window.addEventListener(THREAD_URL_CHANGED_EVENT, handleThreadUrlChanged as EventListener);
      window.addEventListener(WORKSPACE_URL_SYNC_EVENT, handleWorkspaceUrlSync as EventListener);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", refreshEngineStatusAfterVisible);
    }
  });

  onUnmounted(() => {
    desktopStatusDisposed = true;
    if (desktopStatusTimer) clearInterval(desktopStatusTimer);
    stopDesktopEvents?.();
    ws.replaceLocalWorkspaceSubscription(null);
    if (typeof window !== "undefined") {
      window.removeEventListener("popstate", handleThreadUrlChanged);
      window.removeEventListener(THREAD_URL_CHANGED_EVENT, handleThreadUrlChanged as EventListener);
      window.removeEventListener(WORKSPACE_URL_SYNC_EVENT, handleWorkspaceUrlSync as EventListener);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", refreshEngineStatusAfterVisible);
    }
    stopEngineStatusAutoRefresh();
    if (terminalListTimeout) clearTimeout(terminalListTimeout);
  });
  watch(
    () => [config.canConnectServer, config.connected, isPaymentVerificationRoute.value, logoutInProgress.value] as const,
    ([canConnectServer, connected, isPaymentRoute, isLoggingOut]) => {
      if (isLoggingOut || isPaymentRoute || !canConnectServer || connected) return;
      void connect();
    },
    { immediate: true },
  );

  // Account session rotation changes accountSessionId; reconnect WS to keep HTTP and WS identities aligned.
  let desktopAccountFailureNotice: string | null = null;
  /** 同账号同进程的持续失败只提示一次；手动重试即时执行，迟到结果不通知新账号。 */
  async function syncDesktopAccount(manual = false): Promise<boolean> {
    if (!config.isDesktop) return true;
    if (!config.localRuntimeReady) return false;
    const scope = JSON.stringify([config.serverWsOrigin, config.userSummary?.userId, config.desktopRuntime?.requestId]);
    const sessionToken = config.sessionToken;
    /** 凭据仅用于内存 owner 校验；通知键不包含凭据，正常续期也不重复通知。 */
    const isCurrent = () => sessionToken === config.sessionToken
      && scope === JSON.stringify([config.serverWsOrigin, config.userSummary?.userId, config.desktopRuntime?.requestId]);
    try {
      await config.syncDesktopCloudAccount(false, manual);
      if (!isCurrent()) return false;
      if (config.desktopCloudAccount?.status === "failed") throw Object.assign(new Error(config.desktopCloudAccountError ?? config.desktopCloudAccount.errorCode ?? "DESKTOP_CLOUD_ACCOUNT_FAILED"), { code: config.desktopCloudAccountError ?? config.desktopCloudAccount.errorCode });
      if (config.desktopCloudAccount?.status === "linked" || config.desktopCloudAccount?.status === "unlinked") desktopAccountFailureNotice = null;
      return true;
    } catch (error) {
      if (isCancelledRequestError(error) || (error as { code?: unknown })?.code === "DESKTOP_CLOUD_LINK_CANCELLED" || !isCurrent()) return false;
      const notice = `${scope}:${config.desktopCloudAccountError ?? "DESKTOP_CLOUD_ACCOUNT_FAILED"}`;
      if (manual || desktopAccountFailureNotice !== notice) {
        desktopAccountFailureNotice = notice;
        message.error(describeUserFacingError(error, "桌面账号关联失败，请检查账号服务器地址和网络后重试。"));
      }
      return false;
    }
  }
  watch(
    () => [config.authMode, config.serverWsOrigin, config.userSummary?.userId, config.sessionToken, config.sessionExpiresAt, config.logoutInProgress] as const,
    () => { void syncDesktopAccount(); },
    { flush: "post" },
  );

  /** 登录后合并本机常用提示词；退出后重置，使下次登录可合并新增本机项。 */
  watch(
    () => [config.isDesktop, config.localRuntimeReady, config.connected, config.authMode, config.hasActiveSession, config.userSummary?.userId, config.serverWsOrigin] as const,
    () => {
      const userId = config.userSummary?.userId ?? "";
      if (config.authMode !== "account" || !config.hasActiveSession || !userId) { resetQuickPhraseSync(); return; }
      void syncQuickPhrasesToAccount(ctx.value, config.serverWsOrigin, userId).catch(() => {
        message.error("本机常用提示词合并到账号失败，请检查网络后重试");
      });
    },
    { immediate: true, flush: "post" },
  );

  watch(
    () => config.sessionToken,
    (nextToken, previousToken) => {
      if (logoutInProgress.value) return;
      const previous = String(previousToken ?? "").trim();
      const next = String(nextToken ?? "").trim();
      if (!previous || !next || previous === next) return;
      ws.disconnect();
      if (!isPaymentVerificationRoute.value && config.canConnectServer) {
        void connect();
      }
    },
  );

  watch(
    () => config.workspaceId,
    (next, prev) => {
      if (next === prev) return;
      cancelWorkspaceActivationTask("workspace-switch");
      cancelRuntimeReads("workspace-switch");
      reminders.resetForWorkspace((String(next ?? "").trim() || null) as WorkspaceId | null);
      chat.resetForWorkspace("workspace-switch");
      explorer.resetForWorkspace();
      // 预览窗口绑定旧工作区文件；应用内切换不再整页刷新，必须显式关闭。
      ui.closeAllPreviewWindows();
      if (currentWorkspaceReady.value && next) {
        chat.requestWorkspaceHydration();
      }
    },
  );

  // 逐项比较激活条件，运行态轮询返回相同值时不重复强制回放空会话。
  watch(
    [
      () => currentWorkspaceReady.value,
      () => config.workspaceId,
      () => router.currentRoute.value.fullPath,
      () => String(router.currentRoute.value.name ?? ""),
      () => threadUrlTick.value,
      () => resolveRequestedThreadId(),
      () => chat.workspaceHydrationRequestTick,
      () => isPaymentVerificationRoute.value,
      () => localWorkspaceReady.value ? config.desktopRuntime?.requestId : null,
      () => localWorkspaceReady.value ? currentAuthScopeKey() : null,
    ] as const,
    ([connected, workspaceId, _fullPath, routeName, _threadUrlTick, requestedThreadId, hydrationTick, isPaymentRoute], prev) => {
      if (isPaymentRoute || !connected || !workspaceId) {
        cancelWorkspaceActivationTask("reconnect-scope-change");
        workspaceSwitching.value = false;
        return;
      }

      const scopeKey = buildWorkspaceActivationScope(workspaceId, requestedThreadId);
      const previousConnected = prev?.[0] ?? false;
      const previousWorkspaceId = prev?.[1] ?? null;
      const previousRouteName = prev?.[3] ?? null;
      const previousRequestedThreadId = prev?.[5] ?? null;
      const previousHydrationTick = prev?.[6] ?? null;
      const shouldUseThreadOnlyActivation = Boolean(prev) && shouldUseThreadOnlyActivationForRouteChange({
        previousConnected,
        previousWorkspaceId,
        workspaceId,
        hydrationTick,
        previousHydrationTick,
        previousRequestedThreadId,
        requestedThreadId,
        previousRouteName,
        routeName,
      });
      const shouldShowWorkspaceSwitching = Boolean(
        prev
        && previousConnected
        && previousWorkspaceId !== workspaceId,
      );
      workspaceSwitching.value = shouldShowWorkspaceSwitching;
      void runWorkspaceActivationTask(scopeKey, async (signal) => {
        if (shouldUseThreadOnlyActivation) {
          await runVisibleThreadActivation(workspaceId, requestedThreadId, signal);
          return;
        }
        await runWorkspaceHydrationCoordinator(workspaceId, requestedThreadId, signal);
      }).then(() => {
        if (shouldShowWorkspaceSwitching && config.workspaceId === workspaceId) {
          trackProductEvent("workspace_switch", {
            status: "success",
            source: "workspace_activation",
            workspace_type: isSharedWorkspaceSelection(workspaceId) ? "shared" : "local",
          });
        }
      }).catch((error) => {
        if (isCancelledRequestError(error)) return;
        const failure = error as { code?: string; details?: { requestId?: string; serverRequestId?: string } } | null;
        console.error("[appShell.workspace_activation_failed]", {
          code: failure?.code ?? "WORKSPACE_ACTIVATION_FAILED",
          requestId: failure?.details?.requestId ?? failure?.details?.serverRequestId ?? `workspace-activation:${workspaceId}:${hydrationTick}`,
          workspaceId, threadId: requestedThreadId,
          rootCause: error instanceof Error ? error.message : String(error),
        });
        if (shouldShowWorkspaceSwitching) {
          trackProductEvent("workspace_switch", {
            status: "failed",
            source: "workspace_activation",
            workspace_type: isSharedWorkspaceSelection(workspaceId) ? "shared" : "local",
            error_code_group: "activation_failed",
          });
        }
        chat.completeWorkspaceActivation({
          key: scopeKey,
          threadId: chat.workspaceActivation.threadId,
          degraded: true,
        });
        // Client 离线已由 presence 降级态展示；自动激活链路不重复弹 toast。
        if (isWorkspaceClientOfflineError(error)) return;
        message.error(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        if (activeWorkspaceActivationScopeKey && activeWorkspaceActivationScopeKey !== scopeKey) return;
        if (shouldShowWorkspaceSwitching) {
          workspaceSwitching.value = false;
        }
      });
    },
    { immediate: true },
  );

  watch(
    () => config.connected,
    (connected) => {
      if (!connected) {
        if (!localWorkspaceReady.value) cancelWorkspaceActivationTask("disconnect");
        cancelRuntimeReads("reconnect-scope-change");
        return;
      }
      connectError.value = null;
      refreshWorkspaceListAfterConnect();
    },
  );

  watch(
    () => presence.accountClientState,
    (state, previousState) => {
      if (state === "unknown" || state === previousState) return;
      trackProductEvent("client_connection_change", {
        status: state === "online" ? "connected" : "disconnected",
        source: "presence",
        workspace_type: isSharedWorkspaceSelection(String(config.workspaceId ?? "")) ? "shared" : "local",
      });
    },
  );

  watch(
    () => [presence.activeWorkspaceSnapshotReady, presence.activeWorkspaceClientState] as const,
    ([ready, clientState]) => {
      if (!ready || clientState !== "online" || !config.connected || !config.workspaceId) return;
      if (chat.workspaceActivation.phase !== "settled" || !chat.workspaceActivation.degraded) return;
      if (chat.workspaceActivation.key) {
        chat.markWorkspacePresenceReady({ key: chat.workspaceActivation.key });
      }
      // Client 恢复在线不等于 Web 订阅已恢复：重连窗口内激活会在发出订阅前就退出（刷新工作区列表失败、
      // 选择不稳定等），服务端该会话的 activeWorkspaceId 会一直是空。这里重跑一次激活把订阅补上，
      // 否则页面继续用旧内容渲染，表现成「只有刷新页面才恢复正常」。
      chat.requestWorkspaceHydration();
      startAuxiliaryRefresh(config.workspaceId);
    },
  );

  watch(
    () => [currentWorkspaceReady.value, config.workspaceId, presence.isCurrentWorkspaceClientOnline, isPaymentVerificationRoute.value] as const,
    ([connected, wid, clientOnline, isPaymentRoute], prev) => {
      if (isPaymentRoute || !connected || !wid || !clientOnline) return;
      const previousClientOnline = prev?.[2] ?? null;
      if (previousClientOnline !== false) return;
      if (chat.workspaceActivation.workspaceId === wid && chat.workspaceActivation.phase === "critical") return;
      startClientOnlineRecoveryRefresh(wid);
    },
  );

  watch(
    () => [currentWorkspaceReady.value, config.workspaceId, presence.isCurrentWorkspaceClientOnline, isPaymentVerificationRoute.value] as const,
    ([connected, wid, clientOnline, isPaymentRoute]) => {
      if (isPaymentRoute || !connected || !wid || !clientOnline) {
        stopEngineStatusAutoRefresh();
        return;
      }
      startEngineStatusAutoRefresh(wid);
    },
    { immediate: true },
  );

  watch(
    () => config.connected,
    (connected) => {
      if (connected && settingsOpen.value && router.currentRoute.value.name === "landing") {
        settingsActiveTab.value = defaultSettingsTab();
      }
    },
  );

  watch(
    () => [
      config.connected,
      config.localRuntimeReady,
      config.desktopCloudAccountLinked,
      config.desktopClient?.clientId ?? "",
      config.workspaceId,
      presence.online.onlineClients
        .map((client) => `${client.clientId}:${[...client.workspaceIds].sort().join(",")}`)
        .sort()
        .join("|"),
    ] as const,
    ([connected]) => {
      const localClientId = String(config.desktopClient?.clientId ?? "").trim();
      const localTerminalMode = isLocalDesktopTerminalMode(config, String(config.workspaceId ?? ""));
      const onlineClientIds = presence.online.onlineClients.map((client) => client.clientId);
      if (config.localRuntimeReady && localClientId && !onlineClientIds.includes(localClientId)) onlineClientIds.push(localClientId);
      terminalStore.syncOnlineClients(onlineClientIds);
      if (terminalListTimeout) {
        clearTimeout(terminalListTimeout);
        terminalListTimeout = null;
      }
      if (!connected && !localTerminalMode) {
        if (terminalStore.listRequestId) terminalStore.failListAll(terminalStore.listRequestId, "终端列表连接已断开");
        return;
      }
      const requestId = `terminal-list-all-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      terminalStore.beginListAll(requestId);
      if (!ws.sendTerminal({ t: "terminal.listAll", requestId })) {
        terminalStore.failListAll(requestId, "终端列表请求发送失败：WebSocket 未连接");
        return;
      }
      terminalListTimeout = setTimeout(() => {
        terminalStore.failListAll(requestId, "终端列表请求超时");
        terminalListTimeout = null;
      }, 10_000);
    },
    { immediate: true },
  );

  watch(
    () => [
      workspaces.loading,
      workspaces.lastLoadedAt,
      workspaces.workspaces
        .filter((workspace) => workspace.kind !== "shared" && !workspace.shared)
        .map((workspace) => `${String(workspace.ownerClientId ?? "").trim()}\u0000${String(workspace.id)}`)
        .sort()
        .join("|"),
    ] as const,
    () => {
      if (workspaces.loading || workspaces.lastLoadedAt <= 0) return;
      const localWorkspaces = workspaces.workspaces.filter((workspace) => workspace.kind !== "shared" && !workspace.shared);
      if (localWorkspaces.some((workspace) => !String(workspace.ownerClientId ?? "").trim())) return;
      terminalStore.reconcileKnownTargets(localWorkspaces.map((workspace) => ({
        clientId: String(workspace.ownerClientId).trim(),
        workspaceId: String(workspace.id),
      })));
    },
    { immediate: true },
  );

  watch(
    () => config.workspaceId,
    (workspaceId) => {
      if (workspaceId && !isSharedWorkspaceSelection(workspaceId)) {
        const ownerClientId = String(workspaces.byId.get(workspaceId as WorkspaceId)?.ownerClientId ?? "").trim();
        terminalStore.restoreWorkspaceActiveTerminal(workspaceId, ownerClientId || undefined);
      }
    },
  );

  watch(
    () => [
      currentAuthScopeKey(),
      config.serverWsOrigin,
      config.authMode,
      config.userSummary?.userId ?? null,
    ] as const,
    ([nextAuthScope, nextOrigin, nextAuthMode, nextUserId], [prevAuthScope, prevOrigin, prevAuthMode, prevUserId]) => {
      const prevSnapshot = `${String(prevOrigin ?? "").trim()}::${String(prevAuthScope ?? "").trim()}`;
      const nextSnapshot = `${String(nextOrigin ?? "").trim()}::${String(nextAuthScope ?? "").trim()}`;
      if (prevSnapshot === nextSnapshot) return;
      if (!prevSnapshot.trim()) return;
      const prevAuthenticatedUserId = prevAuthMode === "account" ? String(prevUserId ?? "").trim() : "";
      const nextAuthenticatedUserId = nextAuthMode === "account" ? String(nextUserId ?? "").trim() : "";
      const isAnonymousToAccountLogin =
        !prevAuthenticatedUserId
        && Boolean(nextAuthenticatedUserId)
        && String(prevOrigin ?? "").trim() === String(nextOrigin ?? "").trim();
      if (isAnonymousToAccountLogin) {
        return;
      }

      if (config.connected || config.connectionStatus === "connecting" || config.connectionStatus === "reconnecting") {
        disconnect();
        return;
      }

      resetAllStores("disconnect");
      if (router.currentRoute.value.name === "admin") {
        void router.push("/chat");
      }
    },
  );

  watch(
    () => config.loginWarning,
    (warning) => {
      if (warning) message.warning(warning);
    },
  );

  /** 桌面端本机就绪且未登录时自动提示一次；用户勾选“不再提醒”后不再弹出。 */
  watch(
    () => [config.isDesktop, config.localRuntimeReady, config.authMode, config.hasActiveSession, config.desktopCloudAccountLinked] as const,
    ([isDesktop, ready, authMode, activeSession, cloudLinked]) => {
      if (!isDesktop || !ready || desktopLoginPromptScheduled || desktopAuthModalOpen.value) return;
      if ((authMode === "account" && activeSession) || cloudLinked) return;
      if (isDesktopLoginPromptDismissed()) return;
      desktopLoginPromptScheduled = true;
      window.setTimeout(() => {
        const signedIn = (config.authMode === "account" && config.hasActiveSession) || config.desktopCloudAccountLinked;
        if (desktopAuthModalOpen.value || signedIn) return;
        if (!isDesktopLoginPromptDismissed()) desktopAuthModalOpen.value = true;
      }, 600);
    },
    { immediate: true },
  );

  watch(
    () => [config.authMode, config.userSummary, config.sessionToken, config.sessionExpiresAt] as const,
    ([authMode, userSummary, sessionToken, sessionExpiresAt]) => {
      if (authMode !== "account") return;
      const sessionValid = Boolean(sessionToken && sessionExpiresAt && sessionExpiresAt > Date.now());
      if (userSummary && sessionValid) return;
      const routeName = String(router.currentRoute.value.name ?? "");
      if (!routeName.startsWith("auth-")) {
        void pushLoginRoute();
      }
    },
  );

  return reactive({
    mode,
    ctx,
    router,
    ws,
    config,
    chat,
    composer,
    engine,
    presence,
    reminders,
    sharedWorkspaces,
    terminalStore,
    ui,
    workspaces,
    explorer,
    admin,
    account,
    connectError,
    desktopStartupComplete,
    workspaceSwitching,
    clientUpgradeOpen,
    clientManagementOpen,
    settingsOpen,
    feedbackOpen,
    feedbackSource,
    desktopAuthModalOpen,
    settingsActiveTab,
    terminalOpen,
    explorerOpen,
    workspaceManagerOpen,
    canUseTerminal,
    maxPreviewZ,
    connectionLabel,
    connectionTagColor,
    desktopAccountFailureDescription,
    syncDesktopAccount,
    isMobileModalViewport,
    isLandingRoute,
    isOnboardingRoute,
    isPaymentVerificationRoute,
    currentWorkspace,
    antdTheme,
    connect,
    disconnect,
    logout,
    pushLoginRoute,
    openDesktopAuthModal,
    closeDesktopAuthModal,
    previewWindowFileName,
    openSettingsOrWizard,
    openTerminal,
  });
}

export type AppShellBindings = ReturnType<typeof useAppShell>;
