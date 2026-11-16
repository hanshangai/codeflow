import type { ConversationEventInput, RequestUserInputQuestion, SessionId, WorkspaceId } from "@codeflowai/shared";

import type { ConversationEmitFn, SendMessageInput } from "../threadSession.js";
import {
  AssistantLifecycleTracker,
  buildAssistantCompletedEvent,
} from "../assistantLifecycle.js";
import { createToolPresentation } from "../tool-presentation.js";
import { logger } from "../../logger.js";
import { maybeExtractSessionId, safeJson, tryExtractTokenUsage } from "./claudeJson.js";
import { extractClaudeLocalCommandOutput } from "./claudeInputActions.js";
import {
  createToolState,
  extractTodolistItems,
  extractToolOutput,
  resolveToolResultId,
  resolveToolUseId,
  type ClaudeBackgroundShellTaskMeta,
  type ToolState,
} from "./claudeTools.js";

type ClaudeAssistantMessageState = {
  itemId: string;
  engineMessageId: string;
  text: string;
  revision: number;
  completed: boolean;
};

export type ClaudeStreamProcessorState = {
  currentAssistant: ClaudeAssistantMessageState | null;
  currentReasoningItemId: string | null;
  reasoningStarted: boolean;
  reasoningSoFar: string;
  pendingAssistantText: string;
  latestAssistantText: string;
  errorFromEvent: string | null;
  /** 当前 turn 最近一次确认的 Claude 模型 id，用于精确匹配 modelUsage。 */
  activeModelId: string | null;
  /** AskUserQuestion 多轮响应：当前消息周期（0=首轮，每次 tool_result 回答后递增）。 */
  messageCycle: number;
  /** GLM result usage 内容指纹，避免 result 重复刷新累计。 */
  lastGlmUsageKey: string | null;
  /** GLM 同一消息的 final current usage 去重，避免 stream_event 与 assistant 重复计量。 */
  lastGlmCurrentUsageEventKey: string | null;
  /** GLM 当前 provider 消息已取得非 result 最终 usage；同消息 result 只补 UI。 */
  hasGlmNonResultFinalUsage: boolean;
  /** GLM 当前 provider 消息身份，用于在下一次 message_start 时重置去重边界。 */
  lastGlmMessageIdentity: string | null;
  /** GLM 已累计的最终事件身份，允许不同消息拥有相同 token 数。 */
  lastGlmCumulativeUsageEventKey: string | null;
  /** GLM result 事件身份，避免同一 result 重放时按 token 数误去重不同调用。 */
  lastGlmResultUsageEventKey: string | null;
};

/** 创建一轮 turn 的 Claude stream-json 处理状态。 */
export function createClaudeStreamProcessorState(): ClaudeStreamProcessorState {
  return {
    currentAssistant: null,
    currentReasoningItemId: null,
    reasoningStarted: false,
    reasoningSoFar: "",
    pendingAssistantText: "",
    latestAssistantText: "",
    errorFromEvent: null,
    activeModelId: null,
    messageCycle: 0,
    lastGlmUsageKey: null,
    lastGlmCurrentUsageEventKey: null,
    hasGlmNonResultFinalUsage: false,
    lastGlmMessageIdentity: null,
    lastGlmCumulativeUsageEventKey: null,
    lastGlmResultUsageEventKey: null,
  };
}

/** AskUserQuestion tool_result 被跳过后，推进 cycle：重置文本累积器，让后续文本写入新 assistantItemId。 */
function advanceCycle(state: ClaudeStreamProcessorState): void {
  state.messageCycle++;
  state.currentAssistant = null;
  state.currentReasoningItemId = null;
  state.reasoningStarted = false;
  state.reasoningSoFar = "";
  state.pendingAssistantText = "";
}

/** 从 Claude 事件中同步当前 turn 的模型 id，供 usage 解析精确匹配。 */
function syncActiveModelId(state: ClaudeStreamProcessorState, parsed: Record<string, unknown>): void {
  const message = parsed.message as Record<string, unknown> | undefined;
  const result = parsed.result as Record<string, unknown> | undefined;
  const event = parsed.event as Record<string, unknown> | undefined;
  const eventMessage = event?.message as Record<string, unknown> | undefined;
  const directModel = typeof parsed.model === "string" ? parsed.model.trim() : "";
  const messageModel = typeof message?.model === "string" ? message.model.trim() : "";
  const resultModel = typeof result?.model === "string" ? result.model.trim() : "";
  const eventModel = typeof event?.model === "string" ? event.model.trim() : "";
  const eventMessageModel = typeof eventMessage?.model === "string" ? eventMessage.model.trim() : "";
  const model = directModel || messageModel || resultModel || eventModel || eventMessageModel;
  if (model) state.activeModelId = model;
}

/** 读取 Claude SDK 事件所属的父工具作用域；非空表示子作用域事件。 */
function extractParentToolUseId(parsed: any): string | null {
  const raw = parsed?.parent_tool_use_id ?? parsed?.message?.parent_tool_use_id ?? null;
  const normalized = String(raw ?? "").trim();
  return normalized || null;
}

/** Claude synthetic assistant 不是真实 API 响应，不能更新主线程 usage 或当前模型。 */
function isSyntheticAssistantEvent(parsed: any): boolean {
  const model = String(parsed?.message?.model ?? parsed?.model ?? "").trim();
  return model === "<synthetic>";
}

/** 判断是否为 Z.AI/智谱 GLM 模型；其 result.usage 表示当前 turn，而非 session 累计。 */
function isGlmModelId(modelId: string | null | undefined): boolean {
  return String(modelId ?? "").trim().toLowerCase().startsWith("glm-");
}

/** 生成 usage 内容指纹，避免 GLM 同一末条统计同时从 stream_event/result 重复入账。 */
function tokenUsageKey(usage: NonNullable<ReturnType<typeof tryExtractTokenUsage>>): string {
  return [
    usage.inputTokens ?? "n",
    usage.outputTokens ?? "n",
    usage.cachedInputTokens ?? "n",
    usage.cacheCreationInputTokens ?? "n",
  ].join("/");
}

/** 识别 provider 流中的最终 usage；message_delta/message_stop 是流式末段，其余为中间片段。 */
function isFinalUsageEvent(parsed: any): boolean {
  if (String(parsed?.type ?? "").trim() !== "stream_event") return true;
  const innerType = String(parsed?.event?.type ?? "").trim();
  return innerType === "message_delta" || innerType === "message_stop";
}

/** 生成同一 provider 消息的稳定身份，供 stream_event 与 assistant usage 去重。 */
function tokenUsageEventIdentity(parsed: any, state: ClaudeStreamProcessorState): string {
  const type = String(parsed?.type ?? "").trim();
  const identity = String(
    (type === "result" ? parsed?.uuid : null)
    ?? parsed?.message?.id
    ?? parsed?.event?.message?.id
    ?? state.currentAssistant?.engineMessageId
    ?? parsed?.uuid
    ?? "turn",
  ).trim();
  return identity || "turn";
}

/** 新 provider 消息开始时清理 GLM 去重状态，避免后续独立调用被上一消息吞掉。 */
function resetGlmUsageAtMessageBoundary(
  state: ClaudeStreamProcessorState,
  parsed: any,
  type: string,
): void {
  const isMessageStart = type === "stream_event" && String(parsed?.event?.type ?? "").trim() === "message_start";
  const identity = type === "stream_event"
    ? String(parsed?.event?.message?.id ?? "").trim()
    : type === "assistant"
      ? String(parsed?.message?.id ?? "").trim()
      : "";
  if (!identity && !isMessageStart) return;
  if (!identity && isMessageStart) {
    state.lastGlmUsageKey = null;
    state.lastGlmCurrentUsageEventKey = null;
    state.lastGlmCumulativeUsageEventKey = null;
    state.lastGlmResultUsageEventKey = null;
    state.hasGlmNonResultFinalUsage = false;
    state.lastGlmMessageIdentity = null;
    return;
  }
  if (state.lastGlmMessageIdentity && state.lastGlmMessageIdentity !== identity) {
    state.lastGlmUsageKey = null;
    state.lastGlmCurrentUsageEventKey = null;
    state.lastGlmCumulativeUsageEventKey = null;
    state.lastGlmResultUsageEventKey = null;
    state.hasGlmNonResultFinalUsage = false;
  }
  state.lastGlmMessageIdentity = identity;
}

/** 空错误 usage 是 Claude Code 的失败占位，不能清零前台上下文统计。 */
function shouldEmitResultTokenUsage(parsed: any, usage: NonNullable<ReturnType<typeof tryExtractTokenUsage>>): boolean {
  const isError = Boolean(parsed?.is_error ?? parsed?.result?.is_error ?? false);
  if (!isError) return true;
  return hasNonZeroTokenUsageCounters(usage);
}

/** 错误 result 只有真实 token 计数非零时才可覆盖累计统计。 */
function hasNonZeroTokenUsageCounters(usage: NonNullable<ReturnType<typeof tryExtractTokenUsage>>): boolean {
  return (
    (usage.inputTokens ?? 0) !== 0 ||
    (usage.outputTokens ?? 0) !== 0 ||
    (usage.cachedInputTokens ?? 0) !== 0 ||
    (usage.cacheCreationInputTokens ?? 0) !== 0
  );
}

function assistantItemId(engineMessageId: string): string {
  return `assistant_${engineMessageId}`;
}

function reasoningItemId(engineMessageId: string): string {
  return `reasoning_${engineMessageId}`;
}

function completeCurrentAssistantMessage(opts: {
  workspaceId: WorkspaceId;
  threadId: string;
  state: ClaudeStreamProcessorState;
  assistantLifecycle: AssistantLifecycleTracker;
  emit: ConversationEmitFn;
}): void {
  const assistant = opts.state.currentAssistant;
  if (!assistant || assistant.completed) return;
  assistant.completed = true;
  opts.state.latestAssistantText = assistant.text;
  opts.assistantLifecycle.markCompleted({
    itemId: assistant.itemId,
    text: assistant.text,
    revision: assistant.revision,
    completionSource: "provider",
  });
  opts.emit(buildAssistantCompletedEvent({
    workspaceId: opts.workspaceId,
    threadId: opts.threadId,
    engine: "claude",
    itemId: assistant.itemId,
    engineMessageId: assistant.engineMessageId,
    turnId: opts.assistantLifecycle.activeTurn() ?? undefined,
    text: assistant.text,
    revision: assistant.revision,
    completionSource: "provider",
  }));
  opts.state.currentAssistant = null;
  opts.state.currentReasoningItemId = null;
  opts.state.reasoningStarted = false;
  opts.state.reasoningSoFar = "";
  opts.state.pendingAssistantText = "";
}

function ensureAssistantMessage(opts: {
  workspaceId: WorkspaceId;
  threadId: string;
  state: ClaudeStreamProcessorState;
  assistantLifecycle: AssistantLifecycleTracker;
  emit: ConversationEmitFn;
}, engineMessageId: string): ClaudeAssistantMessageState {
  const current = opts.state.currentAssistant;
  if (current && current.engineMessageId === engineMessageId) return current;
  if (current && current.engineMessageId !== engineMessageId) {
    completeCurrentAssistantMessage(opts);
  }
  const created: ClaudeAssistantMessageState = {
    itemId: assistantItemId(engineMessageId),
    engineMessageId,
    text: "",
    revision: 0,
    completed: false,
  };
  opts.state.currentAssistant = created;
  opts.state.currentReasoningItemId = reasoningItemId(engineMessageId);
  opts.state.reasoningStarted = false;
  opts.state.reasoningSoFar = "";
  const activeTurnId = opts.assistantLifecycle.activeTurn();
  if (activeTurnId) {
    opts.assistantLifecycle.ensureStarted({
      itemId: created.itemId,
      engineMessageId,
      turnId: activeTurnId,
    });
  }
  opts.emit({
    ts: Date.now(),
    workspaceId: opts.workspaceId,
    threadId: opts.threadId as any,
    engine: "claude",
    type: "item.agentMessage.started",
    payload: {
      itemId: created.itemId as any,
      engineMessageId,
      turnId: activeTurnId ?? undefined,
    },
  } satisfies ConversationEventInput);
  if (opts.state.pendingAssistantText) {
    const pendingText = opts.state.pendingAssistantText;
    opts.state.pendingAssistantText = "";
    created.text += pendingText;
    opts.assistantLifecycle.appendDelta(created.itemId, pendingText);
    opts.state.latestAssistantText = created.text;
    opts.emit({
      ts: Date.now(),
      workspaceId: opts.workspaceId,
      threadId: opts.threadId as any,
      engine: "claude",
      type: "item.agentMessage.delta",
      payload: {
        itemId: created.itemId as any,
        engineMessageId: created.engineMessageId,
        turnId: activeTurnId ?? undefined,
        delta: pendingText,
      },
    } satisfies ConversationEventInput);
  }
  return created;
}

/** Emits one complete assistant-style text through the canonical Claude lifecycle with exact dedupe. */
export function emitClaudeAssistantText(
  opts: {
    workspaceId: WorkspaceId;
    threadId: string;
    state: ClaudeStreamProcessorState;
    assistantLifecycle: AssistantLifecycleTracker;
    emit: ConversationEmitFn;
  },
  textValue: string,
  engineMessageId: string,
): boolean {
  const text = String(textValue ?? "").trim();
  if (!text) return false;
  if (!opts.state.currentAssistant && opts.state.latestAssistantText === text) return false;
  if (opts.state.currentAssistant?.text === text) {
    completeCurrentAssistantMessage(opts);
    return false;
  }
  opts.state.pendingAssistantText = text;
  ensureAssistantMessage(opts, engineMessageId);
  completeCurrentAssistantMessage(opts);
  return true;
}

function ensureReasoningStarted(
  opts: {
    workspaceId: WorkspaceId;
    threadId: string;
    state: ClaudeStreamProcessorState;
    input: SendMessageInput;
    emit: ConversationEmitFn;
  },
): void {
  const itemId = (opts.state.currentReasoningItemId ?? opts.input.reasoningItemId) as any;
  if (!itemId || opts.state.reasoningStarted) return;
  opts.state.reasoningStarted = true;
  opts.emit({
    ts: Date.now(),
    workspaceId: opts.workspaceId,
    threadId: opts.threadId as any,
    engine: "claude",
    type: "item.reasoning.started",
    payload: { itemId },
  } satisfies ConversationEventInput);
}

/**
 * AskUserQuestion 的 tool_result 到达时的统一收口：
 * 1. 推进 cycle（让后续 assistant text 写入新 itemId）
 * 2. 清理 pending 条目（避免 result 事件误判为"还有待回答"导致 stdin 不关闭）
 * 3. 如果 tool_result 是 error，emit userInput.expired 通知前端卡片状态变更
 */
function handleAskUserQuestionToolResult(
  opts: { workspaceId: WorkspaceId; threadId: string; tool: ToolState; emit: ConversationEmitFn },
  state: ClaudeStreamProcessorState,
  toolId: string,
  isError: boolean,
): void {
  advanceCycle(state);

  // 清理 pending 映射（requestId = "askuser_" + toolUseId）
  const requestId = `askuser_${toolId}`;
  const existed = opts.tool.pendingUserInputByRequestId.delete(requestId);
  const hadControlRequest = opts.tool.controlRequestIdByToolUseId.has(toolId);
  opts.tool.controlRequestIdByToolUseId.delete(toolId);
  opts.tool.controlRequestInputByToolUseId.delete(toolId);

  // 关键诊断日志：区分 "CC正常返回回答" vs "CC报错(未收到control_response)" vs "CC报错(无control_request)"
  logger.info("claude", `handleAskUserQuestionToolResult: toolId=${toolId} isError=${isError} wasPending=${existed} hadControlRequest=${hadControlRequest}`, {
    pendingRemaining: opts.tool.pendingUserInputByRequestId.size,
    claudeResultReceived: opts.tool.claudeResultReceived,
    messageCycle: state.messageCycle,
  });
  if (isError && !hadControlRequest) {
    logger.warn("claude", `AskUserQuestion tool_result is_error=true but NO control_request was received for this toolUseId — possible cause: --dangerously-skip-permissions or session corruption (--resume of a broken session)`);
  } else if (isError && hadControlRequest) {
    logger.warn("claude", `AskUserQuestion tool_result is_error=true WITH control_request — CC timed out or user answer was rejected/too late`);
  } else if (!isError) {
    logger.info("claude", `AskUserQuestion tool_result success — user answer was accepted by CC`);
  }

  // 如果 tool_result 是 error（Claude 内部超时或拒绝），通知前端将卡片标记为 expired
  if (isError && existed) {
    opts.emit({
      ts: Date.now(),
      workspaceId: opts.workspaceId,
      threadId: opts.threadId as any,
      engine: "claude",
      type: "userInput.expired",
      payload: { requestId },
    });
  }
}

/** 处理 Claude `--output-format stream-json` 的一行输出（会更新 state/tool，并 emit 统一事件）。 */
export function applyClaudeStreamLine(opts: {
  line: string;
  /** 可选：外部已解析的 JSON（避免重复 parse，用于 raw trace 场景）。 */
  parsed?: unknown;
  workspacePath: string;
  workspaceId: WorkspaceId;
  threadId: string;
  input: SendMessageInput;
  tool: ToolState;
  state: ClaudeStreamProcessorState;
  assistantLifecycle: AssistantLifecycleTracker;
  emit: ConversationEmitFn;
  onSessionId: (sid: SessionId) => void;
  /** 仅 Provider Slash 允许把 local-command 输出映射为可见 assistant 消息。 */
  providerSlash?: boolean;
  /** Claude Code 通过 system.status 通知 permissionMode 变更（auto-approve 场景）。 */
  onPermissionModeChanged?: (mode: string) => void;
  onBackgroundShellTaskStarted?: (input: ClaudeBackgroundShellTaskMeta) => void;
  onBackgroundShellTaskCompleted?: (input: ClaudeBackgroundShellTaskMeta & { status: "completed" | "failed" | "stopped"; summary: string }) => void;
}): void {
  const parsed = opts.parsed ?? safeJson(opts.line);
  if (!parsed) return;

  // 某些兼容层不会在 system.init/result 回传模型，使用本轮发送参数作为稳定兜底。
  if (!opts.state.activeModelId) {
    const inputModel = String(opts.input.model ?? "").trim();
    if (inputModel) opts.state.activeModelId = inputModel;
  }

  const sid = maybeExtractSessionId(parsed);
  if (sid) opts.onSessionId(sid);

  const type = String(parsed.type ?? "").trim();
  const parentToolUseId = extractParentToolUseId(parsed);
  const isScopedEvent = parentToolUseId != null;
  const isSyntheticAssistant = type === "assistant" && isSyntheticAssistantEvent(parsed);

  if (!isScopedEvent && !isSyntheticAssistant) {
    syncActiveModelId(opts.state, parsed as Record<string, unknown>);
  }

  // result 事件对官方 Claude 是 session 累计值；GLM 兼容层则上报当前 turn 值。
  // 其他事件的 usage 是单次 API call 快照，用于 current 上下文窗口占用。
  if (isGlmModelId(opts.state.activeModelId) && !isScopedEvent && !isSyntheticAssistant) {
    resetGlmUsageAtMessageBoundary(opts.state, parsed, type);
  }
  if (type !== "result") {
    const usage = tryExtractTokenUsage(parsed, opts.state.activeModelId);
    if (usage && !isScopedEvent && !isSyntheticAssistant) {
      const isGlm = isGlmModelId(opts.state.activeModelId);
      const usagePhase = isGlm && type === "stream_event"
        ? (isFinalUsageEvent(parsed) ? "final" : "intermediate")
        : "final";
      const usageKey = tokenUsageKey(usage);
      const usageEventKey = `${tokenUsageEventIdentity(parsed, opts.state)}:${usageKey}`;
      const duplicateGlmFinal = isGlm
        && usagePhase === "final"
        && opts.state.lastGlmCurrentUsageEventKey === usageEventKey;
      if (!duplicateGlmFinal) {
        opts.emit({
          ts: Date.now(),
          workspaceId: opts.workspaceId,
          threadId: opts.threadId as any,
          engine: "claude",
          type: "tokenUsage.updated",
          payload: { tokenUsage: usage, source: "current", usagePhase },
        });
      }
      if (isGlm) {
        opts.state.lastGlmUsageKey = usageKey;
        if (usagePhase === "final") opts.state.lastGlmCurrentUsageEventKey = usageEventKey;
        // GLM 可能没有后续 result；最终 stream_event 本身也要进入会话累计。
        if (
          usagePhase === "final"
          && hasNonZeroTokenUsageCounters(usage)
          && opts.state.lastGlmCumulativeUsageEventKey !== usageEventKey
        ) {
          opts.emit({
            ts: Date.now(),
            workspaceId: opts.workspaceId,
            threadId: opts.threadId as any,
            engine: "claude",
            type: "tokenUsage.updated",
            payload: { tokenUsage: usage, source: "cumulative", cumulativeMode: "delta" },
          });
          opts.state.lastGlmCumulativeUsageEventKey = usageEventKey;
          opts.state.hasGlmNonResultFinalUsage = true;
        }
      }
    }
  } else {
    const usage = tryExtractTokenUsage(parsed, opts.state.activeModelId);
    if (usage && shouldEmitResultTokenUsage(parsed, usage)) {
      const isGlm = isGlmModelId(opts.state.activeModelId);
      if (isGlm) {
        // GLM 的末条 result 是本轮权威 usage：同步最近一次请求，并按 delta 累加会话总计。
        const usageKey = tokenUsageKey(usage);
        const usageEventKey = `${tokenUsageEventIdentity(parsed, opts.state)}:${usageKey}`;
        if (opts.state.hasGlmNonResultFinalUsage) {
          // stream_event/assistant 已取得最终 usage；result 可能是同一调用的重复或另一种汇总口径，
          // 仅刷新 UI，避免编排度量把同一轮再次计入。
          if (opts.state.lastGlmUsageKey !== usageKey) {
            opts.emit({
              ts: Date.now(),
              workspaceId: opts.workspaceId,
              threadId: opts.threadId as any,
              engine: "claude",
              type: "tokenUsage.updated",
              payload: { tokenUsage: usage, source: "current", usagePhase: "intermediate" },
            });
            opts.state.lastGlmUsageKey = usageKey;
          }
        } else {
          if (opts.state.lastGlmResultUsageEventKey !== usageEventKey) {
            opts.emit({
              ts: Date.now(),
              workspaceId: opts.workspaceId,
              threadId: opts.threadId as any,
              engine: "claude",
              type: "tokenUsage.updated",
              payload: { tokenUsage: usage, source: "current", usagePhase: "final" },
            });
            opts.state.lastGlmUsageKey = usageKey;
            opts.state.lastGlmCurrentUsageEventKey = usageEventKey;
          }
          if (opts.state.lastGlmCumulativeUsageEventKey !== usageEventKey) {
            opts.emit({
              ts: Date.now(),
              workspaceId: opts.workspaceId,
              threadId: opts.threadId as any,
              engine: "claude",
              type: "tokenUsage.updated",
              payload: { tokenUsage: usage, source: "cumulative", cumulativeMode: "delta" },
            });
            opts.state.lastGlmCumulativeUsageEventKey = usageEventKey;
          }
          opts.state.lastGlmResultUsageEventKey = usageEventKey;
        }
      } else {
        opts.emit({
          ts: Date.now(),
          workspaceId: opts.workspaceId,
          threadId: opts.threadId as any,
          engine: "claude",
          type: "tokenUsage.updated",
          payload: { tokenUsage: usage, source: "cumulative", cumulativeMode: "snapshot" },
        });
      }
    }
  }

  // subagent 内部消息处理：保留 system / tool_progress / error（专用 handler），
  // assistant/user 转换为 childEvent，其余丢弃（避免流式 delta 噪声）。
  if (parentToolUseId != null && parentToolUseId !== "") {
    if (type === "system" || type === "tool_progress" || type === "error") {
      // 继续走已有 handler（subagent lifecycle 事件）
    } else if (type === "assistant" || type === "user") {
      handleSubagentInternalEvent(opts, parsed, String(parentToolUseId));
      return;
    } else {
      return;
    }
  }

  if (type === "error") {
    const errorDetail = parsed.error;
    opts.state.errorFromEvent = String(errorDetail?.message ?? errorDetail ?? parsed.message ?? "Claude error");
    logger.error("claude", `engine error event: ${opts.state.errorFromEvent}`, { error: errorDetail });
    return;
  }

  if (type === "assistant") {
    handleAssistantMessage(opts, parsed);
    return;
  }

  if (type === "user") {
    handleUserMessage(opts, parsed);
    return;
  }

  if (type === "system") {
    handleSystemEvent(opts, parsed);
    return;
  }

  if (type === "tool_progress") {
    handleToolProgress(opts, parsed);
    return;
  }

  if (type === "stream_event") {
    handleStreamEvent(opts, parsed);
    return;
  }

  if (type === "result") {
    // sessionId 已在上方提取；usage 为 session 累计，仅提取 modelContextWindow。
    // 当 result 事件携带 is_error=true 时，提取 errors 数组作为 errorFromEvent（否则错误信息丢失，
    // 回退到 "Claude 退出码：N" 这种无信息量的兜底，且 session 失效检测也无法匹配错误关键字）。
    if (!opts.state.currentAssistant && opts.state.pendingAssistantText) {
      ensureAssistantMessage(opts, `pending_cycle_${opts.state.messageCycle}`);
      completeCurrentAssistantMessage(opts);
    }
    if (parsed.is_error && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      opts.state.errorFromEvent = parsed.errors.map((e: unknown) => String(e ?? "")).join("; ");
      logger.error("claude", `engine result is_error: ${opts.state.errorFromEvent}`, { errors: parsed.errors });
    }
    return;
  }

  if (type === "auth_status") {
    logger.debug("claude", `auth_status: isAuthenticating=${parsed.isAuthenticating}`, {
      output: parsed.output, error: parsed.error,
    });
    return;
  }

  if (type === "rate_limit_event") {
    const info = parsed.rate_limit_info;
    logger.warn("claude", `rate_limit_event: status=${info?.status}`, {
      resetsAt: info?.resetsAt, utilization: info?.utilization,
    });
    // 未来扩展点：emit rateLimit.updated 事件到 Web
    return;
  }

  if (type === "prompt_suggestion") {
    logger.debug("claude", `prompt_suggestion: ${String(parsed.suggestion ?? "").slice(0, 100)}`);
    // 未来扩展点：emit promptSuggestion 事件到 Web
    return;
  }

  if (type === "tool_use_summary") {
    logger.debug("claude", `tool_use_summary: ${String(parsed.summary ?? "").slice(0, 200)}`, {
      precedingToolUseIds: parsed.preceding_tool_use_ids,
    });
    return;
  }
}

function handleAssistantMessage(
  opts: {
    workspacePath: string;
    workspaceId: WorkspaceId;
    threadId: string;
    input: SendMessageInput;
    tool: ToolState;
    state: ClaudeStreamProcessorState;
    assistantLifecycle: AssistantLifecycleTracker;
    emit: ConversationEmitFn;
    providerSlash?: boolean;
  },
  parsed: any,
): void {
  const engineMessageId = String(parsed.message?.id ?? "").trim();
  if (!engineMessageId) return;
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return;
  if (opts.providerSlash && isSyntheticAssistantEvent(parsed) && !opts.state.currentAssistant) {
    const visibleText = content
      .filter((block: any) => String(block?.type ?? "") === "text")
      .map((block: any) => String(block?.text ?? ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (visibleText && visibleText === opts.state.latestAssistantText) return;
  }
  const assistant = ensureAssistantMessage(opts, engineMessageId);

  for (const block of content) {
    const blockType = String(block?.type ?? "");

    if (blockType === "text") {
      const fullText = String(block?.text ?? "");
      if (!fullText || assistant.text === fullText) continue;
      assistant.text = fullText;
      assistant.revision += 1;
      opts.state.latestAssistantText = fullText;
      opts.assistantLifecycle.applySnapshot({
        itemId: assistant.itemId,
        text: fullText,
        revision: assistant.revision,
      });
      opts.emit({
        ts: Date.now(),
        workspaceId: opts.workspaceId,
        threadId: opts.threadId as any,
        engine: "claude",
        type: "item.agentMessage.snapshot",
        payload: {
          itemId: assistant.itemId as any,
          engineMessageId: assistant.engineMessageId,
          turnId: opts.assistantLifecycle.activeTurn() ?? undefined,
          text: fullText,
          revision: assistant.revision,
        },
      });
      continue;
    }

    if (blockType === "thinking") {
      ensureReasoningStarted(opts);
      const fullThinking = String(block?.thinking ?? block?.text ?? "");
      if (!fullThinking || opts.state.reasoningSoFar === fullThinking) continue;
      const delta = fullThinking.startsWith(opts.state.reasoningSoFar)
        ? fullThinking.slice(opts.state.reasoningSoFar.length)
        : fullThinking;
      if (!delta) continue;
      opts.state.reasoningSoFar = fullThinking;
      opts.emit({
        ts: Date.now(),
        workspaceId: opts.workspaceId,
        threadId: opts.threadId as any,
        engine: "claude",
        type: "item.reasoning.delta",
        payload: { itemId: (opts.state.currentReasoningItemId ?? opts.input.reasoningItemId) as any, delta },
      });
      continue;
    }

    if (blockType === "tool_use") {
      const toolName = normalizeClaudeToolName(block?.name ?? "unknown");
      const index = typeof block?.index === "number" ? (block.index as number) : null;
      const toolId = resolveToolUseId(block, index) ?? `tool_${Date.now()}`;
      if (typeof index === "number") opts.tool.toolIdByIndex.set(index, toolId);
      opts.tool.toolNameById.set(toolId, toolName);
      // AskUserQuestion 拦截：映射为 userInput.requested，不 emit tool.started（避免残留工具卡片）
      if (isAskUserQuestion(toolName)) {
        if (block?.input?.questions) emitUserInputRequested(opts, toolId, block.input);
        continue;
      }
      if (isClaudeTaskTodoTool(toolName)) {
        rememberClaudeToolInput(opts.tool, toolId, block?.input);
        rememberClaudeTaskTodoToolInput(opts.tool, toolId, toolName, block?.input);
        continue;
      }
      // 如果是 todowrite 且 input 完整，提前存储 todolistItems（replay 路径下 input 为完整对象）。
      if (toolName === "todowrite" && block?.input?.todos) {
        const items = extractTodolistItems(block.input.todos);
        if (items) opts.tool.toolTodolistItemsById.set(toolId, items);
      }
      // 已通过 stream_event 发出 started → 跳过（避免重复 started 卡片）。
      // 双重守卫：toolStartedEmitted（直接标记）+ toolInputById（streaming input_json_delta 路径证据）。
      // 两者任一存在即说明 streaming 已处理该工具，assistant 消息为 reconciliation 无需重复发射。
      if (opts.tool.toolStartedEmitted.has(toolId) || opts.tool.toolInputById.has(toolId)) {
        continue;
      }
      rememberClaudeToolInput(opts.tool, toolId, block?.input);
      const presentation = createToolPresentation({ toolName, input: block?.input, workspacePath: opts.workspacePath });
      opts.tool.toolPresentationById.set(toolId, presentation);
      opts.tool.toolStartedEmitted.add(toolId);
      opts.emit({
        ts: Date.now(),
        workspaceId: opts.workspaceId,
        threadId: opts.threadId as any,
        engine: "claude",
        type: "item.tool.started",
        payload: { itemId: toolId as any, toolName, input: block?.input, summary: presentation.summary, changes: presentation.changes },
      });
      continue;
    }

    if (blockType === "tool_result") {
      const index = typeof block?.index === "number" ? (block.index as number) : null;
      const toolId = resolveToolResultId(block, index, opts.tool);
      if (!toolId) continue;
      // AskUserQuestion 的 tool_result：清理 pending + 推进 cycle + 如果是 error 通知前端
      const toolNameForResult = opts.tool.toolNameById.get(toolId);
      const isError = Boolean(block?.is_error ?? block?.isError ?? false);
      if (toolNameForResult && isAskUserQuestion(toolNameForResult)) { handleAskUserQuestionToolResult(opts, opts.state, toolId, isError); continue; }
      if (maybeHandleClaudeTaskTodoToolResult(opts, toolId, isError, parsed)) continue;
      const output = extractToolOutput(block?.content);
      const toolName = opts.tool.toolNameById.get(toolId);
      const todolistItems = opts.tool.toolTodolistItemsById.get(toolId);
      const presentation =
        opts.tool.toolPresentationById.get(toolId) ??
        createToolPresentation({ toolName: toolName ?? "unknown", input: safeJson(opts.tool.toolInputById.get(toolId) ?? "") ?? undefined, workspacePath: opts.workspacePath });
      opts.emit({
        ts: Date.now(),
        workspaceId: opts.workspaceId,
        threadId: opts.threadId as any,
        engine: "claude",
        type: "item.tool.completed",
        payload: {
          itemId: toolId as any,
          toolName,
          output,
          error: isError ? "tool_result.is_error" : undefined,
          status: isError ? "failed" : "completed",
          summary: presentation.summary,
          changes: presentation.changes,
          todolistItems,
        },
      });
      maybeHandleSubagentCompletion(opts, toolId, isError);
      continue;
    }

  }
}

function handleUserMessage(
  opts: {
    workspacePath: string;
    workspaceId: WorkspaceId;
    threadId: string;
    input: SendMessageInput;
    tool: ToolState;
    state: ClaudeStreamProcessorState;
    assistantLifecycle: AssistantLifecycleTracker;
    emit: ConversationEmitFn;
    providerSlash?: boolean;
  },
  parsed: any,
): void {
  const localOutput = opts.providerSlash ? extractClaudeLocalCommandOutput(parsed) : null;
  if (localOutput) {
    emitClaudeAssistantText(
      opts,
      localOutput,
      `local_command_${String(parsed.uuid ?? opts.state.messageCycle)}`,
    );
    return;
  }
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return;

  // Claude Code：tool_result 以顶层 `type: "user"` 的 message 输出（而非 assistant content block）。
  for (const block of content) {
    const blockType = String(block?.type ?? "");
    if (blockType !== "tool_result") continue;

    const index = typeof block?.index === "number" ? (block.index as number) : null;
    const toolId = resolveToolResultId(block, index, opts.tool);
    if (!toolId) continue;
    // AskUserQuestion 的 tool_result：清理 pending + 推进 cycle + 如果是 error 通知前端
    const toolNameForResult = opts.tool.toolNameById.get(toolId);
    const isError = Boolean(block?.is_error ?? block?.isError ?? false);
    if (toolNameForResult && isAskUserQuestion(toolNameForResult)) { handleAskUserQuestionToolResult(opts, opts.state, toolId, isError); continue; }
    if (maybeHandleClaudeTaskTodoToolResult(opts, toolId, isError, parsed)) continue;

    const output = extractToolOutput(block?.content);
    const toolName = opts.tool.toolNameById.get(toolId);
    const todolistItems = opts.tool.toolTodolistItemsById.get(toolId);
    const presentation =
      opts.tool.toolPresentationById.get(toolId) ??
      createToolPresentation({ toolName: toolName ?? "unknown", input: safeJson(opts.tool.toolInputById.get(toolId) ?? "") ?? undefined, workspacePath: opts.workspacePath });

    opts.emit({
      ts: Date.now(),
      workspaceId: opts.workspaceId,
      threadId: opts.threadId as any,
      engine: "claude",
      type: "item.tool.completed",
      payload: {
        itemId: toolId as any,
        toolName,
        output,
        error: isError ? "tool_result.is_error" : undefined,
        status: isError ? "failed" : "completed",
        summary: presentation.summary,
        changes: presentation.changes,
        todolistItems,
      },
    });
    // subagent 完成检测：tool_result 可能携带 tool_use_result（含 agentId），用于合成 subagent.completed
    maybeHandleSubagentCompletion(opts, toolId, isError, parsed);
  }
}

function handleStreamEvent(
  opts: {
    workspacePath: string;
    workspaceId: WorkspaceId;
    threadId: string;
    input: SendMessageInput;
    tool: ToolState;
    state: ClaudeStreamProcessorState;
    assistantLifecycle: AssistantLifecycleTracker;
    emit: ConversationEmitFn;
  },
  parsed: any,
): void {
  const inner = parsed.event;
  const innerType = String(inner?.type ?? "");

  if (innerType === "message_start") {
    const message = inner?.message;
    const role = String(message?.role ?? "");
    const engineMessageId = String(message?.id ?? "").trim();
    if (role === "assistant" && engineMessageId) {
      ensureAssistantMessage(opts, engineMessageId);
    }
    return;
  }

  if (innerType === "message_stop") {
    completeCurrentAssistantMessage(opts);
    return;
  }

  if (innerType === "content_block_start") {
    const block = inner?.content_block;
    const blockType = String(block?.type ?? "");
    const index = typeof inner?.index === "number" ? (inner.index as number) : null;

    if (blockType === "thinking") {
      ensureReasoningStarted(opts);
      return;
    }

    if (blockType === "tool_use") {
      const toolName = normalizeClaudeToolName(block?.name ?? "unknown");
      const toolId = resolveToolUseId(block, index) ?? `tool_${Date.now()}`;
      if (typeof index === "number") opts.tool.toolIdByIndex.set(index, toolId);
      opts.tool.toolNameById.set(toolId, toolName);
      // AskUserQuestion：拦截，不 emit tool.started（避免残留"运行中"工具卡片）。
      // 若 input 已完整则直接 emit userInput.requested，否则等 input_json_delta 累积完成。
      if (isAskUserQuestion(toolName)) {
        if (block?.input?.questions) emitUserInputRequested(opts, toolId, block.input);
        return;
      }
      if (isClaudeTaskTodoTool(toolName)) {
        rememberClaudeToolInput(opts.tool, toolId, block?.input);
        rememberClaudeTaskTodoToolInput(opts.tool, toolId, toolName, block?.input);
        return;
      }
      // 如果 block.input 已有完整的 todos，提前存储（某些环境下 content_block_start 即携带完整 input）。
      if (toolName === "todowrite" && block?.input?.todos) {
        const items = extractTodolistItems(block.input.todos);
        if (items) opts.tool.toolTodolistItemsById.set(toolId, items);
      }
      // input 为空对象 {} 时延迟发 tool.started，等 input_json_delta 累积完整后再发（避免前端显示空 {}）。
      if (isEmptyInput(block?.input)) {
        return;
      }
      rememberClaudeToolInput(opts.tool, toolId, block?.input);
      const presentation = createToolPresentation({ toolName, input: block?.input, workspacePath: opts.workspacePath });
      opts.tool.toolPresentationById.set(toolId, presentation);
      opts.tool.toolStartedEmitted.add(toolId);
      opts.emit({
        ts: Date.now(),
        workspaceId: opts.workspaceId,
        threadId: opts.threadId as any,
        engine: "claude",
        type: "item.tool.started",
        payload: { itemId: toolId as any, toolName, input: block?.input, summary: presentation.summary, changes: presentation.changes },
      });
      return;
    }

    // Claude Code：tool_result 可能通过 stream_event 回传（否则 Web 会一直显示"进行中"）。
    if (blockType === "tool_result") {
      const toolId = resolveToolResultId(block, index, opts.tool);
      if (!toolId) return;
      // AskUserQuestion tool_result：清理 pending + 推进 cycle + 如果是 error 通知前端
      const toolNameForResult = opts.tool.toolNameById.get(toolId);
      const isError = Boolean(block?.is_error ?? block?.isError ?? false);
      if (toolNameForResult && isAskUserQuestion(toolNameForResult)) { handleAskUserQuestionToolResult(opts, opts.state, toolId, isError); return; }
      if (maybeHandleClaudeTaskTodoToolResult(opts, toolId, isError, parsed)) return;
      const output = extractToolOutput(block?.content);
      const toolName = opts.tool.toolNameById.get(toolId);
      const todolistItems = opts.tool.toolTodolistItemsById.get(toolId);
      const presentation =
        opts.tool.toolPresentationById.get(toolId) ??
        createToolPresentation({ toolName: toolName ?? "unknown", input: safeJson(opts.tool.toolInputById.get(toolId) ?? "") ?? undefined, workspacePath: opts.workspacePath });
      opts.emit({
        ts: Date.now(),
        workspaceId: opts.workspaceId,
        threadId: opts.threadId as any,
        engine: "claude",
        type: "item.tool.completed",
        payload: {
          itemId: toolId as any,
          toolName,
          output,
          error: isError ? "tool_result.is_error" : undefined,
          status: isError ? "failed" : "completed",
          summary: presentation.summary,
          changes: presentation.changes,
          todolistItems,
        },
      });
      maybeHandleSubagentCompletion(opts, toolId, isError);
      return;
    }

    return;
  }

  if (innerType !== "content_block_delta") return;
  const index = typeof inner?.index === "number" ? (inner.index as number) : null;
  const deltaObj = inner?.delta;
  const deltaType = String(deltaObj?.type ?? "");

  if (deltaType === "tool_use") {
    const toolName = normalizeClaudeToolName(deltaObj?.name ?? inner?.name ?? "unknown");
    const toolId = resolveToolUseId(deltaObj, index) ?? `tool_${Date.now()}`;
    if (typeof index === "number") opts.tool.toolIdByIndex.set(index, toolId);
    opts.tool.toolNameById.set(toolId, toolName);
    // AskUserQuestion：拦截，不 emit tool.started
    const input = deltaObj?.input ?? inner?.input;
    if (isAskUserQuestion(toolName)) {
      if (input?.questions) emitUserInputRequested(opts, toolId, input);
      return;
    }
    if (isClaudeTaskTodoTool(toolName)) {
      rememberClaudeToolInput(opts.tool, toolId, input);
      rememberClaudeTaskTodoToolInput(opts.tool, toolId, toolName, input);
      return;
    }
    // input 为空对象 {} 时延迟发 tool.started（同 content_block_start 逻辑）。
    if (isEmptyInput(input)) {
      return;
    }
    rememberClaudeToolInput(opts.tool, toolId, input);
    const presentation = createToolPresentation({ toolName, input, workspacePath: opts.workspacePath });
    opts.tool.toolPresentationById.set(toolId, presentation);
    opts.tool.toolStartedEmitted.add(toolId);
    opts.emit({
      ts: Date.now(),
      workspaceId: opts.workspaceId,
      threadId: opts.threadId as any,
      engine: "claude",
      type: "item.tool.started",
      payload: { itemId: toolId as any, toolName, input, summary: presentation.summary, changes: presentation.changes },
    });
    return;
  }

  if (deltaType === "tool_result") {
    const toolId = resolveToolResultId(deltaObj, index, opts.tool);
    if (!toolId) return;
    // AskUserQuestion tool_result：清理 pending + 推进 cycle + 如果是 error 通知前端
    const toolNameForResult = opts.tool.toolNameById.get(toolId);
    const isError = Boolean(deltaObj?.is_error ?? deltaObj?.isError ?? false);
    if (toolNameForResult && isAskUserQuestion(toolNameForResult)) { handleAskUserQuestionToolResult(opts, opts.state, toolId, isError); return; }
    if (maybeHandleClaudeTaskTodoToolResult(opts, toolId, isError, parsed)) return;
    const output = extractToolOutput(deltaObj?.content);
    const toolName = opts.tool.toolNameById.get(toolId);
    const todolistItems = opts.tool.toolTodolistItemsById.get(toolId);
    const presentation =
      opts.tool.toolPresentationById.get(toolId) ??
      createToolPresentation({ toolName: toolName ?? "unknown", input: safeJson(opts.tool.toolInputById.get(toolId) ?? "") ?? undefined, workspacePath: opts.workspacePath });
    opts.emit({
      ts: Date.now(),
      workspaceId: opts.workspaceId,
      threadId: opts.threadId as any,
      engine: "claude",
      type: "item.tool.completed",
      payload: {
        itemId: toolId as any,
        toolName,
        output,
        error: isError ? "tool_result.is_error" : undefined,
        status: isError ? "failed" : "completed",
        summary: presentation.summary,
        changes: presentation.changes,
        todolistItems,
      },
    });
    maybeHandleSubagentCompletion(opts, toolId, isError);
    return;
  }

  if (deltaType === "text_delta") {
    const text = String(deltaObj?.text ?? "");
    if (!text) return;
    if (!opts.state.currentAssistant) {
      opts.state.pendingAssistantText += text;
      return;
    }
    const assistant = opts.state.currentAssistant;
    assistant.text += text;
    opts.assistantLifecycle.appendDelta(assistant.itemId, text);
    opts.state.latestAssistantText = assistant.text;
    opts.emit({
      ts: Date.now(),
      workspaceId: opts.workspaceId,
      threadId: opts.threadId as any,
      engine: "claude",
      type: "item.agentMessage.delta",
      payload: {
        itemId: assistant.itemId as any,
        engineMessageId: assistant.engineMessageId,
        turnId: opts.assistantLifecycle.activeTurn() ?? undefined,
        delta: text,
      },
    });
    return;
  }

  if (deltaType === "thinking_delta") {
    const thinking = String(deltaObj?.thinking ?? "");
    if (!thinking) return;
    ensureReasoningStarted(opts);
    opts.state.reasoningSoFar += thinking;
    opts.emit({
      ts: Date.now(),
      workspaceId: opts.workspaceId,
      threadId: opts.threadId as any,
      engine: "claude",
      type: "item.reasoning.delta",
      payload: { itemId: (opts.state.currentReasoningItemId ?? opts.input.reasoningItemId) as any, delta: thinking },
    });
    return;
  }

  if (deltaType !== "input_json_delta") return;
  const partial = String(deltaObj?.partial_json ?? "");
  const toolId = typeof index === "number" ? opts.tool.toolIdByIndex.get(index) ?? null : null;
  if (!toolId || !partial) return;

  const prev = opts.tool.toolInputById.get(toolId) ?? "";
  const next = prev + partial;
  opts.tool.toolInputById.set(toolId, next);
  const parsedJson = safeJson(next);
  if (!parsedJson) {
    // 完整 JSON 未就绪 — 尝试渐进式解析，提前发出 tool.started
    if (!opts.tool.toolStartedEmitted.has(toolId)) {
      const repaired = tryRepairPartialJson(next);
      if (repaired) {
        const toolName = opts.tool.toolNameById.get(toolId);
        // AskUserQuestion 不走渐进式解析（需要完整 questions 数组）
        if (toolName && isAskUserQuestion(toolName)) return;
        // Claude 新版 Task 工具族是 todolist 语义，等完整输入和结果后统一发标准 todolist。
        if (toolName && isClaudeTaskTodoTool(toolName)) return;
        // 文件类工具依赖完整 file_path 才能稳定生成正确摘要。
        // 若在 `F:\\` 这类半截路径上提前发 started，会把卡片错误锁在盘符根路径。
        if (toolName && isFileSummarySensitiveTool(toolName)) return;
        const presentation = createToolPresentation({
          toolName: toolName ?? "unknown", input: repaired, workspacePath: opts.workspacePath,
        });
        if (presentation.summary || presentation.changes?.length) {
          opts.tool.toolStartedEmitted.add(toolId);
          opts.tool.toolPresentationById.set(toolId, presentation);
          opts.emit({
            ts: Date.now(),
            workspaceId: opts.workspaceId,
            threadId: opts.threadId as any,
            engine: "claude",
            type: "item.tool.started",
            payload: {
              itemId: toolId as any,
              toolName: toolName ?? "unknown",
              input: repaired,
              summary: presentation.summary,
              changes: presentation.changes,
            },
          });
        }
      }
    }
    return;
  }

  const toolName = opts.tool.toolNameById.get(toolId);
  // AskUserQuestion：input JSON 完整后 emit userInput.requested，不 emit inputUpdated
  if (toolName && isAskUserQuestion(toolName) && (parsedJson as any)?.questions) {
    emitUserInputRequested(opts, toolId, parsedJson);
    return;
  }
  if (toolName && isClaudeTaskTodoTool(toolName)) {
    rememberClaudeToolInput(opts.tool, toolId, parsedJson);
    rememberClaudeTaskTodoToolInput(opts.tool, toolId, toolName, parsedJson);
    return;
  }
  // todowrite：input JSON 完整后提取并缓存 todolistItems。
  let todolistItems: { step: string; status: string }[] | undefined;
  if (toolName === "todowrite" && (parsedJson as any)?.todos) {
    const items = extractTodolistItems((parsedJson as any).todos);
    if (items) {
      opts.tool.toolTodolistItemsById.set(toolId, items);
      todolistItems = items;
    }
  }

  const presentation = createToolPresentation({ toolName: toolName ?? "unknown", input: parsedJson, workspacePath: opts.workspacePath });
  opts.tool.toolPresentationById.set(toolId, presentation);

  // input 累积完成：如果 tool.started 尚未发出（因 content_block_start 的 input 为空 {} 而被延迟），
  // 此时发出 tool.started（带完整 input/summary/changes），否则照常发 inputUpdated。
  if (!opts.tool.toolStartedEmitted.has(toolId)) {
    opts.tool.toolStartedEmitted.add(toolId);
    opts.emit({
      ts: Date.now(),
      workspaceId: opts.workspaceId,
      threadId: opts.threadId as any,
      engine: "claude",
      type: "item.tool.started",
      payload: {
        itemId: toolId as any,
        toolName: toolName ?? "unknown",
        input: parsedJson,
        summary: presentation.summary,
        changes: presentation.changes,
      },
    });
  } else {
    opts.emit({
      ts: Date.now(),
      workspaceId: opts.workspaceId,
      threadId: opts.threadId as any,
      engine: "claude",
      type: "item.tool.inputUpdated",
      payload: {
        itemId: toolId as any,
        toolName,
        input: parsedJson,
        summary: presentation.summary,
        changes: presentation.changes,
        todolistItems,
      },
    });
  }
}

function handleSystemEvent(
  opts: {
    workspacePath: string;
    workspaceId: WorkspaceId;
    threadId: string;
    tool: ToolState;
    state: ClaudeStreamProcessorState;
    assistantLifecycle: AssistantLifecycleTracker;
    emit: ConversationEmitFn;
    providerSlash?: boolean;
    onPermissionModeChanged?: (mode: string) => void;
    onBackgroundShellTaskStarted?: (input: ClaudeBackgroundShellTaskMeta) => void;
    onBackgroundShellTaskCompleted?: (input: ClaudeBackgroundShellTaskMeta & { status: "completed" | "failed" | "stopped"; summary: string }) => void;
  },
  parsed: any,
): void {
  const subtype = String(parsed.subtype ?? "").trim();
  const taskId = String(parsed.task_id ?? "");
  const rawTaskType = String(parsed.task_type ?? "").trim();
  const toolUseId = String(parsed.tool_use_id ?? "");
  const parentToolUseId = String(parsed.parent_tool_use_id ?? parsed.message?.parent_tool_use_id ?? "").trim();
  const isSubagentTask = Boolean(parentToolUseId);
  if (subtype === "task_started" && taskId && rawTaskType) {
    opts.tool.taskTypeByTaskId.set(taskId, rawTaskType);
  }
  const taskType = rawTaskType || (taskId ? opts.tool.taskTypeByTaskId.get(taskId) ?? "" : "");

  if (subtype === "task_started" || subtype === "task_progress" || subtype === "task_notification") {
    if (!isSubagentTask && taskId && isClaudeBackgroundShellEvent(opts, parsed, taskId, taskType, toolUseId)) {
      const { meta: backgroundShellMeta, created } = ensureClaudeBackgroundShellTaskMeta(opts, parsed, taskId, toolUseId);
      if (created) {
        opts.onBackgroundShellTaskStarted?.(backgroundShellMeta);
      }
      if (subtype === "task_notification") {
        const status = normalizeClaudeBackgroundTaskStatus(String(parsed.status ?? "completed"));
        const summary = String(parsed.summary ?? "").trim();
        opts.onBackgroundShellTaskCompleted?.({
          ...backgroundShellMeta,
          status,
          summary,
        });
      }
      return;
    }

    // ── subagent 相关（需要 taskId）──
    if (!taskId) return;
    if (!shouldHandleClaudeSubagentTaskLifecycle(opts.tool, taskId, taskType, toolUseId)) return;

    if (subtype === "task_started") {
      const earlyTaskId = toolUseId ? opts.tool.subagentTaskIdByToolUseId.get(toolUseId) : null;
      const hasEarlyMapping = earlyTaskId != null && earlyTaskId !== taskId;

      if (hasEarlyMapping) {
        // 早期映射已存在（子事件先到达时创建的）：记录 realTaskId → earlyTaskId 映射，
        // 后续 task_progress/task_notification 可通过此映射找到正确的 itemId。
        opts.tool.earlySubagentTaskIdMapping.set(taskId, earlyTaskId);
        // 仅当 subagent 尚未完成时才发 progress（description 已在 subagent.started 时从 tool_use input 取过）。
        // 如果 completed 已 emit（tool_result 先于 task_started 到达并直接发了 completed），
        // 再发 progress 会把终态踩回 running，导致 finalizeDanglingTools 误标为 failed。
        if (!opts.tool.completedSubagentIds.has(toolUseId)) {
          opts.emit({
            ts: Date.now(),
            workspaceId: opts.workspaceId,
            threadId: opts.threadId as any,
            engine: "claude",
            type: "item.subagent.progress",
            payload: {
              itemId: `subagent_${earlyTaskId}` as any,
              taskId: earlyTaskId,
              description: String(parsed.description ?? ""),
            },
          });
        }
      } else {
        // 正常路径：建立 parent_tool_use_id → taskId 映射 + 初始化子 ToolState
        if (toolUseId) {
          opts.tool.subagentTaskIdByToolUseId.set(toolUseId, taskId);
          opts.tool.subagentToolStateByTaskId.set(taskId, createToolState());
        }
        opts.emit({
          ts: Date.now(),
          workspaceId: opts.workspaceId,
          threadId: opts.threadId as any,
          engine: "claude",
          type: "item.subagent.started",
          payload: {
            itemId: `subagent_${taskId}` as any,
            taskId,
            toolUseId: parsed.tool_use_id ?? undefined,
            description: String(parsed.description ?? ""),
            taskType: parsed.task_type ?? undefined,
          },
        });
      }

      // 检查 pending 缓存：如果 tool_result 先于 task_started 到达（Claude Code 事件乱序），
      // 则立即补发 item.subagent.completed。
      const effectiveTaskId = hasEarlyMapping ? earlyTaskId : taskId;
      if (toolUseId) {
        const pending = opts.tool.pendingSubagentCompletion.get(toolUseId);
        if (pending) {
          opts.tool.pendingSubagentCompletion.delete(toolUseId);
          opts.tool.completedSubagentIds.add(toolUseId);
          if (effectiveTaskId !== toolUseId) opts.tool.completedSubagentIds.add(effectiveTaskId);
          // 同时将 realTaskId 加入，供后续 task_progress 通过 effectiveTaskId 查找。
          opts.tool.completedSubagentIds.add(taskId);
          opts.emit({
            ts: Date.now(),
            workspaceId: opts.workspaceId,
            threadId: opts.threadId as any,
            engine: "claude",
            type: "item.subagent.completed",
            payload: {
              itemId: `subagent_${effectiveTaskId}` as any,
              taskId: effectiveTaskId,
              status: pending.status as "completed" | "failed" | "stopped",
              summary: pending.summary,
              usage: pending.usage,
            },
          });
        }
      }
      return;
    }

    // task_progress / task_notification：优先使用早期映射的 taskId
    const effectiveTaskId = opts.tool.earlySubagentTaskIdMapping.get(taskId) ?? taskId;
    const itemId = `subagent_${effectiveTaskId}`;

    if (subtype === "task_progress") {
      // subagent 已完成时跳过 progress：迟到的 task_progress 会把终态踩回 running。
      if (opts.tool.completedSubagentIds.has(effectiveTaskId) || opts.tool.completedSubagentIds.has(taskId)) return;
      const usage = parsed.usage
        ? { totalTokens: Number(parsed.usage.total_tokens ?? 0), toolUses: Number(parsed.usage.tool_uses ?? 0), durationMs: Number(parsed.usage.duration_ms ?? 0) }
        : undefined;
      opts.emit({
        ts: Date.now(),
        workspaceId: opts.workspaceId,
        threadId: opts.threadId as any,
        engine: "claude",
        type: "item.subagent.progress",
        payload: {
          itemId: itemId as any,
          taskId: effectiveTaskId,
          description: String(parsed.description ?? ""),
          lastToolName: parsed.last_tool_name ?? undefined,
          usage,
        },
      });
      return;
    }

    if (subtype === "task_notification") {
      const status = String(parsed.status ?? "completed");
      const usage = parsed.usage
        ? { totalTokens: Number(parsed.usage.total_tokens ?? 0), toolUses: Number(parsed.usage.tool_uses ?? 0), durationMs: Number(parsed.usage.duration_ms ?? 0) }
        : undefined;
      // 标记 completed，阻止迟到的 task_progress 踩终态。
      opts.tool.completedSubagentIds.add(effectiveTaskId);
      if (effectiveTaskId !== taskId) opts.tool.completedSubagentIds.add(taskId);
      opts.emit({
        ts: Date.now(),
        workspaceId: opts.workspaceId,
        threadId: opts.threadId as any,
        engine: "claude",
        type: "item.subagent.completed",
        payload: {
          itemId: itemId as any,
          taskId: effectiveTaskId,
          status: status as "completed" | "failed" | "stopped",
          summary: String(parsed.summary ?? ""),
          usage,
        },
      });
      return;
    }

    return;
  }

  // ── 非 subagent system 事件（无需 taskId）──

  if (subtype === "init") {
    logger.info("claude", `system.init: model=${parsed.model ?? "unknown"}`, {
      tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
    });
    return;
  }

  if (subtype === "compact_boundary") {
    logger.info("claude", `system.compact_boundary`, {
      trigger: parsed.compact_metadata?.trigger,
      preTokens: parsed.compact_metadata?.pre_tokens,
    });
    const preTokens = Number(parsed.compact_metadata?.pre_tokens ?? 0);
    const preLabel = Number.isFinite(preTokens) && preTokens > 0 ? `（压缩前约 ${formatTokenCount(preTokens)} tokens）` : "";
    opts.emit({
      ts: Date.now(),
      workspaceId: opts.workspaceId,
      threadId: opts.threadId as any,
      engine: "claude",
      type: "system.notice",
      payload: {
        level: "success",
        text: `上下文压缩完成${preLabel}。`,
        action: "context.compacted",
      },
    });
    return;
  }

  if (subtype === "status") {
    logger.info("claude", `system.status: ${parsed.status ?? "null"}`, {
      permissionMode: parsed.permissionMode ?? undefined,
    });
    if (String(parsed.status ?? "").trim() === "compacting") {
      opts.emit({
        ts: Date.now(),
        workspaceId: opts.workspaceId,
        threadId: opts.threadId as any,
        engine: "claude",
        type: "system.notice",
        payload: {
          level: "info",
          text: "Claude 正在压缩上下文…",
        },
      });
    }
    // Claude Code auto-approve 场景：通过 system.status 通知 permissionMode 变更
    const newPermMode = String(parsed.permissionMode ?? "").trim();
    if (newPermMode && opts.onPermissionModeChanged) {
      opts.onPermissionModeChanged(newPermMode);
    }
    return;
  }

  // ── 低优先级 system 事件：debug 记录 ──
  if (subtype === "hook_started" || subtype === "hook_progress" || subtype === "hook_response") {
    logger.debug("claude", `system.${subtype}: hook=${parsed.hook_name ?? parsed.hook_id ?? "?"}`);
    return;
  }
  if (subtype === "files_persisted") {
    logger.debug("claude", `system.files_persisted`, {
      filesCount: Array.isArray(parsed.files) ? parsed.files.length : 0,
    });
    return;
  }

  if (subtype === "local_command_output") {
    const localOutput = opts.providerSlash ? extractClaudeLocalCommandOutput(parsed) : null;
    if (localOutput) {
      emitClaudeAssistantText(
        opts,
        localOutput,
        `local_command_${String(parsed.uuid ?? opts.state.messageCycle)}`,
      );
    }
    return;
  }
  if (subtype === "elicitation_complete") { logger.debug("claude", `system.elicitation_complete`); return; }
  // thinking_tokens 仅报告内部思考 token 计数，不生成会话事件或重复日志。
  if (subtype === "thinking_tokens") return;
  // Claude 2.1.274 的后台任务状态由生命周期层消费；这里仅标记为已知事件，避免误报未知 subtype。
  if (subtype === "background_tasks_changed" || subtype === "task_updated") return;

  // 兜底：未识别的 system subtype。
  // stdout 原文会由 threadSession 统一落到 raw 事件，这里不再重复发射第二份 raw。
  logger.warn("claude", `unhandled system subtype="${subtype}"`, { taskId: taskId || undefined });
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function handleToolProgress(
  opts: {
    workspaceId: WorkspaceId;
    threadId: string;
    emit: ConversationEmitFn;
  },
  parsed: any,
): void {
  const toolUseId = String(parsed.tool_use_id ?? "");
  const toolName = String(parsed.tool_name ?? "");
  const elapsed = Number(parsed.elapsed_time_seconds ?? 0);
  if (!toolUseId) return;

  // 如果有 task_id，说明这是 subagent 内部的工具进度，暂不处理（由 subagent progress 覆盖）。
  if (parsed.task_id) return;

  const displayText = toolName ? `${toolName} (${elapsed.toFixed(0)}s)` : `工具运行中 (${elapsed.toFixed(0)}s)`;
  opts.emit({
    ts: Date.now(),
    workspaceId: opts.workspaceId,
    threadId: opts.threadId as any,
    engine: "claude",
    type: "item.tool.outputDelta",
    payload: {
      itemId: toolUseId as any,
      toolName: toolName || undefined,
      delta: displayText,
      mode: "replace",
    },
  });
}

/** Claude Code 的 AskUserQuestion 工具判定。 */
function isAskUserQuestion(toolName: string): boolean {
  return toolName.toLowerCase() === "askuserquestion";
}

/** 将 AskUserQuestion input 映射为 userInput.requested 事件并缓存 requestId→toolUseId。 */
function emitUserInputRequested(
  opts: { workspaceId: WorkspaceId; threadId: string; input: SendMessageInput; tool: ToolState; emit: ConversationEmitFn },
  toolUseId: string,
  input: any,
): void {
  const requestId = `askuser_${toolUseId}`;
  const hasControlRequest = opts.tool.controlRequestIdByToolUseId.has(toolUseId);
  logger.info("claude", `emitUserInputRequested: registering requestId=${requestId} toolUseId=${toolUseId}`, {
    pendingBefore: Array.from(opts.tool.pendingUserInputByRequestId.keys()),
    questionsCount: Array.isArray(input?.questions) ? input.questions.length : 0,
    hasControlRequest,
    claudeResultReceived: opts.tool.claudeResultReceived,
  });
  if (!hasControlRequest) {
    logger.warn("claude", `emitUserInputRequested: control_request for AskUserQuestion has NOT arrived yet (toolUseId=${toolUseId}). If --permission-prompt-tool stdio is not enabled, control_request will never arrive and CC will auto-complete this tool.`);
  }
  opts.tool.pendingUserInputByRequestId.set(requestId, toolUseId);

  const questionsRaw = Array.isArray(input?.questions) ? (input.questions as unknown[]) : [];
  const questions: RequestUserInputQuestion[] = questionsRaw.map((q: any, idx: number) => {
    const optionsRaw = Array.isArray(q?.options) ? (q.options as unknown[]) : [];
    const options = optionsRaw
      .map((o: any) => {
        const label = String(o?.label ?? "").trim();
        const description = String(o?.description ?? "").trim();
        if (!label && !description) return null;
        return { label, description };
      })
      .filter((v): v is { label: string; description: string } => Boolean(v));

    return {
      id: `q_${idx}`,
      header: String(q?.header ?? "").trim(),
      question: String(q?.question ?? "").trim(),
      isOther: !options.length,
      options: options.length ? options : undefined,
      multiSelect: Boolean(q?.multiSelect),
    } satisfies RequestUserInputQuestion;
  });

  const event: ConversationEventInput = {
    ts: Date.now(),
    workspaceId: opts.workspaceId,
    threadId: opts.threadId as any,
    engine: "claude",
    type: "userInput.requested",
    payload: {
      request: {
        requestId,
        params: {
          workspaceId: opts.workspaceId,
          threadId: opts.threadId as any,
          turnId: opts.input.turnId,
          itemId: `userInput_${toolUseId}` as any,
          questions,
        },
      },
    },
  };
  opts.emit(event);
}

/** 处理 subagent 内部 assistant/user 消息，转换为 childEvent 发送到 Web 端。 */
function handleSubagentInternalEvent(
  opts: {
    workspacePath: string;
    workspaceId: WorkspaceId;
    threadId: string;
    tool: ToolState;
    emit: ConversationEmitFn;
  },
  parsed: any,
  parentToolUseId: string,
): void {
  let taskId = opts.tool.subagentTaskIdByToolUseId.get(parentToolUseId);
  if (!taskId) {
    // task_started 尚未到达：使用 toolUseId 作为早期 taskId，立即显示 subagent 卡片。
    taskId = parentToolUseId;
    opts.tool.subagentTaskIdByToolUseId.set(parentToolUseId, taskId);
    opts.tool.subagentToolStateByTaskId.set(taskId, createToolState());
    // 从 Task 工具的 tool_use input 中提取 description（tool_use 事件早于 task_started 到达，
    // 这样无需依赖迟到的 task_started 来补 description）。
    const inputStr = opts.tool.toolInputById.get(parentToolUseId) ?? "";
    const inputObj = safeJson(inputStr);
    const description = String((inputObj as any)?.description ?? "");
    opts.emit({
      ts: Date.now(),
      workspaceId: opts.workspaceId,
      threadId: opts.threadId as any,
      engine: "claude",
      type: "item.subagent.started",
      payload: {
        itemId: `subagent_${taskId}` as any,
        taskId,
        toolUseId: parentToolUseId,
        description,
        taskType: "local_agent",
      },
    });
  }
  const itemId = `subagent_${taskId}`;
  const subTool = opts.tool.subagentToolStateByTaskId.get(taskId);
  if (!subTool) return;

  const content = parsed.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    const blockType = String(block?.type ?? "");

    if (blockType === "tool_use") {
      const toolName = String(block?.name ?? "unknown");
      const index = typeof block?.index === "number" ? (block.index as number) : null;
      const toolId = resolveToolUseId(block, index) ?? `sub_tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      if (typeof index === "number") subTool.toolIdByIndex.set(index, toolId);
      subTool.toolNameById.set(toolId, toolName);
      const presentation = createToolPresentation({ toolName, input: block?.input, workspacePath: opts.workspacePath });
      emitSubagentChildEvent(opts, itemId, taskId, "item.tool.started", {
        itemId: toolId,
        toolName,
        input: block?.input,
        summary: presentation.summary,
        changes: presentation.changes,
      });
      continue;
    }

    if (blockType === "tool_result") {
      const index = typeof block?.index === "number" ? (block.index as number) : null;
      const toolId = resolveToolResultId(block, index, subTool);
      if (!toolId) continue;
      const isError = Boolean(block?.is_error ?? block?.isError ?? false);
      const output = extractToolOutput(block?.content);
      const toolName = subTool.toolNameById.get(toolId);
      emitSubagentChildEvent(opts, itemId, taskId, "item.tool.completed", {
        itemId: toolId,
        toolName,
        output,
        status: isError ? "failed" : "completed",
      });
      continue;
    }

    if (blockType === "text") {
      const text = String(block?.text ?? "").trim();
      if (!text) continue;
      emitSubagentChildEvent(opts, itemId, taskId, "item.agentMessage.delta", {
        itemId: `sub_msg_${taskId}`,
        delta: text,
      });
      continue;
    }

    if (blockType === "thinking") {
      const thinking = String(block?.thinking ?? block?.text ?? "").trim();
      if (!thinking) continue;
      emitSubagentChildEvent(opts, itemId, taskId, "item.reasoning.delta", {
        itemId: `sub_reasoning_${taskId}`,
        delta: thinking,
      });
    }
  }
}

function emitSubagentChildEvent(
  opts: { workspaceId: WorkspaceId; threadId: string; emit: ConversationEmitFn },
  itemId: string,
  taskId: string,
  innerEventType: string,
  innerPayload: unknown,
): void {
  opts.emit({
    ts: Date.now(),
    workspaceId: opts.workspaceId,
    threadId: opts.threadId as any,
    engine: "claude",
    type: "item.subagent.childEvent",
    payload: { itemId: itemId as any, taskId, innerEventType, innerPayload },
  });
}

/**
 * tool_result 完成后检查是否为 subagent 的 Task 工具：如果是，合成 item.subagent.completed 事件。
 * Claude Code 不总是发 task_notification 系统事件，且 task_started 可能晚于 tool_result 到达（事件乱序）。
 * 两种路径：
 * - task_started 已到达 → subagentTaskIdByToolUseId 有映射 → 立即 emit completed
 * - task_started 尚未到达 → 从 tool_use_result.agentId 获取 taskId → 缓存到 pendingSubagentCompletion
 */
function maybeHandleSubagentCompletion(
  opts: { workspaceId: WorkspaceId; threadId: string; tool: ToolState; emit: ConversationEmitFn },
  toolUseId: string,
  isError: boolean,
  parsed?: any,
): void {
  const toolUseResult = parsed?.tool_use_result;
  const taskIdFromMapping = opts.tool.subagentTaskIdByToolUseId.get(toolUseId);
  const taskIdFromResult = toolUseResult?.agentId ? String(toolUseResult.agentId) : null;
  const taskId = taskIdFromMapping ?? taskIdFromResult;
  if (!taskId) return;

  const status = isError ? "failed" : (String(toolUseResult?.status ?? "completed") === "failed" ? "failed" : "completed");
  const usage = toolUseResult
    ? {
        totalTokens: Number(toolUseResult.totalTokens ?? toolUseResult.total_tokens ?? 0),
        toolUses: Number(toolUseResult.totalToolUseCount ?? toolUseResult.tool_uses ?? 0),
        durationMs: Number(toolUseResult.totalDurationMs ?? toolUseResult.duration_ms ?? 0),
      }
    : undefined;
  let summary = "";
  if (Array.isArray(toolUseResult?.content)) {
    summary = toolUseResult.content.map((c: any) => String(c?.text ?? "")).filter(Boolean).join("\n");
  }

  // task_started 尚未到达：缓存完成信息，等 task_started 补发
  if (!taskIdFromMapping) {
    opts.tool.pendingSubagentCompletion.set(toolUseId, { taskId, status, summary, usage });
    return;
  }

  // task_started 已到达：立即 emit completed
  // 同时记录 toolUseId 和 taskId（正常路径下两者不同），供 task_started/task_progress 判断是否跳过 progress。
  opts.tool.completedSubagentIds.add(toolUseId);
  if (taskId !== toolUseId) opts.tool.completedSubagentIds.add(taskId);
  const itemId = `subagent_${taskId}`;
  opts.emit({
    ts: Date.now(),
    workspaceId: opts.workspaceId,
    threadId: opts.threadId as any,
    engine: "claude",
    type: "item.subagent.completed",
    payload: {
      itemId: itemId as any,
      taskId,
      status: status as "completed" | "failed" | "stopped",
      summary,
      usage,
    },
  });
}

/**
 * 尝试修复未闭合的 JSON 字符串，提取已完成的字段。
 * 通过追加闭合符使其变为合法 JSON。仅用于 presentation 展示，不用于工具执行。
 */
function tryRepairPartialJson(partial: string): unknown | null {
  // 尝试多种闭合策略（覆盖：值末尾/字符串中间/嵌套对象）
  const closers = ['"}', '}', '"}}', '}}'];
  for (const closer of closers) {
    const patched = partial + closer;
    try {
      return JSON.parse(patched);
    } catch { /* continue */ }
  }
  return null;
}

/** 判断 tool input 是否为空对象 {}（Claude API content_block_start 天然携带的空 input）。 */
function isEmptyInput(input: unknown): boolean {
  if (input == null) return true;
  if (typeof input !== "object" || Array.isArray(input)) return false;
  return Object.keys(input as Record<string, unknown>).length === 0;
}

/** 记录完整 tool input，供后续 Claude task lifecycle 判断后台运行标记。 */
function rememberClaudeToolInput(tool: ToolState, toolId: string, input: unknown): void {
  if (isEmptyInput(input)) return;
  tool.toolInputById.set(toolId, JSON.stringify(input));
}

/** 暂存 Claude TaskCreate 输入；真实 taskId 要等 tool_result 返回后才能绑定。 */
function rememberClaudeTaskTodoToolInput(tool: ToolState, toolId: string, toolName: string, input: unknown): void {
  if (!isClaudeTaskCreateTool(toolName)) return;
  const obj = asRecord(input);
  const step = pickFirstString(obj, ["subject", "content", "title", "task"]);
  if (!step) return;
  const existing = tool.pendingClaudeTaskTodoByToolUseId.get(toolId);
  tool.pendingClaudeTaskTodoByToolUseId.set(toolId, {
    step,
    status: pickFirstString(obj, ["status"]) || "pending",
    description: pickFirstString(obj, ["description"]) || undefined,
    activeForm: pickFirstString(obj, ["activeForm", "active_form"]) || undefined,
    order: existing?.order ?? ++tool.claudeTaskTodoOrder,
  });
}

/** 把 Claude TaskCreate/TaskUpdate/TaskList 结果映射为统一 todowrite 快照。 */
function maybeHandleClaudeTaskTodoToolResult(
  opts: {
    workspaceId: WorkspaceId;
    threadId: string;
    input: SendMessageInput;
    tool: ToolState;
    emit: ConversationEmitFn;
  },
  toolId: string,
  isError: boolean,
  parsed: any,
): boolean {
  const toolName = opts.tool.toolNameById.get(toolId);
  if (!toolName || !isClaudeTaskTodoTool(toolName)) return false;
  const result = parsed?.tool_use_result ?? parsed?.toolUseResult ?? null;
  if (isError || isFailureResult(result)) return false;

  const changed = isClaudeTaskCreateTool(toolName)
    ? applyClaudeTaskCreateResult(opts.tool, toolId, result)
    : isClaudeTaskUpdateTool(toolName)
      ? applyClaudeTaskUpdateResult(opts.tool, toolId)
      : applyClaudeTaskListResult(opts.tool, result);

  if (!changed) return false;
  emitClaudeTaskTodolistSnapshot(opts);
  return true;
}

/** 将 TaskCreate 的返回 ID 与之前缓存的任务内容绑定。 */
function applyClaudeTaskCreateResult(tool: ToolState, toolId: string, result: unknown): boolean {
  const resultObj = asRecord(result);
  const taskObj = asRecord(resultObj?.task);
  const taskId = pickFirstString(taskObj, ["id", "taskId"]) || pickFirstString(resultObj, ["taskId", "id"]);
  const pending = tool.pendingClaudeTaskTodoByToolUseId.get(toolId);
  const step = pending?.step || pickFirstString(taskObj, ["subject", "content", "title", "task"]);
  if (!taskId || !step) return false;
  const existing = tool.claudeTaskTodoById.get(taskId);
  tool.claudeTaskTodoById.set(taskId, {
    id: taskId,
    step,
    status: existing?.status || pending?.status || pickFirstString(taskObj, ["status"]) || "pending",
    description: pending?.description || pickFirstString(taskObj, ["description"]) || undefined,
    activeForm: pending?.activeForm || pickFirstString(taskObj, ["activeForm", "active_form"]) || undefined,
    order: existing?.order ?? pending?.order ?? ++tool.claudeTaskTodoOrder,
  });
  tool.pendingClaudeTaskTodoByToolUseId.delete(toolId);
  return true;
}

/** 根据 TaskUpdate 输入更新已知任务状态。 */
function applyClaudeTaskUpdateResult(tool: ToolState, toolId: string): boolean {
  const input = safeJson(tool.toolInputById.get(toolId) ?? "");
  const inputObj = asRecord(input);
  const taskId = pickFirstString(inputObj, ["taskId", "task_id", "id"]);
  const status = pickFirstString(inputObj, ["status"]);
  if (!taskId || !status) return false;
  const existing = tool.claudeTaskTodoById.get(taskId);
  const step = existing?.step || pickFirstString(inputObj, ["subject", "content", "title", "task"]);
  if (!step) return false;
  tool.claudeTaskTodoById.set(taskId, {
    id: taskId,
    step,
    status,
    description: existing?.description || pickFirstString(inputObj, ["description"]) || undefined,
    activeForm: existing?.activeForm || pickFirstString(inputObj, ["activeForm", "active_form"]) || undefined,
    order: existing?.order ?? ++tool.claudeTaskTodoOrder,
  });
  return true;
}

/** 使用 TaskList 返回的完整列表修正本地任务快照。 */
function applyClaudeTaskListResult(tool: ToolState, result: unknown): boolean {
  const resultObj = asRecord(result);
  const rawTasks = Array.isArray(resultObj?.tasks)
    ? resultObj.tasks
    : Array.isArray(resultObj?.taskList)
      ? resultObj.taskList
      : [];
  let changed = false;
  for (const rawTask of rawTasks) {
    const task = asRecord(rawTask);
    const taskId = pickFirstString(task, ["id", "taskId", "task_id"]);
    const step = pickFirstString(task, ["subject", "content", "title", "task"]);
    if (!taskId || !step) continue;
    const existing = tool.claudeTaskTodoById.get(taskId);
    tool.claudeTaskTodoById.set(taskId, {
      id: taskId,
      step,
      status: pickFirstString(task, ["status"]) || existing?.status || "pending",
      description: pickFirstString(task, ["description"]) || existing?.description,
      activeForm: pickFirstString(task, ["activeForm", "active_form"]) || existing?.activeForm,
      order: existing?.order ?? ++tool.claudeTaskTodoOrder,
    });
    changed = true;
  }
  return changed;
}

/** 发出一个稳定的 todowrite 卡片，让 Web 复用既有 todolist 渲染与浮条逻辑。 */
function emitClaudeTaskTodolistSnapshot(opts: {
  workspaceId: WorkspaceId;
  threadId: string;
  input: SendMessageInput;
  tool: ToolState;
  emit: ConversationEmitFn;
}): void {
  const tasks = Array.from(opts.tool.claudeTaskTodoById.values()).sort((a, b) => a.order - b.order);
  if (!tasks.length) return;
  const todolistItems = tasks.map(({ step, status }) => ({ step, status }));
  const itemId = `claude_todolist_${String(opts.input.turnId)}`;
  const input = {
    source: "claude_task_tools",
    tasks: tasks.map(({ id, step, status, description, activeForm }) => ({ id, step, status, description, activeForm })),
  };
  if (!opts.tool.toolStartedEmitted.has(itemId)) {
    opts.tool.toolStartedEmitted.add(itemId);
    opts.emit({
      ts: Date.now(),
      workspaceId: opts.workspaceId,
      threadId: opts.threadId as any,
      engine: "claude",
      type: "item.tool.started",
      payload: { itemId: itemId as any, toolName: "todowrite", input, summary: "任务清单" },
    });
  }
  opts.emit({
    ts: Date.now(),
    workspaceId: opts.workspaceId,
    threadId: opts.threadId as any,
    engine: "claude",
    type: "item.tool.completed",
    payload: {
      itemId: itemId as any,
      toolName: "todowrite",
      output: input,
      status: "completed",
      summary: "任务清单",
      todolistItems,
    },
  });
}

/** 识别新版 Claude 任务管理工具中可转成 todolist 的工具。 */
function isClaudeTaskTodoTool(toolNameRaw: unknown): boolean {
  return isClaudeTaskCreateTool(toolNameRaw) || isClaudeTaskUpdateTool(toolNameRaw) || normalizeClaudeTaskToolKey(toolNameRaw) === "tasklist";
}

/** 识别新版 Claude 的任务创建工具。 */
function isClaudeTaskCreateTool(toolNameRaw: unknown): boolean {
  return normalizeClaudeTaskToolKey(toolNameRaw) === "taskcreate";
}

/** 识别新版 Claude 的任务状态更新工具。 */
function isClaudeTaskUpdateTool(toolNameRaw: unknown): boolean {
  return normalizeClaudeTaskToolKey(toolNameRaw) === "taskupdate";
}

/** 统一 Claude Task 工具名大小写与分隔符。 */
function normalizeClaudeTaskToolKey(toolNameRaw: unknown): string {
  return String(toolNameRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

/** 判断工具结果是否显式失败，避免失败时伪造 todolist 成功。 */
function isFailureResult(result: unknown): boolean {
  const obj = asRecord(result);
  return Boolean(obj?.success === false || obj?.is_error === true || obj?.isError === true);
}

/** 将未知值安全视为普通对象。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 从对象中按优先级提取非空字符串字段。 */
function pickFirstString(obj: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (!obj) return "";
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function isFileSummarySensitiveTool(toolNameRaw: string): boolean {
  const toolName = String(toolNameRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (
    toolName === "filechange" ||
    toolName === "file_change" ||
    toolName === "edit" ||
    toolName === "multi_edit" ||
    toolName === "multiedit" ||
    toolName === "write" ||
    toolName === "write_file" ||
    toolName === "writefile"
  );
}

function normalizeClaudeToolName(raw: unknown): string {
  /** 将 Claude Code 的 TodoWrite 统一命名为 `todowrite`，避免与 Plan 模式/产物混名。 */
  const name = String(raw ?? "").trim();
  if (!name) return "unknown";

  const normalized = name.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "todowrite" || normalized === "todo_write") return "todowrite";
  return name;
}

/** 判断 Claude task lifecycle 是否属于 Agent/Explore 子代理，而非后台命令等通用 task。 */
function shouldHandleClaudeSubagentTaskLifecycle(tool: ToolState, taskId: string, taskType: string, toolUseId: string): boolean {
  if (taskType) return taskType === "local_agent";
  if (toolUseId && tool.subagentTaskIdByToolUseId.has(toolUseId)) return true;
  if (taskId && tool.earlySubagentTaskIdMapping.has(taskId)) return true;
  if (toolUseId && isClaudeAgentToolUse(tool, toolUseId)) return true;
  return false;
}

/** 兼容旧 Claude：缺少 task_type 时，用 tool_use 的工具名识别 Agent 子代理。 */
function isClaudeAgentToolUse(tool: ToolState, toolUseId: string): boolean {
  const toolName = tool.toolNameById.get(toolUseId);
  return typeof toolName === "string" && toolName.toLowerCase() === "agent";
}

function buildClaudeBackgroundShellTaskMeta(
  opts: { workspacePath: string; tool: ToolState },
  parsed: any,
  taskId: string,
  toolUseId: string,
): ClaudeBackgroundShellTaskMeta {
  const inputStr = toolUseId ? opts.tool.toolInputById.get(toolUseId) ?? "" : "";
  const inputObj = safeJson(inputStr) as Record<string, unknown> | null;
  const command = resolveClaudeBackgroundShellCommand(inputObj, String(parsed.description ?? "").trim());
  const description = String(parsed.description ?? inputObj?.description ?? command ?? "").trim() || "后台命令";
  return {
    taskId,
    toolUseId: toolUseId || undefined,
    description,
    command: command || description,
    startedAt: Date.now(),
  };
}

function ensureClaudeBackgroundShellTaskMeta(
  opts: { workspacePath: string; tool: ToolState },
  parsed: any,
  taskId: string,
  toolUseId: string,
): { meta: ClaudeBackgroundShellTaskMeta; created: boolean } {
  const existing = opts.tool.backgroundShellMetaByTaskId.get(taskId) ?? null;
  if (existing) {
    return { meta: existing, created: false };
  }
  const meta = buildClaudeBackgroundShellTaskMeta(opts, parsed, taskId, toolUseId);
  opts.tool.backgroundShellMetaByTaskId.set(taskId, meta);
  return { meta, created: true };
}

/** 识别明确后台运行的 Claude Bash lifecycle，普通 local_bash 仅排除 subagent。 */
function isClaudeBackgroundShellEvent(
  opts: { tool: ToolState },
  _parsed: any,
  taskId: string,
  taskType: string,
  toolUseId: string,
): boolean {
  if (opts.tool.backgroundShellMetaByTaskId.has(taskId)) return true;
  if (!toolUseId) return false;
  return hasClaudeBackgroundFlag(opts.tool.toolInputById.get(toolUseId) ?? "");
}

function hasClaudeBackgroundFlag(inputJson: string): boolean {
  if (!inputJson) return false;
  const inputObj = safeJson(inputJson) as Record<string, unknown> | null;
  return inputObj?.run_in_background === true || inputObj?.runInBackground === true;
}

function resolveClaudeBackgroundShellCommand(
  inputObj: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!inputObj) return fallback;
  const candidates = [
    inputObj.command,
    inputObj.script,
    inputObj.description,
  ];
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (text) return text;
  }
  return fallback;
}

function normalizeClaudeBackgroundTaskStatus(status: string): "completed" | "failed" | "stopped" {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "stopped" || normalized === "killed") return "stopped";
  if (normalized === "failed") return "failed";
  return "completed";
}

