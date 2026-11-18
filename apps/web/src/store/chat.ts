import { defineStore } from "pinia";
import { respondToChatWorkflow } from "../api/chatWorkflow";
import { message } from "ant-design-vue";
import {
  CHAT_WORKFLOW_ACTIVE_STATUSES,
  CHAT_WORKFLOW_BARE_INTENT_PATTERN,
  CHAT_WORKFLOW_EXPLICIT_PREFIX_PATTERN,
  compressConversationEvents,
  estimateBinaryBytesFromDataUrl,
  extractThreadPrefsPatchFromConversationEvent,
  filterEngineModelsByProviderIds,
  getConversationMessageItemId,
  mergeThreadPrefs,
  normalizeThreadListSort,
  normalizeThreadListScope,
  resolveThreadPrefsWithCatalogDefaults,
  restoreConversationState,
} from "@codeflowai/shared";
import type {
  ChatWorkflowActiveStatus,
  CompactThreadRequestBody,
  ChatWorkflowSnapshot,
  ConversationItem,
  ConversationMessage,
  CreateThreadRequestBody,
  EngineEventEnvelope,
  GetThreadDraftResponseBody,
  ManagedServiceSnapshot,
  OrchestrationEventRecord,
  RollbackThreadResponseBody,
  SendMessageRequestBody,
  ThreadGroupId,
  ThreadGroupSummary,
  ThreadListScope,
  ThreadRunningState,
  ThreadDraft,
  ThreadDraftImageAttachment,
  ThreadDraftPayload,
  ThreadFileChangeSummary,
  ThreadId,
  ThreadManagedServicesScope,
  ThreadPrefs,
  ThreadListSort,
  ThreadSummary,
  ThreadPresentation,
  ThreadWorkflowState,
  TurnId,
  WorkspaceId,
} from "@codeflowai/shared";

import {
  createCancelledRequestError,
  createApiResultError,
  createLinkedAbortController,
  isCancelledRequestError,
  type AbortKind,
  type ApiRequestContext,
} from "../api/request";
import { trackProductEvent, type AnalyticsTrackData } from "../analytics/analytics";
import { isWorkspaceClientOfflineError } from "../utils/clientOfflineNotice";
import { createBrowserUuid } from "../utils/browserUuid";
import {
  acceptThreadFileChanges,
  assignThreadGroup as apiAssignThreadGroup,
  archiveThread as apiArchiveThread,
  clearThreadDraft as apiClearThreadDraft,
  clearThread as apiClearThread,
  compactThread as apiCompactThread,
  createThreadGroup as apiCreateThreadGroup,
  createThread,
  deleteThreadGroup as apiDeleteThreadGroup,
  deleteThread as apiDeleteThread,
  deleteThreadMessage as apiDeleteThreadMessage,
  getThreadDraft as apiGetThreadDraft,
  getThreadSummary as apiGetThreadSummary,
  getThreadPrefs,
  getLatestThreadPrefs,
  interruptTurn,
  listThreadGroups as apiListThreadGroups,
  listThreadFileChanges,
  listThreadManagedServices,
  listThreads,
  loadThread,
  getThreadPresentation,
  pinThread as apiPinThread,
  renameThreadGroup as apiRenameThreadGroup,
  renameThread as apiRenameThread,
  restartCodexAppServer as apiRestartCodexAppServer,
  rollbackThread,
  saveThreadDraft as apiSaveThreadDraft,
  sendMessage,
  stopThreadManagedService as apiStopThreadManagedService,
  undoThreadFileChanges,
  updateThreadPrefs,
} from "../api/threads";
import { applyEngineEventToConversation, deleteConversationMessages, type OrchestrationNodeLabelMap } from "../features/chat/engineEventReducer";
import type { ThreadConversationState } from "../features/chat/chatTypes";
import { updateThreadIdInUrl, type ThreadUrlUpdateMode } from "../features/threads/thread-url";
import {
  isSharedWorkspaceSelectionId,
} from "../utils/workspaceId";
import { resolveAvailableModelProviderIds, resolveEngineUnavailableIssue } from "../utils/engineAvailability";
import { isFileMutationToolName } from "../utils/toolActivity";
import { useEngineStore } from "./engine";
import { useEngineKeysStore } from "./engineKeys";
import { useUiStore } from "./ui";
import { useConfigStore } from "./config";
import { isDesktopWorkspace } from "../services/desktop";

/** 首次打开会话拉取的对话事件条数；不足时按 INCREMENTAL_PAGE_SIZE 继续向前翻页。 */
const DEFAULT_THREAD_LOAD_LIMIT = 2_000;
const INCREMENTAL_PAGE_SIZE = 1_000;
const MAX_THREAD_LOAD_LIMIT = 200_000;
/** 首屏展示窗口与向上增量窗口的可见消息数。 */
const PRESENTATION_INITIAL_MESSAGES = 30;
const PRESENTATION_PAGE_MESSAGES = 10;
const THREADS_PAGE_LIMIT = 30;
const MANAGED_SERVICES_REFRESH_COOLDOWN_MS = 1_000;
const ORCHESTRATION_THREAD_RUNNING_SYNC_ATTEMPTS = 8;
const ORCHESTRATION_THREAD_RUNNING_SYNC_INTERVAL_MS = 150;
const ACTIVE_TURN_CONFLICT_MESSAGE = "当前线程仍有未完成的 AI 回合，请等待本轮完成后再发送。";
const ACTIVE_TURN_CONFLICT_RUNNING_SYNC_ATTEMPTS = 4;
const ACTIVE_TURN_CONFLICT_RUNNING_SYNC_INTERVAL_MS = 150;
/** 已接受回合的正文兜底回放窗口；正常 WS 实时事件不会触发完整回放。 */
const ACCEPTED_TURN_CONTENT_RECONCILE_DELAYS_MS = [2_500, 8_000, 20_000] as const;
const managedServiceLastRefreshAtByThreadId = new Map<string, number>();
/** 以稳定 $state 兼容 devtools action 代理；可见性登记属于面板实例，不持久化。 */
const threadPresentationSurfaces = new WeakMap<object, Map<object, { workspaceId: WorkspaceId; threadId: ThreadId }>>();
const threadReplayLoadTokenByThreadId = new Map<string, number>();
const bufferedLiveReplayEventsByThreadId = new Map<string, EngineEventEnvelope[]>();
const inFlightReadByKey = new Map<string, {
  scopeKey: string;
  controller: AbortController;
  promise: Promise<unknown>;
  cleanup: () => void;
}>();
const threadDraftMutationTailByKey = new Map<string, Promise<void>>();
const threadDraftMutationEpochByKey = new Map<string, number>();
const threadPrefsSaveTailByKey = new Map<string, Promise<void>>();
const threadPrefsMutationEpochByThreadId = new Map<string, number>();
const threadPrefsWriteEpochByThreadId = new Map<string, number>();
const threadPrefsPendingRevisionByThreadId = new Map<string, number>();
const threadPrefsPendingMetaByThreadId = new Map<string, {
  generation: number;
  workspaceId: string | null;
  writeEpoch: number;
  revision: number;
  requestContext: ApiRequestContext | null;
}>();
const threadListReadScopeEpochByWorkspaceId = new Map<string, number>();
const localDeleteRefreshThreadIdsByWorkspaceId = new Map<string, Set<string>>();
const threadDraftVersionSignalByThreadId = new Map<string, {
  epoch: number;
  version: number | null;
  updatedByWebSessionId: string | null;
}>();
const threadReadScopeEpochByThreadId = new Map<string, number>();
const threadHistoryScopeEpochByThreadId = new Map<string, number>();
const acceptedTurnContentReconcileTasks = new Map<string, {
  turnId: string;
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
}>();
type WorkspaceDraftFlusher = () => Promise<void> | null;
const workspaceDraftFlushers = new Set<WorkspaceDraftFlusher>();
let workspaceDraftFlushInFlight: Promise<void> | null = null;
let nextPendingLocalThreadDraftEpoch = 0;
let nextThreadDraftVersionSignalEpoch = 0;
let nextLocalSystemNoticeSeq = -1;

/** 为会话 mutation 请求补齐网络异常埋点；取消请求不计入业务失败。 */
async function runTrackedThreadRequest<T>(
  eventName: string,
  data: AnalyticsTrackData,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!isCancelledRequestError(error)) {
      trackProductEvent(eventName, { ...data, status: "failed", error_code_group: "request_error" });
    }
    throw error;
  }
}

function acceptedTurnContentReconcileKey(workspaceId: WorkspaceId | string, threadId: ThreadId | string): string {
  return `${String(workspaceId)}\u0000${String(threadId)}`;
}

function cancelAcceptedTurnContentReconcileForKey(key: string, turnId?: string): void {
  const task = acceptedTurnContentReconcileTasks.get(key);
  if (!task || (turnId && task.turnId !== turnId)) return;
  if (task.timer) clearTimeout(task.timer);
  acceptedTurnContentReconcileTasks.delete(key);
}

function cancelAcceptedTurnContentReconcileForThread(threadId: ThreadId | string): void {
  const suffix = `\u0000${String(threadId)}`;
  for (const [key, task] of acceptedTurnContentReconcileTasks.entries()) {
    if (!key.endsWith(suffix)) continue;
    if (task.timer) clearTimeout(task.timer);
    acceptedTurnContentReconcileTasks.delete(key);
  }
}

function conversationHasTurnActivity(state: ThreadConversationState | null | undefined, turnId: string): boolean {
  if (!state) return false;
  if (String(state.runningTurnId ?? "") === turnId || state.completedTurnIds[turnId]) return true;
  return state.items.some((item) => !(item.kind === "message" && item.role === "user")
    && String((item as { turnId?: unknown }).turnId ?? "") === turnId);
}

function scheduleAcceptedTurnTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  // Node 测试/SSR 不应因兜底观察定时器延长进程生命周期；浏览器定时器没有 unref，保持原行为。
  if (typeof timer === "object" && timer && "unref" in timer && typeof (timer as { unref?: unknown }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return timer;
}

/** 注册当前挂载 Composer 的切换前草稿提交器，返回对应注销函数。 */
export function registerWorkspaceDraftFlusher(flusher: WorkspaceDraftFlusher): () => void {
  workspaceDraftFlushers.add(flusher);
  return () => workspaceDraftFlushers.delete(flusher);
}

/** 收集所有脏草稿并复用进行中的 flush；无待提交项时返回 null。 */
export function flushWorkspaceDraftsBeforeSwitch(): Promise<void> | null {
  if (workspaceDraftFlushInFlight) return workspaceDraftFlushInFlight;
  const pending: Promise<void>[] = [];
  try {
    for (const flusher of workspaceDraftFlushers) {
      const task = flusher();
      if (task) pending.push(task);
    }
  } catch (error) {
    return Promise.reject(error);
  }
  if (pending.length === 0) return null;
  const task = Promise.all(pending).then(() => undefined);
  workspaceDraftFlushInFlight = task.finally(() => {
    workspaceDraftFlushInFlight = null;
  });
  return workspaceDraftFlushInFlight;
}

/** 将被回滚的用户消息恢复成可持久化草稿，作为回滚后的下一次输入。 */
function buildRollbackRestoredDraft(state: ThreadConversationState | undefined, toTurnId: TurnId): ThreadDraftPayload | null {
  const target = state?.items.find((item): item is ConversationMessage =>
    item.kind === "message" && item.role === "user" && item.turnId === toTurnId,
  );
  if (!target) return null;
  const draft: ThreadDraftPayload = {
    text: target.text ?? "",
    ...(target.inputKind ? { inputKind: target.inputKind } : {}),
    ...(target.skillMentions?.length
      ? { skillMentions: target.skillMentions.map((binding) => ({ ...binding })) }
      : {}),
    images: buildRollbackRestoredImages(target.images),
    files: (target.files ?? []).map((file) => ({ ...file })),
    pathReferences: (target.pathReferences ?? []).map((ref) => ({ ...ref })),
  };
  return hasThreadDraftPayloadContent(draft) ? draft : null;
}

/** 将历史消息里的 data URL 图片恢复为草稿附件结构。 */
function buildRollbackRestoredImages(images: ConversationMessage["images"]): ThreadDraftImageAttachment[] {
  return (images ?? [])
    .map((image, index): ThreadDraftImageAttachment | null => {
      const dataUrl = String(image ?? "").trim();
      if (!dataUrl) return null;
      return {
        id: `rollback_img_${index}`,
        name: `图片 ${index + 1}`,
        dataUrl,
        size: estimateBinaryBytesFromDataUrl(dataUrl) ?? new TextEncoder().encode(dataUrl).length,
      };
    })
    .filter((image): image is ThreadDraftImageAttachment => image !== null);
}

/** 判断草稿是否有实际输入内容，避免为空消息制造草稿记录。 */
function hasThreadDraftPayloadContent(draft: ThreadDraftPayload): boolean {
  return Boolean(draft.text.trim() || draft.images.length || draft.files.length);
}

/** 比较草稿正文与附件，避免相同的本地待确认内容重复推进 epoch。 */
export function sameThreadDraftPayloadContent(left: ThreadDraftPayload, right: ThreadDraftPayload): boolean {
  if (left.text !== right.text
    || (left.inputKind ?? null) !== (right.inputKind ?? null)
    || left.images.length !== right.images.length
    || left.files.length !== right.files.length) return false;
  if (!samePendingSkillMentions(left.skillMentions ?? [], right.skillMentions ?? [])) return false;
  for (let index = 0; index < left.images.length; index += 1) {
    const a = left.images[index]!;
    const b = right.images[index]!;
    if (a.id !== b.id || a.name !== b.name || a.dataUrl !== b.dataUrl || a.size !== b.size) return false;
  }
  for (let index = 0; index < left.files.length; index += 1) {
    const a = left.files[index]!;
    const b = right.files[index]!;
    if (a.id !== b.id
      || a.name !== b.name
      || (a.displayName ?? null) !== (b.displayName ?? null)
      || a.mime !== b.mime
      || a.size !== b.size
      || a.text !== b.text) return false;
  }
  const leftPaths = left.pathReferences ?? [];
  const rightPaths = right.pathReferences ?? [];
  if (leftPaths.length !== rightPaths.length) return false;
  for (let index = 0; index < leftPaths.length; index += 1) {
    const a = leftPaths[index]!;
    const b = rightPaths[index]!;
    if (a.id !== b.id
      || a.path !== b.path
      || a.kind !== b.kind
      || (a.displayName ?? null) !== (b.displayName ?? null)
      || (a.source ?? null) !== (b.source ?? null)) return false;
  }
  return true;
}

/** 提取错误消息，供回滚后的草稿恢复失败显式上抛。 */
function formatStoreError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type MutationRollbackMetadata = {
  rollbackReconciled: boolean;
  rollbackEventSeqBarrier: unknown;
  rollbackProjectionSyncWarning: string | null;
};

type MutationRollbackRefreshResult = MutationRollbackMetadata & {
  barrierError: unknown | null;
  historyReloadError: unknown | null;
  fileChangesReloadError: unknown | null;
};

/** 从成功体或 ApiErr.details 中读取一次 mutation 的自动回滚元数据。 */
function readMutationRollbackMetadata(response: unknown): MutationRollbackMetadata {
  const root = asRollbackMetadataRecord(response);
  const details = asRollbackMetadataRecord(root?.details);
  const metadata = root?.rollbackReconciled === true
    ? root
    : details?.rollbackReconciled === true
      ? details
      : null;
  const warning = readRollbackProjectionSyncWarning(root)
    ?? readRollbackProjectionSyncWarning(details);
  return {
    rollbackReconciled: metadata?.rollbackReconciled === true,
    rollbackEventSeqBarrier: metadata?.rollbackEventSeqBarrier,
    rollbackProjectionSyncWarning: warning,
  };
}

function asRollbackMetadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readRollbackProjectionSyncWarning(record: Record<string, unknown> | null): string | null {
  const warning = typeof record?.rollbackProjectionSyncWarning === "string"
    ? record.rollbackProjectionSyncWarning.trim()
    : "";
  return warning || null;
}

/** 判断发送失败是否为运行中回合冲突，用于拉取权威 running 状态。 */
function isActiveTurnConflictMessage(messageText: string): boolean {
  return messageText.includes(ACTIVE_TURN_CONFLICT_MESSAGE) || messageText.includes("当前 thread 有未完成的 turn");
}
const threadResourceScopeEpochByThreadId = new Map<string, number>();
const managedServiceResourceScopeEpochByThreadId = new Map<string, number>();
let chatReadGeneration = 0;
let threadReplayLoadGeneration = 0;

type ChatReadKind =
  | "thread-presentation"
  | "threads-refresh"
  | "threads-load-more"
  | "thread-groups"
  | "thread-hydrate"
  | "thread-prefs"
  | "thread-draft"
  | "thread-load"
  | "thread-page"
  | "file-changes"
  | "managed-services";

type ThreadReadScopeSnapshot = {
  generation: number;
  workspaceId: string;
  threadId: string;
  readScopeEpoch: number;
  historyScopeEpoch: number;
  resourceScopeEpoch: number;
};

type ManagedServicesScopeSnapshot = {
  generation: number;
  workspaceId: string;
  threadId: string;
  resourceScopeEpoch: number;
};

type WorkspaceReadScopeSnapshot = {
  generation: number;
  workspaceId: string;
  readScopeEpoch: number;
  threadListScope: ThreadListScope;
  threadListSearch: string;
  threadListSort: ThreadListSort;
  threadGroupId: ThreadGroupFilterId;
  onlyRelatedToMe: boolean | null;
};

type ThreadGroupFilterId = ThreadGroupId | "ungrouped" | null;

type ThreadListQueryOptions = {
  search?: string | null;
  sort?: ThreadListSort | null;
  groupId?: ThreadGroupFilterId;
  onlyRelatedToMe?: boolean | null;
  preferCache?: boolean;
};

type ThreadListSnapshot = {
  threads: ThreadSummary[];
  hasMore: boolean;
  nextCursor: string | null;
};

type WorkspaceActivationPhase = "idle" | "critical" | "settled";
type WorkspacePresencePhase = "pending" | "ready" | "degraded";

type WorkspaceActivationState = {
  key: string | null;
  workspaceId: string | null;
  threadId: ThreadId | null;
  phase: WorkspaceActivationPhase;
  degraded: boolean;
  presencePhase: WorkspacePresencePhase;
};

type ThreadActivationPhase = "idle" | "resolved" | "selected" | "activated" | "settled" | "invalidated";
type ThreadActivationOwner = "primary" | "embedded" | "passive";

type ThreadActivationState = {
  key: string | null;
  owner: ThreadActivationOwner | null;
  threadId: ThreadId | null;
  phase: ThreadActivationPhase;
  contentEpoch: number;
};

type PrimaryRouteResolutionState = {
  requestedThreadId: ThreadId | null;
  status: "idle" | "resolving" | "ready" | "retryable";
  message: string | null;
};

type PendingDispatchState = {
  turnId: TurnId;
  requestedAt: number;
};

type ThreadRunningHintSource = "list" | "authoritative";

type ThreadRunningHintState = {
  source: ThreadRunningHintSource;
  running: ThreadRunningState | null;
};

type FileChangesResourceState = {
  loading: boolean;
  items: ThreadFileChangeSummary[];
  error: string | null;
  version: number;
  refreshTick: number;
  hydrated: boolean;
  stale: boolean;
};

type ManagedServicesResourceState = {
  loading: boolean;
  items: ManagedServiceSnapshot[];
  error: string | null;
  version: number;
  refreshTick: number;
  hydrated: boolean;
  stale: boolean;
};

export type ChatState = {
  threads: ThreadSummary[];
  extraThreadSummariesById: Record<string, ThreadSummary>;
  selectedThreadId: ThreadId | null;
  conversations: Record<string, ThreadConversationState>;
  loadedThreads: Record<string, boolean>;
  /** 每个 thread 当前回放上限与已加载事件数（用于"加载更多历史"）。 */
  threadLoadMetaByThreadId: Record<string, {
    limit: number;
    loadedEvents: number;
    hasMore: boolean;
    /** 下一页游标：最早已加载事件的 seq（用于 beforeSeq 分页）。 */
    oldestLoadedSeq: number | null;
    /** 首屏使用消息窗口投影时，更早历史按 presentation 位置游标加载。 */
    presentationPaged?: boolean;
    /** presentation 分页游标：已加载窗口最早消息的位置。 */
    oldestPresentationPosition?: number | null;
    /** 已加载的 presentation 消息窗口大小；实时刷新沿用同一窗口。 */
    presentationLoadedMessages?: number;
    /** 正在加载更多历史（用于 UI 显示加载指示器和防止重复请求）。 */
    loadingMore: boolean;
  }>;
  /** 会话加载与回放进度：由消息区加载遮罩展示阶段文案与进度数值。 */
  threadLoading: {
    threadId: ThreadId;
    stage: "fetching" | "replaying";
    totalEvents: number;
    processedEvents: number;
  } | null;
  /** 单调递增 token：用于并发 loadThread 时避免旧任务覆盖新进度。 */
  threadLoadingToken: number;
  activeWorkspaceLastEventSeq: number;
  threadSelectCounter: number;
  fileChangesByThreadId: Record<string, FileChangesResourceState>;
  managedServicesByThreadId: Record<string, ManagedServicesResourceState>;
  threadManagedServicesScopeByThreadId: Record<string, ThreadManagedServicesScope | null>;
  /** 工作流面板的最近快照；仅用于判断会话框文字是否应进入唯一待补充待办。 */
  chatWorkflowSnapshotByThreadId: Record<string, ChatWorkflowSnapshot>;
  /** 会话工作流活跃态：列表响应全量覆盖，编排事件按会话增量修补，供会话行标签判定。 */
  threadWorkflowByThreadId: Record<string, ThreadWorkflowState>;
  /** 每个 thread 的会话级偏好缓存（唯一来源，用于 UI 展示、发送参数与持久化）。 */
  threadPrefsByThreadId: Record<string, ThreadPrefs>;
  /** 本地尚未获得服务端确认的偏好补丁；远端刷新时必须覆盖在响应之上。 */
  pendingThreadPrefsByThreadId: Record<string, ThreadPrefs>;
  /** 每个 thread 最近一次感知到的共享草稿版本；null 表示草稿被清空。 */
  threadDraftVersionByThreadId: Record<string, number | null>;
  /** loadThread/getDraft 已确认的草稿内容；字段缺失表示仍需远端读取。 */
  threadDraftByThreadId: Record<string, ThreadDraft | null>;
  /** 尚未获得远端写入确认的本地草稿；锁切换或离线时用于防止输入静默丢失。 */
  pendingLocalThreadDraftByThreadId: Record<string, ThreadDraftPayload>;
  /** 本地待确认草稿在模块生命周期内的单调版本；用于阻止迟到请求清理较新的草稿。 */
  pendingLocalThreadDraftEpochByThreadId: Record<string, number>;
  /** 每个 thread 最近一次完整回放的基础 prefs（来自 thread 元数据，而不是事件补丁）。 */
  threadBasePrefsByThreadId: Record<string, ThreadPrefs>;
  /** 每个 thread 是否已经进入过至少一次真实 turn。 */
  threadHasRealTurnActivityByThreadId: Record<string, boolean>;
  /** 每个 thread 已加载的压缩回放事件，供继续翻页时重建完整对话。 */
  threadReplayEventsByThreadId: Record<string, EngineEventEnvelope[]>;
  /** 轻量快照版本；存在时历史由展示索引提供，不再翻 canonical 事件。 */
  threadPresentationVersionByThreadId: Record<string, number>;
  /** 已接收通知要求的最低版本；刷新失败后重试也必须达到该边界。 */
  threadPresentationRequiredVersionByThreadId: Record<string, number>;
  threadPresentationErrorByThreadId: Record<string, string>;
  /** rollback 前的最大事件 seq；用于拒绝裁剪后迟到的旧 WS 事件。 */
  threadRollbackEventSeqBarrierByThreadId: Record<string, number | null>;
  /** 每个 thread 最近一次显示态 running hint；区分 list hint 与 authoritative settle。 */
  threadRunningHintByThreadId: Record<string, ThreadRunningHintState | null>;
  /** 每个 thread 已发送但尚未 authoritative started 的 pending dispatch。 */
  threadPendingDispatchByThreadId: Record<string, PendingDispatchState | null>;
  /** 每个 thread 尚未被 authoritative userMessage 覆盖的本地 pending user message。 */
  pendingLocalUserMessageByThreadId: Record<string, EngineEventEnvelope | null>;
  /** 列表服务端分页：是否有更多。 */
  threadsHasMore: boolean;
  /** 列表服务端分页：下一页游标。 */
  threadsNextCursor: string | null;
  /** 列表服务端分页：加载更多防并发。 */
  threadsLoadingMore: boolean;
  /** 当前运行时内的分类分页缓存；工作区重置和列表变更后失效。 */
  threadListCache: Record<string, ThreadListSnapshot>;
  activeThreadListCacheKey: string | null;
  /** 列表服务端标题搜索词；空字符串表示未搜索。 */
  threadListSearch: string;
  /** 当前自建会话分组筛选；null 表示全部分组，ungrouped 表示未分组。 */
  activeThreadGroupId: ThreadGroupFilterId;
  /** 当前工作区会话分组列表。 */
  threadGroups: ThreadGroupSummary[];
  /** 会话分组加载态。 */
  threadGroupsLoading: boolean;
  /** 会话分组刷新序号；用于丢弃初始化阶段的旧响应。 */
  threadGroupsRequestSeq: number;
  /** 已成功读取的分组身份和工作区；空分组同样可复用。 */
  threadGroupsLoadedScope: string | null;
  /** 共享工作区会话列表筛选；true 表示只看本人 owner/participant 相关记录。 */
  threadListOnlyRelatedToMe: boolean;
  /** 文件变更事件计数器：每当收到 item.tool.completed 且携带 changes 时递增，供 UI 感知并刷新文件列表。 */
  fileChangeTick: number;
  /** 当前工作区订阅成功计数器：重连/重订阅成功后递增，驱动当前可见附属区自愈。 */
  workspaceSubscriptionAckTick: number;
  /** 工作区补水请求计数器：由 coordinator/手动刷新/服务端 dirty 信号驱动。 */
  workspaceHydrationRequestTick: number;
  /** 当前工作区激活事务状态。 */
  workspaceActivation: WorkspaceActivationState;
  /** 地址栏中的目标会话解析状态：供主聊天页占位与重试语义使用。 */
  primaryRouteResolution: PrimaryRouteResolutionState;
  /** 显式线程 activation 协议：供主聊天入口与嵌入入口共享。 */
  threadActivationByThreadId: Record<string, ThreadActivationState>;
  threadActivationTick: number;
  /** 当前可见线程的 activation 结果；供 ChatPanel/ChatComposer 只消费 coordinator 状态。 */
  visibleThreadActivation: {
    key: string;
    threadId: ThreadId;
    contentEpoch: number;
  } | null;
  visibleThreadActivationTick: number;
  /** 线程完整 loadThread 完成后的内容代际；用于约束首屏自动补历史只跑一次。 */
  threadContentEpochByThreadId: Record<string, number>;
};

export type ChatStore = ReturnType<typeof useChatStore>;

/** 会话列表 + 对话渲染状态（统一消费 EngineEventEnvelope）。 */
export const useChatStore = defineStore("chat", {
  state: (): ChatState => ({
    threads: [],
    extraThreadSummariesById: {},
    selectedThreadId: null,
    conversations: {},
    loadedThreads: {},
    threadLoadMetaByThreadId: {},
    threadLoading: null,
    threadLoadingToken: 0,
    activeWorkspaceLastEventSeq: 0,
    threadSelectCounter: 0,
    fileChangesByThreadId: {},
    managedServicesByThreadId: {},
    threadManagedServicesScopeByThreadId: {},
    chatWorkflowSnapshotByThreadId: {},
    threadWorkflowByThreadId: {},
    threadPrefsByThreadId: {},
    pendingThreadPrefsByThreadId: {},
    threadDraftVersionByThreadId: {},
    threadDraftByThreadId: {},
    pendingLocalThreadDraftByThreadId: {},
    pendingLocalThreadDraftEpochByThreadId: {},
    threadBasePrefsByThreadId: {},
    threadHasRealTurnActivityByThreadId: {},
    threadReplayEventsByThreadId: {},
    threadPresentationVersionByThreadId: {},
    threadPresentationRequiredVersionByThreadId: {},
    threadPresentationErrorByThreadId: {},
    threadRollbackEventSeqBarrierByThreadId: {},
    threadRunningHintByThreadId: {},
    threadPendingDispatchByThreadId: {},
    pendingLocalUserMessageByThreadId: {},
    threadsHasMore: false,
    threadsNextCursor: null,
    threadsLoadingMore: false,
    threadListCache: {},
    activeThreadListCacheKey: null,
    threadListSearch: "",
    activeThreadGroupId: null,
    threadGroups: [],
    threadGroupsLoading: false,
    threadGroupsRequestSeq: 0,
    threadGroupsLoadedScope: null,
    threadListOnlyRelatedToMe: true,
    fileChangeTick: 0,
    workspaceSubscriptionAckTick: 0,
    workspaceHydrationRequestTick: 0,
    workspaceActivation: {
      key: null,
      workspaceId: null,
      threadId: null,
      phase: "idle",
      degraded: false,
      presencePhase: "pending",
    },
    primaryRouteResolution: {
      requestedThreadId: null,
      status: "idle",
      message: null,
    },
    threadActivationByThreadId: {},
    threadActivationTick: 0,
    visibleThreadActivation: null,
    visibleThreadActivationTick: 0,
    threadContentEpochByThreadId: {},
  }),
  getters: {
    threadSummaryById: (s) => (threadId: ThreadId | null): ThreadSummary | null => (
      resolveThreadSummaryFromCollections(s.threads, s.extraThreadSummariesById, threadId)
    ),
    managedServicesScopeForThread: (s) => (threadId: ThreadId | null): ThreadManagedServicesScope => (
      resolveManagedServicesScopeFromThreadState(s.threadManagedServicesScopeByThreadId, threadId)
    ),
    managedServicesStateForThread: (s) => (threadId: ThreadId | null): ManagedServicesResourceState => (
      resolveManagedServicesStateFromThreadState(s.threadManagedServicesScopeByThreadId, s.managedServicesByThreadId, threadId)
    ),
    threadActivationForThread: (s) => (threadId: ThreadId | null): ThreadActivationState => (
      resolveThreadActivationStateFromThreadState(s.threadActivationByThreadId, s.threadContentEpochByThreadId, threadId)
    ),
    threadDisplayConversationForThread: (s) => (threadId: ThreadId | null): ThreadConversationState | null => (
      resolveDisplayConversationFromState(
        s.conversations,
        s.loadedThreads,
        s.threadRunningHintByThreadId,
        s.threadPendingDispatchByThreadId,
        threadId,
      )
    ),
    threadDisplayRunningStateForThread: (s) => (threadId: ThreadId | null): ThreadRunningState | null => (
      resolveDisplayRunningStateFromState(
        s.conversations,
        s.loadedThreads,
        s.threadRunningHintByThreadId,
        s.threadPendingDispatchByThreadId,
        threadId,
      )
    ),
    primaryThreadId(s): ThreadId | null {
      return s.selectedThreadId ?? null;
    },
    selectedThread(s): ThreadSummary | null {
      return resolveThreadSummaryFromCollections(s.threads, s.extraThreadSummariesById, s.selectedThreadId);
    },
    selectedConversation(s): ThreadConversationState | null {
      if (!s.selectedThreadId) return null;
      return s.conversations[s.selectedThreadId] ?? null;
    },
    selectedDisplayConversation(s): ThreadConversationState | null {
      return resolveDisplayConversationFromState(
        s.conversations,
        s.loadedThreads,
        s.threadRunningHintByThreadId,
        s.threadPendingDispatchByThreadId,
        s.selectedThreadId,
      );
    },
  },
  actions: {
    requestWorkspaceHydration(): void {
      this.workspaceHydrationRequestTick += 1;
    },

    beginWorkspaceActivation(body: {
      key: string;
      workspaceId: WorkspaceId;
      threadId: ThreadId | null;
    }): void {
      this.workspaceActivation = {
        key: body.key,
        workspaceId: String(body.workspaceId),
        threadId: body.threadId,
        phase: "critical",
        degraded: false,
        presencePhase: "pending",
      };
    },

    markWorkspacePresenceReady(body: { key: string }): void {
      if (this.workspaceActivation.key !== body.key) return;
      this.workspaceActivation = {
        ...this.workspaceActivation,
        degraded: false,
        presencePhase: "ready",
      };
    },

    markWorkspacePresenceDegraded(body: { key: string }): void {
      if (this.workspaceActivation.key !== body.key) return;
      this.workspaceActivation = {
        ...this.workspaceActivation,
        degraded: true,
        presencePhase: "degraded",
      };
    },

    completeWorkspaceActivation(body: {
      key: string;
      threadId: ThreadId | null;
      degraded: boolean;
    }): void {
      if (this.workspaceActivation.key !== body.key) return;
      this.workspaceActivation = {
        ...this.workspaceActivation,
        threadId: body.threadId,
        phase: "settled",
        degraded: body.degraded,
      };
      if (!body.threadId && this.visibleThreadActivation) {
        this.visibleThreadActivation = null;
        this.visibleThreadActivationTick += 1;
      }
    },

    beginPrimaryRouteResolution(threadId: ThreadId): void {
      this.primaryRouteResolution = {
        requestedThreadId: threadId,
        status: "resolving",
        message: null,
      };
    },

    markPrimaryRouteResolved(threadId: ThreadId | null): void {
      this.primaryRouteResolution = {
        requestedThreadId: threadId,
        status: threadId ? "ready" : "idle",
        message: null,
      };
    },

    markPrimaryRouteRetryable(threadId: ThreadId, messageText?: string | null): void {
      this.primaryRouteResolution = {
        requestedThreadId: threadId,
        status: "retryable",
        message: String(messageText ?? "").trim() || "当前会话暂时不可用，请稍后重试。",
      };
    },

    clearPrimaryRouteResolution(): void {
      this.primaryRouteResolution = {
        requestedThreadId: null,
        status: "idle",
        message: null,
      };
    },

    markThreadResolved(body: {
      key: string;
      threadId: ThreadId;
      owner?: ThreadActivationOwner;
    }): void {
      const key = String(body.threadId);
      const current = this.threadActivationByThreadId[key] ?? createEmptyThreadActivationState(body.threadId);
      this.threadActivationByThreadId[key] = {
        ...current,
        key: body.key,
        owner: body.owner ?? current.owner ?? "primary",
        threadId: body.threadId,
        phase: "resolved",
        contentEpoch: this.threadContentEpochByThreadId[key] ?? current.contentEpoch,
      };
      this.threadActivationTick += 1;
    },

    markThreadSelected(body: {
      key: string;
      threadId: ThreadId;
      owner?: ThreadActivationOwner;
    }): void {
      const key = String(body.threadId);
      const current = this.threadActivationByThreadId[key] ?? createEmptyThreadActivationState(body.threadId);
      this.threadActivationByThreadId[key] = {
        ...current,
        key: body.key,
        owner: body.owner ?? current.owner ?? "primary",
        threadId: body.threadId,
        phase: "selected",
        contentEpoch: this.threadContentEpochByThreadId[key] ?? current.contentEpoch,
      };
      this.threadActivationTick += 1;
    },

    markThreadActivated(body: {
      key: string;
      threadId: ThreadId;
      owner?: ThreadActivationOwner;
    }): void {
      const key = String(body.threadId);
      const current = this.threadActivationByThreadId[key] ?? createEmptyThreadActivationState(body.threadId);
      this.threadActivationByThreadId[key] = {
        ...current,
        key: body.key,
        owner: body.owner ?? current.owner ?? "primary",
        threadId: body.threadId,
        phase: "activated",
        contentEpoch: this.threadContentEpochByThreadId[key] ?? current.contentEpoch,
      };
      this.threadActivationTick += 1;
    },

    markThreadSettled(body: {
      key: string;
      threadId: ThreadId;
      owner?: ThreadActivationOwner;
    }): void {
      const key = String(body.threadId);
      const current = this.threadActivationByThreadId[key] ?? createEmptyThreadActivationState(body.threadId);
      this.threadActivationByThreadId[key] = {
        ...current,
        key: body.key,
        owner: body.owner ?? current.owner ?? "primary",
        threadId: body.threadId,
        phase: "settled",
        contentEpoch: this.threadContentEpochByThreadId[key] ?? current.contentEpoch,
      };
      this.threadActivationTick += 1;
    },

    markThreadInvalidated(threadId: ThreadId): void {
      const key = String(threadId);
      const current = this.threadActivationByThreadId[key] ?? createEmptyThreadActivationState(threadId);
      this.threadActivationByThreadId[key] = {
        ...current,
        threadId,
        phase: "invalidated",
        contentEpoch: this.threadContentEpochByThreadId[key] ?? current.contentEpoch,
      };
      this.threadActivationTick += 1;
    },

    clearThreadActivation(threadId: ThreadId): void {
      const key = String(threadId);
      if (!this.threadActivationByThreadId[key]) return;
      delete this.threadActivationByThreadId[key];
      this.threadActivationTick += 1;
    },

    releasePrimaryThreadSurface(threadId: ThreadId): void {
      const key = String(threadId);
      if (String(this.primaryRouteResolution.requestedThreadId ?? "") === key) {
        this.clearPrimaryRouteResolution();
      }
      if (this.visibleThreadActivation && String(this.visibleThreadActivation.threadId) === key) {
        this.visibleThreadActivation = null;
        this.visibleThreadActivationTick += 1;
      }
      if (String(this.workspaceActivation.threadId ?? "") === key) {
        this.workspaceActivation = {
          ...this.workspaceActivation,
          threadId: null,
        };
      }
      this.clearThreadActivation(threadId);
    },

    setThreadManagedServicesScope(threadId: ThreadId, scope: ThreadManagedServicesScope | null | undefined): void {
      const key = String(threadId);
      const next = normalizeThreadManagedServicesScope(scope);
      this.threadManagedServicesScopeByThreadId[key] = next;
    },

    /** 同步面板读取的工作流事实，发送时仍由服务端重新校验版本和唯一待办。 */
    setChatWorkflowSnapshot(threadId: ThreadId, snapshot: ChatWorkflowSnapshot): void {
      this.chatWorkflowSnapshotByThreadId[String(threadId)] = snapshot;
    },

    clearThreadManagedServicesScope(threadId: ThreadId, reason: AbortKind = "selection-change"): void {
      const key = String(threadId);
      delete this.threadManagedServicesScopeByThreadId[key];
      abortRead("managed-services", key, reason);
      managedServiceLastRefreshAtByThreadId.delete(key);
      managedServiceResourceScopeEpochByThreadId.delete(key);
      delete this.managedServicesByThreadId[key];
    },

    invalidateThreadManagedServices(threadId: ThreadId, reason: AbortKind): void {
      const scope = resolveManagedServicesScopeFromThreadState(this.threadManagedServicesScopeByThreadId, threadId);
      const ownerThreadId = String(scope.threadId ?? "").trim();
      if (!scope.visible || !ownerThreadId) return;
      bumpScopeEpoch(managedServiceResourceScopeEpochByThreadId, ownerThreadId);
      abortRead("managed-services", ownerThreadId, reason);
      managedServiceLastRefreshAtByThreadId.delete(ownerThreadId);
    },

    markManagedServicesChanged(threadId: ThreadId): void {
      const key = String(threadId ?? "").trim();
      if (!key) return;
      bumpScopeEpoch(managedServiceResourceScopeEpochByThreadId, key);
      abortRead("managed-services", key, "scope-change");
      managedServiceLastRefreshAtByThreadId.delete(key);
      const current = this.managedServicesByThreadId[key] ?? createEmptyManagedServicesResourceState();
      this.managedServicesByThreadId[key] = {
        ...current,
        error: null,
        refreshTick: current.refreshTick + 1,
        stale: true,
      };
    },

    handleOrchestrationEvent(event: OrchestrationEventRecord): void {
      const type = String(event.type ?? "").trim();
      if (type === "orchestration.chatWorkflowStatusChanged") {
        // 只改本地 overlay：发起 refreshThreads 会全量替换 threads 并重置游标，造成分页截断与滚动跳动。
        const payload = safeParseJsonRecord(event.payloadJson);
        const threadId = String(payload?.threadId ?? "").trim();
        if (!threadId) return;
        const status = String(payload?.status ?? "").trim();
        const instanceId = String(payload?.instanceId ?? "").trim() || null;
        const taskId = String(payload?.taskId ?? "").trim();
        this.setThreadWorkflowState(
          threadId as ThreadId,
          CHAT_WORKFLOW_ACTIVE_STATUSES.has(status)
            ? { status: status as ChatWorkflowActiveStatus, instanceId, taskId }
            : null,
        );
        return;
      }
      if (type === "orchestration.chatWorkflowActivity") {
        // 编排活动（节点执行等）只回填该会话行的活动时间：与会话自身事件同口径，且同样不做列表全量刷新。
        const payload = safeParseJsonRecord(event.payloadJson);
        const threadId = String(payload?.threadId ?? "").trim();
        const updatedAt = Number(payload?.updatedAt ?? 0);
        if (!threadId || !Number.isFinite(updatedAt) || updatedAt <= 0) return;
        const existing = this.getThreadSummary(threadId as ThreadId);
        if (!existing || updatedAt <= Number(existing.updatedAt ?? 0)) return;
        this.upsertThreadSummary({ ...existing, updatedAt });
        return;
      }
      if (type !== "orchestration.managedServices.changed") return;
      const payload = safeParseJsonRecord(event.payloadJson);
      const threadId = String(payload?.threadId ?? "").trim();
      if (!threadId) return;
      this.markManagedServicesChanged(threadId as ThreadId);
    },

    markVisibleThreadActivated(body: { key: string; threadId: ThreadId }): void {
      const threadId = body.threadId;
      const contentEpoch = this.threadContentEpochByThreadId[String(threadId)] ?? 0;
      this.visibleThreadActivation = {
        key: body.key,
        threadId,
        contentEpoch,
      };
      this.visibleThreadActivationTick += 1;
      this.markThreadActivated({ key: body.key, threadId, owner: "primary" });
      this.markThreadSettled({ key: body.key, threadId, owner: "primary" });
    },

    async activateEmbeddedThread(
      ctx: ApiRequestContext,
      body: { workspaceId: WorkspaceId; threadId: ThreadId; key: string; owner?: Exclude<ThreadActivationOwner, "primary">; forceReload?: boolean },
    ): Promise<void> {
      const owner = body.owner ?? "embedded";
      const alreadyHydrated = Boolean(this.loadedThreads[String(body.threadId)]);
      this.markThreadResolved({ key: body.key, threadId: body.threadId, owner });
      await this.ensureThreadHydrated(ctx, {
        workspaceId: body.workspaceId,
        threadId: body.threadId,
        forceReload: body.forceReload,
      });
      if (alreadyHydrated && !body.forceReload) {
        try {
          await this.syncThreadSummaryState(ctx, {
            workspaceId: body.workspaceId,
            threadId: body.threadId,
            waitForRunning: false,
          });
        } catch (error) {
          if (!isCancelledRequestError(error)) {
            console.warn("[chat.activateEmbeddedThread] failed to sync embedded thread running state:", error);
          }
        }
      }
      this.markThreadActivated({ key: body.key, threadId: body.threadId, owner });
      this.markThreadSettled({ key: body.key, threadId: body.threadId, owner });
    },

    invalidateThreadScopes(
      threadId: ThreadId,
      opts: { reason: AbortKind; read?: boolean; resource?: boolean },
    ): void {
      const key = String(threadId);
      if (opts.reason === "clear" || opts.reason === "delete") {
        invalidateQueuedThreadDraftMutations(key);
      }
      if (opts.read !== false) {
        bumpScopeEpoch(threadReadScopeEpochByThreadId, key);
        bumpScopeEpoch(threadHistoryScopeEpochByThreadId, key);
        abortRead("thread-hydrate", key, opts.reason);
        abortRead("thread-prefs", key, opts.reason);
        abortRead("thread-draft", key, opts.reason);
        abortRead("thread-load", key, opts.reason);
        abortRead("thread-page", key, opts.reason);
        abortRead("thread-presentation", key, opts.reason);
      }
      if (opts.resource !== false) {
        bumpScopeEpoch(threadResourceScopeEpochByThreadId, key);
        abortRead("file-changes", key, opts.reason);
      }
    },

    /** 只失效会话历史读取，不中断偏好、草稿或文件变更请求。 */
    invalidateThreadHistoryReads(threadId: ThreadId, reason: AbortKind): void {
      const key = String(threadId);
      bumpScopeEpoch(threadHistoryScopeEpochByThreadId, key);
      abortRead("thread-hydrate", key, reason);
      abortRead("thread-load", key, reason);
      abortRead("thread-page", key, reason);
      abortRead("thread-presentation", key, reason);
    },

    /** 清空已重置引擎 session 的旧投影，并触发仍存平台进程的权威刷新。 */
    resetThreadManagedServicesProjection(threadId: ThreadId, reason: AbortKind): void {
      const scope = resolveManagedServicesScopeFromThreadState(this.threadManagedServicesScopeByThreadId, threadId);
      const ownerThreadId = String(scope.threadId ?? "").trim();
      if (!scope.visible || !ownerThreadId) return;
      bumpScopeEpoch(managedServiceResourceScopeEpochByThreadId, ownerThreadId);
      abortRead("managed-services", ownerThreadId, reason);
      managedServiceLastRefreshAtByThreadId.delete(ownerThreadId);
      const current = this.managedServicesByThreadId[ownerThreadId] ?? createEmptyManagedServicesResourceState();
      this.managedServicesByThreadId[ownerThreadId] = {
        ...createEmptyManagedServicesResourceState(),
        refreshTick: current.refreshTick + 1,
        stale: true,
      };
    },

    markThreadFileChangesChanged(threadId: ThreadId, reason: AbortKind = "scope-change"): void {
      const key = String(threadId ?? "").trim();
      if (!key) return;
      bumpScopeEpoch(threadResourceScopeEpochByThreadId, key);
      abortRead("file-changes", key, reason);
      const current = this.fileChangesByThreadId[key] ?? createEmptyFileChangesResourceState();
      this.fileChangesByThreadId[key] = {
        ...current,
        error: null,
        refreshTick: current.refreshTick + 1,
        stale: true,
      };
    },

    /** 重订阅后重新校验所有已缓存历史，补齐已超出 WS 窗口的删除事实，保留当前展示。 */
    markWorkspaceSubscribed(): void {
      const historyThreadIds = new Set([
        ...Object.keys(this.conversations), ...Object.keys(this.loadedThreads), ...threadReplayLoadTokenByThreadId.keys(),
      ]);
      for (const threadId of historyThreadIds) {
        this.invalidateThreadHistoryReads(threadId as ThreadId, "reconnect-scope-change");
        delete this.loadedThreads[threadId];
      }
      const selectedThreadId = this.selectedThreadId;
      if (selectedThreadId) {
        this.invalidateThreadScopes(selectedThreadId, {
          reason: "reconnect-scope-change",
          read: false,
          resource: true,
        });
        this.invalidateThreadManagedServices(selectedThreadId, "reconnect-scope-change");
      }
      this.workspaceSubscriptionAckTick += 1;
    },

    clearThreadReplayState(threadId: ThreadId): void {
      const key = String(threadId);
      cancelAcceptedTurnContentReconcileForThread(threadId);
      this.threadContentEpochByThreadId[key] = (this.threadContentEpochByThreadId[key] ?? 0) + 1;
      delete this.threadReplayEventsByThreadId[key];
      delete this.threadPresentationVersionByThreadId[key];
      delete this.threadPresentationRequiredVersionByThreadId[key];
      delete this.threadPresentationErrorByThreadId[key];
      delete this.loadedThreads[key];
      delete this.threadPendingDispatchByThreadId[key];
      delete this.pendingLocalUserMessageByThreadId[key];
      delete this.threadRunningHintByThreadId[key];
      delete this.threadHasRealTurnActivityByThreadId[key];
      bufferedLiveReplayEventsByThreadId.delete(key);
      threadReplayLoadTokenByThreadId.delete(key);
      const state = this.ensureConversation(threadId);
      assignConversationState(state, createEmptyConversationState(threadId));
    },

    /** 记录 rollback 的事件屏障；后续只允许屏障之后的新 WS 事件进入投影。 */
    setThreadRollbackEventSeqBarrier(threadId: ThreadId, barrier: number): void {
      const normalized = barrier;
      if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized <= 0) {
        throw new Error(`rollback 事件屏障非法：threadId=${threadId}, barrier=${String(barrier)}`);
      }
      const key = String(threadId);
      this.threadRollbackEventSeqBarrierByThreadId[key] = Math.max(
        Number(this.threadRollbackEventSeqBarrierByThreadId[key] ?? 0),
        normalized,
      );
    },

    /** 应用 rollback barrier 并判断是否需要重载；重复 barrier 复用已完成或进行中的加载。 */
    prepareThreadRollbackHistoryReload(threadId: ThreadId, barrier: number): boolean {
      const key = String(threadId);
      const hadProjection = Boolean(this.loadedThreads[key] || this.conversations[key]);
      const previousBarrier = Number(this.threadRollbackEventSeqBarrierByThreadId[key] ?? 0);
      const isNewBarrier = barrier > previousBarrier;
      this.setThreadRollbackEventSeqBarrier(threadId, barrier);
      if (isNewBarrier) {
        invalidateQueuedThreadDraftMutations(key);
        this.invalidateThreadScopes(threadId, { reason: "thread-invalidated" });
        this.clearThreadReplayState(threadId);
      }
      return hadProjection && (isNewBarrier || !this.loadedThreads[key]);
    },

    /** 消费 mutation 响应中的自动回滚元数据，并在需要时重建 canonical 历史与文件变更。 */
    async reconcileMutationRollbackResponse(
      ctx: ApiRequestContext,
      body: { workspaceId: WorkspaceId; threadId: ThreadId },
      metadata: MutationRollbackMetadata,
    ): Promise<MutationRollbackRefreshResult> {
      const result: MutationRollbackRefreshResult = {
        ...metadata,
        barrierError: null,
        historyReloadError: null,
        fileChangesReloadError: null,
      };
      if (!metadata.rollbackReconciled) return result;

      const key = String(body.threadId);
      let shouldReload = false;
      try {
        if (metadata.rollbackEventSeqBarrier == null) throw new Error("自动回滚响应缺少事件屏障");
        shouldReload = this.prepareThreadRollbackHistoryReload(
          body.threadId,
          metadata.rollbackEventSeqBarrier as number,
        );
      } catch (cause) {
        result.barrierError = cause;
        shouldReload = Boolean(this.loadedThreads[key] || this.conversations[key]);
        invalidateQueuedThreadDraftMutations(key);
        if (shouldReload) {
          this.invalidateThreadScopes(body.threadId, { reason: "thread-invalidated" });
          this.clearThreadReplayState(body.threadId);
        }
      }

      if (!shouldReload) return result;
      const limit = this.threadLoadMetaByThreadId[key]?.limit ?? null;
      try {
        await this.loadThread(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, limit });
      } catch (cause) {
        result.historyReloadError = cause;
      }
      try {
        await this.refreshThreadFileChanges(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, force: true });
      } catch (cause) {
        result.fileChangesReloadError = cause;
      }
      return result;
    },

    /** 消费服务端 thread 变更；历史清理只重置历史/session 投影，删除才移除业务元数据。 */
    handleThreadChangedFromServer(body: {
      workspaceId?: WorkspaceId;
      threadId: ThreadId;
      kind: "created" | "updated" | "deleted" | "cleared" | "history_cleaned";
      patch?: { title?: string; archived?: boolean; pinnedAt?: number | null; updatedAt?: number } | null;
    }): boolean {
      if (body.kind !== "history_cleaned") this.threadListCache = {};
      if (body.kind === "history_cleaned") {
        this.invalidateThreadHistoryReads(body.threadId, "clear");
        this.resetThreadManagedServicesProjection(body.threadId, "clear");
        resetThreadProjectionForClear(this, body.threadId);
        return false;
      }
      if (body.kind === "cleared") {
        this.invalidateThreadScopes(body.threadId, { reason: "clear" });
        this.invalidateThreadManagedServices(body.threadId, "clear");
        const key = String(body.threadId);
        resetThreadProjectionForClear(this, body.threadId);
        this.fileChangesByThreadId[key] = createEmptyFileChangesResourceState();
        delete this.threadBasePrefsByThreadId[key];
        delete this.extraThreadSummariesById[key];
        return false;
      }
      if (body.kind === "deleted") {
        if (body.workspaceId && !isLocalDeleteRefreshThread(body.workspaceId, body.threadId)) {
          invalidateWorkspaceThreadListReads(body.workspaceId, "delete");
        }
        this.threadsLoadingMore = false;
        dropDeletedThreadState(this, body.threadId);
        return false;
      }
      if (body.kind === "updated" && body.patch) {
        const hasPinnedPatch = body.patch.pinnedAt === null || (typeof body.patch.pinnedAt === "number" && Number.isFinite(body.patch.pinnedAt));
        const hasArchivedPatch = typeof body.patch.archived === "boolean";
        const existing = this.getThreadSummary(body.threadId);
        if (existing) {
          this.upsertThreadSummary({
            ...existing,
            ...(typeof body.patch.title === "string" ? { title: body.patch.title } : {}),
            ...(typeof body.patch.archived === "boolean" ? { archived: body.patch.archived } : {}),
            ...(body.patch.pinnedAt === null || (typeof body.patch.pinnedAt === "number" && Number.isFinite(body.patch.pinnedAt))
              ? { pinnedAt: body.patch.pinnedAt }
              : {}),
            ...(typeof body.patch.updatedAt === "number" && Number.isFinite(body.patch.updatedAt)
              ? { updatedAt: body.patch.updatedAt }
              : {}),
          });
        }
        return hasPinnedPatch || hasArchivedPatch;
      }
      return body.kind === "created";
    },

    /** 消费 Server 广播的回滚屏障，并从 canonical 历史重建当前共享会话。 */
    async reconcileThreadRollbackFromServer(
      ctx: ApiRequestContext,
      body: { workspaceId: WorkspaceId; threadId: ThreadId; rollbackEventSeqBarrier: number },
    ): Promise<void> {
      const key = String(body.threadId);
      const limit = this.threadLoadMetaByThreadId[key]?.limit ?? null;
      const shouldReload = this.prepareThreadRollbackHistoryReload(body.threadId, body.rollbackEventSeqBarrier);
      if (!shouldReload) return;
      try {
        await this.loadThread(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, limit });
        await this.refreshThreadFileChanges(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, force: true });
      } catch (cause) {
        if (isCancelledRequestError(cause)) return;
        if (isWorkspaceClientOfflineError(cause)) throw cause;
        const engine = this.getThreadSummary(body.threadId)?.engine ?? "codex";
        const detail = `共享会话回滚已完成，但本地历史刷新失败：${formatStoreError(cause)}。请刷新会话后核对。`;
        appendLocalSystemNotice(this.ensureConversation(body.threadId), body.workspaceId, body.threadId, engine, detail);
        throw new Error(detail, { cause });
      }
    },

    /** 切换 workspace 时重置会话视图状态（避免跨 workspace 混用 seq/threads）。 */
    resetForWorkspace(reason: AbortKind = "workspace-switch") {
      chatReadGeneration += 1;
      abortAllReads(reason);
      threadPresentationSurfaces.delete(this.$state);
      for (const task of acceptedTurnContentReconcileTasks.values()) {
        if (task.timer) clearTimeout(task.timer);
      }
      acceptedTurnContentReconcileTasks.clear();
      threadReadScopeEpochByThreadId.clear();
      threadHistoryScopeEpochByThreadId.clear();
      threadResourceScopeEpochByThreadId.clear();
      threadListReadScopeEpochByWorkspaceId.clear();
      threadPrefsMutationEpochByThreadId.clear();
      threadPrefsWriteEpochByThreadId.clear();
      threadPrefsPendingRevisionByThreadId.clear();
      threadPrefsPendingMetaByThreadId.clear();
      localDeleteRefreshThreadIdsByWorkspaceId.clear();
      threadDraftVersionSignalByThreadId.clear();
      managedServiceLastRefreshAtByThreadId.clear();
      managedServiceResourceScopeEpochByThreadId.clear();
      this.threads = [];
      this.extraThreadSummariesById = {};
      this.selectedThreadId = null;
      this.conversations = {};
      this.loadedThreads = {};
      this.threadLoadMetaByThreadId = {};
      this.threadLoading = null;
      this.threadLoadingToken = 0;
      this.activeWorkspaceLastEventSeq = 0;
      this.threadSelectCounter = 0;
      this.fileChangesByThreadId = {};
      this.managedServicesByThreadId = {};
      this.threadManagedServicesScopeByThreadId = {};
      this.threadPrefsByThreadId = {};
      this.pendingThreadPrefsByThreadId = {};
      this.threadDraftVersionByThreadId = {};
      this.threadDraftByThreadId = {};
      this.pendingLocalThreadDraftByThreadId = {};
      this.pendingLocalThreadDraftEpochByThreadId = {};
      this.threadBasePrefsByThreadId = {};
      this.threadHasRealTurnActivityByThreadId = {};
      this.threadReplayEventsByThreadId = {};
      this.threadPresentationVersionByThreadId = {};
      this.threadPresentationRequiredVersionByThreadId = {};
      this.threadPresentationErrorByThreadId = {};
      this.threadRollbackEventSeqBarrierByThreadId = {};
      this.threadRunningHintByThreadId = {};
      this.threadPendingDispatchByThreadId = {};
      this.pendingLocalUserMessageByThreadId = {};
      this.threadsHasMore = false;
      this.threadsNextCursor = null;
      this.threadsLoadingMore = false;
      this.threadListCache = {};
      this.activeThreadListCacheKey = null;
      this.threadListSearch = "";
      this.resetThreadGroupState();
      this.threadListOnlyRelatedToMe = true;
      this.fileChangeTick = 0;
      this.workspaceSubscriptionAckTick = 0;
      this.workspaceHydrationRequestTick = 0;
      this.workspaceActivation = {
        key: null,
        workspaceId: null,
        threadId: null,
        phase: "idle",
        degraded: false,
        presencePhase: "pending",
      };
      this.primaryRouteResolution = {
        requestedThreadId: null,
        status: "idle",
        message: null,
      };
      this.threadActivationByThreadId = {};
      this.threadActivationTick = 0;
      this.visibleThreadActivation = null;
      this.visibleThreadActivationTick = 0;
      this.threadContentEpochByThreadId = {};
    },

    /** 注入或刷新单个 thread 摘要；已加载列表保持原位，排序交给显式列表刷新。 */
    upsertThreadSummary(thread: ThreadSummary) {
      const previous = this.getThreadSummary(thread.id);
      if (!previous || previous.title !== thread.title || previous.updatedAt !== thread.updatedAt
        || previous.createdAt !== thread.createdAt || previous.archived !== thread.archived
        || previous.pinnedAt !== thread.pinnedAt || previous.groupId !== thread.groupId
        || previous.threadType !== thread.threadType || previous.threadSubtype !== thread.threadSubtype) {
        this.threadListCache = {};
      }
      upsertThreadSummary(this.threads, this.extraThreadSummariesById, thread);
      this.ensureConversation(thread.id);
    },

    /** 设置当前分组筛选；空值表示全部分组。 */
    setActiveThreadGroupId(groupId: ThreadGroupFilterId): void {
      this.activeThreadGroupId = normalizeThreadGroupFilterId(groupId);
      this.threadsHasMore = false;
      this.threadsNextCursor = null;
      this.threadsLoadingMore = false;
    },

    /** 使分组快照和在途读取失效，保留当前列表供显式重读。 */
    invalidateThreadGroupReads(): void {
      this.threadGroupsRequestSeq += 1;
      this.threadGroupsLoading = false;
      this.threadGroupsLoadedScope = null;
      abortRead("thread-groups", "current", "scope-change");
    },

    /** 清空分组筛选与列表，并让未完成的分组刷新结果失效。 */
    resetThreadGroupState(): void {
      this.activeThreadGroupId = null;
      this.threadGroups = [];
      this.invalidateThreadGroupReads();
    },

    /** 分组切换复用当前身份的成功结果；显式刷新读取最新分组，并合并并发读取。 */
    async refreshThreadGroups(ctx: ApiRequestContext, workspaceId: WorkspaceId, opts?: { preferCache?: boolean }): Promise<void> {
      const scopeKey = JSON.stringify([ctx.serverWsOrigin, ctx.webSessionId, ctx.desktopClientId ?? null, workspaceId, chatReadGeneration]);
      if (opts?.preferCache && this.threadGroupsLoadedScope === scopeKey) return;
      try {
        await runScopedRead<void>("thread-groups", "current", scopeKey, async signal => {
          const requestSeq = ++this.threadGroupsRequestSeq;
          this.threadGroupsLoading = true;
          this.threadGroupsLoadedScope = null;
          try {
            const res = await apiListThreadGroups(ctx, workspaceId, { signal });
            if (requestSeq !== this.threadGroupsRequestSeq) return;
            if (!res.ok) throw createApiResultError(res);
            const groupIds = new Set(res.groups.map(group => String(group.id)));
            // 分组删除会把会话移入未分组，已确认的删除必须使列表快照同步失效。
            if (this.threadGroups.some(group => !groupIds.has(String(group.id)))) this.threadListCache = {};
            this.threadGroups = res.groups;
            if (this.activeThreadGroupId && this.activeThreadGroupId !== "ungrouped" && !groupIds.has(String(this.activeThreadGroupId))) {
              this.setActiveThreadGroupId(null);
            }
            this.threadGroupsLoadedScope = scopeKey;
          } finally {
            if (requestSeq === this.threadGroupsRequestSeq) this.threadGroupsLoading = false;
          }
        });
      } catch (error) {
        if (isCancelledRequestError(error)) return;
        throw error;
      }
    },

    /** 创建分组并刷新分组列表。 */
    async createThreadGroup(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; name: string }): Promise<ThreadGroupSummary> {
      const res = await apiCreateThreadGroup(ctx, body);
      if (!res.ok) throw new Error(res.message);
      this.invalidateThreadGroupReads();
      await this.refreshThreadGroups(ctx, body.workspaceId);
      trackProductEvent("thread_group_change", {
        action: "create",
        workspace_type: isSharedWorkspaceSelectionId(body.workspaceId) ? "shared" : "local",
      });
      return res.group;
    },

    /** 重命名分组并更新本地分组列表。 */
    async renameThreadGroup(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; groupId: ThreadGroupId; name: string }): Promise<void> {
      const res = await apiRenameThreadGroup(ctx, body);
      if (!res.ok) throw new Error(res.message);
      this.invalidateThreadGroupReads();
      this.threadGroups = this.threadGroups.map((group) => (String(group.id) === String(body.groupId) ? res.group : group));
      trackProductEvent("thread_group_change", {
        action: "rename",
        workspace_type: isSharedWorkspaceSelectionId(body.workspaceId) ? "shared" : "local",
      });
    },

    /** 删除分组并刷新当前列表；会话会回到未分组。 */
    async deleteThreadGroup(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; groupId: ThreadGroupId }): Promise<void> {
      const res = await apiDeleteThreadGroup(ctx, body);
      if (!res.ok) throw new Error(res.message);
      this.invalidateThreadGroupReads();
      this.threadGroups = this.threadGroups.filter((group) => String(group.id) !== String(body.groupId));
      if (String(this.activeThreadGroupId ?? "") === String(body.groupId)) {
        this.setActiveThreadGroupId(null);
      }
      await this.refreshThreads(ctx, body.workspaceId);
      trackProductEvent("thread_group_change", {
        action: "delete",
        workspace_type: isSharedWorkspaceSelectionId(body.workspaceId) ? "shared" : "local",
      });
    },

    /** 移动自建会话到目标分组；groupId 为空表示未分组。 */
    async assignThreadGroup(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId; groupId?: ThreadGroupId | null }): Promise<void> {
      const res = await apiAssignThreadGroup(ctx, body);
      if (!res.ok) throw new Error(res.message);
      const existing = this.getThreadSummary(body.threadId);
      if (existing) {
        this.upsertThreadSummary({ ...existing, groupId: res.groupId ?? null });
      }
      await this.refreshThreads(ctx, body.workspaceId);
      trackProductEvent("thread_group_change", {
        action: res.groupId ? "assign" : "unassign",
        workspace_type: isSharedWorkspaceSelectionId(body.workspaceId) ? "shared" : "local",
      });
    },

    getThreadSummary(threadId: ThreadId | null): ThreadSummary | null {
      return resolveThreadSummaryFromCollections(this.threads, this.extraThreadSummariesById, threadId);
    },

    async syncThreadSummaryState(
      ctx: ApiRequestContext,
      body: {
        workspaceId: WorkspaceId;
        threadId: ThreadId;
        waitForRunning?: boolean;
        attempts?: number;
        intervalMs?: number;
      },
    ): Promise<ThreadRunningState | null> {
      const maxAttempts = Math.max(1, Math.floor(body.attempts ?? (body.waitForRunning ? ORCHESTRATION_THREAD_RUNNING_SYNC_ATTEMPTS : 1)));
      const intervalMs = Math.max(0, Math.floor(body.intervalMs ?? ORCHESTRATION_THREAD_RUNNING_SYNC_INTERVAL_MS));
      const key = String(body.threadId);

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const res = await apiGetThreadSummary(ctx, {
          workspaceId: body.workspaceId,
          threadId: body.threadId,
        });
        if (!res.ok) throw new Error(res.message);

        this.upsertThreadSummary(res.thread);
        this.setThreadManagedServicesScope(res.thread.id, res.managedServices ?? null);

        const shouldApplyRunningHint = Boolean(res.running) || !body.waitForRunning || attempt === maxAttempts - 1;
        if (shouldApplyRunningHint) {
          this.clearThreadPendingDispatch(body.threadId);
          this.setThreadRunningHint(body.threadId, res.running ?? null);
        } else if (!this.threadDisplayRunningStateForThread(body.threadId)) {
          this.setThreadRunningHint(body.threadId, null);
        }

        if (res.running || !body.waitForRunning) {
          return res.running ?? null;
        }

        if (attempt < maxAttempts - 1 && intervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }

      return this.threadDisplayRunningStateForThread(body.threadId) ?? null;
    },

    /** 同步 canonical 的运行身份，停止阶段由同回合的权威 hint 提供。 */
    applyThreadRunningState(threadId: ThreadId, running: ThreadRunningState | null | undefined): void {
      const state = this.ensureConversation(threadId);
      state.runningTurnId = running?.runningTurnId ? String(running.runningTurnId) : null;
      state.runningTurnStartedAt = running?.runningTurnStartedAt ? Number(running.runningTurnStartedAt) : null;
    },

    /** 保留服务端停止阶段，列表刷新不覆盖已加载会话的权威状态。 */
    setThreadRunningHint(
      threadId: ThreadId,
      running: ThreadRunningState | null | undefined,
      opts?: { source?: ThreadRunningHintSource },
    ): void {
      const key = String(threadId);
      const source = opts?.source ?? "authoritative";
      if (source === "list") {
        if (this.loadedThreads[key]) return;
        const existingHint = this.threadRunningHintByThreadId[key] ?? null;
        if (existingHint?.source === "authoritative") return;
      }
      if (running && running.runningTurnId) {
        this.threadRunningHintByThreadId[key] = {
          source,
          running: {
            runningTurnId: String(running.runningTurnId) as TurnId,
            runningTurnStartedAt: Number(running.runningTurnStartedAt ?? Date.now()),
            ...(running.phase ? { phase: running.phase } : {}),
            ...(running.runningSource ? { runningSource: running.runningSource } : {}),
            ...(running.failureCode ? { failureCode: running.failureCode } : {}),
          },
        };
        return;
      }
      this.threadRunningHintByThreadId[key] = {
        source,
        running: null,
      };
    },

    clearThreadRunningHint(threadId: ThreadId): void {
      delete this.threadRunningHintByThreadId[String(threadId)];
    },

    /** 按会话写入活跃态；status 非活跃或缺失时清除该会话标签。列表刷新与事件补丁都走这里。 */
    setThreadWorkflowState(threadId: ThreadId, workflow: ThreadWorkflowState | null): void {
      const key = String(threadId ?? "").trim();
      if (!key) return;
      if (!workflow || !CHAT_WORKFLOW_ACTIVE_STATUSES.has(String(workflow.status))) {
        delete this.threadWorkflowByThreadId[key];
        return;
      }
      this.threadWorkflowByThreadId[key] = workflow;
    },

    setThreadPendingDispatch(threadId: ThreadId, turnId: string | null | undefined): void {
      const key = String(threadId);
      const normalizedTurnId = String(turnId ?? "").trim();
      if (!normalizedTurnId) {
        delete this.threadPendingDispatchByThreadId[key];
        return;
      }
      this.threadPendingDispatchByThreadId[key] = {
        turnId: normalizedTurnId as TurnId,
        requestedAt: Date.now(),
      };
    },

    clearThreadPendingDispatch(threadId: ThreadId): void {
      delete this.threadPendingDispatchByThreadId[String(threadId)];
    },

    /**
     * 已接受回合的事件若在 WebSocket 订阅切换窗口内丢失，定时从 Client 回放当前 thread。
     * 只对已加载的普通聊天回合启用，并以 turnId + generation 严格隔离，避免旧回合覆盖新回合。
     */
    scheduleAcceptedTurnContentReconcile(
      ctx: ApiRequestContext,
      body: { workspaceId: WorkspaceId; threadId: ThreadId },
      turnId: string,
    ): void {
      const normalizedTurnId = String(turnId ?? "").trim();
      const key = acceptedTurnContentReconcileKey(body.workspaceId, body.threadId);
      if (!normalizedTurnId || (!this.loadedThreads[String(body.threadId)] && !this.conversations[String(body.threadId)])) return;
      const previous = acceptedTurnContentReconcileTasks.get(key);
      const generation = (previous?.generation ?? 0) + 1;
      cancelAcceptedTurnContentReconcileForKey(key);
      const task = { turnId: normalizedTurnId, generation, timer: null as ReturnType<typeof setTimeout> | null };
      acceptedTurnContentReconcileTasks.set(key, task);

      const reconcile = async (attempt: number): Promise<void> => {
        const current = acceptedTurnContentReconcileTasks.get(key);
        if (current !== task || current.generation !== generation || current.turnId !== normalizedTurnId) return;
        const stateBefore = this.conversations[String(body.threadId)] ?? null;
        if (stateBefore?.completedTurnIds[normalizedTurnId]) {
          cancelAcceptedTurnContentReconcileForKey(key, normalizedTurnId);
          return;
        }
        const pendingDispatchBeforeReload = this.threadPendingDispatchByThreadId[String(body.threadId)]?.turnId === normalizedTurnId;
        // 有真实 running/activity 时优先让 WS 增量继续渲染，避免回放造成闪烁；最后一次仍会强制检查历史。
        const hasLiveActivity = conversationHasTurnActivity(stateBefore, normalizedTurnId);
        const shouldReload = attempt === ACCEPTED_TURN_CONTENT_RECONCILE_DELAYS_MS.length - 1
          || !hasLiveActivity
          || !this.threadDisplayRunningStateForThread(body.threadId);
        if (shouldReload) {
          try {
            await this.loadThread(ctx, {
              workspaceId: body.workspaceId,
              threadId: body.threadId,
              limit: this.threadLoadMetaByThreadId[String(body.threadId)]?.limit,
              bumpContentEpoch: false,
            });
          } catch (error) {
            if (!isCancelledRequestError(error)) {
              console.warn("[chat.sendMessage] accepted turn content reconcile failed", {
                code: "CHAT_ACCEPTED_TURN_CONTENT_RECONCILE_FAILED",
                requestId: `chat-turn-reconcile-${normalizedTurnId}`,
                workspaceId: String(body.workspaceId),
                threadId: String(body.threadId),
                turnId: normalizedTurnId,
                attempt,
                rootCause: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
        const stateAfterReload = this.conversations[String(body.threadId)] ?? null;
        // Client 可能尚未把刚接受的 turn 写入事件表；回放空窗口时保留 pending dispatch，避免长启动阶段状态先闪退。
        if (pendingDispatchBeforeReload
          && !stateAfterReload?.completedTurnIds[normalizedTurnId]
          && !stateAfterReload?.runningTurnId
          && !conversationHasTurnActivity(stateAfterReload, normalizedTurnId)) {
          this.setThreadPendingDispatch(body.threadId, normalizedTurnId);
        }
        const stateAfter = this.conversations[String(body.threadId)] ?? null;
        if (stateAfter?.completedTurnIds[normalizedTurnId]) {
          cancelAcceptedTurnContentReconcileForKey(key, normalizedTurnId);
          return;
        }
        const nextAttempt = attempt + 1;
        if (nextAttempt >= ACCEPTED_TURN_CONTENT_RECONCILE_DELAYS_MS.length) {
          cancelAcceptedTurnContentReconcileForKey(key, normalizedTurnId);
          return;
        }
        const latest = acceptedTurnContentReconcileTasks.get(key);
        if (latest !== task) return;
        task.timer = scheduleAcceptedTurnTimer(() => { void reconcile(nextAttempt); }, ACCEPTED_TURN_CONTENT_RECONCILE_DELAYS_MS[nextAttempt]);
      };

      task.timer = scheduleAcceptedTurnTimer(() => { void reconcile(0); }, ACCEPTED_TURN_CONTENT_RECONCILE_DELAYS_MS[0]);
    },

    cancelAcceptedTurnContentReconcile(
      body: { workspaceId: WorkspaceId; threadId: ThreadId },
      turnId?: string,
    ): void {
      cancelAcceptedTurnContentReconcileForKey(
        acceptedTurnContentReconcileKey(body.workspaceId, body.threadId),
        turnId ? String(turnId) : undefined,
      );
    },

    syncPrimaryThreadUrl(
      threadId: ThreadId | null,
      opts?: { mode?: ThreadUrlUpdateMode; historyState?: unknown },
    ): void {
      updateThreadIdInUrl(threadId, opts);
    },

    selectPrimaryThread(
      thread: ThreadSummary | ThreadId | null,
      opts?: { route?: ThreadUrlUpdateMode | "ignore"; historyState?: unknown },
    ): void {
      const routeMode = opts?.route ?? "replace";
      if (!thread) {
        this.clearPrimaryThreadSelection({ clearUrl: routeMode !== "ignore" });
        return;
      }
      const summary = typeof thread === "string" ? null : thread;
      const threadId = typeof thread === "string" ? thread : thread.id;
      if (summary) this.upsertThreadSummary(summary);
      if (this.selectedThreadId === threadId) {
        this.threadSelectCounter += 1;
        this.ensureConversation(threadId);
      } else {
        this.selectThread(threadId);
      }
      if (routeMode !== "ignore") {
        this.syncPrimaryThreadUrl(threadId, {
          mode: routeMode,
          historyState: opts?.historyState,
        });
      }
    },

    clearPrimaryThreadSelection(opts?: { clearUrl?: boolean; reason?: AbortKind }): void {
      const previousThreadId = this.selectedThreadId;
      if (previousThreadId) {
        cancelAcceptedTurnContentReconcileForThread(previousThreadId);
        this.invalidateThreadScopes(previousThreadId, {
          reason: opts?.reason ?? "selection-change",
        });
      }
      this.selectedThreadId = null;
      if (opts?.clearUrl) {
        this.syncPrimaryThreadUrl(null, { mode: "replace" });
      }
    },

    /** 选择一个 thread。 */
    selectThread(threadId: ThreadId) {
      const previousThreadId = this.selectedThreadId;
      if (previousThreadId && String(previousThreadId) !== String(threadId)) {
        cancelAcceptedTurnContentReconcileForThread(previousThreadId);
        this.invalidateThreadScopes(previousThreadId, { reason: "selection-change" });
      }
      this.invalidateThreadScopes(threadId, { reason: "selection-change" });
      this.selectedThreadId = threadId;
      this.threadSelectCounter += 1;
      this.ensureConversation(threadId);
      if (String(previousThreadId ?? "") !== String(threadId)) {
        const summary = this.getThreadSummary(threadId);
        trackProductEvent("thread_open", {
          source: "thread_selection",
          thread_type: summary?.threadType ?? "chat",
          thread_subtype: summary?.threadSubtype ?? null,
          engine: summary?.engine ?? null,
        });
      }
    },

    /** 创建会话并继承最近模型配置；Fast 与 Spec 始终默认关闭。 */
    async createThread(ctx: ApiRequestContext, body: CreateThreadRequestBody): Promise<ThreadId> {
      const engines = useEngineStore();
      const engineKeys = useEngineKeysStore();
      const isSharedWorkspace = isSharedWorkspaceSelectionId(body.workspaceId);
      const localChat = isDesktopWorkspace(useConfigStore(), body.workspaceId)
        && (!body.threadType || body.threadType === "chat") && (!body.threadSubtype || body.threadSubtype === "requirement-analysis");
      // 从后端查询同引擎最近会话的偏好配置（刷新页面后也能继承）
      let sourcePrefs: ThreadPrefs | null = null;
      const shouldInheritPrefs = body.threadType !== "orchestration";
      if (shouldInheritPrefs && !isSharedWorkspace) {
        try {
          const prefsRes = await getLatestThreadPrefs(ctx, { workspaceId: body.workspaceId, engine: body.engine });
          if (localChat && !prefsRes.ok) throw createApiResultError(prefsRes);
          if (prefsRes.ok) sourcePrefs = prefsRes.prefs ?? null;
        } catch (error) {
          if (localChat) throw error;
          if (isCancelledRequestError(error)) throw error;
          message.warning(error instanceof Error
            ? `未能读取最近会话配置，已按默认配置创建：${error.message}`
            : "未能读取最近会话配置，已按默认配置创建");
        }
      }

      await engines.refresh(ctx, body.workspaceId);
      const scopedEngineState = engines.byWorkspaceId[String(body.workspaceId).trim()];
      if (scopedEngineState?.lastError) {
        trackProductEvent("thread_create", {
          status: "failed",
          source: "chat",
          thread_type: body.threadType ?? "chat",
          engine: body.engine,
          error_code_group: "engine_state_unavailable",
        });
        throw new Error(`无法读取引擎状态：${scopedEngineState.lastError}`);
      }
      const engineStatus = engines.byTypeForWorkspace(body.workspaceId).get(body.engine) ?? null;
      let keyRefreshError: string | null = null;
      if (!isSharedWorkspace) {
        try {
          await engineKeys.refresh(ctx, body.workspaceId);
        } catch (error) {
          if (localChat) throw error;
          if (isCancelledRequestError(error)) throw error;
          keyRefreshError = error instanceof Error ? error.message : String(error);
        }
      }
      const providerIds = isSharedWorkspace ? [] : engineKeys.providerIdsForEngine(body.engine);
      const unavailableIssue = resolveEngineUnavailableIssue(body.engine, engineStatus, {
        isSharedWorkspace,
        hasMaintainedKeys: !isSharedWorkspace && engineKeys.hasKeysForEngine(body.engine),
        activeProviderIds: providerIds,
        keyLoadError: keyRefreshError,
      });
      if (unavailableIssue) {
        trackProductEvent("thread_create", {
          status: "failed",
          source: "chat",
          thread_type: body.threadType ?? "chat",
          engine: body.engine,
          error_code_group: "engine_unavailable",
        });
        throw new Error(unavailableIssue);
      }
      const availableProviderIds = resolveAvailableModelProviderIds(body.engine, engineStatus, {
        isSharedWorkspace,
        hasMaintainedKeys: !isSharedWorkspace && engineKeys.hasKeysForEngine(body.engine),
        activeProviderIds: providerIds,
        keyLoadError: keyRefreshError,
      });
      if (keyRefreshError && availableProviderIds?.length) {
        message.warning(`无法读取大模型 Key 配置，已按 Host Client 引擎状态创建：${keyRefreshError}`);
      }
      const catalogModels = engineStatus?.models ?? [];
      if (catalogModels.length === 0) {
        throw new Error("模型目录尚未加载完成，请稍后重试");
      }
      const availableModels = availableProviderIds
        ? filterEngineModelsByProviderIds(catalogModels, availableProviderIds)
        : catalogModels;
      if (availableModels.length === 0) {
        throw new Error("当前可用 Key 供应商在模型目录中没有可选模型，请先调整 Key 或模型配置");
      }
      const sourceModel = String(sourcePrefs?.model ?? "").trim();
      const sourcePrefsForProvider = sourcePrefs && sourceModel && availableModels?.length
        && !availableModels.some((model) => model.id === sourceModel)
          ? { ...sourcePrefs, model: null, effort: null, contextWindow: null, serviceTier: null }
          : sourcePrefs;
      const initialPrefs: ThreadPrefs = {
        ...resolveThreadPrefsWithCatalogDefaults(body.engine, {
          ...sourcePrefsForProvider,
          serviceTier: null,
        }, availableModels),
        roleId: null,
        knowledgeEnabled: false,
      };
      const res = await runTrackedThreadRequest("thread_create", {
        source: "chat",
        thread_type: body.threadType ?? "chat",
        engine: body.engine,
      }, () => createThread(ctx, { ...body, initialPrefs }));
      if (!res.ok) {
        trackProductEvent("thread_create", {
          status: "failed",
          source: "chat",
          thread_type: body.threadType ?? "chat",
          engine: body.engine,
          error_code_group: "request_rejected",
        });
        throw new Error(res.message);
      }
      trackProductEvent("thread_create", {
        status: "success",
        source: "chat",
        thread_type: body.threadType ?? "chat",
        engine: body.engine,
      });
      await this.refreshThreads(ctx, body.workspaceId);

      this.setThreadPrefs(res.threadId, initialPrefs);
      return res.threadId;
    },

    /** 获取当前分类第一页；分类切换可复用成功分页，显式刷新使旧分类缓存失效。 */
    async refreshThreads(ctx: ApiRequestContext, workspaceId: WorkspaceId, opts?: ThreadListQueryOptions): Promise<void> {
      const key = String(workspaceId);
      const previousSearch = this.threadListSearch;
      const search = normalizeThreadListSearch(opts?.search ?? this.threadListSearch);
      const sort = resolveThreadListSort(opts?.sort);
      const threadListScope = resolveThreadListScope();
      const previousGroupId = resolveEffectiveThreadGroupId(threadListScope, this.activeThreadGroupId);
      const groupId = resolveEffectiveThreadGroupId(threadListScope, hasThreadGroupOption(opts) ? opts?.groupId : this.activeThreadGroupId);
      const onlyRelatedToMe = resolveThreadListOnlyRelatedToMe(workspaceId, opts?.onlyRelatedToMe ?? this.threadListOnlyRelatedToMe);
      this.threadListSearch = search;
      if (threadListScope === "current") this.activeThreadGroupId = groupId;
      if (onlyRelatedToMe != null) this.threadListOnlyRelatedToMe = onlyRelatedToMe;
      if (search !== previousSearch || groupId !== previousGroupId) {
        this.threadsHasMore = false;
        this.threadsNextCursor = null;
        this.threadsLoadingMore = false;
      }
      const scope = captureWorkspaceReadScope(workspaceId, threadListScope, search, sort, groupId, onlyRelatedToMe);
      const cacheKey = serializeThreadListCacheKey(ctx, scope);
      if (this.activeThreadListCacheKey !== cacheKey || !opts?.preferCache) {
        abortRead("threads-load-more", key, "scope-change");
        this.threadsLoadingMore = false;
      }
      this.activeThreadListCacheKey = cacheKey;
      if (!opts?.preferCache && Object.keys(this.threadListCache).length) this.threadListCache = {};
      try {
        await runScopedRead<void>("threads-refresh", key, cacheKey, async (signal) => {
          const cache = this.threadListCache;
          if (opts?.preferCache && cache[cacheKey]) {
            applyThreadListSnapshot(this, cache[cacheKey]);
            return;
          }
          const res = await listThreads(ctx, workspaceId, { scope: scope.threadListScope, sort: scope.threadListSort, search, groupId, onlyRelatedToMe, limit: THREADS_PAGE_LIMIT }, { signal });
          if (!res.ok) throw new Error(res.message);
          if (signal.aborted) throw createCancelledRequestError("scope-change");
          assertWorkspaceReadScope(scope, cacheKey);
          const locallyDeleted = localDeleteRefreshThreadIdsByWorkspaceId.get(key) ?? null;
          const nextThreads = locallyDeleted?.size
            ? res.threads.filter((thread) => !locallyDeleted.has(String(thread.id)))
            : res.threads;
          applyThreadListSnapshot(this, { threads: nextThreads, hasMore: Boolean(res.hasMore), nextCursor: res.nextCursor ?? null });
          for (const t of nextThreads) {
            const running = res.runningByThreadId?.[String(t.id)] ?? null;
            this.setThreadRunningHint(t.id, running, { source: "list" });
            this.setThreadWorkflowState(t.id, res.workflowByThreadId?.[String(t.id)] ?? null);
          }
          if (this.threadListCache === cache) cacheThreadListSnapshot(this, cacheKey);
        });
      } catch (error) {
        if (isCancelledRequestError(error)) return;
        throw error;
      }
    },

    /** 服务端翻页：按当前标题搜索加载下一页 threads（append 模式，按 ID 去重）。 */
    async loadMoreThreads(ctx: ApiRequestContext, workspaceId: WorkspaceId, opts?: ThreadListQueryOptions): Promise<void> {
      if (!this.threadsHasMore || this.threadsLoadingMore || !this.threadsNextCursor) return;
      const key = String(workspaceId);
      const cursor = this.threadsNextCursor;
      const search = normalizeThreadListSearch(opts?.search ?? this.threadListSearch);
      const sort = resolveThreadListSort(opts?.sort);
      const threadListScope = resolveThreadListScope();
      const groupId = resolveEffectiveThreadGroupId(threadListScope, hasThreadGroupOption(opts) ? opts?.groupId : this.activeThreadGroupId);
      const onlyRelatedToMe = resolveThreadListOnlyRelatedToMe(workspaceId, opts?.onlyRelatedToMe ?? this.threadListOnlyRelatedToMe);
      if (search !== this.threadListSearch) return;
      if (groupId !== resolveEffectiveThreadGroupId(threadListScope, this.activeThreadGroupId)) return;
      if (onlyRelatedToMe != null && onlyRelatedToMe !== this.threadListOnlyRelatedToMe) return;
      const scope = captureWorkspaceReadScope(workspaceId, threadListScope, search, sort, groupId, onlyRelatedToMe);
      const cacheKey = serializeThreadListCacheKey(ctx, scope);
      if (this.activeThreadListCacheKey != null && this.activeThreadListCacheKey !== cacheKey) return;
      this.activeThreadListCacheKey = cacheKey;
      const cache = this.threadListCache;
      this.threadsLoadingMore = true;
      try {
        await runScopedRead<void>("threads-load-more", key, `${cacheKey}::${String(cursor)}`, async (signal) => {
          const res = await listThreads(ctx, workspaceId, { scope: scope.threadListScope, sort: scope.threadListSort, search, groupId, onlyRelatedToMe, limit: THREADS_PAGE_LIMIT, cursor }, { signal });
          if (!res.ok) throw new Error(res.message);
          if (signal.aborted) throw createCancelledRequestError("scope-change");
          assertWorkspaceReadScope(scope, cacheKey);
          // 按 ID 去重后 append
          const existingIds = new Set(this.threads.map((t) => String(t.id)));
          const newThreads = res.threads.filter((t) => !existingIds.has(String(t.id)));
          this.threads = [...this.threads, ...newThreads];
          this.threadsHasMore = Boolean(res.hasMore);
          this.threadsNextCursor = res.nextCursor ?? null;
          for (const t of newThreads) {
            const running = res.runningByThreadId?.[String(t.id)] ?? null;
            this.setThreadRunningHint(t.id, running, { source: "list" });
            this.setThreadWorkflowState(t.id, res.workflowByThreadId?.[String(t.id)] ?? null);
          }
          if (this.threadListCache === cache) cacheThreadListSnapshot(this, cacheKey);
        });
      } catch (error) {
        if (!isCancelledRequestError(error)) throw error;
      } finally {
        if (this.activeThreadListCacheKey === cacheKey && !inFlightReadByKey.has(`threads-load-more:${key}`)) {
          this.threadsLoadingMore = false;
        }
      }
    },

    /** 重命名 thread。 */
    async renameThread(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId; title: string }): Promise<void> {
      const res = await runTrackedThreadRequest("thread_rename", { source: "thread_action" }, () => (
        apiRenameThread(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, title: body.title })
      ));
      if (!res.ok) {
        trackProductEvent("thread_rename", { status: "failed", source: "thread_action", error_code_group: "request_rejected" });
        throw new Error(res.message);
      }
      const existing = this.getThreadSummary(body.threadId);
      if (existing) {
        this.upsertThreadSummary({
          ...existing,
          title: body.title,
          updatedAt: Date.now(),
        });
      }
      trackProductEvent("thread_rename", { status: "success", source: "thread_action" });
    },

    /** 归档/取消归档 thread。 */
    async setThreadArchived(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId; archived: boolean }): Promise<void> {
      const action = body.archived ? "archive" : "unarchive";
      const res = await runTrackedThreadRequest("thread_archive", { source: "thread_action", action }, () => (
        apiArchiveThread(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, archived: body.archived })
      ));
      if (!res.ok) {
        trackProductEvent("thread_archive", { status: "failed", source: "thread_action", action, error_code_group: "request_rejected" });
        throw new Error(res.message);
      }
      const existing = this.getThreadSummary(body.threadId);
      if (existing) {
        this.upsertThreadSummary({
          ...existing,
          archived: body.archived,
          updatedAt: Date.now(),
        });
      }
      trackProductEvent("thread_archive", { status: "success", source: "thread_action", action });
    },

    /** 置顶/取消置顶 thread。 */
    async setThreadPinned(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId; pinned: boolean }): Promise<void> {
      const action = body.pinned ? "pin" : "unpin";
      const res = await runTrackedThreadRequest("thread_pin", { source: "thread_action", action }, () => (
        apiPinThread(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, pinned: body.pinned })
      ));
      if (!res.ok) {
        trackProductEvent("thread_pin", { status: "failed", source: "thread_action", action, error_code_group: "request_rejected" });
        throw new Error(res.message);
      }
      trackProductEvent("thread_pin", { status: "success", source: "thread_action", action });
      const existing = this.getThreadSummary(body.threadId);
      if (existing) {
        this.upsertThreadSummary({
          ...existing,
          pinnedAt: res.pinnedAt ?? null,
        });
      }
      await this.refreshThreads(ctx, body.workspaceId);
    },

    /** 清空 thread 历史（engine_events）；默认重置 sessionId。 */
    async clearThread(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId; resetSession?: boolean }): Promise<void> {
      this.invalidateThreadScopes(body.threadId, { reason: "clear" });
      this.invalidateThreadManagedServices(body.threadId, "clear");
      const key = String(body.threadId);
      const res = await runTrackedThreadRequest("thread_clear", { source: "thread_action" }, () => (
        apiClearThread(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, resetSession: body.resetSession })
      ));
      if (!res.ok) {
        trackProductEvent("thread_clear", { status: "failed", source: "thread_action", error_code_group: "request_rejected" });
        throw new Error(res.message);
      }
      trackProductEvent("thread_clear", { status: "success", source: "thread_action" });
      resetThreadProjectionForClear(this, body.threadId);
      this.fileChangesByThreadId[key] = createEmptyFileChangesResourceState();
      // clear 的真实收敛点是当前 thread 本身，而不是整个 workspace。
      // 只有当前可见 thread 需要立刻 reload；后台 thread 交给 cleared WS 事件重置缓存，
      // 避免一次 clear 又拖出整套 workspace hydration。
      if (String(this.selectedThreadId ?? "") === key) {
        await this.loadThread(ctx, { workspaceId: body.workspaceId, threadId: body.threadId });
      }
    },

    /** 终止旧 Codex 进程，并刷新当前 thread 的运行态附属资源。 */
    async restartCodexAppServer(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId }): Promise<string> {
      const res = await apiRestartCodexAppServer(ctx, { workspaceId: body.workspaceId, threadId: body.threadId });
      if (!res.ok) throw new Error(res.message);
      this.invalidateThreadManagedServices(body.threadId, "thread-invalidated");
      this.clearThreadRunningHint(body.threadId);
      return res.message || "Codex app-server 运行态已重置；下一次请求会启动新进程。";
    },

    /** 删除 thread（含事件）；并清理本地会话状态。 */
    async deleteThread(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId }): Promise<void> {
      const res = await runTrackedThreadRequest("thread_delete", { source: "thread_action" }, () => (
        apiDeleteThread(ctx, { workspaceId: body.workspaceId, threadId: body.threadId })
      ));
      if (!res.ok) {
        trackProductEvent("thread_delete", { status: "failed", source: "thread_action", error_code_group: "request_rejected" });
        throw new Error(res.message);
      }
      trackProductEvent("thread_delete", { status: "success", source: "thread_action" });
      const finishDeleteRefresh = beginLocalDeleteRefresh(body.workspaceId, [body.threadId]);
      try {
        invalidateWorkspaceThreadListReads(body.workspaceId, "delete");
        this.threadsLoadingMore = false;
        dropDeletedThreadState(this, body.threadId);
        await this.refreshThreads(ctx, body.workspaceId);
      } finally {
        finishDeleteRefresh();
      }
    },

    /** 写入远端或历史 prefs，并保留尚未确认的本地补丁。 */
    setThreadPrefs(
      threadId: ThreadId,
      prefs: ThreadPrefs,
      opts?: {
        readMutationEpoch?: number;
        readBasePrefs?: ThreadPrefs;
        readPendingPrefs?: ThreadPrefs;
        updateBase?: boolean;
      },
    ): void {
      const key = String(threadId);
      const currentMutationEpoch = getThreadPrefsMutationEpoch(key);
      const remotePrefs = copyDefinedThreadPrefs(prefs);
      const currentPrefs = this.threadPrefsByThreadId[key] ?? {};
      const readPendingPrefs = copyDefinedThreadPrefs(opts?.readPendingPrefs);
      const shouldProtectReadPending = hasThreadPrefsFields(readPendingPrefs);
      const effectiveRemotePrefs = opts?.readMutationEpoch != null
        && (opts.readMutationEpoch !== currentMutationEpoch || shouldProtectReadPending)
        ? mergeStaleThreadPrefsSnapshot(currentPrefs, remotePrefs, opts.readBasePrefs, readPendingPrefs)
        : remotePrefs;
      if (opts?.readMutationEpoch != null && opts.readMutationEpoch !== currentMutationEpoch && !opts.readBasePrefs) return;
      const pendingPrefs = this.pendingThreadPrefsByThreadId[key] ?? {};
      this.threadPrefsByThreadId[key] = mergeThreadPrefs(effectiveRemotePrefs, pendingPrefs);
      if (opts?.updateBase) {
        this.threadBasePrefsByThreadId[key] = mergeThreadPrefs(
          this.threadBasePrefsByThreadId[key] ?? {},
          mergeThreadPrefs(effectiveRemotePrefs, pendingPrefs),
        );
      }
      bumpThreadPrefsMutationEpoch(key);
    },

    /** 合并本地偏好补丁，并记录 scope 与冻结身份供后续重试。 */
    patchThreadPrefs(
      threadId: ThreadId,
      patch: ThreadPrefs,
      workspaceId?: WorkspaceId,
      opts?: { apiContext?: ApiRequestContext },
    ): void {
      const key = String(threadId);
      const definedPatch = copyDefinedThreadPrefs(patch);
      if (!hasThreadPrefsFields(definedPatch)) return;
      const current = this.threadPrefsByThreadId[key] ?? {};
      const pending = this.pendingThreadPrefsByThreadId[key] ?? {};
      this.pendingThreadPrefsByThreadId[key] = mergeThreadPrefs(pending, definedPatch);
      const revision = (threadPrefsPendingRevisionByThreadId.get(key) ?? 0) + 1;
      threadPrefsPendingRevisionByThreadId.set(key, revision);
      const previousMeta = threadPrefsPendingMetaByThreadId.get(key);
      threadPrefsPendingMetaByThreadId.set(key, {
        generation: chatReadGeneration,
        workspaceId: workspaceId == null ? previousMeta?.workspaceId ?? null : String(workspaceId),
        writeEpoch: getThreadPrefsWriteEpoch(key),
        revision,
        requestContext: opts?.apiContext
          ? freezeThreadPrefsMutationApiContext(opts.apiContext)
          : previousMeta?.requestContext ?? null,
      });
      this.threadBasePrefsByThreadId[key] = mergeThreadPrefs(
        this.threadBasePrefsByThreadId[key] ?? {},
        definedPatch,
      );
      this.setThreadPrefs(threadId, mergeThreadPrefs(current, definedPatch));
    },

    /** 在 workspace 切换或重连前排空当前 generation 的全部待保存 prefs。 */
    flushPendingThreadPrefs(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      opts?: { workspaceScopeToken?: number },
    ): Promise<void> | null {
      const generation = opts?.workspaceScopeToken ?? chatReadGeneration;
      if (generation !== chatReadGeneration) return null;
      if (!listPendingThreadPrefsForWorkspace(this, workspaceId, generation).length) return null;
      const drain = async (): Promise<void> => {
        while (generation === chatReadGeneration) {
          const threadIds = listPendingThreadPrefsForWorkspace(this, workspaceId, generation);
          if (!threadIds.length) return;
          await Promise.all(threadIds.map((threadId) => this.saveThreadPrefs(
            ctx,
            workspaceId,
            threadId,
            { workspaceScopeToken: generation },
          )));
        }
      };
      return drain();
    },

    /** 接收远端草稿版本信号；记录来源并在版本变化时丢弃本地草稿正文缓存。 */
    setThreadDraftVersion(threadId: ThreadId, version: number | null, updatedByWebSessionId?: string | null): void {
      const key = String(threadId);
      const cached = Object.prototype.hasOwnProperty.call(this.threadDraftByThreadId, key)
        ? this.threadDraftByThreadId[key]
        : undefined;
      threadDraftVersionSignalByThreadId.set(key, {
        epoch: ++nextThreadDraftVersionSignalEpoch,
        version,
        updatedByWebSessionId: String(updatedByWebSessionId ?? "").trim() || null,
      });
      this.threadDraftVersionByThreadId[key] = version;
      if ((cached?.version ?? null) !== version) delete this.threadDraftByThreadId[key];
    },

    /** 写入已确认的草稿内容；null 表示远端已确认无草稿。 */
    setThreadDraft(threadId: ThreadId, draft: ThreadDraft | null): void {
      const key = String(threadId);
      this.threadDraftByThreadId[key] = draft;
      this.threadDraftVersionByThreadId[key] = draft?.version ?? null;
    },

    /** 捕获当前 workspace 草稿代际；reset 后旧组件不得继续读写草稿缓存。 */
    captureThreadDraftWorkspaceScopeToken(): number {
      return chatReadGeneration;
    },

    /** 判断草稿代际是否仍属于当前 workspace。 */
    isThreadDraftWorkspaceScopeCurrent(workspaceScopeToken: number): boolean {
      return workspaceScopeToken === chatReadGeneration;
    },

    /** 缓存尚未远端确认的本地草稿；相同内容复用 epoch，不改写服务端版本事实。 */
    setPendingLocalThreadDraft(
      threadId: ThreadId,
      draft: ThreadDraftPayload,
      opts?: { workspaceScopeToken?: number },
    ): number | null {
      if (!isThreadDraftWorkspaceScopeCurrent(opts?.workspaceScopeToken)) return null;
      const key = String(threadId);
      const currentEpoch = this.pendingLocalThreadDraftEpochByThreadId[key] ?? 0;
      const currentDraft = this.pendingLocalThreadDraftByThreadId[key];
      if (currentEpoch > 0 && currentDraft && sameThreadDraftPayloadContent(currentDraft, draft)) return currentEpoch;
      const epoch = ++nextPendingLocalThreadDraftEpoch;
      this.pendingLocalThreadDraftEpochByThreadId[key] = epoch;
      this.pendingLocalThreadDraftByThreadId[key] = {
        text: draft.text,
        ...(draft.inputKind ? { inputKind: draft.inputKind } : {}),
        ...(draft.skillMentions?.length
          ? { skillMentions: draft.skillMentions.map((binding) => ({ ...binding })) }
          : {}),
        images: draft.images.map((item) => ({ ...item })),
        files: draft.files.map((item) => ({ ...item })),
        pathReferences: draft.pathReferences?.map((item) => ({ ...item })),
      };
      return epoch;
    },

    /** 清除已确认草稿；提供 epoch 时只允许清理同一版 pending。 */
    clearPendingLocalThreadDraft(
      threadId: ThreadId,
      expectedEpoch?: number,
      opts?: { workspaceScopeToken?: number },
    ): boolean {
      if (!isThreadDraftWorkspaceScopeCurrent(opts?.workspaceScopeToken)) return false;
      const key = String(threadId);
      if (expectedEpoch != null && this.pendingLocalThreadDraftEpochByThreadId[key] !== expectedEpoch) return false;
      const existed = Object.prototype.hasOwnProperty.call(this.pendingLocalThreadDraftByThreadId, key);
      delete this.pendingLocalThreadDraftByThreadId[key];
      return existed;
    },

    /** 串行持久化当前 thread 的待确认偏好补丁。 */
    async saveThreadPrefs(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      threadId: ThreadId,
      opts?: { workspaceScopeToken?: number },
    ): Promise<void> {
      const saveGeneration = opts?.workspaceScopeToken ?? chatReadGeneration;
      const saveWriteEpoch = getThreadPrefsWriteEpoch(String(threadId));
      const fallbackRequestCtx = freezeThreadPrefsMutationApiContext(ctx);
      try {
        await runThreadPrefsSave(workspaceId, threadId, async () => {
          if (saveGeneration !== chatReadGeneration) return;
          const key = String(threadId);
          if (saveWriteEpoch !== getThreadPrefsWriteEpoch(key)) return;
          const pendingMeta = threadPrefsPendingMetaByThreadId.get(key);
          if (pendingMeta?.generation !== saveGeneration) return;
          if (pendingMeta?.workspaceId && pendingMeta.workspaceId !== String(workspaceId)) return;
          const prefs = copyDefinedThreadPrefs(this.pendingThreadPrefsByThreadId[key]);
          if (!hasThreadPrefsFields(prefs)) return;
          const requestCtx = pendingMeta?.requestContext ?? fallbackRequestCtx;
          const saveRevision = pendingMeta?.revision ?? null;
          const isSaveStale = (): boolean => (
            saveGeneration !== chatReadGeneration
            || saveWriteEpoch !== getThreadPrefsWriteEpoch(key)
            || (saveRevision != null && threadPrefsPendingMetaByThreadId.get(key)?.revision !== saveRevision)
          );
          let res: Awaited<ReturnType<typeof updateThreadPrefs>>;
          try {
            res = await updateThreadPrefs(requestCtx, { workspaceId, threadId, prefs });
          } catch (error) {
            if (isSaveStale()) {
              logStaleThreadPrefsSaveFailure({ workspaceId, threadId, saveRevision, source: error });
              return;
            }
            throw error;
          }
          if (!res.ok) {
            if (isSaveStale()) {
              logStaleThreadPrefsSaveFailure({ workspaceId, threadId, saveRevision, source: res, code: res.code });
              return;
            }
            if (isMissingThreadPrefsFailure(res)) {
              logStaleThreadPrefsSaveFailure({ workspaceId, threadId, saveRevision, source: res, code: "THREAD_NOT_FOUND" });
              dropDeletedThreadState(this, threadId);
              return;
            }
            throw createApiResultError(res);
          }
          if (isSaveStale()) return;
          if (res.permissionModeWarning) message.warning(res.permissionModeWarning);
          clearAcknowledgedThreadPrefsPatch(this, threadId, prefs);
          bumpThreadPrefsMutationEpoch(key);
          trackProductEvent("thread_preferences_save", {
            status: "success",
            source: "thread_preferences",
          });
        });
      } catch (error) {
        logThreadPrefsSaveFailure({ workspaceId, threadId, source: error });
        if (!isCancelledRequestError(error)) {
          trackProductEvent("thread_preferences_save", {
            status: "failed",
            source: "thread_preferences",
            error_code_group: "request_error",
          });
        }
        throw error;
      }
    },

    /** 从 DB 刷新 thread 的会话级偏好，不重放历史。 */
    async refreshThreadPrefs(ctx: ApiRequestContext, workspaceId: WorkspaceId, threadId: ThreadId): Promise<void> {
      const key = String(threadId);
      const scope = captureThreadReadScope(workspaceId, threadId);
      const prefsMutationEpoch = getThreadPrefsMutationEpoch(key);
      const prefsReadBase = copyDefinedThreadPrefs(this.threadPrefsByThreadId[key]);
      const prefsReadPending = copyDefinedThreadPrefs(this.pendingThreadPrefsByThreadId[key]);
      try {
        await runScopedRead<void>("thread-prefs", key, serializeThreadReadScope(scope), async (signal) => {
          const res = await getThreadPrefs(ctx, { workspaceId, threadId }, { signal });
          if (!res.ok) throw new Error(res.message);
          assertThreadReadScope(scope);
          this.setThreadPrefs(threadId, res.prefs ?? {}, {
            readMutationEpoch: prefsMutationEpoch,
            readBasePrefs: prefsReadBase,
            readPendingPrefs: prefsReadPending,
            updateBase: true,
          });
        });
      } catch (error) {
        if (isCancelledRequestError(error)) return;
        throw error;
      }
    },

    async getThreadDraft(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      threadId: ThreadId,
      opts?: { force?: boolean },
    ): Promise<GetThreadDraftResponseBody["draft"]> {
      const summary = this.getThreadSummary(threadId);
      // 只读共享会话不能输入，也不应触发共享草稿读写链路。
      if (isSharedWorkspaceSelectionId(workspaceId) && (summary?.readOnly || summary?.sharedContext?.readOnly)) {
        this.setThreadDraft(threadId, null);
        return null;
      }
      const key = String(threadId);
      if (!opts?.force && Object.prototype.hasOwnProperty.call(this.threadDraftByThreadId, key)) {
        return this.threadDraftByThreadId[key] ?? null;
      }
      const scope = captureThreadReadScope(workspaceId, threadId);
      return await runScopedRead<GetThreadDraftResponseBody["draft"]>(
        "thread-draft",
        key,
        `${serializeThreadReadScope(scope)}::${opts?.force ? "force" : "normal"}`,
        async (signal) => {
          const res = await apiGetThreadDraft(ctx, { workspaceId, threadId }, { signal });
          if (!res.ok) throw new Error(res.message);
          assertThreadReadScope(scope);
          this.setThreadDraft(threadId, res.draft ?? null);
          return res.draft ?? null;
        },
      );
    },

    /** 串行保存草稿；迟到响应只允许更新发起时对应的 pending epoch。 */
    async saveThreadDraft(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      threadId: ThreadId,
      draft: ThreadDraftPayload,
      opts?: {
        pendingEpoch?: number;
        workspaceScopeToken?: number;
        allowStaleWorkspaceRemoteMutation?: boolean;
      },
    ): Promise<{ version: number; updatedAt: number; updatedByWebSessionId: string | null }> {
      const workspaceScopeCurrent = isThreadDraftWorkspaceScopeCurrent(opts?.workspaceScopeToken);
      if (!workspaceScopeCurrent && !opts?.allowStaleWorkspaceRemoteMutation) {
        assertThreadDraftWorkspaceScope(opts?.workspaceScopeToken);
      }
      const key = String(threadId);
      const expectedPendingEpoch = workspaceScopeCurrent ? (opts?.pendingEpoch ?? (
        Object.prototype.hasOwnProperty.call(this.pendingLocalThreadDraftByThreadId, key)
          ? this.pendingLocalThreadDraftEpochByThreadId[key] ?? null
          : null
      )) : null;
      const requestCtx = freezeThreadDraftMutationApiContext(ctx);
      try {
        return await runThreadDraftMutation(workspaceId, threadId, async (scope, applyLocalProjection) => {
          const signalEpoch = applyLocalProjection
            ? threadDraftVersionSignalByThreadId.get(key)?.epoch ?? 0
            : 0;
          const res = await apiSaveThreadDraft(requestCtx, { workspaceId, threadId, draft });
          if (!res.ok) throw new Error(res.message);
          const result = {
            version: res.version,
            updatedAt: res.updatedAt,
            updatedByWebSessionId: res.updatedByWebSessionId ?? null,
          };
          if (!applyLocalProjection) return result;
          assertThreadReadScope(scope);
          const responseIsCurrent = expectedPendingEpoch == null
            ? !Object.prototype.hasOwnProperty.call(this.pendingLocalThreadDraftByThreadId, key)
            : this.pendingLocalThreadDraftEpochByThreadId[key] === expectedPendingEpoch;
          if (responseIsCurrent) {
            if (canApplyThreadDraftMutationResponse({
              threadId,
              signalEpoch,
              version: res.version,
              updatedByWebSessionId: res.updatedByWebSessionId ?? requestCtx.webSessionId,
            })) {
              this.setThreadDraft(threadId, {
                ...draft,
                version: res.version,
                updatedAt: res.updatedAt,
                updatedByWebSessionId: res.updatedByWebSessionId ?? null,
              });
            }
            this.clearPendingLocalThreadDraft(threadId, expectedPendingEpoch ?? undefined);
          }
          return result;
        }, opts?.workspaceScopeToken, {
          allowStaleWorkspaceRemoteMutation: opts?.allowStaleWorkspaceRemoteMutation,
        });
      } catch (error) {
        if (!isCancelledRequestError(error)) {
          trackProductEvent("thread_draft_save_failed", {
            source: "thread_draft",
            error_code_group: "request_error",
          });
        }
        throw error;
      }
    },

    /** 串行清除草稿；迟到响应不得清空更新 epoch 的本地草稿。 */
    async clearThreadDraft(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      threadId: ThreadId,
      opts?: {
        pendingEpoch?: number;
        workspaceScopeToken?: number;
        allowStaleWorkspaceRemoteMutation?: boolean;
      },
    ): Promise<void> {
      const workspaceScopeCurrent = isThreadDraftWorkspaceScopeCurrent(opts?.workspaceScopeToken);
      if (!workspaceScopeCurrent && !opts?.allowStaleWorkspaceRemoteMutation) {
        assertThreadDraftWorkspaceScope(opts?.workspaceScopeToken);
      }
      const key = String(threadId);
      const expectedPendingEpoch = workspaceScopeCurrent ? (opts?.pendingEpoch ?? (
        Object.prototype.hasOwnProperty.call(this.pendingLocalThreadDraftByThreadId, key)
          ? this.pendingLocalThreadDraftEpochByThreadId[key] ?? null
          : null
      )) : null;
      const requestCtx = freezeThreadDraftMutationApiContext(ctx);
      await runThreadDraftMutation(workspaceId, threadId, async (scope, applyLocalProjection) => {
        const signalEpoch = applyLocalProjection
          ? threadDraftVersionSignalByThreadId.get(key)?.epoch ?? 0
          : 0;
        const res = await apiClearThreadDraft(requestCtx, { workspaceId, threadId });
        if (!res.ok) throw new Error(res.message);
        if (!applyLocalProjection) return;
        assertThreadReadScope(scope);
        const responseIsCurrent = expectedPendingEpoch == null
          ? !Object.prototype.hasOwnProperty.call(this.pendingLocalThreadDraftByThreadId, key)
          : this.pendingLocalThreadDraftEpochByThreadId[key] === expectedPendingEpoch;
        if (!responseIsCurrent) return;
        if (canApplyThreadDraftMutationResponse({
          threadId,
          signalEpoch,
          version: null,
          updatedByWebSessionId: requestCtx.webSessionId,
        })) {
          this.setThreadDraft(threadId, null);
        }
        this.clearPendingLocalThreadDraft(threadId, expectedPendingEpoch ?? undefined);
      }, opts?.workspaceScopeToken, {
        allowStaleWorkspaceRemoteMutation: opts?.allowStaleWorkspaceRemoteMutation,
      });
    },

    /**
     * 确保 thread 已具备可用 UI 状态：
     * - 首次打开/强制刷新直接走 loadThread，由 load 响应携带 prefs，避免重复读
     * - 已加载 thread 重新打开时只刷新 prefs，避免入口层吃旧缓存
     */
    async ensureThreadHydrated(
      ctx: ApiRequestContext,
      body: { workspaceId: WorkspaceId; threadId: ThreadId; limit?: number | null; forceReload?: boolean },
    ): Promise<void> {
      const key = String(body.threadId);
      const scope = captureThreadReadScope(body.workspaceId, body.threadId);
      try {
        await runScopedRead<void>("thread-hydrate", key, serializeThreadHistoryScope(scope), async () => {
          const shouldReloadHistory = Boolean(body.forceReload || !this.loadedThreads[key]);
          if (shouldReloadHistory) {
            await this.loadThread(ctx, {
              workspaceId: body.workspaceId,
              threadId: body.threadId,
              ...(body.limit != null ? { limit: body.limit } : {}),
            });
            return;
          }

          let prefsError: unknown = null;
          try {
            await this.refreshThreadPrefs(ctx, body.workspaceId, body.threadId);
          } catch (error) {
            prefsError = error;
          }

          if (prefsError && isThreadReadScopeCurrent(scope, { history: true })) {
            await this.loadThread(ctx, {
              workspaceId: body.workspaceId,
              threadId: body.threadId,
              ...(body.limit != null ? { limit: body.limit } : {}),
            });
          } else if (prefsError) {
            throw prefsError;
          }
        });
      } catch (error) {
        if (isCancelledRequestError(error)) return;
        throw error;
      }
    },

    /** 发送消息并分流工作流指令；请求标识兼容非安全上下文，写权仍由 Server 校验。 */
    async sendMessage(
      ctx: ApiRequestContext,
      body: SendMessageRequestBody,
    ): Promise<string | null> {
      const threadKey = String(body.threadId);
      const workflowThread = this.getThreadSummary(body.threadId);
      const workflowSnapshot = this.chatWorkflowSnapshotByThreadId[threadKey];
      const composerIntentText = body.text.trim().replace(/[。！!]+$/u, "");
      const explicitWorkflowIntent = CHAT_WORKFLOW_EXPLICIT_PREFIX_PATTERN.test(composerIntentText);
      const workflowIntent = explicitWorkflowIntent || CHAT_WORKFLOW_BARE_INTENT_PATTERN.test(composerIntentText);
      const hasSingleInputTodo = workflowSnapshot?.tasks
        .flatMap(view => view.todos.filter(todo => todo.actions.some(action => action.action === "resume_with_input")))
        .length === 1;
      const pendingApprovalTodos = workflowSnapshot?.tasks
        .filter(view => view.status && CHAT_WORKFLOW_ACTIVE_STATUSES.has(view.status))
        .flatMap(view => view.todos.filter(todo => todo.actions.some(a => a.action === "approve"))) ?? [];
      if (workflowThread?.threadType === "chat" && !workflowThread.threadSubtype && !body.images?.length && !body.files?.length && !body.pathReferences?.length
        && (hasSingleInputTodo || workflowIntent)) {
        const workflowResult = await respondToChatWorkflow(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, text: body.text, requestId: createBrowserUuid() });
        if (!workflowResult.ok) throw createApiResultError(workflowResult);
        if (workflowResult.handled) {
          if (workflowResult.view && workflowSnapshot) {
            this.setChatWorkflowSnapshot(body.threadId, {
              ...workflowSnapshot,
              tasks: workflowSnapshot.tasks.map(view => view.task.id === workflowResult.view?.task.id ? workflowResult.view : view),
            });
          }
          message.success(workflowResult.action === "feedback" ? "审核意见已提交到工作流待办" : "工作流操作已提交");
          return null;
        }
        if (hasSingleInputTodo || explicitWorkflowIntent) {
          // 抛错而非返回 null：composer 把 null 视为发送成功会清空输入框，正文既不发送也不保留。
          throw new Error("这条消息未提交到工作流待办，请刷新后重试");
        }
      }
      if (workflowThread?.threadType === "chat" && !workflowThread.threadSubtype && !body.images?.length && !body.files?.length && !body.pathReferences?.length && pendingApprovalTodos.length) {
        // 有节点等审核时不让自由文本流入 AI 对话：与编排侧 waiting-approval 禁用输入框同口径。
        throw new Error(pendingApprovalTodos.length === 1
          ? "当前节点等待审核，这条消息未发送：请发送「审核通过：审核意见」，或点卡片「提出修改」打回重跑"
          : "当前有多个待审核待办，这条消息未发送：请在卡片上分别处理");
      }
      const authoritativeUserMessageItemIdsBeforeSend = collectAuthoritativeUserMessageItemIds(this.conversations[threadKey]);
      let res: Awaited<ReturnType<typeof sendMessage>>;
      try {
        res = await sendMessage(ctx, body);
      } catch (error) {
        if (!isCancelledRequestError(error)) {
          trackProductEvent("chat_send_failed", {
            source: "chat_composer",
            error_code_group: "request_error",
          });
        }
        throw error;
      }
      const rollbackRefresh = await this.reconcileMutationRollbackResponse(
        ctx,
        body,
        readMutationRollbackMetadata(res),
      );
      if (!res.ok) {
        trackProductEvent("chat_send_failed", {
          source: "chat_composer",
          error_code_group: "request_rejected",
        });
        let runningSyncError: unknown = null;
        if (isActiveTurnConflictMessage(res.message)) {
          try {
            await this.syncThreadSummaryState(ctx, {
              workspaceId: body.workspaceId,
              threadId: body.threadId,
              waitForRunning: true,
              attempts: ACTIVE_TURN_CONFLICT_RUNNING_SYNC_ATTEMPTS,
              intervalMs: ACTIVE_TURN_CONFLICT_RUNNING_SYNC_INTERVAL_MS,
            });
          } catch (syncError) {
            runningSyncError = syncError;
          }
        }
        if (rollbackRefresh.rollbackReconciled) {
          const failure = buildRejectedMutationAfterRollbackFailure(
            "消息发送",
            res.message,
            rollbackRefresh,
            runningSyncError,
          );
          appendLocalSystemNotice(
            this.ensureConversation(body.threadId),
            body.workspaceId,
            body.threadId,
            this.getThreadSummary(body.threadId)?.engine ?? "codex",
            failure.message,
          );
          throw failure;
        }
        if (runningSyncError) {
          throw new Error(`${res.message}；同步会话运行状态失败：${formatStoreError(runningSyncError)}`);
        }
        throw createApiResultError(res);
      }
      const summary = this.getThreadSummary(body.threadId);
      trackProductEvent("chat_send", {
        dispatch_mode: res.dispatchMode ?? null,
        engine: summary?.engine ?? null,
        thread_type: summary?.threadType ?? "chat",
        thread_subtype: summary?.threadSubtype ?? null,
        has_images: Boolean(body.images?.length),
        image_count: body.images?.length ?? 0,
        has_files: Boolean(body.files?.length),
        file_count: body.files?.length ?? 0,
        has_path_refs: Boolean(body.pathReferences?.length),
        path_ref_count: body.pathReferences?.length ?? 0,
        has_role: Boolean(body.roleId),
        plan_mode: Boolean(body.planMode),
        access_mode: body.accessMode ?? null,
        has_model_override: Boolean(body.model),
        context_window_set: body.contextWindow != null,
        auto_compact_set: body.autoCompactPct != null,
        service_tier: body.serviceTier ?? null,
      });
      const skipOptimisticRunningState = summary?.threadType === "orchestration" && summary?.threadSubtype === "node";
      if (res.dispatchMode === "chat_turn" && res.turnId) {
        this.setThreadPendingDispatch(body.threadId, String(res.turnId));
      }
      if (res.dispatchMode === "chat_turn" && res.turnId && (this.loadedThreads[threadKey] || this.conversations[threadKey])) {
        const state = this.ensureConversation(body.threadId);
        const pendingEvent = buildLocalPendingUserMessageEvent({
          workspaceId: body.workspaceId,
          threadId: body.threadId,
          engine: summary?.engine ?? "codex",
          turnId: String(res.turnId),
          text: body.text,
          inputKind: body.inputKind,
          skillMentions: body.skillMentions,
          images: body.images ?? [],
          files: body.files,
          pathReferences: body.pathReferences,
        });
        this.pendingLocalUserMessageByThreadId[threadKey] = pendingEvent;
        // ACK 前可能已收到权威 userMessage；统一检查当前状态后再决定是否写入本地消息。
        reapplyPendingLocalUserMessage(
          state,
          pendingEvent,
          threadKey,
          this.pendingLocalUserMessageByThreadId,
          authoritativeUserMessageItemIdsBeforeSend,
        );
      }
      if (res.dispatchMode === "chat_turn"
        && res.turnId
        && !skipOptimisticRunningState
        && (this.loadedThreads[threadKey] || this.conversations[threadKey])) {
        this.scheduleAcceptedTurnContentReconcile(ctx, {
          workspaceId: body.workspaceId,
          threadId: body.threadId,
        }, String(res.turnId));
      }
      const reconciledFailure = buildAcceptedMutationReconciliationFailure(
        "消息已发送",
        rollbackRefresh,
        "自动回滚后的会话历史刷新失败",
      );
      if (reconciledFailure) {
        appendLocalSystemNotice(
          this.ensureConversation(body.threadId),
          body.workspaceId,
          body.threadId,
          summary?.engine ?? "codex",
          reconciledFailure.message,
        );
        throw reconciledFailure;
      }
      if (skipOptimisticRunningState) {
        try {
          await this.syncThreadSummaryState(ctx, {
            workspaceId: body.workspaceId,
            threadId: body.threadId,
            waitForRunning: true,
          });
        } catch (error) {
          if (!isCancelledRequestError(error)) {
            console.warn("[chat.sendMessage] failed to sync node thread running state:", error);
          }
        }
        if (res.dispatchMode === "orchestration_feedback" && this.loadedThreads[String(body.threadId)]) {
          try {
            const limit = this.threadLoadMetaByThreadId[String(body.threadId)]?.limit ?? null;
            await this.loadThread(ctx, {
              workspaceId: body.workspaceId,
              threadId: body.threadId,
              limit,
              // 这里只做后台回放收敛，避免把 composer 的稳定用量快照误判成一次完整内容重建。
              bumpContentEpoch: false,
            });
          } catch (error) {
            if (!isCancelledRequestError(error)) {
              console.warn("[chat.sendMessage] failed to rehydrate node thread after orchestration feedback:", error);
            }
          }
        }
      }
      this.threadHasRealTurnActivityByThreadId[String(body.threadId)] = true;
      return res.turnId ? String(res.turnId) : null;
    },

    async compactThread(
      ctx: ApiRequestContext,
      body: CompactThreadRequestBody,
    ): Promise<string | null> {
      const res = await apiCompactThread(ctx, body);
      const rollbackRefresh = await this.reconcileMutationRollbackResponse(
        ctx,
        body,
        readMutationRollbackMetadata(res),
      );
      if (!res.ok) {
        if (rollbackRefresh.rollbackReconciled) {
          const failure = buildRejectedMutationAfterRollbackFailure(
            "会话压缩",
            res.message,
            rollbackRefresh,
            null,
          );
          appendLocalSystemNotice(
            this.ensureConversation(body.threadId),
            body.workspaceId,
            body.threadId,
            "codex",
            failure.message,
          );
          throw failure;
        }
        throw new Error(res.message);
      }
      if (res.turnId) {
        this.setThreadPendingDispatch(body.threadId, String(res.turnId));
        if (this.loadedThreads[String(body.threadId)] || this.conversations[String(body.threadId)]) {
          this.scheduleAcceptedTurnContentReconcile(ctx, {
            workspaceId: body.workspaceId,
            threadId: body.threadId,
          }, String(res.turnId));
        }
      }
      const reconciledFailure = buildAcceptedMutationReconciliationFailure(
        "会话压缩已启动",
        rollbackRefresh,
        "自动回滚后的历史刷新失败",
      );
      if (reconciledFailure) {
        appendLocalSystemNotice(
          this.ensureConversation(body.threadId),
          body.workspaceId,
          body.threadId,
          "codex",
          reconciledFailure.message,
        );
        throw reconciledFailure;
      }
      this.threadHasRealTurnActivityByThreadId[String(body.threadId)] = true;
      return res.turnId ? String(res.turnId) : null;
    },

    /** 中断 turn。 */
    async interruptTurn(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: string }): Promise<void> {
      const pendingTurnIdAtRequest = String(this.threadPendingDispatchByThreadId[String(body.threadId)]?.turnId ?? "");
      const res = await runTrackedThreadRequest("turn_interrupt", { source: "chat_composer" }, () => (
        interruptTurn(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, turnId: body.turnId })
      ));
      if (!res.ok) {
        trackProductEvent("turn_interrupt", { status: "failed", source: "chat_composer", error_code_group: "request_rejected" });
        throw new Error(res.message);
      }
      const conversation = this.ensureConversation(body.threadId);
      const currentRunning = this.threadDisplayRunningStateForThread(body.threadId);
      const currentTurnId = String(currentRunning?.runningTurnId ?? "");
      const authoritativeHint = this.threadRunningHintByThreadId[String(body.threadId)] ?? null;
      const currentSuccessor = currentRunning
        && currentTurnId !== String(body.turnId)
        && !conversation.completedTurnIds[currentTurnId]
        && (String(conversation.runningTurnId ?? "") === currentTurnId
          || (authoritativeHint?.source === "authoritative"
            && String(authoritativeHint.running?.runningTurnId ?? "") === currentTurnId))
        ? currentRunning
        : null;
      const reportedRunning = res.running ?? null;
      const reportedTurnId = String(reportedRunning?.runningTurnId ?? "");
      // 停止响应可能晚于 turn.error 到达；旧 session 的 running 快照不能复活同一回合，
      // 也不能把期间已启动的后继回合清掉。
      const running = currentSuccessor && (!reportedRunning || reportedTurnId === String(body.turnId))
        ? currentSuccessor
        : reportedTurnId === String(body.turnId) && conversation.completedTurnIds[String(body.turnId)]
          ? null
          : reportedRunning;
      const pendingTurnId = String(this.threadPendingDispatchByThreadId[String(body.threadId)]?.turnId ?? "");
      if (!pendingTurnId || pendingTurnId === pendingTurnIdAtRequest
        || pendingTurnId === String(body.turnId) || pendingTurnId === String(running?.runningTurnId ?? "")) {
        this.clearThreadPendingDispatch(body.threadId);
      }
      this.setThreadRunningHint(body.threadId, running);
      this.applyThreadRunningState(body.threadId, running);
      trackProductEvent("turn_interrupt", { status: "success", source: "chat_composer" });
    },

    /** 刷新 thread 的文件变更列表（用于"文件变更"抽屉）。 */
    async refreshThreadFileChanges(
      ctx: ApiRequestContext,
      body: { workspaceId: WorkspaceId; threadId: ThreadId; force?: boolean },
    ): Promise<void> {
      const key = String(body.threadId);
      try {
        const scope = captureThreadResourceScope(body.workspaceId, body.threadId);
        await runScopedRead<void>(
          "file-changes",
          key,
          `${serializeThreadResourceScope(scope)}::${body.force ? "force" : "normal"}`,
          async (signal) => {
            const state = this.fileChangesByThreadId[key] ?? createEmptyFileChangesResourceState();
            this.fileChangesByThreadId[key] = { ...state, loading: true, error: null };
            try {
              const res = await listThreadFileChanges(ctx, { workspaceId: body.workspaceId, threadId: body.threadId }, { signal });
              if (!res.ok) throw new Error(res.message);
              assertThreadReadScope(scope, { resource: true });
              const nextItems = Array.isArray(res.items) ? res.items : [];
              const contentChanged = hasFileChangesStructuralChange(state.items ?? [], nextItems);
              const nextVersion = state.stale
                ? state.version
                : state.hydrated && contentChanged
                  ? state.version + 1
                  : state.version;
              this.fileChangesByThreadId[key] = {
                loading: false,
                items: nextItems,
                error: null,
                version: nextVersion,
                refreshTick: state.refreshTick,
                hydrated: true,
                stale: false,
              };
            } catch (error) {
              if (!isCancelledRequestError(error) && isThreadReadScopeCurrent(scope, { resource: true })) {
                this.fileChangesByThreadId[key] = {
                  loading: false,
                  items: state.items ?? [],
                  error: error instanceof Error ? error.message : String(error),
                  version: state.version,
                  refreshTick: state.refreshTick,
                  hydrated: state.hydrated,
                  stale: state.stale,
                };
              }
              throw error;
            }
          },
        );
      } catch (error) {
        if (isCancelledRequestError(error)) return;
        throw error;
      }
    },

    /** 撤销 thread 的文件变更（paths 为空表示撤销全部）。返回被跳过的文件列表（缺快照）。 */
    async undoThreadFileChanges(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId; paths?: string[] | null }): Promise<string[]> {
      const res = await undoThreadFileChanges(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, paths: body.paths ?? null });
      if (!res.ok) throw new Error(res.message);
      await this.refreshThreadFileChanges(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, force: true });
      return res.skippedPaths ?? [];
    },

    /** 接受 thread 的文件变更（推进 diff 基准点）。 */
    async acceptFileChanges(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId; paths: string[] }): Promise<void> {
      const res = await acceptThreadFileChanges(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, paths: body.paths });
      if (!res.ok) throw new Error(res.message);
      await this.refreshThreadFileChanges(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, force: true });
    },

    /** 删除成功后清理消息投影及回放缓存，不重载或中断当前回合。 */
    async deleteThreadMessage(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId; itemId: string }): Promise<void> {
      const result = await apiDeleteThreadMessage(ctx, body);
      if (!result.ok) throw createApiResultError(result);
      if (result.itemId !== body.itemId) throw new Error("删除响应与目标消息不匹配");
      this.applyThreadMessageDeletions(body.threadId, [body.itemId]);
    },

    /** 同步持久删除事实到正文、历史缓存与尚未回放的实时事件。 */
    applyThreadMessageDeletions(threadId: ThreadId, itemIds: string[]): void {
      const key = String(threadId);
      if (itemIds.length) this.threadContentEpochByThreadId[key] = (this.threadContentEpochByThreadId[key] ?? 0) + 1;
      const state = this.ensureConversation(threadId);
      deleteConversationMessages(state, itemIds);
      const pending = this.pendingLocalUserMessageByThreadId[key];
      if (pending && state.deletedMessageIds?.has(getConversationMessageItemId(pending) ?? "")) {
        delete this.pendingLocalUserMessageByThreadId[key];
      }
      const keep = (event: EngineEventEnvelope): boolean => event.type === "item.message.deleted"
        || !state.deletedMessageIds?.has(getConversationMessageItemId(event) ?? "");
      if (this.threadReplayEventsByThreadId[key]) {
        this.threadReplayEventsByThreadId[key] = this.threadReplayEventsByThreadId[key].filter(keep);
      }
      const buffered = bufferedLiveReplayEventsByThreadId.get(key);
      if (buffered) bufferedLiveReplayEventsByThreadId.set(key, buffered.filter(keep));
    },

    /** 回滚 thread 到指定 turn，并自动重新加载会话与文件变更。 */
    async rollbackThread(
      ctx: ApiRequestContext,
      body: { workspaceId: WorkspaceId; threadId: ThreadId; toTurnId: TurnId; rollbackFiles?: boolean; skipPaths?: string[] },
    ): Promise<RollbackThreadResponseBody> {
      const restoredDraft = buildRollbackRestoredDraft(this.conversations[String(body.threadId)], body.toTurnId);
      const res = await rollbackThread(ctx, {
        workspaceId: body.workspaceId,
        threadId: body.threadId,
        toTurnId: body.toTurnId,
        ...(body.rollbackFiles != null ? { rollbackFiles: body.rollbackFiles } : {}),
        ...(body.skipPaths?.length ? { skipPaths: body.skipPaths } : {}),
      });
      if (!res.ok) throw new Error(res.message);
      const rollbackMetadata = readMutationRollbackMetadata(res);
      const expectedFileRollbackStatus = body.rollbackFiles === false ? "not_requested" : "completed";
      if (res.fileRollbackStatus !== expectedFileRollbackStatus) {
        const actualStatus = typeof res.fileRollbackStatus === "string" ? res.fileRollbackStatus : "missing";
        throw new Error(`回滚响应未确认文件状态：期望 ${expectedFileRollbackStatus}，实际 ${actualStatus}；请刷新会话核对`);
      }
      if (res.droppedTurnCount > 0 && res.rollbackEventSeqBarrier == null) {
        throw new Error("回滚响应缺少事件屏障；历史已变更，请重启 Client 后刷新会话核对");
      }
      const rollbackBarrierAlreadyLoaded = res.rollbackEventSeqBarrier != null
        && res.rollbackEventSeqBarrier <= Number(this.threadRollbackEventSeqBarrierByThreadId[String(body.threadId)] ?? 0)
        && Boolean(this.loadedThreads[String(body.threadId)]);
      const shouldReloadRollbackHistory = res.rollbackEventSeqBarrier != null
        ? (this.prepareThreadRollbackHistoryReload(body.threadId, res.rollbackEventSeqBarrier) || !rollbackBarrierAlreadyLoaded)
        : true;
      if (res.rollbackEventSeqBarrier == null) {
        invalidateQueuedThreadDraftMutations(String(body.threadId));
        this.invalidateThreadScopes(body.threadId, { reason: "thread-invalidated" });
        this.clearThreadReplayState(body.threadId);
      }

      // rollback 会裁剪本地历史：重新回放以刷新 UI。
      const meta = this.threadLoadMetaByThreadId[String(body.threadId)] ?? null;
      const limit = meta?.limit ?? null;
      const engine = this.getThreadSummary(body.threadId)?.engine ?? "codex";
      if (shouldReloadRollbackHistory) {
        try {
          await this.loadThread(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, limit });
        } catch (cause) {
          const message = `回滚已完成，但会话历史刷新失败：${formatStoreError(cause)}。请刷新会话后核对。`;
          appendLocalSystemNotice(this.ensureConversation(body.threadId), body.workspaceId, body.threadId, engine, message);
          throw new Error(message, { cause });
        }
        try {
          await this.refreshThreadFileChanges(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, force: true });
        } catch (cause) {
          const message = `回滚已完成，但文件变更列表刷新失败：${formatStoreError(cause)}。请刷新会话后核对。`;
          appendLocalSystemNotice(this.ensureConversation(body.threadId), body.workspaceId, body.threadId, engine, message);
          throw new Error(message, { cause });
        }
      }
      if (restoredDraft) {
        try {
          await this.saveThreadDraft(ctx, body.workspaceId, body.threadId, restoredDraft);
        } catch (error) {
          throw new Error(`回滚已完成，但恢复输入草稿失败：${formatStoreError(error)}`, { cause: error });
        }
      }
      const projectionFailure = buildAcceptedMutationReconciliationFailure(
        "回滚已完成",
        {
          ...rollbackMetadata,
          barrierError: null,
          historyReloadError: null,
          fileChangesReloadError: null,
        },
        "回滚后的会话历史刷新失败",
      );
      if (projectionFailure) {
        appendLocalSystemNotice(
          this.ensureConversation(body.threadId),
          body.workspaceId,
          body.threadId,
          engine,
          projectionFailure.message,
        );
        throw projectionFailure;
      }
      return {
        droppedTurnCount: res.droppedTurnCount,
        revertedFileCount: res.revertedFileCount,
        skippedFileCount: res.skippedFileCount,
        fileRollbackStatus: res.fileRollbackStatus,
        ...(res.rollbackEventSeqBarrier != null ? { rollbackEventSeqBarrier: res.rollbackEventSeqBarrier } : {}),
      };
    },

    /** 应用 canonical conversation 事件：将事件流转换为 ConversationItem。 */
    applyEngineEvent(event: EngineEventEnvelope, opts?: { updateLastSeq?: boolean }) {
      const updateLastSeq = opts?.updateLastSeq !== false;
      const key = String(event.threadId);
      if (event.type === "item.message.deleted") this.applyThreadMessageDeletions(event.threadId, [event.payload.itemId]);
      const presentationVersion = this.threadPresentationVersionByThreadId[key];
      if (updateLastSeq && event.seq > 0 && presentationVersion != null && event.seq <= presentationVersion) {
        this.activeWorkspaceLastEventSeq = Math.max(this.activeWorkspaceLastEventSeq, event.seq);
        if (isTerminalTurnEvent(event)) this.cancelAcceptedTurnContentReconcile({ workspaceId: event.workspaceId, threadId: event.threadId }, String(event.payload.turnId ?? ""));
        return;
      }
      const deletedMessageId = getConversationMessageItemId(event);
      if (event.type !== "item.message.deleted" && deletedMessageId && this.conversations[key]?.deletedMessageIds?.has(deletedMessageId)) {
        applyEngineEventToConversation(this.conversations[key], event);
        if (event.type === "item.userMessage.created") this.applyThreadMessageDeletions(event.threadId, []);
        if (updateLastSeq) this.activeWorkspaceLastEventSeq = Math.max(this.activeWorkspaceLastEventSeq, normalizeSeq(event.seq) ?? 0);
        return;
      }
      if (updateLastSeq) {
        // WS 事件在重订阅、回放加载和跨 thread 批处理间可能晚到；按 thread+seq 去重，避免全局 seq 误丢终态事件。
        if (hasReplayEventSeq(this.threadReplayEventsByThreadId[key], event.seq)) {
          this.activeWorkspaceLastEventSeq = Math.max(this.activeWorkspaceLastEventSeq, normalizeSeq(event.seq) ?? 0);
          return;
        }
        this.activeWorkspaceLastEventSeq = Math.max(this.activeWorkspaceLastEventSeq, normalizeSeq(event.seq) ?? 0);
        if (isBlockedByRollbackEventSeqBarrier(
          this.threadRollbackEventSeqBarrierByThreadId,
          this.threadReplayEventsByThreadId,
          event,
        )) {
          return;
        }
        if (threadReplayLoadTokenByThreadId.has(key)) {
          const buffered = bufferedLiveReplayEventsByThreadId.get(key) ?? [];
          if (!buffered.some(previous => previous.seq === event.seq)) bufferedLiveReplayEventsByThreadId.set(key, [...buffered, event]);
          return;
        }
        if (presentationVersion != null) {
          (this.threadReplayEventsByThreadId[key] ??= []).push(event);
        } else appendReplayEvent(this.threadReplayEventsByThreadId, event);
      }
      const state = this.ensureConversation(event.threadId);
      const matchedPendingLocalUserMessage = reconcilePendingLocalUserMessage(state, this.pendingLocalUserMessageByThreadId[key] ?? null, event);
      const wasInvalidated = state.invalidated;
      const displayRunningTurnIdBeforeEvent = isTerminalTurnEvent(event)
        ? String(this.threadDisplayRunningStateForThread(event.threadId)?.runningTurnId ?? "").trim()
        : "";
      applyEngineEventToConversation(state, event, orchestrationNodeLabelsForThread(this, event.threadId));
      if (matchedPendingLocalUserMessage) {
        delete this.pendingLocalUserMessageByThreadId[key];
      }
      if (event.type === "turn.started") {
        this.threadHasRealTurnActivityByThreadId[String(event.threadId)] = true;
        this.clearThreadPendingDispatch(event.threadId);
        this.setThreadRunningHint(event.threadId, {
          runningTurnId: String(state.runningTurnId ?? event.payload.turnId ?? "") as TurnId,
          runningTurnStartedAt: Number(state.runningTurnStartedAt ?? event.ts ?? Date.now()),
        });
      }
      if (event.type === "turn.completed" || event.type === "turn.error") {
        settleTerminalRunningState(this, event, displayRunningTurnIdBeforeEvent);
        const terminalTurnId = String(event.payload.turnId ?? "").trim();
        if (terminalTurnId) {
          this.cancelAcceptedTurnContentReconcile({
            workspaceId: event.workspaceId,
            threadId: event.threadId,
          }, terminalTurnId);
        }
      }
      // 检测文件写入工具完成事件：递增 fileChangeTick，驱动 UI 实时刷新文件列表。
      // 注意：Read 工具在 display 模式下也会携带 changes（用于 UI 展示路径摘要），
      // 但不是文件变更，必须按 toolName 过滤，仅对写入类工具触发。
      if (
        updateLastSeq &&
        event.type === "item.tool.completed" &&
        Array.isArray((event.payload as any).changes) &&
        (event.payload as any).changes.length > 0 &&
        isFileMutationTool((event.payload as any).toolName)
      ) {
        this.fileChangeTick += 1;
        this.markThreadFileChangesChanged(event.threadId);
      }
      if (updateLastSeq && event.type === "thread.process.changed") {
        this.markManagedServicesChanged(event.threadId);
      }
      if (updateLastSeq && event.type === "item.tool.completed" && isManagedServiceToolEvent(event.payload)) {
        this.markManagedServicesChanged(event.threadId);
      }
      const prefsPatch = extractThreadPrefsPatchFromConversationEvent(event);
      if (prefsPatch) {
        const key = String(event.threadId);
        const current = this.threadPrefsByThreadId[key] ?? {};
        this.setThreadPrefs(event.threadId, mergeThreadPrefs(current, prefsPatch));
      }
      if (!wasInvalidated && state.invalidated) {
        this.invalidateThreadScopes(event.threadId, {
          reason: "thread-invalidated",
          read: false,
          resource: true,
        });
        this.markThreadInvalidated(event.threadId);
        this.markThreadFileChangesChanged(event.threadId, "thread-invalidated");
        this.invalidateThreadManagedServices(event.threadId, "thread-invalidated");
      }
    },

    /** 刷新当前聊天窗口绑定的本地进程列表。 */
    async refreshThreadManagedServices(
      ctx: ApiRequestContext,
      body: { workspaceId: WorkspaceId; threadId: ThreadId; force?: boolean },
    ): Promise<void> {
      const managedServicesScope = resolveManagedServicesScopeFromThreadState(this.threadManagedServicesScopeByThreadId, body.threadId);
      const ownerThreadId = String(managedServicesScope.threadId ?? "").trim();
      if (!managedServicesScope.visible || !ownerThreadId) return;
      const lastRefreshedAt = managedServiceLastRefreshAtByThreadId.get(ownerThreadId) ?? 0;
      if (!body.force && Date.now() - lastRefreshedAt < MANAGED_SERVICES_REFRESH_COOLDOWN_MS) return;
      try {
        const scope = captureManagedServicesScope(body.workspaceId, ownerThreadId as ThreadId);
        await runScopedRead<void>(
          "managed-services",
          ownerThreadId,
          `${serializeManagedServicesScope(scope)}::${body.force ? "force" : "normal"}`,
          async (signal) => {
            const state = this.managedServicesByThreadId[ownerThreadId] ?? createEmptyManagedServicesResourceState();
            this.managedServicesByThreadId[ownerThreadId] = { ...state, loading: true, error: null };
            try {
              const res = await listThreadManagedServices(ctx, { workspaceId: body.workspaceId, threadId: body.threadId }, { signal });
              if (!res.ok) throw new Error(res.message);
              assertManagedServicesScope(scope);
              managedServiceLastRefreshAtByThreadId.set(ownerThreadId, Date.now());
              const nextItems = Array.isArray(res.items) ? res.items : [];
              const contentChanged = hasManagedServicesStructuralChange(state.items ?? [], nextItems);
              const nextVersion = state.stale
                ? state.version
                : state.hydrated && contentChanged
                  ? state.version + 1
                  : state.version;
              this.managedServicesByThreadId[ownerThreadId] = {
                loading: false,
                items: nextItems,
                error: null,
                version: nextVersion,
                refreshTick: state.refreshTick,
                hydrated: true,
                stale: false,
              };
            } catch (error) {
              if (!isCancelledRequestError(error) && isManagedServicesScopeCurrent(scope)) {
                this.managedServicesByThreadId[ownerThreadId] = {
                  loading: false,
                  items: state.items ?? [],
                  error: error instanceof Error ? error.message : String(error),
                  version: state.version,
                  refreshTick: state.refreshTick,
                  hydrated: state.hydrated,
                  stale: state.stale,
                };
              }
              throw error;
            }
          },
        );
      } catch (error) {
        if (isCancelledRequestError(error)) return;
        throw error;
      }
    },

    /** 停止当前聊天窗口绑定的本地进程并刷新列表。 */
    async stopThreadManagedService(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId; serviceId: string }): Promise<void> {
      const res = await apiStopThreadManagedService(ctx, {
        workspaceId: body.workspaceId,
        threadId: body.threadId,
        serviceId: body.serviceId,
      });
      if (!res.ok) throw new Error(res.message);
      await this.refreshThreadManagedServices(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, force: true });
    },

    /** 登记真实展示面板，最后一个面板离开时取消仅用于展示的在途读取。 */
    setThreadPresentationSurface(owner: object, surface: { workspaceId: WorkspaceId; threadId: ThreadId } | null): void {
      let surfaces = threadPresentationSurfaces.get(this.$state);
      if (!surfaces) {
        surfaces = new Map();
        threadPresentationSurfaces.set(this.$state, surfaces);
      }
      const previous = surfaces.get(owner);
      if (surface) surfaces.set(owner, surface);
      else surfaces.delete(owner);
      if (previous && !this.isThreadPresentationVisible(previous.workspaceId, previous.threadId)) {
        abortRead("thread-presentation", String(previous.threadId), "selection-change");
      }
    },

    /** 查询面板登记，避免把全局选中或历史加载状态误作实际可见性。 */
    isThreadPresentationVisible(workspaceId: WorkspaceId, threadId: ThreadId): boolean {
      return [...(threadPresentationSurfaces.get(this.$state)?.values() ?? [])].some(surface =>
        surface.workspaceId === workspaceId && surface.threadId === threadId);
    },

    /** 隐藏会话仅积累权威版本，回滚屏障前的通知不污染重新展示时的读取要求。 */
    requireThreadPresentationVersion(threadId: ThreadId, version: number): void {
      const key = String(threadId);
      if (version <= (this.threadRollbackEventSeqBarrierByThreadId[key] ?? 0)) return;
      this.threadPresentationRequiredVersionByThreadId[key] = Math.max(this.threadPresentationRequiredVersionByThreadId[key] ?? 0, version);
    },

    /** 恢复轻量快照及实时尾部；自动展示读取仅服务仍可见的面板，不阻断终态事件。 */
    async refreshThreadPresentation(
      ctx: ApiRequestContext,
      body: { workspaceId: WorkspaceId; threadId: ThreadId; version?: number; visibleOnly?: boolean },
    ): Promise<void> {
      const key = String(body.threadId);
      this.requireThreadPresentationVersion(body.threadId, body.version ?? 0);
      if (body.visibleOnly && !this.isThreadPresentationVisible(body.workspaceId, body.threadId)) return;
      if (!this.loadedThreads[key] || this.threadPresentationVersionByThreadId[key] == null) return;
      if (body.version != null && body.version <= this.threadPresentationVersionByThreadId[key] && !this.threadPresentationErrorByThreadId[key]) return;
      const scope = captureThreadReadScope(body.workspaceId, body.threadId);
      try {
        await runScopedRead<void>("thread-presentation", key, serializeThreadHistoryScope(scope), async signal => {
          do {
            // 只要求覆盖本次实际读取起点；在途通知留作下一次串行追赶，避免持续输出时饥饿。
            const requiredVersionAtRequest = this.threadPresentationRequiredVersionByThreadId[key] ?? 0;
            const runningHintAtRequest = this.threadRunningHintByThreadId[key];
            const presentationMeta = this.threadLoadMetaByThreadId[key];
            const result = await getThreadPresentation(ctx, { workspaceId: body.workspaceId, threadId: body.threadId,
              ...(presentationMeta?.presentationPaged
                ? { presentationLimit: presentationMeta.presentationLoadedMessages ?? PRESENTATION_INITIAL_MESSAGES } : {}) }, { signal });
            if (!result.ok) throw createApiResultError(result);
            assertThreadReadScope(scope, { history: true });
            if (body.visibleOnly && !this.isThreadPresentationVisible(body.workspaceId, body.threadId)) return;
            const presentation: ThreadPresentation = result.presentation;
            if (presentation.version < requiredVersionAtRequest) throw new Error("会话摘要版本未达到已接收的变更通知，请重试");
            if (presentation.version < this.threadPresentationVersionByThreadId[key]) continue;
            const current = this.ensureConversation(body.threadId);
            // 最新快照只是窗口；保留已向上加载的更早条目，避免实时刷新丢弃历史。
            const windowIds = new Set(presentation.items.map(item => String(item.id)));
            const olderItems = current.items.filter(item => !windowIds.has(String(item.id)));
            const next = restoreConversationState(presentation.state, [...olderItems, ...presentation.items], orchestrationNodeLabelsForThread(this, body.threadId));
            deleteConversationMessages(next, [...(current.deletedMessageIds ?? [])]);
            const tail = (this.threadReplayEventsByThreadId[key] ?? []).filter(event => event.seq > presentation.version);
            for (const event of tail) applyEngineEventToConversation(next, event, orchestrationNodeLabelsForThread(this, body.threadId));
            assignLoadedConversationState(current, next);
            const running = resolveCanonicalRunningStateFromConversation(this.conversations, body.threadId);
            const pendingTurnId = this.threadPendingDispatchByThreadId[key]?.turnId;
            const pendingConfirmed = pendingTurnId && (pendingTurnId === running?.runningTurnId || next.completedTurnIds[pendingTurnId]);
            if (pendingConfirmed) this.clearThreadPendingDispatch(body.threadId);
            const runningHint = this.threadRunningHintByThreadId[key];
            const hintedTurnId = runningHint?.running?.runningTurnId;
            // 快照须确认所属派发，或覆盖已知终态，才可替换请求期间更新的权威提示。
            if (pendingConfirmed || !pendingTurnId && (runningHint === runningHintAtRequest
              || hintedTurnId && (hintedTurnId === running?.runningTurnId || next.completedTurnIds[hintedTurnId]))) {
              this.setThreadRunningHint(body.threadId, running);
            }
            reapplyPendingLocalUserMessage(current, this.pendingLocalUserMessageByThreadId[key] ?? null, key, this.pendingLocalUserMessageByThreadId);
            this.threadReplayEventsByThreadId[key] = tail;
            this.threadPresentationVersionByThreadId[key] = presentation.version;
            delete this.threadPresentationErrorByThreadId[key];
          } while ((!body.visibleOnly || this.isThreadPresentationVisible(body.workspaceId, body.threadId))
            && (this.threadPresentationRequiredVersionByThreadId[key] ?? 0) > this.threadPresentationVersionByThreadId[key]);
        });
      } catch (error) {
        if (isCancelledRequestError(error)) return;
        if (isThreadReadScopeCurrent(scope, { history: true })) this.threadPresentationErrorByThreadId[key] = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },

    /** 加载轻量快照并接续正文与审批偏好；旧响应沿用事件回放兼容入口。 */
    async loadThread(
      ctx: ApiRequestContext,
      body: { workspaceId: WorkspaceId; threadId: ThreadId; limit?: number | null; bumpContentEpoch?: boolean },
    ): Promise<void> {
      const key = String(body.threadId);
      const scope = captureThreadReadScope(body.workspaceId, body.threadId);
      const prefsMutationEpoch = getThreadPrefsMutationEpoch(key);
      const prefsReadBase = copyDefinedThreadPrefs(this.threadPrefsByThreadId[key]);
      const prefsReadPending = copyDefinedThreadPrefs(this.pendingThreadPrefsByThreadId[key]);
      const basePrefsReadBase = copyDefinedThreadPrefs(this.threadBasePrefsByThreadId[key]);
      try {
        await runScopedRead<void>("thread-load", key, serializeThreadHistoryScope(scope), async (signal) => {
          const nextLimit = clampInt(body.limit ?? this.threadLoadMetaByThreadId[key]?.limit ?? DEFAULT_THREAD_LOAD_LIMIT, DEFAULT_THREAD_LOAD_LIMIT, 1, MAX_THREAD_LOAD_LIMIT);
          // 进度条：fetch + replay 两段。这里的 token 用于避免并发 loadThread 时旧任务覆盖新进度。
          const token = this.threadLoadingToken + 1;
          const replayLoadToken = nextReplayLoadToken();
          this.threadLoadingToken = token;
          this.threadLoading = { threadId: body.threadId, stage: "fetching", totalEvents: 0, processedEvents: 0 };
          threadReplayLoadTokenByThreadId.set(key, replayLoadToken);

          let appliedReplayMaxSeq = 0;
          try {
            const res = await loadThread(ctx, { workspaceId: body.workspaceId, threadId: body.threadId, limit: nextLimit,
              presentationLimit: PRESENTATION_INITIAL_MESSAGES, presentation: "lazy" }, { signal });
            if (!res.ok) throw new Error(res.message);
            assertThreadReadScope(scope, { history: true });
            if (res.presentation && res.presentation.version < (this.threadPresentationVersionByThreadId[key] ?? 0)) {
              throw new Error("会话快照版本落后于已接受的展示版本，请重试");
            }
            const existingThread = this.getThreadSummary(res.thread.id);
            const loadedThread = res.thread as typeof res.thread & Pick<ThreadSummary, "sharedContext" | "readOnly">;
            this.upsertThreadSummary({
              id: res.thread.id,
              title: res.thread.title,
              threadType: res.thread.threadType ?? existingThread?.threadType ?? "chat",
              threadSubtype: res.thread.threadSubtype
                ?? existingThread?.threadSubtype
                ?? null,
              archived: existingThread?.archived ?? false,
              pinnedAt: res.thread.pinnedAt ?? existingThread?.pinnedAt ?? null,
              createdAt: res.thread.createdAt,
              updatedAt: res.thread.updatedAt,
              engine: res.thread.engine,
              sharedContext: loadedThread.sharedContext ?? existingThread?.sharedContext ?? null,
              readOnly: Boolean(loadedThread.readOnly ?? existingThread?.readOnly ?? false),
            });
            this.setThreadManagedServicesScope(res.thread.id, res.managedServices ?? null);
            if (Object.prototype.hasOwnProperty.call(res, "draft")) {
              this.setThreadDraft(res.thread.id, res.draft ?? null);
            }

            // 缓存 thread 的偏好（thread 级配置的唯一来源）
            const t = res.thread;
            const basePrefs: ThreadPrefs = {
              model: t.model,
              effort: t.effort,
              accessMode: t.accessMode,
              planMode: t.planMode,
              knowledgeEnabled: t.knowledgeEnabled,
              autoCompactPct: t.autoCompactPct,
              contextWindow: t.contextWindow,
              serviceTier: t.serviceTier,
              roleId: t.roleId,
            };
            const currentPrefsPending = copyDefinedThreadPrefs(this.pendingThreadPrefsByThreadId[key]);
            const loadedBasePrefs = getThreadPrefsMutationEpoch(key) === prefsMutationEpoch
              && !hasThreadPrefsFields(prefsReadPending)
              ? { ...basePrefs }
              : mergeStaleThreadPrefsSnapshot(
                this.threadBasePrefsByThreadId[key] ?? {},
                basePrefs,
                basePrefsReadBase,
                prefsReadPending,
              );
            this.threadBasePrefsByThreadId[key] = mergeThreadPrefs(
              loadedBasePrefs,
              currentPrefsPending,
            );
            const existingReplayEvents = this.threadReplayEventsByThreadId[key] ?? [];
            if (res.deletedMessageIds?.length) this.applyThreadMessageDeletions(body.threadId, res.deletedMessageIds);
            // live 事件在 loadThread 期间会先进入 buffered map。
            // 这里先快照参与回放，但在真正完成赋值前不清空缓冲，
            // 避免 scope 失效/重订阅时把 terminal 事件直接吞掉。
            const liveEventsBeforeReplay = listBufferedReplayEvents(bufferedLiveReplayEventsByThreadId, key);
            const mergedReplayEvents = res.presentation
              ? [...new Map([...existingReplayEvents, ...liveEventsBeforeReplay].filter(event => event.seq > res.presentation!.version).map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq)
              : mergeReplayEventWindows(res, existingReplayEvents, liveEventsBeforeReplay);

            if (this.threadLoadingToken === token && this.threadLoading) {
              this.threadLoading.stage = "replaying";
              this.threadLoading.totalEvents = mergedReplayEvents.length;
              this.threadLoading.processedEvents = 0;
            }

            // 重复加载时保留已向上加载的更早条目，不能用新的最近窗口直接替换会话。
            const previousPresentationItems = res.presentation ? (this.conversations[key]?.items ?? []) : [];
            const previousPresentationMeta = res.presentation ? this.threadLoadMetaByThreadId[key] : undefined;
            const keepLoadedPresentation = Boolean(res.presentation && previousPresentationMeta?.presentationPaged && previousPresentationItems.length);
            const presentationItems = res.presentation
              ? (keepLoadedPresentation
                ? mergePresentationItems(previousPresentationItems.filter(item => !res.presentation!.items.some(next => String(next.id) === String(item.id))), res.presentation.items)
                : res.presentation.items)
              : [];
            // 记录本次回放上限与实际事件数，供"加载更多历史"判断。
            const oldestSeq = normalizeSeq(res.oldestSeq);
            this.threadLoadMetaByThreadId[key] = {
              limit: nextLimit,
              loadedEvents: res.rawEventCount ?? res.events.length,
              hasMore: res.presentation
                ? (keepLoadedPresentation ? previousPresentationMeta!.hasMore : Boolean(res.presentation.hasMoreOlder))
                : Boolean(res.hasMore),
              oldestLoadedSeq: oldestSeq,
              ...(res.presentation ? { presentationPaged: true,
                oldestPresentationPosition: keepLoadedPresentation
                  ? previousPresentationMeta!.oldestPresentationPosition ?? null
                  : res.presentation.oldestPosition ?? null,
                presentationLoadedMessages: keepLoadedPresentation
                  ? previousPresentationMeta!.presentationLoadedMessages ?? PRESENTATION_INITIAL_MESSAGES
                  : PRESENTATION_INITIAL_MESSAGES } : {}),
              loadingMore: false,
            };

            const replayed = res.presentation ? {
              state: restoreConversationState(res.presentation.state, presentationItems, orchestrationNodeLabelsForThread(this, body.threadId)),
              prefs: basePrefs,
              maxSeq: res.presentation.version,
            } : await replayConversationEvents({
              threadId: body.threadId,
              events: mergedReplayEvents,
              deletedMessageIds: [...(this.conversations[key]?.deletedMessageIds ?? []), ...(res.deletedMessageIds ?? [])],
              basePrefs,
              nodeLabels: orchestrationNodeLabelsForThread(this, body.threadId),
              onProgress: async (processedEvents) => {
                assertThreadReadScope(scope, { history: true });
                if (this.threadLoadingToken !== token || !this.threadLoading || this.threadLoading.stage !== "replaying") return;
                this.threadLoading.processedEvents = processedEvents;
                await new Promise((resolve) => setTimeout(resolve, 0));
              },
            });
            if (res.presentation) {
              for (const event of mergedReplayEvents) {
                applyEngineEventToConversation(replayed.state, event, orchestrationNodeLabelsForThread(this, body.threadId));
                replayed.prefs = mergeThreadPrefs(replayed.prefs, extractThreadPrefsPatchFromConversationEvent(event));
              }
              replayed.maxSeq = Math.max(res.presentation.version, maxReplayEventSeq(mergedReplayEvents));
            }

            assertThreadReadScope(scope, { history: true });
            // 一次性赋值回 Pinia reactive state（只触发一次响应式更新）
            const state = this.ensureConversation(body.threadId);
            assignLoadedConversationState(state, replayed.state);
            if (res.presentation) {
              this.threadPresentationVersionByThreadId[key] = res.presentation.version;
              delete this.threadPresentationErrorByThreadId[key];
              if (!keepLoadedPresentation) {
                this.threadLoadMetaByThreadId[key].hasMore = Boolean(res.presentation.hasMoreOlder);
                this.threadLoadMetaByThreadId[key].oldestPresentationPosition = res.presentation.oldestPosition ?? null;
              }
            }
            applyLoadedEngineSessionId(state, res.thread.sessionId);
            reapplyPendingLocalUserMessage(state, this.pendingLocalUserMessageByThreadId[key] ?? null, key, this.pendingLocalUserMessageByThreadId);
            const resolvedRunningState = resolveThreadRunningStateFromReplay(replayed.state, res.running ?? null);
            this.clearThreadPendingDispatch(body.threadId);
            this.applyThreadRunningState(
              body.threadId,
              resolvedRunningState,
            );
            this.setThreadRunningHint(body.threadId, resolvedRunningState);
            this.threadHasRealTurnActivityByThreadId[key] = Boolean(res.hasRealTurnActivity);
            this.threadReplayEventsByThreadId[key] = mergedReplayEvents.filter((event) => event.type === "item.message.deleted"
              || !state.deletedMessageIds?.has(getConversationMessageItemId(event) ?? ""));
            this.setThreadPrefs(body.threadId, replayed.prefs, {
              readMutationEpoch: prefsMutationEpoch,
              readBasePrefs: prefsReadBase,
              readPendingPrefs: prefsReadPending,
            });
            if (body.bumpContentEpoch !== false) {
              this.threadContentEpochByThreadId[key] = (this.threadContentEpochByThreadId[key] ?? 0) + 1;
            }

            this.loadedThreads[String(body.threadId)] = true;
            appliedReplayMaxSeq = Math.max(replayed.maxSeq, normalizeSeq(res.latestSeq) ?? 0);
            dropBufferedReplayEventsThroughSeq(bufferedLiveReplayEventsByThreadId, key, appliedReplayMaxSeq);
          } finally {
            if (threadReplayLoadTokenByThreadId.get(key) === replayLoadToken) {
              threadReplayLoadTokenByThreadId.delete(key);
            }
            const bufferedTailEvents = listBufferedReplayEventsAfterSeq(
              bufferedLiveReplayEventsByThreadId,
              key,
              appliedReplayMaxSeq,
            );
            if (bufferedTailEvents.length > 0 && isThreadReadScopeCurrent(scope, { history: true })) {
              applyBufferedReplayEvents(this, body.threadId, bufferedTailEvents);
              dropBufferedReplayEventsThroughSeq(
                bufferedLiveReplayEventsByThreadId,
                key,
                maxReplayEventSeq(bufferedTailEvents),
              );
            }
            if (this.threadLoadingToken === token) this.threadLoading = null;
          }
        });
      } catch (error) {
        if (isCancelledRequestError(error)) return;
        throw error;
      }
    },

    /** 增量加载更多历史页（游标反向分页），并基于压缩事件缓存重建完整对话。 */
    async loadThreadPage(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; threadId: ThreadId }): Promise<void> {
      const key = String(body.threadId);
      const meta = this.threadLoadMetaByThreadId[key];
      if (!meta || !meta.hasMore || meta.loadingMore || (!meta.presentationPaged && meta.oldestLoadedSeq == null)) return;
      const scope = captureThreadReadScope(body.workspaceId, body.threadId);
      const prefsMutationEpoch = getThreadPrefsMutationEpoch(key);
      const prefsReadBase = copyDefinedThreadPrefs(this.threadPrefsByThreadId[key]);
      const prefsReadPending = copyDefinedThreadPrefs(this.pendingThreadPrefsByThreadId[key]);
      meta.loadingMore = true;
      try {
        await runScopedRead<void>("thread-page", key, `${serializeThreadHistoryScope(scope)}::${meta.presentationPaged ? meta.oldestPresentationPosition : meta.oldestLoadedSeq}`, async (signal) => {
          if (meta.presentationPaged) {
            const result = await getThreadPresentation(ctx, { workspaceId: body.workspaceId, threadId: body.threadId,
              presentationLimit: PRESENTATION_PAGE_MESSAGES, presentationBeforePosition: meta.oldestPresentationPosition ?? null }, { signal });
            if (!result.ok) throw createApiResultError(result);
            assertThreadReadScope(scope, { history: true });
            const presentation = result.presentation;
            const requestedPosition = meta.oldestPresentationPosition;
            // 游标未向前推进说明投影已重排或窗口为空，停止请求而不是重复拉取同一页。
            if (requestedPosition != null && (presentation.oldestPosition == null || presentation.oldestPosition >= requestedPosition)) {
              meta.hasMore = false;
              return;
            }
            if (presentation.state.deletedMessageIds.length) this.applyThreadMessageDeletions(body.threadId, presentation.state.deletedMessageIds);
            const currentState = this.ensureConversation(body.threadId);
            const mergedItems = mergePresentationItems(presentation.items, currentState.items);
            assignLoadedConversationState(currentState, restoreConversationState(presentation.state, mergedItems, orchestrationNodeLabelsForThread(this, body.threadId)));
            this.threadPresentationVersionByThreadId[key] = Math.max(this.threadPresentationVersionByThreadId[key] ?? 0, presentation.version);
            meta.oldestPresentationPosition = presentation.oldestPosition ?? null;
            meta.hasMore = Boolean(presentation.hasMoreOlder);
            meta.presentationLoadedMessages = Math.min(200, (meta.presentationLoadedMessages ?? PRESENTATION_INITIAL_MESSAGES) + PRESENTATION_PAGE_MESSAGES);
            return;
          }
          const replayLoadToken = nextReplayLoadToken();
          threadReplayLoadTokenByThreadId.set(key, replayLoadToken);
          let appliedReplayMaxSeq = 0;
          const res = await loadThread(ctx, {
            workspaceId: body.workspaceId,
            threadId: body.threadId,
            limit: INCREMENTAL_PAGE_SIZE,
            beforeSeq: meta.oldestLoadedSeq,
          }, { signal });
          try {
            if (!res.ok) throw new Error(res.message);
            assertThreadReadScope(scope, { history: true });
            if (res.deletedMessageIds?.length) this.applyThreadMessageDeletions(body.threadId, res.deletedMessageIds);
            if (res.events.length === 0) {
              applyLoadedEngineSessionId(this.ensureConversation(body.threadId), res.thread.sessionId);
              meta.hasMore = false;
              return;
            }

            const existingEvents = this.threadReplayEventsByThreadId[key] ?? [];
            const liveEventsBeforeReplay = listBufferedReplayEvents(bufferedLiveReplayEventsByThreadId, key);
            const mergedEvents = mergeReplayEventWindows(res, existingEvents, liveEventsBeforeReplay);
            this.threadReplayEventsByThreadId[key] = mergedEvents;

            const replayed = await replayConversationEvents({
              threadId: body.threadId,
              events: mergedEvents,
              deletedMessageIds: [...(this.conversations[key]?.deletedMessageIds ?? []), ...(res.deletedMessageIds ?? [])],
              basePrefs: this.threadBasePrefsByThreadId[key] ?? {},
              nodeLabels: orchestrationNodeLabelsForThread(this, body.threadId),
            });
            assertThreadReadScope(scope, { history: true });
            const currentState = this.ensureConversation(body.threadId);
            assignLoadedConversationState(currentState, replayed.state);
            this.threadReplayEventsByThreadId[key] = mergedEvents.filter((event) => event.type === "item.message.deleted"
              || !currentState.deletedMessageIds?.has(getConversationMessageItemId(event) ?? ""));
            applyLoadedEngineSessionId(currentState, res.thread.sessionId);
            reapplyPendingLocalUserMessage(currentState, this.pendingLocalUserMessageByThreadId[key] ?? null, key, this.pendingLocalUserMessageByThreadId);
            const resolvedRunningState = resolveThreadRunningStateFromReplay(replayed.state, res.running ?? null);
            this.clearThreadPendingDispatch(body.threadId);
            this.applyThreadRunningState(body.threadId, resolvedRunningState);
            this.setThreadRunningHint(body.threadId, resolvedRunningState);
            this.setThreadPrefs(body.threadId, replayed.prefs, {
              readMutationEpoch: prefsMutationEpoch,
              readBasePrefs: prefsReadBase,
              readPendingPrefs: prefsReadPending,
            });

            // 更新 meta
            meta.oldestLoadedSeq = normalizeSeq(res.oldestSeq) ?? meta.oldestLoadedSeq;
            meta.hasMore = Boolean(res.hasMore);
            meta.loadedEvents += res.rawEventCount ?? res.events.length;
            appliedReplayMaxSeq = Math.max(replayed.maxSeq, normalizeSeq(res.latestSeq) ?? 0);
            dropBufferedReplayEventsThroughSeq(bufferedLiveReplayEventsByThreadId, key, appliedReplayMaxSeq);
          } finally {
            if (threadReplayLoadTokenByThreadId.get(key) === replayLoadToken) {
              threadReplayLoadTokenByThreadId.delete(key);
            }
            const bufferedTailEvents = listBufferedReplayEventsAfterSeq(
              bufferedLiveReplayEventsByThreadId,
              key,
              appliedReplayMaxSeq,
            );
            if (bufferedTailEvents.length > 0 && isThreadReadScopeCurrent(scope, { history: true })) {
              applyBufferedReplayEvents(this, body.threadId, bufferedTailEvents);
              dropBufferedReplayEventsThroughSeq(
                bufferedLiveReplayEventsByThreadId,
                key,
                maxReplayEventSeq(bufferedTailEvents),
              );
            }
          }
        });
      } catch (error) {
        if (!isCancelledRequestError(error)) throw error;
      } finally {
        if (this.threadLoadMetaByThreadId[key]) {
          this.threadLoadMetaByThreadId[key].loadingMore = false;
        }
      }
    },

    ensureConversation(threadId: ThreadId): ThreadConversationState {
      const key = String(threadId);
      const existing = this.conversations[key];
      if (existing) return existing;
      const created: ThreadConversationState = {
        threadId,
        items: [],
        tokenUsage: null,
        runningTurnId: null,
        runningTurnStartedAt: null,
        completedTurnIds: {},
        engineSessionId: null,
        currentTodolist: null,
        invalidated: false,
        _indexById: new Map(),
        _assistantTranscriptIdByItemId: new Map(),
        _assistantTranscriptIdByTurnId: new Map(),
      };
      this.conversations[key] = created;
      return created;
    },

  },
});

/** 解析 int（默认值 + 范围保护）。 */
function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function normalizeSeq(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const seq = Math.floor(n);
  return seq > 0 ? seq : null;
}

/** accepted send/compact 的回滚刷新或投影告警必须以部分成功语义返回。 */
function buildAcceptedMutationReconciliationFailure(
  acceptedLabel: string,
  result: MutationRollbackRefreshResult,
  reloadLabel: string,
): Error | null {
  const details: string[] = [];
  const causes: unknown[] = [];
  if (result.barrierError) {
    details.push(`自动回滚响应缺少有效事件屏障：${formatStoreError(result.barrierError)}`);
    causes.push(result.barrierError);
  }
  if (result.historyReloadError) {
    details.push(`${reloadLabel}：${formatStoreError(result.historyReloadError)}`);
    causes.push(result.historyReloadError);
  }
  if (result.fileChangesReloadError) {
    details.push(`自动回滚后的文件变更刷新失败：${formatStoreError(result.fileChangesReloadError)}`);
    causes.push(result.fileChangesReloadError);
  }
  if (result.rollbackProjectionSyncWarning) {
    details.push(`共享投影同步失败：${result.rollbackProjectionSyncWarning}`);
    causes.push(new Error(result.rollbackProjectionSyncWarning));
  }
  if (details.length === 0) return null;
  const cause = causes.length === 1 ? causes[0] : new AggregateError(causes, "自动回滚后置处理失败");
  return new Error(
    `${acceptedLabel}，但${details.join("；")}。主操作已经执行，请勿重复操作；请刷新会话后核对。`,
    { cause },
  );
}

/** 主请求失败但自动回滚已经提交时，保留原错误并说明本地收敛结果。 */
function buildRejectedMutationAfterRollbackFailure(
  requestLabel: string,
  requestMessage: string,
  result: MutationRollbackRefreshResult,
  runningSyncError: unknown,
): Error {
  const details: string[] = [];
  const causes: unknown[] = [];
  if (result.barrierError) {
    details.push(`自动回滚响应缺少有效事件屏障：${formatStoreError(result.barrierError)}`);
    causes.push(result.barrierError);
  }
  if (result.historyReloadError) {
    details.push(`自动回滚后的会话历史刷新失败：${formatStoreError(result.historyReloadError)}`);
    causes.push(result.historyReloadError);
  }
  if (result.fileChangesReloadError) {
    details.push(`自动回滚后的文件变更刷新失败：${formatStoreError(result.fileChangesReloadError)}`);
    causes.push(result.fileChangesReloadError);
  }
  if (result.rollbackProjectionSyncWarning) {
    details.push(`共享投影同步失败：${result.rollbackProjectionSyncWarning}；自动回滚已经执行，请勿重复操作`);
    causes.push(new Error(result.rollbackProjectionSyncWarning));
  }
  if (runningSyncError) {
    details.push(`同步会话运行状态失败：${formatStoreError(runningSyncError)}`);
    causes.push(runningSyncError);
  }
  const suffix = details.length ? `；${details.join("；")}` : "";
  const cause = causes.length === 0
    ? undefined
    : causes.length === 1
      ? causes[0]
      : new AggregateError(causes, "主请求失败后的自动回滚收敛失败");
  return new Error(`主请求失败，但自动回滚已完成（${requestLabel}）：${requestMessage}${suffix}。`, { cause });
}

/** 将已接受 mutation 的后置刷新失败显式留在当前会话，避免误导用户重复发送。 */
function appendLocalSystemNotice(
  state: ThreadConversationState,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  engine: string,
  text: string,
): void {
  applyEngineEventToConversation(state, {
    schema: 1,
    seq: nextLocalSystemNoticeSeq--,
    ts: Date.now(),
    workspaceId: workspaceId as any,
    threadId: threadId as any,
    engine: engine as any,
    type: "system.notice",
    payload: { level: "error", text },
  });
}

function buildLocalPendingUserMessageEvent(
  input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    engine: string;
    turnId: string;
    text: string;
    inputKind: SendMessageRequestBody["inputKind"];
    skillMentions: SendMessageRequestBody["skillMentions"];
    images: string[];
    files: SendMessageRequestBody["files"];
    pathReferences: SendMessageRequestBody["pathReferences"];
  },
): EngineEventEnvelope {
  return {
    schema: 1,
    seq: 0,
    ts: Date.now(),
    workspaceId: input.workspaceId as any,
    threadId: input.threadId as any,
    engine: input.engine as any,
    type: "item.userMessage.created",
    payload: {
      turnId: input.turnId as TurnId,
      itemId: `local_user_${input.turnId}` as any,
      text: input.text,
      ...(input.inputKind ? { inputKind: input.inputKind } : {}),
      ...(input.skillMentions?.length
        ? { skillMentions: input.skillMentions.map((binding) => ({ ...binding })) }
        : {}),
      images: input.images,
      files: input.files,
      pathReferences: input.pathReferences,
    },
  } satisfies EngineEventEnvelope;
}

function reconcilePendingLocalUserMessage(
  state: ThreadConversationState,
  pendingEvent: EngineEventEnvelope | null,
  incomingEvent: EngineEventEnvelope,
): boolean {
  if (!pendingEvent) return false;
  if (incomingEvent.type === "item.userMessage.engineCall.created") {
    rekeyPendingLocalUserMessage(state, pendingEvent, String(incomingEvent.payload.itemId ?? ""));
    return false;
  }
  if (incomingEvent.type !== "item.userMessage.created") return false;
  if (!pendingLocalUserMessageMatches(pendingEvent, incomingEvent)) return false;
  rekeyPendingLocalUserMessage(state, pendingEvent, String(incomingEvent.payload.itemId ?? ""));
  return true;
}

/** 重放 pending，排除已删除消息和发送前已有的同文权威消息。 */
function reapplyPendingLocalUserMessage(
  state: ThreadConversationState,
  pendingEvent: EngineEventEnvelope | null,
  threadKey: string,
  pendingByThreadId: Record<string, EngineEventEnvelope | null>,
  authoritativeItemIdsBeforePending?: ReadonlySet<string>,
): void {
  if (!pendingEvent) return;
  if (state.deletedMessageIds?.has(getConversationMessageItemId(pendingEvent) ?? "")
    || hasAuthoritativeUserMessageMatch(state, pendingEvent, authoritativeItemIdsBeforePending)) {
    delete pendingByThreadId[threadKey];
    return;
  }
  applyEngineEventToConversation(state, pendingEvent);
}

/** 收集发送前已展示的权威用户消息 ID，限定 ACK 后内容兜底的匹配范围。 */
function collectAuthoritativeUserMessageItemIds(
  state: ThreadConversationState | undefined,
): Set<string> {
  const itemIds = new Set<string>();
  for (const item of state?.items ?? []) {
    if (item?.kind !== "message" || item.role !== "user") continue;
    if (isLocalUserMessageItemId(item.id)) continue;
    itemIds.add(String(item.id));
  }
  return itemIds;
}

function rekeyPendingLocalUserMessage(
  state: ThreadConversationState,
  pendingEvent: EngineEventEnvelope,
  nextItemId: string,
): void {
  const normalizedNextItemId = String(nextItemId ?? "").trim();
  if (!normalizedNextItemId) return;
  const pendingItemId = String((pendingEvent.payload as any)?.itemId ?? "").trim();
  if (pendingItemId && pendingItemId !== normalizedNextItemId) {
    const hit = state._indexById.get(pendingItemId);
    if (hit && hit.kind === "message" && hit.role === "user") {
      state._indexById.delete(pendingItemId);
      (hit as any).id = normalizedNextItemId;
      state._indexById.set(normalizedNextItemId, hit as any);
    }
  }
  (pendingEvent.payload as any).itemId = normalizedNextItemId;
}

function pendingLocalUserMessageMatches(
  pendingEvent: EngineEventEnvelope,
  incomingEvent: EngineEventEnvelope,
): boolean {
  if (pendingEvent.type !== "item.userMessage.created" || incomingEvent.type !== "item.userMessage.created") return false;
  return samePendingUserMessageContent(pendingEvent.payload, incomingEvent.payload);
}

/** 按 turn 精确匹配；turn 不一致时仅允许新出现的同文权威消息兜底。 */
function hasAuthoritativeUserMessageMatch(
  state: ThreadConversationState,
  pendingEvent: EngineEventEnvelope,
  authoritativeItemIdsBeforePending?: ReadonlySet<string>,
): boolean {
  if (pendingEvent.type !== "item.userMessage.created") return false;
  const pendingTurnId = String(pendingEvent.payload.turnId ?? "").trim();
  const pendingTs = Number(pendingEvent.ts ?? 0);
  const lowerBoundTs = Number.isFinite(pendingTs) && pendingTs > 0 ? pendingTs - 60_000 : 0;
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i];
    if (item?.kind !== "message" || item.role !== "user") continue;
    if (isLocalUserMessageItemId(item.id)) continue;
    if (!samePendingUserMessageContent(pendingEvent.payload, item)) continue;
    const itemTurnId = String(item.turnId ?? "").trim();
    if (pendingTurnId && itemTurnId === pendingTurnId) return true;
    if (authoritativeItemIdsBeforePending?.has(String(item.id))) continue;
    const createdAt = Number(item.createdAt ?? 0);
    if (createdAt > 0 && createdAt < lowerBoundTs) continue;
    return true;
  }
  return false;
}

function samePendingUserMessageContent(
  left: { text?: string; inputKind?: SendMessageRequestBody["inputKind"]; skillMentions?: SendMessageRequestBody["skillMentions"]; images?: string[]; files?: SendMessageRequestBody["files"]; pathReferences?: SendMessageRequestBody["pathReferences"] },
  right: { text?: string; inputKind?: SendMessageRequestBody["inputKind"]; skillMentions?: SendMessageRequestBody["skillMentions"]; images?: string[]; files?: SendMessageRequestBody["files"]; pathReferences?: SendMessageRequestBody["pathReferences"] },
): boolean {
  return String(left.text ?? "") === String(right.text ?? "")
    && (left.inputKind ?? null) === (right.inputKind ?? null)
    && samePendingSkillMentions(left.skillMentions ?? [], right.skillMentions ?? [])
    && samePendingStringArray(left.images ?? [], right.images ?? [])
    && samePendingFiles(left.files ?? [], right.files ?? [])
    && samePendingPathReferences(left.pathReferences ?? [], right.pathReferences ?? []);
}

/** 比较输入动作 opaque binding，避免同文不同 Skill 被错误合并。 */
function samePendingSkillMentions(
  a: readonly NonNullable<SendMessageRequestBody["skillMentions"]>[number][],
  b: readonly NonNullable<SendMessageRequestBody["skillMentions"]>[number][],
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function isLocalUserMessageItemId(value: unknown): boolean {
  return String(value ?? "").trim().startsWith("local_user_");
}

function samePendingStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (String(a[i] ?? "") !== String(b[i] ?? "")) return false;
  }
  return true;
}

function samePendingFiles(
  a: readonly NonNullable<SendMessageRequestBody["files"]>[number][],
  b: readonly NonNullable<SendMessageRequestBody["files"]>[number][],
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** 比较本地乐观消息与权威事件的路径引用，避免重复用户消息。 */
function samePendingPathReferences(
  a: readonly NonNullable<SendMessageRequestBody["pathReferences"]>[number][],
  b: readonly NonNullable<SendMessageRequestBody["pathReferences"]>[number][],
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * 会话工作流面板快照里的 nodeId → 当前节点名；面板未加载时返回 undefined，
 * 事件文案会保留事件里冻结的旧名（不会显示 nodeId）。
 */
function orchestrationNodeLabelsForThread(
  store: Pick<ChatStore, "chatWorkflowSnapshotByThreadId">,
  threadId: string,
): OrchestrationNodeLabelMap | undefined {
  const tasks = store.chatWorkflowSnapshotByThreadId[String(threadId)]?.tasks ?? [];
  const labels = new Map<string, string>();
  for (const task of tasks) for (const stage of task.stages) labels.set(stage.nodeId, stage.label);
  return labels.size > 0 ? labels : undefined;
}

async function replayConversationEvents(opts: {
  threadId: ThreadId;
  events: readonly EngineEventEnvelope[];
  deletedMessageIds?: string[];
  basePrefs: ThreadPrefs;
  nodeLabels?: OrchestrationNodeLabelMap;
  onProgress?: (processedEvents: number, totalEvents: number) => Promise<void> | void;
}): Promise<{ state: ThreadConversationState; prefs: ThreadPrefs; maxSeq: number }> {
  const state = createEmptyConversationState(opts.threadId);
  deleteConversationMessages(state, opts.deletedMessageIds ?? []);
  let prefs = { ...opts.basePrefs };
  let maxSeq = 0;
  const total = opts.events.length;
  const shouldYield = total >= 500;
  const batchSize = Math.min(500, Math.max(100, Math.floor(total / 20)));

  for (let i = 0; i < total; i += 1) {
    const event = opts.events[i]!;
    maxSeq = Math.max(maxSeq, event.seq);
    applyEngineEventToConversation(state, event, opts.nodeLabels);
    prefs = mergeThreadPrefs(prefs, extractThreadPrefsPatchFromConversationEvent(event));

    if (shouldYield && opts.onProgress && (i + 1) % batchSize === 0) {
      await opts.onProgress(i + 1, total);
    }
  }

  return { state, prefs, maxSeq };
}

function createEmptyConversationState(threadId: ThreadId): ThreadConversationState {
  return {
    threadId,
    items: [],
    _indexById: new Map(),
    _assistantTranscriptIdByItemId: new Map(),
    _assistantTranscriptIdByTurnId: new Map(),
    tokenUsage: null,
    runningTurnId: null,
    runningTurnStartedAt: null,
    completedTurnIds: {},
    engineSessionId: null,
    currentTodolist: null,
    invalidated: false,
  };
}

function assignConversationState(target: ThreadConversationState, next: ThreadConversationState): void {
  target.items = next.items;
  target.deletedMessageIds = next.deletedMessageIds;
  target._indexById = next._indexById;
  target._assistantTranscriptIdByItemId = next._assistantTranscriptIdByItemId;
  target._assistantTranscriptIdByTurnId = next._assistantTranscriptIdByTurnId;
  target.tokenUsage = next.tokenUsage;
  target.runningTurnId = next.runningTurnId;
  target.runningTurnStartedAt = next.runningTurnStartedAt;
  target.completedTurnIds = next.completedTurnIds;
  target.engineSessionId = next.engineSessionId;
  target.currentTodolist = next.currentTodolist;
  target.invalidated = next.invalidated;
}

/** 更早窗口按 ID 去重后置于前部；当前窗口的实时更新优先保留。 */
function mergePresentationItems(older: readonly ConversationItem[], current: readonly ConversationItem[]): ConversationItem[] {
  const currentIds = new Set(current.map(item => String(item.id)));
  return [...older.filter(item => !currentIds.has(String(item.id))), ...current];
}

/** 将历史回放写入现有会话；缺少 binding 时保留已知的内存 ID，但不影响清空重置。 */
function assignLoadedConversationState(target: ThreadConversationState, next: ThreadConversationState): void {
  const previousEngineSessionId = String(target.engineSessionId ?? "").trim();
  deleteConversationMessages(next, target.deletedMessageIds ?? []);
  assignConversationState(target, next);
  const replayedEngineSessionId = String(target.engineSessionId ?? "").trim();
  target.engineSessionId = replayedEngineSessionId || previousEngineSessionId || null;
}

/** 仅用 load 响应中的非空 binding 补齐会话投影，避免空值覆盖已有 ID。 */
function applyLoadedEngineSessionId(state: ThreadConversationState, sessionId: string | null | undefined): void {
  const normalized = String(sessionId ?? "").trim();
  if (normalized) state.engineSessionId = normalized;
}

function resetThreadProjectionForClear(store: ChatStore, threadId: ThreadId): void {
  const key = String(threadId);
  cancelAcceptedTurnContentReconcileForThread(threadId);
  delete store.loadedThreads[key];
  delete store.threadLoadMetaByThreadId[key];
  delete store.threadReplayEventsByThreadId[key];
  delete store.threadPresentationVersionByThreadId[key];
  delete store.threadPresentationRequiredVersionByThreadId[key];
  delete store.threadPresentationErrorByThreadId[key];
  store.threadContentEpochByThreadId[key] = (store.threadContentEpochByThreadId[key] ?? 0) + 1;
  delete store.threadRunningHintByThreadId[key];
  delete store.threadPendingDispatchByThreadId[key];
  delete store.pendingLocalUserMessageByThreadId[key];
  delete store.threadHasRealTurnActivityByThreadId[key];
  bufferedLiveReplayEventsByThreadId.delete(key);
  threadReplayLoadTokenByThreadId.delete(key);
  const state = store.ensureConversation(threadId);
  assignConversationState(state, createEmptyConversationState(threadId));
}

/** 移除已删除会话的全部前端投影与资源缓存，不触发网络刷新。 */
function dropDeletedThreadState(store: ChatStore, threadId: ThreadId): void {
  store.threadListCache = {};
  const key = String(threadId);
  for (const [owner, surface] of threadPresentationSurfaces.get(store.$state) ?? []) {
    if (String(surface.threadId) === key) store.setThreadPresentationSurface(owner, null);
  }
  cancelAcceptedTurnContentReconcileForThread(threadId);
  store.invalidateThreadScopes(threadId, { reason: "delete" });
  bumpThreadPrefsWriteEpoch(key);
  store.clearThreadManagedServicesScope(threadId, "delete");
  store.releasePrimaryThreadSurface(threadId);
  delete store.conversations[key];
  delete store.loadedThreads[key];
  delete store.threadLoadMetaByThreadId[key];
  delete store.fileChangesByThreadId[key];
  delete store.threadPrefsByThreadId[key];
  delete store.pendingThreadPrefsByThreadId[key];
  threadPrefsMutationEpochByThreadId.delete(key);
  threadPrefsPendingRevisionByThreadId.delete(key);
  threadPrefsPendingMetaByThreadId.delete(key);
  delete store.threadDraftVersionByThreadId[key];
  delete store.threadDraftByThreadId[key];
  delete store.pendingLocalThreadDraftByThreadId[key];
  delete store.pendingLocalThreadDraftEpochByThreadId[key];
  delete store.threadBasePrefsByThreadId[key];
  delete store.threadReplayEventsByThreadId[key];
  delete store.threadPresentationVersionByThreadId[key];
  delete store.threadPresentationRequiredVersionByThreadId[key];
  delete store.threadPresentationErrorByThreadId[key];
  delete store.threadRollbackEventSeqBarrierByThreadId[key];
  delete store.threadRunningHintByThreadId[key];
  delete store.threadPendingDispatchByThreadId[key];
  delete store.pendingLocalUserMessageByThreadId[key];
  delete store.threadHasRealTurnActivityByThreadId[key];
  delete store.extraThreadSummariesById[key];
  delete store.threadContentEpochByThreadId[key];
  delete store.threadActivationByThreadId[key];
  delete store.chatWorkflowSnapshotByThreadId[key];
  threadHistoryScopeEpochByThreadId.delete(key);
  threadDraftVersionSignalByThreadId.delete(key);
  bufferedLiveReplayEventsByThreadId.delete(key);
  threadReplayLoadTokenByThreadId.delete(key);
  store.threads = store.threads.filter((thread) => String(thread.id) !== key);
  if (String(store.threadLoading?.threadId ?? "") === key) {
    store.threadLoadingToken += 1;
    store.threadLoading = null;
  }
  if (String(store.selectedThreadId ?? "") === key) {
    store.clearPrimaryThreadSelection({ clearUrl: true, reason: "delete" });
  }
}

/** 从回放结果和 API running 合成进入会话后的运行态，runtime 来源优先保留以便用户可停止。 */
function resolveThreadRunningStateFromReplay(
  replayedState: ThreadConversationState,
  apiRunning: ThreadRunningState | null | undefined,
): ThreadRunningState | null {
  const apiRunningTurnId = String(apiRunning?.runningTurnId ?? "").trim();
  if (apiRunningTurnId && apiRunning?.runningSource === "runtime") return apiRunning ?? null;

  const replayedRunningTurnId = String(replayedState.runningTurnId ?? "").trim();
  if (replayedRunningTurnId) {
    return {
      runningTurnId: replayedRunningTurnId as TurnId,
      runningTurnStartedAt: replayedState.runningTurnStartedAt ?? Date.now(),
    };
  }

  if (!apiRunningTurnId) return null;
  if (replayedState.completedTurnIds[apiRunningTurnId] && apiRunning?.runningSource !== "runtime") return null;
  return apiRunning ?? null;
}

function resolveCanonicalRunningStateFromConversation(
  conversations: Record<string, ThreadConversationState>,
  threadId: ThreadId | null,
): ThreadRunningState | null {
  if (!threadId) return null;
  const conversation = conversations[String(threadId)] ?? null;
  const runningTurnId = String(conversation?.runningTurnId ?? "").trim();
  if (!runningTurnId) return null;
  return {
    runningTurnId: runningTurnId as TurnId,
    runningTurnStartedAt: Number(conversation?.runningTurnStartedAt ?? Date.now()),
  };
}

/** 同一 turn 合并回放身份与权威停止阶段，后继回合不能继承旧阶段。 */
function resolveDisplayRunningStateFromState(
  conversations: Record<string, ThreadConversationState>,
  loadedThreads: Record<string, boolean>,
  threadRunningHintByThreadId: Record<string, ThreadRunningHintState | null>,
  threadPendingDispatchByThreadId: Record<string, PendingDispatchState | null>,
  threadId: ThreadId | null,
): ThreadRunningState | null {
  if (!threadId) return null;
  const key = String(threadId);
  const isHydrated = Boolean(loadedThreads[key]);
  const canonical = resolveCanonicalRunningStateFromConversation(conversations, threadId);
  const hintEntry = threadRunningHintByThreadId[key] ?? null;
  const pendingDispatch = threadPendingDispatchByThreadId[key] ?? null;

  if (hintEntry) {
    if (hintEntry.source === "authoritative") {
      const hintRunning = hintEntry.running;
      if (hintRunning) {
        if (canonical && String(canonical.runningTurnId ?? "") === String(hintRunning.runningTurnId ?? "")) {
          return { ...canonical, ...(hintRunning.phase ? { phase: hintRunning.phase } : {}),
            ...(hintRunning.runningSource ? { runningSource: hintRunning.runningSource } : {}),
            ...(hintRunning.failureCode ? { failureCode: hintRunning.failureCode } : {}) };
        }
        return hintRunning;
      }
      if (pendingDispatch?.turnId) {
        return {
          runningTurnId: pendingDispatch.turnId,
          runningTurnStartedAt: pendingDispatch.requestedAt,
        };
      }
      return null;
    }
    if (isHydrated) {
      if (canonical) return canonical;
      if (pendingDispatch?.turnId) {
        return {
          runningTurnId: pendingDispatch.turnId,
          runningTurnStartedAt: pendingDispatch.requestedAt,
        };
      }
      return null;
    }
    if (hintEntry.running) {
      return hintEntry.running;
    }
    if (pendingDispatch?.turnId) {
      return {
        runningTurnId: pendingDispatch.turnId,
        runningTurnStartedAt: pendingDispatch.requestedAt,
      };
    }
    return null;
  }

  if (canonical) return canonical;
  if (pendingDispatch?.turnId) {
    return {
      runningTurnId: pendingDispatch.turnId,
      runningTurnStartedAt: pendingDispatch.requestedAt,
    };
  }
  return null;
}

function resolveDisplayConversationFromState(
  conversations: Record<string, ThreadConversationState>,
  loadedThreads: Record<string, boolean>,
  threadRunningHintByThreadId: Record<string, ThreadRunningHintState | null>,
  threadPendingDispatchByThreadId: Record<string, PendingDispatchState | null>,
  threadId: ThreadId | null,
): ThreadConversationState | null {
  if (!threadId) return null;
  const conversation = conversations[String(threadId)] ?? null;
  if (!conversation) return null;
  const displayRunning = resolveDisplayRunningStateFromState(
    conversations,
    loadedThreads,
    threadRunningHintByThreadId,
    threadPendingDispatchByThreadId,
    threadId,
  );
  const canonicalRunningTurnId = String(conversation.runningTurnId ?? "").trim();
  const displayRunningTurnId = String(displayRunning?.runningTurnId ?? "").trim();
  const canonicalStartedAt = Number(conversation.runningTurnStartedAt ?? 0);
  const displayStartedAt = Number(displayRunning?.runningTurnStartedAt ?? 0);
  if (
    canonicalRunningTurnId === displayRunningTurnId
    && canonicalStartedAt === displayStartedAt
  ) {
    return conversation;
  }
  return {
    ...conversation,
    runningTurnId: displayRunning?.runningTurnId ?? null,
    runningTurnStartedAt: displayRunning?.runningTurnStartedAt ?? null,
  };
}

function appendReplayEvent(
  replayEventsByThreadId: Record<string, EngineEventEnvelope[]>,
  event: EngineEventEnvelope,
): void {
  const key = String(event.threadId);
  replayEventsByThreadId[key] = appendReplayEventToList(replayEventsByThreadId[key], event);
}

const replayEventHighWaterByList = new WeakMap<readonly EngineEventEnvelope[], {
  length: number; first: EngineEventEnvelope; last: EngineEventEnvelope; maxSeq: number;
}>();

/** 递增实时事件按派生高水位跳过扫描；迟到序号仍检查原事件及压缩子事件范围。 */
function hasReplayEventSeq(events: readonly EngineEventEnvelope[] | undefined, rawSeq: unknown): boolean {
  const seq = normalizeSeq(rawSeq);
  if (seq == null || !events?.length) return false;
  const cached = replayEventHighWaterByList.get(events);
  let maxSeq: number;
  // 回放裁剪/替换产生新数组，压缩只替换末项；仅未变的追加前缀允许增量复用。
  if (cached && events.length >= cached.length && events[0] === cached.first && events[cached.length - 1] === cached.last) {
    maxSeq = cached.maxSeq;
    for (let index = cached.length; index < events.length; index++) maxSeq = Math.max(maxSeq, normalizeSeq(events[index]!.seq) ?? 0);
  } else maxSeq = maxReplayEventSeq(events);
  replayEventHighWaterByList.set(events, { length: events.length, first: events[0]!, last: events.at(-1)!, maxSeq });
  if (seq > maxSeq) return false;
  return events.some((event) => normalizeSeq(event.seq) === seq || event.type === "item.subagent.childEvent"
    && event.replayFromSeq != null && event.replayFromSeq <= seq && seq <= event.seq);
}

/** 判断 WS 事件是否落在 rollback 已裁剪的 seq 区间，canonical cache 中保留的事件除外。 */
function isBlockedByRollbackEventSeqBarrier(
  barriersByThreadId: Record<string, number | null>,
  replayEventsByThreadId: Record<string, EngineEventEnvelope[]>,
  event: EngineEventEnvelope,
): boolean {
  const key = String(event.threadId);
  const barrier = barriersByThreadId[key];
  if (barrier == null) return false;
  if (!Number.isSafeInteger(barrier) || barrier <= 0) {
    throw new Error(`rollback 事件屏障状态非法：threadId=${key}, barrier=${String(barrier)}`);
  }
  const seq = normalizeSeq(event.seq);
  return seq != null && seq <= barrier && !hasReplayEventSeq(replayEventsByThreadId[key], seq);
}

type TerminalTurnEvent = Extract<EngineEventEnvelope, { type: "turn.completed" | "turn.error" }>;

/** 仅让当前显示 turn 的终态清理 running hint，避免旧 turn 迟到终态开放输入。 */
function settleTerminalRunningState(
  store: Pick<ChatStore, "clearThreadPendingDispatch" | "setThreadRunningHint">,
  event: TerminalTurnEvent,
  displayRunningTurnIdBeforeEvent: string,
): void {
  const terminalTurnId = String(event.payload.turnId ?? "").trim();
  if (terminalTurnId && terminalTurnId !== displayRunningTurnIdBeforeEvent) return;
  store.clearThreadPendingDispatch(event.threadId);
  store.setThreadRunningHint(event.threadId, null);
}

/** 收窄 turn 终态事件，供 live 与 buffered replay 复用同一清理规则。 */
function isTerminalTurnEvent(event: EngineEventEnvelope): event is TerminalTurnEvent {
  return event.type === "turn.completed" || event.type === "turn.error";
}

function listBufferedReplayEvents(
  replayEventsByThreadId: Map<string, EngineEventEnvelope[]>,
  threadId: string,
): EngineEventEnvelope[] {
  const current = replayEventsByThreadId.get(threadId) ?? [];
  return current.length > 0 ? [...current] : [];
}

function listBufferedReplayEventsAfterSeq(
  replayEventsByThreadId: Map<string, EngineEventEnvelope[]>,
  threadId: string,
  seqExclusive: number,
): EngineEventEnvelope[] {
  return listBufferedReplayEvents(replayEventsByThreadId, threadId)
    .filter((event) => {
      const seq = normalizeSeq(event.seq);
      if (seq == null) return false;
      return seq > seqExclusive;
    });
}

/** 子任务实时事件保留独立序号，允许历史窗口替换重叠部分并保留实时尾部。 */
function appendReplayEventToList(
  current: EngineEventEnvelope[] | undefined,
  event: EngineEventEnvelope,
): EngineEventEnvelope[] {
  if (!current || current.length === 0) return [event];

  const last = current[current.length - 1]!;
  const merged = compressConversationEvents([last, event], { subagentChildEvents: false });
  if (merged.length === 1) {
    current[current.length - 1] = merged[0]!;
    return current;
  }
  current.push(event);
  return current;
}

function dropBufferedReplayEventsThroughSeq(
  replayEventsByThreadId: Map<string, EngineEventEnvelope[]>,
  threadId: string,
  maxAppliedSeq: number,
): void {
  if (!Number.isFinite(maxAppliedSeq) || maxAppliedSeq <= 0) return;
  const current = replayEventsByThreadId.get(threadId) ?? [];
  if (!current.length) return;
  const remaining = current.filter((event) => {
    const seq = normalizeSeq(event.seq);
    if (seq == null) return true;
    return seq > maxAppliedSeq;
  });
  if (remaining.length > 0) {
    replayEventsByThreadId.set(threadId, remaining);
    return;
  }
  replayEventsByThreadId.delete(threadId);
}

function maxReplayEventSeq(events: readonly EngineEventEnvelope[]): number {
  let maxSeq = 0;
  for (const event of events) {
    const seq = normalizeSeq(event.seq);
    if (seq != null) maxSeq = Math.max(maxSeq, seq);
  }
  return maxSeq;
}

function nextReplayLoadToken(): number {
  threadReplayLoadGeneration += 1;
  return threadReplayLoadGeneration;
}

/** 历史窗口覆盖区间内的子任务缓存；窗口外事件保持原序号，避免重叠增量拼接。 */
function mergeReplayEventWindows(
  history: { events: readonly EngineEventEnvelope[]; oldestSeq?: number | null; latestSeq?: number | null },
  ...windows: Array<readonly EngineEventEnvelope[] | undefined>
): EngineEventEnvelope[] {
  const bySeq = new Map<number, EngineEventEnvelope>();
  const oldestSeq = normalizeSeq(history.oldestSeq) ?? normalizeSeq(history.events[0]?.seq);
  const latestSeq = normalizeSeq(history.latestSeq) ?? normalizeSeq(history.events.at(-1)?.seq);
  for (const event of history.events) {
    const seq = normalizeSeq(event.seq);
    if (seq != null) bySeq.set(seq, event);
  }
  for (const window of windows) {
    if (!window || window.length === 0) continue;
    for (const event of window) {
      const seq = normalizeSeq(event.seq);
      if (seq == null || bySeq.has(seq)) continue;
      if (event.type === "item.subagent.childEvent" && oldestSeq != null && latestSeq != null
        && oldestSeq <= seq && seq <= latestSeq) continue;
      bySeq.set(seq, event);
    }
  }

  if (bySeq.size === 0) return [];
  const merged = Array.from(bySeq.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, event]) => event);
  return compressConversationEvents(merged, { subagentChildEvents: false });
}

function applyBufferedReplayEvents(
  store: Pick<ChatStore, "ensureConversation" | "setThreadPrefs" | "setThreadRunningHint" | "clearThreadPendingDispatch" | "threadDisplayRunningStateForThread" | "threadReplayEventsByThreadId" | "threadPrefsByThreadId" | "fileChangeTick" | "markManagedServicesChanged" | "markThreadFileChangesChanged" | "chatWorkflowSnapshotByThreadId">,
  threadId: ThreadId,
  events: readonly EngineEventEnvelope[],
): void {
  if (events.length === 0) return;
  const state = store.ensureConversation(threadId);
  const nodeLabels = orchestrationNodeLabelsForThread(store, threadId);
  for (const event of events) {
    appendReplayEvent(store.threadReplayEventsByThreadId, event);
    const displayRunningTurnIdBeforeEvent = isTerminalTurnEvent(event)
      ? String(store.threadDisplayRunningStateForThread(threadId)?.runningTurnId ?? "").trim()
      : "";
    applyEngineEventToConversation(state, event, nodeLabels);
    if (event.type === "turn.started") {
      store.clearThreadPendingDispatch(threadId);
      store.setThreadRunningHint(threadId, {
        runningTurnId: String(state.runningTurnId ?? event.payload.turnId ?? "") as TurnId,
        runningTurnStartedAt: Number(state.runningTurnStartedAt ?? event.ts ?? Date.now()),
      });
    }
    if (event.type === "turn.completed" || event.type === "turn.error") {
      settleTerminalRunningState(store, event, displayRunningTurnIdBeforeEvent);
    }
    if (
      event.type === "item.tool.completed" &&
      Array.isArray((event.payload as any).changes) &&
      (event.payload as any).changes.length > 0 &&
      isFileMutationTool((event.payload as any).toolName)
    ) {
      store.fileChangeTick += 1;
      store.markThreadFileChangesChanged(threadId);
    }
    if (event.type === "item.tool.completed" && isManagedServiceToolEvent(event.payload)) {
      // 历史回放里出现过“进程”工具时，补一次当前列表刷新，避免首屏仍显示旧状态。
      store.markManagedServicesChanged(threadId);
    }
    if (event.type === "thread.process.changed") {
      store.markManagedServicesChanged(threadId);
    }
    const prefsPatch = extractThreadPrefsPatchFromConversationEvent(event);
    if (prefsPatch) {
      const key = String(event.threadId);
      const current = store.threadPrefsByThreadId[key] ?? {};
      store.setThreadPrefs(event.threadId, mergeThreadPrefs(current, prefsPatch));
    }
  }
}

function resolveThreadSummaryFromCollections(
  list: ThreadSummary[],
  extraById: Record<string, ThreadSummary>,
  threadId: ThreadId | null,
): ThreadSummary | null {
  if (!threadId) return null;
  const key = String(threadId);
  return list.find((item) => String(item.id) === key) ?? extraById[key] ?? null;
}

function pruneExtraThreadSummaries(
  extraById: Record<string, ThreadSummary>,
  pagedThreads: ThreadSummary[],
): Record<string, ThreadSummary> {
  if (!Object.keys(extraById).length) return extraById;
  const visibleIds = new Set(pagedThreads.map((item) => String(item.id)));
  const next: Record<string, ThreadSummary> = {};
  for (const [key, value] of Object.entries(extraById)) {
    if (visibleIds.has(key)) continue;
    next[key] = value;
  }
  return next;
}

/** 原位更新已加载摘要；新摘要放入额外集合，避免后台活动重排当前列表。 */
function upsertThreadSummary(
  list: ThreadSummary[],
  extraById: Record<string, ThreadSummary>,
  value: ThreadSummary,
): void {
  const key = String(value.id);
  const index = list.findIndex((item) => String(item.id) === key);
  if (index >= 0) {
    list[index] = value;
    delete extraById[key];
    return;
  }
  extraById[key] = value;
}

function createEmptyManagedServicesResourceState(): ManagedServicesResourceState {
  return {
    loading: false,
    items: [],
    error: null,
    version: 0,
    refreshTick: 0,
    hydrated: false,
    stale: false,
  };
}

function createEmptyFileChangesResourceState(): FileChangesResourceState {
  return {
    loading: false,
    items: [],
    error: null,
    version: 0,
    refreshTick: 0,
    hydrated: false,
    stale: false,
  };
}

function createEmptyThreadActivationState(threadId: ThreadId | null): ThreadActivationState {
  return {
    key: null,
    owner: null,
    threadId,
    phase: "idle",
    contentEpoch: 0,
  };
}

function resolveThreadActivationStateFromThreadState(
  statesByThreadId: Record<string, ThreadActivationState>,
  contentEpochByThreadId: Record<string, number>,
  threadId: ThreadId | null,
): ThreadActivationState {
  if (!threadId) return createEmptyThreadActivationState(null);
  const key = String(threadId);
  const current = statesByThreadId[key] ?? createEmptyThreadActivationState(threadId);
  return {
    ...current,
    threadId,
    contentEpoch: contentEpochByThreadId[key] ?? current.contentEpoch,
  };
}

function normalizeThreadManagedServicesScope(scope: ThreadManagedServicesScope | null | undefined): ThreadManagedServicesScope {
  return {
    visible: Boolean(scope?.visible),
    threadId: scope?.threadId ? String(scope.threadId).trim() as ThreadId : null,
  };
}

function resolveManagedServicesScopeFromThreadState(
  scopesByThreadId: Record<string, ThreadManagedServicesScope | null>,
  threadId: ThreadId | null,
): ThreadManagedServicesScope {
  if (!threadId) return { visible: false, threadId: null };
  return normalizeThreadManagedServicesScope(scopesByThreadId[String(threadId)] ?? null);
}

function resolveManagedServicesStateFromThreadState(
  scopesByThreadId: Record<string, ThreadManagedServicesScope | null>,
  statesByThreadId: Record<string, ManagedServicesResourceState>,
  threadId: ThreadId | null,
): ManagedServicesResourceState {
  const scope = resolveManagedServicesScopeFromThreadState(scopesByThreadId, threadId);
  const ownerThreadId = String(scope.threadId ?? "").trim();
  if (!scope.visible || !ownerThreadId) return createEmptyManagedServicesResourceState();
  return statesByThreadId[ownerThreadId] ?? createEmptyManagedServicesResourceState();
}

function hasFileChangesStructuralChange(
  leftItems: readonly ThreadFileChangeSummary[],
  rightItems: readonly ThreadFileChangeSummary[],
): boolean {
  if (leftItems.length !== rightItems.length) return true;
  for (let index = 0; index < leftItems.length; index += 1) {
    const left = leftItems[index];
    const right = rightItems[index];
    if (!left || !right) return true;
    if (
      left.path !== right.path
      || left.status !== right.status
      || left.lastTurnId !== right.lastTurnId
      || left.lastChangedAt !== right.lastChangedAt
      || left.canUndo !== right.canUndo
      || left.stepKey !== right.stepKey
      || left.isAccepted !== right.isAccepted
      || left.acceptedBlobId !== right.acceptedBlobId
    ) {
      return true;
    }
  }
  return false;
}

function hasManagedServicesStructuralChange(
  leftItems: readonly ManagedServiceSnapshot[],
  rightItems: readonly ManagedServiceSnapshot[],
): boolean {
  if (leftItems.length !== rightItems.length) return true;
  for (let index = 0; index < leftItems.length; index += 1) {
    const left = leftItems[index];
    const right = rightItems[index];
    if (!left || !right) return true;
    if (
      left.serviceId !== right.serviceId
      || String(left.displayName ?? "") !== String(right.displayName ?? "")
      || String(left.source ?? "") !== String(right.source ?? "")
      || left.status !== right.status
      || Boolean(left.stopSupported) !== Boolean(right.stopSupported)
      || left.pid !== right.pid
      || left.command !== right.command
      || left.workingDirectory !== right.workingDirectory
      || left.startupTimeoutMs !== right.startupTimeoutMs
      || left.readySummary !== right.readySummary
      || left.startedAt !== right.startedAt
      || left.readyAt !== right.readyAt
      || left.exitedAt !== right.exitedAt
      || left.exitCode !== right.exitCode
      || left.exitSignal !== right.exitSignal
    ) {
      return true;
    }
    if (!sameStringArray(left.args, right.args)) return true;
  }
  return false;
}

function isManagedServiceToolEvent(payload: { toolName?: unknown; output?: unknown } | null | undefined): boolean {
  const toolName = String(payload?.toolName ?? "").trim();
  if (toolName === "管理进程" || toolName === "管理本地进程") return true;
  const output = payload?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const status = String((output as Record<string, unknown>).status ?? "").trim();
  const serviceId = String((output as Record<string, unknown>).serviceId ?? "").trim();
  const action = String((output as Record<string, unknown>).action ?? "").trim();
  if (!serviceId || !action) return false;
  return status === "starting" || status === "ready" || status === "stopped" || status === "exited";
}

function sameStringArray(left: readonly string[] | null | undefined, right: readonly string[] | null | undefined): boolean {
  const leftItems = left ?? [];
  const rightItems = right ?? [];
  if (leftItems.length !== rightItems.length) return false;
  for (let index = 0; index < leftItems.length; index += 1) {
    if (leftItems[index] !== rightItems[index]) return false;
  }
  return true;
}

function safeParseJsonRecord(raw: unknown): Record<string, unknown> | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 判断工具是否为文件写入类工具（edit / write / delete 等）。
 * 注意：Read 工具在 display 模式下也会携带 changes（用于 UI 展示路径摘要），
 * 但不是实际文件变更，不应触发文件列表刷新。
 *
 * 工具名列表须与 server 端 `isFileChangeLikeTool`（toolFilePaths.ts）保持一致。
 */
/** 文件变更计数与 Git 自动刷新共用 utils/toolActivity 里的同一份工具名单，避免两边口径分叉。 */
function isFileMutationTool(toolName: unknown): boolean {
  return isFileMutationToolName(toolName);
}

/** 恢复分页视图，同时保留仍打开会话的摘要；实时运行态由原有事件入口维护。 */
function applyThreadListSnapshot(store: ChatStore, snapshot: ThreadListSnapshot): void {
  const selectedSummary = store.getThreadSummary(store.selectedThreadId);
  if (selectedSummary) store.extraThreadSummariesById[String(selectedSummary.id)] = selectedSummary;
  store.threads = [...snapshot.threads];
  store.extraThreadSummariesById = pruneExtraThreadSummaries(store.extraThreadSummariesById, store.threads);
  store.threadsHasMore = snapshot.hasMore;
  store.threadsNextCursor = snapshot.nextCursor;
}

/** 仅缓存成功加载的分页，限制搜索与筛选组合数量，避免长期驻留无限增长。 */
function cacheThreadListSnapshot(store: ChatStore, key: string): void {
  delete store.threadListCache[key];
  store.threadListCache[key] = { threads: [...store.threads], hasMore: store.threadsHasMore, nextCursor: store.threadsNextCursor };
  const keys = Object.keys(store.threadListCache);
  if (keys.length > 12) delete store.threadListCache[keys[0]!];
}

/** 身份与查询共同隔离缓存；登录/工作区重置沿用既有 generation 生命周期。 */
function serializeThreadListCacheKey(ctx: ApiRequestContext, scope: WorkspaceReadScopeSnapshot): string {
  return JSON.stringify([ctx.serverWsOrigin, ctx.webSessionId, ctx.desktopClientId ?? null, serializeWorkspaceReadScope(scope)]);
}

/** 冻结当前列表条件，供请求去重和迟到响应校验共用。 */
function captureWorkspaceReadScope(
  workspaceId: WorkspaceId,
  threadListScope: ThreadListScope,
  threadListSearch: string,
  threadListSort: ThreadListSort,
  threadGroupId: ThreadGroupFilterId,
  onlyRelatedToMe: boolean | null,
): WorkspaceReadScopeSnapshot {
  return {
    generation: chatReadGeneration,
    workspaceId: String(workspaceId),
    readScopeEpoch: getScopeEpoch(threadListReadScopeEpochByWorkspaceId, String(workspaceId)),
    threadListScope,
    threadListSearch,
    threadListSort,
    threadGroupId,
    onlyRelatedToMe,
  };
}

function serializeWorkspaceReadScope(scope: WorkspaceReadScopeSnapshot): string {
  return `${scope.generation}:${scope.workspaceId}:${scope.readScopeEpoch}:${scope.threadListScope}:${scope.threadListSearch}:${scope.threadListSort}:${scope.threadGroupId ?? "all_groups"}:${scope.onlyRelatedToMe ?? "all"}`;
}

function isWorkspaceReadScopeCurrent(scope: WorkspaceReadScopeSnapshot): boolean {
  return scope.generation === chatReadGeneration
    && scope.readScopeEpoch === getScopeEpoch(threadListReadScopeEpochByWorkspaceId, scope.workspaceId)
    && scope.threadListScope === resolveThreadListScope()
    && scope.threadListSearch === useChatStore().threadListSearch
    && scope.threadListSort === resolveThreadListSort()
    && scope.threadGroupId === resolveEffectiveThreadGroupId(scope.threadListScope, useChatStore().activeThreadGroupId)
    && scope.onlyRelatedToMe === resolveThreadListOnlyRelatedToMe(scope.workspaceId as WorkspaceId, useChatStore().threadListOnlyRelatedToMe);
}

/** 除查询条件外校验当前身份，防止分类往返后旧请求回写。 */
function assertWorkspaceReadScope(scope: WorkspaceReadScopeSnapshot, cacheKey: string): void {
  if (!isWorkspaceReadScopeCurrent(scope) || useChatStore().activeThreadListCacheKey !== cacheKey) {
    throw createCancelledRequestError("stale-result");
  }
}

function resolveThreadListScope(): ThreadListScope {
  return normalizeThreadListScope(useUiStore().threadFilterTab, "current");
}

/** 读取当前会话列表排序，兼容旧持久化值。 */
function resolveThreadListSort(raw?: ThreadListSort | null): ThreadListSort {
  return normalizeThreadListSort(raw ?? useUiStore().threadListSort, "activity_desc");
}

/** 归一化会话列表标题搜索词，保证请求和 stale 判断使用同一口径。 */
function normalizeThreadListSearch(raw: unknown): string {
  return String(raw ?? "").trim();
}

/** 归一化当前分组筛选；空值表示全部分组。 */
function normalizeThreadGroupFilterId(raw: unknown): ThreadGroupFilterId {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  return value === "ungrouped" ? "ungrouped" : (value as ThreadGroupId);
}

/** 只有自建会话列表应用分组筛选，流程/全部/归档列表忽略隐藏的分组选中态。 */
function resolveEffectiveThreadGroupId(scope: ThreadListScope, raw: unknown): ThreadGroupFilterId {
  return scope === "current" ? normalizeThreadGroupFilterId(raw) : null;
}

/** 判断调用方是否显式传入分组筛选，区分“沿用当前值”和“清空筛选”。 */
function hasThreadGroupOption(opts?: ThreadListQueryOptions): boolean {
  return Boolean(opts && Object.prototype.hasOwnProperty.call(opts, "groupId"));
}

/** 共享工作区默认只看本人相关会话；本地工作区不携带该筛选参数。 */
function resolveThreadListOnlyRelatedToMe(workspaceId: WorkspaceId, raw: unknown): boolean | null {
  if (!isSharedWorkspaceSelectionId(String(workspaceId))) return null;
  if (raw == null) return true;
  return Boolean(raw);
}

function captureThreadReadScope(workspaceId: WorkspaceId, threadId: ThreadId): ThreadReadScopeSnapshot {
  const key = String(threadId);
  return {
    generation: chatReadGeneration,
    workspaceId: String(workspaceId),
    threadId: key,
    readScopeEpoch: getScopeEpoch(threadReadScopeEpochByThreadId, key),
    historyScopeEpoch: getScopeEpoch(threadHistoryScopeEpochByThreadId, key),
    resourceScopeEpoch: getScopeEpoch(threadResourceScopeEpochByThreadId, key),
  };
}

function captureThreadResourceScope(workspaceId: WorkspaceId, threadId: ThreadId): ThreadReadScopeSnapshot {
  return captureThreadReadScope(workspaceId, threadId);
}

function captureManagedServicesScope(workspaceId: WorkspaceId, threadId: ThreadId): ManagedServicesScopeSnapshot {
  const key = String(threadId);
  return {
    generation: chatReadGeneration,
    workspaceId: String(workspaceId),
    threadId: key,
    resourceScopeEpoch: getScopeEpoch(managedServiceResourceScopeEpochByThreadId, key),
  };
}

function serializeThreadReadScope(scope: ThreadReadScopeSnapshot): string {
  return `${scope.generation}:${scope.workspaceId}:${scope.threadId}:${scope.readScopeEpoch}`;
}

/** 历史读取额外携带独立代际，避免历史清理误伤其它 thread 资源。 */
function serializeThreadHistoryScope(scope: ThreadReadScopeSnapshot): string {
  return `${serializeThreadReadScope(scope)}:${scope.historyScopeEpoch}`;
}

function serializeThreadResourceScope(scope: ThreadReadScopeSnapshot): string {
  return `${serializeThreadReadScope(scope)}:${scope.resourceScopeEpoch}`;
}

function serializeManagedServicesScope(scope: ManagedServicesScopeSnapshot): string {
  return `${scope.generation}:${scope.workspaceId}:${scope.threadId}:${scope.resourceScopeEpoch}`;
}

function isThreadReadScopeCurrent(scope: ThreadReadScopeSnapshot, opts?: { history?: boolean; resource?: boolean }): boolean {
  if (scope.generation !== chatReadGeneration) return false;
  if (scope.readScopeEpoch !== getScopeEpoch(threadReadScopeEpochByThreadId, scope.threadId)) return false;
  if (opts?.history && scope.historyScopeEpoch !== getScopeEpoch(threadHistoryScopeEpochByThreadId, scope.threadId)) return false;
  if (opts?.resource && scope.resourceScopeEpoch !== getScopeEpoch(threadResourceScopeEpochByThreadId, scope.threadId)) return false;
  return true;
}

function isManagedServicesScopeCurrent(scope: ManagedServicesScopeSnapshot): boolean {
  if (scope.generation !== chatReadGeneration) return false;
  return scope.resourceScopeEpoch === getScopeEpoch(managedServiceResourceScopeEpochByThreadId, scope.threadId);
}

function assertThreadReadScope(scope: ThreadReadScopeSnapshot, opts?: { history?: boolean; resource?: boolean }): void {
  if (!isThreadReadScopeCurrent(scope, opts)) {
    throw createCancelledRequestError("stale-result");
  }
}

/** 未显式传 token 的非 Composer 调用沿用当前代际；Composer 必须校验捕获的代际。 */
function isThreadDraftWorkspaceScopeCurrent(workspaceScopeToken?: number): boolean {
  return workspaceScopeToken == null || workspaceScopeToken === chatReadGeneration;
}

/** workspace 已 reset 时，以标准取消态阻止旧草稿请求继续执行。 */
function assertThreadDraftWorkspaceScope(workspaceScopeToken?: number): void {
  if (!isThreadDraftWorkspaceScopeCurrent(workspaceScopeToken)) {
    throw createCancelledRequestError("stale-result");
  }
}

function assertManagedServicesScope(scope: ManagedServicesScopeSnapshot): void {
  if (!isManagedServicesScopeCurrent(scope)) {
    throw createCancelledRequestError("stale-result");
  }
}

function getScopeEpoch(map: Map<string, number>, key: string): number {
  return map.get(key) ?? 0;
}

function bumpScopeEpoch(map: Map<string, number>, key: string): number {
  const next = getScopeEpoch(map, key) + 1;
  map.set(key, next);
  return next;
}

/** 合并同作用域的有效读取；已取消但尚未返回的请求不得阻塞立即重试。 */
function runScopedRead<T>(
  kind: ChatReadKind,
  id: string,
  scopeKey: string,
  start: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const readKey = `${kind}:${id}`;
  const existing = inFlightReadByKey.get(readKey);
  if (existing) {
    if (existing.scopeKey === scopeKey && !existing.controller.signal.aborted) return existing.promise as Promise<T>;
    existing.controller.abort(createCancelledRequestError("scope-change"));
    inFlightReadByKey.delete(readKey);
  }

  const { controller, cleanup } = createLinkedAbortController();
  let promise!: Promise<T>;
  promise = (async () => {
    try {
      return await start(controller.signal);
    } finally {
      cleanup();
      const current = inFlightReadByKey.get(readKey);
      if (current?.promise === promise) {
        inFlightReadByKey.delete(readKey);
      }
    }
  })();
  inFlightReadByKey.set(readKey, { scopeKey, controller, promise, cleanup });
  return promise;
}

/** 冻结草稿入队时的身份；旧请求不得借用新登录 token，也不得用旧 401 清除新会话。 */
function freezeThreadDraftMutationApiContext(ctx: ApiRequestContext): ApiRequestContext {
  const sessionToken = String(ctx.sessionToken ?? "").trim();
  const webSessionId = String(ctx.webSessionId ?? "").trim();
  return {
    serverWsOrigin: ctx.serverWsOrigin,
    desktopClientId: ctx.desktopClientId,
    sessionToken: sessionToken || null,
    webSessionId: webSessionId || null,
    ensureSession: async () => {
      if (!sessionToken) throw new Error("草稿请求入队时缺少鉴权 token（session）");
      return sessionToken;
    },
  };
}

/** 冻结 prefs 入队时的身份，避免旧请求借用新登录 token 或清除新会话。 */
function freezeThreadPrefsMutationApiContext(ctx: ApiRequestContext): ApiRequestContext {
  const sessionToken = String(ctx.sessionToken ?? "").trim();
  const webSessionId = String(ctx.webSessionId ?? "").trim();
  return {
    serverWsOrigin: ctx.serverWsOrigin,
    desktopClientId: ctx.desktopClientId,
    sessionToken: sessionToken || null,
    webSessionId: webSessionId || null,
    ensureSession: async () => {
      if (!sessionToken) throw new Error("会话配置请求入队时缺少鉴权 token（session）");
      return sessionToken;
    },
  };
}

/** 仅在没有更新信号，或最新信号确认为本次 Web mutation 时写回权威草稿缓存。 */
function canApplyThreadDraftMutationResponse(input: {
  threadId: ThreadId;
  signalEpoch: number;
  version: number | null;
  updatedByWebSessionId: string | null;
}): boolean {
  const latest = threadDraftVersionSignalByThreadId.get(String(input.threadId));
  const latestEpoch = latest?.epoch ?? 0;
  if (latestEpoch === input.signalEpoch) return true;
  const source = String(input.updatedByWebSessionId ?? "").trim();
  return Boolean(source && latest?.updatedByWebSessionId === source && latest.version === input.version);
}

/**
 * 同一 workspace/thread 的草稿 mutation 按调用顺序执行，避免旧请求最后写回远端。
 * 会话切换不取消已排队的持久化，工作区代际变化仍会取消旧 mutation。
 * workspace 失效后默认取消；显式 remote-only 时只完成旧 workspace 写入，不投影当前 Store。
 */
function runThreadDraftMutation<T>(
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  mutation: (scope: ThreadReadScopeSnapshot, applyLocalProjection: boolean) => Promise<T>,
  workspaceScopeToken?: number,
  opts?: { allowStaleWorkspaceRemoteMutation?: boolean },
): Promise<T> {
  const key = `${String(workspaceId)}::${String(threadId)}`;
  const scope = captureThreadReadScope(workspaceId, threadId);
  const mutationEpoch = threadDraftMutationEpochByKey.get(key) ?? 0;
  const previous = threadDraftMutationTailByKey.get(key) ?? Promise.resolve();
  const result = previous.then(() => {
    const applyLocalProjection = isThreadDraftWorkspaceScopeCurrent(workspaceScopeToken);
    if (!applyLocalProjection && !opts?.allowStaleWorkspaceRemoteMutation) {
      assertThreadDraftWorkspaceScope(workspaceScopeToken);
    }
    if (applyLocalProjection && scope.generation !== chatReadGeneration) {
      throw createCancelledRequestError("workspace-switch");
    }
    if ((threadDraftMutationEpochByKey.get(key) ?? 0) !== mutationEpoch) {
      throw createCancelledRequestError("clear");
    }
    return mutation(scope, applyLocalProjection);
  });
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  threadDraftMutationTailByKey.set(key, tail);
  void tail.finally(() => {
    if (threadDraftMutationTailByKey.get(key) === tail) {
      threadDraftMutationTailByKey.delete(key);
      threadDraftMutationEpochByKey.delete(key);
    }
  });
  return result;
}

/** Clear/delete invalidates only mutations already queued for the affected thread. */
function invalidateQueuedThreadDraftMutations(threadId: string): void {
  for (const key of threadDraftMutationTailByKey.keys()) {
    if (!key.endsWith(`::${threadId}`)) continue;
    threadDraftMutationEpochByKey.set(key, (threadDraftMutationEpochByKey.get(key) ?? 0) + 1);
  }
}

/** 移除 undefined 字段，保持省略与显式 null 的补丁语义。 */
function copyDefinedThreadPrefs(prefs: ThreadPrefs | null | undefined): ThreadPrefs {
  return Object.fromEntries(
    Object.entries(prefs ?? {}).filter(([, value]) => value !== undefined),
  ) as ThreadPrefs;
}

/** 读取 thread 当前 prefs mutation epoch，供远端快照落地时拒绝旧结果。 */
function getThreadPrefsMutationEpoch(threadId: string): number {
  return threadPrefsMutationEpochByThreadId.get(threadId) ?? 0;
}

/** 为本地修改或实时权威事件推进 prefs mutation epoch。 */
function bumpThreadPrefsMutationEpoch(threadId: string): number {
  const next = getThreadPrefsMutationEpoch(threadId) + 1;
  threadPrefsMutationEpochByThreadId.set(threadId, next);
  return next;
}

/** 读取 thread 写入 epoch；删除 thread 时推进，阻止旧 ACK 污染复用 ID。 */
function getThreadPrefsWriteEpoch(threadId: string): number {
  return threadPrefsWriteEpochByThreadId.get(threadId) ?? 0;
}

/** 推进 thread 写入 epoch，仅用于删除/重建边界而非普通选择切换。 */
function bumpThreadPrefsWriteEpoch(threadId: string): number {
  const next = getThreadPrefsWriteEpoch(threadId) + 1;
  threadPrefsWriteEpochByThreadId.set(threadId, next);
  return next;
}

/** 合并迟到的远端快照，仅保护读取期间被本地修改过的字段。 */
function mergeStaleThreadPrefsSnapshot(
  current: ThreadPrefs,
  remote: ThreadPrefs,
  base: ThreadPrefs | undefined,
  protectedPrefs?: ThreadPrefs,
): ThreadPrefs {
  if (!base) return remote;
  const next: ThreadPrefs = { ...remote };
  const fields = new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(remote)]);
  for (const fieldName of fields) {
    const field = fieldName as keyof ThreadPrefs;
    const baseHas = Object.prototype.hasOwnProperty.call(base, field);
    const currentHas = Object.prototype.hasOwnProperty.call(current, field);
    const protectedField = Object.prototype.hasOwnProperty.call(protectedPrefs ?? {}, field);
    const unchanged = !protectedField
      && baseHas === currentHas
      && (!baseHas || Object.is(base[field], current[field]));
    if (unchanged) continue;
    if (currentHas) {
      Object.assign(next, { [field]: current[field] });
    } else {
      delete (next as Partial<Record<keyof ThreadPrefs, unknown>>)[field];
    }
  }
  return next;
}

/** 判断偏好补丁是否至少包含一个需要持久化的字段。 */
function hasThreadPrefsFields(prefs: ThreadPrefs): boolean {
  return Object.keys(prefs).length > 0;
}

/** 判断偏好保存是否命中了已删除的 thread；只清理明确失效的旧本地投影。 */
function isMissingThreadPrefsFailure(source: { code?: string; message?: string }): boolean {
  const code = String(source.code ?? "").trim().toUpperCase();
  const message = String(source.message ?? "").trim();
  return code === "THREAD_NOT_FOUND"
    || code === "NOT_FOUND"
    || /thread\s*不存在|会话已不存在/u.test(message);
}

/** 返回当前 workspace/generation 仍待确认的 thread，供切换前 drain 使用。 */
function listPendingThreadPrefsForWorkspace(
  store: ChatStore,
  workspaceId: WorkspaceId,
  generation: number,
): ThreadId[] {
  const targetWorkspaceId = String(workspaceId);
  return Object.keys(store.pendingThreadPrefsByThreadId)
    .filter((threadId) => {
      const pending = copyDefinedThreadPrefs(store.pendingThreadPrefsByThreadId[threadId]);
      if (!hasThreadPrefsFields(pending)) return false;
      const meta = threadPrefsPendingMetaByThreadId.get(threadId);
      if (!meta || meta.generation !== generation) return false;
      return !meta.workspaceId || meta.workspaceId === targetWorkspaceId;
    })
    .map((threadId) => threadId as ThreadId);
}

/** 从 API 失败响应或异常中提取可检索的 requestId。 */
function extractThreadPrefsRequestId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const details = (value as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const requestId = (details as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.trim() ? requestId : null;
}

/** 记录当前 scope 的 prefs 保存失败；调用方仍会继续显式传播失败。 */
function logThreadPrefsSaveFailure(input: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  source: unknown;
}): void {
  const sourceCode = typeof input.source === "object" && input.source !== null && typeof (input.source as { code?: unknown }).code === "string"
    ? (input.source as { code: string }).code
    : "REQUEST_THROWN";
  const error = input.source instanceof Error
    ? input.source.message
    : typeof input.source === "object" && input.source !== null && typeof (input.source as { message?: unknown }).message === "string"
      ? (input.source as { message: string }).message
      : String(input.source);
  const currentMeta = threadPrefsPendingMetaByThreadId.get(String(input.threadId));
  console.error("[thread-prefs.save.failed]", {
    code: sourceCode,
    requestId: extractThreadPrefsRequestId(input.source),
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    saveRevision: currentMeta?.revision ?? null,
    currentRevision: currentMeta?.revision ?? null,
    error,
  });
}

/** 记录已失效 scope 的 prefs 保存失败，避免旧 workspace 错误污染当前界面。 */
function logStaleThreadPrefsSaveFailure(input: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  saveRevision: number | null;
  source: unknown;
  code?: string;
}): void {
  const sourceCode = input.code
    ?? (typeof input.source === "object" && input.source !== null && typeof (input.source as { code?: unknown }).code === "string"
      ? (input.source as { code: string }).code
      : "REQUEST_THROWN");
  const error = typeof input.source === "object" && input.source !== null && typeof (input.source as { message?: unknown }).message === "string"
    ? (input.source as { message: string }).message
    : input.source instanceof Error ? input.source.message : String(input.source);
  const currentMeta = threadPrefsPendingMetaByThreadId.get(String(input.threadId));
  console.warn("[thread-prefs.save.stale-failed]", {
    code: sourceCode,
    requestId: extractThreadPrefsRequestId(input.source),
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    saveRevision: input.saveRevision,
    currentRevision: currentMeta?.revision ?? null,
    error,
  });
}

/** 仅清除值仍等于本次响应快照的字段，保留请求期间产生的新修改。 */
function clearAcknowledgedThreadPrefsPatch(store: ChatStore, threadId: ThreadId, acknowledged: ThreadPrefs): void {
  const key = String(threadId);
  const pending = copyDefinedThreadPrefs(store.pendingThreadPrefsByThreadId[key]);
  for (const field of Object.keys(acknowledged) as Array<keyof ThreadPrefs>) {
    if (!Object.prototype.hasOwnProperty.call(pending, field)) continue;
    if (!Object.is(pending[field], acknowledged[field])) continue;
    delete pending[field];
  }
  if (hasThreadPrefsFields(pending)) {
    store.pendingThreadPrefsByThreadId[key] = pending;
    return;
  }
  delete store.pendingThreadPrefsByThreadId[key];
  threadPrefsPendingMetaByThreadId.delete(key);
}

/** 同一 workspace/thread 的偏好保存按调用顺序执行，避免旧请求最后覆盖新值。 */
function runThreadPrefsSave(
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  save: () => Promise<void>,
): Promise<void> {
  const key = `${String(workspaceId)}::${String(threadId)}`;
  const previous = threadPrefsSaveTailByKey.get(key) ?? Promise.resolve();
  const result = previous.then(save);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  threadPrefsSaveTailByKey.set(key, tail);
  void tail.finally(() => {
    if (threadPrefsSaveTailByKey.get(key) === tail) threadPrefsSaveTailByKey.delete(key);
  });
  return result;
}

function abortRead(kind: ChatReadKind, id: string, reason: AbortKind): void {
  const readKey = `${kind}:${id}`;
  const current = inFlightReadByKey.get(readKey);
  if (!current) return;
  current.controller.abort(createCancelledRequestError(reason));
}

/** 删除后清除列表读取身份和缓存，既阻止旧响应回写，也允许沿原游标继续翻页。 */
function invalidateWorkspaceThreadListReads(workspaceId: WorkspaceId, reason: AbortKind): void {
  const key = String(workspaceId);
  bumpScopeEpoch(threadListReadScopeEpochByWorkspaceId, key);
  const store = useChatStore();
  store.threadListCache = {};
  store.activeThreadListCacheKey = null;
  for (const kind of ["threads-refresh", "threads-load-more"] as const) {
    const readKey = `${kind}:${key}`;
    const current = inFlightReadByKey.get(readKey);
    if (!current) continue;
    current.controller.abort(createCancelledRequestError(reason));
    inFlightReadByKey.delete(readKey);
  }
}

/** 标记本窗口删除后的权威刷新周期，避免自己的延迟广播取消新请求。 */
function beginLocalDeleteRefresh(workspaceId: WorkspaceId, threadIds: ReadonlyArray<ThreadId>): () => void {
  const workspaceKey = String(workspaceId);
  const activeIds = localDeleteRefreshThreadIdsByWorkspaceId.get(workspaceKey) ?? new Set<string>();
  for (const threadId of threadIds) activeIds.add(String(threadId));
  localDeleteRefreshThreadIdsByWorkspaceId.set(workspaceKey, activeIds);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const current = localDeleteRefreshThreadIdsByWorkspaceId.get(workspaceKey);
    if (!current) return;
    for (const threadId of threadIds) current.delete(String(threadId));
    if (current.size === 0) localDeleteRefreshThreadIdsByWorkspaceId.delete(workspaceKey);
  };
}

/** 判断删除广播是否来自本窗口仍在收口的删除刷新。 */
function isLocalDeleteRefreshThread(workspaceId: WorkspaceId, threadId: ThreadId): boolean {
  return localDeleteRefreshThreadIdsByWorkspaceId.get(String(workspaceId))?.has(String(threadId)) === true;
}

function abortAllReads(reason: AbortKind): void {
  for (const current of inFlightReadByKey.values()) {
    current.controller.abort(createCancelledRequestError(reason));
    current.cleanup();
  }
  inFlightReadByKey.clear();
}

