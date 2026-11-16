import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import { createPinia, setActivePinia } from "pinia";
import { message } from "ant-design-vue";
import type { ChatWorkflowSnapshot, ChatWorkflowView, ThreadId, WorkspaceId } from "@codeflowai/shared";

import { useChatStore } from "../src/store/chat.ts";
import type { ApiRequestContext } from "../src/api/request.ts";

const originalFetch = globalThis.fetch;
const originalMessageSuccess = message.success;
const originalMessageError = message.error;

function createApiContext(): ApiRequestContext {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "session-demo",
    webSessionId: "web-demo",
    ensureSession: async () => "session-demo",
    clearSession() {},
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const workspaceId = "client-a:ws-natural-intent" as WorkspaceId;
const threadId = "thread-natural-intent" as ThreadId;

/** 待审核视图：status=waiting-approval，唯一待办带 approve 动作。 */
function approvalView(): ChatWorkflowView {
  return {
    task: { id: "task-approval", version: 3, state: "linked" },
    status: "waiting-approval",
    resultVersion: null,
    todos: [{ nodeId: "review", label: "方案审核", version: "node-v1", status: "waiting-approval", summary: "方案已产出", question: "是否通过", actions: [{ action: "approve", label: "审核通过", effect: "推进" }], branches: [] }],
  } as unknown as ChatWorkflowView;
}

function pendingInputView(): ChatWorkflowView {
  const view = approvalView();
  view.status = "waiting-feedback";
  view.todos = [{ ...view.todos[0]!, nodeId: "solution", status: "waiting-feedback", actions: [{ action: "resume_with_input", label: "补充并继续", effect: "继续" }] }];
  return view;
}

/** 建一个已加载的普通 chat 线程；快照按需注入（null 表示无工作流）。 */
function setupStore(snapshot: ChatWorkflowSnapshot | null) {
  setActivePinia(createPinia());
  const store = useChatStore();
  store.upsertThreadSummary({
    id: threadId,
    title: "普通会话",
    engine: "codex",
    threadType: "chat",
    threadSubtype: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  } as never);
  store.loadedThreads[threadId] = true;
  if (snapshot) store.setChatWorkflowSnapshot(threadId, snapshot);
  return store;
}

function sendBody(text: string) {
  return {
    workspaceId, threadId, text, workMode: "general" as const, planMode: false, accessMode: "current" as const,
    model: null, effort: null, contextWindow: null, autoCompactPct: null, images: [], files: [], pathReferences: [],
  };
}

/** 记录请求路径与正文；/natural 响应可定制。/api/threads/send 返回普通成功帧。 */
function installFetch(natural: (body: { text: string }) => unknown) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ path: url.pathname, body });
    if (url.pathname === "/api/orch/chat/natural") return jsonResponse(natural(body as { text: string }));
    if (url.pathname === "/api/threads/send") return jsonResponse({ ok: true, turnId: "turn-natural-intent", dispatchMode: "chat_turn" });
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  return calls;
}

function pathsOf(calls: Array<{ path: string }>): string[] {
  return calls.map(call => call.path);
}

/** 模拟局域网 HTTP 的 Web Crypto：安全随机可用，但不提供 randomUUID。 */
function withoutRandomUuid(t: TestContext): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  const source = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true, value: { getRandomValues: source.getRandomValues.bind(source) },
  });
  t.after(() => Object.defineProperty(globalThis, "crypto", previous));
}

test.afterEach(() => {
  useChatStore().resetForWorkspace();
  globalThis.fetch = originalFetch;
  message.success = originalMessageSuccess;
  message.error = originalMessageError;
});

test("等审核时普通文本被拦下且不落到普通发送", async () => {
  const store = setupStore({ recommendationEnabled: true, tasks: [approvalView()] });
  const calls = installFetch(() => ({ ok: true, handled: false }));
  message.error = (() => {}) as typeof message.error;

  await assert.rejects(store.sendMessage(createApiContext(), sendBody("帮我看看这个方案")), /当前节点等待审核/u);
  assert.deepEqual(pathsOf(calls), []);
});

test("多个待审核待办时普通文本同样被拦下并指向卡片", async () => {
  const view = approvalView();
  view.todos.push({ ...view.todos[0]!, nodeId: "review-2" });
  const store = setupStore({ recommendationEnabled: true, tasks: [view] });
  const calls = installFetch(() => ({ ok: true, handled: false }));
  message.error = (() => {}) as typeof message.error;

  await assert.rejects(store.sendMessage(createApiContext(), sendBody("帮我看看这个方案")), /多个待审核待办/u);
  assert.deepEqual(pathsOf(calls), []);
});

test("前缀式批准带原文到 natural，且不回落到普通发送", async () => {
  const view = approvalView();
  const store = setupStore({ recommendationEnabled: true, tasks: [view] });
  const calls = installFetch(() => ({ ok: true, handled: true, action: "feedback", feedbackAction: "approve", view }));
  message.success = (() => {}) as typeof message.success;

  const result = await store.sendMessage(createApiContext(), sendBody("审核通过：权限验证符合要求。"));
  assert.equal(result, null);
  assert.deepEqual(pathsOf(calls), ["/api/orch/chat/natural"]);
  // 原文照发，剥句号与前缀由服务端解析器负责（会话回执也走 sourceText）。
  assert.equal(calls[0]?.body.text, "审核通过：权限验证符合要求。");
});

test("裸关键词未命中工作流时仍回落普通发送", async () => {
  // 无 approve 待办（此处是 running 且无待办）：兜底不生效，裸关键词解析失败后照常聊天。
  const view = approvalView();
  view.status = "running"; view.todos = [];
  const store = setupStore({ recommendationEnabled: true, tasks: [view] });
  const calls = installFetch(() => ({ ok: true, handled: false }));

  await store.sendMessage(createApiContext(), sendBody("继续"));
  assert.deepEqual(pathsOf(calls), ["/api/orch/chat/natural", "/api/threads/send"]);
});

test("显式前缀被服务端判定未处理时抛错，不静默退回聊天", async () => {
  const store = setupStore({ recommendationEnabled: true, tasks: [] });
  const calls = installFetch(() => ({ ok: true, handled: false }));
  message.error = (() => {}) as typeof message.error;

  await assert.rejects(store.sendMessage(createApiContext(), sendBody("审核通过：权限验证符合要求")), /未提交到工作流待办/u);
  assert.deepEqual(pathsOf(calls), ["/api/orch/chat/natural"]);
});

test("补待办接管时普通文本仍走 natural，不受待审核兜底影响", async () => {
  const view = pendingInputView();
  const store = setupStore({ recommendationEnabled: true, tasks: [view] });
  const calls = installFetch(() => ({ ok: true, handled: true, action: "feedback", feedbackAction: "resume_with_input", view }));
  message.success = (() => {}) as typeof message.success;

  assert.equal(await store.sendMessage(createApiContext(), sendBody("本地测试环境暂不启用扫码登录")), null);
  assert.deepEqual(pathsOf(calls), ["/api/orch/chat/natural"]);
});

for (const scope of [workspaceId, "shared:ws-error-retry" as WorkspaceId]) {
  test(`缺少 randomUUID 时，429 终态后仍能发送继续：${scope}`, async (t) => {
    withoutRandomUuid(t);
    const store = setupStore(null);
    const eventBase = { schema: 1 as const, workspaceId: scope, threadId, engine: "codex" as const };
    store.applyEngineEvent({ ...eventBase, seq: 1, ts: 1, type: "turn.started", payload: { turnId: "turn-429" } });
    store.applyEngineEvent({ ...eventBase, seq: 2, ts: 2, type: "turn.error", payload: {
      turnId: "turn-429", terminationKind: "error", error: "exceeded retry limit, last status: 429 Too Many Requests",
    } });
    assert.equal(store.threadDisplayRunningStateForThread(threadId), null);
    assert.equal(store.ensureConversation(threadId).invalidated, false);
    const calls = installFetch(() => ({ ok: true, handled: false }));

    assert.equal(await store.sendMessage(createApiContext(), { ...sendBody("继续"), workspaceId: scope }), "turn-natural-intent");
    assert.deepEqual(pathsOf(calls), ["/api/orch/chat/natural", "/api/threads/send"]);
    assert.ok(calls.every(call => call.body.workspaceId === scope));
    assert.match(String(calls[0]?.body.requestId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.equal(calls[1]?.body.text, "继续");
    assert.equal(store.threadDisplayRunningStateForThread(threadId)?.runningTurnId, "turn-natural-intent");
  });
}

test("缺少 randomUUID 时可提交工作流补充，服务端拒绝后仍能重试", async (t) => {
  withoutRandomUuid(t);
  const view = pendingInputView();
  const store = setupStore({ recommendationEnabled: true, tasks: [view] });
  let attempts = 0;
  const calls = installFetch(() => ++attempts === 1
    ? { ok: false, code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试" }
    : { ok: true, handled: true, action: "feedback", feedbackAction: "resume_with_input", view });
  t.mock.method(message, "success", () => undefined);

  await assert.rejects(store.sendMessage(createApiContext(), sendBody("补充说明")), /请求过于频繁/u);
  assert.equal(store.threadDisplayRunningStateForThread(threadId), null);
  assert.equal(await store.sendMessage(createApiContext(), sendBody("补充说明")), null);
  assert.deepEqual(pathsOf(calls), ["/api/orch/chat/natural", "/api/orch/chat/natural"]);
  assert.notEqual(calls[0]?.body.requestId, calls[1]?.body.requestId);
});
