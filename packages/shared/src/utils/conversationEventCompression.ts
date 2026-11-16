import type {
  AgentMessageDeltaPayload,
  ConversationEventEnvelope,
  ReasoningDeltaPayload,
  ReasoningSummaryDeltaPayload,
  ToolOutputDeltaPayload,
} from "../types/events.js";

type MergeableConversationEvent =
  | Extract<ConversationEventEnvelope, { type: "item.agentMessage.delta" }>
  | Extract<ConversationEventEnvelope, { type: "item.reasoning.delta" }>
  | Extract<ConversationEventEnvelope, { type: "item.reasoning.summaryDelta" }>
  | Extract<ConversationEventEnvelope, { type: "item.tool.outputDelta" }>
  | Extract<ConversationEventEnvelope, { type: "item.subagent.childEvent" }>
  | Extract<ConversationEventEnvelope, { type: "item.diff.created" }>;

/**
 * 压缩会话回放里的高频 delta 和可替换快照事件。
 *
 * 约束：
 * - 只合并“相邻且同一 item”的可叠加 delta，绝不跨越中间事件重排。
 * - `tool.outputDelta` 需要保留 `mode=replace` 语义，不能简单字符串拼接。
 * - `diff.created` 是上游 aggregate snapshot，同一 item 只保留最后一份。
 * - 同一子任务中的相邻事件沿用内部事件的合并规则，保留任务和消息边界。
 * - 实时缓存可关闭子事件合并，保留历史窗口之外的逐条序号。
 * - 合并后的 `seq/ts` 取最后一条事件，便于实时流式继续推进。
 */
export function compressConversationEvents(
  events: readonly ConversationEventEnvelope[],
  opts?: { subagentChildEvents?: boolean },
): ConversationEventEnvelope[] {
  const out: ConversationEventEnvelope[] = [];
  for (const event of events) {
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (prev && (opts?.subagentChildEvents !== false || event.type !== "item.subagent.childEvent") && canMergeConversationEvent(prev, event)) {
      out[out.length - 1] = mergeConversationEvent(prev as MergeableConversationEvent, event as MergeableConversationEvent);
      continue;
    }
    out.push(cloneConversationEvent(event));
  }
  return out;
}

/** 仅同一会话、任务和消息的连续增量可合并，生命周期事件保持原顺序。 */
function canMergeConversationEvent(
  prev: ConversationEventEnvelope,
  next: ConversationEventEnvelope,
): boolean {
  if (prev.type !== next.type) return false;
  if (prev.workspaceId !== next.workspaceId || prev.threadId !== next.threadId || prev.engine !== next.engine) return false;

  if (prev.type === "item.subagent.childEvent") {
    const nextChild = next as typeof prev;
    const previousItemId = (prev.payload.innerPayload as { itemId?: unknown } | null)?.itemId;
    const nextItemId = (nextChild.payload.innerPayload as { itemId?: unknown } | null)?.itemId;
    if (typeof previousItemId !== "string" || !previousItemId || previousItemId !== nextItemId) return false;
    return prev.payload.itemId === nextChild.payload.itemId && prev.payload.taskId === nextChild.payload.taskId
      && canMergeConversationEvent(unwrapSubagentEvent(prev), unwrapSubagentEvent(nextChild));
  }
  if (prev.type === "item.agentMessage.delta") {
    return prev.payload.itemId === (next as typeof prev).payload.itemId;
  }
  if (prev.type === "item.reasoning.delta") {
    return prev.payload.itemId === (next as typeof prev).payload.itemId;
  }
  if (prev.type === "item.reasoning.summaryDelta") {
    return prev.payload.itemId === (next as typeof prev).payload.itemId;
  }
  if (prev.type === "item.tool.outputDelta") {
    const nextTool = next as typeof prev;
    return prev.payload.itemId === nextTool.payload.itemId
      && String(prev.payload.toolName ?? "") === String(nextTool.payload.toolName ?? "");
  }
  if (prev.type === "item.diff.created") {
    return prev.payload.itemId === (next as typeof prev).payload.itemId;
  }
  return false;
}

/** 合并已校验的相邻事件；子任务只替换内部载荷，序号沿用外层最新事件。 */
function mergeConversationEvent(
  prev: MergeableConversationEvent,
  next: MergeableConversationEvent,
): MergeableConversationEvent {
  if (prev.type === "item.subagent.childEvent") {
    const merged = mergeConversationEvent(unwrapSubagentEvent(prev) as MergeableConversationEvent, unwrapSubagentEvent(next as typeof prev) as MergeableConversationEvent);
    return { ...prev, seq: next.seq, ts: next.ts, replayFromSeq: prev.replayFromSeq ?? prev.seq, payload: { ...prev.payload, innerPayload: merged.payload } };
  }
  if (prev.type === "item.diff.created") {
    const latest = Number(next.seq) >= Number(prev.seq) ? next : prev;
    return cloneConversationEvent(latest) as MergeableConversationEvent;
  }

  if (prev.type === "item.agentMessage.delta") {
    return {
      ...prev,
      seq: next.seq,
      ts: next.ts,
      payload: {
        ...(prev.payload as AgentMessageDeltaPayload),
        delta: String(prev.payload.delta ?? "") + String((next as typeof prev).payload.delta ?? ""),
      },
    };
  }

  if (prev.type === "item.reasoning.delta") {
    return {
      ...prev,
      seq: next.seq,
      ts: next.ts,
      payload: {
        ...(prev.payload as ReasoningDeltaPayload),
        delta: String(prev.payload.delta ?? "") + String((next as typeof prev).payload.delta ?? ""),
      },
    };
  }

  if (prev.type === "item.reasoning.summaryDelta") {
    return {
      ...prev,
      seq: next.seq,
      ts: next.ts,
      payload: {
        ...(prev.payload as ReasoningSummaryDeltaPayload),
        delta: String(prev.payload.delta ?? "") + String((next as typeof prev).payload.delta ?? ""),
      },
    };
  }

  const mergedToolDelta = mergeToolOutputDeltaPayload(prev.payload, next.payload as ToolOutputDeltaPayload);
  return {
    ...prev,
    seq: next.seq,
    ts: next.ts,
    payload: mergedToolDelta,
  };
}

/** 将子任务内部事件映射为同一会话事件，复用现有增量合并语义。 */
function unwrapSubagentEvent(event: Extract<ConversationEventEnvelope, { type: "item.subagent.childEvent" }>): ConversationEventEnvelope {
  return { ...event, type: event.payload.innerEventType, payload: event.payload.innerPayload } as ConversationEventEnvelope;
}

function mergeToolOutputDeltaPayload(
  prev: ToolOutputDeltaPayload,
  next: ToolOutputDeltaPayload,
): ToolOutputDeltaPayload {
  const prevMode = prev.mode ?? "append";
  const nextMode = next.mode ?? "append";

  if (nextMode === "replace") {
    return {
      ...prev,
      ...next,
      mode: "replace",
      delta: String(next.delta ?? ""),
    };
  }

  return {
    ...prev,
    ...next,
    mode: prevMode === "replace" ? "replace" : "append",
    delta: String(prev.delta ?? "") + String(next.delta ?? ""),
  };
}

function cloneConversationEvent(event: ConversationEventEnvelope): ConversationEventEnvelope {
  return {
    ...event,
    payload: { ...(event.payload as Record<string, unknown>) } as ConversationEventEnvelope["payload"],
  } as ConversationEventEnvelope;
}
