import assert from "node:assert/strict";
import test from "node:test";
import { applyEngineEventToConversation, createConversationState, getPendingUserInputItems } from "@codeflowai/shared";
import type { ConversationEventEnvelope, ConversationUserInputRequest } from "@codeflowai/shared";

/** 回放同一会话中 provider 重启后从 0 重新编号的真实交互形态。 */
function fixture() {
  const state = createConversationState("thread" as any);
  let seq = 0;
  const apply = (type: string, payload: unknown) => applyEngineEventToConversation(state, {
    schema: 1, seq: ++seq, ts: seq, workspaceId: "workspace", threadId: "thread", engine: "codex", type, payload,
  } as ConversationEventEnvelope);
  const request = (itemId: string, questionId: string | string[]) => apply("userInput.requested", { request: { requestId: 0,
    params: { workspaceId: "workspace", threadId: "thread", turnId: "turn", itemId,
      questions: (Array.isArray(questionId) ? questionId : [questionId]).map(id => ({ id, header: "范围", question: "选择范围" })) } } });
  const resolve = (questionId: string, answer: string) => apply("userInput.resolved", {
    response: { requestId: 0, answers: { [questionId]: { answers: [answer] } } },
  });
  const item = (id: string) => state.items.find(value => value.id === id) as ConversationUserInputRequest;
  apply("turn.started", { turnId: "turn" });
  return { state, apply, request, resolve, item };
}

for (const sameQuestionId of [false, true]) test(`编号复用后回答最新问题，保留旧答案：相同问题ID=${sameQuestionId}`, () => {
  const f = fixture(), nextQuestionId = sameQuestionId ? "scope" : "modal_scope";
  f.request("old", "scope"); f.resolve("scope", "旧回答");
  f.request("current", nextQuestionId); f.resolve(nextQuestionId, "新回答");
  assert.equal(f.item("current").state, "submitted");
  assert.deepEqual(f.item("current").submittedAnswers, { [nextQuestionId]: { answers: ["新回答"] } });
  assert.deepEqual(f.item("old").submittedAnswers, { scope: { answers: ["旧回答"] } });
  assert.equal(getPendingUserInputItems(f.state).length, 0);
});

test("编号复用时迟到旧答案不关闭当前不同问题，重复事件不会复活填写入口", () => {
  const f = fixture();
  f.request("old", "scope"); f.resolve("scope", "旧回答"); f.request("current", "modal_scope");
  f.resolve("scope", "旧回答");
  assert.equal(f.item("current").state, "pending");
  f.resolve("modal_scope", "新回答"); f.request("current", "modal_scope");
  assert.equal(f.item("current").state, "submitted");
  assert.deepEqual(f.item("old").submittedAnswers, { scope: { answers: ["旧回答"] } });
});

test("编号复用后失效事件关闭最新请求，保留已提交的旧问题", () => {
  const f = fixture();
  f.request("old", "scope"); f.resolve("scope", "旧回答"); f.request("current", "modal_scope");
  f.apply("userInput.expired", { requestId: 0 });
  assert.equal(f.item("old").state, "submitted");
  assert.equal(f.item("current").state, "expired");
});

test("迟到旧回答的问题集合是新问题子集时，不得把新问题标为已提交", () => {
  const f = fixture();
  f.request("old", "scope"); f.resolve("scope", "旧答案");
  f.request("current", ["scope", "target"]);
  f.resolve("scope", "旧答案");
  assert.equal(f.item("current").state, "pending");
  assert.equal(f.item("current").submittedAnswers, undefined);
  assert.equal(getPendingUserInputItems(f.state).length, 1);
  f.apply("userInput.resolved", { response: { requestId: 0, answers: { scope: { answers: ["新范围"] }, target: { answers: ["新目标"] } } } });
  assert.equal(f.item("current").state, "submitted");
  assert.deepEqual(f.item("old").submittedAnswers, { scope: { answers: ["旧答案"] } });
});

test("没有编号冲突时仍接纳旧协议的部分回答，不新增完整性限制", () => {
  const f = fixture();
  f.request("only", ["scope", "target"]);
  f.resolve("scope", "已确认范围");
  assert.equal(f.item("only").state, "submitted");
  assert.deepEqual(f.item("only").submittedAnswers, { scope: { answers: ["已确认范围"] } });
});
