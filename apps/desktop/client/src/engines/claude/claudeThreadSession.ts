import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { types } from "node:util";

import { getDefaultEngineProviderId, getEngineProviderLabel, isEngineProviderAllowed, MANUAL_TURN_INTERRUPT_CODE, PRODUCT_DEFAULT_AUTO_COMPACT_PCT, resolveLegacyEffectiveInputKind, type AccessMode, type ConversationEventInput, type EngineCallTrace, type EngineModelProviderId, type ExecutableToolRegistry, type ManagedServiceSnapshot, type RawEngineEventInput, type RequestUserInputResponse, type SessionId, type TurnId, type WorkspaceId } from "@codeflowai/shared";

import type {
  AppendTurnInput,
  AppendTurnResult,
  ConversationEmitFn,
  ConversationProfile,
  PlatformToolTransportRequirement,
  ProviderNativeToolPolicy,
  SendMessageInput,
  ThreadEngineSession,
  ThreadEventEmitters,
  ThreadInterruptOptions,
} from "../threadSession.js";
import { ActiveTurnInputClosedError, ThreadEventFlushError, withThreadEventFlush } from "../threadSession.js";
import { createEngineWorkspaceLogFailure, engineDiagnosticCause, isEngineWorkspaceLogFailure, writeEngineWorkspaceLog, type EngineWorkspaceLogWriter } from "../threadSession.js";
import { readEngineConfig, type EngineCredentialConfig } from "../../enginesConfig.js";
import { buildClientChildProcessEnv } from "../../runtime/clientProcessEnv.js";
import { SessionInvalidatedError } from "../sessionInvalidatedError.js";
import {
  AssistantLifecycleTracker,
  buildAssistantCompletedEvent,
} from "../assistantLifecycle.js";
import { buildClaudeArgs, buildSingleModelProviderRuntimeEnv, CLAUDE_FIXED_PROMPT_CACHING_ENV, resolveClaudeCli, resolveClaudeLaunchModelId, resolveClaudeModelRuntimeEnv, resolveClaudeModelSettingsEnv, shouldClaudeForceSandboxEnv } from "./claudeCli.js";
import {
  acquireEngineModelCatalogDispatchLease,
  assertRuntimeEngineModelAvailable,
  resolveRuntimeEngineModelProviderId,
} from "../engineModelCatalogRuntime.js";
import {
  buildClaudeApprovalDescriptor,
  buildClaudeApprovalResponse,
  isExitPlanModeTool,
  isAskUserQuestionTool,
  isInteractiveControlTool,
  resolveClaudeControlMode,
  type ClaudeControlMode,
} from "./claudeApproval.js";
import {
  createClaudePlatformToolBridge,
  isClaudePlatformToolName,
  type ClaudePlatformToolBridge,
} from "./claudePlatformTools.js";
import { maybeExtractSessionId, safeJson } from "./claudeJson.js";
import {
  createClaudeRequiredSkillGate,
  finalizeClaudeRequiredSkillGate,
  inspectClaudeRequiredSkillEvent,
  type ClaudeRequiredSkillError,
} from "./claudeRequiredSkills.js";
import { createToolState, type ToolState } from "./claudeTools.js";
import { ClaudeStdinLifecycle } from "./claudeStdinLifecycle.js";
import { applyClaudeStreamLine, createClaudeStreamProcessorState, emitClaudeAssistantText, type ClaudeStreamProcessorState } from "./claudeStreamProcessor.js";
import { ALL_KNOWN_STDOUT_TYPES } from "./claudeStreamTypes.js";
import { buildClaudeStreamJsonInput } from "./claudeStreamJsonInput.js";
import {
  createClaudeProviderSlashResultError,
  extractSafeClaudeSlashCommandName,
  inspectClaudeProviderSlashFinalResult,
  parseClaudeInputActionCatalog,
  type ClaudeInputActionCatalogSnapshot,
  type ClaudeProviderSlashFinalResult,
} from "./claudeInputActions.js";
import { EngineTimeoutError, normalizeTurnTimeoutPolicy, TurnTimeoutController } from "../turnTimeoutController.js";
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
import type { ClaudeBackgroundShellTaskMeta } from "./claudeTools.js";
import { terminateCliProcessTree } from "../../app/handlers/engineHandlers.js";

const claudeStdoutDrains = new Set<(deadline: number) => void>();
let claudeStdoutImmediate: NodeJS.Immediate | undefined;
let claudeStdoutDraining = false;

/** 所有 session 共用每 tick 8ms；未处理的 owner 优先于刚让出的 owner。 */
function drainClaudeStdout(): void {
  claudeStdoutImmediate = undefined;
  claudeStdoutDraining = true;
  const deadline = performance.now() + 8;
  try {
    for (const drain of [...claudeStdoutDrains]) {
      if (!claudeStdoutDrains.delete(drain)) continue;
      drain(deadline);
      if (performance.now() >= deadline) break;
    }
  } finally {
    claudeStdoutDraining = false;
    if (claudeStdoutDrains.size) claudeStdoutImmediate = setImmediate(drainClaudeStdout);
  }
}

/** 合并待执行 owner；每个 session 在一个 tick 内最多执行一次。 */
function scheduleClaudeStdoutDrain(drain: (deadline: number) => void): void {
  claudeStdoutDrains.add(drain);
  if (!claudeStdoutImmediate && !claudeStdoutDraining) claudeStdoutImmediate = setImmediate(drainClaudeStdout);
}

/** 失败只撤销原 owner，队列清空时同时释放共享调度句柄。 */
function cancelClaudeStdoutDrain(drain: (deadline: number) => void): void {
  claudeStdoutDrains.delete(drain);
  if (!claudeStdoutDrains.size && claudeStdoutImmediate) {
    clearImmediate(claudeStdoutImmediate);
    claudeStdoutImmediate = undefined;
  }
}

type ActiveTurn = {
  turnId: TurnId;
  child: ChildProcessWithoutNullStreams;
  stdinLifecycle: ClaudeStdinLifecycle;
  sharedWorkspaceToolContext: SharedWorkspaceToolExecutionContext | null;
  manualInterruptRequested: boolean;
  manualInterruptError: (Error & { code?: string; terminationKind?: "manual_interrupt" }) | null;
  killReason: ClaudeKillReason | null;
  failed: boolean;
  fail: (error: unknown) => void;
  drainStdout: () => Promise<void>;
};

type ClaudeKillReason =
  | "dispose"
  | "manual_interrupt"
  | "platform_tool_fatal"
  | "required_skill_unavailable"
  | "startup_timeout"
  | "turn_timeout";

type ClaudeTempPromptFile = {
  readonly path: string | null;
  readonly requestId: string;
  readonly turnId: TurnId;
  readonly ready: Promise<{ ok: true } | { ok: false; error: unknown }>;
  prepare: () => void;
  bindChild: (child: ChildProcessWithoutNullStreams, facts: ClaudeChildFacts) => void;
  dispose: () => Promise<void>;
};

type ClaudeChildExit = { code: number | null; signal: NodeJS.Signals | null };
type ClaudeChildFacts = {
  readonly closed: boolean;
  readonly close: Promise<ClaudeChildExit>;
  readonly error: Promise<{ error: unknown }>;
  readonly first: Promise<{ kind: "close"; exit: ClaudeChildExit } | { kind: "error"; error: unknown }>;
};

type ClaudeSendBoundary = {
  turnId: TurnId;
  cancellation: ReturnType<typeof createClaudeManualInterruptError> | null;
  child: ChildProcessWithoutNullStreams | null;
  facts: ClaudeChildFacts | null;
  platformToolBridge: ClaudePlatformToolBridge | null;
  stopping: Promise<void> | null;
  stopFailed?: boolean;
  stopConfirmed?: boolean;
  settled: Promise<PromiseSettledResult<{ responseText: string }>>;
  result?: PromiseSettledResult<{ responseText: string }>;
};

const CLAUDE_INTERRUPT_GRACE_MS = 3_000;
const CLAUDE_INTERRUPT_FORCE_MS = 3_000;
const CLAUDE_CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const CLAUDE_LATE_CONTROL_RESPONSE_TTL_MS = 60_000;

/**
 * Claude CLI thread 会话：
 * - 每条消息 spawn 一次 `claude -p --output-format stream-json`
 * - 使用 `--resume <sessionId>` 续写上下文
 */
export class ClaudeThreadSession implements ThreadEngineSession {
  readonly engine = "claude" as const;

  private sessionId: SessionId | null;
  private active: ActiveTurn | null = null;
  private lifecycleToken = 0;
  private promptOwner: ClaudeTempPromptFile | null = null;
  private tool: ToolState = createToolState();
  private streamState: ClaudeStreamProcessorState | null = null;
  private emitters: ThreadEventEmitters | null = null;
  private readonly assistantLifecycle = new AssistantLifecycleTracker();
  private activeTurnSettled: Promise<void> | null = null;
  private sendBoundary: ClaudeSendBoundary | null = null;
  private callbackFailed = false;
  private credentialLease: import('../../security/builtInRelayCredentialService.js').EngineCredentialLease | undefined;
  private currentControlMode: ClaudeControlMode = "acceptEdits";
  private prePlanControlMode: ClaudeControlMode | null = null;
  private currentProviderNativeToolPolicy: ProviderNativeToolPolicy = "allow";
  private currentDeclaredAccessMode: AccessMode = "current";
  /** 当前回合真实派发的 profile；运行中模式切换必须沿用它，不能用线程类型猜测。 */
  private currentConversationProfile: ConversationProfile = "default";
  private currentPlatformToolNames = new Set<string>();
  private inputActionCatalog: ClaudeInputActionCatalogSnapshot | null = null;
  /** 等待 CLI 回执的 control_request；超时后短暂保留以校正迟到回执。 */
  private readonly pendingControlResponses = new Map<string, {
    resolve: (response: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    expired: boolean;
    onLateSuccess?: () => void;
    clearLate?: () => void;
  }>();
  /** 串行化运行中权限切换，避免并发请求以回执顺序覆盖用户最后一次选择。 */
  private permissionSwitchTail: Promise<void> = Promise.resolve();

  /** 会话错误沿已核工作区写入固定日志；失败向原 Promise 传播。 */
  private writeEngineLog(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown> | (() => Record<string, unknown>), business?: { reason: unknown }): void {
    try {
      writeEngineWorkspaceLog(this.opts.writeWorkspaceLog, this.opts.workspaceId, () => ({ level, tag: "claude", message,
        data: { threadId: this.opts.threadId, turnId: this.active?.turnId ?? null, ...(typeof data === "function" ? data() : data) } }), business);
    } catch (error) { throw isEngineWorkspaceLogFailure(error) ? error : createEngineWorkspaceLogFailure(error); }
  }

  constructor(
    private readonly opts: {
      workspacePath: string;
      writeWorkspaceLog: EngineWorkspaceLogWriter;
      workspaceId: WorkspaceId;
      threadId: string;
      initialSessionId: SessionId | null;
      onEngineProcessSnapshot: (snapshot: ManagedServiceSnapshot) => boolean;
      onSessionId: (sid: SessionId) => void;
      readProviderCredentials?: ClaudeCredentialReader;
      resolveModelProvider?: ClaudeModelProviderResolver;
      hasConfiguredProviderCredentials?: (providerId: EngineModelProviderId) => boolean;
      acquireCredential?: import('../threadSession.js').AcquireEngineCredential;
      withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
    },
  ) {
    this.sessionId = opts.initialSessionId;
  }

  /** 凭据和会话持久化在同步短段内准入，不占用进程等待时间。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    return this.opts.withLegacyDatabase ? this.opts.withLegacyDatabase(`claude-session:${this.opts.threadId}`, operation) : operation();
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

  /** 准备与收尾同属当前回合，不能因尚未登记进程而对外显示空闲。 */
  hasActiveTurn(): boolean {
    const boundary = this.sendBoundary;
    return Boolean(this.active || boundary && (!boundary.result || boundary.cancellation
      || boundary.result.status === "rejected" && boundary.result.reason instanceof ThreadEventFlushError));
  }

  /** stdin 已关闭或正在中断时，回合仍活跃但不能再接收追加输入。 */
  canAppendInput(): boolean {
    const active = this.active;
    return Boolean(active && !active.killReason && active.child.stdin?.writable
      && !active.child.stdin.writableEnded && !active.child.stdin.destroyed);
  }

  /** 返回准备或运行中的精确 turnId，供运行态索引缺失时仍可停止。 */
  getActiveTurnId(): TurnId | null {
    return this.active?.turnId ?? (this.hasActiveTurn() ? this.sendBoundary?.turnId ?? null : null);
  }

  /** 未释放的提示 owner 必须由显式关闭收尾，不能被 idle 扫描重试。 */
  canIdleDispose(): boolean {
    return !this.active && !this.promptOwner && !this.callbackFailed && !this.sendBoundary;
  }

  /** Returns the most recent valid system.init Slash catalog without starting a Claude process. */
  async listInputActions(trigger: "/" | "$") {
    if (trigger === "$") {
      return {
        engine: "claude" as const,
        actions: [],
        providerCatalog: { state: "ready" as const, observedAt: null },
      };
    }
    const snapshot = this.inputActionCatalog;
    if (!snapshot || snapshot.sessionId !== this.sessionId) {
      return {
        engine: "claude" as const,
        actions: [],
        providerCatalog: {
          state: "unavailable" as const,
          observedAt: null,
          message: "尚无会话目录",
        },
      };
    }
    return snapshot.response;
  }

  /** Claude 通过本轮临时 MCP bridge 承载平台工具，因此 required 工具链路可走 native-dynamic。 */
  resolvePlatformToolTransport(
    toolRegistry: ExecutableToolRegistry | null,
    _requirement: PlatformToolTransportRequirement = "optional",
  ): "protocol" | "native-dynamic" {
    if (!toolRegistry?.tools.length) return "native-dynamic";
    return "native-dynamic";
  }

  async prepareAssistantTerminalEvents(input: {
    turnId: TurnId;
    outcome: "completed" | "error";
  }): Promise<{ events: ConversationEventInput[]; latestAssistantText: string | null }> {
    const pending = this.assistantLifecycle.listPendingTerminalization(input.turnId);
    if (!pending.length) {
      return {
        events: [],
        latestAssistantText: this.assistantLifecycle.latestText(input.turnId),
      };
    }

    const events = pending.map((record) => {
      const nextRevision = record.revision + 1;
      this.assistantLifecycle.markCompleted({
        itemId: record.itemId,
        text: record.text,
        revision: nextRevision,
        phase: record.phase,
        completionSource: "runtime_close_reconcile",
      });
      return buildAssistantCompletedEvent({
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        engine: "claude",
        itemId: record.itemId,
        engineMessageId: record.engineMessageId,
        turnId: input.turnId,
        text: record.text,
        revision: nextRevision,
        phase: record.phase,
        completionSource: "runtime_close_reconcile",
      });
    });
    return {
      events,
      latestAssistantText: this.assistantLifecycle.latestText(input.turnId),
    };
  }

  async stopManagedService(): Promise<boolean> {
    return false;
  }

  /** 新人工操作复检账号资格，不改变已派发回合的 provider 请求。 */
  private assertNewOperationCredential(): void {
    if (this.credentialLease) { this.credentialLease.assertCurrent(); return; }
    const lease = this.opts.acquireCredential?.({});
    try { lease?.assertCurrent(); } finally { lease?.release(); }
  }

  /** 按所选模型获取派发租约，发送消息并将 Claude 输出映射为统一事件流。 */
  async sendMessage(input: SendMessageInput, emitters: ThreadEventEmitters): Promise<{ responseText: string }> {
    if (this.promptOwner) throw Object.assign(new Error("Claude 提示文件尚未释放，请显式关闭后重试"), { code: "CLAUDE_PROMPT_RELEASE_PENDING", retryable: false });
    if (this.callbackFailed || this.sendBoundary) throw new Error("Claude 回合尚未收口，请显式关闭后重试");
    if (this.credentialLease) throw new Error('当前 thread 有未完成的凭据回合');
    let credential: ReturnType<NonNullable<typeof this.opts.acquireCredential>> | undefined;
    const boundary: ClaudeSendBoundary = { turnId: input.turnId, cancellation: null, child: null, facts: null,
      platformToolBridge: null, stopping: null, settled: undefined! };
    this.sendBoundary = boundary;
    const work = Promise.resolve().then(async () => {
      try {
        credential = await this.withDatabase(() => this.opts.acquireCredential?.({ model: input.model, turnId: input.turnId }));
        this.credentialLease = credential;
        return await withThreadEventFlush(emitters, () => this.sendMessageWithCredential(input, emitters, boundary));
      }
      finally { if (this.credentialLease === credential) this.credentialLease = undefined; credential?.release(); }
    });
    boundary.settled = work.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
    const result = await boundary.settled;
    boundary.result = result;
    const cancellationFailed = boundary.cancellation && result.status === "rejected" && result.reason !== boundary.cancellation;
    const saveFailed = result.status === "rejected" && result.reason instanceof ThreadEventFlushError;
    if (!this.callbackFailed && !cancellationFailed && !saveFailed && !boundary.platformToolBridge && this.sendBoundary === boundary) this.sendBoundary = null;
    if (result.status === "rejected") throw result.reason;
    return result.value;
  }

  /** 已接受回合保留冻结材料直到原进程终态，再归还凭据租约。 */
  private async sendMessageWithCredential(input: SendMessageInput, emitters: ThreadEventEmitters,
    boundary: ClaudeSendBoundary): Promise<{ responseText: string }> {
    if (this.active) throw new Error("当前 thread 有未完成的 turn");
    if (this.promptOwner) throw Object.assign(new Error("Claude 提示文件尚未释放，请显式关闭后重试"), { code: "CLAUDE_PROMPT_RELEASE_PENDING", retryable: false });
    const requiredSkillGate = createClaudeRequiredSkillGate(input.requiredWorkspaceSkills);
    this.emitters = emitters;
    const emitConversation = emitters.conversation;
    const emitRaw = emitters.raw;
    this.assistantLifecycle.startTurn(input.turnId);

    const rawText = String(input.userMessage ?? input.text ?? "");
    const effectiveInputKind = input.inputKind ?? resolveLegacyEffectiveInputKind(rawText, input.images);
    const providerSlash = effectiveInputKind === "provider-slash";
    if (
      input.inputKind === "provider-slash"
      && (
        String(input.text ?? "")[0] !== "/"
        || rawText !== String(input.text ?? "")
        || input.images.some((image) => String(image ?? "").trim())
      )
    ) {
      throw Object.assign(new Error("Provider Slash 不能携带角色包装、附件、路径引用或图片"), {
        code: "PROVIDER_SLASH_CONFLICT",
        terminationKind: "error" as const,
      });
    }
    const appendSystemPrompt = mergePromptBlocks([
      input.systemMessage ?? null,
      input.developerMessage ?? null,
    ]);
    const appendSystemPromptFile = createClaudeAppendSystemPromptFile(appendSystemPrompt, input.turnId);
    this.promptOwner = appendSystemPromptFile;
    const preparationToken = this.lifecycleToken;
    const requestId = appendSystemPromptFile?.requestId ?? `claude-turn:${randomUUID()}`;
    let stage = "prepare";
    let platformToolBridge: ClaudePlatformToolBridge | null = null;
    let catalogDispatchLease: Awaited<ReturnType<typeof acquireEngineModelCatalogDispatchLease>> | null = null;
    let primaryFailure: { error: unknown } | undefined;
    const secondaryErrors: unknown[] = [];
    let response: { responseText: string } | undefined;
    let childFacts: ClaudeChildFacts | null = null;
    let providerChild: ChildProcessWithoutNullStreams | null = null;
    let drainReceivedStdout: (() => Promise<void>) | undefined;
    /** 每次异步准备后复核同一发送 owner，无提示回合同样禁止取消后派发。 */
    const assertDispatchCurrent = () => {
      if (boundary.cancellation) throw boundary.cancellation;
      if (appendSystemPromptFile && (this.promptOwner !== appendSystemPromptFile || preparationToken !== this.lifecycleToken)) {
        throw Object.assign(new Error("Claude 提示准备已被关闭撤销"), { code: "CLAUDE_PROMPT_DISPATCH_INVALIDATED", requestId, retryable: false });
      }
    };
    try {
    assertDispatchCurrent();

    const accessMode = input.accessMode ?? "current";
    const autoCompactPct = normalizeAutoCompactPct(input.autoCompactPct);
    this.currentProviderNativeToolPolicy = input.providerNativeToolPolicy ?? "allow";
    this.currentDeclaredAccessMode = accessMode;
    this.currentConversationProfile = input.conversationProfile ?? "default";
    const baseControlMode = resolveClaudeControlMode({
      planMode: Boolean(input.planMode),
      accessMode,
      conversationProfile: input.conversationProfile ?? "default",
    });
    this.currentControlMode = baseControlMode;
    this.prePlanControlMode = input.planMode
      ? resolveClaudeControlMode({
          planMode: false,
          accessMode,
          conversationProfile: input.conversationProfile ?? "default",
        })
      : null;

    const cli = resolveClaudeCli();
    let childForPlatformTools: ChildProcessWithoutNullStreams | null = null;
    let platformToolFatalError: Error | null = null;
    platformToolBridge = boundary.platformToolBridge = await createClaudePlatformToolBridge({
      toolRegistry: input.toolRegistry,
      executeHostTool: input.executeHostTool,
      accessMode,
      onFatalError: (error) => {
        platformToolFatalError = error;
        const active = this.active;
        if (active?.child === childForPlatformTools) {
          active.killReason = active.killReason ?? "platform_tool_fatal";
          active.failed = true;
        }
        try {
          if (childForPlatformTools && !childForPlatformTools.kill()) throw new Error("CLAUDE_PLATFORM_TOOL_SIGNAL_REJECTED");
        } catch (killError) {
          this.callbackFailed = true;
          secondaryErrors.push(killError);
          try {
            this.writeEngineLog("warn", "failed to kill child after platform tool fatal error", () => ({ rootCause: engineDiagnosticCause(killError) }));
          } catch (diagnosticError) { secondaryErrors.push(diagnosticError); }
        }
      },
    });
    appendSystemPromptFile?.prepare();
    assertDispatchCurrent();
    if (appendSystemPromptFile) {
      const prepared = await appendSystemPromptFile.ready;
      if (!prepared.ok) throw prepared.error;
      assertDispatchCurrent();
    }
    this.currentPlatformToolNames = new Set(platformToolBridge?.toolNames ?? []);
    stage = "model_args";
    let args: string[];
      // 获取租约同样可能失败，必须进入工具桥和提示文件的清理边界。
      catalogDispatchLease = await acquireEngineModelCatalogDispatchLease({ engine: "claude", model: input.model });
      assertDispatchCurrent();
      assertRuntimeEngineModelAvailable("claude", input.model);
      args = buildClaudeArgs({
        text: rawText,
        sessionId: this.sessionId,
        planMode: Boolean(input.planMode),
        accessMode,
        conversationProfile: input.conversationProfile ?? "default",
        model: input.model,
        effort: input.effort,
        contextWindow: input.contextWindow,
        inputFormat: "stream-json",
        autoCompactPct,
        appendSystemPrompt: appendSystemPromptFile ? null : appendSystemPrompt,
        appendSystemPromptFilePath: appendSystemPromptFile?.path ?? null,
        mcpConfigPath: platformToolBridge?.mcpConfigPath ?? null,
      });

    const call: EngineCallTrace = {
      kind: "spawn",
      engine: "claude",
      cwd: this.opts.workspacePath,
      command: cli.command,
      args: [...cli.argsPrefix, ...args],
      stdin: {
        kind: "stream-json",
        line: buildClaudeStreamJsonTraceLine({ text: rawText, images: input.images, inputKind: input.inputKind }),
        redacted: true,
      },
    };
      stage = "engine_call";
      emitConversation({
        ts: Date.now(),
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId as any,
        engine: "claude",
        type: "item.userMessage.engineCall.created",
        payload: { itemId: input.userItemId, call },
      } satisfies ConversationEventInput);

    const fullArgs = [...cli.argsPrefix, ...args];
    const hasStdioPermission = fullArgs.includes("--permission-prompt-tool");
    const hasSkipPermissions = fullArgs.includes("--dangerously-skip-permissions");
    let childEnv: NodeJS.ProcessEnv;
      stage = "credentials";
      this.credentialLease?.assertCurrent();
      childEnv = (await this.withDatabase(() => buildClaudeChildEnv(process.env, {
        command: cli.command,
        dangerouslySkipPermissions: hasSkipPermissions,
        model: input.model,
        contextWindow: input.contextWindow,
        providerId: this.opts.resolveModelProvider?.(input.model) ?? null,
        readCredentials: this.credentialLease?.config ? () => this.credentialLease!.config : this.opts.readProviderCredentials,
        hasConfiguredCredentials: this.opts.hasConfiguredProviderCredentials,
      })));
    const permissionModeIdx = fullArgs.indexOf("--permission-mode");
    const permissionMode = permissionModeIdx >= 0 ? (fullArgs[permissionModeIdx + 1] ?? null) : null;
    const resumeIdx = fullArgs.indexOf("--resume");
    const resumeSessionId = resumeIdx >= 0 ? (fullArgs[resumeIdx + 1] ?? null) : null;
    this.writeEngineLog("info", `spawn command=${cli.command}`, {
      args: fullArgs,
      cwd: this.opts.workspacePath,
      hasStdioPermission,
      hasSkipPermissions,
      permissionMode,
      resumeSessionId,
      accessMode: input.accessMode ?? null,
      askUserQuestionSupported: hasStdioPermission,
      currentControlMode: this.currentControlMode,
      prePlanControlMode: this.prePlanControlMode,
      CLAUDE_CODE_GIT_BASH_PATH: childEnv.CLAUDE_CODE_GIT_BASH_PATH ?? null,
      IS_SANDBOX: childEnv.IS_SANDBOX ?? null,
      ENABLE_PROMPT_CACHING_1H: childEnv.ENABLE_PROMPT_CACHING_1H ?? null,
      FORCE_PROMPT_CACHING_5M: childEnv.FORCE_PROMPT_CACHING_5M ?? null,
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: childEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST ?? null,
      CLAUDE_CODE_SUBAGENT_MODEL: childEnv.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
      ANTHROPIC_DEFAULT_FABLE_MODEL: childEnv.ANTHROPIC_DEFAULT_FABLE_MODEL ?? null,
      ANTHROPIC_DEFAULT_OPUS_MODEL: childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null,
      ANTHROPIC_DEFAULT_SONNET_MODEL: childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null,
      ANTHROPIC_SMALL_FAST_MODEL: childEnv.ANTHROPIC_SMALL_FAST_MODEL ?? null,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: childEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? null,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null,
      hasAnthropicBaseUrl: Boolean(String(childEnv.ANTHROPIC_BASE_URL ?? "").trim()),
      hasAnthropicAuthToken: Boolean(String(childEnv.ANTHROPIC_AUTH_TOKEN ?? childEnv.ANTHROPIC_API_KEY ?? "").trim()),
    });
    let child: ChildProcessWithoutNullStreams;
      stage = "spawn";
      this.credentialLease?.assertCurrent();
      assertDispatchCurrent();
      child = spawn(cli.command, fullArgs, {
        cwd: this.opts.workspacePath,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      childFacts = observeClaudeChild(child);
      boundary.child = child;
      boundary.facts = childFacts;
      providerChild = child;
      appendSystemPromptFile?.bindChild(child, childFacts);
      childForPlatformTools = child;
      const dispatchLease = catalogDispatchLease;
      catalogDispatchLease = null;
      dispatchLease.release();
    const runToken = ++this.lifecycleToken;
    const stdinLifecycle = new ClaudeStdinLifecycle();

    // 始终使用 stream-json 写入初始消息（支持图片 & 保持 stdin 打开以接收 AskUserQuestion 回答）。
    stdinLifecycle.markLocalInputQueued();
    let stopStdoutAfterFailure: ((error: unknown) => void) | undefined;
    const activeTurn: ActiveTurn = {
      turnId: input.turnId,
      child,
      stdinLifecycle,
      sharedWorkspaceToolContext: input.sharedWorkspaceToolContext ?? null,
      manualInterruptRequested: false,
      manualInterruptError: null,
      killReason: null,
      failed: false,
      /** 异步事件失败留在原回合收尾中；停止该进程后由 send/dispose 消费。 */
      fail: (error) => {
        this.callbackFailed = true;
        secondaryErrors.push(error);
        if (activeTurn.failed) return;
        activeTurn.failed = true;
        stopStdoutAfterFailure?.(error);
        try { if (!child.kill()) throw new Error("CLAUDE_CALLBACK_FAILURE_SIGNAL_REJECTED"); }
        catch (killError) { secondaryErrors.push(killError); }
      },
      drainStdout: () => waitForStdoutDrain(),
    };
    this.active = activeTurn;
    this.tool = createToolState();

    const state = createClaudeStreamProcessorState();
    this.streamState = state;
    let startupTimedOut = false;
    let timeoutError: EngineTimeoutError | null = null;
    let requiredSkillFailure: ClaudeRequiredSkillError | null = null;
    const providerSlashState: {
      finalResult: Exclude<ClaudeProviderSlashFinalResult, { kind: "pending" }> | null;
    } = { finalResult: null };
    const knownRawTypes = ALL_KNOWN_STDOUT_TYPES;
    const timeoutPolicy = normalizeTurnTimeoutPolicy(input.timeoutPolicy, input.timeoutMs);
    const pendingInteractiveCount = () => this.tool.pendingUserInputByRequestId.size + this.tool.pendingApprovalByRequestId.size;
    const timeoutController = new TurnTimeoutController({
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId,
      engine: "claude",
      turnId: String(input.turnId),
      policy: timeoutPolicy,
      emitConversation,
      emitRaw,
      onTimeout: (error) => {
        timeoutError = error;
        activeTurn.killReason = activeTurn.killReason ?? "turn_timeout";
        try { if (!child.kill()) throw new Error("CLAUDE_TIMEOUT_SIGNAL_REJECTED"); } catch (killError) { activeTurn.fail(killError); }
      },
    });
    if (timeoutPolicy.mode === "legacy-turn") timeoutController.start();

    // 启动看门狗：如果 Claude Code 在指定时间内没有产生任何 stdout 输出，说明进程卡在初始化阶段。
    // 常见原因：MCP 初始化慢/API 首次连接延迟/会话文件损坏。
    const STARTUP_TIMEOUT_MS = timeoutPolicy.startupTimeoutMs;
    let gotFirstOutput = false;
    const startupTimer = setTimeout(() => {
      if (gotFirstOutput) return;
      startupTimedOut = true;
      activeTurn.killReason = activeTurn.killReason ?? "startup_timeout";
      try { if (!child.kill()) throw new Error("CLAUDE_STARTUP_SIGNAL_REJECTED"); } catch (killError) { activeTurn.fail(killError); }
    }, STARTUP_TIMEOUT_MS);
    startupTimer?.unref?.();

    const rl = readline.createInterface({ input: child.stdout });
    let stdoutReadlineClosed = false;
    /** EOF尾行仍可排队；close后仅停止恢复该读取接口，不丢弃FIFO。 */
    rl.once("close", () => { stdoutReadlineClosed = true; });
    const stdoutLines: string[] = [];
    let stdoutHead = 0, stdoutPaused = false, stdoutDraining = false;
    let stdoutFailure: { error: unknown } | undefined;
    const stdoutWaiters = new Set<{ resolve(): void; reject(error: unknown): void }>();
    /** 仅在当前 turn 已接收行完成或失败后交还排空 owner。 */
    const settleStdoutWaiters = (): void => {
      if (!stdoutFailure && (stdoutDraining || stdoutHead < stdoutLines.length)) return;
      for (const waiter of stdoutWaiters) stdoutFailure ? waiter.reject(stdoutFailure.error) : waiter.resolve();
      stdoutWaiters.clear();
    };
    /** 失败封存剩余副作用，但恢复管道读取以允许 kill 后 stdio 真正关闭。 */
    stopStdoutAfterFailure = (error): void => {
      stdoutFailure ??= { error };
      stdoutLines.length = 0;
      stdoutHead = 0;
      cancelClaudeStdoutDrain(drainStdoutBatch);
      if (stdoutPaused || child.stdout.isPaused()) {
        stdoutPaused = false;
        try {
          if (!stdoutReadlineClosed) rl.resume();
          if (child.stdout.isPaused()) child.stdout.resume();
        }
        catch (resumeError) {
          secondaryErrors.push(resumeError);
          try { child.stdout.destroy(); } catch (destroyError) { secondaryErrors.push(destroyError); }
        }
      }
      settleStdoutWaiters();
    };
    /** 原逐行映射与 raw→全部 canonical 保持同步，中间不让出。 */
    const processStdoutLine = (line: string): void => {
      const rawEvent = safeJson(line);
      const buffered: ConversationEventInput[] = [];
      const emittedTypes = new Set<string>();
      const bufferedEmit: ConversationEmitFn = (event) => {
        buffered.push(event);
        emittedTypes.add(String((event as any)?.type ?? ""));
      };

      const rawType = rawEvent ? String((rawEvent as any).type ?? "").trim() : "";
      const newRootResult = activeTurn.stdinLifecycle.observe(rawEvent);
      const known = rawType ? knownRawTypes.has(rawType) : false;
      if (rawType === "system" && String((rawEvent as any)?.subtype ?? "") === "init") {
        const initSessionId = String((rawEvent as any)?.session_id ?? "").trim();
        if (initSessionId) this.setSessionId(initSessionId as SessionId, bufferedEmit);
        this.observeInputActionCatalog(rawEvent, runToken);
      }
      const skillGateError = inspectClaudeRequiredSkillEvent(requiredSkillGate, rawEvent);
      if (skillGateError && !requiredSkillFailure) {
        requiredSkillFailure = skillGateError;
        activeTurn.killReason = activeTurn.killReason ?? "required_skill_unavailable";
        this.writeEngineLog("error", "required workspace Skill unavailable", {
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          turnId: input.turnId,
          code: skillGateError.code,
          requestMethod: skillGateError.requestMethod,
          details: skillGateError.additionalDetails,
        });
        try {
          if (!child.kill()) {
            this.writeEngineLog("warn", "required workspace Skill gate could not signal child", {
              workspaceId: this.opts.workspaceId,
              threadId: this.opts.threadId,
              turnId: input.turnId,
            });
          }
        } catch (killError) {
            this.writeEngineLog("warn", "required workspace Skill gate failed to signal child", () => ({
            workspaceId: this.opts.workspaceId,
            threadId: this.opts.threadId,
            turnId: input.turnId,
            rootCause: engineDiagnosticCause(killError),
          }), { reason: killError });
        }
      }

      // control protocol：拦截 control_request（--permission-prompt-tool stdio），存储映射供后续回写
      if (!requiredSkillFailure && rawType === "control_request" && rawEvent) {
        const req = (rawEvent as any).request;
        const controlRequestId = String((rawEvent as any).request_id ?? "");
        const subtype = String(req?.subtype ?? "");
        const toolName = String(req?.tool_name ?? "");
        const toolUseId = String(req?.tool_use_id ?? "");
        this.writeEngineLog("info", `control_request received: subtype=${subtype} tool=${toolName} requestId=${controlRequestId} toolUseId=${toolUseId}`);

        if (subtype === "can_use_tool" && controlRequestId) {
          if (toolUseId) {
            this.tool.toolNameById.set(toolUseId, toolName);
            this.tool.controlRequestIdByToolUseId.set(toolUseId, controlRequestId);
            this.tool.controlRequestInputByToolUseId.set(toolUseId, req?.input);
          }
          const platformTool = this.isCurrentPlatformToolName(toolName);
          const nativeToolsDenied = providerNativeToolsDenied(this.currentProviderNativeToolPolicy);
          const interactiveTool = isAskUserQuestionTool(toolName) || isInteractiveControlTool(toolName);
          if (platformTool) {
            const autoAllow = {
              type: "control_response",
              response: {
                subtype: "success",
                request_id: controlRequestId,
                response: { behavior: "allow", updatedInput: req?.input },
              },
            };
            child.stdin.write(JSON.stringify(autoAllow) + "\n", "utf8");
            this.writeEngineLog("info", `control_request auto-allow(platform-tool): tool=${toolName} requestId=${controlRequestId}`);
          } else if ((() => {
            const decision = evaluateSharedWorkspaceProviderNativeToolPolicy({
              context: this.active?.sharedWorkspaceToolContext ?? null,
              provider: "claude",
              toolName,
              toolInput: req?.input,
            });
            if (decision.allowed) return false;
            const autoDeny = {
              type: "control_response",
              response: {
                subtype: "success",
                request_id: controlRequestId,
                response: { behavior: "deny", message: buildSharedWorkspaceProviderNativeDenyMessage(decision) },
              },
            };
            child.stdin.write(JSON.stringify(autoDeny) + "\n", "utf8");
            this.writeEngineLog("info", `control_request auto-deny(shared-workspace-policy): tool=${toolName} requestId=${controlRequestId}`);
            return true;
          })()) {
            // handled by shared workspace policy guard
          } else if (nativeToolsDenied && !(interactiveTool && providerNativeInteractionToolsAllowed(this.currentProviderNativeToolPolicy))) {
            const denyMessage = buildProviderNativeToolDenyMessage("claude", toolName);
            const autoDeny = {
              type: "control_response",
              response: {
                subtype: "success",
                request_id: controlRequestId,
                response: { behavior: "deny", message: denyMessage },
              },
            };
            child.stdin.write(JSON.stringify(autoDeny) + "\n", "utf8");
            this.writeEngineLog("info", `control_request auto-deny(native-tool-policy): tool=${toolName} requestId=${controlRequestId}`);
          } else if (isAskUserQuestionTool(toolName)) {
            // AskUserQuestion：CC 现在阻塞等待 control_response，需要用户在 Web 上回答
            this.writeEngineLog("info", `control_request AskUserQuestion BLOCKING: CC is now waiting for user answer`, {
              controlRequestId,
              toolUseId,
              pendingCount: this.tool.pendingUserInputByRequestId.size,
              pendingKeys: Array.from(this.tool.pendingUserInputByRequestId.keys()),
              claudeResultReceived: this.tool.claudeResultReceived,
              questionsCount: Array.isArray(req?.input?.questions) ? req.input.questions.length : 0,
            });
          } else if (isInteractiveControlTool(toolName)) {
            if (toolUseId) this.tool.pendingApprovalByRequestId.set(controlRequestId, toolUseId);
            const descriptor = buildClaudeApprovalDescriptor({
              toolName,
              prePlanMode: this.prePlanControlMode,
            });
            bufferedEmit({
              ts: Date.now(),
              workspaceId: this.opts.workspaceId,
              threadId: this.opts.threadId as any,
              engine: "claude",
              type: "approval.request",
              payload: {
                requestId: controlRequestId,
                toolName,
                input: req?.input,
                message: descriptor.message,
                approvalKind: descriptor.approvalKind,
                options: descriptor.options,
              },
            });
            this.writeEngineLog("info", `control_request interactive approval queued: tool=${toolName} requestId=${controlRequestId}`, {
              approvalKind: descriptor.approvalKind,
              currentControlMode: this.currentControlMode,
              prePlanControlMode: this.prePlanControlMode,
            });
          } else if (this.currentControlMode === "acceptEdits" || this.currentControlMode === "bypassPermissions") {
            const autoAllow = { type: "control_response", response: { subtype: "success", request_id: controlRequestId, response: { behavior: "allow", updatedInput: req?.input } } };
            child.stdin.write(JSON.stringify(autoAllow) + "\n", "utf8");
            this.writeEngineLog("info", `control_request auto-allow: tool=${toolName} requestId=${controlRequestId}`);
          } else if (this.currentControlMode === "default" || this.currentControlMode === "plan") {
            if (toolUseId) this.tool.pendingApprovalByRequestId.set(controlRequestId, toolUseId);
            bufferedEmit({
              ts: Date.now(),
              workspaceId: this.opts.workspaceId,
              threadId: this.opts.threadId as any,
              engine: "claude",
              type: "approval.request",
              payload: {
                requestId: controlRequestId,
                toolName,
                input: req?.input,
                message: this.currentControlMode === "plan"
                  ? String(req?.decision_reason ?? req?.description ?? `当前处于计划模式，Claude 请求执行工具 ${toolName}。同意后将继续执行该工具。`)
                  : String(req?.decision_reason ?? req?.description ?? `Claude 请求执行工具 ${toolName}`),
                approvalKind: "generic",
              },
            });
            this.writeEngineLog("info", `control_request approval queued: tool=${toolName} requestId=${controlRequestId}`);
          } else {
            this.writeEngineLog("warn", `control_request received unknown control mode, fallback to approval request: tool=${toolName} requestId=${controlRequestId}`, {
              mode: this.currentControlMode,
            });
            if (toolUseId) this.tool.pendingApprovalByRequestId.set(controlRequestId, toolUseId);
            bufferedEmit({
              ts: Date.now(),
              workspaceId: this.opts.workspaceId,
              threadId: this.opts.threadId as any,
              engine: "claude",
              type: "approval.request",
              payload: {
                requestId: controlRequestId,
                toolName,
                input: req?.input,
                message: String(req?.decision_reason ?? req?.description ?? `Claude 请求执行工具 ${toolName}`),
                approvalKind: "generic",
              },
            });
          }
        }
      } else if (!requiredSkillFailure && rawType === "control_response" && rawEvent) {
        // 只处理本端发起的控制请求回执；CLI 主动请求仍走 control_request 分支。
        const response = (rawEvent as any).response as Record<string, unknown> | undefined;
        const responseRequestId = String(response?.request_id ?? "");
        const pendingResponse = responseRequestId ? this.pendingControlResponses.get(responseRequestId) : undefined;
        if (pendingResponse) {
          if (String(response?.subtype) === "success") {
            if (pendingResponse.expired) {
              pendingResponse.onLateSuccess?.();
              pendingResponse.clearLate?.();
            } else {
              pendingResponse.resolve(response!);
            }
          } else {
            pendingResponse.clearLate?.();
            pendingResponse.reject(new Error(`Claude 控制请求失败：${String(response?.error ?? response?.subtype ?? "unknown")}`));
          }
        }
      } else if (!requiredSkillFailure && rawEvent && !known && rawType) {
        // 记录其他未识别的 stdout 事件类型
        this.writeEngineLog("warn", `unhandled stdout type="${rawType}"`, {
          requestId: (rawEvent as any).request_id ?? undefined,
          keys: Object.keys(rawEvent as any),
        });
      }

      if (!requiredSkillFailure) {
        applyClaudeStreamLine({
          line,
          parsed: rawEvent ?? undefined,
          workspacePath: this.opts.workspacePath,
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId,
          input,
          tool: this.tool,
          state,
          assistantLifecycle: this.assistantLifecycle,
          emit: bufferedEmit,
          providerSlash,
          onSessionId: (sid) => this.setSessionId(sid, bufferedEmit),
          onPermissionModeChanged: (mode) => {
            this.handlePermissionModeChanged(mode, bufferedEmit);
          },
          onBackgroundShellTaskStarted: (task) => this.handleBackgroundShellTaskStarted(task),
          onBackgroundShellTaskCompleted: (task) => this.handleBackgroundShellTaskCompleted(task),
        });
      }

      if (providerSlash && rawType === "result") {
        const outcome = inspectClaudeProviderSlashFinalResult(rawEvent, pendingInteractiveCount());
        if (outcome?.kind === "success") {
          providerSlashState.finalResult = outcome;
          if (outcome.resultText && !state.latestAssistantText) {
            emitClaudeAssistantText(
              {
                workspaceId: this.opts.workspaceId,
                threadId: this.opts.threadId,
                state,
                assistantLifecycle: this.assistantLifecycle,
                emit: bufferedEmit,
              },
              outcome.resultText,
              `provider_slash_result_${String((rawEvent as any)?.uuid ?? runToken)}`,
            );
          }
        } else if (outcome?.kind === "failure") {
          providerSlashState.finalResult = outcome;
        }
      }

      const handled = Boolean(rawEvent) && known;
      const action = !rawEvent ? "parseError" : !handled ? "unhandled" : emittedTypes.size > 0 ? "mapped" : "ignored";
      emitRaw({
        ts: Date.now(),
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId as any,
        engine: "claude",
        source: "claude.stream-json.stdout",
        data: rawEvent ?? { rawLine: line, error: "invalid_json" },
        handled,
        action,
        emittedTypes: Array.from(emittedTypes).filter(Boolean),
      } satisfies RawEngineEventInput);
      timeoutController.onRawEvent({
        ts: Date.now(),
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId as any,
        engine: "claude",
        source: "claude.stream-json.stdout",
        data: rawEvent ?? { rawLine: line, error: "invalid_json" },
        handled,
        action,
        emittedTypes: Array.from(emittedTypes).filter(Boolean),
      });

      for (const e of buffered) {
        timeoutController.onConversationEvent(e);
        emitConversation(e);
      }

      // 后台 agent 完成后仍会触发通知轮次；中间 result 不能关闭确认通道。
      if (!requiredSkillFailure && newRootResult) {
        const lifecycle = activeTurn.stdinLifecycle;
        this.tool.claudeResultReceived = !lifecycle.hasPendingWork;
        const pendingCount = pendingInteractiveCount();
        this.writeEngineLog("info", `received type="result", pendingInteractive=${pendingCount}, stdinWritable=${Boolean(child.stdin?.writable)}`, {
          threadId: this.opts.threadId,
          turnId: input.turnId,
          resultIndex: (rawEvent as any)?.result_index ?? null,
          pendingBackgroundTasks: lifecycle.pendingBackgroundTasks,
          pendingNotificationTurns: lifecycle.pendingNotificationTurns,
          pendingLocalInputTurns: lifecycle.pendingLocalInputTurns,
          pendingWork: lifecycle.hasPendingWork,
          pendingUserInputKeys: Array.from(this.tool.pendingUserInputByRequestId.keys()),
          pendingApprovalKeys: Array.from(this.tool.pendingApprovalByRequestId.keys()),
        });
        if (pendingCount === 0 && !lifecycle.hasPendingWork) {
          this.writeEngineLog("info", "closing stdin (root result settled, no pending work)", { threadId: this.opts.threadId, turnId: input.turnId });
          if (child.stdin?.writable) child.stdin.end();
        } else {
          this.writeEngineLog("info", "keeping stdin open (pending interactions or background turns)", { threadId: this.opts.threadId, turnId: input.turnId });
        }
      }
    };
    /** 许可等待也归stdout排空owner，收到的后续行保持FIFO。 */
    const finishStdoutBatch = (): void => {
      stdoutDraining = false;
      if (!stdoutFailure && stdoutHead < stdoutLines.length) scheduleClaudeStdoutDrain(drainStdoutBatch);
      settleStdoutWaiters();
    };
    /** 仅绑定变化行进入短许可；普通输出仍按两行预算同步映射。 */
    const drainStdoutBatch = (deadline: number): void => {
      if (stdoutDraining) return;
      stdoutDraining = true;
      const nextSessionId = maybeExtractSessionId(safeJson(stdoutLines[stdoutHead] ?? ""));
      if (this.opts.withLegacyDatabase && nextSessionId && nextSessionId !== this.sessionId) {
        void this.withDatabase(() => processStdoutLine(stdoutLines[stdoutHead++]!)).then(finishStdoutBatch, error => {
          activeTurn.fail(error);
          finishStdoutBatch();
        });
        return;
      }
      try {
        for (let count = 0; count < 2 && stdoutHead < stdoutLines.length && !activeTurn.failed && (count === 0 || performance.now() < deadline); count++) {
          const sessionId = maybeExtractSessionId(safeJson(stdoutLines[stdoutHead]!));
          if (this.opts.withLegacyDatabase && sessionId && sessionId !== this.sessionId) break;
          processStdoutLine(stdoutLines[stdoutHead++]!);
        }
        if (activeTurn.failed && !stdoutFailure) stopStdoutAfterFailure!(platformToolFatalError ?? new Error("CLAUDE_STDOUT_TURN_FAILED"));
        if (!stdoutFailure && stdoutHead === stdoutLines.length) {
          stdoutLines.length = 0;
          stdoutHead = 0;
          if (stdoutPaused) { stdoutPaused = false; if (!stdoutReadlineClosed) rl.resume(); }
        }
      } catch (error) { activeTurn.fail(error); }
      finally { finishStdoutBatch(); }
    };
    /** 仅接收时校验代次；已接收行不会因 dispose 换代而被丢弃。 */
    rl.on("line", (line: string) => {
      if (runToken !== this.lifecycleToken || activeTurn.failed) return;
      try {
        if (!gotFirstOutput) {
          gotFirstOutput = true;
          clearTimeout(startupTimer);
          if (timeoutPolicy.mode === "activity") timeoutController.start();
        }
        stdoutLines.push(line);
        if (!stdoutPaused) { stdoutPaused = true; rl.pause(); }
        if (!stdoutDraining) scheduleClaudeStdoutDrain(drainStdoutBatch);
      } catch (error) { activeTurn.fail(error); }
    });
    /** 已接收行的短屏障独立于进程关闭，可供 dispose 在清空 emitters 前等待。 */
    const waitForStdoutDrain = (): Promise<void> => {
      if (stdoutFailure) return Promise.reject(stdoutFailure.error);
      if (!stdoutDraining && stdoutHead === stdoutLines.length) return Promise.resolve();
      return new Promise<void>((resolve, reject) => { stdoutWaiters.add({ resolve, reject }); });
    };
    drainReceivedStdout = waitForStdoutDrain;

    const errLines: string[] = [];
    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      if (runToken !== this.lifecycleToken) return;
      if (activeTurn.failed) return;
      try {
      const s = String(line ?? "").trim();
      if (s) errLines.push(s);
      if (errLines.length > 20) errLines.shift();
      // 实时发射 stderr 到事件流，便于在调试面板排查启动卡死等问题
        if (s) {
        const rawEvent: RawEngineEventInput = {
          ts: Date.now(),
          workspaceId: this.opts.workspaceId,
          threadId: this.opts.threadId as any,
          engine: "claude",
          source: "claude.stderr",
          data: { line: s },
          handled: false,
          action: "unhandled" as const,
          emittedTypes: [],
        };
        emitRaw(rawEvent);
        timeoutController.onRawEvent(rawEvent);
      }
      } catch (error) { activeTurn.fail(error); }
    });

    const exitPromise = childFacts.first.then(async fact => {
      // 终态已到，排空期间不再制造新的活动/启动超时；既有超时原因仍保留。
      for (const cleanup of [() => timeoutController.stop(), () => clearTimeout(startupTimer)]) {
        try { cleanup(); } catch (error) { secondaryErrors.push(error); }
      }
      let drainFailure: { error: unknown } | undefined;
      try { await waitForStdoutDrain(); } catch (error) { drainFailure = { error }; }
      if (fact.kind === "error") {
        if (drainFailure) throw new AggregateError([drainFailure.error, fact.error], "Claude stdout 与进程均失败", { cause: drainFailure.error });
        throw fact.error;
      }
      if (drainFailure) throw drainFailure.error;
      const { code, signal } = fact.exit;
      try {
        const pendingAsk = this.tool.pendingUserInputByRequestId.size;
        const pendingApproval = this.tool.pendingApprovalByRequestId.size;
        const pendingLocalInputTurns = activeTurn.stdinLifecycle.pendingLocalInputTurns;
        const resultReceived = this.tool.claudeResultReceived;
        this.writeEngineLog("info", `child exited code=${code} signal=${signal}`, {
          pendingAskUserQuestion: pendingAsk,
          pendingApproval,
          pendingLocalInputTurns,
          claudeResultReceived: resultReceived,
          killReason: activeTurn.killReason,
          pendingAskKeys: pendingAsk > 0 ? Array.from(this.tool.pendingUserInputByRequestId.keys()) : [],
          pendingApprovalKeys: pendingApproval > 0 ? Array.from(this.tool.pendingApprovalByRequestId.keys()) : [],
        });
        if (pendingAsk > 0 || pendingApproval > 0) {
          this.writeEngineLog("warn", `child exited with pending interactive requests — user never had a chance to answer. Possible causes: process killed externally, startup timeout, or session corruption`, {
            pendingAsk,
            pendingApproval,
          });
          if (pendingApproval > 0 && this.emitters) {
            for (const requestId of this.tool.pendingApprovalByRequestId.keys()) {
              this.emitters.conversation({
                ts: Date.now(),
                workspaceId: this.opts.workspaceId,
                threadId: this.opts.threadId as any,
                engine: "claude",
                type: "approval.expired",
                payload: {
                  requestId,
                  message: "Claude 会话已结束，审批请求已失效。",
                },
              });
            }
          }
        }
      } catch (error) { secondaryErrors.push(error); }
      return { code, signal };
    });
    const settled = exitPromise.finally(() => {
      for (const cleanup of [() => rl.close(), () => rlErr.close()]) {
        try { cleanup(); } catch (error) { secondaryErrors.push(error); }
      }
      // 关闭 stdin（进程退出时才执行，确保 AskUserQuestion 双向通信期间管道保持打开）
      try { if (child.stdin?.writable) child.stdin.end(); } catch (error) { secondaryErrors.push(error); }
      if (this.active?.child === child) this.active = null;
      this.assistantLifecycle.retireTurn(input.turnId);
    });
    this.activeTurnSettled = settled.then(() => undefined, () => undefined);
    // 先建立原始事件接收与关闭屏障，再等待初始写入，保证该窗口终止也能排空输出。
    try {
      stage = "initial_stdin";
      const line = buildClaudeStreamJsonInput({ text: rawText, images: input.images, inputKind: input.inputKind });
      await Promise.race([
        writeClaudeStdinLine(child, line),
        childFacts.error.then(fact => { throw fact.error; }),
        childFacts.close.then(() => { throw boundary.cancellation ?? Object.assign(new Error("Claude 初始输入未确认前已退出"), { requestOutcomeUnknown: true }); }),
      ]);
      if (boundary.cancellation) throw boundary.cancellation;
    } catch (error) {
      stdinLifecycle.cancelLocalInputQueued();
      if (error !== boundary.cancellation) {
        timeoutController.stop();
        clearTimeout(startupTimer);
        if (!appendSystemPromptFile) {
          try { child.kill(); } catch (killError) { secondaryErrors.push(killError); }
        }
        throw error;
      }
    }
    stage = "turn";
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let settleFailure: { error: unknown } | undefined;
    try {
      exit = await settled;
    } catch (error) {
      settleFailure = { error };
    }
    this.activeTurnSettled = null;
    let postExitError: Error | null = null;
    const observedRequiredSkillFailure = requiredSkillFailure;
    requiredSkillFailure = requiredSkillFailure ?? finalizeClaudeRequiredSkillGate(requiredSkillGate);
    if (startupTimedOut) {
      const stderr = errLines.join("\n").trim();
      const hint = stderr
        ? `Claude 启动超时（${STARTUP_TIMEOUT_MS}ms 内无 stdout）。stderr:\n${stderr}`
        : `Claude 启动超时：${STARTUP_TIMEOUT_MS}ms 内无 stdout 输出。`
            + " 进程已启动但未产生任何响应，可能原因：API 连接超时、会话文件损坏等。"
            + " 可尝试：1) 新建会话（不使用 --resume）；2) 检查网络连接；3) 查看调试面板中的 stderr 事件。";
      postExitError = withErrorCode(new Error(hint), "startup_timeout");
      this.writeEngineLog("error", `startup timeout (${STARTUP_TIMEOUT_MS}ms, no stdout)`, { stderr, command: cli.command, args: fullArgs, cwd: this.opts.workspacePath }, { reason: postExitError });
    } else if (observedRequiredSkillFailure) {
      postExitError = observedRequiredSkillFailure;
    } else if (timeoutError) {
      postExitError = timeoutError;
    } else if (platformToolFatalError) {
      postExitError = platformToolFatalError;
    } else if (activeTurn.manualInterruptRequested) {
      postExitError = activeTurn.manualInterruptError ?? createClaudeManualInterruptError();
    } else if (requiredSkillFailure) {
      postExitError = requiredSkillFailure;
    } else if (!exit) {
      postExitError = new Error("Claude 进程未返回退出状态。");
    } else if (exit.signal) {
      const reason = activeTurn.killReason ?? "external_signal";
      postExitError = withErrorCode(new Error(`Claude 已被中断（signal=${exit.signal}, reason=${reason}）`), "claude_process_signal");
    } else if (providerSlash && pendingInteractiveCount() === 0 && providerSlashState.finalResult?.kind === "failure") {
      postExitError = createClaudeProviderSlashResultError(providerSlashState.finalResult);
    } else if (providerSlash && pendingInteractiveCount() === 0 && !providerSlashState.finalResult) {
      postExitError = createClaudeProviderSlashResultError({
        subtype: "missing",
        reason: "missing_final_result",
      });
    } else if (exit.code && exit.code !== 0 && !state.latestAssistantText) {
      const msg = state.errorFromEvent || errLines.join("\n") || `Claude 退出码：${exit.code}`;
      // 当 Claude CLI 报 "No conversation found with session ID" 时，说明 session 文件已失效
      // （常见于回滚后 session 文件被截断）。清除内存中的 sessionId，下次重试时自动创建新会话。
      if (this.sessionId && msg.includes("No conversation found with session ID")) {
        this.writeEngineLog("warn", "Claude session invalidated", { code: "CLAUDE_SESSION_INVALIDATED", sessionId: this.sessionId, rootCause: msg });
        this.sessionId = null;
        this.inputActionCatalog = null;
        postExitError = new SessionInvalidatedError("Claude 会话已失效：session 文件不存在，无法恢复上下文。");
      } else {
        postExitError = new Error(msg);
      }
    } else if (stdinLifecycle.pendingLocalInputTurns > 0) {
      postExitError = withErrorCode(new Error("Claude 已退出，但仍有用户输入未完成确认；为避免重复执行，不会自动重发。"), "CLAUDE_STDIN_INPUT_UNSETTLED_ON_EXIT");
      this.writeEngineLog("error", "child exited before queued stdin inputs settled", {
        code: "CLAUDE_STDIN_INPUT_UNSETTLED_ON_EXIT",
        requestId: null,
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        turnId: input.turnId,
        pendingLocalInputTurns: stdinLifecycle.pendingLocalInputTurns,
        rootCause: "child_exited_before_root_result",
      });
    }

    if (settleFailure) throw settleFailure.error;
    if ((postExitError as any)?.code === "claude_result_failed") {
      this.writeEngineLog("error", "provider slash final result failed", () => ({
        code: "claude_result_failed",
        requestId: null,
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId: this.sessionId,
        generation: runToken,
        command: extractSafeClaudeSlashCommandName(String(input.text ?? "")),
        providerSubtype: (postExitError as any)?.additionalDetails?.subtype ?? "invalid",
        reason: (postExitError as any)?.additionalDetails?.reason ?? "invalid_result_shape",
        rootCause: engineDiagnosticCause(postExitError),
      }), { reason: postExitError });
    }
    if (postExitError) throw postExitError;
    response = { responseText: this.assistantLifecycle.latestText(input.turnId) ?? state.latestAssistantText };
    } catch (error) {
      primaryFailure = { error };
    }
    appendSystemPromptFile?.prepare();
    try { catalogDispatchLease?.release(); } catch (error) { secondaryErrors.push(error); }
    let stopFailed = false;
    if (boundary.stopping) {
      try { await boundary.stopping; }
      catch (error) { stopFailed = true; secondaryErrors.push(error); }
    }
    if (appendSystemPromptFile && !stopFailed) {
      try {
        await appendSystemPromptFile.dispose();
        if (this.promptOwner === appendSystemPromptFile) this.promptOwner = null;
      } catch (error) { secondaryErrors.push(error); }
    }
    if (drainReceivedStdout) {
      try { await drainReceivedStdout(); }
      catch (error) { if (primaryFailure?.error !== error && !secondaryErrors.includes(error)) secondaryErrors.push(error); }
    }
    if (providerChild && childFacts?.closed && this.active?.child === providerChild) {
      this.active = null;
      this.assistantLifecycle.retireTurn(input.turnId);
    }
    try {
      await platformToolBridge?.dispose();
      boundary.platformToolBridge = null;
    } catch (error) { secondaryErrors.push(error); }
    this.currentPlatformToolNames = new Set();
    if (primaryFailure || secondaryErrors.length) {
      const code = stage === "prepare" && secondaryErrors.length ? "CLAUDE_PROMPT_PREPARATION_CLEANUP_FAILED" : "CLAUDE_PROMPT_RELEASE_FAILED";
      let failure = combineClaudeResourceFailure(primaryFailure, secondaryErrors, code, requestId);
      try {
        this.writeEngineLog("error", "Claude send resource boundary failed", {
          code, errorCode: code, requestId, workspaceId: this.opts.workspaceId, threadId: this.opts.threadId, turnId: input.turnId,
          stage, providerStarted: childFacts !== null, retainedDirectory: appendSystemPromptFile?.path ? path.dirname(appendSystemPromptFile.path) : null,
          event: { category: "engine", action: stage === "prepare" ? "prompt_prepare_cleanup" : "prompt_release", outcome: "fail" },
          rootCause: summarizeClaudePromptPreparationCause(primaryFailure ? primaryFailure.error : secondaryErrors[0]),
          cleanupCause: secondaryErrors.length ? summarizeClaudePromptPreparationCause(secondaryErrors[0]) : undefined,
        });
      } catch (error) {
        const loggingError = isEngineWorkspaceLogFailure(error) ? Object.getOwnPropertyDescriptor(error, "cause")?.value : error;
        failure = combineClaudeResourceFailure({ error: failure }, [loggingError], code, requestId);
      }
      throw failure;
    }
    return response!;
  }

  /** 通过当前 stdin 追加带 UUID 的输入；未写入与写入结果未知须明确区分。 */
  async appendInput(input: AppendTurnInput): Promise<AppendTurnResult> {
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    const active = this.active;
    if (!active || active.turnId !== input.turnId) throw new Error("当前 thread 没有可追加的 active turn");
    const child = active.child;
    if (!this.canAppendInput()) throw new ActiveTurnInputClosedError();

    const rawText = String(input.userMessage ?? input.text ?? "");
    const inputId = crypto.randomUUID();
    const line = buildClaudeStreamJsonInput({ text: rawText, images: input.images, uuid: inputId });
    const cli = resolveClaudeCli();
    const call: EngineCallTrace = {
      kind: "spawn",
      engine: "claude",
      cwd: this.opts.workspacePath,
      command: cli.command,
      args: [...cli.argsPrefix, "<active-stream-json-stdin>"],
      stdin: {
        kind: "stream-json",
        line: buildClaudeStreamJsonTraceLine({ text: rawText, images: input.images }),
        redacted: true,
      },
    };
    this.tool.claudeResultReceived = false;
    active.stdinLifecycle.markLocalInputQueued(inputId);
    try {
      await writeClaudeStdinLine(child, line);
    } catch (error) {
      active.stdinLifecycle.cancelLocalInputQueued(inputId);
      this.writeEngineLog("error", "appendInput stream-json write failed", () => ({
        code: "CLAUDE_STDIN_APPEND_WRITE_FAILED",
        requestId: null,
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        turnId: input.turnId,
        rootCause: engineDiagnosticCause(error),
      }), { reason: error });
      throw error;
    }
    return { engineCall: call };
  }

  /** 中断指定 turn；进程关闭与输出收尾分别等待，排空迟缓不能触发重复终止。 */
  async interrupt(turnId: TurnId, options?: ThreadInterruptOptions): Promise<boolean> {
    const active = this.active;
    const boundary = this.sendBoundary;
    if (boundary?.turnId === turnId && boundary.result?.status === "rejected"
      && boundary.result.reason instanceof ThreadEventFlushError) throw boundary.result.reason;
    if (!active && boundary?.turnId === turnId) return await this.interruptStartingTurn(boundary, options);
    if (!active || active.turnId !== turnId) return false;
    if (!await this.interruptWithReason(turnId, "manual_interrupt")) return false;
    if (boundary) boundary.stopConfirmed = true;
    options?.onStopConfirmed?.();
    await active.drainStdout();
    await this.waitForInterruptedSend(boundary);
    return true;
  }

  /** 撤销准备期派发；已关闭根进程的树终止失败不能在收尾重试中被清除。 */
  private async interruptStartingTurn(boundary: ClaudeSendBoundary, options?: ThreadInterruptOptions): Promise<boolean> {
    boundary.cancellation ??= createClaudeManualInterruptError();
    if (boundary.stopFailed && !boundary.facts?.closed) { boundary.stopping = null; boundary.stopFailed = false; }
    const stopping = boundary.stopping ??= this.stopStartingProcess(boundary);
    try { await stopping; }
    catch (error) { boundary.stopFailed = true; throw error; }
    boundary.stopConfirmed = true;
    options?.onStopConfirmed?.();
    if (boundary.result) {
      await this.dispose();
      return true;
    }
    await this.waitForInterruptedSend(boundary);
    return true;
  }

  /** 停止确认包含同一发送尾链，资源或回调失败不得被进程退出掩盖。 */
  private async waitForInterruptedSend(boundary: ClaudeSendBoundary | null): Promise<void> {
    if (!boundary) return;
    const result = await boundary.settled;
    if (result.status === "rejected" && result.reason !== boundary.cancellation) throw result.reason;
  }

  /** 进程停止与输出保存属于同一发送边界；保存期间仍保留原 turn。 */
  getTurnPhase(turnId: TurnId): "running" | "stopping" | "draining" | "failed" | null {
    const boundary = this.sendBoundary;
    if (!boundary || boundary.turnId !== turnId) return null;
    if (boundary.result?.status === "rejected" && boundary.result.reason instanceof ThreadEventFlushError) return "failed";
    return boundary.stopConfirmed ? "draining" : boundary.cancellation ? "stopping" : "running";
  }

  /** 失败由原发送结果保留，重连查询仅暴露安全代码。 */
  getTurnFailure(turnId: TurnId): string | null {
    return this.getTurnPhase(turnId) === "failed" ? "TURN_EVENT_FLUSH_FAILED" : null;
  }

  /** 准备期进程仅有一个停止 owner，提示文件释放不得抢先终止根进程。 */
  private async stopStartingProcess(boundary: ClaudeSendBoundary): Promise<void> {
    const child = boundary.child, facts = boundary.facts;
    if (child && facts && !facts.closed) {
      if (process.platform === "win32") {
        let failure: { cause: unknown } | undefined;
        const detail = await terminateCliProcessTree(child, { strictTreeConfirmation: true, timeoutMs: CLAUDE_INTERRUPT_GRACE_MS,
          onFailure: cause => { failure = { cause }; } });
        if (detail !== null) throw Object.assign(new Error(`Claude 准备进程终止未确认：${detail}`, failure), { code: "claude_interrupt_unconfirmed" });
      } else if (!child.kill() && !facts.closed) {
        throw Object.assign(new Error("Claude 准备进程未接受终止信号"), { code: "claude_interrupt_unconfirmed" });
      }
      if (!await waitForClaudeTurnClose(facts.close.then(() => undefined), CLAUDE_INTERRUPT_GRACE_MS)) {
        throw Object.assign(new Error("Claude 准备进程退出尚未确认"), { code: "claude_interrupt_unconfirmed" });
      }
    }
  }

  /** 共用停止任务；只有根尚未关闭时才重试，根关闭不能覆盖进程树停止失败。 */
  private async interruptWithReason(turnId: TurnId, reason: ClaudeKillReason): Promise<boolean> {
    const active = this.active;
    if (!active) return false;
    if (active.turnId !== turnId) return false;
    const boundary = this.sendBoundary;
    if (!boundary?.facts || boundary.child !== active.child) {
      throw Object.assign(new Error("Claude 中断缺少当前进程事实"), { code: "claude_interrupt_unconfirmed" });
    }
    active.manualInterruptRequested = true;
    active.manualInterruptError ??= createClaudeManualInterruptError();
    boundary.cancellation ??= active.manualInterruptError;
    active.killReason = active.killReason ?? reason;
    if (boundary.stopFailed && !boundary.facts.closed) { boundary.stopping = null; boundary.stopFailed = false; }
    try { await (boundary.stopping ??= this.stopActiveProcess(active.child, boundary.facts)); }
    catch (error) { boundary.stopFailed = true; throw error; }
    return true;
  }

  /** 只以进程及 stdio 的关闭事实判断升级信号；输出映射与持久化不属于此等待。 */
  private async stopActiveProcess(child: ChildProcessWithoutNullStreams, facts: ClaudeChildFacts): Promise<void> {
    if (process.platform === "win32") {
      let failure: { cause: unknown } | undefined;
      const detail = await terminateCliProcessTree(child, {
        strictTreeConfirmation: true, timeoutMs: CLAUDE_INTERRUPT_GRACE_MS,
        onFailure: cause => { failure = { cause }; },
      });
      if (detail !== null) {
        throw Object.assign(new Error(`Claude 进程树终止未确认：${detail}`, failure), { code: "claude_interrupt_unconfirmed" });
      }
    } else if (!child.kill() && !facts.closed) {
      throw Object.assign(new Error("Claude 中断信号未被进程接受"), { code: "claude_interrupt_unconfirmed" });
    }
    if (facts.closed || await waitForClaudeTurnClose(facts.close.then(() => undefined), CLAUDE_INTERRUPT_GRACE_MS)) return;
    if (!child.kill("SIGKILL") && !facts.closed) {
      throw Object.assign(new Error("Claude 强制中断信号未被进程接受"), { code: "claude_interrupt_unconfirmed" });
    }
    if (facts.closed || await waitForClaudeTurnClose(facts.close.then(() => undefined), CLAUDE_INTERRUPT_FORCE_MS)) return;
    throw Object.assign(new Error("Claude 中断已发出，但进程未在限定时间内退出"), { code: "claude_interrupt_unconfirmed" });
  }

  /** 响应 Claude 权限审批请求（由 Web → Server → Client 调用链触发，通过 stdin 写回 stdio permission 响应）。 */
  async respondApproval(requestId: number | string, decision: "accept" | "decline", extra?: { choice?: string | null; note?: string | null }): Promise<{ followUp?: { kind: "clearContextAndSend"; promptText: string; accessMode: "current" | "full-access" } }> {
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    const child = this.active?.child;
    if (!child?.stdin?.writable) throw new Error("Claude stdin 不可写（进程可能已退出）");
    const key = String(requestId);
    const pendingToolUseId = this.tool.pendingApprovalByRequestId?.get(key);
    if (!pendingToolUseId) throw new Error(`approval request 不存在或已处理: ${key}`);
    const toolName = this.tool.toolNameById.get(pendingToolUseId) ?? "tool";
    const originalInput = this.tool.controlRequestInputByToolUseId.get(pendingToolUseId) as any;
    const previousControlMode = this.currentControlMode;
    const approval = buildClaudeApprovalResponse({
      toolName,
      decision,
      choice: extra?.choice,
      note: extra?.note,
      currentMode: this.currentControlMode,
      prePlanMode: this.prePlanControlMode,
      plan: typeof originalInput?.plan === "string" ? originalInput.plan : null,
      allowedPrompts: Array.isArray(originalInput?.allowedPrompts) ? originalInput.allowedPrompts : undefined,
    });
    const nextDeclaredAccessMode = resolveClaudeDeclaredAccessModeAfterApproval({
      toolName,
      previousAccessMode: this.currentDeclaredAccessMode,
      approval,
    });
    // Claude Code 的 stdio 权限协议要求 allow 响应必须包含 updatedInput 字段
    const approvalResponseWithInput = approval.response.behavior === "allow"
      ? { ...approval.response, updatedInput: (approval.response as any).updatedInput ?? originalInput }
      : approval.response;
    const response = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: key,
        response: approvalResponseWithInput,
      },
    };
    try {
      await writeClaudeStdinLine(child, JSON.stringify(response));
    } catch (error) {
      this.writeEngineLog("error", "respondApproval control_response write failed", () => ({
        code: "CLAUDE_APPROVAL_RESPONSE_WRITE_FAILED",
        requestId: key,
        toolUseId: pendingToolUseId,
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        turnId: this.active?.turnId ?? null,
        rootCause: engineDiagnosticCause(error),
      }), { reason: error });
      throw error;
    }
    this.applyControlMode(approval.nextMode);
    if (approval.nextMode !== "plan") {
      this.currentDeclaredAccessMode = nextDeclaredAccessMode;
    }
    this.tool.claudeResultReceived = false;
    if (this.active) this.active.stdinLifecycle.activityRevision++;
    this.tool.pendingApprovalByRequestId?.delete(key);

    this.emitters?.conversation({
      ts: Date.now(),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId as any,
      engine: "claude",
      type: "approval.resolved",
      payload: {
        requestId,
        approved: decision === "accept",
        choice: extra?.choice ?? undefined,
        note: extra?.note ?? undefined,
        // 只有本次审批真实改变模式时才回写偏好，避免普通工具审批覆盖用户手动关闭的计划模式。
        nextPlanMode: approval.nextMode !== previousControlMode ? approval.nextMode === "plan" : undefined,
        nextAccessMode: approval.nextMode !== previousControlMode
          ? (approval.nextMode === "plan" ? undefined : nextDeclaredAccessMode)
          : undefined,
        clearContextRequested: approval.clearContextRequested,
        message: approval.resolutionMessage,
      },
    });
    return approval.followUp ? { followUp: approval.followUp } : {};
  }

  /**
   * Claude Code auto-approve 场景下通过 system.status 通知 permissionMode 变更。
   * 例如：bypassPermissions 模式下 EnterPlanMode 被自动批准时，不会经过 control_request 审批流程，
   * 需要在此手动同步 session 控制模式和前端 UI 状态。
   */
  private handlePermissionModeChanged(mode: string, emit: ConversationEmitFn): void {
    const modeMap: Record<string, ClaudeControlMode> = {
      plan: "plan",
      default: "default",
      acceptEdits: "acceptEdits",
      bypassPermissions: "bypassPermissions",
    };
    const newMode = modeMap[mode];
    if (!newMode || newMode === this.currentControlMode) return;

    const previousMode = this.currentControlMode;
    this.writeEngineLog("info", `permissionMode changed via system.status: ${previousMode} → ${newMode}`);

    // 更新 session 控制模式
    this.applyControlMode(newMode);

    // 通知前端同步 planMode / accessMode UI 状态
    const isPlan = newMode === "plan";
    emit({
      ts: Date.now(),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId as any,
      engine: "claude",
      type: "approval.resolved",
      payload: {
        requestId: `auto_mode_${Date.now()}`,
        approved: true,
        nextPlanMode: isPlan,
        nextAccessMode: isPlan ? undefined : (newMode === "bypassPermissions" ? "full-access" : "current"),
      },
    });
  }

  /**
   * 运行中应用用户显式修改的计划/执行模式。
   * 目标模式基于当前回合真实状态推导：退出计划恢复进入前的模式，执行模式变更沿当前 profile。
   */
  async applyPermissionPrefs(patch: { planMode?: boolean | null; accessMode?: AccessMode | null }): Promise<void> {
    // 串行化并发偏好写入，保证最终 CLI 模式对应用户最后一次选择。
    const task = this.permissionSwitchTail.then(() => this.applyPermissionPrefsNow(patch));
    this.permissionSwitchTail = task.catch(() => {});
    return task;
  }

  /** 人工权限变更先按当前凭据短段复核，再在许可外发送控制请求。 */
  private async applyPermissionPrefsNow(patch: { planMode?: boolean | null; accessMode?: AccessMode | null }): Promise<void> {
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    const hasPlan = patch.planMode !== undefined;
    const hasAccess = patch.accessMode !== undefined;
    if (!hasPlan && !hasAccess) return;
    // 计划模式优先：计划中修改执行模式不立即生效，与设置面板提示一致。
    if (!hasPlan && this.currentControlMode === "plan") return;

    let target: ClaudeControlMode;
    if (hasPlan && Boolean(patch.planMode)) {
      target = "plan";
    } else if (hasPlan) {
      target = hasAccess
        ? this.resolveRuntimeControlMode(patch.accessMode ?? "current")
        // 退出计划模式回到进入前的真实模式，避免用持久化偏好放宽或收紧当前回合。
        : (this.prePlanControlMode ?? this.resolveRuntimeControlMode(this.currentDeclaredAccessMode));
    } else {
      target = this.resolveRuntimeControlMode(patch.accessMode ?? "current");
    }
    await this.switchControlMode(target, hasAccess ? (patch.accessMode ?? "current") : undefined);
  }

  /** 按当前回合真实 profile 把声明 accessMode 解析为 Claude 控制模式。 */
  private resolveRuntimeControlMode(accessMode: AccessMode): ClaudeControlMode {
    return resolveClaudeControlMode({
      planMode: false,
      accessMode,
      conversationProfile: this.currentConversationProfile,
    });
  }

  /** 通过 control_request 切换运行中会话的 permission mode；CLI 未回执或进程退出时显式失败。 */
  private async switchControlMode(mode: ClaudeControlMode, declaredAccessMode?: AccessMode): Promise<void> {
    if (mode === this.currentControlMode) {
      if (mode !== "plan" && declaredAccessMode !== undefined) this.currentDeclaredAccessMode = declaredAccessMode;
      return;
    }
    const active = this.active;
    const child = active?.child;
    if (!active || !child?.stdin?.writable || child.stdin.writableEnded || child.stdin.destroyed) {
      throw new Error("Claude 会话没有可写入的运行中进程，权限模式切换未生效");
    }
    const previousMode = this.currentControlMode;
    await this.requestClaudeControl(child, { subtype: "set_permission_mode", mode }, () => {
      // 超时后 CLI 仍完成切换时，用迟到回执校正本地模式，避免后续审批按旧模式决策。
      this.applyControlMode(mode);
      if (mode !== "plan" && declaredAccessMode !== undefined) this.currentDeclaredAccessMode = declaredAccessMode;
      this.writeEngineLog("warn", "late set_permission_mode ack applied", { mode });
    });
    this.applyControlMode(mode);
    if (mode !== "plan" && declaredAccessMode !== undefined) this.currentDeclaredAccessMode = declaredAccessMode;
    active.stdinLifecycle.activityRevision++;
    this.writeEngineLog("info", `permission mode switched via control_request: ${previousMode} → ${mode}`);
  }

  /** 统一维护控制模式迁移，避免各审批路径重复实现出现偏差。 */
  private applyControlMode(mode: ClaudeControlMode): void {
    const previous = this.currentControlMode;
    this.currentControlMode = mode;
    if (mode === "plan") {
      if (previous !== "plan") this.prePlanControlMode = previous;
    } else {
      this.prePlanControlMode = mode;
    }
  }

  /** 发送一次 control_request 并等待 CLI 按 request_id 回执；超时后短暂保留以校正迟到成功。 */
  private requestClaudeControl(
    child: ChildProcessWithoutNullStreams,
    request: Record<string, unknown>,
    onLateSuccess?: () => void,
  ): Promise<Record<string, unknown>> {
    const requestId = `${String(request.subtype)}:${randomUUID()}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let lateTimer: NodeJS.Timeout | null = null;
      const detachChildListeners = (): void => {
        child.off("close", onClose);
        child.off("error", onError);
      };
      const settle = (run: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        this.pendingControlResponses.delete(requestId);
        detachChildListeners();
        run();
      };
      const onClose = (): void => settle(() => reject(new Error(`Claude 进程已退出，控制请求未完成：${String(request.subtype)}`)));
      const onError = (error: Error): void => settle(() => reject(error));
      timer = setTimeout(() => {
        // 结束本次等待但保留回执入口：CLI 若稍后成功切换，迟到回执用于校正本地模式。
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        detachChildListeners();
        const pending = this.pendingControlResponses.get(requestId);
        if (pending) {
          pending.expired = true;
          pending.clearLate = () => {
            if (lateTimer) { clearTimeout(lateTimer); lateTimer = null; }
            this.pendingControlResponses.delete(requestId);
          };
          lateTimer = setTimeout(() => this.pendingControlResponses.delete(requestId), CLAUDE_LATE_CONTROL_RESPONSE_TTL_MS);
          lateTimer.unref?.();
        }
        reject(new Error(`Claude 控制请求超时：${String(request.subtype)}`));
      }, CLAUDE_CONTROL_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      child.once("close", onClose);
      child.once("error", onError);
      this.pendingControlResponses.set(requestId, {
        resolve: response => settle(() => resolve(response)),
        reject: error => settle(() => reject(error)),
        expired: false,
        onLateSuccess,
      });
      void writeClaudeStdinLine(child, JSON.stringify({ type: "control_request", request_id: requestId, request }))
        .catch(error => settle(() => reject(error)));
    });
  }

  /** 响应 Claude AskUserQuestion（由 Web → Server → Client 调用链触发，通过 control_response 写回 stdin）。 */
  async respondUserInput(requestId: number | string, answers: RequestUserInputResponse["answers"]): Promise<void> {
    (await this.withDatabase(() => this.assertNewOperationCredential()));
    const key = String(requestId);
    this.writeEngineLog("info", `respondUserInput called`, {
      requestId: key,
      pendingKeys: Array.from(this.tool.pendingUserInputByRequestId.keys()),
      claudeResultReceived: this.tool.claudeResultReceived,
      hasActiveChild: Boolean(this.active?.child),
      stdinWritable: Boolean(this.active?.child?.stdin?.writable),
      answerCount: Object.keys(answers).length,
    });

    const toolUseId = this.tool.pendingUserInputByRequestId.get(key);
    if (!toolUseId) {
      const err = `AskUserQuestion request 不存在或已处理: ${key}`;
      this.writeEngineLog("error", `respondUserInput FAILED: ${err}`);
      throw new Error(err);
    }
    const child = this.active?.child;
    if (!child?.stdin?.writable) {
      const err = "Claude stdin 不可写（进程可能已退出）";
      this.writeEngineLog("error", `respondUserInput FAILED: ${err}`, { exitCode: child?.exitCode, killed: child?.killed });
      throw new Error(err);
    }

    // 查找 control protocol 的 request_id（由 control_request 事件注册）
    const controlRequestId = this.tool.controlRequestIdByToolUseId.get(toolUseId);
    const originalInput = this.tool.controlRequestInputByToolUseId.get(toolUseId) as any;

    if (!controlRequestId) {
      const err = `control_request request_id not found for toolUseId=${toolUseId} (control_request 可能未到达)`;
      this.writeEngineLog("error", `respondUserInput FAILED: ${err}`, {
        controlRequestKeys: Array.from(this.tool.controlRequestIdByToolUseId.keys()),
      });
      throw new Error(err);
    }

    // 构建 answers：control_response 需要 Record<questionText, answerText>
    // 我们的前端发送 {q_0: {answers: ["选项"]}, q_1: {answers: ["选项"]}}，需要转换为 {"问题文本": "选项文本"}
    const originalQuestions = Array.isArray(originalInput?.questions) ? originalInput.questions : [];
    const controlAnswers: Record<string, string> = {};
    for (const [qKey, val] of Object.entries(answers)) {
      const answerText = Array.isArray((val as any)?.answers) ? (val as any).answers.join(", ") : String(val ?? "");
      // qKey 格式为 q_0, q_1, ... → 提取 index 找到原始问题文本
      const idx = parseInt(qKey.replace("q_", ""), 10);
      const questionText = originalQuestions[idx]?.question ?? qKey;
      controlAnswers[questionText] = answerText;
    }

    // 构造 control_response（--permission-prompt-tool stdio 协议）
    const controlResponse = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: controlRequestId,
        response: {
          behavior: "allow",
          updatedInput: {
            questions: originalQuestions,
            answers: controlAnswers,
          },
        },
      },
    };

    const responseJson = JSON.stringify(controlResponse);
    this.writeEngineLog("info", `respondUserInput writing control_response to stdin`, {
      controlRequestId,
      toolUseId,
      responseLength: responseJson.length,
      answerCount: Object.keys(controlAnswers).length,
    });

    // 保存旧的 result 状态，用于判断 Claude 是否已完成当前 turn
    const hadResultBefore = this.tool.claudeResultReceived;

    const stdinLifecycle = this.active?.stdinLifecycle;
    try {
      await writeClaudeStdinLine(child, responseJson);
    } catch (error) {
      this.writeEngineLog("error", "respondUserInput control_response write failed", () => ({
        code: "CLAUDE_USER_INPUT_RESPONSE_WRITE_FAILED",
        requestId: key,
        toolUseId,
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        turnId: this.active?.turnId ?? null,
        rootCause: engineDiagnosticCause(error),
      }), { reason: error });
      throw error;
    }
    const hadSettledResult = hadResultBefore || this.tool.claudeResultReceived;
    // Claude 会产生新响应：写入确认后再重置 result，失败时保留 pending 请求供重试。
    this.tool.claudeResultReceived = false;
    if (stdinLifecycle) stdinLifecycle.activityRevision++;
    const responseRevision = stdinLifecycle?.activityRevision;
    this.tool.pendingUserInputByRequestId.delete(key);
    this.tool.controlRequestIdByToolUseId.delete(toolUseId);
    this.tool.controlRequestInputByToolUseId.delete(toolUseId);
    const pendingRemaining = this.tool.pendingUserInputByRequestId.size + this.tool.pendingApprovalByRequestId.size;
    this.writeEngineLog("info", `respondUserInput control_response written, pendingRemaining=${pendingRemaining}, hadResultBefore=${hadSettledResult}`);

    // 注意：不在此处推进 messageCycle。stream processor 在收到 AskUserQuestion 的 tool_result 时
    // 会调用 advanceCycle()（统一管理 cycle 推进 + assistantSoFar 重置）。

    this.emitters?.conversation({
      ts: Date.now(),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId as any,
      engine: "claude",
      type: "userInput.resolved",
      payload: { response: { requestId, answers } },
    });

    // 安全网：如果 result 事件在用户提交前已经到达（Claude 已完成当前 turn），
    // 且现在没有更多 pending 请求，Claude 可能不会再发新 result 事件（忽略了这个迟到的 control_response）。
    // 此时需要延迟关闭 stdin，否则进程永远不退出，会话永久卡住。
    if (hadSettledResult && pendingRemaining === 0 && stdinLifecycle && !stdinLifecycle.hasPendingWork) {
      const SAFETY_CLOSE_MS = 5_000;
      const safetyToken = this.lifecycleToken;
      const safetyChild = child;
      const safetyActive = this.active;
      this.writeEngineLog("warn", `respondUserInput: result was already received and no more pending → scheduling safety stdin close in ${SAFETY_CLOSE_MS}ms`);
      const safetyTimer = setTimeout(() => {
        if (safetyToken !== this.lifecycleToken) return;
        if (this.active?.child !== safetyChild) return;
        try {
        // 再次检查：如果 Claude 确实产生了新响应（claudeResultReceived 被 result handler 重新设为 true），
        // 说明 control_response 被正常处理了，不需要强制关闭。
        if (this.tool.claudeResultReceived) {
          this.writeEngineLog("info", "respondUserInput safety close: Claude produced new result, skipping forced close");
          return;
        }
        if (this.active?.child !== safetyChild) return;
        if (stdinLifecycle.activityRevision !== responseRevision || stdinLifecycle.hasPendingWork
          || this.tool.pendingUserInputByRequestId.size > 0 || this.tool.pendingApprovalByRequestId.size > 0) return;
        if (safetyChild.stdin?.writable) {
          this.writeEngineLog("warn", "respondUserInput safety close: no activity after late answer → closing stdin", {
            code: "CLAUDE_LATE_ANSWER_STDIN_CLOSE", requestId: key,
            threadId: this.opts.threadId, turnId: this.active.turnId,
            rootCause: "settled_result_before_answer_without_followup_activity",
          });
          safetyChild.stdin.end();
        }
        } catch (error) { safetyActive?.fail(error); }
      }, SAFETY_CLOSE_MS);
      safetyTimer?.unref?.();
    }
  }

  /** 先确认进程树停止，再释放提示和工具桥；释放失败保留 owner 供显式重试。 */
  async dispose(options?: import("../threadSession.js").ThreadDisposeOptions): Promise<void> {
    this.lifecycleToken += 1;
    const owner = this.promptOwner;
    const sendBoundary = this.sendBoundary;
    if (sendBoundary && !this.active) sendBoundary.cancellation ??= Object.assign(new Error("Claude 准备已被关闭撤销"), {
      code: "CLAUDE_PROMPT_DISPATCH_INVALIDATED", requestId: owner?.requestId ?? `claude-dispose:${randomUUID()}`, retryable: false,
    });
    try {
    if (sendBoundary && !this.active) {
      if (sendBoundary.stopFailed && !sendBoundary.facts?.closed) { sendBoundary.stopping = null; sendBoundary.stopFailed = false; }
      try { await (sendBoundary.stopping ??= this.stopStartingProcess(sendBoundary)); }
      catch (error) { sendBoundary.stopFailed = true; throw error; }
    }
    const active = this.active;
    if (active) await this.interruptWithReason(active.turnId, "dispose");
    if (owner) {
      await owner.dispose();
      if (this.promptOwner === owner) this.promptOwner = null;
    }
    const flushActiveTurn = options?.flushActiveTurn !== false;
    if (active) {
      await active.drainStdout();
      if (flushActiveTurn && this.activeTurnSettled) {
        if (!await waitForClaudeTurnClose(this.activeTurnSettled, 3_000)) {
          throw Object.assign(new Error("Claude 关闭收尾尚未确认"), { code: "CLAUDE_DISPOSE_UNCONFIRMED", retryable: false });
        }
      }
    }
    this.emitters = null;
    this.assistantLifecycle.clear();
    this.activeTurnSettled = null;
    this.streamState = null;
    this.tool = createToolState();
    this.currentPlatformToolNames = new Set();
    this.inputActionCatalog = null;
    if (sendBoundary) {
      const result = await sendBoundary.settled;
      if (sendBoundary.platformToolBridge) {
        await sendBoundary.platformToolBridge.dispose();
        sendBoundary.platformToolBridge = null;
      }
      if (this.sendBoundary === sendBoundary) this.sendBoundary = null;
      const callbackFailed = this.callbackFailed;
      this.callbackFailed = false;
      if (callbackFailed && result.status === "rejected") throw result.reason;
    }
    } catch (error) {
      const requestId = owner?.requestId ?? `claude-dispose:${randomUUID()}`;
      try {
        this.writeEngineLog("error", "Claude explicit disposal failed", {
          code: "CLAUDE_DISPOSE_FAILED", errorCode: "CLAUDE_DISPOSE_FAILED", requestId,
          workspaceId: this.opts.workspaceId, threadId: this.opts.threadId, turnId: owner?.turnId ?? this.active?.turnId ?? null,
          stage: "explicit_dispose", event: { category: "engine", action: "dispose", outcome: "fail" },
          rootCause: summarizeClaudePromptPreparationCause(error),
        });
      } catch (loggingError) {
        throw combineClaudeResourceFailure({ error }, [loggingError], "CLAUDE_DISPOSE_FAILED", requestId);
      }
      throw error;
    }
  }

  /** 判断当前控制请求是否命中本轮注册的平台工具。 */
  private isCurrentPlatformToolName(toolName: string): boolean {
    return isClaudePlatformToolName(toolName, this.currentPlatformToolNames);
  }

  private setSessionId(sessionId: SessionId, emit: ConversationEmitFn): void {
    if (this.sessionId === sessionId) return;
    this.inputActionCatalog = null;
    this.sessionId = sessionId;
    this.opts.onSessionId(sessionId);
    const event: ConversationEventInput = {
      ts: Date.now(),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId as any,
      engine: "claude",
      type: "thread.started",
      payload: { sessionId },
    };
    emit(event);
  }

  /** Atomically replaces or clears the current generation's Claude Slash catalog. */
  private observeInputActionCatalog(value: unknown, generation: number): void {
    if (generation !== this.lifecycleToken) return;
    const snapshot = parseClaudeInputActionCatalog(value, generation);
    if (!snapshot || snapshot.sessionId !== this.sessionId) {
      this.inputActionCatalog = null;
      this.writeEngineLog("error", "input action catalog init invalid", {
        code: "THREAD_INPUT_ACTION_CATALOG_FAILED",
        requestId: null,
        workspaceId: this.opts.workspaceId,
        threadId: this.opts.threadId,
        sessionId: this.sessionId,
        generation,
        rootCause: "invalid_system_init_catalog",
      });
      return;
    }
    this.inputActionCatalog = snapshot;
  }

  private handleBackgroundShellTaskStarted(task: ClaudeBackgroundShellTaskMeta): void {
    const snapshot = buildClaudeEngineProcessSnapshot({
      taskId: task.taskId,
      description: task.description,
      command: task.command,
      workingDirectory: this.opts.workspacePath,
      startedAt: task.startedAt,
      status: "ready",
      readySummary: "后台运行中",
      readyAt: task.startedAt,
      exitedAt: null,
      exitCode: null,
    });
    this.publishEngineProcessSnapshot(snapshot);
  }

  private handleBackgroundShellTaskCompleted(task: ClaudeBackgroundShellTaskMeta & { status: "completed" | "failed" | "stopped"; summary: string }): void {
    const exitedAt = Date.now();
    const status = task.status === "stopped" ? "stopped" : "exited";
    const snapshot = buildClaudeEngineProcessSnapshot({
      taskId: task.taskId,
      description: task.description,
      command: task.command,
      workingDirectory: this.opts.workspacePath,
      startedAt: task.startedAt,
      status,
      readySummary: task.summary || (status === "stopped" ? "已停止" : "已退出"),
      readyAt: task.startedAt,
      exitedAt,
      exitCode: null,
    });
    this.publishEngineProcessSnapshot(snapshot);
  }

  private publishEngineProcessSnapshot(snapshot: ManagedServiceSnapshot): void {
    const changed = this.opts.onEngineProcessSnapshot(snapshot);
    if (!changed) return;
    this.emitters?.conversation({
      ts: Date.now(),
      workspaceId: this.opts.workspaceId,
      threadId: this.opts.threadId as any,
      engine: "claude",
      type: "thread.process.changed",
      payload: {
        serviceId: snapshot.serviceId,
        source: "engine",
        status: snapshot.status,
      },
    } satisfies ConversationEventInput);
  }
}

function normalizeAutoCompactPct(value: number | null | undefined): number {
  const normalized = Number(value ?? PRODUCT_DEFAULT_AUTO_COMPACT_PCT);
  if (!Number.isFinite(normalized) || normalized < 50 || normalized > 99) {
    return PRODUCT_DEFAULT_AUTO_COMPACT_PCT;
  }
  return Math.round(normalized);
}

/** 写入前关闭可安全重排；调用 write 后的失败视为接收结果未知，禁止自动重发。 */
function writeClaudeStdinLine(child: ChildProcessWithoutNullStreams, line: string): Promise<void> {
  const stdin = child.stdin;
  if (!stdin.writable || stdin.writableEnded || stdin.destroyed) {
    return Promise.reject(new ActiveTurnInputClosedError());
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      stdin.off("error", onError);
      if (error !== undefined && error !== null) reject(Object.assign(new Error(error instanceof Error ? error.message : "Claude stdin 写入结果未知，禁止自动重发", { cause: error }), { requestOutcomeUnknown: true }));
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    stdin.once("error", onError);
    try {
      stdin.write(line + "\n", "utf8", finish);
    } catch (error) {
      if (settled) return;
      settled = true;
      stdin.off("error", onError);
      reject(Object.assign(new Error(error instanceof Error ? error.message : "Claude stdin 写入结果未知，禁止自动重发", { cause: error }), { requestOutcomeUnknown: true }));
    }
  });
}

/** 等待 close（含 stdio 关闭），避免停止响应抢在 session active 清理之前返回。 */
async function waitForClaudeTurnClose(settled: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 同步建立唯一 owner；准备、句柄关闭与固定文件释放均保留在同一闭包。 */
function createClaudeAppendSystemPromptFile(
  content: string | null | undefined,
  turnId: TurnId,
): ClaudeTempPromptFile | null {
  const text = String(content ?? "").trim();
  if (!text) return null;
  const requestId = `claude-prompt:${randomUUID()}`;
  let parent = "";
  let parentReal: string;
  let parentStat: fs.Stats;
  let directory: string | null = null, filePath: string | null = null;
  let directoryStat: fs.Stats | null = null, fileStat: fs.Stats | null = null;
  let handle: fsp.FileHandle | null = null;
  let fileOwned = false, fileRemoved = false, released = false;
  let child: ChildProcessWithoutNullStreams | null = null, facts: ClaudeChildFacts | null = null;
  let deadline: number | null = null, stopAttempted = false;
  let flight: Promise<void> | null = null;
  let startPreparation!: () => void;
  const preparation = new Promise<void>(resolve => { startPreparation = resolve; });
  const ready = (async () => {
    await preparation;
    parent = path.resolve(os.tmpdir());
    parentReal = await fsp.realpath(parent);
    parentStat = await fsp.stat(parent);
    directory = await fsp.mkdtemp(path.join(parent, "codeflowai-claude-system-prompt-"));
    filePath = path.join(directory, "append-system-prompt.txt");
    directoryStat = await fsp.lstat(directory);
    handle = await fsp.open(filePath, "wx");
    fileOwned = true;
    fileStat = await handle.stat();
    await handle.writeFile(text, "utf8");
    await handle.close();
    handle = null;
  })().then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));

  /** 身份不符时保留现场，禁止沿替换路径删除或扩大删除范围。 */
  const verifyDirectory = async () => {
    if (!directory || !directoryStat || path.dirname(directory) !== parent
      || await fsp.realpath(parent) !== parentReal || !sameClaudePromptIdentity(await fsp.stat(parent), parentStat)) throw promptIdentityError(requestId);
    const current = await fsp.lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameClaudePromptIdentity(current, directoryStat)
      || await fsp.realpath(directory) !== path.join(parentReal, path.basename(directory))) throw promptIdentityError(requestId);
  };

  /** 首次释放共享 5000ms close 截止；每个成功步骤可在显式重试时复用。 */
  const release = async () => {
    deadline ??= Date.now() + 5_000;
    await ready;
    if (released) return;
    const stopErrors: unknown[] = [];
    if (child && facts && !facts.closed) {
      if (!stopAttempted) {
        stopAttempted = true;
        try {
          if (!child.kill()) stopErrors.push(Object.assign(new Error("Claude 停止请求未被接受"), { code: "CLAUDE_PROMPT_STOP_FAILED", requestId }));
        } catch (error) { stopErrors.push(error); }
      }
      if (!await waitForClaudeTurnClose(facts.close.then(() => undefined), Math.max(0, deadline - Date.now()))) {
        const error = Object.assign(new Error("Claude close 尚未确认，提示文件保留且禁止自动重发"), {
          code: "CLAUDE_PROMPT_CLOSE_UNCONFIRMED", requestId, retryable: false,
        });
        throw combineClaudeResourceFailure({ error }, stopErrors, error.code, requestId);
      }
    }
    try {
      if (handle) {
        fileStat ??= await handle.stat();
        await handle.close();
        handle = null;
      }
      if (directory) {
        await verifyDirectory();
        if (fileOwned && !fileRemoved) {
          const current = await fsp.lstat(filePath!);
          if (!fileStat || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
            || !sameClaudePromptIdentity(current, fileStat)
            || await fsp.realpath(filePath!) !== path.join(parentReal, path.basename(directory), "append-system-prompt.txt")) throw promptIdentityError(requestId);
          await fsp.unlink(filePath!);
          fileRemoved = true;
        }
        await verifyDirectory();
        await fsp.rmdir(directory);
      }
      released = true;
    } catch (error) {
      throw combineClaudeResourceFailure({ error }, stopErrors, "CLAUDE_PROMPT_RELEASE_FAILED", requestId);
    }
    if (stopErrors.length) throw combineClaudeResourceFailure(undefined, stopErrors, "CLAUDE_PROMPT_STOP_FAILED", requestId);
  };
  return {
    get path() { return filePath; }, requestId, turnId, ready, prepare: startPreparation,
    bindChild: (value, observation) => { child = value; facts = observation; },
    dispose: () => {
      if (flight) return flight;
      flight = release();
      const current = flight;
      void current.then(() => { if (flight === current) flight = null; }, () => { if (flight === current) flight = null; });
      return current;
    },
  };
}

/** 固定文件及目录只按同一设备与 inode 判断身份。 */
function sameClaudePromptIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** 身份异常不披露正文，并保留可检索的本次请求标识。 */
function promptIdentityError(requestId: string): Error {
  return Object.assign(new Error("Claude 提示文件资源身份变化，已保留现场"), { code: "CLAUDE_PROMPT_IDENTITY_CHANGED", requestId });
}

/** 主错有无独立判别；没有副错时保持 frozen/falsy 原对象。 */
function combineClaudeResourceFailure(primary: { error: unknown } | undefined, secondary: unknown[], code: string, requestId: string): unknown {
  if (primary && secondary.length === 0) return primary.error;
  if (!primary && secondary.length === 1) return secondary[0];
  const errors = primary ? [primary.error, ...secondary] : secondary;
  const unknownDelivery = types.isNativeError(primary?.error) && Object.getOwnPropertyDescriptor(primary.error, "requestOutcomeUnknown")?.value === true;
  const nonRetryable = unknownDelivery || errors.some(error => types.isNativeError(error) && Object.getOwnPropertyDescriptor(error, "retryable")?.value === false);
  return Object.assign(new AggregateError(errors, `Claude 资源收尾失败（requestId=${requestId}）`, { cause: errors[0] }), {
    code, requestId, ...(unknownDelivery ? { requestOutcomeUnknown: true } : {}), ...(nonRetryable ? { retryable: false } : {}),
  });
}

/** spawn 返回后同步登记 error/close；所有消费者共享不可丢失的事件事实。 */
function observeClaudeChild(child: ChildProcessWithoutNullStreams): ClaudeChildFacts {
  let closed = false, errorObserved = false;
  let resolveClose!: (exit: ClaudeChildExit) => void, resolveError!: (error: { error: unknown }) => void;
  let resolveFirst!: (fact: Awaited<ClaudeChildFacts["first"]>) => void;
  const close = new Promise<ClaudeChildExit>(resolve => { resolveClose = resolve; });
  const error = new Promise<{ error: unknown }>(resolve => { resolveError = resolve; });
  const first = new Promise<Awaited<ClaudeChildFacts["first"]>>(resolve => { resolveFirst = resolve; });
  child.on("error", (reason: unknown) => {
    if (errorObserved) return;
    errorObserved = true;
    resolveError({ error: reason });
    resolveFirst({ kind: "error", error: reason });
  });
  child.once("close", (code, signal) => {
    closed = true;
    const exit = { code, signal };
    resolveClose(exit);
    resolveFirst({ kind: "close", exit });
  });
  return { get closed() { return closed; }, close, error, first };
}

/** 只保留系统错误字段，避免提示正文及异常私文进入资源清理日志。 */
function summarizeClaudePromptPreparationCause(error: unknown): Record<string, unknown> {
  if (!types.isNativeError(error)) return { kind: typeof error };
  const code = Object.getOwnPropertyDescriptor(error, "code"), syscall = Object.getOwnPropertyDescriptor(error, "syscall");
  return {
    kind: "Error",
    ...(code && "value" in code && typeof code.value === "string" ? { code: code.value } : {}),
    ...(syscall && "value" in syscall && typeof syscall.value === "string" ? { syscall: syscall.value } : {}),
  };
}

function createClaudeManualInterruptError(): Error & {
  code?: string;
  terminationKind?: "manual_interrupt";
} {
  const error = new Error("turn interrupted") as Error & {
    code?: string;
    terminationKind?: "manual_interrupt";
  };
  error.code = MANUAL_TURN_INTERRUPT_CODE;
  error.terminationKind = "manual_interrupt";
  return error;
}

function resolveClaudeDeclaredAccessModeAfterApproval(opts: {
  toolName: string;
  previousAccessMode: AccessMode;
  approval: ReturnType<typeof buildClaudeApprovalResponse>;
}): AccessMode {
  if (isExitPlanModeTool(opts.toolName)) {
    if (opts.approval.clearContextRequested) {
      return opts.approval.followUp?.accessMode ?? opts.previousAccessMode;
    }
    if (opts.approval.nextMode === "bypassPermissions") return "full-access";
    if (opts.approval.nextMode === "acceptEdits" || opts.approval.nextMode === "default") return "current";
  }
  return opts.previousAccessMode;
}

function mergePromptBlocks(blocks: Array<string | null | undefined>): string | null {
  const parts = blocks
    .map((block) => String(block ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

/** 生成 Claude `--input-format stream-json` 的“脱敏单行 JSON”（仅用于排障展示与落库）。 */
function buildClaudeStreamJsonTraceLine(opts: {
  text: string;
  images: string[];
  inputKind?: SendMessageInput["inputKind"];
}): string {
  const rawText = String(opts.text ?? "");
  const effectiveInputKind = opts.inputKind ?? resolveLegacyEffectiveInputKind(rawText, opts.images);
  if (effectiveInputKind === "provider-slash") {
    const text = opts.inputKind === "provider-slash" ? rawText : rawText.trim();
    return JSON.stringify({ type: "user", message: { role: "user", content: text } });
  }
  const content: Array<Record<string, unknown>> = [];

  for (const img of opts.images) {
    const trimmed = String(img ?? "").trim();
    if (!trimmed) continue;

    const dataUrl = parseDataUrlHead(trimmed);
    if (dataUrl) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: dataUrl.mediaType, data: `<base64 omitted chars=${dataUrl.base64Chars}>` },
      });
      continue;
    }

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      content.push({ type: "image", source: { type: "url", url: trimmed } });
      continue;
    }

    content.push({
      type: "image",
      source: { type: "base64", media_type: guessMediaTypeFromPath(trimmed), data: `<file omitted path=${trimmed}>` },
    });
  }

  const text = String(opts.text ?? "").trim();
  if (text) content.push({ type: "text", text });

  return JSON.stringify({ type: "user", message: { role: "user", content } });
}

/** 解析 data URL 的 mediaType 与 base64 长度（仅用于脱敏展示）。 */
function parseDataUrlHead(dataUrl: string): { mediaType: string; base64Chars: number } | null {
  if (!dataUrl.startsWith("data:")) return null;
  const idx = dataUrl.indexOf(",");
  if (idx < 0) return null;
  const head = dataUrl.slice(5, idx);
  const base64Data = dataUrl.slice(idx + 1);
  if (!/;base64$/i.test(head)) return null;
  const mediaType = head.replace(/;base64$/i, "").trim() || "image/png";
  return { mediaType, base64Chars: base64Data.length };
}

/** 根据文件后缀猜测图片 media type（用于脱敏展示，不影响真实发送）。 */
function guessMediaTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

type ClaudeCredentialReader = (providerId: EngineModelProviderId) => EngineCredentialConfig | null;
type ClaudeModelProviderResolver = (model: string | null | undefined) => EngineModelProviderId | null;

const CLAUDE_PROVIDER_MANAGED_ENV_KEYS = [
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_SUBAGENT_MODEL",
 "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_REASONING_MODEL",
 "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_MODEL_CAPABILITIES",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "MAX_THINKING_TOKENS",
] as const;

/** 按实际 Claude 命令隔离环境，再合并模型 runtime env、凭据和平台启动标记。 */
export function buildClaudeChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  opts: {
    command?: string;
    dangerouslySkipPermissions: boolean;
    model?: string | null;
    contextWindow?: number | null;
    providerId?: EngineModelProviderId | null;
    readCredentials?: ClaudeCredentialReader;
    hasConfiguredCredentials?: (providerId: EngineModelProviderId) => boolean;
  },
): NodeJS.ProcessEnv {
  const env = buildClientChildProcessEnv(baseEnv, opts.command);

  const providerId = resolveClaudeProviderId(opts.model, opts.providerId);
  const hasManagedCredentials = Boolean(opts.hasConfiguredCredentials?.(providerId));
  if (hasManagedCredentials) {
    for (const key of CLAUDE_PROVIDER_MANAGED_ENV_KEYS) delete env[key];
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  }

  const modelRuntimeEnv = resolveClaudeProviderRuntimeEnv(providerId, opts.model, opts.contextWindow);
  Object.assign(env, modelRuntimeEnv);

  if (hasManagedCredentials) {
    // 让 Claude Code 忽略用户 settings/env 里的 provider/model/auth 覆盖，凭据以本次子进程注入为准。
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
    const credentials = opts.readCredentials?.(providerId) ?? null;
    if (!credentials?.apiKey) {
      throw new Error(`当前模型需要 ${getEngineProviderLabel(providerId)} Key，请到“大模型KEY设置”新增或启用对应供应商 Key。`);
    }
    if (credentials.apiKey) env.ANTHROPIC_AUTH_TOKEN = credentials.apiKey;
    if (credentials.baseUrl) {
      env.ANTHROPIC_BASE_URL = credentials.baseUrl;
    } else {
      delete env.ANTHROPIC_BASE_URL;
    }
    if (isExternalClaudeProvider(providerId) && !String(env.ANTHROPIC_BASE_URL ?? "").trim()) {
      throw new Error(`${getEngineProviderLabel(providerId)} 需要先在 Claude 凭据中配置 Anthropic Base URL。`);
    }
  } else if (Object.keys(modelRuntimeEnv).length > 0) {
    const credentials = readEngineConfig("claude");
    applyLegacyClaudeCredentials(env, credentials, providerId);
  }

  const enableToolSearch = String(baseEnv.CODEFLOWAI_CLAUDE_ENABLE_TOOL_SEARCH ?? "").trim();
  if (enableToolSearch) env.ENABLE_TOOL_SEARCH = enableToolSearch;

  // 清除 Claude Code 嵌套会话检测标记：父进程可能从 Claude Code 终端启动，
  // 子进程不应继承这些标记，否则 Claude Code 会误判为嵌套会话而拒绝启动。
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  // 过滤敏感环境变量：避免子进程获取到不必要的凭据
  delete env.CODEFLOWAI_API_KEY;
  delete env.CODEFLOWAI_DEV_BYPASS_KEY_SERVICE;

  if (shouldClaudeForceSandboxEnv({
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    env,
  })) {
    env.IS_SANDBOX = "1";
  }

  // 产品固定使用 1h prompt cache，覆盖父进程中的强制 5m 与缓存禁用开关。
  Object.assign(env, CLAUDE_FIXED_PROMPT_CACHING_ENV);
  Object.assign(env, resolveClaudeModelSettingsEnv(opts.model, opts.contextWindow));

  // Windows：stream-json 模式触发 Claude Code 的 bash 初始化。
  // 复现 Claude Code 源码中的检测逻辑：找 git → 推导 ../../bin/bash.exe，预设环境变量。
  if (process.platform === "win32" && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    const bashPath = resolveGitBashPath(env);
    if (bashPath) env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
  }

  return env;
}

/** 解析 Claude 子进程本次应使用的 provider，优先使用调用方冻结值。 */
function resolveClaudeProviderId(model: string | null | undefined, explicitProviderId?: EngineModelProviderId | null): EngineModelProviderId {
  if (isEngineProviderAllowed("claude", explicitProviderId)) return explicitProviderId;
  const providerId = resolveRuntimeEngineModelProviderId("claude", model);
  return isEngineProviderAllowed("claude", providerId)
    ? providerId
    : getDefaultEngineProviderId("claude");
}

/** 非 Anthropic Claude 兼容 provider 必须带 Base URL，避免误打官方 Anthropic 地址。 */
function isExternalClaudeProvider(providerId: EngineModelProviderId): boolean {
  return providerId !== "anthropic";
}

/** 解析本次 Claude 兼容 provider 的模型环境，未知自定义模型按单模型接入兜底。 */
function resolveClaudeProviderRuntimeEnv(providerId: EngineModelProviderId, model: string | null | undefined, contextWindow?: number | null): Record<string, string> {
  const modelRuntimeEnv = resolveClaudeModelRuntimeEnv(model, contextWindow);
  if (Object.keys(modelRuntimeEnv).length > 0 || !isExternalClaudeProvider(providerId)) return modelRuntimeEnv;
  const launchModel = resolveClaudeLaunchModelId(model, contextWindow);
  return launchModel ? buildSingleModelProviderRuntimeEnv(launchModel) : {};
}

/** 旧配置路径仅在模型需要 provider env 时启用，并按 provider 做必填校验。 */
function applyLegacyClaudeCredentials(env: NodeJS.ProcessEnv, credentials: EngineCredentialConfig, providerId: EngineModelProviderId): void {
  if (credentials.apiKey) env.ANTHROPIC_AUTH_TOKEN = credentials.apiKey;
  if (credentials.baseUrl) env.ANTHROPIC_BASE_URL = credentials.baseUrl;
  const hasBaseUrl = Boolean(String(env.ANTHROPIC_BASE_URL ?? "").trim());
  const hasAuth = Boolean(String(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "").trim());
  if (!hasBaseUrl) {
    throw new Error(`${getEngineProviderLabel(providerId)} 需要先在 Claude 凭据中配置 Anthropic Base URL。`);
  }
  if (!hasAuth) {
    throw new Error(`${getEngineProviderLabel(providerId)} 需要先在 Claude 凭据中配置 API Key。`);
  }
}

function withErrorCode<T extends Error>(error: T, code: string): T & { code: string } {
  (error as T & { code: string }).code = code;
  return error as T & { code: string };
}

function buildClaudeEngineProcessSnapshot(input: {
  taskId: string;
  description: string;
  command: string;
  workingDirectory: string;
  startedAt: number;
  status: "ready" | "exited" | "stopped";
  readySummary: string;
  readyAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
}): ManagedServiceSnapshot {
  return {
    serviceId: `engine:claude:${input.taskId}`,
    displayName: formatClaudeEngineDisplayName(input.description, input.command, input.taskId),
    source: "engine",
    stopSupported: false,
    status: input.status,
    pid: null,
    command: input.command,
    args: [],
    workingDirectory: input.workingDirectory,
    startupTimeoutMs: 0,
    readySummary: input.readySummary,
    startedAt: input.startedAt,
    readyAt: input.readyAt,
    exitedAt: input.exitedAt,
    exitCode: input.exitCode,
    exitSignal: null,
  };
}

function formatClaudeEngineDisplayName(description: string, command: string, taskId: string): string {
  const preferred = String(description ?? "").trim() || String(command ?? "").trim();
  if (preferred) {
    return preferred.length > 48 ? `${preferred.slice(0, 45)}...` : preferred;
  }
  const shortId = String(taskId ?? "").trim();
  return shortId ? `后台命令 ${shortId.slice(-12)}` : "后台命令";
}

/** Windows：从 PATH 中的 git 可执行文件推导 bash.exe 路径（与 Claude Code 内部逻辑一致）。 */
function resolveGitBashPath(env: NodeJS.ProcessEnv): string | null {
  // env 可能是 spread 后的普通对象，key 大小写敏感：PowerShell 下为 "Path"，git-bash 下为 "PATH"。
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const pathEnv = String(env[pathKey] ?? "");
  const parts = pathEnv.split(path.delimiter).filter(Boolean);

  // 1. 在 PATH 中找 git.exe / git.cmd
  for (const dir of parts) {
    for (const name of ["git.exe", "git.cmd"]) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full)) {
          // Claude Code 逻辑：从 git 可执行文件路径向上两级 → bin/bash.exe
          const bashPath = path.join(full, "..", "..", "bin", "bash.exe");
          const resolved = path.resolve(bashPath);
          if (fs.existsSync(resolved)) return resolved;
        }
      } catch {
        // ignore
      }
    }
  }

  // 2. 兜底：常见安装路径
  const fallbacks = [
    path.join(String(env.ProgramFiles ?? "C:\\Program Files"), "Git", "bin", "bash.exe"),
    path.join(String(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"), "Git", "bin", "bash.exe"),
  ];
  for (const p of fallbacks) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }

  return null;
}
