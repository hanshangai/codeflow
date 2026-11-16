import test from "node:test";
import assert from "node:assert/strict";

import { compressConversationEvents } from "../../packages/shared/src/utils/conversationEventCompression.ts";
import type { ConversationEventEnvelope } from "../../packages/shared/src/index.ts";

function createEvent(event: Partial<ConversationEventEnvelope> & Pick<ConversationEventEnvelope, "type" | "payload" | "seq">): ConversationEventEnvelope {
  return {
    schema: 1,
    seq: event.seq,
    ts: event.seq,
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread_demo" as any,
    engine: "codex",
    type: event.type,
    payload: event.payload,
  } as ConversationEventEnvelope;
}

test("compressConversationEvents merges adjacent assistant deltas of the same item", () => {
  const events = [
    createEvent({
      seq: 10,
      type: "item.agentMessage.delta",
      payload: { itemId: "msg_1" as any, engineMessageId: "engine_1", delta: "您" },
    }),
    createEvent({
      seq: 11,
      type: "item.agentMessage.delta",
      payload: { itemId: "msg_1" as any, engineMessageId: "engine_1", delta: "好" },
    }),
  ];

  const compressed = compressConversationEvents(events);
  assert.equal(compressed.length, 1);
  assert.equal(compressed[0]?.seq, 11);
  assert.deepEqual(compressed[0]?.payload, {
    itemId: "msg_1",
    engineMessageId: "engine_1",
    delta: "您好",
  });
});

test("compressConversationEvents preserves tool output replace semantics", () => {
  const events = [
    createEvent({
      seq: 20,
      type: "item.tool.outputDelta",
      payload: { itemId: "tool_1" as any, toolName: "read", mode: "append", delta: "abc" },
    }),
    createEvent({
      seq: 21,
      type: "item.tool.outputDelta",
      payload: { itemId: "tool_1" as any, toolName: "read", mode: "replace", delta: "xyz" },
    }),
    createEvent({
      seq: 22,
      type: "item.tool.outputDelta",
      payload: { itemId: "tool_1" as any, toolName: "read", mode: "append", delta: "!" },
    }),
  ];

  const compressed = compressConversationEvents(events);
  assert.equal(compressed.length, 1);
  assert.deepEqual(compressed[0]?.payload, {
    itemId: "tool_1",
    toolName: "read",
    mode: "replace",
    delta: "xyz!",
  });
});

test("compressConversationEvents replaces adjacent aggregate diff snapshots", () => {
  const events = [
    createEvent({
      seq: 25,
      type: "item.diff.created",
      payload: { itemId: "diff_1" as any, title: "Diff", diff: "old" },
    }),
    createEvent({
      seq: 26,
      type: "item.diff.created",
      payload: { itemId: "diff_1" as any, title: "Diff", diff: "latest" },
    }),
  ];

  const compressed = compressConversationEvents(events);
  assert.equal(compressed.length, 1);
  assert.equal(compressed[0]?.seq, 26);
  assert.equal(compressed[0]?.type === "item.diff.created" ? compressed[0].payload.diff : null, "latest");
});

test("compressConversationEvents does not cross non-mergeable boundaries", () => {
  const events = [
    createEvent({
      seq: 30,
      type: "item.reasoning.delta",
      payload: { itemId: "reason_1" as any, delta: "A" },
    }),
    createEvent({
      seq: 31,
      type: "tokenUsage.updated",
      payload: { tokenUsage: { inputTokens: 1, outputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: null, modelContextWindow: null }, source: "current" },
    }),
    createEvent({
      seq: 32,
      type: "item.reasoning.delta",
      payload: { itemId: "reason_1" as any, delta: "B" },
    }),
  ];

  const compressed = compressConversationEvents(events);
  assert.equal(compressed.length, 3);
});

test("子任务连续增量沿用主事件压缩语义，保留最后序号且不修改原记录", () => {
  const child = (seq: number, type: string, payload: Record<string, unknown>) => createEvent({
    seq, type: "item.subagent.childEvent",
    payload: { itemId: "review", taskId: "task", innerEventType: type, innerPayload: payload },
  });
  for (const type of ["item.reasoning.delta", "item.reasoning.summaryDelta", "item.agentMessage.delta"]) {
    const events = [child(1, type, { itemId: "reply", delta: "核对" }), child(2, type, { itemId: "reply", delta: "完成" })];
    const compressed = compressConversationEvents(events);
    assert.equal(compressed.length, 1);
    assert.equal(compressed[0]!.seq, 2);
    assert.equal(compressed[0]!.replayFromSeq, 1);
    assert.deepEqual((compressed[0]!.payload as any).innerPayload, { itemId: "reply", delta: "核对完成" });
    assert.equal((events[0]!.payload as any).innerPayload.delta, "核对");
  }
  const output = compressConversationEvents([
    child(3, "item.tool.outputDelta", { itemId: "read", toolName: "read", delta: "old" }),
    child(4, "item.tool.outputDelta", { itemId: "read", toolName: "read", mode: "replace", delta: "new" }),
    child(5, "item.tool.outputDelta", { itemId: "read", toolName: "read", delta: "!" }),
  ]);
  assert.equal(output.length, 1);
  assert.equal(output[0]!.seq, 5);
  assert.deepEqual((output[0]!.payload as any).innerPayload, { itemId: "read", toolName: "read", mode: "replace", delta: "new!" });
});

test("实时子任务缓存保留序号，历史压缩沿用原始覆盖起点", () => {
  const child = (seq: number, delta: string) => createEvent({
    seq, type: "item.subagent.childEvent", payload: {
      itemId: "review", taskId: "task", innerEventType: "item.reasoning.delta", innerPayload: { itemId: "reason", delta },
    },
  });
  const events = [child(1, "A"), child(3, "B"), child(5, "C")];
  assert.deepEqual(compressConversationEvents(events, { subagentChildEvents: false }).map(event => event.seq), [1, 3, 5]);
  const first = compressConversationEvents(events.slice(0, 2));
  const second = compressConversationEvents([...first, events[2]!]);
  assert.equal(second[0]!.replayFromSeq, 1);
  assert.equal(second[0]!.seq, 5);
  assert.equal((second[0]!.payload as any).innerPayload.delta, "ABC");
});

test("子任务压缩不跨任务、消息、事件类型或主会话边界", () => {
  const first = createEvent({ seq: 1, type: "item.subagent.childEvent", payload: {
    itemId: "review", taskId: "task", innerEventType: "item.reasoning.delta", innerPayload: { itemId: "reason", delta: "A" },
  } });
  for (const patch of [
    { itemId: "other-review" }, { taskId: "other-task" },
    { innerEventType: "item.agentMessage.delta" }, { innerPayload: { itemId: "other-reason", delta: "B" } },
    { innerPayload: null }, { innerPayload: {} },
  ]) {
    const second = { ...first, seq: 2, payload: { ...first.payload, ...patch } } as ConversationEventEnvelope;
    assert.equal(compressConversationEvents([first, second]).length, 2);
  }
  const marker = createEvent({ seq: 2, type: "system.notice", payload: { level: "info", text: "主会话消息" } });
  assert.equal(compressConversationEvents([first, marker, { ...first, seq: 3 }]).length, 3);
});
