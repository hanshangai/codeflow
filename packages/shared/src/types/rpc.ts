import type { AccessContext, AccountRole, AccountUserSummary, AuthMode, ReminderActionNotificationPayload, ReminderCompletionNotificationPayload } from "./account";
import type { DeploymentInfo } from "./deployment";
import type { ConversationEventEnvelope, ConversationEventInput } from "./events";
import type { KeyHash, ThreadId, WebSessionId, WorkspaceId } from "./ids";
import type { OrchestrationEventRecord } from "./orchestration";
import type { PresenceEvent } from "./presence";
import type { RawEngineEventEnvelope, RawEngineEventInput } from "./rawEvents";
import type {
  SharedWorkspaceCommandEnvelope,
  SharedWorkspaceId,
  SharedWorkspaceHostHeartbeatMessage,
  SharedWorkspaceHostRegisterAck,
  SharedWorkspaceHostRegisterMessage,
  SharedWorkspaceHostRouteAckMessage,
  SharedWorkspaceHostRouteResultMessage,
  SharedWorkspaceSubscribeAck,
  SharedWorkspaceSubscribeMessage,
  SharedWorkspaceTopicEvent,
  SharedWorkspaceUnsubscribeMessage,
} from "./sharedWorkspace";
import type { AccountTerminalInfo, TerminalInfo } from "./terminal";
import type { ThreadQueueChangedReason } from "./threadQueue";
import type { RelayPricingCatalogSnapshot } from "./relayPricing";
import type {
  EngineModelCatalogAppliedAck,
  EngineModelCatalogDispatchPauseAck,
  EngineModelCatalogSnapshot,
} from "./engineModelCatalog";
import type {
  WorkspaceDirectoryMigrationActivationSnapshot,
  WorkspaceDirectoryMigrationChangedEvent,
} from "./workspaceDirectoryMigration";

export const ROLLBACK_EVIDENCE_FENCE_SOURCE = "codeflow.rollback.evidence-fence.v1";

type LegacyClientTerminalInfo = Omit<TerminalInfo, "workspaceId"> & { workspaceId?: string };

/** 本机终端事件：clientId 由 Client 可信边界注入，workspaceId 必须属于已注册本机工作区。 */
export type TerminalRuntimeEventMessage =
  | { t: "terminal.created"; clientId: string; terminal: TerminalInfo; requestId?: string }
  | { t: "terminal.output"; clientId: string; workspaceId: string; terminalId: string; data: string }
  | { t: "terminal.exited"; clientId: string; workspaceId: string; terminalId: string; exitCode: number | null }
  | { t: "terminal.closed"; clientId: string; workspaceId: string; terminalId: string }
  | { t: "terminal.listed"; clientId: string; workspaceId: string; requestId?: string; terminals: Array<TerminalInfo & { scrollback?: string }> }
  | { t: "terminal.renamed"; clientId: string; workspaceId: string; terminalId: string; label: string }
  | { t: "terminal.foregroundChanged"; clientId: string; workspaceId: string; terminalId: string; foregroundProcess: string | null }
  | { t: "terminal.error"; clientId: string; workspaceId: string; terminalId?: string; requestId?: string; message: string };

/** 本机终端控制面方法；只经桌面 API 桥接，不进入 Server 通用分发。 */
export type TerminalApiMethod =
  | "terminal.create"
  | "terminal.input"
  | "terminal.resize"
  | "terminal.rename"
  | "terminal.close"
  | "terminal.list"
  | "terminal.runAction";

export type ClientPreemptRequest = {
  requestId: string;
  oldClientId: string;
  oldConnectedAt: number;
  newClientId: string;
  newConnectedAt: number;
  requestedAt: number;
  expiresAt: number;
};

export type ClientCapabilitySnapshot = {
  /** false 表示源码运行，不展示安装包升级提醒；省略兼容旧 Client。 */
  selfUpgrade?: boolean;
  sharedThreadAclLocal?: boolean;
  sharedThreadAclInlineList?: boolean;
  sharedOrchestrationResourceAclLocal?: boolean;
  hostRpcHttpLongPoll?: boolean;
  workspaceDirectoryMigrationV1?: boolean;
  threadInputActionsV1?: boolean;
  engineModelCatalogV1?: boolean;
  localCanonicalRelayV1?: boolean;
  /** 授权与实时需求分离，支持读取屏障及需求代次 ACK。 */
  localCanonicalRelayOnDemandV1?: boolean;
  remoteDataDemandV1?: boolean;
  /** 桌面只建立获授权 Host 路由，不接管个人本地事实。 */
  desktopLocalRuntimeV1?: boolean;
  /** 桌面完整账号任务链就绪后才声明；不开放通用本机API。 */
  desktopAccountScheduledTasksV1?: boolean;
};

/** 由 Server 当前账号与 Host projection 派生；epoch 仅约束当前连接。 */
export type ConversationRelayScope =
  | {
    /** 缺省视为 shared，兼容历史持久化。 */
    kind?: "shared";
    userId: string;
    enterpriseId: string;
    clientId: string;
    bindingId: string;
    workspaceId: WorkspaceId;
    sharedWorkspaceId: SharedWorkspaceId;
    hostScopeEpoch: number;
  }
  | {
    /** 同账号远程设备读取桌面本机工作区事件，不涉及共享 Host 绑定。 */
    kind: "personal";
    userId: string;
    enterpriseId: string | null;
    clientId: string;
    workspaceId: WorkspaceId;
  };

/** 每次投递使用独立 ID；ACK 原样回传，不能重新编号或执行本地索引。 */
export type ConversationRelayDelivery = { deliveryId: string; scope: ConversationRelayScope; demandId?: string; generation?: number };

/** 云端数据只由实际订阅或有限查询租约激活，授权范围不代表需求。 */
export type RemoteDataDemandKind = "conversation" | "metrics" | "code-attribution" | "reminders";
export type RemoteDataDemand = {
  requestId: string;
  demandId: string;
  generation: number;
  kind: RemoteDataDemandKind;
  scope: ConversationRelayScope;
  recipientUserIds: string[];
  roundId?: string;
};
export type ConversationRelayDemand = RemoteDataDemand & { kind: "conversation" };
export type ConversationRelayReady = {
  requestId: string;
  demandId: string;
  generation: number;
  scope: ConversationRelayScope;
} & ({ ok: true; readyThroughSeq: number } | { ok: false; errorCode: string; message: string });

export type ClientToServerMessage =
  | { t: "client.hello"; clientId: string; deviceId?: string; version?: string; platform?: string; arch?: string; workspaceIds: string[]; capabilities?: ClientCapabilitySnapshot | null }
  | { t: "client.workspacesChanged"; workspaceIds: string[] }
  | { t: "client.workspaceDirectoryMigrationChanged"; event: WorkspaceDirectoryMigrationChangedEvent }
  | { t: "client.workspaceDirectoryMigrationActivationSnapshot"; snapshot: WorkspaceDirectoryMigrationActivationSnapshot }
  | { t: "engine.models.applied"; ack: EngineModelCatalogAppliedAck }
  | { t: "engine.models.dispatchPaused"; ack: EngineModelCatalogDispatchPauseAck }
  | { t: "conversation.event"; event: ConversationEventInput }
  | { t: "conversation.event.relay"; events: ConversationEventEnvelope[]; delivery?: ConversationRelayDelivery }
  | { t: "conversation.event.relayReady"; ready: ConversationRelayReady }
  | { t: "orchestration.event"; workspaceId: WorkspaceId; event: OrchestrationEventRecord }
  | { t: "reminders.changed"; workspaceId: WorkspaceId }
  | { t: "reminder.actionNotification"; notification: ReminderActionNotificationPayload; requestId?: string }
  | { t: "reminder.completionNotification"; notification: ReminderCompletionNotificationPayload; requestId?: string }
  | { t: "raw.event"; event: RawEngineEventInput }
  | { t: "api.res"; id: string; status: number; body: unknown }
  | { t: "sharedWorkspace.host.register"; message: SharedWorkspaceHostRegisterMessage }
  | { t: "sharedWorkspace.host.heartbeat"; message: SharedWorkspaceHostHeartbeatMessage }
  | { t: "sharedWorkspace.route.ack"; message: SharedWorkspaceHostRouteAckMessage }
  | { t: "sharedWorkspace.route.result"; message: SharedWorkspaceHostRouteResultMessage }
  | { t: "thread.queue.changed"; workspaceId: WorkspaceId; threadId: ThreadId; reason: ThreadQueueChangedReason }
  /** Client 本地改动了引擎 Key（如首次启动自动启用内置中转）；引擎 Key 不区分工作区，Web 收到后刷新自己的 Key 列表。 */
  | { t: "engineKeys.changed" }
  | {
    t: "thread.history.cleaned";
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    sharedWorkspaceId: SharedWorkspaceId | null;
    throughSeq: number;
    delivery?: ConversationRelayDelivery;
    invalidationId?: string;
  }
  | { t: "terminal.created"; terminal: LegacyClientTerminalInfo; requestId?: string }
  | { t: "terminal.output"; terminalId: string; workspaceId?: string; data: string }
  | { t: "terminal.exited"; terminalId: string; workspaceId?: string; exitCode: number | null }
  | { t: "terminal.closed"; terminalId: string; workspaceId?: string }
  | { t: "terminal.listed"; requestId?: string; workspaceId?: string; terminals: Array<LegacyClientTerminalInfo & { scrollback?: string }> }
  | { t: "terminal.renamed"; terminalId: string; workspaceId?: string; label: string }
  | { t: "terminal.foregroundChanged"; terminalId: string; workspaceId?: string; foregroundProcess: string | null }
  | { t: "terminal.error"; terminalId?: string; workspaceId?: string; requestId?: string; message: string };

export type ServerToClientMessage =
  | {
    t: "client.helloAck";
    keyHash: KeyHash;
    serverNow: number;
    authMode?: AuthMode;
    accountRole?: AccountRole | null;
    homePath?: string | null;
    userSummary?: AccountUserSummary | null;
    accountSessionId?: string;
    accessContext?: AccessContext | null;
    deployment?: DeploymentInfo;
    relayPricingCatalog?: RelayPricingCatalogSnapshot;
    engineModelCatalog?: EngineModelCatalogSnapshot;
    capabilities?: { hostRpcHttpLongPoll?: boolean; hostRpcHttpSessionId?: string; localCanonicalRelayV1?: boolean; localCanonicalRelayOnDemandV1?: boolean; remoteDataDemandV1?: boolean; desktopLocalRuntimeV1?: boolean };
  }
  | { t: "relay.pricing.updated"; catalog: RelayPricingCatalogSnapshot }
  | {
    t: "engine.models.dispatchPause";
    operationId: string;
    configVersion: number;
    digest: string;
  }
  | { t: "engine.models.dispatchResume"; operationId: string }
  | { t: "engine.models.updated"; catalog: EngineModelCatalogSnapshot; operationId?: string }
  | {
    t: "engine.models.appliedConfirmed";
    operationId?: string;
    configVersion: number;
    digest: string;
  }
  | { t: "conversation.eventAck"; event: ConversationEventEnvelope }
  | { t: "conversation.event.relayScopes"; scopes: ConversationRelayScope[] }
  | { t: "conversation.event.relayDemand"; demand: ConversationRelayDemand; active: boolean }
  | { t: "remote.data.demand"; demand: RemoteDataDemand; active: boolean }
  | { t: "reminder.deliveryResult"; requestId: string; ok: true }
  | { t: "reminder.deliveryResult"; requestId: string; ok: false; errorCode: string }
  | { t: "conversation.eventRelayAck"; seqs: number[]; delivery?: ConversationRelayDelivery }
  | { t: "thread.history.cleanedAck"; delivery?: ConversationRelayDelivery; invalidationId: string;
      workspaceId: WorkspaceId; threadId: ThreadId; throughSeq: number }
  | { t: "raw.eventAck"; event: RawEngineEventEnvelope }
  | { t: "server.workspaceDirectoryMigrationAck"; operationId: string; stateVersion: number; acknowledgedAt: number }
  | { t: "server.workspaceDirectoryMigrationStartFenceAck"; operationId: string; startAttemptId: string; stateVersion: number; acknowledgedAt: number }
  | { t: "api.req"; id: string; method: string; path: string; body: unknown }
  | { t: "sharedWorkspace.host.registerAck"; ack: SharedWorkspaceHostRegisterAck }
  | { t: "sharedWorkspace.command"; envelope: SharedWorkspaceCommandEnvelope }
  | { t: "terminal.create"; workspaceId: string; requestId?: string; label?: string; shell?: string; cwd?: string }
  | { t: "terminal.input"; terminalId: string; workspaceId?: string; data: string }
  | { t: "terminal.resize"; terminalId: string; workspaceId?: string; cols: number; rows: number }
  | { t: "terminal.close"; terminalId: string; workspaceId?: string }
  | { t: "terminal.rename"; terminalId: string; workspaceId?: string; label: string }
  | { t: "terminal.list"; workspaceId: string; requestId?: string }
  | { t: "terminal.runAction"; workspaceId: string; actionId: string; requestId?: string };

/** Host 通过 HTTP long-poll 领取的普通 RPC 命令。 */
export type HostRpcHttpCommandMessage = Extract<ServerToClientMessage, {
  t: "api.req" | "sharedWorkspace.command";
}>;

/** Host 通过 HTTP 回传的普通 RPC 控制响应；实时事件仍走 WebSocket。 */
export type HostRpcHttpResultMessage = Extract<ClientToServerMessage, {
  t: "api.res" | "sharedWorkspace.route.ack" | "sharedWorkspace.route.result";
}>;

export type HostRpcHttpTask = {
  operationId: string;
  message: HostRpcHttpCommandMessage;
  /** Server 使用单调时钟计算从 HTTP 队列入队到建立租约的耗时；旧 Server 可不提供。 */
  readonly queueMs?: number;
};

export type HostRpcHttpResultRequest = {
  messages: HostRpcHttpResultMessage[];
};

export type WebToServerMessage =
  | { t: "web.subscribe"; workspaceId: WorkspaceId; sinceSeq?: number }
  | { t: "web.subscribeReplace"; workspaceId: WorkspaceId | null; sinceSeq?: number; requestId: string }
  | { t: "client.preempt.respond"; requestId: string; decision: "accept" | "decline" }
  | { t: "sharedWorkspace.subscribe"; message: SharedWorkspaceSubscribeMessage }
  | { t: "sharedWorkspace.unsubscribe"; message: SharedWorkspaceUnsubscribeMessage }
  | { t: "terminal.create"; workspaceId: string; requestId?: string; label?: string; shell?: string; cwd?: string }
  | { t: "terminal.input"; terminalId: string; clientId?: string; workspaceId?: string; data: string }
  | { t: "terminal.resize"; terminalId: string; clientId?: string; workspaceId?: string; cols: number; rows: number }
  | { t: "terminal.close"; terminalId: string; clientId?: string; workspaceId?: string }
  | { t: "terminal.rename"; terminalId: string; clientId?: string; workspaceId?: string; label: string }
  | { t: "terminal.list"; workspaceId: string; clientId?: string; requestId?: string }
  | { t: "terminal.listAll"; requestId: string }
  | { t: "terminal.runAction"; workspaceId: string; actionId: string; requestId?: string };

export type ServerToWebMessage =
  | import("../conversation/presentation.js").ConversationChangedMessage
  | { t: "account.quick_phrases.changed"; revision: number; changedByWebSessionId: WebSessionId | null }
  | {
    t: "web.helloAck";
    webSessionId: WebSessionId;
    serverNow: number;
    authMode?: AuthMode;
    accountRole?: AccountRole | null;
    homePath?: string | null;
    userSummary?: AccountUserSummary | null;
    accessContext?: AccessContext | null;
    engineModelCatalog?: EngineModelCatalogSnapshot;
  }
  | { t: "engine.models.updated"; catalog: EngineModelCatalogSnapshot }
  | { t: "web.subscribeAck"; requestId: string; workspaceId: WorkspaceId | null; sinceSeq: number; bufferedCount: number; serverSeq: number; demandId?: string; readyThroughSeq?: number }
  | { t: "client.preempt.requested"; request: ClientPreemptRequest }
  | { t: "client.preempt.resolved"; requestId: string; decision: "accepted" | "declined" | "timeout" | "failed" }
  | { t: "reminders.changed"; workspaceId: WorkspaceId }
  | {
    t: "threads.changed";
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    kind: "created" | "updated" | "deleted" | "cleared" | "history_cleaned";
    patch?: {
      title?: string;
      archived?: boolean;
      pinnedAt?: number | null;
      updatedAt?: number;
    };
    /** 回滚后共享投影的 canonical 事件屏障；收到方必须重载 thread 历史。 */
    rollbackEventSeqBarrier?: number;
  }
  | { t: "thread.draft.updated"; workspaceId: WorkspaceId; threadId: ThreadId; version: number | null; updatedByWebSessionId: WebSessionId | null; cleared: boolean }
  | { t: "thread.queue.changed"; workspaceId: WorkspaceId; threadId: ThreadId; reason: ThreadQueueChangedReason }
  /** Client 端引擎 Key 变化广播；收到方按当前工作区刷新 Key 列表。 */
  | { t: "engineKeys.changed" }
  | { t: "workspaces.changed"; workspaceId: WorkspaceId; kind: "upserted" | "deleted" }
  | { t: "workspaceDirectoryMigration.changed"; event: WorkspaceDirectoryMigrationChangedEvent }
  | { t: "conversation.event"; event: ConversationEventEnvelope }
  | { t: "orchestration.event"; workspaceId: WorkspaceId; event: OrchestrationEventRecord }
  | { t: "presence.event"; event: PresenceEvent }
  | { t: "sharedWorkspace.subscribeAck"; ack: SharedWorkspaceSubscribeAck }
  | { t: "sharedWorkspace.event"; event: SharedWorkspaceTopicEvent }
  | { t: "error"; message: string; requestId?: string; errorCode?: string }
  | { t: "terminal.created"; terminal: AccountTerminalInfo; requestId?: string }
  | { t: "terminal.output"; clientId: string; workspaceId: string; terminalId: string; data: string }
  | { t: "terminal.exited"; clientId: string; workspaceId: string; terminalId: string; exitCode: number | null }
  | { t: "terminal.closed"; clientId: string; workspaceId: string; terminalId: string }
  | { t: "terminal.listed"; clientId: string; workspaceId: string; requestId?: string; terminals: Array<AccountTerminalInfo & { scrollback?: string }> }
  | { t: "terminal.listAll.result"; requestId: string; targets: Array<{ clientId: string; workspaceId: string }>; terminals: Array<AccountTerminalInfo & { scrollback?: string }>; failures: Array<{ clientId: string; workspaceId: string; message: string }> }
  | { t: "terminal.renamed"; clientId: string; workspaceId: string; terminalId: string; label: string }
  | { t: "terminal.foregroundChanged"; clientId: string; workspaceId: string; terminalId: string; foregroundProcess: string | null }
  | { t: "terminal.error"; clientId?: string; workspaceId?: string; terminalId?: string; requestId?: string; message: string };
