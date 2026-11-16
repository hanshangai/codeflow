import type { InjectionKey } from "vue";
import type {
  ClientPreemptRequest,
  ConversationChangedMessage,
  DesktopApiRequest,
  DesktopEvent,
  EngineEventEnvelope,
  OnlineClientInfo,
  ServerToWebMessage,
  TerminalInfo,
  ThreadId,
  WebToServerMessage,
  WorkspaceId,
} from "@codeflowai/shared";
import { compressConversationEvents, isDesktopTerminalEvent, makeSharedWorkspaceSelectionId, parseSharedWorkspaceSelectionId } from "@codeflowai/shared";

import { createCancelledRequestError, isAuthSessionErrorMessage, isCancelledRequestError, type AbortKind, type ApiRequestContext, wsOriginToHttpOrigin } from "../api/request";
import type { ChatStore } from "../store/chat";
import type { ConfigStore } from "../store/config";
import type { EngineStore } from "../store/engine";
import type { ExplorerStore } from "../store/explorer";
import type { useThreadQueueStore } from "../store/threadQueue";
import type { useEngineKeysStore } from "../store/engineKeys";
import type { useQuickPhrasesStore } from "../store/quickPhrases";
import type { OrchestrationStore } from "../store/orchestration";
import type { PresenceStore } from "../store/presence";
import type { useRequirementAnalysisStore } from "../store/requirementAnalysis";
import type { ReminderStore } from "../store/reminders";
import type { useSharedWorkspacesStore } from "../store/sharedWorkspaces";
import type { TerminalStore } from "../store/terminal";
import type { UiStore } from "../store/ui";
import type { WorkspacesStore } from "../store/workspaces";
import { buildWorkspacesRefreshScopeKey } from "../store/workspaces";
import { isWorkspaceClientOfflineError } from "../utils/clientOfflineNotice";
import { isFileMutationToolName, isWorkspaceMutatingToolName } from "../utils/toolActivity";
import { isSharedWorkspaceSelectionId, resolveStickyWorkspaceSelection, workspaceIdMatchesCurrentSelection, workspaceIdsReferToSameWorkspace, workspaceSubscriptionMatchesSelection } from "../utils/workspaceId";
import { createReminderRefreshCoordinator } from "./reminderRefreshCoordinator";
import { shouldRefreshWorkspacesForPresence } from "./workspaceRefreshPolicy";
import { coalesceLiveConversationEvents } from "./liveConversationEventBatch";
import { getDesktopBridge, isDesktopWorkspace, isLocalDesktopTerminalMode, requestDesktopApi } from "./desktop";

/** Git 状态自动刷新的去抖窗口：同一回合内连续的工具完成只触发一次刷新。 */
const GIT_STATUS_REFRESH_DEBOUNCE_MS = 400;

export type WebSocketClient = ReturnType<typeof createWebSocketClient>;
export const WS_CLIENT_KEY: InjectionKey<WebSocketClient> = Symbol("codeflowai.wsClient");

export function createWebSocketClient(deps: {
  config: ConfigStore;
  chat: ChatStore;
  presence: PresenceStore;
  engine: EngineStore;
  orchestration?: OrchestrationStore;
  requirementAnalysis?: ReturnType<typeof useRequirementAnalysisStore>;
  reminders?: ReminderStore;
  sharedWorkspaces?: ReturnType<typeof useSharedWorkspacesStore>;
  ui?: UiStore;
  workspaces?: WorkspacesStore;
  terminal?: TerminalStore;
  /** 会话内的命令/写文件工具完成后，按需刷新右侧 Git 视图。 */
  explorer?: ExplorerStore;
  threadQueue?: ReturnType<typeof useThreadQueueStore>;
  engineKeys?: ReturnType<typeof useEngineKeysStore>;
  quickPhrases?: ReturnType<typeof useQuickPhrasesStore>;
  onError?: (message: string) => void;
  onClientPreemptRequested?: (req: ClientPreemptRequest) => void;
  onClientPreemptResolved?: (info: { requestId: string; decision: "accepted" | "declined" | "timeout" | "failed" }) => void;
}) {
  let ws: WebSocket | null = null;
  let stopped = true;
  let openingPromise: Promise<void> | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let connectionEpoch = 0;
  let subscriptionEpoch = 0;
  let tenantEpoch = 0;
  let authErrorReported = false;
  let tenantSnapshotKey = "";
  let activeSubscriptionRequestId: string | null = null;
  let lastOnlineClientsSignature = "__init__";
  let currentSubscribedWorkspaceId: WorkspaceId | null = null;
  let localSubscribedWorkspaceId: WorkspaceId | null = null;
  let workspaceSubscriptionWaiter: {
    requestId: string;
    subscriptionEpoch: number;
    resolve: (value: { requestId: string; subscriptionEpoch: number; workspaceId: WorkspaceId | null; bufferedCount: number }) => void;
    reject: (reason?: unknown) => void;
  } | null = null;
  let sharedWorkspaceSubscriptionWaiter: {
    requestId: string;
    subscriptionEpoch: number;
    sharedWorkspaceId: string;
    resolve: (value: { requestId: string; subscriptionEpoch: number; workspaceId: WorkspaceId; sharedWorkspaceId: string; bufferedCount: number }) => void;
    reject: (reason?: unknown) => void;
  } | null = null;

  const engineEventBuffer: EngineEventEnvelope[] = [];
  let engineEventBufferEpoch = 0;
  let engineEventFlushTimer: number | null = null;
  let gitStatusRefreshTimer: number | null = null;
  let treeRefreshPending = false;
  let visibilityRefreshAttached = false;
  let presentationRefreshTimer: number | null = null;
  const presentationChanges = new Map<string, ConversationChangedMessage>();
  const presentationRefreshes = new Set<string>();
  const completedToolSignals = new Map<string, Set<number>>();
  const LIVE_EVENT_BATCH_SIZE = 250;
  const LIVE_EVENT_BUDGET_MS = 8;
  /** 云端连接轮换不清除当前本机已接收的实时尾部。 */
  const clearEngineEventBuffer = (includeLocal = false) => {
    if (localSubscribedWorkspaceId && !includeLocal) return;
    engineEventBufferEpoch++;
    presentationChanges.clear();
    completedToolSignals.clear();
    if (presentationRefreshTimer != null) window.clearTimeout(presentationRefreshTimer);
    presentationRefreshTimer = null;
    engineEventBuffer.splice(0, engineEventBuffer.length);
    if (engineEventFlushTimer != null) {
      window.clearTimeout(engineEventFlushTimer);
      engineEventFlushTimer = null;
    }
  };
  /** 按连续可压缩段消费原始队列；让出期间仍保留未消费事件的 canonical 序号。 */
  const flushEngineEvents = () => {
    engineEventFlushTimer = null;
    if (!engineEventBuffer.length) return;
    const started = performance.now();
    const epoch = engineEventBufferEpoch;
    const limit = Math.min(engineEventBuffer.length, LIVE_EVENT_BATCH_SIZE);
    let consumed = 0;
    try {
      while (epoch === engineEventBufferEpoch && consumed < limit && (consumed === 0 || performance.now() - started < LIVE_EVENT_BUDGET_MS)) {
        let event = engineEventBuffer[consumed++]!;
        const preserveSequences = deps.chat.threadPresentationVersionByThreadId[String(event.threadId)] != null
          || deps.chat.threadLoading?.threadId === event.threadId;
        if (!preserveSequences && String((event.payload as { itemId?: string }).itemId ?? "").trim()) {
          while (consumed < limit && performance.now() - started < LIVE_EVENT_BUDGET_MS) {
            const next = engineEventBuffer[consumed]!;
            // 既有压缩器仅合并相邻同一条目；token、审批、终态及其他线程均形成边界。
            const merged = compressConversationEvents([event, next]);
            if (merged.length !== 1) break;
            event = coalesceLiveConversationEvents(merged)[0]!;
            consumed++;
          }
        }
        const workspaceId = deps.config.workspaceId;
        if ((localSubscribedWorkspaceId || isDesktopWorkspace(deps.config, workspaceId)) && event.workspaceId !== workspaceId) continue;
        deps.chat.applyEngineEvent(event);
        if (epoch !== engineEventBufferEpoch) return;
        refreshRequirementAnalysisForTerminalEvent(event);
        if (epoch !== engineEventBufferEpoch) return;
        // 子代理内部完成的命令/写文件同样会改动工作区，必须与顶层工具一致刷新。
        const child = event.type === "item.subagent.childEvent" ? event.payload as {
          innerEventType?: unknown; innerPayload?: { toolName?: string } } : null;
        const toolName = event.type === "item.tool.completed" ? event.payload.toolName
          : child?.innerEventType === "item.tool.completed" ? child.innerPayload?.toolName : undefined;
        if (isWorkspaceMutatingToolName(toolName)) scheduleGitStatusRefresh(isFileMutationToolName(toolName));
        // 回合结束时兜底复核一次，覆盖子代理未上报或工具名无法归类的写操作。
        else if (event.type === "turn.completed" || event.type === "turn.error") scheduleGitStatusRefresh();
      }
    } finally {
      // 同步失败也移除已消费前缀；作用域重入清理后绝不删除新代际队列。
      if (epoch === engineEventBufferEpoch) engineEventBuffer.splice(0, consumed);
    }
    if (epoch !== engineEventBufferEpoch) return;
    if (engineEventBuffer.length && engineEventFlushTimer == null) {
      engineEventFlushTimer = window.setTimeout(flushEngineEvents, 0);
    }
  };

  /** 后台刷新前置条件：页面在前台、连接正常且当前 Client 在线。 */
  const canRefreshBackground = (): boolean => (typeof document === "undefined" || !document.hidden)
    && deps.config.connected && deps.presence.isCurrentWorkspaceClientOnline;

  /**
   * 会话里命令执行或写文件工具完成后，任何视图下的 Git 状态都可能已过期。
   * 前台且 Client 在线时去抖刷新；文件页有写入时同步刷新文件树。
   * 从未加载过 Git 状态且文件树无需刷新时没有可更新的展示，直接跳过。
   */
  const scheduleGitStatusRefresh = (fileChanged = false) => {
    const explorer = deps.explorer;
    if (!explorer) return;
    const currentWorkspaceId = String(deps.config.workspaceId ?? "").trim();
    // 工具改动工作区后缓存必然过期：面板不可见也要失效，避免切回时命中旧快照。
    if (currentWorkspaceId) explorer.invalidateGitStatus(apiCtx(), currentWorkspaceId as WorkspaceId);
    if (fileChanged) treeRefreshPending = true;
    if (gitStatusRefreshTimer != null) return;
    if (!explorer.gitStatus && !treeRefreshPending) return;
    if (!canRefreshBackground()) return;
    gitStatusRefreshTimer = window.setTimeout(() => {
      gitStatusRefreshTimer = null;
      const workspaceId = String(deps.config.workspaceId ?? "").trim();
      const target = deps.explorer;
      // 条件未恢复时保留待刷新标记，等下一次事件或回到前台再补刷。
      if (!workspaceId || !target || !canRefreshBackground()) return;
      const refreshTree = treeRefreshPending && target.viewMode === "files";
      if (refreshTree) treeRefreshPending = false;
      /** 自动刷新失败仍记录根因；仅 Git 视图中才提示用户，避免其他视图弹出无上下文报错。 */
      const report = (logKey: string, error: unknown, notifyUser: boolean) => reportAutomaticRefreshError(logKey, error, {
        workspaceId,
        code: (error as { code?: unknown })?.code ?? null,
        requestId: (error as { details?: { requestId?: unknown; serverRequestId?: unknown } })?.details?.requestId ?? null,
      }, "", notifyUser);
      if (target.gitStatus) {
        void target.refreshGitView(apiCtx(), workspaceId as WorkspaceId)
          .catch((error) => report("gitStatusRefresh", error, target.viewMode === "git" || target.viewMode === "log"));
      }
      if (refreshTree) {
        void target.loadTree(apiCtx(), workspaceId as WorkspaceId)
          .catch((error) => report("explorerTreeRefresh", error, true));
      }
    }, GIT_STATUS_REFRESH_DEBOUNCE_MS);
  };

  /** 页面从隐藏恢复时补刷此前被跳过的状态与文件树。 */
  const onVisibilityRefresh = () => {
    if (typeof document === "undefined" || document.hidden) return;
    scheduleGitStatusRefresh();
  };

  const clearGitStatusRefreshTimer = () => {
    treeRefreshPending = false;
    if (gitStatusRefreshTimer == null) return;
    window.clearTimeout(gitStatusRefreshTimer);
    gitStatusRefreshTimer = null;
  };

  const scheduleFlushEngineEvents = () => {
    if (engineEventFlushTimer != null) return;
    engineEventFlushTimer = window.setTimeout(flushEngineEvents, 16);
  };

  /** canonical 两条传输共用同一合批和 reducer；归属在所属订阅边界检查。 */
  const enqueueConversationEvent = (event: EngineEventEnvelope): void => {
    engineEventBuffer.push(event);
    scheduleFlushEngineEvents();
    if (event.type === "turn.completed" || event.type === "turn.error" || event.type === "item.message.deleted") {
      enqueuePresentationChange({ t: "conversation.changed", workspaceId: event.workspaceId, threadId: event.threadId, version: event.seq });
    }
  };

  /** 回滚屏障前通知无效；后台只记版本及资源副作用，可见面板才合并刷新快照。 */
  function enqueuePresentationChange(change: ConversationChangedMessage): void {
    const barrier = deps.chat.threadRollbackEventSeqBarrierByThreadId[String(change.threadId)] ?? 0;
    if (change.version <= barrier) return;
    const key = `${change.workspaceId}:${change.threadId}`;
    const completed = change.toolCompleted;
    if (completed && completed.seq > barrier) {
      const seen = completedToolSignals.get(key) ?? new Set<number>();
      if (!seen.has(completed.seq)) {
        seen.add(completed.seq);
        completedToolSignals.set(key, seen);
        if (completed.hasFileChanges && isFileMutationToolName(completed.toolName)) {
          deps.chat.fileChangeTick++;
          deps.chat.markThreadFileChangesChanged(change.threadId);
        }
        if (completed.managedServicesChanged) deps.chat.markManagedServicesChanged(change.threadId);
        if (isWorkspaceMutatingToolName(completed.toolName)) scheduleGitStatusRefresh(isFileMutationToolName(completed.toolName));
      }
    }
    deps.chat.requireThreadPresentationVersion(change.threadId, change.version);
    deps.chat.activeWorkspaceLastEventSeq = Math.max(deps.chat.activeWorkspaceLastEventSeq, change.version);
    if (!deps.chat.isThreadPresentationVisible(change.workspaceId, change.threadId)) return;
    const previous = presentationChanges.get(key);
    if (!previous || previous.version < change.version) presentationChanges.set(key, change);
    schedulePresentationRefresh();
  }

  /** 单会话串行刷新；消费时再次核对回滚屏障，撤销已经排队的旧通知。 */
  function schedulePresentationRefresh(): void {
    if (presentationRefreshTimer != null || !presentationChanges.size) return;
    presentationRefreshTimer = window.setTimeout(() => {
      presentationRefreshTimer = null;
      for (const [key, change] of presentationChanges) {
        if (change.version <= (deps.chat.threadRollbackEventSeqBarrierByThreadId[String(change.threadId)] ?? 0)) {
          presentationChanges.delete(key);
          continue;
        }
        if (presentationRefreshes.has(key)) continue;
        if (!deps.chat.isThreadPresentationVisible(change.workspaceId, change.threadId)) {
          presentationChanges.delete(key);
          continue;
        }
        if (deps.config.workspaceId !== change.workspaceId || (localSubscribedWorkspaceId ?? currentSubscribedWorkspaceId) !== change.workspaceId) {
          presentationChanges.delete(key);
          continue;
        }
        if (deps.chat.threadLoading?.threadId === change.threadId) continue;
        presentationChanges.delete(key);
        presentationRefreshes.add(key);
        void deps.chat.refreshThreadPresentation(apiCtx(), { ...change, visibleOnly: true }).catch(error => {
          if (!isCancelledRequestError(error)) reportAutomaticRefreshError("threadPresentationRefresh", error,
            { code: "THREAD_PRESENTATION_REFRESH_FAILED", workspaceId: change.workspaceId, threadId: change.threadId, version: change.version }, "会话摘要刷新失败");
        }).finally(() => {
          presentationRefreshes.delete(key);
          schedulePresentationRefresh();
        });
      }
      if ([...presentationChanges.keys()].some(key => !presentationRefreshes.has(key))) schedulePresentationRefresh();
    }, 180);
  }

  /** 终端事件的应用逻辑由 Server 实时消息与本机 desktop.event 共用。 */
  const applyTerminalMessage = (msg: TerminalWireMessage): void => {
    if (terminalMessageRequiresOwnership(msg.t) && (!String((msg as { clientId?: unknown }).clientId ?? "").trim() || !String((msg as { workspaceId?: unknown }).workspaceId ?? "").trim())) {
      deps.terminal?.onTerminalError(undefined, undefined, (msg as { terminalId?: string }).terminalId, (msg as { requestId?: string }).requestId,
        "终端事件缺少 Client 或工作区归属，请升级并重启 Server/Client 后重试");
      return;
    }
    if (msg.t === "terminal.created") { deps.terminal?.onTerminalCreated(msg.terminal, msg.requestId); return; }
    if (msg.t === "terminal.output") { deps.terminal?.onTerminalOutput(msg.clientId, msg.workspaceId, msg.terminalId, msg.data); return; }
    if (msg.t === "terminal.exited") { deps.terminal?.onTerminalExited(msg.clientId, msg.workspaceId, msg.terminalId, msg.exitCode); return; }
    if (msg.t === "terminal.closed") { deps.terminal?.onTerminalClosed(msg.clientId, msg.workspaceId, msg.terminalId); return; }
    if (msg.t === "terminal.listed") { deps.terminal?.onTerminalListed(msg.clientId, msg.workspaceId, msg.requestId, msg.terminals); return; }
    if (msg.t === "terminal.listAll.result") { deps.terminal?.onTerminalListAllResult(msg); return; }
    if (msg.t === "terminal.renamed") { deps.terminal?.onTerminalRenamed(msg.clientId, msg.workspaceId, msg.terminalId, msg.label); return; }
    if (msg.t === "terminal.foregroundChanged") { deps.terminal?.onTerminalForegroundChanged(msg.clientId, msg.workspaceId, msg.terminalId, msg.foregroundProcess); return; }
    deps.terminal?.onTerminalError(msg.clientId, msg.workspaceId, msg.terminalId, msg.requestId, msg.message);
  };

  /** 本机事件补上 Client 归属后复用同一应用逻辑。 */
  const toTerminalWireMessage = (event: Extract<DesktopEvent, { t: `terminal.${string}` }>): TerminalWireMessage => {
    if (event.t === "terminal.created") {
      return { t: "terminal.created", terminal: { ...event.terminal, clientId: event.clientId },
        ...(event.requestId ? { requestId: event.requestId } : {}) };
    }
    if (event.t === "terminal.listed") {
      return { t: "terminal.listed", clientId: event.clientId, workspaceId: event.workspaceId,
        ...(event.requestId ? { requestId: event.requestId } : {}),
        terminals: event.terminals.map((terminal) => ({ ...terminal, clientId: event.clientId })) };
    }
    return event;
  };

  /** 本机终端控制面逐条串行执行；失败只报告，不回退到 Server 通道。 */
  const reportLocalTerminalFailure = (message: TerminalSendMessage, error: unknown): void => {
    const workspaceId = String(("workspaceId" in message ? message.workspaceId : undefined) ?? deps.config.workspaceId ?? "").trim();
    const terminalId = "terminalId" in message ? message.terminalId : undefined;
    const requestId = "requestId" in message ? message.requestId : undefined;
    const reason = error instanceof Error ? error.message : String(error);
    const failure = error as { code?: string; details?: { requestId?: string } };
    if (message.t === "terminal.listAll") deps.terminal?.failListAll(message.requestId, reason);
    deps.terminal?.onTerminalError(String(deps.config.desktopClient?.clientId ?? "").trim() || undefined, workspaceId || undefined,
      terminalId, requestId, reason);
    console.warn("[ws.terminal.localFailure]", { errorCode: failure?.code ?? "TERMINAL_LOCAL_REQUEST_FAILED", messageType: message.t,
      clientId: deps.config.desktopClient?.clientId, workspaceId, terminalId, requestId, sourceRequestId: failure?.details?.requestId, reason });
  };

  /** Web 终端控制消息映射为本机 API；clientId 不进入请求体。 */
  const toLocalTerminalRequest = (message: Exclude<TerminalSendMessage, { t: "terminal.listAll" }>): DesktopApiRequest => {
    const workspaceId = String(message.workspaceId ?? "").trim();
    if (message.t === "terminal.create") {
      return { method: "terminal.create", body: { workspaceId, ...(message.requestId ? { requestId: message.requestId } : {}),
        ...(message.label ? { label: message.label } : {}), ...(message.shell ? { shell: message.shell } : {}), ...(message.cwd ? { cwd: message.cwd } : {}) } };
    }
    if (message.t === "terminal.input") return { method: "terminal.input", body: { workspaceId, terminalId: message.terminalId, data: message.data } };
    if (message.t === "terminal.resize") return { method: "terminal.resize", body: { workspaceId, terminalId: message.terminalId, cols: message.cols, rows: message.rows } };
    if (message.t === "terminal.close") return { method: "terminal.close", body: { workspaceId, terminalId: message.terminalId } };
    if (message.t === "terminal.rename") return { method: "terminal.rename", body: { workspaceId, terminalId: message.terminalId, label: message.label } };
    if (message.t === "terminal.runAction") {
      return { method: "terminal.runAction", body: { workspaceId, actionId: message.actionId, ...(message.requestId ? { requestId: message.requestId } : {}) } };
    }
    return { method: "terminal.list", body: { workspaceId, ...(message.requestId ? { requestId: message.requestId } : {}) } };
  };

  /** 本机控制复用原 API；迟到列表不得覆盖切换后的工作区。 */
  const runLocalTerminal = async (message: TerminalSendMessage, workspaceId: string): Promise<void> => {
    const localClientId = String(deps.config.desktopClient?.clientId ?? "").trim();
    if (message.t === "terminal.listAll") {
      if (!localClientId || !workspaceId || !isLocalDesktopTerminalMode(deps.config, workspaceId)) {
        throw new Error("当前工作区不是本机终端工作区");
      }
      const result = await requestDesktopApi<{ terminals: Array<TerminalInfo & { scrollback?: string }> }>({
        method: "terminal.list", body: { workspaceId, requestId: message.requestId },
      });
      if (!result.ok) throw Object.assign(new Error(result.message), result);
      if (!Array.isArray(result.terminals)) throw new Error("本机终端列表响应缺少 terminals");
      if (deps.config.workspaceId !== workspaceId) throw new Error("终端列表所属工作区已切换");
      syncTerminalOnlineClients(deps.config.connected ? deps.terminal?.onlineClientIds ?? [] : []);
      deps.terminal?.onTerminalListAllResult({ t: "terminal.listAll.result", requestId: message.requestId,
        targets: [{ clientId: localClientId, workspaceId }],
        terminals: result.terminals.map((terminal) => ({ ...terminal, clientId: localClientId })), failures: [] });
      return;
    }
    if (!localClientId || !workspaceId) throw new Error("本机终端缺少 Client 或工作区归属");
    const result = await requestDesktopApi(toLocalTerminalRequest(message));
    if (!result.ok) throw Object.assign(new Error(result.message), result);
    if (message.t === "terminal.list") {
      const terminals = (result as { terminals?: Array<TerminalInfo & { scrollback?: string }> }).terminals;
      if (!Array.isArray(terminals)) throw new Error("本机终端列表响应缺少 terminals");
      deps.terminal?.onTerminalListed(localClientId, workspaceId, message.requestId,
        terminals.map((terminal) => ({ ...terminal, clientId: localClientId })));
    }
  };

  let localTerminalQueue: Promise<void> = Promise.resolve();

  /** 云在线事实与本机就绪事实独立，本机不随 Web WS 断连离线。 */
  const syncTerminalOnlineClients = (clientIds: string[]): void => {
    const localClientId = deps.config.localRuntimeReady ? String(deps.config.desktopClient?.clientId ?? "").trim() : "";
    deps.terminal?.syncOnlineClients(localClientId ? [...clientIds, localClientId] : clientIds);
  };

  /** 按目标归属走本机控制；在线账号聚合及远端操作保留 WebSocket。 */
  const sendTerminal = (message: TerminalSendMessage): boolean => {
    const workspaceId = String(("workspaceId" in message ? message.workspaceId : undefined) ?? deps.config.workspaceId ?? "").trim();
    const localClientId = String(deps.config.desktopClient?.clientId ?? "").trim();
    if (message.t === "terminal.listAll" && deps.config.connected && deps.config.desktopCloudAccountLinked) return send(message);
    if ("clientId" in message && message.clientId && message.clientId !== localClientId) return send(message);
    if (!isLocalDesktopTerminalMode(deps.config, workspaceId)) return send(message);
    if (!getDesktopBridge() || !String(deps.config.desktopClient?.clientId ?? "").trim()) {
      reportLocalTerminalFailure(message, new Error("本机终端通道不可用"));
      return false;
    }
    localTerminalQueue = localTerminalQueue.then(() => runLocalTerminal(message, workspaceId)).catch((error: unknown) => {
      // 此请求显式进入失败态；后续独立输入仍保留原串行次序。
      reportLocalTerminalFailure(message, error);
    });
    return true;
  };

  /** 本机订阅无需云端握手，历史由后续 threads.load 读取 SQLite。 */
  const replaceLocalWorkspaceSubscription = (workspaceId: WorkspaceId | null): void => {
    if (workspaceId && !isDesktopWorkspace(deps.config, workspaceId)) throw new Error("DESKTOP_WORKSPACE_NOT_LOCAL");
    if (localSubscribedWorkspaceId === workspaceId) return;
    clearEngineEventBuffer(true);
    localSubscribedWorkspaceId = workspaceId;
    if (workspaceId) {
      activeSubscriptionRequestId = null;
      currentSubscribedWorkspaceId = null;
      rejectWorkspaceSubscriptionWaiter("scope-change");
      rejectSharedWorkspaceSubscriptionWaiter("scope-change");
      deps.chat.markWorkspaceSubscribed();
    }
  };

  /** 只接受当前本机范围；共享及其他工作区事件不进入当前渲染队列。 */
  const receiveDesktopEvent = (message: DesktopEvent): void => {
    const workspaceId = localSubscribedWorkspaceId;
    if (!workspaceId || !isDesktopWorkspace(deps.config, workspaceId) || deps.config.workspaceId !== workspaceId) return;
    if (isDesktopTerminalEvent(message)) {
      const eventWorkspaceId = message.t === "terminal.created" ? message.terminal.workspaceId : message.workspaceId;
      const localClientId = String(deps.config.desktopClient?.clientId ?? "").trim();
      if (eventWorkspaceId !== workspaceId || (localClientId && message.clientId !== localClientId)) return;
      applyTerminalMessage(toTerminalWireMessage(message));
      return;
    }
    if (message.t === "engineKeys.changed") refreshEngineKeysAfterChanged();
    if (message.t === "conversation.event" && message.event.workspaceId === workspaceId) enqueueConversationEvent(message.event);
    if (message.t === "conversation.changed" && message.workspaceId === workspaceId) enqueuePresentationChange(message);
    if (message.t === "reminders.changed" && message.workspaceId === workspaceId) refreshRemindersIfNeeded(workspaceId);
    if (message.t === "orchestration.event" && message.workspaceId === workspaceId) {
      deps.chat.handleOrchestrationEvent(message.event);
      void deps.orchestration?.onOrchestrationEvent(apiCtx(), workspaceId, message.event, {
        allowNetworkHydration: () => localSubscribedWorkspaceId === workspaceId && deps.config.workspaceId === workspaceId
          && isDesktopWorkspace(deps.config, workspaceId) && (!deps.ui || deps.ui.mainView === "orchestration"),
      }).catch(error => {
        reportAutomaticRefreshError("desktopOrchestrationEventRefresh", error, { workspaceId, instanceId: message.event.instanceId, eventType: message.event.type });
      });
    }
    if (message.t === "thread.queue.changed" && message.workspaceId === workspaceId) {
      void deps.threadQueue?.ingestServerEvent(apiCtx(), message.workspaceId, message.threadId).catch(error => {
        reportAutomaticRefreshError("desktopQueueRefresh", error, { workspaceId, threadId: message.threadId }, "本机队列刷新失败");
      });
    }
  };

  const getTenantSnapshotKey = () => [
    String(deps.config.serverWsOrigin ?? "").trim(),
    String(deps.config.authMode ?? ""),
    String(deps.config.userSummary?.userId ?? ""),
  ].join("::");

  const syncTenantEpoch = () => {
    const next = getTenantSnapshotKey();
    if (next !== tenantSnapshotKey) {
      tenantSnapshotKey = next;
      tenantEpoch += 1;
      activeSubscriptionRequestId = null;
      currentSubscribedWorkspaceId = null;
      clearEngineEventBuffer();
      reminderRefreshCoordinator.cancel();
    }
    return tenantEpoch;
  };

  const ensureSession = async (signal?: AbortSignal): Promise<string> => {
    return await deps.config.ensureSession(signal);
  };

  const isAuthSessionError = (message: string): boolean => {
    return isAuthSessionErrorMessage(message);
  };

  /** 判断认证错误是否仍可提示；主动断开忽略旧请求，同一连接只提示一次。 */
  function shouldReportAuthError(message: string, logKey: string, context: Record<string, unknown>): boolean {
    if (!isAuthSessionError(message)) return true;
    if (stopped) {
      console.debug(`[ws.${logKey}.authErrorIgnoredAfterDisconnect]`, { ...context, reason: message });
      return false;
    }
    if (authErrorReported) {
      console.debug(`[ws.${logKey}.authErrorDeduplicated]`, { ...context, reason: message });
      return false;
    }
    authErrorReported = true;
    return true;
  }

  const handlePreOpenFailure = (error: unknown): void => {
    if (stopped) return;
    const message = error instanceof Error ? error.message : String(error);
    deps.config.setConnectionStatus("disconnected");
    if (isAuthSessionError(message)) {
      deps.config.expireCurrentSession();
      return;
    }
    scheduleReconnect();
  };

  const issueWebSocketBridgeToken = async (sessionToken: string, signal?: AbortSignal): Promise<string> => {
    let response: Response;
    try {
      response = await fetch(`${wsOriginToHttpOrigin(deps.config.serverWsOrigin)}/api/account/me/ws-bridge`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
        signal,
      });
    } catch {
      throw new Error("服务暂时不可达，请确认 Server 已启动后重试");
    }
    const text = await response.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`WebSocket bridge response is not JSON (status=${response.status})`);
    }
    if (response.status === 401) {
      throw new Error(String(body?.message ?? "账号会话已过期，请重新登录"));
    }
    if (!response.ok) {
      throw new Error(String(body?.message ?? `服务连接失败（status=${response.status}）`));
    }
    if (!body?.ok || typeof body.bridgeToken !== "string" || !body.bridgeToken.trim()) {
      throw new Error(String(body?.message ?? "Failed to issue WebSocket bridge token"));
    }
    return body.bridgeToken.trim();
  };

  const apiCtx = (): ApiRequestContext => ({
    serverWsOrigin: deps.config.serverWsOrigin,
    sessionToken: deps.config.sessionToken,
    webSessionId: deps.config.webSessionId,
    desktopClientId: deps.config.desktopClient?.clientId ?? null,
    isLogoutInProgress: () => deps.config.logoutInProgress,
    ensureSession: (signal?: AbortSignal) => deps.config.ensureSession(signal),
    clearSession: () => deps.config.clearSession(),
  });

  /** 两条传输共用 Key 刷新入口，并在提交前复检账号与本机代际。 */
  function refreshEngineKeysAfterChanged(): void {
    const workspaceId = String(deps.config.workspaceId ?? "").trim();
    if (!workspaceId || isSharedWorkspaceSelectionId(workspaceId) || !deps.engineKeys) return;
    const owner = [deps.config.serverWsOrigin, deps.config.sessionToken, deps.config.userSummary?.userId, deps.config.desktopCloudAccount?.generation, deps.config.desktopRuntime?.requestId];
    const shouldApply = () => deps.config.workspaceId === workspaceId && !deps.config.logoutInProgress
      && owner.every((value, index) => value === [deps.config.serverWsOrigin, deps.config.sessionToken, deps.config.userSummary?.userId, deps.config.desktopCloudAccount?.generation, deps.config.desktopRuntime?.requestId][index]);
    void deps.engineKeys.refresh(apiCtx(), workspaceId, shouldApply).catch((error) => {
      if (isCancelledRequestError(error)) return;
      reportAutomaticRefreshError("engineKeysChanged", error, { workspaceId }, "引擎 Key 列表刷新失败");
    });
  }

  /** 后台刷新失败保留错误关联；主动断开认证取消，同一连接只提示一次真实失效。 */
  function reportAutomaticRefreshError(
    logKey: string,
    error: unknown,
    context: Record<string, unknown>,
    detailPrefix = "",
    notifyUser = true,
  ): void {
    const reason = error instanceof Error ? error.message : String(error);
    const failure = error as { code?: unknown; details?: { requestId?: unknown; serverRequestId?: unknown } } | null;
    context = { ...context, code: failure?.code ?? context.code ?? null,
      requestId: failure?.details?.requestId ?? failure?.details?.serverRequestId ?? context.requestId ?? null };
    if (isWorkspaceClientOfflineError(error)) {
      console.debug(`[ws.${logKey}.clientOffline]`, { ...context, reason });
      return;
    }
    const detail = detailPrefix ? `${detailPrefix}：${reason}` : reason;
    if (!shouldReportAuthError(reason, logKey, context)) return;
    if (notifyUser) deps.onError?.(detail);
    console.warn(`[ws.${logKey}]`, { ...context, reason }, error);
  }

  /** 需求助手终局事件到达时刷新业务态，补齐 chat 事件与候选草稿 store 的同步边界。 */
  function refreshRequirementAnalysisForTerminalEvent(event: EngineEventEnvelope): void {
    if (event.type !== "turn.completed" && event.type !== "turn.error") return;
    if (!deps.requirementAnalysis) return;
    void deps.requirementAnalysis
      .refreshSelectedSessionForThread(apiCtx(), event.workspaceId, event.threadId)
      .catch((error) => {
        reportAutomaticRefreshError(
          "requirementAnalysisRefresh",
          error,
          { workspaceId: String(event.workspaceId), threadId: String(event.threadId) },
          `需求分析状态刷新失败（threadId=${String(event.threadId)}）`,
        );
      });
  }

  const reminderRefreshCoordinator = createReminderRefreshCoordinator({
    store: deps.reminders,
    getApiContext: apiCtx,
    getCurrentWorkspaceId: () => deps.config.workspaceId,
    onError: (error, workspaceId) => {
      if (isCancelledRequestError(error)) return;
      reportAutomaticRefreshError("reminderRefresh", error, { workspaceId }, "提醒刷新失败");
    },
  });

  const rejectWorkspaceSubscriptionWaiter = (reason: AbortKind) => {
    const waiter = workspaceSubscriptionWaiter;
    if (!waiter) return;
    workspaceSubscriptionWaiter = null;
    waiter.reject(createCancelledRequestError(reason));
  };

  const rejectSharedWorkspaceSubscriptionWaiter = (reason: AbortKind) => {
    const waiter = sharedWorkspaceSubscriptionWaiter;
    if (!waiter) return;
    sharedWorkspaceSubscriptionWaiter = null;
    waiter.reject(createCancelledRequestError(reason));
  };

  const replaceWorkspaceSubscription = (workspaceId: WorkspaceId | null, opts?: { sinceSeq?: number }) => {
    const normalizedWorkspaceId = workspaceId ? ((String(workspaceId).trim() as WorkspaceId) || null) : null;
    const sinceSeqRaw = Number(opts?.sinceSeq ?? 0);
    const sinceSeq = Number.isFinite(sinceSeqRaw) && sinceSeqRaw > 0 ? Math.floor(sinceSeqRaw) : 0;
    rejectWorkspaceSubscriptionWaiter("scope-change");
    rejectSharedWorkspaceSubscriptionWaiter("scope-change");
    subscriptionEpoch += 1;
    activeSubscriptionRequestId = `sub-${tenantEpoch}-${connectionEpoch}-${subscriptionEpoch}-${Date.now()}`;
    currentSubscribedWorkspaceId = normalizedWorkspaceId;
    clearEngineEventBuffer();
    if (!ws || ws.readyState !== ws.OPEN) {
      return Promise.reject(createCancelledRequestError("disconnect"));
    }
    send({
      t: "web.subscribeReplace",
      workspaceId: normalizedWorkspaceId,
      sinceSeq: normalizedWorkspaceId ? sinceSeq : 0,
      requestId: activeSubscriptionRequestId,
    });
    if (!normalizedWorkspaceId) {
      return Promise.resolve({
        requestId: activeSubscriptionRequestId,
        subscriptionEpoch,
        workspaceId: null,
        bufferedCount: 0,
      });
    }
    return new Promise<{ requestId: string; subscriptionEpoch: number; workspaceId: WorkspaceId | null; bufferedCount: number }>((resolve, reject) => {
      workspaceSubscriptionWaiter = {
        requestId: activeSubscriptionRequestId!,
        subscriptionEpoch,
        resolve,
        reject,
      };
    });
  };

  const refreshThreadsIfNeeded = (workspaceId: WorkspaceId) => {
    if (!workspaceIdsReferToSameWorkspace(workspaceId, deps.config.workspaceId)) return;
    deps.chat.requestWorkspaceHydration();
  };

  const refreshRemindersIfNeeded = (workspaceId: WorkspaceId) => {
    reminderRefreshCoordinator.enqueue(workspaceId);
  };

  /** 自动恢复工作区选择；常规重连保留当前选择，明确删除时才允许改选。 */
  const ensureWorkspaceSelection = (opts?: { allowFallbackForMissingCurrent?: boolean }) => {
    const store = deps.workspaces;
    if (!store) return;

    const currentWorkspaceId = String(deps.config.workspaceId ?? "").trim();
    const candidateWorkspaceIds = store.workspaces.map((workspace) => String(workspace.id));
    if (!candidateWorkspaceIds.length) {
      // 工作区列表为空时可能只是首屏加载中或 client 在线态瞬时抖动。
      // 不要在这里把用户上次选择直接清空，否则会形成刷新后 selector 假死。
      return;
    }

    const preferredWorkspaceId = resolveStickyWorkspaceSelection({
      currentWorkspaceId,
      candidates: candidateWorkspaceIds,
      onlineWorkspaceIds: deps.presence.online.onlineClients.flatMap((client) => client.workspaceIds),
      allowFallbackForMissingCurrent: opts?.allowFallbackForMissingCurrent,
    });
    if (!preferredWorkspaceId) {
      if (currentWorkspaceId) deps.config.switchWorkspace("");
      return;
    }

    if (preferredWorkspaceId !== currentWorkspaceId) {
      deps.config.switchWorkspace(preferredWorkspaceId, { preservePrimaryThreadUrl: true });
    }
  };

  const clearWorkspacesIfNeeded = () => {
    const store = deps.workspaces;
    if (!store) return;
    store.lastError = null;
  };

  const refreshWorkspacesIfNeeded = (
    trigger: "presence" | "changed",
    deletedWorkspaceId?: WorkspaceId,
    onlineClients?: OnlineClientInfo[],
  ) => {
    const store = deps.workspaces;
    if (!store) return;
    if (trigger === "presence") {
      const decision = shouldRefreshWorkspacesForPresence({
        loading: store.loading,
        lastLoadedAt: store.lastLoadedAt,
        knownWorkspaceIds: store.workspaces.map((workspace) => workspace.id),
        onlineClients: onlineClients ?? [],
      });
      if (!decision.shouldRefresh) {
        ensureWorkspaceSelection();
        return;
      }
    }
    void store
      .refresh(apiCtx(), { scopeKey: buildWorkspacesRefreshScopeKey(apiCtx(), deps.config.workspaceId) })
      .then(() => {
        if (deletedWorkspaceId && workspaceIdMatchesCurrentSelection(deps.config.workspaceId, deletedWorkspaceId)) {
          ensureWorkspaceSelection({ allowFallbackForMissingCurrent: true });
          return;
        }
        ensureWorkspaceSelection();
      })
      .catch((error) => {
        reportAutomaticRefreshError("workspacesRefresh", error, {
          workspaceId: String(deps.config.workspaceId ?? ""),
          trigger,
        });
      });
  };

  const openWs = async (mode: "connect" | "reconnect") => {
    if (stopped) return;
    const openTenantEpoch = syncTenantEpoch();
    const openConnectionEpoch = ++connectionEpoch;
    authErrorReported = false;
    clearEngineEventBuffer();
    // 新连接在权威 presence 到达前不得继续复用旧在线数快照。
    deps.presence.ready = false;
    syncTerminalOnlineClients([]);
    activeSubscriptionRequestId = null;
    currentSubscribedWorkspaceId = null;
    rejectWorkspaceSubscriptionWaiter("disconnect");
    rejectSharedWorkspaceSubscriptionWaiter("disconnect");
    deps.config.setConnectionStatus(mode === "connect" ? "connecting" : "reconnecting");

    let sessionToken: string;
    try {
      sessionToken = await ensureSession();
    } catch (error) {
      if (stopped || openTenantEpoch !== tenantEpoch || openConnectionEpoch !== connectionEpoch) return;
      throw error;
    }

    if (stopped || openTenantEpoch !== tenantEpoch || openConnectionEpoch !== connectionEpoch) return;
    const wid = String(deps.config.webInstanceId ?? "").trim();
    let bridgeToken: string;
    try {
      bridgeToken = await issueWebSocketBridgeToken(sessionToken);
    } catch (error) {
      if (stopped || openTenantEpoch !== tenantEpoch || openConnectionEpoch !== connectionEpoch) return;
      throw error;
    }
    // disconnect/租户切换可能发生在 bridge 请求期间，迟到结果不得再创建幽灵连接。
    if (stopped || openTenantEpoch !== tenantEpoch || openConnectionEpoch !== connectionEpoch) return;
    const url = `${deps.config.wsWebUrl}?ticket=${encodeURIComponent(bridgeToken)}&wid=${encodeURIComponent(wid)}`;
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket || openTenantEpoch !== tenantEpoch || openConnectionEpoch !== connectionEpoch) return;
      reconnectAttempt = 0;
    };

    socket.onclose = (event) => {
      clearEngineEventBuffer();
      syncTerminalOnlineClients([]);
      rejectWorkspaceSubscriptionWaiter("disconnect");
      if (ws === socket) ws = null;
      else return;
      if (openTenantEpoch !== tenantEpoch || openConnectionEpoch !== connectionEpoch) return;
      if (stopped) {
        deps.config.setConnectionStatus("disconnected");
        return;
      }

      if (event.code === 1008) {
        if (deps.config.authMode === "account") {
          deps.config.expireCurrentSession();
          deps.config.setConnectionStatus("disconnected");
          const reason = "账号会话已过期，请重新登录";
          if (shouldReportAuthError(reason, "sessionExpired", {})) {
            deps.onError?.(reason);
          }
          return;
        }
        deps.config.clearSession();
      }

      deps.config.setConnectionStatus("reconnecting");
      scheduleReconnect();
    };

    socket.onmessage = (rawEvent) => {
      if (ws !== socket || openTenantEpoch !== tenantEpoch || openConnectionEpoch !== connectionEpoch) return;
      const msg = safeParse(rawEvent.data);
      if (!msg) return;
      if (!msg.t.startsWith("terminal.") && localSubscribedWorkspaceId && (("workspaceId" in msg && msg.workspaceId === localSubscribedWorkspaceId)
        || (msg.t === "conversation.event" && msg.event.workspaceId === localSubscribedWorkspaceId))) return;

      if (msg.t === "web.helloAck") {
        deps.config.setWebSessionId(msg.webSessionId);
        deps.config.applySessionFromHello(msg);
        if (msg.engineModelCatalog) deps.engine.applyCatalog(msg.engineModelCatalog);
        deps.config.setConnectionStatus("connected");
        return;
      }

      if (msg.t === "engine.models.updated") {
        deps.engine.applyCatalog(msg.catalog);
        const workspaceId = String(deps.config.workspaceId ?? "").trim();
        if (workspaceId) {
          void deps.engine.refresh(apiCtx(), workspaceId, {
            shouldApply: () => String(deps.config.workspaceId ?? "").trim() === workspaceId,
          }).catch((error) => {
            deps.onError?.(error instanceof Error ? error.message : String(error));
          });
        }
        return;
      }

      if (msg.t === "web.subscribeAck") {
        if (msg.requestId !== activeSubscriptionRequestId) return;
        deps.config.setLastBackfillCount(msg.bufferedCount);
        if (msg.workspaceId) {
          currentSubscribedWorkspaceId = msg.workspaceId;
          deps.presence.beginActiveWorkspaceSnapshot(msg.workspaceId, subscriptionEpoch);
          deps.chat.markWorkspaceSubscribed();
        }
        if (workspaceSubscriptionWaiter && workspaceSubscriptionWaiter.requestId === msg.requestId) {
          const waiter = workspaceSubscriptionWaiter;
          workspaceSubscriptionWaiter = null;
          waiter.resolve({
            requestId: msg.requestId,
            subscriptionEpoch: waiter.subscriptionEpoch,
            workspaceId: msg.workspaceId ?? null,
            bufferedCount: msg.bufferedCount,
          });
        }
        return;
      }

      if (msg.t === "sharedWorkspace.subscribeAck") {
        const activeSharedWorkspaceId = currentSubscribedWorkspaceId
          ? parseSharedWorkspaceSelectionId(currentSubscribedWorkspaceId)
          : null;
        if (msg.ack.requestId !== activeSubscriptionRequestId || String(activeSharedWorkspaceId ?? "") !== String(msg.ack.sharedWorkspaceId)) {
          return;
        }
        deps.config.setLastBackfillCount(msg.ack.bufferedCount);
        if (currentSubscribedWorkspaceId) {
          deps.presence.beginActiveWorkspaceSnapshot(currentSubscribedWorkspaceId, subscriptionEpoch);
          deps.chat.markWorkspaceSubscribed();
        }
        if (msg.ack.bootstrap) {
          deps.sharedWorkspaces?.applyTopicEvent({
            type: "sharedWorkspace.host.status.changed",
            sharedWorkspaceId: msg.ack.sharedWorkspaceId,
            enterpriseId: msg.ack.bootstrap.sharedWorkspace.enterpriseId,
            seq: msg.ack.serverSeq,
            ts: Date.now(),
            payload: {
              hostStatus: msg.ack.bootstrap.sharedWorkspace.hostStatus,
              host: msg.ack.bootstrap.host,
              reason: "registered",
            },
          });
          if (msg.ack.bootstrap.sharedWorkspace.hostMaintenance) {
            deps.sharedWorkspaces?.applyTopicEvent({
              type: "sharedWorkspace.host.maintenance.changed",
              sharedWorkspaceId: msg.ack.sharedWorkspaceId,
              enterpriseId: msg.ack.bootstrap.sharedWorkspace.enterpriseId,
              seq: msg.ack.serverSeq,
              ts: Date.now(),
              payload: msg.ack.bootstrap.sharedWorkspace.hostMaintenance,
            });
          }
        }
        if (sharedWorkspaceSubscriptionWaiter && sharedWorkspaceSubscriptionWaiter.requestId === msg.ack.requestId) {
          const waiter = sharedWorkspaceSubscriptionWaiter;
          sharedWorkspaceSubscriptionWaiter = null;
          waiter.resolve({
            requestId: msg.ack.requestId,
            subscriptionEpoch: waiter.subscriptionEpoch,
            workspaceId: currentSubscribedWorkspaceId!,
            sharedWorkspaceId: msg.ack.sharedWorkspaceId,
            bufferedCount: msg.ack.bufferedCount,
          });
        }
        return;
      }

      if (msg.t === "client.preempt.requested") {
        deps.onClientPreemptRequested?.(msg.request);
        return;
      }
      if (msg.t === "client.preempt.resolved") {
        deps.onClientPreemptResolved?.({ requestId: msg.requestId, decision: msg.decision });
        return;
      }
      if (msg.t === "threads.changed") {
        if (msg.kind === "history_cleaned") {
          if (!currentSubscribedWorkspaceId || !workspaceIdsReferToSameWorkspace(msg.workspaceId, currentSubscribedWorkspaceId)) return;
          // 失效只撤投影；已展示的回滚历史仍须从原事实源重读，清空操作会读到空历史。
          const reload = deps.chat.selectedThreadId === msg.threadId
            || Boolean(deps.chat.loadedThreads[String(msg.threadId)] || deps.chat.conversations[String(msg.threadId)]);
          const limit = deps.chat.threadLoadMetaByThreadId[String(msg.threadId)]?.limit ?? null;
          deps.chat.handleThreadChangedFromServer({ workspaceId: msg.workspaceId, threadId: msg.threadId, kind: msg.kind, patch: null });
          if (reload) void deps.chat.loadThread(apiCtx(), { workspaceId: msg.workspaceId, threadId: msg.threadId, limit }).catch(error => {
            reportAutomaticRefreshError("historyCleanedRefresh", error, { workspaceId: msg.workspaceId, threadId: msg.threadId });
          });
          return;
        }
        if (msg.rollbackEventSeqBarrier != null) {
          // 工作区切换后的迟到 rollback 广播不得污染当前会话投影。
          if (!currentSubscribedWorkspaceId || !workspaceIdsReferToSameWorkspace(msg.workspaceId, currentSubscribedWorkspaceId)) {
            return;
          }
          void deps.chat.reconcileThreadRollbackFromServer(apiCtx(), {
            workspaceId: msg.workspaceId,
            threadId: msg.threadId,
            rollbackEventSeqBarrier: msg.rollbackEventSeqBarrier,
          }).catch((error) => {
            reportAutomaticRefreshError("sharedRollbackHistoryRefresh", error, {
              workspaceId: String(msg.workspaceId),
              threadId: String(msg.threadId),
              rollbackEventSeqBarrier: msg.rollbackEventSeqBarrier,
            });
          });
          return;
        }
        const shouldHydrate = deps.chat.handleThreadChangedFromServer({
          workspaceId: msg.workspaceId,
          threadId: msg.threadId,
          kind: msg.kind,
          patch: msg.patch ?? null,
        });
        if (shouldHydrate) {
          refreshThreadsIfNeeded(msg.workspaceId);
        }
        return;
      }
      if (msg.t === "thread.draft.updated") {
        if (!currentSubscribedWorkspaceId || String(msg.workspaceId) !== String(currentSubscribedWorkspaceId)) return;
        deps.chat.setThreadDraftVersion(msg.threadId, msg.version, msg.updatedByWebSessionId);
        return;
      }
      if (msg.t === "thread.queue.changed") {
        if (!currentSubscribedWorkspaceId || String(msg.workspaceId) !== String(currentSubscribedWorkspaceId)) return;
        if (deps.threadQueue) {
          void deps.threadQueue.ingestServerEvent(apiCtx(), msg.workspaceId, msg.threadId).catch(error => {
            reportAutomaticRefreshError("queueRefresh", error, { workspaceId: msg.workspaceId, threadId: msg.threadId }, "队列刷新失败");
          });
        }
        return;
      }
      if (msg.t === "engineKeys.changed") {
        refreshEngineKeysAfterChanged();
        return;
      }
      if (msg.t === "workspaces.changed") {
        refreshWorkspacesIfNeeded("changed", msg.kind === "deleted" ? msg.workspaceId : undefined);
        return;
      }
      if (msg.t === "workspaceDirectoryMigration.changed") {
        const needsAuthoritativeRefresh = deps.workspaces?.applyDirectoryMigrationChanged(msg.event) ?? false;
        if (needsAuthoritativeRefresh && deps.workspaces) {
          void deps.workspaces
            .getDirectoryMigration(apiCtx(), msg.event.workspaceId, msg.event.operationId)
            .catch((error) => {
              reportAutomaticRefreshError(
                "workspaceDirectoryMigrationRefresh",
                error,
                { workspaceId: String(msg.event.workspaceId), operationId: msg.event.operationId, stateVersion: msg.event.stateVersion },
                "迁移状态权威刷新失败",
              );
            });
        }
        return;
      }
      if (msg.t === "reminders.changed") {
        if (isDesktopWorkspace(deps.config, msg.workspaceId)) return;
        refreshRemindersIfNeeded(msg.workspaceId);
        return;
      }
      if (msg.t === "account.quick_phrases.changed") {
        if (msg.changedByWebSessionId !== deps.config.webSessionId) {
          void deps.quickPhrases?.handleRemoteRevision(apiCtx(), msg.revision).catch((error) => {
            reportAutomaticRefreshError("quickPhrasesRefresh", error, { revision: msg.revision }, "常用提示词刷新失败");
          });
        }
        return;
      }
      if (msg.t === "conversation.event") {
        if (localSubscribedWorkspaceId) return;
        if (!currentSubscribedWorkspaceId || String(msg.event.workspaceId) !== String(currentSubscribedWorkspaceId)) return;
        enqueueConversationEvent(msg.event);
        return;
      }
      if (msg.t === "conversation.changed") {
        if (localSubscribedWorkspaceId || !currentSubscribedWorkspaceId || msg.workspaceId !== currentSubscribedWorkspaceId) return;
        enqueuePresentationChange(msg);
        return;
      }
      if (msg.t === "orchestration.event") {
        if (!currentSubscribedWorkspaceId || String(msg.workspaceId) !== String(currentSubscribedWorkspaceId)) return;
        deps.chat.handleOrchestrationEvent(msg.event);
        void deps.orchestration?.onOrchestrationEvent(apiCtx(), msg.workspaceId, msg.event, {
          allowNetworkHydration: () => !deps.ui || deps.ui.mainView === "orchestration",
        }).catch((error) => {
          reportAutomaticRefreshError("orchestrationEventRefresh", error, {
            workspaceId: String(msg.workspaceId),
            eventType: msg.event.type,
          });
        });
        return;
      }
      if (msg.t === "presence.event") {
        if (msg.event.type === "presence.updated") {
          const sharedPresenceActive = Boolean(currentSubscribedWorkspaceId && parseSharedWorkspaceSelectionId(currentSubscribedWorkspaceId));
          if (!sharedPresenceActive) {
            const resolvedWorkspaceId = resolveStickyWorkspaceSelection({
              currentWorkspaceId: deps.config.workspaceId,
              candidates: deps.workspaces?.workspaces.map((workspace) => String(workspace.id)) ?? [],
            });
            if (resolvedWorkspaceId && resolvedWorkspaceId !== deps.config.workspaceId) {
              deps.config.switchWorkspace(resolvedWorkspaceId, { preservePrimaryThreadUrl: true });
            }

            const nextSignature = getOnlineClientsSignature(msg.event.payload.onlineClients);
            if (nextSignature !== lastOnlineClientsSignature) {
              lastOnlineClientsSignature = nextSignature;
              if (msg.event.payload.onlineClients.length) refreshWorkspacesIfNeeded("presence", undefined, msg.event.payload.onlineClients);
              else clearWorkspacesIfNeeded();
            }
          }
          syncTerminalOnlineClients(msg.event.payload.onlineClients.map((client) => client.clientId));
        }
        deps.presence.applyPresenceEvent(msg.event, {
          activeWorkspaceId: currentSubscribedWorkspaceId,
          epoch: subscriptionEpoch,
        });
        return;
      }
      if (msg.t === "sharedWorkspace.event") {
        const activeSharedWorkspaceId = currentSubscribedWorkspaceId
          ? parseSharedWorkspaceSelectionId(currentSubscribedWorkspaceId)
          : null;
        if (!activeSharedWorkspaceId || String(msg.event.sharedWorkspaceId) !== String(activeSharedWorkspaceId)) return;
        deps.sharedWorkspaces?.applyTopicEvent(msg.event);
        return;
      }
      if (msg.t.startsWith("terminal.")) {
        const terminalMessage = msg as TerminalWireMessage;
        if (terminalMessage.t !== "terminal.listAll.result") {
          const target = terminalMessage.t === "terminal.created" ? terminalMessage.terminal : terminalMessage;
          if (target.clientId === deps.config.desktopClient?.clientId && target.workspaceId === localSubscribedWorkspaceId
            && target.workspaceId === deps.config.workspaceId && isLocalDesktopTerminalMode(deps.config, target.workspaceId)) return;
        }
        applyTerminalMessage(msg as TerminalWireMessage);
        return;
      }
      if (msg.t === "error") {
        if (workspaceSubscriptionWaiter && msg.requestId === workspaceSubscriptionWaiter.requestId) {
          const waiter = workspaceSubscriptionWaiter;
          workspaceSubscriptionWaiter = null;
          waiter.reject(Object.assign(new Error(msg.message), { code: msg.errorCode, requestId: msg.requestId }));
          return;
        }
        if (sharedWorkspaceSubscriptionWaiter && msg.requestId === sharedWorkspaceSubscriptionWaiter.requestId) {
          const waiter = sharedWorkspaceSubscriptionWaiter;
          sharedWorkspaceSubscriptionWaiter = null;
          waiter.reject(new Error(msg.message));
          return;
        }
        // 服务端拒绝时，两侧订阅状态可能已经失配（例如重连窗口内激活在发订阅前就退出，
        // 服务端该会话的 activeWorkspaceId 一直为空）。这里按本地订阅事实补一次激活，
        // 否则页面继续用旧内容渲染，任何写操作都只会重复报同一句错。
        if (!workspaceSubscriptionMatchesSelection(currentSubscribedWorkspaceId, deps.config.workspaceId)) {
          deps.chat.requestWorkspaceHydration();
        }
        if (isWorkspaceClientOfflineError(msg.message)) {
          console.debug("[ws.serverError.clientOffline]", {
            workspaceId: String(currentSubscribedWorkspaceId ?? deps.config.workspaceId ?? ""),
            reason: msg.message,
          });
          return;
        }
        if (!shouldReportAuthError(msg.message, "serverError", {
          workspaceId: String(currentSubscribedWorkspaceId ?? deps.config.workspaceId ?? ""),
        })) return;
        deps.onError?.(msg.message);
      }
    };
  };

  const startOpen = (mode: "connect" | "reconnect"): Promise<void> => {
    if (openingPromise) return openingPromise;
    openingPromise = openWs(mode).finally(() => {
      openingPromise = null;
    });
    return openingPromise;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(8_000, 1_200 + reconnectAttempt * 600);
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void startOpen("reconnect").catch((error) => {
        handlePreOpenFailure(error);
      });
    }, delay);
  };

  const connect = async () => {
    stopped = false;
    if (!visibilityRefreshAttached && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityRefresh);
      visibilityRefreshAttached = true;
    }
    syncTenantEpoch();
    lastOnlineClientsSignature = "__init__";
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      await startOpen("connect");
      // disconnect 后立即 connect 可能先复用被 epoch 作废的旧 open；其收口后再发起当前连接。
      if (!stopped && !ws) await startOpen("connect");
    } catch (error) {
      handlePreOpenFailure(error);
      throw error;
    }
  };

  const disconnect = () => {
    stopped = true;
    if (visibilityRefreshAttached && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityRefresh);
      visibilityRefreshAttached = false;
    }
    connectionEpoch += 1;
    lastOnlineClientsSignature = "__init__";
    clearEngineEventBuffer();
    clearGitStatusRefreshTimer();
    deps.presence.ready = false;
    syncTerminalOnlineClients([]);
    reminderRefreshCoordinator.cancel();
    activeSubscriptionRequestId = null;
    currentSubscribedWorkspaceId = null;
    rejectWorkspaceSubscriptionWaiter("disconnect");
    rejectSharedWorkspaceSubscriptionWaiter("disconnect");
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    ws?.close(1000, "disconnect");
    ws = null;
    deps.config.setConnectionStatus("disconnected");
  };

  /** 发送 WebSocket 消息，并让调用方显式处理未连接状态。 */
  const send = (msg: WebToServerMessage): boolean => {
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  const subscribeSharedWorkspace = (sharedWorkspaceId: string, opts?: { sinceSeq?: number }) => {
    const normalizedSharedWorkspaceId = String(sharedWorkspaceId ?? "").trim();
    if (!normalizedSharedWorkspaceId) return Promise.reject(new Error("sharedWorkspaceId 不能为空"));
    const sinceSeqRaw = Number(opts?.sinceSeq ?? 0);
    const sinceSeq = Number.isFinite(sinceSeqRaw) && sinceSeqRaw > 0 ? Math.floor(sinceSeqRaw) : 0;
    rejectWorkspaceSubscriptionWaiter("scope-change");
    rejectSharedWorkspaceSubscriptionWaiter("scope-change");
    subscriptionEpoch += 1;
    const requestId = `swsub-${tenantEpoch}-${connectionEpoch}-${subscriptionEpoch}-${Date.now()}`;
    activeSubscriptionRequestId = requestId;
    currentSubscribedWorkspaceId = makeSharedWorkspaceSelectionId(normalizedSharedWorkspaceId) as WorkspaceId;
    clearEngineEventBuffer();
    if (!ws || ws.readyState !== ws.OPEN) {
      return Promise.reject(createCancelledRequestError("disconnect"));
    }
    send({
      t: "sharedWorkspace.subscribe",
      message: {
        requestId,
        sharedWorkspaceId: normalizedSharedWorkspaceId,
        sinceSeq,
      },
    });
    return new Promise<{ requestId: string; subscriptionEpoch: number; workspaceId: WorkspaceId; sharedWorkspaceId: string; bufferedCount: number }>((resolve, reject) => {
      sharedWorkspaceSubscriptionWaiter = {
        requestId,
        subscriptionEpoch,
        sharedWorkspaceId: normalizedSharedWorkspaceId,
        resolve,
        reject,
      };
    });
  };

  const unsubscribeSharedWorkspace = (sharedWorkspaceId: string) => {
    const workspaceId = makeSharedWorkspaceSelectionId(sharedWorkspaceId) as WorkspaceId;
    if (String(currentSubscribedWorkspaceId) === String(workspaceId)) {
      currentSubscribedWorkspaceId = null;
      activeSubscriptionRequestId = null;
      clearEngineEventBuffer();
      rejectSharedWorkspaceSubscriptionWaiter("scope-change");
    }
    send({
      t: "sharedWorkspace.unsubscribe",
      message: {
        sharedWorkspaceId,
      },
    });
  };

  return {
    connect,
    disconnect,
    send,
    sendTerminal,
    replaceWorkspaceSubscription,
    replaceLocalWorkspaceSubscription,
    receiveDesktopEvent,
    subscribeSharedWorkspace,
    unsubscribeSharedWorkspace,
  };
}

type TerminalWireMessage = Extract<ServerToWebMessage, { t:
  | "terminal.created" | "terminal.output" | "terminal.exited" | "terminal.closed" | "terminal.listed"
  | "terminal.listAll.result" | "terminal.renamed" | "terminal.foregroundChanged" | "terminal.error" }>;

type TerminalSendMessage = Extract<WebToServerMessage, { t:
  | "terminal.create" | "terminal.input" | "terminal.resize" | "terminal.close"
  | "terminal.rename" | "terminal.list" | "terminal.listAll" | "terminal.runAction" }>;

/** 标识必须携带 Server 可信终端归属的实时消息。 */
function terminalMessageRequiresOwnership(type: ServerToWebMessage["t"]): boolean {
  return type === "terminal.output"
    || type === "terminal.exited"
    || type === "terminal.closed"
    || type === "terminal.listed"
    || type === "terminal.renamed"
    || type === "terminal.foregroundChanged";
}

function getOnlineClientsSignature(clients: Array<{ clientId: string; workspaceIds: string[] }>): string {
  return clients
    .map((client) => {
      const workspaceIds = Array.isArray(client.workspaceIds) ? [...client.workspaceIds].sort().join(",") : "";
      return `${client.clientId}:${workspaceIds}`;
    })
    .sort()
    .join("|");
}

function safeParse(raw: unknown): ServerToWebMessage | null {
  try {
    const text = typeof raw === "string" ? raw : String(raw ?? "");
    return JSON.parse(text) as ServerToWebMessage;
  } catch {
    return null;
  }
}
