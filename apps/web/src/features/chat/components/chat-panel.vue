<script setup lang="ts">
import { Comment, Fragment, Text, computed, defineAsyncComponent, inject, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, provide, ref, useSlots, watch, type Slot, type VNode } from "vue";
import { useRoute } from "vue-router";
import type { ConversationMessage, ThreadId, ThreadSummary, TurnId, WorkspaceId } from "@codeflowai/shared";
import { message, Modal } from "ant-design-vue";

import { isApiResultError, isCancelledRequestError } from "../../../api/request";
import { useApiContext } from "../../../composables/useApiContext";
import { copyToClipboard } from "../../../composables/useClipboard";
import { useChatStore } from "../../../store/chat";
import { useComposerStore } from "../../../store/composer";
import { useConfigStore } from "../../../store/config";
import { useEngineStore } from "../../../store/engine";
import { useReminderStore } from "../../../store/reminders";
import { getConversationItemsForMessageList, getPendingInteractionItems, getPendingInteractionState, isConversationActivelyProcessing, isConversationAwaitingInteraction, isConversationRunning } from "../chatTypes";
import { formatToolDisplayName } from "../toolDisplayName";
import { buildRollbackFeedback } from "../rollbackUiState";
import { getThreadIdFromUrl, THREAD_URL_CHANGED_EVENT } from "../../threads/thread-url";
import TodolistBar from "./todolist-bar.vue";
import ManagedServicesPanel from "./managed-services-panel.vue";
import ThreadQueueBar from "./thread-queue-bar.vue";
import ChatWorkflowPanel from "./chat-workflow-panel.vue";
import UserMessageFloat from "./user-message-float.vue";
import { useThreadQueueStore } from "../../../store/threadQueue";
import ManagedServicesModal from "./managed-services-drawer.vue";
import ChatComposer from "../../composer/components/chat-composer.vue";
import KnowledgeThreadContext from "../../project-knowledge/components/knowledge-thread-context.vue";
import { isKnowledgeThread } from "../../threads/thread-list-navigation";
import MessagesList from "../../messages/components/messages-list.vue";
import RollbackConfirmModal from "./rollback-confirm-modal.vue";
import { prepareConversationItemsForDisplay } from "../../messages/prepareConversationItems";
import { dismissedSystemMessageIds, dismissSystemMessage } from "../../messages/dismissedSystemMessages";
import { canLoadMoreHistoryOnUnscrollableWheel, canLoadMoreHistoryOnUserScroll, shouldAutofillInitialHistory } from "../historyLoadPolicy";
import PendingInteractionStack from "./pending-interaction-stack.vue";
import IconClaude from "../../../shared/icons/IconClaude.vue";
import IconCodex from "../../../shared/icons/IconCodex.vue";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { isDesktopWorkspace } from "../../../services/desktop";
import { APP_MODALS_KEY } from "../../../services/appModals";
import { localModelSetupGuideActive, localModelSetupGuideWorkspaceId } from "../../settings/localModelSetupGuideState";

defineOptions({ name: "ChatPanel" });

/** 文件差异预览仅在会话确有文件变更时加载，避免首屏引入 Monaco。 */
const FileChangesPanel = defineAsyncComponent(() => import("./file-changes-panel.vue"));

type Props = {
  workspaceId: WorkspaceId;
  /** 可选：嵌入模式下指定要展示的 thread，而不是使用全局选中会话。 */
  threadId?: ThreadId | null;
  /** 助手模式：复用会话窗口，但关闭回滚/文件变更等普通 thread 特有能力。 */
  assistantMode?: boolean;
  /** 强制禁用输入框，但保留会话查看能力。 */
  composerDisabled?: boolean;
  /** 受控写入会话需要在停止后重新授权下一条消息。 */
  allowQueue?: boolean;
  preserveDraftOnDisable?: boolean;
  /** 暂缓发送时允许编写草稿，真实只读、失效和维护状态仍禁止编辑。 */
  allowDraftWhenDisabled?: boolean;
  /** 嵌入页已展示上下文只读提示时，隐藏通用共享会话只读横幅。 */
  hideThreadReadOnlyNotice?: boolean;
  /** H5 仅改变会话呈现密度与输入栏，不改变消息和发送逻辑。 */
  surface?: "default" | "h5";
  /** 嵌入页面负责声明当前会话是否可见，避免依赖全局聊天选择。 */
  interactionActive?: boolean;
};

const props = withDefaults(defineProps<Props>(), {
  surface: "default",
  allowQueue: true,
  preserveDraftOnDisable: false,
  allowDraftWhenDisabled: false,
  interactionActive: undefined,
});
const slots = useSlots();

type SharedThreadSummary = ThreadSummary & {
  readOnly?: boolean;
  sharedContext?: { readOnly?: boolean } | null;
};

const config = useConfigStore();
const chat = useChatStore();
const composer = useComposerStore();
const engines = useEngineStore();
const reminders = useReminderStore();
const { ctx } = useApiContext();
const appModals = inject(APP_MODALS_KEY, null);

/** 空会话引导入口：打开设置的大模型 Key 页签。 */
function openModelKeySettings(): void {
  appModals?.openSettings("engine-keys");
}

/** 仅当前面板对应当前引导工作区时展示入口，避免嵌入其它工作区复用状态。 */
const showModelSetupEntry = computed(() =>
  localModelSetupGuideActive.value && localModelSetupGuideWorkspaceId.value === String(props.workspaceId),
);

/** 摘要刷新失败保留可见失败态；用户重试仍走轻量读取入口。 */
function retryThreadPresentation(): void {
  const threadId = activeThreadId.value;
  if (!threadId) return;
  refreshVisibleThreadPresentation(props.workspaceId, threadId);
}

/** 重新展示时补齐后台积累的权威快照；失败保留 store 错误态供面板重试。 */
function refreshVisibleThreadPresentation(workspaceId: WorkspaceId, threadId: ThreadId): void {
  void chat.refreshThreadPresentation(ctx.value, { workspaceId, threadId, visibleOnly: true }).catch((error: unknown) => {
    const failure = error as { code?: string; details?: { requestId?: string; serverRequestId?: string } };
    console.error("[THREAD_PRESENTATION_REFRESH_FAILED]", { code: failure?.code ?? "THREAD_PRESENTATION_REFRESH_FAILED",
      requestId: failure?.details?.requestId ?? failure?.details?.serverRequestId ?? null,
      workspaceId, threadId, cause: error instanceof Error ? error.message : String(error) });
  });
}
const route = useRoute();
const threadUrlTick = ref(0);

const activeThreadId = computed<ThreadId | null>(() => props.threadId ?? chat.selectedThreadId);
// 登记跟随面板挂载、KeepAlive 和嵌入页面可见性，独立于主会话激活流水线。
const presentationSurfaceOwner = {};
const presentationSurfaceActive = ref(false);
watch(
  () => [props.workspaceId, activeThreadId.value, presentationSurfaceActive.value && props.interactionActive !== false,
    activeThreadId.value ? Boolean(chat.loadedThreads[activeThreadId.value]) : false, chat.loadedThreads] as const,
  ([workspaceId, threadId, visible, loaded]) => {
    chat.setThreadPresentationSurface(presentationSurfaceOwner, visible && threadId ? { workspaceId, threadId } : null);
    if (!visible || !threadId || !loaded) return;
    const key = String(threadId);
    if ((chat.threadPresentationRequiredVersionByThreadId[key] ?? 0) > (chat.threadPresentationVersionByThreadId[key] ?? 0)
      || chat.threadPresentationErrorByThreadId[key]) refreshVisibleThreadPresentation(workspaceId, threadId);
  },
  { immediate: true, flush: "sync" },
);
onMounted(() => { presentationSurfaceActive.value = true; });
onActivated(() => { presentationSurfaceActive.value = true; });
onDeactivated(() => { presentationSurfaceActive.value = false; });
onUnmounted(() => {
  presentationSurfaceActive.value = false;
  chat.setThreadPresentationSurface(presentationSurfaceOwner, null);
});
const processCacheEpoch = computed(() => activeThreadId.value ? chat.threadContentEpochByThreadId[activeThreadId.value] : 0);
const isRouteDrivenPrimarySurface = computed(() =>
  route.name === "chat" && (!props.threadId || String(props.threadId) === String(chat.primaryThreadId ?? "")),
);
const routeRequestedThreadId = computed<ThreadId | null>(() => {
  threadUrlTick.value;
  void route.fullPath;
  if (!isRouteDrivenPrimarySurface.value) return null;
  if (typeof window !== "undefined") {
    return getThreadIdFromUrl();
  }
  const routeThreadId = String(route.query.threadId ?? "").trim();
  return routeThreadId ? (routeThreadId as ThreadId) : null;
});
const thread = computed(() => {
  const id = activeThreadId.value;
  if (!id) return null;
  return chat.threadSummaryById(id);
});
/** 本机已接入的聊天、需求分析、节点和知识线程直接使用 Client。 */
const localChatReady = computed(() => isDesktopWorkspace(config, props.workspaceId)
  && Boolean(thread.value && (thread.value.threadType === "chat" && (!thread.value.threadSubtype || thread.value.threadSubtype === "requirement-analysis" || thread.value.threadSubtype === "node-discussion" || thread.value.threadSubtype === "knowledge-conversation")
    || thread.value.threadType === "orchestration" && (thread.value.threadSubtype === "node" || thread.value.threadSubtype === "knowledge-assets"))));
const chatConnected = computed(() => config.connected || localChatReady.value);
/** 主会话中的规格线程复用助手边界；嵌入规格库时继续由原页面管理授权。 */
const primaryKnowledgeThread = computed(() => !props.assistantMode && (route.name === "chat" || route.name === "h5") && Boolean(thread.value && isKnowledgeThread(thread.value)));
const effectiveAssistantMode = computed(() => props.assistantMode || Boolean(thread.value && isKnowledgeThread(thread.value)));
const knowledgeReady = ref<{ threadId: string; canContinue: boolean }>({ threadId: "", canContinue: false });
const isSharedWorkspace = computed(() => isSharedWorkspaceSelectionId(props.workspaceId));
const sharedThread = computed(() => thread.value as SharedThreadSummary | null);
/** 共享团队可见但与当前成员无关的会话只允许查看，不能输入或执行维护操作。 */
const threadReadOnly = computed(() =>
  Boolean(sharedThread.value?.readOnly || sharedThread.value?.sharedContext?.readOnly),
);
/** 主动推荐开关与工作流面板同源可见性：仅普通 chat 会话且非助手模式。 */
const chatWorkflowVisible = computed(() => {
  const current = thread.value;
  return Boolean(current && current.threadType === "chat" && !current.threadSubtype && !props.assistantMode);
});
/** WorkFlow 开关只在桌面普通会话工具栏提供入口，H5 不渲染。 */
const chatWorkflowToggleVisible = computed(() => chatWorkflowVisible.value && props.surface !== "h5");
const primaryRouteResolution = computed(() => (isRouteDrivenPrimarySurface.value ? chat.primaryRouteResolution : null));
const routeThreadSwitchPending = computed(() => {
  const requestedThreadId = routeRequestedThreadId.value;
  if (!requestedThreadId) return false;
  return String(requestedThreadId) !== String(activeThreadId.value ?? "");
});
/** 只在确实存在选中/解析中的目标会话时展示打开占位，避免无选中态误显示为加载中。 */
const showPendingThreadSelectionPlaceholder = computed(() =>
  Boolean(
    !thread.value
    && (
      activeThreadId.value
      || (routeThreadSwitchPending.value && primaryRouteResolution.value?.status === "resolving")
      || primaryRouteResolution.value?.status === "retryable"
    ),
  ),
);
const pendingThreadSelectionPlaceholderText = computed(() => {
  if (primaryRouteResolution.value?.status === "retryable") {
    return primaryRouteResolution.value.message ?? "当前会话暂时不可用，请稍后重试。";
  }
  return "正在打开会话…";
});
const conversation = computed(() => {
  const id = activeThreadId.value;
  if (!id) return null;
  return chat.conversations[String(id)] ?? null;
});
const effectiveRunningState = computed(() => chat.threadDisplayRunningStateForThread(activeThreadId.value));
const displayConversation = computed(() => chat.threadDisplayConversationForThread(activeThreadId.value));
const pendingInteractionOwner = "assistant-helper" as const;
const messageListItems = computed(() => getConversationItemsForMessageList(displayConversation.value, { pendingInteractionOwner }));
/** 当前会话已被用户关闭的提示条 id（持久层 ∪ 会话层）。 */
const dismissedSystemMessageIdsForThread = computed(() => dismissedSystemMessageIds(String(activeThreadId.value ?? "")));
/**
 * 过滤掉已被用户点 ✕ 关闭的提示条。
 * 提示条由事件回放重建，不过滤则刷新/切会话后会带着同一稳定 id 再次出现。
 */
const displayItems = computed(() =>
  prepareConversationItemsForDisplay(messageListItems.value)
    .filter((item) => item.kind !== "systemMessage" || !dismissedSystemMessageIdsForThread.value.has(String(item.id))),
);
const threadLoading = computed(() => chat.threadLoading);
const RUNNING_STATE_RECONCILE_INTERVAL_MS = 5_000;
let runningStateReconcileTimer: ReturnType<typeof setInterval> | null = null;
let runningStateReconcileKey = "";
let runningStateReconcileInFlight = false;
let runningStateReconcileGeneration = 0;

/** 运行中定期读取权威摘要；若实时终态漏到页面，自动回放一次会话历史。 */
function stopRunningStateReconcile(): void {
  runningStateReconcileGeneration += 1;
  if (runningStateReconcileTimer) clearInterval(runningStateReconcileTimer);
  runningStateReconcileTimer = null;
  runningStateReconcileKey = "";
  runningStateReconcileInFlight = false;
}

function startRunningStateReconcile(): void {
  stopRunningStateReconcile();
  const threadId = activeThreadId.value;
  // 本机实时事件与摘要同源；不再定时回放，避免本地工作区周期性刷新会话。
  if (!threadId || !chatConnected.value || !effectiveRunningState.value?.runningTurnId || localChatReady.value) return;
  const workspaceId = props.workspaceId;
  const key = `${String(workspaceId)}:${String(threadId)}:${String(effectiveRunningState.value.runningTurnId)}`;
  const generation = runningStateReconcileGeneration;
  runningStateReconcileKey = key;
  runningStateReconcileTimer = setInterval(() => {
    if (runningStateReconcileGeneration !== generation || runningStateReconcileKey !== key) return;
    if (runningStateReconcileInFlight) return;
    runningStateReconcileInFlight = true;
    void chat.syncThreadSummaryState(ctx.value, { workspaceId, threadId }).then(async (running) => {
      if (running || runningStateReconcileGeneration !== generation) return;
      if (String(activeThreadId.value ?? "") !== String(threadId)
        || String(props.workspaceId) !== String(workspaceId)) return;
      await chat.loadThread(ctx.value, {
        workspaceId,
        threadId,
        limit: chat.threadLoadMetaByThreadId[String(threadId)]?.limit,
      });
    }).catch((error: unknown) => {
      console.warn("[ChatPanel] running state reconciliation failed", {
        code: "CHAT_RUNNING_STATE_RECONCILE_FAILED",
        requestId: `chat-running-reconcile-${String(threadId)}`,
        workspaceId: String(workspaceId),
        threadId: String(threadId),
        rootCause: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      if (runningStateReconcileGeneration === generation) runningStateReconcileInFlight = false;
    });
  }, RUNNING_STATE_RECONCILE_INTERVAL_MS);
}

watch(
  () => [props.workspaceId, activeThreadId.value, effectiveRunningState.value?.runningTurnId ?? null, chatConnected.value] as const,
  () => {
    if (!activeThreadId.value || !effectiveRunningState.value?.runningTurnId || !chatConnected.value) {
      stopRunningStateReconcile();
      return;
    }
    const expectedKey = `${String(props.workspaceId)}:${String(activeThreadId.value)}:${String(effectiveRunningState.value.runningTurnId)}`;
    if (runningStateReconcileKey !== expectedKey) startRunningStateReconcile();
  },
  { immediate: true },
);

const loadMeta = computed(() => {
  const id = activeThreadId.value;
  if (!id) return null;
  const loading = chat.threadLoading;
  if (loading && String(loading.threadId) !== String(id)) return null;
  return chat.threadLoadMetaByThreadId[String(id)] ?? null;
});

const isLoadingSelectedThread = computed(() => {
  const loading = threadLoading.value;
  return Boolean(loading && activeThreadId.value && loading.threadId === activeThreadId.value);
});
const isAutofillingInitialHistory = ref(false);
const selectedThreadLoadingText = computed(() => {
  const loading = threadLoading.value;
  if (!loading || !activeThreadId.value || loading.threadId !== activeThreadId.value) return "";
  if (loading.stage === "fetching") return "读取事件中…";
  return `回放中 ${loading.processedEvents} / ${loading.totalEvents}`;
});
const showBlockingThreadLoading = computed(() => isLoadingSelectedThread.value || isAutofillingInitialHistory.value);
/** 仅首屏无内容时遮挡；已有消息的后台同步和补页保持内容可见，避免整块闪烁。 */
const showThreadLoadingOverlay = computed(() => showBlockingThreadLoading.value && displayItems.value.length === 0);
const blockingThreadLoadingText = computed(() => {
  if (isLoadingSelectedThread.value) return selectedThreadLoadingText.value;
  if (isAutofillingInitialHistory.value) return "补齐历史中…";
  return "";
});

const canWrite = computed(() => {
  if (!activeThreadId.value) return false;
  if (threadReadOnly.value) return false;
  if (conversation.value?.invalidated) return false;
  return true;
});

const messagesEl = ref<HTMLElement | null>(null);
const messagesInnerEl = ref<HTMLElement | null>(null);
const composerHostEl = ref<HTMLElement | null>(null);
provide("virtualScrollRoot", messagesEl);
const stickToBottom = ref(true);
const nearTop = ref(false);
const userScrolledSinceSelect = ref(false);
const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null);
const composerViewportWidth = ref(0);
const maintenanceBusy = ref(false);
const deletingMessageId = ref<string | null>(null);
const messageDeleteConfirmationOpen = ref(false);
const rollbackModalOpen = ref(false);
const rollbackTargetTurnId = ref<string | null>(null);
const isMobileViewport = ref(false);
const now = ref(Date.now());
let timer: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let composerLayoutObserver: ResizeObserver | null = null;
let autoScrollRaf: number | null = null;
let suppressScrollEvents = false;
let nearTopDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let managedServiceDetailPollTimer: ReturnType<typeof setInterval> | null = null;
let initialHistoryAutofillRunId = 0;
let lastInitialHistoryContentKey = "";

function handleThreadUrlChanged(): void {
  threadUrlTick.value += 1;
}

/** 是否接近顶部（用于显示“更多历史”）。 */
function isNearTop(el: HTMLElement): boolean {
  const thresholdPx = 80;
  return el.scrollTop < thresholdPx;
}

function isNearBottom(el: HTMLElement): boolean {
  const thresholdPx = 80;
  return el.scrollHeight - el.scrollTop - el.clientHeight < thresholdPx;
}

/** 会话内选中文本右键菜单：仅接管消息区内的非空选区，空选区保留浏览器默认行为。 */
const selectionMenu = ref<{ x: number; y: number; text: string } | null>(null);
const selectionMenuEl = ref<HTMLElement | null>(null);

function onMessagesContextMenu(event: MouseEvent): void {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";
  const anchorNode = selection?.anchorNode ?? null;
  const anchorElement = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement ?? null;
  if (!text || !anchorElement || !messagesEl.value?.contains(anchorElement)) return;
  event.preventDefault();
  // 菜单尺寸固定，按视口边界回推位置，避免贴边被裁切。
  selectionMenu.value = {
    x: Math.max(4, Math.min(event.clientX, window.innerWidth - 172)),
    y: Math.max(4, Math.min(event.clientY, window.innerHeight - 88)),
    text,
  };
}

function closeSelectionMenu(): void {
  selectionMenu.value = null;
}

/** 复制选区文本；失败时显式提示，不静默忽略。 */
async function copySelectionText(): Promise<void> {
  const text = selectionMenu.value?.text ?? "";
  closeSelectionMenu();
  if (!text) return;
  try {
    await copyToClipboard(text);
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  }
}

/** 把选区追加到当前会话输入框，复用 composer 的外部动作队列。 */
function addSelectionToComposer(): void {
  const text = selectionMenu.value?.text ?? "";
  const threadId = activeThreadId.value;
  closeSelectionMenu();
  if (!text || !threadId || !canWrite.value) return;
  composer.enqueueExternalAction({ workspaceId: props.workspaceId, threadId, kind: "append-text", text });
}

/** 点击菜单外部或按 Esc 关闭菜单。 */
function onSelectionMenuDismiss(event: MouseEvent | KeyboardEvent): void {
  if (!selectionMenu.value) return;
  if (event instanceof KeyboardEvent) {
    if (event.key === "Escape") closeSelectionMenu();
    return;
  }
  const target = event.target;
  if (target instanceof Node && selectionMenuEl.value?.contains(target)) return;
  closeSelectionMenu();
}

/** 用户未主动上滑时，让消息区在流式输出过程中自动滚动到底部。 */
function onMessagesScroll(): void {
  closeSelectionMenu();
  const el = messagesEl.value;
  if (!el) return;
  if (suppressScrollEvents) return;
  userScrolledSinceSelect.value = true;
  stickToBottom.value = isNearBottom(el);
  nearTop.value = isNearTop(el);
}

/** 无滚动条时承接向上滚轮意图，避免历史分页失去触发入口。 */
function onMessagesWheel(event: WheelEvent): void {
  const el = messagesEl.value;
  const meta = loadMeta.value;
  if (!el || !meta) return;
  if (!canLoadMoreHistoryOnUnscrollableWheel({
    deltaY: event.deltaY,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    hasMore: Boolean(meta.hasMore),
    loadingMore: Boolean(meta.loadingMore),
    blockingThreadLoading: showBlockingThreadLoading.value,
  })) return;

  userScrolledSinceSelect.value = true;
  stickToBottom.value = false;
  void autoLoadMoreHistory();
}

function scrollToBottom(): void {
  const el = messagesEl.value;
  if (!el) return;
  suppressScrollEvents = true;
  el.scrollTop = el.scrollHeight;
  stickToBottom.value = true;
  nearTop.value = false;
  requestAnimationFrame(() => {
    suppressScrollEvents = false;
  });
}

/** 将指定消息滚动到可视区并短暂高亮，供 H5 历史搜索定位。 */
function locateMessage(messageId: string): boolean {
  const root = messagesEl.value;
  const normalizedId = String(messageId ?? "").trim();
  if (!root || !normalizedId) return false;
  const target = Array.from(root.querySelectorAll<HTMLElement>("[data-message-id]"))
    .find((element) => element.dataset.messageId === normalizedId);
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("msg-row--located");
  window.setTimeout(() => target.classList.remove("msg-row--located"), 1_800);
  return true;
}

/** 浮窗收起偏好：跨会话记住，刷新后保持。 */
const USER_MESSAGE_FLOAT_COLLAPSED_KEY = "codeflow-chat-user-message-float-collapsed";

function readUserMessageFloatCollapsed(): boolean {
  try {
    return window.localStorage.getItem(USER_MESSAGE_FLOAT_COLLAPSED_KEY) === "1";
  } catch (error) {
    console.warn("[chat-panel] user message float preference read failed", { error });
    return false;
  }
}

/** 记录浮窗收起偏好；写失败只影响下次打开时的默认值，不影响本次界面。 */
function persistUserMessageFloatCollapsed(): void {
  try {
    window.localStorage.setItem(USER_MESSAGE_FLOAT_COLLAPSED_KEY, floatCollapsed.value ? "1" : "0");
  } catch (error) {
    console.warn("[chat-panel] user message float preference persist failed", { error });
  }
}

const floatCollapsed = ref(readUserMessageFloatCollapsed());

/** 浮窗当前展示的用户消息下标；-1 表示跟随最新一条。 */
const floatMessageIndex = ref(-1);

/** 用户消息序列，作为浮窗上下翻阅的范围。 */
const userMessages = computed(() => displayItems.value.filter(
  (item): item is ConversationMessage => item.kind === "message" && item.role === "user",
));

/** 收敛后的下标：未手动翻阅或越界时都指向最后一条。 */
const resolvedUserMessageIndex = computed(() => {
  const total = userMessages.value.length;
  if (!total) return -1;
  return floatMessageIndex.value < 0 || floatMessageIndex.value >= total ? total - 1 : floatMessageIndex.value;
});

const floatMessage = computed(() => userMessages.value[resolvedUserMessageIndex.value] ?? null);

// 只在「最后一条用户消息」变化时回到最新：加载更早的历史不会打断正在翻阅的位置。
watch(() => userMessages.value.at(-1)?.id ?? null, () => {
  floatMessageIndex.value = -1;
});

/** 定位到浮窗当前消息；目标尚未渲染时提示先向上加载历史。 */
function locateFloatMessage(): void {
  const current = floatMessage.value;
  if (!current) return;
  if (locateMessage(String(current.id))) return;
  message.warning("该消息尚未加载，请先向上加载更多历史");
}

/** 浮窗内容切到上一条用户消息；已在最早一条时保持不动并提示。 */
function showPrevUserMessage(): void {
  const current = resolvedUserMessageIndex.value;
  if (current <= 0) {
    message.info("没有更早的用户消息了");
    return;
  }
  floatMessageIndex.value = current - 1;
}

/** 浮窗内容切到下一条用户消息；已在最新一条时保持不动并提示。 */
function showNextUserMessage(): void {
  const current = resolvedUserMessageIndex.value;
  if (current < 0 || current >= userMessages.value.length - 1) {
    message.info("没有更新的用户消息了");
    return;
  }
  floatMessageIndex.value = current + 1;
}

function toggleUserMessageFloat(): void {
  floatCollapsed.value = !floatCollapsed.value;
  persistUserMessageFloatCollapsed();
}

function syncViewportMode(): void {
  if (typeof window === "undefined") return;
  isMobileViewport.value = window.innerWidth <= 767;
  composerViewportWidth.value = Math.round(composerHostEl.value?.getBoundingClientRect().width ?? 0);
}

/** 内容高度变化（流式 delta / 回放）时，若用户未上滑则自动粘底。 */
function scheduleAutoScrollToBottom(): void {
  if (!stickToBottom.value) return;
  if (autoScrollRaf != null) return;
  autoScrollRaf = requestAnimationFrame(() => {
    autoScrollRaf = null;
    scrollToBottom();
  });
}

const assistantHelperScope = computed(() => ({
  canWrite: canWrite.value
    && !maintenanceBusy.value
    && !conversation.value?.invalidated
    && !catalogSyncIssue.value,
  busy: Boolean(effectiveAssistantMode.value && isConversationRunning(displayConversation.value)),
}));

function hasVisibleSlotNode(node: VNode | null | undefined): boolean {
  if (!node) return false;
  if (node.type === Comment) return false;
  if (node.type === Text) return String(node.children ?? "").trim().length > 0;
  if (node.type === Fragment) {
    return Array.isArray(node.children) && node.children.some((child) => hasVisibleSlotNode(child as VNode));
  }
  return true;
}

function hasVisibleSlotContent(slot: Slot | undefined, scope: { canWrite: boolean; busy: boolean }): boolean {
  if (!slot) return false;
  return slot(scope).some((node) => hasVisibleSlotNode(node));
}

const hasAssistantHelperContent = computed(() =>
  hasVisibleSlotContent(slots["assistant-helper"], assistantHelperScope.value),
);
const hasComposerGuardContent = computed(() =>
  hasVisibleSlotContent(slots["composer-guard"], assistantHelperScope.value),
);
const CATALOG_SYNC_POLL_INTERVAL_MS = 3_000;
const CATALOG_SYNC_WAIT_TIMEOUT_MS = 30_000;
const CATALOG_SYNC_REQUEST_TIMEOUT_MS = 8_000;
const catalogSyncTimedOut = ref(false);
const catalogSyncCheckError = ref<string | null>(null);
let catalogSyncPollTimer: ReturnType<typeof setTimeout> | null = null;
let catalogSyncRequestAbort: AbortController | null = null;
let catalogSyncPollGeneration = 0;
let catalogSyncActiveKey = "";
let catalogSyncDeadline = 0;

/** 当前目录检查失败显式展示并有界重试，切换作用域后只释放请求资源。 */
async function pollCatalogSync(workspaceId: string, generation: number): Promise<void> {
  if (generation !== catalogSyncPollGeneration) return;
  if (Date.now() >= catalogSyncDeadline) {
    catalogSyncTimedOut.value = true;
    return;
  }
  const controller = new AbortController();
  catalogSyncRequestAbort = controller;
  const requestTimer = setTimeout(() => controller.abort(), CATALOG_SYNC_REQUEST_TIMEOUT_MS);
  try {
    await engines.refresh(ctx.value, workspaceId, {
      signal: controller.signal,
      shouldApply: () => generation === catalogSyncPollGeneration && String(props.workspaceId) === workspaceId,
    });
    if (controller.signal.aborted) throw new Error("状态请求超时");
    if (generation === catalogSyncPollGeneration && String(props.workspaceId) === workspaceId) catalogSyncCheckError.value = null;
  } catch (error) {
    if (generation !== catalogSyncPollGeneration || String(props.workspaceId) !== workspaceId) return;
    if (isCancelledRequestError(error) && !controller.signal.aborted) return;
    const details = isApiResultError(error) ? error.details as Record<string, unknown> | undefined : undefined;
    const rootCause = controller.signal.aborted ? "状态请求超时" : error instanceof Error ? error.message : String(error);
    catalogSyncCheckError.value = rootCause;
    console.error("[chat-panel] model catalog check failed", {
      code: "CHAT_MODEL_CATALOG_CHECK_FAILED",
      requestId: details?.requestId ?? (error && typeof error === "object" && "requestId" in error ? error.requestId : null),
      workspaceId, threadId: activeThreadId.value, generation, rootCause,
    });
  } finally {
    clearTimeout(requestTimer);
    if (catalogSyncRequestAbort === controller) catalogSyncRequestAbort = null;
  }
  if (generation !== catalogSyncPollGeneration || String(props.workspaceId) !== workspaceId) return;
  const scoped = engines.byWorkspaceId[workspaceId];
  if (scoped?.hostCatalogSyncState !== "waiting") return;
  if (Date.now() >= catalogSyncDeadline) {
    catalogSyncTimedOut.value = true;
    return;
  }
  catalogSyncPollTimer = setTimeout(() => void pollCatalogSync(workspaceId, generation), CATALOG_SYNC_POLL_INTERVAL_MS);
}

function stopCatalogSyncPolling(): void {
  catalogSyncPollGeneration += 1;
  if (catalogSyncPollTimer) clearTimeout(catalogSyncPollTimer);
  catalogSyncPollTimer = null;
  catalogSyncRequestAbort?.abort();
  catalogSyncRequestAbort = null;
  catalogSyncActiveKey = "";
}

function startCatalogSyncPolling(): void {
  stopCatalogSyncPolling();
  const workspaceId = String(props.workspaceId);
  const scoped = engines.byWorkspaceId[workspaceId];
  if (scoped?.hostCatalogSyncState !== "waiting") return;
  catalogSyncActiveKey = `${workspaceId}:${scoped.catalogVersion ?? "unknown"}`;
  catalogSyncDeadline = Date.now() + CATALOG_SYNC_WAIT_TIMEOUT_MS;
  catalogSyncTimedOut.value = false;
  catalogSyncCheckError.value = null;
  void pollCatalogSync(workspaceId, catalogSyncPollGeneration);
}

function retryCatalogSync(): void {
  startCatalogSyncPolling();
}

watch(
  () => {
    const workspaceId = String(props.workspaceId);
    const scoped = engines.byWorkspaceId[workspaceId];
    return `${workspaceId}:${scoped?.catalogVersion ?? "unknown"}:${scoped?.hostCatalogSyncState ?? "unknown"}`;
  },
  () => {
    const workspaceId = String(props.workspaceId);
    const scoped = engines.byWorkspaceId[workspaceId];
    if (scoped?.hostCatalogSyncState !== "waiting") {
      stopCatalogSyncPolling();
      catalogSyncTimedOut.value = false;
      catalogSyncCheckError.value = null;
      return;
    }
    const key = `${workspaceId}:${scoped.catalogVersion ?? "unknown"}`;
    if (catalogSyncActiveKey !== key) startCatalogSyncPolling();
  },
  { immediate: true },
);

const catalogSyncIssue = computed(() => {
  const state = engines.byWorkspaceId[String(props.workspaceId)]?.hostCatalogSyncState ?? null;
  if (state === "waiting") {
    if (catalogSyncTimedOut.value) return "模型目录同步超时，当前 Client 尚未确认最新目录。请重试同步；若仍失败，请检查 Client 连接。";
    if (catalogSyncCheckError.value) return `检查模型目录同步状态失败：${catalogSyncCheckError.value}。正在自动重试。`;
    return "等待当前工作区的 Client 应用最新模型目录，完成后即可发送。";
  }
  if (state === "unsupported") return "当前工作区的 Client 版本不支持动态模型目录，请升级 Client 后再发送。";
  if (state === "offline") return "当前工作区的 Host Client 已离线，重新上线并同步模型目录后即可发送。";
  return null;
});
const composerBlocked = computed(() => Boolean(props.composerDisabled || catalogSyncIssue.value
  || primaryKnowledgeThread.value && (knowledgeReady.value.threadId !== activeThreadId.value || !knowledgeReady.value.canContinue)));

const pendingInteractionItems = computed(() => getPendingInteractionItems(displayConversation.value));
const hasPendingInteractionHelper = computed(() => pendingInteractionItems.value.length > 0);
const hasAssistantHelperShell = computed(() => hasAssistantHelperContent.value);
const pendingInteraction = computed(() => getPendingInteractionState(displayConversation.value));
const showTypingIndicator = computed(() => isConversationActivelyProcessing(displayConversation.value));
const showPendingIndicator = computed(() =>
  isConversationAwaitingInteraction(displayConversation.value) && !hasPendingInteractionHelper.value && !hasAssistantHelperContent.value,
);
/** 历史已加载且无消息或待处理内容时，显示首条消息引导。 */
const showEmptyConversation = computed(() => Boolean(
  activeThreadId.value && chat.loadedThreads[String(activeThreadId.value)]
  && !showBlockingThreadLoading.value && !loadMeta.value?.hasMore
  && displayItems.value.length === 0 && !conversation.value?.invalidated
  && !showTypingIndicator.value && !showPendingIndicator.value
  && !hasPendingInteractionHelper.value && !hasAssistantHelperShell.value,
));
const listBusy = computed(() => maintenanceBusy.value || showTypingIndicator.value);
const completedTurnIds = computed(() => conversation.value?.completedTurnIds ?? {});

const fileChangesState = computed(() => {
  const id = activeThreadId.value;
  if (!id) return {
    loading: false,
    items: [],
    error: null as string | null,
    version: 0,
    refreshTick: 0,
    hydrated: false,
    stale: false,
  };
  return chat.fileChangesByThreadId[String(id)] ?? {
    loading: false,
    items: [],
    error: null as string | null,
    version: 0,
    refreshTick: 0,
    hydrated: false,
    stale: false,
  };
});
const fileChangeCount = computed(() => fileChangesState.value.items.length);
const fileChangesRefreshTick = computed(() => fileChangesState.value.refreshTick);
const fileChangesStale = computed(() => fileChangesState.value.stale);
const managedServicesScope = computed(() => chat.managedServicesScopeForThread(activeThreadId.value));
const managedServicesVisible = computed(() => managedServicesScope.value.visible && !effectiveAssistantMode.value && !isSharedWorkspace.value);
const managedServicesState = computed(() => {
  return chat.managedServicesStateForThread(activeThreadId.value);
});
const threadActivation = computed(() => chat.threadActivationForThread(activeThreadId.value));
const selectedThreadSettled = computed(() => {
  const phase = threadActivation.value.phase;
  return phase === "settled" || phase === "invalidated";
});
const managedServicesScopeKey = computed(() => String(managedServicesScope.value.threadId ?? "").trim());
const managedServiceCount = computed(() => managedServicesVisible.value ? managedServicesState.value.items.length : 0);
const managedServicesHasLiveItems = computed(() =>
  managedServicesState.value.items.some((item) => item.status === "starting" || item.status === "ready"),
);
const managedServicesPanelVisible = computed(() => managedServicesVisible.value && managedServiceCount.value > 0);
const managedServicesRefreshTick = computed(() => managedServicesState.value.refreshTick);
const managedServicesStale = computed(() => managedServicesState.value.stale);
const activeThreadReminderItems = computed(() =>
  reminders.currentItems.filter((item) =>
    item.sourceType === "chat"
    && String(item.workspaceId ?? "").trim() === String(props.workspaceId ?? "").trim()
    && String(item.routeTarget.threadId ?? "").trim() === String(activeThreadId.value ?? "").trim(),
  ),
);
const threadQueueStore = useThreadQueueStore();
const threadQueueCount = computed(() =>
  activeThreadId.value ? threadQueueStore.itemCountFor(activeThreadId.value) : 0,
);
/** 节点会话保留持久投递能力，但不向用户暴露通用队列控制面板。 */
const showThreadQueuePanel = computed(() =>
  threadQueueCount.value > 0 && thread.value?.threadSubtype !== "node" && !primaryKnowledgeThread.value,
);
const hasAuxiliaryComposerPanels = computed(() =>
  Boolean(
    (!effectiveAssistantMode.value && (
      conversation.value?.currentTodolist
      || fileChangeCount.value > 0
      || managedServicesPanelVisible.value
    ))
    || showThreadQueuePanel.value,
  ),
);
const auxiliaryComposerPanelCount = computed(() =>
  Number(!effectiveAssistantMode.value && Boolean(conversation.value?.currentTodolist))
  + Number(!effectiveAssistantMode.value && fileChangeCount.value > 0)
  + Number(!effectiveAssistantMode.value && managedServicesPanelVisible.value)
  + Number(showThreadQueuePanel.value),
);
const compactComposerAuxThreshold = computed(() => {
  if (auxiliaryComposerPanelCount.value >= 3) return 980;
  if (auxiliaryComposerPanelCount.value === 2) return 860;
  if (auxiliaryComposerPanelCount.value === 1) return 760;
  return 0;
});
const useCompactComposerAux = computed(() => {
  if (!hasAuxiliaryComposerPanels.value) return false;
  if (isMobileViewport.value) return true;
  if (composerViewportWidth.value <= 0) return false;
  return composerViewportWidth.value <= compactComposerAuxThreshold.value;
});
const managedServicesExpanded = ref(false);
const fileChangesExpanded = ref(false);
const threadQueueExpanded = ref(false);
const managedServicesModalOpen = ref(false);
const managedServicesSelectedServiceId = ref<string | null>(null);
const lastFileChangesSettledFetchKey = ref("");
const lastManagedServicesSettledFetchKey = ref("");

watch(
  () => [
    activeThreadId.value ?? "",
    selectedThreadSettled.value,
    activeThreadReminderItems.value.map((item) => item.id).join("|"),
  ] as const,
  ([threadId, settled, reminderSignature]) => {
    if (!threadId || !settled || !reminderSignature) return;
    void reminders.consumeItems(ctx.value, activeThreadReminderItems.value).catch((error: unknown) => {
      if (isCancelledRequestError(error)) return;
      message.error(error instanceof Error ? error.message : String(error));
    });
  },
  { immediate: true },
);

/** 从当前工作区刷新文件变更，失败交给调用边界展示原资源错误态。 */
async function prefetchFileChanges(threadId: ThreadId, opts?: { force?: boolean }): Promise<void> {
  if (isSharedWorkspace.value) return;
  await chat.refreshThreadFileChanges(ctx.value, { workspaceId: props.workspaceId, threadId, force: opts?.force });
}

/** 从当前工作区刷新托管进程，失败交给调用边界展示原资源错误态。 */
async function prefetchManagedServices(threadId: ThreadId, opts?: { force?: boolean }): Promise<void> {
  if (isSharedWorkspace.value) return;
  await chat.refreshThreadManagedServices(ctx.value, { workspaceId: props.workspaceId, threadId, force: opts?.force });
}

async function refreshFileChanges(): Promise<void> {
  const id = activeThreadId.value;
  if (!id) return;
  if (isSharedWorkspace.value) return;
  try {
    await chat.refreshThreadFileChanges(ctx.value, { workspaceId: props.workspaceId, threadId: id, force: true });
  } catch (error) {
    showAsyncError(error);
  }
}

async function refreshManagedServices(): Promise<void> {
  const id = activeThreadId.value;
  if (!id) return;
  if (isSharedWorkspace.value) return;
  try {
    await chat.refreshThreadManagedServices(ctx.value, { workspaceId: props.workspaceId, threadId: id, force: true });
  } catch (error) {
    showAsyncError(error);
  }
}

/** 资源失败由原 store 错误态展示；此边界补充可检索日志与操作反馈。 */
function showAsyncError(error: unknown): void {
  if (isCancelledRequestError(error)) return;
  const rootCause = error instanceof Error ? error.message : String(error);
  const details = isApiResultError(error) ? error.details as { requestId?: unknown } | undefined : undefined;
  // 会话删除后迟到的资源刷新属于预期竞态；记录日志，不再逐条打扰用户。
  if (/本机本地会话不存在|会话已不存在|thread\s*不存在/u.test(rootCause)) {
    console.warn("[chat-panel.operation.thread-missing]", {
      code: isApiResultError(error) ? error.code : "CHAT_PANEL_THREAD_MISSING",
      requestId: details?.requestId ?? null,
      workspaceId: props.workspaceId,
      threadId: activeThreadId.value,
      rootCause,
    });
    return;
  }
  console.error("[chat-panel.operation.failed]", {
    code: isApiResultError(error) ? error.code : "CHAT_PANEL_OPERATION_FAILED",
    requestId: details?.requestId ?? null,
    workspaceId: props.workspaceId,
    threadId: activeThreadId.value,
    error,
  });
  message.error(rootCause);
}

/** 用户手动展开/收起队列浮层；入队时不再自动展开遮挡主界面。 */
function handleThreadQueueExpandedChange(expanded: boolean): void {
  threadQueueExpanded.value = expanded;
}

type ExternalActionComposer = InstanceType<typeof ChatComposer> & {
  appendText?: (value: string) => void;
  sendExternalText?: (value: string) => Promise<boolean>;
  attachTextFile?: (file: import("@codeflowai/shared").TextFileAttachment) => void;
  canAcceptExternalActions?: () => boolean;
};

/** 返回可接收外部回填动作的 Composer 实例。 */
function getExternalActionComposer(): ExternalActionComposer | null {
  return composerRef.value as ExternalActionComposer | null;
}

/** 仅在当前会话可写时消费外部回填动作，失锁期间保留到接管后。 */
function applyExternalComposerActions(): void {
  const threadId = activeThreadId.value;
  const composerInstance = getExternalActionComposer();
  if (!threadId || !composerInstance || !canWrite.value || !composerInstance.canAcceptExternalActions?.()) return;
  const actions = composer.consumeExternalActions(props.workspaceId, threadId);
  for (const action of actions) {
    if (action.kind === "append-text") {
      composerInstance.appendText?.(action.text);
      continue;
    }
    if (action.kind === "send-text") {
      // 一键修复由 Composer 自行校验空闲状态，失败时会给用户明确提示。
      void composerInstance.sendExternalText?.(action.text);
      continue;
    }
    composerInstance.attachTextFile?.(action.file);
  }
}

async function acceptFileChanges(paths: string[]): Promise<void> {
  const id = activeThreadId.value;
  if (!id || !paths.length) return;
  try {
    await chat.acceptFileChanges(ctx.value, { workspaceId: props.workspaceId, threadId: id, paths });
    message.success("已接受");
  } catch (e) {
    showAsyncError(e);
  }
}

async function undoFileChanges(paths: string[] | null): Promise<void> {
  const id = activeThreadId.value;
  if (!id) return;
  maintenanceBusy.value = true;
  try {
    const skipped = await chat.undoThreadFileChanges(ctx.value, { workspaceId: props.workspaceId, threadId: id, paths });
    if (skipped.length) {
      message.warning(`已撤销，${skipped.length} 个文件因缺少快照被跳过`);
    } else {
      message.success("已撤销");
    }
  } catch (e) {
    showAsyncError(e);
  } finally {
    maintenanceBusy.value = false;
  }
}

async function stopManagedService(serviceId: string): Promise<void> {
  const id = activeThreadId.value;
  if (!id || !serviceId) return;
  maintenanceBusy.value = true;
  try {
    await chat.stopThreadManagedService(ctx.value, { workspaceId: props.workspaceId, threadId: id, serviceId });
    message.success(`已停止进程：${serviceId}`);
  } catch (e) {
    showAsyncError(e);
  } finally {
    maintenanceBusy.value = false;
  }
}

function openManagedServiceModal(serviceId: string): void {
  managedServicesSelectedServiceId.value = serviceId;
  managedServicesModalOpen.value = true;
}

/** 确认删除时重新核对会话和写入状态；删除不占用维护锁或停止当前执行。 */
function confirmMessageDelete(itemId: string): void {
  const threadId = activeThreadId.value;
  const workspaceId = props.workspaceId;
  if (!threadId || !canWrite.value || deletingMessageId.value || messageDeleteConfirmationOpen.value) return;
  messageDeleteConfirmationOpen.value = true;
  Modal.confirm({
    title: "删除这条消息？",
    content: "删除后不可恢复。",
    okText: "删除",
    cancelText: "取消",
    okButtonProps: { danger: true },
    afterClose() { messageDeleteConfirmationOpen.value = false; },
    async onOk() {
      try {
        if (activeThreadId.value !== threadId || props.workspaceId !== workspaceId || !canWrite.value) {
          throw new Error("会话或写入状态已变化，请重新确认删除");
        }
        deletingMessageId.value = itemId;
        await chat.deleteThreadMessage(ctx.value, { workspaceId, threadId, itemId });
      } catch (error) {
        showAsyncError(error);
        throw error;
      } finally {
        deletingMessageId.value = null;
      }
    },
  });
}

/** 用户点击回滚按钮：打开确认模态框。 */
function confirmRollback(toTurnId: string): void {
  if (!canWrite.value || maintenanceBusy.value) return;
  rollbackTargetTurnId.value = toTurnId;
  rollbackModalOpen.value = true;
}

/** 关闭弹窗时同时清空目标，避免后续会话复用旧 turn。 */
function setRollbackModalOpen(open: boolean): void {
  rollbackModalOpen.value = open;
  if (!open) rollbackTargetTurnId.value = null;
}

/** 关闭提示条：按会话记住该提示已被用户关闭，刷新后重放事件也不再渲染。 */
function closeSystemMessage(id: string): void {
  const threadId = String(activeThreadId.value ?? "");
  if (!threadId) return;
  dismissSystemMessage(threadId, id);
}

/** 用户在模态框中确认后执行回滚。 */
async function handleRollbackConfirmed(opts: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  toTurnId: TurnId;
  rollbackFiles: boolean;
  skipPaths: string[];
}): Promise<void> {
  const id = activeThreadId.value;
  const toTurnId = rollbackTargetTurnId.value;
  if (!id || !toTurnId) return;
  if (maintenanceBusy.value) return;
  if (
    String(opts.workspaceId) !== String(props.workspaceId)
    || String(opts.threadId) !== String(id)
    || String(opts.toTurnId) !== String(toTurnId)
  ) {
    setRollbackModalOpen(false);
    message.error("回滚目标已变化，请重新打开回滚预览");
    return;
  }

  maintenanceBusy.value = true;
  try {
    const res = await chat.rollbackThread(ctx.value, {
      workspaceId: opts.workspaceId,
      threadId: opts.threadId,
      toTurnId: opts.toTurnId,
      rollbackFiles: opts.rollbackFiles,
      skipPaths: opts.skipPaths,
    });
    const feedback = buildRollbackFeedback(res);
    if (feedback.level === "warning") {
      message.warning(feedback.message);
    } else {
      message.success(feedback.message);
    }
    await nextTick();
    scheduleAutoScrollToBottom();
  } catch (e) {
    showAsyncError(e);
  } finally {
    maintenanceBusy.value = false;
  }
}

watch(
  () => messagesInnerEl.value,
  (el) => {
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;
    resizeObserver = new ResizeObserver(() => scheduleAutoScrollToBottom());
    resizeObserver.observe(el);
  },
  { immediate: true },
);

watch(
  () => composerHostEl.value,
  (el) => {
    if (composerLayoutObserver) composerLayoutObserver.disconnect();
    composerLayoutObserver = null;
    if (!el) {
      composerViewportWidth.value = 0;
      return;
    }
    composerViewportWidth.value = Math.round(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    composerLayoutObserver = new ResizeObserver(() => {
      composerViewportWidth.value = Math.round(el.getBoundingClientRect().width);
    });
    composerLayoutObserver.observe(el);
  },
  { immediate: true },
);

watch(
  () => [props.workspaceId, activeThreadId.value] as const,
  ([wsId, threadId]) => {
    setRollbackModalOpen(false);
    fileChangesExpanded.value = false;
    managedServicesExpanded.value = false;
    threadQueueExpanded.value = false;
    // 切 thread/workspace 时主动拉队列快照：chip 仅在 itemCount > 0 时挂载，
    // 但本地 store 初始为 0，依赖 chip onMounted 拉取会陷入"看不见 → 不拉 → 永远 0"循环。
    // 必须在此处主动 refresh，确保入队 mode / chip 显隐与权威态一致。
    if (wsId && threadId) {
      void threadQueueStore.refresh(ctx.value, wsId, threadId).catch((error) => {
        if (isCancelledRequestError(error)) return;
        const details = isApiResultError(error) ? error.details as { requestId?: unknown } | undefined : undefined;
        const rootCause = error instanceof Error ? error.message : String(error);
        console.warn("[ChatPanel] refreshThreadQueue failed:", {
          code: isApiResultError(error) ? error.code : "THREAD_QUEUE_REFRESH_FAILED",
          requestId: details?.requestId ?? null, workspaceId: wsId, threadId, rootCause,
        });
        if (props.workspaceId === wsId && activeThreadId.value === threadId) message.error(`队列刷新失败：${rootCause}`);
      });
    }
  },
  { immediate: true },
);

watch(
  () => threadQueueCount.value,
  (count) => {
    if (count <= 0) threadQueueExpanded.value = false;
  },
);

watch(
  () => fileChangeCount.value,
  (count) => {
    if (count <= 0) fileChangesExpanded.value = false;
  },
);

const canLoadMoreHistory = computed(() => {
  const meta = loadMeta.value;
  if (!meta) return false;
  return canLoadMoreHistoryOnUserScroll({
    hasMore: Boolean(meta.hasMore),
    loadingMore: Boolean(meta.loadingMore),
    blockingThreadLoading: showBlockingThreadLoading.value,
  });
});

const loadingMoreHistory = computed(() => {
  const meta = loadMeta.value;
  return Boolean(meta?.loadingMore);
});

/** 自动加载更多历史（游标分页 + 滚动保位）。 */
async function autoLoadMoreHistory(): Promise<void> {
  const id = activeThreadId.value;
  if (!id || !canLoadMoreHistory.value) return;

  const el = messagesEl.value;
  if (!el) return;

  const prevScrollHeight = el.scrollHeight;
  const prevScrollTop = el.scrollTop;

  suppressScrollEvents = true;
  try {
    await chat.loadThreadPage(ctx.value, { workspaceId: props.workspaceId, threadId: id });
    await nextTick();

    // 保持用户视角不跳：补偿新增高度
    const delta = el.scrollHeight - prevScrollHeight;
    if (delta > 0) {
      el.scrollTop = prevScrollTop + delta;
    }
    nearTop.value = isNearTop(el);
  } catch (e) {
    showAsyncError(e);
  } finally {
    requestAnimationFrame(() => {
      suppressScrollEvents = false;
    });
  }
}

/** 浮窗需要至少一条用户消息才能显示：窗口里没有时向上补载，最多若干页，避免长会话反复拉取。 */
const USER_MESSAGE_FLOAT_BACKFILL_MAX_PAGES = 5;
const userMessageBackfillPages = ref(0);

watch(activeThreadId, () => {
  userMessageBackfillPages.value = 0;
});

// 补载复用 autoLoadMoreHistory：它是游标分页且会补偿新增高度，不会让当前阅读位置跳动。
// 依赖里必须带上 thread：刷新页面时用户消息会先于消息区挂载出现，此时 autoLoadMoreHistory
// 拿不到滚动容器会静默返回，而之后不再有变化可以重试，浮窗就再也不显示了。
watch([userMessages, canLoadMoreHistory, loadingMoreHistory, thread], async () => {
  if (userMessages.value.length) return;
  if (!canLoadMoreHistory.value || loadingMoreHistory.value) return;
  if (userMessageBackfillPages.value >= USER_MESSAGE_FLOAT_BACKFILL_MAX_PAGES) return;
  await nextTick();
  if (!messagesEl.value) return;
  userMessageBackfillPages.value += 1;
  void autoLoadMoreHistory();
}, { flush: "post" });

/** 正在为浮窗补载历史：先给占位，避免进会话时顶部一片空白。 */
const floatLoading = computed(() => !floatMessage.value && loadingMoreHistory.value);

/** 自动补齐首屏历史；运行中会话由 Store 合并补页期间的实时事件。 */
async function ensureInitialHistoryVisibility(): Promise<void> {
  const threadId = activeThreadId.value;
  const meta = loadMeta.value;
  if (!threadId || !meta || isLoadingSelectedThread.value) {
    isAutofillingInitialHistory.value = false;
    return;
  }

  const runId = ++initialHistoryAutofillRunId;
  let passCount = 0;

  try {
    while (runId === initialHistoryAutofillRunId) {
      await nextTick();
      const el = messagesEl.value;
      const currentMeta = loadMeta.value;
      const shouldLoadMore = shouldAutofillInitialHistory({
        hasMore: Boolean(currentMeta?.hasMore),
        loadingMore: Boolean(currentMeta?.loadingMore),
        userScrolled: userScrolledSinceSelect.value,
        displayItemCount: displayItems.value.length,
        scrollHeight: el?.scrollHeight ?? 0,
        clientHeight: el?.clientHeight ?? 0,
        passCount,
      });
      if (!shouldLoadMore) break;
      passCount += 1;
      isAutofillingInitialHistory.value = true;
      await chat.loadThreadPage(ctx.value, { workspaceId: props.workspaceId, threadId });
    }
  } catch (e) {
    showAsyncError(e);
  } finally {
    if (runId !== initialHistoryAutofillRunId) return;
    isAutofillingInitialHistory.value = false;
    if (!userScrolledSinceSelect.value) {
      await nextTick();
      stickToBottom.value = true;
      nearTop.value = false;
      scheduleAutoScrollToBottom();
    }
  }
}

const runningHint = computed(() => {
  const c = displayConversation.value;
  if (!isConversationActivelyProcessing(c)) return "";
  const items = c!.items ?? [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i] as any;
    if (it?.kind === "tool" && it.status === "started") return formatToolDisplayName(it.title || it.toolType);
    if (it?.kind === "explore" && it.status === "exploring") return "探索中";
    if (it?.kind === "review" && it.state === "started") return "复检中";
  }
  return "";
});

const runningMs = computed(() => {
  const c = displayConversation.value;
  if (!isConversationActivelyProcessing(c)) return 0;
  return Math.max(0, now.value - c!.runningTurnStartedAt!);
});

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

watch(
  () => isConversationActivelyProcessing(displayConversation.value),
  (running, prevRunning) => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (prevRunning && !running && activeThreadId.value && selectedThreadSettled.value) {
      const id = activeThreadId.value;
      void prefetchFileChanges(id, { force: true }).catch(showAsyncError);
      // 延迟重试：Client 端的 captureAfter 可能尚未写入 SQLite（事件回执与 API 查询竞态）。
      setTimeout(() => { if (activeThreadId.value === id) void prefetchFileChanges(id, { force: true }).catch(showAsyncError); }, 800);
    }
    if (!running) return;
    timer = setInterval(() => {
      now.value = Date.now();
    }, 500) as any;
  },
  { immediate: true },
);

watch(
  () => chat.activeWorkspaceLastEventSeq,
  async () => {
    if (!stickToBottom.value) return;
    await nextTick();
    scheduleAutoScrollToBottom();
  },
);

// 文件变更实时刷新：当工具完成事件携带 changes 时，防抖触发文件列表刷新。
let fileChangeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [activeThreadId.value, fileChangesRefreshTick.value, fileChangesStale.value, selectedThreadSettled.value] as const,
  ([threadId, _refreshTick, stale, settled]) => {
    if (!threadId || !stale || !settled) return;
    if (fileChangeDebounceTimer) clearTimeout(fileChangeDebounceTimer);
    fileChangeDebounceTimer = setTimeout(() => {
      fileChangeDebounceTimer = null;
      if (activeThreadId.value === threadId && fileChangesStale.value) {
        void prefetchFileChanges(threadId, { force: true }).catch(showAsyncError);
      }
    }, 500);
  },
  { immediate: true },
);

watch(
  () => activeThreadId.value,
  (threadId) => {
    if (!props.threadId) return;
    if (!threadId || !chatConnected.value) return;
    const activationKey = `embedded:${String(props.workspaceId)}:${String(threadId)}`;
    void chat.activateEmbeddedThread(ctx.value, {
      workspaceId: props.workspaceId,
      threadId,
      key: activationKey,
      owner: "embedded",
    }).catch((e) => {
      showAsyncError(e);
    });
  },
  { immediate: true },
);

watch(
  () => activeThreadId.value,
  async (newThreadId) => {
    initialHistoryAutofillRunId += 1;
    isAutofillingInitialHistory.value = false;
    lastInitialHistoryContentKey = "";
    // 等待 DOM 更新
    await nextTick();

    // 切换会话时默认滚到底部（更符合聊天场景：优先看到最新消息）。
    const el = messagesEl.value;
    if (newThreadId && el) {
      userScrolledSinceSelect.value = false;
      stickToBottom.value = true;
      nearTop.value = false;
      scheduleAutoScrollToBottom();
    }
  },
);

watch(
  () => [activeThreadId.value, managedServicesScopeKey.value] as const,
  () => {
    managedServicesExpanded.value = false;
    managedServicesModalOpen.value = false;
    managedServicesSelectedServiceId.value = null;
    lastFileChangesSettledFetchKey.value = "";
    lastManagedServicesSettledFetchKey.value = "";
  },
);

watch(
  () => managedServicesState.value.items,
  (items) => {
    if (!managedServicesSelectedServiceId.value) return;
    if (!items.some((item) => item.serviceId === managedServicesSelectedServiceId.value)) {
      managedServicesSelectedServiceId.value = items[0]?.serviceId ?? null;
    }
    if (!items.length) {
      managedServicesModalOpen.value = false;
    }
  },
  { deep: true },
);

watch(
  () => [
    composer.externalActionTick,
    activeThreadId.value,
    Boolean(composerRef.value),
    canWrite.value,
    Boolean(getExternalActionComposer()?.canAcceptExternalActions?.()),
  ] as const,
  async () => {
    await nextTick();
    applyExternalComposerActions();
  },
  { immediate: true },
);

watch(
  () => isLoadingSelectedThread.value,
  async (loading, prevLoading) => {
    // 加载完成后再补一次粘底：避免长会话回放期间的高度变化导致最终未落到底部。
    if (prevLoading && !loading && !userScrolledSinceSelect.value) {
      await nextTick();
      stickToBottom.value = true;
      nearTop.value = false;
      scheduleAutoScrollToBottom();
    }
    if (!props.threadId) return;
    if (!loading && activeThreadId.value && selectedThreadSettled.value) {
      void ensureInitialHistoryVisibility();
    }
  },
);

watch(
  () => [activeThreadId.value, threadActivation.value.phase, threadActivation.value.contentEpoch] as const,
  ([threadId, phase, contentEpoch]) => {
    if (!threadId) return;
    if (phase !== "settled" && phase !== "invalidated") return;
    const fileChangesFetchKey = `${String(threadId)}:${contentEpoch}:${phase}`;
    if (lastFileChangesSettledFetchKey.value !== fileChangesFetchKey) {
      lastFileChangesSettledFetchKey.value = fileChangesFetchKey;
      void prefetchFileChanges(threadId, { force: true }).catch(showAsyncError);
    }
    const contentKey = `${String(threadId)}:${contentEpoch}`;
    if (lastInitialHistoryContentKey === contentKey) return;
    lastInitialHistoryContentKey = contentKey;
    void ensureInitialHistoryVisibility();
  },
  { immediate: true },
);

watch(
  () => [activeThreadId.value, managedServicesScopeKey.value, managedServicesVisible.value, selectedThreadSettled.value, effectiveAssistantMode.value] as const,
  ([threadId, scopeKey, visible, settled, assistantMode]) => {
    if (!threadId || !scopeKey || !visible || assistantMode || !settled) return;
    const fetchKey = `${String(threadId)}:${scopeKey}`;
    if (lastManagedServicesSettledFetchKey.value === fetchKey) return;
    lastManagedServicesSettledFetchKey.value = fetchKey;
    void prefetchManagedServices(threadId, { force: true }).catch(showAsyncError);
  },
  { immediate: true },
);

watch(
  () => [activeThreadId.value, managedServicesScopeKey.value, managedServicesVisible.value, selectedThreadSettled.value, effectiveAssistantMode.value, managedServicesRefreshTick.value] as const,
  ([threadId, scopeKey, visible, settled, assistantMode]) => {
    if (!threadId || !scopeKey || !visible || assistantMode || !settled || !managedServicesStale.value) return;
    void prefetchManagedServices(threadId, { force: true }).catch(showAsyncError);
  },
  { immediate: true },
);

watch(
  () => [
    activeThreadId.value,
    managedServicesScopeKey.value,
    managedServicesPanelVisible.value,
    managedServicesExpanded.value,
    managedServicesModalOpen.value,
    managedServicesHasLiveItems.value,
    selectedThreadSettled.value,
    effectiveAssistantMode.value,
    chatConnected.value,
  ] as const,
  ([threadId, scopeKey, visible, expanded, modalOpen, hasLiveItems, settled, assistantMode, connected]) => {
    if (managedServiceDetailPollTimer) {
      clearInterval(managedServiceDetailPollTimer);
      managedServiceDetailPollTimer = null;
    }
    if (!threadId || !scopeKey || !visible || (!expanded && !modalOpen) || !hasLiveItems || !settled || assistantMode || !connected) return;
    managedServiceDetailPollTimer = setInterval(() => {
      if (activeThreadId.value === threadId && managedServicesScopeKey.value === scopeKey && chatConnected.value) {
        void prefetchManagedServices(threadId).catch(showAsyncError);
      }
    }, 5_000);
  },
  { immediate: true },
);

/** 重连或切换已缓存会话时校验历史，覆盖主聊天窗口和嵌入会话。 */
watch(
  () => [chat.workspaceSubscriptionAckTick, activeThreadId.value] as const,
  () => {
    const threadId = activeThreadId.value;
    if (!threadId || !chatConnected.value) return;
    void chat.ensureThreadHydrated(ctx.value, { workspaceId: props.workspaceId, threadId }).catch((error) => {
      console.error("[ChatPanel] history synchronization failed", {
        code: "CHAT_HISTORY_SYNC_FAILED", requestId: `chat-history-${String(threadId)}-${chat.workspaceSubscriptionAckTick}`,
        workspaceId: props.workspaceId, threadId, rootCause: error instanceof Error ? error.message : String(error),
      });
      showAsyncError(error);
    });
    void prefetchFileChanges(threadId, { force: true }).catch(showAsyncError);
    void prefetchManagedServices(threadId, { force: true }).catch(showAsyncError);
  },
);

watch(
  () => displayItems.value.length,
  async () => {
    // 消息列表变化时，如果需要粘底则滚动
    if (stickToBottom.value) {
      await nextTick();
      scheduleAutoScrollToBottom();
    }
  },
);

// 自动加载更多历史：滚到顶部时 debounce 150ms 后触发
watch(
  () => nearTop.value,
  (isNear) => {
    if (nearTopDebounceTimer != null) {
      clearTimeout(nearTopDebounceTimer);
      nearTopDebounceTimer = null;
    }
    if (!isNear || !canLoadMoreHistory.value) return;
    nearTopDebounceTimer = setTimeout(() => {
      nearTopDebounceTimer = null;
      void autoLoadMoreHistory();
    }, 150);
  },
);

onMounted(async () => {
  if (typeof window !== "undefined") {
    window.addEventListener("popstate", handleThreadUrlChanged);
    window.addEventListener(THREAD_URL_CHANGED_EVENT, handleThreadUrlChanged as EventListener);
  }
  syncViewportMode();
  await nextTick();
  window.addEventListener("resize", syncViewportMode);
  document.addEventListener("mousedown", onSelectionMenuDismiss);
  document.addEventListener("keydown", onSelectionMenuDismiss);
  // 初次加载时稍微延迟，确保内容渲染完成
  setTimeout(() => {
    scheduleAutoScrollToBottom();
  }, 100);
});

onUnmounted(() => {
  stopRunningStateReconcile();
  stopCatalogSyncPolling();
  if (typeof window !== "undefined") {
    window.removeEventListener("popstate", handleThreadUrlChanged);
    window.removeEventListener(THREAD_URL_CHANGED_EVENT, handleThreadUrlChanged as EventListener);
  }
  if (timer) clearInterval(timer);
  timer = null;
  if (managedServiceDetailPollTimer) clearInterval(managedServiceDetailPollTimer);
  managedServiceDetailPollTimer = null;
  if (autoScrollRaf != null) cancelAnimationFrame(autoScrollRaf);
  autoScrollRaf = null;
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = null;
  if (composerLayoutObserver) composerLayoutObserver.disconnect();
  composerLayoutObserver = null;
  if (nearTopDebounceTimer != null) clearTimeout(nearTopDebounceTimer);
  nearTopDebounceTimer = null;
  if (fileChangeDebounceTimer != null) clearTimeout(fileChangeDebounceTimer);
  fileChangeDebounceTimer = null;
  window.removeEventListener("resize", syncViewportMode);
  document.removeEventListener("mousedown", onSelectionMenuDismiss);
  document.removeEventListener("keydown", onSelectionMenuDismiss);
});

/** 转交输入组件的草稿保存边界，未挂载时显式阻止会话切换。 */
async function prepareThreadSwitch() {
  if (!composerRef.value) throw new Error("会话输入尚未就绪，暂时无法切换引擎");
  return composerRef.value.prepareThreadSwitch();
}

const emit = defineEmits<{ modelPrefsChange: [prefs: { model: string | null; effort: string | null }] }>();
defineExpose({ locateMessage, prepareThreadSwitch });
</script>

<template>
  <div class="chat-panel" :class="{ 'chat-panel--h5': props.surface === 'h5' }">
    <div v-if="showPendingThreadSelectionPlaceholder" class="chat-panel__empty">
      <div class="chat-panel__loading-placeholder">
        <a-spin size="large" />
        <div class="chat-panel__loading-placeholder-text">{{ pendingThreadSelectionPlaceholderText }}</div>
      </div>
    </div>

    <div v-else-if="!thread" class="chat-panel__empty">
      <div v-if="showModelSetupEntry" class="chat-panel__empty-setup">
        <a-empty description="尚未配置可用的模型 Key" />
        <p class="chat-panel__empty-setup-text">配置或登录后即可创建会话并开始对话。</p>
        <a-button type="primary" @click="openModelKeySettings">配置模型 Key</a-button>
      </div>
      <a-empty v-else description="请选择会话" />
    </div>

    <template v-else>
      <KnowledgeThreadContext v-if="primaryKnowledgeThread" :key="thread.id" :workspace-id="props.workspaceId" :thread="thread" :read-only="threadReadOnly" @ready="knowledgeReady = $event" />
      <div class="chat-panel__body" :class="{ 'chat-panel__body--blocked': showThreadLoadingOverlay }">
        <UserMessageFloat
          v-if="(floatMessage || floatLoading) && !isMobileViewport"
          :text="floatMessage?.text ?? ''"
          :images="floatMessage?.images"
          :index="resolvedUserMessageIndex + 1"
          :total="userMessages.length"
          :collapsed="floatCollapsed"
          :loading="floatLoading"
          @locate="locateFloatMessage"
          @prev="showPrevUserMessage"
          @next="showNextUserMessage"
          @toggle-collapse="toggleUserMessageFloat"
        />

        <div ref="messagesEl" class="chat-panel__messages" @scroll="onMessagesScroll" @wheel.passive="onMessagesWheel" @contextmenu="onMessagesContextMenu">
          <div v-if="showEmptyConversation" class="chat-panel__empty chat-panel__conversation-empty" role="status">
            <a-empty :description="canWrite && !composerBlocked ? '暂无消息，发送第一条消息开始对话' : '暂无消息'" />
          </div>
          <div
            ref="messagesInnerEl"
            class="chat-panel__messages-inner"
            :class="{ 'chat-panel__messages-inner--has-floatbar': hasAuxiliaryComposerPanels }"
          >
            <div v-if="loadingMoreHistory" class="chat-panel__loading-more">
              <span class="typing__spinner" />
              <span>正在加载历史...</span>
            </div>
            <a-alert
              v-else-if="activeThreadId && chat.threadLoadMetaByThreadId[activeThreadId]?.presentationPending"
              type="info"
              message="会话历史已打开，正在准备完整索引；较早历史可继续分页读取。"
              show-icon
            />
            <a-alert
              v-if="activeThreadId && chat.threadPresentationErrorByThreadId[activeThreadId]"
              type="error"
              message="会话摘要更新失败"
              :description="chat.threadPresentationErrorByThreadId[activeThreadId]"
              show-icon
            >
              <template #action><a-button size="small" @click="retryThreadPresentation">重试</a-button></template>
            </a-alert>
            <MessagesList
              :workspace-id="props.workspaceId"
              :thread-id="thread?.id"
              :api-context="ctx"
              :process-cache-epoch="processCacheEpoch"
              :items="displayItems"
              :engine="thread?.engine"
              :completed-turn-ids="effectiveAssistantMode ? undefined : completedTurnIds"
              :busy="listBusy"
              :can-delete="canWrite && !effectiveAssistantMode"
              :deleting-message-id="deletingMessageId"
              @delete-message="confirmMessageDelete"
              @rollback="confirmRollback"
              @close-system-message="closeSystemMessage"
            />
            <ChatWorkflowPanel v-if="chatWorkflowVisible" :key="thread.id" :workspace-id="props.workspaceId" :thread-id="thread.id" :read-only="threadReadOnly" :reply-running="isConversationRunning(displayConversation)" />
            <div v-if="showTypingIndicator" class="chat-panel__typing">
              <span class="typing__spinner" />
              <span class="typing__text">
                AI 正在处理 · {{ formatDuration(runningMs) }}<template v-if="runningHint"> · {{ runningHint }}</template>
              </span>
            </div>
            <div v-else-if="showPendingIndicator" class="chat-panel__typing">
              <span class="typing__text">
                {{ pendingInteraction === "approval" ? "等待您的确认" : "等待您补充输入" }}
              </span>
            </div>
            <div v-if="hasAssistantHelperShell" class="chat-panel__assistant-helper">
              <div class="msg-row msg-row--assistant chat-panel__assistant-helper-shell">
                <div class="msg-avatar msg-avatar--assistant" :class="`msg-avatar--${thread?.engine ?? 'codex'}`">
                  <IconClaude v-if="(thread?.engine ?? 'codex') === 'claude'" :size="18" />
                  <IconCodex v-else :size="16" />
                </div>
                <div class="msg-row__content">
                  <div class="chat-panel__assistant-helper-row">
                    <slot
                      v-if="hasAssistantHelperContent"
                      name="assistant-helper"
                      :can-write="assistantHelperScope.canWrite"
                      :busy="assistantHelperScope.busy"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div ref="composerHostEl" class="chat-panel__composer">
          <a-alert
            v-if="!effectiveAssistantMode && fileChangeCount === 0 && fileChangesState.error"
            class="chat-panel__invalidated-banner"
            type="error"
            show-icon
            aria-label="文件变更加载失败"
            :message="fileChangesState.error"
          >
            <template #action><a-button size="small" @click="refreshFileChanges">重试</a-button></template>
          </a-alert>
          <a-alert
            v-if="managedServicesVisible && managedServiceCount === 0 && managedServicesState.error"
            class="chat-panel__invalidated-banner"
            type="error"
            show-icon
            aria-label="进程加载失败"
            :message="managedServicesState.error"
          >
            <template #action><a-button size="small" @click="refreshManagedServices">重试</a-button></template>
          </a-alert>
          <div v-if="!stickToBottom" class="chat-panel__jump-bar">
            <button type="button" class="chat-panel__jump" @click="scrollToBottom">
              <span class="chat-panel__jump-icon">↓</span>
              <span>回到底部</span>
            </button>
          </div>
          <div
            v-if="hasAuxiliaryComposerPanels && useCompactComposerAux"
            class="chat-panel__floatbox chat-panel__floatbox--compact"
          >
            <div class="floatbox__cards">
              <TodolistBar v-if="!effectiveAssistantMode && conversation?.currentTodolist" :conversation="conversation" />
              <ManagedServicesPanel
                v-if="!effectiveAssistantMode && managedServicesPanelVisible"
                :loading="managedServicesState.loading"
                :items="managedServicesState.items"
                :error="managedServicesState.error"
                :disabled="!canWrite || maintenanceBusy"
                :expanded="managedServicesExpanded"
                @refresh="refreshManagedServices"
                @stop="stopManagedService"
                @inspect="openManagedServiceModal"
                @expanded-change="managedServicesExpanded = $event"
              />
              <FileChangesPanel
                v-if="!effectiveAssistantMode && fileChangeCount > 0"
                :workspace-id="props.workspaceId"
                :thread-id="thread.id"
                :loading="fileChangesState.loading"
                :items="fileChangesState.items"
                :error="fileChangesState.error"
                :disabled="!canWrite || maintenanceBusy"
                :expanded="fileChangesExpanded"
                @refresh="refreshFileChanges"
                @accept="acceptFileChanges"
                @undo="undoFileChanges"
                @expanded-change="fileChangesExpanded = $event"
              />
              <ThreadQueueBar
                v-if="showThreadQueuePanel"
                :workspace-id="props.workspaceId"
                :thread-id="thread.id"
                :disabled="!canWrite || maintenanceBusy"
                :expanded="threadQueueExpanded"
                @expanded-change="handleThreadQueueExpandedChange"
              />
            </div>
          </div>
          <div v-if="conversation?.invalidated" class="chat-panel__invalidated-banner">
            <a-alert
              type="error"
              show-icon
              :closable="false"
              message="会话已失效：引擎上下文已丢失，此会话仅供查看。请创建新会话继续工作。"
            />
          </div>
          <div v-if="threadReadOnly && !props.hideThreadReadOnlyNotice" class="chat-panel__invalidated-banner">
            <a-alert
              type="info"
              show-icon
              :closable="false"
              message="此共享会话仅可查看：你不是该会话的创建者或参与人，不能输入或执行操作。"
            />
          </div>
          <div v-if="catalogSyncIssue" class="chat-panel__invalidated-banner">
            <a-alert
              type="warning"
              show-icon
              :closable="false"
              :message="catalogSyncIssue"
            />
            <a-button
              v-if="engines.byWorkspaceId[String(props.workspaceId)]?.hostCatalogSyncState === 'waiting' && (catalogSyncTimedOut || catalogSyncCheckError)"
              type="link"
              size="small"
              @click="retryCatalogSync"
            >重试同步</a-button>
          </div>
          <div v-if="hasComposerGuardContent" class="chat-panel__composer-guard">
            <slot
              name="composer-guard"
              :can-write="assistantHelperScope.canWrite"
              :busy="assistantHelperScope.busy"
            />
          </div>
          <div v-if="hasPendingInteractionHelper" class="chat-panel__composer-helper">
            <PendingInteractionStack :workspace-id="props.workspaceId" :items="pendingInteractionItems" :active="props.interactionActive" />
          </div>
          <div class="chat-panel__composer-inner">
            <slot name="composer-notice" />
            <ChatComposer
              ref="composerRef"
              :workspace-id="props.workspaceId"
              :thread-id="thread.id"
              :disabled="threadReadOnly || Boolean(conversation?.invalidated) || maintenanceBusy || composerBlocked"
              :running-turn-id="effectiveRunningState?.runningTurnId ?? null"
              :activation-managed="!props.threadId"
              :workflow-toggle-visible="chatWorkflowToggleVisible"
              :surface="props.surface"
              :allow-queue="primaryKnowledgeThread ? false : props.allowQueue"
              :preserve-draft-on-disable="(props.preserveDraftOnDisable || primaryKnowledgeThread) && !threadReadOnly && !conversation?.invalidated"
              :allow-draft-when-disabled="props.allowDraftWhenDisabled && !threadReadOnly && !conversation?.invalidated && !maintenanceBusy && !catalogSyncIssue && (!primaryKnowledgeThread || knowledgeReady.threadId === activeThreadId && knowledgeReady.canContinue)"
              @model-prefs-change="emit('modelPrefsChange', $event)"
            >
              <template v-if="slots['toolbar-before-model']" #toolbar-before-model="slotProps"><slot name="toolbar-before-model" v-bind="slotProps" /></template>
              <template #toolbar-extra>
                <div v-if="hasAuxiliaryComposerPanels && !useCompactComposerAux" class="composer__toolbar-widgets">
                  <TodolistBar v-if="!effectiveAssistantMode && conversation?.currentTodolist" :conversation="conversation" mode="toolbar" />
                  <ManagedServicesPanel
                    v-if="!effectiveAssistantMode && managedServicesPanelVisible"
                    :loading="managedServicesState.loading"
                    :items="managedServicesState.items"
                    :error="managedServicesState.error"
                    :disabled="!canWrite || maintenanceBusy"
                    mode="toolbar"
                    :expanded="managedServicesExpanded"
                    @refresh="refreshManagedServices"
                    @stop="stopManagedService"
                    @inspect="openManagedServiceModal"
                    @expanded-change="managedServicesExpanded = $event"
                  />
                  <FileChangesPanel
                    v-if="!effectiveAssistantMode && fileChangeCount > 0"
                    :workspace-id="props.workspaceId"
                    :thread-id="thread.id"
                    :loading="fileChangesState.loading"
                    :items="fileChangesState.items"
                    :error="fileChangesState.error"
                    :disabled="!canWrite || maintenanceBusy"
                    mode="toolbar"
                    :expanded="fileChangesExpanded"
                    @refresh="refreshFileChanges"
                    @accept="acceptFileChanges"
                    @undo="undoFileChanges"
                    @expanded-change="fileChangesExpanded = $event"
                  />
                  <!-- 队列 chip：仅当前 thread 队列非空时显示（参考方案 5.4） -->
                  <ThreadQueueBar
                    v-if="showThreadQueuePanel"
                    :workspace-id="props.workspaceId"
                    :thread-id="thread.id"
                    :disabled="!canWrite || maintenanceBusy"
                    mode="toolbar"
                    :expanded="threadQueueExpanded"
                    @expanded-change="handleThreadQueueExpandedChange"
                  />
                </div>
              </template>
            </ChatComposer>
          </div>
        </div>

        <div v-if="showThreadLoadingOverlay" class="chat-panel__loading-overlay">
          <a-spin size="large" />
          <div class="chat-panel__loading-overlay-text">{{ blockingThreadLoadingText }}</div>
        </div>
      </div>

      <ManagedServicesModal
        :open="managedServicesModalOpen"
        :loading="managedServicesState.loading"
        :items="managedServicesState.items"
        :selected-service-id="managedServicesSelectedServiceId"
        :error="managedServicesState.error"
        :disabled="!canWrite || maintenanceBusy"
        @update:open="managedServicesModalOpen = $event"
        @refresh="refreshManagedServices"
        @stop="stopManagedService"
      />

      <RollbackConfirmModal
        v-if="rollbackTargetTurnId"
        :open="rollbackModalOpen"
        :workspace-id="props.workspaceId"
        :thread-id="thread.id"
        :to-turn-id="(rollbackTargetTurnId as any)"
        @update:open="setRollbackModalOpen"
        @confirmed="handleRollbackConfirmed"
      />
    </template>

    <!-- 选中文本右键菜单：复制或追加到当前会话输入框。 -->
    <Teleport to="body">
      <div
        v-if="selectionMenu"
        ref="selectionMenuEl"
        class="chat-selection-menu"
        :style="{ left: `${selectionMenu.x}px`, top: `${selectionMenu.y}px` }"
        @mousedown.prevent
      >
        <button type="button" class="chat-selection-menu__item" @click="copySelectionText">复制</button>
        <button
          type="button"
          class="chat-selection-menu__item"
          :disabled="!canWrite || !activeThreadId"
          title="把选中内容追加到会话输入框"
          @click="addSelectionToComposer"
        >
          添加到会话
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.chat-selection-menu {
  position: fixed;
  z-index: 3000;
  min-width: 152px;
  padding: 4px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-bg);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
}

.chat-selection-menu__item {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--app-fg);
  text-align: left;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  transition: background-color 120ms ease;
}

.chat-selection-menu__item:hover:not(:disabled) {
  background: var(--app-hover-bg);
}

.chat-selection-menu__item:disabled {
  color: var(--app-muted);
  cursor: not-allowed;
}

.chat-panel__conversation-empty {
  position: absolute;
  inset: 0;
  padding: 24px;
}

/* 卡片可见性仍由工作流面板管理，避免空提示遮挡卡片或错误反馈。 */
.chat-panel__messages:has(.chat-workflow) > .chat-panel__conversation-empty {
  display: none;
}

.chat-panel__messages :deep(.msg-row--located .msg) {
  outline: 2px solid color-mix(in srgb, var(--app-accent) 58%, transparent);
  outline-offset: 3px;
  border-radius: 10px;
}

.chat-panel--h5 {
  --h5-chat-brand: #16825d;
  background: color-mix(in srgb, var(--app-bg) 96%, var(--app-panel-bg));
}

.chat-panel--h5 .chat-panel__messages {
  padding: 16px 10px 18px;
  overscroll-behavior: contain;
  background: color-mix(in srgb, var(--app-bg) 96%, var(--app-bg-secondary));
  scrollbar-width: none;
}

.chat-panel--h5 .chat-panel__messages::-webkit-scrollbar {
  display: none;
}

.chat-panel--h5 :deep(.messages > .virtual-group > .msg-row) {
  gap: 9px;
  margin-bottom: 18px;
  padding: 0;
  border-bottom: 0;
}

.chat-panel--h5 :deep(.messages > .virtual-group > .msg-row--user) {
  flex-direction: row-reverse;
}

.chat-panel--h5 :deep(.messages > .virtual-group > .msg-row--assistant > .msg-row__content) {
  flex: 0 1 auto;
  width: min(82%, calc(100% - 46px));
  max-width: min(82%, calc(100% - 46px));
}

.chat-panel--h5 :deep(.messages > .virtual-group > .msg-row--user > .msg) {
  flex: 0 1 auto;
  width: fit-content;
  max-width: min(82%, calc(100% - 46px));
}

.chat-panel--h5 :deep(.msg-row--bare) {
  display: block;
}

.chat-panel--h5 :deep(.msg-avatar) {
  position: static;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 750;
}

.chat-panel--h5 :deep(.msg-avatar--user .account-avatar) {
  --account-avatar-size: 36px !important;
  border-radius: 12px;
}

.chat-panel--h5 :deep(.msg--message) {
  width: fit-content;
  max-width: 100%;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--app-border) 76%, transparent);
  border-radius: 18px 18px 18px 5px;
  background: color-mix(in srgb, var(--app-panel-bg) 95%, transparent);
  box-shadow: 0 8px 22px rgba(30, 34, 44, 0.065), 0 1px 0 color-mix(in srgb, var(--app-border) 62%, transparent) inset;
  font-size: 13px;
  line-height: 1.65;
  backdrop-filter: blur(18px) saturate(1.22);
}

.chat-panel--h5 :deep(.msg--message.msg--user) {
  border-color: color-mix(in srgb, var(--h5-chat-brand) 25%, var(--app-border));
  border-radius: 18px 18px 5px 18px;
  background: color-mix(in srgb, var(--h5-chat-brand) 10%, var(--app-panel-bg));
}

.chat-panel--h5 :deep(.msg__actions) {
  margin-right: -12px;
  margin-bottom: -10px;
  margin-left: -12px;
  padding-right: 10px;
  padding-left: 7px;
  border-radius: 0 0 18px 5px;
  opacity: 0.58;
}

.chat-panel--h5 :deep(.msg--message.msg--user .msg__actions) {
  border-radius: 0 0 5px 18px;
}

.chat-panel--h5 .chat-panel__typing {
  width: fit-content;
  margin-left: 45px;
  padding: 9px 12px;
  border: 1px solid var(--app-border);
  border-radius: 18px;
  background: var(--app-panel-bg);
}

.chat-panel--h5 .chat-panel__composer {
  --chat-panel-composer-inline-padding: 7px;
  padding: 0 7px calc(5px + var(--safe-bottom));
  background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--app-bg) 92%, transparent) 18%);
}
</style>

