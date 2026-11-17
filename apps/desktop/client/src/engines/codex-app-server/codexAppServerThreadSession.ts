import crypto from "node:crypto";

import {
  MANUAL_TURN_INTERRUPT_CODE,
  PRODUCT_DEFAULT_AUTO_COMPACT_PCT,
  buildCodexCliSlashInputActions,
  ThreadInputContractError,
  type AssistantMessagePhase,
  type AccessMode,
  type EngineCallTrace,
  type ConversationEventInput,
  type ExecutableToolRegistry,
  type ManagedServiceSnapshot,
  type RawEngineEventInput,
  type RequestUserInputQuestion,
  type RequestUserInputRequest,
  type RequestUserInputResponse,
  type SessionId,
  type ThreadSessionCapabilities,
  type TurnId,
  type WorkspaceId,
} from "@codeflowai/shared";

import { clearPlatformToolFailureCounts, platformToolFailureKey } from "../threadSession.js";
import type {
  AppendTurnInput,
  AcquireEngineCredential,
  AppendTurnResult,
  CompactThreadInput,
  ConversationEmitFn,
  HostToolExecutionResult,
  HostToolExecutor,
  PlatformToolTransportRequirement,
  PreparedCodexSkillInput,
  ProviderNativeToolPolicy,
  SendMessageInput,
  ThreadEngineSession,
  ThreadEventEmitters,
  ThreadInterruptOptions,
} from "../threadSession.js";
import type { WorkspaceLogEntry } from "../../logger.js";
import { createEngineWorkspaceLogFailure, engineDiagnosticCause, engineDiagnosticField, isEngineWorkspaceLogFailure, ThreadEventFlushError, withThreadEventFlush, writeEngineWorkspaceLog, type EngineWorkspaceLogWriter } from "../threadSession.js";
import { redactClientStartupText } from "../../startup/clientStartupStatus.js";
import { normalizeTurnTimeoutPolicy, TurnTimeoutController, type EngineTimeoutError } from "../turnTimeoutController.js";
import {
  AssistantLifecycleTracker,
  buildAssistantCompletedEvent,
  normalizeAssistantMessagePhase,
  type AssistantLifecycleRecord,
} from "../assistantLifecycle.js";
import type { CodexAppServerThreadManager as CodexAppServerManager } from "./codexAppServerManager.js";
import {
  CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS,
  type CodexAppServerLateSettlement,
  type CodexAppServerMessage,
} from "./codexAppServerWorkspace.js";
import type { CodexHistoryProjection } from "./codexAppServerHistory.js";
import { ensureCodexRequiredWorkspaceSkills } from "./codexRequiredSkills.js";
import {
  listCodexSkillInputActions,
  resolveCodexSkillMentionBindings,
} from "./codexInputActions.js";
import {
  applyCodexAppServerMessage,
  extractTransientReconnectInfo,
  isCodexAppServerHandledMethod,
  isCodexSyntheticTransportFault,
} from "./codexAppServerMessageMapper.js";
import {
  buildCodexDynamicToolBindingVersion,
  buildCodexDynamicToolSpecs,
  buildCodexDynamicToolToolIdByName,
  buildThreadResumeRequestParams,
  buildThreadStartRequestParams,
  buildTurnStartParams,
  buildTurnSteerParams,
  extractThreadIdFromResult,
  extractTurnIdFromResult,
  listExecutableToolIds,
  resolveCodexAppServerModelProvider,
  resolveCodexThreadConfigOverrides,
  supportsCodexNativeDynamicToolTransport,
} from "./codexAppServerProtocol.js";
import { buildAsyncUserInputRequest, buildUserInputRequest, extractApprovalMessage } from "./codexAppServerRequests.js";
import { prepareCodexImagesForTurn } from "../codex/codexImageInput.js";
import { extractAssistantItems } from "./codexTurnRecovery.js";
import {
  acquireEngineModelCatalogDispatchLease,
  assertEngineModelCatalogDispatchLeaseCurrent,
  assertRuntimeEngineModelAvailable,
  resolveRuntimeThreadPrefsWithCatalogDefaults,
} from "../engineModelCatalogRuntime.js";
import {
  buildProviderNativeToolDenyMessage,
  providerNativeInteractionToolsAllowed,
  providerNativeToolsDenied,
} from "../providerNativeToolPolicy.js";
import {
  buildSharedWorkspaceProviderNativeDenyMessage,
  evaluateSharedWorkspaceProviderNativeToolPolicy,
  type SharedWorkspaceToolExecutionContext,
} from "../../app/sharedWorkspaceToolPolicy.js";
import { readEngineConfig, type CodexRuntimeConfig } from "../../enginesConfig.js";

const PLATFORM_TOOL_FAILURE_RETRY_LIMIT = 5;
const MAX_DETACHED_PROVIDER_CORRELATIONS = 64;
const CODEX_START_OWNERSHIP_GRACE_MS = 250;
const CODEX_ACTIVE_OWNERSHIP_RECOVERY_INITIAL_DELAY_MS = 100;
const CODEX_INTERRUPT_OWNERSHIP_SCAN_TIMEOUT_MS = 1_000;
const CODEX_ACTIVE_OWNERSHIP_RECOVERY_TIMEOUT_MS = 1_000;
const CODEX_ACTIVE_OWNERSHIP_RECOVERY_TTL_MS = 5_000;
const CODEX_PROVIDER_START_EVIDENCE_GRACE_MS = 10 * 60_000;
const CODEX_OWNERSHIP_RECOVERY_TURN_LIMIT = 64;
const CODEX_OWNERSHIP_RECOVERY_MAX_PAGES = 4;
const CODEX_OWNERSHIP_RECOVERY_MAX_RETRY_MS = 30_000;
const CODEX_DETACHED_OWNERSHIP_RECOVERY_TTL_MS = 10 * 60_000;
const CODEX_PROVIDER_GOAL_READ_TIMEOUT_MS = 2_000;
const CODEX_TIMEOUT_RECONCILE_REQUEST_TIMEOUT_MS = CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS;
const CODEX_INTERRUPT_RECONCILE_MAX_ATTEMPTS = 5;
const CODEX_ROLLBACK_RECONCILE_MAX_ATTEMPTS = 3;

/** 统一恢复 RPC 的长预算与迟到结算追踪；普通业务 RPC 仍使用各自预算。 */
const CODEX_RECOVERY_REQUEST_OPTIONS = {
  timeoutMs: CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS,
  trackLateSettlement: true,
} as const;

/** 状态与历史边界对账只读取轮次元数据，不加载工具输出和正文。 */
const CODEX_STATE_READ_OPTIONS = {
  ...CODEX_RECOVERY_REQUEST_OPTIONS,
  history: { itemTypes: [] },
} as const;

type CodexTimeoutReconcileDecision =
  | "pending"
  | "completed"
  | "terminal_failed"
  | "monitoring_resumed"
  | "unresolved"
  | "request_failed"
  | "stale_ignored";

type CodexTimeoutReconcileErrorDetail = {
  name: string;
  code: string | null;
  message: string;
  method: string | null;
  requestId: number | null;
  processGeneration: number | null;
};

type CodexTimeoutReconcileRawData = {
  type: "started" | "resolved" | "failed";
  phase: "started" | "resolved" | "failed";
  decision: CodexTimeoutReconcileDecision;
  clientTurnId: string;
  providerThreadId: string;
  providerTurnId: string;
  timeoutSequence: number;
  requestMethod: "thread/read";
  requestTimeoutMs: number;
  elapsedMs: number;
  providerThreadStatus: string | null;
  providerTurnStatus: string | null;
  providerTurnFound: boolean | null;
  activeTurnMatched: boolean | null;
  error: CodexTimeoutReconcileErrorDetail | null;
};

type CodexTurnBindingSource = "start_result" | "provider_lifecycle" | "observed";

type CompactStartState = {
  phase: "pending" | "accepted" | "unknown";
  error: Error | null;
  lateSettlementPending: boolean;
  lateSettlementResult: CodexAppServerLateSettlement | null;
  providerTurnIdsBeforeStart: Set<string>;
  providerCompactTurnIds: Set<string>;
};

type ConfigRefreshUnsubscribeFence = {
  sessionId: SessionId;
  settlement: Promise<CodexAppServerLateSettlement>;
};

type CodexRollbackExpectation = {
  droppedTurnIds: string[];
  retainedTurnId: string | null;
};

export type CodexPreparedRollbackHistory = CodexRollbackExpectation & {
  sessionId: SessionId;
  numTurns: number;
  providerLifecycleEventVersion: number;
  beforeTurnIds: string[];
  afterTurnIds: string[];
};

type ActiveTurn = {
  clientTurnId: TurnId;
  clientUserMessageIds: Set<string>;
  providerInputImageReleases?: Set<(reason: string) => void>;
  clientUserMessageSequenceById?: Map<string, number>;
  confirmedClientUserMessageSequence?: number;
  providerOwnershipStartingTurn?: StartingTurn | null;
  codexTurnId: string | null;
  provisionalCodexTurnId?: string | null;
  codexTurnBindingSource?: CodexTurnBindingSource | null;
  responseFormat: SendMessageInput["responseFormat"];
  accessMode: AccessMode;
  toolRegistry: ExecutableToolRegistry | null;
  executeHostTool: HostToolExecutor | null;
  sharedWorkspaceToolContext: SharedWorkspaceToolExecutionContext | null;
  platformToolFailureCounts: Map<string, number>;
  timeoutController: TurnTimeoutController;
  /** 单次 turn 的 todolist 原文聚合（避免与下一轮 turn 串台）。 */
  todolistTextState: { text: string };
  /** 是否在本轮观察到 todolist(update_plan) 更新（用于决定是否补拉 ThreadItem(type=plan).text）。 */
  todolistSeenState: { seen: boolean };
  /** 是否已收到 turn/plan/updated（避免只有 delta 时 Web 一直“运行中”）。 */
  todolistToolCompletedState: { completed: boolean };
  manualInterruptRequested: boolean;
  manualInterruptError: Error | null;
  interruptPromise: Promise<boolean> | null;
  interruptTerminalError: Error | null;
  pendingEngineIdleTimeoutError: EngineTimeoutError | null;
  idleTimeoutReconcilePromise: Promise<void> | null;
  providerTerminalStatus: string | null;
  lastNonRetryableTurnError: Error | null;
  compactStartState: CompactStartState | null;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

type StartingTurn = {
  clientTurnId: TurnId;
  clientUserMessageId: string;
  preparedInputActions: PreparedCodexSkillInput | null;
  preparedInputActionsConsumed: boolean;
  preparedWorkspace: ReturnType<CodexAppServerManager["getOrCreate"]> | null;
  interruptRequested: boolean;
  interruptPromise: Promise<boolean> | null;
  createdProviderThreadId: SessionId | null;
  providerThreadId: SessionId | null;
  providerTurnId: string | null;
  providerLifecycleTurnId: string | null;
  providerStartedTurnKeys: Set<string>;
  providerStartedTurnIdsSeen: Set<string>;
  providerStartEvidenceTurnId: string | null;
  providerStartEvidenceAttemptId: number | null;
  providerObservedTurnId: string | null;
  startRequestSent: boolean;
  startRequestAttemptSequence: number;
  pendingStartRequestAttemptId: number | null;
  lastStartRequestAttemptId: number | null;
  persistedStartAttemptId: number | null;
  persistedStartAttemptProviderTurnId: string | null;
  startRequestDispatched: Promise<void>;
  signalStartRequestDispatched: () => void;
  preflightInterruptSignal: Promise<void>;
  signalPreflightInterrupt: () => void;
  providerOwnershipSignal: Promise<void>;
  signalProviderOwnership: () => void;
  startupInterruptAcknowledged: boolean;
  startupInterruptAcknowledgedSignal: Promise<void>;
  acknowledgeStartupInterrupt: () => void;
  startError: unknown | null;
  providerOwnershipConflict: Error | null;
  lateSettlement: Promise<CodexAppServerLateSettlement> | null;
  lateSettlementResult: CodexAppServerLateSettlement | null;
  releaseLateSettlement: (() => void) | null;
  lateSettlementReleased: boolean;
  reconcileRequested: boolean;
  reconcileRetryScheduled: boolean;
  reconcileRetryPending: boolean;
  compensatedProviderTurnIds: Set<string>;
  terminalHintProviderTurnIds: Set<string>;
  terminalThreadHintSeen: boolean;
  terminalEvidenceVersion: number;
  handoffTerminalReconcile: Promise<void> | null;
  handoffTerminalSettled: boolean;
  ownershipRecoveryPromise: Promise<void> | null;
  ownershipRecoveryTimer: ReturnType<typeof setTimeout> | null;
  ownershipRecoveryExpiryTimer: ReturnType<typeof setTimeout> | null;
  ownershipRecoveryExhausted: boolean;
  ownershipRecoveryRescanRequested: boolean;
  ownershipRecoveryRetryAt: number;
  ownershipRecoveryRetryDelayMs: number;
  ownershipRecoveryExpiresAt: number;
  onProviderTurnRecovered: ((providerTurnId: string) => void) | null;
  interruptFinalized: Promise<void>;
  resolveInterruptFinalized: () => void;
  settled: Promise<void>;
  settle: () => void;
};

type PendingSteerCorrelation = {
  clientTurnId: TurnId;
  clientUserMessageId: string;
  providerThreadId: SessionId;
  sequence: number;
  state: "pending" | "accepted" | "confirmed" | "failed" | "interrupted";
  provisionalProviderTurnId: string | null;
  confirmedProviderTurnId: string | null;
  providerObservedTurnId: string | null;
  ownershipRecoveryPromise: Promise<void> | null;
  ownershipRecoveryTimer: ReturnType<typeof setTimeout> | null;
  ownershipRecoveryExhausted: boolean;
  ownershipRecoveryRescanRequested: boolean;
  ownershipRecoveryRetryAt: number;
  ownershipRecoveryRetryDelayMs: number;
  ownershipRecoveryExpiresAt: number;
};

type CodexProviderInputAdmission = {
  providerThreadId: SessionId;
  lifecycleEventVersion: number;
  foreignActiveTurnId: string | null;
  foreignGoalStatus: string | null;
};

type CodexProviderMutationContext = {
  operation: "input" | "compact" | "rollback";
  clientTurnId: TurnId | null;
  clientUserMessageId: string | null;
};

type CodexClientIdTurnMatch =
  | { kind: "missing"; turnIds: [] }
  | { kind: "unique"; turnIds: [string]; turnId: string }
  | { kind: "ambiguous"; turnIds: string[] };

type CodexProviderTurnOwnershipEvidence = {
  turns: any[];
  match: CodexClientIdTurnMatch;
  complete: boolean;
  incompleteCause?: Error;
};

type CodexProviderInputImageLease = {
  /** 登记一个真实 provider 输入请求，并追踪其迟到结算。 */
  trackRequest: (request: Promise<unknown>) => void;
  /** 标记本地调用已结束；没有在途 provider 使用时清理图片。 */
  close: (reason: string) => void;
  /** 关闭后的待释放或失败结果；通知回调只保存结果，不抛到事件循环。 */
  getError: () => Error | null;
};

export type CodexDetachedProviderRecoveryInput = {
  clientTurnId: TurnId;
  clientUserMessageId: string;
  provisionalProviderTurnId: string | null;
  onProviderTurnRecovered: (providerTurnId: string) => void;
};

export type CodexStartAttemptInput = {
  workspaceId: WorkspaceId;
  threadId: string;
  clientTurnId: TurnId;
  clientUserMessageId: string;
  providerThreadId: SessionId;
  provisionalProviderTurnId: string;
  attemptId: number;
  observedAt: number;
};

type CodexBackgroundProcessRecord = {
  itemId: string;
  serviceId: string;
  processId: string;
  command: string;
  workingDirectory: string;
  outputTail: string;
  startedAt: number;
  readyAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  displayName: string;
};

/** 构造 provider thread 与用户消息的联合键，隔离不同 generation 的相同 clientId。 */
function buildCodexProviderClientCorrelationKey(providerThreadId: SessionId | string, clientId: string): string {
  return JSON.stringify([String(providerThreadId), String(clientId)]);
}

/** 恢复并读取指定 provider thread；不依赖或裁决当前内存 binding。 */
export async function resumeCodexProviderThreadForRead(
  requester: {
    request(
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number; trackLateSettlement?: boolean; history?: CodexHistoryProjection },
    ): Promise<unknown>;
  },
  expectedSessionId: SessionId,
  options: { includeTurns?: boolean; modelProvider?: string | null; history?: CodexHistoryProjection } = {},
): Promise<unknown> {
  let resumeCause: unknown = null;
  try {
    await requester.request(
      "thread/resume",
      {
        threadId: expectedSessionId,
        ...(String(options.modelProvider ?? "").trim()
          ? { modelProvider: String(options.modelProvider).trim() }
          : {}),
      },
      CODEX_RECOVERY_REQUEST_OPTIONS,
    );
  } catch (cause) {
    resumeCause = cause;
    if (isCodexRecoveryRequestTimeout(cause)) {
      const recoveryError = buildCodexProviderThreadRecoveryError({
        code: "codex_thread_resume_unconfirmed",
        providerThreadId: expectedSessionId,
        reason: "resume_request_timeout",
        message: "Codex thread/resume 请求超时；binding 保持不变。",
        cause,
        retryable: false,
      });
      copyCodexLateSettlementMetadata(recoveryError, cause);
      throw recoveryError;
    }
  }

  let read: unknown;
  try {
    read = await requester.request(
      "thread/read",
      { threadId: expectedSessionId, includeTurns: options.includeTurns === true },
      { ...CODEX_RECOVERY_REQUEST_OPTIONS, ...(options.history ? { history: options.history } : {}) },
    );
  } catch (cause) {
    const recoveryError = buildCodexProviderThreadRecoveryError({
      code: "codex_thread_resume_unconfirmed",
      providerThreadId: expectedSessionId,
      reason: "read_failed_after_resume",
      message: "Codex thread/read 请求失败；binding 保持不变。",
      cause: combineCodexResumeAndReadFailures(resumeCause, cause),
      retryable: !isCodexRecoveryRequestTimeout(cause),
    });
    copyCodexLateSettlementMetadata(recoveryError, cause);
    throw recoveryError;
  }

  const providerThread = (read as any)?.thread ?? null;
  const providerThreadId = String(providerThread?.id ?? "").trim();
  if (providerThreadId !== String(expectedSessionId)) {
    throw buildCodexProviderThreadRecoveryError({
      code: "codex_thread_resume_unconfirmed",
      providerThreadId: expectedSessionId,
      reason: "thread_identity_mismatch_after_resume",
      message: "Codex thread/read 返回了其他 thread；binding 保持不变。",
      cause: resumeCause,
    });
  }
  return read;
}

/** 构造 provider thread 与 turn 的联合键，避免跨 generation 共享补偿任务。 */
function buildCodexProviderTurnCorrelationKey(providerThreadId: SessionId | string, providerTurnId: string): string {
  return JSON.stringify([String(providerThreadId), String(providerTurnId)]);
}

/** 构造 attempt 级 started 证据键，避免重试时迟到事件借用新请求。 */
function buildCodexProviderStartEvidenceKey(
  providerThreadId: SessionId | string,
  attemptId: number,
  providerTurnId: string,
): string {
  return JSON.stringify([String(providerThreadId), attemptId, String(providerTurnId)]);
}

/**
 * Codex app-server thread 会话（真流式）。
 * - `thread/start` 返回的 threadId 作为 sessionId（用于 resume）
 * - `turn/start` 后 app-server 持续推送 item/turn 事件
 */
export class CodexAppServerThreadSession implements ThreadEngineSession {
  readonly engine = "codex" as const;

  private sessionId: SessionId | null;
  private active: ActiveTurn | null = null;
  private startingTurn: StartingTurn | null = null;
  private historyRollbackInProgress = false;
  private preparedHistoryRollback: CodexPreparedRollbackHistory | null = null;
  private pendingTerminalStateReconcileTurnId: string | null = null;
  private terminalStateReconcileHintVersion = 0;
  private pendingHandoffStartingTurn: StartingTurn | null = null;
  private pendingReconnectRecoveryTurnId: string | null = null;
  private pendingReconnectRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private registered = false;
  private unregister: (() => void) | null = null;
  private resumed = false;
  /** 原 provider binding 尚未被同 ID 的安全恢复状态确认；idle 回收不得释放它。 */
  private recoveryPending = false;
  private responseText = "";
  private emitters: ThreadEventEmitters | null = null;
  private readonly pendingRequests = new Map<string, { id: unknown; kind: "approval" | "userInput" }>();
  private readonly assistantLifecycle = new AssistantLifecycleTracker();
  private readonly codexTurnIdByClientTurnId = new Map<TurnId, string>();
  /** 随原 turn 映射保留权限，终态补偿不能使用已重置或后继回合的权限。 */
  private readonly nativeToolPolicyByClientTurnId = new Map<TurnId, ProviderNativeToolPolicy>();
  private readonly clientTurnIdByCodexTurnId = new Map<string, TurnId>();
  private readonly retiredCodexTurnIds = new Set<string>();
  private readonly retiredCodexTurnMappingOrder: string[] = [];
  private readonly terminalObservedProviderTurnStatusById = new Map<string, string>();
  private readonly terminalObservedProviderTurnStatusByThreadId = new Map<SessionId, Map<string, string>>();
  private readonly supersededProviderHeadTurnIds = new Set<string>();
  private readonly pendingInterruptedStartingTurns = new Map<TurnId, StartingTurn>();
  private readonly pendingInterruptedProviderCompensationsByKey = new Map<string, Promise<string>>();
  private readonly pendingSteerCorrelationsByProviderClientKey = new Map<string, PendingSteerCorrelation>();
  private readonly detachedProviderThreadUnregisterById = new Map<SessionId, () => void>();
  private readonly handledCodexBindingPersistenceErrors = new WeakSet<Error>();
  private readonly observedRecoverySettlements = new WeakSet<Promise<CodexAppServerLateSettlement>>();
  private pendingSessionBindingDrop: { expectedSessionId: SessionId | null; lastError: Error | null } | null = null;
  private pendingSteerOwnershipRecovery: Promise<void> | null = null;
  private pendingSteerOwnershipRecoveryRequested = false;
  private disposed = false;
  private diagnosticFailure: { reason: Error } | null = null;
  private observedProviderThreadStatus: string | null = null;
  private observedProviderActiveTurnId: string | null = null;
  private providerLifecycleEventVersion = 0;
  private activeTurnSettled: Promise<void> | null = null;
  private readonly providerInputImageLeases = new Set<CodexProviderInputImageLease>();
  private credentialLease: import('../../security/builtInRelayCredentialService.js').EngineCredentialLease | undefined;
  private credentialCallPending: { turnId: TurnId; phase: "running" | "stopping" | "draining" | "failed"; preparing?: boolean; settled?: Promise<void>; failure?: ThreadEventFlushError } | null = null;
  private currentProviderNativeToolPolicy: ProviderNativeToolPolicy = "allow";
  private appliedContextWindow: number | null = null;
  private appliedModelAutoCompactTokenLimit: number | null = null;
  private appliedModel: string | null = null;
  private appliedDeveloperInstructions: string | null = null;
  private hasAppliedDeveloperInstructions = false;
  private pendingConfigRefreshUnsubscribe: ConfigRefreshUnsubscribeFence | null = null;
  private sessionCapabilities: ThreadSessionCapabilities | null;
  private readonly pendingCommandExecutionsByItemId = new Set<string>();
  private readonly pendingBackgroundProcessesByItemId = new Map<string, CodexBackgroundProcessRecord>();
  private readonly backgroundProcessesByItemId = new Map<string, CodexBackgroundProcessRecord>();
  private readonly backgroundProcessesByServiceId = new Map<string, CodexBackgroundProcessRecord>();
  constructor(
    private readonly opts: {
      manager: CodexAppServerManager;
      writeWorkspaceLog: EngineWorkspaceLogWriter;
      workspacePath: string;
      workspaceId: WorkspaceId;
      threadId: string;
      initialSessionId: SessionId | null;
      initialSessionCapabilities: ThreadSessionCapabilities | null;
      onEngineProcessSnapshot: (snapshot: ManagedServiceSnapshot) => boolean;
      onSessionBinding: (sid: SessionId, capabilities: ThreadSessionCapabilities | null) => void;
      onSessionBindingDropped: (expectedSessionId: SessionId | null) => void;
      onStartAttempt: (input: CodexStartAttemptInput) => void;
      /** 优先使用 Client DB 活动 Key 判断当前 provider 的动态工具能力。 */
      resolveCodexRuntimeConfig?: () => CodexRuntimeConfig | null;
      acquireCredential?: AcquireEngineCredential;
      withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
      supportsNativeDynamicTools?: () => boolean;
      markNativeDynamicToolsUnsupported?: () => void;
      reconnectRecoveryGraceMs?: number;
      reconnectRecoveryPollMs?: number;
      reconnectRecoveryMaxAttempts?: number;
      activeOwnershipRecoveryTtlMs?: number;
      activeOwnershipRecoveryEvidenceTtlMs?: number;
      /** 持久化历史未收口时拒绝新的 send/compact/append。 */
      assertMutationAllowed?: () => void;
      /** 普通聊天 Client-local opaque Skill id key；隔离会话不提供。 */
      getInputActionHmacKey?: () => Buffer;
    },
  ) {
    this.sessionId = opts.initialSessionId;
    this.sessionCapabilities = opts.initialSessionCapabilities ?? null;
  }

  /** 同步门禁和绑定写回独立准入，provider RPC 始终在许可外等待。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    return this.opts.withLegacyDatabase ? this.opts.withLegacyDatabase(`codex-session:${this.opts.threadId}`, operation) : operation();
  }

  get workspaceId(): WorkspaceId {
    return this.opts.workspaceId;
  }

  get threadId(): string {
    return this.opts.threadId;
  }

  getSessionId(): SessionId | null {
    return this.sessionId;
  }

  /** 新外部操作复检当前资格；已派发回合内部请求继续使用冻结租约。 */
  private assertNewOperationCredential(): void {
    this.assertDiagnosticReady();
    if (this.credentialLease) { this.credentialLease.assertCurrent(); return; }
    const lease = this.opts.acquireCredential?.({});
    try { lease?.assertCurrent(); } finally { lease?.release(); }
  }

  /** Reads Codex provider actions without exposing absolute Skill paths. */
  async listInputActions(trigger: "/" | "$") {
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    if (trigger === "/") {
      return {
        engine: "codex" as const,
        actions: buildCodexCliSlashInputActions({
          // session 层没有完整历史计数；compact API 仍会做最终权威校验。
          hasConversationHistory: true,
          runningTurnId: this.hasActiveTurn() ? "active" : null,
          queueLength: 0,
        }),
        providerCatalog: { state: "ready" as const, observedAt: null },
      };
    }
    const hmacKey = (await this.withDatabase(() => this.requireInputActionHmacKey()));
    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    await ws.ensureStarted();
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    const snapshot = ws.getProcessSnapshot();
    return await listCodexSkillInputActions({
      requester: ws,
      workspaceId: this.opts.workspaceId,
      workspacePath: this.opts.workspacePath,
      hmacKey,
      expectedProcessGeneration: snapshot.generation,
    });
  }

  /** Fresh-resolves Skill bindings and atomically reserves the existing starting-turn owner. */
  async prepareInputActions(input: {
    turnId: TurnId;
    userItemId: import("@codeflowai/shared").ItemId;
    text: string;
    skillMentions: readonly import("@codeflowai/shared").CodexSkillMentionBinding[];
  }): Promise<PreparedCodexSkillInput> {
    this.assertProviderInputImagesReleased();
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    (await this.withDatabase(() => this.opts.assertMutationAllowed?.()));
    (await this.withDatabase(() => this.retryPendingSessionBindingDrop()));
    if (this.disposed) throw createCodexSkillBindingError("Codex 会话已失效");
    if (this.active || this.startingTurn || this.historyRollbackInProgress) {
      throw createCodexSkillBindingError("当前 thread 有未完成的 turn", "active_turn_conflict");
    }
    const hmacKey = (await this.withDatabase(() => this.requireInputActionHmacKey()));
    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    await ws.ensureStarted();
    (await this.withDatabase(() => this.assertNewOperationCredential()));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = ws.getProcessSnapshot();
      if (!snapshot.running) {
        if (attempt === 0) {
          (await this.withDatabase(() => this.assertNewOperationCredential()));
          await ws.ensureStarted();
          (await this.withDatabase(() => this.assertNewOperationCredential()));
          continue;
        }
        throw createCodexSkillBindingError("Codex app-server 未运行");
      }
      let skills: Awaited<ReturnType<typeof resolveCodexSkillMentionBindings>>;
      try {
        skills = await resolveCodexSkillMentionBindings({
          requester: ws,
          workspaceId: this.opts.workspaceId,
          workspacePath: this.opts.workspacePath,
          hmacKey,
          text: input.text,
          bindings: input.skillMentions,
          expectedProcessGeneration: snapshot.generation,
        });
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        (await this.withDatabase(() => this.assertNewOperationCredential()));
        if (attempt === 0 && !ws.isCurrentProcessGeneration(snapshot.generation)) {
          await ws.ensureStarted();
          (await this.withDatabase(() => this.assertNewOperationCredential()));
          continue;
        }
        throw cause;
      }
      (await this.withDatabase(() => this.assertNewOperationCredential()));
      if (!ws.isCurrentProcessGeneration(snapshot.generation)) {
        if (attempt === 0) {
          await ws.ensureStarted();
          (await this.withDatabase(() => this.assertNewOperationCredential()));
          continue;
        }
        throw createCodexSkillBindingError("Codex app-server 代际在 Skill 解析期间变化");
      }
      if (this.disposed || this.active || this.startingTurn || this.historyRollbackInProgress) {
        throw createCodexSkillBindingError("Skill 解析完成时 thread 已被其他回合占用", "active_turn_conflict");
      }
      const prepared: PreparedCodexSkillInput = {
        kind: "codex-skills",
        reservationId: crypto.randomUUID(),
        turnId: input.turnId,
        userItemId: input.userItemId,
        processGeneration: snapshot.generation,
        skills,
      };
      const startingTurn = createStartingTurn(input.turnId, String(input.userItemId));
      startingTurn.preparedInputActions = prepared;
      startingTurn.preparedWorkspace = ws;
      this.startingTurn = startingTurn;
      return prepared;
    }
    throw createCodexSkillBindingError("Codex app-server 代际持续变化");
  }

  /** Releases only an unconsumed prepared reservation owned by this session. */
  releasePreparedInputActions(prepared: PreparedCodexSkillInput): boolean {
    const startingTurn = this.startingTurn;
    if (
      !startingTurn
      || startingTurn.preparedInputActions !== prepared
      || startingTurn.preparedInputActionsConsumed
      || startingTurn.startRequestSent
    ) return false;
    this.finishStartingTurn(startingTurn);
    return true;
  }

  /** Returns the normal-chat HMAC key or fails before Provider discovery. */
  private requireInputActionHmacKey(): Buffer {
    const key = this.opts.getInputActionHmacKey?.() ?? null;
    if (!key || key.length !== 32) {
      throw createCodexSkillBindingError("当前会话未启用 Codex Skill 输入能力");
    }
    return key;
  }

  /** Fences a reserved Skill input to its exact workspace handle and live process generation. */
  private assertPreparedInputGeneration(
    startingTurn: StartingTurn,
    prepared: PreparedCodexSkillInput,
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
  ): void {
    const existing = this.opts.manager.getExisting(this.opts.workspaceId);
    if (
      startingTurn.preparedInputActions !== prepared
      || startingTurn.preparedWorkspace !== ws
      || existing !== ws
      || !ws.isCurrentProcessGeneration(prepared.processGeneration)
    ) {
      throw createCodexSkillBindingError("Codex app-server 代际在发送前变化");
    }
  }

  /** 当前 binding 是否仍有尚未收口的恢复操作。 */
  isRecoveryPending(): boolean {
    return this.recoveryPending;
  }

  /**
   * 业务终态持久化后解除同一 session 的内存恢复状态。
   * 不清理持久化 binding，也不发出 thread/unsubscribe；session 仍由后续正常 idle 清理处理。
   */
  releaseRecoveryPending(expectedSessionId: SessionId): boolean {
    if (this.sessionId !== expectedSessionId) return false;
    this.recoveryPending = false;
    return true;
  }

  /** 标记一次原 binding 恢复尝试；各调用点按自身 provider 合同收口。 */
  private beginRecoveryAttempt(expectedSessionId: SessionId): void {
    if (this.sessionId !== expectedSessionId) return;
    this.recoveryPending = true;
    this.resumed = false;
    this.hasAppliedDeveloperInstructions = false;
  }

  /** 只有同 ID 的 idle thread/read 才能确认恢复并解除 idle 门禁。 */
  private confirmIdleRecovery(expectedSessionId: SessionId, providerThreadId: string, status: string): boolean {
    if (
      this.sessionId !== expectedSessionId
      || String(providerThreadId ?? "").trim() !== String(expectedSessionId)
      || normalizeCodexTurnStatus(status) !== "idle"
    ) {
      this.resumed = false;
      this.recoveryPending = true;
      return false;
    }
    this.resumed = true;
    this.recoveryPending = false;
    this.markObservedProviderThreadTerminal("idle");
    return true;
  }

  /**
   * 将持久化层已通过 CAS 确认的 capability 快照补回当前内存 binding。
   * 这里只同步同一 provider thread；不得触发 resume/start/drop，也不得覆盖冲突能力。
   */
  restoreSessionCapabilities(
    expectedSessionId: SessionId,
    capabilities: ThreadSessionCapabilities,
  ): boolean {
    if (!this.canRestoreSessionCapabilities(expectedSessionId, capabilities)) return false;
    if (!this.sessionCapabilities) {
      this.sessionCapabilities = cloneThreadSessionCapabilities(capabilities);
    }
    return true;
  }

  /** 只读预检 capability 快照能否补回；与 restore 的成功条件完全一致。 */
  canRestoreSessionCapabilities(
    expectedSessionId: SessionId,
    capabilities: ThreadSessionCapabilities,
  ): boolean {
    if (this.sessionId !== expectedSessionId) return false;
    return !this.sessionCapabilities
      || threadSessionCapabilitiesEqual(this.sessionCapabilities, capabilities);
  }

  /** 仅上报用户仍可停止的本地运行单元。 */
  hasActiveTurn(): boolean {
    return Boolean(
      this.active
      || this.startingTurn
      || this.credentialCallPending
      || this.historyRollbackInProgress,
    );
  }

  /** 返回当前启动中或 active 的 client turnId，已结束的旧 mutation fence 不再占用 UI 运行态。 */
  getActiveTurnId(): TurnId | null {
    return this.active?.clientTurnId
      ?? this.startingTurn?.clientTurnId
      ?? this.credentialCallPending?.turnId
      ?? null;
  }

  /** 未确认 ownership/终态的旧 mutation 仍需阻止 session 被提前回收。 */
  private hasPendingProviderMutationFence(): boolean {
    return Boolean(this.getPendingProviderMutationFenceTurnId());
  }

  /** 返回仍占用当前 provider thread 的旧 mutation，供释放与 idle cleanup 判断。 */
  private getPendingProviderMutationFenceTurnId(): TurnId | null {
    const sessionId = String(this.sessionId ?? "").trim();
    // 没有当前 binding 时，旧 provider thread 的 tombstone 不阻塞其他 generation。
    if (!sessionId) return null;
    if (String(this.pendingHandoffStartingTurn?.providerThreadId ?? "") === sessionId) {
      return this.pendingHandoffStartingTurn!.clientTurnId;
    }
    const interruptedStart = Array.from(this.pendingInterruptedStartingTurns.values())
      .filter((startingTurn) => (
        String(startingTurn.providerThreadId ?? "") === sessionId
      ))
      .at(-1) ?? null;
    if (interruptedStart) return interruptedStart.clientTurnId;
    const interruptedSteer = Array.from(this.pendingSteerCorrelationsByProviderClientKey.values())
      .filter((correlation) => (
        correlation.state === "interrupted"
        && String(correlation.providerThreadId) === sessionId
      ))
      .sort((left, right) => right.sequence - left.sequence)[0] ?? null;
    return interruptedSteer?.clientTurnId ?? null;
  }

  /** idle 回收前确认没有 active/pending 运行态和后台服务。 */
  canIdleDispose(): boolean {
    this.assertDiagnosticReady();
    return !this.recoveryPending
      && this.providerInputImageLeases.size === 0
      && !this.startingTurn
      && !this.active
      && !this.historyRollbackInProgress
      && !this.pendingTerminalStateReconcileTurnId
      && !this.hasPendingProviderMutationFence()
      && !this.pendingReconnectRecoveryTurnId
      && !this.pendingReconnectRecoveryTimer
      && this.pendingInterruptedStartingTurns.size === 0
      && this.pendingSteerCorrelationsByProviderClientKey.size === 0
      && this.detachedProviderThreadUnregisterById.size === 0
      && !this.pendingSessionBindingDrop
      && !this.pendingConfigRefreshUnsubscribe
      && this.pendingRequests.size === 0
      && this.pendingCommandExecutionsByItemId.size === 0
      && this.pendingBackgroundProcessesByItemId.size === 0
      && !this.hasLiveBackgroundProcess();
  }

  /** 已注册工具可按回合停用；仅复用名称映射兼容的子集，不为新增工具伪造注册。 */
  resolvePlatformToolTransport(
    toolRegistry: ExecutableToolRegistry | null,
    requirement: PlatformToolTransportRequirement = "optional",
  ): "protocol" | "native-dynamic" {
    const requestedToolIds = listExecutableToolIds(toolRegistry);
    const requestedBindingVersion = buildCodexDynamicToolBindingVersion(toolRegistry);
    if (!requestedToolIds.length) return "native-dynamic";
    if (!this.supportsNativeDynamicTools()) return "protocol";
    if (requirement === "required") return "native-dynamic";
    if (!this.sessionId) return "native-dynamic";
    return this.currentSessionSupportsDynamicToolBinding(requestedToolIds, requestedBindingVersion)
      ? "native-dynamic"
      : "protocol";
  }

  /**
   * Codex provider thread 的动态工具集合是启动时固定的；知识执行线程若遗留旧绑定，
   * 清除 provider generation 后由下一轮在同一本地 thread 上重新 thread/start。
   *
   * sendMessage 会在进入 ensureThreadSession 前登记 startingTurn。能力不兼容发生在
   * ensureThreadSession 的准入检查阶段，此时没有发出 turn/start，仍然可以安全旋转；
   * 一旦已经发出 provider mutation，就必须保留 binding，交给 ownership/recovery 链收口。
   */
  resetDynamicToolBinding(): boolean {
    this.assertProviderInputImagesReleased();
    const sessionId = this.sessionId;
    if (!sessionId || this.active || this.historyRollbackInProgress || this.pendingSessionBindingDrop) return false;
    if (this.hasPendingProviderMutationFence()) return false;
    const startingTurn = this.startingTurn;
    if (startingTurn && (
      startingTurn.startRequestSent
      || startingTurn.pendingStartRequestAttemptId !== null
      || startingTurn.providerThreadId
      || startingTurn.providerTurnId
      || startingTurn.providerLifecycleTurnId
      || startingTurn.providerObservedTurnId
      || startingTurn.providerOwnershipConflict
    )) return false;
    this.detachProviderGeneration(sessionId);
    return true;
  }

  /** 复用精确 turn 快照补正文与异步问题，重复问题由统一 reducer 保留提交状态。 */
  async prepareAssistantTerminalEvents(input: {
    turnId: TurnId;
    outcome: "completed" | "error";
  }): Promise<{ events: ConversationEventInput[]; latestAssistantText: string | null }> {
    const events: ConversationEventInput[] = [];
    // 已确认进程终止时沿用本地输出，避免终态收尾又隐式启动 app-server。
    if (input.outcome === "completed" && this.sessionId && !this.disposed) {
      const snapshot = await this.readTerminalItemsFromThreadRead(input.turnId);
      const nativeToolPolicy = this.nativeToolPolicyByClientTurnId.get(input.turnId) ?? this.currentProviderNativeToolPolicy;
      if (snapshot.userInputRequests.length && !providerNativeInteractionToolsAllowed(nativeToolPolicy)) {
        throw new Error(buildProviderNativeToolDenyMessage("codex", "request_user_input_async"));
      }
      for (const request of snapshot.userInputRequests) {
        events.push({ ts: Date.now(), workspaceId: this.opts.workspaceId, threadId: this.opts.threadId as any,
          engine: "codex", type: "userInput.requested", payload: { request } });
      }
      for (const item of snapshot.assistantItems) {
        const record = this.resolveAssistantSnapshotRecord(input.turnId, item);
        const shouldUpgradeFromSnapshot = !record
          || !record.completed
          || record.text !== item.text
          || codexAssistantPhasePriority(item.phase) > codexAssistantPhasePriority(record.phase);
        if (!shouldUpgradeFromSnapshot) continue;
        const nextRevision = record ? record.revision + 1 : 1;
        this.assistantLifecycle.ensureCompleted({
          itemId: record?.itemId ?? item.itemId,
          engineMessageId: record?.engineMessageId ?? item.engineMessageId,
          turnId: input.turnId,
          text: item.text,
          revision: nextRevision,
          phase: item.phase,
          completionSource: "snapshot_reconcile",
        });
        events.push(buildAssistantCompletedEvent({
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          engine: "codex",
          itemId: record?.itemId ?? item.itemId,
          engineMessageId: record?.engineMessageId ?? item.engineMessageId,
          turnId: input.turnId,
          text: item.text,
          revision: nextRevision,
          phase: item.phase,
          completionSource: "snapshot_reconcile",
        }));
      }
    }

    for (const record of this.assistantLifecycle.listPendingTerminalization(input.turnId)) {
      const nextRevision = record.revision + 1;
      this.assistantLifecycle.markCompleted({
        itemId: record.itemId,
        text: record.text,
        revision: nextRevision,
        phase: record.phase,
        completionSource: "runtime_close_reconcile",
      });
      events.push(buildAssistantCompletedEvent({
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        engine: "codex",
        itemId: record.itemId,
        engineMessageId: record.engineMessageId,
        turnId: input.turnId,
        text: record.text,
        revision: nextRevision,
        phase: record.phase,
        completionSource: "runtime_close_reconcile",
      }));
    }

    return {
      events,
      latestAssistantText: this.assistantLifecycle.latestText(input.turnId),
    };
  }

  private resolveAssistantSnapshotRecord(
    turnId: TurnId,
    item: {
      itemId: string;
      text: string;
      phase?: AssistantMessagePhase;
    },
  ): AssistantLifecycleRecord | null {
    const direct = this.assistantLifecycle.get(item.itemId);
    if (direct) return direct;

    const normalizedSnapshotText = normalizeAssistantReconcileText(item.text);
    if (!normalizedSnapshotText) return null;
    const snapshotPhasePriority = codexAssistantPhasePriority(item.phase);
    const candidates = this.assistantLifecycle.listByTurn(turnId).filter((record) => {
      if (!record.completed) return false;
      if (normalizeAssistantReconcileText(record.text) !== normalizedSnapshotText) return false;
      return snapshotPhasePriority >= codexAssistantPhasePriority(record.phase);
    });
    if (candidates.length !== 1) return null;
    return candidates[0] ?? null;
  }

  async stopManagedService(serviceId: string): Promise<boolean> {
    const normalizedServiceId = String(serviceId ?? "").trim();
    if (!normalizedServiceId) return false;
    const record = this.backgroundProcessesByServiceId.get(normalizedServiceId) ?? null;
    if (!record) return false;
    if (record.exitedAt != null) return true;

    const pid = parseManagedProcessPid(record.processId);
    if (!pid) return false;

    try {
      terminateManagedProcess(pid);
    } catch (error) {
      if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
      if (!isProcessMissingError(error)) return false;
    }

    const exitedAt = Date.now();
    const stoppedRecord: CodexBackgroundProcessRecord = {
      ...record,
      readyAt: record.readyAt ?? record.startedAt,
      exitedAt,
      exitCode: null,
    };
    this.backgroundProcessesByItemId.set(stoppedRecord.itemId, stoppedRecord);
    this.backgroundProcessesByServiceId.set(stoppedRecord.serviceId, stoppedRecord);
    this.publishEngineProcessSnapshot({
      serviceId: stoppedRecord.serviceId,
      displayName: stoppedRecord.displayName,
      source: "engine",
      stopSupported: false,
      status: "stopped",
      pid: null,
      command: stoppedRecord.command,
      args: [],
      workingDirectory: stoppedRecord.workingDirectory,
      startupTimeoutMs: 0,
      readySummary: "已停止",
      startedAt: stoppedRecord.startedAt,
      readyAt: stoppedRecord.readyAt,
      exitedAt: stoppedRecord.exitedAt,
      exitCode: stoppedRecord.exitCode,
      exitSignal: null,
    });
    return true;
  }

  /**
   * 回滚 thread 历史（丢弃末尾 N 个 user turn）。
   * - 仅修改引擎历史，不处理本地文件/事件裁剪。
   */
  async rollbackHistory(numTurns: number, expectation: CodexRollbackExpectation): Promise<void> {
    const prepared = await this.prepareRollbackHistory(numTurns, expectation);
    if (!prepared) return;
    await this.applyPreparedRollbackHistory(prepared);
  }

  /** 只读校验 provider 历史、收敛可证明的尾部幻影映射并持有回滚锁。 */
  async prepareRollbackHistory(
    numTurns: number,
    expectation: CodexRollbackExpectation,
  ): Promise<CodexPreparedRollbackHistory | null> {
    this.assertProviderInputImagesReleased();
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    (await this.withDatabase(() => this.retryPendingSessionBindingDrop()));
    const n = Math.floor(Number(numTurns ?? 0));
    if (!Number.isFinite(n) || n <= 0) return null;
    if (this.active || this.startingTurn || this.hasPendingProviderMutationFence()) {
      throw new Error("当前 thread 有未完成的 turn");
    }
    if (this.historyRollbackInProgress) throw new Error("当前 thread 正在回滚历史");
    if (!this.sessionId) throw new Error("Codex sessionId 缺失，无法回滚");
    const expectedDroppedTurnIds = normalizeCodexRollbackTurnIds(expectation?.droppedTurnIds, "droppedTurnIds");
    const expectedRetainedTurnId = String(expectation?.retainedTurnId ?? "").trim() || null;
    if (expectedDroppedTurnIds.length !== n) {
      throw new Error(`Codex 回滚映射数量不一致：numTurns=${n}, mappedTurns=${expectedDroppedTurnIds.length}`);
    }
    const sessionId = this.sessionId;
    this.historyRollbackInProgress = true;
    let recoveryConfirmed = false;
    try {
      const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
      await ws.ensureStarted();
      (await this.withDatabase(() => this.assertNewOperationCredential()));

      if (!this.registered) {
        this.unregister = ws.registerThread(sessionId, (msg) => this.onAppServerMessage(msg));
        this.registered = true;
      }
      // resume ACK 不能单独证明 binding 可复用；每次回滚准备都必须读取同一
      // provider thread，并以 idle 快照作为唯一恢复确认。
      this.beginRecoveryAttempt(sessionId);
      await ws.request("thread/resume", await this.withDatabase(() => this.buildCurrentCodexResumeParams(sessionId)), CODEX_RECOVERY_REQUEST_OPTIONS);
      (await this.withDatabase(() => this.assertNewOperationCredential()));

      const providerAdmission = this.captureProviderInputAdmission(sessionId, null);
      const goalStatus = await this.readProviderThreadGoalStatus(ws, sessionId);
      (await this.withDatabase(() => this.assertNewOperationCredential()));
      providerAdmission.foreignGoalStatus = goalStatus && goalStatus !== "complete" ? goalStatus : null;
      const mutationContext: CodexProviderMutationContext = {
        operation: "rollback",
        clientTurnId: null,
        clientUserMessageId: null,
      };
      this.assertProviderMutationAdmissionAvailable(providerAdmission, mutationContext);
      const beforeRead = await ws.request(
        "thread/read",
        { threadId: sessionId, includeTurns: true },
        CODEX_STATE_READ_OPTIONS,
      );
      const before = parseCodexRollbackThreadSnapshot(beforeRead, sessionId);
      (await this.withDatabase(() => this.assertNewOperationCredential()));
      const beforeThread = (beforeRead as any)?.thread ?? null;
      if (!this.confirmIdleRecovery(
        sessionId,
        String(beforeThread?.id ?? "").trim(),
        normalizeCodexTurnStatus(beforeThread?.status),
      )) {
        throw new Error("thread/read 恢复确认期间 provider binding 已变化");
      }
      recoveryConfirmed = true;
      this.assertProviderMutationAdmissionCurrent(providerAdmission, mutationContext);
      const aligned = reconcileCodexRollbackProviderTail({
        providerTurnIds: before.turnIds,
        expectedDroppedTurnIds,
        expectedRetainedTurnId,
      });
      if (aligned.phantomTurnIds.length > 0) {
        this.log("warn", () => ({ message: "rollback provider tail reconciled non-materialized mappings", data: {
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId,
          expectedProviderTurnCount: n,
          actualProviderTurnCount: aligned.droppedTurnIds.length,
          expectedDroppedTurnIds,
          actualDroppedTurnIds: aligned.droppedTurnIds,
          phantomTurnIds: aligned.phantomTurnIds,
          retainedTurnId: expectedRetainedTurnId,
        } }));
      }

      const prepared: CodexPreparedRollbackHistory = {
        sessionId,
        numTurns: aligned.droppedTurnIds.length,
        providerLifecycleEventVersion: providerAdmission.lifecycleEventVersion,
        beforeTurnIds: [...before.turnIds],
        afterTurnIds: [...aligned.afterTurnIds],
        droppedTurnIds: [...aligned.droppedTurnIds],
        retainedTurnId: expectedRetainedTurnId,
      };
      this.preparedHistoryRollback = prepared;
      return prepared;
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      // read/解析失败时绝不能沿用旧 ACK；若本轮尚未得到 idle 证据，继续保留
      // recovery fence，避免下一次 mutation 或 idle cleanup 越过未确认 binding。
      this.resumed = false;
      if (!recoveryConfirmed) this.recoveryPending = true;
      this.historyRollbackInProgress = false;
      throw cause;
    }
  }

  /** 二次确认 prepare 的 before 历史后执行 provider mutation，并确认精确 after。 */
  async applyPreparedRollbackHistory(prepared: CodexPreparedRollbackHistory): Promise<void> {
    this.assertProviderInputImagesReleased();
    if (!this.historyRollbackInProgress || this.preparedHistoryRollback !== prepared) {
      throw new Error("Codex 回滚 prepare 已失效");
    }
    const { sessionId, numTurns: n, beforeTurnIds, afterTurnIds } = prepared;
    let providerIdleConfirmed = false;
    try {
      (await this.withDatabase(() => this.assertNewOperationCredential()));
      const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
      const mutationContext: CodexProviderMutationContext = {
        operation: "rollback",
        clientTurnId: null,
        clientUserMessageId: null,
      };
      this.assertProviderMutationAdmissionCurrent({
        providerThreadId: sessionId,
        lifecycleEventVersion: prepared.providerLifecycleEventVersion,
        foreignActiveTurnId: null,
        foreignGoalStatus: null,
      }, mutationContext);
      const providerAdmission = this.captureProviderInputAdmission(sessionId, null);
      const goalStatus = await this.readProviderThreadGoalStatus(ws, sessionId);
      (await this.withDatabase(() => this.assertNewOperationCredential()));
      providerAdmission.foreignGoalStatus = goalStatus && goalStatus !== "complete" ? goalStatus : null;
      this.assertProviderMutationAdmissionAvailable(providerAdmission, mutationContext);
      const latestRead = await ws.request(
        "thread/read",
        { threadId: sessionId, includeTurns: true },
        CODEX_STATE_READ_OPTIONS,
      );
      const latest = parseCodexRollbackThreadSnapshot(latestRead, sessionId);
      (await this.withDatabase(() => this.assertNewOperationCredential()));
      const latestThread = (latestRead as any)?.thread ?? null;
      if (!this.confirmIdleRecovery(
        sessionId,
        String(latestThread?.id ?? "").trim(),
        normalizeCodexTurnStatus(latestThread?.status),
      )) {
        throw new Error("thread/read 回滚提交前未确认同一 idle provider binding");
      }
      providerIdleConfirmed = true;
      this.assertProviderMutationAdmissionCurrent(providerAdmission, mutationContext);
      if (!codexTurnIdListsEqual(latest.turnIds, beforeTurnIds)) {
        throw new Error(
          `provider 历史在回滚提交前发生变化：expected=${formatCodexTurnIds(beforeTurnIds)}, actual=${formatCodexTurnIds(latest.turnIds)}`,
        );
      }
      if (n === 0) {
        if (!codexTurnIdListsEqual(latest.turnIds, afterTurnIds)) {
          throw new Error(
            `provider 无需回滚但目标历史不一致：expected=${formatCodexTurnIds(afterTurnIds)}, actual=${formatCodexTurnIds(latest.turnIds)}`,
          );
        }
        return;
      }

      try {
        // 从这里开始 mutation 结果可能未知；任何后续 read 失败都必须阻止
        // 下一次输入直接复用旧 ACK。
        await ws.request("thread/rollback", { threadId: sessionId, numTurns: n }, { timeoutMs: 20_000 });
        (await this.withDatabase(() => this.assertNewOperationCredential()));
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        if (isCodexRollbackUnsupportedError(cause)) {
          throw buildCodexRollbackUnsupportedError(sessionId, n, cause);
        }
        throw buildCodexRollbackMutationUnknownError(sessionId, n, afterTurnIds, null, cause);
      }

      let lastCause: unknown = new Error("thread/read 尚未确认回滚结果");
      let actualTurnIds: string[] | null = null;
      for (let attempt = 0; attempt < CODEX_ROLLBACK_RECONCILE_MAX_ATTEMPTS; attempt += 1) {
        (await this.withDatabase(() => this.assertNewOperationCredential()));
        try {
          const afterRead = await ws.request(
            "thread/read",
            { threadId: sessionId, includeTurns: true },
            CODEX_STATE_READ_OPTIONS,
          );
          const after = parseCodexRollbackThreadSnapshot(afterRead, sessionId);
          actualTurnIds = after.turnIds;
          if (!codexTurnIdListsEqual(actualTurnIds, afterTurnIds)) {
            throw new Error(
              `provider 历史未按预期裁剪：expected=${formatCodexTurnIds(afterTurnIds)}, actual=${formatCodexTurnIds(actualTurnIds)}`,
            );
          }
          return;
        } catch (cause) {
          if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
          lastCause = cause;
        }
        if (attempt + 1 < CODEX_ROLLBACK_RECONCILE_MAX_ATTEMPTS) {
          await waitForCodexRollbackReconcileRetry(attempt);
        }
      }

      throw buildCodexRollbackMutationUnknownError(sessionId, n, afterTurnIds, actualTurnIds, lastCause);
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      this.resumed = false;
      // 只有在 provider idle 已被确认且尚未发出 mutation 时，才可安全释放
      // 本轮 fence；其余情况必须等待下一次显式 resume -> read。
      if (!providerIdleConfirmed || (cause as any)?.code !== "codex_thread_rollback_unsupported") {
        this.recoveryPending = true;
      }
      throw cause;
    } finally {
      this.preparedHistoryRollback = null;
      this.historyRollbackInProgress = false;
    }
  }

  /** 文件阶段未能提交时释放尚未 apply 的 provider 回滚锁。 */
  cancelPreparedRollbackHistory(prepared: CodexPreparedRollbackHistory): void {
    if (this.preparedHistoryRollback !== prepared) return;
    this.preparedHistoryRollback = null;
    this.historyRollbackInProgress = false;
  }

  /** 只读返回当前 provider 历史，用于重启后的未决回滚核对。 */
  async readRollbackHistoryTurnIds(): Promise<string[]> {
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    (await this.withDatabase(() => this.retryPendingSessionBindingDrop()));
    if (this.active || this.startingTurn || this.historyRollbackInProgress || this.hasPendingProviderMutationFence()) {
      throw new Error("当前 thread 有未完成的 turn");
    }
    if (!this.sessionId) throw new Error("Codex sessionId 缺失，无法核对回滚");
    const sessionId = this.sessionId;
    this.historyRollbackInProgress = true;
    let recoveryConfirmed = false;
    try {
      const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
      await ws.ensureStarted();
      (await this.withDatabase(() => this.assertNewOperationCredential()));
      if (!this.registered) {
        this.unregister = ws.registerThread(sessionId, (msg) => this.onAppServerMessage(msg));
        this.registered = true;
      }
      // 只接受同 ID 的 idle read；resume ACK 本身不更新 resumed。
      this.beginRecoveryAttempt(sessionId);
      await ws.request("thread/resume", await this.withDatabase(() => this.buildCurrentCodexResumeParams(sessionId)), CODEX_RECOVERY_REQUEST_OPTIONS);
      (await this.withDatabase(() => this.assertNewOperationCredential()));
      const read = await ws.request("thread/read", { threadId: sessionId, includeTurns: true }, CODEX_STATE_READ_OPTIONS);
      (await this.withDatabase(() => this.assertNewOperationCredential()));
      const snapshot = parseCodexRollbackThreadSnapshot(read, sessionId);
      const providerThread = (read as any)?.thread ?? null;
      if (!this.confirmIdleRecovery(
        sessionId,
        String(providerThread?.id ?? "").trim(),
        normalizeCodexTurnStatus(providerThread?.status),
      )) {
        throw new Error("thread/read 恢复确认期间 provider binding 已变化");
      }
      recoveryConfirmed = true;
      return [...snapshot.turnIds];
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      this.resumed = false;
      if (!recoveryConfirmed) this.recoveryPending = true;
      throw cause;
    } finally {
      this.historyRollbackInProgress = false;
    }
  }

  /** 先登记 StartingTurn，再启动 provider 回合并等待唯一权威终态。 */
  async sendMessage(input: SendMessageInput, emitters: ThreadEventEmitters): Promise<{ responseText: string }> {
    this.assertProviderInputImagesReleased();
    if (this.credentialCallPending) throw new Error("当前 thread 有未完成的回合输出保存");
    if (this.credentialLease) throw new Error('当前 thread 有未完成的凭据回合');
    let settlePreparation!: () => void;
    this.credentialCallPending = { turnId: input.turnId, phase: "running", preparing: true, settled: new Promise(resolve => { settlePreparation = resolve; }) };
    try {
      this.credentialLease = await this.withDatabase(() => this.opts.acquireCredential?.({ model: input.model, turnId: input.turnId }));
      this.credentialCallPending.preparing = false;
      if (this.credentialCallPending.phase !== "running") throw createManualInterruptError();
      return await withThreadEventFlush(emitters, () => this.sendMessageWithCredential(input, emitters));
    }
    catch (error) {
      if (error instanceof ThreadEventFlushError) { this.credentialCallPending.failure = error; this.credentialCallPending.phase = "failed"; }
      throw error;
    } finally {
      if (!this.credentialCallPending?.failure) this.credentialCallPending = null;
      try { this.releaseSettledCredential(); } finally { settlePreparation(); }
    }
  }

  /** 凭据准入成功后沿原 starting/active turn 生命周期派发。 */
  private async sendMessageWithCredential(input: SendMessageInput, emitters: ThreadEventEmitters): Promise<{ responseText: string }> {
    if (this.disposed) throw createManualInterruptError();
    (await this.withDatabase(() => this.opts.assertMutationAllowed?.()));
    (await this.withDatabase(() => this.retryPendingSessionBindingDrop()));
    const prepared = input.preparedInputActions ?? null;
    let startingTurn: StartingTurn;
    if (prepared) {
      const reserved = this.startingTurn;
      if (
        this.active
        || this.historyRollbackInProgress
        || !reserved
        || reserved.preparedInputActions !== prepared
        || reserved.preparedInputActionsConsumed
        || prepared.turnId !== input.turnId
        || prepared.userItemId !== input.userItemId
        || reserved.clientTurnId !== input.turnId
        || reserved.clientUserMessageId !== String(input.userItemId)
      ) {
        throw createCodexSkillBindingError("Codex Skill reservation 与当前发送不匹配");
      }
      reserved.preparedInputActionsConsumed = true;
      startingTurn = reserved;
    } else {
      if (this.active || this.startingTurn || this.historyRollbackInProgress) {
        throw new Error("当前 thread 有未完成的 turn");
      }
      startingTurn = createStartingTurn(input.turnId, String(input.userItemId));
      this.startingTurn = startingTurn;
    }
    let preserveStartingTurn = false;
    try {
      return await this.sendMessageAfterStartRegistration(input, emitters, startingTurn);
    } catch (error) {
      if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
      if (this.disposed && !isCodexImageCleanupError(error)) {
        const status = this.getObservedTurnTerminalStatus(input.turnId);
        if (status === "completed") {
          this.log("warn", () => ({ message: "completed turn cleanup stopped after process termination", data: {
            code: "codex_completed_turn_cleanup_stopped",
            requestId: String(engineDiagnosticField(error, "requestId") ?? "").trim() || null,
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            clientTurnId: input.turnId,
            rootCause: engineDiagnosticCause(error),
          } }), { reason: error });
          return { responseText: this.responseText };
        }
        if (!status) throw createManualInterruptError();
      }
      if (this.startingTurn === startingTurn) {
        const providerError = isCodexImageCleanupError(error) && error instanceof AggregateError ? error.cause : error;
        // ownership 冲突已经切断 provider generation；后续迟到 timeout 不能覆盖真实冲突原因。
        const ownershipConflict = startingTurn.providerOwnershipConflict;
        startingTurn.startError = ownershipConflict ?? providerError;
        if (
          startingTurn.startRequestSent
          && !isExplicitCodexTurnStartRejection(startingTurn.startError)
        ) {
          preserveStartingTurn = true;
          if (startingTurn.startError instanceof Error) {
            (startingTurn.startError as Error & { preserveRunningState?: boolean }).preserveRunningState = true;
          }
        }
        const uncertainTurnStart = isUncertainTurnStartError(providerError, startingTurn);
        if (uncertainTurnStart) {
          this.trackStartingTurnLateSettlement(startingTurn, extractCodexLateSettlement(providerError));
          const releaseLateSettlement = extractCodexLateSettlementRelease(providerError);
          if (!startingTurn.lateSettlementReleased) {
            startingTurn.releaseLateSettlement = releaseLateSettlement;
          }
        }
        startingTurn.settle();

        if (uncertainTurnStart) {
          startingTurn.reconcileRequested = true;
          if (startingTurn.interruptRequested) {
            startingTurn.interruptPromise ??= this.interruptStartingTurn(startingTurn);
            const interruptPromise = startingTurn.interruptPromise;
            try {
              await this.awaitStartingTurnInterruptOutcome(startingTurn, interruptPromise);
            } catch (cause) {
              if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
              if (this.startingTurn === startingTurn && Boolean((cause as any)?.preserveRunningState)) {
                preserveStartingTurn = true;
              }
              if (this.startingTurn === startingTurn && startingTurn.interruptPromise === interruptPromise) {
                startingTurn.interruptPromise = null;
              }
              throw cause;
            }
            throw createManualInterruptError();
          }
          preserveStartingTurn = this.startingTurn === startingTurn;
          throw buildCodexStartInterruptReconcileError(
            startingTurn.providerThreadId ?? this.sessionId ?? this.opts.threadId,
            startingTurn.clientTurnId,
            startingTurn.providerLifecycleTurnId ?? startingTurn.providerTurnId,
            error,
          );
        }

        if (startingTurn.interruptRequested && startingTurn.interruptPromise) {
          try {
            await this.awaitStartingTurnInterruptOutcome(startingTurn, startingTurn.interruptPromise);
          } catch (cause) {
            if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
            if (this.startingTurn === startingTurn && Boolean((cause as any)?.preserveRunningState)) {
              preserveStartingTurn = true;
            }
            throw cause;
          }
          throw createManualInterruptError();
        }
      }
      throw error;
    } finally {
      if (!preserveStartingTurn) {
        const startupIncomplete = this.startingTurn === startingTurn;
        this.finishStartingTurn(startingTurn);
        if (startupIncomplete) {
          this.assistantLifecycle.retireTurn(input.turnId);
          this.retireCodexTurn(input.turnId);
        }
      }
    }
  }

  /** 登记启动态后按所选模型及最大窗口启动 provider，首个 await 起即可中断。 */
  private async sendMessageAfterStartRegistration(
    input: SendMessageInput,
    emitters: ThreadEventEmitters,
    startingTurn: StartingTurn,
  ): Promise<{ responseText: string }> {
    this.emitters = emitters;
    const emitConversation = emitters.conversation;
    const emitRaw = emitters.raw;
    this.responseText = "";
    this.assistantLifecycle.startTurn(input.turnId);
    this.currentProviderNativeToolPolicy = input.providerNativeToolPolicy ?? "allow";
    const todolistTextState = { text: "" };
    const todolistSeenState = { seen: false };
    const todolistToolCompletedState = { completed: false };

    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    await this.awaitStartingTurnPreflight(startingTurn, ws.ensureStarted());
    this.credentialLease?.assertCurrent();
    await this.awaitStartingTurnPreflight(
      startingTurn,
      ensureCodexRequiredWorkspaceSkills({
        requester: ws,
        workspacePath: this.opts.workspacePath,
        requirements: input.requiredWorkspaceSkills,
      }),
    );
    if (startingTurn.interruptRequested) throw createManualInterruptError();
    const setup = await (async () => {
      const dispatchLease = await acquireEngineModelCatalogDispatchLease({ engine: "codex", model: input.model });
      try {
        assertRuntimeEngineModelAvailable("codex", input.model);
        const modelProvider = this.resolveCurrentCodexModelProvider();
        const accessMode = input.accessMode ?? "current";
        const threadConfigContextWindow = resolveRuntimeThreadPrefsWithCatalogDefaults("codex", { model: input.model }).contextWindow;
        const autoCompactPct = normalizeAutoCompactPct(input.autoCompactPct);
        const threadConfigOverrides = resolveCodexThreadConfigOverrides({
          contextWindow: threadConfigContextWindow,
          autoCompactPct,
        });
        const requestedDynamicToolIds = listExecutableToolIds(input.toolRegistry ?? null);
        const platformToolTransportRequirement = input.platformToolTransportRequirement ?? "optional";
        const nativeDynamicToolTransport = (await this.withDatabase(() => this.resolvePlatformToolTransport(
          input.toolRegistry ?? null,
          platformToolTransportRequirement,
        ))) === "native-dynamic";
        const dynamicTools = nativeDynamicToolTransport
          ? buildCodexDynamicToolSpecs(input.toolRegistry ?? null)
          : [];
        const dynamicToolBindingVersion = dynamicTools.length
          ? buildCodexDynamicToolBindingVersion(input.toolRegistry ?? null)
          : null;
        const sessionCapabilities = dynamicTools.length
          ? ({
              codexDynamicToolIds: requestedDynamicToolIds,
              codexDynamicToolBindingVersion: dynamicToolBindingVersion,
            } satisfies ThreadSessionCapabilities)
          : null;
        const developerInstructions = mergePromptBlocks([
          input.systemMessage ?? null,
          input.developerMessage ?? null,
          this.listAppliedDynamicToolIds().some(toolId => !requestedDynamicToolIds.includes(toolId))
            ? nativeDynamicToolTransport && requestedDynamicToolIds.length
              ? `本轮启用的平台工具：${requestedDynamicToolIds.join("、")}。历史注册中未列出的平台工具本轮已停用，不得调用。`
              : "本轮未启用平台工具，不得调用历史注册中已停用的平台工具。"
            : null,
          buildCodexDeveloperInstructions({
            accessMode,
            providerNativeToolPolicy: input.providerNativeToolPolicy ?? "allow",
            responseFormat: input.responseFormat ?? "text",
          }),
        ]);
        const ensureInfo = await this.awaitStartingThreadSession(
          startingTurn,
          this.ensureThreadSession(
            ws, emitConversation, accessMode, threadConfigContextWindow, autoCompactPct,
            modelProvider, input.model ?? null, developerInstructions, threadConfigOverrides,
            dynamicTools, requestedDynamicToolIds, dynamicToolBindingVersion, sessionCapabilities,
            platformToolTransportRequirement, startingTurn, "turn_start",
          ),
        );
        return {
          catalogDispatchIdentity: {
            configVersion: dispatchLease.configVersion,
            digest: dispatchLease.digest,
          },
          accessMode,
          threadConfigContextWindow,
          autoCompactPct,
          modelProvider,
          dynamicTools,
          developerInstructions,
          ensureInfo,
          nativeDynamicToolTransport,
          requestedDynamicToolIds,
          sessionCapabilities,
        };
      } finally {
        dispatchLease.release();
      }
    })();
    const {
      catalogDispatchIdentity,
      accessMode,
      threadConfigContextWindow,
      autoCompactPct,
      modelProvider,
      dynamicTools,
      developerInstructions,
      ensureInfo,
      nativeDynamicToolTransport,
      requestedDynamicToolIds,
      sessionCapabilities,
    } = setup;

    // 作为防御保留：如果 sessionId 意外为 null，也标记为失效。
    if (!this.sessionId) {
      throw buildCodexProviderThreadRecoveryError({
        code: "codex_thread_resume_unconfirmed",
        providerThreadId: null,
        reason: "missing_binding_after_thread_setup",
        message: "Codex 会话 binding 在启动后缺失，未发送输入。",
      });
    }

    // 普通发送直接遵循 app-server 生命周期：thread/start|resume -> turn/start -> turn/* events。
    // provider 自身是 active-turn 的权威仲裁者；这里不再用 goal/read/list 做发送前猜测，
    // 否则每轮历史会话都会增加多次 RPC，并把 ACK 乱序放大成准入失败。
    startingTurn.providerObservedTurnId = null;

    const preparedImages = prepareCodexImagesForTurn(input.images, {
      writeWorkspaceLog: this.opts.writeWorkspaceLog,
      workspacePath: this.opts.workspacePath,
      workspaceId: String(this.opts.workspaceId),
      threadId: String(this.opts.threadId),
      clientTurnId: String(input.turnId),
      operation: "turn/start",
    });
    const imageLease = this.createProviderInputImageLease(preparedImages, input.turnId);
    let operationFailed = false, operationError: unknown;
    try {
      const startTurn = async (): Promise<unknown> => {
        const dispatchLease = await acquireEngineModelCatalogDispatchLease({ engine: "codex", model: input.model });
        try {
          assertEngineModelCatalogDispatchLeaseCurrent(catalogDispatchIdentity, dispatchLease);
          assertRuntimeEngineModelAvailable("codex", input.model);
          if (startingTurn.interruptRequested) throw createManualInterruptError();
          const preparedInputActions = input.preparedInputActions ?? null;
          if (preparedInputActions) {
            this.assertPreparedInputGeneration(startingTurn, preparedInputActions, ws);
          }
        // Codex app-server 的 collaboration mode 可能“粘住”（线程级状态）：
        // - 仅在 plan=true 时发送 {mode:"plan"}，关掉时只是不传，很可能不会切回 default。
        // - 因此这里明确发送 default/plan 两种模式，保证“关计划”真的生效。
        const collaborationSettings: Record<string, unknown> = {
          ...(input.model != null ? { model: input.model } : {}),
          ...(input.effort != null ? { reasoning_effort: input.effort } : {}),
        };
        const collaborationMode = {
          mode: input.planMode ? "plan" : "default",
          settings: collaborationSettings,
        };
        const params = {
          ...buildTurnStartParams({
            threadId: this.sessionId!,
            cwd: this.opts.workspacePath,
            text: String(input.userMessage ?? input.text ?? ""),
            images: preparedImages.images,
            skillInputs: preparedInputActions?.skills,
            accessMode,
            model: input.model,
            effort: input.effort,
            serviceTier: input.serviceTier ?? null,
            collaborationMode,
          }),
          clientUserMessageId: startingTurn.clientUserMessageId,
        };
        const requests: Array<{ method: string; params?: unknown }> = [];
        if (ensureInfo.didThreadStart) {
          requests.push({
            method: "thread/start",
            params: buildThreadStartRequestParams({
              cwd: this.opts.workspacePath,
              accessMode,
              contextWindow: threadConfigContextWindow,
              autoCompactPct,
              modelProvider,
              dynamicTools,
              developerInstructions,
            }),
          });
        }
        if (ensureInfo.didThreadResume) {
          requests.push({
            method: "thread/resume",
            params: buildThreadResumeRequestParams({
              threadId: this.sessionId!,
              cwd: this.opts.workspacePath,
              accessMode,
              contextWindow: threadConfigContextWindow,
              autoCompactPct,
              modelProvider,
              developerInstructions,
            }),
          });
        }
        requests.push({
          method: "turn/start",
          params: preparedInputActions
            ? buildCodexTurnStartTraceParams(params, preparedInputActions)
            : params,
        });

        const call: EngineCallTrace = { kind: "jsonrpc", engine: "codex", transport: "codex-app-server", cwd: this.opts.workspacePath, requests };
        emitConversation({
          ts: Date.now(),
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId as any,
          engine: "codex",
          type: "item.userMessage.engineCall.created",
          payload: { itemId: input.userItemId, call },
        } satisfies ConversationEventInput);

        this.credentialLease?.assertCurrent();
        this.assertProviderInputImagesReleased();
        startingTurn.providerThreadId = this.sessionId;
        startingTurn.startRequestSent = true;
        startingTurn.signalStartRequestDispatched();
        const request = ws.request("turn/start", params, {
          timeoutMs: 20_000,
          trackLateSettlement: true,
          ...(preparedInputActions
            ? { expectedProcessGeneration: preparedInputActions.processGeneration }
            : {}),
        });
          imageLease.trackRequest(request);
          return request;
        } finally {
          dispatchLease.release();
        }
      };

      const awaitStartTurn = async (): Promise<unknown> => {
        const attemptId = ++startingTurn.startRequestAttemptSequence;
        startingTurn.pendingStartRequestAttemptId = attemptId;
        startingTurn.providerStartedTurnKeys.clear();
        startingTurn.providerStartEvidenceTurnId = null;
        startingTurn.providerStartEvidenceAttemptId = null;
        let request: Promise<unknown>;
        try {
          request = startTurn();
        } catch (error) {
          if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
          if (startingTurn.pendingStartRequestAttemptId === attemptId) {
            startingTurn.pendingStartRequestAttemptId = null;
          }
          throw error;
        }
        const processedRequest = request.then(
          async (result) => {
            if (
              this.disposed
              || startingTurn.providerOwnershipConflict
              || !this.isCurrentStartRequestAttempt(startingTurn, attemptId)
            ) {
              this.log("info", () => ({ message: "turn/start settlement ignored after ownership fence", data: {
                code: "codex_turn_start_settlement_ownership_fenced",
                workspaceId: this.opts.workspaceId,
                threadId: this.opts.threadId,
                clientTurnId: startingTurn.clientTurnId,
                attemptId,
                currentAttemptId: startingTurn.startRequestAttemptSequence,
                outcome: "fulfilled",
                ownershipConflict: Boolean(startingTurn.providerOwnershipConflict),
              } }));
              return result;
            }
            if (startingTurn.pendingStartRequestAttemptId === attemptId) {
              const providerTurnId = extractTurnIdFromResult(result);
              if (providerTurnId) {
                (await this.withDatabase(() => this.persistCurrentStartAttempt(startingTurn, attemptId, providerTurnId)));
                startingTurn.providerTurnId = providerTurnId;
              }
              startingTurn.pendingStartRequestAttemptId = null;
              startingTurn.lastStartRequestAttemptId = attemptId;
            }
            return result;
          },
          (cause) => {
            if (
              this.disposed
              || startingTurn.providerOwnershipConflict
              || !this.isCurrentStartRequestAttempt(startingTurn, attemptId)
            ) {
              this.log("info", () => ({ message: "turn/start rejection ignored after ownership fence", data: {
                code: "codex_turn_start_rejection_ownership_fenced",
                workspaceId: this.opts.workspaceId,
                threadId: this.opts.threadId,
                clientTurnId: startingTurn.clientTurnId,
                attemptId,
                currentAttemptId: startingTurn.startRequestAttemptSequence,
                outcome: "rejected",
                ownershipConflict: Boolean(startingTurn.providerOwnershipConflict),
                error: engineDiagnosticCause(cause),
              } }), { reason: cause });
              throw cause;
            }
            if (startingTurn.pendingStartRequestAttemptId === attemptId) {
              startingTurn.pendingStartRequestAttemptId = null;
              startingTurn.lastStartRequestAttemptId = attemptId;
            }
            throw cause;
          },
        );
        (await this.withDatabase(() => this.trackStartupInterruptedTurnStartSettlement(startingTurn, processedRequest, attemptId)));
        return await Promise.race([
          processedRequest,
          startingTurn.startupInterruptAcknowledgedSignal.then(() => {
            throw createManualInterruptError();
          }),
        ]);
      };

      let result: unknown;
      try {
        result = await awaitStartTurn();
      } catch (e) {
        if (isEngineWorkspaceLogFailure(e)) throw this.retainDiagnosticFailure(e);
        // turn/start 是非幂等 mutation；失败后只恢复下一次重试的 resume 门禁，绝不自动重投输入。
        const msg = e instanceof Error ? e.message : String(e);
        if (nativeDynamicToolTransport && requestedDynamicToolIds.length && isCodexDynamicToolTransportRejectedError(msg)) {
          (await this.withDatabase(() => this.clearSessionCapabilities()));
          throw e;
        }
        if (this.sessionId && hasCodexThreadUnavailableSignal(msg)) {
          this.beginRecoveryAttempt(this.sessionId);
        }
        throw e;
      }
      if (nativeDynamicToolTransport && sessionCapabilities) {
        try {
          (await this.withDatabase(() => this.confirmSessionBinding(sessionCapabilities)));
        } catch (cause) {
          if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
          const persistenceError = cause instanceof Error ? cause : new Error(String(cause));
          const providerTurnId = extractTurnIdFromResult(result)
            ?? startingTurn.providerTurnId
            ?? startingTurn.providerLifecycleTurnId
            ?? "";
          const finalError = this.failStartingTurnBindingPersistence(
            startingTurn,
            providerTurnId,
            persistenceError,
          );
          this.handledCodexBindingPersistenceErrors.add(persistenceError);
          this.handledCodexBindingPersistenceErrors.add(finalError);
          this.log("error", () => ({ message: "dynamic tool capability binding persistence failed after turn start", data: {
            code: "codex_dynamic_tool_capability_binding_persistence_failed",
            requestId: String(engineDiagnosticField(persistenceError, "requestId") ?? "").trim() || null,
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            providerThreadId: startingTurn.providerThreadId ?? this.sessionId,
            clientTurnId: startingTurn.clientTurnId,
            providerTurnId: providerTurnId || null,
            rootCause: engineDiagnosticCause(persistenceError),
          } }), { reason: cause });
          throw finalError;
        }
      }
      const responseCodexTurnId = extractTurnIdFromResult(result);
      if (!responseCodexTurnId) {
        throw createCodexTurnStartMissingIdError();
      }
      // binding 持久化可能在 turn/start 在途期间失败；隔离后禁止迟到 response 覆盖旧 generation 证据。
      if (startingTurn.providerOwnershipConflict) {
        throw startingTurn.providerOwnershipConflict;
      }
      startingTurn.providerTurnId = responseCodexTurnId;
      if (this.startingTurn !== startingTurn) {
        const handoffError = startingTurn.interruptRequested
          ? createManualInterruptError()
          : Object.assign(new Error(
            `Codex startup handoff 已失效：threadId=${this.opts.threadId}, clientTurnId=${startingTurn.clientTurnId}`,
          ), {
            code: "codex_start_handoff_lost",
            preserveRunningState: false,
          });
        throw handoffError;
      }
      if (startingTurn.providerThreadId && this.sessionId !== startingTurn.providerThreadId) {
        throw Object.assign(new Error(
          `Codex startup provider generation 已变化：threadId=${this.opts.threadId}, clientTurnId=${startingTurn.clientTurnId}, expectedSessionId=${startingTurn.providerThreadId}, actualSessionId=${this.sessionId ?? "missing"}`,
        ), {
          code: "codex_start_generation_changed",
          preserveRunningState: false,
        });
      }
      this.bindCodexTurn(input.turnId, responseCodexTurnId);
      const codexTurnId = responseCodexTurnId;
      const timeoutPolicy = normalizeTurnTimeoutPolicy(input.timeoutPolicy, input.timeoutMs);

      let activeTurn!: ActiveTurn;
      const done = new Promise((resolve, reject) => {
        const timeoutController = new TurnTimeoutController({
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          engine: "codex",
          turnId: String(input.turnId),
          policy: timeoutPolicy,
          emitConversation,
          emitRaw,
          onTimeout: (error) => this.runDiagnosticCallback(() => {
            this.handleCodexTurnTimeout(ws, input.turnId, error);
          }),
        });
        activeTurn = {
          clientTurnId: input.turnId,
          clientUserMessageIds: new Set([startingTurn.clientUserMessageId]),
          providerInputImageReleases: new Set(),
          clientUserMessageSequenceById: new Map([[startingTurn.clientUserMessageId, 0]]),
          confirmedClientUserMessageSequence: 0,
          providerOwnershipStartingTurn: startingTurn,
          codexTurnId,
          provisionalCodexTurnId: null,
          codexTurnBindingSource: "start_result",
          responseFormat: input.responseFormat ?? "text",
          accessMode,
          toolRegistry: input.toolRegistry ?? null,
          executeHostTool: input.executeHostTool ?? null,
          sharedWorkspaceToolContext: input.sharedWorkspaceToolContext ?? null,
          platformToolFailureCounts: new Map(),
          timeoutController,
          todolistTextState,
          todolistSeenState,
          todolistToolCompletedState,
          manualInterruptRequested: false,
          manualInterruptError: null,
          interruptPromise: null,
          interruptTerminalError: null,
          pendingEngineIdleTimeoutError: null,
          idleTimeoutReconcilePromise: null,
          providerTerminalStatus: null,
          lastNonRetryableTurnError: null,
          compactStartState: null,
          resolve,
          reject,
        };
        this.active = activeTurn;
        timeoutController.start();
      });
      if (startingTurn.interruptRequested && this.active?.clientTurnId === startingTurn.clientTurnId) {
        this.active.manualInterruptRequested = true;
        this.active.manualInterruptError = createManualInterruptError();
      }
      const handoffTerminalEvidenceSeen = startingTurn.terminalThreadHintSeen
        || startingTurn.terminalHintProviderTurnIds.has(responseCodexTurnId);
      if (handoffTerminalEvidenceSeen) {
        this.pendingHandoffStartingTurn = startingTurn;
        const reconcile = this.reconcileStartingTurnHandoffTerminalState(ws, {
          startingTurn,
          sessionId: startingTurn.providerThreadId ?? this.sessionId!,
          responseProviderTurnId: responseCodexTurnId,
          reason: "turn.terminal-before-active-handoff",
        }).finally(() => {
          if (this.pendingHandoffStartingTurn === startingTurn) this.pendingHandoffStartingTurn = null;
        });
        startingTurn.handoffTerminalReconcile = reconcile;
        this.observeDiagnosticTask(() => (reconcile.catch((error) => {
          const reconcileError = error instanceof Error ? error : new Error(String(error));
          const activeAtFailure = this.active?.providerOwnershipStartingTurn === startingTurn
            ? this.active
            : null;
          this.log("error", () => ({ message: "turn handoff terminal reconcile failed and was isolated", data: {
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            sessionId: startingTurn.providerThreadId ?? this.sessionId,
            clientTurnId: startingTurn.clientTurnId,
            responseProviderTurnId: responseCodexTurnId,
            activeStillOwned: Boolean(activeAtFailure),
            error: reconcileError.message,
          } }), { reason: error });
        })));
      }
      this.finishStartingTurn(startingTurn);

      const settled = done.finally(() => {
        this.releaseActiveProviderInputImages(activeTurn, "active_turn_settled");
        activeTurn.timeoutController.stop();
        if (this.active === activeTurn) {
          this.pendingRequests.clear();
          this.active = null;
          this.currentProviderNativeToolPolicy = "allow";
          this.clearReconnectRecovery();
          this.pendingCommandExecutionsByItemId.clear();
        }
        this.assistantLifecycle.retireTurn(input.turnId);
        this.retireCodexTurn(input.turnId);
        this.markPendingSteersInterrupted(activeTurn);
      }).then(value => {
        this.assertProviderInputImagesReleased();
        return value;
      }, error => {
        try { this.assertProviderInputImagesReleased(); }
        catch (cleanupError) { throw combineCodexImageCleanupError(error, cleanupError as Error); }
        throw error;
      });
      const activeTurnSettlement = settled.then(() => undefined, () => undefined);
      this.activeTurnSettled = activeTurnSettlement;
      try {
        await settled;
      } finally {
        if (this.activeTurnSettled === activeTurnSettlement) this.activeTurnSettled = null;
      }

      if (this.disposed) return { responseText: this.responseText };

      if (todolistSeenState.seen && !todolistToolCompletedState.completed) {
        // 兜底：只收到 item/plan/delta（原文）而未收到 turn/plan/updated（结构化）时，补一条 tool.completed，避免 Web 卡住。
        this.emitTodoListToolCompletedFallback({
          clientTurnId: input.turnId,
          engineTurnId: activeTurn.codexTurnId ?? responseCodexTurnId,
        });
      }

      if (todolistSeenState.seen) {
        // 当出现 todolist(update_plan) 更新时，原文可能只会出现在 thread 历史的 ThreadItem(type=plan).text 中（非增量通知）。
        const settledCodexTurnId = activeTurn.codexTurnId ?? this.codexTurnIdByClientTurnId.get(input.turnId) ?? null;
        if (settledCodexTurnId) {
          await this.tryHydrateTodoListTextFromThreadRead(ws, {
            clientTurnId: input.turnId,
            codexTurnId: settledCodexTurnId,
            state: todolistTextState,
          });
        }
      }
      const lastAssistantText = this.assistantLifecycle.latestText(input.turnId) ?? this.responseText;
      return { responseText: lastAssistantText };
    } catch (error) {
      operationFailed = true;
      operationError = error;
      throw error;
    } finally {
      imageLease.close("active_turn_settled");
      const cleanupError = imageLease.getError();
      if (cleanupError && (!operationFailed || !isCodexImageCleanupPending(cleanupError))) {
        throw operationFailed ? combineCodexImageCleanupError(operationError, cleanupError) : cleanupError;
      }
    }
  }

  /** 隔离 startup interrupt 后迟到的 turn/start 结果，避免其 provider turn 污染下一轮。 */
  private trackStartupInterruptedTurnStartSettlement(
    startingTurn: StartingTurn,
    request: Promise<unknown>,
    attemptId: number,
  ): void {
    this.observeDiagnosticTask(() => startingTurn.startupInterruptAcknowledgedSignal.then(() => {
      if (!this.isStartRequestAttemptPending(startingTurn, attemptId)) return;
      this.observeDiagnosticTask(() => (request.then(
        async (result) => {
          if (
            startingTurn.providerOwnershipConflict
            || !this.isCurrentStartRequestAttempt(startingTurn, attemptId)
          ) {
            this.log("info", () => ({ message: "stale turn/start settlement ignored after newer attempt", data: {
              code: "codex_stale_turn_start_settlement_ignored",
              workspaceId: this.opts.workspaceId,
              threadId: this.opts.threadId,
              clientTurnId: startingTurn.clientTurnId,
              attemptId,
              currentAttemptId: startingTurn.startRequestAttemptSequence,
              outcome: "fulfilled",
              ownershipConflict: Boolean(startingTurn.providerOwnershipConflict),
            } }));
            return;
          }
          const providerTurnId = extractTurnIdFromResult(result);
          if (providerTurnId) {
            try {
              (await this.withDatabase(() => this.persistCurrentStartAttempt(startingTurn, attemptId, providerTurnId)));
            } catch (cause) {
              if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
              this.log("error", () => ({ message: "late turn/start attempt persistence failed", data: {
                code: "codex_start_attempt_persistence_failed",
                workspaceId: this.opts.workspaceId,
                threadId: this.opts.threadId,
                providerThreadId: startingTurn.providerThreadId,
                clientTurnId: startingTurn.clientTurnId,
                providerTurnId,
                attemptId,
                error: engineDiagnosticCause(cause),
              } }), { reason: cause });
              return;
            }
            startingTurn.providerTurnId = providerTurnId;
            startingTurn.lastStartRequestAttemptId = attemptId;
            this.extendStartingTurnOwnershipRecoveryFromStartResponse(startingTurn, attemptId, providerTurnId);
          }
          this.restartStartingTurnOwnershipRecoveryAfterNewEvidence(startingTurn);
          this.log("info", () => ({ message: "turn/start settled after startup interrupt", data: {
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            sessionId: startingTurn.providerThreadId,
            clientTurnId: startingTurn.clientTurnId,
            providerTurnId,
            outcome: "fulfilled",
          } }));
        },
        (cause) => {
          const lateSettlement = extractCodexLateSettlement(cause);
          const releaseLateSettlement = extractCodexLateSettlementRelease(cause);
          const releaseTrackedLateSettlement = (): void => {
            this.releaseStartingTurnLateSettlement(startingTurn, releaseLateSettlement);
          };
          if (lateSettlement) {
            this.observeDiagnosticTask(() => (lateSettlement.then(
              async (settlement) => {
                if (
                  startingTurn.providerOwnershipConflict
                  || !this.isCurrentStartRequestAttempt(startingTurn, attemptId)
                ) {
                  this.log("info", () => ({ message: "stale late turn/start settlement ignored after newer attempt", data: {
                    code: "codex_stale_late_turn_start_settlement_ignored",
                    workspaceId: this.opts.workspaceId,
                    threadId: this.opts.threadId,
                    clientTurnId: startingTurn.clientTurnId,
                    attemptId,
                    currentAttemptId: startingTurn.startRequestAttemptSequence,
                    outcome: settlement.status,
                    ownershipConflict: Boolean(startingTurn.providerOwnershipConflict),
                  } }), { reason: cause });
                  releaseTrackedLateSettlement();
                  return;
                }
                const providerTurnId = settlement.status === "fulfilled"
                  ? extractTurnIdFromResult(settlement.value)
                  : null;
                if (providerTurnId) {
                  try {
                    (await this.withDatabase(() => this.persistCurrentStartAttempt(startingTurn, attemptId, providerTurnId)));
                  } catch (cause) {
                    if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
                    this.log("error", () => ({ message: "late settled turn/start attempt persistence failed", data: {
                      code: "codex_start_attempt_persistence_failed",
                      workspaceId: this.opts.workspaceId,
                      threadId: this.opts.threadId,
                      providerThreadId: startingTurn.providerThreadId,
                      clientTurnId: startingTurn.clientTurnId,
                      providerTurnId,
                      attemptId,
                      error: engineDiagnosticCause(cause),
                    } }), { reason: cause });
                    releaseTrackedLateSettlement();
                    return;
                  }
                  startingTurn.providerTurnId = providerTurnId;
                  startingTurn.lastStartRequestAttemptId = attemptId;
                  this.extendStartingTurnOwnershipRecoveryFromStartResponse(startingTurn, attemptId, providerTurnId);
                }
                if (settlement.status === "fulfilled") {
                  this.restartStartingTurnOwnershipRecoveryAfterNewEvidence(startingTurn);
                } else if (settlement.kind === "rpc_error") {
                  this.forgetInterruptedStartingTurn(startingTurn);
                } else {
                  this.restartStartingTurnOwnershipRecoveryAfterNewEvidence(startingTurn);
                }
                this.log("info", () => ({ message: "late turn/start settled after startup interrupt", data: {
                  workspaceId: this.opts.workspaceId,
                  threadId: this.opts.threadId,
                  sessionId: startingTurn.providerThreadId,
                  clientTurnId: startingTurn.clientTurnId,
                  providerTurnId,
                  outcome: settlement.status,
                  error: settlement.status === "rejected"
                    ? (engineDiagnosticCause(settlement.reason))
                    : null,
                } }), { reason: cause });
                releaseTrackedLateSettlement();
              },
              (lateCause) => {
                this.log("error", () => ({ message: "late turn/start tracking failed after startup interrupt", data: {
                  workspaceId: this.opts.workspaceId,
                  threadId: this.opts.threadId,
                  sessionId: startingTurn.providerThreadId,
                  clientTurnId: startingTurn.clientTurnId,
                  error: engineDiagnosticCause(lateCause),
                } }), { reason: lateCause });
                releaseTrackedLateSettlement();
              },
            )));
          } else {
            if (
              startingTurn.providerOwnershipConflict
              || !this.isCurrentStartRequestAttempt(startingTurn, attemptId)
            ) {
              this.log("info", () => ({ message: "stale turn/start rejection ignored after newer attempt", data: {
                code: "codex_stale_turn_start_rejection_ignored",
                workspaceId: this.opts.workspaceId,
                threadId: this.opts.threadId,
                clientTurnId: startingTurn.clientTurnId,
                attemptId,
                currentAttemptId: startingTurn.startRequestAttemptSequence,
                outcome: "rejected",
                ownershipConflict: Boolean(startingTurn.providerOwnershipConflict),
              } }), { reason: cause });
              releaseTrackedLateSettlement();
              return;
            }
            if (isExplicitCodexTurnStartRejection(cause)) {
              this.forgetInterruptedStartingTurn(startingTurn);
            } else {
              this.restartStartingTurnOwnershipRecoveryAfterNewEvidence(startingTurn);
            }
            releaseTrackedLateSettlement();
          }
          this.log("info", () => ({ message: "turn/start rejected after startup interrupt", data: {
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            sessionId: startingTurn.providerThreadId,
            clientTurnId: startingTurn.clientTurnId,
            outcome: "rejected",
            error: engineDiagnosticCause(cause),
          } }), { reason: cause });
        },
      )));
    }));
  }

  /** 判断 turn/start 是否仍有当前 attempt 在途；指定 ID 时拒绝旧 attempt 借用新请求状态。 */
  private isStartRequestAttemptPending(startingTurn: StartingTurn, attemptId?: number): boolean {
    const pendingAttemptId = startingTurn.pendingStartRequestAttemptId;
    return pendingAttemptId != null && (attemptId == null || pendingAttemptId === attemptId);
  }

  /** 仅允许仍属于当前 StartingTurn 的 attempt 回写迟到结算，避免旧请求污染新重试。 */
  private isCurrentStartRequestAttempt(startingTurn: StartingTurn, attemptId: number): boolean {
    if (startingTurn.startRequestAttemptSequence !== attemptId) return false;
    return this.startingTurn === startingTurn
      || this.pendingHandoffStartingTurn === startingTurn
      || this.active?.providerOwnershipStartingTurn === startingTurn
      || this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn;
  }

  /**
   * turn/start fulfilled response 先同步耐久化，再发布到 StartingTurn 内存。
   * 快速停止后仍由 detached tombstone 精确追踪的 response 也必须落盘；旧 attempt 禁止覆盖。
   */
  private persistCurrentStartAttempt(
    startingTurn: StartingTurn,
    attemptId: number,
    providerTurnId: string,
  ): void {
    this.assertDiagnosticReady();
    const providerThreadId = startingTurn.providerThreadId;
    const normalizedProviderTurnId = String(providerTurnId ?? "").trim();
    const trackedDetachedStart = this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn;
    if (
      !providerThreadId
      || !normalizedProviderTurnId
      || startingTurn.providerOwnershipConflict
      || !this.isCurrentStartRequestAttempt(startingTurn, attemptId)
      || (this.sessionId !== providerThreadId && !trackedDetachedStart)
    ) {
      return;
    }
    if (
      startingTurn.persistedStartAttemptId === attemptId
      && startingTurn.persistedStartAttemptProviderTurnId === normalizedProviderTurnId
    ) {
      return;
    }
    try {
      this.opts.onStartAttempt({
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        clientTurnId: startingTurn.clientTurnId,
        clientUserMessageId: startingTurn.clientUserMessageId,
        providerThreadId,
        provisionalProviderTurnId: normalizedProviderTurnId,
        attemptId,
        observedAt: Date.now(),
      });
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const finalError = this.handleCodexBindingPersistenceFailure(
        startingTurn.clientTurnId,
        normalizedProviderTurnId,
        providerThreadId,
        error,
      );
      this.handledCodexBindingPersistenceErrors.add(error);
      this.handledCodexBindingPersistenceErrors.add(finalError);
      throw finalError;
    }
    startingTurn.persistedStartAttemptId = attemptId;
    startingTurn.persistedStartAttemptProviderTurnId = normalizedProviderTurnId;
  }

  /** 通过 Codex `turn/steer` 向当前 active turn 追加用户输入。 */
  async appendInput(input: AppendTurnInput): Promise<AppendTurnResult> {
    this.assertProviderInputImagesReleased();
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    if (this.disposed) throw createManualInterruptError();
    (await this.withDatabase(() => this.opts.assertMutationAllowed?.()));
    (await this.withDatabase(() => this.retryPendingSessionBindingDrop()));
    const startingTurn = this.startingTurn;
    if (startingTurn?.clientTurnId === input.turnId) {
      await startingTurn.settled;
      (await this.withDatabase(() => this.assertNewOperationCredential()));
      if (startingTurn.interruptRequested) throw createManualInterruptError();
    }
    const active = this.active;
    if (!active || active.clientTurnId !== input.turnId) throw new Error("当前 thread 没有可追加的 active turn");
    if (!this.sessionId) {
      throw buildCodexProviderThreadRecoveryError({
        code: "codex_thread_resume_unconfirmed",
        providerThreadId: null,
        reason: "missing_binding_before_append",
        message: "Codex 会话 binding 在追加输入前缺失，未发送输入。",
      });
    }
    if (!active.codexTurnId) throw new Error("Codex active turn 尚未绑定 provider turnId，无法追加输入");

    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    const providerThreadId = this.sessionId;
    await ws.ensureStarted();
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    if (this.disposed) throw createManualInterruptError();
    if (this.active !== active || this.sessionId !== providerThreadId) {
      throw new Error("Codex active turn 在追加输入前已变化");
    }
    if (active.manualInterruptRequested) throw createManualInterruptError();
    if (active.providerTerminalStatus) throw new Error("Codex active turn 已进入终态，无法追加输入");
    if (!active.codexTurnId) throw new Error("Codex active turn 尚未绑定 provider turnId，无法追加输入");

    const clientUserMessageId = String(input.userItemId);
    const correlationKey = buildCodexProviderClientCorrelationKey(providerThreadId, clientUserMessageId);
    if (this.pendingSteerCorrelationsByProviderClientKey.has(correlationKey)) {
      throw new Error(`Codex turn/steer clientUserMessageId 重复：${clientUserMessageId}`);
    }
    const preparedImages = prepareCodexImagesForTurn(input.images, {
      writeWorkspaceLog: this.opts.writeWorkspaceLog,
      workspacePath: this.opts.workspacePath,
      workspaceId: String(this.opts.workspaceId),
      threadId: String(this.opts.threadId),
      clientTurnId: String(input.turnId),
      operation: "turn/steer",
    });
    const imageLease = this.createProviderInputImageLease(preparedImages, input.turnId);
    const releaseImageLease = (reason: string): void => imageLease.close(reason);
    if (preparedImages.temporaryImageCount > 0) {
      this.registerActiveProviderInputImageRelease(active, releaseImageLease);
    }
    const sequence = this.registerActiveClientUserMessage(active, clientUserMessageId);
    const correlation: PendingSteerCorrelation = {
      clientTurnId: active.clientTurnId,
      clientUserMessageId,
      providerThreadId,
      sequence,
      state: "pending",
      provisionalProviderTurnId: null,
      confirmedProviderTurnId: null,
      providerObservedTurnId: null,
      ownershipRecoveryPromise: null,
      ownershipRecoveryTimer: null,
      ownershipRecoveryExhausted: false,
      ownershipRecoveryRescanRequested: false,
      ownershipRecoveryRetryAt: 0,
      ownershipRecoveryRetryDelayMs: 1_000,
      ownershipRecoveryExpiresAt: 0,
    };
    this.pendingSteerCorrelationsByProviderClientKey.set(correlationKey, correlation);
    try {
      const params = {
        ...buildTurnSteerParams({
          threadId: providerThreadId,
          expectedTurnId: active.codexTurnId,
          text: String(input.userMessage ?? input.text ?? ""),
          images: preparedImages.images,
        }),
        clientUserMessageId,
      };
      const call: EngineCallTrace = {
        kind: "jsonrpc",
        engine: "codex",
        transport: "codex-app-server",
        cwd: this.opts.workspacePath,
        requests: [{ method: "turn/steer", params }],
      };
      this.assertProviderInputImagesReleased();
      const request = ws.request("turn/steer", params, { timeoutMs: 20_000, trackLateSettlement: true });
      imageLease.trackRequest(request);
      const result = await request;
      const cleanupError = imageLease.getError();
      if (cleanupError && !isCodexImageCleanupPending(cleanupError)) throw cleanupError;
      if (this.disposed) throw createManualInterruptError();
      const responseCodexTurnId = extractTurnIdFromResult(result);
      if (correlation.state === "pending") correlation.state = "accepted";
      if (responseCodexTurnId && correlation.state === "accepted") {
        correlation.provisionalProviderTurnId = responseCodexTurnId;
        this.confirmSteerOwnership(correlation, responseCodexTurnId);
      }
      return { engineCall: call };
    } catch (error) {
      if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
      if (!isUncertainTurnSteerError(error)) {
        correlation.state = "failed";
        this.pendingSteerCorrelationsByProviderClientKey.delete(correlationKey);
        this.unregisterActiveClientUserMessage(active, clientUserMessageId);
        active.providerInputImageReleases?.delete(releaseImageLease);
        imageLease.close("turn_steer_rejected");
        const cleanupError = imageLease.getError();
        if (cleanupError && !isCodexImageCleanupPending(cleanupError)) throw combineCodexImageCleanupError(error, cleanupError);
      }
      throw error;
    }
  }

  /** 将 steer 图片释放权登记到当前 active turn，避免 provider ACK 后提前删图。 */
  private registerActiveProviderInputImageRelease(active: ActiveTurn, release: (reason: string) => void): void {
    (active.providerInputImageReleases ??= new Set()).add(release);
  }

  /** 在 provider turn 权威收口后一次性释放其全部 steer 临时图片。 */
  private releaseActiveProviderInputImages(active: ActiveTurn, reason: string): void {
    const releases = Array.from(active.providerInputImageReleases ?? []);
    active.providerInputImageReleases?.clear();
    for (const release of releases) release(reason);
  }

  /** 原会话持有图片lease直到确认释放；迟到回调只保存释放结果。 */
  private createProviderInputImageLease(prepared: ReturnType<typeof prepareCodexImagesForTurn>, turnId: TurnId): CodexProviderInputImageLease {
    const requestId = prepared.requestId;
    const pendingError = Object.assign(new Error(`Codex 图片仍等待 provider 请求结算（requestId=${requestId}）；原操作可能已生效，请勿自动重跑`), {
      code: "codex_image_cleanup_pending", requestId,
    });
    const lease = createCodexProviderInputImageLease(prepared.cleanup, pendingError, () => this.providerInputImageLeases.delete(lease), {
      writeWorkspaceLog: this.opts.writeWorkspaceLog,
      requestId, workspaceId: this.opts.workspaceId, threadId: this.opts.threadId, clientTurnId: turnId,
    });
    if (prepared.temporaryImageCount > 0) this.providerInputImageLeases.add(lease);
    return lease;
  }

  /** 只拦截新副作用和关闭；在途回合恢复及interrupt不经过此门禁。 */
  private assertProviderInputImagesReleased(): void {
    this.assertDiagnosticReady();
    const errors = Array.from(this.providerInputImageLeases, lease => lease.getError()).filter((error): error is Error => error !== null);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw Object.assign(new AggregateError(errors, "Codex 图片资源尚未全部释放，请核查关联请求，勿自动重跑", { cause: errors[0] }), {
      code: errors.some(error => !isCodexImageCleanupPending(error)) ? "codex_image_cleanup_failed" : "codex_image_cleanup_pending",
    });
  }

  /** 为初始输入和 steer 输入补齐稳定顺序，旧测试构造的 ActiveTurn 也可惰性升级。 */
  private ensureActiveClientUserMessageSequences(active: ActiveTurn): Map<string, number> {
    if (!active.clientUserMessageSequenceById) {
      active.clientUserMessageSequenceById = new Map(
        Array.from(active.clientUserMessageIds, (clientId, index) => [clientId, index]),
      );
    }
    if (active.confirmedClientUserMessageSequence == null) {
      active.confirmedClientUserMessageSequence = active.codexTurnId
        ? Math.max(-1, active.clientUserMessageSequenceById.size - 1)
        : -1;
    }
    return active.clientUserMessageSequenceById;
  }

  /** 登记最新 steer 输入并返回其单调序号。 */
  private registerActiveClientUserMessage(active: ActiveTurn, clientUserMessageId: string): number {
    const sequences = this.ensureActiveClientUserMessageSequences(active);
    const existing = sequences.get(clientUserMessageId);
    if (existing != null) return existing;
    const sequence = Math.max(-1, ...sequences.values()) + 1;
    sequences.set(clientUserMessageId, sequence);
    active.clientUserMessageIds.add(clientUserMessageId);
    return sequence;
  }

  /** 明确失败且未写入 provider 的 steer 不再参与后续 ownership 恢复。 */
  private unregisterActiveClientUserMessage(active: ActiveTurn, clientUserMessageId: string): void {
    active.clientUserMessageIds.delete(clientUserMessageId);
    active.clientUserMessageSequenceById?.delete(clientUserMessageId);
  }

  /** 仅允许同序或更新输入推进 active ownership，拒绝迟到旧 echo 回滚。 */
  private canAdvanceActiveOwnership(active: ActiveTurn, clientUserMessageId: string): boolean {
    const sequence = this.ensureActiveClientUserMessageSequences(active).get(clientUserMessageId);
    if (sequence == null) return false;
    return sequence >= (active.confirmedClientUserMessageSequence ?? -1);
  }

  /** 返回当前 active 中序号最新的本地用户输入。 */
  private getLatestActiveClientUserMessageId(active: ActiveTurn): string | null {
    const entries = Array.from(this.ensureActiveClientUserMessageSequences(active).entries());
    entries.sort((left, right) => right[1] - left[1]);
    return entries[0]?.[0] ?? null;
  }

  /** 本地 turn 收口或人工停止后，将未确权 steer 保留为可精确补偿的 tombstone。 */
  private markPendingSteersInterrupted(active: ActiveTurn): void {
    const interrupted: PendingSteerCorrelation[] = [];
    for (const correlation of this.pendingSteerCorrelationsByProviderClientKey.values()) {
      if (correlation.clientTurnId !== active.clientTurnId) continue;
      if (correlation.state === "pending" || correlation.state === "accepted") {
        correlation.state = "interrupted";
      }
      if (correlation.state === "interrupted") interrupted.push(correlation);
    }
    if (interrupted.length > 0) {
      this.preserveUnownedSteerProviderGeneration(interrupted, "active-settled-with-unowned-steer");
    }
  }

  /** 返回比当前已确权输入更新的最后一条 pending steer。 */
  private getLatestPendingSteerCorrelation(active: ActiveTurn): PendingSteerCorrelation | null {
    const confirmedSequence = active.confirmedClientUserMessageSequence ?? -1;
    const candidates = Array.from(this.pendingSteerCorrelationsByProviderClientKey.values())
      .filter((correlation) => (
        correlation.clientTurnId === active.clientTurnId
        && (correlation.state === "pending" || correlation.state === "accepted")
        && correlation.sequence > confirmedSequence
      ))
      .sort((left, right) => right.sequence - left.sequence);
    return candidates[0] ?? null;
  }

  /** 首个 await 前登记 compact owner，阻止并发操作与立即停止穿透。 */
  async compactThread(input: CompactThreadInput, emitters: ThreadEventEmitters): Promise<void> {
    this.assertProviderInputImagesReleased();
    if (this.credentialCallPending) throw new Error("当前 thread 有未完成的回合输出保存");
    if (this.credentialLease) throw new Error('当前 thread 有未完成的凭据回合');
    let settlePreparation!: () => void;
    this.credentialCallPending = { turnId: input.turnId, phase: "running", preparing: true, settled: new Promise(resolve => { settlePreparation = resolve; }) };
    try {
      this.credentialLease = await this.withDatabase(() => this.opts.acquireCredential?.({ model: input.catalogModel, turnId: input.turnId }));
      this.credentialCallPending.preparing = false;
      if (this.credentialCallPending.phase !== "running") throw createManualInterruptError();
      return await withThreadEventFlush(emitters, () => this.compactThreadWithCredential(input, emitters));
    }
    catch (error) {
      if (error instanceof ThreadEventFlushError) { this.credentialCallPending.failure = error; this.credentialCallPending.phase = "failed"; }
      throw error;
    } finally {
      if (!this.credentialCallPending?.failure) this.credentialCallPending = null;
      try { this.releaseSettledCredential(); } finally { settlePreparation(); }
    }
  }

  /** 压缩与普通新回合同一凭据门禁，保留原 provider 模型。 */
  private async compactThreadWithCredential(input: CompactThreadInput, emitters: ThreadEventEmitters): Promise<void> {
    if (this.disposed) throw createManualInterruptError();
    (await this.withDatabase(() => this.opts.assertMutationAllowed?.()));
    (await this.withDatabase(() => this.retryPendingSessionBindingDrop()));
    if (this.active || this.startingTurn || this.historyRollbackInProgress || this.hasPendingProviderMutationFence()) {
      throw new Error("当前 thread 有未完成的 turn");
    }
    const startingTurn = createStartingTurn(input.turnId, null);
    this.startingTurn = startingTurn;
    try {
      return await this.compactThreadAfterStartRegistration(input, emitters, startingTurn);
    } catch (error) {
      if (this.disposed) {
        const status = this.getObservedTurnTerminalStatus(input.turnId);
        if (status === "completed") return;
        if (!status) throw createManualInterruptError();
      }
      if (this.startingTurn === startingTurn) {
        startingTurn.startError = error;
        this.finishStartingTurn(startingTurn);
        if (startingTurn.interruptRequested) {
          if (startingTurn.interruptPromise) await startingTurn.interruptPromise;
          throw createManualInterruptError();
        }
      }
      throw error;
    } finally {
      this.finishStartingTurn(startingTurn);
    }
  }

  /** 以可信历史模型校验 compact 租约，并按当前目录最大窗口压缩。 */
  private async compactThreadAfterStartRegistration(
    input: CompactThreadInput,
    emitters: ThreadEventEmitters,
    startingTurn: StartingTurn,
  ): Promise<void> {
    this.emitters = emitters;
    this.responseText = "";
    this.currentProviderNativeToolPolicy = "allow";
    const catalogModel = input.catalogModel ?? this.appliedModel;

    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    await this.awaitStartingTurnPreflight(startingTurn, ws.ensureStarted());
    this.credentialLease?.assertCurrent();

    const setup = await (async () => {
      const dispatchLease = await acquireEngineModelCatalogDispatchLease({ engine: "codex", model: catalogModel });
      try {
        const accessMode = input.accessMode ?? "current";
        const modelProvider = this.resolveCurrentCodexModelProvider();
        const threadConfigContextWindow = resolveRuntimeThreadPrefsWithCatalogDefaults("codex", { model: catalogModel }).contextWindow;
        const autoCompactPct = normalizeAutoCompactPct(input.autoCompactPct);
        const threadConfigOverrides = resolveCodexThreadConfigOverrides({
          contextWindow: threadConfigContextWindow,
          autoCompactPct,
        });
        await this.awaitStartingThreadSession(
          startingTurn,
          this.ensureThreadSession(
            ws,
            emitters.conversation,
            accessMode,
            threadConfigContextWindow,
            autoCompactPct,
            modelProvider,
            this.appliedModel,
            this.appliedDeveloperInstructions,
            threadConfigOverrides,
            [],
            [],
            null,
            null,
            "optional",
            startingTurn,
            "compact_start",
          ),
        );
        return {
          accessMode,
          catalogDispatchIdentity: {
            configVersion: dispatchLease.configVersion,
            digest: dispatchLease.digest,
          },
        };
      } finally {
        dispatchLease.release();
      }
    })();
    const { accessMode, catalogDispatchIdentity } = setup;

    if (!this.sessionId) {
      throw buildCodexProviderThreadRecoveryError({
        code: "codex_thread_resume_unconfirmed",
        providerThreadId: null,
        reason: "missing_binding_before_compact",
        message: "Codex 会话 binding 在 compact 前缺失，未发送请求。",
      });
    }
    startingTurn.providerThreadId = this.sessionId;
    if (startingTurn.interruptRequested) {
      this.finishStartingTurn(startingTurn);
      throw createManualInterruptError();
    }
    const timeoutPolicy = normalizeTurnTimeoutPolicy(input.timeoutPolicy, undefined);
    const launchDispatchLease = await acquireEngineModelCatalogDispatchLease({ engine: "codex", model: catalogModel });
    let providerTurnIdsBeforeStart: Set<string>;
    try {
      assertEngineModelCatalogDispatchLeaseCurrent(catalogDispatchIdentity, launchDispatchLease);
      this.resolveCurrentCodexModelProvider();
      const providerAdmission = this.captureProviderInputAdmission(this.sessionId, null);
      providerTurnIdsBeforeStart = await this.awaitStartingTurnPreflight(
        startingTurn,
        this.readCompactProviderTurnBaseline(ws, this.sessionId),
      );
      this.assertProviderMutationAdmissionCurrent(providerAdmission, {
        operation: "compact",
        clientTurnId: startingTurn.clientTurnId,
        clientUserMessageId: null,
      });
      if (startingTurn.interruptRequested) {
        this.finishStartingTurn(startingTurn);
        throw createManualInterruptError();
      }
    } catch (error) {
      launchDispatchLease.release();
      throw error;
    }

    let releaseCompactStartLateSettlement: (() => void) | null = null;
    let compactStartSettled = false;
    let activeTurn!: ActiveTurn;
    const done = new Promise((resolve, reject) => {
      const timeoutController = new TurnTimeoutController({
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        engine: "codex",
        turnId: String(input.turnId),
        policy: timeoutPolicy,
        emitConversation: emitters.conversation,
        emitRaw: emitters.raw,
        onTimeout: (error) => this.runDiagnosticCallback(() => {
          this.handleCodexTurnTimeout(ws, input.turnId, error);
        }),
      });
      activeTurn = {
        clientTurnId: input.turnId,
        clientUserMessageIds: new Set(),
        providerInputImageReleases: new Set(),
        clientUserMessageSequenceById: new Map(),
        confirmedClientUserMessageSequence: -1,
        providerOwnershipStartingTurn: null,
        codexTurnId: null,
        provisionalCodexTurnId: null,
        responseFormat: "text",
        accessMode,
        toolRegistry: null,
        executeHostTool: null,
        sharedWorkspaceToolContext: input.sharedWorkspaceToolContext ?? null,
        platformToolFailureCounts: new Map(),
        timeoutController,
        todolistTextState: { text: "" },
        todolistSeenState: { seen: false },
        todolistToolCompletedState: { completed: false },
        manualInterruptRequested: false,
        manualInterruptError: null,
        interruptPromise: null,
        interruptTerminalError: null,
        pendingEngineIdleTimeoutError: null,
        idleTimeoutReconcilePromise: null,
        providerTerminalStatus: null,
        lastNonRetryableTurnError: null,
        compactStartState: {
          phase: "pending",
          error: null,
          lateSettlementPending: false,
          lateSettlementResult: null,
          providerTurnIdsBeforeStart,
          providerCompactTurnIds: new Set(),
        },
        resolve,
        reject,
      };
      this.active = activeTurn;
      timeoutController.start();
    });

    const settled = done.finally(() => {
      compactStartSettled = true;
      releaseCompactStartLateSettlement?.();
      releaseCompactStartLateSettlement = null;
      activeTurn.timeoutController.stop();
      if (this.active === activeTurn) {
        this.active = null;
        this.clearReconnectRecovery();
        this.pendingCommandExecutionsByItemId.clear();
      }
      this.retireCodexTurn(input.turnId);
    });
    const activeTurnSettlement = settled.then(() => undefined, () => undefined);
    this.activeTurnSettled = activeTurnSettlement;

    let compactStartRequest: Promise<unknown>;
    try {
      this.credentialLease?.assertCurrent();
      compactStartRequest = ws.request(
        "thread/compact/start",
        { threadId: this.sessionId },
        { timeoutMs: 20_000, trackLateSettlement: true },
      );
      launchDispatchLease.release();
    } catch (error) {
      launchDispatchLease.release();
      throw error;
    }
    this.finishStartingTurn(startingTurn);

    let compactStartAccepted = false;
    try {
      try {
        await compactStartRequest;
        compactStartAccepted = true;
        activeTurn.compactStartState!.phase = "accepted";
        this.bindActiveCompactTurnFromRecordedEvidence(activeTurn);
      } catch (error) {
        if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
        const uncertainCompactStart = isUncertainCompactStartError(error);
        const compactError = error instanceof Error ? error : new Error(String(error));
        const releaseLateSettlement = uncertainCompactStart
          ? extractCodexLateSettlementRelease(error)
          : null;
        const active = this.active === activeTurn ? activeTurn : null;
        if (compactStartAccepted) {
          (compactError as Error & { preserveRunningState?: boolean }).preserveRunningState = true;
          if (active) active.interruptTerminalError = compactError;
          throw compactError;
        }
        if (uncertainCompactStart && active) {
          const compactStartState = active.compactStartState!;
          const lateSettlement = extractCodexLateSettlement(error);
          compactStartState.phase = "unknown";
          compactStartState.error = compactError;
          compactStartState.lateSettlementPending = Boolean(lateSettlement);
          if (lateSettlement) {
            compactStartState.lateSettlementResult = null;
          }
          if (compactStartSettled) releaseLateSettlement?.();
          else releaseCompactStartLateSettlement = releaseLateSettlement;
          active.interruptTerminalError = compactError;
          this.trackCompactStartLateSettlement(active, ws, lateSettlement);
          if (!lateSettlement) {
            this.startPendingActiveTurnInterrupt(active, ws, "compact-start-state-unknown");
          }
        } else {
          if (uncertainCompactStart) releaseLateSettlement?.();
          if (active) active.reject(compactError);
          await activeTurnSettlement;
          throw compactError;
        }
      }
      await settled;
    } finally {
      if (this.activeTurnSettled === activeTurnSettlement) this.activeTurnSettled = null;
    }
  }

  /** 读取 compact/start 前的 idle 基线；已有 provider turn 运行时拒绝并发 compact。 */
  private async readCompactProviderTurnBaseline(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    sessionId: SessionId,
  ): Promise<Set<string>> {
    const read = await ws.request(
      "thread/read",
      { threadId: sessionId, includeTurns: true },
      CODEX_STATE_READ_OPTIONS,
    );
    const thread = (read as any)?.thread ?? null;
    const providerThreadId = String(thread?.id ?? "").trim();
    if (providerThreadId !== String(sessionId)) {
      throw Object.assign(
        new Error(`compact 基线读取返回错误 threadId：${providerThreadId || "missing"}`),
        { code: "codex_compact_baseline_thread_mismatch" },
      );
    }
    const threadStatus = normalizeCodexTurnStatus(thread?.status);
    const turns = Array.isArray(thread?.turns) ? (thread.turns as any[]) : null;
    const runningTurnIds = (turns ?? [])
      .filter((turn) => isRunningCodexTurnStatus(normalizeCodexTurnStatus(turn?.status)))
      .map((turn) => String(turn?.id ?? "").trim() || "missing");
    if (threadStatus !== "idle" || runningTurnIds.length > 0) {
      throw buildCodexCompactProviderBusyError({
        sessionId,
        threadStatus,
        runningTurnIds,
      });
    }
    if (!turns) {
      throw Object.assign(new Error("compact 基线读取未返回完整 turns"), {
        code: "codex_compact_baseline_turns_missing",
      });
    }
    this.markObservedProviderThreadTerminal("idle");
    return new Set(parseCodexRollbackThreadSnapshot(read, sessionId).turnIds);
  }

  /** 记录迟到 compact/start 结果，并在当前 singleflight 结束后重试权威补偿。 */
  private trackCompactStartLateSettlement(
    active: ActiveTurn,
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    lateSettlement: Promise<CodexAppServerLateSettlement> | null,
  ): void {
    if (!lateSettlement) return;
    const retryAfterCurrentAttempt = (settlement: CodexAppServerLateSettlement): void => {
      const compactStartState = active.compactStartState;
      if (compactStartState?.phase === "unknown") {
        compactStartState.lateSettlementPending = false;
        compactStartState.lateSettlementResult = settlement;
      }
      const retry = (): void => {
        if (this.active !== active || active.providerTerminalStatus) return;
        const compactStartState = active.compactStartState;
        if (!compactStartState || compactStartState.phase !== "unknown") return;
        if (settlement.status === "fulfilled") this.bindActiveCompactTurnFromRecordedEvidence(active);
        this.startPendingActiveTurnInterrupt(active, ws, "compact-start-late-settlement");
      };
      const currentAttempt = active.interruptPromise;
      if (currentAttempt) {
        this.observeDiagnosticTask(() => (currentAttempt.then(retry, retry)));
      } else {
        retry();
      }
    };
    this.observeDiagnosticTask(() => (lateSettlement.then(
      retryAfterCurrentAttempt,
      (cause) => {
        this.log("error", () => ({ message: "compact/start late settlement failed; keeping active turn", data: {
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId: this.sessionId,
          clientTurnId: active.clientTurnId,
          providerTurnId: active.codexTurnId,
          error: engineDiagnosticCause(cause),
        } }), { reason: cause });
        retryAfterCurrentAttempt({
          status: "rejected",
          kind: "process_fault",
          reason: cause instanceof Error ? cause : new Error(String(cause)),
        });
      },
    )));
  }

  /** 已有保存失败不阻止精确停止；停止证明先反馈，随后仍返回原保存错误。 */
  async interrupt(turnId: TurnId, options?: ThreadInterruptOptions): Promise<boolean> {
    const emitters = this.emitters;
    const settlement = this.activeTurnSettled;
    const call = this.credentialCallPending?.turnId === turnId ? this.credentialCallPending : null;
    if (call?.failure && !this.active && !this.startingTurn) throw call.failure;
    if (call && !call.failure && (call.phase === "draining" || !this.active && !this.startingTurn && !this.hasPendingProviderMutationFence())) {
      call.phase = "draining";
      options?.onStopConfirmed?.();
      if (call.preparing) await call.settled;
      await emitters?.flush?.();
      return true;
    }
    if (call) call.phase = "stopping";
    let interrupted: boolean;
    try { interrupted = await this.interruptProviderTurn(turnId); }
    catch (error) { if (call && this.credentialCallPending === call) call.phase = "running"; throw error; }
    if (!interrupted) { if (call && this.credentialCallPending === call) call.phase = "running"; return false; }
    if (call && this.credentialCallPending === call) call.phase = "draining";
    options?.onStopConfirmed?.();
    if (call?.failure) throw call.failure;
    if (settlement) await settlement;
    await emitters?.flush?.();
    return true;
  }

  /** 只从既有 starting/active owner 的停止请求和 provider 证据派生阶段。 */
  getTurnPhase(turnId: TurnId): "running" | "stopping" | "draining" | "failed" | null {
    if (this.credentialCallPending?.turnId === turnId) return !this.credentialCallPending.preparing && this.credentialCallPending.phase === "running"
      && !this.active && !this.startingTurn && !this.hasPendingProviderMutationFence() ? "draining" : this.credentialCallPending.phase;
    const active = this.active;
    if (active?.clientTurnId === turnId) return active.manualInterruptRequested
      ? active.providerTerminalStatus ? "draining" : "stopping" : "running";
    const starting = this.startingTurn;
    if (starting?.clientTurnId === turnId) return starting.startupInterruptAcknowledged
      ? "draining" : starting.interruptRequested ? "stopping" : "running";
    return null;
  }

  /** 持久化失败保留在原调用 owner 上，查询不重新访问失败的数据源。 */
  getTurnFailure(turnId: TurnId): string | null {
    return this.credentialCallPending?.turnId === turnId ? this.credentialCallPending.failure?.code ?? null : null;
  }

  /** 中断指定 turn；provider 失败时保留 active 并显式抛错。 */
  private async interruptProviderTurn(turnId: TurnId): Promise<boolean> {
    const startingTurn = this.startingTurn;
    if (startingTurn?.clientTurnId === turnId) {
      startingTurn.interruptRequested = true;
      startingTurn.signalPreflightInterrupt();
      startingTurn.interruptPromise ??= this.interruptStartingTurn(startingTurn);
      const interruptPromise = startingTurn.interruptPromise;
      try {
        return await this.awaitStartingTurnInterruptOutcome(startingTurn, interruptPromise);
      } catch (error) {
        if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
        if (this.startingTurn === startingTurn && startingTurn.interruptPromise === interruptPromise) {
          startingTurn.interruptPromise = null;
        }
        throw error;
      }
    }

    const interruptedStartingTurn = this.pendingInterruptedStartingTurns.get(turnId) ?? null;
    if (interruptedStartingTurn) {
      const providerThreadId = interruptedStartingTurn.providerThreadId;
      const providerTurnId = this.getStartingTurnInterruptProviderTurnId(interruptedStartingTurn);
      const terminalStatus = providerTurnId
        ? this.getProviderTerminalStatus(providerThreadId, providerTurnId)
        : null;
      if (providerTurnId && terminalStatus && isTerminalCodexTurnStatus(terminalStatus)) {
        this.forgetInterruptedStartingTurn(interruptedStartingTurn);
        return true;
      }
      if (!providerThreadId || !providerTurnId) {
        this.scheduleStartingTurnOwnershipRecovery(interruptedStartingTurn);
        throw buildCodexStartInterruptReconcileError(
          providerThreadId ?? this.sessionId ?? this.opts.threadId,
          interruptedStartingTurn.clientTurnId,
          providerTurnId || null,
          new Error("尚未取得可精确中断的 provider turnId"),
        );
      }
      const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
      let outcome: string;
      try {
        outcome = await this.getOrStartOwnedProviderTurnCompensation(ws, {
          sessionId: providerThreadId,
          providerTurnId,
        });
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        throw buildCodexDetachedInterruptStateUnknownError(providerThreadId, providerTurnId, cause);
      }
      if (outcome === "interrupt_acknowledged") {
        this.finalizeOwnedStartingTurnInterruptAcknowledged(interruptedStartingTurn, providerTurnId);
      } else {
        this.finalizeOwnedStartingTurnTerminal(
          interruptedStartingTurn,
          providerTurnId,
          outcome,
          "detached-starting-stop.provider-terminal-observed",
        );
      }
      return true;
    }
    const pendingHandoffStartingTurn = this.pendingHandoffStartingTurn?.clientTurnId === turnId
      ? this.pendingHandoffStartingTurn
      : null;
    const interruptedSteer = Array.from(this.pendingSteerCorrelationsByProviderClientKey.values()).find(
      (correlation) => correlation.clientTurnId === turnId && correlation.state === "interrupted",
    ) ?? null;
    if (interruptedSteer) {
      const providerTurnId = String(interruptedSteer.confirmedProviderTurnId ?? "").trim();
      const terminalStatus = providerTurnId
        ? this.getProviderTerminalStatus(interruptedSteer.providerThreadId, providerTurnId)
        : null;
      if (providerTurnId && terminalStatus && isTerminalCodexTurnStatus(terminalStatus)) {
        this.forgetInterruptedSteerCorrelation(interruptedSteer);
        return true;
      }
      if (!providerTurnId) {
        throw buildCodexActiveInterruptStateUnknownError(
          interruptedSteer.providerThreadId,
          interruptedSteer.clientTurnId,
          null,
          new Error("尚未取得 steer 对应的 provider turnId"),
        );
      }
      const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
      try {
        await this.getOrStartOwnedProviderTurnCompensation(ws, {
          sessionId: interruptedSteer.providerThreadId,
          providerTurnId,
        });
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        throw buildCodexDetachedInterruptStateUnknownError(
          interruptedSteer.providerThreadId,
          providerTurnId,
          cause,
        );
      }
      this.forgetInterruptedSteerCorrelation(interruptedSteer);
      return true;
    }

    const active = this.active;
    if (!active) {
      if (pendingHandoffStartingTurn?.handoffTerminalSettled) return true;
      if (pendingHandoffStartingTurn) {
        throw buildCodexStartInterruptReconcileError(
          pendingHandoffStartingTurn.providerThreadId ?? this.sessionId ?? this.opts.threadId,
          pendingHandoffStartingTurn.clientTurnId,
          pendingHandoffStartingTurn.providerLifecycleTurnId ?? pendingHandoffStartingTurn.providerTurnId,
          new Error("handoff 尚未取得 provider 明确终态"),
        );
      }
      return false;
    }
    if (active.clientTurnId !== turnId) return false;

    return await this.interruptActiveTurn(active);
  }

  /** 让 provider 启动前检查响应当前 turn 的立即停止，不等待 RPC 自身超时。 */
  private async awaitStartingTurnPreflight<T>(startingTurn: StartingTurn, preflight: Promise<T>): Promise<T> {
    const result = await Promise.race([
      preflight,
      startingTurn.preflightInterruptSignal.then(() => {
        throw createManualInterruptError();
      }),
    ]);
    this.credentialLease?.assertCurrent();
    return result;
  }

  /** 立即停止可先结束本地等待；迟到的新 thread 绑定会在落地后安全清除。 */
  private async awaitStartingThreadSession<T extends { didThreadStart: boolean; didThreadResume: boolean }>(
    startingTurn: StartingTurn,
    preflight: Promise<T>,
  ): Promise<T> {
    try {
      const result = await this.awaitStartingTurnPreflight(startingTurn, preflight);
      if (result.didThreadStart) startingTurn.createdProviderThreadId = this.sessionId;
      return result;
    } catch (error) {
      if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
      if (startingTurn.interruptRequested) {
        this.observeDiagnosticTask(() => (preflight.then(
          async (result) => {
            if (this.disposed) return;
            if (!result.didThreadStart) return;
            if (this.active || this.startingTurn) {
              this.log("warn", () => ({ message: "interrupted thread preflight completed after a newer local turn started", data: {
                workspaceId: this.opts.workspaceId,
                threadId: this.opts.threadId,
                clientTurnId: startingTurn.clientTurnId,
                currentTurnId: this.getActiveTurnId(),
              } }), { reason: error });
              return;
            }
            startingTurn.createdProviderThreadId = this.sessionId;
            (await this.withDatabase(() => this.dropFreshInterruptedThreadBinding(startingTurn)));
          },
          (cause) => {
            this.log("error", () => ({ message: "interrupted thread preflight settled as failed", data: {
              workspaceId: this.opts.workspaceId,
              threadId: this.opts.threadId,
              clientTurnId: startingTurn.clientTurnId,
              error: engineDiagnosticCause(cause),
            } }), { reason: cause });
          },
        ).catch((cause) => {
          this.log("error", () => ({ message: "interrupted thread preflight binding cleanup failed", data: {
            code: "codex_interrupted_preflight_binding_cleanup_failed",
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            clientTurnId: startingTurn.clientTurnId,
            expectedSessionId: startingTurn.createdProviderThreadId,
            error: engineDiagnosticCause(cause),
          } }), { reason: cause });
        })));
      }
      throw error;
    }
  }

  /** 精确中断已取得 provider ID 的 starting turn；RPC ACK 直接裁决本次中断。 */
  private async interruptStartingProviderTurn(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    startingTurn: StartingTurn,
    sessionId: SessionId,
    initialProviderTurnId: string,
  ): Promise<string> {
    const targetTurnId = String(initialProviderTurnId ?? "").trim();
    this.assertStartingTurnOwnershipUnambiguous(startingTurn);
    await ws.request(
      "turn/interrupt",
      { threadId: sessionId, turnId: targetTurnId },
      CODEX_RECOVERY_REQUEST_OPTIONS,
    );
    return targetTurnId;
  }

  /** turn/start 响应 ID 是中断权威目标；无响应 ID 时才接受无冲突的 lifecycle ID。 */
  private getStartingTurnInterruptProviderTurnId(startingTurn: StartingTurn): string | null {
    const responseProviderTurnId = String(startingTurn.providerTurnId ?? "").trim();
    if (responseProviderTurnId) return responseProviderTurnId;
    if (startingTurn.providerOwnershipConflict) return null;
    return String(startingTurn.providerLifecycleTurnId ?? "").trim() || null;
  }

  /** ownership 辅助失败且没有 turn/start 响应 ID 时，拒绝猜测中断目标。 */
  private assertStartingTurnOwnershipUnambiguous(startingTurn: StartingTurn): void {
    this.assertDiagnosticReady();
    if (startingTurn.providerOwnershipConflict && !startingTurn.providerTurnId) {
      throw startingTurn.providerOwnershipConflict;
    }
  }

  /** ownership 已隔离时立即结束启动中断等待，不再阻塞于旧 generation 的在途 RPC。 */
  private async awaitStartingTurnInterruptOutcome(
    startingTurn: StartingTurn,
    interruptPromise: Promise<boolean>,
  ): Promise<boolean> {
    const interrupted = await Promise.race([
      interruptPromise,
      // finalizer 只负责唤醒等待；本次 Stop 仍由原 interrupt Promise 的 ACK/终态结果裁决。
      startingTurn.interruptFinalized.then(() => interruptPromise),
    ]);
    return interrupted;
  }

  /** 启动请求已发后等待真实结算；只有精确 ACK、明确终态或明确拒绝才返回成功。 */
  private async interruptStartingTurn(startingTurn: StartingTurn): Promise<boolean> {
    this.assertStartingTurnOwnershipUnambiguous(startingTurn);
    await Promise.race([startingTurn.startRequestDispatched, startingTurn.settled]);
    this.assertStartingTurnOwnershipUnambiguous(startingTurn);
    await startingTurn.settled;
    this.assertStartingTurnOwnershipUnambiguous(startingTurn);
    if (startingTurn.handoffTerminalSettled) return true;
    const active = this.active;
    if (active?.clientTurnId === startingTurn.clientTurnId) return await this.interruptActiveTurn(active);
    if (!startingTurn.startRequestSent) {
      (await this.withDatabase(() => this.dropFreshInterruptedThreadBinding(startingTurn)));
      return true;
    }

    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    return await this.interruptUncertainStartingTurn(ws, startingTurn);
  }

  /** 对已发送但未 handoff 的 turn/start 只接受当前请求 ID、精确 ACK、精确终态或明确 RPC 拒绝。 */
  private async interruptUncertainStartingTurn(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    startingTurn: StartingTurn,
  ): Promise<boolean> {
    this.assertStartingTurnOwnershipUnambiguous(startingTurn);
    const sessionId = startingTurn.providerThreadId ?? this.sessionId;
    if (!sessionId) {
      throw buildCodexStartInterruptReconcileError(this.opts.threadId, startingTurn.clientTurnId, null, new Error("缺少 provider threadId"));
    }
    const lateSettlement = startingTurn.lateSettlementResult;
    if (lateSettlement?.status === "fulfilled") {
      startingTurn.providerTurnId = extractTurnIdFromResult(lateSettlement.value) ?? startingTurn.providerTurnId;
    }
    const providerTurnId = this.getStartingTurnInterruptProviderTurnId(startingTurn);
    const terminalStatus = providerTurnId
      ? this.getProviderTerminalStatus(sessionId, providerTurnId)
      : null;
    if (providerTurnId && terminalStatus && isTerminalCodexTurnStatus(terminalStatus)) {
      this.finalizeOwnedStartingTurnTerminal(
        startingTurn,
        providerTurnId,
        terminalStatus,
        "startup-interrupt.provider-terminal-observed",
      );
      return true;
    }
    if (providerTurnId) {
      try {
        await this.interruptStartingProviderTurn(ws, startingTurn, sessionId, providerTurnId);
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        if (hasCodexThreadUnavailableSignal(cause)) {
          let resumeCause: unknown = null;
          try {
            await ws.request("thread/resume", await this.withDatabase(() => this.buildCurrentCodexResumeParams(sessionId)), CODEX_RECOVERY_REQUEST_OPTIONS);
          } catch (error) {
            if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
            resumeCause = error;
          }
          try {
            await this.interruptStartingProviderTurn(ws, startingTurn, sessionId, providerTurnId);
          } catch (retryCause) {
            if (isEngineWorkspaceLogFailure(retryCause)) throw this.retainDiagnosticFailure(retryCause);
            throw buildCodexStartupInterruptError(
              sessionId,
              startingTurn.clientTurnId,
              combineCodexResumeAndInterruptFailures(resumeCause, retryCause),
            );
          }
        } else {
          throw buildCodexStartupInterruptError(sessionId, startingTurn.clientTurnId, cause);
        }
      }
      startingTurn.compensatedProviderTurnIds.add(providerTurnId);
      startingTurn.startupInterruptAcknowledged = true;
      startingTurn.acknowledgeStartupInterrupt();
      const activeAfterAck = this.active?.clientTurnId === startingTurn.clientTurnId ? this.active : null;
      if (activeAfterAck) {
        this.settleActiveAfterInterruptAcknowledged(activeAfterAck, providerTurnId);
      } else if (this.startingTurn === startingTurn) {
        this.finishUnboundStartingTurn(startingTurn);
      }
      startingTurn.resolveInterruptFinalized();
      return true;
    }
    if (lateSettlement?.status === "rejected" && lateSettlement.kind === "rpc_error") {
      this.finishUnboundStartingTurn(startingTurn);
      return true;
    }
    if (isExplicitCodexTurnStartRejection(startingTurn.startError)) {
      this.finishUnboundStartingTurn(startingTurn);
      return true;
    }
    throw buildCodexStartInterruptReconcileError(
      sessionId,
      startingTurn.clientTurnId,
      null,
      startingTurn.startError ?? new Error("turn/start 尚未返回可精确中断的 turnId"),
    );
  }

  /** 记录迟到结算结果；明确 RPC rejection 且无 ownership 证据时立即释放 detached fence。 */
  private trackStartingTurnLateSettlement(
    startingTurn: StartingTurn,
    lateSettlement: Promise<CodexAppServerLateSettlement> | null,
  ): void {
    if (!lateSettlement || startingTurn.lateSettlement === lateSettlement) return;
    startingTurn.lateSettlement = lateSettlement;
    this.observeDiagnosticTask(() => (lateSettlement.then(
      (result) => {
        if (startingTurn.providerOwnershipConflict) {
          this.log("info", () => ({ message: "late turn/start settlement ignored after ownership fence", data: {
            code: "codex_late_turn_start_settlement_ownership_fenced",
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            clientTurnId: startingTurn.clientTurnId,
            outcome: result.status,
            ownershipConflict: true,
          } }));
          return;
        }
        startingTurn.lateSettlementResult = result;
        if (
          result.status === "rejected"
          && result.kind === "rpc_error"
          && !startingTurn.providerLifecycleTurnId
          && !startingTurn.providerObservedTurnId
          && this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn
        ) {
          this.log("info", () => ({ message: "late turn/start RPC rejection released detached mutation fence", data: {
            code: "codex_late_turn_start_rpc_rejection_released_fence",
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            providerThreadId: startingTurn.providerThreadId,
            clientTurnId: startingTurn.clientTurnId,
            clientUserMessageId: startingTurn.clientUserMessageId,
            error: result.reason.message,
          } }));
          this.forgetInterruptedStartingTurn(startingTurn);
          return;
        }
        this.restartStartingTurnOwnershipRecoveryAfterNewEvidence(startingTurn);
        this.scheduleStartingTurnReconcile(startingTurn, "turn-start-late-settlement");
      },
      (cause) => {
        if (startingTurn.providerOwnershipConflict) {
          this.log("info", () => ({ message: "late turn/start rejection ignored after ownership fence", data: {
            code: "codex_late_turn_start_rejection_ownership_fenced",
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            clientTurnId: startingTurn.clientTurnId,
            outcome: "rejected",
            ownershipConflict: true,
            error: engineDiagnosticCause(cause),
          } }), { reason: cause });
          return;
        }
        startingTurn.lateSettlementResult = {
          status: "rejected",
          kind: "process_fault",
          reason: cause instanceof Error ? cause : new Error(String(cause)),
        };
        this.scheduleStartingTurnReconcile(startingTurn, "turn-start-late-settlement-fault");
      },
    )));
  }

  /** provider 新证据到达后合并重试启动未知态对账，成功会唤醒原 send 生命周期。 */
  private scheduleStartingTurnReconcile(startingTurn: StartingTurn, trigger: string): void {
    if (this.startingTurn !== startingTurn || !startingTurn.reconcileRequested) return;
    if (startingTurn.reconcileRetryScheduled) {
      startingTurn.reconcileRetryPending = true;
      return;
    }
    startingTurn.reconcileRetryScheduled = true;
    startingTurn.reconcileRetryPending = false;
    this.observeDiagnosticTask(() => ((async () => {
      const previous = startingTurn.interruptPromise;
      if (previous) {
        const [previousResult] = await Promise.allSettled([previous]);
        if (previousResult?.status === "rejected") {
          this.log("info", () => ({ message: "retrying start reconcile after provider evidence", data: {
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            clientTurnId: startingTurn.clientTurnId,
            trigger,
            previousError: engineDiagnosticCause(previousResult.reason),
          } }));
        }
      }
      if (this.startingTurn !== startingTurn) return;

      const concurrent = startingTurn.interruptPromise;
      if (concurrent && concurrent !== previous) {
        await Promise.allSettled([concurrent]);
        return;
      }
      if (startingTurn.interruptPromise === previous) startingTurn.interruptPromise = null;

      const retry = this.interruptStartingTurn(startingTurn);
      startingTurn.interruptPromise = retry;
      try {
        await retry;
      } catch (error) {
        if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
        this.log("error", () => ({ message: "turn/start evidence reconcile failed; keeping starting turn", data: {
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId: startingTurn.providerThreadId ?? this.sessionId,
          clientTurnId: startingTurn.clientTurnId,
          trigger,
          errorCode: String(engineDiagnosticField(error, "code") ?? "").trim() || null,
          error: engineDiagnosticCause(error),
        } }), { reason: error });
      } finally {
        if (this.startingTurn === startingTurn && startingTurn.interruptPromise === retry) {
          startingTurn.interruptPromise = null;
        }
      }
    })()
      .catch((error) => {
        this.log("error", () => ({ message: "turn/start evidence retry task failed; keeping starting turn", data: {
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          clientTurnId: startingTurn.clientTurnId,
          trigger,
          error: engineDiagnosticCause(error),
        } }), { reason: error });
      })
      .finally(() => {
        startingTurn.reconcileRetryScheduled = false;
        if (startingTurn.reconcileRetryPending) {
          startingTurn.reconcileRetryPending = false;
          this.scheduleStartingTurnReconcile(startingTurn, "coalesced-provider-evidence");
        }
      })));
  }

  /** 结束未创建 ActiveTurn 的启动态，并清理该 client turn 的临时映射。 */
  private finishUnboundStartingTurn(startingTurn: StartingTurn): void {
    if (!startingTurn.lateSettlement || startingTurn.lateSettlementResult) {
      this.releaseStartingTurnLateSettlement(startingTurn);
    }
    this.finishStartingTurn(startingTurn);
    this.assistantLifecycle.retireTurn(startingTurn.clientTurnId);
    this.retireCodexTurn(startingTurn.clientTurnId);
    this.pendingCommandExecutionsByItemId.clear();
    startingTurn.resolveInterruptFinalized();
  }

  /** 只释放一次 turn/start 迟到响应追踪，兼容停止先于 timeout error 回传的竞态。 */
  private releaseStartingTurnLateSettlement(
    startingTurn: StartingTurn,
    release = startingTurn.releaseLateSettlement,
  ): void {
    if (!release || startingTurn.lateSettlementReleased) return;
    startingTurn.lateSettlementReleased = true;
    startingTurn.releaseLateSettlement = null;
    release();
  }

  /** 中断已绑定 turn；状态未知时保留 active，ownership 丢失时收口 active 并保留 generation。 */
  private async interruptActiveTurn(active: ActiveTurn): Promise<boolean> {
    if (this.active !== active) return false;
    active.manualInterruptRequested = true;
    active.manualInterruptError ??= createManualInterruptError();
    active.pendingEngineIdleTimeoutError = null;
    if (active.interruptPromise) return await active.interruptPromise;

    const interruptPromise = Promise.resolve().then(() => this.requestAndConfirmActiveTurnInterrupt(active));
    active.interruptPromise = interruptPromise;
    try {
      return await interruptPromise;
    } finally {
      if (active.interruptPromise === interruptPromise) active.interruptPromise = null;
    }
  }

  /** ownership 辅助逻辑失败只停止恢复任务，不得伪造 provider 终态。 */
  private rejectActiveForProviderOwnershipFailure(
    active: ActiveTurn,
    error: Error,
    reason: string,
    _recoverWithStartingCorrelation = true,
  ): void {
    if (this.active !== active || active.providerTerminalStatus) return;
    (error as Error & { preserveRunningState?: boolean }).preserveRunningState = true;
    const ownershipCorrelation = active.providerOwnershipStartingTurn ?? null;
    if (ownershipCorrelation) {
      this.clearStartingTurnOwnershipRecoveryTimer(ownershipCorrelation);
      ownershipCorrelation.ownershipRecoveryExhausted = true;
    }
    this.log("error", () => ({ message: "provider ownership recovery failed; keeping active turn", data: {
      code: String(engineDiagnosticField(error, "code") ?? "codex_provider_ownership_recovery_failed"),
      requestId: String(engineDiagnosticField(error, "requestId") ?? "").trim() || null,
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      sessionId: this.sessionId,
      clientTurnId: active.clientTurnId,
      providerTurnId: active.codexTurnId,
      reason,
      rootCause: engineDiagnosticCause(error),
    } }));
  }

  /** starting ownership 辅助逻辑失败只停止扫描，不得伪造 interrupt ACK。 */
  private rejectStartingForProviderOwnershipFailure(
    startingTurn: StartingTurn,
    error: Error,
    reason: string,
  ): void {
    if (this.startingTurn !== startingTurn) return;
    (error as Error & { preserveRunningState?: boolean }).preserveRunningState = true;
    this.clearStartingTurnOwnershipRecoveryTimer(startingTurn);
    startingTurn.ownershipRecoveryExhausted = true;
    const providerThreadId = startingTurn.providerThreadId ?? this.sessionId;
    this.log("error", () => ({ message: "provider ownership recovery failed; keeping starting turn", data: {
      code: String(engineDiagnosticField(error, "code") ?? "codex_start_ownership_recovery_failed"),
      requestId: String(engineDiagnosticField(error, "requestId") ?? "").trim() || null,
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      providerThreadId,
      clientTurnId: startingTurn.clientTurnId,
      clientUserMessageId: startingTurn.clientUserMessageId,
      reason,
      rootCause: engineDiagnosticCause(error),
    } }));
  }

  /** 精确 interrupt ACK 已足以完成停止；无 ACK 或明确终态时保留 active。 */
  private settleActiveAfterInterruptAcknowledged(active: ActiveTurn, providerTurnId: string): void {
    if (this.active !== active || active.providerTerminalStatus) return;
    if (active.codexTurnId !== providerTurnId) {
      this.replaceActiveCodexTurnId(active, providerTurnId, "provider_lifecycle");
    }
    active.providerTerminalStatus = "interrupt_acknowledged";
    this.releaseActiveProviderInputImages(active, "provider_turn_interrupt_acknowledged");
    active.reject(
      active.manualInterruptRequested
        ? active.manualInterruptError ?? createManualInterruptError()
        : active.interruptTerminalError ?? createManualInterruptError(),
    );
  }

  /** 精确 provider pair 已 ACK 或已确认终态时，结束同一个本地 turn。 */
  acknowledgeExactProviderTurnInterrupt(input: {
    clientTurnId: TurnId;
    providerThreadId: SessionId;
    providerTurnId: string;
    /** 同 ID thread/read 已确认的 provider 终态；缺失时保持原 ACK 语义。 */
    providerTerminalStatus?: string | null;
    providerThreadRead?: unknown;
  }): boolean {
    const providerTurnId = String(input.providerTurnId ?? "").trim();
    const providerTerminalStatus = normalizeCodexTurnStatus(input.providerTerminalStatus);
    if (providerTerminalStatus && !isTerminalCodexTurnStatus(providerTerminalStatus)) return false;
    const active = this.active;
    if (
      active
      && active.clientTurnId === input.clientTurnId
      && this.sessionId === input.providerThreadId
      && active.codexTurnId === providerTurnId
    ) {
      active.pendingEngineIdleTimeoutError = null;
      if (providerTerminalStatus) {
        this.rememberProviderTerminalStatus(input.providerThreadId, providerTurnId, providerTerminalStatus);
        this.terminalObservedProviderTurnStatusById.set(providerTurnId, providerTerminalStatus);
        this.settleActiveFromProviderTerminal(
          active,
          providerTerminalStatus,
          "turn.interrupt.provider-read-terminal",
          input.providerThreadRead ?? null,
        );
      } else {
        active.manualInterruptRequested = true;
        active.manualInterruptError ??= createManualInterruptError();
        this.settleActiveAfterInterruptAcknowledged(active, providerTurnId);
      }
      return true;
    }

    const startingTurn = [
      this.startingTurn,
      this.pendingHandoffStartingTurn,
      this.pendingInterruptedStartingTurns.get(input.clientTurnId) ?? null,
    ].find((candidate) => (
      candidate?.clientTurnId === input.clientTurnId
      && candidate.providerThreadId === input.providerThreadId
      && this.getStartingTurnInterruptProviderTurnId(candidate) === providerTurnId
    )) ?? null;
    if (!startingTurn) return false;
    if (providerTerminalStatus) {
      this.finalizeOwnedStartingTurnTerminal(
        startingTurn,
        providerTurnId,
        providerTerminalStatus,
        "turn.interrupt.provider-read-terminal",
      );
    } else {
      this.finalizeOwnedStartingTurnInterruptAcknowledged(startingTurn, providerTurnId);
    }
    return true;
  }

  private async requestAndConfirmActiveTurnInterrupt(
    active: ActiveTurn,
    ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath),
  ): Promise<boolean> {
    if (!active.codexTurnId && active.compactStartState?.phase === "unknown") {
      const decision = this.reconcileUncertainCompactStart(active);
      if (decision === "settled") return true;
    }
    if (!active.codexTurnId && active.compactStartState) {
      this.bindActiveCompactTurnFromRecordedEvidence(active);
      if (!active.codexTurnId) {
        throw buildCodexActiveInterruptStateUnknownError(
          this.sessionId ?? this.opts.threadId,
          active.clientTurnId,
          null,
          buildCodexCompactOwnershipUnconfirmedError({
            sessionId: this.sessionId ?? this.opts.threadId as SessionId,
            clientTurnId: active.clientTurnId,
            candidateTurnIds: Array.from(active.compactStartState.providerCompactTurnIds),
            cause: new Error("尚未收到 compact 专用 provider turnId"),
          }),
        );
      }
    }
    const pendingSteer = this.getLatestPendingSteerCorrelation(active);
    const responseProviderTurnId = String(
      pendingSteer?.confirmedProviderTurnId ?? pendingSteer?.provisionalProviderTurnId ?? "",
    ).trim();
    if (pendingSteer && responseProviderTurnId) {
      this.confirmSteerOwnership(pendingSteer, responseProviderTurnId);
    } else if (pendingSteer || !active.codexTurnId) {
      throw buildCodexActiveInterruptStateUnknownError(
        this.sessionId ?? this.opts.threadId,
        active.clientTurnId,
        active.codexTurnId,
        new Error(
          pendingSteer
            ? "turn/steer 尚未返回可精确中断的 provider turnId"
            : "active turn 缺少可精确中断的 provider turnId",
        ),
      );
    }
    if (active.providerTerminalStatus) {
      if (
        active.providerTerminalStatus === "interrupt_acknowledged"
        || isTerminalCodexTurnStatus(active.providerTerminalStatus)
      ) return true;
      throw buildCodexActiveInterruptStateUnknownError(
        this.sessionId ?? this.opts.threadId,
        active.clientTurnId,
        active.codexTurnId,
        new Error(`本地状态 ${active.providerTerminalStatus} 不是 provider 明确终态`),
      );
    }
    if (this.active !== active || !this.sessionId || !active.codexTurnId) {
      throw buildCodexActiveInterruptStateUnknownError(
        this.sessionId ?? this.opts.threadId,
        active.clientTurnId,
        active.codexTurnId,
        new Error("中断前 active turn 或 provider 绑定已变化"),
      );
    }
    const requestedProviderTurnId = active.codexTurnId;
    try {
      await ws.request("turn/interrupt", { threadId: this.sessionId, turnId: requestedProviderTurnId }, CODEX_RECOVERY_REQUEST_OPTIONS);
    } catch (error) {
      if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
      if (active.providerTerminalStatus && isTerminalCodexTurnStatus(active.providerTerminalStatus)) return true;
      try {
        await this.interruptReconciledActiveTurn(ws, active, requestedProviderTurnId, error);
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        if (active.providerTerminalStatus && isTerminalCodexTurnStatus(active.providerTerminalStatus)) return true;
        if (Boolean((cause as any)?.preserveRunningState)) throw cause;
        throw buildCodexActiveInterruptStateUnknownError(
          this.sessionId ?? this.opts.threadId,
          active.clientTurnId,
          requestedProviderTurnId,
          cause,
        );
      }
    }
    if (!active.providerTerminalStatus && this.active === active) {
      this.settleActiveAfterInterruptAcknowledged(active, active.codexTurnId ?? requestedProviderTurnId);
    }
    return true;
  }

  /** compact/start 未知态只接受明确 RPC 拒绝或已记录的 compact 专用 turnId。 */
  private reconcileUncertainCompactStart(
    active: ActiveTurn,
  ): "bound" | "settled" {
    const sessionId = this.sessionId;
    const state = active.compactStartState;
    if (!sessionId || !state || state.phase !== "unknown") {
      throw buildCodexActiveInterruptStateUnknownError(
        sessionId ?? this.opts.threadId,
        active.clientTurnId,
        active.codexTurnId,
        new Error("缺少 compact/start 未知态上下文"),
      );
    }

    const lateSettlement = state.lateSettlementResult;
    if (lateSettlement?.status === "rejected" && lateSettlement.kind === "rpc_error") {
      active.reject(lateSettlement.reason);
      return "settled";
    }
    const providerTurnId = this.bindActiveCompactTurnFromRecordedEvidence(active);
    if (providerTurnId) return "bound";
    throw buildCodexActiveInterruptStateUnknownError(
      sessionId,
      active.clientTurnId,
      null,
      buildCodexCompactOwnershipUnconfirmedError({
        sessionId,
        clientTurnId: active.clientTurnId,
        candidateTurnIds: Array.from(state.providerCompactTurnIds),
        cause: state.error ?? new Error(
          state.lateSettlementPending
            ? "compact/start 结果仍未结算"
            : "compact/start 尚未返回可精确中断的 provider turnId",
        ),
      }),
    );
  }

  /** 普通 turn 按最新 clientUserMessageId 恢复；调用方可收紧本地历史读取上限。 */
  private async bindLatestRunningProviderTurn(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    active: ActiveTurn,
    timeoutMs = 10_000,
  ): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      throw buildCodexActiveInterruptStateUnknownError(
        this.opts.threadId,
        active.clientTurnId,
        null,
        new Error("缺少 provider threadId"),
      );
    }

    let read: unknown;
    try {
      read = await this.readBoundedProviderTurnSnapshot(ws, sessionId, "full", timeoutMs);
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      throw buildCodexActiveInterruptStateUnknownError(sessionId, active.clientTurnId, null, cause);
    }
    if (this.active !== active || this.sessionId !== sessionId) {
      throw buildCodexActiveInterruptStateUnknownError(
        sessionId,
        active.clientTurnId,
        active.codexTurnId,
        new Error("provider turnId 对账期间 active turn 已变化"),
      );
    }

    const providerThreadId = String((read as any)?.thread?.id ?? "").trim();
    const threadStatus = normalizeCodexTurnStatus((read as any)?.thread?.status);
    const turns = Array.isArray((read as any)?.thread?.turns) ? ((read as any).thread.turns as any[]) : [];
    if (active.clientUserMessageIds.size > 0) {
      const latestClientUserMessageId = this.getLatestActiveClientUserMessageId(active);
      const ownedTurnMatch = latestClientUserMessageId
        ? matchCodexTurnsByClientUserMessageId(turns, latestClientUserMessageId)
        : { kind: "missing", turnIds: [] } as CodexClientIdTurnMatch;
      const turnListComplete = (read as any)?.thread?.__codeflowRecoveryTurnListComplete === true;
      if (ownedTurnMatch.kind === "ambiguous") {
        throw buildCodexTurnOwnershipAmbiguousError({
          sessionId,
          clientTurnId: active.clientTurnId,
          clientUserMessageId: latestClientUserMessageId ?? "missing",
          providerTurnIds: ownedTurnMatch.turnIds,
        });
      }
      const ownedTurnId = ownedTurnMatch.kind === "unique" && turnListComplete
        ? ownedTurnMatch.turnId
        : null;
      const ownedTurn = ownedTurnId
        ? turns.find((turn) => String(turn?.id ?? "").trim() === ownedTurnId) ?? null
        : null;
      const ownedTurnStatus = normalizeCodexTurnStatus(ownedTurn?.status);
      if (providerThreadId !== String(sessionId) || !ownedTurnId) {
        throw buildCodexActiveInterruptStateUnknownError(
          sessionId,
          active.clientTurnId,
          null,
          ownedTurnMatch.kind === "unique"
            ? new Error(
                `thread/turns/list 仍有更早历史，无法证明最新 clientUserMessageId=${latestClientUserMessageId ?? "missing"} 仅归属 turnId=${ownedTurnMatch.turnId}`,
              )
            : new Error(
                `thread/read 未确认最新 clientUserMessageId=${latestClientUserMessageId ?? "missing"} 对应的 provider turn：providerThreadId=${providerThreadId || "missing"}`,
              ),
        );
      }
      const correlation = latestClientUserMessageId
        ? this.pendingSteerCorrelationsByProviderClientKey.get(
            buildCodexProviderClientCorrelationKey(sessionId, latestClientUserMessageId),
          ) ?? null
        : null;
      if (
        correlation
        && correlation.clientTurnId === active.clientTurnId
        && (correlation.state === "pending" || correlation.state === "accepted")
      ) {
        this.confirmSteerOwnership(correlation, ownedTurnId, ownedTurnStatus, read);
      } else if (this.canAdvanceActiveOwnership(active, latestClientUserMessageId!)) {
        active.confirmedClientUserMessageSequence = this.ensureActiveClientUserMessageSequences(active)
          .get(latestClientUserMessageId!) ?? -1;
        if (active.codexTurnId && active.codexTurnId !== ownedTurnId) {
          this.replaceActiveCodexTurnId(active, ownedTurnId, "provider_lifecycle");
        } else {
          this.bindActiveCodexTurn(active, ownedTurnId, "provider_lifecycle");
        }
      }
      if (isTerminalCodexTurnStatus(ownedTurnStatus)) {
        if (!active.providerTerminalStatus) {
          this.settleActiveFromProviderTerminal(active, ownedTurnStatus, "turn.interrupt.ownership-recovery", read);
        }
        return;
      }
      if (!isRunningCodexTurnStatus(ownedTurnStatus)) {
        throw buildCodexActiveInterruptStateUnknownError(
          sessionId,
          active.clientTurnId,
          ownedTurnId,
          new Error(`已确权 provider turn 状态未知：turnStatus=${ownedTurnStatus || "missing"}, threadStatus=${threadStatus || "missing"}`),
        );
      }
      return;
    }
    if (active.compactStartState) {
      const outcome = this.reconcileCompactProviderTurnOwnershipFromRead(active, read, "provider-turn-id-recovery");
      if (outcome !== "unresolved") return;
      const error = buildCodexCompactOwnershipUnconfirmedError({
        sessionId,
        clientTurnId: active.clientTurnId,
        candidateTurnIds: Array.from(active.compactStartState.providerCompactTurnIds),
        cause: new Error(
          `thread/read 未返回 contextCompaction turn：providerThreadId=${providerThreadId || "missing"}, threadStatus=${threadStatus || "missing"}`,
        ),
      });
      throw buildCodexActiveInterruptStateUnknownError(sessionId, active.clientTurnId, null, error);
    }
    throw buildCodexActiveInterruptStateUnknownError(
      sessionId,
      active.clientTurnId,
      null,
      new Error("active turn 缺少 clientUserMessageId，拒绝按 latest provider turn 猜测归属"),
    );
  }

  /** 用有界 turn 列表读取状态；非法响应显式失败，禁止回退传输完整长历史。 */
  private async readBoundedProviderTurnSnapshot(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    sessionId: SessionId,
    itemsView: "full" | "notLoaded",
    timeoutMs = CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const listed = await ws.request(
      "thread/turns/list",
      {
        threadId: sessionId,
        limit: CODEX_OWNERSHIP_RECOVERY_TURN_LIMIT,
        sortDirection: "desc",
        itemsView,
      },
      {
        timeoutMs,
        trackLateSettlement: true,
        history: { itemTypes: this.active?.compactStartState ? ["contextCompaction"] : ["userMessage"] },
      },
    );
    if (!Array.isArray((listed as any)?.data)) {
      throw new Error(`thread/turns/list 返回非法结构：threadId=${sessionId}, itemsView=${itemsView}`);
    }
    const turns = (listed as any).data as any[];
    if (itemsView === "full") assertCodexFullTurnItems(turns, sessionId);
    const turnListComplete = isCodexTurnListComplete(
      listed,
      turns,
      CODEX_OWNERSHIP_RECOVERY_TURN_LIMIT,
    );
    return {
      thread: {
        id: sessionId,
        status: null,
        turns,
        __codeflowRecoveryTurnListComplete: turnListComplete,
      },
    };
  }

  /** 按 cursor 有界扫描 clientId ownership；多义可提前返回，超出页数则显式标记不完整。 */
  private async readProviderTurnOwnershipEvidence(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    sessionId: SessionId,
    clientUserMessageId: string,
    timeoutMs: number,
  ): Promise<CodexProviderTurnOwnershipEvidence> {
    const turnsById = new Map<string, any>();
    const seenCursors = new Set<string>();
    const deadlineAt = Date.now() + timeoutMs;
    let cursor: string | null = null;
    const incomplete = (cause: Error): CodexProviderTurnOwnershipEvidence => {
      const turns = Array.from(turnsById.values());
      return {
        turns,
        match: matchCodexTurnsByClientUserMessageId(turns, clientUserMessageId),
        complete: false,
        incompleteCause: cause,
      };
    };
    for (let page = 0; page < CODEX_OWNERSHIP_RECOVERY_MAX_PAGES; page += 1) {
      const remainingTimeoutMs = deadlineAt - Date.now();
      if (remainingTimeoutMs <= 0) {
        throw new Error(`thread/turns/list ownership 分页超时：threadId=${sessionId}, page=${page + 1}`);
      }
      const listed = await ws.request(
        "thread/turns/list",
        {
          threadId: sessionId,
          limit: CODEX_OWNERSHIP_RECOVERY_TURN_LIMIT,
          sortDirection: "desc",
          itemsView: "full",
          ...(cursor ? { cursor } : {}),
        },
        { timeoutMs: remainingTimeoutMs, trackLateSettlement: true, history: { itemTypes: ["userMessage"] } },
      );
      if (!Array.isArray((listed as any)?.data)) {
        return incomplete(new Error(`thread/turns/list 返回非法结构：threadId=${sessionId}`));
      }
      const pageTurns = (listed as any).data as any[];
      try {
        assertCodexFullTurnItems(pageTurns, sessionId);
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        return incomplete(cause instanceof Error ? cause : new Error(String(cause)));
      }
      for (const turn of pageTurns) {
        const providerTurnId = String(turn?.id ?? "").trim();
        if (turnsById.has(providerTurnId)) {
          return incomplete(new Error(
            `thread/turns/list ownership 分页包含重复 turnId：threadId=${sessionId}, turnId=${providerTurnId}`,
          ));
        }
        turnsById.set(providerTurnId, turn);
      }
      const turns = Array.from(turnsById.values());
      const match = matchCodexTurnsByClientUserMessageId(turns, clientUserMessageId);
      if (match.kind === "ambiguous") return { turns, match, complete: true };

      const hasExplicitNextCursor = Object.prototype.hasOwnProperty.call(listed as object, "nextCursor");
      const nextCursor = hasExplicitNextCursor
        ? String((listed as any)?.nextCursor ?? "").trim()
        : "";
      if ((hasExplicitNextCursor && !nextCursor) || (!hasExplicitNextCursor && pageTurns.length < CODEX_OWNERSHIP_RECOVERY_TURN_LIMIT)) {
        return { turns, match, complete: true };
      }
      if (!nextCursor || seenCursors.has(nextCursor)) {
        return incomplete(new Error(
          `thread/turns/list ownership 分页游标不完整：threadId=${sessionId}, cursor=${nextCursor || "missing"}`,
        ));
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return incomplete(new Error(
      `thread/turns/list ownership 分页超过安全上限：threadId=${sessionId}, pages=${CODEX_OWNERSHIP_RECOVERY_MAX_PAGES}`,
    ));
  }

  /** 对 provider mismatch 只恢复本地输入确权的 turn，绝不追赶线程中的 Goal continuation。 */
  private async interruptReconciledActiveTurn(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    active: ActiveTurn,
    requestedProviderTurnId: string,
    interruptError: unknown,
  ): Promise<void> {
    const sessionId = this.sessionId;
    const initialExpectedTurnId = String(requestedProviderTurnId ?? "").trim();
    const interruptMessage = interruptError instanceof Error ? interruptError.message : String(interruptError ?? "");
    if (sessionId && initialExpectedTurnId && hasCodexThreadUnavailableSignal(interruptMessage)) {
      await this.resumeAndInterruptLatestActiveTurn(ws, active, sessionId, initialExpectedTurnId);
      return;
    }
    throw interruptError;
  }

  /** app-server 不可用时恢复同一 thread，并让同一精确 interrupt 的重试结果直接裁决。 */
  private async resumeAndInterruptLatestActiveTurn(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    active: ActiveTurn,
    sessionId: SessionId,
    expectedTurnId: string,
  ): Promise<void> {
    let resumeCause: unknown = null;
    try {
      await ws.request("thread/resume", await this.withDatabase(() => this.buildCurrentCodexResumeParams(sessionId)), CODEX_RECOVERY_REQUEST_OPTIONS);
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      resumeCause = cause;
    }
    try {
      await ws.request("turn/interrupt", { threadId: sessionId, turnId: expectedTurnId }, CODEX_RECOVERY_REQUEST_OPTIONS);
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      throw combineCodexResumeAndInterruptFailures(resumeCause, cause);
    }
    this.log("info", () => ({ message: "turn interrupt retried with exact target after app-server restart", data: {
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      sessionId,
      clientTurnId: active.clientTurnId,
      providerTurnId: expectedTurnId,
    } }));
  }

  /** 按 provider 权威状态结算 active，completed 不得被改写为 manual interrupt。 */
  private settleActiveFromProviderTerminal(
    active: ActiveTurn,
    status: string,
    reason: string,
    threadRead: unknown,
  ): void {
    active.providerTerminalStatus = status;
    if (this.active !== active) return;
    this.releaseActiveProviderInputImages(active, "provider_turn_terminal");
    if (status === "completed") {
      active.resolve({ reason, turnStatus: status, threadRead });
      return;
    }
    active.reject(
      active.interruptTerminalError && !active.manualInterruptRequested
        ? active.interruptTerminalError
        : buildCodexTurnTerminalError(active, status, reason),
    );
  }

  /** 调用已返回且原运行 owner 已收口后才释放凭据，未知启动继续占有。 */
  private releaseSettledCredential(): void {
    if (this.credentialCallPending || this.hasActiveTurn() || this.hasPendingProviderMutationFence() || this.pendingInterruptedStartingTurns.size || this.pendingInterruptedProviderCompensationsByKey.size || [...this.pendingSteerCorrelationsByProviderClientKey.values()].some(correlation => correlation.state === 'interrupted')) return;
    const credential = this.credentialLease; this.credentialLease = undefined; credential?.release();
  }

  /** 清理启动态并唤醒等待启动交接的中断/追加请求。 */
  private finishStartingTurn(startingTurn: StartingTurn): void {
    if (this.startingTurn === startingTurn) this.startingTurn = null;
    startingTurn.settle();
    this.releaseSettledCredential();
  }

  /** 仅使用双向确权映射读取终态，不能把同 provider thread 的其他回合判给本地请求。 */
  getObservedTurnTerminalStatus(turnId: TurnId): string | null {
    const providerTurnId = this.codexTurnIdByClientTurnId.get(turnId);
    if (!providerTurnId || this.clientTurnIdByCodexTurnId.get(providerTurnId) !== turnId) return null;
    const status = (this.active?.clientTurnId === turnId ? this.active.providerTerminalStatus : null)
      ?? this.terminalObservedProviderTurnStatusById.get(providerTurnId);
    return status && isTerminalCodexTurnStatus(status) ? status : null;
  }

  /** 确认进程树终止后结束本地等待；canonical 终态仍由共享结算入口唯一落库。 */
  invalidateAfterProcessTermination(): void {
    this.disposed = true;
    const active = this.active;
    active?.timeoutController.stop();
    if (active?.codexTurnId && active.providerTerminalStatus && isTerminalCodexTurnStatus(active.providerTerminalStatus)) {
      this.terminalObservedProviderTurnStatusById.set(active.codexTurnId, active.providerTerminalStatus);
    }
    for (const startingTurn of new Set([
      this.startingTurn,
      this.pendingHandoffStartingTurn,
      this.active?.providerOwnershipStartingTurn ?? null,
    ])) {
      if (!startingTurn) continue;
      this.clearStartingTurnOwnershipRecoveryTimer(startingTurn);
      this.releaseStartingTurnLateSettlement(startingTurn);
      startingTurn.interruptRequested = true;
      startingTurn.signalPreflightInterrupt();
      startingTurn.acknowledgeStartupInterrupt();
      startingTurn.resolveInterruptFinalized();
      this.finishStartingTurn(startingTurn);
    }
    if (active && !active.providerTerminalStatus) active.reject(createManualInterruptError());
    this.active = null;
    this.pendingHandoffStartingTurn = null;
    this.clearDetachedProviderRecovery();
    this.clearReconnectRecovery();
    this.emitters = null;
    this.releaseSettledCredential();
  }

  /** 仅在 provider turn、配置刷新退订与历史回滚均已收口后释放本地 binding。 */
  async dispose(options?: import("../threadSession.js").ThreadDisposeOptions): Promise<void> {
    try { return await this.disposeOnce(options); }
    catch (cause) {
      if (!this.diagnosticFailure || this.disposed) throw cause;
      try { await this.disposeOnce(options); }
      catch (cleanup) {
        if (cause === cleanup) throw cause;
        throw new AggregateError([cause, cleanup], "Codex 会话释放及诊断清理失败", { cause });
      }
      throw cause;
    }
  }

  /** 沿原释放入口清理会话；诊断失败分支尝试进程与图片清理后仍显式拒绝。 */
  private async disposeOnce(options?: import("../threadSession.js").ThreadDisposeOptions): Promise<void> {
    const preparing = this.credentialCallPending;
    if (preparing?.preparing) {
      preparing.phase = "draining";
      await preparing.settled;
    }
    if (this.diagnosticFailure) {
      const failures: unknown[] = [this.diagnosticFailure.reason];
      let processStopped = false;
      try {
        await this.opts.manager.getExisting?.(this.opts.workspaceId)?.kill();
        processStopped = true;
        this.invalidateAfterProcessTermination();
      }
      catch (cause) { failures.push(cause); }
      for (const lease of this.providerInputImageLeases) {
        try { lease.close("diagnostic_failure_dispose"); const error = lease.getError(); if (error) failures.push(error); }
        catch (cause) { failures.push(cause); }
      }
      try { await this.opts.manager.drainMessages?.(); }
      catch (cause) { failures.push(cause); }
      if (processStopped) {
        try { this.resetThreadBinding(); }
        catch (cause) { failures.push(cause); }
      }
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, "Codex 会话诊断失败，清理后仍需处理原错误", { cause: failures[0] });
    }
    (await this.withDatabase(() => this.retryPendingSessionBindingDrop()));
    if (this.pendingConfigRefreshUnsubscribe) {
      throw new Error(
        `Codex thread/unsubscribe 结果未结算，拒绝释放 thread session：threadId=${this.opts.threadId}, sessionId=${this.pendingConfigRefreshUnsubscribe.sessionId}`,
      );
    }
    if (this.historyRollbackInProgress) {
      throw new Error(`Codex 历史回滚仍在执行，拒绝释放 thread session：threadId=${this.opts.threadId}`);
    }
    const activeTurnId = this.getActiveTurnId();
    const flushActiveTurn = options?.flushActiveTurn !== false;
    if (activeTurnId) {
      try {
        await this.interrupt(activeTurnId);
      } catch (error) {
        throw new Error(
          `Codex active turn 中断未确认，拒绝释放 thread session：threadId=${this.opts.threadId}, turnId=${activeTurnId}`,
          { cause: error },
        );
      }
      if (flushActiveTurn) {
        if (this.activeTurnSettled) await waitForCodexDisposeSettlement(this.activeTurnSettled, 3_000, this.opts.threadId, activeTurnId);
        else await waitForCodexTurnInactive(() => Boolean(this.startingTurn || this.active || this.hasPendingProviderMutationFence()),
          3_000, this.opts.threadId, activeTurnId);
      }
      if (this.startingTurn || this.active || this.hasPendingProviderMutationFence()) {
        throw new Error(
          `Codex provider turn 仍未收口，拒绝释放 thread session：threadId=${this.opts.threadId}, turnId=${activeTurnId}`,
        );
      }
    }
    this.assertProviderInputImagesReleased();
    const pendingProviderMutationFenceTurnId = this.getPendingProviderMutationFenceTurnId();
    const detachedStartingTurnId = this.pendingInterruptedStartingTurns.keys().next().value as TurnId | undefined;
    const detachedSteer = Array.from(this.pendingSteerCorrelationsByProviderClientKey.values())
      .find((correlation) => correlation.state === "interrupted") ?? null;
    if (
      pendingProviderMutationFenceTurnId
      || detachedStartingTurnId
      || detachedSteer
      || this.pendingInterruptedProviderCompensationsByKey.size > 0
    ) {
      throw new Error(
        `Codex detached provider mutation 仍未收口，拒绝释放 thread session：threadId=${this.opts.threadId}, turnId=${pendingProviderMutationFenceTurnId ?? detachedStartingTurnId ?? detachedSteer?.clientTurnId ?? "unknown"}`,
      );
    }
    if (options?.reason === "idle" && this.sessionId) {
      const sessionId = this.sessionId;
      try {
        const ws = this.opts.manager.getExisting(this.opts.workspaceId);
        if (ws?.isRunning()) {
          await ws.request("thread/unsubscribe", { threadId: sessionId }, { timeoutMs: 10_000 });
        }
      } catch (error) {
        this.log("warn", () => ({ message: "idle dispose thread/unsubscribe failed", data: {
          cleanupCode: "codex_thread_unsubscribe_cleanup_failed",
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId,
          cleanupReason: "idle_dispose",
          errorCode: String(engineDiagnosticField(error, "code") ?? "").trim() || null,
          error: engineDiagnosticCause(error),
          impact: "the remote subscription may remain until the app-server unload grace period",
          compensation: "the local binding is released immediately and process exit clears the remote subscription",
        } }), { reason: error });
        throw error;
      }
    }
    await this.opts.manager.drainMessages?.();
    this.disposed = true;
    this.clearDetachedProviderRecovery();
    this.emitters = null;
    this.assistantLifecycle.clear();
    this.activeTurnSettled = null;
    this.resetThreadBinding();
  }

  /** 响应 app-server 的 requestApproval（accept/decline）。 */
  async respondApproval(requestId: number | string, decision: "accept" | "decline"): Promise<void> {
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    const key = String(requestId);
    const pending = this.pendingRequests.get(key);
    if (!pending || pending.kind !== "approval") throw new Error("approval request 不存在或已处理");
    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    await ws.respond(pending.id, { decision });
    this.pendingRequests.delete(key);
    this.emitters?.conversation({
      ts: Date.now(),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId as any,
      engine: "codex",
      type: "approval.resolved",
      payload: { requestId, approved: decision === "accept" },
    });
  }

  /** 仅回传仍在执行的补充输入；终止后拒绝提交，发送失败保留请求供重试。 */
  async respondUserInput(requestId: number | string, answers: RequestUserInputResponse["answers"]): Promise<void> {
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    const key = String(requestId);
    const pending = this.pendingRequests.get(key);
    if (!pending || pending.kind !== "userInput") throw new Error("userInput request 不存在或已处理");
    const active = this.active;
    if (!active || active.manualInterruptRequested || active.providerTerminalStatus || active.interruptPromise || active.interruptTerminalError) {
      throw Object.assign(new Error("补充输入请求已失效，请等待当前回合结束。"), { code: "USER_INPUT_REQUEST_EXPIRED" });
    }
    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    await ws.respond(pending.id, { answers });
    this.pendingRequests.delete(key);
    this.emitters?.conversation({
      ts: Date.now(),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId as any,
      engine: "codex",
      type: "userInput.resolved",
      payload: { response: { requestId, answers } },
    });
  }

  private supportsNativeDynamicTools(): boolean {
    if (this.opts.supportsNativeDynamicTools) return this.opts.supportsNativeDynamicTools();
    const runtimeConfig = this.credentialLease?.config ?? this.opts.resolveCodexRuntimeConfig?.();
    if (runtimeConfig) return supportsCodexNativeDynamicToolTransport(runtimeConfig.baseUrl ?? null);
    return supportsCodexNativeDynamicToolTransport(readEngineConfig("codex").baseUrl ?? null);
  }

  /** 读取当前 Client 运行时对应的 app-server provider；无托管配置时保留原生配置。 */
  private resolveCurrentCodexModelProvider(): string | null {
    const resolver = this.opts.resolveCodexRuntimeConfig;
    if (!resolver) return null;
    return resolveCodexAppServerModelProvider(this.credentialLease?.config ?? resolver());
  }

  /** 为旧恢复调用生成带当前 provider 的最小 thread/resume 参数。 */
  private buildCurrentCodexResumeParams(sessionId: SessionId): Record<string, unknown> {
    const modelProvider = this.resolveCurrentCodexModelProvider();
    return {
      threadId: sessionId,
      ...(modelProvider ? { modelProvider } : {}),
    };
  }

  /** 读取并校验 provider Goal；null 表示线程没有持久 Goal。 */
  private async readProviderThreadGoalStatus(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    sessionId: SessionId,
  ): Promise<string | null> {
    const goalResponse = await ws.request(
      "thread/goal/get",
      { threadId: sessionId },
      { timeoutMs: CODEX_PROVIDER_GOAL_READ_TIMEOUT_MS },
    );
    if (!goalResponse || typeof goalResponse !== "object" || !Object.prototype.hasOwnProperty.call(goalResponse, "goal")) {
      throw new Error(`thread/goal/get 返回非法结构：threadId=${sessionId}`);
    }
    const goal = (goalResponse as any).goal;
    if (goal == null) return null;
    const goalThreadId = String(goal?.threadId ?? "").trim();
    const goalStatus = normalizeCodexThreadGoalStatus(goal?.status);
    if (goalThreadId !== String(sessionId) || !goalStatus) {
      throw new Error(
        `thread/goal/get 返回非法 Goal：threadId=${sessionId}, goalThreadId=${goalThreadId || "missing"}, goalStatus=${String(goal?.status ?? "missing")}`,
      );
    }
    return goalStatus;
  }

  /** 捕获本次输入准入 token；后续 provider lifecycle 事件会使它失效。 */
  private captureProviderInputAdmission(
    providerThreadId: SessionId,
    foreignActiveTurnId: string | null,
    foreignGoalStatus: string | null = null,
  ): CodexProviderInputAdmission {
    return {
      providerThreadId,
      lifecycleEventVersion: this.providerLifecycleEventVersion,
      foreignActiveTurnId,
      foreignGoalStatus,
    };
  }

  /** 拒绝已有 foreign Goal/turn，且保留具体 mutation 上下文用于排障。 */
  private assertProviderMutationAdmissionAvailable(
    admission: CodexProviderInputAdmission,
    context: CodexProviderMutationContext,
  ): void {
    this.assertDiagnosticReady();
    const foreignActiveTurnId = admission.foreignActiveTurnId;
    const foreignGoalStatus = admission.foreignGoalStatus;
    if (!foreignActiveTurnId && !foreignGoalStatus) return;
    const operationLabel = context.operation === "rollback"
      ? "回滚线程历史"
      : context.operation === "compact"
        ? "压缩线程"
        : "发送新消息";
    const error = Object.assign(new Error(
      foreignGoalStatus
        ? `Codex provider thread 存在未完成 Goal，拒绝${operationLabel}（threadId=${admission.providerThreadId}, goalStatus=${foreignGoalStatus}）`
        : `Codex provider thread 正在执行非本地回合，拒绝${operationLabel}（threadId=${admission.providerThreadId}, providerTurnId=${foreignActiveTurnId}）`,
    ), {
      code: "codex_provider_foreign_active",
      providerThreadId: admission.providerThreadId,
      providerTurnId: foreignActiveTurnId,
      providerGoalStatus: foreignGoalStatus,
      providerMutation: context.operation,
    });
    this.log("warn", () => ({ message: "provider thread is already active before local mutation", data: {
      code: engineDiagnosticField(error, "code"),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      providerThreadId: admission.providerThreadId,
      providerTurnId: foreignActiveTurnId,
      providerGoalStatus: foreignGoalStatus,
      providerMutation: context.operation,
      clientTurnId: context.clientTurnId,
      clientUserMessageId: context.clientUserMessageId,
    } }));
    throw error;
  }

  /** mutation 前复核 provider thread、lifecycle version 与 foreign live head。 */
  private assertProviderMutationAdmissionCurrent(
    admission: CodexProviderInputAdmission,
    context: CodexProviderMutationContext,
  ): void {
    this.assertDiagnosticReady();
    const currentProviderThreadId = this.sessionId;
    const currentForeignActiveTurnId = (
      isNonTerminalCodexThreadStatus(this.observedProviderThreadStatus ?? "")
      && this.observedProviderActiveTurnId
    ) ? this.observedProviderActiveTurnId : null;
    const lifecycleChanged = this.providerLifecycleEventVersion !== admission.lifecycleEventVersion;
    const sessionChanged = currentProviderThreadId !== admission.providerThreadId;
    if (!lifecycleChanged && !sessionChanged && !currentForeignActiveTurnId) return;

    const code = currentForeignActiveTurnId
      ? "codex_provider_foreign_active"
      : "codex_provider_active_preflight_stale";
    const operationLabel = context.operation === "rollback"
      ? "回滚线程历史"
      : context.operation === "compact"
        ? "压缩线程"
        : "发送新消息";
    const error = Object.assign(new Error(
      currentForeignActiveTurnId
        ? `Codex provider thread 在准入后启动了非本地回合，拒绝${operationLabel}（threadId=${admission.providerThreadId}, providerTurnId=${currentForeignActiveTurnId}）`
        : `Codex provider lifecycle 在准入后发生变化，拒绝${operationLabel}（threadId=${admission.providerThreadId}, clientTurnId=${context.clientTurnId ?? "none"}）`,
    ), {
      code,
      providerThreadId: admission.providerThreadId,
      providerTurnId: currentForeignActiveTurnId,
      clientTurnId: context.clientTurnId,
      providerMutation: context.operation,
    });
    this.log("warn", () => ({ message: "provider admission became stale before mutation", data: {
      code,
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      providerThreadId: admission.providerThreadId,
      currentProviderThreadId,
      providerMutation: context.operation,
      clientTurnId: context.clientTurnId,
      clientUserMessageId: context.clientUserMessageId,
      providerTurnId: currentForeignActiveTurnId,
      lifecycleChanged,
      sessionChanged,
    } }));
    throw error;
  }

  /** 必需工具未注册时显式失败；已注册工具允许停用，执行仍以本轮 registry 为准。 */
  private async ensureThreadSession(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    emit: ConversationEmitFn,
    accessMode: AccessMode,
    contextWindow: number | null,
    autoCompactPct: number | null,
    modelProvider: string | null,
    model: string | null,
    developerInstructions: string | null,
    threadConfigOverrides: ReturnType<typeof resolveCodexThreadConfigOverrides>,
    dynamicTools: Array<{ name: string; description: string; inputSchema: unknown }>,
    requestedDynamicToolIds: string[],
    dynamicToolBindingVersion: string | null,
    sessionCapabilities: ThreadSessionCapabilities | null,
    platformToolTransportRequirement: PlatformToolTransportRequirement,
    startingTurn: StartingTurn,
    recoveryOperation: "turn_start" | "compact_start",
  ): Promise<{
    didThreadStart: boolean;
    didThreadResume: boolean;
  }> {
    if (this.disposed) throw createManualInterruptError();
    // 动态工具只能在 thread/start 注册；必需工具必须已绑定，关闭工具不清除旧会话上下文。
    if (
      this.sessionId
      && platformToolTransportRequirement === "required"
      && requestedDynamicToolIds.length > 0
      && !this.currentSessionSupportsDynamicToolBinding(requestedDynamicToolIds, dynamicToolBindingVersion)
    ) {
      const error = buildCodexProviderThreadRecoveryError({
        code: "codex_thread_capability_incompatible",
        providerThreadId: this.sessionId,
        reason: "dynamic_tool_binding_changed",
        message: "当前 Codex 会话绑定的动态工具与本轮不一致，已保留原上下文并停止发送。请新建会话后重试。",
      });
      this.log("error", () => ({ message: "dynamic tool binding changed before provider mutation", data: {
        code: "codex_thread_capability_incompatible", requestId: startingTurn.clientTurnId,
        workspaceId: this.opts.workspaceId, threadId: this.opts.threadId,
        providerThreadId: this.sessionId, appliedToolIds: this.listAppliedDynamicToolIds(),
        requestedToolIds: requestedDynamicToolIds, rootCause: engineDiagnosticCause(error),
      } }));
      throw error;
    }
    let didThreadStart = false;
    let didThreadResume = false;
    // 未决 unsubscribe 是此前已经发出的配置刷新 mutation，只能先等待其结算。
    // 对仍持有 binding 的普通配置变化，不得在恢复前 unsubscribe；resume(E) 自身携带新 config。
    if (this.pendingConfigRefreshUnsubscribe) {
      await this.unloadThreadForConfigRefresh(ws);
    }
    const boundConfigChanged = Boolean(
      this.sessionId
      && (
        this.appliedContextWindow !== threadConfigOverrides.modelContextWindow
        || this.appliedModelAutoCompactTokenLimit !== threadConfigOverrides.modelAutoCompactTokenLimit
        || this.appliedModel !== model
        || !this.hasAppliedDeveloperInstructions
        || this.appliedDeveloperInstructions !== developerInstructions
      )
    );

    const startNewThread = async (): Promise<void> => {
      this.credentialLease?.assertCurrent();
      const started = await ws.request(
        "thread/start",
        buildThreadStartRequestParams({
          cwd: this.opts.workspacePath,
          accessMode,
          contextWindow,
          autoCompactPct,
          modelProvider,
          dynamicTools,
          developerInstructions,
        }),
        { timeoutMs: 20_000 },
      );
      const threadId = extractThreadIdFromResult(started);
      if (this.disposed) throw createManualInterruptError();
      if (!threadId) throw new Error("Codex thread/start 返回缺少 thread.id");
      const nextSessionId = threadId as SessionId;
      const nextSessionCapabilities = null;
      await this.withDatabase(() => {
        this.assertThreadStartBindingOwner(startingTurn, nextSessionId);
        this.opts.onSessionBinding(nextSessionId, nextSessionCapabilities);
        this.sessionId = nextSessionId;
        this.sessionCapabilities = nextSessionCapabilities;
      });
      this.appliedContextWindow = threadConfigOverrides.modelContextWindow;
      this.appliedModelAutoCompactTokenLimit = threadConfigOverrides.modelAutoCompactTokenLimit;
      this.appliedModel = model;
      this.appliedDeveloperInstructions = developerInstructions;
      this.hasAppliedDeveloperInstructions = true;
      emit({
        ts: Date.now(),
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId as any,
        engine: "codex",
        type: "thread.started",
        payload: { sessionId: nextSessionId, sessionCapabilities: this.sessionCapabilities },
      } satisfies ConversationEventInput);
      didThreadStart = true;
    };

    if (this.sessionId && (!this.resumed || boundConfigChanged)) {
      const expectedSessionId = this.sessionId;
      await this.resumeBoundProviderThreadForMutation(
        ws,
        expectedSessionId,
        accessMode,
        contextWindow,
        autoCompactPct,
        modelProvider,
        model,
        developerInstructions,
        threadConfigOverrides,
        recoveryOperation,
      );
      didThreadResume = true;
    }

    if (!this.sessionId) await startNewThread();

    if (this.disposed) throw createManualInterruptError();
    if (!this.registered && this.sessionId) {
      this.unregister = ws.registerThread(this.sessionId, (msg) => this.onAppServerMessage(msg));
      this.registered = true;
    }

    return { didThreadStart, didThreadResume };
  }

  /** 直接调用 thread/resume；RPC 成功即恢复，失败原样交给调用方处理。 */
  private async resumeBoundProviderThreadForMutation(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    expectedSessionId: SessionId,
    accessMode: AccessMode,
    contextWindow: number | null,
    autoCompactPct: number | null,
    modelProvider: string | null,
    model: string | null,
    developerInstructions: string | null,
    threadConfigOverrides: ReturnType<typeof resolveCodexThreadConfigOverrides>,
    recoveryOperation: "turn_start" | "compact_start",
  ): Promise<void> {
    if (!this.registered) {
      this.unregister = ws.registerThread(expectedSessionId, (msg) => this.onAppServerMessage(msg));
      this.registered = true;
    }

    // 恢复请求尚未成功前保留门禁，避免失败后的下一次发送跳过 resume。
    this.beginRecoveryAttempt(expectedSessionId);
    try {
      this.credentialLease?.assertCurrent();
      await ws.request(
        "thread/resume",
        buildThreadResumeRequestParams({
          threadId: expectedSessionId,
          cwd: this.opts.workspacePath,
          accessMode,
          contextWindow,
          autoCompactPct,
          modelProvider,
          developerInstructions,
        }),
        CODEX_RECOVERY_REQUEST_OPTIONS,
      );
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      this.observeLateProviderRecoverySettlement(expectedSessionId, cause, threadConfigOverrides);
      throw cause;
    }

    if (this.disposed) throw createManualInterruptError();
    this.resumed = true;
    this.recoveryPending = false;
    this.appliedContextWindow = threadConfigOverrides.modelContextWindow;
    this.appliedModelAutoCompactTokenLimit = threadConfigOverrides.modelAutoCompactTokenLimit;
    this.appliedModel = model;
    this.appliedDeveloperInstructions = developerInstructions;
    this.hasAppliedDeveloperInstructions = true;
    this.log("info", () => ({ message: "bound provider thread recovered for mutation", data: {
      code: "codex_bound_provider_thread_recovered",
      requestId: null,
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      providerThreadId: expectedSessionId,
      recoveryReason: recoveryOperation,
    } }));
  }

  /** 监听恢复 RPC 的迟到结果；成功后解除本地 recovery fence，失败则保留待确认状态。 */
  private observeLateProviderRecoverySettlement(
    expectedSessionId: SessionId,
    cause: unknown,
    threadConfigOverrides: ReturnType<typeof resolveCodexThreadConfigOverrides>,
  ): void {
    const lateSettlement = extractCodexLateSettlement(cause);
    if (!lateSettlement || this.observedRecoverySettlements.has(lateSettlement)) return;
    this.observedRecoverySettlements.add(lateSettlement);
    this.observeDiagnosticTask(() => (lateSettlement.then((settlement) => {
      if (this.disposed || this.sessionId !== expectedSessionId) return;
      if (settlement.status === "fulfilled") {
        const providerThreadId = extractThreadIdFromResult(settlement.value);
        if (providerThreadId && providerThreadId !== String(expectedSessionId)) {
          this.log("error", () => ({ message: "late thread/resume settlement returned mismatched thread", data: {
            code: "codex_late_thread_resume_identity_mismatch",
            requestId: null,
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            expectedProviderThreadId: expectedSessionId,
            actualProviderThreadId: providerThreadId,
          } }));
          return;
        }
        this.resumed = true;
        this.recoveryPending = false;
        this.appliedContextWindow = threadConfigOverrides.modelContextWindow;
        this.appliedModelAutoCompactTokenLimit = threadConfigOverrides.modelAutoCompactTokenLimit;
        this.log("info", () => ({ message: "late thread/resume settlement confirmed recovery", data: {
          code: "codex_late_thread_resume_recovered",
          requestId: null,
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          providerThreadId: expectedSessionId,
        } }));
        return;
      }
      this.log("error", () => ({ message: "late thread/resume settlement failed", data: {
        code: "codex_late_thread_resume_failed",
        requestId: null,
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        providerThreadId: expectedSessionId,
        settlementKind: settlement.kind,
        rootCause: settlement.reason.message,
      } }));
    }).catch((lateError) => {
      this.log("error", () => ({ message: "late thread/resume settlement observer failed", data: {
        code: "codex_late_thread_resume_observer_failed",
        requestId: null,
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        providerThreadId: expectedSessionId,
        rootCause: engineDiagnosticCause(lateError),
      } }), { reason: lateError });
    })));
    if (cause && typeof cause === "object") {
      const tagged = cause as Error & { recoveryPending?: boolean; preserveBinding?: boolean };
      tagged.recoveryPending = true;
      tagged.preserveBinding = true;
    }
  }

  /** 配置刷新前解除远端订阅；结果未知时保留绑定并阻止后续 provider mutation。 */
  private async unloadThreadForConfigRefresh(ws: ReturnType<CodexAppServerManager["getOrCreate"]>): Promise<void> {
    const pendingFence = this.pendingConfigRefreshUnsubscribe;
    if (pendingFence) {
      if (this.sessionId !== pendingFence.sessionId) {
        throw new Error(
          `Codex thread/unsubscribe 未决结果与当前绑定不一致：pending=${pendingFence.sessionId}, current=${this.sessionId ?? "none"}`,
        );
      }
      const settlement = await pendingFence.settlement;
      if (this.pendingConfigRefreshUnsubscribe === pendingFence) {
        this.pendingConfigRefreshUnsubscribe = null;
      }
      if (settlement.status === "rejected") {
        const failure = Object.assign(new Error(
          `Codex thread/unsubscribe 迟到结算失败（threadId=${pendingFence.sessionId}, kind=${settlement.kind}）`,
          { cause: settlement.reason },
        ), {
          code: "codex_thread_unsubscribe_late_settlement_failed",
          method: "thread/unsubscribe",
          sessionId: pendingFence.sessionId,
        });
        this.log("error", () => ({ message: "config refresh thread/unsubscribe late settlement failed", data: {
          code: "codex_thread_unsubscribe_late_settlement_failed",
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId: pendingFence.sessionId,
          settlementKind: settlement.kind,
          rootCause: engineDiagnosticCause(settlement.reason),
        } }), { reason: failure });
        throw failure;
      }
      this.resetThreadBinding();
      return;
    }

    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    try {
      await ws.request(
        "thread/unsubscribe",
        { threadId: sessionId },
        { timeoutMs: 10_000, trackLateSettlement: true },
      );
    } catch (error) {
      if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
      const lateSettlement = extractCodexLateSettlement(error);
      if (lateSettlement) {
        this.pendingConfigRefreshUnsubscribe = { sessionId, settlement: lateSettlement };
      }
      this.log(lateSettlement ? "warn" : "error", () => ({
        message: lateSettlement ? "config refresh thread/unsubscribe outcome unknown" : "config refresh thread/unsubscribe failed",
        data: {
          code: lateSettlement ? "codex_thread_unsubscribe_outcome_unknown" : "codex_thread_unsubscribe_failed",
          workspaceId: this.opts.workspaceId, threadId: this.opts.threadId, sessionId,
          rootCause: engineDiagnosticCause(error),
          impact: lateSettlement
            ? "the local binding is retained and provider mutations stay blocked until the request settles"
            : "the local binding is retained and the config refresh is rejected",
        },
      }), { reason: error });
      throw error;
    }
    this.resetThreadBinding();
  }

  /** 将 app-server 消息路由到当前 turn，并按既有 owner 保留错位事件的 raw trace。 */
  private onAppServerMessage(msg: CodexAppServerMessage): void {
    if (this.disposed) return;
    this.assertDiagnosticReady();
    const method = String((msg as any).method ?? "");
    const params = (msg as any).params as Record<string, unknown> | undefined;
    const providerTurnId = this.extractCodexEventTurnId(method, params);
    const providerTurnWasTerminal = providerTurnId
      ? this.terminalObservedProviderTurnStatusById.has(providerTurnId)
      : false;
    this.observeProviderThreadLifecycle(method, params, providerTurnId);
    const emitters = this.emitters;
    if (!emitters) return;
    const outerEmitConversation = emitters.conversation;
    const outerEmitRaw = emitters.raw;

    const buffered: ConversationEventInput[] = [];
    const emittedTypes = new Set<string>();
    const emitBuffered: ConversationEmitFn = (event) => {
      buffered.push(event);
      emittedTypes.add(String((event as any)?.type ?? ""));
    };

    // JSON-RPC request（需要 Web 决策后回响应）
    const requestId = (msg as any).id as unknown;
    const isRequest = requestId !== undefined && method && !("result" in (msg as any)) && !("error" in (msg as any));
    const providerToolsDenied = providerNativeToolsDenied(this.currentProviderNativeToolPolicy);
    const interactionToolsAllowed = providerNativeInteractionToolsAllowed(this.currentProviderNativeToolPolicy);

    let handled = false;
    let ignoredTurnScopedProviderEvent = false;
    let rawClientTurnId: TurnId | null = providerTurnId
      ? this.clientTurnIdByCodexTurnId.get(providerTurnId) ?? null
      : null;
    const isProviderInteractionRequest = Boolean(
      isRequest
      && (
        method.includes("requestApproval")
        || method === "item/tool/requestUserInput"
        || method === "item/tool/call"
      ),
    );
    const requestActive = this.active;
    const providerRequestOwnedByActive = Boolean(
      providerTurnId
      && requestActive?.codexTurnId === providerTurnId
      && !requestActive.providerTerminalStatus
      && !requestActive.manualInterruptRequested
      && !requestActive.interruptTerminalError
      && !requestActive.interruptPromise,
    );
    if (isProviderInteractionRequest && !providerRequestOwnedByActive) {
      const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
      const response = method.includes("requestApproval")
        ? {
            decision: "decline",
            note: "provider 请求未通过本地 turn 归属确认，已拒绝执行。",
          }
        : method === "item/tool/requestUserInput"
          ? { answers: {} }
          : buildCodexDynamicToolResponse({
              ok: false,
              message: "provider 工具请求未通过本地 turn 归属确认，已拒绝执行。",
              code: "TURN_OWNERSHIP_UNCONFIRMED",
            } as HostToolExecutionResult);
      this.observeDiagnosticTask(() => (ws.respond(requestId, response)
        .catch((error) => this.handleProviderRequestResponseFailure(ws, method, requestId, providerTurnId, error))));
      this.log("warn", () => ({ message: "provider interaction request rejected without local turn ownership", data: {
        code: "codex_provider_request_ownership_unconfirmed",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId: this.sessionId,
        clientTurnId: requestActive?.clientTurnId ?? null,
        activeProviderTurnId: requestActive?.codexTurnId ?? null,
        requestProviderTurnId: providerTurnId,
        requestId: String(requestId ?? ""),
        method,
      } }));
      return;
    }
    if (isRequest && method.includes("requestApproval")) {
      handled = true;
      const sharedWorkspaceDecision = evaluateSharedWorkspaceProviderNativeToolPolicy({
        context: this.active?.sharedWorkspaceToolContext ?? null,
        provider: "codex",
        toolName: method,
        toolInput: params,
      });
      if (!sharedWorkspaceDecision.allowed) {
        const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
        this.observeDiagnosticTask(() => (ws.respond(requestId, {
          decision: "decline",
          note: buildSharedWorkspaceProviderNativeDenyMessage(sharedWorkspaceDecision),
        }).catch((error) => this.handleProviderRequestResponseFailure(ws, method, requestId, providerTurnId, error))));
        return;
      }
      if (!interactionToolsAllowed) {
        const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
        this.observeDiagnosticTask(() => (ws.respond(requestId, {
          decision: "decline",
          note: buildProviderNativeToolDenyMessage("codex", method),
        }).catch((error) => this.handleProviderRequestResponseFailure(ws, method, requestId, providerTurnId, error))));
        return;
      }
      this.pendingRequests.set(String(requestId), { id: requestId, kind: "approval" });
      emitBuffered({
        ts: Date.now(),
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId as any,
        engine: "codex",
        type: "approval.request",
        payload: {
          requestId,
          toolName: method,
          input: params,
          message: extractApprovalMessage(params),
        },
      } satisfies ConversationEventInput);
    } else if (isRequest && method === "item/tool/requestUserInput") {
      handled = true;
      if (!interactionToolsAllowed) {
        const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
        this.observeDiagnosticTask(() => (ws.respond(requestId, { answers: {} })
          .catch((error) => this.handleProviderRequestResponseFailure(ws, method, requestId, providerTurnId, error))));
        const active = this.active;
        if (active && providerTurnId && active.codexTurnId === providerTurnId) {
          active.interruptTerminalError ??= new Error(buildProviderNativeToolDenyMessage("codex", "requestUserInput"));
          this.startPendingActiveTurnInterrupt(active, ws, "provider-native-user-input-denied");
        } else {
          this.log("warn", () => ({ message: "provider-native user input denied without local turn ownership", data: {
            code: "codex_provider_native_user_input_unowned",
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            sessionId: this.sessionId,
            clientTurnId: active?.clientTurnId ?? null,
            activeProviderTurnId: active?.codexTurnId ?? null,
            requestProviderTurnId: providerTurnId,
            requestId: String(requestId ?? ""),
          } }));
        }
      } else {
        this.pendingRequests.set(String(requestId), { id: requestId, kind: "userInput" });
        const request = buildUserInputRequest({
          requestId,
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId as any,
          activeTurnId: this.active?.clientTurnId ?? null,
          params,
        });
        emitBuffered({
          ts: Date.now(),
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId as any,
          engine: "codex",
          type: "userInput.requested",
          payload: { request },
        } satisfies ConversationEventInput);
      }
    } else if (isRequest && method === "item/tool/call") {
      handled = true;
      const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
      this.observeDiagnosticTask(() => (this.respondDynamicToolCall(ws, requestId, params)
        .catch((error) => this.handleProviderRequestResponseFailure(ws, method, requestId, providerTurnId, error))));
    } else {
      const activeAtFault = this.active;
      const syntheticTransportFault = Boolean(
        activeAtFault
        && isCodexSyntheticTransportFault(method, params)
      );
      if (activeAtFault && syntheticTransportFault) {
        // 只有真实退出且无其他恢复 owner 的普通 active，才由现有 reject/finally 收口。
        const unexpectedProcessExit = (params as any)?.error?.processExit;
        const rejectClosedActive = Boolean(
          unexpectedProcessExit
          && activeAtFault.codexTurnId
          && !activeAtFault.compactStartState
          && !activeAtFault.manualInterruptRequested
          && !activeAtFault.interruptTerminalError
          && !activeAtFault.interruptPromise
          && !activeAtFault.providerTerminalStatus
        );
        const faultMethod = rejectClosedActive ? "turn/start" : !activeAtFault.codexTurnId && activeAtFault.compactStartState
          ? "thread/compact/start"
          : "turn/interrupt";
        const faultError = createCodexSyntheticTransportFaultError(params, faultMethod);
        if (rejectClosedActive) {
          this.resumed = false;
          activeAtFault.reject(faultError);
        } else {
          (faultError as Error & { preserveRunningState?: boolean }).preserveRunningState = true;
        }
        const compactStartState = activeAtFault.compactStartState;
        if (!activeAtFault.codexTurnId && compactStartState) {
          if (compactStartState.phase !== "unknown") {
            compactStartState.phase = "unknown";
            compactStartState.error = faultError;
            compactStartState.lateSettlementPending = false;
            compactStartState.lateSettlementResult = {
              status: "rejected",
              kind: "process_fault",
              reason: faultError,
            };
          }
        }
        const shouldContinueInterrupt = !activeAtFault.codexTurnId
          || activeAtFault.manualInterruptRequested
          || Boolean(activeAtFault.interruptTerminalError)
          || Boolean(activeAtFault.interruptPromise);
        if (shouldContinueInterrupt) {
          activeAtFault.interruptTerminalError ??= faultError;
          const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
          this.startPendingActiveTurnInterrupt(activeAtFault, ws, "synthetic-transport-fault");
        }
        const faultContext = {
          code: String((params as any)?.error?.code ?? "codex_app_server_process_error").trim()
            || "codex_app_server_process_error",
          requestId: String((params as any)?.error?.requestId ?? "").trim() || null,
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId: this.sessionId,
          clientTurnId: activeAtFault.clientTurnId,
          providerTurnId: activeAtFault.codexTurnId,
          interruptInProgress: shouldContinueInterrupt,
          rootCause: faultError.message,
          ...(unexpectedProcessExit ? { processExit: unexpectedProcessExit } : {}),
        };
        if (rejectClosedActive) {
          this.log("error", () => ({ message: "provider process exited; active turn rejected", data: faultContext }));
        } else {
          this.log("warn", () => ({ message: "transport fault observed; active turn preserved", data: faultContext }));
        }
        handled = true;
      }
      const reconnectInfo = extractTransientReconnectInfo(method, params);
      const startingTurn = this.startingTurn ?? this.pendingHandoffStartingTurn;
      let ownedClientTurnId: TurnId | null = null;
      let ownershipCorrelationFailed = false;
      try {
        ownedClientTurnId = this.bindProviderTurnFromUserMessageEcho(method, params, providerTurnId);
        this.observeStartingTurnProviderStart(method, params, providerTurnId);
      } catch (error) {
        if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
        const correlationError = error instanceof Error ? error : new Error(String(error));
        const clientUserMessageId = extractCodexUserMessageClientId(method, params);
        const activeAtConflict = clientUserMessageId && this.active?.clientUserMessageIds.has(clientUserMessageId)
          ? this.active
          : null;
        const startingAtConflict = clientUserMessageId
          && this.startingTurn?.clientUserMessageId === clientUserMessageId
          ? this.startingTurn
          : clientUserMessageId
            && this.pendingHandoffStartingTurn?.clientUserMessageId === clientUserMessageId
            ? this.pendingHandoffStartingTurn
            : null;
        ownershipCorrelationFailed = true;
        if (!this.handledCodexBindingPersistenceErrors.has(correlationError)) {
          if (activeAtConflict) {
            this.rejectActiveForProviderOwnershipFailure(
              activeAtConflict,
              correlationError,
              "provider-user-message-correlation-failed",
            );
          } else if (startingAtConflict) {
            this.rejectStartingForProviderOwnershipFailure(
              startingAtConflict,
              correlationError,
              "provider-user-message-correlation-failed",
            );
          }
        }
        this.log("error", () => ({ message: "provider user message correlation conflict isolated", data: {
          code: "codex_provider_user_message_correlation_conflict",
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId: this.sessionId,
          providerTurnId,
          method,
          error: engineDiagnosticCause(correlationError),
        } }), { reason: error });
      }
      if (ownedClientTurnId) rawClientTurnId = ownedClientTurnId;
      const compactClientTurnId = this.recordCompactProviderTurnEvidence(method, params, providerTurnId);
      if (compactClientTurnId) rawClientTurnId = compactClientTurnId;
      // 无 turnId 的终态只有在本轮 lifecycle 已绑定后才有明确归属，避免上一轮 idle 污染新启动。
      const canAttributeIdlessTerminalToStartingTurn = Boolean(
        startingTurn?.providerLifecycleTurnId,
      );
      // 带 turnId 的终态先作为 hint 保留，后续仍必须由 clientId 证明 ownership；
      // 无 turnId 的 thread 终态只有已确权时才能归入当前 starting turn。
      const canRecordProviderTerminalHintForStartingTurn = Boolean(
        providerTurnId || canAttributeIdlessTerminalToStartingTurn,
      );
      let startingTurnTerminalHintSeen = false;
      if (
        startingTurn
        && startingTurn.startRequestSent
        && canAttributeIdlessTerminalToStartingTurn
        && method === "thread/status/changed"
        && isTerminalCodexThreadStatus(normalizeCodexTurnStatus((params as any)?.status))
      ) {
        startingTurn.terminalEvidenceVersion += 1;
        startingTurn.terminalThreadHintSeen = true;
        startingTurnTerminalHintSeen = true;
      }
      if (
        startingTurn
        && startingTurn.startRequestSent
        && canRecordProviderTerminalHintForStartingTurn
        && (
          !providerTurnId
          || (
            !this.retiredCodexTurnIds.has(providerTurnId)
            && !providerTurnWasTerminal
          )
        )
        && !reconnectInfo
        && !isCodexSyntheticTransportFault(method, params)
        && isCodexTerminalProviderEvent(method, params)
      ) {
        startingTurn.terminalEvidenceVersion += 1;
        if (providerTurnId) startingTurn.terminalHintProviderTurnIds.add(providerTurnId);
        else startingTurn.terminalThreadHintSeen = true;
        startingTurnTerminalHintSeen = true;
      }
      if (startingTurnTerminalHintSeen && startingTurn) {
        this.scheduleStartingTurnReconcile(startingTurn, "provider-terminal-hint");
      }
      this.bindActiveCodexTurnFromProviderLifecycleEvent(method, params, providerTurnId);
      if (!rawClientTurnId && method === "turn/started") {
        rawClientTurnId = this.resolveRawTurnStartedClientTurnId(providerTurnId);
      }
      const idlessActiveTerminalHint = Boolean(
        this.active
        && !providerTurnId
        && !reconnectInfo
        && !isCodexSyntheticTransportFault(method, params)
        && isCodexTerminalProviderEvent(method, params),
      );
      ignoredTurnScopedProviderEvent = ownershipCorrelationFailed
        || idlessActiveTerminalHint
        || this.shouldIgnoreTurnScopedProviderEvent(method, params, providerTurnId);
      if (ignoredTurnScopedProviderEvent) {
        const unownedActiveStartingTurn = !this.active?.codexTurnId && !this.active?.compactStartState
          ? this.active?.providerOwnershipStartingTurn ?? null
          : null;
        if (unownedActiveStartingTurn) {
          this.scheduleStartingTurnOwnershipRecovery(unownedActiveStartingTurn);
        }
        if (idlessActiveTerminalHint) {
          this.scheduleTerminalStateReconcile(`provider-turn-id-missing.${method}`);
        }
        handled = true;
      } else {
        this.captureActiveProviderTerminalStatus(method, params, providerTurnId);
        handled = isCodexAppServerHandledMethod(method);

        if (!reconnectInfo) {
          this.maybeCancelReconnectRecovery(method, providerTurnId);
        }

        if (method === "thread/status/changed") {
          const statusType = normalizeCodexTurnStatus((params as any)?.status);
          if (isTerminalCodexThreadStatus(statusType)) {
            this.scheduleTerminalStateReconcile(`thread.status.${statusType}`);
          }
        }

        if (method === "turn/status/changed") {
          const active = this.active;
          const engineTurnId = String((params as any)?.turnId ?? (params as any)?.turn?.id ?? "").trim();
          const statusType = normalizeCodexTurnStatus((params as any)?.status);
          if (this.activeTurnMatchesProviderTurn(active, engineTurnId || null) && isTerminalCodexTurnStatus(statusType)) {
            this.scheduleTerminalStateReconcile(`turn.status.${statusType}`);
          }
        }

        let asyncInputDenied = false;
        if (providerToolsDenied && (method === "item/started" || method === "item/completed")) {
          const item = ((params as any).item ?? null) as Record<string, unknown> | null;
          const itemType = String((item as any)?.type ?? "").trim();
          // 新版异步问题属于原生交互；严格结构化任务拒绝后仍保存原始 trace。
          asyncInputDenied = !interactionToolsAllowed && itemType === "agentMessage" && item?.delivery === "async";
          if (
            asyncInputDenied || (itemType
            && itemType !== "agentMessage"
            && itemType !== "userMessage"
            && itemType !== "reasoning"
            && itemType !== "plan")
          ) {
            const active = this.active;
            if (active) {
              active.interruptTerminalError ??= new Error(buildProviderNativeToolDenyMessage("codex", itemType));
              const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
              this.startPendingActiveTurnInterrupt(active, ws, "provider-native-item-denied");
            }
            if (!asyncInputDenied) return;
          }
        }

        if (method === "turn/plan/updated" || method === "item/plan/delta") {
          const active = this.active;
          if (this.activeTurnMatchesProviderTurn(active, providerTurnId)) {
            active.todolistSeenState.seen = true;
            if (method === "turn/plan/updated") active.todolistToolCompletedState.completed = true;
          }
        }

        if (!syntheticTransportFault && !asyncInputDenied) applyCodexAppServerMessage({
          workspacePath: this.opts.workspacePath,
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
        msg,
        emit: emitBuffered,
        todolistTextState: this.active?.todolistTextState,
        onAssistantDelta: (delta) => {
          this.responseText += delta;
        },
        ensureAssistantMessage: (itemId, phase) => this.ensureAssistantMessage(itemId, emitBuffered, phase),
        appendAssistantDelta: (itemId, delta) => this.appendAssistantMessageDelta(itemId, delta),
        applyAssistantSnapshot: (input) => this.applyAssistantMessageSnapshot(input),
        completeAssistantMessage: (input) => this.completeAssistantMessageFromProvider(input),
        getActiveTurn: () => this.active,
        onTransientReconnect: (info) => {
          this.scheduleReconnectRecovery({
            providerTurnId: info.turnId,
            reason: info.responseStreamDisconnected
              ? "error.responseStreamDisconnected"
              : info.willRetry
                ? "error.willRetry"
                : "error.reconnecting",
          });
        },
        onFinalTurnError: (info) => {
          const active = this.active;
          if (!active) return;
          if (!this.activeTurnMatchesProviderTurn(active, info.turnId)) return;
          active.lastNonRetryableTurnError = cloneCodexFinalError(info.error);
        },
        resolveDynamicToolDisplayName: (toolId) => this.resolveDynamicToolDisplayName(toolId),
        onCommandExecutionStarted: (input) => this.handleCommandExecutionStarted(input),
          onCommandExecutionOutputDelta: (input) => this.handleCommandExecutionOutputDelta(input),
          onCommandExecutionCompleted: (input) => this.handleCommandExecutionCompleted(input),
          onCommandExecutionTerminalInteraction: (input) => this.handleCommandExecutionTerminalInteraction(input),
        });
      }
      if (compactClientTurnId) handled = true;
    }

    const action = !handled ? "unhandled" : emittedTypes.size > 0 ? "mapped" : "ignored";
    const rawStartingTurn = this.startingTurn ?? this.pendingHandoffStartingTurn;
    const startingTurnOwnsRawEvent = Boolean(
      providerTurnId
      && rawStartingTurn?.providerLifecycleTurnId === providerTurnId,
    );
    if (!rawClientTurnId && startingTurnOwnsRawEvent) {
      rawClientTurnId = rawStartingTurn!.clientTurnId;
    }
    const rawEvent: RawEngineEventInput = {
      ts: Date.now(),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId as any,
      engine: "codex",
      source: "codex.app-server.msg",
      ...(rawClientTurnId ? { clientTurnId: rawClientTurnId } : {}),
      data: msg,
      handled,
      action,
      emittedTypes: Array.from(emittedTypes).filter(Boolean),
    };
    if (!ignoredTurnScopedProviderEvent) {
      this.active?.timeoutController.onRawEvent(rawEvent);
    }
    if (!ignoredTurnScopedProviderEvent || rawClientTurnId || startingTurnOwnsRawEvent) {
      outerEmitRaw(rawEvent);
    }

    for (const e of buffered) {
      this.active?.timeoutController.onConversationEvent(e);
      outerEmitConversation(e);
    }
  }

  /** 兜底补齐 todolist(update_plan) 的 tool.completed（无结构化 plan 时输出空 plan）。 */
  private emitTodoListToolCompletedFallback(opts: { clientTurnId: TurnId; engineTurnId: string }): void {
    const emit = this.emitters?.conversation;
    if (!emit) return;
    emit({
      ts: Date.now(),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId as any,
      engine: "codex",
      type: "item.tool.completed",
      payload: {
        itemId: `plan_turn_${opts.clientTurnId}` as any,
        toolName: "update_plan",
        output: { explanation: null, plan: null, turnId: opts.clientTurnId, engineTurnId: opts.engineTurnId },
        status: "completed",
      },
    } satisfies ConversationEventInput);
  }

  /**
   * 从 `thread/read(includeTurns=true)` 响应里提取 ThreadItem(type=plan).text，写入 `update_plan/todolist` 卡片。
   * 分页仅读取目标 turn 的 plan，传输失败交给当前 turn 显式处理。
   */
  private async tryHydrateTodoListTextFromThreadRead(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    opts: { clientTurnId: TurnId; codexTurnId: string; state: { text: string } },
  ): Promise<void> {
    const emit = this.emitters?.conversation;
    const sessionId = this.sessionId;
    if (!emit || !sessionId) return;

    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const read = await ws.request("thread/read", { threadId: sessionId, includeTurns: true }, {
        ...CODEX_RECOVERY_REQUEST_OPTIONS,
        history: { turnIds: [opts.codexTurnId], itemTypes: ["plan"] },
      });

      const turns = Array.isArray((read as any)?.thread?.turns) ? ((read as any).thread.turns as any[]) : [];
      const turn = turns.find((t) => String(t?.id ?? "").trim() === String(opts.codexTurnId).trim()) ?? null;
      const items = turn && Array.isArray((turn as any).items) ? ((turn as any).items as any[]) : [];
      const planItem = [...items].reverse().find((i) => String(i?.type ?? "") === "plan" && typeof i?.text === "string") ?? null;
      const text = planItem ? String((planItem as any).text ?? "") : "";
      if (text) {
        const prev = String(opts.state.text ?? "");
        if (prev === text) return;
        opts.state.text = text;
        emit({
          ts: Date.now(),
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId as any,
          engine: "codex",
          type: "item.tool.outputDelta",
          payload: { itemId: `plan_turn_${opts.clientTurnId}` as any, toolName: "update_plan", delta: text, mode: "replace" },
        } satisfies ConversationEventInput);
        return;
      }

      if (attempt < maxAttempts - 1) {
        const delayMs = 200 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  /** 重置 thread 绑定状态（用于 threadId 失效后的重建/重连）。 */
  private resetThreadBinding(): void {
    try {
      this.unregister?.();
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.log("error", () => ({ message: "thread observer unregister failed during binding reset", data: {
        code: "codex_thread_observer_unregister_failed",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId: this.sessionId,
        error: engineDiagnosticCause(error),
      } }), { reason: cause });
      throw error;
    }
    this.unregister = null;
    this.registered = false;
    this.resumed = false;
    this.recoveryPending = false;
    this.appliedContextWindow = null;
    this.appliedModelAutoCompactTokenLimit = null;
    this.appliedModel = null;
    this.appliedDeveloperInstructions = null;
    this.hasAppliedDeveloperInstructions = false;
    this.observedProviderThreadStatus = null;
    this.observedProviderActiveTurnId = null;
    this.providerLifecycleEventVersion += 1;
    this.pendingRequests.clear();
    this.clearReconnectRecovery();
    this.clearCodexTurnBindings();
  }

  /** 重试此前失败的持久化 binding 清理；成功前拒绝任何新 provider mutation。 */
  retryPendingSessionBindingDrop(): void {
    const pending = this.pendingSessionBindingDrop;
    if (!pending) return;
    try {
      this.opts.onSessionBindingDropped(pending.expectedSessionId);
      if (this.pendingSessionBindingDrop === pending) this.pendingSessionBindingDrop = null;
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      const error = cause instanceof Error ? cause : new Error(String(cause));
      pending.lastError = error;
      throw error;
    }
  }

  /** 先释放本地 binding，再同步清理持久化状态；失败会保留可重试门禁。 */
  private dropSessionBinding(): void {
    if (this.pendingSessionBindingDrop) {
      this.retryPendingSessionBindingDrop();
      return;
    }
    const expectedSessionId = this.sessionId;
    const hadBinding = Boolean(expectedSessionId) || this.listAppliedDynamicToolIds().length > 0;
    this.resetThreadBinding();
    this.sessionId = null;
    this.sessionCapabilities = null;
    if (!hadBinding) return;
    this.pendingSessionBindingDrop = { expectedSessionId, lastError: null };
    this.retryPendingSessionBindingDrop();
  }

  /** thread/start 返回后仅允许原 StartingTurn 提交新 binding，迟到响应不得覆盖后继 generation。 */
  private assertThreadStartBindingOwner(startingTurn: StartingTurn, nextSessionId: SessionId): void {
    if (
      this.startingTurn === startingTurn
      && !startingTurn.interruptRequested
      && !this.active
      && !this.sessionId
    ) {
      return;
    }
    const error = Object.assign(new Error(
      `Codex thread/start binding 已失去当前启动归属：threadId=${this.opts.threadId}, providerThreadId=${nextSessionId}`,
    ), { code: "codex_thread_start_binding_stale" });
    this.log("warn", () => ({ message: "stale thread/start binding ignored", data: {
      code: engineDiagnosticField(error, "code"),
      requestId: null,
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      providerThreadId: nextSessionId,
      clientTurnId: startingTurn.clientTurnId,
      currentTurnId: this.getActiveTurnId(),
      pendingSessionId: this.pendingSessionBindingDrop?.expectedSessionId ?? null,
      rootCause: startingTurn.interruptRequested
        ? "starting turn was interrupted before thread/start settled"
        : "starting turn or provider generation changed before thread/start settled",
    } }));
    // 归属检查发生在 binding 持久化之前；迟到响应从未成为本地 binding，不能进入 CAS 清理门禁。
    throw error;
  }

  /** 旋转指定 provider generation；可把重启恢复相关性接入现有 detached 补偿链。 */
  detachProviderGeneration(
    expectedSessionId: SessionId,
    recovery?: CodexDetachedProviderRecoveryInput,
  ): void {
    const expected = String(expectedSessionId ?? "").trim();
    const current = String(this.sessionId ?? "").trim();
    if (!expected) throw new Error(`Codex generation rotation 缺少 expectedSessionId：threadId=${this.opts.threadId}`);
    const clientUserMessageId = String(recovery?.clientUserMessageId ?? "").trim();
    if (recovery && !clientUserMessageId) {
      throw new Error(`Codex detached recovery 缺少 clientUserMessageId：threadId=${this.opts.threadId}, turnId=${recovery.clientTurnId}`);
    }
    if (recovery) {
      const collision = Array.from(this.pendingInterruptedStartingTurns.values()).find((candidate) => (
        candidate.clientTurnId !== recovery.clientTurnId
        && candidate.providerThreadId === expected
        && candidate.clientUserMessageId === clientUserMessageId
      )) ?? null;
      if (collision) {
        throw new Error(
          `Codex detached recovery clientId 已关联其他本地 turn：threadId=${this.opts.threadId}, clientId=${clientUserMessageId}, existing=${collision.clientTurnId}, incoming=${recovery.clientTurnId}`,
        );
      }
      const existing = this.pendingInterruptedStartingTurns.get(recovery.clientTurnId) ?? null;
      if (existing) {
        if (
          existing.providerThreadId !== expected
          || existing.clientUserMessageId !== clientUserMessageId
        ) {
          throw new Error(
            `Codex detached recovery 关联冲突：threadId=${this.opts.threadId}, turnId=${recovery.clientTurnId}`,
          );
        }
        this.preserveUnownedProviderGeneration(existing, "restart-fallback-ownership-unconfirmed");
        return;
      }
    }
    if (!current) {
      if (recovery) {
        throw new Error(`Codex generation rotation 无法登记 detached recovery：threadId=${this.opts.threadId}, expected=${expected}, actual=missing`);
      }
      return;
    }
    if (current !== expected) {
      throw new Error(
        `Codex generation rotation 拒绝清除新绑定：threadId=${this.opts.threadId}, expected=${expected}, actual=${current}`,
      );
    }
    const activeTurnId = this.getActiveTurnId();
    if (activeTurnId || this.historyRollbackInProgress) {
      throw new Error(
        `Codex generation rotation 仍有本地 mutation：threadId=${this.opts.threadId}, turnId=${activeTurnId ?? "rollback"}`,
      );
    }
    if (recovery) {
      const startingTurn = createStartingTurn(recovery.clientTurnId, clientUserMessageId);
      startingTurn.providerThreadId = expectedSessionId;
      startingTurn.providerTurnId = String(recovery.provisionalProviderTurnId ?? "").trim() || null;
      startingTurn.startRequestSent = true;
      startingTurn.interruptRequested = true;
      startingTurn.onProviderTurnRecovered = recovery.onProviderTurnRecovered;
      startingTurn.settle();
      this.rememberInterruptedStartingTurn(startingTurn);
      this.preserveUnownedProviderGeneration(startingTurn, "restart-fallback-ownership-unconfirmed");
      return;
    }
    this.dropSessionBinding();
  }

  /** 清除当前被中断首轮新建、且尚未承载 provider turn 的 thread 绑定。 */
  private dropFreshInterruptedThreadBinding(startingTurn: StartingTurn): void {
    if (this.disposed) return;
    const createdThreadId = startingTurn.createdProviderThreadId;
    if (!createdThreadId || this.sessionId !== createdThreadId) return;
    if (startingTurn.providerLifecycleTurnId || startingTurn.providerObservedTurnId) return;
    this.dropSessionBinding();
  }

  private clearSessionCapabilities(): void {
    if (!this.sessionId) return;
    if (!this.sessionCapabilities) return;
    this.sessionCapabilities = null;
    this.opts.onSessionBinding(this.sessionId, null);
  }

  /** 耐久化成功后再提交动态工具 capabilities 到内存。 */
  private confirmSessionBinding(sessionCapabilities: ThreadSessionCapabilities | null): void {
    this.assertDiagnosticReady();
    if (!this.sessionId || !sessionCapabilities) return;
    const requestedToolIds = Array.isArray(sessionCapabilities.codexDynamicToolIds)
      ? sessionCapabilities.codexDynamicToolIds.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
    const bindingVersion = String(sessionCapabilities.codexDynamicToolBindingVersion ?? "").trim() || null;
    if (this.currentSessionSupportsDynamicToolBinding(requestedToolIds, bindingVersion)) return;
    this.opts.onSessionBinding(this.sessionId, sessionCapabilities);
    this.sessionCapabilities = sessionCapabilities;
  }

  private listAppliedDynamicToolIds(): string[] {
    return Array.isArray(this.sessionCapabilities?.codexDynamicToolIds)
      ? this.sessionCapabilities!.codexDynamicToolIds!.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
  }

  /** 本轮工具须已注册且名称映射一致；原绑定可包含本轮停用的工具。 */
  private currentSessionSupportsDynamicToolBinding(requestedToolIds: string[], bindingVersion: string | null): boolean {
    if (!requestedToolIds.length) return true;
    const appliedSet = new Set(this.listAppliedDynamicToolIds());
    if (!requestedToolIds.every((toolId) => appliedSet.has(toolId))) return false;
    const currentBindingVersion = String(this.sessionCapabilities?.codexDynamicToolBindingVersion ?? "").trim() || null;
    if (!currentBindingVersion || !bindingVersion) return false;
    const appliedBindings = new Set(currentBindingVersion.split("|"));
    return bindingVersion.split("|").every(binding => appliedBindings.has(binding));
  }

  /** 确保 assistant message 生命周期以 itemId 为唯一身份启动。 */
  private ensureAssistantMessage(
    itemId: string,
    emit: ConversationEmitFn,
    phase?: AssistantMessagePhase,
  ): AssistantLifecycleRecord {
    const activeTurnId = this.assistantLifecycle.activeTurn() ?? this.active?.clientTurnId ?? null;
    if (!activeTurnId) {
      throw new Error(`Codex assistant message started without active turn: ${itemId}`);
    }
    const existing = this.assistantLifecycle.get(itemId);
    if (existing) {
      if (phase && !existing.completed && codexAssistantPhasePriority(phase) >= codexAssistantPhasePriority(existing.phase)) {
        existing.phase = phase;
      }
      return existing;
    }
    const created = this.assistantLifecycle.ensureStarted({
      itemId,
      engineMessageId: itemId,
      turnId: activeTurnId,
      phase,
    });
    emit({
      ts: Date.now(),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId as any,
      engine: "codex",
      type: "item.agentMessage.started",
      payload: { itemId: itemId as any, engineMessageId: itemId, turnId: activeTurnId, phase },
    } satisfies ConversationEventInput);
    return created;
  }

  private appendAssistantMessageDelta(itemId: string, delta: string): AssistantLifecycleRecord | null {
    return this.assistantLifecycle.appendDelta(itemId, delta);
  }

  private applyAssistantMessageSnapshot(input: {
    itemId: string;
    text: string;
    phase?: AssistantMessagePhase;
  }): AssistantLifecycleRecord | null {
    const existing = this.assistantLifecycle.get(input.itemId);
    if (!existing) return null;
    return this.assistantLifecycle.applySnapshot({
      itemId: input.itemId,
      text: input.text,
      revision: existing.revision + 1,
      phase: input.phase,
    });
  }

  private completeAssistantMessageFromProvider(input: {
    itemId: string;
    text: string;
    phase?: AssistantMessagePhase;
  }): AssistantLifecycleRecord | null {
    const existing = this.assistantLifecycle.get(input.itemId);
    if (!existing) return null;
    return this.assistantLifecycle.markCompleted({
      itemId: input.itemId,
      text: input.text,
      revision: existing.revision,
      phase: input.phase,
      completionSource: "provider",
    });
  }

  /** 精确读取本地 turn 的普通正文与异步问题，复用实时消息的结构校验。 */
  private async readTerminalItemsFromThreadRead(turnId: TurnId): Promise<{
    assistantItems: ReturnType<typeof extractAssistantItems>;
    userInputRequests: RequestUserInputRequest[];
  }> {
    const sessionId = this.sessionId;
    if (!sessionId) return { assistantItems: [], userInputRequests: [] };
    const codexTurnId = this.codexTurnIdByClientTurnId.get(turnId) ?? null;
    if (!codexTurnId) return { assistantItems: [], userInputRequests: [] };
    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    const read = await ws.request("thread/read", { threadId: sessionId, includeTurns: true }, {
      ...CODEX_RECOVERY_REQUEST_OPTIONS,
      history: { turnIds: [codexTurnId], itemTypes: ["agentMessage"] },
    });
    const turns = Array.isArray((read as any)?.thread?.turns) ? ((read as any).thread.turns as any[]) : [];
    const turn = turns.find((item) => String(item?.id ?? "").trim() === codexTurnId) ?? null;
    if (!turn) return { assistantItems: [], userInputRequests: [] };
    const userInputRequests: RequestUserInputRequest[] = [];
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      const request = buildAsyncUserInputRequest({ item, workspaceId: this.opts.workspaceId, threadId: this.opts.threadId, turnId });
      if (request) userInputRequests.push(request);
    }
    return { assistantItems: extractAssistantItems(turn), userInputRequests };
  }

  /** 先投递权威 mapping 事件再提交内存双向映射，避免持久化失败留下 partial state。 */
  private bindCodexTurn(
    clientTurnId: TurnId,
    codexTurnId: string,
    previousEngineTurnIdOverride?: string | null,
    engineSessionIdOverride?: SessionId | null,
    suppressConversationEvent = false,
  ): void {
    this.assertDiagnosticReady();
    const normalizedTurnId = String(codexTurnId ?? "").trim();
    if (!normalizedTurnId) throw new Error(`Codex provider turnId 无效：clientTurnId=${clientTurnId}`);
    const mappedPreviousEngineTurnId = this.codexTurnIdByClientTurnId.get(clientTurnId) ?? null;
    const previousEngineTurnId = previousEngineTurnIdOverride === undefined
      ? mappedPreviousEngineTurnId
      : previousEngineTurnIdOverride;
    const existingClientTurnId = this.clientTurnIdByCodexTurnId.get(normalizedTurnId) ?? null;
    if (existingClientTurnId && existingClientTurnId !== clientTurnId) {
      throw buildCodexProviderTurnBindingConflictError(
        `Codex provider turn 已关联其他本地 turn：threadId=${this.opts.threadId}, providerTurnId=${normalizedTurnId}, existing=${existingClientTurnId}, incoming=${clientTurnId}`,
      );
    }
    const engineSessionId = engineSessionIdOverride === undefined
      ? this.sessionId
      : engineSessionIdOverride;
    const emit = this.emitters?.conversation;
    if (
      !suppressConversationEvent
      && previousEngineTurnId !== normalizedTurnId
      && engineSessionId
      && emit
    ) {
      try {
        emit({
          ts: Date.now(),
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId as any,
          engine: "codex",
          type: "turn.engineBound",
          payload: {
            turnId: clientTurnId,
            engineTurnId: normalizedTurnId,
            engineSessionId,
            previousEngineTurnId,
          },
        } satisfies ConversationEventInput);
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        const error = cause instanceof Error ? cause : new Error(String(cause));
        const finalError = this.handleCodexBindingPersistenceFailure(
          clientTurnId,
          normalizedTurnId,
          engineSessionId,
          error,
        );
        this.handledCodexBindingPersistenceErrors.add(error);
        this.handledCodexBindingPersistenceErrors.add(finalError);
        throw finalError;
      }
    }
    this.codexTurnIdByClientTurnId.set(clientTurnId, normalizedTurnId);
    if (!this.nativeToolPolicyByClientTurnId.has(clientTurnId)) this.nativeToolPolicyByClientTurnId.set(clientTurnId, this.currentProviderNativeToolPolicy);
    this.clientTurnIdByCodexTurnId.set(normalizedTurnId, clientTurnId);
    this.retiredCodexTurnIds.delete(normalizedTurnId);
    const retiredMappingIndex = this.retiredCodexTurnMappingOrder.indexOf(normalizedTurnId);
    if (retiredMappingIndex >= 0) this.retiredCodexTurnMappingOrder.splice(retiredMappingIndex, 1);
  }

  /** 持久化 binding 失败时隔离当前 provider generation，禁止留下未登记的运行 turn。 */
  private handleCodexBindingPersistenceFailure(
    clientTurnId: TurnId,
    providerTurnId: string,
    providerThreadId: SessionId | null,
    error: Error,
  ): Error {
    (error as Error & { preserveRunningState?: boolean }).preserveRunningState = true;
    const active = this.active?.clientTurnId === clientTurnId ? this.active : null;
    if (active) {
      this.rejectActiveForProviderOwnershipFailure(
        active,
        error,
        "provider-turn-binding-persistence-failed",
      );
      this.log("error", () => ({ message: "active provider turn binding persistence failed", data: {
        code: "codex_provider_turn_binding_persistence_failed",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        providerThreadId,
        clientTurnId,
        providerTurnId,
        error: engineDiagnosticCause(error),
      } }));
      return error;
    }

    const starting = this.startingTurn?.clientTurnId === clientTurnId
      ? this.startingTurn
      : this.pendingHandoffStartingTurn?.clientTurnId === clientTurnId
        ? this.pendingHandoffStartingTurn
        : null;
    if (starting) {
      return this.failStartingTurnBindingPersistence(starting, providerTurnId, error);
    }

    const interrupted = this.pendingInterruptedStartingTurns.get(clientTurnId) ?? null;
    if (interrupted) {
      const normalizedProviderTurnId = String(providerTurnId ?? "").trim();
      const previousObservedTurnId = String(interrupted.providerObservedTurnId ?? "").trim();
      if (
        previousObservedTurnId
        && normalizedProviderTurnId
        && previousObservedTurnId !== normalizedProviderTurnId
      ) {
        const ambiguityError = buildCodexTurnOwnershipAmbiguousError({
          sessionId: providerThreadId ?? interrupted.providerThreadId ?? this.opts.threadId,
          clientTurnId,
          clientUserMessageId: interrupted.clientUserMessageId,
          providerTurnIds: [previousObservedTurnId, normalizedProviderTurnId],
        });
        interrupted.ownershipRecoveryExhausted = true;
        this.log("error", () => ({ message: "detached binding persistence exposed ambiguous provider ownership", data: {
          code: "codex_detached_provider_turn_binding_persistence_ambiguous",
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          providerThreadId,
          clientTurnId,
          clientUserMessageId: interrupted.clientUserMessageId,
          providerTurnIds: [previousObservedTurnId, normalizedProviderTurnId],
          cause: engineDiagnosticCause(error),
        } }));
        return ambiguityError;
      }
      if (normalizedProviderTurnId) interrupted.providerObservedTurnId = normalizedProviderTurnId;
      this.restartStartingTurnOwnershipRecoveryAfterNewEvidence(interrupted);
      this.log("error", () => ({ message: "detached provider turn binding persistence failed", data: {
        code: "codex_detached_provider_turn_binding_persistence_failed",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        providerThreadId,
        clientTurnId,
        providerTurnId,
        error: engineDiagnosticCause(error),
      } }));
      return error;
    }

    this.log("error", () => ({ message: "untracked provider turn binding persistence failed", data: {
      code: "codex_provider_turn_binding_persistence_unowned",
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      providerThreadId,
      clientTurnId,
      providerTurnId,
      error: engineDiagnosticCause(error),
    } }));
    return error;
  }

  /** 启动阶段 binding 持久化失败时登记 bounded tombstone，并保留当前 generation。 */
  private failStartingTurnBindingPersistence(
    startingTurn: StartingTurn,
    providerTurnId: string,
    error: Error,
  ): Error {
    const normalizedProviderTurnId = String(providerTurnId ?? "").trim();
    const providerThreadId = startingTurn.providerThreadId ?? this.sessionId;
    if (!startingTurn.providerThreadId && providerThreadId) {
      startingTurn.providerThreadId = providerThreadId;
    }
    const previousObservedTurnId = String(startingTurn.providerObservedTurnId ?? "").trim();
    const ownershipAmbiguous = Boolean(
      previousObservedTurnId
      && normalizedProviderTurnId
      && previousObservedTurnId !== normalizedProviderTurnId,
    );
    let finalError = error;
    if (ownershipAmbiguous) {
      finalError = buildCodexTurnOwnershipAmbiguousError({
        sessionId: providerThreadId ?? this.opts.threadId,
        clientTurnId: startingTurn.clientTurnId,
        clientUserMessageId: startingTurn.clientUserMessageId,
        providerTurnIds: [previousObservedTurnId, normalizedProviderTurnId],
      });
      this.discardAmbiguousProviderTurnBindings(startingTurn.clientTurnId, [
        previousObservedTurnId,
        normalizedProviderTurnId,
        startingTurn.providerLifecycleTurnId,
      ]);
      this.log("error", () => ({ message: "binding persistence failure exposed ambiguous provider ownership", data: {
        code: "codex_provider_turn_binding_persistence_ambiguous",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        providerThreadId,
        clientTurnId: startingTurn.clientTurnId,
        clientUserMessageId: startingTurn.clientUserMessageId,
        providerTurnIds: [previousObservedTurnId, normalizedProviderTurnId],
        cause: engineDiagnosticCause(error),
      } }));
    } else {
      if (normalizedProviderTurnId) startingTurn.providerObservedTurnId = normalizedProviderTurnId;
      startingTurn.providerTurnId ??= normalizedProviderTurnId || null;
    }
    // 先立 ownership fence，再登记 tombstone/恢复任务，避免同步回调提交未持久化的 turn 映射。
    startingTurn.providerOwnershipConflict = finalError;
    startingTurn.interruptRequested = true;

    const alreadyInterrupted = this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn;
    if (!alreadyInterrupted) this.rememberInterruptedStartingTurn(startingTurn);

    let preserveFailure: Error | null = null;
    if (providerThreadId) {
      try {
        this.preserveUnownedProviderGeneration(startingTurn, "provider-turn-binding-persistence-failed");
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        const failure = cause instanceof Error ? cause : new Error("Codex generation fence failed", { cause });
        preserveFailure = failure;
        this.log("error", () => ({ message: "provider generation fence after binding persistence failure failed", data: {
          code: "codex_provider_generation_fence_after_binding_failure_failed",
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          providerThreadId,
          clientTurnId: startingTurn.clientTurnId,
          providerTurnId,
          error: failure.message,
        } }), { reason: cause });
      }
    }
    if (!ownershipAmbiguous && startingTurn.providerLifecycleTurnId === normalizedProviderTurnId) {
      this.scheduleInterruptedStartingTurnCompensation(startingTurn, normalizedProviderTurnId);
    } else if (!ownershipAmbiguous) {
      this.restartStartingTurnOwnershipRecoveryAfterNewEvidence(startingTurn);
    }
    if (preserveFailure) {
      finalError = Object.assign(new Error(
        `Codex provider binding 持久化失败且 generation 门禁失败：${preserveFailure.message}`,
        { cause: error },
      ), {
        code: "codex_provider_binding_persistence_generation_fence_failed",
        originalError: error.message,
      });
    }
    startingTurn.providerOwnershipConflict = finalError;
    startingTurn.startError = finalError;
    (finalError as Error & { preserveRunningState?: boolean }).preserveRunningState = true;
    return finalError;
  }

  /** 单调推进 provider live head；被后继替代的 head 只防回滚，不等同于本地 turn 终态。 */
  private advanceObservedProviderActiveTurn(providerTurnId: string): void {
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    if (
      !normalizedTurnId
      || this.retiredCodexTurnIds.has(normalizedTurnId)
      || this.terminalObservedProviderTurnStatusById.has(normalizedTurnId)
      || this.supersededProviderHeadTurnIds.has(normalizedTurnId)
    ) {
      return;
    }
    const previousTurnId = this.observedProviderActiveTurnId;
    const activeProviderTurnId = this.active?.codexTurnId ?? null;
    if (activeProviderTurnId && activeProviderTurnId !== normalizedTurnId) {
      this.supersededProviderHeadTurnIds.add(activeProviderTurnId);
    }
    if (previousTurnId && previousTurnId !== normalizedTurnId) {
      this.supersededProviderHeadTurnIds.add(previousTurnId);
    }
    this.observedProviderThreadStatus = "active";
    this.observedProviderActiveTurnId = normalizedTurnId;
  }

  /** 记录 provider thread 终态，并冻结刚结束的 head，防止迟到 started 将其复活。 */
  private markObservedProviderThreadTerminal(status: string): void {
    const normalizedStatus = normalizeCodexTurnStatus(status);
    if (!isTerminalCodexThreadStatus(normalizedStatus)) return;
    const terminalTurnId = this.observedProviderActiveTurnId;
    if (terminalTurnId) this.terminalObservedProviderTurnStatusById.set(terminalTurnId, "unknown");
    const startingTurn = this.startingTurn;
    if (
      terminalTurnId
      && startingTurn
      && !startingTurn.startRequestSent
      && startingTurn.providerObservedTurnId === terminalTurnId
    ) {
      startingTurn.providerObservedTurnId = null;
    }
    this.observedProviderThreadStatus = normalizedStatus;
    this.observedProviderActiveTurnId = null;
  }

  /** 按 provider thread/turn 保存终态，避免 generation reset 丢失 terminal-first 证据。 */
  private rememberProviderTerminalStatus(
    providerThreadId: SessionId | string | null,
    providerTurnId: string,
    status: string,
  ): void {
    const normalizedThreadId = String(providerThreadId ?? "").trim() as SessionId;
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    const normalizedStatus = normalizeCodexTurnStatus(status);
    if (!normalizedThreadId || !normalizedTurnId || !isTerminalCodexTurnStatus(normalizedStatus)) return;
    let statuses = this.terminalObservedProviderTurnStatusByThreadId.get(normalizedThreadId);
    if (!statuses) {
      statuses = new Map<string, string>();
      this.terminalObservedProviderTurnStatusByThreadId.set(normalizedThreadId, statuses);
    }
    statuses.set(normalizedTurnId, normalizedStatus);
  }

  /** 只读取同一 provider thread 的精确终态，禁止相同 turnId 跨 generation 串证据。 */
  private getProviderTerminalStatus(
    providerThreadId: SessionId | string | null,
    providerTurnId: string,
  ): string | null {
    const normalizedThreadId = String(providerThreadId ?? "").trim() as SessionId;
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    if (!normalizedThreadId || !normalizedTurnId) return null;
    return this.terminalObservedProviderTurnStatusByThreadId.get(normalizedThreadId)?.get(normalizedTurnId) ?? null;
  }

  /** 维护 provider 线程级 live head，供本地无 active turn 时的下一次输入复用。 */
  private observeProviderThreadLifecycle(
    method: string,
    params: Record<string, unknown> | undefined,
    providerTurnId: string | null,
  ): void {
    if (isCodexSyntheticTransportFault(method, params)) {
      this.providerLifecycleEventVersion += 1;
      this.observedProviderThreadStatus = null;
      this.observedProviderActiveTurnId = null;
      return;
    }
    if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
      this.providerLifecycleEventVersion += 1;
      return;
    }
    if (method === "thread/status/changed") {
      const status = normalizeCodexTurnStatus((params as any)?.status);
      if (status) {
        this.providerLifecycleEventVersion += 1;
        if (isTerminalCodexThreadStatus(status)) {
          this.markObservedProviderThreadTerminal(status);
        } else {
          this.observedProviderThreadStatus = status;
        }
      }
      return;
    }
    if (method === "turn/started" && providerTurnId) {
      this.providerLifecycleEventVersion += 1;
      if (this.retiredCodexTurnIds.has(providerTurnId)) return;
      const startingTurn = this.startingTurn ?? this.pendingHandoffStartingTurn;
      if (startingTurn?.terminalHintProviderTurnIds.has(providerTurnId)) return;
      if (this.active?.codexTurnId === providerTurnId && this.active.providerTerminalStatus) return;
      this.advanceObservedProviderActiveTurn(providerTurnId);
      return;
    }
    if (providerTurnId && isCodexTerminalProviderEvent(method, params)) {
      this.providerLifecycleEventVersion += 1;
      const terminalStatus = extractCodexTerminalProviderStatus(method, params) ?? "error";
      this.rememberProviderTerminalStatus(this.sessionId, providerTurnId, terminalStatus);
      this.terminalObservedProviderTurnStatusById.set(providerTurnId, terminalStatus);
      this.finalizeInterruptedOwnedTurnFromTerminal(this.sessionId, providerTurnId, terminalStatus);
      const startingTurn = this.startingTurn;
      if (
        startingTurn
        && !startingTurn.startRequestSent
        && startingTurn.providerObservedTurnId === providerTurnId
      ) {
        startingTurn.providerObservedTurnId = null;
      }
      if (this.observedProviderActiveTurnId === providerTurnId) {
        this.observedProviderActiveTurnId = null;
      }
    }
  }

  /** 记录 compact 专用 lifecycle 证据；只有 ACK 已确认时才绑定对应 provider turn。 */
  private recordCompactProviderTurnEvidence(
    method: string,
    params: Record<string, unknown> | undefined,
    providerTurnId: string | null,
  ): TurnId | null {
    const active = this.active;
    const state = active?.compactStartState ?? null;
    const evidenceTurnId = extractCodexCompactEvidenceTurnId(method, params, providerTurnId);
    const evidenceThreadId = String((params as any)?.threadId ?? (params as any)?.thread_id ?? "").trim();
    if (
      !active
      || !state
      || !evidenceTurnId
      || evidenceThreadId !== String(this.sessionId)
      || state.providerTurnIdsBeforeStart.has(evidenceTurnId)
    ) {
      return null;
    }
    state.providerCompactTurnIds.add(evidenceTurnId);
    try {
      return this.bindActiveCompactTurnFromRecordedEvidence(active) ? active.clientTurnId : null;
    } catch (error) {
      if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
      active.interruptTerminalError ??= error instanceof Error ? error : new Error(String(error));
      this.log("error", () => ({ message: "compact provider ownership became ambiguous", data: {
        code: "codex_compact_ownership_unconfirmed",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId: this.sessionId,
        clientTurnId: active.clientTurnId,
        candidateTurnIds: Array.from(state.providerCompactTurnIds),
        error: engineDiagnosticCause(error),
      } }), { reason: error });
      return null;
    }
  }

  /** 将唯一 compact 专用证据绑定为 ownership；无 ACK 或无证据时保持未绑定。 */
  private bindActiveCompactTurnFromRecordedEvidence(active: ActiveTurn): string | null {
    const state = active.compactStartState;
    const sessionId = this.sessionId;
    if (!state || !sessionId || !hasAcknowledgedCompactStart(state)) return null;
    const candidates = Array.from(state.providerCompactTurnIds).filter(
      (turnId) => !state.providerTurnIdsBeforeStart.has(turnId),
    );
    if (candidates.length > 1) {
      throw buildCodexCompactOwnershipUnconfirmedError({
        sessionId,
        clientTurnId: active.clientTurnId,
        candidateTurnIds: candidates,
        cause: new Error("观察到多个基线后的 contextCompaction turn"),
      });
    }
    const providerTurnId = candidates[0] ?? null;
    if (!providerTurnId) return null;
    this.bindActiveCodexTurn(active, providerTurnId, "provider_lifecycle");
    const observedTerminalStatus = this.getProviderTerminalStatus(this.sessionId, providerTurnId);
    if (observedTerminalStatus && isTerminalCodexTurnStatus(observedTerminalStatus)) {
      this.settleActiveFromProviderTerminal(
        active,
        observedTerminalStatus,
        "compact-evidence-after-provider-terminal",
        null,
      );
    }
    return providerTurnId;
  }

  /** 从一次权威 thread/read 中恢复 contextCompaction ownership，不使用 latest/唯一普通 turn。 */
  private reconcileCompactProviderTurnOwnershipFromRead(
    active: ActiveTurn,
    read: unknown,
    reason: string,
  ): "bound" | "settled" | "unresolved" {
    const sessionId = this.sessionId;
    const state = active.compactStartState;
    if (!sessionId || !state || this.active !== active) return "unresolved";
    const thread = (read as any)?.thread ?? null;
    const providerThreadId = String(thread?.id ?? "").trim();
    if (providerThreadId !== String(sessionId)) {
      throw buildCodexCompactOwnershipUnconfirmedError({
        sessionId,
        clientTurnId: active.clientTurnId,
        candidateTurnIds: Array.from(state.providerCompactTurnIds),
        cause: new Error(`thread/read 返回了错误 threadId：${providerThreadId || "missing"}`),
      });
    }
    const turns = Array.isArray(thread?.turns) ? (thread.turns as any[]) : [];
    for (const providerTurnId of findCodexCompactTurnIdsAfterBaseline(turns, state.providerTurnIdsBeforeStart)) {
      state.providerCompactTurnIds.add(providerTurnId);
    }
    const providerTurnId = this.bindActiveCompactTurnFromRecordedEvidence(active);
    if (!providerTurnId) return "unresolved";
    const providerTurn = turns.find((turn) => String(turn?.id ?? "").trim() === providerTurnId) ?? null;
    const providerTurnStatus = normalizeCodexTurnStatus(providerTurn?.status);
    if (isTerminalCodexTurnStatus(providerTurnStatus)) {
      this.settleActiveFromProviderTerminal(active, providerTurnStatus, reason, read);
      return "settled";
    }
    return "bound";
  }

  /** 持久化成功后提交 active ownership；失败时不留下 active/Map 半状态。 */
  private bindActiveCodexTurn(
    active: ActiveTurn,
    codexTurnId: string | null,
    source: CodexTurnBindingSource = "observed",
  ): void {
    const normalizedTurnId = String(codexTurnId ?? "").trim();
    if (!normalizedTurnId) return;
    if (active.codexTurnId === normalizedTurnId) {
      if (this.codexTurnIdByClientTurnId.get(active.clientTurnId) !== normalizedTurnId) {
        this.bindCodexTurn(active.clientTurnId, normalizedTurnId);
      }
      active.provisionalCodexTurnId = null;
      if (source === "provider_lifecycle" || !active.codexTurnBindingSource) {
        active.codexTurnBindingSource = source;
      }
      this.schedulePendingActiveStateRecovery(active);
      return;
    }
    if (active.codexTurnId) return;
    this.bindCodexTurn(active.clientTurnId, normalizedTurnId);
    active.codexTurnId = normalizedTurnId;
    active.provisionalCodexTurnId = null;
    active.codexTurnBindingSource = source;
    this.schedulePendingActiveStateRecovery(active);
  }

  /** provider ID 晚到时重试已挂起的 timeout 对账或真实中断。 */
  private schedulePendingActiveStateRecovery(active: ActiveTurn): void {
    if (
      !active.pendingEngineIdleTimeoutError
      && !active.manualInterruptRequested
      && !active.interruptTerminalError
    ) {
      return;
    }
    queueMicrotask(() => {
      if (this.active !== active || active.providerTerminalStatus) return;
      const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
      if (active.pendingEngineIdleTimeoutError && !active.manualInterruptRequested && !active.interruptTerminalError) {
        this.startPendingEngineIdleTimeoutReconcile(active, ws);
      }
      if ((active.manualInterruptRequested || active.interruptTerminalError) && !active.interruptPromise) {
        this.startPendingActiveTurnInterrupt(active, ws, "provider-turn-id-bound");
      }
    });
  }

  /** 用 provider 权威 turnId 替换旧绑定，并保留可持久化的替换链。 */
  private replaceActiveCodexTurnId(
    active: ActiveTurn,
    codexTurnId: string,
    source: CodexTurnBindingSource = "observed",
  ): void {
    const normalizedTurnId = String(codexTurnId ?? "").trim();
    if (!normalizedTurnId || active.codexTurnId === normalizedTurnId) return;
    const previousTurnId = active.codexTurnId;
    this.bindCodexTurn(active.clientTurnId, normalizedTurnId, previousTurnId);
    if (previousTurnId) {
      if (this.codexTurnIdByClientTurnId.get(active.clientTurnId) === previousTurnId) {
        this.codexTurnIdByClientTurnId.delete(active.clientTurnId);
      }
      if (this.clientTurnIdByCodexTurnId.get(previousTurnId) === active.clientTurnId) {
        this.clientTurnIdByCodexTurnId.delete(previousTurnId);
      }
      this.retireProviderTurnId(previousTurnId);
    }
    active.codexTurnId = normalizedTurnId;
    active.provisionalCodexTurnId = null;
    active.codexTurnBindingSource = source;
    this.schedulePendingActiveStateRecovery(active);
  }

  /** 应用 steer 的 clientId 确权；旧序号不回滚，新终态可直接结算。 */
  private confirmSteerOwnership(
    correlation: PendingSteerCorrelation,
    providerTurnId: string,
    providerStatus: string | null = null,
    threadRead: unknown = null,
  ): void {
    const previousConfirmedTurnId = String(correlation.confirmedProviderTurnId ?? "").trim();
    if (previousConfirmedTurnId && previousConfirmedTurnId !== providerTurnId) {
      throw buildCodexTurnOwnershipAmbiguousError({
        sessionId: correlation.providerThreadId,
        clientTurnId: correlation.clientTurnId,
        clientUserMessageId: correlation.clientUserMessageId,
        providerTurnIds: [previousConfirmedTurnId, providerTurnId],
      });
    }
    const cachedProviderTerminalStatus = this.getProviderTerminalStatus(
      correlation.providerThreadId,
      providerTurnId,
    );
    if (!cachedProviderTerminalStatus && providerStatus && isTerminalCodexTurnStatus(providerStatus)) {
      this.rememberProviderTerminalStatus(correlation.providerThreadId, providerTurnId, providerStatus);
    }
    const effectiveProviderStatus = cachedProviderTerminalStatus ?? providerStatus;
    const active = this.active?.clientTurnId === correlation.clientTurnId ? this.active : null;
    const detached = correlation.state === "interrupted" || !active || this.sessionId !== correlation.providerThreadId;
    if (detached && previousConfirmedTurnId === providerTurnId) {
      if (effectiveProviderStatus && isTerminalCodexTurnStatus(effectiveProviderStatus)) {
        this.clearSteerOwnershipRecoveryTimer(correlation);
        this.forgetInterruptedSteerCorrelation(correlation);
        this.retireProviderTurnId(providerTurnId);
        return;
      }
      const compensationKey = buildCodexProviderTurnCorrelationKey(correlation.providerThreadId, providerTurnId);
      if (correlation.ownershipRecoveryTimer || this.pendingInterruptedProviderCompensationsByKey.has(compensationKey)) {
        return;
      }
      this.scheduleInterruptedSteerCompensation(correlation, providerTurnId);
      return;
    }
    this.clearSteerOwnershipRecoveryTimer(correlation);
    if (detached) {
      correlation.confirmedProviderTurnId = providerTurnId;
      correlation.state = "interrupted";
      if (effectiveProviderStatus && isTerminalCodexTurnStatus(effectiveProviderStatus)) {
        this.forgetInterruptedSteerCorrelation(correlation);
        this.retireProviderTurnId(providerTurnId);
        return;
      }
      this.scheduleInterruptedSteerCompensation(correlation, providerTurnId);
      return;
    }

    if (this.canAdvanceActiveOwnership(active, correlation.clientUserMessageId)) {
      if (active.codexTurnId !== providerTurnId) {
        this.replaceActiveCodexTurnId(active, providerTurnId, "provider_lifecycle");
      } else {
        this.bindActiveCodexTurn(active, providerTurnId, "provider_lifecycle");
      }
      active.confirmedClientUserMessageSequence = correlation.sequence;
    } else {
      this.log("info", () => ({ message: "stale steer ownership did not replace newer provider turn", data: {
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId: this.sessionId,
        clientTurnId: correlation.clientTurnId,
        clientUserMessageId: correlation.clientUserMessageId,
        providerTurnId,
        steerSequence: correlation.sequence,
        confirmedSequence: active.confirmedClientUserMessageSequence ?? -1,
      } }));
    }
    correlation.confirmedProviderTurnId = providerTurnId;
    correlation.state = "confirmed";
    this.forgetInterruptedSteerCorrelation(correlation);
    if (
      active.codexTurnId === providerTurnId
      && effectiveProviderStatus
      && isTerminalCodexTurnStatus(effectiveProviderStatus)
    ) {
      this.settleActiveFromProviderTerminal(
        active,
        effectiveProviderStatus,
        "provider-steer-user-message-correlation-after-terminal",
        threadRead,
      );
    }
  }

  /** 旧 provider turn 先终态时，按最新 pending steer 的 clientId 做一次异常路径历史恢复。 */
  private schedulePendingSteerOwnershipRecovery(active: ActiveTurn): void {
    if (this.active !== active) return;
    if (this.pendingSteerOwnershipRecovery) {
      this.pendingSteerOwnershipRecoveryRequested = true;
      return;
    }
    this.pendingSteerOwnershipRecoveryRequested = false;
    const correlation = this.getLatestPendingSteerCorrelation(active);
    const sessionId = correlation?.providerThreadId ?? null;
    if (!correlation || !sessionId) return;
    if (correlation.ownershipRecoveryExhausted) return;
    const correlationKey = buildCodexProviderClientCorrelationKey(
      correlation.providerThreadId,
      correlation.clientUserMessageId,
    );
    const isCurrentPendingCorrelation = (): boolean => (
      this.active === active
      && (correlation.state === "pending" || correlation.state === "accepted")
      && this.pendingSteerCorrelationsByProviderClientKey.get(correlationKey) === correlation
    );
    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    const recovery = (async (): Promise<void> => {
      let lastCause: unknown = new Error("provider 历史尚未回显 pending steer clientId");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!isCurrentPendingCorrelation()) return;
        try {
          const ownershipEvidence = await this.readProviderTurnOwnershipEvidence(
            ws,
            sessionId,
            correlation.clientUserMessageId,
            10_000,
          );
          const turns = ownershipEvidence.turns;
          const ownedTurnMatch = ownershipEvidence.match;
          const observedProviderTurnId = String(
            correlation.confirmedProviderTurnId ?? correlation.providerObservedTurnId ?? "",
          ).trim();
          const observedProviderTurnConflict = ownedTurnMatch.kind === "unique"
            && Boolean(observedProviderTurnId)
            && ownedTurnMatch.turnId !== observedProviderTurnId;
          if (
            this.active === active
            && (ownedTurnMatch.kind === "ambiguous" || observedProviderTurnConflict)
          ) {
            const conflictingProviderTurnIds = ownedTurnMatch.kind === "ambiguous"
              ? ownedTurnMatch.turnIds
              : ownedTurnMatch.kind === "unique"
                ? [observedProviderTurnId, ownedTurnMatch.turnId]
                : [];
            const error = buildCodexTurnOwnershipAmbiguousError({
              sessionId,
              clientTurnId: active.clientTurnId,
              clientUserMessageId: correlation.clientUserMessageId,
              providerTurnIds: conflictingProviderTurnIds,
            });
            correlation.ownershipRecoveryExhausted = true;
            this.rejectActiveForProviderOwnershipFailure(active, error, "steer-ownership-ambiguous");
            return;
          }
          if (!isCurrentPendingCorrelation()) return;
          if (!ownershipEvidence.complete) {
            const error = buildCodexTurnOwnershipScanIncompleteError({
              sessionId,
              clientTurnId: active.clientTurnId,
              clientUserMessageId: correlation.clientUserMessageId,
              cause: ownershipEvidence.incompleteCause,
            });
            correlation.ownershipRecoveryExhausted = true;
            this.rejectActiveForProviderOwnershipFailure(active, error, "steer-ownership-scan-incomplete", false);
            return;
          }
          const ownedTurnId = ownedTurnMatch.kind === "unique" ? ownedTurnMatch.turnId : null;
          if (ownedTurnId) {
            const ownedTurn = turns.find((turn) => String(turn?.id ?? "").trim() === ownedTurnId) ?? null;
            const ownedStatus = normalizeCodexTurnStatus(ownedTurn?.status);
            this.confirmSteerOwnership(
              correlation,
              ownedTurnId,
              ownedStatus,
              { thread: { id: sessionId, turns } },
            );
            return;
          }
          lastCause = new Error(`最近 ${turns.length} 个 provider turn 未找到 steer clientUserMessageId=${correlation.clientUserMessageId}`);
        } catch (error) {
          if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
          lastCause = error;
        }
        if (!isCurrentPendingCorrelation()) return;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
      if (!isCurrentPendingCorrelation()) return;
      const latestCorrelation = this.getLatestPendingSteerCorrelation(active);
      if (latestCorrelation && latestCorrelation !== correlation) {
        this.pendingSteerOwnershipRecoveryRequested = true;
        return;
      }
      correlation.ownershipRecoveryExhausted = true;
      const error = buildCodexSteerOwnershipLostError({
        sessionId,
        clientTurnId: active.clientTurnId,
        clientUserMessageId: correlation.clientUserMessageId,
        cause: lastCause,
      });
      this.log("error", () => ({ message: "pending steer ownership recovery failed", data: {
        code: String(engineDiagnosticField(error, "code")),
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId,
        clientTurnId: active.clientTurnId,
        clientUserMessageId: correlation.clientUserMessageId,
        error: engineDiagnosticCause(error),
      } }));
      this.rejectActiveForProviderOwnershipFailure(active, error, "steer-ownership-lost", false);
    })();
    this.pendingSteerOwnershipRecovery = recovery;
    correlation.ownershipRecoveryPromise = recovery;
    this.observeDiagnosticTask(() => (recovery.catch((error) => {
      this.log("error", () => ({ message: "pending steer ownership recovery task failed", data: {
        code: "codex_steer_ownership_recovery_task_failed",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId,
        clientTurnId: active.clientTurnId,
        clientUserMessageId: correlation.clientUserMessageId,
        error: engineDiagnosticCause(error),
      } }), { reason: error });
      if (isCurrentPendingCorrelation()) {
        correlation.ownershipRecoveryExhausted = true;
        this.rejectActiveForProviderOwnershipFailure(
          active,
          error instanceof Error ? error : new Error(String(error)),
          "steer-ownership-recovery-task-failed",
          false,
        );
      }
    }).finally(() => {
      if (this.pendingSteerOwnershipRecovery === recovery) this.pendingSteerOwnershipRecovery = null;
      if (correlation.ownershipRecoveryPromise === recovery) correlation.ownershipRecoveryPromise = null;
      if (
        this.active === active
        && !correlation.ownershipRecoveryExhausted
        && (this.pendingSteerOwnershipRecoveryRequested || this.getLatestPendingSteerCorrelation(active))
      ) {
        this.pendingSteerOwnershipRecoveryRequested = false;
        queueMicrotask(() => this.schedulePendingSteerOwnershipRecovery(active));
      } else if (
        correlation.state === "interrupted"
        && this.pendingSteerCorrelationsByProviderClientKey.get(correlationKey) === correlation
      ) {
        queueMicrotask(() => this.scheduleInterruptedSteerOwnershipRecovery(correlation));
      }
    })));
  }

  /** 普通 start 只信任响应 ID；clientId 回显仅路由同 ID 事件或确权 steer/detached 中断。 */
  private bindProviderTurnFromUserMessageEcho(
    method: string,
    params: Record<string, unknown> | undefined,
    providerTurnId: string | null,
  ): TurnId | null {
    const clientUserMessageId = extractCodexUserMessageClientId(method, params);
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    if (!clientUserMessageId || !normalizedTurnId) return null;
    const currentProviderThreadId = this.sessionId;
    const steerCorrelation = currentProviderThreadId
      ? this.pendingSteerCorrelationsByProviderClientKey.get(
          buildCodexProviderClientCorrelationKey(currentProviderThreadId, clientUserMessageId),
        ) ?? null
      : null;

    const startingCandidates = [
      this.startingTurn,
      this.pendingHandoffStartingTurn,
      this.active?.providerOwnershipStartingTurn ?? null,
    ]
      .filter((turn): turn is StartingTurn => Boolean(
        turn
        && turn.startRequestSent
        && !turn.providerOwnershipConflict
        && turn.clientUserMessageId === clientUserMessageId
        && (!turn.providerThreadId || turn.providerThreadId === currentProviderThreadId)
      ));
    for (const pending of this.pendingInterruptedStartingTurns.values()) {
      if (
        pending.providerThreadId === currentProviderThreadId
        && !pending.providerOwnershipConflict
        && pending.clientUserMessageId === clientUserMessageId
      ) {
        startingCandidates.push(pending);
      }
    }
    const uniqueStartingCandidates = Array.from(
      new Map(startingCandidates.map((turn) => [turn.clientTurnId, turn])).values(),
    );
    const active = this.active?.clientUserMessageIds.has(clientUserMessageId) ? this.active : null;
    const activeOwnershipConflict = active?.providerOwnershipStartingTurn?.providerOwnershipConflict ?? null;
    if (activeOwnershipConflict) throw activeOwnershipConflict;
    const candidateTurnIds = new Set<TurnId>(uniqueStartingCandidates.map((turn) => turn.clientTurnId));
    if (active) candidateTurnIds.add(active.clientTurnId);
    if (steerCorrelation) candidateTurnIds.add(steerCorrelation.clientTurnId);
    const existingClientTurnId = this.clientTurnIdByCodexTurnId.get(normalizedTurnId) ?? null;
    if (
      existingClientTurnId
      && (candidateTurnIds.size !== 1 || !candidateTurnIds.has(existingClientTurnId))
    ) {
      this.log("info", () => ({ message: "provider user message kept existing turn owner", data: {
        code: "codex_provider_user_message_existing_owner_preserved",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId: currentProviderThreadId,
        providerTurnId: normalizedTurnId,
        existingClientTurnId,
        candidateTurnIds: Array.from(candidateTurnIds),
      } }));
      return existingClientTurnId;
    }

    const ordinaryStartingTurn = uniqueStartingCandidates.find((turn) => (
      this.pendingInterruptedStartingTurns.get(turn.clientTurnId) !== turn
      && (
        this.startingTurn === turn
        || this.pendingHandoffStartingTurn === turn
        || active?.providerOwnershipStartingTurn === turn
      )
    )) ?? null;
    if (!steerCorrelation && ordinaryStartingTurn) {
      if (active?.clientTurnId === ordinaryStartingTurn.clientTurnId) {
        if (active.codexTurnId !== normalizedTurnId) {
          this.log("info", () => ({ message: "provider user message did not replace turn/start binding", data: {
            code: "codex_provider_user_message_start_binding_preserved",
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            sessionId: currentProviderThreadId,
            clientTurnId: active.clientTurnId,
            responseProviderTurnId: active.codexTurnId,
            echoedProviderTurnId: normalizedTurnId,
          } }));
          return null;
        }
        return active.clientTurnId;
      }
      return null;
    }

    if (candidateTurnIds.size === 0) {
      this.log("warn", () => ({ message: "provider user message correlation unresolved", data: {
        code: "codex_user_message_correlation_missing",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId: this.sessionId,
        providerTurnId: normalizedTurnId,
        clientUserMessageId,
        candidateTurnIds: Array.from(candidateTurnIds),
      } }));
      return null;
    }
    if (candidateTurnIds.size > 1) {
      throw buildCodexTurnOwnershipAmbiguousError({
        sessionId: currentProviderThreadId ?? this.opts.threadId,
        clientTurnId: active?.clientTurnId ?? Array.from(candidateTurnIds)[0]!,
        clientUserMessageId,
        providerTurnIds: [normalizedTurnId],
        localCandidateTurnIds: Array.from(candidateTurnIds),
      });
    }

    const clientTurnId = Array.from(candidateTurnIds)[0]!;
    const startingTurn = uniqueStartingCandidates.find((turn) => turn.clientTurnId === clientTurnId) ?? null;
    const activeSequence = active
      ? this.ensureActiveClientUserMessageSequences(active).get(clientUserMessageId) ?? -1
      : -1;
    const confirmedProviderTurnIds = [
      startingTurn?.providerLifecycleTurnId ?? null,
      steerCorrelation?.confirmedProviderTurnId ?? null,
      active
        && active.codexTurnBindingSource === "provider_lifecycle"
        && activeSequence === (active.confirmedClientUserMessageSequence ?? -1)
        ? active.codexTurnId
        : null,
    ].filter((turnId): turnId is string => Boolean(turnId));
    const conflictingProviderTurnId = confirmedProviderTurnIds.find((turnId) => turnId !== normalizedTurnId) ?? null;
    if (conflictingProviderTurnId) {
      throw buildCodexTurnOwnershipAmbiguousError({
        sessionId: currentProviderThreadId ?? this.opts.threadId,
        clientTurnId,
        clientUserMessageId,
        providerTurnIds: [conflictingProviderTurnId, normalizedTurnId],
      });
    }
    if (startingTurn) {
      const previousTurnId = this.codexTurnIdByClientTurnId.get(clientTurnId) ?? null;
      if (this.pendingInterruptedStartingTurns.get(clientTurnId) === startingTurn) {
        this.bindRetiredProviderTurnCorrelation(startingTurn, normalizedTurnId);
      } else if (active?.clientTurnId !== clientTurnId && previousTurnId !== normalizedTurnId) {
        this.bindCodexTurn(clientTurnId, normalizedTurnId, previousTurnId, currentProviderThreadId);
        if (previousTurnId && this.clientTurnIdByCodexTurnId.get(previousTurnId) === clientTurnId) {
          this.clientTurnIdByCodexTurnId.delete(previousTurnId);
          this.retireProviderTurnId(previousTurnId);
        }
      }
    }

    if (steerCorrelation) {
      const terminalStatus = this.getProviderTerminalStatus(currentProviderThreadId, normalizedTurnId);
      this.confirmSteerOwnership(steerCorrelation, normalizedTurnId, terminalStatus);
    } else if (active?.clientTurnId === clientTurnId) {
      if (this.canAdvanceActiveOwnership(active, clientUserMessageId)) {
        const sequence = this.ensureActiveClientUserMessageSequences(active).get(clientUserMessageId) ?? -1;
        if (active.codexTurnId !== normalizedTurnId) {
          this.replaceActiveCodexTurnId(active, normalizedTurnId, "provider_lifecycle");
        } else {
          this.bindActiveCodexTurn(active, normalizedTurnId, "provider_lifecycle");
        }
        active.confirmedClientUserMessageSequence = sequence;
      } else {
        this.log("info", () => ({ message: "stale provider user message echo did not replace newer ownership", data: {
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId: this.sessionId,
          clientTurnId,
          clientUserMessageId,
          providerTurnId: normalizedTurnId,
          confirmedSequence: active.confirmedClientUserMessageSequence ?? -1,
        } }));
      }
      const terminalStatus = this.getProviderTerminalStatus(currentProviderThreadId, normalizedTurnId);
      if (
        active.codexTurnId === normalizedTurnId
        && terminalStatus
        && isTerminalCodexTurnStatus(terminalStatus)
      ) {
        this.settleActiveFromProviderTerminal(
          active,
          terminalStatus,
          "provider-user-message-correlation-after-terminal",
          null,
        );
      }
    }
    if (startingTurn) {
      startingTurn.providerLifecycleTurnId = normalizedTurnId;
      this.clearStartingTurnOwnershipRecoveryTimer(startingTurn);
      startingTurn.signalProviderOwnership();
      this.scheduleStartingTurnReconcile(startingTurn, "provider-user-message-correlation");
    }
    return clientTurnId;
  }

  /** started 只能确认当前同 ID provisional 映射，不能把其他 live head 换成本地 turn。 */
  private bindActiveCodexTurnFromProviderLifecycleEvent(
    method: string,
    _params: Record<string, unknown> | undefined,
    providerTurnId: string | null,
  ): void {
    const active = this.active;
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    if (!active || !normalizedTurnId) return;
    if (method !== "turn/started") return;
    if (
      this.retiredCodexTurnIds.has(normalizedTurnId)
      || this.terminalObservedProviderTurnStatusById.has(normalizedTurnId)
    ) {
      return;
    }
    if (active.codexTurnId !== normalizedTurnId) return;
    this.bindActiveCodexTurn(active, normalizedTurnId, "provider_lifecycle");
  }

  /** 只记录当前 attempt 的 started 证据，不凭 response/head 猜测 ownership。 */
  private observeStartingTurnProviderStart(
    method: string,
    params: Record<string, unknown> | undefined,
    providerTurnId: string | null,
  ): void {
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    if (method !== "turn/started" || !normalizedTurnId) return;
    if (
      this.retiredCodexTurnIds.has(normalizedTurnId)
      || this.terminalObservedProviderTurnStatusById.has(normalizedTurnId)
    ) {
      return;
    }
    const eventThreadId = String((params as any)?.threadId ?? (params as any)?.thread_id ?? "").trim();
    if (!eventThreadId) {
      this.log("warn", () => ({ message: "started evidence without provider thread is ignored", data: {
        code: "codex_start_evidence_thread_missing",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        providerTurnId: normalizedTurnId,
      } }));
      return;
    }
    const candidates = [
      this.startingTurn,
      this.pendingHandoffStartingTurn,
      this.active?.providerOwnershipStartingTurn ?? null,
      ...this.pendingInterruptedStartingTurns.values(),
    ].filter((candidate): candidate is StartingTurn => Boolean(
      candidate
      && candidate.startRequestSent
      && !candidate.providerOwnershipConflict
      && candidate.providerThreadId === eventThreadId
      && (candidate.pendingStartRequestAttemptId != null || candidate.lastStartRequestAttemptId != null)
      && (
        candidate.pendingStartRequestAttemptId != null
          || !candidate.providerTurnId
          || candidate.providerTurnId === normalizedTurnId
      )
      && !(
        candidate.pendingStartRequestAttemptId != null
        && candidate.pendingStartRequestAttemptId > 1
        && candidate.providerStartedTurnIdsSeen.has(normalizedTurnId)
      )
      && !this.retiredCodexTurnIds.has(normalizedTurnId)
      && !this.terminalObservedProviderTurnStatusById.has(normalizedTurnId)
      && !this.getProviderTerminalStatus(eventThreadId, normalizedTurnId)
    ));
    const uniqueCandidates = Array.from(
      new Map(candidates.map((candidate) => [candidate.clientTurnId, candidate])).values(),
    );
    const responseMatched = uniqueCandidates.filter(
      (candidate) => candidate.providerTurnId === normalizedTurnId,
    );
    const targets = responseMatched.length === 1
      ? responseMatched
      : responseMatched.length > 1
        ? []
        : uniqueCandidates.length === 1
          ? uniqueCandidates
          : [];
    if (!targets.length && uniqueCandidates.length > 1) {
      this.log("error", () => ({ message: "started evidence has multiple local attempt candidates", data: {
        code: "codex_start_evidence_ambiguous",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        providerThreadId: eventThreadId,
        providerTurnId: normalizedTurnId,
        candidateTurnIds: uniqueCandidates.map((candidate) => candidate.clientTurnId),
      } }));
      return;
    }
    for (const candidate of targets) {
      const attemptId = candidate.pendingStartRequestAttemptId ?? candidate.lastStartRequestAttemptId;
      if (attemptId == null) continue;
      candidate.providerStartedTurnKeys.add(
        buildCodexProviderStartEvidenceKey(eventThreadId, attemptId, normalizedTurnId),
      );
      candidate.providerStartedTurnIdsSeen.add(normalizedTurnId);
    }
  }

  /** 当前 attempt 的 fulfilled response 仅延长只读对账窗口，不建立映射或指定中断目标。 */
  private extendStartingTurnOwnershipRecoveryFromStartResponse(
    startingTurn: StartingTurn,
    attemptId: number,
    providerTurnId: string,
  ): void {
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    const providerThreadId = startingTurn.providerThreadId;
    if (!providerThreadId || !normalizedTurnId) return;
    if (
      startingTurn.providerOwnershipConflict
      || startingTurn.providerLifecycleTurnId
      || startingTurn.startRequestAttemptSequence !== attemptId
      || !(
        this.startingTurn === startingTurn
        || this.pendingHandoffStartingTurn === startingTurn
        || this.active?.providerOwnershipStartingTurn === startingTurn
        || this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn
      )
    ) {
      return;
    }
    const key = buildCodexProviderStartEvidenceKey(providerThreadId, attemptId, normalizedTurnId);
    const startedObserved = startingTurn.providerStartedTurnKeys.has(key);
    if (
      startingTurn.providerStartEvidenceAttemptId === attemptId
      && startingTurn.providerStartEvidenceTurnId === normalizedTurnId
    ) {
      return;
    }
    startingTurn.providerStartEvidenceAttemptId = attemptId;
    startingTurn.providerStartEvidenceTurnId = normalizedTurnId;
    const evidenceGraceMs = this.getActiveOwnershipRecoveryEvidenceTtlMs();
    const nextExpiry = Date.now() + evidenceGraceMs;
    const currentExpiry = Number.isFinite(startingTurn.ownershipRecoveryExpiresAt)
      ? startingTurn.ownershipRecoveryExpiresAt
      : 0;
    if (currentExpiry < nextExpiry) {
      startingTurn.ownershipRecoveryExpiresAt = nextExpiry;
      if (startingTurn.ownershipRecoveryExpiryTimer) {
        clearTimeout(startingTurn.ownershipRecoveryExpiryTimer);
        startingTurn.ownershipRecoveryExpiryTimer = null;
      }
    }
    this.restartStartingTurnOwnershipRecoveryAfterNewEvidence(startingTurn);
    this.armStartingTurnOwnershipExpiryTimer(startingTurn);
    this.log("info", () => ({ message: "provider start response evidence extends ownership recovery", data: {
      code: "codex_start_evidence_observed",
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      providerThreadId,
      clientTurnId: startingTurn.clientTurnId,
      providerTurnId: normalizedTurnId,
      attemptId,
      startedObserved,
      graceMs: evidenceGraceMs,
    } }));
  }

  /** 校验当前 attempt 的已持久化 response 与实时 clientId 回显是否指向同一 provider turn。 */
  private hasExactCurrentStartAttemptEvidence(startingTurn: StartingTurn, providerTurnId: string): boolean {
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    const attemptId = startingTurn.providerStartEvidenceAttemptId;
    return Boolean(
      normalizedTurnId
      && attemptId != null
      && startingTurn.startRequestAttemptSequence === attemptId
      && startingTurn.persistedStartAttemptId === attemptId
      && startingTurn.providerStartEvidenceTurnId === normalizedTurnId
      && startingTurn.persistedStartAttemptProviderTurnId === normalizedTurnId,
    );
  }

  /** 为 raw turn/started 解析精确本地 turn，并隔离已中断启动的迟到 provider ID。 */
  private resolveRawTurnStartedClientTurnId(providerTurnId: string | null): TurnId | null {
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    if (!normalizedTurnId) return null;

    const mappedTurnId = this.clientTurnIdByCodexTurnId.get(normalizedTurnId) ?? null;
    if (mappedTurnId) return mappedTurnId;

    if (
      this.retiredCodexTurnIds.has(normalizedTurnId)
      || this.terminalObservedProviderTurnStatusById.has(normalizedTurnId)
    ) {
      this.log("warn", () => ({ message: "late turn/started ignored for terminal provider turn", data: {
        code: "codex_turn_started_terminal_tombstone",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId: this.sessionId,
        providerTurnId: normalizedTurnId,
      } }));
      return null;
    }

    this.log("warn", () => ({ message: "turn/started has no confirmed local ownership", data: {
      code: "codex_turn_started_unowned",
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      sessionId: this.sessionId,
      providerTurnId: normalizedTurnId,
      pendingInterruptedTurnCount: this.pendingInterruptedStartingTurns.size,
    } }));
    return null;
  }

  /** 记录 startup interrupt 后仍可能返回 provider ID 的启动请求，作为 provider mutation fence。 */
  private rememberInterruptedStartingTurn(startingTurn: StartingTurn): void {
    const alreadyRemembered = this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn;
    this.clearStartingTurnOwnershipRecoveryTimer(startingTurn);
    if (!alreadyRemembered) {
      startingTurn.ownershipRecoveryRetryAt = Date.now() + CODEX_ACTIVE_OWNERSHIP_RECOVERY_INITIAL_DELAY_MS;
      startingTurn.ownershipRecoveryRetryDelayMs = 1_000;
      startingTurn.ownershipRecoveryExpiresAt = Date.now() + CODEX_DETACHED_OWNERSHIP_RECOVERY_TTL_MS;
      this.pendingInterruptedStartingTurns.delete(startingTurn.clientTurnId);
      this.pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);
    }
    this.reportDetachedProviderCorrelationPressure();
    this.scheduleStartingTurnOwnershipRecovery(startingTurn);
  }

  /** 未确权停止后保留原 provider thread，并串行等待精确 ownership/终态恢复。 */
  private preserveUnownedProviderGeneration(startingTurn: StartingTurn, reason: string): void {
    const providerThreadId = startingTurn.providerThreadId;
    if (!providerThreadId) {
      this.log("error", () => ({ message: "cannot preserve unowned provider generation without thread id", data: {
        code: "codex_provider_generation_preserve_identity_missing",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        clientTurnId: startingTurn.clientTurnId,
        reason,
      } }));
      return;
    }
    if (this.sessionId !== providerThreadId) {
      this.registerDetachedProviderThreadObserver(providerThreadId);
    }
    this.scheduleStartingTurnOwnershipRecovery(startingTurn);
    this.reportDetachedProviderCorrelationPressure();
    this.log("warn", () => ({ message: "retained unowned provider generation after interrupt", data: {
      code: "codex_provider_generation_retained",
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      providerThreadId,
      clientTurnId: startingTurn.clientTurnId,
      clientUserMessageId: startingTurn.clientUserMessageId,
      reason,
      impact: "the next local message waits for this provider thread and preserves its context",
    } }));
  }

  /** active 收口仍有未确权 steer 时保留其 provider generation，并后台等待精确回显。 */
  private preserveUnownedSteerProviderGeneration(
    correlations: PendingSteerCorrelation[],
    reason: string,
  ): void {
    const now = Date.now();
    const providerThreadIds = new Set<SessionId>();
    for (const correlation of correlations) {
      this.clearSteerOwnershipRecoveryTimer(correlation);
      if (correlation.ownershipRecoveryExpiresAt <= 0) {
        correlation.ownershipRecoveryExpiresAt = now + CODEX_DETACHED_OWNERSHIP_RECOVERY_TTL_MS;
        correlation.ownershipRecoveryRetryAt = now + CODEX_ACTIVE_OWNERSHIP_RECOVERY_INITIAL_DELAY_MS;
      }
      providerThreadIds.add(correlation.providerThreadId);
    }
    const currentProviderThreadId = this.sessionId;
    this.reportDetachedProviderCorrelationPressure();
    for (const correlation of correlations) {
      const correlationKey = buildCodexProviderClientCorrelationKey(
        correlation.providerThreadId,
        correlation.clientUserMessageId,
      );
      if (this.pendingSteerCorrelationsByProviderClientKey.get(correlationKey) !== correlation) continue;
      if (correlation.providerThreadId !== currentProviderThreadId) {
        this.registerDetachedProviderThreadObserver(correlation.providerThreadId);
      }
      this.scheduleInterruptedSteerOwnershipRecovery(correlation);
    }
    this.log("warn", () => ({ message: "retained provider generation with unowned steer", data: {
      code: "codex_steer_provider_generation_retained",
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      providerThreadIds: Array.from(providerThreadIds),
      clientTurnId: correlations[0]?.clientTurnId ?? null,
      clientUserMessageIds: correlations.map((correlation) => correlation.clientUserMessageId),
      reason,
      impact: "the next local message waits for this provider thread and preserves its context",
    } }));
  }

  /** 为已隔离 provider thread 保留轻量事件观察器，只做精确 clientId 关联与补偿。 */
  private registerDetachedProviderThreadObserver(providerThreadId: SessionId): void {
    if (this.detachedProviderThreadUnregisterById.has(providerThreadId)) return;
    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    const unregister = ws.registerThread(providerThreadId, (msg) => {
      this.onDetachedProviderThreadMessage(providerThreadId, msg);
    });
    this.detachedProviderThreadUnregisterById.set(providerThreadId, unregister);
  }

  /** 新证据到达时重启一次 starting ownership 扫描；在途扫描只合并一个后续重扫。 */
  private restartStartingTurnOwnershipRecoveryAfterNewEvidence(startingTurn: StartingTurn): void {
    const detached = this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn;
    if (startingTurn.providerOwnershipConflict && !detached) {
      this.clearStartingTurnOwnershipRecoveryRetryTimer(startingTurn);
      return;
    }
    if (startingTurn.ownershipRecoveryPromise) {
      startingTurn.ownershipRecoveryRescanRequested = true;
      return;
    }
    startingTurn.ownershipRecoveryRescanRequested = false;
    startingTurn.ownershipRecoveryExhausted = false;
    // 重扫只替换 retry timer；wall-clock expiry 必须跨越在途扫描继续存在。
    this.clearStartingTurnOwnershipRecoveryRetryTimer(startingTurn);
    startingTurn.ownershipRecoveryRetryAt = Date.now() + CODEX_ACTIVE_OWNERSHIP_RECOVERY_INITIAL_DELAY_MS;
    this.scheduleStartingTurnOwnershipRecovery(startingTurn);
  }

  /** 新证据到达时重启一次 steer ownership 扫描；在途扫描只合并一个后续重扫。 */
  private restartSteerOwnershipRecoveryAfterNewEvidence(correlation: PendingSteerCorrelation): void {
    if (correlation.ownershipRecoveryPromise) {
      correlation.ownershipRecoveryRescanRequested = true;
      return;
    }
    correlation.ownershipRecoveryRescanRequested = false;
    correlation.ownershipRecoveryExhausted = false;
    this.clearSteerOwnershipRecoveryTimer(correlation);
    correlation.ownershipRecoveryRetryAt = Date.now() + CODEX_ACTIVE_OWNERSHIP_RECOVERY_INITIAL_DELAY_MS;
    this.scheduleInterruptedSteerOwnershipRecovery(correlation);
  }

  /** 暂存 detached starting 的实时 clientId 候选，稳定后交给 full history 唯一性校验。 */
  private observeDetachedStartingTurnOwnershipCandidate(
    startingTurn: StartingTurn,
    providerTurnId: string,
  ): void {
    if (startingTurn.providerOwnershipConflict) {
      this.log("info", () => ({ message: "detached starting ownership evidence ignored after ownership fence", data: {
        code: "codex_detached_start_evidence_ownership_fenced",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        providerThreadId: startingTurn.providerThreadId,
        clientTurnId: startingTurn.clientTurnId,
        providerTurnId,
      } }));
      return;
    }
    const previousObservedTurnId = String(startingTurn.providerObservedTurnId ?? "").trim();
    if (previousObservedTurnId && previousObservedTurnId !== providerTurnId) {
      throw buildCodexTurnOwnershipAmbiguousError({
        sessionId: startingTurn.providerThreadId ?? this.opts.threadId,
        clientTurnId: startingTurn.clientTurnId,
        clientUserMessageId: startingTurn.clientUserMessageId,
        providerTurnIds: [previousObservedTurnId, providerTurnId],
      });
    }
    if (previousObservedTurnId === providerTurnId) return;
    startingTurn.providerObservedTurnId = providerTurnId;
    this.restartStartingTurnOwnershipRecoveryAfterNewEvidence(startingTurn);
  }

  /** 暂存 detached steer 的实时 clientId 候选，稳定后交给 full history 唯一性校验。 */
  private observeDetachedSteerOwnershipCandidate(
    correlation: PendingSteerCorrelation,
    providerTurnId: string,
  ): void {
    const previousObservedTurnId = String(correlation.providerObservedTurnId ?? "").trim();
    if (previousObservedTurnId && previousObservedTurnId !== providerTurnId) {
      throw buildCodexTurnOwnershipAmbiguousError({
        sessionId: correlation.providerThreadId,
        clientTurnId: correlation.clientTurnId,
        clientUserMessageId: correlation.clientUserMessageId,
        providerTurnIds: [previousObservedTurnId, providerTurnId],
      });
    }
    if (previousObservedTurnId === providerTurnId) return;
    correlation.providerObservedTurnId = providerTurnId;
    this.restartSteerOwnershipRecoveryAfterNewEvidence(correlation);
  }

  /** detached generation 的事件不得进入当前 active，只允许精确 tombstone 关联。 */
  private onDetachedProviderThreadMessage(providerThreadId: SessionId, msg: CodexAppServerMessage): void {
    if (this.disposed) return;
    const method = String((msg as any)?.method ?? "");
    const params = (msg as any)?.params as Record<string, unknown> | undefined;
    const eventThreadId = String((params as any)?.threadId ?? (params as any)?.thread_id ?? "").trim();
    if (eventThreadId && eventThreadId !== String(providerThreadId)) {
      this.log("error", () => ({ message: "detached provider event thread mismatch isolated", data: {
        code: "codex_detached_provider_event_thread_mismatch",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        expectedProviderThreadId: providerThreadId,
        actualProviderThreadId: eventThreadId,
        method,
      } }));
      return;
    }

    const providerTurnId = this.extractCodexEventTurnId(method, params);
    this.observeStartingTurnProviderStart(method, params, providerTurnId);
    const clientUserMessageId = extractCodexUserMessageClientId(method, params);
    let clientTurnId: TurnId | null = null;
    let correlationHandled = false;
    let correlationRelevant = false;
    if (clientUserMessageId && providerTurnId) {
      const startingTurn = Array.from(this.pendingInterruptedStartingTurns.values()).find((candidate) => (
        candidate.providerThreadId === providerThreadId
        && !candidate.providerOwnershipConflict
        && candidate.clientUserMessageId === clientUserMessageId
      )) ?? null;
      const steer = this.pendingSteerCorrelationsByProviderClientKey.get(
        buildCodexProviderClientCorrelationKey(providerThreadId, clientUserMessageId),
      ) ?? null;
      if (startingTurn && steer && startingTurn.clientTurnId !== steer.clientTurnId) {
        this.log("error", () => ({ message: "detached provider clientId belongs to multiple local turns", data: {
          code: "codex_detached_provider_correlation_ambiguous",
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          providerThreadId,
          providerTurnId,
          clientUserMessageId,
          candidateTurnIds: [startingTurn.clientTurnId, steer.clientTurnId],
        } }));
        startingTurn.ownershipRecoveryExhausted = true;
        steer.ownershipRecoveryExhausted = true;
      } else {
        try {
          if (startingTurn) {
            if (
              startingTurn.providerLifecycleTurnId
              || this.hasExactCurrentStartAttemptEvidence(startingTurn, providerTurnId)
            ) {
              clientTurnId = this.bindRetiredProviderTurnCorrelation(startingTurn, providerTurnId);
              correlationHandled = true;
            } else {
              this.observeDetachedStartingTurnOwnershipCandidate(startingTurn, providerTurnId);
            }
          }
          if (steer?.providerThreadId === providerThreadId && steer.state === "interrupted") {
            const confirmedProviderTurnId = String(steer.confirmedProviderTurnId ?? "").trim();
            if (confirmedProviderTurnId && confirmedProviderTurnId !== providerTurnId) {
              throw buildCodexTurnOwnershipAmbiguousError({
                sessionId: providerThreadId,
                clientTurnId: steer.clientTurnId,
                clientUserMessageId,
                providerTurnIds: [confirmedProviderTurnId, providerTurnId],
              });
            }
            if (confirmedProviderTurnId) {
              const previousEngineTurnId = this.codexTurnIdByClientTurnId.get(steer.clientTurnId) ?? null;
              this.bindCodexTurn(
                steer.clientTurnId,
                providerTurnId,
                previousEngineTurnId,
                providerThreadId,
              );
              this.confirmSteerOwnership(
                steer,
                providerTurnId,
                this.getProviderTerminalStatus(providerThreadId, providerTurnId),
              );
              clientTurnId = steer.clientTurnId;
              correlationHandled = true;
            } else {
              this.observeDetachedSteerOwnershipCandidate(steer, providerTurnId);
            }
          }
        } catch (error) {
          if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
          const correlationError = error instanceof Error ? error : new Error(String(error));
          const errorCode = String((correlationError as any)?.code ?? "");
          const ownershipAmbiguous = errorCode === "codex_turn_ownership_ambiguous";
          const providerTurnBindingConflict = errorCode === "codex_provider_turn_binding_conflict";
          const isolateCorrelation = ownershipAmbiguous || providerTurnBindingConflict;
          if (isolateCorrelation) {
            if (startingTurn) {
              startingTurn.ownershipRecoveryExhausted = true;
            }
            if (steer) {
              steer.ownershipRecoveryExhausted = true;
            }
          }
          this.log("error", () => ({ message: "detached provider correlation conflict isolated", data: {
            code: "codex_detached_provider_correlation_conflict",
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            providerThreadId,
            providerTurnId,
            clientUserMessageId,
            error: engineDiagnosticCause(correlationError),
            recoveryAction: isolateCorrelation ? "retained" : "rescheduled",
          } }), { reason: error });
          if (!isolateCorrelation) {
            if (startingTurn) this.restartStartingTurnOwnershipRecoveryAfterNewEvidence(startingTurn);
            if (steer) this.restartSteerOwnershipRecoveryAfterNewEvidence(steer);
          }
        }
      }
      correlationRelevant = Boolean(startingTurn || steer);
    }

    const exactOwnedClientTurnId = providerTurnId
      ? this.findDetachedOwnedClientTurnId(providerThreadId, providerTurnId)
      : null;
    if (exactOwnedClientTurnId) {
      clientTurnId ??= exactOwnedClientTurnId;
      correlationRelevant = true;
      correlationHandled = true;
    }

    if (providerTurnId && isCodexTerminalProviderEvent(method, params)) {
      const terminalStatus = extractCodexTerminalProviderStatus(method, params) ?? "error";
      this.rememberProviderTerminalStatus(providerThreadId, providerTurnId, terminalStatus);
      this.terminalObservedProviderTurnStatusById.set(providerTurnId, terminalStatus);
      const matchedOwnedTurn = this.finalizeInterruptedOwnedTurnFromTerminal(
        providerThreadId,
        providerTurnId,
        terminalStatus,
      );
      if (matchedOwnedTurn) {
        clientTurnId ??= this.findDetachedOwnedClientTurnId(providerThreadId, providerTurnId);
        correlationRelevant = true;
        correlationHandled = true;
      }
    }

    const emitRaw = this.emitters?.raw;
    if (emitRaw && correlationRelevant) {
      emitRaw({
        ts: Date.now(),
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId as any,
        engine: "codex",
        source: "codex.app-server.msg",
        ...(clientTurnId ? { clientTurnId } : {}),
        data: msg,
        handled: correlationHandled,
        action: correlationHandled ? "mapped" : "unhandled",
        emittedTypes: [],
      });
    }
    this.releaseDetachedProviderThreadObserverIfIdle(providerThreadId);
  }

  /** 仅按 provider thread/turn 精确识别 detached owned trace，拒绝转发 foreign delta。 */
  private findDetachedOwnedClientTurnId(
    providerThreadId: SessionId,
    providerTurnId: string,
  ): TurnId | null {
    const clientTurnIds = new Set<TurnId>();
    for (const startingTurn of this.pendingInterruptedStartingTurns.values()) {
      if (
        startingTurn.providerThreadId === providerThreadId
        && startingTurn.providerLifecycleTurnId === providerTurnId
      ) {
        clientTurnIds.add(startingTurn.clientTurnId);
      }
    }
    for (const correlation of this.pendingSteerCorrelationsByProviderClientKey.values()) {
      if (
        correlation.providerThreadId === providerThreadId
        && correlation.confirmedProviderTurnId === providerTurnId
      ) {
        clientTurnIds.add(correlation.clientTurnId);
      }
    }
    if (clientTurnIds.size <= 1) return clientTurnIds.values().next().value ?? null;
    this.log("error", () => ({ message: "detached owned provider turn maps to multiple local turns", data: {
      code: "codex_detached_owned_turn_ambiguous",
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      providerThreadId,
      providerTurnId,
      clientTurnIds: Array.from(clientTurnIds),
    } }));
    return null;
  }

  /** 删除多义候选的双向内存映射；候选未证终态，不能写入 retired tombstone。 */
  private discardAmbiguousProviderTurnBindings(
    clientTurnId: TurnId,
    providerTurnIds: Array<string | null | undefined>,
  ): void {
    const candidates = new Set(providerTurnIds.map((turnId) => String(turnId ?? "").trim()).filter(Boolean));
    const currentProviderTurnId = this.codexTurnIdByClientTurnId.get(clientTurnId) ?? null;
    if (currentProviderTurnId && candidates.has(currentProviderTurnId)) {
      this.codexTurnIdByClientTurnId.delete(clientTurnId);
    }
    for (const providerTurnId of candidates) {
      if (this.clientTurnIdByCodexTurnId.get(providerTurnId) === clientTurnId) {
        this.clientTurnIdByCodexTurnId.delete(providerTurnId);
      }
    }
  }

  /** 建立已中断 provider turn 的双向关联；冲突时同步失败，禁止污染后续 turn。 */
  private bindRetiredProviderTurnCorrelation(startingTurn: StartingTurn, providerTurnId: string): TurnId {
    const clientTurnId = startingTurn.clientTurnId;
    if (startingTurn.providerOwnershipConflict) {
      this.log("info", () => ({ message: "retired provider correlation ignored after ownership fence", data: {
        code: "codex_retired_provider_correlation_ownership_fenced",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        providerThreadId: startingTurn.providerThreadId,
        clientTurnId,
        providerTurnId,
      } }));
      return clientTurnId;
    }
    const responseProviderTurnId = String(startingTurn.providerTurnId ?? "").trim();
    if (responseProviderTurnId && responseProviderTurnId !== providerTurnId) {
      this.log("info", () => ({ message: "retired provider correlation ignored in favor of turn/start response", data: {
        code: "codex_retired_provider_correlation_start_response_preserved",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        providerThreadId: startingTurn.providerThreadId,
        clientTurnId,
        responseProviderTurnId,
        ignoredProviderTurnId: providerTurnId,
      } }));
      return clientTurnId;
    }
    const confirmedProviderTurnId = responseProviderTurnId
      || String(startingTurn.providerLifecycleTurnId ?? "").trim();
    if (confirmedProviderTurnId && confirmedProviderTurnId !== providerTurnId) {
      throw buildCodexTurnOwnershipAmbiguousError({
        sessionId: startingTurn.providerThreadId ?? this.opts.threadId,
        clientTurnId,
        clientUserMessageId: startingTurn.clientUserMessageId,
        providerTurnIds: [confirmedProviderTurnId, providerTurnId],
      });
    }
    if (confirmedProviderTurnId === providerTurnId) {
      const terminalStatus = this.getProviderTerminalStatus(startingTurn.providerThreadId, providerTurnId);
      if (terminalStatus && isTerminalCodexTurnStatus(terminalStatus)) {
        this.clearStartingTurnOwnershipRecoveryTimer(startingTurn);
        this.finalizeOwnedStartingTurnTerminal(
          startingTurn,
          providerTurnId,
          terminalStatus,
          "startup-interrupt.repeated-correlation-after-terminal",
        );
        return clientTurnId;
      }
      const providerThreadId = startingTurn.providerThreadId;
      const compensationKey = providerThreadId
        ? buildCodexProviderTurnCorrelationKey(providerThreadId, providerTurnId)
        : null;
      if (
        startingTurn.ownershipRecoveryTimer
        || (compensationKey && this.pendingInterruptedProviderCompensationsByKey.has(compensationKey))
      ) {
        return clientTurnId;
      }
      this.scheduleInterruptedStartingTurnCompensation(startingTurn, providerTurnId);
      return clientTurnId;
    }
    const existingProviderTurnId = this.codexTurnIdByClientTurnId.get(clientTurnId) ?? null;
    const existingClientTurnId = this.clientTurnIdByCodexTurnId.get(providerTurnId) ?? null;
    if (existingProviderTurnId && existingProviderTurnId !== providerTurnId) {
      const provisionalTurnIds = new Set([
        startingTurn.providerTurnId,
      ].filter((turnId): turnId is string => Boolean(turnId)));
      if (!provisionalTurnIds.has(existingProviderTurnId)) {
        throw buildCodexProviderTurnBindingConflictError(
          `Codex 已中断本地 turn 的 provider 关联冲突：threadId=${this.opts.threadId}, turnId=${clientTurnId}, existing=${existingProviderTurnId}, incoming=${providerTurnId}`,
        );
      }
    }
    if (existingClientTurnId && existingClientTurnId !== clientTurnId) {
      throw buildCodexProviderTurnBindingConflictError(
        `Codex provider turn 已关联其他本地 turn：threadId=${this.opts.threadId}, providerTurnId=${providerTurnId}, existing=${existingClientTurnId}, incoming=${clientTurnId}`,
      );
    }
    const recoveryCallback = startingTurn.onProviderTurnRecovered;
    const persistedByRecoveryCallback = Boolean(recoveryCallback);
    recoveryCallback?.(providerTurnId);
    this.bindCodexTurn(
      clientTurnId,
      providerTurnId,
      existingProviderTurnId,
      startingTurn.providerThreadId,
      persistedByRecoveryCallback,
    );
    if (existingProviderTurnId && existingProviderTurnId !== providerTurnId) {
      if (this.clientTurnIdByCodexTurnId.get(existingProviderTurnId) === clientTurnId) {
        this.clientTurnIdByCodexTurnId.delete(existingProviderTurnId);
      }
      this.retireProviderTurnId(existingProviderTurnId);
    }
    startingTurn.providerLifecycleTurnId = providerTurnId;
    this.clearStartingTurnOwnershipRecoveryRetryTimer(startingTurn);
    if (startingTurn.onProviderTurnRecovered === recoveryCallback) {
      startingTurn.onProviderTurnRecovered = null;
    }
    const terminalStatus = this.getProviderTerminalStatus(startingTurn.providerThreadId, providerTurnId);
    if (terminalStatus && isTerminalCodexTurnStatus(terminalStatus)) {
      this.finalizeOwnedStartingTurnTerminal(
        startingTurn,
        providerTurnId,
        terminalStatus,
        "startup-interrupt.provider-terminal-before-client-correlation",
      );
    } else {
      this.scheduleInterruptedStartingTurnCompensation(startingTurn, providerTurnId);
    }
    return clientTurnId;
  }

  /** 按 clientUserMessageId 从 provider 历史恢复真实归属；response/head 只用于诊断。 */
  private scheduleStartingTurnOwnershipRecovery(startingTurn: StartingTurn): void {
    if (this.disposed || startingTurn.providerLifecycleTurnId || !startingTurn.clientUserMessageId) {
      return;
    }
    const interruptedAtSchedule = this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn;
    const activeAtSchedule = this.active?.providerOwnershipStartingTurn === startingTurn ? this.active : null;
    const currentStartingAtSchedule = this.startingTurn === startingTurn;
    const currentHandoffAtSchedule = this.pendingHandoffStartingTurn === startingTurn;
    if (startingTurn.providerOwnershipConflict && !interruptedAtSchedule) {
      this.clearStartingTurnOwnershipRecoveryRetryTimer(startingTurn);
      return;
    }
    if (!interruptedAtSchedule && !activeAtSchedule && !currentStartingAtSchedule && !currentHandoffAtSchedule) {
      return;
    }
    const hasTrackedCurrentState = Boolean(
      activeAtSchedule || currentStartingAtSchedule || currentHandoffAtSchedule,
    );
    const now = Date.now();
    if (!Number.isFinite(startingTurn.ownershipRecoveryExpiresAt) || startingTurn.ownershipRecoveryExpiresAt <= 0) {
      const ttlMs = interruptedAtSchedule
        ? CODEX_DETACHED_OWNERSHIP_RECOVERY_TTL_MS
        : this.getActiveOwnershipRecoveryTtlMs();
      startingTurn.ownershipRecoveryExpiresAt = now + ttlMs;
      const currentRetryAt = Number.isFinite(startingTurn.ownershipRecoveryRetryAt)
        ? startingTurn.ownershipRecoveryRetryAt
        : 0;
      startingTurn.ownershipRecoveryRetryAt = Math.max(
        currentRetryAt,
        now + CODEX_ACTIVE_OWNERSHIP_RECOVERY_INITIAL_DELAY_MS,
      );
      if (!Number.isFinite(startingTurn.ownershipRecoveryRetryDelayMs) || startingTurn.ownershipRecoveryRetryDelayMs <= 0) {
        startingTurn.ownershipRecoveryRetryDelayMs = 1_000;
      }
      this.log("warn", () => ({ message: "startup ownership recovery had invalid expiry and was reinitialized", data: {
        code: "codex_start_ownership_recovery_expiry_reinitialized",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        clientTurnId: startingTurn.clientTurnId,
        providerThreadId: startingTurn.providerThreadId,
        interrupted: interruptedAtSchedule,
        trackedCurrentState: hasTrackedCurrentState,
        ttlMs,
      } }));
    }
    // retryAt=0/NaN 表示尚未安排扫描；保留已有的 past/future retry deadline。
    if (!Number.isFinite(startingTurn.ownershipRecoveryRetryAt) || startingTurn.ownershipRecoveryRetryAt <= 0) {
      startingTurn.ownershipRecoveryRetryAt = now + CODEX_ACTIVE_OWNERSHIP_RECOVERY_INITIAL_DELAY_MS;
    }
    this.armStartingTurnOwnershipExpiryTimer(startingTurn);
    if (startingTurn.ownershipRecoveryPromise) return;
    if (
      interruptedAtSchedule
      && startingTurn.providerThreadId
      && startingTurn.ownershipRecoveryExpiresAt > 0
      && Date.now() >= startingTurn.ownershipRecoveryExpiresAt
    ) {
      this.expireDetachedStartingTurnCorrelation(startingTurn);
      return;
    }
    if (
      activeAtSchedule
      && startingTurn.ownershipRecoveryExpiresAt > 0
      && Date.now() >= startingTurn.ownershipRecoveryExpiresAt
    ) {
      this.failCurrentStartingTurnOwnershipRecovery(startingTurn);
      return;
    }
    if (startingTurn.ownershipRecoveryExhausted) {
      if (interruptedAtSchedule && startingTurn.ownershipRecoveryExpiresAt > 0) {
        startingTurn.ownershipRecoveryRetryAt = startingTurn.ownershipRecoveryExpiresAt;
        this.armStartingTurnOwnershipRecoveryTimer(startingTurn);
      }
      return;
    }
    if (Date.now() < startingTurn.ownershipRecoveryRetryAt) {
      this.armStartingTurnOwnershipRecoveryTimer(startingTurn);
      return;
    }
    // 扫描开始时只清掉本轮 retry timer，不能清除独立的 wall-clock expiry。
    this.clearStartingTurnOwnershipRecoveryRetryTimer(startingTurn);
    const sessionId = startingTurn.providerThreadId ?? this.sessionId;
    if (!sessionId) {
      this.log("error", () => ({ message: "late startup ownership recovery missing provider thread", data: {
        code: "codex_late_start_ownership_thread_missing",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        clientTurnId: startingTurn.clientTurnId,
        clientUserMessageId: startingTurn.clientUserMessageId,
      } }));
      return;
    }
    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    const recovery = (async (): Promise<void> => {
      let lastCause: unknown = new Error("provider history 尚未回显 clientUserMessageId");
      const interruptedAtRequest = this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn;
      try {
        const remainingOwnershipTtlMs = startingTurn.ownershipRecoveryExpiresAt > 0
          ? Math.max(1, startingTurn.ownershipRecoveryExpiresAt - Date.now())
          : (interruptedAtRequest ? 10_000 : CODEX_ACTIVE_OWNERSHIP_RECOVERY_TIMEOUT_MS);
        const ownershipEvidence = await this.readProviderTurnOwnershipEvidence(
          ws,
          sessionId,
          startingTurn.clientUserMessageId,
          Math.min(
            interruptedAtRequest ? 10_000 : CODEX_ACTIVE_OWNERSHIP_RECOVERY_TIMEOUT_MS,
            remainingOwnershipTtlMs,
          ),
        );
        const interrupted = this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn;
        const active = this.active?.providerOwnershipStartingTurn === startingTurn ? this.active : null;
        const currentStarting = this.startingTurn === startingTurn;
        const currentHandoff = this.pendingHandoffStartingTurn === startingTurn;
        const locallyTracked = interrupted
          || Boolean(active)
          || currentStarting
          || currentHandoff;
        if (!locallyTracked) {
          this.log("info", () => ({ message: "stale startup ownership recovery ignored after correlation release", data: {
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            sessionId,
            clientTurnId: startingTurn.clientTurnId,
            clientUserMessageId: startingTurn.clientUserMessageId,
          } }));
          return;
        }
        if (startingTurn.providerOwnershipConflict && !interrupted) {
          this.log("info", () => ({ message: "startup ownership recovery ignored after ownership fence", data: {
            code: "codex_start_ownership_recovery_ownership_fenced",
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            sessionId,
            clientTurnId: startingTurn.clientTurnId,
            clientUserMessageId: startingTurn.clientUserMessageId,
          } }));
          return;
        }
        if (startingTurn.providerOwnershipConflict) {
          this.log("info", () => ({ message: "detached startup ownership scan retained for compensation only", data: {
            code: "codex_detached_start_ownership_fenced_for_compensation",
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            sessionId,
            clientTurnId: startingTurn.clientTurnId,
            clientUserMessageId: startingTurn.clientUserMessageId,
          } }));
        }
        if (
          startingTurn.providerThreadId !== sessionId
          || (!interrupted && this.sessionId !== sessionId)
        ) {
          this.log("info", () => ({ message: "stale startup ownership recovery ignored after generation changed", data: {
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            expectedSessionId: sessionId,
            currentSessionId: this.sessionId,
            startingTurnSessionId: startingTurn.providerThreadId,
            clientTurnId: startingTurn.clientTurnId,
          } }));
          return;
        }
        const turns = ownershipEvidence.turns;
        const ownedTurnMatch = ownershipEvidence.match;
        const confirmedProviderTurnId = String(startingTurn.providerLifecycleTurnId ?? "").trim();
        const observedProviderTurnId = String(
          confirmedProviderTurnId || startingTurn.providerObservedTurnId || "",
        ).trim();
        const observedProviderTurnConflict = ownedTurnMatch.kind === "unique"
          && Boolean(observedProviderTurnId)
          && ownedTurnMatch.turnId !== observedProviderTurnId;
        if (ownedTurnMatch.kind === "ambiguous" || observedProviderTurnConflict) {
          const conflictingProviderTurnIds = ownedTurnMatch.kind === "ambiguous"
            ? ownedTurnMatch.turnIds
            : ownedTurnMatch.kind === "unique"
              ? [observedProviderTurnId, ownedTurnMatch.turnId]
              : [];
          const error = buildCodexTurnOwnershipAmbiguousError({
            sessionId,
            clientTurnId: startingTurn.clientTurnId,
            clientUserMessageId: startingTurn.clientUserMessageId,
            providerTurnIds: conflictingProviderTurnIds,
          });
          startingTurn.ownershipRecoveryExhausted = true;
          if (active) {
            this.log("error", () => ({ message: "active startup ownership is ambiguous", data: {
              code: String(engineDiagnosticField(error, "code")),
              workspaceId: this.opts.workspaceId,
              threadId: this.opts.threadId,
              sessionId,
              clientTurnId: startingTurn.clientTurnId,
              clientUserMessageId: startingTurn.clientUserMessageId,
              providerTurnIds: conflictingProviderTurnIds,
            } }));
            this.rejectActiveForProviderOwnershipFailure(active, error, "active-start-ownership-ambiguous");
            return;
          }
          if (interrupted) {
            this.log("error", () => ({ message: "detached startup ownership is ambiguous", data: {
              code: String(engineDiagnosticField(error, "code")),
              workspaceId: this.opts.workspaceId,
              threadId: this.opts.threadId,
              providerThreadId: sessionId,
              clientTurnId: startingTurn.clientTurnId,
              clientUserMessageId: startingTurn.clientUserMessageId,
              providerTurnIds: conflictingProviderTurnIds,
            } }));
            return;
          }
          if (currentStarting) {
            this.rejectStartingForProviderOwnershipFailure(
              startingTurn,
              error,
              "starting-ownership-history-ambiguous",
            );
            return;
          }
          lastCause = error;
        }
        if (startingTurn.providerOwnershipConflict) {
          this.log("info", () => ({ message: "startup ownership history ignored after ownership fence", data: {
            code: "codex_start_ownership_history_ownership_fenced",
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            sessionId,
            clientTurnId: startingTurn.clientTurnId,
            clientUserMessageId: startingTurn.clientUserMessageId,
          } }));
          return;
        }
        if (confirmedProviderTurnId) {
          this.log("info", () => ({ message: "stale startup ownership scan ignored after realtime confirmation", data: {
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            sessionId,
            clientTurnId: startingTurn.clientTurnId,
            clientUserMessageId: startingTurn.clientUserMessageId,
            providerTurnId: confirmedProviderTurnId,
            scanComplete: ownershipEvidence.complete,
          } }));
          return;
        }
        if (!ownershipEvidence.complete) {
          const error = buildCodexTurnOwnershipScanIncompleteError({
            sessionId,
            clientTurnId: startingTurn.clientTurnId,
            clientUserMessageId: startingTurn.clientUserMessageId,
            cause: ownershipEvidence.incompleteCause,
          });
          startingTurn.ownershipRecoveryExhausted = true;
          this.log("error", () => ({ message: "startup ownership scan reached pagination limit", data: {
            code: String(engineDiagnosticField(error, "code")),
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            sessionId,
            clientTurnId: startingTurn.clientTurnId,
            clientUserMessageId: startingTurn.clientUserMessageId,
            interrupted,
          } }));
          if (active) {
            this.rejectActiveForProviderOwnershipFailure(active, error, "active-start-ownership-scan-incomplete");
          } else if (currentStarting) {
            this.rejectStartingForProviderOwnershipFailure(
              startingTurn,
              error,
              "starting-ownership-scan-incomplete",
            );
          } else if (interrupted && startingTurn.ownershipRecoveryExpiresAt > 0) {
            startingTurn.ownershipRecoveryRetryAt = startingTurn.ownershipRecoveryExpiresAt;
            this.armStartingTurnOwnershipRecoveryTimer(startingTurn);
          }
          return;
        }
        const ownedTurnId = ownedTurnMatch.kind === "unique"
          && !observedProviderTurnConflict
          ? ownedTurnMatch.turnId
          : null;
        if (ownedTurnId) {
          const ownedTurn = turns.find((turn) => String(turn?.id ?? "").trim() === ownedTurnId) ?? null;
          const ownedTurnStatus = normalizeCodexTurnStatus(ownedTurn?.status);
          if (startingTurn.providerOwnershipConflict) {
            if (interrupted && ownedTurnStatus && isTerminalCodexTurnStatus(ownedTurnStatus)) {
              this.rememberProviderTerminalStatus(sessionId, ownedTurnId, ownedTurnStatus);
              this.retireProviderTurnId(ownedTurnId);
              this.forgetInterruptedStartingTurn(startingTurn);
            } else if (interrupted) {
              this.scheduleInterruptedStartingTurnCompensation(startingTurn, ownedTurnId);
            }
            return;
          }
          if (interrupted) {
            if (ownedTurnStatus && isTerminalCodexTurnStatus(ownedTurnStatus)) {
              this.rememberProviderTerminalStatus(sessionId, ownedTurnId, ownedTurnStatus);
            }
            this.bindRetiredProviderTurnCorrelation(startingTurn, ownedTurnId);
            startingTurn.signalProviderOwnership();
            return;
          }
          if (active) {
            const confirmedStartingTurnId = String(startingTurn.providerLifecycleTurnId ?? "").trim();
            const startingSequence = this.ensureActiveClientUserMessageSequences(active)
              .get(startingTurn.clientUserMessageId) ?? 0;
            const confirmedSequence = active.confirmedClientUserMessageSequence ?? -1;
            const sameCorrelationConflict = (
              confirmedStartingTurnId
              && confirmedStartingTurnId !== ownedTurnId
            ) || (
              active.codexTurnId
              && active.codexTurnId !== ownedTurnId
              && confirmedSequence <= startingSequence
            );
            if (sameCorrelationConflict) {
              const error = buildCodexTurnOwnershipAmbiguousError({
                sessionId,
                clientTurnId: startingTurn.clientTurnId,
                clientUserMessageId: startingTurn.clientUserMessageId,
                providerTurnIds: [confirmedStartingTurnId || active.codexTurnId!, ownedTurnId],
              });
              this.log("error", () => ({ message: "startup ownership history conflicts with live correlation", data: {
                code: String(engineDiagnosticField(error, "code")),
                workspaceId: this.opts.workspaceId,
                threadId: this.opts.threadId,
                sessionId,
                clientTurnId: startingTurn.clientTurnId,
                clientUserMessageId: startingTurn.clientUserMessageId,
                providerTurnIds: [confirmedStartingTurnId || active.codexTurnId, ownedTurnId],
                startingSequence,
                confirmedSequence,
              } }));
              this.rejectActiveForProviderOwnershipFailure(active, error, "active-start-ownership-history-conflict");
              return;
            }
            if (!active.codexTurnId || active.codexTurnId === ownedTurnId) {
              this.bindActiveCodexTurn(active, ownedTurnId, "provider_lifecycle");
            } else {
              this.log("info", () => ({ message: "stale ownership recovery ignored after newer provider binding", data: {
                workspaceId: this.opts.workspaceId,
                threadId: this.opts.threadId,
                sessionId,
                clientTurnId: startingTurn.clientTurnId,
                recoveredProviderTurnId: ownedTurnId,
                activeProviderTurnId: active.codexTurnId,
              } }));
            }
            startingTurn.providerLifecycleTurnId = ownedTurnId;
            startingTurn.signalProviderOwnership();
            const terminalStatus = isTerminalCodexTurnStatus(ownedTurnStatus)
              ? ownedTurnStatus
              : this.getProviderTerminalStatus(sessionId, ownedTurnId);
            if (active.codexTurnId === ownedTurnId && terminalStatus && isTerminalCodexTurnStatus(terminalStatus)) {
              this.settleActiveFromProviderTerminal(
                active,
                terminalStatus,
                "provider-history-user-message-correlation-after-terminal",
                { thread: { id: sessionId, turns } },
              );
            }
            return;
          }
          if (currentStarting || currentHandoff) {
            this.bindCodexTurn(startingTurn.clientTurnId, ownedTurnId, undefined, sessionId);
            startingTurn.providerLifecycleTurnId = ownedTurnId;
            startingTurn.signalProviderOwnership();
            this.scheduleStartingTurnReconcile(startingTurn, "provider-history-user-message-correlation");
            return;
          }
          this.log("warn", () => ({ message: "provider ownership recovered after local turn was released", data: {
            code: "codex_start_ownership_recovered_without_local_turn",
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            sessionId,
            clientTurnId: startingTurn.clientTurnId,
            clientUserMessageId: startingTurn.clientUserMessageId,
            providerTurnId: ownedTurnId,
          } }));
          return;
        }
        lastCause = lastCause instanceof Error && String((lastCause as any)?.code ?? "") === "codex_turn_ownership_ambiguous"
            ? lastCause
            : new Error(`最近 ${turns.length} 个 provider turn 未找到 clientUserMessageId 回显`);
      } catch (error) {
        if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
        lastCause = error;
      }
      const retryDelayMs = Math.max(1_000, startingTurn.ownershipRecoveryRetryDelayMs);
      startingTurn.ownershipRecoveryRetryAt = Date.now() + retryDelayMs;
      startingTurn.ownershipRecoveryRetryDelayMs = Math.min(
        CODEX_OWNERSHIP_RECOVERY_MAX_RETRY_MS,
        retryDelayMs * 2,
      );
      this.log("warn", () => ({ message: "startup ownership recovery unresolved", data: {
        code: this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn
          ? "codex_late_start_ownership_unresolved"
          : "codex_start_ownership_unresolved",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId,
        clientTurnId: startingTurn.clientTurnId,
        clientUserMessageId: startingTurn.clientUserMessageId,
        provisionalProviderTurnId: startingTurn.providerTurnId,
        error: engineDiagnosticCause(lastCause),
      } }));
    })();
    startingTurn.ownershipRecoveryPromise = recovery;
    this.observeDiagnosticTask(() => (recovery.catch((error) => {
      this.log("error", () => ({ message: "startup ownership recovery task failed", data: {
        code: "codex_start_ownership_recovery_task_failed",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId,
        clientTurnId: startingTurn.clientTurnId,
        clientUserMessageId: startingTurn.clientUserMessageId,
        error: engineDiagnosticCause(error),
      } }), { reason: error });
    }).finally(() => {
      if (startingTurn.ownershipRecoveryPromise === recovery) startingTurn.ownershipRecoveryPromise = null;
      if (
        (
          this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn
          || this.active?.providerOwnershipStartingTurn === startingTurn
          || this.startingTurn === startingTurn
          || this.pendingHandoffStartingTurn === startingTurn
        )
        && !startingTurn.providerLifecycleTurnId
        && !startingTurn.providerOwnershipConflict
      ) {
        if (startingTurn.ownershipRecoveryRescanRequested) {
          startingTurn.ownershipRecoveryRescanRequested = false;
          startingTurn.ownershipRecoveryExhausted = false;
          startingTurn.ownershipRecoveryRetryAt = Date.now()
            + CODEX_ACTIVE_OWNERSHIP_RECOVERY_INITIAL_DELAY_MS;
        }
        this.armStartingTurnOwnershipRecoveryTimer(startingTurn);
      }
    })));
  }

  /** 返回当前 generation 的 clientId 确权窗口；测试可缩短但生产默认固定有界。 */
  private getActiveOwnershipRecoveryTtlMs(): number {
    return Math.max(1, Math.trunc(
      this.opts.activeOwnershipRecoveryTtlMs ?? CODEX_ACTIVE_OWNERSHIP_RECOVERY_TTL_MS,
    ));
  }

  /** 返回成功 turn/start response 触发的延长窗口；测试可缩短，生产默认与 detached TTL 一致。 */
  private getActiveOwnershipRecoveryEvidenceTtlMs(): number {
    return Math.max(1, Math.trunc(
      this.opts.activeOwnershipRecoveryEvidenceTtlMs
        ?? CODEX_PROVIDER_START_EVIDENCE_GRACE_MS,
    ));
  }

  /** 为当前 ownership recovery 建立独立 wall-clock 到期边界，不受扫描 Promise 阻塞影响。 */
  private armStartingTurnOwnershipExpiryTimer(startingTurn: StartingTurn): void {
    if (
      this.disposed
      || startingTurn.ownershipRecoveryExpiryTimer
      || !Number.isFinite(startingTurn.ownershipRecoveryExpiresAt)
      || startingTurn.ownershipRecoveryExpiresAt <= 0
    ) {
      return;
    }
    const interrupted = this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn;
    const active = this.active?.providerOwnershipStartingTurn === startingTurn ? this.active : null;
    const tracked = interrupted
      || Boolean(active)
      || this.startingTurn === startingTurn
      || this.pendingHandoffStartingTurn === startingTurn;
    if (!tracked) return;
    const delayMs = Math.max(1, startingTurn.ownershipRecoveryExpiresAt - Date.now());
    const timer = setTimeout(() => this.runDiagnosticCallback(() => {
      if (startingTurn.ownershipRecoveryExpiryTimer !== timer) return;
      startingTurn.ownershipRecoveryExpiryTimer = null;
      if (Date.now() < startingTurn.ownershipRecoveryExpiresAt) {
        this.armStartingTurnOwnershipExpiryTimer(startingTurn);
        return;
      }
      if (this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn) {
        this.expireDetachedStartingTurnCorrelation(startingTurn);
        return;
      }
      const currentActive = this.active?.providerOwnershipStartingTurn === startingTurn ? this.active : null;
      if (currentActive) {
        this.failCurrentStartingTurnOwnershipRecovery(startingTurn);
        return;
      }
      if (this.startingTurn === startingTurn) {
        const sessionId = startingTurn.providerThreadId ?? this.sessionId;
        if (!sessionId) return;
        const error = buildCodexTurnOwnershipUnmaterializedError({
          sessionId,
          clientTurnId: startingTurn.clientTurnId,
          clientUserMessageId: startingTurn.clientUserMessageId,
          provisionalProviderTurnId: startingTurn.providerTurnId,
        });
        this.rejectStartingForProviderOwnershipFailure(
          startingTurn,
          error,
          "starting-ownership-unmaterialized",
        );
      }
    }), delayMs);
    startingTurn.ownershipRecoveryExpiryTimer = timer;
    timer.unref?.();
  }

  /** 清理 retry 与独立 expiry timer，避免 generation 旋转后触发旧回调。 */
  private clearStartingTurnOwnershipRecoveryTimer(startingTurn: StartingTurn): void {
    this.clearStartingTurnOwnershipRecoveryRetryTimer(startingTurn);
    this.clearStartingTurnOwnershipRecoveryExpiryTimer(startingTurn);
  }

  /** 仅清理 ownership recovery 的扫描 retry timer。 */
  private clearStartingTurnOwnershipRecoveryRetryTimer(startingTurn: StartingTurn): void {
    if (startingTurn.ownershipRecoveryTimer) {
      clearTimeout(startingTurn.ownershipRecoveryTimer);
      startingTurn.ownershipRecoveryTimer = null;
    }
  }

  /** 仅清理 ownership recovery 的 wall-clock expiry timer。 */
  private clearStartingTurnOwnershipRecoveryExpiryTimer(startingTurn: StartingTurn): void {
    if (startingTurn.ownershipRecoveryExpiryTimer) {
      clearTimeout(startingTurn.ownershipRecoveryExpiryTimer);
      startingTurn.ownershipRecoveryExpiryTimer = null;
    }
  }

  /** 退避恢复 starting ownership；current active 显式失败，interrupted correlation 到期后停止观察。 */
  private armStartingTurnOwnershipRecoveryTimer(startingTurn: StartingTurn): void {
    if (this.disposed) return;
    this.armStartingTurnOwnershipExpiryTimer(startingTurn);
    const interrupted = this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) === startingTurn;
    const active = this.active?.providerOwnershipStartingTurn === startingTurn ? this.active : null;
    const currentTracked = Boolean(active)
      || this.startingTurn === startingTurn
      || this.pendingHandoffStartingTurn === startingTurn;
    if (
      startingTurn.ownershipRecoveryTimer
      || startingTurn.ownershipRecoveryPromise
      || startingTurn.providerLifecycleTurnId
      || (!interrupted && !currentTracked)
    ) {
      return;
    }
    if (
      interrupted
      && startingTurn.ownershipRecoveryExpiresAt > 0
      && Date.now() >= startingTurn.ownershipRecoveryExpiresAt
    ) {
      this.expireDetachedStartingTurnCorrelation(startingTurn);
      return;
    }
    if (
      !interrupted
      && startingTurn.ownershipRecoveryExpiresAt > 0
      && Date.now() >= startingTurn.ownershipRecoveryExpiresAt
    ) {
      this.failCurrentStartingTurnOwnershipRecovery(startingTurn);
      return;
    }
    const retryDelayMs = Math.max(50, startingTurn.ownershipRecoveryRetryAt - Date.now());
    const expiryDelayMs = startingTurn.ownershipRecoveryExpiresAt > 0
      ? Math.max(50, startingTurn.ownershipRecoveryExpiresAt - Date.now())
      : retryDelayMs;
    const delayMs = Math.min(retryDelayMs, expiryDelayMs);
    const timer = setTimeout(() => this.runDiagnosticCallback(() => {
      if (startingTurn.ownershipRecoveryTimer === timer) startingTurn.ownershipRecoveryTimer = null;
      this.scheduleStartingTurnOwnershipRecovery(startingTurn);
    }), delayMs);
    startingTurn.ownershipRecoveryTimer = timer;
    timer.unref?.();
  }

  /** 当前 generation 在短窗口内仍无 clientId 回显时，释放本地 turn 并隔离旧上下文。 */
  private failCurrentStartingTurnOwnershipRecovery(startingTurn: StartingTurn): void {
    const active = this.active?.providerOwnershipStartingTurn === startingTurn ? this.active : null;
    const sessionId = startingTurn.providerThreadId;
    if (!active || !sessionId || this.sessionId !== sessionId || active.codexTurnId) return;
    const error = buildCodexTurnOwnershipUnmaterializedError({
      sessionId,
      clientTurnId: active.clientTurnId,
      clientUserMessageId: startingTurn.clientUserMessageId,
      provisionalProviderTurnId: active.provisionalCodexTurnId ?? startingTurn.providerTurnId,
    });
    this.log("error", () => ({ message: "active startup ownership did not materialize", data: {
      code: String(engineDiagnosticField(error, "code")),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      sessionId,
      clientTurnId: active.clientTurnId,
      clientUserMessageId: startingTurn.clientUserMessageId,
      provisionalProviderTurnId: active.provisionalCodexTurnId ?? startingTurn.providerTurnId,
      ttlMs: this.getActiveOwnershipRecoveryTtlMs(),
    } }));
    this.rejectActiveForProviderOwnershipFailure(active, error, "active-start-ownership-unmaterialized");
  }

  /** detached 恢复到期只停止辅助扫描；未知 mutation fence 必须保留。 */
  private expireDetachedStartingTurnCorrelation(startingTurn: StartingTurn): void {
    const providerThreadId = startingTurn.providerThreadId;
    startingTurn.ownershipRecoveryExhausted = true;
    this.clearStartingTurnOwnershipRecoveryTimer(startingTurn);
    this.log("error", () => ({ message: "detached startup ownership recovery expired; correlation retained", data: {
      code: "codex_detached_start_ownership_expired",
      requestId: null,
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      providerThreadId,
      clientTurnId: startingTurn.clientTurnId,
      clientUserMessageId: startingTurn.clientUserMessageId,
      ttlMs: CODEX_DETACHED_OWNERSHIP_RECOVERY_TTL_MS,
      rootCause: "provider mutation has no exact RPC rejection, interrupt ACK, or terminal event",
    } }));
  }

  /** detached steer 仅按 clientId 回显恢复真实 provider turn，不使用 thread head 猜测。 */
  private scheduleInterruptedSteerOwnershipRecovery(correlation: PendingSteerCorrelation): void {
    if (
      this.disposed
      || correlation.state !== "interrupted"
      || correlation.confirmedProviderTurnId
      || correlation.ownershipRecoveryPromise
      || correlation.ownershipRecoveryTimer
      || this.pendingSteerCorrelationsByProviderClientKey.get(
        buildCodexProviderClientCorrelationKey(correlation.providerThreadId, correlation.clientUserMessageId),
      ) !== correlation
    ) {
      return;
    }
    if (
      correlation.ownershipRecoveryExpiresAt > 0
      && Date.now() >= correlation.ownershipRecoveryExpiresAt
    ) {
      this.expireDetachedSteerCorrelation(correlation);
      return;
    }
    if (correlation.ownershipRecoveryExhausted) {
      if (correlation.ownershipRecoveryExpiresAt > 0) {
        correlation.ownershipRecoveryRetryAt = correlation.ownershipRecoveryExpiresAt;
        this.armSteerOwnershipRecoveryTimer(correlation);
      }
      return;
    }
    if (Date.now() < correlation.ownershipRecoveryRetryAt) {
      this.armSteerOwnershipRecoveryTimer(correlation);
      return;
    }

    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    const recovery = (async (): Promise<void> => {
      const ownershipEvidence = await this.readProviderTurnOwnershipEvidence(
        ws,
        correlation.providerThreadId,
        correlation.clientUserMessageId,
        10_000,
      );
      if (
        correlation.state !== "interrupted"
        || this.pendingSteerCorrelationsByProviderClientKey.get(
          buildCodexProviderClientCorrelationKey(correlation.providerThreadId, correlation.clientUserMessageId),
        ) !== correlation
      ) {
        return;
      }
      const turns = ownershipEvidence.turns;
      const providerTurnMatch = ownershipEvidence.match;
      const observedProviderTurnId = String(correlation.providerObservedTurnId ?? "").trim();
      const observedProviderTurnConflict = providerTurnMatch.kind === "unique"
        && Boolean(observedProviderTurnId)
        && providerTurnMatch.turnId !== observedProviderTurnId;
      if (providerTurnMatch.kind === "ambiguous" || observedProviderTurnConflict) {
        const conflictingProviderTurnIds = providerTurnMatch.kind === "ambiguous"
          ? providerTurnMatch.turnIds
          : providerTurnMatch.kind === "unique"
            ? [observedProviderTurnId, providerTurnMatch.turnId]
            : [];
        const error = buildCodexTurnOwnershipAmbiguousError({
          sessionId: correlation.providerThreadId,
          clientTurnId: correlation.clientTurnId,
          clientUserMessageId: correlation.clientUserMessageId,
          providerTurnIds: conflictingProviderTurnIds,
        });
        this.log("error", () => ({ message: "detached steer ownership is ambiguous", data: {
          code: String(engineDiagnosticField(error, "code")),
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          providerThreadId: correlation.providerThreadId,
          clientTurnId: correlation.clientTurnId,
          clientUserMessageId: correlation.clientUserMessageId,
          providerTurnIds: conflictingProviderTurnIds,
        } }));
        correlation.ownershipRecoveryExhausted = true;
        return;
      }
      if (!ownershipEvidence.complete) {
        const error = buildCodexTurnOwnershipScanIncompleteError({
          sessionId: correlation.providerThreadId,
          clientTurnId: correlation.clientTurnId,
          clientUserMessageId: correlation.clientUserMessageId,
          cause: ownershipEvidence.incompleteCause,
        });
        correlation.ownershipRecoveryExhausted = true;
        correlation.ownershipRecoveryRetryAt = correlation.ownershipRecoveryExpiresAt;
        this.log("error", () => ({ message: "detached steer ownership scan reached pagination limit", data: {
          code: String(engineDiagnosticField(error, "code")),
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          providerThreadId: correlation.providerThreadId,
          clientTurnId: correlation.clientTurnId,
          clientUserMessageId: correlation.clientUserMessageId,
        } }));
        this.armSteerOwnershipRecoveryTimer(correlation);
        return;
      }
      const providerTurnId = providerTurnMatch.kind === "unique" ? providerTurnMatch.turnId : null;
      if (!providerTurnId) {
        throw new Error(`最近 ${turns.length} 个 provider turn 未找到 steer clientUserMessageId=${correlation.clientUserMessageId}`);
      }
      const providerTurn = turns.find((turn) => String(turn?.id ?? "").trim() === providerTurnId) ?? null;
      const providerStatus = normalizeCodexTurnStatus(providerTurn?.status);
      const previousEngineTurnId = this.codexTurnIdByClientTurnId.get(correlation.clientTurnId) ?? null;
      this.bindCodexTurn(
        correlation.clientTurnId,
        providerTurnId,
        previousEngineTurnId,
        correlation.providerThreadId,
      );
      this.confirmSteerOwnership(
        correlation,
        providerTurnId,
        providerStatus,
        { thread: { id: correlation.providerThreadId, turns } },
      );
    })();
    correlation.ownershipRecoveryPromise = recovery;
    this.observeDiagnosticTask(() => (recovery.catch((error) => {
      this.log("warn", () => ({ message: "detached steer ownership recovery unresolved", data: {
        code: "codex_detached_steer_ownership_unresolved",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        providerThreadId: correlation.providerThreadId,
        clientTurnId: correlation.clientTurnId,
        clientUserMessageId: correlation.clientUserMessageId,
        error: engineDiagnosticCause(error),
      } }), { reason: error });
    }).finally(() => {
      if (correlation.ownershipRecoveryPromise === recovery) correlation.ownershipRecoveryPromise = null;
      if (
        correlation.state === "interrupted"
        && !correlation.confirmedProviderTurnId
        && this.pendingSteerCorrelationsByProviderClientKey.get(
          buildCodexProviderClientCorrelationKey(correlation.providerThreadId, correlation.clientUserMessageId),
        ) === correlation
      ) {
        if (correlation.ownershipRecoveryRescanRequested) {
          correlation.ownershipRecoveryRescanRequested = false;
          correlation.ownershipRecoveryExhausted = false;
          correlation.ownershipRecoveryRetryAt = Date.now()
            + CODEX_ACTIVE_OWNERSHIP_RECOVERY_INITIAL_DELAY_MS;
        }
        this.armSteerOwnershipRecoveryTimer(correlation);
      }
    })));
  }

  /** 以可取消 timer 退避恢复 detached steer ownership。 */
  private armSteerOwnershipRecoveryTimer(correlation: PendingSteerCorrelation): void {
    if (correlation.ownershipRecoveryTimer || correlation.ownershipRecoveryPromise) return;
    if (
      correlation.ownershipRecoveryExpiresAt > 0
      && Date.now() >= correlation.ownershipRecoveryExpiresAt
    ) {
      this.expireDetachedSteerCorrelation(correlation);
      return;
    }
    const now = Date.now();
    const waitingForStableEvidence = now < correlation.ownershipRecoveryRetryAt;
    const retryDelayMs = waitingForStableEvidence
      ? Math.max(50, correlation.ownershipRecoveryRetryAt - now)
      : Math.max(1_000, correlation.ownershipRecoveryRetryDelayMs);
    const remainingTtlMs = correlation.ownershipRecoveryExpiresAt > 0
      ? Math.max(1, correlation.ownershipRecoveryExpiresAt - Date.now())
      : retryDelayMs;
    const delayMs = Math.min(retryDelayMs, remainingTtlMs);
    if (!waitingForStableEvidence) {
      correlation.ownershipRecoveryRetryDelayMs = Math.min(
        CODEX_OWNERSHIP_RECOVERY_MAX_RETRY_MS,
        retryDelayMs * 2,
      );
    }
    const timer = setTimeout(() => this.runDiagnosticCallback(() => {
      if (correlation.ownershipRecoveryTimer === timer) correlation.ownershipRecoveryTimer = null;
      this.scheduleInterruptedSteerOwnershipRecovery(correlation);
    }), delayMs);
    correlation.ownershipRecoveryTimer = timer;
    timer.unref?.();
  }

  /** 清理 steer ownership retry timer。 */
  private clearSteerOwnershipRecoveryTimer(correlation: PendingSteerCorrelation): void {
    if (!correlation.ownershipRecoveryTimer) return;
    clearTimeout(correlation.ownershipRecoveryTimer);
    correlation.ownershipRecoveryTimer = null;
  }

  /** detached steer 恢复到期只停止辅助扫描；未知 mutation fence 必须保留。 */
  private expireDetachedSteerCorrelation(correlation: PendingSteerCorrelation): void {
    correlation.ownershipRecoveryExhausted = true;
    this.clearSteerOwnershipRecoveryTimer(correlation);
    this.log("error", () => ({ message: "detached steer ownership recovery expired; correlation retained", data: {
      code: "codex_detached_steer_ownership_expired",
      requestId: null,
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      providerThreadId: correlation.providerThreadId,
      clientTurnId: correlation.clientTurnId,
      clientUserMessageId: correlation.clientUserMessageId,
      ttlMs: CODEX_DETACHED_OWNERSHIP_RECOVERY_TTL_MS,
      rootCause: "provider mutation has no exact RPC rejection, interrupt ACK, or terminal event",
    } }));
  }

  /** 移除 starting tombstone，并释放 timer、迟到请求追踪和旧 thread observer。 */
  private forgetInterruptedStartingTurn(startingTurn: StartingTurn): void {
    if (this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) !== startingTurn) return;
    this.pendingInterruptedStartingTurns.delete(startingTurn.clientTurnId);
    this.clearStartingTurnOwnershipRecoveryTimer(startingTurn);
    this.releaseStartingTurnLateSettlement(startingTurn);
    startingTurn.resolveInterruptFinalized();
    if (startingTurn.providerThreadId) {
      this.releaseDetachedProviderThreadObserverIfIdle(startingTurn.providerThreadId);
    }
    this.releaseSettledCredential();
  }

  /** 移除 steer tombstone，并释放 timer 与旧 thread observer。 */
  private forgetInterruptedSteerCorrelation(correlation: PendingSteerCorrelation): void {
    const correlationKey = buildCodexProviderClientCorrelationKey(
      correlation.providerThreadId,
      correlation.clientUserMessageId,
    );
    if (this.pendingSteerCorrelationsByProviderClientKey.get(correlationKey) !== correlation) return;
    this.pendingSteerCorrelationsByProviderClientKey.delete(correlationKey);
    this.clearSteerOwnershipRecoveryTimer(correlation);
    this.releaseDetachedProviderThreadObserverIfIdle(correlation.providerThreadId);
    this.releaseSettledCredential();
  }

  /** 容量压力只告警，不能把本地内存上限伪装成 provider mutation 终态。 */
  private reportDetachedProviderCorrelationPressure(): void {
    const pendingCount = this.pendingInterruptedStartingTurns.size
      + Array.from(this.pendingSteerCorrelationsByProviderClientKey.values())
        .filter((correlation) => correlation.state === "interrupted").length;
    if (pendingCount <= MAX_DETACHED_PROVIDER_CORRELATIONS) return;
    this.log("error", () => ({ message: "detached provider correlation limit exceeded; correlations retained", data: {
      code: "codex_detached_correlation_limit_exceeded",
      requestId: null,
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      maxPending: MAX_DETACHED_PROVIDER_CORRELATIONS,
      pendingCount,
      rootCause: "unresolved provider mutations cannot be evicted without an exact terminal outcome",
    } }));
  }

  /** 判断旧 provider thread 是否仍有精确补偿在途。 */
  private hasPendingProviderCompensation(providerThreadId: SessionId): boolean {
    const keyPrefix = `[${JSON.stringify(String(providerThreadId))},`;
    return Array.from(this.pendingInterruptedProviderCompensationsByKey.keys())
      .some((key) => key.startsWith(keyPrefix));
  }

  /** 旧 thread 无 tombstone/补偿后解除观察器并清理其终态账本。 */
  private releaseDetachedProviderThreadObserverIfIdle(providerThreadId: SessionId): void {
    const hasStarting = Array.from(this.pendingInterruptedStartingTurns.values())
      .some((startingTurn) => startingTurn.providerThreadId === providerThreadId);
    const hasSteer = Array.from(this.pendingSteerCorrelationsByProviderClientKey.values())
      .some((correlation) => correlation.state === "interrupted" && correlation.providerThreadId === providerThreadId);
    if (hasStarting || hasSteer || this.hasPendingProviderCompensation(providerThreadId)) return;
    const unregister = this.detachedProviderThreadUnregisterById.get(providerThreadId) ?? null;
    if (unregister) {
      unregister();
      this.detachedProviderThreadUnregisterById.delete(providerThreadId);
    }
    if (this.sessionId !== providerThreadId) {
      this.terminalObservedProviderTurnStatusByThreadId.delete(providerThreadId);
    }
  }

  /** session 失效或 dispose 时取消 detached 恢复和观察器，避免旧 session 继续后台访问。 */
  private clearDetachedProviderRecovery(): void {
    for (const startingTurn of this.pendingInterruptedStartingTurns.values()) {
      this.clearStartingTurnOwnershipRecoveryTimer(startingTurn);
      this.releaseStartingTurnLateSettlement(startingTurn);
      startingTurn.resolveInterruptFinalized();
    }
    for (const correlation of this.pendingSteerCorrelationsByProviderClientKey.values()) {
      this.clearSteerOwnershipRecoveryTimer(correlation);
    }
    this.pendingInterruptedStartingTurns.clear();
    this.pendingSteerCorrelationsByProviderClientKey.clear();
    this.pendingInterruptedProviderCompensationsByKey.clear();
    for (const unregister of this.detachedProviderThreadUnregisterById.values()) unregister();
    this.detachedProviderThreadUnregisterById.clear();
    this.terminalObservedProviderTurnStatusByThreadId.clear();
  }

  /** 最佳努力恢复原 thread 后精确中断 owned turn；ACK 或已观察到的精确终态直接裁决。 */
  private async requestAndConfirmOwnedProviderTurnCompensation(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    input: {
      sessionId: SessionId;
      providerTurnId: string;
      interruptAlreadyAcknowledged?: boolean;
      assertContinue?: () => void;
    },
  ): Promise<string> {
    const assertContinue = () => { this.assertDiagnosticReady(); input.assertContinue?.(); };
    assertContinue();
    const knownTerminalStatus = this.getProviderTerminalStatus(input.sessionId, input.providerTurnId);
    if (knownTerminalStatus && isTerminalCodexTurnStatus(knownTerminalStatus)) return knownTerminalStatus;
    if (input.interruptAlreadyAcknowledged) return "interrupt_acknowledged";
    if (this.disposed) throw new Error("Codex session 已释放，停止 detached turn 补偿");

    let resumeCause: unknown = null;
    try {
      await ws.request("thread/resume", await this.withDatabase(() => this.buildCurrentCodexResumeParams(input.sessionId)), CODEX_RECOVERY_REQUEST_OPTIONS);
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      resumeCause = cause;
    }

    const requestInterrupt = async (): Promise<void> => {
      assertContinue();
      await ws.request(
        "turn/interrupt",
        { threadId: input.sessionId, turnId: input.providerTurnId },
        CODEX_RECOVERY_REQUEST_OPTIONS,
      );
      assertContinue();
    };

    try {
      await requestInterrupt();
      return "interrupt_acknowledged";
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      const observedStatus = this.getProviderTerminalStatus(input.sessionId, input.providerTurnId);
      if (observedStatus && isTerminalCodexTurnStatus(observedStatus)) return observedStatus;
      throw buildCodexDetachedInterruptStateUnknownError(
        input.sessionId,
        input.providerTurnId,
        combineCodexResumeAndInterruptFailures(resumeCause, cause),
      );
    }
  }

  /** 复用同一 provider thread/turn 的精确补偿，并让所有相关 tombstone 订阅同一结果。 */
  private getOrStartOwnedProviderTurnCompensation(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    input: {
      sessionId: SessionId;
      providerTurnId: string;
      interruptAlreadyAcknowledged?: boolean;
    },
  ): Promise<string> {
    const key = buildCodexProviderTurnCorrelationKey(input.sessionId, input.providerTurnId);
    const pending = this.pendingInterruptedProviderCompensationsByKey.get(key) ?? null;
    if (pending) return pending;
    const compensation = this.requestAndConfirmOwnedProviderTurnCompensation(ws, input);
    this.pendingInterruptedProviderCompensationsByKey.set(key, compensation);
    const clear = () => {
      if (this.pendingInterruptedProviderCompensationsByKey.get(key) === compensation) {
        this.pendingInterruptedProviderCompensationsByKey.delete(key);
      }
      this.releaseDetachedProviderThreadObserverIfIdle(input.sessionId);
      this.releaseSettledCredential();
    };
    this.observeDiagnosticTask(() => (compensation.then(clear, clear)));
    return compensation;
  }

  /** 幂等收口已确权 starting turn；同步确认、后台补偿和 terminal 事件共用。 */
  private finalizeOwnedStartingTurnTerminal(
    startingTurn: StartingTurn,
    providerTurnId: string,
    terminalStatus: string,
    reason: string,
  ): void {
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    const normalizedStatus = normalizeCodexTurnStatus(terminalStatus);
    if (!normalizedTurnId || !isTerminalCodexTurnStatus(normalizedStatus)) return;
    const expectedProviderTurnId = this.getStartingTurnInterruptProviderTurnId(startingTurn);
    if (!expectedProviderTurnId || expectedProviderTurnId !== normalizedTurnId) return;
    this.rememberProviderTerminalStatus(startingTurn.providerThreadId, normalizedTurnId, normalizedStatus);
    startingTurn.compensatedProviderTurnIds.add(normalizedTurnId);
    this.forgetInterruptedStartingTurn(startingTurn);
    this.terminalObservedProviderTurnStatusById.set(normalizedTurnId, normalizedStatus);
    startingTurn.resolveInterruptFinalized();

    const active = this.active?.clientTurnId === startingTurn.clientTurnId
      && (
        this.active.providerOwnershipStartingTurn === startingTurn
        || this.active.codexTurnId === normalizedTurnId
      )
      ? this.active
      : null;
    if (active) {
      if (active.codexTurnId !== normalizedTurnId) {
        this.replaceActiveCodexTurnId(active, normalizedTurnId, "provider_lifecycle");
      }
      active.manualInterruptRequested = true;
      active.manualInterruptError ??= createManualInterruptError();
      this.settleActiveFromProviderTerminal(active, normalizedStatus, reason, null);
      return;
    }

    if (this.startingTurn === startingTurn) {
      if (!startingTurn.startupInterruptAcknowledged) {
        startingTurn.startupInterruptAcknowledged = true;
        startingTurn.acknowledgeStartupInterrupt();
      }
      this.finishUnboundStartingTurn(startingTurn);
      return;
    }
    this.retireProviderTurnId(normalizedTurnId);
  }

  /** 精确 interrupt ACK 后立即收口 starting tombstone，不再读取 provider 状态。 */
  private finalizeOwnedStartingTurnInterruptAcknowledged(
    startingTurn: StartingTurn,
    providerTurnId: string,
  ): void {
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    if (!normalizedTurnId) return;
    const expectedProviderTurnId = this.getStartingTurnInterruptProviderTurnId(startingTurn);
    if (!expectedProviderTurnId || expectedProviderTurnId !== normalizedTurnId) return;
    startingTurn.compensatedProviderTurnIds.add(normalizedTurnId);
    startingTurn.startupInterruptAcknowledged = true;
    startingTurn.acknowledgeStartupInterrupt();
    this.forgetInterruptedStartingTurn(startingTurn);

    const active = this.active?.clientTurnId === startingTurn.clientTurnId
      && (
        this.active.providerOwnershipStartingTurn === startingTurn
        || this.active.codexTurnId === normalizedTurnId
      )
      ? this.active
      : null;
    if (active) {
      this.settleActiveAfterInterruptAcknowledged(active, normalizedTurnId);
      return;
    }
    this.retireProviderTurnId(normalizedTurnId);
    startingTurn.resolveInterruptFinalized();
  }

  /** 精确 terminal 到达时按同 thread 的 lifecycle 或 turn/start 响应 ID 收口 tombstone。 */
  private finalizeInterruptedOwnedTurnFromTerminal(
    providerThreadId: SessionId | null,
    providerTurnId: string,
    terminalStatus: string,
  ): boolean {
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    const normalizedThreadId = String(providerThreadId ?? "").trim();
    if (!normalizedTurnId || !normalizedThreadId) return false;
    let matched = false;
    for (const startingTurn of Array.from(this.pendingInterruptedStartingTurns.values())) {
      const ownedProviderTurnId = this.getStartingTurnInterruptProviderTurnId(startingTurn);
      if (
        startingTurn.providerThreadId !== normalizedThreadId
        || ownedProviderTurnId !== normalizedTurnId
      ) {
        continue;
      }
      matched = true;
      this.finalizeOwnedStartingTurnTerminal(
        startingTurn,
        normalizedTurnId,
        terminalStatus,
        "startup-interrupt.provider-terminal-event",
      );
    }
    let matchedSteer = false;
    for (const correlation of this.pendingSteerCorrelationsByProviderClientKey.values()) {
      if (
        correlation.providerThreadId !== normalizedThreadId
        || correlation.state !== "interrupted"
        || correlation.confirmedProviderTurnId !== normalizedTurnId
      ) {
        continue;
      }
      matchedSteer = true;
      matched = true;
      this.forgetInterruptedSteerCorrelation(correlation);
    }
    if (matchedSteer) this.retireProviderTurnId(normalizedTurnId);
    return matched;
  }

  /** 对停止后才由 clientId 确权的 provider turn 发一次精确补偿中断，不追 foreign active。 */
  private scheduleInterruptedStartingTurnCompensation(
    startingTurn: StartingTurn,
    providerTurnId: string,
    interruptAlreadyAcknowledged = false,
  ): void {
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    const sessionId = startingTurn.providerThreadId ?? this.sessionId;
    if (
      this.disposed
      || !normalizedTurnId
      || !sessionId
      || startingTurn.compensatedProviderTurnIds.has(normalizedTurnId)
    ) {
      return;
    }
    if (startingTurn.ownershipRecoveryExpiresAt > 0 && Date.now() >= startingTurn.ownershipRecoveryExpiresAt) {
      this.expireDetachedStartingTurnCorrelation(startingTurn);
      return;
    }
    // 精确补偿仍受独立 expiry 约束，只替换 discovery/retry timer。
    this.clearStartingTurnOwnershipRecoveryRetryTimer(startingTurn);
    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    this.observeDiagnosticTask(() => (this.getOrStartOwnedProviderTurnCompensation(ws, {
      sessionId,
      providerTurnId: normalizedTurnId,
      interruptAlreadyAcknowledged,
    }).then(
      (outcome) => {
        if (this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) !== startingTurn) return;
        if (outcome === "interrupt_acknowledged") {
          this.finalizeOwnedStartingTurnInterruptAcknowledged(startingTurn, normalizedTurnId);
        } else {
          this.finalizeOwnedStartingTurnTerminal(
            startingTurn,
            normalizedTurnId,
            outcome,
            "startup-interrupt.background-compensation",
          );
        }
        this.log("info", () => ({ message: "late owned provider turn compensation confirmed", data: {
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId,
          clientTurnId: startingTurn.clientTurnId,
          providerTurnId: normalizedTurnId,
          outcome,
        } }));
      },
      (error) => {
        if (
          this.disposed
          || this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) !== startingTurn
        ) {
          return;
        }
        this.log("error", () => ({ message: "late owned provider turn compensation unconfirmed", data: {
          code: "codex_late_owned_turn_compensation_unconfirmed",
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId,
          clientTurnId: startingTurn.clientTurnId,
          providerTurnId: normalizedTurnId,
          error: engineDiagnosticCause(error),
        } }), { reason: error });
        this.armInterruptedStartingTurnCompensationRetry(startingTurn, normalizedTurnId);
      },
    )));
  }

  /** 在 detached TTL 内退避重试已确权 starting turn 的精确补偿。 */
  private armInterruptedStartingTurnCompensationRetry(
    startingTurn: StartingTurn,
    providerTurnId: string,
  ): void {
    if (
      this.disposed
      || startingTurn.ownershipRecoveryTimer
      || this.pendingInterruptedStartingTurns.get(startingTurn.clientTurnId) !== startingTurn
    ) {
      return;
    }
    if (startingTurn.ownershipRecoveryExpiresAt > 0 && Date.now() >= startingTurn.ownershipRecoveryExpiresAt) {
      this.expireDetachedStartingTurnCorrelation(startingTurn);
      return;
    }
    const retryDelayMs = Math.max(1_000, startingTurn.ownershipRecoveryRetryDelayMs);
    const remainingTtlMs = startingTurn.ownershipRecoveryExpiresAt > 0
      ? Math.max(1, startingTurn.ownershipRecoveryExpiresAt - Date.now())
      : retryDelayMs;
    const delayMs = Math.min(retryDelayMs, remainingTtlMs);
    startingTurn.ownershipRecoveryRetryDelayMs = Math.min(
      CODEX_OWNERSHIP_RECOVERY_MAX_RETRY_MS,
      retryDelayMs * 2,
    );
    const timer = setTimeout(() => this.runDiagnosticCallback(() => {
      if (startingTurn.ownershipRecoveryTimer === timer) startingTurn.ownershipRecoveryTimer = null;
      this.scheduleInterruptedStartingTurnCompensation(startingTurn, providerTurnId);
    }), delayMs);
    startingTurn.ownershipRecoveryTimer = timer;
    timer.unref?.();
  }

  /** 对停止后才确权的 steer turn 发一次精确补偿中断，不触碰其他 Goal turn。 */
  private scheduleInterruptedSteerCompensation(
    correlation: PendingSteerCorrelation,
    providerTurnId: string,
  ): void {
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    const sessionId = correlation.providerThreadId;
    if (this.disposed) return;
    if (correlation.ownershipRecoveryExpiresAt > 0 && Date.now() >= correlation.ownershipRecoveryExpiresAt) {
      this.expireDetachedSteerCorrelation(correlation);
      return;
    }
    if (!normalizedTurnId || !sessionId) {
      this.log("error", () => ({ message: "late steer compensation missing provider identity", data: {
        code: "codex_late_steer_compensation_identity_missing",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId,
        clientTurnId: correlation.clientTurnId,
        clientUserMessageId: correlation.clientUserMessageId,
        providerTurnId: normalizedTurnId || null,
      } }));
      return;
    }
    this.clearSteerOwnershipRecoveryTimer(correlation);
    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    this.observeDiagnosticTask(() => (this.getOrStartOwnedProviderTurnCompensation(ws, {
      sessionId,
      providerTurnId: normalizedTurnId,
    }).then(
      (outcome) => {
        if (
          correlation.state !== "interrupted"
          || this.pendingSteerCorrelationsByProviderClientKey.get(
            buildCodexProviderClientCorrelationKey(correlation.providerThreadId, correlation.clientUserMessageId),
          ) !== correlation
        ) {
          return;
        }
        this.forgetInterruptedSteerCorrelation(correlation);
        this.retireProviderTurnId(normalizedTurnId);
        this.log("info", () => ({ message: "late owned steer turn compensation confirmed", data: {
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId,
          clientTurnId: correlation.clientTurnId,
          clientUserMessageId: correlation.clientUserMessageId,
          providerTurnId: normalizedTurnId,
          outcome,
        } }));
      },
      (error) => {
        if (
          this.disposed
          || correlation.state !== "interrupted"
          || this.pendingSteerCorrelationsByProviderClientKey.get(
            buildCodexProviderClientCorrelationKey(correlation.providerThreadId, correlation.clientUserMessageId),
          ) !== correlation
        ) {
          return;
        }
        this.log("error", () => ({ message: "late owned steer turn compensation unconfirmed", data: {
          code: "codex_late_owned_steer_compensation_unconfirmed",
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId,
          clientTurnId: correlation.clientTurnId,
          clientUserMessageId: correlation.clientUserMessageId,
          providerTurnId: normalizedTurnId,
          error: engineDiagnosticCause(error),
        } }), { reason: error });
        this.armInterruptedSteerCompensationRetry(correlation, normalizedTurnId);
      },
    )));
  }

  /** 在 detached TTL 内退避重试已确权 steer turn 的精确补偿。 */
  private armInterruptedSteerCompensationRetry(
    correlation: PendingSteerCorrelation,
    providerTurnId: string,
  ): void {
    if (
      this.disposed
      || correlation.ownershipRecoveryTimer
      || correlation.state !== "interrupted"
      || this.pendingSteerCorrelationsByProviderClientKey.get(
        buildCodexProviderClientCorrelationKey(correlation.providerThreadId, correlation.clientUserMessageId),
      ) !== correlation
    ) {
      return;
    }
    if (correlation.ownershipRecoveryExpiresAt > 0 && Date.now() >= correlation.ownershipRecoveryExpiresAt) {
      this.expireDetachedSteerCorrelation(correlation);
      return;
    }
    const retryDelayMs = Math.max(1_000, correlation.ownershipRecoveryRetryDelayMs);
    const remainingTtlMs = correlation.ownershipRecoveryExpiresAt > 0
      ? Math.max(1, correlation.ownershipRecoveryExpiresAt - Date.now())
      : retryDelayMs;
    const delayMs = Math.min(retryDelayMs, remainingTtlMs);
    correlation.ownershipRecoveryRetryDelayMs = Math.min(
      CODEX_OWNERSHIP_RECOVERY_MAX_RETRY_MS,
      retryDelayMs * 2,
    );
    const timer = setTimeout(() => this.runDiagnosticCallback(() => {
      if (correlation.ownershipRecoveryTimer === timer) correlation.ownershipRecoveryTimer = null;
      this.scheduleInterruptedSteerCompensation(correlation, providerTurnId);
    }), delayMs);
    correlation.ownershipRecoveryTimer = timer;
    timer.unref?.();
  }

  /** 回合退休后沿既有映射清理，并释放已结算的凭据 owner。 */
  private retireCodexTurn(clientTurnId: TurnId): void {
    this.releaseSettledCredential();
    const codexTurnId = this.codexTurnIdByClientTurnId.get(clientTurnId) ?? null;
    if (!codexTurnId) return;
    const reverseOwner = this.clientTurnIdByCodexTurnId.get(codexTurnId) ?? null;
    if (reverseOwner && reverseOwner !== clientTurnId) {
      this.codexTurnIdByClientTurnId.delete(clientTurnId);
      this.nativeToolPolicyByClientTurnId.delete(clientTurnId);
      this.log("error", () => ({ message: "stale local provider mapping was not allowed to retire newer owner", data: {
        code: "codex_stale_provider_mapping_retire_blocked",
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        clientTurnId,
        providerTurnId: codexTurnId,
        reverseOwner,
      } }));
      return;
    }
    this.retireProviderTurnId(codexTurnId);
  }

  /** 在线程会话生命周期内保留迟到事件 tombstone，仅限制已终态双向映射数量。 */
  private retireProviderTurnId(codexTurnId: string): void {
    const normalizedTurnId = String(codexTurnId ?? "").trim();
    if (!normalizedTurnId) return;
    if (this.observedProviderActiveTurnId === normalizedTurnId) {
      this.observedProviderActiveTurnId = null;
      if (isNonTerminalCodexThreadStatus(this.observedProviderThreadStatus ?? "")) {
        this.observedProviderThreadStatus = null;
      }
    }
    this.retiredCodexTurnIds.add(normalizedTurnId);
    if (!this.clientTurnIdByCodexTurnId.has(normalizedTurnId)) return;
    this.rememberRetiredCodexTurnMapping(normalizedTurnId);
  }

  /** 刷新已终态映射的 LRU；tombstone 本身不随映射淘汰。 */
  private rememberRetiredCodexTurnMapping(normalizedTurnId: string): void {
    const existingIndex = this.retiredCodexTurnMappingOrder.indexOf(normalizedTurnId);
    if (existingIndex >= 0) this.retiredCodexTurnMappingOrder.splice(existingIndex, 1);
    this.retiredCodexTurnMappingOrder.push(normalizedTurnId);
    while (this.retiredCodexTurnMappingOrder.length > 8) {
      const oldestCodexTurnId = this.retiredCodexTurnMappingOrder.shift();
      if (!oldestCodexTurnId) break;
      const oldestClientTurnId = this.clientTurnIdByCodexTurnId.get(oldestCodexTurnId) ?? null;
      if (oldestClientTurnId) {
        if (this.codexTurnIdByClientTurnId.get(oldestClientTurnId) === oldestCodexTurnId) {
          this.codexTurnIdByClientTurnId.delete(oldestClientTurnId);
          this.nativeToolPolicyByClientTurnId.delete(oldestClientTurnId);
        }
      }
      this.clientTurnIdByCodexTurnId.delete(oldestCodexTurnId);
    }
  }

  private clearCodexTurnBindings(): void {
    const currentProviderThreadId = this.sessionId;
    const retainedProviderTurnIds = new Set<string>();
    for (const startingTurn of this.pendingInterruptedStartingTurns.values()) {
      const providerTurnId = this.getStartingTurnInterruptProviderTurnId(startingTurn);
      if (providerTurnId) retainedProviderTurnIds.add(providerTurnId);
    }
    for (const correlation of this.pendingSteerCorrelationsByProviderClientKey.values()) {
      const providerTurnId = String(correlation.confirmedProviderTurnId ?? "").trim();
      if (providerTurnId) retainedProviderTurnIds.add(providerTurnId);
    }
    const retainedMappings = Array.from(retainedProviderTurnIds).flatMap((providerTurnId) => {
      const clientTurnId = this.clientTurnIdByCodexTurnId.get(providerTurnId) ?? null;
      return clientTurnId ? [{ providerTurnId, clientTurnId }] : [];
    });
    const retainedTerminalStatuses = Array.from(retainedProviderTurnIds).flatMap((providerTurnId) => {
      const status = this.terminalObservedProviderTurnStatusById.get(providerTurnId) ?? null;
      return status ? [{ providerTurnId, status }] : [];
    });
    const retainedRetiredTurnIds = Array.from(retainedProviderTurnIds)
      .filter((providerTurnId) => this.retiredCodexTurnIds.has(providerTurnId));
    this.codexTurnIdByClientTurnId.clear();
    this.clientTurnIdByCodexTurnId.clear();
    this.retiredCodexTurnIds.clear();
    this.retiredCodexTurnMappingOrder.length = 0;
    this.terminalObservedProviderTurnStatusById.clear();
    this.supersededProviderHeadTurnIds.clear();
    for (const mapping of retainedMappings) {
      this.codexTurnIdByClientTurnId.set(mapping.clientTurnId, mapping.providerTurnId);
      this.clientTurnIdByCodexTurnId.set(mapping.providerTurnId, mapping.clientTurnId);
    }
    for (const clientTurnId of this.nativeToolPolicyByClientTurnId.keys()) {
      if (!this.codexTurnIdByClientTurnId.has(clientTurnId)) this.nativeToolPolicyByClientTurnId.delete(clientTurnId);
    }
    for (const providerTurnId of retainedRetiredTurnIds) this.retiredCodexTurnIds.add(providerTurnId);
    for (const mapping of retainedMappings) {
      if (retainedRetiredTurnIds.includes(mapping.providerTurnId)) {
        this.rememberRetiredCodexTurnMapping(mapping.providerTurnId);
      }
    }
    for (const item of retainedTerminalStatuses) {
      this.terminalObservedProviderTurnStatusById.set(item.providerTurnId, item.status);
    }
    if (currentProviderThreadId) {
      const hasStarting = Array.from(this.pendingInterruptedStartingTurns.values())
        .some((startingTurn) => startingTurn.providerThreadId === currentProviderThreadId);
      const hasSteer = Array.from(this.pendingSteerCorrelationsByProviderClientKey.values())
        .some((correlation) => correlation.providerThreadId === currentProviderThreadId);
      const hasObserver = this.detachedProviderThreadUnregisterById.has(currentProviderThreadId);
      if (
        !hasStarting
        && !hasSteer
        && !hasObserver
        && !this.hasPendingProviderCompensation(currentProviderThreadId)
      ) {
        this.terminalObservedProviderTurnStatusByThreadId.delete(currentProviderThreadId);
      }
    }
  }

  /** 提取 provider turnId，用于阻断旧 provider turn 事件串入当前 client turn。 */
  private extractCodexEventTurnId(method: string, params: Record<string, unknown> | undefined): string | null {
    const directTurnId = extractCodexProviderTurnId(params);
    if (directTurnId) return directTurnId;
    const normalizedMethod = String(method ?? "").trim();
    const item = ((params as any)?.item ?? null) as Record<string, unknown> | null;
    if (normalizedMethod === "item/started" || normalizedMethod === "item/completed") {
      const turnId = String(
        (item as any)?.turnId
        ?? (item as any)?.turn_id
        ?? "",
      ).trim();
      return turnId || null;
    }
    return null;
  }

  /** 记录匹配 active turn 的精确 provider 终态，处理其与 interrupt RPC 的并发竞态。 */
  private captureActiveProviderTerminalStatus(
    method: string,
    params: Record<string, unknown> | undefined,
    providerTurnId: string | null,
  ): void {
    const active = this.active;
    if (!active) return;
    if (!providerTurnId) return;
    if (providerTurnId && active.codexTurnId !== providerTurnId) return;
    if (method === "turn/completed") {
      const status = normalizeCodexTurnStatus((params as any)?.turn?.status ?? (params as any)?.status) || "completed";
      if (isTerminalCodexTurnStatus(status)) {
        active.providerTerminalStatus = status;
        if (status !== "completed" && active.interruptTerminalError && !active.manualInterruptRequested) {
          active.reject(active.interruptTerminalError);
        }
      }
      return;
    }
    if (method === "turn/error" && extractTransientReconnectInfo(method, params) == null) {
      active.providerTerminalStatus = "error";
      if (active.interruptTerminalError && !active.manualInterruptRequested) {
        active.reject(active.interruptTerminalError);
      }
    }
  }

  private shouldIgnoreTurnScopedProviderEvent(
    method: string,
    params: Record<string, unknown> | undefined,
    providerTurnId: string | null,
  ): boolean {
    if (!isCodexTurnScopedProviderMethod(method, params)) return false;
    const trackedItemId = this.extractTurnScopedTrackedItemId(method, params);
    if (providerTurnId && this.retiredCodexTurnIds.has(providerTurnId)) return true;
    const active = this.active;
    if (!active) return true;
    if (
      providerTurnId
      && active.codexTurnId === providerTurnId
      && isCodexTerminalProviderEvent(method, params)
      && this.getLatestPendingSteerCorrelation(active)
    ) {
      this.schedulePendingSteerOwnershipRecovery(active);
      return true;
    }
    if (providerTurnId && active.compactStartState?.providerTurnIdsBeforeStart.has(providerTurnId)) return true;
    if (!providerTurnId && trackedItemId) {
      const record = this.assistantLifecycle.get(trackedItemId);
      if (!record) return true;
      if (this.assistantLifecycle.isTurnRetired(record.turnId)) return true;
      if (record.turnId !== active.clientTurnId) return true;
    }
    if (providerTurnId) {
      if (!active.codexTurnId) {
        return true;
      }
      if (!this.activeTurnMatchesProviderTurn(active, providerTurnId)) return true;
    }
    return false;
  }

  private activeTurnMatchesProviderTurn(active: ActiveTurn | null, providerTurnId: string | null): active is ActiveTurn {
    if (!active) return false;
    const normalizedTurnId = String(providerTurnId ?? "").trim();
    if (!normalizedTurnId) return Boolean(active.codexTurnId);
    return active.codexTurnId === normalizedTurnId;
  }

  /** 超时先按 provider 权威状态结算；仅 legacy hard timeout 会主动中断。 */
  private handleCodexTurnTimeout(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    clientTurnId: TurnId,
    error: EngineTimeoutError,
  ): void {
    const active = this.active;
    if (!active || active.clientTurnId !== clientTurnId) return;
    if (error.code !== "engine_idle_timeout") {
      this.interruptHardTimedOutTurn(ws, { clientTurnId, error });
      return;
    }
    active.pendingEngineIdleTimeoutError = error;
    this.startPendingEngineIdleTimeoutReconcile(active, ws);
  }

  /** activity timeout 仅做权威读取并恢复监控；读取失败时保留 active 等待后续证据重试。 */
  private startPendingEngineIdleTimeoutReconcile(
    active: ActiveTurn,
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
  ): void {
    if (
      this.active !== active
      || !active.pendingEngineIdleTimeoutError
      || active.idleTimeoutReconcilePromise
      || active.manualInterruptRequested
      || active.interruptTerminalError
      || active.providerTerminalStatus
    ) {
      return;
    }
    const timeoutError = active.pendingEngineIdleTimeoutError;
    const reconcile = this.reconcilePendingEngineIdleTimeout(ws, active, timeoutError);
    active.idleTimeoutReconcilePromise = reconcile;
    this.observeDiagnosticTask(() => (reconcile
      .catch((cause) => {
        this.log("error", () => ({ message: "engine idle timeout state reconcile failed; keeping active turn", data: {
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId: this.sessionId,
          clientTurnId: active.clientTurnId,
          providerTurnId: active.codexTurnId,
          timeoutSequence: timeoutError.detail.timeoutSequence,
          errorCode: String(engineDiagnosticField(cause, "code") ?? "").trim() || null,
          error: engineDiagnosticCause(cause),
        } }), { reason: cause });
      })
      .finally(() => {
        if (active.idleTimeoutReconcilePromise === reconcile) active.idleTimeoutReconcilePromise = null;
      })));
  }

  /** 为缺 ID 的 activity timeout 发现唯一 running turn，再复用既有 thread/read 对账。 */
  private async reconcilePendingEngineIdleTimeout(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    active: ActiveTurn,
    error: EngineTimeoutError,
  ): Promise<void> {
    if (!active.codexTurnId) await this.bindLatestRunningProviderTurn(ws, active);
    if (active.manualInterruptRequested || active.interruptTerminalError) return;
    const sessionId = this.sessionId;
    const codexTurnId = active.codexTurnId;
    if (this.active !== active || !sessionId || !codexTurnId) {
      throw buildCodexIdleTimeoutReconcileError(
        sessionId ?? (this.opts.threadId as SessionId),
        codexTurnId ?? "unknown",
        new Error("activity timeout 对账前 active turn 或 provider 绑定已变化"),
      );
    }
    const outcome = await this.reconcileEngineIdleTimeout(ws, {
      clientTurnId: active.clientTurnId,
      sessionId,
      codexTurnId,
      error,
    });
    if (outcome === "unresolved") {
      throw buildCodexIdleTimeoutReconcileError(
        sessionId,
        codexTurnId,
        new Error("thread/read 未返回当前 turn 的权威状态"),
      );
    }
    if (this.active === active && active.pendingEngineIdleTimeoutError === error) {
      active.pendingEngineIdleTimeoutError = null;
    }
  }

  /** 写入单次 timeout 对账事件；缺少 raw emitter 视为运行时不变量破坏。 */
  private emitCodexTimeoutReconcileRaw(data: CodexTimeoutReconcileRawData): void {
    const emitRaw = this.emitters?.raw;
    if (!emitRaw) throw new Error("Codex timeout reconcile missing raw event emitter");
    emitRaw({
      ts: Date.now(),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId as any,
      engine: "codex",
      source: "codex.timeout.reconcile",
      data,
      handled: true,
      action: "mapped",
      emittedTypes: [],
    });
  }

  /** 对 engine idle timeout 执行一次 thread/read，并记录完整权威对账生命周期。 */
  private async reconcileEngineIdleTimeout(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    opts: { clientTurnId: TurnId; sessionId: SessionId; codexTurnId: string; error: EngineTimeoutError },
  ): Promise<"settled" | "monitoring_resumed" | "stale" | "unresolved"> {
    const startedAt = Date.now();
    const common = {
      clientTurnId: String(opts.clientTurnId),
      providerThreadId: String(opts.sessionId),
      providerTurnId: opts.codexTurnId,
      timeoutSequence: opts.error.detail.timeoutSequence,
      requestMethod: "thread/read" as const,
      requestTimeoutMs: CODEX_TIMEOUT_RECONCILE_REQUEST_TIMEOUT_MS,
    };
    this.emitCodexTimeoutReconcileRaw({
      ...common,
      type: "started",
      phase: "started",
      decision: "pending",
      elapsedMs: 0,
      providerThreadStatus: null,
      providerTurnStatus: null,
      providerTurnFound: null,
      activeTurnMatched: null,
      error: null,
    });

    let read: unknown;
    try {
      read = await ws.request(
        "thread/read",
        { threadId: opts.sessionId, includeTurns: true },
        CODEX_STATE_READ_OPTIONS,
      );
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
      const current = this.active;
      this.emitCodexTimeoutReconcileRaw({
        ...common,
        type: "failed",
        phase: "failed",
        decision: "request_failed",
        elapsedMs: Date.now() - startedAt,
        providerThreadStatus: null,
        providerTurnStatus: null,
        providerTurnFound: null,
        activeTurnMatched: Boolean(
          current && current.clientTurnId === opts.clientTurnId && current.codexTurnId === opts.codexTurnId,
        ),
        error: buildCodexTimeoutReconcileErrorDetail(cause),
      });
      throw cause;
    }

    const turns = Array.isArray((read as any)?.thread?.turns) ? ((read as any).thread.turns as any[]) : [];
    const turn = turns.find((item) => String(item?.id ?? "").trim() === opts.codexTurnId) ?? null;
    const turnStatus = normalizeCodexTurnStatus((turn as any)?.status);
    const threadStatus = normalizeCodexTurnStatus((read as any)?.thread?.status);
    const active = this.active;
    const activeTurnMatched = Boolean(
      active && active.clientTurnId === opts.clientTurnId && active.codexTurnId === opts.codexTurnId,
    );
    const emitResolved = (decision: CodexTimeoutReconcileDecision): void => {
      this.emitCodexTimeoutReconcileRaw({
        ...common,
        type: "resolved",
        phase: "resolved",
        decision,
        elapsedMs: Date.now() - startedAt,
        providerThreadStatus: threadStatus || null,
        providerTurnStatus: turnStatus || null,
        providerTurnFound: turn != null,
        activeTurnMatched,
        error: null,
      });
    };
    if (!activeTurnMatched || !active) {
      emitResolved("stale_ignored");
      return "stale";
    }

    if (turnStatus === "completed") {
      emitResolved("completed");
      active.resolve({ reason: "engine_idle_timeout.reconcile", turnStatus, threadRead: read });
      return "settled";
    }
    if (isTerminalCodexTurnStatus(turnStatus)) {
      emitResolved("terminal_failed");
      active.reject(buildCodexTurnTerminalError(active, turnStatus, "engine_idle_timeout.reconcile"));
      return "settled";
    }

    if (turn || isNonTerminalCodexThreadStatus(threadStatus)) {
      if (active.timeoutController.resumeAfterTimeout("provider_turn_in_progress")) {
        emitResolved("monitoring_resumed");
        return "monitoring_resumed";
      }
    }
    emitResolved("unresolved");
    return "unresolved";
  }

  /** legacy hard timeout 发送精确 interrupt；ACK 或精确 provider 终态直接结算。 */
  private interruptHardTimedOutTurn(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    opts: {
      clientTurnId: TurnId;
      error: EngineTimeoutError;
    },
  ): void {
    const active = this.active;
    if (!active || active.clientTurnId !== opts.clientTurnId) return;
    active.interruptTerminalError = opts.error;
    this.startPendingActiveTurnInterrupt(active, ws, "legacy-timeout");
  }

  /** 以 singleflight 执行挂起的真实中断，失败时保留 active 与错误上下文。 */
  private startPendingActiveTurnInterrupt(
    active: ActiveTurn,
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    reason: string,
  ): void {
    if (
      this.active !== active
      || active.interruptPromise
      || active.providerTerminalStatus
      || (!active.manualInterruptRequested && !active.interruptTerminalError)
    ) {
      return;
    }
    const interruptPromise = Promise.resolve().then(() => this.requestAndConfirmActiveTurnInterrupt(active, ws));
    active.interruptPromise = interruptPromise;
    this.observeDiagnosticTask(() => (interruptPromise
      .catch((cause) => {
        this.log("error", () => ({ message: "pending active turn interrupt confirmation failed; keeping active turn", data: {
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId: this.sessionId,
          clientTurnId: active.clientTurnId,
          providerTurnId: active.codexTurnId,
          reason,
          errorCode: String(engineDiagnosticField(cause, "code") ?? "").trim() || null,
          error: engineDiagnosticCause(cause),
        } }), { reason: cause });
      })
      .finally(() => {
        if (active.interruptPromise === interruptPromise) active.interruptPromise = null;
      })));
  }

  private extractTurnScopedTrackedItemId(method: string, params: Record<string, unknown> | undefined): string | null {
    if (method === "item/agentMessage/delta") {
      const itemId = String((params as any)?.itemId ?? (params as any)?.item_id ?? "").trim();
      return itemId || null;
    }
    if (method !== "item/started" && method !== "item/completed") return null;
    const item = ((params as any)?.item ?? null) as Record<string, unknown> | null;
    if (String((item as any)?.type ?? "").trim() !== "agentMessage") return null;
    const itemId = String((item as any)?.id ?? "").trim();
    return itemId || null;
  }

  private scheduleReconnectRecovery(input: { providerTurnId: string | null; reason: string }): void {
    const active = this.active;
    const sessionId = this.sessionId;
    if (!active || !sessionId) return;
    if (input.providerTurnId && !this.activeTurnMatchesProviderTurn(active, input.providerTurnId)) return;
    if (!active.codexTurnId) return;
    const activeCodexTurnId = active.codexTurnId;
    this.clearReconnectRecovery();
    this.pendingReconnectRecoveryTurnId = activeCodexTurnId;
    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    const delayMs = this.opts.reconnectRecoveryGraceMs ?? 2_000;
    this.pendingReconnectRecoveryTimer = setTimeout(() => this.runDiagnosticCallback(() => {
      this.pendingReconnectRecoveryTimer = null;
      this.observeDiagnosticTask(() => (this.reconcileReconnectRecoveryState(ws, {
        sessionId,
        codexTurnId: activeCodexTurnId,
        reason: input.reason,
      })));
    }), Math.max(1, delayMs));
    this.pendingReconnectRecoveryTimer.unref?.();
  }

  private maybeCancelReconnectRecovery(method: string, providerTurnId: string | null): void {
    const pendingTurnId = this.pendingReconnectRecoveryTurnId;
    const active = this.active;
    if (!pendingTurnId || !active) return;
    if (method === "thread/tokenUsage/updated" || method === "token_count") {
      this.clearReconnectRecovery();
      return;
    }
    if (providerTurnId && this.activeTurnMatchesProviderTurn(active, providerTurnId) && providerTurnId === pendingTurnId) {
      this.clearReconnectRecovery();
      return;
    }
    if (!providerTurnId && pendingTurnId === active.codexTurnId && method === "item/agentMessage/delta") {
      this.clearReconnectRecovery();
    }
  }

  private clearReconnectRecovery(): void {
    this.pendingReconnectRecoveryTurnId = null;
    if (this.pendingReconnectRecoveryTimer) {
      clearTimeout(this.pendingReconnectRecoveryTimer);
      this.pendingReconnectRecoveryTimer = null;
    }
  }

  /**
   * 对 transient reconnect 后的 provider 状态做短轮询。
   * 只有看到明确终态才结算；仍在运行时继续等待 live 事件，避免本地 turn 早于 provider turn 结束。
   */
  private async reconcileReconnectRecoveryState(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    opts: { sessionId: SessionId; codexTurnId: string; reason: string },
  ): Promise<void> {
    const maxAttempts = Math.max(1, this.opts.reconnectRecoveryMaxAttempts ?? 4);
    const baseDelayMs = Math.max(1, this.opts.reconnectRecoveryPollMs ?? 1_500);
    let sawNonTerminalProviderState = false;
    let lastCause: unknown = new Error("thread/read 尚未返回当前 provider turn 的精确状态");
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const active = this.active;
      if (!active || active.codexTurnId !== opts.codexTurnId) return;
      if (!this.sessionId || this.sessionId !== opts.sessionId) return;
      if (this.pendingReconnectRecoveryTurnId !== opts.codexTurnId) return;

      let read: unknown;
      try {
        read = await ws.request("thread/read", { threadId: opts.sessionId, includeTurns: true }, CODEX_STATE_READ_OPTIONS);
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        lastCause = cause;
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
          continue;
        }
        this.clearReconnectRecovery();
        this.log("warn", () => ({ message: "reconnect recovery read failed; active turn preserved", data: {
          code: "codex_reconnect_recovery_read_failed",
          requestId: null,
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          sessionId: opts.sessionId,
          clientTurnId: active.clientTurnId,
          providerTurnId: opts.codexTurnId,
          reason: opts.reason,
          rootCause: engineDiagnosticCause(cause),
        } }), { reason: cause });
        return;
      }

      if (
        this.active !== active
        || active.codexTurnId !== opts.codexTurnId
        || this.sessionId !== opts.sessionId
        || this.pendingReconnectRecoveryTurnId !== opts.codexTurnId
      ) return;
      const providerThreadId = String((read as any)?.thread?.id ?? "").trim();
      if (providerThreadId !== String(opts.sessionId)) {
        lastCause = new Error(
          `thread/read 返回了错误 threadId：expected=${opts.sessionId}, actual=${providerThreadId || "missing"}`,
        );
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
          continue;
        }
        break;
      }
      const turns = Array.isArray((read as any)?.thread?.turns) ? ((read as any).thread.turns as any[]) : [];
      const turn = turns.find((item) => String(item?.id ?? "").trim() === opts.codexTurnId) ?? null;
      const threadStatus = normalizeCodexTurnStatus((read as any)?.thread?.status);
      if (turn) {
        const turnStatus = normalizeCodexTurnStatus((turn as any)?.status);
        if (turnStatus === "completed") {
          this.clearReconnectRecovery();
          active.resolve({ reason: `${opts.reason}.reconnect`, turnStatus, threadRead: read });
          return;
        }
        if (isTerminalCodexTurnStatus(turnStatus)) {
          this.clearReconnectRecovery();
          active.reject(buildCodexTurnTerminalError(active, turnStatus, `${opts.reason}.reconnect`));
          return;
        }
        sawNonTerminalProviderState = true;
      } else if (isNonTerminalCodexThreadStatus(threadStatus)) {
        sawNonTerminalProviderState = true;
        lastCause = new Error(
          `thread/read 缺少当前 provider turn：turnId=${opts.codexTurnId}, threadStatus=${threadStatus}`,
        );
      } else {
        lastCause = new Error(
          `thread/read 缺少当前 provider turn：turnId=${opts.codexTurnId}, threadStatus=${threadStatus || "missing"}`,
        );
      }

      if (isTerminalCodexThreadStatus(threadStatus)) {
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
          continue;
        }
        break;
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
      }
    }

    const active = this.active;
    if (!active || active.codexTurnId !== opts.codexTurnId) return;
    if (this.pendingReconnectRecoveryTurnId !== opts.codexTurnId) return;
    if (sawNonTerminalProviderState) {
      const delayMs = Math.max(baseDelayMs, baseDelayMs * maxAttempts);
      this.pendingReconnectRecoveryTimer = setTimeout(() => this.runDiagnosticCallback(() => {
        this.pendingReconnectRecoveryTimer = null;
        this.observeDiagnosticTask(() => (this.reconcileReconnectRecoveryState(ws, opts)));
      }), delayMs);
      this.pendingReconnectRecoveryTimer.unref?.();
      return;
    }
    this.clearReconnectRecovery();
    this.log("warn", () => ({ message: "reconnect recovery unconfirmed; active turn preserved", data: {
      code: "codex_reconnect_recovery_unconfirmed",
      requestId: null,
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      sessionId: opts.sessionId,
      clientTurnId: active.clientTurnId,
      providerTurnId: opts.codexTurnId,
      reason: opts.reason,
      rootCause: engineDiagnosticCause(lastCause),
    } }));
  }

  /** handoff 只核对 turn/start 响应 ID 的终态，禁止用历史 clientId 结果替换该绑定。 */
  private async reconcileStartingTurnHandoffTerminalState(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    opts: {
      startingTurn: StartingTurn;
      sessionId: SessionId;
      responseProviderTurnId: string | null;
      reason: string;
    },
  ): Promise<void> {
    let handledEvidenceVersion = -1;
    while (!this.disposed && handledEvidenceVersion !== opts.startingTurn.terminalEvidenceVersion) {
      handledEvidenceVersion = opts.startingTurn.terminalEvidenceVersion;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (this.disposed) return;
        const active = this.active;
        if (!active || active.clientTurnId !== opts.startingTurn.clientTurnId) return;
        if (this.sessionId !== opts.sessionId) return;
        if (handledEvidenceVersion !== opts.startingTurn.terminalEvidenceVersion) break;

        let read: unknown;
        try {
          read = await ws.request("thread/read", { threadId: opts.sessionId, includeTurns: true }, CODEX_STATE_READ_OPTIONS);
          if (this.disposed) return;
          const providerThreadId = String((read as any)?.thread?.id ?? "").trim();
          if (providerThreadId !== String(opts.sessionId)) {
            throw new Error(`thread/read 返回了错误 threadId：${providerThreadId || "missing"}`);
          }
        } catch (cause) {
          if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
          if (this.disposed) return;
          if (opts.startingTurn.interruptRequested) return;
          if (handledEvidenceVersion !== opts.startingTurn.terminalEvidenceVersion) break;
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
            continue;
          }
          throw buildCodexHandoffTerminalReconcileError(
            opts.sessionId,
            opts.startingTurn.clientTurnId,
            opts.responseProviderTurnId,
            cause,
          );
        }
        if (handledEvidenceVersion !== opts.startingTurn.terminalEvidenceVersion) break;

        const turns = Array.isArray((read as any)?.thread?.turns) ? ((read as any).thread.turns as any[]) : [];
        const responseProviderTurnId = String(opts.responseProviderTurnId ?? "").trim();
        const responseTurns = turns.filter(
          (turn) => String(turn?.id ?? "").trim() === responseProviderTurnId,
        );
        if (responseTurns.length > 1) {
          throw new Error(`thread/read 返回重复的 turn/start 响应 turnId=${responseProviderTurnId}`);
        }
        const responseTurn = responseTurns[0] ?? null;
        const responseTurnStatus = normalizeCodexTurnStatus(responseTurn?.status);
        if (responseTurn) {
          this.bindActiveCodexTurn(active, responseProviderTurnId, "provider_lifecycle");
          opts.startingTurn.providerLifecycleTurnId = responseProviderTurnId;
          opts.startingTurn.signalProviderOwnership();
        }
        if (responseTurn && isTerminalCodexTurnStatus(responseTurnStatus)) {
          opts.startingTurn.handoffTerminalSettled = true;
          this.settleActiveFromProviderTerminal(active, responseTurnStatus, opts.reason, read);
          return;
        }

        if (opts.startingTurn.interruptRequested) return;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }

  /**
   * 当 app-server 只告诉我们 thread/turn 已进入终态，但没有补发 turn/completed 或 turn/error 时，
   * 主动拉一次 `thread/read` 对账，避免上层一直卡在运行中。
   */
  private scheduleTerminalStateReconcile(reason: string): void {
    const active = this.active;
    const sessionId = this.sessionId;
    if (!active || !sessionId) return;
    if (this.pendingHandoffStartingTurn?.clientTurnId === active.clientTurnId) return;
    if (!active.codexTurnId && !active.compactStartState) return;
    const hintVersion = ++this.terminalStateReconcileHintVersion;
    if (this.pendingTerminalStateReconcileTurnId) return;

    const codexTurnId = active.codexTurnId;
    const reconcileKey = codexTurnId ?? `compact:${active.clientTurnId}`;
    this.pendingTerminalStateReconcileTurnId = reconcileKey;
    const ws = this.opts.manager.getOrCreate(this.opts.workspaceId, this.opts.workspacePath);
    const reconcile = codexTurnId
      ? this.reconcileActiveTurnTerminalState(ws, { sessionId, codexTurnId, reason })
      : this.reconcileUnboundCompactTerminalState(ws, {
          sessionId,
          clientTurnId: active.clientTurnId,
          reason,
        });
    this.observeDiagnosticTask(() => (reconcile.catch((cause) => {
      this.log("error", () => ({ message: "provider terminal hint reconcile failed; keeping active turn", data: {
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId,
        clientTurnId: active.clientTurnId,
        providerTurnId: codexTurnId,
        reason,
        error: engineDiagnosticCause(cause),
      } }), { reason: cause });
    }).finally(() => {
      if (this.pendingTerminalStateReconcileTurnId === reconcileKey) {
        this.pendingTerminalStateReconcileTurnId = null;
      }
      if (
        this.active === active
        && this.sessionId === sessionId
        && this.terminalStateReconcileHintVersion > hintVersion
      ) {
        this.scheduleTerminalStateReconcile("provider-terminal-hint.coalesced");
      }
    })));
  }

  /** 无 ID compact 终态只按 contextCompaction item 恢复，不按基线后的普通 turn 猜测。 */
  private async reconcileUnboundCompactTerminalState(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    opts: { sessionId: SessionId; clientTurnId: TurnId; reason: string },
  ): Promise<void> {
    const maxAttempts = 3;
    let lastCause: unknown = new Error("无 turnId 的 compact 终态提示尚未得到权威确认");
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const active = this.active;
      const state = active?.compactStartState ?? null;
      if (!active || active.clientTurnId !== opts.clientTurnId || !state || this.sessionId !== opts.sessionId) return;

      let read: unknown;
      try {
        read = await ws.request("thread/read", { threadId: opts.sessionId, includeTurns: true }, {
          ...CODEX_RECOVERY_REQUEST_OPTIONS,
          history: { excludeTurnIds: [...state.providerTurnIdsBeforeStart], itemTypes: ["contextCompaction"] },
        });
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        lastCause = cause;
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
          continue;
        }
        break;
      }

      if (this.active !== active || active.compactStartState !== state || this.sessionId !== opts.sessionId) return;
      try {
        const outcome = this.reconcileCompactProviderTurnOwnershipFromRead(active, read, opts.reason);
        if (outcome !== "unresolved") return;
        lastCause = new Error("thread/read 未返回基线后的 contextCompaction item");
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        lastCause = cause;
        break;
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }

    const active = this.active;
    if (active?.clientTurnId === opts.clientTurnId && this.sessionId === opts.sessionId) {
      const error = buildCodexCompactOwnershipUnconfirmedError({
        sessionId: opts.sessionId,
        clientTurnId: opts.clientTurnId,
        candidateTurnIds: Array.from(active.compactStartState?.providerCompactTurnIds ?? []),
        cause: lastCause,
      });
      active.interruptTerminalError ??= error;
      this.log("error", () => ({ message: "unbound compact terminal hint unresolved", data: {
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId: opts.sessionId,
        clientTurnId: opts.clientTurnId,
        providerTurnId: active.codexTurnId,
        reason: opts.reason,
        error: engineDiagnosticCause(error),
      } }));
    }
  }

  private async reconcileActiveTurnTerminalState(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    opts: { sessionId: SessionId; codexTurnId: string; reason: string },
  ): Promise<void> {
    const maxAttempts = 3;
    let lastTerminalThreadStatus = "";
    let lastCause: unknown = new Error("provider 终态提示尚未得到权威确认");
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const active = this.active;
      if (!active || active.codexTurnId !== opts.codexTurnId) return;
      if (!this.sessionId || this.sessionId !== opts.sessionId) return;

      let read: unknown;
      try {
        read = await ws.request("thread/read", { threadId: opts.sessionId, includeTurns: true }, CODEX_STATE_READ_OPTIONS);
      } catch (cause) {
        if (isEngineWorkspaceLogFailure(cause)) throw this.retainDiagnosticFailure(cause);
        lastCause = cause;
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
          continue;
        }
        break;
      }

      if (
        this.active !== active
        || this.sessionId !== opts.sessionId
        || active.codexTurnId !== opts.codexTurnId
      ) return;
      const providerThreadId = String((read as any)?.thread?.id ?? "").trim();
      const turns = Array.isArray((read as any)?.thread?.turns) ? ((read as any).thread.turns as any[]) : [];
      const turn = turns.find((item) => String(item?.id ?? "").trim() === opts.codexTurnId) ?? null;
      const threadStatus = normalizeCodexTurnStatus((read as any)?.thread?.status);
      if (providerThreadId !== String(opts.sessionId)) {
        lastCause = new Error(`thread/read 返回了错误 threadId：${providerThreadId || "missing"}`);
      } else if (!turn) {
        lastCause = new Error(`thread/read 缺少当前 provider turn：turnId=${opts.codexTurnId}`);
        if (isTerminalCodexThreadStatus(threadStatus)) {
          lastTerminalThreadStatus = threadStatus;
        }
      } else {
        const turnStatus = normalizeCodexTurnStatus((turn as any)?.status);
        if (isTerminalCodexTurnStatus(turnStatus)) {
          this.settleActiveFromProviderTerminal(active, turnStatus, opts.reason, read);
          return;
        }
        lastCause = new Error(
          `provider turn 尚未确认终态：turnId=${opts.codexTurnId}, turnStatus=${turnStatus || "missing"}, threadStatus=${threadStatus || "missing"}`,
        );
        if (isTerminalCodexThreadStatus(threadStatus)) lastTerminalThreadStatus = threadStatus;
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }

    const active = this.active;
    if (active && active.codexTurnId === opts.codexTurnId) {
      this.log("warn", () => ({ message: "provider terminal hint unresolved; keeping active turn", data: {
        code: "codex_provider_terminal_hint_unconfirmed",
        requestId: null,
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId: opts.sessionId,
        clientTurnId: active.clientTurnId,
        providerTurnId: opts.codexTurnId,
        reason: opts.reason,
        terminalThreadStatus: lastTerminalThreadStatus || null,
        rootCause: engineDiagnosticCause(lastCause),
      } }));
    }
  }

  /** provider request 响应失败时只中断同一已确权 turn，foreign 请求仅记录错误。 */
  private handleProviderRequestResponseFailure(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    method: string,
    requestId: unknown,
    providerTurnId: string | null,
    cause: unknown,
  ): void {
    const error = cause instanceof Error ? cause : new Error("Codex provider request response failed", { cause });
    const active = this.active;
    this.log("error", () => ({ message: "provider request response failed", data: {
      code: "codex_provider_request_response_failed",
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      sessionId: this.sessionId,
      clientTurnId: active?.clientTurnId ?? null,
      providerTurnId: active?.codexTurnId ?? null,
      requestProviderTurnId: providerTurnId,
      method,
      requestId: String(requestId ?? ""),
      error: engineDiagnosticCause(error),
    } }), { reason: cause });
    if (!active || !providerTurnId || active.codexTurnId !== providerTurnId) return;
    active.interruptTerminalError ??= error;
    this.startPendingActiveTurnInterrupt(active, ws, "provider-request-response-failed");
  }

  /** 执行失败返回工具失败；响应发送失败交给统一传输边界，禁止重复响应。 */
  private async respondDynamicToolCall(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    requestId: unknown,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    const active = this.active;
    const toolId = this.resolveDynamicToolCallToolId(String((params as any)?.tool ?? "").trim());
    const toolInput = (params as any)?.arguments;

    const tool = this.findRegisteredTool(toolId);
    if (!toolId || !active?.executeHostTool || !tool) {
      const result = {
        ok: false,
        message: toolId ? `当前回合未注册工具：${toolId}` : "动态工具调用缺少 tool",
        code: "TOOL_NOT_FOUND",
      } satisfies HostToolExecutionResult;
      this.log("error", () => ({ message: "dynamic tool request is not registered for the active turn", data: {
        code: "TOOL_NOT_FOUND",
        requestId: String(requestId),
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        providerThreadId: this.sessionId,
        clientTurnId: active?.clientTurnId ?? null,
        providerTurnId: active?.codexTurnId ?? null,
        toolCallId: params?.callId ?? null,
        toolId,
        registeredToolIds: listExecutableToolIds(active?.toolRegistry ?? null),
        rootCause: result.message,
      } }));
      await ws.respond(requestId, buildCodexDynamicToolResponse(result));
      if (active && toolId) {
        await this.handlePlatformToolFailureThreshold(ws, active, toolId, toolInput, result);
      }
      return;
    }

    let result: HostToolExecutionResult;
    try {
      result = await active.executeHostTool({
        toolId,
        toolInput,
        accessMode: active.accessMode,
      });
    } catch (error) {
      if (isEngineWorkspaceLogFailure(error)) throw this.retainDiagnosticFailure(error);
      const failure: Extract<HostToolExecutionResult, { ok: false }> = {
        ok: false,
        message: redactClientStartupText(error instanceof Error ? error.message : String(error)),
        code: "TOOL_EXECUTION_FAILED",
      };
      result = failure;
      this.log("error", () => ({ message: "dynamic tool execution threw before returning a result", data: {
        code: "TOOL_EXECUTION_FAILED", requestId: String(requestId),
        workspaceId: this.opts.workspaceId, threadId: this.opts.threadId,
        providerThreadId: this.sessionId, clientTurnId: active.clientTurnId,
        providerTurnId: active.codexTurnId, toolCallId: params?.callId ?? null,
        toolId, rootCause: failure.message,
      } }), { reason: error });
    }
    await ws.respond(requestId, buildCodexDynamicToolResponse(result));
    if (result.ok) {
      if (active.platformToolFailureCounts) clearPlatformToolFailureCounts(active.platformToolFailureCounts, toolId);
      return;
    }
    await this.handlePlatformToolFailureThreshold(ws, active, toolId, toolInput, result);
  }

  /** 读取上限立即结束当前 turn；其他工具错误仍按连续失败阈值处理。 */
  private async handlePlatformToolFailureThreshold(
    ws: ReturnType<CodexAppServerManager["getOrCreate"]>,
    active: ActiveTurn,
    toolId: string,
    toolInput: unknown,
    result: Extract<HostToolExecutionResult, { ok: false }>,
  ): Promise<void> {
    const normalizedToolId = String(toolId ?? "").trim();
    if (!normalizedToolId) return;
    if (result.code === "KNOWLEDGE_ASSET_READ_LIMIT_REACHED") {
      if (active.interruptTerminalError) return;
      const displayName = this.resolveDynamicToolDisplayName(normalizedToolId) ?? normalizedToolId;
      const error = createPlatformToolReadLimitError(displayName, result.message);
      active.interruptTerminalError = error;
      this.startPendingActiveTurnInterrupt(active, ws, "knowledge-asset-read-limit");
      return;
    }
    if (result.code === "WORK_ITEM_CONTEXT_CHECKPOINT_REQUIRED") {
      const checkpointError = Object.assign(new Error(result.message), {
        code: "WORK_ITEM_CONTEXT_CHECKPOINT_REQUIRED",
      });
      active.interruptTerminalError ??= checkpointError;
      this.startPendingActiveTurnInterrupt(active, ws, "work-item-context-checkpoint");
      return;
    }
    const failureCounts = active.platformToolFailureCounts ?? new Map<string, number>();
    active.platformToolFailureCounts = failureCounts;
    const failureKey = platformToolFailureKey(normalizedToolId, toolInput, result);
    const failureCount = (failureCounts.get(failureKey) ?? 0) + 1;
    failureCounts.set(failureKey, failureCount);
    if (failureCount < PLATFORM_TOOL_FAILURE_RETRY_LIMIT) return;

    failureCounts.delete(failureKey);
    const displayName = this.resolveDynamicToolDisplayName(normalizedToolId) ?? normalizedToolId;
    const error = createPlatformToolRetryExhaustedError(displayName, failureCount, result.message, result.code ?? null);
    active.interruptTerminalError = error;
    this.startPendingActiveTurnInterrupt(active, ws, "platform-tool-retry-exhausted");
  }

  private resolveDynamicToolDisplayName(toolId: string): string | null {
    const normalizedToolId = this.resolveDynamicToolCallToolId(toolId);
    if (!normalizedToolId) return null;
    const tool = this.findRegisteredTool(normalizedToolId);
    if (!tool) return null;
    return String(tool.alias || tool.name || normalizedToolId).trim() || normalizedToolId;
  }

  private resolveDynamicToolCallToolId(requestedToolName: string): string {
    const normalizedToolName = String(requestedToolName ?? "").trim();
    if (!normalizedToolName) return "";
    const toolIdByName = buildCodexDynamicToolToolIdByName(this.active?.toolRegistry ?? null);
    return toolIdByName.get(normalizedToolName) ?? normalizedToolName;
  }

  private findRegisteredTool(toolKey: string): ExecutableToolRegistry["tools"][number] | null {
    const normalizedToolKey = String(toolKey ?? "").trim();
    if (!normalizedToolKey) return null;
    return this.active?.toolRegistry?.tools.find((item) =>
      String(item.toolId) === normalizedToolKey
      || String(item.alias ?? "").trim() === normalizedToolKey
      || String(item.name ?? "").trim() === normalizedToolKey,
    ) ?? null;
  }

  /** 登记命令与进程，完成状态只由对应 provider 完成事件确认。 */
  private handleCommandExecutionStarted(input: {
    itemId: string;
    processId: string | null;
    command: string;
    cwd: string;
    status: string;
  }): void {
    this.pendingCommandExecutionsByItemId.add(input.itemId);
    const processId = String(input.processId ?? "").trim();
    if (!processId) return;
    const serviceId = buildCodexEngineServiceId(processId);
    const previous = this.backgroundProcessesByItemId.get(input.itemId) ?? this.backgroundProcessesByServiceId.get(serviceId) ?? null;
    const record: CodexBackgroundProcessRecord = {
      itemId: input.itemId,
      serviceId,
      processId,
      command: input.command || previous?.command || "",
      workingDirectory: input.cwd || previous?.workingDirectory || this.opts.workspacePath,
      outputTail: previous?.outputTail ?? "",
      startedAt: previous?.startedAt ?? Date.now(),
      readyAt: previous?.readyAt ?? null,
      exitedAt: previous?.exitedAt ?? null,
      exitCode: previous?.exitCode ?? null,
      displayName: previous?.displayName ?? formatCodexEngineDisplayName(processId),
    };
    this.pendingBackgroundProcessesByItemId.set(input.itemId, record);
  }

  private handleCommandExecutionOutputDelta(input: {
    itemId: string;
    delta: string;
  }): void {
    const pending = this.pendingBackgroundProcessesByItemId.get(input.itemId) ?? null;
    if (!pending) return;

    const outputTail = appendCodexCommandOutputTail(pending.outputTail, input.delta);
    const record: CodexBackgroundProcessRecord = {
      ...pending,
      outputTail,
    };
    this.pendingBackgroundProcessesByItemId.set(input.itemId, record);

    const confirmedProcessId = extractCodexManagedProcessIdFromOutput(outputTail);
    if (!confirmedProcessId || confirmedProcessId !== record.processId) return;

    // Codex app-server 的旧版本没有把更底层的“后台终端来源标记”透传给 Web。
    // 为兼容这些历史版本，这里只把 Codex 自己统一生成的官方摘要
    // “Process running with session ID ...” 视作后台终端确认信号；
    // 未出现该摘要的普通命令，即使带有 processId，也不会进入底部“进程”列表。
    const readyRecord: CodexBackgroundProcessRecord = {
      ...record,
      readyAt: record.readyAt ?? Date.now(),
      exitedAt: null,
      exitCode: null,
    };
    this.pendingBackgroundProcessesByItemId.delete(input.itemId);
    this.backgroundProcessesByItemId.set(input.itemId, readyRecord);
    this.backgroundProcessesByServiceId.set(readyRecord.serviceId, readyRecord);
    this.publishEngineProcessSnapshot({
      serviceId: readyRecord.serviceId,
      displayName: readyRecord.displayName,
      source: "engine",
      stopSupported: parseManagedProcessPid(readyRecord.processId) != null,
      status: "ready",
      pid: parseManagedProcessPid(readyRecord.processId),
      command: readyRecord.command,
      args: [],
      workingDirectory: readyRecord.workingDirectory,
      startupTimeoutMs: 0,
      readySummary: "后台运行中",
      startedAt: readyRecord.startedAt,
      readyAt: readyRecord.readyAt,
      exitedAt: null,
      exitCode: null,
      exitSignal: null,
    });
  }

  private handleCommandExecutionTerminalInteraction(input: {
    itemId: string;
    processId: string;
    stdin: string;
  }): void {
    const processId = String(input.processId ?? "").trim();
    if (!processId) return;
    const serviceId = buildCodexEngineServiceId(processId);
    const previous = this.backgroundProcessesByItemId.get(input.itemId) ?? this.backgroundProcessesByServiceId.get(serviceId) ?? null;
    if (!previous) return;
    const record: CodexBackgroundProcessRecord = {
      itemId: input.itemId,
      serviceId,
      processId,
      command: previous?.command ?? "",
      workingDirectory: previous?.workingDirectory ?? this.opts.workspacePath,
      outputTail: previous?.outputTail ?? "",
      startedAt: previous?.startedAt ?? Date.now(),
      readyAt: previous?.readyAt ?? Date.now(),
      exitedAt: null,
      exitCode: null,
      displayName: previous?.displayName ?? formatCodexEngineDisplayName(processId),
    };
    this.backgroundProcessesByItemId.set(input.itemId, record);
    this.backgroundProcessesByServiceId.set(serviceId, record);
    this.publishEngineProcessSnapshot({
      serviceId,
      displayName: record.displayName,
      source: "engine",
      stopSupported: parseManagedProcessPid(processId) != null,
      status: "ready",
      pid: parseManagedProcessPid(processId),
      command: record.command,
      args: [],
      workingDirectory: record.workingDirectory,
      startupTimeoutMs: 0,
      readySummary: "后台运行中",
      startedAt: record.startedAt,
      readyAt: record.readyAt,
      exitedAt: null,
      exitCode: null,
      exitSignal: null,
    });
  }

  private handleCommandExecutionCompleted(input: {
    itemId: string;
    processId: string | null;
    command: string;
    cwd: string;
    status: string;
    exitCode: number | null;
    durationMs: number | null;
  }): void {
    this.pendingCommandExecutionsByItemId.delete(input.itemId);
    const processId = String(input.processId ?? "").trim();
    const serviceId = processId ? buildCodexEngineServiceId(processId) : null;
    const previous = this.backgroundProcessesByItemId.get(input.itemId) ?? (serviceId ? this.backgroundProcessesByServiceId.get(serviceId) : null) ?? null;
    const pending = this.pendingBackgroundProcessesByItemId.get(input.itemId) ?? null;
    if (!previous) {
      if (pending) this.pendingBackgroundProcessesByItemId.delete(input.itemId);
      return;
    }
    this.pendingBackgroundProcessesByItemId.delete(input.itemId);
    const normalizedStatus = normalizeCodexCommandExecutionStatus(input.status);
    const finalStatus = normalizedStatus === "stopped" ? "stopped" : "exited";
    const record: CodexBackgroundProcessRecord = {
      itemId: input.itemId,
      serviceId: previous.serviceId,
      processId: previous.processId,
      command: input.command || previous.command,
      workingDirectory: input.cwd || previous.workingDirectory,
      outputTail: previous.outputTail,
      startedAt: previous.startedAt,
      readyAt: previous.readyAt,
      exitedAt: previous.exitedAt ?? Date.now(),
      exitCode: input.exitCode ?? previous.exitCode,
      displayName: previous.displayName,
    };
    this.backgroundProcessesByItemId.set(input.itemId, record);
    this.backgroundProcessesByServiceId.set(record.serviceId, record);
    this.publishEngineProcessSnapshot({
      serviceId: record.serviceId,
      displayName: record.displayName,
      source: "engine",
      stopSupported: false,
      status: finalStatus,
      pid: parseManagedProcessPid(record.processId),
      command: record.command,
      args: [],
      workingDirectory: record.workingDirectory,
      startupTimeoutMs: 0,
      readySummary: buildCodexCommandExecutionSummary(finalStatus, input.exitCode, input.durationMs),
      startedAt: record.startedAt,
      readyAt: record.readyAt,
      exitedAt: record.exitedAt,
      exitCode: input.exitCode ?? null,
      exitSignal: null,
    });
  }

  /** 判断 Codex 侧是否仍有已确认的后台进程存活。 */
  private hasLiveBackgroundProcess(): boolean {
    for (const record of this.backgroundProcessesByServiceId.values()) {
      if (record.exitedAt == null) return true;
    }
    return false;
  }

  private publishEngineProcessSnapshot(snapshot: ManagedServiceSnapshot): void {
    const changed = this.opts.onEngineProcessSnapshot(snapshot);
    if (!changed) return;
    this.emitters?.conversation({
      ts: Date.now(),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId as any,
      engine: "codex",
      type: "thread.process.changed",
      payload: {
        serviceId: snapshot.serviceId,
        source: "engine",
        status: snapshot.status,
      },
    } satisfies ConversationEventInput);
  }

  /** 日志使用构造时的 W，所有描述均延迟至同一保因边界内执行。 */
  private log(level: WorkspaceLogEntry["level"], build: () => { message: string; data?: unknown }, business?: { reason: unknown }): void {
    this.assertDiagnosticReady();
    try {
      writeEngineWorkspaceLog(this.opts.writeWorkspaceLog, this.opts.workspaceId, () => {
        const entry = build();
        return { level, tag: "codex-app-server", message: entry.message, data: { threadId: this.opts.threadId,
          ...(entry.data as Record<string, unknown> | undefined) } };
      }, business);
    } catch (cause) { throw this.retainDiagnosticFailure(cause); }
  }

  /** 同一会话保留诊断根因，停止重试并拒绝活动等待，不影响其它 W。 */
  private retainDiagnosticFailure(cause: unknown): Error {
    if (this.diagnosticFailure) return this.diagnosticFailure.reason;
    const failure = isEngineWorkspaceLogFailure(cause) ? cause as Error : createEngineWorkspaceLogFailure(cause);
    this.diagnosticFailure = { reason: failure };
    this.clearReconnectRecovery();
    this.pendingSteerOwnershipRecoveryRequested = false;
    const starts = new Set([this.startingTurn, this.pendingHandoffStartingTurn,
      this.active?.providerOwnershipStartingTurn ?? null, ...this.pendingInterruptedStartingTurns.values()]);
    for (const startingTurn of starts) {
      if (!startingTurn) continue;
      startingTurn.startError = failure;
      startingTurn.reconcileRetryPending = false;
      startingTurn.ownershipRecoveryExhausted = true;
      this.clearStartingTurnOwnershipRecoveryTimer(startingTurn);
    }
    for (const correlation of this.pendingSteerCorrelationsByProviderClientKey.values()) {
      correlation.ownershipRecoveryExhausted = true;
      this.clearSteerOwnershipRecoveryTimer(correlation);
    }
    const active = this.active;
    if (active) {
      active.lastNonRetryableTurnError = failure;
      active.timeoutController.stop();
      try { active.reject(failure); }
      catch (secondary) { this.diagnosticFailure.reason = createEngineWorkspaceLogFailure(new AggregateError([failure, secondary], "Codex 回合和诊断收口均失败", { cause: failure })); }
    }
    return this.diagnosticFailure.reason;
  }

  /** 诊断失败后所有新副作用与 idle 资格检查必须失败。 */
  private assertDiagnosticReady(): void {
    if (this.diagnosticFailure) throw this.diagnosticFailure.reason;
  }

  /** 原 detached task 的拒绝留在原会话事实，关闭负责清理并显式返回，避免全局拒绝。 */
  private observeDiagnosticTask(run: () => Promise<unknown>): void {
    try { void run().then(() => undefined, cause => { this.retainDiagnosticFailure(cause); }); }
    catch (cause) { this.retainDiagnosticFailure(cause); }
  }

  /** Timer 的同步失败留在会话 owner；后续 send/idle/dispose 都会观察，禁止逃逸进程。 */
  private runDiagnosticCallback(run: () => void): void {
    try { this.assertDiagnosticReady(); run(); }
    catch (cause) { this.retainDiagnosticFailure(cause); }
  }
}

/** 把知识读取上限转换为可追踪的终止错误，避免平台继续重试同一调用。 */
function createPlatformToolReadLimitError(toolName: string, failureMessage: string): Error & { code: "platform_tool_read_limit_reached"; toolFailureCode?: string | null } {
  const wrapped = new Error(`平台工具 ${toolName} 已达到本轮读取上限：${failureMessage || "请整理已有证据后提交当前资产"}`) as Error & { code: "platform_tool_read_limit_reached"; toolFailureCode?: string | null };
  wrapped.code = "platform_tool_read_limit_reached";
  wrapped.toolFailureCode = "KNOWLEDGE_ASSET_READ_LIMIT_REACHED";
  return wrapped;
}

function createPlatformToolRetryExhaustedError(
  toolName: string,
  failureCount: number,
  failureMessage: string,
  failureCode: string | null,
): Error & { code: "platform_tool_failed_too_many_times" } {
  const wrapped = new Error(
    `平台工具 ${toolName} 在同一轮内已连续失败 ${failureCount} 次：${failureMessage || "执行失败"}`,
  ) as Error & { code: "platform_tool_failed_too_many_times"; toolFailureCode?: string | null };
  wrapped.code = "platform_tool_failed_too_many_times";
  wrapped.toolFailureCode = failureCode;
  return wrapped;
}

function isCodexDynamicToolTransportRejectedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  const mentionsDynamicTools =
    normalized.includes("tools[")
    || normalized.includes("\"param\":\"tools")
    || normalized.includes("\"param\": \"tools")
    || normalized.includes("dynamic tools")
    || normalized.includes("dynamic tool");
  return (
    mentionsDynamicTools
    && (
      normalized.includes("invalid_request_error")
      || normalized.includes("上游服务拒绝请求")
      || normalized.includes("unsupported")
    )
  );
}

function normalizeAutoCompactPct(value: number | null | undefined): number | null {
  const normalized = Number(value ?? PRODUCT_DEFAULT_AUTO_COMPACT_PCT);
  if (!Number.isFinite(normalized) || normalized < 50 || normalized > 99) return PRODUCT_DEFAULT_AUTO_COMPACT_PCT;
  return Math.round(normalized);
}

/** 从 app-server params 中读取 provider turnId，兼容不同命名风格。 */
function extractCodexProviderTurnId(params: Record<string, unknown> | undefined): string | null {
  const item = ((params as any)?.item ?? null) as Record<string, unknown> | null;
  const turnId = String(
    (params as any)?.turnId
    ?? (params as any)?.turn_id
    ?? (params as any)?.turn?.id
    ?? (item as any)?.turnId
    ?? (item as any)?.turn_id
    ?? "",
  ).trim();
  return turnId || null;
}

/** 判断 compact/start 已由正常或迟到 RPC ACK 明确接受。 */
function hasAcknowledgedCompactStart(state: CompactStartState): boolean {
  return state.phase === "accepted" || state.lateSettlementResult?.status === "fulfilled";
}

/** 从 compact 专用通知或 item 中提取 provider turnId。 */
function extractCodexCompactEvidenceTurnId(
  method: string,
  params: Record<string, unknown> | undefined,
  providerTurnId: string | null,
): string | null {
  const normalizedTurnId = String(providerTurnId ?? "").trim();
  if (!normalizedTurnId) return null;
  if (method === "thread/compacted") return normalizedTurnId;
  const itemType = String(((params as any)?.item as any)?.type ?? "").trim();
  if ((method === "item/started" || method === "item/completed") && itemType === "contextCompaction") {
    return normalizedTurnId;
  }
  const turnItems = Array.isArray((params as any)?.turn?.items) ? ((params as any).turn.items as any[]) : [];
  return turnItems.some((item) => String(item?.type ?? "").trim() === "contextCompaction")
    ? normalizedTurnId
    : null;
}

/** 从 provider 快照中找出基线后含 contextCompaction item 的 turn。 */
function findCodexCompactTurnIdsAfterBaseline(
  turns: readonly any[],
  providerTurnIdsBeforeStart: ReadonlySet<string>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const turnId = String(turn?.id ?? "").trim();
    if (!turnId || seen.has(turnId) || providerTurnIdsBeforeStart.has(turnId)) continue;
    if (!Array.isArray(turn?.items)) continue;
    if (!turn.items.some((item: any) => String(item?.type ?? "").trim() === "contextCompaction")) continue;
    seen.add(turnId);
    result.push(turnId);
  }
  return result;
}

/** 读取 provider 对 turn/start 或 turn/steer 的用户消息关联回显。 */
function extractCodexUserMessageClientId(
  method: string,
  params: Record<string, unknown> | undefined,
): string | null {
  if (method !== "item/started" && method !== "item/completed") return null;
  const item = ((params as any)?.item ?? null) as Record<string, unknown> | null;
  if (String((item as any)?.type ?? "").trim() !== "userMessage") return null;
  const clientId = String((item as any)?.clientId ?? "").trim();
  return clientId || null;
}

/** 校验 itemsView=full 的 turn 结构，禁止把缺失 items 误判为 clientId 不存在。 */
function assertCodexFullTurnItems(turns: readonly any[], sessionId: string): void {
  for (const turn of turns) {
    const turnId = String(turn?.id ?? "").trim();
    const itemsView = String(turn?.itemsView ?? "").trim();
    if (!turnId || itemsView !== "full" || !Array.isArray(turn?.items)) {
      throw new Error(
        `thread/turns/list full item 结构非法：threadId=${sessionId}, turnId=${turnId || "missing"}, itemsView=${itemsView || "missing"}`,
      );
    }
  }
}

/** 判断有界 turn 列表是否已覆盖完整历史；缺少游标字段时按页容量保守判断。 */
function isCodexTurnListComplete(listed: unknown, turns: readonly unknown[], limit: number): boolean {
  const hasExplicitNextCursor = Boolean(
    listed
    && typeof listed === "object"
    && Object.prototype.hasOwnProperty.call(listed, "nextCursor"),
  );
  return hasExplicitNextCursor
    ? !String((listed as any)?.nextCursor ?? "").trim()
    : turns.length < limit;
}

/** 按 clientId 区分未回显、唯一归属和 provider 多义冲突。 */
function matchCodexTurnsByClientUserMessageId(
  turns: readonly any[],
  clientUserMessageId: string,
): CodexClientIdTurnMatch {
  const normalizedClientId = String(clientUserMessageId ?? "").trim();
  if (!normalizedClientId) return { kind: "missing", turnIds: [] };
  const turnIds = turns.flatMap((turn) => {
    if (!Array.isArray(turn?.items)) return [];
    const matchesClientId = turn.items.some((item: any) => (
      String(item?.type ?? "").trim() === "userMessage"
      && String(item?.clientId ?? "").trim() === normalizedClientId
    ));
    const turnId = String(turn?.id ?? "").trim();
    return matchesClientId && turnId ? [turnId] : [];
  });
  if (turnIds.length === 0) return { kind: "missing", turnIds: [] };
  if (turnIds.length === 1) return { kind: "unique", turnIds: [turnIds[0]!], turnId: turnIds[0]! };
  return { kind: "ambiguous", turnIds };
}

/** 判断当前 app-server method 是否应该受 provider turn 归属约束。 */
function isCodexTurnScopedProviderMethod(method: string, params: Record<string, unknown> | undefined): boolean {
  if (extractCodexProviderTurnId(params)) return true;
  if (
    method === "item/agentMessage/delta"
    || method === "item/plan/delta"
    || method === "turn/plan/updated"
    || method === "turn/completed"
    || method === "turn/error"
    || method === "turn/status/changed"
    || method === "error"
  ) {
    return true;
  }
  if (method !== "item/started" && method !== "item/completed") return false;
  const itemType = String(((params as any)?.item as any)?.type ?? "").trim();
  return itemType === "agentMessage" || itemType === "plan" || itemType === "userMessage" || itemType === "reasoning";
}

function codexAssistantPhasePriority(phase: AssistantMessagePhase | undefined): number {
  if (phase === "structured_result") return 4;
  if (phase === "final_answer") return 3;
  if (phase === "commentary") return 1;
  return 2;
}

function normalizeAssistantReconcileText(text: string): string {
  return String(text ?? "").trim();
}

/** 规范化正式 ThreadGoalStatus；未知值保持失败关闭。 */
function normalizeCodexThreadGoalStatus(status: unknown): string {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized === "active"
    || normalized === "paused"
    || normalized === "blocked"
    || normalized === "usagelimited"
    || normalized === "budgetlimited"
    || normalized === "complete"
    ? normalized
    : "";
}

function normalizeCodexTurnStatus(status: unknown): string {
  if (typeof status === "string") return status.trim().toLowerCase();
  if (status && typeof status === "object") {
    const type = String((status as any).type ?? "").trim().toLowerCase();
    if (type) return type;
  }
  return "";
}

/** 复制 capability 快照，避免外部数组后续变更污染当前 binding。 */
function cloneThreadSessionCapabilities(capabilities: ThreadSessionCapabilities): ThreadSessionCapabilities {
  return {
    codexDynamicToolIds: Array.isArray(capabilities.codexDynamicToolIds)
      ? capabilities.codexDynamicToolIds.map((toolId) => String(toolId))
      : capabilities.codexDynamicToolIds ?? null,
    codexDynamicToolBindingVersion: capabilities.codexDynamicToolBindingVersion ?? null,
  };
}

/** capabilities 只比较当前正式字段；工具 ID 作为集合按稳定序列比较。 */
function threadSessionCapabilitiesEqual(
  left: ThreadSessionCapabilities,
  right: ThreadSessionCapabilities,
): boolean {
  const normalizeToolIds = (value: string[] | null | undefined): string[] => Array.isArray(value)
    ? value.map((toolId) => String(toolId ?? "").trim()).filter(Boolean).sort()
    : [];
  const leftToolIds = normalizeToolIds(left.codexDynamicToolIds);
  const rightToolIds = normalizeToolIds(right.codexDynamicToolIds);
  return leftToolIds.length === rightToolIds.length
    && leftToolIds.every((toolId, index) => toolId === rightToolIds[index])
    && String(left.codexDynamicToolBindingVersion ?? "").trim() === String(right.codexDynamicToolBindingVersion ?? "").trim();
}

/** 构造原 thread 恢复/能力门禁错误；原 provider binding 始终保留。 */
function buildCodexProviderThreadRecoveryError(input: {
  code: "codex_thread_resume_unconfirmed"
    | "codex_thread_capability_incompatible";
  providerThreadId: SessionId | null;
  reason: string;
  message: string;
  cause?: unknown;
  retryable?: boolean;
}): Error {
  const cause = input.cause instanceof Error
    ? input.cause
    : input.cause == null
      ? undefined
      : new Error(String(input.cause));
  return Object.assign(new Error(input.message, cause ? { cause } : undefined), {
    code: input.code,
    providerThreadId: input.providerThreadId,
    reason: input.reason,
    retryable: input.retryable !== false,
    preserveBinding: true,
  });
}

/** 识别 RPC 超时；超时后的同一 provider 队列不可继续追加恢复请求。 */
function isCodexRecoveryRequestTimeout(error: unknown): boolean {
  if (String((error as any)?.code ?? "").trim() === "codex_app_server_request_timeout") return true;
  return String(error instanceof Error ? error.message : error ?? "")
    .trim()
    .toLowerCase()
    .includes("codex app-server request timeout");
}

/** 同时保留 resume 与权威 read 两个失败原因，便于结构化日志追查。 */
function combineCodexResumeAndReadFailures(resumeCause: unknown, readCause: unknown): Error {
  const readError = readCause instanceof Error ? readCause : new Error(String(readCause));
  if (resumeCause == null) return readError;
  const resumeError = resumeCause instanceof Error ? resumeCause : new Error(String(resumeCause));
  return Object.assign(new Error(
    `thread/resume 失败：${resumeError.message}；thread/read 失败：${readError.message}`,
    { cause: readError },
  ), { resumeCause: resumeError });
}

/** resume 不阻断精确 interrupt 重试；两者都失败时保留两个原始原因。 */
function combineCodexResumeAndInterruptFailures(resumeCause: unknown, interruptCause: unknown): Error {
  const interruptError = interruptCause instanceof Error ? interruptCause : new Error(String(interruptCause));
  if (resumeCause == null) return interruptError;
  const resumeError = resumeCause instanceof Error ? resumeCause : new Error(String(resumeCause));
  return Object.assign(new Error(
    `thread/resume 失败：${resumeError.message}；turn/interrupt 重试失败：${interruptError.message}`,
    { cause: interruptError },
  ), { resumeCause: resumeError });
}

function isTerminalCodexTurnStatus(status: string): boolean {
  return status === "completed" || status === "interrupted" || status === "error" || status === "failed" || status === "cancelled";
}

/** 识别 thread/read 中明确仍在执行的 provider turn 状态。 */
function isRunningCodexTurnStatus(status: string): boolean {
  return status === "inprogress" || status === "in_progress" || status === "running" || status === "active";
}

function isTerminalCodexThreadStatus(status: string): boolean {
  return status === "idle" || status === "systemerror" || status === "system_error" || status === "notloaded";
}

/** 识别 app-server 明确表示仍在运行的 thread status。 */
function isNonTerminalCodexThreadStatus(status: string): boolean {
  return status === "active" || status === "running" || status === "busy";
}

/** 解析 rollback 前后的权威 thread 快照，仅接受 idle 且 turnId 完整唯一的历史。 */
function parseCodexRollbackThreadSnapshot(result: unknown, expectedThreadId: SessionId): { turnIds: string[] } {
  const thread = (result as any)?.thread ?? null;
  const providerThreadId = String(thread?.id ?? "").trim();
  if (providerThreadId !== String(expectedThreadId)) {
    throw new Error(`thread/read 返回了错误 threadId：${providerThreadId || "missing"}`);
  }
  const threadStatus = normalizeCodexTurnStatus(thread?.status);
  if (threadStatus !== "idle") {
    throw new Error(`thread/read 未返回 idle thread：${threadStatus || "missing"}`);
  }
  if (!Array.isArray(thread?.turns)) {
    throw new Error("thread/read 未返回完整 turns");
  }

  const turnIds: string[] = [];
  const seenTurnIds = new Set<string>();
  const runningTurnIds: string[] = [];
  for (let index = 0; index < thread.turns.length; index += 1) {
    const turn = thread.turns[index];
    const rawTurnId = turn?.id;
    const turnId = typeof rawTurnId === "string" ? rawTurnId.trim() : "";
    if (!turnId) throw new Error(`thread/read 第 ${index + 1} 个 turn 缺少有效 id`);
    if (seenTurnIds.has(turnId)) throw new Error(`thread/read 返回重复 turnId：${turnId}`);
    seenTurnIds.add(turnId);
    turnIds.push(turnId);
    if (isRunningCodexTurnStatus(normalizeCodexTurnStatus(turn?.status))) runningTurnIds.push(turnId);
  }
  if (runningTurnIds.length > 0) {
    throw new Error(`thread/read 的 idle thread 仍包含运行中 turn：${formatCodexTurnIds(runningTurnIds)}`);
  }
  return { turnIds };
}

/** 严格比较 provider turnId 序列，防止只按数量误判回滚成功。 */
function codexTurnIdListsEqual(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((turnId, index) => turnId === expected[index]);
}

/** 过滤未物化映射后，仅接受仍构成 provider 精确尾部且保留边界一致的计划。 */
function reconcileCodexRollbackProviderTail(input: {
  providerTurnIds: string[];
  expectedDroppedTurnIds: string[];
  expectedRetainedTurnId: string | null;
}): { droppedTurnIds: string[]; afterTurnIds: string[]; phantomTurnIds: string[] } {
  const providerTurnIdSet = new Set(input.providerTurnIds);
  const droppedTurnIds = input.expectedDroppedTurnIds.filter((turnId) => providerTurnIdSet.has(turnId));
  const phantomTurnIds = input.expectedDroppedTurnIds.filter((turnId) => !providerTurnIdSet.has(turnId));
  const cutIndex = input.providerTurnIds.length - droppedTurnIds.length;
  const afterTurnIds = input.providerTurnIds.slice(0, cutIndex);
  const actualDroppedTurnIds = input.providerTurnIds.slice(cutIndex);
  if (!codexTurnIdListsEqual(droppedTurnIds, actualDroppedTurnIds)) {
    throw new Error(
      `provider 待删除 turns 与本地映射不一致：expected=${formatCodexTurnIds(input.expectedDroppedTurnIds)}, actual=${formatCodexTurnIds(actualDroppedTurnIds)}`,
    );
  }
  const actualRetainedTurnId = afterTurnIds.length > 0 ? afterTurnIds[afterTurnIds.length - 1]! : null;
  if (actualRetainedTurnId !== input.expectedRetainedTurnId) {
    throw new Error(
      `provider 回滚边界与本地映射不一致：expected=${input.expectedRetainedTurnId ?? "empty"}, actual=${actualRetainedTurnId ?? "empty"}`,
    );
  }

  return { droppedTurnIds, afterTurnIds, phantomTurnIds };
}

/** 严格规范化本地提供的 provider turnId 列表，拒绝空值和重复项。 */
function normalizeCodexRollbackTurnIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Codex 回滚映射 ${label} 必须是数组`);
  const turnIds = value.map((item) => String(item ?? "").trim());
  if (turnIds.some((turnId) => !turnId)) throw new Error(`Codex 回滚映射 ${label} 包含空 turnId`);
  if (new Set(turnIds).size !== turnIds.length) throw new Error(`Codex 回滚映射 ${label} 包含重复 turnId`);
  return turnIds;
}

/** 将 turnId 序列格式化为稳定的错误上下文。 */
function formatCodexTurnIds(turnIds: readonly string[]): string {
  return JSON.stringify(turnIds);
}

/** 识别 app-server 已移除或不支持 deprecated thread/rollback 的明确错误。 */
function isCodexRollbackUnsupportedError(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const code = String(record?.code ?? "").trim();
  if (code === "-32601") return true;
  const message = (error instanceof Error ? error.message : String(error ?? "")).trim().toLowerCase();
  if (!message) return false;
  if (message.includes("method not found") || message.includes("unknown method")) return true;
  const mentionsRollback = message.includes("thread/rollback") || message.includes("thread rollback");
  return mentionsRollback
    && (message.includes("unsupported") || message.includes("not supported") || message.includes("removed"));
}

/** 构造 provider 明确不支持历史回退的错误；method-not-found 可确认未发生 mutation。 */
function buildCodexRollbackUnsupportedError(sessionId: SessionId, numTurns: number, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return Object.assign(
    new Error(`Codex app-server 不支持 thread/rollback（threadId=${sessionId}, numTurns=${numTurns}）：${detail}`, { cause }),
    {
      code: "codex_thread_rollback_unsupported",
      method: "thread/rollback",
    },
  );
}

/** 构造 provider 回退结果未获权威确认的错误，供上层避免反向补偿文件。 */
function buildCodexRollbackMutationUnknownError(
  sessionId: SessionId,
  numTurns: number,
  expectedTurnIds: readonly string[],
  actualTurnIds: readonly string[] | null,
  cause: unknown,
): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return Object.assign(
    new Error(
      `Codex thread/rollback 后权威状态未确认（threadId=${sessionId}, numTurns=${numTurns}, expected=${formatCodexTurnIds(expectedTurnIds)}, actual=${actualTurnIds ? formatCodexTurnIds(actualTurnIds) : "unknown"}）：${detail}`,
      { cause },
    ),
    {
      code: "codex_thread_rollback_state_unknown",
      method: "thread/rollback",
      providerMutationMayHaveApplied: true,
    },
  );
}

/** 在 rollback 回读之间短暂让出，等待 provider 的持久化历史可见。 */
async function waitForCodexRollbackReconcileRetry(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
}

/** 等待本地 active promise 收口；超时必须保留 session binding 供重试。 */
async function waitForCodexDisposeSettlement(
  settlement: Promise<void>,
  timeoutMs: number,
  threadId: string,
  turnId: TurnId,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      settlement,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Codex dispose 等待 active turn 收口超时：threadId=${threadId}, turnId=${turnId}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 缺少显式 settlement 时轮询回合状态；中断确认后给 provider 有界时间收口。 */
async function waitForCodexTurnInactive(
  isActive: () => boolean,
  timeoutMs: number,
  threadId: string,
  turnId: TurnId,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isActive()) {
    if (Date.now() >= deadline) {
      throw new Error(`Codex dispose 等待 active turn 收口超时：threadId=${threadId}, turnId=${turnId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 创建可等待且可按 user message ID 验证 provider 所有权的启动态。 */
function createStartingTurn(clientTurnId: TurnId, clientUserMessageId: string | null): StartingTurn {
  let settle!: () => void;
  let resolveInterruptFinalized!: () => void;
  let signalStartRequestDispatched!: () => void;
  let signalPreflightInterrupt!: () => void;
  let signalProviderOwnership!: () => void;
  let acknowledgeStartupInterrupt!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const interruptFinalized = new Promise<void>((resolve) => {
    resolveInterruptFinalized = resolve;
  });
  const startRequestDispatched = new Promise<void>((resolve) => {
    signalStartRequestDispatched = resolve;
  });
  const preflightInterruptSignal = new Promise<void>((resolve) => {
    signalPreflightInterrupt = resolve;
  });
  const providerOwnershipSignal = new Promise<void>((resolve) => {
    signalProviderOwnership = resolve;
  });
  const startupInterruptAcknowledgedSignal = new Promise<void>((resolve) => {
    acknowledgeStartupInterrupt = resolve;
  });
  return {
    clientTurnId,
    clientUserMessageId: String(clientUserMessageId ?? "").trim(),
    preparedInputActions: null,
    preparedInputActionsConsumed: false,
    preparedWorkspace: null,
    interruptRequested: false,
    interruptPromise: null,
    createdProviderThreadId: null,
    providerThreadId: null,
    providerTurnId: null,
    providerLifecycleTurnId: null,
    providerStartedTurnKeys: new Set(),
    providerStartedTurnIdsSeen: new Set(),
    providerStartEvidenceTurnId: null,
    providerStartEvidenceAttemptId: null,
    providerObservedTurnId: null,
    startRequestSent: false,
    startRequestAttemptSequence: 0,
    pendingStartRequestAttemptId: null,
    lastStartRequestAttemptId: null,
    persistedStartAttemptId: null,
    persistedStartAttemptProviderTurnId: null,
    startRequestDispatched,
    signalStartRequestDispatched,
    preflightInterruptSignal,
    signalPreflightInterrupt,
    providerOwnershipSignal,
    signalProviderOwnership,
    startupInterruptAcknowledged: false,
    startupInterruptAcknowledgedSignal,
    acknowledgeStartupInterrupt,
    startError: null,
    providerOwnershipConflict: null,
    lateSettlement: null,
    lateSettlementResult: null,
    releaseLateSettlement: null,
    lateSettlementReleased: false,
    reconcileRequested: false,
    reconcileRetryScheduled: false,
    reconcileRetryPending: false,
    compensatedProviderTurnIds: new Set(),
    terminalHintProviderTurnIds: new Set(),
    terminalThreadHintSeen: false,
    terminalEvidenceVersion: 0,
    handoffTerminalReconcile: null,
    handoffTerminalSettled: false,
    ownershipRecoveryPromise: null,
    ownershipRecoveryTimer: null,
    ownershipRecoveryExpiryTimer: null,
    ownershipRecoveryExhausted: false,
    ownershipRecoveryRescanRequested: false,
    ownershipRecoveryRetryAt: 0,
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: 0,
    onProviderTurnRecovered: null,
    interruptFinalized,
    resolveInterruptFinalized,
    settled,
    settle,
  };
}

/** 提取 provider turn 的明确终态；瞬态重连错误不算终态。 */
function extractCodexTerminalProviderStatus(
  method: string,
  params: Record<string, unknown> | undefined,
): string | null {
  if (isCodexSyntheticTransportFault(method, params)) return null;
  if (method === "turn/completed") {
    const status = normalizeCodexTurnStatus((params as any)?.turn?.status ?? (params as any)?.status) || "completed";
    return isTerminalCodexTurnStatus(status) ? status : null;
  }
  if (method === "turn/error" || method === "error") {
    return extractTransientReconnectInfo(method, params) == null ? "error" : null;
  }
  if (method !== "turn/status/changed") return null;
  const status = normalizeCodexTurnStatus((params as any)?.status);
  return isTerminalCodexTurnStatus(status) ? status : null;
}

/** 识别 active 建立前到达、需要在 handoff 后权威对账的 provider 终态通知。 */
function isCodexTerminalProviderEvent(method: string, params: Record<string, unknown> | undefined): boolean {
  return extractCodexTerminalProviderStatus(method, params) != null;
}

/** 将 synthetic transport fault 转成显式失败，保留实际退出事实与请求上下文。 */
function createCodexSyntheticTransportFaultError(
  params: Record<string, unknown> | undefined,
  method: string,
): Error {
  const payload = ((params as any)?.error ?? {}) as Record<string, unknown>;
  return Object.assign(new Error(String(payload.message ?? "Codex app-server transport fault")), {
    code: String(payload.code ?? "codex_app_server_process_error").trim() || "codex_app_server_process_error",
    method,
    requestId: payload.requestId,
    processGeneration: payload.processGeneration,
    ...(payload.processExit ? { processExit: { ...payload.processExit as Record<string, unknown> } } : {}),
    requestOutcomeUnknown: true,
    terminationKind: "error" as const,
  });
}

/** Builds a typed pre-mutation Skill failure or the existing active-turn conflict. */
function createCodexSkillBindingError(
  message: string,
  code: "CODEX_SKILL_BINDING_INVALID" | "active_turn_conflict" = "CODEX_SKILL_BINDING_INVALID",
): Error {
  if (code === "active_turn_conflict") {
    return Object.assign(new Error(message), { code });
  }
  return Object.assign(new ThreadInputContractError(code, message), {
    terminationKind: "error" as const,
  });
}

/** Clones turn/start params and replaces every Skill path with its opaque binding id. */
export function buildCodexTurnStartTraceParams(
  params: Record<string, unknown>,
  prepared: PreparedCodexSkillInput,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
  if (!Array.isArray(clone.input)) return clone;
  const skillIdByNameAndPath = new Map(
    prepared.skills.map((skill) => [JSON.stringify([skill.name, skill.path]), skill.skillId]),
  );
  clone.input = clone.input.map((rawInput) => {
    if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return rawInput;
    const item = rawInput as Record<string, unknown>;
    if (item.type !== "skill") return item;
    const skillId = skillIdByNameAndPath.get(JSON.stringify([String(item.name ?? ""), String(item.path ?? "")]))
      ?? "unmatched";
    return { ...item, path: `[Codex Skill ${skillId}]` };
  });
  return clone;
}

/** turn/start 成功响应缺少 turn.id 时直接失败，不从历史或回显猜测绑定。 */
  function createCodexTurnStartMissingIdError(): Error {
    return Object.assign(new Error("Codex turn/start 返回缺少 turn.id"), {
      code: "codex_turn_start_response_missing_turn_id",
      method: "turn/start",
      terminationKind: "error" as const,
      preserveRunningState: true,
    });
  }

/** 判断 turn/start 是否已发出但 provider 结果仍未知。 */
function isUncertainTurnStartError(error: unknown, startingTurn: StartingTurn): boolean {
  if (!startingTurn.startRequestSent || !error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code ?? "").trim();
  const method = String(record.method ?? "").trim();
  return method === "turn/start"
    && (
      code === "codex_app_server_request_timeout"
      || record.requestOutcomeUnknown === true
    );
}

/** 仅把 provider 对 turn/start 的明确 RPC 拒绝视为“mutation 未开始”。 */
function isExplicitCodexTurnStartRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.rpcError === true && String(record.method ?? "").trim() === "turn/start";
}

/** 判断 turn/steer 是否已写出但结果仍可能迟到。 */
function isUncertainTurnSteerError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return String(record.method ?? "").trim() === "turn/steer"
    && (
      String(record.code ?? "").trim() === "codex_app_server_request_timeout"
      || record.requestOutcomeUnknown === true
    );
}

/** 判断 compact/start 已写出但 provider 结果未知，禁止据此提前释放本地 active。 */
function isUncertainCompactStartError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return String(record.method ?? "").trim() === "thread/compact/start"
    && (
      String(record.code ?? "").trim() === "codex_app_server_request_timeout"
      || record.requestOutcomeUnknown === true
    );
}

/** 读取 Workspace 附在 timeout error 上的迟到结算 Promise。 */
function extractCodexLateSettlement(error: unknown): Promise<CodexAppServerLateSettlement> | null {
  if (!error || typeof error !== "object") return null;
  const lateSettlement = (error as Record<string, unknown>).lateSettlement;
  return lateSettlement && typeof (lateSettlement as Promise<unknown>).then === "function"
    ? (lateSettlement as Promise<CodexAppServerLateSettlement>)
    : null;
}

/** 读取迟到结算追踪的释放函数，仅在 provider 已权威收口后调用。 */
function extractCodexLateSettlementRelease(error: unknown): (() => void) | null {
  if (!error || typeof error !== "object") return null;
  const release = (error as Record<string, unknown>).releaseLateSettlement;
  return typeof release === "function" ? (release as () => void) : null;
}

/** 将底层 timeout 的迟到结算句柄转移到包装错误，避免恢复层丢失真实响应关联。 */
function copyCodexLateSettlementMetadata(target: Error, source: unknown): void {
  const lateSettlement = extractCodexLateSettlement(source);
  if (!lateSettlement) return;
  const targetRecord = target as Error & {
    lateSettlement?: Promise<CodexAppServerLateSettlement>;
    releaseLateSettlement?: () => void;
    requestId?: number;
    processGeneration?: number;
  };
  targetRecord.lateSettlement = lateSettlement;
  const release = extractCodexLateSettlementRelease(source);
  if (release) targetRecord.releaseLateSettlement = release;
  const sourceRecord = source as Record<string, unknown>;
  if (typeof sourceRecord.requestId === "number") targetRecord.requestId = sourceRecord.requestId;
  if (typeof sourceRecord.processGeneration === "number") {
    targetRecord.processGeneration = sourceRecord.processGeneration;
  }
}

/** 识别资源失败，避免provider终态翻译把清理错误改成成功或手动中断。 */
function isCodexImageCleanupError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "codex_image_cleanup_failed" || code === "codex_image_cleanup_pending";
}

/** pending只表示provider仍可能使用图片，不替代已发生的操作失败。 */
function isCodexImageCleanupPending(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "codex_image_cleanup_pending";
}

/** 清理失败保留操作原对象和释放错误，禁止finally覆盖前因。 */
function combineCodexImageCleanupError(operationError: unknown, cleanupError: Error): Error {
  if (operationError === cleanupError) return cleanupError;
  return Object.assign(new AggregateError([operationError, cleanupError], cleanupError.message, { cause: operationError }), {
    code: (cleanupError as Error & { code?: string }).code,
    requestId: (cleanupError as Error & { requestId?: string }).requestId,
    ...((operationError as { preserveRunningState?: boolean } | null)?.preserveRunningState === true ? { preserveRunningState: true } : {}),
  });
}

/** 图片只在调用和真实请求均结束后释放；detached结算保存错误，原会话负责传播。 */
function createCodexProviderInputImageLease(
  cleanup: (reason?: string) => void,
  pendingError: Error,
  onReleased: () => void,
  context: { requestId: string; workspaceId: WorkspaceId; threadId: string; clientTurnId: TurnId; writeWorkspaceLog: EngineWorkspaceLogWriter },
): CodexProviderInputImageLease {
  const { writeWorkspaceLog, ...logContext } = context;
  let closed = false;
  let cleaned = false;
  let cleanupError: Error | null = null;
  let pendingReported = false;
  let pendingLogError: Error | null = null;
  let pendingRequests = 0;
  let cleanupReason = "provider_request_settled";
  const cleanupIfSettled = (): void => {
    if (!closed || cleaned || pendingRequests > 0) return;
    cleaned = true;
    try { cleanup(cleanupReason); }
    catch (error) {
      cleanupError = error instanceof Error ? error : Object.assign(new Error("Codex 图片清理失败", { cause: error }), { code: "codex_image_cleanup_failed" });
      return;
    }
    onReleased();
  };
  const settleRequest = (): void => {
    pendingRequests = Math.max(0, pendingRequests - 1);
    cleanupIfSettled();
  };
  return {
    trackRequest(request) {
      pendingRequests += 1;
      void request.then(
        settleRequest,
        (error) => {
          const lateSettlement = extractCodexLateSettlement(error);
          if (!lateSettlement) {
            settleRequest();
            return;
          }
          void lateSettlement.then(settleRequest, settleRequest);
        },
      );
    },
    close(reason) {
      closed = true;
      cleanupReason = reason;
      cleanupIfSettled();
    },
    getError() {
      if (cleanupError) return cleanupError;
      if (!closed || cleaned) return null;
      if (!pendingReported) {
        pendingReported = true;
        try {
          writeEngineWorkspaceLog(writeWorkspaceLog, context.workspaceId, () => ({ level: "error", tag: "codex-image-input",
            message: "Codex image cleanup waits for provider settlement", data: {
            ...logContext, code: "codex_image_cleanup_pending", errorCode: "codex_image_cleanup_pending",
            event: { category: "engine", action: "image_cleanup", outcome: "fail" },
            rootCause: { code: "provider_request_unsettled" }, retryable: false,
          } }));
        } catch (error) { pendingLogError = combineCodexImageCleanupError(error, pendingError); }
      }
      return pendingLogError ?? pendingError;
    },
  };
}

/** 构造启动未知态的中断对账错误，并要求上层保留 running。 */
function buildCodexStartInterruptReconcileError(
  sessionId: string,
  clientTurnId: TurnId,
  providerTurnId: string | null,
  cause: unknown,
): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `Codex turn/start 超时后的中断对账失败（threadId=${sessionId}, clientTurnId=${clientTurnId}, providerTurnId=${providerTurnId ?? "unknown"}）：${detail}`,
    { cause },
  ) as Error & { code?: string; preserveRunningState?: boolean };
  error.code = "codex_turn_start_state_unknown";
  error.preserveRunningState = true;
  return error;
}

/** 构造 startup interrupt 失败并要求上层保留 running，避免取消结果未知时开放下一轮。 */
function buildCodexStartupInterruptError(
  sessionId: string,
  clientTurnId: TurnId,
  cause: unknown,
): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `Codex startup interrupt 失败（threadId=${sessionId}, clientTurnId=${clientTurnId}）：${detail}`,
    { cause },
  ) as Error & { code?: string; preserveRunningState?: boolean };
  error.code = "codex_turn_startup_interrupt_failed";
  error.preserveRunningState = true;
  return error;
}

/** 构造 active handoff 终态对账失败，并保留 provider/client turn 上下文。 */
function buildCodexHandoffTerminalReconcileError(
  sessionId: SessionId,
  clientTurnId: TurnId,
  responseProviderTurnId: string | null,
  cause: unknown,
): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `Codex active handoff 终态对账失败（threadId=${sessionId}, clientTurnId=${clientTurnId}, providerTurnId=${responseProviderTurnId ?? "unknown"}）：${detail}`,
    { cause },
  ) as Error & { code?: string };
  error.code = "codex_turn_handoff_terminal_reconcile_failed";
  return error;
}

/** 构造 provider 中断结果未知错误，要求上层继续保留 running。 */
function buildCodexActiveInterruptStateUnknownError(
  sessionId: string,
  clientTurnId: TurnId,
  providerTurnId: string | null,
  cause: unknown,
): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `Codex turn 中断后的终态确认失败（threadId=${sessionId}, clientTurnId=${clientTurnId}, providerTurnId=${providerTurnId ?? "unknown"}）：${detail}`,
    { cause },
  ) as Error & { code?: string; preserveRunningState?: boolean };
  error.code = "codex_turn_interrupt_state_unknown";
  error.preserveRunningState = true;
  return error;
}

/** 构造 detached 精确中断结果未知错误；后台保留 tombstone 等待重试或终态事件。 */
function buildCodexDetachedInterruptStateUnknownError(
  sessionId: SessionId,
  providerTurnId: string,
  cause: unknown,
): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return Object.assign(new Error(
    `Codex detached turn 精确中断未确认（threadId=${sessionId}, turnId=${providerTurnId}）：${detail}`,
    { cause },
  ), {
    code: "codex_detached_turn_interrupt_state_unknown",
    preserveRunningState: true,
  });
}

/** 构造 compact 前 provider 非 idle 错误，禁止向已有 Goal 发送 compact 或 interrupt。 */
function buildCodexCompactProviderBusyError(input: {
  sessionId: SessionId;
  threadStatus: string;
  runningTurnIds: string[];
}): Error {
  return Object.assign(new Error(
    `Codex compact 前 provider thread 非 idle（threadId=${input.sessionId}, threadStatus=${input.threadStatus || "missing"}, runningTurnIds=${formatCodexTurnIds(input.runningTurnIds)}）`,
  ), {
    code: "codex_compact_provider_busy",
    preserveRunningState: false,
  });
}

/** 构造 compact 专用证据不足错误；保留 running，绝不追停 foreign turn。 */
function buildCodexCompactOwnershipUnconfirmedError(input: {
  sessionId: SessionId;
  clientTurnId: TurnId;
  candidateTurnIds: string[];
  cause: unknown;
}): Error {
  const detail = input.cause instanceof Error ? input.cause.message : String(input.cause);
  return Object.assign(new Error(
    `Codex compact provider turn 归属无法确认（threadId=${input.sessionId}, clientTurnId=${input.clientTurnId}, candidateTurnIds=${formatCodexTurnIds(input.candidateTurnIds)}）：${detail}`,
    { cause: input.cause },
  ), {
    code: "codex_compact_ownership_unconfirmed",
    preserveRunningState: true,
  });
}

/** 构造 provider turn 反向映射冲突，禁止把迟到事件重绑到新本地 turn。 */
function buildCodexProviderTurnBindingConflictError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), {
    code: "codex_provider_turn_binding_conflict",
    preserveRunningState: true,
  });
}

/** 构造 clientId 命中多个本地或 provider turn 的不可猜测归属错误。 */
function buildCodexTurnOwnershipAmbiguousError(input: {
  sessionId: string;
  clientTurnId: TurnId;
  clientUserMessageId: string;
  providerTurnIds: string[];
  localCandidateTurnIds?: TurnId[];
}): Error {
  return Object.assign(new Error(
    `Codex turn 归属不唯一（threadId=${input.sessionId}, clientTurnId=${input.clientTurnId}, clientUserMessageId=${input.clientUserMessageId}, providerTurnIds=${formatCodexTurnIds(input.providerTurnIds)}, localCandidateTurnIds=${formatCodexTurnIds(input.localCandidateTurnIds ?? [])}）`,
  ), {
    code: "codex_turn_ownership_ambiguous",
    preserveRunningState: true,
  });
}

/** 构造 ownership 分页未完整覆盖或证据结构非法时的显式隔离错误。 */
function buildCodexTurnOwnershipScanIncompleteError(input: {
  sessionId: string;
  clientTurnId: TurnId;
  clientUserMessageId: string;
  cause?: Error;
}): Error {
  const detail = input.cause
    ? `扫描证据不完整：${input.cause.message}`
    : `pages=${CODEX_OWNERSHIP_RECOVERY_MAX_PAGES}, pageSize=${CODEX_OWNERSHIP_RECOVERY_TURN_LIMIT}`;
  return Object.assign(new Error(
    `Codex turn 归属扫描未完整完成（threadId=${input.sessionId}, clientTurnId=${input.clientTurnId}, clientUserMessageId=${input.clientUserMessageId}, ${detail}）：已隔离该 provider generation，拒绝继续重复扫描或猜测归属。`,
  ), {
    code: "codex_turn_ownership_scan_incomplete",
    preserveRunningState: true,
  });
}

/** 构造当前 generation 在限定窗口内未回显本地 clientId 的终态错误。 */
function buildCodexTurnOwnershipUnmaterializedError(input: {
  sessionId: string;
  clientTurnId: TurnId;
  clientUserMessageId: string;
  provisionalProviderTurnId: string | null;
}): Error {
  return Object.assign(new Error(
    `Codex turn 未在 provider 历史中物化（threadId=${input.sessionId}, clientTurnId=${input.clientTurnId}, clientUserMessageId=${input.clientUserMessageId}, provisionalProviderTurnId=${input.provisionalProviderTurnId ?? "missing"}）`,
  ), {
    code: "codex_turn_ownership_unmaterialized",
    preserveRunningState: true,
  });
}

/** 构造 steer clientId 在异常历史恢复中仍未找到的显式失败。 */
function buildCodexSteerOwnershipLostError(input: {
  sessionId: string;
  clientTurnId: TurnId;
  clientUserMessageId: string;
  cause: unknown;
}): Error {
  const detail = input.cause instanceof Error ? input.cause.message : String(input.cause);
  return Object.assign(new Error(
    `Codex steer 归属确认失败（threadId=${input.sessionId}, clientTurnId=${input.clientTurnId}, clientUserMessageId=${input.clientUserMessageId}）：${detail}`,
    { cause: input.cause },
  ), {
    code: "codex_steer_ownership_lost",
    preserveRunningState: true,
  });
}

/** 判断错误是否带有 provider 的 thread/rollout 不可用信号。 */
function hasCodexThreadUnavailableSignal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  return normalized.includes("thread not found") || normalized.includes("no rollout found");
}

/** 在中断确认轮询间短暂让出，等待 provider 写入最终 turn 状态。 */
async function waitForCodexInterruptReconcileRetry(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
}

function cloneCodexFinalError(error: Error): Error {
  const cloned = new Error(String(error.message ?? ""));
  const source = error as unknown as Record<string, unknown>;
  const target = cloned as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(error)) {
    target[key] = source[key];
  }
  return cloned;
}

function buildCodexTurnTerminalMessage(status: string, reason: string): string {
  const normalizedReason = String(reason ?? "").trim();
  if (normalizedReason) return `Codex turn ended as ${status} (${normalizedReason})`;
  return `Codex turn ended as ${status}`;
}

function createManualInterruptError(): Error {
  const error = new Error("turn interrupted") as Error & {
    code?: string;
    terminationKind?: "manual_interrupt";
  };
  error.code = MANUAL_TURN_INTERRUPT_CODE;
  error.terminationKind = "manual_interrupt";
  return error;
}

function buildCodexTurnTerminalError(active: ActiveTurn | null, status: string, reason: string): Error {
  if (active?.manualInterruptRequested && (status === "interrupted" || status === "cancelled")) {
    return active.manualInterruptError ?? createManualInterruptError();
  }
  return new Error(buildCodexTurnTerminalMessage(status, reason));
}

/** 构造带 provider turn 上下文的空闲超时对账错误。 */
function buildCodexIdleTimeoutReconcileError(sessionId: SessionId, turnId: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`Codex 空闲超时后 thread/read 状态对账失败（threadId=${sessionId}, turnId=${turnId}）：${detail}`, {
    cause,
  });
}

/** 将 RPC Error 转为可安全导出的短诊断字段。 */
function buildCodexTimeoutReconcileErrorDetail(cause: unknown): CodexTimeoutReconcileErrorDetail {
  const record = cause && typeof cause === "object" ? (cause as Record<string, unknown>) : null;
  const requestId = record?.requestId == null ? null : Number(record.requestId);
  const processGeneration = record?.processGeneration == null ? null : Number(record.processGeneration);
  return {
    name: cause instanceof Error ? cause.name : "Error",
    code: record?.code == null ? null : String(record.code),
    message: cause instanceof Error ? cause.message : String(cause),
    method: record?.method == null ? null : String(record.method),
    requestId: requestId != null && Number.isFinite(requestId) ? requestId : null,
    processGeneration: processGeneration != null && Number.isFinite(processGeneration) ? processGeneration : null,
  };
}

function buildCodexEngineServiceId(processId: string): string {
  return `engine:codex:${processId}`;
}

function appendCodexCommandOutputTail(previous: string, delta: string, maxChars = 4096): string {
  const combined = `${String(previous ?? "")}${String(delta ?? "")}`;
  if (combined.length <= maxChars) return combined;
  return combined.slice(-maxChars);
}

function extractCodexManagedProcessIdFromOutput(text: string): string | null {
  const match = /Process running with session ID ([^\s]+)/i.exec(String(text ?? ""));
  const processId = String(match?.[1] ?? "").trim();
  return processId || null;
}

function formatCodexEngineDisplayName(processId: string): string {
  const normalized = String(processId ?? "").trim();
  if (!normalized) return "后台命令";
  const shortId = normalized.length > 12 ? normalized.slice(-12) : normalized;
  return `后台命令 ${shortId}`;
}

function parseManagedProcessPid(processId: string): number | null {
  const normalized = String(processId ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const pid = Number(normalized);
  return Number.isFinite(pid) ? pid : null;
}

function normalizeCodexCommandExecutionStatus(status: string): "exited" | "stopped" {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "cancelled" || normalized === "interrupted" || normalized === "stopped") return "stopped";
  return "exited";
}

function buildCodexCommandExecutionSummary(
  status: "exited" | "stopped",
  exitCode: number | null,
  durationMs: number | null,
): string {
  const parts: string[] = [status === "stopped" ? "已停止" : "已退出"];
  if (exitCode != null) parts.push(`exit ${exitCode}`);
  if (durationMs != null && Number.isFinite(durationMs) && durationMs > 0) {
    parts.push(`${Math.round(durationMs)}ms`);
  }
  return parts.join(" · ");
}

function terminateManagedProcess(pid: number): void {
  process.kill(pid, "SIGTERM");
}

function isProcessMissingError(error: unknown): boolean {
  const code = typeof (error as { code?: unknown } | null)?.code === "string"
    ? String((error as { code: string }).code)
    : "";
  return code === "ESRCH";
}

function buildCodexDynamicToolResponse(result: HostToolExecutionResult): {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
} {
  const payload = result.ok
    ? {
        ok: true,
        output: result.output,
        durationMs: result.durationMs ?? null,
      }
    : {
        ok: false,
        code: result.code ?? null,
        message: result.message,
        output: result.output ?? null,
        durationMs: result.durationMs ?? null,
      };
  return {
    contentItems: [{
      type: "inputText",
      text: JSON.stringify(payload, null, 2),
    }],
    success: result.ok,
  };
}

/** 汇总原生工具权限、结构化提问及当前平台的执行约束。 */
export function buildCodexDeveloperInstructions(input: {
  accessMode: AccessMode;
  providerNativeToolPolicy: ProviderNativeToolPolicy;
  responseFormat: SendMessageInput["responseFormat"];
  platform?: NodeJS.Platform;
}): string | null {
  const blocks: string[] = [];
  if (input.accessMode === "read-only") {
    blocks.push("当前为只读模式：禁止创建/修改/删除文件或执行任何写操作；如需修改请先请求用户切换访问模式。");
  }
  if (input.providerNativeToolPolicy === "deny") {
    blocks.push([
      "本轮禁止调用任何 Codex 原生工具。",
      "严禁使用 commandExecution、fileChange、requestUserInput 或其他工具型能力。",
      input.responseFormat === "json"
        ? "请仅基于当前提供的上下文直接输出一个纯 JSON 结果，不要附加解释、不要输出 Markdown 代码块。"
        : "请仅基于当前提供的上下文直接完成回复，不要先调用工具。",
    ].join(" "));
  } else if (input.providerNativeToolPolicy === "interactive-only") {
    blocks.push([
      "本轮仅允许使用交互型 Codex 原生工具。",
      "如果信息不足，可使用 requestUserInput 或 requestApproval；严禁使用 commandExecution、fileChange 或其他非交互工具。",
      input.responseFormat === "json"
        ? "在拿到补充信息后，请最终输出一个纯 JSON 结果，不要附加解释、不要输出 Markdown 代码块。"
        : "在拿到补充信息后，请直接完成回复。",
    ].join(" "));
  }
  if (input.providerNativeToolPolicy !== "deny") {
    blocks.push([
      "如果缺少的信息会实质影响需求、方案、执行范围或数据变更，且无法根据上下文合理判断，必须暂停并调用 request_user_input，通过补充输入弹框展示简短选项并允许用户补充；不要只在普通回复中列出编号选项或写“请确认”。",
      "上下文已明确或可以安全继续时自主处理，不要为常规细节提问。",
    ].join(" "));
  }
  if (input.providerNativeToolPolicy === "allow" && (input.platform ?? process.platform) === "win32") {
    blocks.push([
      "Windows 命令执行约束（以环境指定的 shell 为准）：",
      "PowerShell 5.1 向原生程序传参可能丢失内嵌引号，复杂 Node/Python 脚本避免多层 node -e/python -c，优先通过标准输入传递。管道传递含中文的脚本前，显式设置 $OutputEncoding = [System.Text.UTF8Encoding]::new($false)，避免默认 ASCII 编码破坏脚本。",
      "读取文件前先用 rg --files 等确认实际路径；查规范须包含项目根 AGENTS.md，局部目录无匹配不能推断项目没有规范。依赖脚本在声明该依赖的子包目录运行。",
      "使用 PowerShell 时，不会为原生程序展开路径通配符或 Bash 花括号。rg 须传真实目录，文件模式使用 -g：如 rg --files apps/web/tests -g 'chat-composer*'，不要传 apps/web/tests/chat-composer* 或 knowledge-{a,b}.vue。",
      "不要用原生命令 | Select-Object -First N 提前关闭管道；优先使用工具自身的限量参数，或完整接收输出后再截取，并核对真实退出码。",
      "PowerShell 执行脚本先设置 $ErrorActionPreference = 'Stop'，避免 cmdlet 非终止错误后仍执行后续步骤。该设置不能替代原生程序的退出码检查；原生程序执行后立即保存并按语义校验 $LASTEXITCODE，异常时 exit 原退出码，停止依赖它的后续操作。",
      "rg 退出码 0 表示匹配、1 表示无匹配、2 表示执行错误；git diff --no-index 检测到差异也会非零退出。按具体命令语义说明结果，不得统一将退出码 1 改为成功、吞掉异常或盲目重试。独立查询分开调用，避免分号串联只保留最后一个退出码；PowerShell 执行原生命令后立即核对 $LASTEXITCODE。",
      "路径报错先按已枚举的真实路径修正；测试失败先读失败断言；测试端口被占用先核对所属进程，勿重复启动同一套测试服务。",
    ].join("\n"));
  }
  return blocks.length ? blocks.join("\n\n") : null;
}

function mergePromptBlocks(blocks: Array<string | null | undefined>): string | null {
  const parts = blocks
    .map((block) => String(block ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}
