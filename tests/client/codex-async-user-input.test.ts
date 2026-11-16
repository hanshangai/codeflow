import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationEventEnvelope, ConversationEventInput, ConversationUserInputRequest } from "@codeflowai/shared";
import { applyEngineEventToConversation, createConversationState, getPendingInteractionItems, isConversationActivelyProcessing } from "@codeflowai/shared";
import { applyCodexAppServerMessage } from "../../apps/desktop/client/src/engines/codex-app-server/codexAppServerMessageMapper.ts";
import { extractAssistantItems } from "../../apps/desktop/client/src/engines/codex-app-server/codexTurnRecovery.ts";
import { TurnTimeoutController } from "../../apps/desktop/client/src/engines/turnTimeoutController.ts";
import { CodexAppServerThreadSession } from "../../apps/desktop/client/src/engines/codex-app-server/codexAppServerThreadSession.ts";
import { initializeLocalEngineModelCatalog } from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";
import { testEngineWorkspaceLog } from "../../apps/desktop/client/tests/engine-workspace-log-fixture.ts";

/** 回放真实异步提问形态，保持开始/完成重复通知与原问题顺序。 */
function replay() {
  const events: ConversationEventInput[] = [];
  const item = { type: "agentMessage", id: "call_async", text: "请选择开源范围", phase: "final_answer", delivery: "async",
    questions: [{ title: "Web 的范围？", options: ["全部开源", "仅桌面"] }, { title: "补充说明", options: null }] };
  const assistant = { text: item.text, revision: 1, completed: false };
  const map = (method: string, value = item) => applyCodexAppServerMessage({
    workspacePath: process.cwd(), workspaceId: "workspace" as any, threadId: "thread", msg: { method, params: { item: value, turnId: "provider-turn" } },
    emit: event => events.push(event), onAssistantDelta() {}, ensureAssistantMessage: () => assistant,
    appendAssistantDelta: () => assistant, applyAssistantSnapshot: () => assistant, completeAssistantMessage: () => assistant,
    getActiveTurn: () => ({ clientTurnId: "turn" as any, codexTurnId: "provider-turn", resolve() {}, reject() {} }),
  });
  map("item/started");
  map("item/completed");
  return { events, map, item };
}

test("异步问题转成结构化补充输入，开始/完成重复不会产生普通最终回答", () => {
  const { events } = replay();
  const requested = events.filter(event => event.type === "userInput.requested");
  assert.ok(requested.length > 0);
  assert.equal(events.some(event => event.type.startsWith("item.agentMessage.")), false);
  const request = requested[0]!.payload.request;
  assert.equal((request.params as any).delivery, "async");
  assert.equal(request.requestId, "call_async");
  assert.equal(request.params.questions[0]!.question, "Web 的范围？");
  assert.deepEqual(request.params.questions[0]!.options?.map(option => option.label), ["全部开源", "仅桌面"]);
  assert.equal(request.params.questions[1]!.options, undefined);
});

test("异步问题在回合结束后仍可回答，重复通知不复活已提交状态", () => {
  const { events } = replay();
  const state = createConversationState("thread" as any);
  let seq = 0;
  const apply = (event: ConversationEventInput) => applyEngineEventToConversation(state, { ...event, schema: 1, seq: ++seq } as ConversationEventEnvelope);
  const base = { ts: 1, engine: "codex" as const, workspaceId: "workspace" as any, threadId: "thread" as any };
  apply({ ...base, type: "turn.started", payload: { turnId: "turn" as any } });
  for (const event of events) apply(event);
  assert.equal(isConversationActivelyProcessing(state), true, "异步提问不暂停正在运行的模型");
  apply({ ...base, type: "turn.completed", payload: { turnId: "turn" as any, result: {} } });
  assert.equal(getPendingInteractionItems(state).length, 1);
  const request = state.items.find(item => item.kind === "userInputRequest") as ConversationUserInputRequest;
  assert.equal(request.state, "pending");
  const answers = { [request.questions[0]!.id]: { answers: ["全部开源"] }, [request.questions[1]!.id]: { answers: ["说明"] } };
  apply({ ...base, type: "userInput.resolved", payload: { response: { requestId: request.requestId, answers } } });
  for (const event of events) apply(event);
  assert.equal(request.state, "submitted");
  assert.equal(getPendingInteractionItems(state).length, 0);
});

test("普通助手消息不因包含问句变成提问；非法异步问题显式失败", () => {
  const { map, item, events } = replay();
  assert.throws(() => map("item/completed", { ...item, questions: [{ title: "", options: [] }] }), /问题|question/iu);
  events.length = 0;
  map("item/completed", { ...item, delivery: undefined } as any);
  assert.deepEqual(events.map(event => event.type), ["item.agentMessage.completed"]);
});

test("终态补偿不能将异步问题重新恢复成普通助手回答", () => {
  const { item } = replay();
  const recovered = extractAssistantItems({ items: [item, { type: "agentMessage", id: "final", text: "等待你的选择", phase: "final_answer" }] });
  assert.deepEqual(recovered.map(message => message.itemId), ["final"]);
});

test("异步问题不暂停引擎空闲计时，同步提问保持等待", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const delivery of ["async", undefined] as const) {
    const timeouts: Error[] = [];
    const controller = new TurnTimeoutController({ workspaceId: "workspace", threadId: "thread", turnId: "turn", engine: "codex",
      policy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 40 }, emitRaw() {}, emitConversation() {},
      onTimeout: error => timeouts.push(error) });
    controller.start();
    controller.onConversationEvent({ ts: Date.now(), workspaceId: "workspace" as any, threadId: "thread" as any, engine: "codex",
      type: "userInput.requested", payload: { request: { requestId: "question", params: { workspaceId: "workspace" as any,
        threadId: "thread" as any, turnId: "turn" as any, itemId: "question" as any, delivery, questions: [] } } } });
    t.mock.timers.tick(80);
    assert.equal(timeouts.length, delivery === "async" ? 1 : 0);
    controller.stop();
  }
});

test("异步提问遵守原生交互权限，拒绝时保留原始事件", async () => {
  initializeLocalEngineModelCatalog();
  for (const policy of ["deny", "interactive-only"] as const) {
    const events: ConversationEventInput[] = [], raw: any[] = [];
    const ws = { async ensureStarted() {}, registerThread() { return () => {}; }, async request(method: string) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") return { turn: { id: "provider-turn" } };
      if (method === "thread/read") return { thread: { id: "provider-thread", turns: [{ id: "provider-turn", items: [item] }] } };
      assert.fail(method);
    } };
    const session = new CodexAppServerThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,
      manager: { getOrCreate: () => ws } as any, workspacePath: "D:/isolated", workspaceId: "workspace" as any,
      threadId: "thread", initialSessionId: "provider-thread" as any, initialSessionCapabilities: null,
      onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {} });
    const pending = session.sendMessage({ turnId: "turn" as any, userItemId: "user" as any, text: "test", images: [],
      assistantItemId: "assistant", reasoningItemId: "reasoning", providerNativeToolPolicy: policy },
      { conversation: event => events.push(event), raw: event => raw.push(event) });
    const settled = pending.then(() => null, error => error);
    for (let attempt = 0; attempt < 50 && (session as any).active?.codexTurnId !== "provider-turn"; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal((session as any).active?.codexTurnId, "provider-turn");
    let interrupts = 0;
    (session as any).startPendingActiveTurnInterrupt = () => { interrupts++; };
    const item = { type: "agentMessage", id: "policy-input", delivery: "async", text: "请选择",
      questions: [{ title: "选择范围", options: ["全部"] }] };
    (session as any).onAppServerMessage({ method: "item/completed", params: { threadId: "provider-thread", turnId: "provider-turn", item } });
    const active = (session as any).active;
    (session as any).onAppServerMessage({ method: "turn/completed", params: { threadId: "provider-thread", turn: { id: "provider-turn", status: "completed" } } });
    await settled;
    if (policy === "deny") {
      await assert.rejects(session.prepareAssistantTerminalEvents({ turnId: "turn" as any, outcome: "completed" }), /禁止/);
    } else {
      const terminal = await session.prepareAssistantTerminalEvents({ turnId: "turn" as any, outcome: "completed" });
      assert.ok(terminal.events.some(event => event.type === "userInput.requested"));
    }
    assert.equal(interrupts, policy === "deny" ? 1 : 0);
    assert.equal(events.some(event => event.type === "userInput.requested"), policy !== "deny");
    if (policy === "deny") assert.match(active.interruptTerminalError.message, /禁止/);
    assert.ok(raw.some(event => event.data?.params?.item?.id === "policy-input"));
  }
});

test("终态快照补回丢失的异步问题，重复补偿不复活已回答状态", async () => {
  const { item } = replay();
  const calls: string[] = [];
  const ws = { async request(method: string) {
    calls.push(method);
    assert.equal(method, "thread/read");
    return { thread: { id: "provider-thread", status: "idle", turns: [
      { id: "other-turn", status: "completed", items: [{ ...item, id: "foreign" }] },
      { id: "provider-turn", status: "completed", items: [item] },
    ] } };
  } };
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,
    manager: { getOrCreate: () => ws } as any, workspacePath: "D:/isolated", workspaceId: "workspace" as any,
    threadId: "thread", initialSessionId: "provider-thread" as any, initialSessionCapabilities: null,
    onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {} });
  (session as any).codexTurnIdByClientTurnId.set("turn", "provider-turn");
  const result = await session.prepareAssistantTerminalEvents({ turnId: "turn" as any, outcome: "completed" });
  assert.equal(result.latestAssistantText, null);
  const requested = result.events.filter(event => event.type === "userInput.requested");
  assert.equal(requested.length, 1);
  assert.equal(requested[0]!.payload.request.requestId, "call_async");
  assert.equal(requested[0]!.payload.request.params.delivery, "async");
  assert.equal(result.events.some(event => event.type.startsWith("item.agentMessage")), false);
  const state = createConversationState("thread" as any);
  let seq = 0;
  const apply = (event: ConversationEventInput) => applyEngineEventToConversation(state, { ...event, schema: 1, seq: ++seq } as ConversationEventEnvelope);
  result.events.forEach(apply);
  const answers = { question_1: { answers: ["全部开源"] }, question_2: { answers: ["说明"] } };
  apply({ ts: 1, workspaceId: "workspace" as any, threadId: "thread" as any, engine: "codex",
    type: "userInput.resolved", payload: { response: { requestId: "call_async", answers } } });
  const repeated = await session.prepareAssistantTerminalEvents({ turnId: "turn" as any, outcome: "completed" });
  repeated.events.forEach(apply);
  assert.equal(state.items.filter(item => item.kind === "userInputRequest").length, 1);
  assert.equal(getPendingInteractionItems(state).length, 0);
  (session as any).currentProviderNativeToolPolicy = "deny";
  await assert.rejects(session.prepareAssistantTerminalEvents({ turnId: "turn" as any, outcome: "completed" }), /禁止/);
  assert.deepEqual(calls, ["thread/read", "thread/read", "thread/read"]);
});
