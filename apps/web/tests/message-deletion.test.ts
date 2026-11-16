import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import type { EngineEventEnvelope } from "@codeflowai/shared";
import { useChatStore } from "../src/store/chat.ts";
import type { ApiRequestContext } from "../src/api/request.ts";

const workspaceId = "client:messages" as any;
const threadId = "thread-messages" as any;
const originalFetch = globalThis.fetch;
const ctx: ApiRequestContext = { serverWsOrigin: "ws://localhost:39280", sessionToken: "test-session", webSessionId: "web-test", ensureSession: async () => "test-session", clearSession() {} };
test.afterEach(() => { globalThis.fetch = originalFetch; });

/** 构造消息事件，允许以不同顺序模拟实时输出和重连回放。 */
function event(seq: number, type: EngineEventEnvelope["type"], payload: unknown): EngineEventEnvelope {
  return { schema: 1, seq, ts: seq, threadId, workspaceId, engine: "codex", type, payload } as EngineEventEnvelope;
}

/** 模拟 Client 的权威历史页，包括与分页独立的删除列表。 */
function history(events: EngineEventEnvelope[], deletedMessageIds: string[] = [], hasMore = false) {
  return { ok: true, thread: { id: threadId, workspaceId, engine: "codex", title: "Messages", threadType: "chat", threadSubtype: null, sessionId: "native-session", createdAt: 1, updatedAt: 1 },
    managedServices: null, running: null, events, deletedMessageIds, hasMore, oldestSeq: events[0]?.seq ?? null, latestSeq: events.at(-1)?.seq ?? null, rawEventCount: events.length };
}

/** 构造 JSON 回包，不经过真实服务器或用户账号。 */
function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

test("实时删除运行中的消息后，增量、快照和完成事件均不能复活；回合仍正常结束", () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  store.applyEngineEvent(event(1, "turn.started", { turnId: "turn-1" }));
  store.applyEngineEvent(event(2, "item.agentMessage.delta", { itemId: "answer-1", delta: "first" }));
  store.applyEngineEvent(event(3, "item.message.deleted", { itemId: "answer-1" }));
  assert.equal(store.conversations[threadId].runningTurnId, "turn-1");
  for (const type of ["item.agentMessage.delta", "item.agentMessage.snapshot", "item.agentMessage.completed"] as const) {
    store.applyEngineEvent(event(4, type, { itemId: "answer-1", delta: "late", text: "late", revision: 1 }));
  }
  store.applyEngineEvent(event(5, "item.agentMessage.delta", { itemId: "answer-2", delta: "new answer" }));
  assert.deepEqual(store.conversations[threadId].items.map((item) => item.id), ["answer-2"]);
  assert.equal(store.threadReplayEventsByThreadId[threadId].some((row) => row.type === "item.agentMessage.delta" && row.payload.itemId === "answer-1"), false);
  store.applyEngineEvent(event(6, "turn.completed", { turnId: "turn-1" }));
  assert.equal(store.conversations[threadId].runningTurnId, null);
});

test("删除 API 成功后立即移除消息；失败保留原记录", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  store.applyEngineEvent(event(1, "item.userMessage.created", { itemId: "user-1", turnId: "turn-1", text: "user text" }));
  globalThis.fetch = async () => response({ ok: false, code: "CLIENT_ERROR", message: "delete failed" });
  await assert.rejects(store.deleteThreadMessage(ctx, { workspaceId, threadId, itemId: "user-1" }), /delete failed/);
  assert.equal(store.conversations[threadId].items.length, 1);
  globalThis.fetch = async () => response({ ok: true, itemId: "user-1" });
  await store.deleteThreadMessage(ctx, { workspaceId, threadId, itemId: "user-1" });
  assert.equal(store.conversations[threadId].items.length, 0);
});

test("刷新及分页中包含旧消息缓存时，权威删除列表仍阻止正文恢复", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  store.applyEngineEvent(event(3, "item.userMessage.created", { itemId: "user-1", turnId: "turn-1", text: "cached secret" }));
  const newer = event(10, "turn.completed", { turnId: "turn-1" });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return response(body.beforeSeq
      ? history([event(2, "item.userMessage.created", { itemId: "user-1", text: "stale page" })], ["user-1"])
      : history([newer], ["user-1"], true));
  };
  await store.loadThread(ctx, { workspaceId, threadId });
  await store.loadThreadPage(ctx, { workspaceId, threadId });
  assert.equal(store.conversations[threadId].items.some((item) => item.id === "user-1"), false);
  const fresh = useChatStore(createPinia());
  await fresh.loadThread(ctx, { workspaceId, threadId });
  fresh.applyEngineEvent(event(20, "item.userMessage.created", { itemId: "user-1", text: "late WS backfill" }));
  assert.equal(fresh.conversations[threadId].items.some((item) => item.id === "user-1"), false);
});

test("历史请求在途时收到删除通知，旧响应不能覆盖删除事实", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  let resolveFetch!: (value: Response) => void;
  globalThis.fetch = () => new Promise<Response>((resolve) => { resolveFetch = resolve; });
  const pending = store.loadThread(ctx, { workspaceId, threadId });
  while (!resolveFetch) await new Promise((resolve) => setImmediate(resolve));
  store.applyEngineEvent(event(20, "item.message.deleted", { itemId: "user-1" }));
  resolveFetch(response(history([event(2, "item.userMessage.created", { itemId: "user-1", text: "old request" })])));
  await pending;
  assert.equal(store.conversations[threadId].items.some((item) => item.id === "user-1"), false);
});

test("空历史页仍同步删除清单，并清理已显示正文与回放缓存", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  globalThis.fetch = async () => response(history([
    event(5, "item.userMessage.created", { itemId: "user-1", text: "cached" }),
  ], [], true));
  await store.loadThread(ctx, { workspaceId, threadId });
  assert.equal(store.conversations[threadId].items.length, 1);
  globalThis.fetch = async () => response(history([], ["user-1"]));
  await store.loadThreadPage(ctx, { workspaceId, threadId });
  assert.equal(store.conversations[threadId].items.length, 0);
  assert.equal(store.threadReplayEventsByThreadId[threadId].length, 0);
  assert.equal(store.threadLoadMetaByThreadId[threadId].hasMore, false);
});

test("发送请求晚于消息删除返回时，不会重新插入同轮临时消息", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  store.ensureConversation(threadId);
  let resolveFetch!: (value: Response) => void;
  globalThis.fetch = () => new Promise<Response>((resolve) => { resolveFetch = resolve; });
  const pending = store.sendMessage(ctx, { workspaceId, threadId, text: "delete before send response", images: [] });
  while (!resolveFetch) await new Promise((resolve) => setImmediate(resolve));
  store.applyEngineEvent(event(2, "item.userMessage.created", { itemId: "user-1", turnId: "turn-1", text: "delete before send response" }));
  store.applyEngineEvent(event(3, "item.message.deleted", { itemId: "user-1" }));
  resolveFetch(response({ ok: true, dispatchMode: "chat_turn", turnId: "turn-1" }));
  try {
    await pending;
    assert.equal(store.conversations[threadId].items.length, 0);
    assert.equal(store.pendingLocalUserMessageByThreadId[threadId], undefined);
  } finally {
    store.cancelAcceptedTurnContentReconcile({ workspaceId, threadId });
  }
});

test("删除通知先于正式正文时，迟到正文会同时清理同轮临时消息", () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const pending = event(1, "item.userMessage.created", { itemId: "local_user_turn-1", turnId: "turn-1", text: "pending" });
  store.pendingLocalUserMessageByThreadId[threadId] = pending;
  store.applyEngineEvent(pending);
  store.applyEngineEvent(event(3, "item.message.deleted", { itemId: "user-1" }));
  store.applyEngineEvent(event(2, "item.userMessage.created", { itemId: "user-1", turnId: "turn-1", text: "pending" }));
  assert.equal(store.conversations[threadId].items.length, 0);
  assert.equal(store.pendingLocalUserMessageByThreadId[threadId], undefined);
});

test("删除通知超出补发窗口后，重连会重新读取删除事实并保留运行中其他消息", async () => {
  for (const selectedWorkspaceId of [workspaceId, "shared:messages"] as const) {
    setActivePinia(createPinia());
    const store = useChatStore();
    const events = [event(1, "turn.started", { turnId: "turn-1" }),
      event(2, "item.userMessage.created", { itemId: "user-1", turnId: "turn-1", text: "cached" }),
      event(3, "item.agentMessage.delta", { itemId: "answer-1", turnId: "turn-1", delta: "still running" })];
    const running = { runningTurnId: "turn-1", runningTurnStartedAt: 1 };
    globalThis.fetch = async () => response({ ...history(events), running });
    await store.loadThread(ctx, { workspaceId: selectedWorkspaceId, threadId });
    store.selectedThreadId = threadId;
    assert.equal(store.loadedThreads[threadId], true);
    store.markWorkspaceSubscribed();
    assert.equal(store.loadedThreads[threadId], undefined);
    assert.equal(store.conversations[threadId].items.length, 2, "校验前保留已展示内容");
    assert.equal(store.conversations[threadId].runningTurnId, "turn-1");
    const requests: string[] = [];
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return response({ ...history(events.filter((event) => event.seq !== 2), ["user-1"]), running });
    };
    await store.ensureThreadHydrated(ctx, { workspaceId: selectedWorkspaceId, threadId });
    assert.equal(requests.filter((url) => url.endsWith("/api/threads/load")).length, 1);
    assert.deepEqual(store.conversations[threadId].items.map((item) => item.id), ["answer-1"]);
    assert.equal(store.conversations[threadId].runningTurnId, "turn-1");
    store.applyEngineEvent(event(10, "item.userMessage.created", { itemId: "user-1", turnId: "turn-1", text: "late" }));
    assert.deepEqual(store.conversations[threadId].items.map((item) => item.id), ["answer-1"]);
  }
});

test("重连后未选中的缓存会话在再次打开时校验删除清单，失败保留重试资格", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const otherThreadId = "other-thread" as any;
  store.ensureConversation(otherThreadId);
  store.loadedThreads[otherThreadId] = true;
  store.selectedThreadId = otherThreadId;
  const events = [event(1, "item.agentMessage.completed", { itemId: "answer-1", text: "cached", revision: 1 })];
  globalThis.fetch = async () => response(history(events));
  await store.loadThread(ctx, { workspaceId, threadId });
  store.markWorkspaceSubscribed();
  assert.equal(store.loadedThreads[otherThreadId], undefined);
  assert.equal(store.loadedThreads[threadId], undefined);
  globalThis.fetch = async () => response({ ok: false, message: "history unavailable" });
  await assert.rejects(store.ensureThreadHydrated(ctx, { workspaceId, threadId }), /history unavailable/);
  assert.equal(store.loadedThreads[threadId], undefined);
  assert.equal(store.conversations[threadId].items.length, 1);
  globalThis.fetch = async () => response(history([], ["answer-1"]));
  await store.ensureThreadHydrated(ctx, { workspaceId, threadId });
  assert.equal(store.loadedThreads[threadId], true);
  assert.equal(store.conversations[threadId].items.length, 0);
});

test("重订阅取消旧历史请求，旧响应不能覆盖新删除清单", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  let resolveOldFetch!: (value: Response) => void;
  globalThis.fetch = () => new Promise<Response>((resolve) => { resolveOldFetch = resolve; });
  const oldLoad = store.loadThread(ctx, { workspaceId, threadId });
  while (!resolveOldFetch) await new Promise((resolve) => setImmediate(resolve));
  store.markWorkspaceSubscribed();
  globalThis.fetch = async () => response(history([], ["user-1"]));
  await store.ensureThreadHydrated(ctx, { workspaceId, threadId });
  resolveOldFetch(response(history([event(1, "item.userMessage.created", { itemId: "user-1", text: "stale" })])));
  await oldLoad;
  assert.equal(store.conversations[threadId].items.length, 0);
  assert.equal(store.loadedThreads[threadId], true);
});
