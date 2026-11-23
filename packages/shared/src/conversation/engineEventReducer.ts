import type {
  ConversationApprovalRequest,
  ConversationDiff,
  ConversationExplore,
  ConversationItem,
  ConversationMessage,
  ConversationSubagent,
  ConversationSystemMessage,
  ConversationReview,
  ConversationUserInputRequest,
  EngineEventEnvelope,
  TokenUsageSnapshot,
  TurnErrorPayload,
} from "../index.js";
import {
  classifyTurnErrorSemantics,
  isTransientTurnError,
  isTransientTurnErrorCode,
} from "../utils/turnErrorSemantics.js";
import { createEmptyTokenUsageState } from "../types/engine.js";
import { getConversationMessageItemId } from "../types/events.js";

import type { ThreadConversationState } from "./chatTypes.js";
import {
  applyMessageTimestamp,
  findApproval,
  findLatestOptimisticUserMessageByContent,
  findOptimisticUserMessageByTurnId,
  findOrCreateAssistantMessage,
  findOrCreateReasoning,
  findOrCreateTool,
  findTool,
  findUserMessage,
  formatJson,
  indexedPush,
  rekeyIndexedItem,
  removeEmptyReasoningPlaceholders,
  syncCurrentTodolist,
  upsertApproval,
  upsertDiff,
  upsertExplore,
  upsertReview,
  upsertSubagent,
} from "./engineEventReducerHelpers.js";

/**
 * thread 级 nodeId → 当前节点名映射，取自会话工作流面板快照（服务端已按当前定义改名）。
 * 缺该映射时事件文案保留事件里冻结的旧名，不会回退成 nodeId。
 */
export type OrchestrationNodeLabelMap = ReadonlyMap<string, string>;

/**
 * 将 canonical 会话事件归并到 `ConversationItem[]`。
 * - 只做“渲染态归并”，不做业务校验。
 */
export function applyEngineEventToConversation(
  state: ThreadConversationState,
  event: EngineEventEnvelope,
  nodeLabels?: OrchestrationNodeLabelMap,
): void {
  if (event.type === "item.message.deleted") {
    deleteConversationMessages(state, [event.payload.itemId]);
    return;
  }
  const messageItemId = getConversationMessageItemId(event);
  if (messageItemId && state.deletedMessageIds?.has(messageItemId)) {
    if (event.type === "item.userMessage.created" && event.payload.turnId) {
      deleteConversationMessages(state, [`local_user_${event.payload.turnId}`]);
    }
    return;
  }
  switch (event.type) {
    case "thread.started":
      if (event.payload.sessionId) state.engineSessionId = String(event.payload.sessionId);
      return;
    case "turn.engineBound": {
      const engineSessionId = String(event.payload.engineSessionId ?? "").trim();
      if (engineSessionId) state.engineSessionId = engineSessionId;
      return;
    }
    case "thread.process.changed":
      return;
    case "turn.started": {
      clearResolvedTransientSystemMessages(state);
      const nextTurnId = String(event.payload.turnId ?? "").trim();
      const nextStartedAt = event.ts || Date.now();
      // 同一 thread 理论上只允许一个活跃 turn。若已有运行中的 turn，
      // 则后续短命 started（常见于“当前 thread 有未完成的 turn”）不应顶掉现有运行态。
      if (!state.runningTurnId || state.runningTurnId === nextTurnId) {
        state.runningTurnId = nextTurnId || state.runningTurnId;
        state.runningTurnStartedAt = nextStartedAt;
        // 新轮次：重置 current（保留 modelContextWindow）
        if (state.tokenUsage) {
          const cw = state.tokenUsage.current.modelContextWindow;
          state.tokenUsage.current = {
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            cacheCreationInputTokens: null,
            totalTokens: null,
            reasoningOutputTokens: null,
            modelContextWindow: cw,
          };
        }
      }
      return;
    }
    case "tokenUsage.updated":
      if (event.payload.source === "cumulative") {
        applyCumulativeUsage(state, event.payload.tokenUsage, event.payload.cumulativeMode);
      } else {
        mergeTokenUsage(state, event.payload.tokenUsage);
      }
      return;
    case "turn.completed":
      if (event.payload.turnId) state.completedTurnIds[String(event.payload.turnId)] = true;
      clearResolvedTransientSystemMessages(state);
      if (shouldAffectRunningTurn(state, event.payload.turnId)) {
        state.runningTurnId = null;
        state.runningTurnStartedAt = null;
        finalizeDanglingTools(state, "completed");
        removeEmptyReasoningPlaceholders(state);
        reorderCurrentGroup(state);
      }
      return;
    case "turn.error": {
      // 失败的 turn 也标记为 completed，使对应的用户消息可以回滚
      const errorTurnId = event.payload.turnId ?? state.runningTurnId;
      const errorTurnKey = String(errorTurnId ?? "").trim();
      const alreadyTerminal = Boolean(errorTurnKey && state.completedTurnIds[errorTurnKey]);
      if (errorTurnKey) state.completedTurnIds[errorTurnKey] = true;
      if (shouldAffectRunningTurn(state, errorTurnId)) {
        state.runningTurnId = null;
        state.runningTurnStartedAt = null;
        finalizeDanglingTools(state, "error");
        removeEmptyReasoningPlaceholders(state);
        reorderCurrentGroup(state);
      }
      // 共享工作区可能收到同一 turn 的重放/桥接终态，渲染层只保留首个终态提示。
      if (alreadyTerminal) return;
      indexedPush(state, buildTurnErrorSystemMessage(event));
      return;
    }
    case "item.userMessage.created":
      {
        const existing = findUserMessage(state, event.payload.itemId)
          ?? findOptimisticUserMessageByTurnId(state, event.payload.turnId)
          ?? findLatestOptimisticUserMessageByContent(state, {
            text: event.payload.text,
            inputKind: event.payload.inputKind,
            skillMentions: event.payload.skillMentions,
            images: event.payload.images,
            files: event.payload.files,
            pathReferences: event.payload.pathReferences,
          });
        if (existing) {
          rekeyIndexedItem(state, existing, event.payload.itemId);
          applyMessageTimestamp(existing, event.ts);
          if (event.payload.turnId) existing.turnId = event.payload.turnId;
          existing.text = event.payload.text;
          existing.inputKind = event.payload.inputKind;
          existing.skillMentions = event.payload.skillMentions;
          existing.images = event.payload.images;
          existing.files = event.payload.files;
          existing.pathReferences = event.payload.pathReferences;
          return;
        }
        indexedPush(state, {
          kind: "message",
          id: event.payload.itemId,
          role: "user",
          createdAt: event.ts,
          turnId: event.payload.turnId,
          text: event.payload.text,
          inputKind: event.payload.inputKind,
          skillMentions: event.payload.skillMentions,
          images: event.payload.images,
          files: event.payload.files,
          pathReferences: event.payload.pathReferences,
        } satisfies ConversationMessage);
      }
      return;
    case "item.userMessage.engineCall.created":
      {
        const existing = findUserMessage(state, event.payload.itemId);
        if (existing) {
          applyMessageTimestamp(existing, event.ts);
          existing.engineCall = event.payload.call;
          return;
        }
        indexedPush(state, {
          kind: "message",
          id: event.payload.itemId,
          role: "user",
          createdAt: event.ts,
          text: "",
          engineCall: event.payload.call,
        } satisfies ConversationMessage);
      }
      return;
    case "item.agentMessage.started": {
      const msg = findOrCreateAssistantMessage(state, {
        engine: event.engine,
        itemId: event.payload.itemId,
        turnId: event.payload.turnId,
      });
      if (shouldIgnoreAssistantMessageEvent(event, msg)) return;
      if (shouldResetAssistantMessageStream(event, msg)) {
        resetAssistantMessageStream(msg, {
          engineMessageId: event.payload.engineMessageId,
          turnId: event.payload.turnId,
          phase: event.payload.phase,
        });
      }
      applyMessageTimestamp(msg, event.ts);
      msg.engineMessageId = event.payload.engineMessageId;
      if (event.payload.turnId) msg.turnId = event.payload.turnId;
      if (msg.streamState !== "completed") {
        msg.format = "plain";
        msg.streamState = "streaming";
      }
      msg.phase = msg.phase ?? event.payload.phase;
      if (msg.revision == null) msg.revision = 0;
      reorderCurrentGroup(state);
      return;
    }
    case "item.agentMessage.delta": {
      removeEmptyReasoningPlaceholders(state);
      const msg = findOrCreateAssistantMessage(state, {
        engine: event.engine,
        itemId: event.payload.itemId,
        turnId: event.payload.turnId,
      });
      if (shouldIgnoreAssistantMessageEvent(event, msg)) return;
      if (shouldResetAssistantMessageStream(event, msg)) {
        resetAssistantMessageStream(msg, {
          engineMessageId: event.payload.engineMessageId,
          turnId: event.payload.turnId,
        });
      }
      applyMessageTimestamp(msg, event.ts);
      if (msg.streamState === "completed") return;
      msg.engineMessageId = event.payload.engineMessageId;
      if (event.payload.turnId) msg.turnId = event.payload.turnId;
      msg.format = "plain";
      msg.streamState = "streaming";
      msg.text += event.payload.delta;
      reorderCurrentGroup(state);
      return;
    }
    case "item.agentMessage.snapshot": {
      removeEmptyReasoningPlaceholders(state);
      const msg = findOrCreateAssistantMessage(state, {
        engine: event.engine,
        itemId: event.payload.itemId,
        turnId: event.payload.turnId,
      });
      if (shouldIgnoreAssistantMessageEvent(event, msg)) return;
      if (shouldResetAssistantMessageStream(event, msg)) {
        resetAssistantMessageStream(msg, {
          engineMessageId: event.payload.engineMessageId,
          turnId: event.payload.turnId,
          phase: event.payload.phase,
        });
      }
      applyMessageTimestamp(msg, event.ts);
      if (msg.streamState === "completed") return;
      msg.engineMessageId = event.payload.engineMessageId;
      if (event.payload.turnId) msg.turnId = event.payload.turnId;
      msg.format = "plain";
      msg.streamState = "streaming";
      msg.text = event.payload.text;
      msg.revision = event.payload.revision;
      msg.phase = event.payload.phase ?? msg.phase;
      reorderCurrentGroup(state);
      return;
    }
    case "item.agentMessage.completed": {
      removeEmptyReasoningPlaceholders(state);
      const msg = findOrCreateAssistantMessage(state, {
        engine: event.engine,
        itemId: event.payload.itemId,
        turnId: event.payload.turnId,
      });
      if (shouldIgnoreAssistantMessageEvent(event, msg)) return;
      if (shouldResetAssistantMessageStream(event, msg)) {
        resetAssistantMessageStream(msg, {
          engineMessageId: event.payload.engineMessageId,
          turnId: event.payload.turnId,
          phase: event.payload.phase,
        });
      }
      applyMessageTimestamp(msg, event.ts);
      const currentRevision = typeof msg.revision === "number" ? msg.revision : -1;
      const incomingRevision = typeof event.payload.revision === "number" ? event.payload.revision : -1;
      const currentPhasePriority = messagePhasePriority(msg.phase);
      const incomingPhasePriority = messagePhasePriority(event.payload.phase ?? msg.phase);
      const currentSourcePriority = messageCompletionSourcePriority(msg.completionSource);
      const incomingSourcePriority = messageCompletionSourcePriority(event.payload.completionSource ?? msg.completionSource);
      if (
        msg.streamState === "completed"
        && (
          incomingRevision < currentRevision
          || (
            incomingRevision === currentRevision
            && (
              incomingPhasePriority < currentPhasePriority
              || (
                incomingPhasePriority === currentPhasePriority
                && (
                  incomingSourcePriority < currentSourcePriority
                      || (
                        incomingSourcePriority === currentSourcePriority
                        && (
                          (Boolean(msg.structuredPayloadJson) && !event.payload.structuredPayloadJson)
                      || (msg.structuredPayloadJson != null
                        && event.payload.structuredPayloadJson != null
                        && msg.structuredPayloadJson !== event.payload.structuredPayloadJson)
                      || msg.text !== String(event.payload.text ?? "")
                    )
                  )
                )
              )
            )
          )
        )
      ) {
        return;
      }
      msg.engineMessageId = event.payload.engineMessageId;
      if (event.payload.turnId) msg.turnId = event.payload.turnId;
      msg.format = "markdown";
      msg.streamState = "completed";
      msg.text = event.payload.text;
      msg.revision = event.payload.revision;
      msg.phase = event.payload.phase ?? msg.phase;
      if (event.payload.completionSource) msg.completionSource = event.payload.completionSource;
      msg.structuredPayloadJson = event.payload.structuredPayloadJson ?? null;
      reorderCurrentGroup(state);
      return;
    }
    case "item.reasoning.started": {
      const hadReasoning = state._indexById.has(String(event.payload.itemId));
      const reasoning = findOrCreateReasoning(state, event.payload.itemId, { placeholder: true });
      if (!String(reasoning.content ?? "").trim() && !String(reasoning.summary ?? "").trim()) {
        reasoning.placeholder = true;
      }
      if (!hadReasoning) reorderCurrentGroup(state);
      return;
    }
    case "item.reasoning.delta": {
      const hadReasoning = state._indexById.has(String(event.payload.itemId));
      const reasoning = findOrCreateReasoning(state, event.payload.itemId);
      reasoning.placeholder = false;
      reasoning.content += event.payload.delta;
      if (!hadReasoning) reorderCurrentGroup(state);
      return;
    }
    case "item.reasoning.summaryDelta": {
      const hadReasoning = state._indexById.has(String(event.payload.itemId));
      const reasoning = findOrCreateReasoning(state, event.payload.itemId);
      reasoning.summary = (reasoning.summary ?? "") + event.payload.delta;
      if (String(reasoning.summary ?? "").trim()) reasoning.placeholder = false;
      if (!hadReasoning) reorderCurrentGroup(state);
      return;
    }
    case "item.reasoning.summaryBoundary": {
      const hadReasoning = state._indexById.has(String(event.payload.itemId));
      const reasoning = findOrCreateReasoning(state, event.payload.itemId);
      reasoning.summary = addSummaryBoundary(reasoning.summary ?? "");
      if (String(reasoning.summary ?? "").trim()) reasoning.placeholder = false;
      if (!hadReasoning) reorderCurrentGroup(state);
      return;
    }
    case "item.tool.started":
      {
        removeEmptyReasoningPlaceholders(state);
        if (event.payload.toolName === "userMessage" || event.payload.toolName === "agentMessage" || event.payload.toolName === "reasoning") {
          return;
        }
        const hadTool = Boolean(findTool(state, event.payload.itemId));
        const tool = findOrCreateTool(state, event.payload.itemId, event.payload.toolName);
        tool.toolType = event.payload.toolName;
        tool.isTodolist = isTodoListToolName(event.payload.toolName);
        tool.title = tool.isTodolist ? "todolist" : event.payload.toolName;
        tool.detail = formatJson(event.payload.input);
        tool.status = "started";
        tool.changes = Array.isArray(event.payload.changes) ? event.payload.changes : tool.changes;
        if (event.payload.summary != null) tool.summary = event.payload.summary;
        if (!hadTool) reorderCurrentGroup(state);
      }
      return;
    case "item.tool.inputUpdated": {
      const tool = findTool(state, event.payload.itemId);
      if (!tool) return;
      if (event.payload.toolName) {
        tool.toolType = event.payload.toolName;
        tool.isTodolist = isTodoListToolName(event.payload.toolName);
        tool.title = tool.isTodolist ? "todolist" : event.payload.toolName;
      }
      tool.detail = formatJson(event.payload.input) || tool.detail;
      tool.changes = Array.isArray(event.payload.changes) ? event.payload.changes : tool.changes;
      if (event.payload.summary != null) tool.summary = event.payload.summary;
      if (event.payload.todolistItems) {
        tool.todolistItems = event.payload.todolistItems;
        syncCurrentTodolist(state, tool);
      }
      return;
    }
    case "item.tool.completed": {
      removeEmptyReasoningPlaceholders(state);
      if (event.payload.toolName === "userMessage" || event.payload.toolName === "agentMessage" || event.payload.toolName === "reasoning") {
        return;
      }
      const hadTool = Boolean(findTool(state, event.payload.itemId));
      const tool = findOrCreateTool(state, event.payload.itemId, event.payload.toolName ?? "tool");
      if (event.payload.toolName) {
        tool.toolType = event.payload.toolName;
        tool.isTodolist = isTodoListToolName(event.payload.toolName);
        tool.title = tool.isTodolist ? "todolist" : event.payload.toolName;
      }
      tool.status = event.payload.status === "failed" ? "failed" : "completed";
      tool.output = formatJson(event.payload.output) || tool.output;
      if (event.payload.error) tool.output = String(event.payload.error);
      tool.durationMs = typeof event.payload.durationMs === "number" ? event.payload.durationMs : tool.durationMs;
      tool.changes = Array.isArray(event.payload.changes) ? event.payload.changes : tool.changes;
      if (event.payload.summary != null) tool.summary = event.payload.summary;
      if (event.payload.todolistItems) {
        tool.todolistItems = event.payload.todolistItems;
        syncCurrentTodolist(state, tool);
      }
      if (!hadTool) reorderCurrentGroup(state);
      return;
    }
    case "item.tool.outputDelta": {
      removeEmptyReasoningPlaceholders(state);
      const toolName = event.payload.toolName ?? "tool";
      const hadTool = Boolean(findTool(state, event.payload.itemId));
      const tool = findOrCreateTool(state, event.payload.itemId, toolName);
      if (event.payload.toolName) {
        tool.toolType = toolName;
        tool.isTodolist = isTodoListToolName(toolName);
        tool.title = tool.isTodolist ? "todolist" : toolName;
      }
      // 部分引擎会先推 delta 再推 started：此时将 unknown 提升为 started，避免 Web 侧卡片一直"未知"。
      if (tool.status === "unknown") tool.status = "started";

      tool.changes = Array.isArray(event.payload.changes) ? event.payload.changes : tool.changes;
      if (event.payload.summary != null) tool.summary = event.payload.summary;
      const mode = event.payload.mode ?? "append";
      if (tool.isTodolist ?? isTodoListToolName(tool.toolType)) {
        // todolist 工具：仅保留原文供排障，不再从原文解析 currentTodolist（由 item.tool.completed 处理）。
        tool.todolistText = mode === "replace" ? event.payload.delta : (tool.todolistText ?? "") + event.payload.delta;
      } else {
        tool.output = mode === "replace" ? event.payload.delta : (tool.output ?? "") + event.payload.delta;
      }
      if (!hadTool) reorderCurrentGroup(state);
      return;
    }
    case "approval.request":
      removeEmptyReasoningPlaceholders(state);
      upsertApproval(state, {
        kind: "approvalRequest",
        id: `approval_${String(event.payload.requestId)}` as any,
        workspaceId: event.workspaceId,
        threadId: event.threadId,
        requestId: event.payload.requestId as any,
        toolName: event.payload.toolName,
        message: event.payload.message,
        input: event.payload.input,
        approvalKind: event.payload.approvalKind,
        options: event.payload.options,
        state: "pending",
      });
      reorderCurrentGroup(state);
      return;
    case "approval.resolved":
      {
        const existing = findApproval(state, event.payload.requestId);
        if (existing) {
          existing.state = event.payload.approved ? "accepted" : "declined";
          existing.resolvedChoice = event.payload.choice;
          existing.resolvedNote = event.payload.note;
          if (event.payload.message) existing.message = event.payload.message;
        }
      }
      return;
    case "approval.expired":
      {
        const existing = findApproval(state, event.payload.requestId);
        if (existing) {
          existing.state = "expired";
          if (event.payload.message) existing.message = event.payload.message;
        }
      }
      return;
    case "system.notice":
      indexedPush(state, {
        kind: "systemMessage",
        id: `sys_${event.seq}`,
        type: event.payload.level,
        text: event.payload.text,
      } satisfies ConversationSystemMessage);
      if (event.payload.action === "session.invalidated" && event.engine !== "codex") {
        state.invalidated = true;
      }
      return;
    case "orchestration.started":
    case "orchestration.recovered":
    case "orchestration.completed":
    case "orchestration.nodeStateChanged":
    case "orchestration.nodeRecovered":
    case "orchestration.promptSnapshotCreated":
    case "orchestration.artifactWritten":
    case "orchestration.artifactRevised":
    case "orchestration.artifactWorkspaceWritten":
    case "orchestration.artifactPublished":
    case "orchestration.artifactDiscarded":
    case "orchestration.gateResult":
    case "orchestration.approvalRequested":
    case "orchestration.feedbackRequested":
    case "orchestration.reworkRequested":
    case "orchestration.error":
      indexedPush(state, buildOrchestrationSystemMessage(event, nodeLabels));
      return;
    case "userInput.requested":
      {
        removeEmptyReasoningPlaceholders(state);
        // upsert：同一 itemId 的 userInput 只保留一份（流式 + final assistant 可能触发两次 emitUserInputRequested）
        const itemId = event.payload.request.params.itemId;
        const existingInput = state._indexById.get(itemId);
        if (existingInput && existingInput.kind === "userInputRequest") {
          // 更新已有条目（questions 可能在第二次推送时更完整）
          const existing = existingInput as ConversationUserInputRequest;
          existing.questions = event.payload.request.params.questions;
          existing.requestId = event.payload.request.requestId;
          existing.delivery = event.payload.request.params.delivery;
          return;
        }
        indexedPush(state, {
          kind: "userInputRequest",
          ...(event.payload.request.params.delivery ? { delivery: event.payload.request.params.delivery } : {}),
          id: itemId,
          workspaceId: event.payload.request.params.workspaceId,
          threadId: event.payload.request.params.threadId,
          requestId: event.payload.request.requestId,
          header: "需要您补充输入",
          prompt: "请回答以下问题后继续。",
          questions: event.payload.request.params.questions,
          state: "pending",
        } satisfies ConversationUserInputRequest);
        reorderCurrentGroup(state);
      }
      return;
    case "userInput.resolved":
      {
        const existing = findLatestUserInputRequest(state, event.payload.response.requestId, event.payload.response.answers);
        if (existing) {
          existing.state = "submitted";
          existing.submittedAnswers = event.payload.response.answers;
        }
      }
      return;
    case "userInput.expired":
      {
        // Claude 内部超时或拒绝了 AskUserQuestion → 将卡片从 pending 标记为 expired
        const existing = findLatestUserInputRequest(state, event.payload.requestId);
        if (existing && existing.state === "pending") {
          existing.state = "expired";
        }
      }
      return;
    case "item.diff.created":
      removeEmptyReasoningPlaceholders(state);
      upsertDiff(state, {
        kind: "diff",
        id: event.payload.itemId,
        title: event.payload.title,
        diff: event.payload.diff,
        status: event.payload.status,
      } satisfies ConversationDiff);
      reorderCurrentGroup(state);
      return;
    case "item.review.started":
      removeEmptyReasoningPlaceholders(state);
      upsertReview(state, { kind: "review", id: event.payload.itemId, state: "started", text: event.payload.text } satisfies ConversationReview);
      reorderCurrentGroup(state);
      return;
    case "item.review.completed":
      removeEmptyReasoningPlaceholders(state);
      upsertReview(state, { kind: "review", id: event.payload.itemId, state: "completed", text: event.payload.text } satisfies ConversationReview);
      reorderCurrentGroup(state);
      return;
    case "item.explore.updated":
      removeEmptyReasoningPlaceholders(state);
      upsertExplore(state, {
        kind: "explore",
        id: event.payload.itemId,
        status: event.payload.status,
        entries: event.payload.entries,
      } satisfies ConversationExplore);
      reorderCurrentGroup(state);
      return;
    case "item.subagent.started":
      removeEmptyReasoningPlaceholders(state);
      upsertSubagent(state, {
        kind: "subagent",
        id: event.payload.itemId,
        taskId: event.payload.taskId,
        toolUseId: event.payload.toolUseId,
        description: event.payload.description,
        taskType: event.payload.taskType,
        status: "running",
      } satisfies ConversationSubagent);
      reorderCurrentGroup(state);
      return;
    case "item.subagent.progress":
      removeEmptyReasoningPlaceholders(state);
      upsertSubagent(state, {
        kind: "subagent",
        id: event.payload.itemId,
        taskId: event.payload.taskId,
        description: event.payload.description,
        status: "running",
        lastToolName: event.payload.lastToolName,
        usage: event.payload.usage,
      } satisfies ConversationSubagent);
      reorderCurrentGroup(state);
      return;
    case "item.subagent.completed":
      removeEmptyReasoningPlaceholders(state);
      upsertSubagent(state, {
        kind: "subagent",
        id: event.payload.itemId,
        taskId: event.payload.taskId,
        description: "",
        status: event.payload.status === "completed" ? "completed" : event.payload.status === "stopped" ? "stopped" : "failed",
        summary: event.payload.summary,
        usage: event.payload.usage,
      } satisfies ConversationSubagent);
      reorderCurrentGroup(state);
      return;
    case "item.subagent.childEvent": {
      const existing = state._indexById.get(String(event.payload.itemId));
      if (!existing || existing.kind !== "subagent") return;
      const sub = existing as ConversationSubagent;
      if (!sub.children) sub.children = [];
      applySubagentChildEvent(sub.children, event.payload.innerEventType, event.payload.innerPayload);
      // 上限保护：只保留最近 200 条
      if (sub.children.length > 200) sub.children = sub.children.slice(-200);
      return;
    }
  }
}

/** 只移除指定聊天消息，保留同轮工具、交互、运行态和其他回复。 */
export function deleteConversationMessages(state: ThreadConversationState, itemIds: Iterable<string>): void {
  const deleted = state.deletedMessageIds ??= new Set();
  for (const id of itemIds) deleted.add(id);
  // 发送响应可能晚于正式消息及其删除通知，连同该轮临时消息一起屏蔽。
  for (const item of state.items) {
    if (item.kind === "message" && item.role === "user" && item.turnId && deleted.has(String(item.id))) {
      deleted.add(`local_user_${item.turnId}`);
    }
  }
  state.items = state.items.filter((item) => {
    if (item.kind !== "message" || !deleted.has(String(item.id))) return true;
    state._indexById.delete(String(item.id));
    return false;
  });
}

function shouldAffectRunningTurn(
  state: ThreadConversationState,
  turnId: string | null | undefined,
): boolean {
  const currentRunningTurnId = String(state.runningTurnId ?? "").trim();
  const targetTurnId = String(turnId ?? "").trim();
  if (!currentRunningTurnId) return true;
  if (!targetTurnId) return true;
  return currentRunningTurnId === targetTurnId;
}

/** 仅按结构化终止语义渲染错误。 */
function buildTurnErrorSystemMessage(event: Extract<EngineEventEnvelope, { type: "turn.error" }>): ConversationSystemMessage {
  const rawErr = String(event.payload.error ?? "");
  const errorCode = String(event.payload.code ?? "").trim();
  const semantics = classifyTurnErrorSemantics({
    terminationKind: event.payload.terminationKind ?? null,
    error: rawErr,
    code: errorCode,
  });
  const interrupt = semantics === "manual_interrupt";
  const transient = isTransientTurnError({
    terminationKind: event.payload.terminationKind ?? null,
    error: rawErr,
    code: errorCode,
  });
  return {
    kind: "systemMessage",
    id: `sys_${event.seq}`,
    type: transient ? "warning" : "error",
    turnId: event.payload.turnId,
    code: errorCode || undefined,
    transient: transient || undefined,
    text: interrupt
      ? "刚才那次请求已中止，可继续发送消息。"
      : semantics === "transient_cleanup"
        ? formatRestartRecoveryMessage(errorCode, rawErr)
        : formatTurnErrorMessage(event.payload),
  };
}

function clearResolvedTransientSystemMessages(state: ThreadConversationState): void {
  const nextItems = state.items.filter((item) => !shouldAutoClearSystemMessage(item));
  if (nextItems.length === state.items.length) return;
  state.items.splice(0, state.items.length, ...nextItems);
  rebuildConversationIndex(state);
}

function shouldAutoClearSystemMessage(item: ConversationItem): boolean {
  if (item.kind !== "systemMessage") return false;
  if (item.transient) return true;
  return isTransientTurnErrorCode(String(item.code ?? "").trim());
}

function rebuildConversationIndex(state: ThreadConversationState): void {
  state._indexById.clear();
  for (const item of state.items) {
    const key = String(item.id ?? "");
    if (key) state._indexById.set(key, item);
  }
}

/** 保留格式化所需字段，快照无需读取 canonical 即可更新当前节点名。 */
function buildOrchestrationSystemMessage(event: EngineEventEnvelope, nodeLabels?: OrchestrationNodeLabelMap): ConversationSystemMessage {
  const { type, seq } = event;
  const payload = event.payload as Record<string, unknown>;
  return {
    kind: "systemMessage",
    id: `orch_${seq}`,
    type: orchestrationMessageLevel(type, payload),
    text: formatOrchestrationEventText(type, payload, nodeLabels),
    orchestrationDisplay: { type, payload: orchestrationDisplayPayload(payload) },
  };
}

/** 排除提示词、产物正文等与事件文案无关的数据。 */
function orchestrationDisplayPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const display: Record<string, unknown> = {};
  for (const key of ["workflowName", "nodeId", "nodeLabel", "fromNodeId", "fromNodeLabel", "targetNodeId", "targetNodeLabel",
    "artifactKind", "publishedPath", "stagingPath", "discardedPath", "fileCount", "status", "action", "version", "note", "nextAction", "source", "error"]) {
    if (payload[key] !== undefined) display[key] = payload[key];
  }
  if (Array.isArray(payload.files)) display.files = payload.files.map(file => ({ path: (file as { path?: unknown })?.path }));
  if (Array.isArray(payload.results)) display.results = payload.results.map(result => ({ passed: Boolean((result as { passed?: unknown })?.passed) }));
  return display;
}

/** 用现有格式函数更新快照文案，节点已删除时保留事件冻结名。 */
export function refreshConversationNodeLabels(items: readonly ConversationItem[], nodeLabels: OrchestrationNodeLabelMap): ConversationItem[] {
  return items.map(item => item.kind === "systemMessage" && item.orchestrationDisplay
    ? { ...item, text: formatOrchestrationEventText(item.orchestrationDisplay.type, item.orchestrationDisplay.payload, nodeLabels) } : item);
}

function orchestrationMessageLevel(type: string, payload: Record<string, unknown>): ConversationSystemMessage["type"] {
  if (type === "orchestration.error") return "error";
  if (type === "orchestration.completed") {
    const status = String(payload.status ?? "").trim();
    if (status === "completed") return "success";
    if (status === "failed") return "error";
    return "warning";
  }
  if (
    type === "orchestration.artifactWritten"
    || type === "orchestration.artifactRevised"
    || type === "orchestration.artifactWorkspaceWritten"
    || type === "orchestration.artifactPublished"
  ) {
    return "success";
  }
  if (type === "orchestration.gateResult") {
    const results = Array.isArray(payload.results) ? payload.results : [];
    return results.length > 0 && results.every((item) => Boolean((item as any)?.passed)) ? "success" : "warning";
  }
  if (type === "orchestration.approvalRequested" || type === "orchestration.feedbackRequested" || type === "orchestration.reworkRequested" || type === "orchestration.artifactDiscarded") {
    return "warning";
  }
  return "info";
}

/** 事件文案里的节点名优先取当前定义（按 nodeId），节点已删除时回退事件里冻结的旧名。 */
function displayEventNodeLabel(nodeId: unknown, frozenLabel: unknown, fallback: string, nodeLabels?: OrchestrationNodeLabelMap): string {
  const currentLabel = nodeLabels?.get(String(nodeId ?? "").trim());
  return normalizeOrchestrationNodeLabel(currentLabel ?? frozenLabel ?? nodeId, fallback);
}

function formatOrchestrationEventText(type: string, payload: Record<string, unknown>, nodeLabels?: OrchestrationNodeLabelMap): string {
  const workflowName = textOrFallback(payload.workflowName, "未命名流程");
  const nodeLabel = displayEventNodeLabel(payload.nodeId, payload.nodeLabel, "节点", nodeLabels);
  const fromNodeLabel = displayEventNodeLabel(payload.fromNodeId, payload.fromNodeLabel, "当前节点", nodeLabels);
  const targetNodeLabel = displayEventNodeLabel(payload.targetNodeId, payload.targetNodeLabel, "目标节点", nodeLabels);
  const artifactKind = textOrFallback(payload.artifactKind, "结果");
  const workspacePath = textOrFallback(payload.publishedPath ?? payload.stagingPath ?? payload.discardedPath, "");
  const fileCount = numberOrNull(payload.fileCount);

  switch (type) {
    case "orchestration.started":
      return `流程已启动：${workflowName}`;
    case "orchestration.recovered":
      return `流程已恢复：${workflowName}`;
    case "orchestration.completed":
      return `流程已结束：${orchestrationStatusLabel(String(payload.status ?? ""))}`;
    case "orchestration.nodeStateChanged":
      return `${nodeLabel} 状态变为 ${nodeExecutionStatusLabel(String(payload.status ?? ""))}`;
    case "orchestration.nodeRecovered":
      return `${nodeLabel} 已恢复：${nodeRecoveryActionLabel(String(payload.action ?? ""))}`;
    case "orchestration.promptSnapshotCreated":
      return `${nodeLabel} 已生成本次提示词快照`;
    case "orchestration.artifactWritten":
      return `${nodeLabel} 已生成${artifactKind}`;
    case "orchestration.artifactRevised": {
      const version = numberOrNull(payload.version);
      const files = Array.isArray(payload.files) ? payload.files : [];
      const visiblePaths = files
        .map((item) => String((item as { path?: unknown })?.path ?? "").trim())
        .filter(Boolean);
      const pathText = visiblePaths.length
        ? `：${visiblePaths.slice(0, 3).join("、")}${visiblePaths.length > 3 ? ` 等 ${visiblePaths.length} 个文件` : ""}`
        : "";
      const note = textOrFallback(payload.note, "");
      return `${nodeLabel} 已保存人工修订${version != null ? ` v${version}` : ""}${pathText}${note ? `（${note}）` : ""}`;
    }
    case "orchestration.artifactWorkspaceWritten":
      return `${nodeLabel} 已写入工作区${workspacePath ? `：${workspacePath}` : ""}${fileCount != null ? `（${fileCount} 个文件）` : ""}`;
    case "orchestration.artifactPublished":
      return `${nodeLabel} 产出物已发布${workspacePath ? `：${workspacePath}` : ""}${fileCount != null ? `（${fileCount} 个文件）` : ""}`;
    case "orchestration.artifactDiscarded":
      return `${nodeLabel} 已驳回结果${workspacePath ? `：${workspacePath}` : ""}`;
    case "orchestration.gateResult": {
      const results = Array.isArray(payload.results) ? payload.results : [];
      const passed = results.filter((item) => Boolean((item as any)?.passed)).length;
      const total = results.length;
      return `${nodeLabel} 已完成门禁检查${total ? `（${passed}/${total} 通过）` : ""}`;
    }
    case "orchestration.approvalRequested":
      if (String(payload.nextAction ?? "") === "rework") return `${nodeLabel} 建议退回上游，等待人工确认`;
      return `${nodeLabel} 等待人工审核`;
    case "orchestration.feedbackRequested": {
      const source = String(payload.source ?? "").trim();
      if (source === "human_input") return `${nodeLabel} 等待补充输入`;
      if (source === "review") return `${nodeLabel} 等待人工决策`;
      if (source === "gate") return `${nodeLabel} 门禁未通过，等待处理`;
      if (source === "execution") return `${nodeLabel} 会话异常中断`;
      return `${nodeLabel} 等待人工处理`;
    }
    case "orchestration.reworkRequested":
      return `${fromNodeLabel} 已退回到 ${targetNodeLabel}`;
    case "orchestration.error":
      if (payload.nodeLabel || payload.nodeId) {
        return `${nodeLabel} 执行失败：${textOrFallback(payload.error, "未知错误")}`;
      }
      return `流程执行失败：${textOrFallback(payload.error, "未知错误")}`;
    default:
      return type;
  }
}

function textOrFallback(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function numberOrNull(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeOrchestrationNodeLabel(value: unknown, fallback: string): string {
  const text = textOrFallback(value, fallback);
  if (text === "START") return "开始节点";
  if (text === "END") return "结束节点";
  return text;
}

function orchestrationStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "等待中",
    running: "执行中",
    paused: "已暂停",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return map[status] ?? (status || "未知状态");
}

function nodeExecutionStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "等待中",
    queued: "排队中",
    running: "运行中",
    "result-submitted": "结果已提交",
    finalizing: "正在收尾",
    "artifact-writing": "写入结果",
    "gate-checking": "门禁检查",
    "waiting-approval": "等待审核",
    "waiting-feedback": "等待反馈",
    completed: "已完成",
    failed: "失败",
    skipped: "已跳过",
    cancelled: "已取消",
  };
  return map[status] ?? (status || "未知状态");
}

function nodeRecoveryActionLabel(action: string): string {
  const map: Record<string, string> = {
    "completed-turn-replayed": "已回放已完成轮次",
    "retry-queued-after-error": "错误后重新排队",
    "failed-after-recovery": "恢复后仍失败",
    requeued: "已重新排队",
  };
  return map[action] ?? (action || "已恢复");
}

/**
 * 更新当前上下文快照（单次 API call 的 usage）。
 *
 * 关键点：
 * - `inputTokens/cachedInputTokens/cacheCreationInputTokens` 必须视为“同一次调用的完整快照”
 *   来整体更新，不能按字段分别取 max，否则会把不同时间点的峰值拼成一个虚假的总输入。
 * - 仅当事件完全没有输入侧字段时，才保留旧的输入快照（典型是只携带 outputTokens 的增量事件）。
 */
function mergeTokenUsage(state: ThreadConversationState, snapshot: TokenUsageSnapshot): void {
  if (!state.tokenUsage) state.tokenUsage = createEmptyTokenUsageState();
  const cur = state.tokenUsage.current;

  const hasInputSnapshot =
    snapshot.inputTokens != null ||
    snapshot.cachedInputTokens != null ||
    snapshot.cacheCreationInputTokens != null;

  if (hasInputSnapshot) {
    cur.inputTokens = snapshot.inputTokens ?? 0;
    cur.cachedInputTokens = snapshot.cachedInputTokens ?? 0;
    cur.cacheCreationInputTokens = snapshot.cacheCreationInputTokens ?? 0;
  }

  if (snapshot.outputTokens != null) cur.outputTokens = snapshot.outputTokens;
  if (snapshot.totalTokens != null) cur.totalTokens = snapshot.totalTokens;
  if (snapshot.reasoningOutputTokens != null) cur.reasoningOutputTokens = snapshot.reasoningOutputTokens;
  if (snapshot.modelContextWindow != null) cur.modelContextWindow = snapshot.modelContextWindow;
}

/** 应用 result 累计：官方 Claude 使用快照替换，GLM 本轮 usage 使用 delta 累加。 */
function applyCumulativeUsage(
  state: ThreadConversationState,
  snapshot: TokenUsageSnapshot,
  mode: "snapshot" | "delta" | undefined,
): void {
  if (!state.tokenUsage) state.tokenUsage = createEmptyTokenUsageState();
  const cum = state.tokenUsage.cumulative;

  if (mode === "delta") {
    if (snapshot.inputTokens != null) cum.inputTokens += snapshot.inputTokens;
    if (snapshot.outputTokens != null) cum.outputTokens += snapshot.outputTokens;
    if (snapshot.cachedInputTokens != null) cum.cachedInputTokens += snapshot.cachedInputTokens;
    if (snapshot.cacheCreationInputTokens != null) cum.cacheCreationInputTokens += snapshot.cacheCreationInputTokens;
    if (snapshot.totalTokens != null) cum.totalTokens = (cum.totalTokens ?? 0) + snapshot.totalTokens;
    if (snapshot.reasoningOutputTokens != null) cum.reasoningOutputTokens = (cum.reasoningOutputTokens ?? 0) + snapshot.reasoningOutputTokens;
  } else {
    if (snapshot.inputTokens != null) cum.inputTokens = snapshot.inputTokens;
    if (snapshot.outputTokens != null) cum.outputTokens = snapshot.outputTokens;
    if (snapshot.cachedInputTokens != null) cum.cachedInputTokens = snapshot.cachedInputTokens;
    if (snapshot.cacheCreationInputTokens != null) cum.cacheCreationInputTokens = snapshot.cacheCreationInputTokens;
    if (snapshot.totalTokens != null) cum.totalTokens = snapshot.totalTokens;
    if (snapshot.reasoningOutputTokens != null) cum.reasoningOutputTokens = snapshot.reasoningOutputTokens;
  }
  if (snapshot.modelContextWindow != null) state.tokenUsage.current.modelContextWindow = snapshot.modelContextWindow;
}

/** 按子消息 ID 归并增量、快照与完成正文，避免回复丢失或重复拼接。 */
function applySubagentChildEvent(items: ConversationItem[], type: string, payload: any): void {
  if (type === "item.tool.started") {
    items.push({
      kind: "tool",
      id: payload.itemId,
      toolType: payload.toolName,
      title: payload.toolName,
      detail: formatJson(payload.input),
      status: "started",
      summary: payload.summary,
      changes: payload.changes,
    });
  } else if (type === "item.tool.completed") {
    const existing = items.find((i) => i.kind === "tool" && i.id === payload.itemId);
    if (existing && existing.kind === "tool") {
      existing.status = payload.status === "failed" ? "failed" : "completed";
      existing.output = formatJson(payload.output) || existing.output;
    } else {
      items.push({
        kind: "tool",
        id: payload.itemId,
        toolType: payload.toolName ?? "tool",
        title: payload.toolName ?? "tool",
        detail: "",
        status: payload.status ?? "completed",
        output: formatJson(payload.output),
      });
    }
  } else if (type === "item.agentMessage.started" || type === "item.agentMessage.delta" || type === "item.agentMessage.snapshot" || type === "item.agentMessage.completed") {
    let message = items.find((item): item is ConversationMessage => item.kind === "message" && item.role === "assistant" && item.id === payload.itemId);
    if (!message) {
      message = { kind: "message", id: payload.itemId, role: "assistant", text: "", format: "markdown" };
      items.push(message);
    }
    const revision = typeof payload.revision === "number" ? payload.revision : message.revision ?? 0;
    if (revision < (message.revision ?? 0) || message.streamState === "completed" && type !== "item.agentMessage.completed") return;
    if (type === "item.agentMessage.delta") message.text += payload.delta;
    else if (type !== "item.agentMessage.started") message.text = payload.text;
    message.revision = revision;
    message.streamState = type === "item.agentMessage.completed" ? "completed" : "streaming";
    message.phase = payload.phase ?? message.phase;
    message.engineMessageId = payload.engineMessageId ?? message.engineMessageId;
    message.turnId = payload.turnId ?? message.turnId;
    if (type === "item.agentMessage.completed") {
      message.completionSource = payload.completionSource;
      message.structuredPayloadJson = payload.structuredPayloadJson ?? null;
    }
  } else if (type === "item.reasoning.delta") {
    const last = items.length > 0 ? items[items.length - 1] : null;
    if (last && last.kind === "reasoning") {
      last.content += payload.delta;
    } else {
      items.push({ kind: "reasoning", id: payload.itemId, content: payload.delta });
    }
  }
}

function isTodoListToolName(toolName: string): boolean {
  /** 输出侧待办列表：Codex=update_plan，Claude=todowrite。 */
  return toolName === "update_plan" || toolName === "todowrite";
}

function formatTurnErrorMessage(payload: Pick<TurnErrorPayload, "error" | "additionalDetails" | "providerErrorInfo">): string {
  const msg = pickPreferredTurnErrorMessage(payload);
  if (!msg) return "错误：引擎未提供详细原因。";

  if (/prompt is too long/i.test(msg) || /input is too long/i.test(msg) || /context length/i.test(msg)) {
    return "上下文过长，Claude 无法继续处理。请先点击“压缩”，若仍失败再使用“重置”。";
  }

  return `错误：${msg}`;
}

function pickPreferredTurnErrorMessage(payload: Pick<TurnErrorPayload, "error" | "additionalDetails" | "providerErrorInfo">): string {
  const rawErr = normalizeTurnErrorText(payload.error);
  if (rawErr && !isGenericTurnErrorMessage(rawErr)) return rawErr;

  const additionalDetails = normalizeTurnErrorText(payload.additionalDetails);
  if (additionalDetails) return additionalDetails;

  const providerErrorInfo = normalizeTurnErrorText(payload.providerErrorInfo);
  if (providerErrorInfo) return formatProviderErrorInfo(providerErrorInfo);

  if (rawErr) return "引擎返回了通用错误，但未提供详细原因。";
  return "";
}

function normalizeTurnErrorText(value: unknown): string {
  return String(value ?? "").trim();
}

function isGenericTurnErrorMessage(message: string): boolean {
  const normalized = normalizeTurnErrorText(message).toLowerCase();
  return normalized === "codex error" || normalized === "error";
}

function formatProviderErrorInfo(providerErrorInfo: string): string {
  const normalized = normalizeTurnErrorText(providerErrorInfo);
  if (!normalized) return "";
  if (normalized.toLowerCase() === "other") return "引擎返回了错误类型是其他，但未提供更多细节。";
  if (/^[a-z0-9_.-]+$/i.test(normalized)) return `引擎返回错误类别（${normalized}）`;
  return `引擎返回错误信息：${normalized}`;
}

/** 仅格式化已写入 turn.error 的重启终态，不处理仍保持 running 的对账结果。 */
function formatRestartRecoveryMessage(errorCode: string, rawErr: string): string {
  switch (String(errorCode ?? "").trim()) {
    case "client_restarted":
      return "CodeFlow 重启前未完成的那次请求已结束；当前会话仍可继续发送消息。";
    case "codex_interrupted":
    case "codex_cancelled":
      return "CodeFlow 重启后确认上一条未完成请求已经中止；当前会话仍可继续发送消息。";
    default:
      break;
  }
  const msg = String(rawErr ?? "").trim();
  if (!msg) {
    return "CodeFlow 重启后，上一次未完成的请求已结束；当前会话仍可继续发送消息。";
  }
  return `${msg} 当前会话仍可继续发送消息。`;
}

/**
 * turn 结束时兜底收口：若存在未收到 completed 的 tool，则按 turn 终态补一个渲染态收尾。
 * - 仅修改渲染态（ConversationTool），不回写 DB。
 */
function finalizeDanglingTools(state: ThreadConversationState, turnOutcome: "completed" | "error"): void {
  const completedTip = "（收尾缺失）轮次已结束，但未收到工具完成事件；以下仅展示已收到的过程输出。";
  const errorTip = "（未完成）轮次已异常结束，未收到工具完成事件（可能为中断/超时/进程退出/事件丢失）。";
  for (const item of state.items) {
    if (item.kind === "tool") {
      if (item.status !== "started" && item.status !== "unknown") continue;
      if (turnOutcome === "completed") {
        item.status = "incomplete";
        item.output = item.output ? `${item.output}\n\n${completedTip}` : completedTip;
        item.summary = item.summary || "（轮次已结束，工具收尾事件缺失）";
      } else {
        item.status = "failed";
        item.output = item.output ? `${item.output}\n\n${errorTip}` : errorTip;
        item.summary = item.summary || "（轮次异常结束，未收到完成事件）";
      }
    } else if (item.kind === "subagent") {
      if (item.status !== "running") continue;
      item.status = "failed";
      item.summary = item.summary || "（轮次已结束，未收到完成事件）";
    } else if (item.kind === "userInputRequest") {
      if (item.state !== "pending") continue;
      if (item.delivery === "async") continue;
      item.state = "expired";
    }
  }
}

function shouldIgnoreAssistantMessageEvent(
  event: Extract<
    EngineEventEnvelope,
    | { type: "item.agentMessage.started" }
    | { type: "item.agentMessage.delta" }
    | { type: "item.agentMessage.snapshot" }
    | { type: "item.agentMessage.completed" }
  >,
  msg: ConversationMessage,
): boolean {
  if (event.engine !== "codex") return false;
  const incomingEngineMessageId = String(event.payload.engineMessageId ?? "").trim();
  const currentEngineMessageId = String(msg.engineMessageId ?? "").trim();
  if (!incomingEngineMessageId || !currentEngineMessageId || incomingEngineMessageId === currentEngineMessageId) {
    return false;
  }
  return messagePhasePriority(msg.phase) > incomingAssistantEventPhasePriority(event);
}

function shouldResetAssistantMessageStream(
  event: Extract<
    EngineEventEnvelope,
    | { type: "item.agentMessage.started" }
    | { type: "item.agentMessage.delta" }
    | { type: "item.agentMessage.snapshot" }
    | { type: "item.agentMessage.completed" }
  >,
  msg: ConversationMessage,
): boolean {
  if (event.engine !== "codex") return false;
  const incomingEngineMessageId = String(event.payload.engineMessageId ?? "").trim();
  const currentEngineMessageId = String(msg.engineMessageId ?? "").trim();
  return Boolean(incomingEngineMessageId && currentEngineMessageId && incomingEngineMessageId !== currentEngineMessageId);
}

function resetAssistantMessageStream(
  msg: ConversationMessage,
  input: {
    engineMessageId: string;
    turnId?: string | null;
    phase?: ConversationMessage["phase"];
  },
): void {
  msg.engineMessageId = input.engineMessageId;
  if (input.turnId) msg.turnId = input.turnId as any;
  msg.text = "";
  msg.format = "plain";
  msg.createdAt = undefined;
  msg.revision = 0;
  msg.streamState = "streaming";
  msg.phase = input.phase ?? msg.phase;
  msg.completionSource = undefined;
  msg.structuredPayloadJson = null;
}

function incomingAssistantEventPhasePriority(
  event: Extract<
    EngineEventEnvelope,
    | { type: "item.agentMessage.started" }
    | { type: "item.agentMessage.delta" }
    | { type: "item.agentMessage.snapshot" }
    | { type: "item.agentMessage.completed" }
  >,
): number {
  const phase = "phase" in event.payload ? event.payload.phase : undefined;
  return phase ? messagePhasePriority(phase) : 0;
}

function messagePhasePriority(phase: ConversationMessage["phase"]): number {
  if (phase === "structured_result") return 4;
  if (phase === "final_answer") return 3;
  if (phase === "commentary") return 1;
  return 2;
}

function messageCompletionSourcePriority(source: ConversationMessage["completionSource"]): number {
  if (source === "synthetic_structured_result") return 4;
  if (source === "snapshot_reconcile") return 3;
  if (source === "provider") return 2;
  if (source === "runtime_close_reconcile") return 1;
  return 0;
}

/**
 * 对当前 assistant group（最后一个 user/system message 之后的所有 items）做一次排序，
 * 修正跨通道事件乱序导致的显示位置异常。
 *
 * 逻辑顺序：reasoning → tool/explore/diff/review/subagent/approval/userInput → assistant text
 *
 * 这是系统性安全网：
 * 1. turn 结束时兜底归位
 * 2. 运行中 assistant/tool 类事件改变当前组结构时，也保持同一排序规则
 *
 * 同时保持 tool/subagent 之间的相对顺序不变（稳定排序）。
 */
function reorderCurrentGroup(state: ThreadConversationState): void {
  // 保留真实时间线，不再把同一 assistant group 的 item 按语义桶重排。
}

/** 复用编号时按完整问题集合消歧；唯一请求仍沿旧协议接纳部分回答。 */
function findLatestUserInputRequest(
  state: ThreadConversationState,
  requestId: ConversationUserInputRequest["requestId"],
  answers?: ConversationUserInputRequest["submittedAnswers"],
): ConversationUserInputRequest | undefined {
  const answerIds = answers ? Object.keys(answers) : [];
  let latest: ConversationUserInputRequest | undefined;
  let matches = 0;
  for (let index = state.items.length - 1; index >= 0; index--) {
    const item = state.items[index]!;
    if (item.kind !== "userInputRequest" || item.requestId !== requestId) continue;
    latest ??= item; matches++;
    if (!answers || answerIds.length === item.questions.length
      && answerIds.every(id => item.questions.some(question => question.id === id))) return item;
  }
  return matches === 1 ? latest : undefined;
}

/** summaryPartAdded：在 summary 段落间加一个空行，提升可读性。 */
function addSummaryBoundary(existing: string): string {
  if (!existing) return existing;
  if (existing.endsWith("\n\n")) return existing;
  if (existing.endsWith("\n")) return `${existing}\n`;
  return `${existing}\n\n`;
}

