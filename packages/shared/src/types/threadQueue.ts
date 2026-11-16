import type { RoleId, ThreadId, TurnId, WorkspaceId } from "./ids.js";
import type { AccessMode, CodexServiceTier } from "./engine.js";
import type { TextFileAttachment } from "./attachments.js";
import type { WorkspacePathReference } from "./pathReferences.js";
import type { ThreadDraftImageAttachment } from "./http.js";
import type { CodexSkillMentionBinding, ThreadInputKind } from "../inputActions.js";
import type {
  SharedWorkspaceOperationId,
  SharedWorkspaceOperationKey,
  SharedWorkspaceToolPolicyKey,
} from "./sharedWorkspace.js";

/** 运行中输入队列：单条消息项的状态机。 */
export type ThreadMessageQueueItemStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "cancelled";

/** thread 级队列暂停原因；展示给用户决定是否「继续发送」。 */
export type ThreadQueuePauseReason =
  | "user_pause"
  | "user_stop"
  | "turn_error"
  | "send_failed"
  | "session_invalidated"
  | "rollback"
  | "transient_cleanup";

/** 入队时锁定的发送选项快照；消费时直接复用，不取当前 composer 选择。 */
export type ThreadQueueSendOptions = {
  workMode: "general" | null;
  planMode: boolean;
  accessMode: AccessMode | null;
  model: string | null;
  effort: string | null;
  contextWindow: number | null;
  autoCompactPct: number | null;
  serviceTier: CodexServiceTier | null;
  roleId?: RoleId | null;
  /** 当前模型与运行中 turn 不一致时，等待该 turn 结束后再启动新 turn。 */
  forceNewTurn?: boolean;
};

/** 共享工作区队列消费时必须还原的 Host 工具策略上下文；不随队列 DTO 下发给 Web。 */
export type ThreadQueueSharedWorkspaceContext = {
  sharedWorkspaceId: string;
  operationId: SharedWorkspaceOperationId;
  routeEventId?: string | null;
  operationKey: SharedWorkspaceOperationKey;
  toolPolicyKey: SharedWorkspaceToolPolicyKey | null;
  lockToken?: string | null;
  lockVersion?: number | null;
  allowSharedUpgrade?: boolean | null;
};

/** 队列项的对外 DTO（list/append 返回均使用此结构）。 */
export type ThreadMessageQueueItem = {
  id: string;
  threadId: ThreadId;
  workspaceId: WorkspaceId;
  position: number;
  status: ThreadMessageQueueItemStatus;
  text: string;
  inputKind?: ThreadInputKind;
  skillMentions?: CodexSkillMentionBinding[];
  images: ThreadDraftImageAttachment[];
  files: TextFileAttachment[];
  pathReferences: WorkspacePathReference[];
  sendOptions: ThreadQueueSendOptions;
  originWebSessionId: string | null;
  /** 客户端幂等键；可空（兼容老数据 / 未传 clientItemId 的入队）。 */
  clientItemId: string | null;
  enqueuedAt: number;
  updatedAt: number;
  sentTurnId: TurnId | null;
  failureReason: string | null;
  failureCode: string | null;
  attemptCount: number;
};

/** thread 级队列状态（暂停 / 上次消费指针）。 */
export type ThreadQueueState = {
  threadId: ThreadId;
  workspaceId: WorkspaceId;
  paused: boolean;
  pausedReason: ThreadQueuePauseReason | null;
  pausedAt: number | null;
  lastConsumedQueueId: string | null;
  lastConsumedTurnId: TurnId | null;
};

/** list 返回的整体快照：state + 仅活跃项（pending/sending）。 */
export type ThreadQueueSnapshot = {
  state: ThreadQueueState;
  items: ThreadMessageQueueItem[];
};

// ===== HTTP / RPC body =====

export type ThreadQueueAppendRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  text: string;
  inputKind?: ThreadInputKind;
  skillMentions?: CodexSkillMentionBinding[];
  images?: ThreadDraftImageAttachment[];
  files?: TextFileAttachment[];
  pathReferences?: WorkspacePathReference[];
  sendOptions: ThreadQueueSendOptions;
  /**
   * 可选：客户端幂等键（UUID）。同一 thread 内活跃项（pending/sending）唯一；
   * 重复 append 同一 clientItemId 时 server 返回 200 OK + 已存在的 item，
   * 不会创建第二个队列项。建议 composer 维护"草稿期间复用同一 UUID，
   * 提交成功清空后下次输入再 generate"。
   */
  clientItemId?: string;
};

export type ThreadQueueAppendResponseBody = {
  item: ThreadMessageQueueItem;
  /** 当 clientItemId 命中已存在的 active 项时为 true（idempotent ack）。 */
  idempotent?: boolean;
};

export type ThreadQueueListRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
};

export type ThreadQueueListResponseBody = ThreadQueueSnapshot;

export type ThreadQueueMoveDirection = "up" | "down";

export type ThreadQueueMoveRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  queueItemId: string;
  direction: ThreadQueueMoveDirection;
};

export type ThreadQueueMoveResponseBody = {
  items: ThreadMessageQueueItem[];
};

export type ThreadQueueRemoveRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  queueItemId: string;
};

export type ThreadQueueRemoveResponseBody = {
  removed: boolean;
};

export type ThreadQueueClearRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
};

export type ThreadQueueClearResponseBody = {
  cleared: number;
};

export type ThreadQueueResumeRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
};

export type ThreadQueueResumeResponseBody = ThreadQueueSnapshot;

export type ThreadQueuePauseRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  reason?: ThreadQueuePauseReason;
};

export type ThreadQueuePauseResponseBody = {
  paused: boolean;
};

/** ws 推送原因；Web 收到后主动 list 拉快照（不直接携带 payload，避免帧膨胀）。 */
export type ThreadQueueChangedReason =
  | "appended"
  | "moved"
  | "removed"
  | "cleared"
  | "consuming"
  | "consumed"
  | "cancelled"
  | "failed"
  | "paused"
  | "resumed";
