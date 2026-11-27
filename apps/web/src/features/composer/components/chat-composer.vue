<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { useRouter } from "vue-router";
import {
  FullscreenExitOutlined,
  FullscreenOutlined,
  PaperClipOutlined,
  QuestionCircleOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
  SnippetsOutlined,
  StopOutlined,
} from "@ant-design/icons-vue";
import {
  getEngineModelInfo,
  getModelContextWindowBounds as resolveModelContextBounds,
  getModelContextBillingHint,
  normalizeThreadContextWindow,
  getDefaultReasoningEffortForModel,
  getEngineProviderLabel,
  normalizeEngineKeyProviderId,
  findCodexSkillPickerToken,
  findFirstEnabledThreadInputActionIndex,
  findRawSlashToken,
  insertCodexSkillMention,
  isThreadInputActionEnabled,
  moveThreadInputActionSelection,
  PRODUCT_DEFAULT_AUTO_COMPACT_PCT,
  PRODUCT_DEFAULT_THREAD_PREFS,
  rebaseCodexSkillMentionsAfterEdit,
  resolveThreadPrefsWithCatalogDefaults,
  validateInlineThreadPayload,
  DOCUMENT_ATTACHMENT_EXTENSIONS,
  DOCUMENT_ATTACHMENT_LIMITS,
  TEXT_FILE_ATTACHMENT_EXTENSIONS,
  type AccessMode,
  type CodexServiceTier,
  type CodexSkillMentionBinding,
  type EngineType,
  type FsSearchResult,
  type RoleId,
  type ThreadDraft,
  type ThreadDraftPayload,
  type TextFileAttachment,
  type ThreadId,
  type ThreadInputAction,
  type ThreadInputKind,
  type WorkspacePathReference,
  type WorkspaceId,
  createWorkspacePathReference,
  formatWorkspacePathMention,
  isWorkspacePathMentionStart,
  parseWorkspacePathMentions,
  WORKSPACE_PATH_REFERENCE_LIMITS,
} from "@codeflowai/shared";

import { createApiResultError, isApiResultError, isCancelledRequestError, type ApiRequestContext } from "../../../api/request";
import { extractDocumentAttachment, fetchFsSearch, fetchFsStat } from "../../../api/fs";
import { requestKnowledgeAsset } from "../../../api/projectKnowledge";
import { getChatWorkflow, setChatWorkflowEnabled } from "../../../api/chatWorkflow";
import { listThreadInputActions } from "../../../api/threads";
import { copyToClipboard } from "../../../composables/useClipboard";
import {
  buildModelSelectOptionGroups,
  filterModelSelectOptionGroups,
  flattenModelSelectOptionGroups,
  resolveModelProvider,
} from "../../../composables/modelSelectOptions";
import { useApiContext } from "../../../composables/useApiContext";
import { registerWorkspaceDraftFlusher, sameThreadDraftPayloadContent, useChatStore } from "../../../store/chat";
import { useConfigStore } from "../../../store/config";
import { useAccountStore } from "../../../store/account";
import { useOrchestrationStore } from "../../../store/orchestration";
import { setPendingMcpSearchQuery } from "../../orchestration/components/mcp-suites-cache";
import { useEngineStore } from "../../../store/engine";
import { useEngineKeysStore } from "../../../store/engineKeys";
import { usePresenceStore } from "../../../store/presence";
import { useUiStore, type ThemeMode } from "../../../store/ui";
import { APP_MODALS_KEY } from "../../../services/appModals";
import { isDesktopWorkspace } from "../../../services/desktop";
import { needsLocalModelSetup } from "../localModelSetup";
import {
  ENGINE_LABELS,
  isEngineCliConfirmedMissing,
  resolveAvailableModelProviderIds,
  resolveEngineCliStatusIssue,
  resolveEngineImageInputAllowed,
  resolveEngineKeyActivationIssue,
  resolveEngineUnavailableIssue,
} from "../../../utils/engineAvailability";
import { getSoftwareUpdateStatus, npmInstall } from "../../../api/software";
import { canLoadSoftwareUpdateStatus, resolveSoftwareUpdateWorkspaceId } from "../../settings/softwareUpdateScope";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import ImagePreview from "../../../shared/components/ImagePreview.vue";
import { hasDirtyPreviewWindows } from "../../explorer/previewWindowEditor";
import HtmlPreview from "../../explorer/components/html-preview.vue";
import MarkdownPreview from "../../explorer/components/markdown-preview.vue";
import { useComposerAttachments } from "../useComposerAttachments";
import { loadComposerRoleOptions, type ComposerRoleOption } from "../composer-role-options";
import { resolveSubmitPathReferences } from "../path-reference-submit";
import {
  resolveNextStableTokenUsage,
  resolveStableTokenUsageOnContentChange,
} from "../context-usage-snapshot";
import { hasRealConversationActivity } from "../thread-config-lock";
import {
  buildCodexSlashInputActions,
  describeComposerInputAction,
  findCodexResumeTarget,
  filterComposerInputActions,
  isComposerInputActionsEnabled,
  reconcileComposerInputContract,
  type ComposerInputSubmission,
  resolveComposerInputSubmission,
  resolveEditedComposerInputKind,
  validateComposerActionSubmission,
} from "../input-actions";
import ContextUsageBar from "./context-usage-bar.vue";
import RelayBalanceReminder from "./relay-balance-reminder.vue";
import QuickPhrasePicker from "./quick-phrase-picker.vue";
import {
  shouldAllowComposerSend,
  shouldEnqueueInsteadOfSend,
  shouldSubmitOnEnter,
} from "../send-guard";
import { useThreadQueueStore } from "../../../store/threadQueue";

defineOptions({ name: "ChatComposer" });

type TextAttachmentPreviewKind = "markdown" | "html" | "code";
type RelayBalanceReminderHandle = { ensureCanStartTurn: () => Promise<boolean> };

type Props = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  disabled: boolean;
  runningTurnId: string | null;
  activationManaged?: boolean;
  allowQueue?: boolean;
  /** 嵌入页临时校验绑定时保留同一会话尚未发送的输入。 */
  preserveDraftOnDisable?: boolean;
  /** 有写权限但暂不能发送的嵌入会话，仅放行文本草稿编辑与保存。 */
  allowDraftWhenDisabled?: boolean;
  /** 主动推荐开关的可见性，由会话面板按工作流面板同源条件下发；H5 不渲染该开关。 */
  workflowToggleVisible?: boolean;
  knowledgeToggleVisible?: boolean;
  /** H5 使用紧凑输入栏，运行参数统一由会话设置页维护。 */
  surface?: "default" | "h5";
};

const props = withDefaults(defineProps<Props>(), {
  surface: "default",
  allowQueue: true,
  preserveDraftOnDisable: false,
  allowDraftWhenDisabled: false,
  workflowToggleVisible: false,
  knowledgeToggleVisible: false,
});

const DRAFT_SAVE_DEBOUNCE_MS = 1500;
const DRAFT_SAVE_MAX_WAIT_MS = 10_000;

const config = useConfigStore();
const account = useAccountStore();
const orch = useOrchestrationStore();
const chat = useChatStore();
const engines = useEngineStore();
const engineKeys = useEngineKeysStore();
const presence = usePresenceStore();
const ui = useUiStore();
const appModals = inject(APP_MODALS_KEY, null);
const { ctx } = useApiContext();
const router = useRouter();
const thread = computed(() => chat.threadSummaryById(props.threadId));
/** 本机已接入的聊天、节点和知识线程独立于云端；精确归属由 Client 校验。 */
const localChatReady = computed(() => isDesktopWorkspace(config, props.workspaceId)
  && Boolean(thread.value && (thread.value.threadType === "chat" && (!thread.value.threadSubtype || thread.value.threadSubtype === "requirement-analysis" || thread.value.threadSubtype === "node-discussion" || thread.value.threadSubtype === "knowledge-conversation")
    || thread.value.threadType === "orchestration" && (thread.value.threadSubtype === "node" || thread.value.threadSubtype === "knowledge-assets"))));
const composerConnected = computed(() => config.connected || localChatReady.value);
const modelCatalogLoaded = computed(() => {
  const state = engines.byWorkspaceId[String(props.workspaceId)];
  return localChatReady.value
    ? Boolean(state?.localModels && state.lastUpdatedAt != null && !state.lastError)
    : state?.catalogVersion != null;
});

const text = ref("");
const relayBalanceReminderRef = ref<RelayBalanceReminderHandle | null>(null);
const inputKind = ref<ThreadInputKind | undefined>(undefined);
const skillMentions = ref<CodexSkillMentionBinding[]>([]);
let preserveInputContractTextMutation = false;
const pathReferences = ref<WorkspacePathReference[]>([]);
const textareaRef = ref<any>(null);
const textareaEl = ref<HTMLTextAreaElement | null>(null);
const mentionOpen = ref(false);
const mentionLoading = ref(false);
const mentionError = ref("");
const mentionResults = ref<FsSearchResult[]>([]);
const mentionSelectedIndex = ref(0);
const mentionTokenRange = ref<{ start: number; end: number; query: string; quoted: boolean } | null>(null);
const mentionQuery = ref("");
const mentionCursor = ref<string | null>(null);
const mentionHasMore = ref(false);
const mentionLoadingMore = ref(false);
let mentionSearchTimer: ReturnType<typeof setTimeout> | null = null;
let mentionSearchSeq = 0;
const inputActionOpen = ref(false);
const inputActionLoading = ref(false);
const inputActionError = ref("");
const inputActionCatalogMessage = ref("");
const inputActionActions = ref<ThreadInputAction[]>([]);
const inputActionSelectedIndex = ref(0);
const inputActionTokenRange = ref<{ start: number; end: number; query: string; trigger: "/" | "$" } | null>(null);
const inputActionScopeKey = ref("");
let inputActionRequestGeneration = 0;
let inputActionRequestController: AbortController | null = null;
const filteredInputActionActions = computed(() =>
  filterComposerInputActions(inputActionActions.value, inputActionTokenRange.value?.query ?? ""),
);
const resumePickerOpen = ref(false);
const resumePickerLoading = ref(false);
const resumePickerError = ref("");
const resumePickerQuery = ref("");
const resumePickerSelectedId = ref<ThreadId | null>(null);
const vimModeEnabled = ref(false);
const rawOutputMode = ref(false);
const petsVisible = ref(true);
const personalityMode = ref("default");
const codexGoalByThreadId = new Map<string, string>();
const codexSandboxReadDirsByThreadId = new Map<string, string[]>();
const resumePickerThreads = computed(() => {
  const query = resumePickerQuery.value.trim().toLocaleLowerCase();
  return chat.threads
    .filter((item) => item.engine === "codex" && String(item.id) !== String(props.threadId))
    .filter((item) => !query || item.title.toLocaleLowerCase().includes(query) || String(item.id).toLocaleLowerCase().includes(query));
});
const selectedResumePickerThread = computed(() => {
  const selectedId = resumePickerSelectedId.value;
  return selectedId == null
    ? null
    : resumePickerThreads.value.find((item) => String(item.id) === String(selectedId)) ?? null;
});
const resumePickerCanConfirm = computed(() => Boolean(selectedResumePickerThread.value) && !resumePickerLoading.value);
watch(
  resumePickerThreads,
  (threads) => {
    if (!resumePickerOpen.value) return;
    if (!threads.length) {
      resumePickerSelectedId.value = null;
      return;
    }
    if (!threads.some((item) => String(item.id) === String(resumePickerSelectedId.value))) {
      resumePickerSelectedId.value = threads[0]!.id;
    }
  },
  { flush: "sync" },
);
/**
 * 跨场景幂等键：同一份草稿（"composer 非空 → 提交"为一个生命周期）共享同一个 UUID。
 * 提交成功后由 send() 末尾清空，下次首次输入再生成。
 * Server 侧：append 用 DB 唯一索引 + send 用 30s 内存 LRU 双层去重，重复请求返回原 item/turnId。
 */
const currentClientItemId = ref<string | null>(null);
function ensureClientItemId(): string {
  if (!currentClientItemId.value) {
    currentClientItemId.value =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `cid_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
  return currentClientItemId.value;
}
const sending = ref(false);
/** 在途提交固定分流；运行事件只影响下一次发送，不能改变本次文案。 */
const sendingViaQueue = ref(false);
const interrupting = ref(false);
const settingsOpen = ref(false);
const imagePreviewSrc = ref("");
const imagePreviewVisible = ref(false);
const currentDraftVersion = ref<number | null>(null);
const draftHydrating = ref(false);
const draftRemoteMutationDepth = ref(0);
const workspaceSwitchFlushInProgress = ref(false);

const composerWriteBlocked = computed(() => (
  props.disabled
  || !composerConnected.value
  || !modelCatalogLoaded.value
  || workspaceSwitchFlushInProgress.value
  || sending.value
));
/** 草稿编辑独立于发送锁，连接和运行环境限制仍然生效。 */
const draftInputBlocked = computed(() => (
  props.disabled && !props.allowDraftWhenDisabled
  || !composerConnected.value || !modelCatalogLoaded.value || workspaceSwitchFlushInProgress.value || sending.value
));
const composerWriteBlockedReason = computed(() => {
  if (props.disabled) return "当前会话为只读状态";
  if (!composerConnected.value) return "服务连接已断开";
  if (!modelCatalogLoaded.value) return "模型目录尚未加载完成";
  if (workspaceSwitchFlushInProgress.value) return "工作区正在切换";
  if (sending.value) return "消息正在发送";
  return "当前会话不可编辑";
});

const canAddAttachments = computed(() => !composerWriteBlocked.value);
/** 桌面本机常用提示词不依赖账号，Web 保留账号入口。 */
const quickPhrasesAvailable = computed(() => config.isDesktop || (config.isAccountSession && config.hasActiveSession && Boolean(config.userSummary?.userId)));
const toolbarScrollEl = ref<HTMLDivElement | null>(null);
const modelSelectRef = ref<any>(null);
const roleSelectRef = ref<any>(null);
const modelSelectOpen = ref(false);
const roleSelectOpen = ref(false);
const toolbarDragging = ref(false);
let suppressToolbarClickUntil = 0;
let toolbarDragState: {
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  dragged: boolean;
} | null = null;
let draftLoadToken = 0;
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
// 首次会话 watcher 会同步冲刷偏好，定时器状态必须先完成初始化。
let pendingPrefsSave: {
  scope: ThreadPrefsSaveScope;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
let draftDirtySince = 0;
let skipNextDraftWatch = false;
let draftDirty = false;
let draftEditSeq = 0;
let draftScopeEpoch = 0;
let draftWorkspaceScopeToken = chat.captureThreadDraftWorkspaceScopeToken();
let draftWorkspaceApiContext: ApiRequestContext = ctx.value;
const draftScopeHydrated = ref(false);
let draftWriteAuthorized = false;
let draftAuthorizationWorkspaceId = props.workspaceId;
let draftAuthorizationThreadId = props.threadId;
let draftVersionReloadDeferred = false;
let scheduledDraftPersist: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  draftSeq: number;
  draftScopeEpoch: number;
  task: Promise<void>;
} | null = null;
let lastDraftBudgetWarning = "";

/** 当前草稿 scope 有效时同步最新鉴权；scope 失效后保留旧身份供 remote-only 收尾。 */
watch(
  () => [ctx.value.serverWsOrigin, ctx.value.sessionToken, ctx.value.webSessionId] as const,
  () => {
    if (chat.isThreadDraftWorkspaceScopeCurrent(draftWorkspaceScopeToken)) {
      draftWorkspaceApiContext = ctx.value;
    }
  },
  { flush: "sync" },
);

/** Popover 可见性变更：禁用时拒绝打开。 */
function onSettingsVisibleChange(visible: boolean): void {
  if (visible && (props.disabled || !composerConnected.value)) return;
  settingsOpen.value = visible;
}

/** 禁用时自动关闭设置弹出层。 */
watch(
  () => props.disabled || !composerConnected.value,
  (v) => {
    if (v) settingsOpen.value = false;
  },
);

watch(
  () => props.runningTurnId,
  (next, prev) => {
    if (!next || (prev && next !== prev)) {
      interrupting.value = false;
    }
  },
);
const engineStatus = computed(() => engines.byTypeForWorkspace(props.workspaceId).get(engine.value) ?? null);

/** 刷新 Key 供应商状态，用于模型列表过滤与发送前校验。 */
async function refreshEngineKeysForComposer(): Promise<void> {
  if (!composerConnected.value || !presence.isCurrentWorkspaceClientOnline) return;
  if (isSharedWorkspaceSelectionId(config.workspaceId)) return;
  try {
    await engineKeys.refresh(ctx.value, config.workspaceId);
  } catch (error) {
    if (isCancelledRequestError(error)) return;
    message.warning(error instanceof Error ? `无法读取大模型 Key 配置：${error.message}` : "无法读取大模型 Key 配置");
  }
}

watch(
  () => [composerConnected.value, config.workspaceId, presence.isCurrentWorkspaceClientOnline] as const,
  ([connected, workspaceId, online], previous) => {
    const [prevConnected, prevWorkspaceId, prevOnline] = previous ?? [undefined, undefined, undefined];
    if (!connected || !online) return;
    if (connected === prevConnected && workspaceId === prevWorkspaceId && online === prevOnline) return;
    void refreshEngineKeysForComposer();
  },
  { immediate: true },
);

const resolvedModelInfo = computed(() => {
  const id = resolvedModelId.value;
  if (!id) return null;
  return engineStatus.value?.models.find((m) => m.id === id) ?? null;
});

const engineCliStatusIssue = computed(() => resolveEngineCliStatusIssue(engine.value, engineStatus.value));
/** 明确未安装时进入硬门禁；探测超时仍允许尝试。 */
const engineCliMissing = computed(() => isEngineCliConfirmedMissing(engineStatus.value));
const engineCliMissingIssue = computed(() => engineCliMissing.value ? engineCliStatusIssue.value : null);
/** 直接安装/修复期间用进行中文案替换提示行，避免与缺失提示重复。 */
const cliRepairBusy = ref(false);
const cliRepairHint = ref<string | null>(null);

const allowImages = computed(() =>
  resolveEngineImageInputAllowed(engine.value, engineStatus.value, resolvedModelInfo.value));

const TEXT_ACCEPT = ["text/*", ...TEXT_FILE_ATTACHMENT_EXTENSIONS.map((extension) => `.${extension}`)].join(",");
const DOCUMENT_ACCEPT = DOCUMENT_ATTACHMENT_EXTENSIONS.map((extension) => `.${extension}`).join(",");
const fileAccept = computed(() => `${allowImages.value ? "image/*," : ""}${TEXT_ACCEPT},${DOCUMENT_ACCEPT}`);

// 本地文件输入元素 ref
const localFileInputEl = ref<HTMLInputElement | null>(null);

/** 文档源文件统一 20MB；图片统一保留 12MB 解码安全上限。 */
const attachmentSourceLimitHint = computed(
  () => `文档最大 ${Math.floor(DOCUMENT_ATTACHMENT_LIMITS.maxSourceBytes / (1024 * 1024))}MB`,
);

const {
  imageAttachments,
  textFileAttachments,
  previewFile,
  previewOpen,
  removeImage,
  removeTextFile,
  addTextAttachment,
  openTextFilePreview,
  closeTextFilePreview,
  onFileChange,
  onDrop,
  onPaste,
  clearAttachments,
  pendingReads,
  invalidateAttachmentReads,
} = useComposerAttachments({
  canAdd: canAddAttachments,
  allowImages,
  scopeKey: computed(() => `${props.workspaceId}\u0000${props.threadId}\u0000${config.webSessionId}`),
  extractDocument: async (file, base64) => {
    const result = await extractDocumentAttachment(ctx.value, { workspaceId: props.workspaceId, fileName: file.name, base64 });
    if (!result.ok) throw createApiResultError(result);
    return result.text;
  },
  onOversizedFileReference: appendOversizedFileReference,
});
const previewFileKind = computed<TextAttachmentPreviewKind>(() => detectTextAttachmentPreviewKind(previewFile.value?.name ?? ""));
const attachmentPreviewFullscreen = ref(false);
const attachmentPreviewFullscreenTitle = computed(() => attachmentPreviewFullscreen.value ? "还原附件预览" : "全屏查看附件预览");
const attachmentPreviewModalWidth = computed(() => attachmentPreviewFullscreen.value ? "100vw" : "70%");
const attachmentPreviewModalStyle = computed(() => attachmentPreviewFullscreen.value ? { top: "0", paddingBottom: "0" } : { top: "10%" });
const attachmentPreviewBodyStyle = computed(() =>
  attachmentPreviewFullscreen.value
    ? { height: "calc(100dvh - 56px)", maxHeight: "calc(100dvh - 56px)", overflow: "hidden" }
    : { maxHeight: "70vh", overflow: "auto" });
const attachmentPreviewWrapClassName = computed(() =>
  attachmentPreviewFullscreen.value
    ? "composer-attachment-preview-modal composer-attachment-preview-modal--fullscreen"
    : "composer-attachment-preview-modal");

watch(previewOpen, (open) => {
  if (!open) attachmentPreviewFullscreen.value = false;
});

/** 关闭待发送附件预览并恢复普通窗口尺寸。 */
function handleCloseTextFilePreview(): void {
  attachmentPreviewFullscreen.value = false;
  closeTextFilePreview();
}

/** 切换待发送附件预览全屏状态，保留当前附件内容。 */
function toggleAttachmentPreviewFullscreen(): void {
  attachmentPreviewFullscreen.value = !attachmentPreviewFullscreen.value;
}

/** 大文件不能内联时，把浏览器可取得的完整 URL 追加进当前输入。 */
function appendOversizedFileReference(referenceUrl: string): void {
  appendText(referenceUrl);
}

/** 按附件文件名判断预览方式；发送前附件没有工作区路径上下文。 */
function detectTextAttachmentPreviewKind(fileName: string): TextAttachmentPreviewKind {
  const ext = String(fileName ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  return "code";
}

/** 关闭 @ 路径候选，并清理等待中的搜索。 */
function closeMentionPicker(): void {
  mentionOpen.value = false;
  mentionLoading.value = false;
  mentionError.value = "";
  mentionResults.value = [];
  mentionSelectedIndex.value = 0;
  mentionTokenRange.value = null;
  mentionQuery.value = "";
  mentionCursor.value = null;
  mentionHasMore.value = false;
  mentionLoadingMore.value = false;
  if (mentionSearchTimer) {
    clearTimeout(mentionSearchTimer);
    mentionSearchTimer = null;
  }
}

/** 关闭输入动作候选并使所有在途目录响应失效。 */
function closeInputActionPicker(): void {
  inputActionRequestGeneration += 1;
  inputActionRequestController?.abort();
  inputActionRequestController = null;
  inputActionOpen.value = false;
  inputActionLoading.value = false;
  inputActionError.value = "";
  inputActionCatalogMessage.value = "";
  inputActionActions.value = [];
  inputActionSelectedIndex.value = 0;
  inputActionTokenRange.value = null;
  inputActionScopeKey.value = "";
}

/** 关闭恢复会话选择器并清理本次查询状态。 */
function closeResumePicker(): void {
  resumePickerOpen.value = false;
  resumePickerLoading.value = false;
  resumePickerError.value = "";
  resumePickerQuery.value = "";
  resumePickerSelectedId.value = null;
}

/** 让选择索引始终落在可执行候选上，避免 disabled 命令抢占 Enter。 */
function normalizeInputActionSelection(actions: readonly ThreadInputAction[] = filteredInputActionActions.value): void {
  if (!actions.length) {
    inputActionSelectedIndex.value = 0;
    return;
  }
  const current = inputActionSelectedIndex.value;
  if (current >= 0 && current < actions.length && isThreadInputActionEnabled(actions[current]!)) return;
  const firstEnabled = findFirstEnabledThreadInputActionIndex(actions);
  inputActionSelectedIndex.value = firstEnabled >= 0 ? firstEnabled : 0;
}

/** 解析 ant-design-vue TextArea 的真实 textarea 元素。 */
function resolveTextareaElement(): HTMLTextAreaElement | null {
  const direct = textareaRef.value;
  if (direct instanceof HTMLTextAreaElement) {
    textareaEl.value = direct;
    return direct;
  }
  const candidate = direct?.resizableTextArea?.textArea
    ?? direct?.$el?.querySelector?.("textarea")
    ?? null;
  if (candidate instanceof HTMLTextAreaElement) {
    textareaEl.value = candidate;
    return candidate;
  }
  return textareaEl.value;
}

/** 从 textarea 光标前内容解析正在输入的 @ token。 */
function resolveActiveMentionToken(target: HTMLTextAreaElement): { start: number; end: number; query: string; quoted: boolean } | null {
  const cursor = target.selectionStart ?? text.value.length;
  const before = text.value.slice(0, cursor);
  for (let start = before.lastIndexOf("@"); start >= 0; start = before.lastIndexOf("@", start - 1)) {
    if (!isWorkspacePathMentionStart(text.value, start)) continue;
    const tokenText = before.slice(start);
    if (tokenText.startsWith("@\"")) {
      const query = tokenText.slice(2);
      if (/["\r\n]/u.test(query)) return null;
      return {
        start,
        end: cursor,
        query,
        quoted: true,
      };
    }
    if (/\s/u.test(tokenText)) return null;
    const query = tokenText.slice(1);
    if (/[@'"\r\n]/u.test(query)) return null;
    return {
      start,
      end: cursor,
      query,
      quoted: false,
    };
  }
  return null;
}

/** 输入变更后按优先级维护输入动作与 @ 候选。 */
function onComposerInput(): void {
  void refreshComposerPickersAfterInput();
}

/** 输入框获得焦点时关闭全局文件预览；有未保存修改时保留窗口，避免静默丢失编辑。 */
function closePreviewWindowsOnComposerFocus(): void {
  if (!ui.explorerPreviewWindows.length) return;
  if (hasDirtyPreviewWindows(ui.explorerPreviewWindows)) return;
  ui.closeAllPreviewWindows();
}

/** 等 v-model 与光标更新后刷新互斥的两类候选浮层。 */
async function refreshComposerPickersAfterInput(): Promise<void> {
  await nextTick();
  const target = resolveTextareaElement();
  syncPathReferencesWithText();
  if (!target || composerWriteBlocked.value) {
    closeInputActionPicker();
    closeMentionPicker();
    return;
  }
  if (refreshInputActionPicker(target)) {
    closeMentionPicker();
    return;
  }
  closeInputActionPicker();
  refreshMentionStateAfterInput(target);
}

/** Inserts a quick phrase at the current selection without sending it. */
async function insertQuickPhrase(content: string): Promise<void> {
  if (composerWriteBlocked.value) return;
  const target = resolveTextareaElement();
  const start = target?.selectionStart ?? text.value.length;
  const end = target?.selectionEnd ?? start;
  if (target && typeof target.setRangeText === "function") {
    target.setRangeText(content, start, end, "end");
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: content }));
  } else {
    text.value = `${text.value.slice(0, start)}${content}${text.value.slice(end)}`;
  }
  await nextTick();
  const nextTarget = resolveTextareaElement();
  nextTarget?.focus();
  nextTarget?.setSelectionRange(start + content.length, start + content.length);
  onComposerInput();
}

/** 根据已同步的 textarea 光标判断是否处于 @ token。 */
function refreshMentionStateAfterInput(target: HTMLTextAreaElement): void {
  const token = resolveActiveMentionToken(target);
  if (!token) {
    closeMentionPicker();
    return;
  }
  mentionTokenRange.value = token;
  scheduleMentionSearch(token.query);
}

/** 生成目录请求的稳定作用域，隔离工作区、会话与引擎切换。 */
function currentInputActionScopeKey(): string {
  return `${String(props.workspaceId)}\u0000${String(props.threadId)}\u0000${engine.value}`;
}

/** 解析当前光标下可触发的 Slash 或 Codex Skill token。 */
function resolveActiveInputActionToken(target: HTMLTextAreaElement): {
  start: number;
  end: number;
  query: string;
  trigger: "/" | "$";
} | null {
  if (!inputActionsEnabled.value) return null;
  const cursor = target.selectionStart ?? text.value.length;
  const slash = findRawSlashToken(text.value, cursor);
  if (slash && (engine.value === "codex" || engine.value === "claude")) {
    return { start: slash.start, end: slash.end, query: slash.query, trigger: "/" };
  }
  if (engine.value !== "codex" || text.value[0] === "/") return null;
  const skill = findCodexSkillPickerToken(text.value, cursor);
  return skill ? { ...skill, trigger: "$" } : null;
}

/** 打开或更新输入动作浮层；逐字符过滤不重复请求目录。 */
function refreshInputActionPicker(target: HTMLTextAreaElement): boolean {
  const token = resolveActiveInputActionToken(target);
  if (!token) return false;
  const scopeKey = currentInputActionScopeKey();
  const sameOpen = inputActionOpen.value
    && inputActionScopeKey.value === scopeKey
    && inputActionTokenRange.value?.trigger === token.trigger;
  inputActionTokenRange.value = token;
  inputActionSelectedIndex.value = 0;
  if (sameOpen) {
    if (engine.value === "codex" && token.trigger === "/") {
      inputActionActions.value = buildCurrentCodexSlashActions();
    }
    normalizeInputActionSelection();
    return true;
  }

  closeInputActionPicker();
  closeMentionPicker();
  inputActionOpen.value = true;
  inputActionScopeKey.value = scopeKey;
  inputActionTokenRange.value = token;
  if (engine.value === "codex" && token.trigger === "/") {
    inputActionActions.value = buildCurrentCodexSlashActions();
    normalizeInputActionSelection();
  } else {
    void loadInputActionCatalog(scopeKey, token.trigger);
  }
  return true;
}

/** 按当前会话状态投影本地 Codex host action 可用性。 */
function buildCurrentCodexSlashActions(): ThreadInputAction[] {
  return buildCodexSlashInputActions({
    hasConversationHistory: hasConversationHistory.value,
    runningTurnId: props.runningTurnId,
    queueLength: threadQueueStore.itemCountFor(props.threadId),
  });
}

/** 请求 Claude Slash 或 Codex Skill 目录，并拒绝取消或迟到的结果。 */
async function loadInputActionCatalog(scopeKey: string, trigger: "/" | "$"): Promise<void> {
  inputActionRequestController?.abort();
  const controller = new AbortController();
  inputActionRequestController = controller;
  const generation = ++inputActionRequestGeneration;
  inputActionLoading.value = true;
  inputActionError.value = "";
  inputActionCatalogMessage.value = "";
  inputActionActions.value = [];
  try {
    const result = await listThreadInputActions(ctx.value, {
      workspaceId: props.workspaceId,
      threadId: props.threadId,
      trigger,
    }, { signal: controller.signal });
    if (!isCurrentInputActionRequest(generation, scopeKey, trigger) || controller.signal.aborted) return;
    if (!result.ok) {
      inputActionError.value = result.message;
      return;
    }
    inputActionActions.value = result.actions ?? [];
    inputActionCatalogMessage.value = result.providerCatalog?.message ?? (
      result.providerCatalog?.state === "unavailable" ? "尚无会话目录，可继续手动输入" : ""
    );
  } catch (error) {
    if (controller.signal.aborted || isCancelledRequestError(error)) return;
    if (!isCurrentInputActionRequest(generation, scopeKey, trigger)) return;
    inputActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (isCurrentInputActionRequest(generation, scopeKey, trigger)) {
      inputActionLoading.value = false;
      if (inputActionRequestController === controller) inputActionRequestController = null;
    }
  }
}

/** 校验目录响应仍属于当前一次打开的相同作用域。 */
function isCurrentInputActionRequest(generation: number, scopeKey: string, trigger: "/" | "$"): boolean {
  return generation === inputActionRequestGeneration
    && inputActionOpen.value
    && inputActionScopeKey.value === scopeKey
    && inputActionTokenRange.value?.trigger === trigger
    && currentInputActionScopeKey() === scopeKey;
}

/** 在当前浮层作用域内重新请求 Provider 目录。 */
function retryInputActionCatalog(): void {
  const token = inputActionTokenRange.value;
  if (!inputActionOpen.value || !token || !inputActionScopeKey.value) return;
  void loadInputActionCatalog(inputActionScopeKey.value, token.trigger);
}

/** 返回候选是否可由鼠标或键盘选择。 */
function isInputActionEnabled(action: ThreadInputAction): boolean {
  return isThreadInputActionEnabled(action);
}

/** 组合候选描述与禁用原因，供原生 title 完整展示。 */
function inputActionTitle(action: ThreadInputAction): string {
  const disabledReason = action.kind === "slash" ? action.disabledReason : null;
  const aliases = action.kind === "slash" && action.source === "codeflow" && action.aliases?.length
    ? `别名：${action.aliases.join("、")}`
    : null;
  return [action.description, aliases, disabledReason].filter((item): item is string => Boolean(item)).join("；");
}

/** 用候选 token 替换当前输入范围，并为 Codex Skill 写入 opaque binding。 */
function selectInputAction(action: ThreadInputAction): boolean {
  if (composerWriteBlocked.value) return false;
  if (!isInputActionEnabled(action)) {
    message.warning(action.kind === "slash" ? (action.disabledReason ?? "当前命令不可用") : "当前候选不可用");
    return false;
  }
  const range = inputActionTokenRange.value;
  const target = resolveTextareaElement();
  if (!range || !target) return false;
  let nextCursor: number;
  if (action.kind === "codex-skill") {
    const inserted = insertCodexSkillMention({
      text: text.value,
      bindings: skillMentions.value,
      replaceStart: range.start,
      replaceEnd: range.end,
      skillId: action.skillId,
      name: action.name,
    });
    text.value = inserted.text;
    skillMentions.value = inserted.skillMentions;
    inputKind.value = resolveEditedComposerInputKind({
      enabled: inputActionsEnabled.value,
      engine: engine.value,
      rawText: text.value,
      skillMentions: skillMentions.value,
    });
    nextCursor = inserted.caret;
  } else {
    text.value = `${text.value.slice(0, range.start)}${action.token}${text.value.slice(range.end)}`;
    nextCursor = range.start + action.token.length;
  }
  closeInputActionPicker();
  requestAnimationFrame(() => {
    target.focus();
    target.setSelectionRange(nextCursor, nextCursor);
  });
  return true;
}

/** 路径引用只保留仍出现在文本中的 @ token，避免用户删 token 后仍发送引用。 */
function syncPathReferencesWithText(): void {
  const mentioned = new Set(parseWorkspacePathMentions(text.value).map((mention) => mention.path));
  pathReferences.value = pathReferences.value.filter((ref) => mentioned.has(ref.path));
}

/** 防抖搜索 workspace 路径；每次结果都按最新 seq 收口，避免旧请求覆盖新输入。 */
function scheduleMentionSearch(query: string): void {
  if (mentionSearchTimer) clearTimeout(mentionSearchTimer);
  mentionOpen.value = true;
  mentionLoading.value = true;
  mentionLoadingMore.value = false;
  mentionError.value = "";
  mentionQuery.value = query;
  mentionCursor.value = null;
  mentionHasMore.value = false;
  mentionSearchTimer = setTimeout(() => {
    mentionSearchTimer = null;
    void runMentionSearch(query, null, false);
  }, 120);
}

/** 调用 fs.search 获取 @ 候选。 */
async function runMentionSearch(query: string, cursor: string | null, append: boolean): Promise<void> {
  const seq = ++mentionSearchSeq;
  if (append) mentionLoadingMore.value = true;
  else mentionLoading.value = true;
  mentionError.value = "";
  try {
    const result = await fetchFsSearch(ctx.value, {
      workspaceId: props.workspaceId,
      query,
      limit: 30,
      cursor,
      kind: "all",
    });
    if (seq !== mentionSearchSeq) return;
    if (!result.ok) {
      if (!append) mentionResults.value = [];
      mentionError.value = result.message;
      return;
    }
    const nextResults = result.results ?? [];
    mentionResults.value = append ? [...mentionResults.value, ...nextResults] : nextResults;
    mentionCursor.value = result.nextCursor ?? null;
    mentionHasMore.value = Boolean(result.hasMore && result.nextCursor);
    if (!append) mentionSelectedIndex.value = 0;
  } catch (error) {
    if (seq !== mentionSearchSeq) return;
    if (!append) mentionResults.value = [];
    mentionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (seq === mentionSearchSeq) {
      if (append) mentionLoadingMore.value = false;
      else mentionLoading.value = false;
    }
  }
}

/** 滚动到底部时加载下一页路径候选。 */
function loadMoreMentionResults(): void {
  if (!mentionOpen.value || mentionLoading.value || mentionLoadingMore.value || !mentionHasMore.value || !mentionCursor.value) return;
  void runMentionSearch(mentionQuery.value, mentionCursor.value, true);
}

/** 监听候选浮层滚动，实现懒加载下一页。 */
function onMentionScroll(event: Event): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
  if (distanceToBottom <= 32) loadMoreMentionResults();
}

/** 格式化目录补全前缀，目录选择后继续保留 @ token 输入态。 */
function formatWorkspaceDirectoryMentionPrefix(path: string): string {
  const normalized = createWorkspacePathReference({ path, kind: "directory" }).path;
  if (/[\s"]/u.test(normalized)) {
    return `@"${normalized.replace(/"/g, "\\\"")}/`;
  }
  return `@${normalized}/`;
}

/** 选择 @ 候选：替换当前 token，并写入结构化路径引用。 */
function selectMentionResult(result: FsSearchResult): void {
  if (composerWriteBlocked.value) return;
  const range = mentionTokenRange.value;
  const target = resolveTextareaElement();
  if (!range || !target) return;
  const ref = createWorkspacePathReference({
    path: result.path,
    kind: result.isDir ? "directory" : "file",
    source: "mention",
  });
  const mentionText = result.isDir ? formatWorkspaceDirectoryMentionPrefix(ref.path) : formatWorkspacePathMention(ref.path);
  text.value = `${text.value.slice(0, range.start)}${mentionText}${text.value.slice(range.end)}`;
  if (result.isDir) {
    upsertPathReference(ref);
    mentionTokenRange.value = {
      start: range.start,
      end: range.start + mentionText.length,
      query: `${ref.path}/`,
      quoted: mentionText.startsWith("@\""),
    };
    scheduleMentionSearch(`${ref.path}/`);
  } else {
    upsertPathReference(ref);
    closeMentionPicker();
  }
  requestAnimationFrame(() => {
    target.focus();
    const nextCursor = range.start + mentionText.length;
    target.selectionStart = nextCursor;
    target.selectionEnd = nextCursor;
  });
}

/** 按 path 去重写入路径引用，保留最新 stat kind。 */
function upsertPathReference(ref: WorkspacePathReference): void {
  const next = pathReferences.value.filter((item) => item.path !== ref.path);
  next.push(ref);
  pathReferences.value = next.slice(-WORKSPACE_PATH_REFERENCE_LIMITS.maxCount);
}

/** 按发送时快照解析结构化路径引用，避免异步 stat 读取到切换后的会话。 */
async function resolvePathReferencesForSubmit(input: {
  text: string;
  workspaceId: WorkspaceId;
  existingReferences: WorkspacePathReference[];
}): Promise<WorkspacePathReference[]> {
  const threadId = props.threadId;
  let statFailure: unknown;
  return await resolveSubmitPathReferences({
    text: input.text,
    existingReferences: input.existingReferences,
    statPath: async (path) => {
      try {
        const result = await fetchFsStat(ctx.value, { workspaceId: input.workspaceId, path });
        if (result.ok) return result;
        throw createApiResultError(result);
      } catch (error) {
        statFailure = error;
        throw error;
      }
    },
    onStatFailure: (path, reason) => {
      const error = statFailure ?? new Error(reason);
      console.error("[chat-path-reference.stat.failed]", { ...describeWorkflowFailure(error), workspaceId: input.workspaceId, threadId, path, error });
      throw error;
    },
  });
}

/** 保存当前 thread 的未发送草稿（正文、附件、路径引用元数据）。 */
function snapshotDraft(): ThreadDraftPayload {
  return {
    text: text.value,
    ...(inputKind.value ? { inputKind: inputKind.value } : {}),
    ...(skillMentions.value.length
      ? { skillMentions: skillMentions.value.map((binding) => ({ ...binding })) }
      : {}),
    images: imageAttachments.value.map((item) => ({ ...item })),
    files: textFileAttachments.value.map((item) => ({ ...item })),
    pathReferences: pathReferences.value.map((item) => ({ ...item })),
  };
}

/** 切换 thread 时加载对应草稿，避免附件跨会话串用。 */
function applyDraft(draft: ThreadDraftPayload | ThreadDraft | null): void {
  invalidateAttachmentReads();
  draftHydrating.value = true;
  skipNextDraftWatch = true;
  preserveInputContractTextMutation = true;
  closeImagePreview();
  closeTextFilePreview();
  text.value = draft?.text ?? "";
  // 草稿可能来自旧引擎或旧版本；按当前 thread 事实重算合同，避免过期字段跨引擎透传。
  const draftThread = chat.threadSummaryById(props.threadId);
  const draftContract = draftThread
    ? reconcileComposerInputContract({
      enabled: isComposerInputActionsEnabled({
        surface: props.surface,
        threadType: draftThread.threadType ?? null,
        threadSubtype: draftThread.threadSubtype ?? null,
      }),
      engine: draftThread.engine,
      rawText: draft?.text ?? "",
      inputKind: draft?.inputKind,
      skillMentions: draft?.skillMentions,
    })
    : {
      inputKind: draft?.inputKind,
      skillMentions: draft?.skillMentions?.map((binding) => ({ ...binding })),
    };
  inputKind.value = draftContract.inputKind;
  skillMentions.value = draftContract.skillMentions ?? [];
  preserveInputContractTextMutation = false;
  imageAttachments.value = draft?.images ? draft.images.map((item) => ({ ...item })) : [];
  textFileAttachments.value = draft?.files ? draft.files.map((item) => ({ ...item })) : [];
  pathReferences.value = draft?.pathReferences ? draft.pathReferences.map((item) => ({ ...item })) : [];
  draftDirty = false;
  draftEditSeq = 0;
  draftHydrating.value = false;
}

/** 恢复未获远端确认的本地草稿，并保持待保存状态。 */
function applyPendingLocalDraft(draft: ThreadDraftPayload): void {
  applyDraft(draft);
  draftDirty = true;
  draftEditSeq = 1;
  draftDirtySince = Date.now();
}

function openImagePreview(src: string): void {
  imagePreviewSrc.value = src;
  imagePreviewVisible.value = true;
}

function closeImagePreview(): void {
  imagePreviewVisible.value = false;
  imagePreviewSrc.value = "";
}

function validateDraftBudget(draft: ThreadDraftPayload): string | null {
  const result = validateInlineThreadPayload(
    { text: draft.text, images: draft.images, files: draft.files, pathReferences: draft.pathReferences ?? [] },
    { contextLabel: "当前草稿" },
  );
  if (result.ok) {
    lastDraftBudgetWarning = "";
    return null;
  }
  return result.message;
}

function reportDraftBudgetWarning(messageText: string): void {
  if (!messageText || lastDraftBudgetWarning === messageText) return;
  lastDraftBudgetWarning = messageText;
  message.warning(messageText);
}

function hasDraftContent(draft: ThreadDraftPayload): boolean {
  return Boolean(draft.text.trim() || draft.images.length || draft.files.length);
}

function beginDraftRemoteMutation(): void {
  draftRemoteMutationDepth.value += 1;
}

function endDraftRemoteMutation(): void {
  draftRemoteMutationDepth.value = Math.max(0, draftRemoteMutationDepth.value - 1);
  flushDeferredDraftVersionReload();
}

/** 条件允许时消费延迟版本信号；未具备加载条件时保留标记等待恢复。 */
function flushDeferredDraftVersionReload(): boolean {
  if (draftRemoteMutationDepth.value !== 0 || !draftVersionReloadDeferred) return false;
  const consumed = reconcileDraftVersionSignal(chat.threadDraftVersionByThreadId[String(props.threadId)] ?? null);
  if (consumed) draftVersionReloadDeferred = false;
  return consumed;
}

/** 仅清理当前草稿保存计时器，保留本轮脏数据起点。 */
function clearDraftSaveTimer(): void {
  if (!draftSaveTimer) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
}

/** 取消待保存草稿，并结束本轮防抖窗口。 */
function cancelDraftSave(): void {
  clearDraftSaveTimer();
  draftDirtySince = 0;
}

/** 先保留本地待确认草稿，再在当前写入状态允许时同步到远端。 */
async function persistDraft(
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  draft: ThreadDraftPayload,
  opts: {
    workspaceScopeToken: number;
    apiContext: ApiRequestContext;
    draftSeq?: number;
    draftScopeEpoch?: number;
    propagateError?: boolean;
  },
): Promise<void> {
  const pendingEpoch = chat.setPendingLocalThreadDraft(threadId, draft, {
    workspaceScopeToken: opts.workspaceScopeToken,
  });
  if (!config.connected && !(localChatReady.value && isDesktopWorkspace(config, workspaceId))) {
    if (opts.propagateError) throw new Error("当前未连接 Server，无法在切换工作区前保存草稿");
    return;
  }
  const applyLocalProjection = pendingEpoch != null;
  const isCurrentThreadAtStart = props.workspaceId === workspaceId && props.threadId === threadId;
  const draftBudgetError = validateDraftBudget(draft);
  if (draftBudgetError) {
    if (opts.propagateError) throw new Error(draftBudgetError);
    reportDraftBudgetWarning(draftBudgetError);
    return;
  }
  if (applyLocalProjection) beginDraftRemoteMutation();
  try {
    const mutationScopeOptions = {
      workspaceScopeToken: opts.workspaceScopeToken,
      ...(pendingEpoch != null ? { pendingEpoch } : {}),
      ...(!applyLocalProjection ? { allowStaleWorkspaceRemoteMutation: true } : {}),
    };
    if (!hasDraftContent(draft)) {
      await chat.clearThreadDraft(opts.apiContext, workspaceId, threadId, mutationScopeOptions);
      if (!applyLocalProjection) return;
      const isCurrentThread = props.workspaceId === workspaceId && props.threadId === threadId;
      const isCurrentDraftScope = opts?.draftScopeEpoch == null || opts.draftScopeEpoch === draftScopeEpoch;
      if (!isCurrentThread || !isCurrentDraftScope) return;
      currentDraftVersion.value = null;
      draftScopeHydrated.value = true;
      if (opts?.draftSeq == null || opts.draftSeq === draftEditSeq) draftDirty = false;
      else {
        chat.setPendingLocalThreadDraft(threadId, snapshotDraft(), {
          workspaceScopeToken: opts.workspaceScopeToken,
        });
        scheduleDraftSave();
      }
      return;
    }

    const saved = await chat.saveThreadDraft(opts.apiContext, workspaceId, threadId, draft, mutationScopeOptions);
    if (!applyLocalProjection) return;
    const isCurrentThread = props.workspaceId === workspaceId && props.threadId === threadId;
    const isCurrentDraftScope = opts?.draftScopeEpoch == null || opts.draftScopeEpoch === draftScopeEpoch;
    if (!isCurrentThread || !isCurrentDraftScope) return;
    currentDraftVersion.value = saved.version;
    draftScopeHydrated.value = true;
    if (opts?.draftSeq == null || opts.draftSeq === draftEditSeq) draftDirty = false;
    else {
      chat.setPendingLocalThreadDraft(threadId, snapshotDraft(), {
        workspaceScopeToken: opts.workspaceScopeToken,
      });
      scheduleDraftSave();
    }
  } catch (e) {
    if (opts.propagateError) throw e;
    if (isCancelledRequestError(e)) return;
    console.error("[composer.draft.save.failed]", { ...describeWorkflowFailure(e), workspaceId, threadId,
      rootCause: e instanceof Error ? e.message : String(e) });
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    if (applyLocalProjection) endDraftRemoteMutation();
  }
}

/** 用户主动切换 workspace 前等待当前 scope 的草稿与偏好保存；失败时中止导航。 */
function flushDraftBeforeWorkspaceSwitch(): Promise<void> | null {
  if (draftDirty && !draftWriteAuthorized) {
    return Promise.reject(new Error("当前无法保存草稿，请检查连接状态"));
  }
  // 统一排空当前 workspace 的全部 prefs，避免旧 thread 的在途写入被 reset 遗失。
  const prefsTask = flushPendingPrefsForWorkspace({ propagateError: true });
  if (!draftDirty) {
    if (!prefsTask) return null;
    workspaceSwitchFlushInProgress.value = true;
    return prefsTask.finally(() => {
      workspaceSwitchFlushInProgress.value = false;
    });
  }

  cancelDraftSave();
  workspaceSwitchFlushInProgress.value = true;
  const matchingScheduledPersist = scheduledDraftPersist
    && scheduledDraftPersist.workspaceId === props.workspaceId
    && scheduledDraftPersist.threadId === props.threadId
    && scheduledDraftPersist.draftSeq === draftEditSeq
    && scheduledDraftPersist.draftScopeEpoch === draftScopeEpoch
    ? scheduledDraftPersist.task
    : null;
  /** 串行等待旧保存后，仅在仍有脏内容时持久化最新草稿。 */
  const persistLatestDraft = () => {
    if (!draftDirty) return Promise.resolve();
    return persistDraft(props.workspaceId, props.threadId, snapshotDraft(), {
      workspaceScopeToken: draftWorkspaceScopeToken,
      apiContext: ctx.value,
      draftSeq: draftEditSeq,
      draftScopeEpoch,
      propagateError: true,
    });
  };
  const draftTask = matchingScheduledPersist
    ? matchingScheduledPersist.then(persistLatestDraft)
    : persistLatestDraft();
  const task = prefsTask ? Promise.all([prefsTask, draftTask]).then(() => undefined) : draftTask;
  return task.finally(() => {
    workspaceSwitchFlushInProgress.value = false;
  });
}

const unregisterWorkspaceDraftFlusher = registerWorkspaceDraftFlusher(flushDraftBeforeWorkspaceSwitch);

/** 切换引擎前保存完整草稿与偏好，返回可带入新会话的输入。 */
async function prepareThreadSwitch(): Promise<ThreadDraftPayload> {
  if (!canAcceptExternalActions()) throw new Error("会话输入尚未就绪，暂时无法切换引擎");
  const draft = snapshotDraft();
  await flushDraftBeforeWorkspaceSwitch();
  return draft;
}

/** 尾随防抖保存草稿，连续输入时最多等待固定上限。 */
function scheduleDraftSave(): void {
  if (draftHydrating.value || props.disabled && !props.allowDraftWhenDisabled || !composerConnected.value) return;
  clearDraftSaveTimer();
  const now = Date.now();
  if (!draftDirtySince) draftDirtySince = now;
  const workspaceId = props.workspaceId;
  const threadId = props.threadId;
  const draftSeq = draftEditSeq;
  const scopeEpoch = draftScopeEpoch;
  const workspaceScopeToken = draftWorkspaceScopeToken;
  const apiContextAtSchedule = ctx.value;
  const maxWaitRemaining = Math.max(0, DRAFT_SAVE_MAX_WAIT_MS - (now - draftDirtySince));
  const delayMs = Math.min(DRAFT_SAVE_DEBOUNCE_MS, maxWaitRemaining);
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    draftDirtySince = 0;
    const task = persistDraft(workspaceId, threadId, snapshotDraft(), {
      workspaceScopeToken,
      apiContext: chat.isThreadDraftWorkspaceScopeCurrent(workspaceScopeToken)
        ? ctx.value
        : apiContextAtSchedule,
      draftSeq,
      draftScopeEpoch: scopeEpoch,
    });
    const tracked = { workspaceId, threadId, draftSeq, draftScopeEpoch: scopeEpoch, task };
    scheduledDraftPersist = tracked;
    void task.finally(() => {
      if (scheduledDraftPersist === tracked) scheduledDraftPersist = null;
    });
  }, delayMs);
}

/** 只读会话不读写草稿；显式允许的暂缓发送状态仍恢复草稿。 */
async function loadThreadDraft(
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  token: number,
  opts?: { silent?: boolean; force?: boolean },
): Promise<void> {
  if (props.disabled && !props.allowDraftWhenDisabled) {
    if (token !== draftLoadToken) return;
    currentDraftVersion.value = null;
    draftScopeHydrated.value = false;
    if (!props.preserveDraftOnDisable) applyDraft(null);
    return;
  }
  const pendingKey = String(threadId);
  if (Object.prototype.hasOwnProperty.call(chat.pendingLocalThreadDraftByThreadId, pendingKey)) {
    if (token !== draftLoadToken) return;
    applyPendingLocalDraft(chat.pendingLocalThreadDraftByThreadId[pendingKey]!);
    draftScopeHydrated.value = true;
    await Promise.resolve();
    if (token !== draftLoadToken || props.workspaceId !== workspaceId || props.threadId !== threadId) return;
    scheduleDraftSave();
    return;
  }
  if (!composerConnected.value) {
    if (token !== draftLoadToken) return;
    currentDraftVersion.value = null;
    draftScopeHydrated.value = false;
    applyDraft(null);
    return;
  }
  draftScopeHydrated.value = false;
  beginDraftRemoteMutation();
  try {
    const draft = await chat.getThreadDraft(ctx.value, workspaceId, threadId, { force: opts?.force });
    if (token !== draftLoadToken) return;
    currentDraftVersion.value = draft?.version ?? null;
    draftScopeHydrated.value = true;
    applyDraft(draft);
  } catch (e) {
    if (isCancelledRequestError(e)) return;
    if (token !== draftLoadToken) return;
    currentDraftVersion.value = null;
    draftScopeHydrated.value = false;
    applyDraft(null);
    console.error("[composer.draft.load.failed]", { ...describeWorkflowFailure(e), workspaceId, threadId,
      rootCause: e instanceof Error ? e.message : String(e) });
    if (!opts?.silent || localChatReady.value) message.error(e instanceof Error ? e.message : String(e));
  } finally {
    endDraftRemoteMutation();
  }
}

/** 将 mutation 期间延迟的草稿版本信号重新加载为当前输入框内容。 */
function reconcileDraftVersionSignal(nextVersion: number | null): boolean {
  if (draftScopeHydrated.value && nextVersion === currentDraftVersion.value) return true;
  if (props.activationManaged) {
    const activation = chat.threadActivationForThread(props.threadId);
    if (activation.threadId !== props.threadId) return false;
    if (activation.phase !== "settled" && activation.phase !== "invalidated") return false;
  }
  if (props.disabled && !props.allowDraftWhenDisabled || !composerConnected.value) return false;
  draftLoadToken += 1;
  void loadThreadDraft(props.workspaceId, props.threadId, draftLoadToken, { silent: true, force: true });
  return true;
}

watch(
  () => [props.workspaceId, props.threadId] as const,
  ([nextWorkspaceId, nextThreadId], prevState) => {
    cancelDraftSave();
    const previousDraftScopeEpoch = draftScopeEpoch;
    const previousWorkspaceScopeToken = draftWorkspaceScopeToken;
    const previousApiContext = draftWorkspaceApiContext;
    if (prevState) {
      const [prevWorkspaceId, prevThreadId] = prevState;
      if (prevThreadId && draftDirty) {
        const draft = snapshotDraft();
        chat.setPendingLocalThreadDraft(prevThreadId, draft, {
          workspaceScopeToken: previousWorkspaceScopeToken,
        });
        if (draftWriteAuthorized) {
          void persistDraft(prevWorkspaceId, prevThreadId, draft, {
            workspaceScopeToken: previousWorkspaceScopeToken,
            apiContext: previousApiContext,
            draftSeq: draftEditSeq,
            draftScopeEpoch: previousDraftScopeEpoch,
          });
        }
      }
    }
    draftScopeEpoch += 1;
    draftWorkspaceScopeToken = chat.captureThreadDraftWorkspaceScopeToken();
    draftWorkspaceApiContext = ctx.value;
    draftAuthorizationWorkspaceId = nextWorkspaceId;
    draftAuthorizationThreadId = nextThreadId;
    if (prevState) {
      draftWriteAuthorized = (!props.disabled || props.allowDraftWhenDisabled) && composerConnected.value;
    }
    draftScopeHydrated.value = false;
    draftVersionReloadDeferred = false;
    currentDraftVersion.value = null;
    // 先用本次会话内已知草稿同步回填，避免等待远端草稿接口/激活期间输入框空窗。
    const nextKey = String(nextThreadId);
    const pendingDraft = chat.pendingLocalThreadDraftByThreadId[nextKey];
    if (pendingDraft) {
      applyPendingLocalDraft(pendingDraft);
    } else if (Object.prototype.hasOwnProperty.call(chat.threadDraftByThreadId, nextKey)) {
      applyDraft(chat.threadDraftByThreadId[nextKey] ?? null);
    } else {
      applyDraft(null);
    }
    if (!props.activationManaged && (!props.disabled || props.allowDraftWhenDisabled)) {
      draftLoadToken += 1;
      void loadThreadDraft(nextWorkspaceId, nextThreadId, draftLoadToken, { silent: true, force: true });
    }
    const prefsTask = flushPendingPrefsForWorkspace();
    if (prefsTask) void prefsTask.catch((error) => reportThreadPrefsSaveFailure(captureThreadPrefsSaveScope(), error));
  },
  // 同步切换草稿，避免“刚切换会话就立刻发送”导致把上一会话附件带到新会话。
  { immediate: true, flush: "sync" },
);

watch(
  () => [
    text.value,
    inputKind.value,
    skillMentions.value,
    imageAttachments.value,
    textFileAttachments.value,
    pathReferences.value,
  ] as const,
  () => {
    if (skipNextDraftWatch) {
      skipNextDraftWatch = false;
      return;
    }
    if (draftHydrating.value) return;
    draftDirty = true;
    draftEditSeq += 1;
    scheduleDraftSave();
  },
  { deep: true },
);

watch(
  () => chat.threadDraftVersionByThreadId[String(props.threadId)] ?? null,
  (nextVersion) => {
    if (draftRemoteMutationDepth.value > 0) {
      draftVersionReloadDeferred = true;
      return;
    }
    if (!reconcileDraftVersionSignal(nextVersion)) draftVersionReloadDeferred = true;
  },
);

watch(
  () => [chat.threadActivationTick, chat.threadActivationForThread(props.threadId).phase, chat.threadActivationForThread(props.threadId).contentEpoch] as const,
  () => {
    if (!props.activationManaged) return;
    if (props.disabled) return;
    const activation = chat.threadActivationForThread(props.threadId);
    if (activation.threadId !== props.threadId) return;
    if (activation.phase !== "settled" && activation.phase !== "invalidated") return;
    if (flushDeferredDraftVersionReload()) return;
    draftLoadToken += 1;
    void loadThreadDraft(props.workspaceId, props.threadId, draftLoadToken, { silent: true });
  },
  { immediate: true },
);

watch(
  () => composerConnected.value,
  (connected) => {
    if (!connected) {
      cancelDraftSave();
      return;
    }
    const prefsTask = flushPendingPrefsForWorkspace();
    if (prefsTask) void prefsTask.catch((error) => reportThreadPrefsSaveFailure(captureThreadPrefsSaveScope(), error));
    const consumedDeferredReload = flushDeferredDraftVersionReload();
    if (!props.activationManaged) {
      if (props.disabled && !props.allowDraftWhenDisabled) return;
      if (consumedDeferredReload) return;
      draftLoadToken += 1;
      void loadThreadDraft(props.workspaceId, props.threadId, draftLoadToken, { silent: true, force: true });
    }
  },
);

watch(
  () => props.disabled && !props.allowDraftWhenDisabled,
  (disabled) => {
    cancelDraftSave();
    draftLoadToken += 1;
    if (disabled) {
      if (props.preserveDraftOnDisable && draftScopeHydrated.value) {
        chat.setPendingLocalThreadDraft(props.threadId, snapshotDraft(), { workspaceScopeToken: draftWorkspaceScopeToken });
      }
      currentDraftVersion.value = null;
      draftScopeHydrated.value = false;
      if (!props.preserveDraftOnDisable) applyDraft(null);
      return;
    }
    if (!composerConnected.value) return;
    if (flushDeferredDraftVersionReload()) return;
    if (props.activationManaged) return;
    void loadThreadDraft(props.workspaceId, props.threadId, draftLoadToken, { silent: true, force: true });
  },
);

// 本地打开文件选择器函数
function handleOpenFilePicker(): void {
  if (composerWriteBlocked.value) return;
  localFileInputEl.value?.click();
}

const conversationState = computed(() => chat.conversations[String(props.threadId)] ?? null);
const hasRealTurnActivity = computed(() => Boolean(chat.threadHasRealTurnActivityByThreadId[String(props.threadId)]));
const hasConversationHistory = computed(() => {
  return hasRealConversationActivity({
    hasRealTurnActivity: hasRealTurnActivity.value,
    conversation: conversationState.value,
  });
});
const isNodeDiscussionThread = computed(() => thread.value?.threadSubtype === "node-discussion");
/** 知识讨论和资产执行线程都使用受控知识工具；它们可以继续输入，但不暴露普通研发权限/计划开关。 */
const isKnowledgeSession = computed(() => thread.value?.threadSubtype === "knowledge-conversation" || thread.value?.threadSubtype === "knowledge-assets");
const engine = computed<EngineType>(() => (thread.value?.engine ?? "codex") as EngineType);
/** 按输入表面和会话引擎展示真实可用的命令入口；手机端无物理键盘，省略按键提示。 */
const composerPlaceholder = computed(() => {
  if (props.disabled && props.allowDraftWhenDisabled) return "可先编写修订草稿，任务结束后再发送";
  if (props.surface === "h5") return "输入消息";
  if (isKnowledgeSession.value) return "";
  const actionHint = engine.value === "claude" ? "/ 命令或技能" : "/ 命令, $ 技能";
  if (isMobile) return `${actionHint}, @ 文件`;
  return `${actionHint}, @ 文件, Enter发送, Shift / Ctrl / Alt + Enter换行`;
});
const inputActionsEnabled = computed(() => isComposerInputActionsEnabled({
  surface: props.surface,
  threadType: thread.value?.threadType ?? null,
  threadSubtype: thread.value?.threadSubtype ?? null,
}));

watch(
  filteredInputActionActions,
  (actions) => normalizeInputActionSelection(actions),
  { flush: "sync" },
);

/** 每次实际正文编辑都重映射 binding，并按 raw text 重算显式输入语义。 */
watch(
  text,
  (nextText, previousText) => {
    if (preserveInputContractTextMutation) return;
    const rebasedSkillMentions = rebaseCodexSkillMentionsAfterEdit(
      previousText,
      nextText,
      skillMentions.value,
    );
    const editedInputKind = resolveEditedComposerInputKind({
      enabled: inputActionsEnabled.value,
      engine: engine.value,
      rawText: nextText,
      skillMentions: rebasedSkillMentions,
    });
    const contract = reconcileComposerInputContract({
      enabled: inputActionsEnabled.value,
      engine: engine.value,
      rawText: nextText,
      inputKind: editedInputKind,
      skillMentions: rebasedSkillMentions,
    });
    skillMentions.value = contract.skillMentions ?? [];
    inputKind.value = contract.inputKind;
  },
  { flush: "sync" },
);

/** 会话作用域或引擎变化时关闭目录，并清理不属于当前引擎的输入合同。 */
watch(
  [() => props.workspaceId, () => props.threadId, engine, inputActionsEnabled],
  () => {
    closeInputActionPicker();
    closeResumePicker();
    modelSelectOpen.value = false;
    roleSelectOpen.value = false;
    const contract = reconcileComposerInputContract({
      enabled: inputActionsEnabled.value,
      engine: engine.value,
      rawText: text.value,
      inputKind: inputKind.value,
      skillMentions: skillMentions.value,
    });
    skillMentions.value = contract.skillMentions ?? [];
    inputKind.value = contract.inputKind;
  },
  { flush: "sync" },
);
const threadPrefs = computed(() => chat.threadPrefsByThreadId[String(props.threadId)] ?? {});
const emit = defineEmits<{ modelPrefsChange: [prefs: { model: string | null; effort: string | null }] }>();

/** 仅把用户主动选择的模型配置通知宿主，恢复历史会话不覆盖项目偏好。 */
function notifyModelPrefsChange(): void {
  emit("modelPrefsChange", { model: effectiveThreadPrefs.value?.model ?? threadPrefs.value.model ?? null, effort: effectiveThreadPrefs.value?.effort ?? threadPrefs.value.effort ?? null });
}
const explicitModel = computed(() => String(threadPrefs.value.model ?? "").trim());
const explicitEffort = computed(() => String(threadPrefs.value.effort ?? "").trim());
const modelCatalogReady = computed(() => (
  modelCatalogLoaded.value
  && engineStatus.value != null
  && engineStatus.value.models.length > 0
));
const effectiveThreadPrefs = computed(() => modelCatalogReady.value
  ? resolveThreadPrefsWithCatalogDefaults(engine.value, threadPrefs.value, engineStatus.value?.models ?? [])
  : null);
const resolvedModelId = computed(() => String(effectiveThreadPrefs.value?.model ?? threadPrefs.value.model ?? "").trim());
const threadConfigLocked = computed(() =>
  hasConversationHistory.value && (engine.value === "claude" || engine.value === "codex")
);

type ThreadPrefsPatch = {
  model?: string | null;
  effort?: string | null;
  accessMode?: AccessMode | null;
  planMode?: boolean | null;
  autoCompactPct?: number | null;
  contextWindow?: number | null;
  serviceTier?: CodexServiceTier | null;
  roleId?: RoleId | null;
  knowledgeEnabled?: boolean | null;
};

/** 合并本地 thread prefs，并按配置选择立即或延迟持久化。 */
function patchThreadPrefs(patch: ThreadPrefsPatch, opts?: { immediateSave?: boolean }): void {
  chat.patchThreadPrefs(props.threadId, patch, props.workspaceId, { apiContext: ctx.value });
  if (opts?.immediateSave) {
    const scope = captureThreadPrefsSaveScope();
    const task = flushPrefsSave(scope);
    if (task) void task.catch((error) => reportThreadPrefsSaveFailure(scope, error));
    return;
  }
  schedulePrefsSave();
}

const model = computed({
  get: () => effectiveThreadPrefs.value?.model ?? (explicitModel.value || undefined),
  set: (v: string) => patchThreadPrefs({ model: String(v ?? "").trim() || null }),
});

const effort = computed({
  get: () => effectiveThreadPrefs.value?.effort ?? (explicitEffort.value || undefined),
  set: (v: string) => { patchThreadPrefs({ effort: String(v ?? "").trim() || null }); notifyModelPrefsChange(); },
});

const accessMode = computed<AccessMode>({
  get: () => isKnowledgeSession.value ? "read-only" : (effectiveThreadPrefs.value?.accessMode ?? PRODUCT_DEFAULT_THREAD_PREFS.accessMode),
  set: (v: AccessMode) => { if (!isKnowledgeSession.value) patchThreadPrefs({
    accessMode: v === PRODUCT_DEFAULT_THREAD_PREFS.accessMode ? null : v,
  }); },
});

const planMode = computed<boolean>({
  get: () => !isKnowledgeSession.value && Boolean(effectiveThreadPrefs.value?.planMode ?? PRODUCT_DEFAULT_THREAD_PREFS.planMode),
  set: (v: boolean) => { if (!isKnowledgeSession.value) patchThreadPrefs({ planMode: v ? true : null }); },
});
const fastModeAvailable = computed(() => !isKnowledgeSession.value && engine.value === "codex" && resolvedModelInfo.value?.supportsFastMode === true);
const fastModeCapabilityKnown = computed(() => engine.value !== "codex" || resolvedModelInfo.value != null);
const fastMode = computed<boolean>({
  get: () => fastModeAvailable.value && effectiveThreadPrefs.value?.serviceTier === "fast",
  set: (enabled: boolean) => patchThreadPrefs(
    { serviceTier: enabled && fastModeAvailable.value ? "fast" : null },
    { immediateSave: true },
  ),
});
const roleOptions = ref<ComposerRoleOption[]>([]);
const roleOptionsLoading = ref(false);
const roleOptionsScopeEpoch = ref(0);
let roleOptionsRefreshVersion = 0;
const roleSelectorVisible = computed(() =>
  Boolean(thread.value && thread.value.threadType !== "orchestration" && thread.value.threadSubtype == null)
);
const selectedRoleId = computed<RoleId | undefined>({
  get: () => {
    if (!roleSelectorVisible.value) return undefined;
    const roleId = String(threadPrefs.value.roleId ?? "").trim();
    return roleId ? (roleId as RoleId) : undefined;
  },
  set: (value: RoleId | undefined) => {
    patchThreadPrefs({ roleId: value ? (String(value).trim() as RoleId) : null }, { immediateSave: true });
  },
});
const accessModeLocked = computed(() => isNodeDiscussionThread.value || isKnowledgeSession.value);
/** 交互模式设置组可见性：节点讨论和知识会话的执行/计划模式由宿主强制锁定，整组不展示。 */
const interactionSettingsVisible = computed(() => !accessModeLocked.value);

/** 只提交当前作用域的最新 Agent 结果；恢复、切换和卸载会使旧请求失效。 */
async function refreshComposerRoles(): Promise<void> {
  const refreshVersion = ++roleOptionsRefreshVersion;
  const workspaceId = props.workspaceId;
  // 静默刷新：已有选项时不清空、不转圈，避免切换界面时下拉闪一下；只有首次加载才显示加载态。
  if (roleOptions.value.length === 0) roleOptionsLoading.value = true;
  try {
    const options = await loadComposerRoleOptions(ctx.value, workspaceId);
    if (refreshVersion !== roleOptionsRefreshVersion || workspaceId !== props.workspaceId) return;
    roleOptions.value = options;
  } catch (error) {
    // 已切换工作区的迟到失败不能干扰当前会话框；当前请求仍需显式抛出并提示。
    if (refreshVersion !== roleOptionsRefreshVersion || workspaceId !== props.workspaceId) return;
    throw error;
  } finally {
    if (refreshVersion === roleOptionsRefreshVersion) roleOptionsLoading.value = false;
  }
}

/** 角色选择器按名称、描述和 ID 做本地搜索。 */
function filterRoleOption(input: string, option: unknown): boolean {
  const keyword = String(input ?? "").trim().toLowerCase();
  if (!keyword) return true;
  const item = option as { label?: string; value?: string; title?: string };
  return [item.label, item.value, item.title]
    .map((value) => String(value ?? "").toLowerCase())
    .some((value) => value.includes(keyword));
}

/** 账号与运行时身份同步围栏，防止同 tick 切回原账号时旧请求复活。 */
function roleOwnerScope(): string {
  return JSON.stringify([config.userSummary?.userId, config.serverWsOrigin, config.sessionToken, config.desktopRuntime?.requestId,
    config.desktopCloudAccount?.generation, config.desktopCloudAccount?.status]);
}

watch(roleOwnerScope, () => {
  roleOptionsRefreshVersion += 1;
  roleOptions.value = [];
  roleOptionsLoading.value = false;
  roleOptionsScopeEpoch.value += 1;
}, { flush: "sync" });

watch(
  () => [roleSelectorVisible.value, props.workspaceId, composerConnected.value, roleOwnerScope(), roleOptionsScopeEpoch.value] as const,
  ([visible, workspaceId, connected, ownerScope, scopeEpoch], previous) => {
    const visibleChanged = !previous || visible !== previous[0];
    const workspaceChanged = !previous || workspaceId !== previous[1];
    const connectedChanged = !previous || connected !== previous[2];
    const ownerChanged = !previous || ownerScope !== previous[3];
    const scopeChanged = !previous || scopeEpoch !== previous[4];
    const contextChanged = visibleChanged || workspaceChanged || connectedChanged || ownerChanged || scopeChanged;
    if (!contextChanged) return;
    if (ownerChanged) roleOptions.value = [];
    if (!visible || !connected) {
      roleOptionsRefreshVersion += 1;
      roleOptions.value = [];
      roleOptionsLoading.value = false;
      return;
    }
    // 旧工作区的选项不属于当前项目，切换时必须丢弃；同工作区的刷新保持静默。
    if (workspaceChanged) {
      roleOptions.value = [];
      roleOptionsLoading.value = false;
    }
    const request = refreshComposerRoles();
    const refreshVersion = roleOptionsRefreshVersion;
    void request.catch((error) => {
      if (refreshVersion !== roleOptionsRefreshVersion) return;
      const details = (error as { details?: { requestId?: unknown; serverRequestId?: unknown } })?.details;
      console.warn("[composer.roles.failed]", { code: (error as { code?: unknown })?.code ?? "COMPOSER_ROLES_FAILED",
        requestId: details?.serverRequestId ?? details?.requestId ?? null, workspaceId, threadId: props.threadId,
        rootCause: error instanceof Error ? error.message : String(error) });
      message.error(error instanceof Error ? `Agent 列表加载失败：${error.message}` : "Agent 列表加载失败");
    });
  },
  { immediate: true },
);

onUnmounted(() => { roleOptionsRefreshVersion += 1; });

// ── 主动推荐开关（会话级行为开关，与工作流面板同源可见） ──
const recommendationEnabled = ref(false);
const workflowToggleBusy = ref(false);
let workflowPrefVersion = 0;

const knowledgeEnabled = computed(() => !isKnowledgeSession.value && threadPrefs.value.knowledgeEnabled === true);
const knowledgeToggleBusy = ref(false);

/** 开启 Spec 前确认当前项目已初始化规格库，避免注入空资产范围。 */
async function toggleKnowledgeEnabled(): Promise<void> {
  if (composerWriteBlocked.value || isKnowledgeSession.value || knowledgeToggleBusy.value) return;
  const next = !knowledgeEnabled.value;
  if (!next) {
    patchThreadPrefs({ knowledgeEnabled: false }, { immediateSave: true });
    return;
  }
  const workspaceId = props.workspaceId;
  const threadId = props.threadId;
  knowledgeToggleBusy.value = true;
  try {
    const result = await requestKnowledgeAsset(ctx.value, "snapshot", { workspaceId });
    if (!result.ok) throw createApiResultError(result);
    if (workspaceId !== props.workspaceId || threadId !== props.threadId) return;
    if (!result.data.initialized) {
      message.info("当前项目尚未初始化规格库，请先进入“规格库”点击“一键生成规格”");
      return;
    }
    patchThreadPrefs({ knowledgeEnabled: true }, { immediateSave: true });
  } catch (error) {
    if (workspaceId !== props.workspaceId || threadId !== props.threadId) return;
    console.error("[chat-knowledge.toggle.failed]", { ...describeWorkflowFailure(error), workspaceId, threadId, error });
    message.error(error instanceof Error ? `规格库状态校验失败：${error.message}` : "规格库状态校验失败");
  } finally {
    knowledgeToggleBusy.value = false;
  }
}

/** 归一化 API 失败为可检索的错误码与 requestId。 */
function describeWorkflowFailure(source: unknown): { code: string; requestId: string | null } {
  if (!isApiResultError(source)) return { code: "REQUEST_THROWN", requestId: null };
  const details = source.details as { requestId?: unknown } | undefined;
  const requestId = typeof details?.requestId === "string" ? details.requestId.trim() : "";
  return { code: source.code, requestId: requestId || null };
}

/** 读取当前可连接会话的工作流偏好；只采纳最新请求，失败保持原状态并局部提示，不升级为应用级错误。 */
async function refreshWorkflowPreference(): Promise<void> {
  const version = ++workflowPrefVersion;
  const workspaceId = props.workspaceId;
  const threadId = props.threadId;
  if (!props.workflowToggleVisible || !composerConnected.value) {
    recommendationEnabled.value = false;
    return;
  }
  try {
    const result = await getChatWorkflow(ctx.value, workspaceId, threadId);
    if (version !== workflowPrefVersion || workspaceId !== props.workspaceId || threadId !== props.threadId) return;
    if (!result.ok) throw createApiResultError(result);
    recommendationEnabled.value = result.recommendationEnabled;
  } catch (error) {
    if (version !== workflowPrefVersion || workspaceId !== props.workspaceId || threadId !== props.threadId) return;
    console.warn("[chat-recommendation.read.failed]", { ...describeWorkflowFailure(error), workspaceId, threadId, error });
    message.warning(error instanceof Error ? `工作流状态读取失败：${error.message}` : "工作流状态读取失败");
  }
}

/** 切换主动推荐开关；以服务端返回的快照为准，失败时提示且不改动本地状态。 */
async function toggleWorkflowRecommendation(): Promise<void> {
  if (composerWriteBlocked.value || workflowToggleBusy.value) return;
  const version = workflowPrefVersion;
  const workspaceId = props.workspaceId;
  const threadId = props.threadId;
  workflowToggleBusy.value = true;
  try {
    const result = await setChatWorkflowEnabled(ctx.value, workspaceId, threadId, !recommendationEnabled.value);
    if (version !== workflowPrefVersion || workspaceId !== props.workspaceId || threadId !== props.threadId) return;
    if (!result.ok) throw createApiResultError(result);
    recommendationEnabled.value = result.recommendationEnabled;
  } catch (error) {
    if (version !== workflowPrefVersion || workspaceId !== props.workspaceId || threadId !== props.threadId) return;
    console.error("[chat-recommendation.toggle.failed]", { ...describeWorkflowFailure(error), workspaceId, threadId, error });
    message.error(error instanceof Error ? `主动推荐开关更新失败：${error.message}` : "主动推荐开关更新失败");
  } finally {
    if (version === workflowPrefVersion) workflowToggleBusy.value = false;
  }
}

watch(
  () => [props.workspaceId, props.threadId, props.workflowToggleVisible, composerConnected.value],
  async () => {
    workflowToggleBusy.value = false;
    await refreshWorkflowPreference();
  },
  { immediate: true },
);

/** 知识会话使用标准档位，其他会话按 Codex 模型能力开放 Fast。 */
function supportsCodexFastMode(modelId: string | null): boolean {
  if (isKnowledgeSession.value || engine.value !== "codex") return false;
  if (!modelCatalogReady.value) return false;
  const targetModelId = String(modelId ?? "").trim();
  if (!targetModelId) return fastModeAvailable.value;
  return getEngineModelInfo(engine.value, targetModelId, engineStatus.value?.models)?.supportsFastMode === true;
}

/** 记录用户是否在当前线程手动切换过模型；手动选择后不再被供应商可用性回退覆盖。 */
const userSelectedModelManually = ref(false);

/** 切换模型时同步窗口，只有已手动开启且新模型支持时才保留 Fast。 */
function handleModelChange(nextValue: string, manual = false): void {
  const nextModel = String(nextValue ?? "").trim() || null;
  const previousModel = resolvedModelId.value;
  const previousEffectiveEffort = String(effectiveThreadPrefs.value?.effort ?? threadPrefs.value.effort ?? "").trim();
  const previousExplicitEffort = explicitEffort.value;
  const previousDefaultEffort = getDefaultReasoningEffortForModel(engine.value, previousModel, engineStatus.value?.models);
  const nextDefaultEffort = getDefaultReasoningEffortForModel(engine.value, nextModel, engineStatus.value?.models);
  const shouldFollowModelDefault = !previousExplicitEffort
    || (!!previousDefaultEffort && previousEffectiveEffort === previousDefaultEffort);
  const nextContextWindow = normalizeThreadContextWindowForModel(nextModel);
  const nextServiceTier = effectiveThreadPrefs.value?.serviceTier === "fast" && supportsCodexFastMode(nextModel) ? "fast" : null;

  const nextPatch: {
    model: string | null;
    effort: string | null;
    contextWindow: number | null;
    serviceTier: CodexServiceTier | null;
  } = {
    model: nextModel,
    effort: shouldFollowModelDefault ? (nextDefaultEffort ?? null) : (previousExplicitEffort || null),
    contextWindow: nextContextWindow,
    serviceTier: nextServiceTier,
  };
  patchThreadPrefs(nextPatch);
  if (manual) userSelectedModelManually.value = true;
}

// 切换线程时重置手动选择标记，使新线程首次仍可走供应商可用性兜底。
watch(() => props.threadId, () => {
  userSelectedModelManually.value = false;
});

const workMode = computed(() => "general" as const);

const autoCompactPct = computed<number>({
  get: () => effectiveThreadPrefs.value?.autoCompactPct ?? PRODUCT_DEFAULT_AUTO_COMPACT_PCT,
  set: (v: number) => {
    if (threadConfigLocked.value) return;
    const normalized = Math.min(99, Math.max(50, Math.round(v)));
    patchThreadPrefs({ autoCompactPct: normalized });
  },
});

// ── 模型上下文窗口 ──

const modelContextBounds = computed(() => resolveModelContextBounds(engine.value, resolvedModelInfo.value));
const showContextWindowInfo = computed(() => modelContextBounds.value.maxContextWindow > 0);

/** 当前窗口始终跟随模型目录最大值，历史会话覆盖不再参与。 */
const effectiveContextWindow = computed(() => normalizeThreadContextWindowForModel(resolvedModelId.value));

/** 上下文设置组：压缩阈值与上下文窗口按引擎与模型能力出现。 */
const showAutoCompactControl = computed(() =>
  engine.value === "claude" || engine.value === "codex"
);
const showContextSettings = computed(() =>
  showAutoCompactControl.value || showContextWindowInfo.value
);
/** 设置弹出层是否有内容可显示（避免空 popover） */
const hasSettingsContent = computed(() =>
  interactionSettingsVisible.value || showContextSettings.value
);

const autoCompactMin = 50;
const autoCompactMax = 99;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 按执行端模型目录派生最大窗口。 */
function normalizeThreadContextWindowForModel(modelId: string | null): number {
  return normalizeThreadContextWindow(engine.value, modelId, null, engineStatus.value?.models);
}

watch(
  () => [fastModeCapabilityKnown.value, fastModeAvailable.value, threadPrefs.value.serviceTier] as const,
  ([capabilityKnown, available, serviceTier]) => {
    if (serviceTier === "fast" && capabilityKnown && !available) patchThreadPrefs({ serviceTier: null });
  },
);

/** 发送前解析 Codex 服务档位；未开启或不支持时显式清空。 */
function resolveCodexServiceTierForSend(): CodexServiceTier | null {
  return fastMode.value ? "fast" : null;
}

/** 发送时使用当前模型最大窗口，覆盖历史请求参数。 */
function resolveContextWindowForSend(): number | undefined {
  return effectiveContextWindow.value > 0 ? effectiveContextWindow.value : undefined;
}

function resolveAutoCompactPctForSend(): number {
  return autoCompactPct.value;
}

/** 发送前冻结当前普通聊天角色；非普通聊天不注入角色。 */
function resolveRoleIdForSend(): RoleId | null {
  return roleSelectorVisible.value ? (selectedRoleId.value ?? null) : null;
}

const settingsHelp = {
  accessMode: '访问模式 (Permission Mode)\n控制 AI 对文件系统和工具的访问权限\n1. Claude → --permission-mode\n2. Codex → approvalPolicy + sandboxPolicy',
  model: '模型 (Model)\nClaude → --model <id>\nCodex → turn/start.model\n留空使用引擎默认模型',
  effort: '思考强度 (Reasoning Effort)\n可选项由当前模型配置动态决定\nClaude → --effort\nCodex → effort\n更高 = 更深入推理，消耗更多 token',
  fastMode: 'Fast 模式\nCodex 请求响应会更快，但费用消耗可能增加30%~50%',
  knowledge: 'Spec 模式 \n开启后，会话会按已采用的规格和知识约束代码实现与验证。',
  recommendation: '工作流模式\n开启后，会话中会根据需要，主动推荐您合适的工作流，您可以在会话中选择工作流来实现需求开发与验证。',
  planMode: '计划模式\nAI 仅做分析和规划，不执行任何修改',
  autoCompactPct: `压缩阈值 (Auto-Compact %)\n上下文使用达到此百分比时自动触发压缩\n默认值：${PRODUCT_DEFAULT_AUTO_COMPACT_PCT}%\nClaude → --settings env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE\nCodex → 运行时换算为 model_auto_compact_token_limit`,
};

const contextBillingHint = computed(() => getModelContextBillingHint(resolvedModelInfo.value));
const contextWindowHelp = computed(() =>
  "自动使用当前模型支持的最大上下文窗口：" + formatTokens(effectiveContextWindow.value) + "。"
);

const threadConfigLockHint = computed(() =>
  threadConfigLocked.value ? "已有对话后，压缩阈值已锁定。" : ""
);

// ── 会话级 prefs 自动持久化（debounce 300ms） ──
type ThreadPrefsSaveScope = {
  apiContext: ApiRequestContext;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  workspaceScopeToken: number;
};

/** 冻结当前会话身份，避免 debounce 延迟后借用新登录 token。 */
function freezeThreadPrefsApiContext(apiContext: ApiRequestContext): ApiRequestContext {
  const sessionToken = String(apiContext.sessionToken ?? "").trim();
  const webSessionId = String(apiContext.webSessionId ?? "").trim();
  return {
    serverWsOrigin: apiContext.serverWsOrigin,
    desktopClientId: apiContext.desktopClientId,
    sessionToken: sessionToken || null,
    webSessionId: webSessionId || null,
    ensureSession: async () => {
      if (!sessionToken) throw new Error("会话配置请求入队时缺少鉴权 token（session）");
      return sessionToken;
    },
  };
}

/** 捕获调度时的保存目标，避免 thread 切换后读取到新的 props。 */
function captureThreadPrefsSaveScope(): ThreadPrefsSaveScope {
  return {
    apiContext: freezeThreadPrefsApiContext(ctx.value),
    workspaceId: props.workspaceId,
    threadId: props.threadId,
    workspaceScopeToken: chat.captureThreadDraftWorkspaceScopeToken(),
  };
}

/** 判断两个偏好保存目标是否属于同一 workspace/thread。 */
function isSameThreadPrefsSaveScope(left: ThreadPrefsSaveScope, right: ThreadPrefsSaveScope): boolean {
  return left.workspaceId === right.workspaceId && left.threadId === right.threadId;
}

/** 记录可检索的保存失败上下文，并向用户明确反馈。 */
function reportThreadPrefsSaveFailure(scope: ThreadPrefsSaveScope, error: unknown): void {
  void scope;
  message.error(error instanceof Error ? `会话配置保存失败：${error.message}` : "会话配置保存失败");
}

/** 立即保存指定 scope 的 pending prefs；失败由调用方决定是否提示或阻断切换。 */
function flushPrefsSave(
  scope: ThreadPrefsSaveScope = captureThreadPrefsSaveScope(),
  opts?: { propagateError?: boolean },
): Promise<void> | null {
  const pending = chat.pendingThreadPrefsByThreadId[String(scope.threadId)];
  if (!pending || Object.keys(pending).length === 0) {
    if (pendingPrefsSave && isSameThreadPrefsSaveScope(pendingPrefsSave.scope, scope)) {
      clearTimeout(pendingPrefsSave.timer);
      pendingPrefsSave = null;
    }
    return null;
  }
  // 断线时保留已触发的 timer/scope，重连 watcher 才能重新入队；workspace flush 则显式失败。
  if ((!config.connected && !(localChatReady.value && isDesktopWorkspace(config, scope.workspaceId))) || !scope.threadId) {
    return opts?.propagateError
      ? Promise.reject(new Error("服务连接已断开，无法保存会话配置"))
      : null;
  }
  if (pendingPrefsSave && isSameThreadPrefsSaveScope(pendingPrefsSave.scope, scope)) {
    clearTimeout(pendingPrefsSave.timer);
    pendingPrefsSave = null;
  }
  return chat.saveThreadPrefs(scope.apiContext, scope.workspaceId, scope.threadId, {
    workspaceScopeToken: scope.workspaceScopeToken,
  });
}

/** 统一冲刷当前 workspace 的全部 pending prefs；断线时显式阻断 workspace 切换。 */
function flushPendingPrefsForWorkspace(opts?: { propagateError?: boolean }): Promise<void> | null {
  const hasPending = Object.values(chat.pendingThreadPrefsByThreadId).some((prefs) => Object.keys(prefs ?? {}).length > 0);
  if (!hasPending) return null;
  if (!composerConnected.value) {
    return opts?.propagateError
      ? Promise.reject(new Error("服务连接已断开，无法保存会话配置"))
      : null;
  }
  if (pendingPrefsSave) {
    clearTimeout(pendingPrefsSave.timer);
    pendingPrefsSave = null;
  }
  return chat.flushPendingThreadPrefs(ctx.value, props.workspaceId, {
    workspaceScopeToken: chat.captureThreadDraftWorkspaceScopeToken(),
  });
}

/** 延迟保存频繁变化的 prefs；切换 thread 时保留旧目标的保存。 */
function schedulePrefsSave(): void {
  const scope = captureThreadPrefsSaveScope();
  if (pendingPrefsSave) {
    if (isSameThreadPrefsSaveScope(pendingPrefsSave.scope, scope)) {
      clearTimeout(pendingPrefsSave.timer);
    } else {
      const previousScope = pendingPrefsSave.scope;
      // 旧 scope 会在这里立即 flush；取消原 timer，避免它稍后再次提交同一补丁。
      clearTimeout(pendingPrefsSave.timer);
      pendingPrefsSave = null;
      const previousTask = flushPrefsSave(previousScope);
      if (previousTask) void previousTask.catch((error) => reportThreadPrefsSaveFailure(previousScope, error));
    }
  }
  const timer = setTimeout(() => {
    const task = flushPrefsSave(scope);
    if (task) void task.catch((error) => reportThreadPrefsSaveFailure(scope, error));
  }, 300);
  pendingPrefsSave = { scope, timer };
}

onUnmounted(() => {
  unregisterWorkspaceDraftFlusher();
  closeInputActionPicker();
  closeResumePicker();
  closeMentionPicker();
  cancelDraftSave();
  if (draftDirty) {
    const draft = snapshotDraft();
    chat.setPendingLocalThreadDraft(props.threadId, draft, {
      workspaceScopeToken: draftWorkspaceScopeToken,
    });
    if (draftWriteAuthorized) {
      void persistDraft(props.workspaceId, props.threadId, draft, {
        workspaceScopeToken: draftWorkspaceScopeToken,
        apiContext: draftWorkspaceApiContext,
        draftSeq: draftEditSeq,
        draftScopeEpoch,
      });
    }
  }
  const prefsTask = flushPendingPrefsForWorkspace();
  if (prefsTask) void prefsTask.catch((error) => reportThreadPrefsSaveFailure(captureThreadPrefsSaveScope(), error));
  toolbarDragState = null;
  toolbarDragging.value = false;
});

const threadQueueStore = useThreadQueueStore();
const isNodeExecutionThread = computed(() => thread.value?.threadSubtype === "node");

/** 本地 `/compact` 浮层打开时实时同步会话与队列可用状态。 */
watch(
  [hasConversationHistory, () => props.runningTurnId, () => threadQueueStore.itemCountFor(props.threadId)],
  () => {
    if (inputActionOpen.value && engine.value === "codex" && inputActionTokenRange.value?.trigger === "/") {
      inputActionActions.value = buildCurrentCodexSlashActions();
    }
  },
);

/** 节点线程始终入队；其他线程在运行中或队列非空时入队；队列因中断暂停时走直发以继续会话。 */
const enqueueMode = computed(() => {
  if (!props.allowQueue) return false;
  return shouldEnqueueInsteadOfSend({
    threadSubtype: thread.value?.threadSubtype ?? null,
    runningTurnId: props.runningTurnId,
    queueLength: threadQueueStore.itemCountFor(props.threadId as any),
    queuePausedReason: threadQueueStore.pausedReasonFor(props.threadId as any),
  });
});

const hasComposerPayload = computed(() => Boolean(text.value.trim() || imageAttachments.value.length || textFileAttachments.value.length));
const currentComposerInputSubmission = computed(() => resolveComposerInputSubmission({
  enabled: inputActionsEnabled.value,
  engine: engine.value,
  rawText: text.value,
  inputKind: inputKind.value,
  skillMentions: skillMentions.value,
}));
const isSharedWorkspace = computed(() => isSharedWorkspaceSelectionId(config.workspaceId));
const configuredProviderIdsForEngine = computed(() => engineKeys.providerIdsForEngine(engine.value));
const availableModelProviderIds = computed(() =>
  resolveAvailableModelProviderIds(engine.value, engineStatus.value, {
    isSharedWorkspace: isSharedWorkspace.value,
    hasMaintainedKeys: !isSharedWorkspace.value && engineKeys.hasKeysForEngine(engine.value),
    activeProviderIds: isSharedWorkspace.value ? [] : configuredProviderIdsForEngine.value,
    keyLoadError: keyProviderLoadIssue.value ? engineKeys.lastError : null,
  }),
);
const restrictModelsByKeyProvider = computed(() => availableModelProviderIds.value !== null);
const allowedModelProviderIds = computed(() => availableModelProviderIds.value);
const selectedModelProvider = computed(() => {
  if (resolvedModelInfo.value) return resolveModelProvider(resolvedModelInfo.value);
  const id = resolvedModelId.value;
  if (!id) return null;
  return resolveModelProvider({ id, displayName: id, isDefault: false });
});
const selectedModelProviderId = computed(() => selectedModelProvider.value?.id ?? null);
const keyProviderLoadIssue = computed(() => {
  if (isSharedWorkspace.value) return null;
  if (!composerConnected.value || !engineKeys.lastError) return null;
  return `无法读取大模型 Key 配置：${engineKeys.lastError}`;
});
const engineUnavailableIssue = computed(() =>
  resolveEngineUnavailableIssue(engine.value, engineStatus.value, {
    isSharedWorkspace: isSharedWorkspace.value,
    hasMaintainedKeys: !isSharedWorkspace.value && engineKeys.hasKeysForEngine(engine.value),
    activeProviderIds: configuredProviderIdsForEngine.value,
    keyLoadError: keyProviderLoadIssue.value ? engineKeys.lastError : null,
  }),
);
const workspaceKeyScope = computed(() => engineKeys.scopeSnapshotForWorkspace(props.workspaceId));

/** 当前工作区已启用的 Key 供应商；与模型可用性判断保持同一份作用域快照。 */
function activeProviderIdsForSetup(engine: EngineType): string[] {
  const ids = new Set<string>();
  for (const key of workspaceKeyScope.value.keys) {
    if (key.engine !== engine || !key.isActive) continue;
    const providerId = normalizeEngineKeyProviderId(engine, key.providerId);
    if (providerId) ids.add(providerId);
  }
  return [...ids];
}
const localModelSetupActive = computed(() => needsLocalModelSetup({
  isDesktop: config.isDesktop && isDesktopWorkspace(config, props.workspaceId),
  localRuntimeReady: config.localRuntimeReady,
  hasActiveSession: config.hasActiveSession,
  desktopCloudAccountLinked: config.desktopCloudAccountLinked,
  keyStoreLoading: workspaceKeyScope.value.phase !== "success",
  keyStoreError: workspaceKeyScope.value.lastError,
  engineStatusLoading: Boolean(engines.byWorkspaceId[String(props.workspaceId)]?.loading),
  hasKeysByEngine: {
    claude: workspaceKeyScope.value.keys.some((key) => key.engine === "claude"),
    codex: workspaceKeyScope.value.keys.some((key) => key.engine === "codex"),
  },
  activeProviderIdsByEngine: {
    claude: activeProviderIdsForSetup("claude"),
    codex: activeProviderIdsForSetup("codex"),
  },
  statuses: {
    claude: engines.byTypeForWorkspace(props.workspaceId).get("claude"),
    codex: engines.byTypeForWorkspace(props.workspaceId).get("codex"),
  },
}));

function openModelKeySettings(): void {
  appModals?.openSettings("engine-keys");
}

const queueAppendedToast = ref<{ pendingCount: number } | null>(null);
let queueAppendedToastTimer: ReturnType<typeof setTimeout> | null = null;

/** 入队成功后显示输入框上方轻提示；不自动展开队列浮层，避免遮挡主界面。 */
function notifyThreadQueueAppended(threadId: ThreadId): void {
  const pendingCount = threadQueueStore.itemsFor(threadId).filter((item) => item.status === "pending").length;
  queueAppendedToast.value = { pendingCount };
  if (queueAppendedToastTimer != null) clearTimeout(queueAppendedToastTimer);
  queueAppendedToastTimer = setTimeout(() => {
    queueAppendedToastTimer = null;
    queueAppendedToast.value = null;
  }, 2500);
}

function openModelLogin(): void {
  appModals?.openDesktopAuth();
}

/** 优先展示本工作区检测失败，未完成检测不能被判定为没有可用模型。 */
const currentModelProviderIssue = computed(() => {
  const state = engines.byWorkspaceId[String(props.workspaceId)];
  if (state?.lastError) return `无法读取模型引擎状态：${state.lastError}`;
  if (!modelCatalogReady.value) return state?.loading || state?.lastUpdatedAt == null
    ? "正在加载模型引擎状态，请稍候。"
    : "当前引擎没有可用模型，请检查模型配置。";
  if (engineCliMissingIssue.value) return engineCliMissingIssue.value;
  if (engineUnavailableIssue.value) return engineUnavailableIssue.value;
  if (keyProviderLoadIssue.value) return keyProviderLoadIssue.value;
  if (resolvedModelId.value && !resolvedModelInfo.value) {
    return `当前模型 ${resolvedModelId.value} 已从模型目录移除，请重新选择模型。`;
  }
  if (!restrictModelsByKeyProvider.value) return null;
  const activationIssue = resolveEngineKeyActivationIssue(engine.value, engineStatus.value, {
    isSharedWorkspace: isSharedWorkspace.value,
    hasMaintainedKeys: !isSharedWorkspace.value && engineKeys.hasKeysForEngine(engine.value),
    activeProviderIds: configuredProviderIdsForEngine.value,
  });
  if (activationIssue) return activationIssue;
  const provider = selectedModelProvider.value;
  if (!provider || !resolvedModelId.value) return null;
  const allowedProviderIds = allowedModelProviderIds.value ?? [];
  const allowed = new Set<string>(allowedProviderIds);
  if (allowed.has(provider.id)) return null;
  const modelLabel = resolvedModelInfo.value?.displayName ?? resolvedModelId.value;
  const configuredLabels = allowedProviderIds.map(getEngineProviderLabel).join(" / ") || "当前可用供应商";
  return `当前 Key 供应商为 ${configuredLabels}，不支持 ${modelLabel}（${provider.label}）。请到“模型配置”新增或启用 ${provider.label} Key，或切换为 ${configuredLabels} 模型。`;
});
const firstAllowedProviderModel = computed(() => {
  const allowed = allowedModelProviderIds.value;
  if (!allowed?.length) return null;
  const allowedSet = new Set<string>(allowed);
  return (engineStatus.value?.models ?? []).find((item) => allowedSet.has(resolveModelProvider(item).id)) ?? null;
});

watch(
  () => [
    props.threadId,
    hasConversationHistory.value,
    restrictModelsByKeyProvider.value,
    availableModelProviderIds.value?.join("|") ?? "legacy",
    resolvedModelId.value,
    engineStatus.value?.models.length ?? 0,
  ] as const,
  () => {
    // 知识会话必须保留明确选择的供应商；凭据不可用时展示错误并阻止发送。
    if (isKnowledgeSession.value || hasConversationHistory.value || !restrictModelsByKeyProvider.value) return;
    if (userSelectedModelManually.value) return;
    const provider = selectedModelProvider.value;
    if (provider && availableModelProviderIds.value?.some((providerId) => providerId === provider.id)) return;
    const firstModel = firstAllowedProviderModel.value;
    if (!firstModel) return;
    handleModelChange(firstModel.id);
  },
  { immediate: true },
);

const turnPhase = computed(() => chat.threadDisplayRunningStateForThread(props.threadId)?.phase);
const turnDraining = computed(() => turnPhase.value === "draining");
const turnSaveFailed = computed(() => turnPhase.value === "failed");

const canSend = computed(() => {
  if (turnDraining.value || turnSaveFailed.value) return false;
  if (pendingReads.value) return false;
  const hostAction = currentComposerInputSubmission.value.mode === "host-action";
  if (!hostAction && currentModelProviderIssue.value) return false;
  return shouldAllowComposerSend({
    disabled: props.disabled,
    connected: config.connected,
    hasWebSession: Boolean(config.webSessionId),
    localReady: localChatReady.value,
    sending: sending.value,
    hasModelRequirement: !hostAction && flatModelOptions.value.length > 0,
    hasSelectedModel: Boolean(model.value),
    hasContent: hasComposerPayload.value,
    runningTurnId: props.runningTurnId,
    allowDuringRunning: props.allowQueue,
  });
});

const sendButtonLabel = computed(() => {
  if (pendingReads.value) return "读取附件中";
  if (sending.value) return isNodeExecutionThread.value ? "发送中" : (sendingViaQueue.value ? "入队中" : "发送中");
  if (props.disabled) return props.allowDraftWhenDisabled ? "待任务结束" : "不可发送";
  if (!composerConnected.value || (!localChatReady.value && !config.webSessionId)) return "未连接";
  if (currentComposerInputSubmission.value.mode !== "host-action" && engineCliMissing.value) return "CLI 未安装";
  if (currentComposerInputSubmission.value.mode !== "host-action" && localModelSetupActive.value) return "请配置 Key";
  if (currentComposerInputSubmission.value.mode !== "host-action" && currentModelProviderIssue.value) return "模型不可用";
  if (currentComposerInputSubmission.value.mode !== "host-action" && flatModelOptions.value.length && !model.value) return "请选择模型";
  if (!hasComposerPayload.value) return "待输入";
  if (currentComposerInputSubmission.value.mode !== "message") return "执行";
  if (isNodeExecutionThread.value) return "发送";
  return enqueueMode.value ? "入队" : "发送";
});

const sendButtonTitle = computed(() => {
  if (pendingReads.value) return "正在读取附件，请稍候";
  if (sending.value) return "正在发送";
  if (props.disabled) return props.allowDraftWhenDisabled ? "可先编写草稿，任务结束后再发送" : "当前状态下不可发送";
  if (!composerConnected.value || (!localChatReady.value && !config.webSessionId)) return "连接成功后才能发送";
  if (currentComposerInputSubmission.value.mode !== "host-action" && engineCliMissingIssue.value) return engineCliMissingIssue.value;
  if (currentComposerInputSubmission.value.mode !== "host-action" && localModelSetupActive.value) {
    return "未登录且未配置模型 Key，当前无法发送。请先配置模型 Key 或登录账号。";
  }
  if (currentComposerInputSubmission.value.mode !== "host-action" && currentModelProviderIssue.value) return currentModelProviderIssue.value;
  if (!hasComposerPayload.value) return "请输入消息或添加附件后发送";
  if (currentComposerInputSubmission.value.mode !== "message") return "执行当前输入命令";
  return "Enter 发送，Shift / Ctrl / Alt + Enter换行";
});

/** 终止操作不受写入状态限制。 */
const primaryActionIsStop = computed(() => Boolean(
  props.runningTurnId
  && (turnDraining.value || turnSaveFailed.value || !props.allowQueue || !hasComposerPayload.value)
  && !props.disabled,
));
const primaryActionLabel = computed(() => {
  if (!primaryActionIsStop.value) return sendButtonLabel.value;
  if (turnSaveFailed.value) return "重试终止";
  if (turnDraining.value) return "保存中";
  return interrupting.value || turnPhase.value === "stopping" ? "终止中" : "终止";
});
const primaryActionTitle = computed(() => {
  if (!primaryActionIsStop.value) return sendButtonTitle.value;
  if (turnSaveFailed.value) return "输出保存失败，仍可停止引擎并重试收尾";
  if (turnDraining.value) return "已停止，正在保存剩余输出";
  return "终止当前会话";
});
const primaryActionLoading = computed(() => primaryActionIsStop.value ? interrupting.value || turnDraining.value : sending.value);
const primaryActionDisabled = computed(() => primaryActionIsStop.value ? (!composerConnected.value || interrupting.value || turnDraining.value) : !canSend.value);
const primaryActionClass = computed(() => {
  if (primaryActionIsStop.value) return "composer__send-btn--stop";
  if (currentComposerInputSubmission.value.mode === "message"
    && enqueueMode.value
    && hasComposerPayload.value
    && canSend.value) return "composer__send-btn--queue";
  return canSend.value ? "composer__send-btn--ready" : "composer__send-btn--idle";
});
const primaryActionType = computed(() =>
  primaryActionClass.value === "composer__send-btn--ready" || primaryActionClass.value === "composer__send-btn--queue"
    ? "primary"
    : "default",
);
const primaryActionDanger = computed(() => primaryActionClass.value === "composer__send-btn--stop");

/** 单一主按钮：运行中无输入时终止，有输入时直接入队。 */
function handlePrimaryAction(): void {
  if (primaryActionIsStop.value) {
    void interrupt();
    return;
  }
  void send();
}

const modelOptionGroups = computed(() =>
  engineUnavailableIssue.value
    ? []
    : buildModelSelectOptionGroups(engineStatus.value?.models ?? [], model.value, {
      allowedProviderIds: allowedModelProviderIds.value,
      engine: engine.value,
    }),
);
const flatModelOptions = computed(() => flattenModelSelectOptionGroups(modelOptionGroups.value));

const effortOptions = computed(() => {
  const info = resolvedModelInfo.value;
  const supported = info?.supportedReasoningEfforts ?? null;
  if (!supported?.length) return [] as Array<{ value: string; label: string }>;
  return supported.map((option) => ({
    value: option.reasoningEffort,
    label: option.reasoningEffort,
  }));
});

const accessModeOptions = [
  { value: "current", label: "需确认" },
  { value: "read-only", label: "只读" },
  { value: "full-access", label: "自动执行" },
];

/** 模型下拉搜索：搜索框放在弹框内，避免移动端触发输入法。 */
const modelSearchQuery = ref("");
const filteredModelOptionGroups = computed(() =>
  filterModelSelectOptionGroups(modelOptionGroups.value, modelSearchQuery.value),
);
function onModelDropdownVisibleChange(open: boolean): void {
  modelSelectOpen.value = open;
  if (!open) modelSearchQuery.value = "";
}

/** 切走后的成功回包只清除仍与已发送内容一致的旧 thread 草稿。 */
function clearSubmittedDraftAfterSuccess(input: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  draftScopeEpoch: number;
  workspaceScopeToken: number;
  draftEditSeq: number;
  draft: ThreadDraftPayload;
  successLabel: string;
}): void {
  const workspaceScopeStillCurrent = props.workspaceId === input.workspaceId
    && chat.isThreadDraftWorkspaceScopeCurrent(input.workspaceScopeToken);
  const sentDraftStillCurrent = workspaceScopeStillCurrent
    && props.threadId === input.threadId
    && draftScopeEpoch === input.draftScopeEpoch
    && draftEditSeq === input.draftEditSeq;
  const returnedToSubmittedThread = workspaceScopeStillCurrent
    && props.threadId === input.threadId
    && draftScopeEpoch !== input.draftScopeEpoch
    && sameThreadDraftPayloadContent(snapshotDraft(), input.draft);
  if (!sentDraftStillCurrent && !returnedToSubmittedThread) {
    const threadKey = String(input.threadId);
    const pendingDraft = chat.pendingLocalThreadDraftByThreadId[threadKey];
    const cachedDraft = chat.threadDraftByThreadId[threadKey] ?? null;
    const retainedDraft = pendingDraft ?? cachedDraft;
    if (workspaceScopeStillCurrent && props.threadId !== input.threadId && retainedDraft
      && sameThreadDraftPayloadContent(retainedDraft, input.draft)) {
      const pendingEpoch = pendingDraft ? chat.pendingLocalThreadDraftEpochByThreadId[threadKey] : undefined;
      chat.clearPendingLocalThreadDraft(input.threadId, pendingEpoch, {
        workspaceScopeToken: input.workspaceScopeToken,
      });
      chat.setThreadDraft(input.threadId, null);
      void clearRemoteDraftAfterSubmit(ctx.value, input);
      return;
    }
    message.warning(`${input.successLabel}；执行期间会话已切换，原会话草稿已保留，请返回后确认。`);
    return;
  }

  cancelDraftSave();
  chat.clearPendingLocalThreadDraft(input.threadId, undefined, {
    workspaceScopeToken: input.workspaceScopeToken,
  });
  // 立即清本地远端草稿缓存，避免云端清理未完成时重挂载回填发送前内容。
  chat.setThreadDraft(input.threadId, null);
  skipNextDraftWatch = true;
  draftDirty = false;
  draftEditSeq = 0;
  currentDraftVersion.value = null;
  preserveInputContractTextMutation = true;
  text.value = "";
  inputKind.value = undefined;
  skillMentions.value = [];
  preserveInputContractTextMutation = false;
  pathReferences.value = [];
  closeInputActionPicker();
  closeImagePreview();
  closeTextFilePreview();
  clearAttachments();
  void clearRemoteDraftAfterSubmit(ctx.value, input);
  settingsOpen.value = false;
}

/** 发送成功后清理远端草稿；瞬时失败重试一次，仍失败只告警，不误报发送失败。 */
async function clearRemoteDraftAfterSubmit(
  apiContext: ApiRequestContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId; workspaceScopeToken: number; successLabel: string },
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await chat.clearThreadDraft(apiContext, input.workspaceId, input.threadId, {
        workspaceScopeToken: input.workspaceScopeToken,
      });
      return;
    } catch (error) {
      if (isCancelledRequestError(error)) {
        // 发送后切换会话/工作区会取消旧作用域的草稿清理；本地草稿已清，不能误报为清理失败。
        console.warn("[composer.draft.clear.cancelled]", {
          code: "THREAD_DRAFT_CLEAR_AFTER_SUBMIT_CANCELLED",
          requestId: null,
          workspaceId: String(input.workspaceId),
          threadId: String(input.threadId),
          cancelKind: error.kind,
        });
        return;
      }
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      const rootCause = error instanceof Error ? error.message : String(error);
      console.error("[composer.draft.clear.failed]", {
        code: "THREAD_DRAFT_CLEAR_AFTER_SUBMIT_FAILED",
        requestId: null,
        workspaceId: String(input.workspaceId),
        threadId: String(input.threadId),
        rootCause,
      });
      message.warning(`${input.successLabel}；草稿已在本机清除，云端草稿同步失败：${rootCause}`);
    }
  }
}

/** 调用现有 Codex compact API，不创建普通用户消息。 */
async function executeCodexCompact(): Promise<void> {
  await chat.compactThread(ctx.value, {
    workspaceId: props.workspaceId,
    threadId: props.threadId,
    accessMode: accessMode.value,
    contextWindow: resolveContextWindowForSend(),
    autoCompactPct: resolveAutoCompactPctForSend(),
    serviceTier: resolveCodexServiceTierForSend(),
  });
}

type CodexHostActionResult = {
  /** 成功后清空当前命令草稿；交互型命令可保留草稿。 */
  clearDraft?: boolean;
  successMessage?: string;
  noticeType?: "success" | "info";
  /** 清空命令草稿后再打开选择器或切换会话。 */
  postClear?: () => Promise<void> | void;
};

/** Codex CLI `/init` 的最小等价提示；通过现有 turn/start 发送而不伪造本地文件写入。 */
const CODEX_INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.

Keep it concise (about 200-400 words) and use Markdown headings. Describe the project structure, build/test commands, coding conventions, testing guidance, and commit or pull-request expectations. Add repository-specific examples where useful. Do not overwrite an existing AGENTS.md; if one already exists, explain that it was left unchanged.`;

/** 发送由 Web 映射的 Codex 本地命令提示，保持普通消息合同和当前会话设置。 */
async function sendCodexHostPrompt(prompt: string): Promise<void> {
  const clientItemId = ensureClientItemId();
  await chat.sendMessage(ctx.value, {
    workspaceId: props.workspaceId,
    threadId: props.threadId,
    text: prompt,
    inputKind: "message",
    workMode: workMode.value,
    roleId: null,
    planMode: planMode.value,
    accessMode: accessMode.value,
    model: model.value || null,
    effort: effort.value || null,
    images: [],
    files: [],
    pathReferences: [],
    contextWindow: resolveContextWindowForSend(),
    autoCompactPct: resolveAutoCompactPctForSend(),
    serviceTier: resolveCodexServiceTierForSend(),
    clientItemId,
  });
}

/** 受控打开现有选择器，复用 Composer 的模型/权限/Agent 配置入口。 */
function focusHostActionSelect(
  selectRef: { value?: { focus?: () => void } | null },
  openState: { value: boolean },
  label: string,
): CodexHostActionResult {
  if (!selectRef.value) throw new Error(`${label}选择器当前不可用`);
  return {
    successMessage: `已打开${label}选择器`,
    postClear: async () => {
      openState.value = true;
      await nextTick();
      const instance = selectRef.value;
      if (!instance) {
        openState.value = false;
        throw new Error(`${label}选择器当前不可用`);
      }
      instance.focus?.();
    },
  };
}

/** 对会话归档/删除等不可逆动作先取得用户确认，取消时保留原始草稿。 */
function confirmCodexHostAction(input: {
  title: string;
  content: string;
  okText: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: input.title,
      content: input.content,
      okText: input.okText,
      okType: input.danger ? "danger" : "primary",
      cancelText: "取消",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

/** 刷新 Codex 会话列表并为裸 `/resume` 选择器设置首个候选。 */
async function refreshResumePicker(): Promise<boolean> {
  resumePickerLoading.value = true;
  resumePickerError.value = "";
  try {
    await chat.refreshThreads(ctx.value, props.workspaceId);
    const first = resumePickerThreads.value[0] ?? null;
    resumePickerSelectedId.value = first?.id ?? null;
    if (!first) resumePickerError.value = "当前工作区没有可恢复的 Codex 会话";
    return true;
  } catch (error) {
    resumePickerError.value = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    resumePickerLoading.value = false;
  }
}

/** 打开裸 `/resume` 的会话选择器；读取失败时保留可重试错误态。 */
async function openResumePicker(): Promise<void> {
  resumePickerQuery.value = "";
  resumePickerSelectedId.value = null;
  resumePickerError.value = "";
  resumePickerOpen.value = true;
  const loaded = await refreshResumePicker();
  if (!loaded) throw new Error(resumePickerError.value || "恢复会话目录读取失败");
}

/** 重试恢复会话目录读取，不把失败伪装成空列表。 */
function retryResumePicker(): void {
  void refreshResumePicker();
}

/** 在恢复列表中提供与 CLI 相同的方向键和 Enter 快捷操作。 */
function onResumePickerKeydown(event: KeyboardEvent): void {
  if (resumePickerLoading.value || !resumePickerThreads.value.length) return;
  const currentIndex = Math.max(0, resumePickerThreads.value.findIndex((item) => (
    String(item.id) === String(resumePickerSelectedId.value)
  )));
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (currentIndex + delta + resumePickerThreads.value.length) % resumePickerThreads.value.length;
    resumePickerSelectedId.value = resumePickerThreads.value[nextIndex]!.id;
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    confirmResumePicker();
  }
}

/** 确认恢复候选并沿用普通 thread 选择与 URL 同步入口。 */
function confirmResumePicker(): void {
  const selectedId = resumePickerSelectedId.value;
  const target = selectedId == null
    ? null
    : findCodexResumeTarget(chat.threads, selectedId, props.threadId);
  if (!target) {
    resumePickerError.value = "所选会话已不可用，请刷新后重试";
    return;
  }
  closeResumePicker();
  chat.selectPrimaryThread(target, { route: "replace" });
  message.success(`已恢复会话「${target.title}」`);
}

/** 清空本地命令后插入 `@` 或 `$`，让既有 picker 接管后续输入。 */
async function openHostActionToken(token: "@" | "$"): Promise<void> {
  if (composerWriteBlocked.value) return;
  preserveInputContractTextMutation = true;
  text.value = token;
  inputKind.value = undefined;
  skillMentions.value = [];
  pathReferences.value = [];
  preserveInputContractTextMutation = false;
  await nextTick();
  const target = resolveTextareaElement();
  target?.focus();
  target?.setSelectionRange(token.length, token.length);
  onComposerInput();
}

/** 打开命令对应的说明弹窗；内容只描述已确认的 Web 行为。 */
function showCodexHostInfo(title: string, content: string): CodexHostActionResult {
  Modal.info({
    title,
    content,
    okText: "关闭",
  });
  return {
    successMessage: `${title}已打开`,
    noticeType: "info",
  };
}

/** 打开 Shell 提供的设置入口；基础配置已并入系统设置，不再保留在弹框页签。 */
function openCodexSettings(tab: string, label: string): CodexHostActionResult {
  if (tab === "codeflowai-config") {
    return {
      successMessage: `已打开${label}`,
      postClear: () => { void router.push({ path: "/admin", query: { panel: "settings" } }); },
    };
  }
  if (appModals) {
    return {
      successMessage: `已打开${label}`,
      postClear: () => appModals.openSettings(tab),
    };
  }
  return showCodexHostInfo(label, "当前页面未连接应用 Shell，请从顶部设置入口继续操作。");
}

/** 创建一个 Codex 旁支会话，并沿用现有会话创建与路由同步能力。 */
async function createCodexSiblingThread(kind: "fork" | "side" | "btw", args: string): Promise<CodexHostActionResult> {
  const sourceTitle = String(thread.value?.title ?? "当前会话").trim() || "当前会话";
  const prefix = kind === "fork" ? "分支" : "旁支";
  const title = `${prefix}：${sourceTitle}`;
  const newThreadId = await chat.createThread(ctx.value, {
    workspaceId: props.workspaceId,
    engine: "codex",
    title,
  });
  const suffix = args ? `；附加上下文：${args}` : "";
  return {
    successMessage: `已创建${prefix}会话「${title}」${suffix}`,
    postClear: () => chat.selectPrimaryThread(newThreadId, { route: "replace" }),
  };
}

/** 以当前会话为键保存 Web 侧长期目标，避免跨会话串值。 */
function setCodexGoal(value: string): void {
  const key = String(props.threadId);
  if (value) codexGoalByThreadId.set(key, value);
  else codexGoalByThreadId.delete(key);
}

/** 读取当前会话的 Web 侧目标；未设置时返回空值。 */
function getCodexGoal(): string {
  return codexGoalByThreadId.get(String(props.threadId)) ?? "";
}

/** 将用户输入的只读目录按会话去重保存，并返回当前集合。 */
function addCodexSandboxReadDir(value: string): string[] {
  const key = String(props.threadId);
  const current = codexSandboxReadDirsByThreadId.get(key) ?? [];
  const normalized = value.trim();
  if (normalized && !current.includes(normalized)) current.push(normalized);
  codexSandboxReadDirsByThreadId.set(key, current);
  return current;
}

/** 以统一的 Web 宿主语义承接 Codex CLI 命令，保留每个动作的真实边界。 */
async function executeCodexHostAction(
  submission: Extract<ComposerInputSubmission, { mode: "host-action" }>,
): Promise<CodexHostActionResult> {
  const args = submission.trimmedArgs ?? "";
  switch (submission.action) {
    case "compact":
      await executeCodexCompact();
      return { successMessage: "已触发 Codex 会话压缩，请等待完成" };
    case "model":
      return focusHostActionSelect(modelSelectRef, modelSelectOpen, "模型");
    case "ide": {
      if (typeof window !== "undefined" && window.innerWidth <= 767 && appModals) {
        return {
          successMessage: "已打开终端入口",
          postClear: () => appModals.openTerminal(),
        };
      }
      ui.openRightPanel("explorer");
      return {
        successMessage: args ? `已打开 Explorer（上下文：${args}）` : "已打开 Explorer 面板",
        noticeType: "info",
      };
    }
    case "permissions": {
      // 执行模式已从工具栏移入会话设置，命令改为打开设置面板。
      if (accessModeLocked.value) throw new Error("当前会话权限模式已锁定，不能设置");
      return {
        successMessage: "已打开会话设置中的执行模式",
        postClear: () => { settingsOpen.value = true; },
      };
    }
    case "agent":
    case "subagents":
      return focusHostActionSelect(roleSelectRef, roleSelectOpen, "Agent");
    case "keymap":
      return showCodexHostInfo(
        "Web 快捷键",
        "Enter：发送\nShift/Ctrl/Alt/Cmd + Enter：换行\n↑/↓：选择 Slash 或 Skill 候选\nTab：确认候选\nEsc：关闭候选",
      );
    case "vim":
      vimModeEnabled.value = !vimModeEnabled.value;
      return {
        successMessage: `Vim 模式已${vimModeEnabled.value ? "开启" : "关闭"}`,
        noticeType: "info",
      };
    case "setup-default-sandbox": {
      if (accessModeLocked.value) throw new Error("当前会话权限模式已锁定，不能设置默认沙箱");
      patchThreadPrefs({ accessMode: "full-access" });
      const saveTask = flushPrefsSave(captureThreadPrefsSaveScope(), { propagateError: true });
      if (saveTask) await saveTask;
      return { successMessage: "已将默认沙箱设置为自动执行（完整访问）" };
    }
    case "sandbox-add-read-dir": {
      const requested = args || (typeof window !== "undefined"
        ? String(window.prompt("加入沙箱只读目录", "") ?? "").trim()
        : "");
      if (!requested) return { clearDraft: false, successMessage: "已取消目录设置", noticeType: "info" };
      const dirs = addCodexSandboxReadDir(requested);
      return showCodexHostInfo(
        "只读目录已记录",
        `当前会话目录：${dirs.join("、")}\nWeb 会话已保存目录意图；实际执行权限仍由当前 Host 沙箱策略裁决。`,
      );
    }
    case "experimental":
      return openCodexSettings("codeflowai-config", "实验性功能设置");
    case "approve": {
      const pending = (conversationState.value?.items ?? []).filter((item) => (
        item.kind === "approvalRequest" && item.state === "pending"
      ));
      ui.openRightPanel("inspector");
      return showCodexHostInfo(
        "审批请求",
        pending.length ? `当前有 ${pending.length} 个待处理审批，请在消息卡片中确认。` : "当前没有待处理审批请求。",
      );
    }
    case "memories":
      return openCodexSettings("codeflowai-config", "记忆设置");
    case "import":
      return openCodexSettings("workspaces", "导入设置");
    case "skills":
      return {
        successMessage: "已打开 Skill 选择",
        postClear: () => openHostActionToken("$"),
      };
    case "mention":
      return {
        successMessage: "已打开文件引用输入",
        postClear: () => openHostActionToken("@"),
      };
    case "hooks":
      return openCodexSettings("codeflowai-config", "Hooks 设置");
    case "rename": {
      const requested = args || (typeof window !== "undefined"
        ? String(window.prompt("重命名当前会话", thread.value?.title ?? "") ?? "").trim()
        : "");
      if (!requested) {
        return { clearDraft: false, successMessage: "已取消重命名", noticeType: "info" };
      }
      await chat.renameThread(ctx.value, {
        workspaceId: props.workspaceId,
        threadId: props.threadId,
        title: requested,
      });
      return { successMessage: `会话已重命名为「${requested}」` };
    }
    case "new": {
      const newThreadId = await chat.createThread(ctx.value, {
        workspaceId: props.workspaceId,
        engine: "codex",
        title: args || "新会话",
      });
      return {
        successMessage: args ? `已创建新 Codex 会话「${args}」` : "已创建新 Codex 会话",
        postClear: () => chat.selectPrimaryThread(newThreadId, { route: "replace" }),
      };
    }
    case "archive": {
      const confirmed = await confirmCodexHostAction({
        title: "归档当前会话？",
        content: "归档后将退出当前会话，可从已归档列表恢复。",
        okText: "归档并退出",
        danger: false,
      });
      if (!confirmed) return { clearDraft: false, successMessage: "已取消归档", noticeType: "info" };
      await chat.setThreadArchived(ctx.value, {
        workspaceId: props.workspaceId,
        threadId: props.threadId,
        archived: true,
      });
      return {
        successMessage: "会话已归档",
        postClear: () => chat.selectPrimaryThread(null, { route: "replace" }),
      };
    }
    case "delete": {
      const confirmed = await confirmCodexHostAction({
        title: "永久删除当前会话？",
        content: "此操作不可撤销，当前会话及其历史事件将被删除。",
        okText: "删除并退出",
        danger: true,
      });
      if (!confirmed) return { clearDraft: false, successMessage: "已取消删除", noticeType: "info" };
      await chat.deleteThread(ctx.value, {
        workspaceId: props.workspaceId,
        threadId: props.threadId,
      });
      // deleteThread 已清理本地/远端草稿，不能再对已删除 ID 发 clear-draft 请求。
      return { clearDraft: false, successMessage: "会话已删除" };
    }
    case "resume": {
      const targetText = args.trim();
      if (!targetText) {
        await openResumePicker();
        return { successMessage: "已打开恢复会话选择器", noticeType: "info" };
      }
      await chat.refreshThreads(ctx.value, props.workspaceId);
      const target = findCodexResumeTarget(chat.threads, targetText, props.threadId);
      if (!target) throw new Error(`未找到会话：${targetText}`);
      return {
        successMessage: `已恢复会话「${target.title}」`,
        postClear: () => chat.selectPrimaryThread(target, { route: "replace" }),
      };
    }
    case "fork":
      return createCodexSiblingThread("fork", args);
    case "app":
      if (appModals) {
        return {
          successMessage: "已打开桌面 Client 管理入口",
          postClear: () => appModals.openClientManagement(),
        };
      }
      return showCodexHostInfo("桌面 Client", "当前环境没有连接桌面 Client；可以继续使用 Web 会话。 ");
    case "goal": {
      const normalized = args.trim();
      if (!normalized) {
        return showCodexHostInfo("当前目标", getCodexGoal() || "当前会话尚未设置长期目标。 ");
      }
      if (normalized === "clear" || normalized === "reset") {
        setCodexGoal("");
        return { successMessage: "已清除当前会话目标", noticeType: "info" };
      }
      setCodexGoal(normalized);
      return { successMessage: `已设置当前会话目标：${normalized}` };
    }
    case "side":
    case "btw":
      return createCodexSiblingThread(submission.action, args);
    case "clear":
      await chat.clearThread(ctx.value, { workspaceId: props.workspaceId, threadId: props.threadId, resetSession: true });
      if (args) {
        await chat.renameThread(ctx.value, {
          workspaceId: props.workspaceId,
          threadId: props.threadId,
          title: args,
        });
      }
      return { successMessage: args ? `已清空当前会话并以「${args}」开始新对话` : "已清空当前会话并重置上下文" };
    case "init":
      await sendCodexHostPrompt(CODEX_INIT_PROMPT);
      return { successMessage: "已发送 /init 初始化提示" };
    case "review": {
      const prompt = args
        ? `请检查当前工作区的代码变更并查找问题。\n附加审查要求：${args}`
        : "请检查当前工作区的代码变更并查找问题，按严重程度说明发现的问题和建议。";
      await sendCodexHostPrompt(prompt);
      return { successMessage: "已启动 Codex 变更审查" };
    }
    case "copy": {
      const latest = [...(conversationState.value?.items ?? [])]
        .reverse()
        .find((item) => item.kind === "message" && item.role === "assistant" && item.text.trim());
      if (!latest || latest.kind !== "message") throw new Error("当前会话没有可复制的回答");
      await copyToClipboard(latest.text);
      return { successMessage: "已复制上一条回答" };
    }
    case "raw": {
      const normalized = args.toLocaleLowerCase();
      if (normalized && normalized !== "on" && normalized !== "off" && normalized !== "status") {
        throw new Error("用法：/raw [on|off|status]");
      }
      if (normalized === "status") {
        return { successMessage: `原始输出模式当前为${rawOutputMode.value ? "开启" : "关闭"}`, noticeType: "info" };
      }
      rawOutputMode.value = normalized === "on" ? true : normalized === "off" ? false : !rawOutputMode.value;
      return { successMessage: `原始输出模式已${rawOutputMode.value ? "开启" : "关闭"}`, noticeType: "info" };
    }
    case "diff":
      await chat.refreshThreadFileChanges(ctx.value, { workspaceId: props.workspaceId, threadId: props.threadId, force: true });
      return { successMessage: "已刷新工作区差异" };
    case "status": {
      const usage = stableTokenUsage.value?.current;
      const usageText = usage?.totalTokens != null ? formatTokens(usage.totalTokens) : "暂无";
      const accessLabel = accessMode.value === "full-access" ? "自动执行" : accessMode.value === "read-only" ? "只读" : "需确认";
      return {
        successMessage: `模型：${resolvedModelId.value || "默认"}；Effort：${effort.value || "默认"}；权限：${accessLabel}；Fast：${fastMode.value ? "on" : "off"}；Vim：${vimModeEnabled.value ? "on" : "off"}；当前 Token：${usageText}`,
        noticeType: "info",
      };
    }
    case "debug-config": {
      const configText = [
        `引擎：${engine.value}`,
        `模型：${resolvedModelId.value || "默认"}`,
        `Effort：${effort.value || "默认"}`,
        `权限：${accessMode.value}`,
        `Fast：${fastMode.value ? "on" : "off"}`,
        `Vim：${vimModeEnabled.value ? "on" : "off"}`,
        `Raw：${rawOutputMode.value ? "on" : "off"}`,
        `目标：${getCodexGoal() || "未设置"}`,
        `会话：${String(props.threadId)}`,
      ].join("；");
      return { successMessage: configText, noticeType: "info" };
    }
    case "title": {
      if (typeof document === "undefined") throw new Error("当前环境不支持浏览器标题");
      const requested = typeof window !== "undefined"
        ? String(window.prompt("设置浏览器标题（留空恢复会话标题）", document.title) ?? "")
        : "";
      const nextTitle = requested.trim() || thread.value?.title?.trim() || "CodeFlow";
      document.title = nextTitle;
      return { successMessage: `浏览器标题已设置为「${nextTitle}」` };
    }
    case "theme": {
      const requested = typeof window !== "undefined"
        ? String(window.prompt("选择主题：light / dark / auto", ui.themeMode) ?? "").trim().toLocaleLowerCase()
        : "";
      if (!requested) return { clearDraft: false, successMessage: "已取消主题设置", noticeType: "info" };
      if (requested !== "light" && requested !== "dark" && requested !== "auto") {
        throw new Error("主题只允许 light、dark 或 auto");
      }
      ui.setThemeMode(requested as ThemeMode);
      return { successMessage: `主题已切换为${requested === "light" ? "亮色" : requested === "dark" ? "暗色" : "自动"}` };
    }
    case "usage": {
      const panel = args.trim() || "relay-self-usage";
      await router.push({ path: "/admin", query: { panel } });
      return { successMessage: `已打开用量页面（${panel}）`, noticeType: "info" };
    }
    case "statusline":
      return openCodexSettings("codeflowai-config", "状态栏设置");
    case "pets": {
      const normalized = args.toLocaleLowerCase();
      if (normalized && normalized !== "show" && normalized !== "hide" && normalized !== "status") {
        throw new Error("用法：/pets [show|hide|status]");
      }
      if (normalized === "status") {
        return { successMessage: `终端宠物当前为${petsVisible.value ? "显示" : "隐藏"}`, noticeType: "info" };
      }
      petsVisible.value = normalized === "show" ? true : normalized === "hide" ? false : !petsVisible.value;
      return { successMessage: `终端宠物已${petsVisible.value ? "显示" : "隐藏"}`, noticeType: "info" };
    }
    case "mcp": {
      const query = String(args ?? "").trim();
      setPendingMcpSearchQuery(query);
      orch.setActiveTab("mcp");
      return {
        successMessage: query ? `已打开 MCP 管理（筛选：${query}）` : "已打开 MCP 管理",
        postClear: () => { void router.push({ path: "/orchestration/assets" }); },
      };
    }
    case "feedback":
      if (appModals) {
        appModals.openFeedback("slash_command");
        return { successMessage: "已打开意见反馈", noticeType: "info" };
      }
      await router.push("/contact");
      return { successMessage: "已打开反馈页面", noticeType: "info" };
    case "personality": {
      const requested = typeof window !== "undefined"
        ? String(window.prompt("沟通风格：default / concise / friendly", personalityMode.value) ?? "").trim().toLocaleLowerCase()
        : "";
      if (!requested) return { clearDraft: false, successMessage: "已取消沟通风格设置", noticeType: "info" };
      if (requested !== "default" && requested !== "concise" && requested !== "friendly") {
        throw new Error("沟通风格只允许 default、concise 或 friendly");
      }
      personalityMode.value = requested;
      return { successMessage: `沟通风格已切换为 ${requested}`, noticeType: "info" };
    }
    case "logout":
      if (!appModals?.logout) throw new Error("应用 Shell 未提供登出入口");
      await appModals.logout();
      // 登出会立即撤销当前会话；不要在随后再次调用受保护的远端草稿清理接口。
      return { clearDraft: false, successMessage: "已退出 Codex 登录", noticeType: "info" };
    case "quit":
    case "exit":
      chat.clearPrimaryThreadSelection({ clearUrl: true });
      await router.push("/chat");
      return { successMessage: "已退出当前 Codex 会话", noticeType: "info" };
    case "ps": {
      await chat.refreshThreadManagedServices(ctx.value, { workspaceId: props.workspaceId, threadId: props.threadId, force: true });
      const items = chat.managedServicesStateForThread(props.threadId).items;
      const summary = items.length
        ? items.map((item) => `${item.displayName || item.serviceId}（${item.status}）`).join("、")
        : "当前没有后台进程";
      return { successMessage: summary, noticeType: "info" };
    }
    case "stop": {
      await chat.refreshThreadManagedServices(ctx.value, { workspaceId: props.workspaceId, threadId: props.threadId, force: true });
      const items = chat.managedServicesStateForThread(props.threadId).items
        .filter((item) => (item.status === "starting" || item.status === "ready") && item.stopSupported !== false);
      for (const item of items) {
        await chat.stopThreadManagedService(ctx.value, {
          workspaceId: props.workspaceId,
          threadId: props.threadId,
          serviceId: item.serviceId,
        });
      }
      return {
        successMessage: items.length ? `已停止 ${items.length} 个后台进程` : "当前没有可停止的后台进程",
        noticeType: "info",
      };
    }
    default:
      throw new Error(`未知 Codex host action：${submission.action}`);
  }
}

/** 附件读取结束后冻结输入，再分流本机或已认证远程动作、普通发送及队列。 */
const send = async () => {
  if (!props.allowQueue && props.runningTurnId) return;
  // 等待同一输入事件的 watcher 收敛，避免 Slash 选中后立即执行时误判草稿代际已切换。
  await nextTick();
  if (pendingReads.value) {
    message.warning("正在读取附件，请稍候");
    return;
  }
  const sendWorkspaceId = props.workspaceId;
  const sendThreadId = props.threadId;
  const sendDraftScopeEpoch = draftScopeEpoch;
  const sendDraftWorkspaceScopeToken = draftWorkspaceScopeToken;
  const sendDraftEditSeq = draftEditSeq;
  const sendDraftSnapshot = snapshotDraft();
  const submission = currentComposerInputSubmission.value;
  const sendImageAttachments = imageAttachments.value.map((item) => ({ ...item }));
  const images = sendImageAttachments.map((item) => item.dataUrl);
  const files = textFileAttachments.value.map((item) => ({ ...item }));
  const existingPathReferences = pathReferences.value.map((item) => ({ ...item }));
  const queueLength = threadQueueStore.itemCountFor(sendThreadId);
  const sendRoleId = resolveRoleIdForSend();
  const actionConflict = validateComposerActionSubmission({
    submission,
    hasRole: Boolean(sendRoleId),
    imageCount: images.length,
    fileCount: files.length,
    pathReferenceCount: existingPathReferences.length,
    skillMentionCount: skillMentions.value.length,
    runningTurnId: props.runningTurnId,
    queueLength,
  });
  if (actionConflict) {
    message.error(actionConflict);
    return;
  }

  if (submission.mode === "host-action") {
    if (composerWriteBlocked.value) {
      message.warning(composerWriteBlockedReason.value);
      return;
    }
    if (!localChatReady.value && !config.webSessionId) {
      message.warning("连接成功后才能执行本地命令");
      return;
    }
    sendingViaQueue.value = false;
    sending.value = true;
    let postClear: (() => Promise<void> | void) | null = null;
    let clearDraft = true;
    let successMessage = "";
    let noticeType: "success" | "info" = "success";
    try {
      const result = await executeCodexHostAction(submission);
      clearDraft = result.clearDraft !== false;
      successMessage = result.successMessage ?? "命令已执行";
      noticeType = result.noticeType ?? "success";
      postClear = result.postClear ?? null;
      if (clearDraft) {
        currentClientItemId.value = null;
        clearSubmittedDraftAfterSuccess({
          workspaceId: sendWorkspaceId,
          threadId: sendThreadId,
          draftScopeEpoch: sendDraftScopeEpoch,
          workspaceScopeToken: sendDraftWorkspaceScopeToken,
          draftEditSeq: sendDraftEditSeq,
          draft: sendDraftSnapshot,
          successLabel: successMessage,
        });
      }
    } catch (error) {
      // Host action 执行失败时不追加成功提示。
      successMessage = "";
      postClear = null;
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      sending.value = false;
    }
    if (postClear && clearDraft) {
      try {
        await postClear();
      } catch (error) {
        const rootCause = error instanceof Error ? error.message : String(error);
        console.error("[composer.host_action.post_clear.failed]", {
          code: "CODEX_HOST_ACTION_POST_CLEAR_FAILED",
          requestId: null,
          workspaceId: String(sendWorkspaceId),
          threadId: String(sendThreadId),
          action: submission.action,
          rootCause,
        });
        successMessage = "";
        message.error(rootCause);
      }
    }
    if (successMessage) {
      if (noticeType === "info") message.info(successMessage);
      else message.success(successMessage);
    }
    return;
  }

  // 普通消息与 Provider Slash 仍要求当前线程已有可用模型。
  if (flatModelOptions.value.length && !model.value) {
    modelSelectRef.value?.focus();
    message.warning("请先选择模型");
    return;
  }
  if (currentModelProviderIssue.value) {
    message.warning(currentModelProviderIssue.value);
    return;
  }
  if (!canSend.value) return;

  const sendText = submission.text;
  const sendInputKind = submission.inputKind;
  const sendSkillMentions = submission.mode === "message" ? submission.skillMentions : undefined;
  const sendShouldEnqueue = enqueueMode.value;
  const sendWorkMode = workMode.value;
  const sendPlanMode = planMode.value;
  const sendAccessMode = accessMode.value;
  const sendEffort = effort.value || null;
  const sendContextWindow = resolveContextWindowForSend();
  const sendAutoCompactPct = resolveAutoCompactPctForSend();
  const sendServiceTier = resolveCodexServiceTierForSend();
  const resolvedModel = model.value || null;

  sendingViaQueue.value = sendShouldEnqueue;
  sending.value = true;
  try {
    if (await relayBalanceReminderRef.value?.ensureCanStartTurn() === false) return;
    const submitPathReferences = submission.mode === "provider-slash"
      ? []
      : await resolvePathReferencesForSubmit({
        text: sendText,
        workspaceId: sendWorkspaceId,
        existingReferences: existingPathReferences,
      });
    const payloadBudget = validateInlineThreadPayload(
      { text: sendText, images, files, pathReferences: submitPathReferences },
      { contextLabel: "当前消息" },
    );
    if (!payloadBudget.ok) {
      message.error(payloadBudget.message);
      return;
    }

    const clientItemId = ensureClientItemId();
    if (sendShouldEnqueue) {
      // 节点线程始终经编排队列持久化；dispatcher 会在 idle 时开新 turn、active 时走追加投递。
      await threadQueueStore.append(ctx.value, sendWorkspaceId as any, sendThreadId as any, {
        text: sendText,
        ...(sendInputKind ? { inputKind: sendInputKind } : {}),
        ...(sendSkillMentions?.length ? { skillMentions: sendSkillMentions } : {}),
        images: sendImageAttachments,
        files,
        pathReferences: submitPathReferences,
        sendOptions: {
          workMode: sendWorkMode,
          roleId: sendRoleId,
          planMode: sendPlanMode,
          accessMode: sendAccessMode,
          model: resolvedModel,
          effort: sendEffort,
          // 队列以 null 表示缺省，实际窗口由 Client 按当前模型目录限制。
          contextWindow: sendContextWindow ?? null,
          autoCompactPct: sendAutoCompactPct,
          serviceTier: sendServiceTier,
        },
        clientItemId,
      });
      notifyThreadQueueAppended(sendThreadId);
    } else {
      await chat.sendMessage(ctx.value, {
        workspaceId: sendWorkspaceId,
        threadId: sendThreadId,
        text: sendText,
        ...(sendInputKind ? { inputKind: sendInputKind } : {}),
        ...(sendSkillMentions?.length ? { skillMentions: sendSkillMentions } : {}),
        workMode: sendWorkMode,
        roleId: sendRoleId,
        planMode: sendPlanMode,
        accessMode: sendAccessMode,
        model: resolvedModel,
        effort: sendEffort,
        images,
        files,
        pathReferences: submitPathReferences,
        contextWindow: sendContextWindow,
        autoCompactPct: sendAutoCompactPct,
        serviceTier: sendServiceTier,
        clientItemId,
      });
    }
    // 提交成功后清空幂等键：下次输入会重新 generate（不同草稿生命周期不应共享）
    if (currentClientItemId.value === clientItemId) currentClientItemId.value = null;
    clearSubmittedDraftAfterSuccess({
      workspaceId: sendWorkspaceId,
      threadId: sendThreadId,
      draftScopeEpoch: sendDraftScopeEpoch,
      workspaceScopeToken: sendDraftWorkspaceScopeToken,
      draftEditSeq: sendDraftEditSeq,
      draft: sendDraftSnapshot,
      successLabel: "消息已发送",
    });
  } catch (e) {
    console.error("[composer.send.failed]", { ...describeWorkflowFailure(e), workspaceId: sendWorkspaceId,
      threadId: sendThreadId, rootCause: e instanceof Error ? e.message : String(e) });
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    sending.value = false;
  }
};

const currentTokenUsage = computed(() => {
  const conv = chat.conversations[String(props.threadId)];
  return conv?.tokenUsage ?? null;
});

const currentTokenUsageVersion = computed(() => {
  const usage = currentTokenUsage.value;
  if (!usage) return "null";
  const cur = usage.current;
  const cum = usage.cumulative;
  const peak = usage.turnPeak;
  return [
    cur.inputTokens ?? "n",
    cur.outputTokens ?? "n",
    cur.cachedInputTokens ?? "n",
    cur.cacheCreationInputTokens ?? "n",
    cur.totalTokens ?? "n",
    cur.reasoningOutputTokens ?? "n",
    cur.modelContextWindow ?? "n",
    cum.inputTokens,
    cum.outputTokens,
    cum.cachedInputTokens,
    cum.cacheCreationInputTokens,
    cum.totalTokens ?? "n",
    cum.reasoningOutputTokens ?? "n",
    peak.inputTokens,
    peak.outputTokens,
    peak.cachedInputTokens,
    peak.cacheCreationInputTokens,
  ].join("|");
});

const currentThreadContentEpoch = computed(() => chat.threadContentEpochByThreadId[String(props.threadId)] ?? 0);

/**
 * 稳定的 token 用量快照：
 * - thread reload / clear 时按当前真实内容重建；
 * - 运行中若 usage 暂时退化成 null 或仅剩 modelContextWindow，则保留上一份真实上下文快照。
 */
const stableTokenUsage = ref<import("@codeflowai/shared").TokenUsageState | null>(null);

watch(
  () => [props.threadId, currentThreadContentEpoch.value] as const,
  () => {
    stableTokenUsage.value = resolveStableTokenUsageOnContentChange(currentTokenUsage.value);
  },
  { immediate: true },
);

watch(
  currentTokenUsageVersion,
  () => {
    stableTokenUsage.value = resolveNextStableTokenUsage(stableTokenUsage.value, currentTokenUsage.value);
  },
  { immediate: true },
);

/**
 * 手动压缩上下文。
 *
 * - Claude 走 `/compact` 内建命令。
 * - Codex 走 app-server 的 `thread/compact/start`，触发真实会话压缩。
 *
 * Claude 依赖 buildClaudeStreamJsonInput 将 slash 命令的 content 编码为纯字符串格式
 * （而非数组格式），否则 CLI 解析器无法识别为内建命令。
 * 同时 claudeThreadSession 会跳过 AIDT mode 包装，防止前缀破坏 "/" 前导。
 *
 * `/compact` 后可附加 focus 指令（如 `/compact 重点保留 API 变更`），
 * 按钮触发默认不带参数；如需指定方向，可直接在输入框输入。
 */
async function handleCompactContext(): Promise<void> {
  if (composerWriteBlocked.value || props.runningTurnId) return;
  if (inputActionsEnabled.value && threadQueueStore.itemCountFor(props.threadId) > 0) {
    message.error("消息队列清空后才能压缩上下文");
    return;
  }
  if (currentModelProviderIssue.value) {
    message.warning(currentModelProviderIssue.value);
    return;
  }

  try {
    if (engine.value === "codex") {
      await executeCodexCompact();
      message.success("已触发 Codex 会话压缩，请等待完成");
      return;
    }

    const compactModel = model.value || null;

    await chat.sendMessage(ctx.value, {
      workspaceId: props.workspaceId,
      threadId: props.threadId,
      text: "/compact",
      ...(inputActionsEnabled.value ? { inputKind: "provider-slash" as const } : {}),
      workMode: workMode.value,
      planMode: planMode.value,
      accessMode: accessMode.value,
      model: compactModel,
      effort: effort.value || null,
      images: [],
      files: [],
      contextWindow: resolveContextWindowForSend(),
      autoCompactPct: resolveAutoCompactPctForSend(),
      serviceTier: resolveCodexServiceTierForSend(),
    });
    message.success("已发送 /compact，请等待 Claude 完成压缩");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

/** 仅在当前会话可写且空闲时执行上下文重置，防止确认弹窗期间失锁。 */
function handleResetContext(): void {
  if (contextActionsDisabled.value) return;
  chat.clearThread(ctx.value, { workspaceId: props.workspaceId, threadId: props.threadId, resetSession: true })
    .then(() => message.success("已重置上下文"))
    .catch((e) => message.error(e instanceof Error ? e.message : String(e)));
}

/** 保证自定义换行后的 textarea 内部滚动能覆盖到光标所在行。 */
function scrollTextareaCaretIntoView(target: HTMLTextAreaElement, cursor: number): void {
  const style = window.getComputedStyle(target);
  const fontSize = Number.parseFloat(style.fontSize);
  const parsedLineHeight = Number.parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(parsedLineHeight)
    ? parsedLineHeight
    : Number.isFinite(fontSize)
      ? fontSize * 1.4
      : 20;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const lineIndex = target.value.slice(0, cursor).split("\n").length - 1;
  const caretTop = paddingTop + lineIndex * lineHeight;
  const caretBottom = caretTop + lineHeight;
  const visibleTop = target.scrollTop + paddingTop;
  const visibleBottom = target.scrollTop + target.clientHeight - paddingBottom;

  if (caretBottom > visibleBottom) {
    target.scrollTop = Math.ceil(caretBottom - target.clientHeight + paddingBottom + 2);
  } else if (caretTop < visibleTop) {
    target.scrollTop = Math.max(0, Math.floor(caretTop - paddingTop - 2));
  }
}

/** 在当前光标位置插入换行，并保持光标停在新行后且可见。 */
function insertLineBreakAtCursor(ev: KeyboardEvent): void {
  const target = ev.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  textareaEl.value = target;
  ev.preventDefault();

  const start = target.selectionStart ?? text.value.length;
  const end = target.selectionEnd ?? start;
  text.value = `${text.value.slice(0, start)}\n${text.value.slice(end)}`;
  const nextCursor = start + 1;

  void nextTick().then(() => {
    requestAnimationFrame(() => {
      if (!target.isConnected) return;
      target.focus();
      target.setSelectionRange(nextCursor, nextCursor);
      scrollTextareaCaretIntoView(target, nextCursor);
    });
  });
}

/** 输入动作候选打开时接管方向键、Enter/Tab 和 Escape；Slash 的 Enter 立即执行。 */
function handleInputActionKeydown(ev: KeyboardEvent): boolean {
  const target = ev.target instanceof HTMLTextAreaElement ? ev.target : resolveTextareaElement();
  if (target) textareaEl.value = target;
  if (!inputActionOpen.value || Boolean((ev as any).isComposing)) return false;
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeInputActionPicker();
    return true;
  }
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const delta = ev.key === "ArrowDown" ? 1 : -1;
    inputActionSelectedIndex.value = moveThreadInputActionSelection(
      filteredInputActionActions.value,
      inputActionSelectedIndex.value,
      delta,
    );
    return true;
  }
  if (ev.key === "Tab") {
    normalizeInputActionSelection();
    const action = filteredInputActionActions.value[
      Math.max(0, Math.min(inputActionSelectedIndex.value, filteredInputActionActions.value.length - 1))
    ];
    if (!action) return false;
    ev.preventDefault();
    selectInputAction(action);
    return true;
  }
  if (ev.key === "Enter") {
    normalizeInputActionSelection();
    const action = filteredInputActionActions.value[
      Math.max(0, Math.min(inputActionSelectedIndex.value, filteredInputActionActions.value.length - 1))
    ];
    if (!action) return false;
    ev.preventDefault();
    const selected = selectInputAction(action);
    // Codex/Claude Slash 候选的 Enter 等价于 CLI 的执行动作；Skill 候选只插入文本。
    if (selected && action.kind === "slash") void send();
    return true;
  }
  return false;
}

/** @ 候选打开时接管方向键、Enter/Tab 和 Escape。 */
function handleMentionKeydown(ev: KeyboardEvent): boolean {
  const target = ev.target instanceof HTMLTextAreaElement ? ev.target : resolveTextareaElement();
  if (target) textareaEl.value = target;
  if (!mentionOpen.value) return false;
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeMentionPicker();
    return true;
  }
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const count = mentionResults.value.length;
    if (count <= 0) return true;
    const delta = ev.key === "ArrowDown" ? 1 : -1;
    mentionSelectedIndex.value = (mentionSelectedIndex.value + delta + count) % count;
    return true;
  }
  if (ev.key === "Enter" || ev.key === "Tab") {
    if (!mentionResults.value.length) return false;
    ev.preventDefault();
    selectMentionResult(mentionResults.value[Math.max(0, Math.min(mentionSelectedIndex.value, mentionResults.value.length - 1))]!);
    return true;
  }
  return false;
}

/** 手机回车直接发送；带辅助键仍显式换行，桌面行为保持不变。 */
function onInputKeydown(ev: KeyboardEvent): void {
  if (handleInputActionKeydown(ev)) return;
  if (Boolean((ev as any).isComposing)) return;
  if (handleMentionKeydown(ev)) return;
  if (ev.key === "Enter" && !Boolean((ev as any).isComposing) && (ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey)) {
    insertLineBreakAtCursor(ev);
    return;
  }

  if (!shouldSubmitOnEnter({
    key: ev.key,
    isComposing: Boolean((ev as any).isComposing),
    shiftKey: ev.shiftKey,
    ctrlKey: ev.ctrlKey,
    metaKey: ev.metaKey,
    altKey: ev.altKey,
    runningTurnId: props.runningTurnId,
    allowDuringRunning: props.allowQueue,
  })) {
    return;
  }
  ev.preventDefault();
  void send();
}

function isMobileToolbarDragEnabled(): boolean {
  return typeof window !== "undefined" && window.innerWidth <= 767;
}

function onToolbarWheel(event: WheelEvent): void {
  const el = toolbarScrollEl.value;
  if (!el) return;
  if (el.scrollWidth <= el.clientWidth + 4) return;
  const primaryDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (Math.abs(primaryDelta) < 0.5) return;
  const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
  const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, el.scrollLeft + primaryDelta));
  if (Math.abs(nextScrollLeft - el.scrollLeft) < 0.5) return;
  el.scrollLeft = nextScrollLeft;
  event.preventDefault();
}

function onToolbarPointerDown(event: PointerEvent): void {
  if (!isMobileToolbarDragEnabled()) return;
  const el = toolbarScrollEl.value;
  if (!el) return;
  if (el.scrollWidth <= el.clientWidth + 4) return;
  toolbarDragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startScrollLeft: el.scrollLeft,
    dragged: false,
  };
  toolbarDragging.value = false;
  el.setPointerCapture?.(event.pointerId);
}

function onToolbarPointerMove(event: PointerEvent): void {
  if (!toolbarDragState || event.pointerId !== toolbarDragState.pointerId) return;
  const el = toolbarScrollEl.value;
  if (!el) return;
  const dx = event.clientX - toolbarDragState.startX;
  const dy = event.clientY - toolbarDragState.startY;

  if (!toolbarDragState.dragged) {
    if (Math.abs(dx) < 6) return;
    if (Math.abs(dy) > Math.abs(dx)) {
      onToolbarPointerUp(event);
      return;
    }
    toolbarDragState.dragged = true;
    toolbarDragging.value = true;
  }

  el.scrollLeft = toolbarDragState.startScrollLeft - dx;
  event.preventDefault();
}

function onToolbarPointerUp(event: PointerEvent): void {
  if (!toolbarDragState || event.pointerId !== toolbarDragState.pointerId) return;
  const el = toolbarScrollEl.value;
  if (el?.hasPointerCapture?.(event.pointerId)) {
    el.releasePointerCapture(event.pointerId);
  }
  if (toolbarDragState.dragged) {
    suppressToolbarClickUntil = Date.now() + 220;
  }
  toolbarDragState = null;
  toolbarDragging.value = false;
}

function onToolbarClickCapture(event: MouseEvent): void {
  if (Date.now() < suppressToolbarClickUntil) {
    event.preventDefault();
    event.stopPropagation();
  }
}

/** 中断复用原 Client turn 入口；保存失败仍允许停止，失败不显示成功。 */
const interrupt = async () => {
  const turnId = props.runningTurnId;
  if (!turnId || !composerConnected.value || interrupting.value || turnDraining.value) return;
  interrupting.value = true;
  try {
    await chat.interruptTurn(ctx.value, { workspaceId: props.workspaceId, threadId: props.threadId, turnId });
    interrupting.value = false;
    if (turnDraining.value) message.info("已停止，正在保存剩余输出");
    else message.success("已停止");
  } catch (e) {
    interrupting.value = false;
    console.error("[composer.interrupt.failed]", { ...describeWorkflowFailure(e), workspaceId: props.workspaceId,
      threadId: props.threadId, turnId, rootCause: e instanceof Error ? e.message : String(e) });
    message.error(e instanceof Error ? e.message : String(e));
  }
};

watch(
  [
    () => props.workspaceId,
    () => props.threadId,
    () => config.workspaceId,
    () => props.disabled,
    () => props.allowDraftWhenDisabled,
    () => composerConnected.value,
  ],
  () => {
    const scopeMatches = props.workspaceId === draftAuthorizationWorkspaceId
      && props.threadId === draftAuthorizationThreadId
      && String(props.workspaceId) === String(config.workspaceId);
    if (!scopeMatches) return;
    draftWriteAuthorized = (!props.disabled || props.allowDraftWhenDisabled) && composerConnected.value;
  },
  { immediate: true, flush: "sync" },
);

const contextActionsDisabled = computed(() => composerWriteBlocked.value || Boolean(props.runningTurnId));

onUnmounted(() => {
  if (queueAppendedToastTimer != null) clearTimeout(queueAppendedToastTimer);
  queueAppendedToastTimer = null;
});

const isMobile = typeof window !== "undefined" && window.innerWidth <= 767;

watch(
  () => composerWriteBlocked.value,
  (blocked) => {
    if (!blocked) {
      if (draftDirty) scheduleDraftSave();
      if (composerConnected.value) {
        const prefsTask = flushPendingPrefsForWorkspace();
        if (prefsTask) void prefsTask.catch((error) => reportThreadPrefsSaveFailure(captureThreadPrefsSaveScope(), error));
      }
      return;
    }
    if (draftDirty) {
      chat.setPendingLocalThreadDraft(props.threadId, snapshotDraft(), {
        workspaceScopeToken: draftWorkspaceScopeToken,
      });
    }
    cancelDraftSave();
    closeInputActionPicker();
    closeMentionPicker();
    // 锁状态变化不清理已产生的 prefs scope；恢复连接后由 watcher 重新排队。
    settingsOpen.value = false;
  },
  { immediate: true, flush: "sync" },
);

/** 外部调用：回填文本到输入框（回滚后恢复用户 prompt）。 */
function prefill(value: string): void {
  if (composerWriteBlocked.value) return;
  text.value = value;
}

/** 当前输入允许写入时追加外部文本。 */
function appendText(value: string): void {
  if (composerWriteBlocked.value) return;
  const next = String(value ?? "").trim();
  if (!next) return;
  if (!text.value.trim()) {
    text.value = next;
    return;
  }
  const separator = text.value.endsWith("\n") ? "" : "\n";
  text.value = `${text.value}${separator}${next}`;
}

/** 外部一键修复：输入框为空且会话空闲时写入并直接发送，避免误发用户已有草稿。 */
async function sendExternalText(value: string): Promise<boolean> {
  const next = String(value ?? "").trim();
  if (!next) return false;
  if (composerWriteBlocked.value) { message.warning(composerWriteBlockedReason.value); return false; }
  if (props.runningTurnId) { message.warning("会话正在执行，请等待完成后再一键修复"); return false; }
  if (text.value.trim()) {
    appendText(next);
    message.info("输入框已有内容，已追加修复建议，请确认后发送");
    return false;
  }
  text.value = next;
  await nextTick();
  if (!canSend.value) { message.warning("当前会话暂时无法发送，请检查模型和连接状态"); return false; }
  await send();
  return true;
}

/** 直接在本机安装/修复当前引擎 CLI；进行中状态显示在输入区提示行。 */
async function repairEngineCli(): Promise<void> {
  const engineId = engine.value;
  if (!engineId || cliRepairBusy.value) return;
  if (isSharedWorkspace.value) { message.warning("共享工作区不支持本机 CLI 安装/修复"); return; }
  const workspaceId = String(config.workspaceId ?? "").trim();
  const scope = {
    connected: config.connected,
    isDesktop: config.isDesktop,
    localRuntimeReady: config.localRuntimeReady,
    workspaceId,
    workspaceIsLocal: isDesktopWorkspace(config, workspaceId),
  };
  if (!canLoadSoftwareUpdateStatus(scope)) { message.warning("本机 Client 未就绪，暂时无法安装/修复 CLI"); return; }
  const targetWorkspaceId = resolveSoftwareUpdateWorkspaceId(scope);
  const requestCtx = { ...ctx.value };
  const network = { mode: "auto" as const, proxyUrl: null };
  const label = ENGINE_LABELS[engineId];
  cliRepairBusy.value = true;
  cliRepairHint.value = `正在安装/修复 ${label} CLI，请稍候…`;
  try {
    const status = await getSoftwareUpdateStatus(requestCtx, { network, forceRefresh: true }, targetWorkspaceId);
    if (!status.ok) throw new Error(status.message);
    const item = status.items.find((entry) => entry.engineType === engineId);
    if (!item) throw new Error(`未找到 ${label} CLI 安装信息`);
    const result = await npmInstall(requestCtx, { npmPackage: item.npmPackage, network }, targetWorkspaceId);
    if (!result.ok) throw new Error(result.message);
    if (!result.success) {
      throw new Error(result.requiresPrivilege
        ? `${label} CLI 需要管理员权限，请在设置中按引导安装`
        : result.error || `${label} CLI 安装/修复失败`);
    }
    message.success(`${label} CLI 安装/修复完成`);
    // 引擎状态按当前会话工作区缓存；优先刷新这里，保证输入区提示立即更新。
    const refreshWorkspaceId = String(props.workspaceId ?? "").trim() || targetWorkspaceId;
    try {
      await engines.refresh(requestCtx, refreshWorkspaceId);
    } catch (refreshError) {
      if (isCancelledRequestError(refreshError)) return;
      console.error("[composer.cli-repair.refresh.failed]", { ...describeWorkflowFailure(refreshError), workspaceId: refreshWorkspaceId,
        threadId: props.threadId, engineType: engineId, error: refreshError });
      message.warning(`${label} CLI 已安装，但引擎状态刷新失败，请稍后重试`);
    }
  } catch (error) {
    if (isCancelledRequestError(error)) return;
    message.error(error instanceof Error ? error.message : "安装/修复失败，请重试");
  } finally {
    cliRepairBusy.value = false;
    cliRepairHint.value = null;
  }
}

/** 当前输入允许写入时追加外部文本附件。 */
function attachTextFile(file: TextFileAttachment): void {
  if (composerWriteBlocked.value) return;
  addTextAttachment(file);
}

/** 判断父组件能否安全消费排队中的外部回填动作。 */
function canAcceptExternalActions(): boolean {
  return !composerWriteBlocked.value && draftScopeHydrated.value && !draftHydrating.value && draftRemoteMutationDepth.value === 0;
}

defineExpose({ prefill, appendText, attachTextFile, sendExternalText, canAcceptExternalActions, prepareThreadSwitch });
</script>

<template>
  <div class="composer" :class="{ 'composer--h5': props.surface === 'h5', 'composer--knowledge': isKnowledgeSession }" @drop.prevent="onDrop" @dragover.prevent>
    <div v-if="localModelSetupActive" class="composer__hint composer__hint--warn composer__hint-row">
      <span>未登录且未配置模型 Key，当前无法发送。</span>
      <a-button v-if="appModals" size="small" type="link" @click="openModelKeySettings">去配置</a-button>
      <a-button v-if="appModals" size="small" type="link" @click="openModelLogin">登录账号</a-button>
    </div>
    <div v-if="engineCliStatusIssue" class="composer__hint composer__hint--warn composer__hint-row">
      <span>{{ cliRepairHint || engineCliStatusIssue }}</span>
      <a-button v-if="engineCliMissing && !isSharedWorkspace" size="small" type="link" :loading="cliRepairBusy" :disabled="cliRepairBusy" @click="repairEngineCli">安装/修复 CLI</a-button>
    </div>
    <div v-if="currentModelProviderIssue && !engineCliMissing && !localModelSetupActive" class="composer__hint composer__hint--warn">
      {{ currentModelProviderIssue }}
    </div>

    <div v-if="imageAttachments.length || textFileAttachments.length" class="composer__attachments">
      <div v-for="a in imageAttachments" :key="a.id" class="composer__attachment">
        <button type="button" class="composer__attachment-preview" :title="`预览 ${a.name}`" @click="openImagePreview(a.dataUrl)">
          <img :src="a.dataUrl" class="composer__attachment-thumb" :alt="a.name" />
        </button>
        <div class="composer__attachment-name" :title="a.name">{{ a.name }}</div>
        <a-button size="small" type="text" :disabled="composerWriteBlocked" @click="removeImage(a.id)">移除</a-button>
      </div>

      <div v-for="f in textFileAttachments" :key="f.id" class="composer__attachment composer__attachment--file">
        <div class="composer__file-icon">TXT</div>
        <div class="composer__attachment-name" :title="f.name">{{ f.displayName || f.name }}</div>
        <a-button size="small" type="text" @click="openTextFilePreview(f)">预览</a-button>
        <a-button size="small" type="text" :disabled="composerWriteBlocked" @click="removeTextFile(f.id)">移除</a-button>
      </div>
    </div>

    <div class="composer__input-row">
      <div class="composer__toolbar">
        <input ref="localFileInputEl" type="file" :accept="fileAccept" multiple style="display: none" @change="onFileChange" />
        <div
          ref="toolbarScrollEl"
          class="composer__toolbar-primary"
          :class="{ 'composer__toolbar-primary--dragging': toolbarDragging }"
          @wheel="onToolbarWheel"
          @pointerdown="onToolbarPointerDown"
          @pointermove="onToolbarPointerMove"
          @pointerup="onToolbarPointerUp"
          @pointercancel="onToolbarPointerUp"
          @click.capture="onToolbarClickCapture"
        >
          <a-button
            size="small"
            :type="props.surface === 'h5' ? 'default' : 'text'"
            :shape="props.surface === 'h5' ? 'circle' : 'default'"
            :disabled="composerWriteBlocked"
            aria-label="添加附件"
            :title="`添加图片、文本、Word、Excel、PPT 或 PDF（${attachmentSourceLimitHint}）`"
            @click="handleOpenFilePicker"
          >
            <PaperClipOutlined v-if="props.surface === 'h5'" />
            <template v-else>+ 附件</template>
          </a-button>
          <template v-if="props.surface !== 'h5'">
            <span class="composer__toolbar-sep" />
            <slot name="toolbar-before-model" :disabled="composerWriteBlocked || !draftScopeHydrated || draftHydrating" />

            <a-select
              ref="modelSelectRef"
              v-if="flatModelOptions.length"
              :value="model"
              :open="modelSelectOpen"
              size="small"
              :bordered="false"
              :options="filteredModelOptionGroups"
              :disabled="composerWriteBlocked"
              class="composer__model-select"
              :class="{ 'composer__model-select--unavailable': currentModelProviderIssue }"
              popup-class-name="composer__model-dropdown"
              :dropdown-match-select-width="false"
              placement="topLeft"
              placeholder="选择模型"
              @update:value="(value: string) => { handleModelChange(value, true); notifyModelPrefsChange(); }"
              @dropdownVisibleChange="onModelDropdownVisibleChange"
            >
              <template #dropdownRender="{ menuNode: menu }">
                <component :is="menu" />
                <div class="composer__model-search">
                  <a-input
                    v-model:value="modelSearchQuery"
                    placeholder="搜索模型..."
                    size="small"
                    allow-clear
                    @keydown.stop
                    @click.stop
                  >
                    <template #prefix><SearchOutlined style="color: var(--app-muted); font-size: 12px;" /></template>
                  </a-input>
                </div>
              </template>
            </a-select>
            <a-select
              v-if="effortOptions.length"
              v-model:value="effort"
              size="small"
              :bordered="false"
              :options="effortOptions"
              :disabled="composerWriteBlocked"
              class="composer__effort-select"
              popup-class-name="composer__effort-dropdown"
              :dropdown-match-select-width="false"
              placement="topLeft"
              placeholder="Effort"
            />
            <!-- 执行/计划模式已统一放入设置弹层；知识与节点讨论会话由 interactionSettingsVisible 隐藏。 -->
            <span v-if="fastModeAvailable" class="composer__toolbar-sep" />

            <a-tooltip v-if="fastModeAvailable" :title="settingsHelp.fastMode" placement="top" color="var(--app-panel-bg)"
              :overlay-style="{ whiteSpace: 'pre-line', maxWidth: '300px' }"
              overlay-class-name="composer__tooltip">
              <a-button
                size="small"
                type="text"
                :disabled="composerWriteBlocked"
                :class="fastMode ? 'composer__toggle--on' : ''"
                @click="fastMode = !fastMode"
              >
                Fast
              </a-button>
            </a-tooltip>
            <span v-if="knowledgeToggleVisible" class="composer__toolbar-sep" />

            <a-tooltip v-if="knowledgeToggleVisible" :title="settingsHelp.knowledge" placement="top" color="var(--app-panel-bg)"
              :overlay-style="{ whiteSpace: 'pre-line', maxWidth: '300px' }"
              overlay-class-name="composer__tooltip">
              <a-button
                size="small"
                type="text"
                :disabled="composerWriteBlocked || knowledgeToggleBusy"
                :loading="knowledgeToggleBusy"
                :class="knowledgeEnabled ? 'composer__toggle--on' : ''"
                :aria-pressed="knowledgeEnabled"
                @click="toggleKnowledgeEnabled"
              >
                Spec
              </a-button>
            </a-tooltip>
            <span v-if="workflowToggleVisible" class="composer__toolbar-sep" />

            <a-tooltip v-if="workflowToggleVisible" :title="settingsHelp.recommendation" placement="top" color="var(--app-panel-bg)"
              :overlay-style="{ whiteSpace: 'pre-line', maxWidth: '300px' }"
              overlay-class-name="composer__tooltip">
              <a-button
                size="small"
                type="text"
                :disabled="composerWriteBlocked || workflowToggleBusy"
                :class="recommendationEnabled ? 'composer__toggle--on' : ''"
                :aria-pressed="recommendationEnabled"
                @click="toggleWorkflowRecommendation"
              >
                WorkFlow
              </a-button>
            </a-tooltip>
            <span v-if="roleSelectorVisible" class="composer__toolbar-sep" />

            <a-select
              ref="roleSelectRef"
              v-if="roleSelectorVisible"
              v-model:value="selectedRoleId"
              :open="roleSelectOpen"
              size="small"
              :bordered="false"
              :options="roleOptions"
              :disabled="composerWriteBlocked"
              :loading="roleOptionsLoading"
              class="composer__role-select"
              popup-class-name="composer__role-dropdown"
              :dropdown-match-select-width="false"
              placement="topLeft"
              placeholder="Agent"
              allow-clear
              show-search
              :filter-option="filterRoleOption"
              @dropdownVisibleChange="roleSelectOpen = $event"
            />
          </template>
        </div>

        <div v-if="props.surface !== 'h5'" class="composer__toolbar-secondary">
          <slot name="toolbar-extra" />
          <QuickPhrasePicker v-if="quickPhrasesAvailable" :disabled="composerWriteBlocked" :disabled-reason="composerWriteBlockedReason" @insert="insertQuickPhrase" />
          <a-button v-else size="small" type="text" :disabled="true" aria-label="常用提示词" title="登录账号后使用常用提示词"><SnippetsOutlined /></a-button>
          <RelayBalanceReminder v-if="!localChatReady" ref="relayBalanceReminderRef" :engine="engine" :provider-id="selectedModelProviderId" />

          <a-popover v-if="hasSettingsContent" :open="settingsOpen" trigger="click" placement="topRight" @open-change="onSettingsVisibleChange">
            <template #content>
              <div class="composer__settings">
                <div v-if="interactionSettingsVisible" class="composer__settings-group">
                  <div class="composer__settings-group-title">交互模式</div>
                  <div class="composer__settings-row">
                    <div class="composer__settings-label">
                      执行模式
                      <a-tooltip :title="settingsHelp.accessMode" placement="right"
                        :overlay-style="{ whiteSpace: 'pre-line', maxWidth: '340px' }">
                        <QuestionCircleOutlined class="composer__help-icon" />
                      </a-tooltip>
                    </div>
                    <a-select
                      v-model:value="accessMode"
                      size="small"
                      class="composer__access-select"
                      :options="accessModeOptions"
                      :disabled="composerWriteBlocked || planMode"
                      popup-class-name="composer__access-dropdown"
                      :dropdown-match-select-width="false"
                      placement="topLeft"
                    />
                  </div>
                  <div v-if="planMode" class="composer__ctx-bound">
                    计划模式优先，执行模式暂不生效
                  </div>
                  <div class="composer__settings-row">
                    <div class="composer__settings-label">
                      计划模式
                      <a-tooltip :title="settingsHelp.planMode" placement="right"
                        :overlay-style="{ whiteSpace: 'pre-line', maxWidth: '340px' }">
                        <QuestionCircleOutlined class="composer__help-icon" />
                      </a-tooltip>
                    </div>
                    <a-switch
                      v-model:checked="planMode"
                      size="small"
                      :disabled="composerWriteBlocked"
                      aria-label="计划模式"
                    />
                  </div>
                </div>
                <div v-if="showContextSettings" class="composer__settings-group">
                  <div class="composer__settings-group-title">上下文</div>
                  <div class="composer__ctx-block" v-if="showAutoCompactControl">
                    <div class="composer__ctx-header">
                      <div class="composer__settings-label">
                        压缩阈值
                        <a-tooltip :title="settingsHelp.autoCompactPct" placement="right"
                          :overlay-style="{ whiteSpace: 'pre-line', maxWidth: '340px' }">
                          <QuestionCircleOutlined class="composer__help-icon" />
                        </a-tooltip>
                      </div>
                      <span class="composer__ctx-value">{{ autoCompactPct }}%</span>
                    </div>
                    <div class="composer__ctx-slider">
                      <span class="composer__ctx-bound">{{ autoCompactMin }}%</span>
                      <a-slider
                        v-model:value="autoCompactPct"
                        :min="autoCompactMin"
                        :max="autoCompactMax"
                        :step="1"
                        :disabled="threadConfigLocked"
                        :tooltip="{ formatter: (value?: number) => `${value ?? PRODUCT_DEFAULT_AUTO_COMPACT_PCT}%` }"
                      />
                      <span class="composer__ctx-bound">{{ autoCompactMax }}%</span>
                    </div>
                  </div>
                  <div class="composer__ctx-block" v-if="showContextWindowInfo">
                    <div class="composer__ctx-header">
                      <div class="composer__settings-label">
                        上下文窗口
                        <a-tooltip :title="contextWindowHelp" placement="right"
                          :overlay-style="{ whiteSpace: 'pre-line', maxWidth: '340px' }">
                          <QuestionCircleOutlined class="composer__help-icon" />
                        </a-tooltip>
                      </div>
                      <span class="composer__ctx-value">{{ formatTokens(effectiveContextWindow) }}</span>
                    </div>
                    <div v-if="contextBillingHint" class="composer__ctx-bound">{{ contextBillingHint }}</div>
                  </div>
                </div>
                <div v-if="threadConfigLocked" class="composer__ctx-bound">
                  {{ threadConfigLockHint }}
                </div>
              </div>
            </template>
            <a-button size="small" type="text" :disabled="composerWriteBlocked" aria-label="设置" title="设置">
              <SettingOutlined style="font-size: 16px" />
            </a-button>
          </a-popover>
        </div>
        <RelayBalanceReminder
          v-if="props.surface === 'h5' && !localChatReady"
          ref="relayBalanceReminderRef"
          :engine="engine"
          :provider-id="selectedModelProviderId"
          :trigger-visible="false"
        />
      </div>

      <div
        v-if="inputActionOpen"
        class="composer__mention-picker composer__input-action-picker"
        role="listbox"
        :aria-label="inputActionTokenRange?.trigger === '$' ? 'Codex Skill 候选' : 'Slash 命令候选'"
      >
        <div class="composer__input-action-header">
          <strong>{{ inputActionTokenRange?.trigger === "$" ? "Codex Skill" : engine === "codex" ? "Codex CLI 命令" : "Claude 命令" }}</strong>
          <span v-if="inputActionTokenRange?.trigger === '/'">
            {{ filteredInputActionActions.length }} 项 · ↑↓选择 / Enter执行 / Tab补全
          </span>
          <span v-else>↑↓选择 / Enter或Tab插入</span>
        </div>
        <div v-if="inputActionLoading" class="composer__mention-state">正在读取候选...</div>
        <div v-else-if="inputActionError" class="composer__mention-state composer__mention-state--error">
          <span>{{ inputActionError }}</span>
          <a-button size="small" type="link" @mousedown.prevent @click="retryInputActionCatalog">重试</a-button>
        </div>
        <template v-else>
          <div v-if="inputActionCatalogMessage" class="composer__mention-state">{{ inputActionCatalogMessage }}</div>
          <div v-if="!filteredInputActionActions.length && !inputActionCatalogMessage" class="composer__mention-state">
            没有匹配候选，可继续手动输入
          </div>
          <button
            v-for="(item, index) in filteredInputActionActions"
            :key="item.kind === 'codex-skill' ? item.skillId : `${item.source}:${item.token}`"
            type="button"
            class="composer__mention-option"
            :class="{
              'composer__mention-option--active': index === inputActionSelectedIndex,
              'composer__mention-option--disabled': !isInputActionEnabled(item),
            }"
            :disabled="!isInputActionEnabled(item)"
            role="option"
            :aria-selected="index === inputActionSelectedIndex"
            :title="inputActionTitle(item)"
            @mousedown.prevent="selectInputAction(item)"
          >
            <span class="composer__input-action-main">
              <span class="composer__mention-path">{{ item.token }}</span>
              <small v-if="item.description" class="composer__input-action-description">{{ item.description }}</small>
            </span>
            <span class="composer__mention-kind">{{ describeComposerInputAction(item) }}</span>
          </button>
        </template>
      </div>
      <div v-if="mentionOpen" class="composer__mention-picker" @scroll="onMentionScroll">
        <div v-if="mentionLoading" class="composer__mention-state">搜索中...</div>
        <div v-else-if="mentionError" class="composer__mention-state composer__mention-state--error">{{ mentionError }}</div>
        <div v-else-if="!mentionResults.length" class="composer__mention-state">没有匹配路径</div>
        <template v-else>
          <button
            v-for="(item, index) in mentionResults"
            :key="item.path"
            type="button"
            class="composer__mention-option"
            :class="{ 'composer__mention-option--active': index === mentionSelectedIndex }"
            @mousedown.prevent="selectMentionResult(item)"
          >
            <span class="composer__mention-path" :title="item.path">{{ item.path }}</span>
            <span class="composer__mention-kind">{{ item.isDir ? "目录" : "文件" }}</span>
          </button>
          <div v-if="mentionLoadingMore" class="composer__mention-state">加载更多...</div>
        </template>
      </div>
      <a-textarea
        ref="textareaRef"
        v-model:value="text"
        class="composer__textarea"
        :disabled="draftInputBlocked"
        :bordered="false"
        :auto-size="{ minRows: isMobile ? 1 : 2, maxRows: 10 }"
        :placeholder="composerPlaceholder"
        :enterkeyhint="isMobile || props.surface === 'h5' ? 'send' : undefined"
        @keydown="onInputKeydown"
        @focus="closePreviewWindowsOnComposerFocus"
        @input="onComposerInput"
        @paste="onPaste"
      />
      <div class="composer__footer">
        <div v-if="props.surface !== 'h5'" class="composer__context-bar">
          <ContextUsageBar
            :engine="engine"
            :token-usage="stableTokenUsage"
            :fallback-context-window="effectiveContextWindow"
            :disabled="contextActionsDisabled"
            @compact="handleCompactContext"
            @reset="handleResetContext"
          />
        </div>
        <a-button
          size="small"
          :type="primaryActionType"
          class="composer__send-btn"
          :class="primaryActionClass"
          :loading="primaryActionLoading"
          :disabled="primaryActionDisabled"
          :danger="primaryActionDanger"
          :title="primaryActionTitle"
          :aria-label="primaryActionLabel"
          @click="handlePrimaryAction"
        >
          <template v-if="props.surface === 'h5'">
            <StopOutlined v-if="primaryActionIsStop" />
            <SendOutlined v-else />
          </template>
          <template v-else>{{ primaryActionLabel }}</template>
        </a-button>
      </div>
    </div>
    <Transition name="composer-queue-toast">
      <div v-if="queueAppendedToast" class="composer-queue-toast" role="status" aria-live="polite">
        <span class="composer-queue-toast__icon" aria-hidden="true">✓</span>
        <span class="composer-queue-toast__body">
          <strong class="composer-queue-toast__title">已加入队列</strong>
          <span v-if="queueAppendedToast.pendingCount > 0" class="composer-queue-toast__desc">
            当前 {{ queueAppendedToast.pendingCount }} 项待投递
          </span>
        </span>
      </div>
    </Transition>
  </div>

  <a-modal
    :open="previewOpen"
    :footer="null"
    @cancel="handleCloseTextFilePreview"
    :width="attachmentPreviewModalWidth"
    :style="attachmentPreviewModalStyle"
    :body-style="attachmentPreviewBodyStyle"
    :wrap-class-name="attachmentPreviewWrapClassName"
  >
    <template #title>
      <div class="composer-attachment-preview__titlebar">
        <span>附件预览</span>
        <a-tooltip :title="attachmentPreviewFullscreenTitle">
          <a-button size="small" type="text" :aria-label="attachmentPreviewFullscreenTitle" @click.stop="toggleAttachmentPreviewFullscreen">
            <component :is="attachmentPreviewFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
          </a-button>
        </a-tooltip>
      </div>
    </template>
    <div
      v-if="previewFile"
      class="composer-attachment-preview"
      :class="{ 'composer-attachment-preview--fullscreen': attachmentPreviewFullscreen }"
    >
      <div style="display: flex; justify-content: space-between; gap: 10px; align-items: center">
        <div style="display: grid; gap: 4px">
          <div class="mono">{{ previewFile.displayName || previewFile.name }}</div>
          <div v-if="previewFile.displayName && previewFile.displayName !== previewFile.name" style="font-size: 12px; color: var(--app-muted)">
            {{ previewFile.name }}
          </div>
        </div>
      </div>
      <div v-if="previewFileKind === 'markdown' || previewFileKind === 'html'" class="composer-attachment-preview__rendered">
        <MarkdownPreview
          v-if="previewFileKind === 'markdown'"
          :content="previewFile.text"
          :file-path="previewFile.name"
        />
        <HtmlPreview
          v-else
          :content="previewFile.text"
          :file-path="previewFile.name"
        />
      </div>
      <pre v-else class="msg__pre composer-attachment-preview__text">{{ previewFile.text }}</pre>
    </div>
  </a-modal>
  <a-modal
    v-model:open="resumePickerOpen"
    title="恢复 Codex 会话"
    width="min(640px, calc(100vw - 32px))"
    :mask-closable="false"
    :confirm-loading="resumePickerLoading"
    :ok-button-props="{ disabled: !resumePickerCanConfirm }"
    ok-text="恢复"
    cancel-text="取消"
    @ok="confirmResumePicker"
    @cancel="closeResumePicker"
  >
    <div class="composer__resume-picker">
      <a-input
        v-model:value="resumePickerQuery"
        allow-clear
        placeholder="搜索会话标题或 ID"
        @keydown="onResumePickerKeydown"
      />
      <div v-if="resumePickerLoading" class="composer__resume-picker-state">正在读取 Codex 会话...</div>
      <div v-else-if="resumePickerError" class="composer__resume-picker-state composer__resume-picker-state--error">
        <span>{{ resumePickerError }}</span>
        <a-button size="small" type="link" @click="retryResumePicker">重试</a-button>
      </div>
      <div v-else-if="!resumePickerThreads.length" class="composer__resume-picker-state">
        当前没有可恢复的 Codex 会话
      </div>
      <div v-else class="composer__resume-picker-list" role="listbox" aria-label="Codex 会话列表">
        <button
          v-for="item in resumePickerThreads"
          :key="String(item.id)"
          type="button"
          class="composer__resume-picker-item"
          :class="{ 'composer__resume-picker-item--active': String(item.id) === String(resumePickerSelectedId) }"
          role="option"
          :aria-selected="String(item.id) === String(resumePickerSelectedId)"
          @click="resumePickerSelectedId = item.id"
        >
          <span class="composer__resume-picker-item-title">{{ item.title || "未命名会话" }}</span>
          <span class="composer__resume-picker-item-id">{{ item.id }}</span>
        </button>
      </div>
    </div>
  </a-modal>
  <ImagePreview :src="imagePreviewSrc" :visible="imagePreviewVisible" @close="closeImagePreview" />
</template>

<style scoped>
/* 作为入队提示的定位上下文，浮层相对输入框区域定位。 */
.composer {
  position: relative;
}

/* Select 无内容自适应宽度属性；仅覆盖知识工具栏原有的宽度上下限。 */
.composer--knowledge :deep(.composer__toolbar-primary > .ant-select) {
  width: max-content;
  min-width: 0;
  max-width: none;
}

.composer-attachment-preview__titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: calc(100% - 44px);
  min-width: 0;
}

.composer-attachment-preview__titlebar span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-attachment-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.composer-attachment-preview__rendered {
  height: 60vh;
  min-height: 320px;
  overflow: hidden;
}

.composer-attachment-preview__text {
  max-height: 60vh;
  overflow: auto;
}

:global(.composer-attachment-preview-modal--fullscreen.ant-modal-wrap) {
  overflow: hidden !important;
}

:global(.composer-attachment-preview-modal--fullscreen .ant-modal) {
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100dvh !important;
  min-height: 100dvh !important;
  max-height: 100dvh !important;
  margin: 0 !important;
  top: 0 !important;
  padding-bottom: 0 !important;
}

:global(.composer-attachment-preview-modal--fullscreen .ant-modal-content) {
  display: flex;
  flex-direction: column;
  height: 100dvh !important;
  max-height: 100dvh !important;
  border-radius: 0;
  overflow: hidden;
}

:global(.composer-attachment-preview-modal--fullscreen .ant-modal-body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden !important;
}

:global(.composer-attachment-preview-modal--fullscreen) .composer-attachment-preview {
  height: 100%;
}

:global(.composer-attachment-preview-modal--fullscreen) .composer-attachment-preview__rendered,
:global(.composer-attachment-preview-modal--fullscreen) .composer-attachment-preview__text {
  flex: 1 1 auto;
  height: auto;
  max-height: none;
  min-height: 0;
}

.composer-attachment-preview--fullscreen {
  height: 100%;
}

.composer-attachment-preview--fullscreen .composer-attachment-preview__rendered,
.composer-attachment-preview--fullscreen .composer-attachment-preview__text {
  flex: 1 1 auto;
  height: auto;
  max-height: none;
  min-height: 0;
}

.composer--h5 {
  gap: 8px;
}

.composer--h5 .composer__input-row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 44px;
  align-items: center;
  column-gap: 0;
  padding: 6px;
  overflow: visible;
  border-color: color-mix(in srgb, var(--app-border) 76%, transparent);
  border-radius: 20px;
  background: color-mix(in srgb, var(--app-panel-bg) 94%, transparent);
  box-shadow: 0 12px 32px rgba(24, 28, 38, 0.13), 0 1px 0 color-mix(in srgb, var(--app-border) 62%, transparent) inset;
  backdrop-filter: blur(24px) saturate(1.32);
}

.composer--h5 .composer__toolbar {
  grid-column: 1;
  grid-row: 1;
  align-self: center;
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
  padding: 0;
  border: 0;
}

.composer--h5 .composer__toolbar-primary {
  width: 44px;
  flex: 0 0 44px;
  justify-content: center;
  padding: 0;
  overflow: visible;
  cursor: default;
  -webkit-mask-image: none;
  mask-image: none;
}

.composer--h5 .composer__toolbar-primary :deep(.ant-btn) {
  width: 44px;
  min-width: 44px;
  height: 44px;
  padding: 0;
  border-radius: 50%;
  color: var(--app-muted);
  font-size: 19px;
}

.composer--h5 .composer__textarea {
  grid-column: 2;
  grid-row: 1;
  align-self: center;
  width: auto;
  margin: 0 6px 0 4px;
  min-height: 44px;
  max-height: 120px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-bg-secondary) 72%, transparent);
  /* iOS 聚焦小于 16px 的输入框会自动缩放并推移可见区域。 */
  font-size: 16px;
  line-height: 1.5;
}

.composer--h5 .composer__textarea:deep(.ant-input) {
  min-height: 44px;
  padding: 11px;
}

.composer--h5 .composer__footer {
  grid-column: 3;
  grid-row: 1;
  align-self: center;
  justify-content: center;
  padding: 0;
}

.composer--h5 .composer__send-btn.ant-btn {
  width: 44px;
  min-width: 44px;
  height: 44px;
  padding: 0;
  border-radius: 50%;
  font-size: 18px;
}

/* 入队后的轻提示：浮在输入框上方右侧，短暂展示后自动消失。 */
.composer-queue-toast {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  z-index: 20;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 200px;
  max-width: min(340px, calc(100vw - 32px));
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--app-border) 72%, #52c41a 28%);
  border-radius: 12px;
  background: var(--app-panel-bg);
  color: var(--app-text);
  box-shadow: 0 8px 24px rgba(20, 20, 19, 0.14), 0 2px 8px rgba(20, 20, 19, 0.08);
}

.composer-queue-toast__icon {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: color-mix(in srgb, #52c41a 14%, transparent);
  color: #389e0d;
  font-size: 11px;
  font-weight: 700;
}

.composer-queue-toast__body {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.composer-queue-toast__title {
  font-size: 13px;
  font-weight: 600;
}

.composer-queue-toast__desc {
  font-size: 12px;
  color: var(--app-muted);
}

.composer-queue-toast-enter-active,
.composer-queue-toast-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.composer-queue-toast-enter-from,
.composer-queue-toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

</style>

