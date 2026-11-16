import { performance } from "node:perf_hooks";
import { createPinia, setActivePinia } from "pinia";
import type { EngineEventEnvelope } from "@codeflowai/shared";
import { useChatStore } from "../src/store/chat";

/** 测量真实Pinia流式事件应用；只使用内存事件，不请求模型或桌面数据。 */
function measure(tailLength: number, count: number): void {
  setActivePinia(createPinia());
  const store = useChatStore(), threadId = "benchmark-chat";
  const event = (seq: number): EngineEventEnvelope => ({ schema: 1, seq, ts: seq, workspaceId: "benchmark:workspace", threadId,
    engine: "codex", type: "item.agentMessage.delta", payload: { itemId: "benchmark-message", delta: "x" } }) as EngineEventEnvelope;
  store.threadPresentationVersionByThreadId[threadId] = 1;
  store.threadReplayEventsByThreadId[threadId] = Array.from({ length: tailLength }, (_, index) => event(index + 2));
  const before = store.threadReplayEventsByThreadId[threadId];
  const started = performance.now();
  for (let index = 0; index < count; index++) store.applyEngineEvent(event(tailLength + index + 2));
  const elapsedMs = performance.now() - started;
  console.log(JSON.stringify({ tailLength, appended: count, elapsedMs: Math.round(elapsedMs), perEventMs: Number((elapsedMs / count).toFixed(3)),
    tailArrayReused: before === store.threadReplayEventsByThreadId[threadId], storedEvents: store.threadReplayEventsByThreadId[threadId]?.length }));
  store.$dispose();
}

for (const length of [0, 2000, 10000]) measure(length, 500);
