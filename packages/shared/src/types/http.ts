import type {
  AccessMode,
  CodexServiceTier,
  EngineCustomModelEntry,
  EngineModelInfo,
  EngineModelProviderId,
  EngineStatus,
  EngineType,
  InputModality,
  ReasoningEffort,
  ReasoningEffortOption,
} from "./engine";
import type { EngineModelCatalogSyncState } from "./engineModelCatalog";
import type { AccountRole } from "./account";
import type { ChatWorkflowActiveStatus } from "./chatWorkflow";
import type { SharedWorkspaceAssetPermissions, SharedWorkspaceEntryStatus, SharedWorkspaceErrorCode, SharedWorkspaceDirectEntry, SharedWorkspaceAssetMaintenancePolicy, SharedWorkspaceFileTransferPolicy } from "./sharedWorkspace";
import type { AssetDraftId, AssetGenerationJobId, AssetVersionId, ClientId, IntakeId, KnowledgeBundleId, ArtifactId, OrchestrationId, ProposalId, RequirementAnalysisSessionId, RequirementCandidateId, RoleId, SessionId, SkillId, ThreadId, ToolsetId, TurnId, WorkflowId, WorkspaceId } from "./ids";
import type { ThreadEntryVisibility, ThreadGroupId, ThreadGroupSummary, ThreadListScope, ThreadListSort, ThreadSubtype, ThreadSummary, ThreadType } from "./conversation";
import type { ConversationEventEnvelope } from "./events";
import type { RawEngineEventEnvelope } from "./rawEvents";
import type { TextFileAttachment } from "./attachments";
import type { WorkspacePathReference } from "./pathReferences";
import type { CodexSkillMentionBinding, ThreadInputKind } from "../inputActions";
import type { TerminalAction, TerminalShellOption } from "./terminal";
import type { WorkspaceDirectoryMigrationHostMaintenance } from "./workspaceDirectoryMigration";
import type { OrchAssetBundle, OrchAssetBundleImportCounts, OrchAssetBundleImportMode, OrchAssetBundleWarning } from "../orchestration/assetBundle.js";
import type {
  OrchAssetCacheStatus,
  OrchAssetListMetadata,
  OrchAssetScopeType,
  OrchAssetType,
} from "./orchestrationAssets";
import type {
  Artifact,
  OrchAssetGroup,
  OrchAssetGroupType,
  ArtifactFileEntry,
  NodeResultField,
  AssetDraft,
  AssetGenerationJob,
  AssetJobEventView,
  AssetValidationIssue,
  AssigneeTemplate,
  WorkflowExecutionDefault,
  FeedbackAction,
  KnowledgeBundleDefinition,
  NodeWorkItem,
  NodeWorkItemBoard,
  NodeWorkItemEvent,
  NodeWorkItemStatus,
  NodeWorkItemSummary,
  NodeExecutionEnvelope,
  NodePromptSnapshot,
  NodeThreadReusePolicy,
  OrchestrationInstance,
  OrchestrationInstanceRuntimePatch,
  OrchestrationInstanceSummary,
  OrchestrationExecutionEngineStrategy,
  OrchestrationStatus,
  OrchestrationRunPlan,
  OrchestrationRoleExecutionOverride,
  OrchestrationEventRecord,
  DownstreamThreadReusePolicy,
  RequirementAnalysisAssistantPayload,
  RequirementAnalysisMessage,
  RequirementAnalysisSession,
  RequirementCandidateDraft,
  RoleDraftComparison,
  RoleDefinition,
  RoleDraftPayload,
  SkillDefinition,
  SkillDraftComparison,
  SkillDraftPayload,
  SkillTargetEngine,
  TaskIntake,
  TaskIntakeSourceKind,
  ToolsetDefinition,
  WorkflowDefinition,
  WorkflowProposal,
  WorkflowProposalSummary,
} from "./orchestration";

export type {
  BillingCycle,
  BillingPlanType,
  BillingScopeType,
  BusinessOrderFulfillmentStatus,
  BusinessOrderStatus,
  BusinessOrderType,
  CheckoutEntrySource,
  OrderRefreshTriggerSource,
} from "./billing";

export type {
  CancelPaymentOrderRequestBody,
  CancelPaymentOrderResponseBody,
  CreateVerificationOrderRequestBody,
  GetPaymentOrderDetailResponseBody,
  ListVerificationOrdersParams,
  ListVerificationOrdersResponseBody,
  PaymentCallbackSummary,
  PaymentEvidenceSummary,
  PaymentFinalSource,
  PaymentOrderDetailView,
  PaymentOrderFilterView,
  PaymentOrderListItemView,
  PaymentOrderStatus,
  PaymentProductKind,
  PaymentQueryCheckSummary,
  PaymentQueryTriggerSource,
  PaymentStatusLogItem,
  VerificationOrderCreateResponseBody,
  VerificationProductResponseBody,
  VerifyPaymentOrderRequestBody,
  VerifyPaymentOrderResponseBody,
} from "./payment";

export type SharedWorkspaceApiErrorBody = {
  ok: false;
  errorCode: SharedWorkspaceErrorCode;
  message: string;
  requestId?: string | null;
  detail?: unknown;
};

export type CreateThreadRequestBody = {
  workspaceId: WorkspaceId;
  engine: EngineType;
  title: string;
  threadType?: ThreadType | null;
  threadSubtype?: ThreadSubtype | null;
  /** 普通自建会话所属分组；空值表示未分组。 */
  groupId?: ThreadGroupId | null;
  initialPrefs?: ThreadPrefs | null;
};
export type CreateThreadResponseBody = { threadId: ThreadId; engine: EngineType };

/** thread 运行态：用于列表页在不进入会话的情况下展示"是否运行中"。 */
export type ThreadRunningState = { runningTurnId: TurnId; runningTurnStartedAt: number; runningSource?: "runtime" | "db";
  /** 原运行 owner 的停止阶段；draining 期间禁止派发下一回合。 */
  phase?: "running" | "stopping" | "draining" | "failed";
  /** 仅公开可检索错误码，不把持久化异常正文带入 UI。 */
  failureCode?: string };
export type ListThreadsRequestQuery = {
  workspaceId: WorkspaceId;
  scope?: ThreadListScope;
  /** 列表排序；置顶始终优先，排序作用于置顶组内和普通组内。 */
  sort?: ThreadListSort;
  /** 自建会话分组过滤；空值不过滤，ungrouped 表示未分组。 */
  groupId?: ThreadGroupId | "ungrouped" | null;
  /** 共享工作区列表筛选；true 仅返回 owner/participant 相关记录，false 允许返回团队只读记录。 */
  onlyRelatedToMe?: boolean | null;
  /** 标题搜索关键字；服务端仅匹配 threads.title，不搜索消息内容。 */
  search?: string | null;
  limit?: number;
  cursor?: string | null;
};
/** 会话工作流活跃态：用于列表行在不进入编排视图时展示工作流标签。 */
export type ThreadWorkflowState = {
  status: ChatWorkflowActiveStatus;
  instanceId: string | null;
  taskId: string;
};
export type ListThreadsResponseBody = {
  threads: ThreadSummary[];
  runningByThreadId?: Record<string, ThreadRunningState>;
  workflowByThreadId?: Record<string, ThreadWorkflowState>;
  hasMore: boolean;
  nextCursor: string | null;
};
export type ListThreadGroupsRequestQuery = {
  workspaceId: WorkspaceId;
};
export type ListThreadGroupsResponseBody = {
  groups: ThreadGroupSummary[];
};
export type CreateThreadGroupRequestBody = {
  workspaceId: WorkspaceId;
  name: string;
};
export type CreateThreadGroupResponseBody = {
  group: ThreadGroupSummary;
};
export type RenameThreadGroupRequestBody = {
  workspaceId: WorkspaceId;
  groupId: ThreadGroupId;
  name: string;
};
export type RenameThreadGroupResponseBody = {
  group: ThreadGroupSummary;
};
export type DeleteThreadGroupRequestBody = {
  workspaceId: WorkspaceId;
  groupId: ThreadGroupId;
};
export type DeleteThreadGroupResponseBody = {
  ungroupedThreadCount: number;
};
export type AssignThreadGroupRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  groupId?: ThreadGroupId | null;
};
export type AssignThreadGroupResponseBody = {
  groupId: ThreadGroupId | null;
};
export type GetThreadSummaryRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId };
export type ThreadManagedServicesScope = {
  visible: boolean;
  threadId: ThreadId | null;
};
export type GetThreadSummaryResponseBody = {
  thread: ThreadSummary;
  running: ThreadRunningState | null;
  visibility: ThreadEntryVisibility;
  managedServices: ThreadManagedServicesScope | null;
};

export type RenameThreadRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId; title: string };
export type ArchiveThreadRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId; archived: boolean };
export type PinThreadRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId; pinned: boolean };
export type PinThreadResponseBody = { pinnedAt: number | null };
export type DeleteThreadRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId };
export type DeleteThreadMessageRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId; itemId: string };
export type DeleteThreadMessageResponseBody = { itemId: string };
export type ClearThreadRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId; resetSession?: boolean };

export type ClientDbCleanupStatus = "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";

export type ClientDbCleanupPhase =
  | "selecting_threads"
  | "conversation_events"
  | "raw_engine_events"
  | "prompt_snapshots"
  | "file_blobs"
  | null;

export type ClientDbCleanupSnapshot = {
  jobId: string | null;
  status: ClientDbCleanupStatus;
  phase: ClientDbCleanupPhase;
  inactiveBefore: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  currentThreadId: ThreadId | null;
  selectedThreadCount: number;
  processedThreadCount: number;
  skippedThreadCount: number;
  batchCount: number;
  deletedConversationEventCount: number;
  deletedRawEngineEventCount: number;
  deletedPromptSnapshotCount: number;
  deletedFileBlobCount: number;
  deletedFileBlobBytes: number;
  reusableBytesBefore: number | null;
  reusableBytesAfter: number | null;
  error: string | null;
};

export type ClientDbStorageSummary = {
  databaseBytes: number;
  reusableBytes: number;
  liveBytes: number;
  cleanup: ClientDbCleanupSnapshot;
};

export type GetClientDbCleanupStatusRequestBody = {
  clientId: ClientId;
};

export type GetClientDbCleanupStatusResponseBody = {
  storage: ClientDbStorageSummary;
};

export type StartClientDbCleanupRequestBody = {
  clientId: ClientId;
  inactiveBefore: number;
};

export type StartClientDbCleanupResponseBody = {
  storage: ClientDbStorageSummary;
};
export type RestartCodexAppServerRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId };
export type RestartCodexAppServerResponseBody = { message: string };
export type CompactThreadRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  /** 可选：权限模式（read-only/current/full-access）。 */
  accessMode?: AccessMode | null;
  /** 可选：上下文窗口覆盖值（仅运行时透传，不落本地 Codex config）。 */
  contextWindow?: number | null;
  /** 可选：自动压缩阈值百分比（50-99）。空值表示使用产品默认值 90%；Codex 会在运行时换算为 token 阈值。 */
  autoCompactPct?: number | null;
  /** Codex 专属：Fast mode 服务档位；null 表示显式回到标准档。 */
  serviceTier?: CodexServiceTier | null;
};
export type CompactThreadResponseBody = {
  turnId?: TurnId | null;
  /** 本次 mutation 前已自动收口未决回滚，调用方必须重载裁剪后的历史。 */
  rollbackReconciled?: boolean;
  /** 回滚收口后的事件序号屏障；仅接受安全正整数。 */
  rollbackEventSeqBarrier?: number;
  /** 主 mutation 已完成，但一个或多个共享投影未能同步失效。 */
  rollbackProjectionSyncWarning?: string;
};

export type SendMessageRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  /**
   * 可选：客户端预分配的 turnId。为空时由服务端生成 authoritative turnId 并回传。
   * 节点恢复执行等非普通 chat turn 场景不保证返回 turnId。
   */
  turnId?: TurnId | null;
  text: string;
  /** 显式 Provider 输入语义；缺失时由 Client 保留旧版自动判定。 */
  inputKind?: ThreadInputKind;
  /** Codex Skill 的 opaque 正文范围绑定。 */
  skillMentions?: CodexSkillMentionBinding[];
  /** 工作模式：当前仅保留常规对话。 */
  workMode?: "general" | null;
  /** 可选：普通聊天角色；只注入角色 prompt/知识/工具，不切换 engine。 */
  roleId?: RoleId | null;
  /** Plan 模式（输入侧开关）：让引擎进入"先计划/少执行"的行为（不同引擎实现不同）。 */
  planMode?: boolean | null;
  /** 可选：权限模式（read-only/current/full-access）。 */
  accessMode?: AccessMode | null;
  /** 可选：模型 ID（由引擎自行解析；为空表示用默认模型）。 */
  model?: string | null;
  /**
   * 可选：思考强度。
   * - 具体支持的档位由当前模型配置决定；为空表示默认。
   */
  effort?: string | null;
  /** 可选：图片输入（支持 dataURL/http(s)/本机路径；是否可用由引擎能力决定）。 */
  images?: string[];
  /** 可选：文本文件附件（会以内嵌文本方式发送给引擎）。 */
  files?: TextFileAttachment[];
  /** 可选：工作区路径引用（仅传路径边界，不内联文件正文）。 */
  pathReferences?: WorkspacePathReference[];
  /** 可选：上下文窗口覆盖值（仅运行时透传，不落本地 Codex config）。 */
  contextWindow?: number | null;
  /** 可选：自动压缩阈值百分比（50-99）。空值表示使用产品默认值 90%；Codex 会在运行时换算为 token 阈值。 */
  autoCompactPct?: number | null;
  /** Codex 专属：Fast mode 服务档位；null 表示显式回到标准档。 */
  serviceTier?: CodexServiceTier | null;
  /**
   * 可选：客户端幂等键（UUID）。Client 维护一个 30 秒 TTL 的 LRU；
   * 重复发送同一 clientItemId 时返回 200 OK + 已有 turnId（idempotent ack），不会触发第二个 turn。
   * 适用于网络重试 / 多端并发 / 用户连点（虽然 web 端 sending 锁已先一步拦截）。
   */
  clientItemId?: string;
};
export type SendMessageResponseBody = {
  turnId?: TurnId | null;
  dispatchMode?: "chat_turn" | "orchestration_feedback";
  result?: unknown;
  /** 当 clientItemId 命中近期已 send 时为 true。 */
  idempotent?: boolean;
  /** 本次 mutation 前已自动收口未决回滚，调用方必须重载裁剪后的历史。 */
  rollbackReconciled?: boolean;
  /** 回滚收口后的事件序号屏障；仅接受安全正整数。 */
  rollbackEventSeqBarrier?: number;
  /** 主 mutation 已完成，但一个或多个共享投影未能同步失效。 */
  rollbackProjectionSyncWarning?: string;
};

export type InterruptTurnRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId };
export type InterruptTurnResponseBody = {
  /** 已确认停止可先返回 draining，完整终态仍由原运行 owner 保存。 */
  phase?: "draining" | "completed";
  /** 中断处理后该 thread 的权威运行态；null 表示已无运行中 turn。 */
  running: ThreadRunningState | null;
  /** 请求目标在处理前已是终态，用于排障 stale UI。 */
  alreadyTerminal?: boolean;
};

export type ThreadDraftImageAttachment = {
  id: string;
  name: string;
  dataUrl: string;
  size: number;
};

export type ThreadDraftPayload = {
  text: string;
  inputKind?: ThreadInputKind;
  skillMentions?: CodexSkillMentionBinding[];
  images: ThreadDraftImageAttachment[];
  files: TextFileAttachment[];
  pathReferences?: WorkspacePathReference[];
};

export type ThreadDraft = ThreadDraftPayload & {
  version: number;
  updatedAt: number;
  updatedByWebSessionId: string | null;
};

export type GetThreadDraftRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId };
export type GetThreadDraftResponseBody = { draft: ThreadDraft | null };

export type SaveThreadDraftRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  draft: ThreadDraftPayload;
};
export type SaveThreadDraftResponseBody = {
  version: number;
  updatedAt: number;
  updatedByWebSessionId: string | null;
};

export type ClearThreadDraftRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId };
export type ClearThreadDraftResponseBody = {};

export type ReadThreadPresentationRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId;
  /** 可见消息窗口大小；省略时读取全部消息。 */
  presentationLimit?: number | null;
  /** 返回位置早于该游标的更早消息窗口；省略时取最新窗口。 */
  presentationBeforePosition?: number | null };
export type ReadThreadPresentationResponseBody = { presentation: import("../conversation/presentation.js").ThreadPresentation };
export type LoadThreadProcessRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  processId: string;
  afterSeq?: number;
  cursor?: string;
  throughSeq?: number;
  limit?: number;
};
export type LoadThreadProcessResponseBody = import("../conversation/presentation.js").ThreadProcessDetails;

export type LoadThreadRequestBody = {
  /** 首屏读取展示快照，过程正文由独立接口按需读取。 */
  presentation?: "lazy";
  /** presentation 模式：本次窗口的可见消息数；省略时读取全部消息。 */
  presentationLimit?: number | null;
  /** presentation 模式：返回位置早于该游标的更早消息窗口；省略时取最新窗口。 */
  presentationBeforePosition?: number | null;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  /** 可选：单页回放事件数上限（从最新向前取）；为空表示使用默认值。 */
  limit?: number | null;
  /** 游标分页：返回 seq < beforeSeq 的事件。空/省略 = 取最新。 */
  beforeSeq?: number | null;
};
export type LoadThreadResponseBody = {
  presentation?: import("../conversation/presentation.js").ThreadPresentation;
  /** 永久删除的消息 ID，与分页窗口无关，用于阻止缓存和迟到事件恢复正文。 */
  deletedMessageIds?: string[];
  thread: {
    id: ThreadId;
    workspaceId: WorkspaceId;
    engine: EngineType;
    title: string;
    threadType: ThreadType;
    threadSubtype: ThreadSubtype | null;
    sessionId: SessionId | null;
    /** 置顶时间；为空表示未置顶。 */
    pinnedAt?: number | null;
    createdAt: number;
    updatedAt: number;
    /** 会话级偏好：model */
    model?: string | null;
    /** 会话级偏好：effort */
    effort?: string | null;
    /** 会话级偏好：accessMode */
    accessMode?: AccessMode | null;
    /** 会话级偏好：planMode */
    planMode?: boolean | null;
    /** 普通会话是否允许读取项目知识；新会话在资产树已初始化时默认开启。 */
    knowledgeEnabled?: boolean | null;
    /** 会话级偏好：自动压缩阈值（百分比 50-99，null 表示使用产品默认值 90%）。 */
    autoCompactPct?: number | null;
    /** 会话级偏好：上下文窗口覆盖值（token 数，null 表示使用模型默认值）。 */
    contextWindow?: number | null;
    /** 会话级偏好：Codex Fast mode 服务档位；null 表示标准档。 */
    serviceTier?: CodexServiceTier | null;
    /** 会话级偏好：普通聊天角色；null 表示不启用角色注入。 */
    roleId?: RoleId | null;
    /** 共享工作区上下文；只在 shared:* 入口打开时返回。 */
    sharedContext?: ThreadSummary["sharedContext"];
    /** 共享工作区只读标记；true 表示当前账号不能输入或维护该会话。 */
    readOnly?: ThreadSummary["readOnly"];
  };
  /** 该 thread 是否已经进入过至少一次真实 turn。 */
  hasRealTurnActivity?: boolean;
  running?: ThreadRunningState | null;
  managedServices: ThreadManagedServicesScope | null;
  /** 首屏会话草稿；旧端或分页读取可能不返回，调用方需按可选字段处理。 */
  draft?: ThreadDraft | null;
  events: ConversationEventEnvelope[];
  /** 是否还有更早历史（true 表示可用 oldestSeq 作为 beforeSeq 继续分页）。 */
  hasMore: boolean;
  /** 本次原始事件窗口的最早 seq（用于继续向更早分页）。 */
  oldestSeq: number | null;
  /** 本次原始事件窗口的最新 seq（用于同步 lastEventSeq，而不是依赖压缩后的事件尾部）。 */
  latestSeq: number | null;
  /** 本次从 Client 读取到的原始事件数（压缩前）。 */
  rawEventCount: number;
};

/** 分页读取某 thread 的事件（用于调试面板/排障）。 */
export type ListThreadEventsRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  /** 向更早分页：返回 `seq < beforeSeq` 的事件（不含边界）。空表示取最新一页。 */
  beforeSeq?: number | null;
  /** 单页数量（建议 50~500；服务端会做上限保护）。 */
  limit?: number | null;
};
export type ListThreadEventsResponseBody = {
  /** 事件列表（按 seq 倒序：最新在前）。 */
  events: RawEngineEventEnvelope[];
  /** 下一页游标：用于继续取更早事件；为空表示无更多。 */
  nextBeforeSeq: number | null;
};

export type ThreadFileChangeSummary = {
  /** 统一用 `/` 分隔的工作区相对路径。 */
  path: string;
  status: "created" | "modified" | "deleted";
  lastTurnId: TurnId;
  lastChangedAt: number;
  /** 是否具备撤销所需快照（老会话/缺快照时为 false）。 */
  canUndo: boolean;
  /** 文件变更所属的 AIDT 阶段标识（PRD/UI/ARC/DGN/PLAN/DEV/E2E/GIT），未绑定或无 doing 阶段时为 null。 */
  stepKey: string | null;
  /** 当前快照是否已被用户接受（用于增量 diff 基准推进）。 */
  isAccepted: boolean;
  /** 已接受的 blob id（未接受为 null）。 */
  acceptedBlobId: string | null;
};

export type ListThreadFileChangesRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId };
export type ListThreadFileChangesResponseBody = { items: ThreadFileChangeSummary[] };

export type GetThreadFileChangeDiffRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId; path: string };
export type GetThreadFileChangeDiffResponseBody = {
  path: string;
  isBinary: boolean;
  beforeText: string | null;
  afterText: string | null;
  /** 可选：统一 diff（缺失或文件过大时为 null）。 */
  diffText: string | null;
};

export type AcceptThreadFileChangesRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId; paths: string[] };
export type AcceptThreadFileChangesResponseBody = { acceptedPaths: string[] };

export type UndoThreadFileChangesRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId; paths?: string[] | null };
export type UndoThreadFileChangesResponseBody = { undonePaths: string[]; skippedPaths?: string[] };

export type RollbackThreadRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  toTurnId: TurnId;
  /** 是否回滚文件变更（默认 true，向后兼容）。 */
  rollbackFiles?: boolean;
  /** 要跳过的文件路径（仅 rollbackFiles=true 时生效）。 */
  skipPaths?: string[];
};
export type RollbackThreadResponseBody = {
  droppedTurnCount: number;
  revertedFileCount: number;
  skippedFileCount: number;
  /** 文件回滚的权威执行结果；异常必须通过非成功响应返回。 */
  fileRollbackStatus: "not_requested" | "completed";
  /** 回滚完成后的事件序号屏障；仅接受安全正整数。 */
  rollbackEventSeqBarrier?: number;
  /** 主回滚已完成，但一个或多个共享投影未能同步失效。 */
  rollbackProjectionSyncWarning?: string;
};

// ── Rollback Preview ─────────────────────────────────────────────
export type PreviewRollbackRequestBody = { workspaceId: WorkspaceId; threadId: ThreadId; toTurnId: TurnId };
export type RollbackEvidenceIssue = {
  /** 证据缺口类型，用于前端稳定展示和排障。 */
  code:
    | "missing_turn_diff"
    | "diff_parse_failed"
    | "diff_event_missing"
    | "diff_hash_mismatch"
    | "untracked_change"
    | "missing_before_snapshot"
    | "missing_after_snapshot"
    | "snapshot_blob_missing"
    | "invalid_provider_diff";
  /** 工作区相对路径；无法安全确定路径时为 null。 */
  path: string | null;
  message: string;
};
export type RollbackFileInfo = {
  /** 工作区相对路径。 */
  path: string;
  /** 回滚操作类型：restore=恢复旧内容，delete=删除新建文件。 */
  rollbackOp: "restore" | "delete";
  /** 当前磁盘文件与最后快照不一致（文件在会话外被修改）。 */
  hasConflict: boolean;
  /** 冲突原因描述（无冲突时为 null）。 */
  conflictReason: string | null;
  /** 是否可回滚（缺 beforeBlobId 且 beforeExists 时为 false）。 */
  canRollback: boolean;
};
export type PreviewRollbackResponseBody = {
  droppedTurnCount: number;
  files: RollbackFileInfo[];
  /** provider 聚合变更与本地快照证据是否完整闭合。 */
  evidenceComplete: boolean;
  evidenceIssues: RollbackEvidenceIssue[];
};

export type WorkspaceSummary = {
  id: WorkspaceId;
  title: string;
  path: string;
  createdAt: number;
  updatedAt: number;
  kind?: "local" | "shared";
  entryStatus?: SharedWorkspaceEntryStatus;
  disabledReason?: string | null;
  /** 本地工作区归属 Client；由 Server 聚合/离线投影写入，不代表当前在线。 */
  ownerClientId?: string | null;
  ownerClientName?: string | null;
  shared?: SharedWorkspaceDirectEntry | null;
  /** 本地工作区正在作为共享工作区 Host 承载；仅用于列表标记，不改变本地路由语义。 */
  hostedShared?: SharedWorkspaceDirectEntry | null;
  /** 本地工作区当前承载的共享工作区数量；仅 Host 本地入口返回。 */
  hostedSharedCount?: number;
  /** 共享 Host 目录迁移维护态；由 Server 在线投影或 WebSocket 事件写入。 */
  hostMaintenance?: WorkspaceDirectoryMigrationHostMaintenance | null;
  /** 本地工作区当前未终态目录迁移摘要；completed 后移除。 */
  activeDirectoryMigration?: {
    operationId: string;
    state: string;
    stateVersion: number;
    phase: string;
    progressPct: number;
    startAttemptId: string | null;
    startDisposition: string | null;
    updatedAt: number;
  } | null;
  /** completed 后仍 pending/failed 的索引派生状态。 */
  directoryMigrationIndexState?: {
    operationId: string;
    stateVersion: number;
    indexRebuildGeneration: number | null;
    indexRebuildStatus: string;
    warningCode: string | null;
    updatedAt: number;
  } | null;
  capabilities?: SharedWorkspaceAssetPermissions | null;
  /** 共享工作区文件传输策略；仅 shared 入口返回。 */
  fileTransferPolicy?: SharedWorkspaceFileTransferPolicy | null;
  /** 共享工作区资产维护策略；仅 shared 入口返回。 */
  assetMaintenancePolicy?: SharedWorkspaceAssetMaintenancePolicy | null;
};

export type ListWorkspacesResponseBody = {
  workspaces: WorkspaceSummary[];
  resolvedCurrentWorkspaceId?: WorkspaceId | null;
  workspaceListAuthoritative?: boolean;
  activeClientCount?: number;
  workspaceListSuccessCount?: number;
  workspaceListFailureCount?: number;
};

export type UpsertWorkspaceRequestBody = { workspaceId?: WorkspaceId; title: string; path: string; clientId?: string };
export type UpsertWorkspaceResponseBody = { workspace: WorkspaceSummary };

export type DeleteWorkspaceRequestBody = { workspaceId: WorkspaceId; clientId?: string };

export type ExecutionProfileScopeType = "local_workspace" | "shared_workspace";
export type ExecutionProfileSource = "workspace" | "missing";

export type WorkspaceExecutionProfileScope = {
  scopeType: ExecutionProfileScopeType;
  scopeId: string;
};

export type WorkspaceExecutionProfile = {
  scope: WorkspaceExecutionProfileScope;
  userId: string;
  profileText: string;
  source: ExecutionProfileSource;
  profileHash: string | null;
  updatedAt: number | null;
};

export type WorkspaceExecutionProfileStatus = {
  scope: WorkspaceExecutionProfileScope;
  userId: string;
  hasProfile: boolean;
  source: ExecutionProfileSource;
  profileHash: string | null;
  profileUpdatedAt: number | null;
  checkedAt: number;
};

export type GetWorkspaceExecutionProfileResponseBody = { profile: WorkspaceExecutionProfile };
export type UpdateWorkspaceExecutionProfileRequestBody = { profileText: string };
export type UpdateWorkspaceExecutionProfileResponseBody = { profile: WorkspaceExecutionProfile };
export type GetWorkspaceExecutionProfileStatusResponseBody = { statuses: WorkspaceExecutionProfileStatus[] };

export type ReminderTone = "info" | "warning" | "danger" | "success" | "neutral";
export type ReminderSourceType = "orchestration" | "chat";
export type ReminderReadState = "unread" | "read";
export type ReminderDisplayKind = "action" | "receipt" | "status";
export type RequirementDraftListStatus =
  | "running"
  | "clarifying"
  | "ready-to-create"
  | "partial-created"
  | "created"
  | "archived";
export type TaskIntakeListStatus = "not-started" | OrchestrationStatus;
export type PendingMineListStatus =
  | "waiting-start"
  | "waiting-approval"
  | "waiting-feedback"
  | "receipt"
  | "failed"
  | "paused";
export type ListAttentionStatus = PendingMineListStatus;
export type ListStatusCount<T extends string> = {
  status: T;
  label: string;
  count: number;
};
export type ListPageMeta = {
  totalCount: number;
  cursorScope: string;
};
export type ReminderActionKind =
  | "open_orch_monitor"
  | "open_orch_primary_action"
  | "open_orch_artifacts"
  | "open_orch_metric_review"
  | "open_chat_thread"
  | "open_chat_pending_input"
  | "open_chat_pending_approval";

export type WorkspaceReminderSummary = {
  workspaceId: WorkspaceId;
  pendingActionCount: number;
  pendingReceiptCount: number;
  updatedAt: number | null;
};

export type ReminderRouteTarget = {
  workspaceId: WorkspaceId;
  intakeId?: IntakeId | null;
  instanceId?: OrchestrationId | null;
  nodeId?: string | null;
  threadId?: ThreadId | null;
};

export type ReminderItem = {
  id: string;
  sourceType: ReminderSourceType;
  workspaceId: WorkspaceId;
  pendingMineStatus?: PendingMineListStatus | null;
  displayKind?: ReminderDisplayKind;
  title: string;
  statusLabel: string;
  tone: ReminderTone;
  summary: string | null;
  updatedAt: number;
  isActionRequired: boolean;
  readState: ReminderReadState;
  primaryActionKind: ReminderActionKind | null;
  primaryActionLabel: string | null;
  /** 当前提醒可被忽略的状态签名；状态变化后会重新出现。 */
  ignoreMarker: string;
  routeTarget: ReminderRouteTarget;
};

export type ListWorkspaceReminderSummariesResponseBody = {
  summaries: WorkspaceReminderSummary[];
};

export type ListWorkspaceReminderItemsResponseBody = {
  summary: WorkspaceReminderSummary;
  items: ReminderItem[];
};

export type OrchestrationMetricReviewReminderScanItem = {
  notificationKey: string;
  workspaceId: WorkspaceId;
  workspaceTitle: string;
  intakeId: IntakeId;
  title: string;
  requesterUserId: string | null;
  observationEndedAt: number;
};

export type OrchestrationMetricReviewReminderScanResponseBody = {
  items: OrchestrationMetricReviewReminderScanItem[];
};

export type MarkReminderReadRequestBody = {
  workspaceId: WorkspaceId;
  entityType: "thread" | "orch_instance";
  entityId: string;
  marker?: string | null;
};

export type MarkReminderReadResponseBody = { ok: true };

export type IgnoreReminderItemSelection = {
  reminderId: string;
  ignoreMarker: string;
};

export type IgnoreReminderItemsRequestBody = {
  workspaceId: WorkspaceId;
  items: IgnoreReminderItemSelection[];
};

export type IgnoreReminderItemsResponseBody = {
  ok: true;
  ignoredIds: string[];
};

export type RespondApprovalRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  requestId: number | string;
  decision: "accept" | "decline";
  choice?: string | null;
  note?: string | null;
};

export type RespondUserInputRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  requestId: number | string;
  answers: Record<string, { answers: string[] }>;
};

/** Client 本地自定义模型，按引擎分组后随状态响应返回。 */
export type EngineCustomModelsByEngine = Partial<Record<EngineType, EngineModelInfo[]>>;

/** 引擎状态：用于 Web 展示"安装/版本/能力/可选模型"等信息。 */
export type GetEnginesStatusResponseBody = {
  engines: EngineStatus[];
  customModelsByEngine?: EngineCustomModelsByEngine;
  catalogVersion?: number;
  hostAppliedCatalogVersion?: number | null;
  hostCatalogSyncState?: EngineModelCatalogSyncState;
};

/** 单引擎凭据配置（对应原生配置文件中的字段） */
export type EngineCredentialConfig = {
  apiKey?: string | null;
  baseUrl?: string | null;
};

/** 引擎凭据配置响应 */
export type GetEnginesConfigResponseBody = {
  claude: EngineCredentialConfig;
  codex: EngineCredentialConfig;
};

/** 设置引擎凭据请求 */
export type SetEngineConfigRequestBody = {
  engine: "claude" | "codex";
  config: EngineCredentialConfig;
};

/** codeflowai.json（仅包含需要由 Web 可视化配置的字段；其余字段允许按需扩展）。 */
export type CodeflowaiConfig = {
  paths?: { workflowDocsRoot?: string };
  /** 文件索引配置；maxEntries 为空时使用 Client 环境变量/内置默认值。 */
  fileIndex?: { maxEntries?: number | null };
  /**
   * 工作流目录配置：
   * - dirName 推荐只填"阶段名"（不含数字前缀），实际落盘目录由工作台/skills 按 STATE 计算 `<x>-<阶段名>`
   */
  workflow?: {
    dirs?: {
      prd?: { dirName?: string | null };
      ui?: { dirName?: string | null };
      arc?: { dirName?: string | null };
      design?: { dirName?: string | null };
      dev?: { dirName?: string | null };
      test?: { dirName?: string | null };
    };
  };
};

export type GetCodeflowaiConfigResponseBody = { path: string; config: CodeflowaiConfig };
export type SetCodeflowaiConfigRequestBody = { workspaceId: WorkspaceId; config: CodeflowaiConfig };
export type SetCodeflowaiConfigResponseBody = { path: string; config: CodeflowaiConfig };

export type SkillsInstalledInfo = {
  installedAt: number;
  source: "community";
};

export type InstallSkillsRequestBody = {
  workspaceId: WorkspaceId;
  targets: string[];
  suiteId?: string | null;
  suite?: SkillSuiteInfo | null;
};
export type UninstallSkillsRequestBody = { workspaceId: WorkspaceId; targets: string[]; suiteId: string };

export type SkillsOperateResult = { targetId: string; ok: boolean; message?: string };
export type SkillsOperateResponseBody = { results: SkillsOperateResult[] };

// ── Software Update ───────────────────────────────────────────────

/** 软件安装模式：应用私有运行时安装，或兼容保留的 npm 全局安装。 */
export type SoftwareInstallMode = "private" | "global";

/** 软件更新状态（引擎检测 + npm 最新版本） */
export type SoftwareUpdateStatus = {
  engineType: EngineType;
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  binPath: string | null;
  npmPackage: string;
  updateAvailable: boolean;
  error: string | null;
  /** 安装模式；私有模式为 private，旧的全局安装链路缺省。 */
  installMode?: SoftwareInstallMode;
  /** 私有清单给出的估算安装体积（字节），供 UI 展示磁盘占用。 */
  installSizeBytes?: number | null;
};

export type SoftwareInstallPlatform = "windows" | "mac" | "linux" | "unknown";

export type SoftwareInstallEnvironment = {
  platform: SoftwareInstallPlatform;
  npmGlobalPrefix: string | null;
  npmGlobalInstallWritable: boolean | null;
  requiresPrivilege: boolean;
  /** 私有模式下为 private，且不探测、不依赖 npm 全局目录。 */
  installMode?: SoftwareInstallMode;
};

export type GetSoftwareUpdateStatusResponseBody = {
  items: SoftwareUpdateStatus[];
  environment: SoftwareInstallEnvironment;
};

export type NpmInstallSourceMode = "auto" | "npmmirror" | "official" | "proxyOfficial" | "inherit";

export type NpmInstallNetworkOptions = {
  mode?: NpmInstallSourceMode;
  proxyUrl?: string | null;
};

export type GetSoftwareUpdateStatusRequestBody = {
  network?: NpmInstallNetworkOptions;
  /** 显式要求服务端跳过进程内 CLI 探测缓存。 */
  forceRefresh?: boolean;
};

export type NpmInstallAttempt = {
  source: Exclude<NpmInstallSourceMode, "auto">;
  registry: string | null;
  success: boolean;
  error: string | null;
  durationMs: number;
};

export type NpmInstallRequestBody = {
  npmPackage: string;
  version?: string | null;
  network?: NpmInstallNetworkOptions;
};

export type NpmInstallResponseBody = {
  npmPackage: string;
  success: boolean;
  installedVersion: string | null;
  output: string;
  error: string | null;
  message?: string | null;
  noUpgradeNeeded?: boolean;
  requiresPrivilege?: boolean;
  attempts?: NpmInstallAttempt[];
  nextAction?: "configureProxy" | "retryOfficial" | "sudo" | "checkPermission" | null;
};

export type ClientExitRequestBody = {
  clientId: string;
};

export type ClientExitResponseBody = {
  clientId: string;
  exiting: true;
};

// ── MCP Servers ──────────────────────────────────────────────────

export type MarketplaceEntrySource = "builtin" | "custom" | "imported";

/** MCP 目录条目的安装来源；连接方式与安装方式独立表达。 */
export type McpInstallType = "local-command" | "http" | "sse" | "npm" | "pypi" | "imported";

/** MCP 与目标引擎之间的传输协议。 */
export type McpTransportType = "stdio" | "streamable-http" | "sse";

/** MCP 凭据输入；值只允许在本次请求中传递到目标 Client。 */
export type McpCredentialInput = {
  name: string;
  value: string;
  kind: "env" | "header";
};

/** MCP 条目的安全提示等级，仅用于页面提示，不承担额外鉴权。 */
export type McpSecurityLevel = "low" | "medium" | "high";

/** MCP Server 注册信息（来自预置注册表） */
export type McpServerInfo = {
  /** 目录级稳定身份，不随 npm 包版本变化。 */
  mcpId: string;
  /** NPM 安装类型使用的包名；远程/本地命令类型为空。 */
  npmPackage: string | null;
  /** 引擎 MCP 配置中的 server 名称（如 claude mcp add <serverName>） */
  serverName: string | null;
  name: string;
  description: string;
  homepage: string | null;
  source?: MarketplaceEntrySource;
  /** 自定义/导入条目的工作区作用域；内置目录条目不设置。 */
  workspaceScope?: string | null;
  installType: McpInstallType;
  transportType: McpTransportType;
  installSpecSummary?: string | null;
  prerequisites?: string[];
  securityLevel?: McpSecurityLevel;
  recommended?: boolean;
  /** 是否作为 MCP 首次加载时优先选中的推荐项。 */
  featuredRecommended?: boolean;
  recommendedRank?: number | null;
  categories?: string[];
  /** 本地命令类型的可执行文件和参数。 */
  command?: string | null;
  args?: string[];
  /** 远程 HTTP/SSE 类型的服务地址。 */
  url?: string | null;
  /** PyPI 类型的包名和运行器。 */
  pythonPackage?: string | null;
  runner?: string | null;
};

/** MCP Server 安装状态（运行时检测） */
export type McpServerStatus = {
  /** 当前目标上的稳定配置身份。 */
  mcpId: string;
  /** 同一个 MCP 在不同参数/凭据配置下可有不同实例。 */
  instanceId: string;
  npmPackage: string | null;
  /** npm 全局安装状态 */
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** 是否已在 Claude Code 中配置（用户级或项目级） */
  configuredInClaude: boolean;
  /** 是否已在 Codex 中配置（用户级或项目级） */
  configuredInCodex: boolean;
  /** 是否已在项目 .mcp.json 中配置（Claude/Codex 共用） */
  configuredInProject: boolean;
  installType: McpInstallType;
  transportType: McpTransportType;
  installationStatus: "installed" | "not-installed" | "not-required" | "unknown";
  credentialConfigured?: boolean;
  error: string | null;
};

export type McpInstallRequestBody = {
  workspaceId?: WorkspaceId;
  mcpId?: string | null;
  instanceId?: string | null;
  npmPackage?: string | null;
  version?: string | null;
  serverName?: string | null;
  name?: string | null;
  description?: string | null;
  homepage?: string | null;
};
export type McpInstallResponseBody = { npmPackage: string | null; success: boolean; installedVersion: string | null; error: string | null };

export type McpConfigureRequestBody = {
  workspaceId?: WorkspaceId;
  mcpId?: string | null;
  instanceId?: string | null;
  npmPackage?: string | null;
  engine: "claude" | "codex";
  serverName?: string | null;
  name?: string | null;
  description?: string | null;
  homepage?: string | null;
  installType?: McpInstallType;
  transportType?: McpTransportType;
  command?: string | null;
  args?: string[];
  url?: string | null;
  pythonPackage?: string | null;
  runner?: string | null;
  credentialInputs?: McpCredentialInput[];
};

export type McpUnconfigureRequestBody = {
  workspaceId?: WorkspaceId;
  mcpId?: string | null;
  instanceId?: string | null;
  npmPackage?: string | null;
  engine: "claude" | "codex";
  serverName?: string | null;
};

export type McpUninstallRequestBody = {
  workspaceId?: WorkspaceId;
  mcpId?: string | null;
  instanceId?: string | null;
  npmPackage?: string | null;
  serverName?: string | null;
};
export type McpUninstallResponseBody = {
  npmPackage: string;
  success: boolean;
  error: string | null;
  errorCode?: "MCP_UNINSTALL_BLOCKED_BY_ENGINE_CONFIG" | null;
};

export type McpEnableStageName = "resolve_target" | "prepare_install_or_remote_config" | "configure_engine" | "test_connection";
export type McpEnableStage = {
  name: McpEnableStageName;
  status: "pending" | "running" | "succeeded" | "failed";
  message?: string | null;
};

export type McpEnableRequestBody = {
  workspaceId?: WorkspaceId;
  mcpId?: string | null;
  instanceId?: string | null;
  npmPackage?: string | null;
  engine: "claude" | "codex";
  version?: string | null;
  serverName?: string | null;
  name?: string | null;
  description?: string | null;
  homepage?: string | null;
  installType?: McpInstallType;
  transportType?: McpTransportType;
  command?: string | null;
  args?: string[];
  url?: string | null;
  pythonPackage?: string | null;
  runner?: string | null;
  credentialInputs?: McpCredentialInput[];
};

export type McpEnableResponseBody = {
  ok: boolean;
  operationId: string;
  mcpId: string;
  instanceId: string;
  npmPackage: string | null;
  engine: "claude" | "codex";
  stage: McpEnableStageName | null;
  stages: McpEnableStage[];
  installedVersion: string | null;
  enabled: boolean;
  errorCode: string | null;
  message: string | null;
  credentialConfigured?: boolean;
};

export type McpUpdateRequestBody = McpEnableRequestBody;
export type McpTestRequestBody = {
  workspaceId?: WorkspaceId;
  mcpId?: string | null;
  instanceId?: string | null;
  npmPackage?: string | null;
  engine: "claude" | "codex";
  serverName?: string | null;
  name?: string | null;
  description?: string | null;
  homepage?: string | null;
};
export type McpTestResponseBody = {
  ok: boolean;
  mcpId: string;
  instanceId: string;
  engine: "claude" | "codex";
  errorCode: string | null;
  message: string;
};

export type McpImportSource = "claude" | "codex" | "vscode" | "cursor";
export type McpImportRequestBody = { workspaceId?: WorkspaceId; sources?: McpImportSource[] };
export type McpImportError = { source: McpImportSource; path: string; message: string };
export type McpImportResponseBody = { items: McpServerInfo[]; errors: McpImportError[] };

// ── Skill Suites ──────────────────────────────────────────────────

/** 技能套件的安装来源类型。 */
export type SkillInstallType = "github" | "git" | "local" | "url";

/** Skill 套件信息（registry 条目） */
export type SkillSuiteInfo = {
  suiteId: string;
  name: string;
  description: string;
  author: string;
  homepage: string | null;
  /** 套件类型：当前仅保留社区套件。 */
  kind: "external";
  /** 依赖的 MCP Server npm 包名（安装 Skill 时级联安装） */
  mcpDeps?: string[];
  /** GitHub 仓库 URL（external 套件的下载源，如 https://github.com/anthropics/skills） */
  repoUrl?: string;
  /** 仓库内 skill 目录的相对路径（默认为根目录"."） */
  skillsPath?: string;
  source?: MarketplaceEntrySource;
  /** 是否进入推荐分组；featuredRecommended 仅用于首次加载优先选中。 */
  recommended?: boolean;
  featuredRecommended?: boolean;
  recommendedRank?: number | null;
  /** 安装来源类型，默认 github。 */
  installType?: SkillInstallType;
  /** git 类型：任意 git 仓库 URL。 */
  gitUrl?: string;
  /** local 类型：Client/Host 本机目录路径。 */
  localPath?: string;
  /** url 类型：压缩包下载地址（zip/tar/tgz）。 */
  archiveUrl?: string;
};

/** Skill 套件在某个 target 上的安装状态 */
export type SkillSuiteTargetStatus = {
  suiteId: string;
  targetId: string;
  label: string;
  skillsRoot: string;
  installed: SkillsInstalledInfo | null;
  ready: boolean;
  message: string | null;
};

/** 套件列表（含安装状态）响应 */
export type GetSkillSuitesResponseBody = {
  suites: SkillSuiteInfo[];
  /** 各套件在各 target 上的安装状态（按 suiteId 分组） */
  targetStatus: Record<string, SkillSuiteTargetStatus[]>;
  /** 预置 MCP Server 列表 */
  mcpServers?: McpServerInfo[];
  /** 各 MCP Server 的安装状态（按 npmPackage 索引） */
  mcpStatus?: Record<string, McpServerStatus>;
  /** true 表示当前仅返回公共市场目录，未读取当前账号/Client 的安装状态。 */
  catalogOnly?: boolean;
};

// ── Terminal Actions ─────────────────────────────────────────────

export type ListTerminalActionsResponseBody = { actions: TerminalAction[] };
export type SaveTerminalActionsRequestBody = { workspaceId: WorkspaceId; actions: TerminalAction[] };
export type SaveTerminalActionsResponseBody = { actions: TerminalAction[] };
export type ListTerminalShellsResponseBody = { shells: TerminalShellOption[] };

// ── Thread Prefs（会话级偏好持久化） ─────────────────────────
export type ThreadPrefs = {
  model?: string | null;
  effort?: string | null;
  accessMode?: AccessMode | null;
  planMode?: boolean | null;
  /** 普通会话是否允许读取项目知识；新会话在资产树已初始化时默认开启。 */
  knowledgeEnabled?: boolean | null;
  autoCompactPct?: number | null;
  contextWindow?: number | null;
  serviceTier?: CodexServiceTier | null;
  roleId?: RoleId | null;
};

export type UpdateThreadPrefsRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  prefs: ThreadPrefs;
};

export type UpdateThreadPrefsResponseBody = {
  /** 偏好已持久化，但当前运行轮次的权限模式未切换时的用户提示。 */
  permissionModeWarning?: string;
};

export type GetThreadPrefsRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
};

export type GetThreadPrefsResponseBody = {
  prefs: ThreadPrefs | null;
};

export type GetLatestThreadPrefsRequestBody = { workspaceId: WorkspaceId; engine: EngineType; threadId?: ThreadId };
export type GetLatestThreadPrefsResponseBody = { prefs: ThreadPrefs | null };

// ── Workspace Prefs（工作区级偏好持久化） ─────────────────────
export type WorkspacePref = {
  engine: EngineType;
  workMode: "general";
  /** 上下文窗口覆盖值（token 数），null/undefined = 使用模型默认值。 */
  contextWindow?: number | null;
  /** 自动压缩阈值（百分比 50-99），null/undefined = 使用产品默认值 90%；Codex 会在运行时换算为 token 阈值。 */
  autoCompactPct?: number | null;
};

export type GetWorkspacePrefsResponseBody = { prefs: WorkspacePref[] };
export type SaveWorkspacePrefsRequestBody = { workspaceId: WorkspaceId; prefs: WorkspacePref[] };
export type SaveWorkspacePrefsResponseBody = { prefs: WorkspacePref[] };

// ── Client Version ──────────────────────────────────────────────

export type ClientLatestResponse =
  | { ok: true; version: string; url: string; platformKey?: string | null }
  | { ok: false; message: string };

// ── Engine Keys ─────────────────────────────────────────────────

// ── Engine Keys ─────────────────────────────────────────────────

export type EngineKeyEntry = {
  id: string;
  source?: "unknown" | "user_configured" | "builtin";
  serverOrigin?: string | null;
  ownerUserId?: string | null;
  keyId?: string | null;
  runtimeAvailable?: boolean;
  label: string;
  engine: "claude" | "codex";
  providerId: EngineModelProviderId;
  apiKey: string;
  baseUrl: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ListEngineKeysResponseBody = { keys: EngineKeyEntry[] };
export type UpsertEngineKeyRequestBody = {
  id?: string;
  label: string;
  engine: "claude" | "codex";
  providerId?: EngineModelProviderId | null;
  apiKey: string;
  baseUrl?: string | null;
  /** 用户确认后，先安全停止当前 Client 的普通 Codex 回合再保存激活配置。 */
  stopRunningTurns?: boolean;
};
export type DeleteEngineKeyRequestBody = { id: string };
/** 使用尚未保存的 Key 配置做一次最小模型请求，验证凭据与 Base URL。 */
export type TestEngineKeyRequestBody = {
  engine: "claude" | "codex";
  providerId?: EngineModelProviderId | null;
  apiKey: string;
  baseUrl?: string | null;
};
export type TestEngineKeyResponseBody = {
  ok: boolean;
  /** 失败原因；不得包含完整 API Key。 */
  message?: string;
  latencyMs?: number;
  model?: string;
};
export type ActivateEngineKeyRequestBody = {
  id: string;
  /** 用户确认后，先安全停止当前 Client 的普通 Codex 回合再切换 Key。 */
  stopRunningTurns?: boolean;
};
export type DeactivateEngineKeyRequestBody = { id: string };

/** Codex Key 切换冲突的稳定细分原因，供 Client、Server 与 Web 共用。 */
export const CODEX_KEY_SWITCH_CONFLICT_REASONS = {
  runningTurnsConfirmRequired: "CODEX_RUNNING_TURNS_CONFIRM_REQUIRED",
  controlledExperimentRunning: "CODEX_CONTROLLED_EXPERIMENT_RUNNING",
  runningTurnsStopFailed: "CODEX_RUNNING_TURNS_STOP_FAILED",
} as const;

export type EngineCustomModelReasoningEffortInput = ReasoningEffort | ReasoningEffortOption;

export type ListEngineCustomModelsResponseBody = { models: EngineCustomModelEntry[] };
export type UpsertEngineCustomModelRequestBody = {
  id?: string | null;
  engine: EngineType;
  providerId: EngineModelProviderId;
  modelId: string;
  displayName?: string | null;
  inputModalities?: InputModality[] | null;
  supportedReasoningEfforts?: EngineCustomModelReasoningEffortInput[] | null;
  defaultReasoningEffort?: ReasoningEffort | null;
  contextWindow?: number | null;
  maxContextWindow?: number | null;
  supportsFastMode?: boolean | null;
  supports1MContext?: boolean | null;
  enabled?: boolean | null;
};
export type DeleteEngineCustomModelRequestBody = { id: string };

export type UsageOverview = {
  totalKeys: number;
  activeKeys: number;
  todayLogins: number;
  todayMessages: number;
  activeSessions: number;
};

export type UsageLogEntry = {
  id: number;
  keyHash: string;
  action: string;
  workspaceId: string | null;
  detail: string;
  createdAt: number;
};

export type AdminSessionInfo = {
  id: string;
  sessionKind: "client" | "web";
  accountSessionId?: string | null;
  keyHash: string;
  clientId?: string;
  webSessionId?: string;
  webInstanceId?: string;
  userId?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  accountRole?: AccountRole | null;
  enterpriseId?: string | null;
  connectedAt: number;
  lastSeenAt?: number | null;
  sessionExpiresAt?: number | null;
  connectedWebCount?: number;
  clientVersion: string | null;
  activeWorkspaceId?: string | null;
  workspaceIds?: string[];
};

export type AdminStatsKeyDetailItem = {
  keyId: string;
  keyName: string;
  keyPrefix: string;
  isActive: boolean;
  expiresAt: number;
  lastUsedAt: number;
  loginCount: number;
  messageCount: number;
  createdAt: number;
};

export type AdminStatsKeyDetailsResponseBody = {
  items: AdminStatsKeyDetailItem[];
  total: number;
};

export type AdminStatsUsageDetailItem = {
  logId: number;
  keyHash: string;
  keyName: string;
  keyPrefix: string;
  action: "login" | "message" | "terminal" | "git_write";
  workspaceId: string | null;
  workspaceTitle?: string | null;
  workspacePath?: string | null;
  detail: string;
  createdAt: number;
};

export type AdminStatsUsageDetailsResponseBody = {
  items: AdminStatsUsageDetailItem[];
  total: number;
};

export type SiteContactInfo = {
  phone: string;
  email: string;
  wechatContacts: string[];
  wechatGroupQrImage: string;
  officialAccountQrImage: string;
  address: string;
};

export type GetPublicContactInfoResponseBody = {
  contactInfo: SiteContactInfo;
};
/** 普通 Client 运行身份登记，不包含数据库密钥或设备私钥。 */
export type ClientDeviceRegisterRequestBody = {
  clientId: string;
  clientVersion?: string | null;
  deviceId: string;
  deviceFingerprintHash: string;
  deviceAuthMode: "runtime";
  platform: string;
  arch: string;
};

export type ClientDeviceRegisterResponseBody = {
  deviceId: string;
  status: "active" | "pending" | "revoked" | "blocked";
  serverNow: number;
};

export type ClientDbStartupContextRequestBody = {
  clientVersion?: string | null;
  platform: string;
  arch: string;
};
export type ClientDbStartupContextResponseBody = {
  accountNamespace: string;
  serverNow: number;
};

export type RequirementAnalysisSessionListMeta = {
  listStatus: RequirementDraftListStatus;
  listStatusLabel: string;
  recommendedWorkflowName?: string | null;
};

export type TaskIntakeListMeta = {
  listStatus: TaskIntakeListStatus;
  listStatusLabel: string;
  attentionStatus?: ListAttentionStatus | null;
  attentionLabel?: string | null;
  attentionActionKind?: ReminderActionKind | null;
  workflowName?: string | null;
  instanceCount: number;
  latestInstance?: OrchestrationInstanceSummary | null;
  progressText?: string | null;
};

export type PendingMineListItem = {
  reminder: ReminderItem;
  intake: TaskIntake;
  listMeta: TaskIntakeListMeta;
  pendingMineStatus: PendingMineListStatus;
  pendingMineStatusLabel: string;
};

export type ClientLogTailEntry = {
  time: string | null;
  level: string | null;
  module: string | null;
  message: string;
  raw: string;
};

export type ClientLogFileItem = {
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
};

export type ClientLogFileListRequestBody = {
  clientId: string;
};

export type ClientLogFileListResponseBody = {
  clientId: string;
  files: ClientLogFileItem[];
  readAt: number;
};

export type ClientLogTailRequestBody = {
  clientId: string;
  fileName?: string | null;
  lines?: number;
  maxBytes?: number;
};

export type ClientLogTailResponseBody = {
  clientId: string;
  logFileName: string | null;
  lines: ClientLogTailEntry[];
  lineCount: number;
  truncated: boolean;
  readAt: number;
};

export type ClientLogDownloadRequestBody = {
  clientId: string;
  fileName: string;
};

export type ClientLogDownloadResponseBody = {
  clientId: string;
  fileName: string;
  contentBase64: string;
  sizeBytes: number;
  contentType: string;
};

// ── Orchestration ────────────────────────────────────────────────

export type OrchRolesListResponseBody = {
  roles: RoleDefinition[];
  assetMetadata?: OrchAssetListMetadata<"role">[];
};
/** 无工作区只读预览返回的已发布内置资产定义；字段与既有列表接口拍平后保持一致。 */
export type OrchBuiltinAssetCatalogDefinitionByType = {
  role: RoleDefinition;
  workflow: WorkflowDefinition;
  knowledge_bundle: KnowledgeBundleDefinition;
  toolset: ToolsetDefinition;
  skill: SkillDefinition;
};
/** 无工作区只读预览的单个条目；definition.workspaceId 恒为空字符串。 */
export type OrchBuiltinAssetCatalogItem<T extends OrchAssetType = OrchAssetType> = {
  assetType: T;
  assetId: string;
  revision: number;
  scopeType: OrchAssetScopeType;
  contentHash: string;
  definition: OrchBuiltinAssetCatalogDefinitionByType[T];
};
export type OrchBuiltinAssetCatalogResponseBody = {
  items: OrchBuiltinAssetCatalogItem[];
};
/** Carries optional rolling-upgrade fields that become mandatory after Server authority cutover. */
export type OrchAssetSingleUpsertRequestMetadata = {
  clientRequestId?: string;
  expectedRevision?: number | null;
};
/** Carries optional rolling-upgrade fields that become mandatory after Server authority cutover. */
export type OrchAssetSingleDeleteRequestMetadata = {
  clientRequestId?: string;
  expectedRevision?: number;
};
/** Identifies a successful Server mutation while remaining absent on legacy Client responses. */
export type OrchAssetSingleMutationResponseMetadata<T extends OrchAssetListMetadata["assetType"]> = {
  changeSeq?: number;
  cacheStatus?: OrchAssetCacheStatus;
  assetMetadata?: OrchAssetListMetadata<T>;
};
export type OrchRolesUpsertRequestBody = {
  workspaceId: WorkspaceId;
  role: Omit<RoleDefinition, "createdAt" | "updatedAt">;
} & OrchAssetSingleUpsertRequestMetadata;
export type OrchRolesUpsertResponseBody = {
  role: RoleDefinition;
} & OrchAssetSingleMutationResponseMetadata<"role">;
export type OrchRolesDeleteRequestBody = {
  workspaceId: WorkspaceId;
  roleId: RoleId;
} & OrchAssetSingleDeleteRequestMetadata;
export type OrchRolesDeleteResponseBody = OrchAssetSingleMutationResponseMetadata<"role">;
export type OrchAssetGroupsListResponseBody = { groups: OrchAssetGroup[]; assignments: Record<string, string> };
export type OrchAssetGroupsCreateRequestBody = { workspaceId: WorkspaceId; assetType: OrchAssetGroupType; name: string };
export type OrchAssetGroupMutationResponseMetadata = {
  changeSeq?: number | null;
  cacheStatus?: OrchAssetCacheStatus | null;
};
export type OrchAssetGroupsCreateResponseBody = { group: OrchAssetGroup } & OrchAssetGroupMutationResponseMetadata;
export type OrchAssetGroupsRenameRequestBody = { workspaceId: WorkspaceId; assetType: OrchAssetGroupType; groupId: string; name: string };
export type OrchAssetGroupsRenameResponseBody = { group: OrchAssetGroup } & OrchAssetGroupMutationResponseMetadata;
export type OrchAssetGroupsDeleteRequestBody = { workspaceId: WorkspaceId; assetType: OrchAssetGroupType; groupId: string };
export type OrchAssetGroupsDeleteResponseBody = {
  removedAssignmentCount?: number;
} & OrchAssetGroupMutationResponseMetadata;
export type OrchAssetGroupsAssignRequestBody = { workspaceId: WorkspaceId; assetType: OrchAssetGroupType; assetId: string; groupId?: string | null };
export type OrchAssetGroupsAssignResponseBody = {
  groupId: string | null;
  changed?: boolean;
} & OrchAssetGroupMutationResponseMetadata;
export type OrchAssetBundlesExportRequestBody = {
  workspaceId: WorkspaceId;
  workflowIds?: WorkflowId[] | null;
  roleIds?: RoleId[] | null;
  knowledgeBundleIds?: KnowledgeBundleId[] | null;
  skillIds?: SkillId[] | null;
  toolsetIds?: ToolsetId[] | null;
};
export type OrchAssetBundlesExportResponseBody = { bundle: OrchAssetBundle };
export type OrchAssetBundlesImportRequestBody = {
  workspaceId: WorkspaceId;
  bundle: OrchAssetBundle;
  importMode?: OrchAssetBundleImportMode | null;
  clientRequestId?: string | null;
};
export type OrchAssetBundlesImportResponseBody = {
  imported: {
    roles: RoleDefinition[];
    knowledgeBundles: KnowledgeBundleDefinition[];
    skills: SkillDefinition[];
    toolsets: ToolsetDefinition[];
    workflows: WorkflowDefinition[];
    warnings: OrchAssetBundleWarning[];
    overwritten: OrchAssetBundleImportCounts;
    skipped: OrchAssetBundleImportCounts;
    copied: OrchAssetBundleImportCounts;
  };
  changeSeq?: number | null;
  cacheStatus?: OrchAssetCacheStatus;
  assetMetadata?: OrchAssetListMetadata[];
};

export type OrchAssetDraftContextOptions = {
  includeWorkspaceFiles?: boolean | null;
  includeExistingAssets?: boolean | null;
  includeWorkbenchDocs?: boolean | null;
  maxContextChars?: number | null;
  selectedPaths?: string[] | null;
};

export type OrchAssetDraftEnginePreference = {
  engine?: "claude" | "codex" | null;
  model?: string | null;
  effort?: string | null;
  contextWindow?: number | null;
  autoCompactPct?: number | null;
  serviceTier?: CodexServiceTier | null;
};

export type OrchAssetDraftReviewInput = {
  comment?: string | null;
  acknowledgedWarningCodes?: string[] | null;
  reviewedDiffHash?: string | null;
};

export type OrchAssetDraftGenerateRequestBody = {
  workspaceId: WorkspaceId;
  assetKind: "role" | "skill";
  mode: "create" | "revise";
  targetAssetId?: string | null;
  roleSnapshot?: Omit<RoleDefinition, "createdAt" | "updatedAt"> | null;
  skillSnapshot?: Omit<SkillDefinition, "createdAt" | "updatedAt"> | null;
  clientRequestId?: string | null;
  prompt: string;
  contextOptions?: OrchAssetDraftContextOptions | null;
  enginePreference?: OrchAssetDraftEnginePreference | null;
};

export type OrchAssetDraftGenerateResponseBody = {
  reusedJob: boolean;
  job: AssetGenerationJob;
};

export type OrchAssetDraftJobGetRequestBody = {
  workspaceId: WorkspaceId;
  jobId: AssetGenerationJobId;
};

export type OrchAssetDraftJobSummary = {
  id: AssetDraftId;
  status: AssetDraft["status"];
  validationIssueCount: number;
  blockingIssueCount: number;
};

export type OrchAssetDraftJobListItem = {
  job: AssetGenerationJob;
  draft: OrchAssetDraftJobSummary | null;
};

export type OrchAssetDraftJobsListRequestBody = {
  workspaceId: WorkspaceId;
  limit?: number | null;
};

export type OrchAssetDraftJobsListResponseBody = {
  jobs: OrchAssetDraftJobListItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type OrchAssetDraftJobDeleteRequestBody = {
  workspaceId: WorkspaceId;
  jobId: AssetGenerationJobId;
};

export type OrchAssetDraftJobDeleteResponseBody = {
  jobId: AssetGenerationJobId;
  threadId: ThreadId | null;
};

export type OrchAssetDraftJobGetResponseBody = {
  job: AssetGenerationJob;
  draft: OrchAssetDraftJobSummary | null;
  events: AssetJobEventView[];
};

export type OrchAssetDraftJobResumeRequestBody = {
  workspaceId: WorkspaceId;
  jobId: AssetGenerationJobId;
  prompt: string;
  selectedPaths?: string[] | null;
  targetThreadId?: ThreadId | null;
  /** 本轮恢复使用的执行参数；未传字段继续沿用任务快照。 */
  enginePreference?: OrchAssetDraftEnginePreference | null;
};

export type OrchAssetDraftJobResumeResponseBody = {
  job: AssetGenerationJob;
};

export type OrchAssetDraftGetRequestBody = {
  workspaceId: WorkspaceId;
  draftId: AssetDraftId;
};

export type OrchAssetDraftGetResponseBody = {
  draft: AssetDraft;
  payload: RoleDraftPayload | SkillDraftPayload;
  comparison: RoleDraftComparison | SkillDraftComparison;
  job: AssetGenerationJob | null;
  /** 草案已应用时，回传其落地的正式角色与版本，便于前端"查看 Agent"跳转及重名自排除；未应用为 null。 */
  appliedRoleId: RoleId | null;
  /** 草案已应用时，回传其落地的正式 Skill 与版本；未应用为 null。 */
  appliedSkillId: SkillId | null;
  appliedVersionId: AssetVersionId | null;
};

export type OrchAssetDraftApplyRequestBody = {
  workspaceId: WorkspaceId;
  draftId: AssetDraftId;
  expectedJobId?: AssetGenerationJobId | null;
  expectedBaseVersionId?: AssetVersionId | null;
  forceApplyWarnings?: boolean | null;
  review?: OrchAssetDraftReviewInput | null;
};

export type OrchAssetDraftApplyResponseBody = {
  assetKind: "role";
  roleId: RoleId;
  versionId: AssetVersionId;
  appliedDraftId: AssetDraftId;
} | {
  assetKind: "skill";
  skillId: SkillId;
  versionId: AssetVersionId;
  appliedDraftId: AssetDraftId;
};

export type OrchAssetDraftRejectRequestBody = {
  workspaceId: WorkspaceId;
  draftId: AssetDraftId;
  reason?: string | null;
  review?: Omit<OrchAssetDraftReviewInput, "acknowledgedWarningCodes"> | null;
};

export type OrchAssetDraftRejectResponseBody = {
  draftId: AssetDraftId;
  status: "rejected";
};

export type OrchAssetDraftErrorDetails = {
  existingJob?: AssetGenerationJob | null;
  issues?: AssetValidationIssue[] | null;
  failure?: AssetGenerationJob["failure"] | null;
};

export type OrchIntakesListResponseBody = {
  intakes: TaskIntake[];
  hasMore: boolean;
  nextCursor: string | null;
  statusCounts?: Array<ListStatusCount<TaskIntakeListStatus>>;
  totalCount?: number;
  listMetaById?: Record<string, TaskIntakeListMeta>;
  listPageMeta?: ListPageMeta;
};
export type OrchIntakesListRequestQuery = {
  workspaceId: WorkspaceId;
  limit?: number;
  cursor?: string | null;
  search?: string | null;
  statuses?: TaskIntakeListStatus[] | null;
  /** 列表来源分流；requirement 排除定时任务，scheduled_task 只返回定时任务调度生成的编排。 */
  sourceKind?: TaskIntakeSourceKind | null;
  /** 共享工作区列表筛选；true 仅返回 owner/participant 相关需求，false 允许返回团队只读需求。 */
  onlyRelatedToMe?: boolean | null;
};
export type OrchIntakesCreateRequestBody = {
  workspaceId: WorkspaceId;
  intake: Omit<TaskIntake, "id" | "workspaceId" | "createdAt" | "updatedAt">;
};
export type OrchIntakesCreateResponseBody = { intake: TaskIntake };
export type OrchIntakesUpsertRequestBody = {
  workspaceId: WorkspaceId;
  intake: Omit<TaskIntake, "workspaceId" | "createdAt" | "updatedAt">;
};
export type OrchIntakesUpsertResponseBody = { intake: TaskIntake };
export type OrchIntakesDeleteRequestBody = {
  workspaceId: WorkspaceId;
  intakeId: IntakeId;
  forceDeleteRunning?: boolean | null;
};
export type OrchIntakesDeleteResponseBody = {
  deletedProposalCount: number;
  deletedInstanceCount: number;
  deletedThreadCount: number;
  cancelledActiveInstanceCount: number;
};

export type OrchRequirementAnalysisSessionsListResponseBody = {
  sessions: RequirementAnalysisSession[];
  hasMore: boolean;
  nextCursor: string | null;
  statusCounts?: Array<ListStatusCount<RequirementDraftListStatus>>;
  totalCount?: number;
  listMetaById?: Record<string, RequirementAnalysisSessionListMeta>;
  listPageMeta?: ListPageMeta;
};
export type OrchRequirementAnalysisSessionsListRequestQuery = {
  workspaceId: WorkspaceId;
  limit?: number;
  cursor?: string | null;
  search?: string | null;
  statuses?: RequirementDraftListStatus[] | null;
  /** 共享工作区列表筛选；true 仅返回 owner/participant 相关草稿，false 允许返回团队只读草稿。 */
  onlyRelatedToMe?: boolean | null;
};
export type OrchRequirementAnalysisSessionsCreateRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  title?: string | null;
};
export type OrchRequirementAnalysisSessionsCreateResponseBody = {
  session: RequirementAnalysisSession;
  messages: RequirementAnalysisMessage[];
  candidates: RequirementCandidateDraft[];
};
export type OrchRequirementAnalysisSessionsGetRequestBody = {
  workspaceId: WorkspaceId;
  sessionId: RequirementAnalysisSessionId;
};
export type OrchRequirementAnalysisSessionsGetResponseBody = {
  session: RequirementAnalysisSession;
  messages: RequirementAnalysisMessage[];
  candidates: RequirementCandidateDraft[];
};
export type OrchRequirementAnalysisSessionsArchiveRequestBody = {
  workspaceId: WorkspaceId;
  sessionId: RequirementAnalysisSessionId;
  status: "active" | "archived";
};
export type OrchRequirementAnalysisSessionsArchiveResponseBody = {
  session: RequirementAnalysisSession;
};
export type OrchRequirementAnalysisMessagesSendRequestBody = {
  workspaceId: WorkspaceId;
  sessionId: RequirementAnalysisSessionId;
  text: string;
  planMode?: boolean | null;
  accessMode?: AccessMode | null;
  model?: string | null;
  effort?: string | null;
  images?: string[];
  files?: TextFileAttachment[];
  contextWindow?: number | null;
  autoCompactPct?: number | null;
  serviceTier?: CodexServiceTier | null;
};
export type OrchRequirementAnalysisMessagesSendResponseBody = {
  session: RequirementAnalysisSession;
  userMessage: RequirementAnalysisMessage;
  assistantMessage: RequirementAnalysisMessage;
  candidates: RequirementCandidateDraft[];
  payload: RequirementAnalysisAssistantPayload;
};
export type OrchRequirementAnalysisCreateIntakesRequestBody = {
  workspaceId: WorkspaceId;
  sessionId: RequirementAnalysisSessionId;
  candidateIds: RequirementCandidateId[];
  workflowSelections?: Array<{
    candidateId: RequirementCandidateId;
    workflowId: WorkflowId;
  }> | null;
};
export type OrchRequirementAnalysisCreateIntakesResponseBody = {
  created: Array<{
    candidateId: RequirementCandidateId;
    intake: TaskIntake;
    proposal: WorkflowProposal;
  }>;
};

export type OrchPendingMineListRequestQuery = {
  workspaceId: WorkspaceId;
  limit?: number;
  cursor?: string | null;
  search?: string | null;
  statuses?: PendingMineListStatus[] | null;
  onlyRelatedToMe?: boolean | null;
};

export type OrchPendingMineListResponseBody = {
  items: PendingMineListItem[];
  hasMore: boolean;
  nextCursor: string | null;
  statusCounts: Array<ListStatusCount<PendingMineListStatus>>;
  totalCount: number;
  listPageMeta?: ListPageMeta;
};

export type OrchWorkflowsListResponseBody = {
  workflows: WorkflowDefinition[];
  assetMetadata?: OrchAssetListMetadata<"workflow">[];
};
export type OrchWorkflowsUpsertRequestBody = {
  workspaceId: WorkspaceId;
  workflow: Omit<WorkflowDefinition, "createdAt" | "updatedAt">;
} & OrchAssetSingleUpsertRequestMetadata;
export type OrchWorkflowsUpsertResponseBody = {
  workflow: WorkflowDefinition;
} & OrchAssetSingleMutationResponseMetadata<"workflow">;
export type OrchWorkflowsDeleteRequestBody = {
  workspaceId: WorkspaceId;
  workflowId: WorkflowId;
} & OrchAssetSingleDeleteRequestMetadata;
export type OrchWorkflowsDeleteResponseBody = OrchAssetSingleMutationResponseMetadata<"workflow">;

export type OrchAssigneeTemplatesListRequestQuery = { workspaceId: WorkspaceId; workflowId?: WorkflowId | null };
export type OrchAssigneeTemplatesListResponseBody = { templates: AssigneeTemplate[] };
export type OrchAssigneeTemplatesUpsertInput = Omit<AssigneeTemplate, "id" | "createdAt" | "updatedAt" | "version"> & {
  id?: string | null;
  version?: number | null;
};
export type OrchAssigneeTemplatesUpsertRequestBody = { workspaceId: WorkspaceId; template: OrchAssigneeTemplatesUpsertInput };
export type OrchAssigneeTemplatesUpsertResponseBody = { template: AssigneeTemplate };
export type OrchAssigneeTemplatesDeleteRequestBody = { workspaceId: WorkspaceId; templateId: string };

export type OrchWorkflowExecutionDefaultsGetRequestQuery = { workspaceId: WorkspaceId; workflowId: WorkflowId };
export type OrchWorkflowExecutionDefaultsGetResponseBody = { executionDefault: WorkflowExecutionDefault | null };
export type OrchWorkflowExecutionDefaultsUpsertRequestBody = {
  workspaceId: WorkspaceId;
  workflowId: WorkflowId;
  engine: EngineType;
  model: string;
};
export type OrchWorkflowExecutionDefaultsUpsertResponseBody = { executionDefault: WorkflowExecutionDefault };
export type OrchWorkflowExecutionDefaultsDeleteRequestBody = { workspaceId: WorkspaceId; workflowId: WorkflowId };

export type OrchInstancesListResponseBody = {
  instances: OrchestrationInstanceSummary[];
  hasMore?: boolean;
  nextCursor?: string | null;
  totalCountByIntake?: Record<string, number>;
};
export type OrchInstancesListRequestQuery = {
  workspaceId: WorkspaceId;
  limit?: number;
  /** 列表来源分流；用于让定时编排实例不受普通需求上下文权限过滤。 */
  sourceKind?: TaskIntakeSourceKind | null;
  /** 共享工作区列表筛选；true 仅返回 owner/participant 相关执行，false 允许返回团队只读执行。 */
  onlyRelatedToMe?: boolean | null;
};
export type OrchInstancesGetRequestBody = { workspaceId: WorkspaceId; instanceId: OrchestrationId };
export type OrchInstancesGetResponseBody = { instance: OrchestrationInstance };
export type OrchInstancesRuntimePatchRequestBody = { workspaceId: WorkspaceId; instanceId: OrchestrationId };
export type OrchInstancesRuntimePatchResponseBody = { patch: OrchestrationInstanceRuntimePatch };
export type OrchInstancesReassignNodeRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
  assigneeUserIds: string[];
};
export type OrchInstancesReassignNodeResponseBody = { instance: OrchestrationInstance };

export type OrchInstancesStartRequestBody = {
  workspaceId: WorkspaceId;
  proposalId: ProposalId;
  executionEngineStrategy?: OrchestrationExecutionEngineStrategy | null;
  roleExecutionOverrides?: Record<string, OrchestrationRoleExecutionOverride> | null;
  runPlan?: OrchestrationRunPlan | null;
};
export type OrchInstancesStartResponseBody = { instanceId: OrchestrationId; proposalId?: ProposalId | null };

export type OrchInstancesPauseRequestBody = { workspaceId: WorkspaceId; instanceId: OrchestrationId };
export type OrchInstancesResumeRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId?: string | null;
  feedback?: string | null;
  artifactIds?: string[] | null;
};
export type OrchInstancesCancelRequestBody = { workspaceId: WorkspaceId; instanceId: OrchestrationId };

/** 停止单个节点的请求体：硬中断目标节点的 in-flight turn，整体 instance 继续运行。 */
export type OrchNodesCancelRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
};

/** 启动处于 waiting-start 的节点，可携带本次启动前补充说明。 */
export type OrchNodesStartRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
  /** 启动前补充说明；为空时只解除人工启动门禁。 */
  feedback?: string | null;
  actorUserId?: string | null;
};

/** 跳过处于 waiting-start 的节点，后续 DAG 调度按 skipped 前驱继续推进。 */
export type OrchNodesSkipRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
  actorUserId?: string | null;
};

export type OrchInstancesFeedbackRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
  action: FeedbackAction;
  targetNodeId?: string | null;
  feedback?: string | null;
  /** 可选：人工审核意见中粘贴的图片 dataURL。 */
  images?: string[] | null;
  artifactIds?: string[] | null;
};

/**
 * 用户主动「从指定节点重跑」：刹停当前运行，重置指定影响集到 pending，再拉起调度。
 * 未提供 rerunNodeIds 时保持“起点及全部有效下游”的兼容语义。
 */
export type OrchInstancesRerunFromNodeRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  /** 重跑起点节点；必须是 role 节点。 */
  targetNodeId: string;
  /** 可选的重跑说明，非空时写入 system_rework feedback，下轮 prompt 以 rework-upstream-node intent 注入。 */
  note?: string | null;
  /** 可选：重跑说明中粘贴的图片 dataURL。 */
  images?: string[] | null;
  /** 起点节点已有会话时的处理策略；默认复用。 */
  threadReusePolicy?: NodeThreadReusePolicy | null;
  /** 下游已运行节点已有会话时的处理策略；默认保留。 */
  downstreamThreadReusePolicy?: DownstreamThreadReusePolicy | null;
  /** 精确重跑节点集合；为空时保持“起点及全部有效下游”的既有语义。 */
  rerunNodeIds?: string[] | null;
  /** 重跑前覆盖后续节点的角色执行偏好；仅允许在实例未运行时更新。 */
  roleExecutionOverrides?: Record<string, OrchestrationRoleExecutionOverride> | null;
  /** 使用当前工作流中兼容的工作项策略覆盖本轮重跑节点，不改写历史流程快照。 */
  applyLatestWorkItemPolicy?: boolean | null;
};

export type OrchInstancesEnsureDiscussionThreadRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
};
export type OrchInstancesEnsureDiscussionThreadResponseBody = {
  thread: ThreadSummary;
  created: boolean;
};

/** 分页字段可缺省以兼容旧 Client 的完整列表响应。 */
export type OrchProposalsListResponseBody = {
  proposals: WorkflowProposalSummary[];
  hasMore?: boolean;
  nextCursor?: string | null;
};
export type OrchProposalsGetRequestBody = { workspaceId: WorkspaceId; proposalId: ProposalId };
export type OrchProposalsGetResponseBody = { proposal: WorkflowProposal };
export type OrchProposalsCreateRequestBody = {
  workspaceId: WorkspaceId;
  workflowId?: WorkflowId | null;
  roleId?: RoleId | null;
  intakeId?: IntakeId | null;
  intake?: Omit<TaskIntake, "id" | "workspaceId" | "createdAt" | "updatedAt"> | null;
};
export type OrchProposalsCreateResponseBody = { proposal: WorkflowProposal; intakeId: IntakeId };
export type OrchProposalsConfirmRequestBody = { workspaceId: WorkspaceId; proposalId: ProposalId };
export type OrchProposalsConfirmResponseBody = { proposal: WorkflowProposal };

export type OrchToolsetsListResponseBody = {
  toolsets: ToolsetDefinition[];
  assetMetadata?: OrchAssetListMetadata<"toolset">[];
};
export type OrchToolsetsUpsertRequestBody = {
  workspaceId: WorkspaceId;
  toolset: Omit<ToolsetDefinition, "createdAt" | "updatedAt">;
} & OrchAssetSingleUpsertRequestMetadata;
export type OrchToolsetsUpsertResponseBody = {
  toolset: ToolsetDefinition;
} & OrchAssetSingleMutationResponseMetadata<"toolset">;
export type OrchToolsetsDeleteRequestBody = {
  workspaceId: WorkspaceId;
  toolsetId: ToolsetId;
} & OrchAssetSingleDeleteRequestMetadata;
export type OrchToolsetsDeleteResponseBody = OrchAssetSingleMutationResponseMetadata<"toolset">;

export type OrchKnowledgeBundlesListResponseBody = {
  bundles: KnowledgeBundleDefinition[];
  assetMetadata?: OrchAssetListMetadata<"knowledge_bundle">[];
};
export type OrchKnowledgeBundlesUpsertRequestBody = {
  workspaceId: WorkspaceId;
  bundle: Omit<KnowledgeBundleDefinition, "createdAt" | "updatedAt">;
} & OrchAssetSingleUpsertRequestMetadata;
export type OrchKnowledgeBundlesUpsertResponseBody = {
  bundle: KnowledgeBundleDefinition;
} & OrchAssetSingleMutationResponseMetadata<"knowledge_bundle">;
export type OrchKnowledgeBundlesDeleteRequestBody = {
  workspaceId: WorkspaceId;
  bundleId: KnowledgeBundleId;
} & OrchAssetSingleDeleteRequestMetadata;
export type OrchKnowledgeBundlesDeleteResponseBody = OrchAssetSingleMutationResponseMetadata<"knowledge_bundle">;

export type OrchSkillsListResponseBody = {
  skills: SkillDefinition[];
  assetMetadata?: OrchAssetListMetadata<"skill">[];
};
export type OrchSkillsUpsertRequestBody = {
  workspaceId: WorkspaceId;
  skill: Omit<SkillDefinition, "createdAt" | "updatedAt">;
} & OrchAssetSingleUpsertRequestMetadata;
export type OrchSkillsUpsertResponseBody = {
  skill: SkillDefinition;
} & OrchAssetSingleMutationResponseMetadata<"skill">;
export type OrchSkillsDeleteRequestBody = {
  workspaceId: WorkspaceId;
  skillId: SkillId;
} & OrchAssetSingleDeleteRequestMetadata;
export type OrchSkillsDeleteResponseBody = OrchAssetSingleMutationResponseMetadata<"skill">;
export type OrchSkillInstallTargetStatus = {
  targetId: SkillTargetEngine;
  label: string;
  skillsRoot: string;
  installedPath: string;
  installed: boolean;
  ready: boolean;
  packageHash: string | null;
  message: string;
};
export type OrchSkillsInstallStatusRequestBody = { workspaceId: WorkspaceId; skillId: SkillId };
export type OrchSkillsInstallStatusResponseBody = { status: OrchSkillInstallTargetStatus[] };
export type OrchSkillsInstallRequestBody = {
  workspaceId: WorkspaceId;
  skillId: SkillId;
  targets: SkillTargetEngine[];
};
export type OrchSkillsInstallResponseBody = {
  results: Array<{ targetId: SkillTargetEngine; ok: boolean; skillsRoot: string; installedPath: string; message: string }>;
  status: OrchSkillInstallTargetStatus[];
};
export type OrchSkillsUninstallRequestBody = OrchSkillsInstallRequestBody;
export type OrchSkillsUninstallResponseBody = OrchSkillsInstallResponseBody;

export type OrchArtifactsListRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  /** 为 false 时只返回元数据；正文由选中产物时的 get 接口按需读取。 */
  includeContent?: boolean;
};
export type OrchArtifactsListResponseBody = { artifacts: Artifact[] };
export type OrchArtifactGetRequestBody = { workspaceId: WorkspaceId; artifactId: ArtifactId };
export type OrchArtifactGetResponseBody = { artifact: Artifact };
export type OrchArtifactFilesListRequestBody = { workspaceId: WorkspaceId; artifactId: string };
export type OrchArtifactFilesListResponseBody = { files: ArtifactFileEntry[]; fields?: NodeResultField[] | null };
export type OrchArtifactWorkspaceFileInput = {
  path: string;
  content: string;
};
export type OrchArtifactReviseRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
  artifactId: ArtifactId;
  note?: string | null;
  answer: NodeExecutionEnvelope;
  workspaceFiles?: OrchArtifactWorkspaceFileInput[] | null;
};
export type OrchArtifactReviseResponseBody = {
  artifact: Artifact;
  files: ArtifactFileEntry[];
  fields?: NodeResultField[] | null;
};

export type OrchEventsListRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  /** 可选返回最近 N 条事件；缺省保持兼容返回完整列表。 */
  limit?: number | null;
  /** false 时只返回事件摘要 payload，避免历史 nodeState 大对象进入详情初始加载。 */
  includePayload?: boolean | null;
};
export type OrchEventsListResponseBody = { events: OrchestrationEventRecord[] };

export type OrchNodeWorkItemsListRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
  /** 按名称、标识、来源或产出路径搜索工作项。 */
  search?: string | null;
  statuses?: NodeWorkItemStatus[] | null;
  includeDeleted?: boolean | null;
  limit?: number | null;
  cursor?: string | null;
};

export type OrchNodeWorkItemsListResponseBody = {
  board: NodeWorkItemBoard | null;
  summary: NodeWorkItemSummary;
  items: NodeWorkItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type OrchNodeWorkItemEventsListRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
  itemId?: string | null;
  limit?: number | null;
  cursor?: string | null;
};

export type OrchNodeWorkItemEventsListResponseBody = {
  events: NodeWorkItemEvent[];
  hasMore: boolean;
  nextCursor: string | null;
};
export type OrchPromptSnapshotsListRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId?: string | null;
  /** 可选返回最近 N 条快照；缺省保持兼容返回完整列表。 */
  limit?: number | null;
  /** 缺省 false，只返回快照元数据；true 时返回完整 prompt 内容。 */
  includeContent?: boolean | null;
};
export type OrchPromptSnapshotsListResponseBody = { snapshots: NodePromptSnapshot[] };
export type OrchPromptSnapshotGetRequestBody = { workspaceId: WorkspaceId; promptSnapshotId: string };
export type OrchPromptSnapshotGetResponseBody = { snapshot: NodePromptSnapshot };

export type OrchRuntimeEvidenceEventRef = {
  seq: number;
  kind: string;
  occurredAt: number;
};

export type OrchRuntimeEvidenceTurnRef = {
  turnId: string;
  status: string;
  startedAt: number;
  endedAt?: number | null;
};

export type OrchRuntimeEvidenceThread = {
  threadId: ThreadId;
  sources: Array<"master" | "node" | "prompt_snapshot">;
  conversationEventCount: number;
  rawEngineEventCount: number;
  turnCount: number;
  latestConversationEvents: OrchRuntimeEvidenceEventRef[];
  latestRawEngineEvents: OrchRuntimeEvidenceEventRef[];
  latestTurns: OrchRuntimeEvidenceTurnRef[];
};

export type OrchRuntimeEvidencePromptSnapshotRef = Pick<
  NodePromptSnapshot,
  "id" | "nodeId" | "attemptNo" | "threadId" | "turnId" | "engine" | "model" | "effort" | "createdAt"
>;

export type OrchRuntimeEvidenceStatus = "available" | "missing" | "incomplete";

/**
 * 节点耗时分解：回答「这个节点的执行时间花在哪」，只含计数与耗时，不含事件正文。
 * 时间线按该节点的全部尝试线程（含历史线程）合并后计算，因此静默段可能是尝试之间的等待。
 */
export type OrchNodeRuntimeBreakdown = {
  /** 参与统计的引擎事件时间线来源线程数。 */
  threadCount: number;
  /** 引擎事件总数（含流式增量与心跳）。 */
  eventCount: number;
  startedAt: number | null;
  endedAt: number | null;
  /** 工具调用次数（同一 tool_use 只计一次）与按工具分类的计数。 */
  toolCallCount: number;
  toolCallsByTool: Array<{ tool: string; count: number }>;
  /** 耗时最长的若干次工具调用，用于区分「模型慢」与「命令慢」。 */
  slowestCalls: Array<{ tool: string; seconds: number; detail: string; startedAt: number }>;
  /** 测试类命令执行次数（playwright / vitest / jest / node --test / pnpm test 等）。 */
  testCommandCount: number;
  /** 检测到的引擎心跳间隔（秒）；等待模型时引擎按固定周期打点，用于区分正常等待与真实卡顿。 */
  heartbeatSeconds: number | null;
  /** 剔除心跳后的最大静默段（秒）及其起点；为 0 表示没有超过心跳周期的空档。 */
  maxSilenceSeconds: number;
  maxSilenceStartedAt: number | null;
  computedAt: number;
};

export type OrchRuntimeEvidenceGetRequestBody = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId?: string | null;
  attemptNo?: number | null;
  /** 可选精确选择一次 Prompt 调用并返回该 Turn 的受限正文。 */
  promptSnapshotId?: string | null;
  /** 每类事件和 turn 最多返回的定位引用数。 */
  limit?: number | null;
};

export type OrchRuntimeEvidenceTraceDetail = {
  promptSnapshot: NodePromptSnapshot;
  turn: OrchRuntimeEvidenceTurnRef | null;
  conversationEventCount: number;
  conversationEventsTruncated: boolean;
  conversationEvents: ConversationEventEnvelope[];
  rawEngineEventCount: number;
  rawEngineEventsTruncated: boolean;
  rawEngineEvents: RawEngineEventEnvelope[];
};

export type OrchRuntimeEvidenceGetResponseBody = {
  instanceId: OrchestrationId;
  nodeId: string | null;
  attemptNo: number | null;
  scopeStatus: "available" | "incomplete";
  unresolvedScopeRefs: string[];
  promptSnapshotTotal: number;
  promptSnapshotsTruncated: boolean;
  promptSnapshots: OrchRuntimeEvidencePromptSnapshotRef[];
  traceDetail: OrchRuntimeEvidenceTraceDetail | null;
  threads: OrchRuntimeEvidenceThread[];
  /** 仅在按节点（nodeId）查询时给出；用于回答「这个节点为什么慢」。 */
  runtimeBreakdown: OrchNodeRuntimeBreakdown | null;
  status: {
    promptSnapshot: OrchRuntimeEvidenceStatus;
    conversationTrace: OrchRuntimeEvidenceStatus;
    rawTrace: OrchRuntimeEvidenceStatus;
  };
};
