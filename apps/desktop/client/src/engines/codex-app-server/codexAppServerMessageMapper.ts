import { MANUAL_TURN_INTERRUPT_CODE, type AssistantCompletionSource, type AssistantMessagePhase, type ConversationEventInput, type TokenUsageSnapshot, type TurnId, type WorkspaceId } from "@codeflowai/shared";

import type { ConversationEmitFn } from "../threadSession.js";
import { normalizeAssistantMessagePhase } from "../assistantLifecycle.js";
import { createToolPresentation } from "../tool-presentation.js";
import type { CodexAppServerMessage } from "./codexAppServerWorkspace.js";
import { buildAsyncUserInputRequest } from "./codexAppServerRequests.js";

export type ActiveTurnLike = {
  clientTurnId: TurnId;
  codexTurnId: string | null;
  manualInterruptRequested?: boolean;
  manualInterruptError?: Error | null;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

export type TransientReconnectInfo = {
  turnId: string | null;
  message: string;
  additionalDetails: string | null;
  willRetry: boolean;
  responseStreamDisconnected: boolean;
};

export type FinalTurnErrorInfo = {
  turnId: string | null;
  error: Error;
  additionalDetails: string | null;
  providerErrorInfo: string | null;
  responseStreamDisconnected: boolean;
};

/** 从 app-server 终态参数中统一提取 provider turnId。 */
function extractProviderTurnId(params: Record<string, unknown> | undefined): string {
  return String(
    (params as any)?.turnId
    ?? (params as any)?.turn_id
    ?? (params as any)?.turn?.id
    ?? "",
  ).trim();
}

/** 缺少 turnId 的终态只能由 session 做权威读取对账。 */
function terminalNotificationMatchesActiveTurn(active: ActiveTurnLike, providerTurnId: string): boolean {
  const activeProviderTurnId = String(active.codexTurnId ?? "").trim();
  return Boolean(providerTurnId) && providerTurnId === activeProviderTurnId;
}

/** 识别 Workspace 为进程/传输故障合成的无 turnId error。 */
export function isCodexSyntheticTransportFault(
  method: string,
  params: Record<string, unknown> | undefined,
): boolean {
  const turnId = extractProviderTurnId(params);
  if (method !== "error" || turnId) return false;
  const code = String((params as any)?.error?.code ?? "").trim();
  return code === "codex_app_server_closed"
    || code === "codex_app_server_fatal"
    || code === "codex_app_server_process_error"
    || code === "codex_app_server_thread_handler_error"
    || code === "codex_app_server_request_timeout";
}

type TokenUsageUpdate = {
  tokenUsage: TokenUsageSnapshot;
  source?: "current" | "cumulative";
};

/** app-server 已覆盖的 method 集合（用于 raw trace 标记 handled/unhandled）。 */
export const CODEX_APP_SERVER_HANDLED_METHODS = new Set<string>([
  "item/plan/delta",
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/started",
  "item/completed",
  "thread/status/changed",
  "turn/status/changed",
  "turn/diff/updated",
  "turn/plan/updated",
  "thread/tokenUsage/updated",
  "token_count",
  "turn/completed",
  "turn/error",
  "error",
]);

/** 判断某 method 是否已被适配器覆盖。 */
export function isCodexAppServerHandledMethod(method: string): boolean {
  return CODEX_APP_SERVER_HANDLED_METHODS.has(String(method ?? "").trim());
}

/**
 * 将 Codex app-server 的 method/params 映射为统一事件或 turn 生命周期回调。
 * - 不做重业务校验：只负责尽可能把“过程”转换成 Web 可消费的事件流。
 */
export function applyCodexAppServerMessage(opts: {
  workspacePath: string;
  workspaceId: WorkspaceId;
  threadId: string;
  msg: CodexAppServerMessage;
  emit: ConversationEmitFn;
  /** todolist 原文聚合（来自 `item/plan/delta` 与 plan item 的 completed.text）。 */
  todolistTextState?: { text: string };
  onAssistantDelta: (delta: string) => void;
  ensureAssistantMessage: (itemId: string, phase?: AssistantMessagePhase) => {
    text: string;
    revision: number;
    phase?: AssistantMessagePhase;
    completed: boolean;
  } | null;
  appendAssistantDelta: (itemId: string, delta: string) => {
    text: string;
    revision: number;
    phase?: AssistantMessagePhase;
    completed: boolean;
  } | null;
  applyAssistantSnapshot: (input: {
    itemId: string;
    text: string;
    phase?: AssistantMessagePhase;
  }) => {
    text: string;
    revision: number;
    phase?: AssistantMessagePhase;
    completed: boolean;
  } | null;
  completeAssistantMessage: (input: {
    itemId: string;
    text: string;
    phase?: AssistantMessagePhase;
  }) => {
    text: string;
    revision: number;
    phase?: AssistantMessagePhase;
    completed: boolean;
  } | null;
  getActiveTurn: () => ActiveTurnLike | null;
  onTransientReconnect?: (info: TransientReconnectInfo) => void;
  onFinalTurnError?: (info: FinalTurnErrorInfo) => void;
  resolveDynamicToolDisplayName?: (toolId: string) => string | null;
  onCommandExecutionStarted?: (input: {
    itemId: string;
    processId: string | null;
    command: string;
    cwd: string;
    status: string;
  }) => void;
  onCommandExecutionOutputDelta?: (input: {
    itemId: string;
    delta: string;
  }) => void;
  onCommandExecutionCompleted?: (input: {
    itemId: string;
    processId: string | null;
    command: string;
    cwd: string;
    status: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => void;
  onCommandExecutionTerminalInteraction?: (input: {
    itemId: string;
    processId: string;
    stdin: string;
  }) => void;
}): void {
  const method = String(opts.msg.method ?? "");
  const params = (opts.msg.params ?? {}) as Record<string, unknown>;

  if (method === "item/plan/delta") {
    const active = opts.getActiveTurn();
    if (!active) return;
    const delta = String((params as any).delta ?? "");
    if (!delta) return;
    if (opts.todolistTextState) opts.todolistTextState.text += delta;
    emitEvent(opts, {
      type: "item.tool.outputDelta",
      payload: { itemId: `plan_turn_${active.clientTurnId}` as any, toolName: "update_plan", delta },
    });
    return;
  }

  if (method === "item/agentMessage/delta") {
    const active = opts.getActiveTurn();
    const itemId = String((params as any).itemId ?? (params as any).item_id ?? "").trim();
    const delta = String((params as any).delta ?? "");
    if (!itemId || !delta) return;
    const assistant = opts.ensureAssistantMessage(itemId);
    if (!assistant) return;
    const updated = opts.appendAssistantDelta(itemId, delta);
    if (!updated) return;
    opts.onAssistantDelta(delta);
    emitEvent(opts, {
      type: "item.agentMessage.delta",
      payload: {
        itemId: itemId as any,
        engineMessageId: itemId,
        turnId: active?.clientTurnId,
        delta,
      },
    });
    return;
  }

  if (method === "item/reasoning/textDelta") {
    const itemId = String((params as any).itemId ?? (params as any).item_id ?? "").trim();
    const delta = String((params as any).delta ?? "");
    if (!itemId || !delta) return;
    emitEvent(opts, { type: "item.reasoning.delta", payload: { itemId: itemId as any, delta } });
    return;
  }

  if (method === "item/reasoning/summaryTextDelta") {
    const itemId = String((params as any).itemId ?? (params as any).item_id ?? "").trim();
    const delta = String((params as any).delta ?? "");
    if (!itemId || !delta) return;
    emitEvent(opts, { type: "item.reasoning.summaryDelta", payload: { itemId: itemId as any, delta } });
    return;
  }

  if (method === "item/reasoning/summaryPartAdded") {
    const itemId = String((params as any).itemId ?? (params as any).item_id ?? "").trim();
    if (!itemId) return;
    emitEvent(opts, { type: "item.reasoning.summaryBoundary", payload: { itemId: itemId as any } });
    return;
  }

  if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") {
    const itemId = String((params as any).itemId ?? (params as any).item_id ?? "").trim();
    const delta = String((params as any).delta ?? "");
    if (!itemId || !delta) return;
    const toolName = method.includes("commandExecution") ? "commandExecution" : "fileChange";
    if (toolName === "commandExecution") {
      opts.onCommandExecutionOutputDelta?.({ itemId, delta });
    }
    emitEvent(opts, { type: "item.tool.outputDelta", payload: { itemId: itemId as any, toolName, delta } });
    return;
  }

  if (method === "item/commandExecution/terminalInteraction") {
    const itemId = String((params as any).itemId ?? (params as any).item_id ?? "").trim();
    const processId = String((params as any).processId ?? (params as any).process_id ?? "").trim();
    if (!itemId || !processId) return;
    opts.onCommandExecutionTerminalInteraction?.({
      itemId,
      processId,
      stdin: String((params as any).stdin ?? ""),
    });
    return;
  }

  if (method === "item/started") {
    const item = ((params as any).item ?? null) as Record<string, unknown> | null;
    const itemId = String((item as any)?.id ?? "").trim();
    const itemType = String((item as any)?.type ?? "tool");
    if (!itemId) return;
    const asyncRequest = buildAsyncUserInputRequest({ item, workspaceId: opts.workspaceId, threadId: opts.threadId,
      turnId: opts.getActiveTurn()?.clientTurnId ?? null });
    if (asyncRequest) {
      emitEvent(opts, { type: "userInput.requested", payload: { request: asyncRequest } });
      return;
    }
    if (itemType === "agentMessage") {
      opts.ensureAssistantMessage(itemId, normalizeAssistantMessagePhase((item as any)?.phase));
      return;
    }
    // 非 tool item：由更专门的事件处理（避免在 Web 侧出现“userMessage/reasoning 也被当成 tool 卡片”）。
    if (itemType === "userMessage" || itemType === "reasoning" || itemType === "plan") return;
    if (itemType === "commandExecution") {
      opts.onCommandExecutionStarted?.({
        itemId,
        processId: normalizeOptionalText((item as any)?.processId ?? (item as any)?.process_id ?? null),
        command: String((item as any)?.command ?? "").trim(),
        cwd: String((item as any)?.cwd ?? "").trim(),
        status: String((item as any)?.status ?? "").trim(),
      });
    }
    const toolName = resolveCodexToolName(itemType, item, opts.resolveDynamicToolDisplayName);
    const toolInput = resolveCodexToolInput(itemType, item, params);
    const presentation = createToolPresentation({ toolName, input: toolInput, workspacePath: opts.workspacePath });
    emitEvent(opts, {
      type: "item.tool.started",
      payload: { itemId: itemId as any, toolName, input: toolInput, summary: presentation.summary, changes: presentation.changes },
    });
    return;
  }

  if (method === "item/completed") {
    const item = ((params as any).item ?? null) as Record<string, unknown> | null;
    const itemId = String((item as any)?.id ?? "").trim();
    const itemType = String((item as any)?.type ?? "");
    const asyncRequest = buildAsyncUserInputRequest({ item, workspaceId: opts.workspaceId, threadId: opts.threadId,
      turnId: opts.getActiveTurn()?.clientTurnId ?? null });
    if (asyncRequest) {
      emitEvent(opts, { type: "userInput.requested", payload: { request: asyncRequest } });
      return;
    }
    if (itemType === "agentMessage" && itemId) {
      const phase = normalizeAssistantMessagePhase((item as any)?.phase);
      const assistant = opts.ensureAssistantMessage(itemId, phase);
      if (!assistant) return;
      const fullText = String((item as any)?.text ?? assistant.text ?? "");
      if (fullText && fullText !== assistant.text) {
        const updated = opts.applyAssistantSnapshot({
          itemId,
          text: fullText,
          phase,
        });
        if (!updated) return;
        emitEvent(opts, {
          type: "item.agentMessage.snapshot",
          payload: {
            itemId: itemId as any,
            engineMessageId: itemId,
            turnId: opts.getActiveTurn()?.clientTurnId,
            text: updated.text,
            revision: updated.revision,
            phase: updated.phase,
          },
        });
      }
      const completed = opts.completeAssistantMessage({
        itemId,
        text: fullText || assistant.text,
        phase,
      });
      if (!completed) return;
      emitEvent(opts, {
        type: "item.agentMessage.completed",
        payload: {
          itemId: itemId as any,
          engineMessageId: itemId,
          turnId: opts.getActiveTurn()?.clientTurnId,
          text: completed.text,
          revision: completed.revision,
          phase: completed.phase,
          completionSource: "provider" satisfies AssistantCompletionSource,
        },
      });
      return;
    }
    if (itemType === "plan") {
      const active = opts.getActiveTurn();
      if (!active) return;
      const text = String((item as any)?.text ?? "");
      if (!text) return;
      const prev = String(opts.todolistTextState?.text ?? "");
      if (prev === text) return;
      if (opts.todolistTextState) opts.todolistTextState.text = text;
      emitEvent(opts, {
        type: "item.tool.outputDelta",
        payload: { itemId: `plan_turn_${active.clientTurnId}` as any, toolName: "update_plan", delta: text, mode: "replace" },
      });
      return;
    }
    if (itemType === "userMessage" || itemType === "reasoning") return;
    if (itemType === "commandExecution" && itemId) {
      opts.onCommandExecutionCompleted?.({
        itemId,
        processId: normalizeOptionalText((item as any)?.processId ?? (item as any)?.process_id ?? null),
        command: String((item as any)?.command ?? "").trim(),
        cwd: String((item as any)?.cwd ?? "").trim(),
        status: String((item as any)?.status ?? "").trim(),
        exitCode: asNullableNumber((item as any)?.exitCode ?? (item as any)?.exit_code ?? null),
        durationMs: asNullableNumber((item as any)?.durationMs ?? (item as any)?.duration_ms ?? null),
      });
    }
    if (itemId) {
      const toolName = resolveCodexToolName(itemType, item, opts.resolveDynamicToolDisplayName);
      const toolInput = resolveCodexToolInput(itemType, item, params);
      const output = resolveCodexToolOutput(itemType, item, params);
      const presentation = createToolPresentation({ toolName, input: toolInput, workspacePath: opts.workspacePath });

      emitEvent(opts, {
        type: "item.tool.completed",
        payload: {
          itemId: itemId as any,
          toolName: toolName || undefined,
          output,
          status: resolveCodexToolCompletionStatus(itemType, item),
          changes: presentation.changes,
          summary: presentation.summary || undefined,
        },
      });
    }
    return;
  }

  if (method === "turn/diff/updated") {
    const diff = String((params as any).diff ?? "");
    const active = opts.getActiveTurn();
    const engineTurnId = String((params as any).turnId ?? (params as any).turn_id ?? (params as any).turn?.id ?? "").trim();
    const belongsToActive = Boolean(
      active
      && (!engineTurnId || active.codexTurnId === engineTurnId),
    );
    const clientTurnId = belongsToActive ? active!.clientTurnId : null;
    const itemId = clientTurnId
      ? `diff_${clientTurnId}`
      : `diff_${engineTurnId || Date.now()}`;
    emitEvent(opts, {
      type: "item.diff.created",
      payload: {
        itemId: itemId as any,
        title: "Diff",
        diff,
        ...(clientTurnId ? { turnId: clientTurnId } : {}),
        ...(engineTurnId ? { engineTurnId } : {}),
      },
    });
    return;
  }

  if (method === "turn/plan/updated") {
    // turn/plan/updated：将 app-server 的计划更新映射为 `update_plan` 工具输出（用于渲染 todolist）。
    const active = opts.getActiveTurn();
    const engineTurnId = String((params as any).turnId ?? (params as any).turn_id ?? (params as any).turn?.id ?? "").trim();
    const itemId = active ? `plan_turn_${active.clientTurnId}` : `plan_turn_${engineTurnId || Date.now()}`;

    const rawPlan = Array.isArray((params as any).plan) ? ((params as any).plan as Record<string, unknown>[]) : [];
    const todolistItems = rawPlan
      .map((p) => ({
        step: String(p.step ?? p.text ?? "").trim(),
        status: String(p.status ?? "").trim(),
      }))
      .filter((item) => Boolean(item.step));
    const explanation = String((params as any).explanation ?? "").trim();
    const inProgressStep = todolistItems.find((i) => {
      const s = i.status.toLowerCase();
      return s === "in_progress" || s === "inprogress" || s === "in-progress" || s === "doing" || s === "running";
    })?.step ?? "";
    const summary = explanation || inProgressStep || "";

    emitEvent(opts, {
      type: "item.tool.completed",
      payload: {
        itemId: itemId as any,
        toolName: "update_plan",
        output: {
          explanation: (params as any).explanation ?? null,
          plan: (params as any).plan ?? null,
          turnId: active?.clientTurnId ?? null,
          engineTurnId: engineTurnId || null,
        },
        status: "completed",
        summary: summary || undefined,
        todolistItems: todolistItems.length ? todolistItems : undefined,
      },
    });
    return;
  }

  if (method === "thread/tokenUsage/updated" || method === "token_count") {
    const updates = extractTokenUsageUpdates(method, params);
    for (const update of updates) {
      emitEvent(opts, { type: "tokenUsage.updated", payload: update });
    }
    return;
  }

  if (method === "turn/completed") {
    const active = opts.getActiveTurn();
    if (!active) return;
    const turnId = extractProviderTurnId(params);
    if (!terminalNotificationMatchesActiveTurn(active, turnId)) return;
    // app-server 的 `turn/completed` 表示“该 turn 已结束”，并不保证一定是成功结束。
    const terminal = classifyTurnCompletedTerminal(params, active);
    if (terminal.kind === "resolve") {
      active.resolve(params);
      return;
    }
    opts.onFinalTurnError?.({
      turnId: turnId || null,
      error: terminal.error,
      additionalDetails: terminal.additionalDetails,
      providerErrorInfo: terminal.providerErrorInfo,
      responseStreamDisconnected: terminal.responseStreamDisconnected,
    });
    active.reject(terminal.error);
    return;
  }

  if (method === "turn/error" || method === "error") {
    const active = opts.getActiveTurn();
    if (!active) return;
    const reconnect = extractTransientReconnectInfo(method, params);
    if (reconnect) {
      opts.onTransientReconnect?.(reconnect);
      return;
    }
    const turnId = extractProviderTurnId(params);
    if (
      !terminalNotificationMatchesActiveTurn(active, turnId)
      && !isCodexSyntheticTransportFault(method, params)
    ) return;
    const error = (params as any).error ?? params;
    const extracted = extractErrorDetails(error);
    const finalError = createCodexFinalError(extracted, "Codex 引擎返回空错误，未提供详细原因。");
    opts.onFinalTurnError?.({
      turnId: turnId || null,
      error: finalError,
      additionalDetails: extracted.additionalDetails,
      providerErrorInfo: extracted.providerErrorInfo,
      responseStreamDisconnected: extracted.responseStreamDisconnected,
    });
    active.reject(finalError);
  }
}

export function extractTransientReconnectInfo(
  method: string,
  params: Record<string, unknown> | undefined,
): TransientReconnectInfo | null {
  if (method !== "turn/error" && method !== "error") return null;
  const payload = params ?? {};
  const turnId = extractProviderTurnId(payload) || null;
  const error = (payload as any).error ?? payload;
  const extracted = extractErrorDetails(error);
  const msgText = extracted.message;
  const hasWillRetry = (payload as any).willRetry !== undefined || (payload as any).will_retry !== undefined;
  const willRetry = Boolean((payload as any).willRetry ?? (payload as any).will_retry);
  const responseStreamDisconnected = extracted.responseStreamDisconnected;
  const shouldTreatAsTransient = willRetry
    || (!hasWillRetry && (responseStreamDisconnected || isTransientReconnectMessage(msgText)));
  if (!shouldTreatAsTransient) return null;
  return {
    turnId,
    message: msgText,
    additionalDetails: extracted.additionalDetails,
    willRetry,
    responseStreamDisconnected,
  };
}

/** 判定 app-server 的 error 是否为“重连中”的非终止状态提示。 */
function isTransientReconnectMessage(message: string): boolean {
  const s = String(message ?? "").trim();
  if (!s) return false;
  const m = s.toLowerCase();
  if (!m.includes("reconnect")) return false;
  if (m.startsWith("reconnecting")) return true;
  // e.g. "Error: Reconnecting... 1/5"
  if (m.includes("reconnecting...")) return true;
  return false;
}

function normalizeOptionalText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function classifyTurnCompletedTerminal(
  params: Record<string, unknown> | undefined,
  active: ActiveTurnLike | null,
): {
  kind: "resolve";
} | {
  kind: "reject";
  error: Error;
  additionalDetails: string | null;
  providerErrorInfo: string | null;
  responseStreamDisconnected: boolean;
} {
  const turn = ((params as any)?.turn ?? null) as Record<string, unknown> | null;
  const status = String((turn as any)?.status ?? (params as any)?.status ?? "").trim().toLowerCase();
  if (!status || status === "completed") {
    return { kind: "resolve" };
  }
  const errorPayload = ((turn as any)?.error ?? (params as any)?.error ?? null) as Record<string, unknown> | string | null;
  const extracted = extractErrorDetails(errorPayload);
  if (active?.manualInterruptRequested && (status === "interrupted" || status === "cancelled")) {
    return {
      kind: "reject",
      error: active.manualInterruptError ?? createManualInterruptTurnError(),
      additionalDetails: extracted.additionalDetails,
      providerErrorInfo: extracted.providerErrorInfo,
      responseStreamDisconnected: extracted.responseStreamDisconnected,
    };
  }
  const fallbackMessage = `Codex turn ended as ${status} (turn.completed)`;
  return {
    kind: "reject",
    error: createCodexFinalError(extracted, fallbackMessage),
    additionalDetails: extracted.additionalDetails,
    providerErrorInfo: extracted.providerErrorInfo,
    responseStreamDisconnected: extracted.responseStreamDisconnected,
  };
}

function createManualInterruptTurnError(): Error {
  const error = new Error("turn interrupted") as Error & {
    code?: string;
    terminationKind?: "manual_interrupt";
  };
  error.code = MANUAL_TURN_INTERRUPT_CODE;
  error.terminationKind = "manual_interrupt";
  return error;
}

function extractErrorDetails(errorPayload: Record<string, unknown> | string | null): {
  message: string;
  code: string | null;
  additionalDetails: string | null;
  providerErrorInfo: string | null;
  responseStreamDisconnected: boolean;
} {
  const msgText = typeof errorPayload === "string"
    ? errorPayload
    : String((errorPayload as any)?.message ?? "Codex error");
  const code = typeof errorPayload === "string"
    ? null
    : normalizeOptionalText((errorPayload as any)?.code ?? (errorPayload as any)?.type);
  const additionalDetails = normalizeOptionalText(
    (errorPayload as any)?.additionalDetails ?? (errorPayload as any)?.additional_details,
  );
  const codexErrorInfo = (errorPayload as any)?.codexErrorInfo ?? (errorPayload as any)?.codex_error_info ?? null;
  const providerErrorInfo = summarizeCodexErrorInfo(codexErrorInfo);
  const responseStreamDisconnected = extractResponseStreamDisconnected(codexErrorInfo);
  return {
    message: msgText,
    code,
    additionalDetails,
    providerErrorInfo,
    responseStreamDisconnected,
  };
}

type CodexFinalError = Error & {
  code?: string;
  additionalDetails?: string;
  providerErrorInfo?: string;
};

function createCodexFinalError(
  details: {
    message: string;
    code: string | null;
    additionalDetails: string | null;
    providerErrorInfo: string | null;
  },
  fallbackMessage: string,
): CodexFinalError {
  const finalError = new Error(buildCodexFinalErrorMessage(details, fallbackMessage)) as CodexFinalError;
  if (details.code) finalError.code = details.code;
  if (details.additionalDetails) finalError.additionalDetails = details.additionalDetails;
  if (details.providerErrorInfo) finalError.providerErrorInfo = details.providerErrorInfo;
  return finalError;
}

function buildCodexFinalErrorMessage(
  details: {
    message: string;
    additionalDetails: string | null;
    providerErrorInfo: string | null;
  },
  fallbackMessage: string,
): string {
  const message = normalizeOptionalText(details.message);
  if (message && !isGenericCodexErrorMessage(message)) return message;
  if (details.additionalDetails) return details.additionalDetails;
  if (details.providerErrorInfo) return formatCodexProviderErrorInfo(details.providerErrorInfo);
  return fallbackMessage;
}

function isGenericCodexErrorMessage(message: string): boolean {
  const normalized = String(message ?? "").trim().toLowerCase();
  return !normalized || normalized === "codex error" || normalized === "error";
}

function formatCodexProviderErrorInfo(providerErrorInfo: string): string {
  const normalized = String(providerErrorInfo ?? "").trim();
  if (!normalized) return "Codex 引擎返回空错误，未提供详细原因。";
  if (normalized.toLowerCase() === "other") return "Codex 上游返回了错误类型是其他，但未提供更多细节。";
  if (/^[a-z0-9_.-]+$/i.test(normalized)) return `Codex 上游错误（${normalized}）`;
  return `Codex 上游错误：${normalized}`;
}

function summarizeCodexErrorInfo(codexErrorInfo: unknown): string | null {
  if (typeof codexErrorInfo === "string" || typeof codexErrorInfo === "number" || typeof codexErrorInfo === "boolean") {
    return normalizeOptionalText(codexErrorInfo);
  }
  if (!codexErrorInfo || typeof codexErrorInfo !== "object") return null;
  try {
    const json = JSON.stringify(codexErrorInfo);
    if (!json) return null;
    return json.length > 240 ? `${json.slice(0, 237)}...` : json;
  } catch {
    const keys = Object.keys(codexErrorInfo as Record<string, unknown>);
    return keys.length ? keys.join(", ") : null;
  }
}

function extractResponseStreamDisconnected(codexErrorInfo: unknown): boolean {
  if (!codexErrorInfo || typeof codexErrorInfo !== "object") return false;
  return Boolean(
    (codexErrorInfo as any).responseStreamDisconnected
    ?? (codexErrorInfo as any).response_stream_disconnected,
  );
}

function asNullableNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function emitEvent(
  ctx: { workspaceId: WorkspaceId; threadId: string; emit: ConversationEmitFn },
  event: Pick<ConversationEventInput, "type" | "payload">,
): void {
  ctx.emit({
    ts: Date.now(),
    workspaceId: ctx.workspaceId,
    threadId: ctx.threadId as any,
    engine: "codex",
    type: event.type,
    payload: event.payload as any,
  } as ConversationEventInput);
}

/** 解析 Codex token usage；last 写当前上下文，total 写会话累计。 */
function extractTokenUsageUpdates(method: string, params: Record<string, unknown>): TokenUsageUpdate[] {
  if (method === "thread/tokenUsage/updated") {
    const u = (params as any).tokenUsage ?? (params as any).token_usage ?? null;
    if (!u || typeof u !== "object") return [];
    const last = (u as any).last ?? u;
    const modelContextWindow = asNumber((u as any).modelContextWindow ?? (u as any).model_context_window ?? null);
    const current = readTokenUsageSnapshot(last, modelContextWindow);
    const totalSource = (u as any).total ?? (u as any).cumulative ?? null;
    const cumulative = totalSource && typeof totalSource === "object"
      ? readTokenUsageSnapshot(totalSource, modelContextWindow)
      : null;

    const updates: TokenUsageUpdate[] = [];
    if (current) updates.push({ tokenUsage: current, source: "current" });
    if (cumulative) updates.push({ tokenUsage: cumulative, source: "cumulative" });
    return updates;
  }

  if (method === "token_count") {
    const info = (params as any).info ?? null;
    const modelContextWindow = asNumber(info?.model_context_window ?? info?.modelContextWindow ?? null);
    const currentSource = info?.last_token_usage ?? info?.lastTokenUsage ?? null;
    const cumulativeSource = info?.total_token_usage ?? info?.totalTokenUsage ?? null;
    const current = readTokenUsageSnapshot(currentSource, modelContextWindow);
    const cumulative = readTokenUsageSnapshot(cumulativeSource, modelContextWindow);
    const updates: TokenUsageUpdate[] = [];
    if (current) updates.push({ tokenUsage: current, source: "current" });
    if (cumulative) updates.push({ tokenUsage: cumulative, source: "cumulative" });
    return updates;
  }

  return [];
}

/** 从 app-server/codex token 字段别名中归一化单个 usage 快照。 */
function readTokenUsageSnapshot(input: unknown, modelContextWindow: number | null): TokenUsageSnapshot | null {
  if (!input || typeof input !== "object") return null;
  const usage = input as Record<string, unknown>;
  const snapshot = {
    inputTokens: asNumber(usage.inputTokens ?? usage.input_tokens ?? null),
    outputTokens: asNumber(usage.outputTokens ?? usage.output_tokens ?? null),
    cachedInputTokens: asNumber(
      usage.cachedInputTokens ??
        usage.cached_input_tokens ??
        usage.cacheReadInputTokens ??
        usage.cache_read_input_tokens ??
        null,
    ),
    cacheCreationInputTokens: asNumber(
      usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? null,
    ),
    totalTokens: asNumber(usage.totalTokens ?? usage.total_tokens ?? null),
    reasoningOutputTokens: asNumber(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens ?? null),
    modelContextWindow,
  };
  if (
    snapshot.inputTokens == null &&
    snapshot.outputTokens == null &&
    snapshot.cachedInputTokens == null &&
    snapshot.cacheCreationInputTokens == null &&
    snapshot.totalTokens == null &&
    snapshot.reasoningOutputTokens == null &&
    snapshot.modelContextWindow == null
  ) {
    return null;
  }
  return snapshot;
}

function asNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function resolveCodexToolName(
  itemType: string,
  item: Record<string, unknown> | null,
  resolveDynamicToolDisplayName?: (toolId: string) => string | null,
): string {
  if (itemType === "dynamicToolCall") {
    const tool = String((item as any)?.tool ?? "").trim();
    if (tool) return resolveDynamicToolDisplayName?.(tool) || tool;
  }
  return itemType;
}

function resolveCodexToolInput(
  itemType: string,
  item: Record<string, unknown> | null,
  params: Record<string, unknown>,
): unknown {
  if (itemType === "dynamicToolCall") {
    return (item as any)?.arguments ?? params;
  }
  return item ?? params;
}

function resolveCodexToolOutput(
  itemType: string,
  item: Record<string, unknown> | null,
  params: Record<string, unknown>,
): unknown {
  if (itemType !== "dynamicToolCall") return item ?? params;
  const contentItems = Array.isArray((item as any)?.contentItems)
    ? ((item as any).contentItems as Array<Record<string, unknown>>)
    : Array.isArray((item as any)?.content_items)
      ? ((item as any).content_items as Array<Record<string, unknown>>)
      : [];
  if (contentItems.length === 1 && String(contentItems[0]?.type ?? "") === "inputText") {
    const text = String(contentItems[0]?.text ?? "").trim();
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return {
    tool: (item as any)?.tool ?? null,
    arguments: (item as any)?.arguments ?? null,
    contentItems: contentItems.length ? contentItems : null,
    success: (item as any)?.success ?? null,
    status: (item as any)?.status ?? null,
  };
}

function resolveCodexToolCompletionStatus(
  itemType: string,
  item: Record<string, unknown> | null,
): "completed" | "failed" {
  const status = String((item as any)?.status ?? "").trim().toLowerCase();
  if (["failed", "error", "declined", "cancelled", "canceled", "interrupted"].includes(status)) return "failed";
  if (itemType === "commandExecution") {
    const exitCode = asNullableNumber((item as any)?.exitCode ?? (item as any)?.exit_code ?? null);
    if (exitCode != null && exitCode !== 0) return "failed";
  }
  if ((item as any)?.success === false) return "failed";
  return "completed";
}

