import { MANUAL_TURN_INTERRUPT_CODE, type ConversationEventInput, type EngineType, type InterruptTurnResponseBody, type SessionId, type ThreadId, type TurnId, type WorkspaceId } from "@codeflowai/shared";
import { createTurnErrorEventInput } from "../errors/turnErrors.js";

import { emitTurnTerminalWithAssistantReconcile } from "../engines/turnTerminalEmitter.js";
import { engineDiagnosticCause, engineDiagnosticField, isEngineWorkspaceLogFailure, writeEngineWorkspaceLog,
  type ThreadEngineSession } from "../engines/threadSession.js";
import {
  THREAD_RUNTIME_STALE_CODE,
  type CodexDanglingTurnFailureResult,
  type CodexDanglingTurnReconcileResult,
} from "../engines/threadSessionManager.js";
import type { WorkspaceLogEntry } from "../logger.js";
import type { WsSendJsonResult } from "../transport/wsTransport.js";
import { scopeApiHandlerContext, type ApiHandlerContext } from "./handleApiRequest.js";
import { resolveThreadRunningState } from "./threadRunningState.js";
import { cancelOrdinaryTurnBeforeDispatch, isLocalOrdinaryTurnExecution, listOrdinaryTurnExecutions } from "./ordinaryTurnExecution.js";
import {
  findCodexClientUserMessageIdsFromHistory,
  findCodexProviderTurnIdentityFromHistory,
} from "./utils/codexTurnHistory.js";

type InterruptTurnOptions = {
  /** 调用方即将释放运行态时，强制补齐 turn.error 终态，避免异步 session 回调被 lifecycle 清理截断。 */
  ensureTerminalEvent?: boolean;
  /** 只在精确 provider/准备 owner 停止已确认时通知，完整 Promise 仍代表收尾。 */
  onStopConfirmed?: () => void;
};
type InterruptTarget = { turnId: TurnId; source: "active" | "db" | "pending" | "input" };
type TurnTerminalOutcome = "emitted" | "already_terminal";
type CompletedCodexReconcileResult = Extract<CodexDanglingTurnReconcileResult, { kind: "completed" }>;
type ErrorCodexReconcileResult = CodexDanglingTurnFailureResult & { kind: "error" };
type ManualTurnQueueTarget =
  | { source: "user_send" | "queue_consume"; queueItemId: string | null }
  | { source: "none"; queueItemId: null };
type TurnTerminalProgress = {
  status: "completed" | "error";
  stopConfirmed: boolean;
  terminalEvents: ConversationEventInput[] | null;
  nextTerminalEventIndex: number;
  afterTerminalEventsSettled: boolean;
  localIndexed: boolean;
  activeCleared: boolean;
  queueNotified: boolean;
  afterTerminalSettled: boolean;
  buildTerminalEvents: (() => Promise<ConversationEventInput[]>) | null;
  afterTerminalEvents: (() => Promise<void>) | null;
  notifyQueue: () => void;
  afterTerminal: (() => Promise<void>) | null;
  lastFailure?: { error: unknown };
};
const turnTerminalByKey = new Map<string, Promise<TurnTerminalOutcome>>();
const turnTerminalProgressByKey = new Map<string, TurnTerminalProgress>();
const pendingTurnTerminalIdByThreadKey = new Map<string, TurnId>();

/** 终态/中断只在同步数据库段持许可，provider与提交等待均在许可之外。 */
function accessDatabase<T>(ctx: ApiHandlerContext, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase("turn-interrupt", operation) : Promise.resolve(operation());
}

/** 中断诊断固定已核W；普通日志失败由共享入口告警，原业务错误仍由调用方处理。 */
function logInterrupt(ctx: ApiHandlerContext, level: WorkspaceLogEntry["level"], message: string,
  build: () => Record<string, unknown>, business: { reason: unknown }): void {
  if (ctx.db.workspaceId === null) throw new Error("TURN_INTERRUPT_WORKSPACE_REQUIRED", { cause: business.reason });
  const workspaceId = ctx.db.workspaceId;
  writeEngineWorkspaceLog(ctx.db.writeWorkspaceLog, workspaceId, () => ({ level, tag: "api", message,
    data: { requestId: `turn-interrupt:${workspaceId}`, ...build() } }), business);
}

/** 让 completed、普通 error 与 manual interrupt 竞争同一个 turn 终态 owner。 */
export async function settleTurnTerminalOnce(
  ctx: ApiHandlerContext,
  input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: TurnId;
    status: "completed" | "error";
    stopConfirmed?: boolean;
  },
  actions: {
    buildTerminalEvents: () => Promise<ConversationEventInput[]>;
    afterTerminalEvents?: () => Promise<void>;
    notifyQueue: () => void;
    afterTerminal?: () => Promise<void>;
  },
): Promise<TurnTerminalOutcome> {
  const key = buildTurnTerminalKey(input);
  let progress = turnTerminalProgressByKey.get(key) ?? null;
  const current = await accessDatabase(ctx, () => ctx.db.turns.get(input.turnId));
  if (!progress && current && current.status !== "started") {
    ctx.clearActiveThreadTurn?.({ threadId: input.threadId, turnId: input.turnId });
    return "already_terminal";
  }
  if (!progress) {
    const threadKey = buildTurnTerminalThreadKey(input);
    const pendingTurnId = pendingTurnTerminalIdByThreadKey.get(threadKey) ?? null;
    if (pendingTurnId && pendingTurnId !== input.turnId) {
      throw new Error(
        `当前 thread 已有待完成的终态（threadId=${input.threadId}, pendingTurnId=${pendingTurnId}, turnId=${input.turnId}）`,
      );
    }
    progress = {
      status: input.status,
      stopConfirmed: input.stopConfirmed === true,
      terminalEvents: null,
      nextTerminalEventIndex: 0,
      afterTerminalEventsSettled: false,
      localIndexed: false,
      activeCleared: false,
      queueNotified: false,
      afterTerminalSettled: false,
      buildTerminalEvents: actions.buildTerminalEvents,
      afterTerminalEvents: actions.afterTerminalEvents ?? null,
      notifyQueue: actions.notifyQueue,
      afterTerminal: actions.afterTerminal ?? null,
    };
    turnTerminalProgressByKey.set(key, progress);
    pendingTurnTerminalIdByThreadKey.set(threadKey, input.turnId);
  }

  return await runTurnTerminalSettlement(ctx, input, progress, key);
}

/** 复用同一 turn 的 singleflight，完成首次结算或失败后的固定阶段重试。 */
async function runTurnTerminalSettlement(
  ctx: ApiHandlerContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId },
  progress: TurnTerminalProgress,
  key: string,
): Promise<TurnTerminalOutcome> {
  const existing = turnTerminalByKey.get(key);
  if (existing) {
    await existing;
    return "already_terminal";
  }

  const settlement = Promise.resolve().then(
    async () => await completeTurnTerminal(ctx, input, progress, key),
  );
  turnTerminalByKey.set(key, settlement);
  try {
    return await settlement;
  } catch (error) {
    progress.lastFailure = { error };
    throw error;
  } finally {
    if (turnTerminalByKey.get(key) === settlement) turnTerminalByKey.delete(key);
  }
}

/** 暴露原终态进度的失败身份，供运行态查询显示；不创建独立失败状态。 */
export function getPendingTurnTerminalFailure(input: { workspaceId: WorkspaceId; threadId: ThreadId }): { turnId: TurnId; errorCode: string } | null {
  const turnId = pendingTurnTerminalIdByThreadKey.get(buildTurnTerminalThreadKey(input));
  if (!turnId) return null;
  const progress = turnTerminalProgressByKey.get(buildTurnTerminalKey({ ...input, turnId }));
  return progress?.lastFailure ? { turnId, errorCode: "TURN_FINALIZATION_FAILED" } : null;
}

/** 按事件游标与独立本地阶段推进终态；后段失败时不重复已 accepted 的事件。 */
async function completeTurnTerminal(
  ctx: ApiHandlerContext,
  input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: TurnId;
  },
  progress: TurnTerminalProgress,
  key: string,
): Promise<TurnTerminalOutcome> {
  if (progress.terminalEvents === null) {
    const buildTerminalEvents = progress.buildTerminalEvents;
    if (!buildTerminalEvents) {
      throw new Error(`终态 pending 缺少事件 builder（threadId=${input.threadId}, turnId=${input.turnId}）`);
    }
    progress.terminalEvents = [...await buildTerminalEvents()];
    progress.buildTerminalEvents = null;
  }
  while (progress.nextTerminalEventIndex < progress.terminalEvents.length) {
    await accessDatabase(ctx, () => emitConversation(ctx, progress.terminalEvents![progress.nextTerminalEventIndex]!));
    progress.nextTerminalEventIndex += 1;
  }
  await ctx.flushLocalEvents?.(input.workspaceId, input.threadId);
  if (!progress.afterTerminalEventsSettled) {
    const afterTerminalEvents = progress.afterTerminalEvents;
    if (afterTerminalEvents) await afterTerminalEvents();
    progress.afterTerminalEventsSettled = true;
    progress.afterTerminalEvents = null;
  }
  if (!progress.localIndexed) {
    await accessDatabase(ctx, () => {
      const finalized = ctx.db.turns.get(input.turnId);
      if (!finalized || finalized.status === "started") {
        ctx.db.turns.setEnded(input.turnId, { status: progress.status, endedAt: Date.now(), endEventSeq: null });
      }
    });
    progress.localIndexed = true;
  }
  if (!progress.activeCleared) {
    ctx.clearActiveThreadTurn?.({ threadId: input.threadId, turnId: input.turnId });
    progress.activeCleared = true;
  }
  if (!progress.queueNotified) {
    await accessDatabase(ctx, () => progress.notifyQueue());
    progress.queueNotified = true;
  }
  if (!progress.afterTerminalSettled) {
    const afterTerminal = progress.afterTerminal;
    if (afterTerminal) await afterTerminal();
    progress.afterTerminalSettled = true;
    progress.afterTerminal = null;
  }
  clearTurnTerminalProgress(input, key);
  return "emitted";
}

/** 由共享 owner 完成手动中断的 terminal 与固定 queue target。 */
export async function settleManualTurnTerminalOnce(
  ctx: ApiHandlerContext,
  input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: TurnId;
    engine: EngineType | null;
    session: ThreadEngineSession | null;
    /** 批量清理历史遗留 turn 时，只有当前 turn 可以结算正在投递的队列项。 */
    notifyQueue?: boolean;
    afterTerminal?: () => Promise<void>;
  },
): Promise<TurnTerminalOutcome> {
  const { workspaceId, threadId, turnId, engine, session } = input;
  const queueTarget = input.notifyQueue === false
    ? { source: "none" as const, queueItemId: null }
    : await accessDatabase(ctx, () => resolveManualTurnQueueTarget(ctx, threadId, turnId));
  const endedAt = Date.now();
  return await settleTurnTerminalOnce(ctx, {
    workspaceId,
    threadId,
    turnId,
    status: "error",
    stopConfirmed: true,
  }, {
    buildTerminalEvents: async () => {
      if (!engine) throw new Error(`手动中断缺少 engine（threadId=${threadId}, turnId=${turnId}）`);
      const terminalEvents: ConversationEventInput[] = [];
      await emitTurnTerminalWithAssistantReconcile({
        session,
        turnId,
        outcome: "error",
        emitConversation: (event) => {
          terminalEvents.push(event);
        },
        buildTerminalEvent: () => createTurnErrorEventInput({
          ts: endedAt,
          workspaceId,
          threadId,
          engine,
          turnId,
          error: "turn interrupted",
          code: MANUAL_TURN_INTERRUPT_CODE,
          terminationKind: "manual_interrupt",
        }),
      });
      return terminalEvents;
    },
    notifyQueue: () => notifyQueueTurnInterrupted(
      ctx,
      workspaceId,
      threadId,
      turnId,
      queueTarget,
    ),
    afterTerminal: input.afterTerminal,
  });
}

/** 进程树已确认退出后收口旧 turn；已收到的精确 completed 证据优先于重启动作。 */
export async function settleTerminatedCodexTurnOnce(
  ctx: ApiHandlerContext,
  input: {
    workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId; session: ThreadEngineSession | null;
    notifyQueue?: boolean;
  },
): Promise<TurnTerminalOutcome> {
  const status = input.session?.getObservedTurnTerminalStatus?.(input.turnId);
  if (!status) {
    return await settleManualTurnTerminalOnce(ctx, { ...input, engine: "codex" });
  }
  const completed = status === "completed";
  const code = `codex_${status}`;
  const queueTarget = input.notifyQueue === false
    ? { source: "none" as const, queueItemId: null }
    : await accessDatabase(ctx, () => resolveManualTurnQueueTarget(ctx, input.threadId, input.turnId));
  return await settleTurnTerminalOnce(ctx, { ...input, status: completed ? "completed" : "error" }, {
    buildTerminalEvents: async () => {
      const events: ConversationEventInput[] = [];
      await emitTurnTerminalWithAssistantReconcile({
        session: input.session,
        turnId: input.turnId,
        outcome: completed ? "completed" : "error",
        emitConversation: (event) => { events.push(event); },
        buildTerminalEvent: (text) => completed ? {
          ts: Date.now(), workspaceId: input.workspaceId, threadId: input.threadId, engine: "codex",
          type: "turn.completed",
          payload: { turnId: input.turnId, result: { responseText: text ?? "" } },
        } : createTurnErrorEventInput({
          ts: Date.now(), workspaceId: input.workspaceId, threadId: input.threadId, engine: "codex",
          turnId: input.turnId, error: `Codex turn ended as ${status} before process termination`, code,
          terminationKind: status === "interrupted" || status === "cancelled" ? "transient_cleanup" : "error",
        }),
      });
      return events;
    },
    notifyQueue: () => completed
      ? notifyQueueTurnCompleted(ctx, input.workspaceId, input.threadId, input.turnId, queueTarget)
      : notifyQueueTurnFailed(ctx, input.workspaceId, input.threadId, input.turnId, queueTarget, code),
  });
}

/** 重试当前 thread 尚未完成的原 owner 终态阶段；没有 pending 时返回 null。 */
export async function retryPendingTurnTerminal(
  ctx: ApiHandlerContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId },
): Promise<TurnTerminalOutcome | null> {
  const threadKey = buildTurnTerminalThreadKey(input);
  const pendingTurnId = pendingTurnTerminalIdByThreadKey.get(threadKey) ?? null;
  if (!pendingTurnId) return null;

  const pendingInput = { ...input, turnId: pendingTurnId };
  await accessDatabase(ctx, () => assertTerminalRetryStillTargetsTurn(ctx, pendingInput));
  const key = buildTurnTerminalKey(pendingInput);
  const progress = turnTerminalProgressByKey.get(key);
  if (!progress) {
    throw new Error(`终态 pending 缺少进度（threadId=${input.threadId}, turnId=${pendingTurnId}）`);
  }
  return await runTurnTerminalSettlement(ctx, pendingInput, progress, key);
}

/** 本机停止仅复用已准入owner和精确内存身份，未知或共享归属仍走原数据库校验。 */
export function canInterruptRuntimeTurnWithoutDatabase(
  ctx: Pick<ApiHandlerContext, "workspaces" | "threads" | "sessions" | "getActiveThreadTurn">,
  input: { workspaceId?: unknown; threadId?: unknown; turnId?: unknown },
): boolean {
  if ([input.workspaceId, input.threadId, input.turnId].some(value => typeof value !== "string" || !value.trim())) return false;
  const scope = { workspaceId: input.workspaceId as WorkspaceId, threadId: input.threadId as ThreadId, turnId: input.turnId as TurnId };
  return ctx.workspaces.has(scope.workspaceId) && ctx.threads.get(scope.threadId)?.workspaceId === scope.workspaceId
    && ctx.getActiveThreadTurn?.({ ...scope, includeDb: false })?.turnId === scope.turnId
    && isLocalOrdinaryTurnExecution(ctx.sessions, scope);
}

/**
 * 中断 turn；Claude/Codex 已派发后必须确认 provider 停止，未派发只认精确 owner 的取消证明。
 * 已核内存owner先停止再等待数据库；停止证明先反馈，保存失败保留原终态进度并显式返回。
 */
export async function interruptTurnBestEffort(
  ctx: ApiHandlerContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId },
  opts: InterruptTurnOptions = {},
): Promise<InterruptTurnResponseBody> {
  let stopConfirmed = false;
  /** 同一请求只反馈一次停止证明；之后的保存失败不能进入provider恢复路径。 */
  const confirmStop = (): void => {
    if (stopConfirmed) return;
    stopConfirmed = true;
    const progress = turnTerminalProgressByKey.get(buildTurnTerminalKey(input));
    if (progress) progress.stopConfirmed = true;
    opts.onStopConfirmed?.();
  };
  let didInterrupt = false, liveInterruptAttempted = false;
  let liveInterruptFailure: { reason: unknown } | null = null;
  const runtimeThreadBeforeStop = ctx.threads.get(input.threadId);
  const runtimeTurn = ctx.getActiveThreadTurn?.({ ...input, includeDb: false });
  const existingProgress = turnTerminalProgressByKey.get(buildTurnTerminalKey(input));
  const runtimeMatches = runtimeThreadBeforeStop?.workspaceId === input.workspaceId && runtimeTurn?.turnId === input.turnId;
  let cancelledBeforeDispatch = runtimeMatches && cancelOrdinaryTurnBeforeDispatch(ctx.sessions, input);
  if (cancelledBeforeDispatch) confirmStop();
  if (runtimeMatches && !cancelledBeforeDispatch && !existingProgress?.stopConfirmed) {
    liveInterruptAttempted = true;
    try { didInterrupt = await ctx.sessions.interrupt(input.threadId, input.turnId, { onStopConfirmed: confirmStop }); }
    catch (error) {
      if (stopConfirmed) throw error;
      liveInterruptFailure = { reason: error };
    }
  }
  if (ctx.db.workspaceId !== input.workspaceId) ctx = await accessDatabase(ctx, () => scopeApiHandlerContext(ctx, input.workspaceId, { deferPersistenceCheck: true }));
  await accessDatabase(ctx, () => assertRequestedInterruptTurnOwnership(ctx, input));
  // 先做 compare-and-cancel，再执行任何终态重试或 provider 中断。旧标签页针对 A 的迟到停止
  // 请求绝不能借由“当前 active 是 B”被静默改写成停止 B。
  const target = await accessDatabase(ctx, () => resolveAuthoritativeInterruptTurnId(ctx, input));
  cancelledBeforeDispatch ||= cancelOrdinaryTurnBeforeDispatch(ctx.sessions, input);
  if (opts.onStopConfirmed && await accessDatabase(ctx, () => resolveThreadRunningState(ctx, input)?.phase === "draining")) confirmStop();
  if (existingProgress?.stopConfirmed) {
    confirmStop();
    const outcome = await retryPendingTurnTerminal(ctx, input);
    return buildInterruptResult(ctx, input, { alreadyTerminal: outcome === "already_terminal" });
  }

  const targetTurnId = target.turnId;

  const existing = await accessDatabase(ctx, () => ctx.db.turns.get(targetTurnId));
  if (existing && existing.status !== "started" && target.source !== "active") {
    await retryPendingTurnTerminal(ctx, input);
    await settleManualTurnTerminalOnce(ctx, {
      ...input,
      turnId: targetTurnId,
      engine: existing.engine,
      session: null,
    });
    return buildInterruptResult(ctx, input, { alreadyTerminal: true });
  }

  const thread = await accessDatabase(ctx, () => ctx.db.threads.get(input.threadId));
  const engine = (existing?.engine ?? thread?.engine ?? null) as EngineType | null;
  if (cancelledBeforeDispatch) {
    confirmStop();
    const runtime = ctx.threads.get(input.threadId);
    await settleManualTurnTerminalOnce(ctx, { ...input, engine, session: runtime ? ctx.sessions.getOrCreate(runtime) : null });
    return buildInterruptResult(ctx, input);
  }
  const workspacePath = ctx.workspaces.get(input.workspaceId) ?? null;
  const liveCodexSessionId = engine === "codex"
    ? (String(ctx.threads.get(input.threadId)?.sessionId ?? thread?.sessionId ?? "").trim() || null) as SessionId | null
    : null;

  let liveCodexInterruptError: { reason: unknown } | null = null;
  try {
    if (liveInterruptFailure) throw liveInterruptFailure.reason;
    if (!liveInterruptAttempted) didInterrupt = await ctx.sessions.interrupt(input.threadId, targetTurnId, { onStopConfirmed: confirmStop });
  } catch (error) {
    if (stopConfirmed) throw error;
    await accessDatabase(ctx, () => logInterrupt(ctx, "error", "turn interrupt failed; keeping authoritative running state", () => ({
      code: engineDiagnosticField(error, "code") ?? "turn_interrupt_failed",
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: targetTurnId,
      providerThreadId: liveCodexSessionId,
      rootCause: engineDiagnosticCause(error),
    }), { reason: error }));
    if (engine !== "codex") throw error;
    liveCodexInterruptError = { reason: error };
  }
  if (didInterrupt) {
    const pendingOutcome = await retryPendingTurnTerminal(ctx, input);
    if (pendingOutcome) return buildInterruptResult(ctx, input, { alreadyTerminal: pendingOutcome === "already_terminal" });
  }
  if (!didInterrupt && engine === "claude") {
    throw Object.assign(new Error("Claude 当前回合停止尚未确认，请重试终止"), {
      code: "claude_interrupt_unconfirmed", ...input, turnId: targetTurnId,
    });
  }
  if (didInterrupt && !opts.ensureTerminalEvent) return buildInterruptResult(ctx, input);

  const codexProviderIdentity = !didInterrupt && engine === "codex"
    ? await accessDatabase(ctx, () => findCodexProviderTurnIdentityFromHistory(ctx.db, {
        threadId: input.threadId,
        clientTurnId: targetTurnId,
      }))
    : null;
  const weakCodexSessionId = !didInterrupt
    && engine === "codex"
    && !liveCodexInterruptError
    && !codexProviderIdentity?.engineSessionId
    ? await accessDatabase(ctx, () => resolveUniqueRunningCodexThreadSession(ctx, input.threadId, targetTurnId))
    : null;
  const recoveredEngineSessionId = codexProviderIdentity?.engineSessionId ?? weakCodexSessionId;
  const provisionalProviderTurnId = codexProviderIdentity?.engineTurnId ?? null;
  const exactProviderTurn = Boolean(recoveredEngineSessionId && provisionalProviderTurnId);
  if (liveCodexInterruptError && !exactProviderTurn) {
    const liveMessage = interruptFailureMessage(liveCodexInterruptError.reason);
    throw buildCodexInterruptPendingError(
      input,
      targetTurnId,
      provisionalProviderTurnId,
      {
        message: `live session interrupt 失败：${liveMessage}；持久化历史缺少完整 provider threadId/turnId`,
        code: "codex_provider_turn_identity_missing",
        providerThreadId: recoveredEngineSessionId ?? liveCodexSessionId,
        preserveBinding: true,
        cause: liveCodexInterruptError.reason,
      },
    );
  }
  let providerInterruptConfirmed = didInterrupt;
  if (!didInterrupt && engine === "codex" && workspacePath && recoveredEngineSessionId) {
    let recoveredInterrupt;
    let recoveredClientUserMessageIds: string[] | undefined;
    try {
      if (!exactProviderTurn) {
        const clientIdLookup = await accessDatabase(ctx, () => findCodexClientUserMessageIdsFromHistory(ctx.db, {
          threadId: input.threadId,
          clientTurnId: targetTurnId,
        }));
        if (clientIdLookup.kind === "incomplete") {
          throw buildCodexInterruptPendingError(
            input,
            targetTurnId,
            provisionalProviderTurnId,
            {
              message: clientIdLookup.message,
              code: "codex_turn_correlation_scan_incomplete",
            },
          );
        }
        recoveredClientUserMessageIds = clientIdLookup.clientUserMessageIds;
      }
      recoveredInterrupt = await ctx.sessions.interruptCodexTurnByEngineIds({
        threadId: input.threadId,
        workspaceId: input.workspaceId,
        workspacePath,
        turnId: targetTurnId,
        engineSessionId: recoveredEngineSessionId,
        engineTurnId: provisionalProviderTurnId,
        exactProviderTurn,
        ...(recoveredClientUserMessageIds ? { clientUserMessageIds: recoveredClientUserMessageIds } : {}),
      });
    } catch (error) {
      if (isEngineWorkspaceLogFailure(error)) throw error;
      const combinedCause = liveCodexInterruptError
        ? combineCodexLiveAndExactInterruptFailures(liveCodexInterruptError.reason, error)
        : error;
      await accessDatabase(ctx, () => logInterrupt(ctx, "error", "codex turn interrupt by engine id failed; keeping authoritative running state", () => ({
        code: engineDiagnosticField(error, "code") ?? "codex_exact_turn_interrupt_failed",
        requestId: engineDiagnosticField(error, "requestId") ?? `turn-interrupt:${targetTurnId}`,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: targetTurnId,
        engineSessionId: recoveredEngineSessionId,
        engineTurnId: provisionalProviderTurnId,
        liveRootCause: engineDiagnosticCause(liveCodexInterruptError?.reason),
        rootCause: engineDiagnosticCause(error),
      }), { reason: combinedCause }));
      throw buildCodexInterruptPendingError(
        input,
        targetTurnId,
        provisionalProviderTurnId,
        {
          message: interruptFailureMessage(combinedCause),
          code: typeof engineDiagnosticField(error, "code") === "string"
            ? engineDiagnosticField(error, "code") as string : "codex_exact_turn_interrupt_failed",
          providerThreadId: recoveredEngineSessionId,
          preserveBinding: true,
          cause: combinedCause,
        },
      );
    }
    if (recoveredInterrupt.kind !== "ready" && recoveredInterrupt.kind !== "terminal") {
      const recoveredCause = new Error(recoveredInterrupt.message);
      const combinedCause = liveCodexInterruptError
        ? combineCodexLiveAndExactInterruptFailures(liveCodexInterruptError.reason, recoveredCause)
        : recoveredCause;
      await accessDatabase(ctx, () => logInterrupt(ctx, "error", "codex recovered interrupt remains unconfirmed; preserving running state", () => ({
        code: recoveredInterrupt.code,
        requestId: `turn-interrupt:${targetTurnId}`,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: targetTurnId,
        engineSessionId: recoveredEngineSessionId,
        engineTurnId: provisionalProviderTurnId,
        rootCause: engineDiagnosticCause(recoveredInterrupt.message),
      }), { reason: combinedCause }));
      throw buildCodexInterruptPendingError(
        input,
        targetTurnId,
        provisionalProviderTurnId,
        {
          ...recoveredInterrupt,
          message: combinedCause.message,
          providerThreadId: recoveredEngineSessionId,
          preserveBinding: true,
          cause: combinedCause,
        },
      );
    }

    confirmStop();
    const actualEngineTurnId = recoveredInterrupt.actualEngineTurnId;
    if (
      !provisionalProviderTurnId
      || actualEngineTurnId !== provisionalProviderTurnId
      || codexProviderIdentity?.engineSessionSource !== "durable_history"
    ) {
      await accessDatabase(ctx, () => emitConversation(ctx, {
        ts: Date.now(),
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: {
          turnId: targetTurnId,
          engineTurnId: actualEngineTurnId,
          engineSessionId: recoveredEngineSessionId,
          previousEngineTurnId: actualEngineTurnId === provisionalProviderTurnId ? null : provisionalProviderTurnId,
        },
      }));
    }
    if (recoveredInterrupt.kind === "terminal") {
      const terminalOutcome = recoveredInterrupt.reconciled.kind === "completed"
        ? await settleRecoveredCodexCompletedTerminal(ctx, {
            ...input,
            turnId: targetTurnId,
            reconciled: recoveredInterrupt.reconciled,
          })
        : await settleRecoveredCodexErrorTerminal(ctx, {
            ...input,
            turnId: targetTurnId,
            reconciled: recoveredInterrupt.reconciled,
          });
      return buildInterruptResult(ctx, input, { alreadyTerminal: terminalOutcome === "already_terminal" });
    }
    providerInterruptConfirmed = true;
  }

  if (!engine) {
    throw new Error(`无法确认手动中断的 engine（threadId=${input.threadId}, turnId=${targetTurnId}）`);
  }
  if (engine === "codex" && !providerInterruptConfirmed) {
    throw buildCodexInterruptPendingError(
      input,
      targetTurnId,
      provisionalProviderTurnId,
      {
        message: "未找到可直接发送给 provider 的 sessionId/turnId",
        code: "codex_provider_turn_identity_missing",
        ...(liveCodexSessionId ? { providerThreadId: liveCodexSessionId, preserveBinding: true } : {}),
      },
    );
  }
  const runtimeThread = ctx.threads.get(input.threadId) ?? null;
  const pendingOutcome = await retryPendingTurnTerminal(ctx, input);
  if (pendingOutcome) return buildInterruptResult(ctx, input, { alreadyTerminal: pendingOutcome === "already_terminal" });
  const session = !didInterrupt && engine === "codex"
    ? null
    : runtimeThread
    ? ctx.sessions.getOrCreate(runtimeThread)
    : null;
  const terminalOutcome = await settleManualTurnTerminalOnce(ctx, {
    ...input,
    turnId: targetTurnId,
    engine,
    session,
  });
  return buildInterruptResult(ctx, input, { alreadyTerminal: terminalOutcome === "already_terminal" });
}

/** thread 级 session 仅在目标是唯一 started turn 时作为待 clientId 确权的弱候选。 */
function resolveUniqueRunningCodexThreadSession(
  ctx: ApiHandlerContext,
  threadId: ThreadId,
  targetTurnId: TurnId,
): SessionId | null {
  const running = ctx.db.turns.listByThread(threadId).filter((turn) => turn.status === "started");
  if (running.length !== 1 || running[0]?.turnId !== targetTurnId) return null;
  const sessionId = ctx.db.threads.get(threadId)?.sessionId ?? ctx.threads.get(threadId)?.sessionId ?? null;
  return (String(sessionId ?? "").trim() || null) as SessionId | null;
}

/** 将重启后确认已完成的 Codex turn 连同 assistant 快照按 completed 终态收口。 */
async function settleRecoveredCodexCompletedTerminal(
  ctx: ApiHandlerContext,
  input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: TurnId;
    reconciled: CompletedCodexReconcileResult;
    afterTerminal?: () => Promise<void>;
  },
): Promise<TurnTerminalOutcome> {
  const queueTarget = await accessDatabase(ctx, () => resolveManualTurnQueueTarget(ctx, input.threadId, input.turnId));
  return await settleTurnTerminalOnce(ctx, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    status: "completed",
  }, {
    buildTerminalEvents: async () => [
      ...input.reconciled.assistantEvents,
      {
        ts: Date.now(),
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        engine: "codex",
        type: "turn.completed",
        payload: {
          turnId: input.turnId,
          result: {
            responseText: input.reconciled.responseText ?? "",
            recoveredAfterRestart: true,
          },
        },
      },
    ],
    notifyQueue: () => notifyQueueTurnCompleted(
      ctx,
      input.workspaceId,
      input.threadId,
      input.turnId,
      queueTarget,
    ),
    afterTerminal: input.afterTerminal,
  });
}

/** 将 provider 已明确返回的非 completed 终态按真实错误语义落库。 */
async function settleRecoveredCodexErrorTerminal(
  ctx: ApiHandlerContext,
  input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: TurnId;
    reconciled: ErrorCodexReconcileResult;
  },
): Promise<TurnTerminalOutcome> {
  const queueTarget = await accessDatabase(ctx, () => resolveManualTurnQueueTarget(ctx, input.threadId, input.turnId));
  const terminationKind = input.reconciled.code === "codex_interrupted"
    || input.reconciled.code === "codex_cancelled"
    ? "transient_cleanup"
    : "error";
  return await settleTurnTerminalOnce(ctx, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    status: "error",
  }, {
    buildTerminalEvents: async () => [createTurnErrorEventInput({
      ts: Date.now(),
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      engine: "codex",
      turnId: input.turnId,
      error: input.reconciled.message,
      code: input.reconciled.code,
      terminationKind,
    })],
    notifyQueue: () => notifyQueueTurnFailed(
      ctx,
      input.workspaceId,
      input.threadId,
      input.turnId,
      queueTarget,
      input.reconciled.code,
    ),
  });
}

/** 为待确认的 provider 中断构造可追踪错误，并要求保留本地 running。 */
function buildCodexInterruptPendingError(
  input: { workspaceId: WorkspaceId; threadId: ThreadId },
  turnId: TurnId,
  providerTurnId: string | null,
  result: {
    message: string;
    code: string;
    providerThreadId?: SessionId | null;
    preserveBinding?: boolean;
    userChoiceRequired?: boolean;
    recoveryStrategies?: readonly string[];
    cause?: unknown;
  },
): Error {
  return Object.assign(new Error(
    `Codex 回合停止状态仍未确认；本地回合保持待处理（workspaceId=${input.workspaceId}, threadId=${input.threadId}, turnId=${turnId}, providerTurnId=${providerTurnId ?? "missing"}）：${result.message}`,
    Object.hasOwn(result, "cause") ? { cause: result.cause } : undefined,
  ), {
    code: result.code,
    preserveRunningState: true,
    ...(result.providerThreadId ? { providerThreadId: result.providerThreadId } : {}),
    ...(result.preserveBinding ? { preserveBinding: true } : {}),
    ...(result.userChoiceRequired ? { userChoiceRequired: true } : {}),
    ...(result.recoveryStrategies ? { recoveryStrategies: result.recoveryStrategies } : {}),
  });
}

/** live session 与持久化精确 pair 均失败时保留两段原始原因。 */
function combineCodexLiveAndExactInterruptFailures(liveCause: unknown, exactCause: unknown): Error {
  return Object.assign(new Error(
    `live session interrupt 失败：${interruptFailureMessage(liveCause)}；持久化精确 provider pair interrupt 失败：${interruptFailureMessage(exactCause)}`,
    { cause: exactCause },
  ), {
    liveInterruptCause: liveCause,
    exactInterruptCause: exactCause,
  });
}

/** 用户错误提示只取自有字符串消息，不调用异常访问器或未知转换。 */
function interruptFailureMessage(cause: unknown): string {
  const message = engineDiagnosticField(cause, "message");
  return typeof message === "string" ? message : "provider 中断失败";
}

/** 校验请求 turn 的持久化归属，禁止跨 workspace/thread 的迟到停止污染其他回合。 */
function assertRequestedInterruptTurnOwnership(
  ctx: ApiHandlerContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId },
): void {
  const requestedTurnId = String(input.turnId ?? "").trim();
  if (!requestedTurnId) throw new Error("中断 turn 缺少 turnId");
  const turn = ctx.db.turns.get(requestedTurnId as TurnId);
  if (!turn || (turn.workspaceId === input.workspaceId && turn.threadId === input.threadId)) return;

  const running = resolveThreadRunningState(ctx, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
  });
  const failure = Object.assign(new Error(
    `停止请求已过期：turnId=${requestedTurnId} 不属于当前 workspace/thread；已保留原回合，请刷新会话后重试。`,
  ), {
    code: THREAD_RUNTIME_STALE_CODE, preserveRunningState: true, requestedTurnId,
    requestedWorkspaceId: input.workspaceId, requestedThreadId: input.threadId,
    actualWorkspaceId: turn.workspaceId, actualThreadId: turn.threadId, running,
  });
  logInterrupt(ctx, "warn", "foreign interrupt target rejected", () => ({
    code: THREAD_RUNTIME_STALE_CODE,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    requestedTurnId,
    actualWorkspaceId: turn.workspaceId,
    actualThreadId: turn.threadId,
    running,
  }), { reason: failure });
  throw failure;
}

/**
 * compare-and-cancel：请求 turnId 必须与当前权威本地 turn 完全一致。
 * 这里只校验归属，不允许把旧请求静默改写为当前新 turn。
 */
function resolveAuthoritativeInterruptTurnId(
  ctx: ApiHandlerContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId },
): InterruptTarget {
  const requestedTurnId = String(input.turnId ?? "").trim();
  if (!requestedTurnId) throw new Error("中断 turn 缺少 turnId");

  const threadKey = buildTurnTerminalThreadKey(input);
  const pendingTurnId = String(pendingTurnTerminalIdByThreadKey.get(threadKey) ?? "").trim() || null;
  if (pendingTurnId && pendingTurnId !== requestedTurnId) {
    throw buildStaleInterruptTargetError(ctx, input, {
      requestedTurnId,
      authoritativeTurnId: pendingTurnId,
      authoritativeSource: "pending_terminal",
    });
  }

  const active = ctx.getActiveThreadTurn?.({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    includeDb: false,
  })?.turnId ?? null;
  if (active) {
    const activeTurnId = String(active).trim();
    if (activeTurnId !== requestedTurnId) {
      throw buildStaleInterruptTargetError(ctx, input, {
        requestedTurnId,
        authoritativeTurnId: activeTurnId,
        authoritativeSource: "runtime_active",
      });
    }
    return { turnId: activeTurnId as TurnId, source: "active" };
  }
  const runningByThreadId = ctx.db.turns.listRunningByWorkspace(input.workspaceId);
  const authoritative = runningByThreadId[String(input.threadId)]?.runningTurnId ?? null;
  if (authoritative) {
    const authoritativeTurnId = String(authoritative).trim();
    if (authoritativeTurnId !== requestedTurnId) {
      throw buildStaleInterruptTargetError(ctx, input, {
        requestedTurnId,
        authoritativeTurnId,
        authoritativeSource: "db_running",
      });
    }
    return { turnId: authoritativeTurnId as TurnId, source: "db" };
  }
  if (pendingTurnId) return { turnId: pendingTurnId as TurnId, source: "pending" };
  const preparing = listOrdinaryTurnExecutions(ctx.sessions).some(owner => owner.workspaceId === input.workspaceId
    && owner.threadId === input.threadId && owner.turnId === requestedTurnId);
  if (!preparing && !ctx.db.turns.get(requestedTurnId as TurnId)) {
    throw buildStaleInterruptTargetError(ctx, input, {
      requestedTurnId, authoritativeTurnId: null, authoritativeSource: "missing",
    });
  }
  return { turnId: requestedTurnId as TurnId, source: "input" };
}

/** 构造可被 API 统一映射为 409 的 stale target 错误，并保留当前 running 快照供调用方对账。 */
function buildStaleInterruptTargetError(
  ctx: ApiHandlerContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId },
  mismatch: {
    requestedTurnId: string;
    authoritativeTurnId: string | null;
    authoritativeSource: "runtime_active" | "db_running" | "pending_terminal" | "missing";
  },
): Error {
  const running = resolveThreadRunningState(ctx, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
  });
  const failure = Object.assign(new Error(
    `停止请求已过期：请求 turnId=${mismatch.requestedTurnId}，当前 turnId=${mismatch.authoritativeTurnId ?? "不存在"}；已保留当前回合，请刷新会话后重试。`,
  ), {
    code: THREAD_RUNTIME_STALE_CODE, preserveRunningState: true,
    requestedTurnId: mismatch.requestedTurnId, authoritativeTurnId: mismatch.authoritativeTurnId,
    authoritativeSource: mismatch.authoritativeSource, running,
  });
  logInterrupt(ctx, "warn", "stale interrupt target rejected", () => ({
    code: THREAD_RUNTIME_STALE_CODE,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    requestedTurnId: mismatch.requestedTurnId,
    authoritativeTurnId: mismatch.authoritativeTurnId,
    authoritativeSource: mismatch.authoritativeSource,
    running,
  }), { reason: failure });
  return failure;
}

/** 返回中断处理后的权威 running 状态，供上游同步 UI。 */
async function buildInterruptResult(
  ctx: ApiHandlerContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId },
  opts: { alreadyTerminal?: boolean } = {},
): Promise<InterruptTurnResponseBody> {
  return await accessDatabase(ctx, () => ({
    running: resolveThreadRunningState(ctx, { workspaceId: input.workspaceId, threadId: input.threadId }),
    ...(opts.alreadyTerminal ? { alreadyTerminal: true } : {}),
  }));
}

/** 构造终态 singleflight/progress key。 */
function buildTurnTerminalKey(input: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId }): string {
  return `${input.workspaceId}\u0000${input.threadId}\u0000${input.turnId}`;
}

/** 构造每线程唯一的待完成终态索引。 */
function buildTurnTerminalThreadKey(input: { workspaceId: WorkspaceId; threadId: ThreadId }): string {
  return `${input.workspaceId}\u0000${input.threadId}`;
}

/** 清理已完成的终态进度及其每线程 pending 索引。 */
function clearTurnTerminalProgress(
  input: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId },
  key: string,
): void {
  turnTerminalProgressByKey.delete(key);
  const threadKey = buildTurnTerminalThreadKey(input);
  if (pendingTurnTerminalIdByThreadKey.get(threadKey) === input.turnId) {
    pendingTurnTerminalIdByThreadKey.delete(threadKey);
  }
}

/** 队列阶段重试不得跨到随后启动的其他 turn。 */
function assertTerminalRetryStillTargetsTurn(
  ctx: ApiHandlerContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId },
): void {
  const runtimeTurnId = ctx.getActiveThreadTurn?.({ workspaceId: input.workspaceId, threadId: input.threadId })?.turnId ?? null;
  const dbTurnId = ctx.db.turns.listRunningByWorkspace(input.workspaceId)[String(input.threadId)]?.runningTurnId ?? null;
  const activeTurnId = String(runtimeTurnId ?? dbTurnId ?? "").trim();
  if (activeTurnId && activeTurnId !== String(input.turnId)) {
    throw new Error(
      `终态重试检测到其他 active turn（threadId=${input.threadId}, expectedTurnId=${input.turnId}, activeTurnId=${activeTurnId}）`,
    );
  }
}

/** 发送必须投递的 terminal 事件；明确拒绝入队时保留终态 pending。 */
function emitConversation(ctx: ApiHandlerContext, event: ConversationEventInput): void {
  if (ctx.onBeforeEmitConversationEvent) ctx.onBeforeEmitConversationEvent(event);
  const dispatch = ctx.send({ t: "conversation.event", event }) as unknown as WsSendJsonResult | void;
  if (dispatch && !dispatch.accepted) {
    const turnId = String((event.payload as any)?.turnId ?? "").trim() || "unknown";
    throw new Error(
      `conversation terminal dispatch rejected（workspaceId=${event.workspaceId}, threadId=${event.threadId}, turnId=${turnId}, type=${event.type}, reason=${dispatch.reason ?? "unknown"}, readyState=${dispatch.readyState ?? "unknown"}）`,
    );
  }
}

/** 固定首次终态结算时的队列目标，重试不得读取后续 turn 的 sending 项。 */
function resolveManualTurnQueueTarget(
  ctx: ApiHandlerContext,
  threadId: ThreadId,
  turnId: TurnId,
): ManualTurnQueueTarget {
  const sendingItem = ctx.db.threadMessageQueue
    .listActiveByThread(threadId)
    .find((item) => item.status === "sending") ?? null;
  if (sendingItem) return { source: "queue_consume", queueItemId: sendingItem.id };
  const hasIndexedUserMessage = Boolean(ctx.db.turns.get(turnId)?.userItemId);
  const hasPersistedUserMessage = ctx.db.conversationEvents.listByThread(threadId).some((event) =>
    event.type === "item.userMessage.created"
    && String((event.payload as any)?.turnId ?? "").trim() === String(turnId));
  return hasIndexedUserMessage || hasPersistedUserMessage
    ? { source: "user_send", queueItemId: null }
    : { source: "none", queueItemId: null };
}

/** 通知队列把固定 turn/queue item 收敛为 user_stop。 */
function notifyQueueTurnInterrupted(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  turnId: TurnId,
  target: ManualTurnQueueTarget,
): void {
  if (target.source === "none") return;
  if (!ctx.queueDispatcher) return;
  ctx.queueDispatcher.notifyTurnTerminal({
    workspaceId,
    threadId,
    turnId,
    source: target.source,
    queueItemId: target.queueItemId,
    outcome: "error",
    terminationKind: "manual_interrupt",
    errorCode: MANUAL_TURN_INTERRUPT_CODE,
  });
}

/** 通知队列把固定 turn/queue item 收敛为 completed。 */
function notifyQueueTurnCompleted(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  turnId: TurnId,
  target: ManualTurnQueueTarget,
): void {
  if (target.source === "none") return;
  if (!ctx.queueDispatcher) return;
  ctx.queueDispatcher.notifyTurnTerminal({
    workspaceId,
    threadId,
    turnId,
    source: target.source,
    queueItemId: target.queueItemId,
    outcome: "completed",
  });
}

/** 通知队列按明确错误码结束失效 turn。 */
function notifyQueueTurnFailed(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  turnId: TurnId,
  target: ManualTurnQueueTarget,
  errorCode: string,
): void {
  if (target.source === "none") return;
  if (!ctx.queueDispatcher) return;
  ctx.queueDispatcher.notifyTurnTerminal({
    workspaceId,
    threadId,
    turnId,
    source: target.source,
    queueItemId: target.queueItemId,
    outcome: "error",
    terminationKind: "error",
    errorCode,
  });
}
