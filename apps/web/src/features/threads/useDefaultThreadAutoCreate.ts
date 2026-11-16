import { computed, onScopeDispose, watch } from "vue";
import { message } from "ant-design-vue";
import { useRoute } from "vue-router";
import type { EngineType, ThreadId, WorkspaceId } from "@codeflowai/shared";

import { trackProductEvent } from "../../analytics/analytics";
import { createCancelledRequestError, type AbortKind } from "../../api/request";
import { listThreads } from "../../api/threads";
import { useApiContext } from "../../composables/useApiContext";
import { useViewport } from "../../composables/useViewport";
import { useChatStore } from "../../store/chat";
import { useConfigStore } from "../../store/config";
import {
  DEFAULT_THREAD_AUTO_CREATE_STORAGE_PREFIX,
  DEFAULT_THREAD_AUTO_CREATE_TITLE,
  clearDefaultThreadAutoCreateAttemptCache,
  hasDefaultThreadAutoCreateAttempted,
  markDefaultThreadAutoCreateAttempted,
  resolveDefaultThreadAutoCreateEnvironment,
  resolveDefaultThreadAutoCreateMarkerKey,
  resolveDefaultThreadAutoCreatePrecheck,
  runDefaultThreadAutoCreate,
  shouldLogDefaultThreadAutoCreateWait,
  type DefaultThreadAutoCreateEnvironmentInput,
  type DefaultThreadAutoCreatePrecheckInput,
  type DefaultThreadAutoCreatePrecheckResult,
  type DefaultThreadAutoCreateRunResult,
  type DefaultThreadAutoCreateWaitLogState,
} from "../../store/defaultThreadAutoCreate";
import { useEngineKeysStore } from "../../store/engineKeys";
import { useEngineStore } from "../../store/engine";
import { usePresenceStore } from "../../store/presence";
import { useUiStore } from "../../store/ui";
import { useWorkspacesStore } from "../../store/workspaces";
import { isPrimaryThreadRoute } from "./primary-thread-selection";
import { useCreateThreadEngineAvailability } from "./useCreateThreadEngineAvailability";
import { isSharedWorkspaceSummary } from "../../utils/workspaceId";
import { isDesktopWorkspace } from "../../services/desktop";

/** 回前台后重新评估的最小间隔，避免来回切页时重复探测。 */
const REVISIT_EVALUATE_INTERVAL_MS = 5 * 60 * 1000;
/** 探测"是否已有可见会话"只取一条，避免拉整页列表。 */
const PROBE_THREADS_LIMIT = 1;

export type DefaultThreadAutoCreateOptions = {
  /** 官网/文档等公开视图清单，用于把"自动创建"限制在应用内。 */
  publicMainViews: ReadonlySet<string>;
};

/** 在飞 run 的作用域快照：用于取消探测请求与判定本轮是否仍然有效。 */
type DefaultThreadAutoCreateRun = { scopeKey: string; workspaceId: string; controller: AbortController };

/**
 * 为没有会话的本地工作区自动创建一次「默认会话」，创建后选中并打开。
 * 前置条件与"是否已有会话"都不满足时只等待、不消耗一次性机会；真正发起创建才消耗，失败不回滚不重试。
 */
export function useDefaultThreadAutoCreate(options: DefaultThreadAutoCreateOptions): void {
  const chat = useChatStore();
  const config = useConfigStore();
  const engineKeys = useEngineKeysStore();
  const engines = useEngineStore();
  const presence = usePresenceStore();
  const ui = useUiStore();
  const workspaces = useWorkspacesStore();
  const { ctx } = useApiContext();
  const { mode } = useViewport();
  const route = useRoute();
  const workspaceId = computed(() => String(config.workspaceId ?? "").trim());
  const localReady = computed(() => isDesktopWorkspace(config, workspaceId.value));
  const engineAvailability = useCreateThreadEngineAvailability(workspaceId);
  const runtimeState = computed(() => presence.runtimeStateForWorkspace(workspaceId.value));
  const scopeSnapshot = computed(() => engineKeys.scopeSnapshotForWorkspace(workspaceId.value));
  const workspaceActivation = computed(() => chat.workspaceActivation);
  const isPublicView = computed(() => options.publicMainViews.has(ui.mainView));
  const workspaceKind = computed<"local" | "shared" | "unknown">(() => {
    const workspace = workspaceId.value ? workspaces.byId.get(workspaceId.value as WorkspaceId) ?? null : null;
    if (!workspace) return "unknown";
    return isSharedWorkspaceSummary(workspace) ? "shared" : "local";
  });
  /**
   * 各引擎启用中的 Key 供应商。providerIdsForEngine 读的是 engineKeys 当前作用域投影，
   * 与新建会话弹窗口径一致；prepareAvailability 刷新后即与目标工作区对齐。
   */
  const activeProviderIdsByEngine = computed<Record<EngineType, string[]>>(() => ({
    codex: engineKeys.providerIdsForEngine("codex"),
    claude: engineKeys.providerIdsForEngine("claude"),
  }));
  /** 启用中 Key 集合签名：内置中转自动启用会写 Key，此处用它唤醒本次评估。 */
  const activeProviderSignature = computed(() => (
    `${activeProviderIdsByEngine.value.codex.join(",")}|${activeProviderIdsByEngine.value.claude.join(",")}`
  ));
  /** 引擎禁用原因签名：避免直接 watch computed 对象导致逐次引用变化。 */
  const disabledEngineSignature = computed(() => {
    const disabled = engineAvailability.disabledEngines.value;
    return `${disabled.codex ?? ""}|${disabled.claude ?? ""}`;
  });

  let activeRun: DefaultThreadAutoCreateRun | null = null;
  let disposed = false;
  let lastRevisitEvaluateAt = 0;
  let lastWaitLog: DefaultThreadAutoCreateWaitLogState = null;

  /**
   * 记录"为什么没建默认会话"。等待此前完全静默，线上只能靠猜；同一原因按窗口节流，
   * 附带诊断维度（Client 状态、工作区阶段、Key 阶段、启用中的 Key 签名）便于直接定位卡点。
   */
  function logWaitReason(reason: string, stage: "environment" | "precheck"): void {
    const now = Date.now();
    const currentWorkspaceId = workspaceId.value;
    if (!shouldLogDefaultThreadAutoCreateWait(lastWaitLog, reason, currentWorkspaceId, now)) return;
    lastWaitLog = { reason, workspaceId: currentWorkspaceId, at: now };
    console.info("[DEFAULT_THREAD_AUTO_CREATE_WAIT]", {
      workspaceId: workspaceId.value,
      stage,
      reason,
      clientStatus: runtimeState.value.kind === "local" ? runtimeState.value.status : "offline",
      workspaceKind: workspaceKind.value,
      workspacePhase: workspaceActivation.value.phase,
      workspaceDegraded: workspaceActivation.value.degraded,
      keysPhase: scopeSnapshot.value.phase,
      activeProviderSignature: activeProviderSignature.value,
      disabledEngines: engineAvailability.disabledEngines.value,
    });
  }

  /** 在飞 run 是否仍属当前作用域：工作区未变、未登出、组件未卸载。 */
  function isRunScopeValid(run: DefaultThreadAutoCreateRun): boolean {
    return !disposed
      && workspaceId.value === run.workspaceId
      && (config.connected || localReady.value)
      && !config.logoutInProgress;
  }

  /** 取消在飞 run 的探测请求；kind 决定接口层记录的取消原因。 */
  function abortActiveRun(kind: AbortKind): void {
    activeRun?.controller.abort(createCancelledRequestError(kind));
  }

  /** 汇总当前前置条件输入；只读 store 原始值，不产生副作用。 */
  function buildPrecheckInput(): DefaultThreadAutoCreatePrecheckInput {
    const activation = workspaceActivation.value;
    const environment: DefaultThreadAutoCreateEnvironmentInput = {
      isPublicView: isPublicView.value,
      isAccountSession: config.authMode === "account",
      hasActiveSession: config.hasActiveSession,
      logoutInProgress: config.logoutInProgress,
      connected: config.connected,
      localReady: localReady.value,
      workspaceId: workspaceId.value,
      workspaceKind: workspaceKind.value,
      clientStatus: runtimeState.value.kind === "local" ? runtimeState.value.status : "offline",
      workspacePhase: activation.phase,
      activatedWorkspaceId: activation.workspaceId,
      workspaceDegraded: activation.degraded,
    };
    return {
      ...environment,
      keysPhase: scopeSnapshot.value.phase,
      activeProviderIdsByEngine: activeProviderIdsByEngine.value,
      disabledEngines: engineAvailability.disabledEngines.value,
    };
  }

  /** 本机机会归属当前 Client；账号标记仍归属真实云端身份。 */
  function buildMarkerInput() {
    return {
      serverWsOrigin: config.serverWsOrigin,
      userId: String(config.userSummary?.userId ?? ""),
      workspaceId: workspaceId.value,
      desktopClientId: localReady.value ? config.desktopClient?.clientId : null,
    };
  }

  /** 只读探测当前工作区是否已有用户可见会话；固定查询口径，不写 chat 列表状态。 */
  async function probeHasVisibleThreads(runWorkspaceId: string, signal: AbortSignal): Promise<boolean> {
    const res = await listThreads(ctx.value, runWorkspaceId as WorkspaceId, {
      scope: "current",
      sort: "activity_desc",
      limit: PROBE_THREADS_LIMIT,
    }, { signal });
    if (!res.ok) throw new Error(res.message);
    return res.threads.length > 0;
  }

  /**
   * 自动链路专用的可用性刷新：刷新 Host Client 引擎状态与本地 Key 列表。
   * 与新建弹窗的 refreshEngineAvailability 不同，这里不弹用户可见提示——后台重试链路
   * 反复弹提示属于打扰；失败按"未就绪"等待（不消耗机会），诊断走带标识的 console.warn。
   */
  async function prepareAvailability(runWorkspaceId: string): Promise<void> {
    try {
      await engines.refresh(ctx.value, runWorkspaceId);
      const scopedEngineState = engines.byWorkspaceId[runWorkspaceId];
      if (scopedEngineState?.lastError) throw new Error(`无法读取引擎状态：${scopedEngineState.lastError}`);
      // 必须每次都拉取：Key 可能在别处被启用/停用，用旧快照会把"待就绪"误判成"无可用引擎"。
      await engineKeys.refresh(ctx.value, runWorkspaceId);
    } catch (error) {
      console.warn("[DEFAULT_THREAD_AUTO_CREATE_PREPARE_FAILED]", {
        workspaceId: runWorkspaceId,
        cause: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** 仅选中并打开本次自己创建的会话，绝不改选"列表第一条"。 */
  function openCreatedThread(threadId: ThreadId): void {
    if (chat.selectedThreadId != null) return;
    const routeMode = isPrimaryThreadRoute(route.name) && mode.value !== "mobile" ? "replace" : "ignore";
    chat.selectPrimaryThread(threadId, { route: routeMode });
  }

  /** 上报本次结果；runWorkspaceId 是本轮实际生效的工作区，不用可能已切换的当前值。 */
  function reportOutcome(result: DefaultThreadAutoCreateRunResult, runWorkspaceId: string): void {
    if (result.outcome === "created") {
      trackProductEvent("default_thread_auto_create", {
        status: "success",
        source: "auto",
        engine: result.engine,
        thread_type: "chat",
      });
      return;
    }
    if (result.outcome === "interrupted") {
      // 取消发生在 createThread 尾部的列表刷新上：服务端可能已建好，只是拿不到 id。
      console.warn("[DEFAULT_THREAD_AUTO_CREATE_INTERRUPTED]", {
        workspaceId: runWorkspaceId,
        engine: result.engine,
      });
      message.info("默认会话可能已创建，请在会话列表中确认");
      trackProductEvent("default_thread_auto_create", {
        status: "failed",
        source: "auto",
        engine: result.engine,
        thread_type: "chat",
        error_code_group: "create_interrupted",
      });
      // 自愈：让列表把可能已落库的会话拉回来。失败只记录，不改变上面已告知用户的结论。
      void chat.refreshThreads(ctx.value, runWorkspaceId as WorkspaceId).catch((error) => {
        console.warn("[DEFAULT_THREAD_AUTO_CREATE_REFRESH_FAILED]", {
          workspaceId: runWorkspaceId,
          cause: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (result.outcome === "failed") {
      const codeGroup = result.failure.codeGroup;
      message.warning(`自动创建默认会话失败：${result.failure.message}。本次机会已使用，可在会话列表手动新建。`);
      console.error("[DEFAULT_THREAD_AUTO_CREATE_FAILED]", {
        code: "DEFAULT_THREAD_AUTO_CREATE_FAILED",
        workspaceId: runWorkspaceId,
        engine: result.engine,
        errorCodeGroup: codeGroup,
        keysPhase: scopeSnapshot.value.phase,
        cause: result.failure.message,
      });
      trackProductEvent("default_thread_auto_create", {
        status: "failed",
        source: "auto",
        engine: result.engine,
        thread_type: "chat",
        error_code_group: codeGroup,
      });
    }
  }

  /**
   * 评估一次；环境、Key 状态与"是否已有会话"全部通过才会消耗那一次机会。
   *
   * 已知边界：不做跨标签页互斥。同账号、同工作区、0 会话且有 active Key 时同时开多个页签，
   * 最坏各创建一个「默认会话」——会话表无唯一约束，多出的记录可一键删除，无数据损坏与级联影响；
   * 触发窗口很窄，本轮接受，不引入 navigator.locks 等新机制。
   */
  async function evaluate(): Promise<void> {
    if (disposed) return;
    const scopeKey = resolveDefaultThreadAutoCreateMarkerKey(buildMarkerInput());
    // 同一作用域已有流程在飞时不再介入：避免重复探测与重复创建。
    if (scopeKey && activeRun?.scopeKey === scopeKey) return;
    const environment = resolveDefaultThreadAutoCreateEnvironment(buildPrecheckInput());
    if (environment.status !== "ready") {
      logWaitReason(environment.reason, "environment");
      return;
    }
    if (!scopeKey) return;
    const markerInput = buildMarkerInput();
    if (hasDefaultThreadAutoCreateAttempted(markerInput)) {
      logWaitReason("already-attempted", "environment");
      return;
    }

    const runWorkspaceId = workspaceId.value;
    const run: DefaultThreadAutoCreateRun = { scopeKey, workspaceId: runWorkspaceId, controller: new AbortController() };
    const shouldApply = () => isRunScopeValid(run);
    activeRun = run;
    try {
      const result = await runDefaultThreadAutoCreate({
        readAttempted: () => hasDefaultThreadAutoCreateAttempted(markerInput),
        // shouldApply 为假时短路为"等待"，由外层统一处理。
        environment: () => (shouldApply()
          ? resolveDefaultThreadAutoCreateEnvironment(buildPrecheckInput())
          : { status: "wait", reason: "workspace-not-settled" }),
        precheck: (): DefaultThreadAutoCreatePrecheckResult => (shouldApply()
          ? resolveDefaultThreadAutoCreatePrecheck(buildPrecheckInput())
          : { status: "wait", reason: "workspace-not-settled" }),
        shouldApply,
        prepareAvailability: () => prepareAvailability(runWorkspaceId),
        probeHasVisibleThreads: () => probeHasVisibleThreads(runWorkspaceId, run.controller.signal),
        markAttempted: () => markDefaultThreadAutoCreateAttempted(markerInput),
        createThread: (engine) => chat.createThread(ctx.value, {
          workspaceId: runWorkspaceId as WorkspaceId,
          engine,
          title: DEFAULT_THREAD_AUTO_CREATE_TITLE,
          groupId: null,
        }),
      });
      // 本轮结论只对当轮作用域有效：切换工作区后不再弹旧工作区的提示与埋点。
      if (!shouldApply()) return;
      // 编排层每条等待路径都带原因（scope-changed / prepare-failed / probe-failed 等），类型上已强制。
      if (result.outcome === "wait") logWaitReason(result.reason, "precheck");
      reportOutcome(result, runWorkspaceId);
      if (result.outcome === "created") openCreatedThread(result.threadId);
    } finally {
      if (activeRun === run) activeRun = null;
    }
  }

  /** 回前台时重新评估：装完 Client、启用 Key 或后端恢复后，用户切回页面即可生效。 */
  function onVisibilityChange(): void {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastRevisitEvaluateAt < REVISIT_EVALUATE_INTERVAL_MS) return;
    lastRevisitEvaluateAt = Date.now();
    void evaluate();
  }

  /** 其他标签页写入过标记时，丢掉本标签页的内存兜底，避免重复创建。 */
  function onStorageChange(event: StorageEvent): void {
    if (!event.key || !event.key.startsWith(`${DEFAULT_THREAD_AUTO_CREATE_STORAGE_PREFIX}::`)) return;
    clearDefaultThreadAutoCreateAttemptCache();
  }

  /**
   * 触发源只保留"外部变化"：刻意不监听 engineKeys 的 phase / lastUpdatedAt——
   * 这两个值会被本链路自己的 prepareAvailability 改写（loading→success、lastUpdatedAt=now），
   * 一旦监听就会"刷新→再评估→再刷新"自我触发；而真正需要被唤醒的信号是
   * "启用中的 Key 集合变了"（activeProviderSignature），已单独覆盖。
   */
  watch(
    () => [
      isPublicView.value,
      config.authMode,
      config.hasActiveSession,
      config.connected,
      localReady.value,
      config.logoutInProgress,
      workspaceId.value,
      workspaceKind.value,
      runtimeState.value.status,
      workspaceActivation.value.workspaceId,
      workspaceActivation.value.phase,
      workspaceActivation.value.degraded,
      activeProviderSignature.value,
      disabledEngineSignature.value,
    ] as const,
    () => {
      // 作用域已变化时立即取消在飞探测，不等它自己结束（探测结果对新作用域已无意义）。
      if (activeRun && !isRunScopeValid(activeRun)) abortActiveRun("scope-change");
      void evaluate();
    },
    { immediate: true, flush: "post" },
  );

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("storage", onStorageChange);
  onScopeDispose(() => {
    disposed = true;
    abortActiveRun("component-unmount");
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("storage", onStorageChange);
  });
}
