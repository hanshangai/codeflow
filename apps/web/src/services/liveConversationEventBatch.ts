import type { EngineEventEnvelope } from "@codeflowai/shared";

type MergeableLiveEvent = Extract<
  EngineEventEnvelope,
  { type: "item.agentMessage.delta" | "item.reasoning.delta" | "item.reasoning.summaryDelta" }
>;

/**
 * 合并同一批实时事件里的高频文本增量，减少 Vue 响应式状态写入次数。
 *
 * tokenUsage、工具事件和交互事件仍保留原顺序；只有同一 item 的文本增量
 * 会在不改变最后 seq/ts 的前提下拼接，终态和用户交互事件不会被吞掉。
 */
export function coalesceLiveConversationEvents(
  events: readonly EngineEventEnvelope[],
): EngineEventEnvelope[] {
  const output: Array<EngineEventEnvelope | null> = [];
  const mergeSlots = new Map<string, number>();

  for (const event of events) {
    if (!isMergeableEvent(event)) {
      clearMergeSlotsForBoundary(mergeSlots, event);
      output.push(cloneEvent(event));
      continue;
    }
    const mergeKey = getMergeKey(event);
    if (!mergeKey) {
      output.push(cloneEvent(event));
      continue;
    }

    const previousIndex = mergeSlots.get(mergeKey);
    const previous = previousIndex == null ? undefined : output[previousIndex];
    if (previousIndex != null && previous && isMergeableEvent(previous)) {
      // 将合并后的事件放到最新 delta 的位置，避免跨 tokenUsage 后改变事件顺序。
      output[previousIndex] = null;
      output.push(mergeTextDelta(previous, event));
      mergeSlots.set(mergeKey, output.length - 1);
      continue;
    }

    mergeSlots.set(mergeKey, output.length);
    output.push(cloneEvent(event));
  }

  return output.filter((event): event is EngineEventEnvelope => event !== null);
}

function getMergeKey(event: EngineEventEnvelope): string | null {
  if (
    event.type !== "item.agentMessage.delta"
    && event.type !== "item.reasoning.delta"
    && event.type !== "item.reasoning.summaryDelta"
  ) return null;
  const itemId = String(event.payload.itemId ?? "").trim();
  if (!itemId) return null;
  return `${event.workspaceId}\u0000${event.threadId}\u0000${event.type}\u0000${itemId}`;
}

function clearMergeSlotsForBoundary(
  mergeSlots: Map<string, number>,
  event: EngineEventEnvelope,
): void {
  if (event.type === "tokenUsage.updated") return;
  // 交互、工具、started/completed 与终态都构成显示顺序边界；不跨边界合并。
  mergeSlots.clear();
}

function isMergeableEvent(event: EngineEventEnvelope): event is MergeableLiveEvent {
  return event.type === "item.agentMessage.delta"
    || event.type === "item.reasoning.delta"
    || event.type === "item.reasoning.summaryDelta";
}

function mergeTextDelta(previous: MergeableLiveEvent, next: MergeableLiveEvent): MergeableLiveEvent {
  return {
    ...previous,
    seq: next.seq,
    ts: next.ts,
    payload: {
      ...previous.payload,
      ...next.payload,
      delta: String(previous.payload.delta ?? "") + String(next.payload.delta ?? ""),
    },
  } as MergeableLiveEvent;
}

function cloneEvent(event: EngineEventEnvelope): EngineEventEnvelope {
  return {
    ...event,
    payload: { ...(event.payload as Record<string, unknown>) } as EngineEventEnvelope["payload"],
  } as EngineEventEnvelope;
}
