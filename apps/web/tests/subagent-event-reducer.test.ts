import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSubagent, EngineEventEnvelope } from "@codeflowai/shared";
import { createConversationState } from "../../../tests/support/conversation-fixture.ts";
import { applyEngineEventToConversation } from "../src/features/chat/engineEventReducer.ts";

/** 通过父会话的真实子任务事件入口回放正文，不直接调用内部归并函数。 */
function fixture() {
  const state = createConversationState();
  let seq = 0;
  const emit = (event: Pick<EngineEventEnvelope, "type" | "payload">) => applyEngineEventToConversation(state, {
    schema: 1, seq: ++seq, ts: seq, workspaceId: "workspace", threadId: state.threadId, engine: "codex", ...event,
  } as EngineEventEnvelope);
  emit({ type: "item.subagent.started", payload: { itemId: "review", taskId: "child", description: "复检" } });
  return {
    child: (type: string, payload: Record<string, unknown>) => emit({ type: "item.subagent.childEvent", payload: { itemId: "review", taskId: "child", innerEventType: type, innerPayload: payload } }),
    children: () => (state.items[0] as ConversationSubagent).children ?? [],
  };
}

for (const type of ["item.agentMessage.snapshot", "item.agentMessage.completed"]) test(`复检只有完整回复时仍显示正文：${type}`, () => {
  const f = fixture();
  f.child(type, { itemId: "reply", text: "已核对约束及源码", revision: 1 });
  assert.equal(f.children().length, 1);
  assert.equal(f.children()[0]!.kind, "message");
  assert.equal((f.children()[0] as { text: string }).text, "已核对约束及源码");
});

test("复检增量被快照补齐，完成重放不重复，迟到事件不覆盖终态", () => {
  const f = fixture();
  f.child("item.agentMessage.delta", { itemId: "reply", delta: "已核对" });
  f.child("item.agentMessage.snapshot", { itemId: "reply", text: "已核对约束", revision: 1 });
  const completed = { itemId: "reply", text: "已核对约束及源码", revision: 2, completionSource: "provider" };
  f.child("item.agentMessage.completed", completed);
  f.child("item.agentMessage.completed", completed);
  f.child("item.agentMessage.delta", { itemId: "reply", delta: "迟到增量" });
  f.child("item.agentMessage.snapshot", { itemId: "reply", text: "迟到快照", revision: 3 });
  f.child("item.agentMessage.completed", { itemId: "reply", text: "旧回复", revision: 1 });
  assert.equal(f.children().length, 1);
  assert.equal((f.children()[0] as { text: string }).text, completed.text);
  assert.equal((f.children()[0] as { streamState: string }).streamState, "completed");
});

test("多条子回复按消息 ID 独立归并，穿插工具事件不拆分正文", () => {
  const f = fixture();
  f.child("item.agentMessage.started", { itemId: "first" });
  f.child("item.agentMessage.delta", { itemId: "first", delta: "检查" });
  f.child("item.tool.started", { itemId: "read", toolName: "read", input: {} });
  f.child("item.agentMessage.delta", { itemId: "second", delta: "第二条" });
  f.child("item.agentMessage.delta", { itemId: "first", delta: "完成" });
  f.child("item.agentMessage.completed", { itemId: "second", text: "第二条回复", revision: 1 });
  const messages = f.children().filter(item => item.kind === "message");
  assert.deepEqual(messages.map(item => [item.id, item.text]), [["first", "检查完成"], ["second", "第二条回复"]]);
});
