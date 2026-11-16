import { computed, onScopeDispose, watch } from "vue";
import type { WorkspaceId } from "@codeflowai/shared";

import { trackProductEvent } from "../../../analytics/analytics";
import { createCancelledRequestError } from "../../../api/request";
import { useApiContext } from "../../../composables/useApiContext";
import {
  BUILT_IN_RELAY_AUTO_ENABLE_PROVIDER_ID,
  buildBuiltInRelayAutoEnableFailureNotice,
  buildBuiltInRelayAutoEnableSuccessNotice,
  hasBuiltInRelayAutoEnableAttempted,
  isBuiltInRelayAutoEnableRetryableError,
  isBuiltInRelayReadyForProvider,
  markBuiltInRelayAutoEnableAttempted,
  resolveBuiltInRelayAutoEnableEnvironment,
  resolveBuiltInRelayAutoEnableMarkerKey,
  resolveBuiltInRelayAutoEnablePrecheck,
  resolveBuiltInRelayAutoEnableScopeKey,
  runBuiltInRelayAutoEnable,
  useBuiltInRelayAutoEnableStore,
  type BuiltInRelayAutoEnablePrecheckInput,
  type BuiltInRelayAutoEnableRunResult,
} from "../../../store/builtInRelayAutoEnable";
import { useConfigStore } from "../../../store/config";
import { useEngineKeysStore } from "../../../store/engineKeys";
import { usePresenceStore } from "../../../store/presence";
import { useUiStore } from "../../../store/ui";
import { useWorkspacesStore } from "../../../store/workspaces";
import { isSharedWorkspaceSummary } from "../../../utils/workspaceId";
import { CODEX_RELAY_TARGET, useBuiltInRelayKey } from "./useBuiltInRelayKey";

/** 回前台后重新评估的最小间隔，避免来回切页时重复探测。 */
const REVISIT_EVALUATE_INTERVAL_MS = 5 * 60 * 1000;
/** Key 列表并发刷新竞态的单次重试等待。 */
const TRANSIENT_RETRY_DELAY_MS = 600;

export type BuiltInRelayAutoEnableOptions = {
  /** 官网/文档等公开视图清单，用于把"自动启用"限制在应用内。 */
  publicMainViews: ReadonlySet<string>;
};

/**
 * 首次装完 Client 并正常启动后，自动启用一次内置中转 Key（Codex）。
 * 前置条件不满足时只等待、不消耗一次性机会；真正发起写请求才消耗，失败不回滚不重试。
 */
export function useBuiltInRelayAutoEnable(options: BuiltInRelayAutoEnableOptions): void {
  const config = useConfigStore();
  const ui = useUiStore();
  const presence = usePresenceStore();
  const workspaces = useWorkspacesStore();
  const engineKeys = useEngineKeysStore();
  const notices = useBuiltInRelayAutoEnableStore();
  const { ctx } = useApiContext();
  const builtInRelay = useBuiltInRelayKey();

  const workspaceId = computed(() => String(config.workspaceId ?? "").trim());
  const runtimeState = computed(() => presence.runtimeStateForWorkspace(workspaceId.value));
  const scopeSnapshot = computed(() => engineKeys.scopeSnapshotForWorkspace(workspaceId.value));
  const hasActiveKey = computed(() => scopeSnapshot.value.keys.some((key) => key.isActive));
  const hasTargetRelayKey = computed(() => Boolean(builtInRelay.findBuiltInRelayKey(CODEX_RELAY_TARGET, workspaceId.value)));
  const isPublicView = computed(() => options.publicMainViews.has(ui.mainView));
  const workspaceKind = computed<"local" | "shared" | "unknown">(() => {
    const workspace = workspaceId.value ? workspaces.byId.get(workspaceId.value as WorkspaceId) ?? null : null;
    if (!workspace) return "unknown";
    return isSharedWorkspaceSummary(workspace) ? "shared" : "local";
  });

  let activeRunScopeKey: string | null = null;
  let disposed = false;
  let lastRevisitEvaluateAt = 0;

  /** 汇总当前前置条件输入；只读 store 原始值，不产生副作用。 */
  function buildPrecheckInput(): BuiltInRelayAutoEnablePrecheckInput {
    return {
      isPublicView: isPublicView.value,
      isAccountSession: config.authMode === "account",
      hasActiveSession: config.hasActiveSession,
      logoutInProgress: config.logoutInProgress,
      connected: config.connected,
      isDesktop: config.isDesktop,
      desktopCloudAccountLinked: config.desktopCloudAccountLinked,
      workspaceId: workspaceId.value,
      workspaceKind: workspaceKind.value,
      clientStatus: runtimeState.value.kind === "local" ? runtimeState.value.status : "offline",
      keysPhase: scopeSnapshot.value.phase,
      hasActiveKey: hasActiveKey.value,
      hasTargetRelayKey: hasTargetRelayKey.value,
    };
  }

  function buildMarkerInput() {
    return {
      serverWsOrigin: config.serverWsOrigin,
      userId: String(config.userSummary?.userId ?? ""),
      workspaceId: workspaceId.value,
      providerId: BUILT_IN_RELAY_AUTO_ENABLE_PROVIDER_ID,
    };
  }

  function resolveScopeKey(): string | null {
    return resolveBuiltInRelayAutoEnableScopeKey({
      serverWsOrigin: config.serverWsOrigin,
      userId: config.userSummary?.userId,
      workspaceId: workspaceId.value,
    });
  }

  function reportOutcome(result: BuiltInRelayAutoEnableRunResult, scopeKey: string): void {
    if (result.outcome === "issued") {
      notices.publishNotice(scopeKey, buildBuiltInRelayAutoEnableSuccessNotice());
      trackProductEvent("built_in_relay_auto_enable", { status: "success", source: "auto", engine: "codex" });
      return;
    }
    if (result.outcome === "failed") {
      notices.publishNotice(scopeKey, buildBuiltInRelayAutoEnableFailureNotice(result.failure?.message ?? ""));
      console.error("[BUILT_IN_RELAY_AUTO_ENABLE_FAILED]", {
        code: "BUILT_IN_RELAY_AUTO_ENABLE_FAILED",
        workspaceId: workspaceId.value,
        errorCodeGroup: result.failure?.codeGroup ?? "request_error",
        keysPhase: scopeSnapshot.value.phase,
        cause: result.failure?.message ?? "",
      });
      trackProductEvent("built_in_relay_auto_enable", {
        status: "failed",
        source: "auto",
        engine: "codex",
        error_code_group: result.failure?.codeGroup ?? "request_error",
      });
    }
  }

  /**
   * 发起启用；Key 列表并发刷新属瞬时竞态，同一次尝试内重试一次，
   * 避免把唯一机会浪费在自身刷新竞态上（其他失败不做任何重试）。
   * 返回 null 表示 sync 因作用域变化静默放弃，此时绝不算成功。
   */
  async function issueEnableWithBoundedRetry(runWorkspaceId: string, shouldApply: () => boolean): Promise<unknown> {
    if (config.isDesktop) return await builtInRelay.syncBuiltInRelayKey(CODEX_RELAY_TARGET, runWorkspaceId, shouldApply, { intent: "auto" });
    try {
      return await builtInRelay.syncBuiltInRelayKey(CODEX_RELAY_TARGET, runWorkspaceId, shouldApply);
    } catch (error) {
      if (!isBuiltInRelayAutoEnableRetryableError(error)) throw error;
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS); });
    if (!shouldApply()) throw createCancelledRequestError("scope-change");
    return await builtInRelay.syncBuiltInRelayKey(CODEX_RELAY_TARGET, runWorkspaceId, shouldApply);
  }

  /**
   * 评估一次；只有环境、内置中转就绪与 Key 状态全部通过才会消耗那一次机会。
   * 环境未就绪时只等待，不探测也不刷新 Key 列表。
   *
   * 已知边界：不做跨标签页互斥。同账号、同工作区、0 会话且有 active Key 时同时开多个页签，
   * 最坏多写一行同名内置中转 Key（可一键删除，无数据损坏与级联影响）；触发窗口很窄，
   * 本轮接受，不引入 navigator.locks 等新机制。
   */
  async function evaluate(): Promise<void> {
    if (disposed) return;
    const scopeKey = resolveScopeKey();
    // 同一作用域已有启用流程在飞时不再介入：否则本链路自己的刷新会把流程内部的 Key 列表刷新顶掉。
    if (scopeKey && activeRunScopeKey === scopeKey) return;
    if (resolveBuiltInRelayAutoEnableEnvironment(buildPrecheckInput()).status !== "ready") return;
    if (!scopeKey) return;
    const markerInput = buildMarkerInput();
    if (!resolveBuiltInRelayAutoEnableMarkerKey(markerInput) || hasBuiltInRelayAutoEnableAttempted(markerInput)) return;

    const runWorkspaceId = workspaceId.value;
    const runSessionToken = config.sessionToken;
    const runGeneration = config.desktopCloudAccount?.generation;
    const runContext = { ...ctx.value };
    const shouldApply = () => !disposed
      && workspaceId.value === runWorkspaceId
      && resolveScopeKey() === scopeKey
      && config.sessionToken === runSessionToken
      && (!config.isDesktop || config.desktopCloudAccount?.generation === runGeneration)
      && (config.isDesktop ? config.desktopCloudAccountLinked : config.connected)
      && !config.logoutInProgress;
    activeRunScopeKey = scopeKey;
    try {
      const result = await runBuiltInRelayAutoEnable({
        readAttempted: () => hasBuiltInRelayAutoEnableAttempted(markerInput),
        markAttempted: () => markBuiltInRelayAutoEnableAttempted(markerInput),
        probeRelayReady: async () => {
          const availability = await builtInRelay.getBuiltInRelayAvailability();
          return isBuiltInRelayReadyForProvider(availability, BUILT_IN_RELAY_AUTO_ENABLE_PROVIDER_ID);
        },
        prepareKeys: async () => {
          if (scopeSnapshot.value.phase === "success") return;
          await engineKeys.refresh(runContext, runWorkspaceId, shouldApply);
        },
        issueEnable: async () => {
          const written = await issueEnableWithBoundedRetry(runWorkspaceId, shouldApply);
          if (written) return;
          // sync 返回 null 有两种来源，用同一个 shouldApply 区分（不要一律当失败，否则会留下消不掉的假失败卡）：
          // 仍为真 → 写已落库、只是本地列表被并发刷新顶掉读不回，按成功收敛并留可观测日志；
          // 已变假 → 作用域变化主动放弃本轮，静默取消。
          if (!shouldApply()) throw createCancelledRequestError("scope-change");
          console.warn("[BUILT_IN_RELAY_AUTO_ENABLE_KEY_UNLISTED]", {
            workspaceId: runWorkspaceId,
            providerId: BUILT_IN_RELAY_AUTO_ENABLE_PROVIDER_ID,
            keysPhase: scopeSnapshot.value.phase,
          });
        },
        shouldApply,
        recheckPrecheck: () => shouldApply() && resolveBuiltInRelayAutoEnablePrecheck(buildPrecheckInput()).status === "ready",
      });
      // 本轮结论只对当轮作用域有效：切换工作区后不再往旧工作区的 Key 面板塞提示。
      if (!shouldApply()) return;
      reportOutcome(result, scopeKey);
    } finally {
      if (activeRunScopeKey === scopeKey) activeRunScopeKey = null;
    }
  }

  /** 回前台时重新评估：管理员事后开启内置中转时，用户切回页面即可生效。 */
  function onVisibilityChange(): void {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastRevisitEvaluateAt < REVISIT_EVALUATE_INTERVAL_MS) return;
    lastRevisitEvaluateAt = Date.now();
    void evaluate();
  }

  watch(
    () => [
      isPublicView.value,
      config.authMode,
      config.hasActiveSession,
      config.connected,
      config.sessionToken,
      config.serverWsOrigin,
      config.userSummary?.userId,
      config.desktopCloudAccount?.generation,
      config.desktopCloudAccountLinked,
      config.logoutInProgress,
      workspaceId.value,
      workspaceKind.value,
      runtimeState.value.status,
      scopeSnapshot.value.phase,
      hasActiveKey.value,
      engineKeys.lastUpdatedAt,
    ] as const,
    () => { void evaluate(); },
    { immediate: true, flush: "post" },
  );

  document.addEventListener("visibilitychange", onVisibilityChange);
  onScopeDispose(() => {
    disposed = true;
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });
}
