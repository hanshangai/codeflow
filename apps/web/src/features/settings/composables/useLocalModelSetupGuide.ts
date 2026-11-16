import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { normalizeEngineKeyProviderId, type EngineType } from "@codeflowai/shared";

import { isCancelledRequestError } from "../../../api/request";
import { useApiContext } from "../../../composables/useApiContext";
import { isDesktopWorkspace } from "../../../services/desktop";
import { useConfigStore } from "../../../store/config";
import { useEngineStore } from "../../../store/engine";
import { useEngineKeysStore } from "../../../store/engineKeys";
import { usePresenceStore } from "../../../store/presence";
import { useUiStore } from "../../../store/ui";
import { desktopAuthModalOpen } from "../../account/desktopAuthPromptState";
import { shouldShowLocalModelSetupGuide, type LocalModelSetupGuideInput } from "../../composer/localModelSetup";
import { localModelSetupGuideActive, localModelSetupGuideWorkspaceId } from "../localModelSetupGuideState";

const GUIDE_PROMPT_DELAY_MS = 900;

export type LocalModelSetupGuideOptions = {
  publicMainViews: ReadonlySet<string>;
  settingsOpen: Ref<boolean>;
  workspaceSwitching: Ref<boolean>;
  /** 打开设置的大模型 Key 页签；由应用根注入，避免同组件 provide 后 inject 失效。 */
  openSettings: () => void;
  openDesktopAuth: () => void;
};

export type LocalModelSetupGuide = {
  guideOpen: Ref<boolean>;
  dismissGuide: () => void;
  configureGuide: () => void;
  loginGuide: () => void;
};

/**
 * 桌面本机工作区的模型 Key 引导。
 * 启动后主动刷新当前工作区的引擎与 Key 状态，再复用 needsLocalModelSetup 判定；
 * 每次运行最多弹一次，登录或配置 Key 后自动消失。
 */
export function useLocalModelSetupGuide(options: LocalModelSetupGuideOptions): LocalModelSetupGuide {
  const config = useConfigStore();
  const engines = useEngineStore();
  const engineKeys = useEngineKeysStore();
  const presence = usePresenceStore();
  const ui = useUiStore();
  const { ctx } = useApiContext();

  const workspaceId = computed(() => String(config.workspaceId ?? "").trim());
  const localWorkspace = computed(() => config.isDesktop && isDesktopWorkspace(config, workspaceId.value));
  const runtimeStatus = computed(() => {
    const state = presence.runtimeStateForWorkspace(workspaceId.value);
    return state.kind === "local" ? state.status : "offline";
  });
  const publicView = computed(() => options.publicMainViews.has(ui.mainView));
  const scopeKey = computed(() => `${config.desktopClient?.clientId ?? ""}|${workspaceId.value}|${runtimeStatus.value}`);
  const keyScope = computed(() => engineKeys.scopeSnapshotForWorkspace(workspaceId.value));
  const statuses = computed(() => engines.byTypeForWorkspace(workspaceId.value));
  const engineStatusLoading = computed(() => Boolean(engines.byWorkspaceId[workspaceId.value]?.loading));
  const guideOpen = ref(false);
  const stateReady = ref(false);
  let shownThisRun = false;
  let dismissedThisRun = false;
  let promptTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshGeneration = 0;
  let preparedScope = "";
  let disposed = false;

  /** 当前工作区已启用的 Key 供应商；与模型可用性判断共用同一份作用域快照。 */
  function activeProviderIdsFor(engine: EngineType): string[] {
    const ids = new Set<string>();
    for (const key of keyScope.value.keys) {
      if (key.engine !== engine || !key.isActive) continue;
      const providerId = normalizeEngineKeyProviderId(engine, key.providerId);
      if (providerId) ids.add(providerId);
    }
    return [...ids];
  }

  const guideInput = computed<LocalModelSetupGuideInput>(() => ({
    isDesktop: config.isDesktop,
    isDesktopLocalWorkspace: localWorkspace.value,
    publicView: publicView.value,
    settingsOpen: options.settingsOpen.value,
    workspaceSwitching: options.workspaceSwitching.value,
    authModalOpen: desktopAuthModalOpen.value,
    stateReady: stateReady.value,
    localRuntimeReady: config.localRuntimeReady,
    hasActiveSession: config.hasActiveSession,
    desktopCloudAccountLinked: config.desktopCloudAccountLinked,
    keyStoreLoading: keyScope.value.phase !== "success",
    keyStoreError: keyScope.value.lastError,
    engineStatusLoading: engineStatusLoading.value,
    hasKeysByEngine: {
      claude: keyScope.value.keys.some((key) => key.engine === "claude"),
      codex: keyScope.value.keys.some((key) => key.engine === "codex"),
    },
    activeProviderIdsByEngine: {
      claude: activeProviderIdsFor("claude"),
      codex: activeProviderIdsFor("codex"),
    },
    statuses: {
      claude: statuses.value.get("claude"),
      codex: statuses.value.get("codex"),
    },
  }));
  /** 已结算的配置结论；加载期间沿用上一次结论，避免周期刷新让空态和引导反复闪动。 */
  const setupNeeded = ref(false);
  const settledGuideInput = computed<LocalModelSetupGuideInput | null>(() => {
    if (!stateReady.value) return null;
    if (keyScope.value.phase !== "success" || engineStatusLoading.value) return null;
    return {
      ...guideInput.value,
      keyStoreLoading: false,
      engineStatusLoading: false,
      stateReady: true,
      publicView: false,
      settingsOpen: false,
      workspaceSwitching: false,
      authModalOpen: false,
    };
  });
  watch(settledGuideInput, (input) => {
    if (input) setupNeeded.value = shouldShowLocalModelSetupGuide(input);
  }, { immediate: true });
  /** 硬性阻断条件即时生效；加载中的未知态不改写已展示的结论。 */
  const guideActive = computed(() => setupNeeded.value
    && config.isDesktop
    && config.localRuntimeReady
    && localWorkspace.value
    && !publicView.value
    && !options.settingsOpen.value
    && !options.workspaceSwitching.value
    && !desktopAuthModalOpen.value
    && !config.hasActiveSession
    && !config.desktopCloudAccountLinked);

  /** 主动拉取一次引擎与 Key 状态；失败保留未知态并记录可检索日志，不冒充“未配置”。 */
  async function refreshState(): Promise<void> {
    if (disposed) return;
    const scope = scopeKey.value;
    if (preparedScope === scope && stateReady.value) return;
    // 作用域变化后先进入未知态，避免用上一个工作区的快照误判“未配置”。
    stateReady.value = false;
    // 登录态下 needsLocalModelSetup 必然为 false，无需重复探测引擎与 Key。
    if (config.hasActiveSession || config.desktopCloudAccountLinked) return;
    if (!config.isDesktop || !config.localRuntimeReady || !localWorkspace.value || publicView.value) return;
    const runWorkspaceId = workspaceId.value;
    const generation = ++refreshGeneration;
    const isCurrent = () => !disposed && generation === refreshGeneration
      && workspaceId.value === runWorkspaceId && !publicView.value;
    let stage = "engines";
    try {
      await engines.refresh(ctx.value, runWorkspaceId, { shouldApply: isCurrent });
      if (!isCurrent()) return;
      stage = "keys";
      await engineKeys.refresh(ctx.value, runWorkspaceId, isCurrent);
      if (!isCurrent()) return;
      preparedScope = scope;
      stateReady.value = true;
    } catch (error) {
      if (isCancelledRequestError(error)) return;
      preparedScope = "";
      const details = (error as { details?: { requestId?: string; serverRequestId?: string } } | null)?.details;
      console.warn("[LOCAL_MODEL_SETUP_GUIDE_STATE_FAILED]", {
        code: "LOCAL_MODEL_SETUP_GUIDE_STATE_FAILED",
        requestId: details?.requestId ?? details?.serverRequestId ?? null,
        workspaceId: runWorkspaceId,
        stage,
        rootCause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function clearPromptTimer(): void {
    if (promptTimer !== null) clearTimeout(promptTimer);
    promptTimer = null;
  }

  function closeGuide(): void {
    clearPromptTimer();
    guideOpen.value = false;
  }

  /** 条件成立时延迟展示一次，避开启动期登录弹框与首屏渲染。 */
  function schedulePrompt(): void {
    clearPromptTimer();
    if (guideOpen.value || !guideActive.value || shownThisRun || dismissedThisRun) return;
    promptTimer = setTimeout(() => {
      promptTimer = null;
      if (disposed || !guideActive.value || shownThisRun || dismissedThisRun) return;
      shownThisRun = true;
      guideOpen.value = true;
    }, GUIDE_PROMPT_DELAY_MS);
  }

  function dismissGuide(): void {
    dismissedThisRun = true;
    closeGuide();
  }

  function configureGuide(): void {
    dismissedThisRun = true;
    closeGuide();
    options.openSettings();
  }

  function loginGuide(): void {
    dismissedThisRun = true;
    closeGuide();
    options.openDesktopAuth();
  }

  /** 切换工作区时立即隐藏旧结论，等新工作区完成一次结算后再显示。 */
  watch(workspaceId, () => {
    setupNeeded.value = false;
  });

  watch(guideActive, (active) => {
    localModelSetupGuideActive.value = active;
    localModelSetupGuideWorkspaceId.value = active ? workspaceId.value : null;
    if (!active) closeGuide();
    schedulePrompt();
  }, { immediate: true });

  watch([
    scopeKey,
    () => ui.mainView,
    () => config.isDesktop,
    () => config.localRuntimeReady,
    () => config.hasActiveSession,
    () => config.desktopCloudAccountLinked,
  ], () => {
    void refreshState();
  }, { immediate: true, flush: "post" });

  /** 回到前台时补一次刷新，覆盖启动时 Client 尚未就绪的场景。 */
  function handleVisibilityChange(): void {
    if (document.visibilityState === "visible") void refreshState();
  }
  document.addEventListener("visibilitychange", handleVisibilityChange);

  onScopeDispose(() => {
    disposed = true;
    refreshGeneration += 1;
    clearPromptTimer();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    localModelSetupGuideActive.value = false;
    localModelSetupGuideWorkspaceId.value = null;
  });

  return { guideOpen, dismissGuide, configureGuide, loginGuide };
}
