import type { TextFileAttachment } from "./attachments";
import type { WorkspacePathReference } from "./pathReferences";
import type { AssistantCompletionSource, AssistantMessagePhase, ConversationExplore } from "./conversation";
import type { AccessMode, CodexServiceTier, EngineType, TokenUsageSnapshot } from "./engine";
import type { EngineCallTrace } from "./engineCall";
import type { ItemId, OrchestrationId, SessionId, ThreadId, TurnId, WorkspaceId } from "./ids";
import type { FeedbackAction, GateResult, ManagedServiceStatus, NodeExecutionStatus, NodeNextAction, NodeReviewVerdict, OrchestrationStatus } from "./orchestration";
import type { RequestUserInputRequest, RequestUserInputResponse } from "./userInput";
import type { CodexSkillMentionBinding, ThreadInputKind } from "../inputActions";

export type ConversationEventSchema = 1;

export type ConversationEventPayloadByType = {
  "thread.started": ThreadStartedPayload;
  "thread.title.updated": ThreadTitleUpdatedPayload;
  "thread.process.changed": ThreadProcessChangedPayload;
  "turn.started": TurnStartedPayload;
  "turn.engineBound": TurnEngineBoundPayload;

  "item.userMessage.created": UserMessageCreatedPayload;
  "item.userMessage.engineCall.created": UserMessageEngineCallCreatedPayload;
  "item.message.deleted": { itemId: ItemId };
  "item.agentMessage.started": AgentMessageStartedPayload;
  "item.agentMessage.delta": AgentMessageDeltaPayload;
  "item.agentMessage.snapshot": AgentMessageSnapshotPayload;
  "item.agentMessage.completed": AgentMessageCompletedPayload;
  "item.reasoning.started": ReasoningStartedPayload;
  "item.reasoning.delta": ReasoningDeltaPayload;
  "item.reasoning.summaryDelta": ReasoningSummaryDeltaPayload;
  "item.reasoning.summaryBoundary": ReasoningSummaryBoundaryPayload;

  "item.tool.started": ToolStartedPayload;
  "item.tool.inputUpdated": ToolInputUpdatedPayload;
  "item.tool.outputDelta": ToolOutputDeltaPayload;
  "item.tool.completed": ToolCompletedPayload;

  "approval.request": ApprovalRequestPayload;
  "approval.resolved": ApprovalResolvedPayload;
  "approval.expired": ApprovalExpiredPayload;
  "system.notice": SystemNoticePayload;

  "userInput.requested": UserInputRequestedPayload;
  "userInput.resolved": UserInputResolvedPayload;
  "userInput.expired": UserInputExpiredPayload;

  "item.diff.created": DiffCreatedPayload;
  "item.review.started": ReviewStartedPayload;
  "item.review.completed": ReviewCompletedPayload;
  "item.explore.updated": ExploreUpdatedPayload;

  "item.subagent.started": SubagentStartedPayload;
  "item.subagent.progress": SubagentProgressPayload;
  "item.subagent.completed": SubagentCompletedPayload;
  "item.subagent.childEvent": SubagentChildEventPayload;

  "tokenUsage.updated": TokenUsageUpdatedPayload;
  "turn.completed": TurnCompletedPayload;
  "turn.error": TurnErrorPayload;

  "orchestration.started": OrchestrationStartedPayload;
  "orchestration.recovered": OrchestrationRecoveredPayload;
  "orchestration.completed": OrchestrationCompletedPayload;
  "orchestration.nodeStateChanged": OrchestrationNodeStateChangedPayload;
  "orchestration.nodeRecovered": OrchestrationNodeRecoveredPayload;
  "orchestration.promptSnapshotCreated": OrchestrationPromptSnapshotCreatedPayload;
  "orchestration.artifactWritten": OrchestrationArtifactWrittenPayload;
  "orchestration.artifactRevised": OrchestrationArtifactRevisedPayload;
  "orchestration.artifactWorkspaceWritten": OrchestrationArtifactWorkspaceWrittenPayload;
  "orchestration.artifactPublished": OrchestrationArtifactPublishedPayload;
  "orchestration.artifactDiscarded": OrchestrationArtifactDiscardedPayload;
  "orchestration.gateResult": OrchestrationGateResultPayload;
  "orchestration.approvalRequested": OrchestrationApprovalRequestedPayload;
  "orchestration.feedbackRequested": OrchestrationFeedbackRequestedPayload;
  "orchestration.reworkRequested": OrchestrationReworkRequestedPayload;
  "orchestration.error": OrchestrationErrorPayload;
};

export type ConversationEventType = keyof ConversationEventPayloadByType;

/** 产品面可消费的会话事件：仅用于渲染、回放、状态恢复。 */
export type ConversationEventEnvelope = {
  [T in ConversationEventType]: ConversationEventEnvelopeBase<T>;
}[ConversationEventType];

export type ConversationEventEnvelopeBase<
  TType extends ConversationEventType,
  TPayload = ConversationEventPayloadByType[TType],
> = {
  schema: ConversationEventSchema;
  seq: number;
  /** 历史压缩覆盖的起始序号；只用于回放去重，不写入原始事件。 */
  replayFromSeq?: number;
  ts: number;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  engine: EngineType;
  type: TType;
  payload: TPayload;
};

/** Client 上报 Server 的 canonical 事件输入。 */
export type ConversationEventInput = {
  [T in ConversationEventType]: Omit<ConversationEventEnvelopeBase<T>, "schema" | "seq" | "replayFromSeq">;
}[ConversationEventType];

/** 识别聊天正文事件的稳定消息 ID；工具、交互和回合状态不属于单条消息删除范围。 */
export function getConversationMessageItemId(event: Pick<ConversationEventInput, "type" | "payload">): string | null {
  switch (event.type) {
    case "item.userMessage.created":
    case "item.userMessage.engineCall.created":
    case "item.agentMessage.started":
    case "item.agentMessage.delta":
    case "item.agentMessage.snapshot":
    case "item.agentMessage.completed":
    case "item.message.deleted":
      return String((event.payload as { itemId?: unknown }).itemId ?? "").trim() || null;
    default:
      return null;
  }
}

export type ThreadSessionCapabilities = {
  codexDynamicToolIds?: string[] | null;
  codexDynamicToolBindingVersion?: string | null;
};

export type ThreadStartedPayload = {
  sessionId?: SessionId;
  sessionCapabilities?: ThreadSessionCapabilities | null;
};

export type ThreadTitleUpdatedPayload = {
  title: string;
};

export type ThreadProcessChangedPayload = {
  serviceId: string;
  source: "platform" | "engine";
  status: ManagedServiceStatus;
};

export type TurnStartedPayload = {
  turnId: TurnId;
  /** 本 turn 实际接收的模型执行参数；旧事件可缺省。 */
  execution?: TurnExecutionOptionsSnapshot | null;
};

/** active turn 的模型参数快照，用于判断后续输入能否安全追加。 */
export type TurnExecutionOptionsSnapshot = {
  model: string | null;
  effort: string | null;
  contextWindow: number | null;
  autoCompactPct: number | null;
  serviceTier: CodexServiceTier | null;
};

export type TurnEngineBoundPayload = {
  turnId: TurnId;
  engineTurnId: string;
  engineSessionId: SessionId;
  previousEngineTurnId?: string | null;
};

export type UserMessageCreatedPayload = {
  turnId?: TurnId;
  itemId: ItemId;
  /** true 表示该用户消息追加到已有 active turn，不应覆盖同 turn 的首条用户消息。 */
  activeTurnAppend?: boolean;
  text: string;
  inputKind?: ThreadInputKind;
  skillMentions?: CodexSkillMentionBinding[];
  images?: string[];
  files?: TextFileAttachment[];
  pathReferences?: WorkspacePathReference[];
};

export type UserMessageEngineCallCreatedPayload = {
  itemId: ItemId;
  call: EngineCallTrace;
};

export type AgentMessageStartedPayload = {
  itemId: ItemId;
  /** 引擎原生 messageId；canonical item 必须按此聚合。 */
  engineMessageId: string;
  turnId?: TurnId;
  phase?: AssistantMessagePhase;
};

export type AgentMessageDeltaPayload = {
  itemId: ItemId;
  engineMessageId: string;
  turnId?: TurnId;
  delta: string;
};

export type AgentMessageSnapshotPayload = {
  itemId: ItemId;
  engineMessageId: string;
  turnId?: TurnId;
  text: string;
  revision: number;
  phase?: AssistantMessagePhase;
};

export type AgentMessageCompletedPayload = {
  itemId: ItemId;
  engineMessageId: string;
  turnId?: TurnId;
  text: string;
  revision: number;
  phase?: AssistantMessagePhase;
  completionSource?: AssistantCompletionSource;
  structuredPayloadJson?: string | null;
};

export type ReasoningStartedPayload = {
  itemId: ItemId;
};

export type ReasoningDeltaPayload = {
  itemId: ItemId;
  delta: string;
};

export type ReasoningSummaryDeltaPayload = {
  itemId: ItemId;
  delta: string;
};

export type ReasoningSummaryBoundaryPayload = {
  itemId: ItemId;
};

export type ToolChange = {
  path: string;
  kind?: string;
  diff?: string;
};

export type ToolStartedPayload = {
  itemId: ItemId;
  toolName: string;
  input?: unknown;
  changes?: ToolChange[];
  summary?: string;
};

export type ToolInputUpdatedPayload = {
  itemId: ItemId;
  toolName?: string;
  input?: unknown;
  todolistItems?: { step: string; status: string }[];
  changes?: ToolChange[];
  summary?: string;
};

export type ToolOutputDeltaPayload = {
  itemId: ItemId;
  toolName?: string;
  delta: string;
  mode?: "append" | "replace";
  changes?: ToolChange[];
  summary?: string;
};

export type ToolCompletedPayload = {
  itemId: ItemId;
  toolName?: string;
  output?: unknown;
  error?: string;
  status: "completed" | "failed";
  durationMs?: number | null;
  changes?: ToolChange[];
  summary?: string;
  todolistItems?: { step: string; status: string }[];
};

export type ApprovalOption = {
  value: string;
  label: string;
  description?: string;
  intent: "accept" | "decline";
  requiresNote?: boolean;
  notePlaceholder?: string;
};

export type ApprovalRequestPayload = {
  requestId: unknown;
  toolName: string;
  input?: unknown;
  message?: string;
  approvalKind?: "generic" | "enterPlanMode" | "exitPlanMode";
  options?: ApprovalOption[];
};

export type ApprovalResolvedPayload = {
  requestId: unknown;
  approved: boolean;
  choice?: string;
  note?: string;
  nextPlanMode?: boolean;
  nextAccessMode?: AccessMode | null;
  clearContextRequested?: boolean;
  message?: string;
};

export type ApprovalExpiredPayload = {
  requestId: unknown;
  message?: string;
};

export type SystemNoticePayload = {
  level: "info" | "warning" | "error" | "success";
  text: string;
  /**
   * 语义动作。
   * - "session.invalidated"：引擎会话永久丢失，前端应标记会话为只读。
   * - "context.compacted"：Claude 自动压缩了上下文，session 文件已被重写，
   *   Client 应更新已存储的 turn checkpoint 以避免回滚时使用失效的字节偏移。
   */
  action?: "session.invalidated" | "context.compacted";
};

export type UserInputRequestedPayload = {
  request: RequestUserInputRequest;
};

export type UserInputResolvedPayload = {
  response: RequestUserInputResponse;
};

export type UserInputExpiredPayload = {
  requestId: string;
};

export type DiffCreatedPayload = {
  itemId: ItemId;
  title: string;
  diff: string;
  /** Client 落库时将正文外置到每个 diff item 的最新快照；实时事件通常不携带。 */
  diffRef?: {
    kind: "client_latest_snapshot";
    sha256: string;
    bytes: number;
  };
  /** Client 本地 turnId；仅在 provider turn 与当前 active turn 匹配时写入。 */
  turnId?: TurnId;
  /** Codex app-server 原生 turnId，用于校验 diff 的 provider 归属。 */
  engineTurnId?: string;
  status?: string;
};

export type ReviewStartedPayload = {
  itemId: ItemId;
  text: string;
};

export type ReviewCompletedPayload = {
  itemId: ItemId;
  text: string;
};

export type ExploreUpdatedPayload = {
  itemId: ItemId;
  status: ConversationExplore["status"];
  entries: ConversationExplore["entries"];
};

export type SubagentUsage = {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
};

export type SubagentStartedPayload = {
  itemId: ItemId;
  taskId: string;
  toolUseId?: string;
  description: string;
  taskType?: string;
};

export type SubagentProgressPayload = {
  itemId: ItemId;
  taskId: string;
  description: string;
  lastToolName?: string;
  usage?: SubagentUsage;
};

export type SubagentCompletedPayload = {
  itemId: ItemId;
  taskId: string;
  status: "completed" | "failed" | "stopped";
  summary: string;
  usage?: SubagentUsage;
};

export type SubagentChildEventPayload = {
  itemId: ItemId;
  taskId: string;
  innerEventType: string;
  innerPayload: unknown;
};

export type TokenUsageUpdatedPayload = {
  tokenUsage: TokenUsageSnapshot;
  /** "current"=单次 API call 快照（默认）；"cumulative"=累计口径（来自 provider 终态或 result 事件）。 */
  source?: "current" | "cumulative";
  /** cumulative 的计算口径；snapshot 直接替换，delta 按当前轮累加（兼容 GLM result）。 */
  cumulativeMode?: "snapshot" | "delta";
  /** current usage 的阶段；intermediate 仅刷新 UI，不参与编排度量累加。 */
  usagePhase?: "intermediate" | "final";
};

export type TurnCompletedPayload = {
  turnId: TurnId;
  result?: unknown;
};

export type TurnTerminationKind = "manual_interrupt" | "transient_cleanup" | "error";

export type TurnErrorPayload = {
  turnId?: TurnId;
  error: string;
  code?: string;
  /** 触发错误的 provider 请求方法；仅在错误对象明确提供时写入。 */
  requestMethod?: string;
  additionalDetails?: string;
  providerErrorInfo?: string;
  /** 原 provider thread 的恢复诊断；仅由真实恢复错误写入。 */
  providerThreadId?: string;
  recoveryReason?: string;
  preserveBinding?: boolean;
  userChoiceRequired?: boolean;
  recoveryStrategies?: Array<"retry-existing" | "new-thread">;
  terminationKind: TurnTerminationKind;
};

// ── Orchestration Events ────────────────────────────────────────

export type OrchestrationStartedPayload = {
  instanceId: OrchestrationId;
  workflowName: string;
};

export type OrchestrationRecoveredPayload = {
  instanceId: OrchestrationId;
  workflowName: string;
};

export type OrchestrationCompletedPayload = {
  instanceId: OrchestrationId;
  status: OrchestrationStatus;
};

export type OrchestrationNodeStateChangedPayload = {
  instanceId: OrchestrationId;
  nodeId: string;
  nodeLabel: string;
  status: NodeExecutionStatus;
  nodeExecutionId?: string | null;
  attemptNo?: number | null;
  parentExecutionId?: string | null;
  threadId?: ThreadId | null;
};

export type OrchestrationNodeRecoveredPayload = {
  instanceId: OrchestrationId;
  nodeId: string;
  nodeLabel: string;
  action: "completed-turn-replayed" | "retry-queued-after-error" | "failed-after-recovery" | "requeued";
  threadId?: ThreadId | string | null;
  turnId?: TurnId | null;
  error?: string | null;
  reason?: string | null;
};

export type OrchestrationPromptSnapshotCreatedPayload = {
  instanceId: OrchestrationId;
  nodeId: string;
  nodeLabel: string;
  promptSnapshotId: string;
  threadId?: ThreadId | null;
};

export type OrchestrationArtifactWrittenPayload = {
  instanceId: OrchestrationId;
  nodeId: string;
  nodeLabel: string;
  artifactId: string;
  artifactKind: string;
  payloadMode?: string | null;
  persistenceMode?: string | null;
};

export type OrchestrationArtifactRevisedPayload = {
  instanceId: OrchestrationId;
  nodeId: string;
  nodeLabel: string;
  threadId?: ThreadId | null;
  artifactId: string;
  artifactKind: string;
  version?: number | null;
  basedOnArtifactId: string;
  basedOnVersion?: number | null;
  note?: string | null;
  summary?: string | null;
  changedFiles?: string[] | null;
  files?: Array<{
    path: string;
    summary?: string | null;
  }> | null;
  workspaceStatus?: string | null;
  stagingPath?: string | null;
  publishedPath?: string | null;
};

export type OrchestrationArtifactWorkspaceWrittenPayload = {
  instanceId: OrchestrationId;
  nodeId: string;
  nodeLabel: string;
  artifactId: string;
  workspaceStatus: string;
  stagingPath?: string | null;
  publishedPath?: string | null;
  fileCount?: number | null;
};

export type OrchestrationManagedServicesChangedPayload = {
  instanceId: OrchestrationId;
  threadId: ThreadId;
  serviceId: string;
  status: ManagedServiceStatus;
  reason:
    | "starting"
    | "ready"
    | "exited"
    | "stopped"
    | "startup-failed"
    | "reconfigured"
    | "instance-disposed"
    | "spawn-error"
    | "process-exit";
};

export type OrchestrationArtifactPublishedPayload = {
  instanceId: OrchestrationId;
  nodeId: string;
  nodeLabel: string;
  artifactId: string;
  publishedPath?: string | null;
  fileCount?: number | null;
};

export type OrchestrationArtifactDiscardedPayload = {
  instanceId: OrchestrationId;
  nodeId: string;
  nodeLabel: string;
  artifactId: string;
  discardedPath?: string | null;
};

export type OrchestrationGateResultPayload = {
  instanceId: OrchestrationId;
  nodeId: string;
  nodeLabel: string;
  artifactId?: string | null;
  results: GateResult[];
};

export type OrchestrationApprovalRequestedPayload = {
  instanceId: OrchestrationId;
  nodeId: string;
  nodeLabel: string;
  artifactId?: string | null;
  reviewVerdict?: NodeReviewVerdict | null;
  nextAction?: NodeNextAction | null;
  reworkTargetNodeId?: string | null;
};

export type OrchestrationFeedbackRequestedPayload = {
  instanceId: OrchestrationId;
  nodeId: string;
  nodeLabel: string;
  source?: "gate" | "execution" | "review" | "human_input";
  gateResults: GateResult[];
  reason?: string | null;
  artifactId?: string | null;
  reviewVerdict?: NodeReviewVerdict | null;
  nextAction?: NodeNextAction | null;
  reworkTargetNodeId?: string | null;
  humanSummary?: string | null;
};

export type OrchestrationReworkRequestedPayload = {
  instanceId: OrchestrationId;
  fromNodeId: string;
  fromNodeLabel: string;
  targetNodeId: string;
  targetNodeLabel: string;
  artifactIds?: string[] | null;
  reason?: string | null;
};

export type OrchestrationErrorPayload = {
  instanceId: OrchestrationId;
  nodeId?: string | null;
  error: string;
};

/* 过渡别名：项目内仍有部分模块使用旧命名。 */
export type EngineEventSchema = ConversationEventSchema;
export type EngineEventPayloadByType = ConversationEventPayloadByType;
export type EngineEventType = ConversationEventType;
export type EngineEventEnvelope = ConversationEventEnvelope;
export type EngineEventEnvelopeBase<
  TType extends ConversationEventType,
  TPayload = ConversationEventPayloadByType[TType],
> = ConversationEventEnvelopeBase<TType, TPayload>;
export type EngineEventInput = ConversationEventInput;
