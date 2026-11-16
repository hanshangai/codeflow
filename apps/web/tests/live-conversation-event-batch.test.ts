import assert from "node:assert/strict";
import test from "node:test";

import { coalesceLiveConversationEvents } from "../src/services/liveConversationEventBatch.ts";
import type { EngineEventEnvelope } from "@codeflowai/shared";
import { createWebSocketClient } from "../src/services/ws.ts";

/** 用可控时钟运行真实 adapter，避免计时波动掩盖事件丢失或跨帧合并。 */
function liveClient(t: test.TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let now = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout(callback: () => void) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
  } });
  t.mock.method(performance, "now", () => now);
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const applied: EngineEventEnvelope[] = [];
  const presentation: Record<string, number> = {};
  const invalidated: string[] = [];
  let eventCost = 0;
  let gitError: Error | undefined;
  let onApply: (() => void) | undefined;
  const workspaceId = "local-client:workspace";
  const config = { workspaceId, localRuntimeReady: true,
    desktopClient: { clientId: "local-client", workspaceIds: [workspaceId, "local-client:next"] } };
  const client = createWebSocketClient({
    config,
    chat: { threadPresentationVersionByThreadId: presentation, threadRollbackEventSeqBarrierByThreadId: {},
      // 本 fixture 只验证正文队列，未挂载展示面板；快照行为由真实 Pinia 用例覆盖。
      requireThreadPresentationVersion() {}, isThreadPresentationVisible: () => false,
      markWorkspaceSubscribed() {}, applyEngineEvent(event: EngineEventEnvelope) { applied.push(event); now += eventCost; onApply?.(); } },
    presence: {}, engine: {}, explorer: { invalidateGitStatus(_ctx: unknown, id: string) {
      invalidated.push(id);
      if (gitError) throw gitError;
    } },
  } as any);
  client.replaceLocalWorkspaceSubscription(workspaceId as any);
  return { client, config, applied, presentation, timers, invalidated,
    setCost(cost: number) { eventCost = cost; },
    setOnApply(callback: () => void) { onApply = callback; },
    setGitError(error?: Error) { gitError = error; },
    enqueue(event: EngineEventEnvelope, target = workspaceId) {
      client.receiveDesktopEvent({ t: "conversation.event", event: { ...event, workspaceId: target as any } });
    },
    flush() { const [id, callback] = timers.entries().next().value!; timers.delete(id); callback(); },
  };
}

test("需保序线程仅隔开自己的边界，不连带禁止其他连续线程的合并", t => {
  const f = liveClient(t);
  f.presentation["preserved"] = 0;
  const events = [
    { ...reasoningDelta(1, "p"), threadId: "preserved" },
    reasoningDelta(2, "a"), reasoningDelta(3, "b"),
    { ...reasoningDelta(4, "q"), threadId: "preserved" },
    reasoningDelta(5, "c"), reasoningDelta(6, "d"),
  ] as EngineEventEnvelope[];
  events.forEach(event => f.enqueue(event));
  f.flush();
  assert.deepEqual(f.applied.map(event => event.seq), [1, 3, 4, 6]);
  assert.deepEqual(f.applied.map(event => (event.payload as { delta: string }).delta), ["p", "ab", "q", "cd"]);
});

test("8ms预算让出后保留原始剩余序号，下一帧建立展示快照仍逐条处理", t => {
  const f = liveClient(t);
  f.setCost(3);
  for (let seq = 1; seq <= 3; seq++) f.enqueue({ ...reasoningDelta(seq, "a"), threadId: `other-${seq}` as any });
  for (let seq = 4; seq <= 10; seq++) f.enqueue(reasoningDelta(seq, "b"));
  f.flush();
  assert.deepEqual(f.applied.map(event => event.seq), [1, 2, 3]);
  f.presentation["thread-1"] = 3;
  while (f.timers.size) f.flush();
  assert.deepEqual(f.applied.map(event => event.seq), Array.from({ length: 10 }, (_, index) => index + 1));
});

test("耗时未超预算仍保留250条原始事件上限", t => {
  const f = liveClient(t);
  f.presentation["thread-1"] = 0;
  for (let seq = 1; seq <= 260; seq++) f.enqueue(reasoningDelta(seq, "x"));
  f.flush();
  assert.equal(f.applied.length, 250);
  f.flush();
  assert.equal(f.applied.length, 260);
});

test("真实adapter不跨token、审批或终态合并，缺少itemId保留独立事件", t => {
  const f = liveClient(t);
  const events = [reasoningDelta(1, "a"), tokenUsage(2), reasoningDelta(3, "b"),
    { ...baseEvent(4), type: "approval.request", payload: { requestId: "approval-1", toolName: "shell" } },
    reasoningDelta(5, "c"), { ...baseEvent(6), type: "turn.completed", payload: { turnId: "turn-1" } },
    { ...baseEvent(7), type: "item.reasoning.delta", payload: { delta: "d" } },
    { ...baseEvent(8), type: "item.reasoning.delta", payload: { delta: "e" } },
  ] as EngineEventEnvelope[];
  events.forEach(event => f.enqueue(event));
  f.flush();
  assert.deepEqual(f.applied.map(event => event.seq), events.map(event => event.seq));
});

test("同步消费回调取消订阅后停止旧队列，不再读取已清理的事件", t => {
  const f = liveClient(t);
  f.presentation["thread-1"] = 0;
  f.setOnApply(() => f.client.replaceLocalWorkspaceSubscription(null));
  f.enqueue(reasoningDelta(1, "a"));
  f.enqueue(reasoningDelta(2, "b"));
  f.flush();
  assert.deepEqual(f.applied.map(event => event.seq), [1]);
  assert.equal(f.timers.size, 0);
});

test("同步切换作用域后旧消费不删除新事件、不重复排定时器或刷新新工作区Git", t => {
  const f = liveClient(t);
  f.presentation["thread-1"] = 0;
  f.setOnApply(() => {
    if (f.applied.length !== 1) return;
    f.client.replaceLocalWorkspaceSubscription(null);
    f.config.workspaceId = "local-client:next";
    f.client.replaceLocalWorkspaceSubscription("local-client:next" as any);
    f.enqueue(reasoningDelta(3, "new"), "local-client:next");
  });
  f.enqueue({ ...baseEvent(1), type: "turn.completed", payload: { turnId: "turn-1" } } as EngineEventEnvelope);
  f.enqueue(reasoningDelta(2, "old"));
  f.flush();
  assert.deepEqual(f.applied.map(event => event.seq), [1]);
  assert.deepEqual(f.invalidated, []);
  assert.equal(f.timers.size, 1);
  f.flush();
  assert.deepEqual(f.applied.map(event => event.seq), [1, 3]);
  assert.equal(f.timers.size, 0);
});

for (const failureBoundary of ["apply", "refresh"] as const) {
  test(`${failureBoundary}同步失败显式抛出且不重放已消费前缀，独立唤醒仍保留未消费原始尾部`, t => {
    const f = liveClient(t);
    f.presentation["thread-1"] = 0;
    const failure = new Error(`${failureBoundary} failure`);
    if (failureBoundary === "apply") f.setOnApply(() => { if (f.applied.length === 2) throw failure; });
    else f.setGitError(failure);
    f.enqueue(reasoningDelta(1, "a"));
    f.enqueue({ ...baseEvent(2), type: "item.tool.completed", payload: { itemId: "tool-1", toolName: "Write" } } as EngineEventEnvelope);
    f.enqueue(reasoningDelta(3, "b"));
    assert.throws(() => f.flush(), error => error === failure);
    assert.deepEqual(f.applied.map(event => event.seq), [1, 2]);
    f.setOnApply(() => {});
    f.setGitError();
    f.enqueue(reasoningDelta(4, "c"));
    f.flush();
    assert.deepEqual(f.applied.map(event => event.seq), [1, 2, 3, 4]);
  });
}

test("合并同一 item 的 reasoning delta，减少高频响应式更新", () => {
  const events = [
    reasoningDelta(1, "a"),
    tokenUsage(2),
    reasoningDelta(3, "b"),
    reasoningDelta(4, "c"),
  ];

  const merged = coalesceLiveConversationEvents(events);

  assert.deepEqual(merged.map((event) => event.type), ["tokenUsage.updated", "item.reasoning.delta"]);
  assert.equal((merged[1] as any).payload.delta, "abc");
  assert.equal(merged[1]?.seq, 4);
});

test("终态和用户交互事件保序且不被增量合并吞掉", () => {
  const events = [
    reasoningDelta(1, "thinking"),
    {
      ...baseEvent(2),
      type: "userInput.requested",
      payload: {
        request: {
          requestId: "request-1",
          params: {
            workspaceId: "workspace-1",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "input-1",
            questions: [],
          },
        },
      },
    },
    reasoningDelta(3, "after"),
    { ...baseEvent(4), type: "turn.completed", payload: { turnId: "turn-1", result: { responseText: "done" } } },
  ] as EngineEventEnvelope[];

  const merged = coalesceLiveConversationEvents(events);

  assert.deepEqual(merged.map((event) => event.type), [
    "item.reasoning.delta",
    "userInput.requested",
    "item.reasoning.delta",
    "turn.completed",
  ]);
  assert.equal((merged[2] as any).payload.delta, "after");
});

test("缺少 itemId 的增量不跨事件合并", () => {
  const events = [
    { ...baseEvent(1), type: "item.reasoning.delta", payload: { delta: "a" } },
    { ...baseEvent(2), type: "item.reasoning.delta", payload: { delta: "b" } },
  ] as EngineEventEnvelope[];

  const merged = coalesceLiveConversationEvents(events);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((event) => (event.payload as { delta?: string }).delta), ["a", "b"]);
});

function baseEvent(seq: number) {
  return {
    schema: 1 as const,
    seq,
    ts: seq,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    engine: "claude" as const,
  };
}

function reasoningDelta(seq: number, delta: string): EngineEventEnvelope {
  return {
    ...baseEvent(seq),
    type: "item.reasoning.delta",
    payload: { itemId: "reasoning-1", delta },
  };
}

function tokenUsage(seq: number): EngineEventEnvelope {
  return {
    ...baseEvent(seq),
    type: "tokenUsage.updated",
    payload: { tokenUsage: { inputTokens: seq } },
  } as EngineEventEnvelope;
}
