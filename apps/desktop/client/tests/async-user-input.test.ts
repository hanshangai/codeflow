import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ClientToServerMessage, ConversationEventInput } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";
import { handleUserInputRespond } from "../src/app/handlers/interactionHandlers.ts";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.ts";

/** 真实 SQLite、提问投影与消息队列；仅隔离 provider 和外部消息传输。 */
function fixture(t: test.TestContext, localPersistence = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "async-input-"));
  let app = openClientDb({ dbPath: path.join(root, "app.db") });
  const workspaceId = "local:workspace" as any, threadId = "thread" as any;
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  app.workspaces.upsert({ id: workspaceId, title: "fixture", path: workspace });
  let db = app.forWorkspace(workspaceId);
  const threads = new ThreadStore();
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "fixture" });
  threads.create({ threadId, workspaceId, engine: "codex", title: "fixture" });
  const sent: ClientToServerMessage[] = []; let seq = 0, kicks = 0;
  const append = (event: ConversationEventInput) => db.conversationEvents.appendEnvelope({ ...event, schema: 1, seq: ++seq } as any);
  const ctx = { db, threads, workspaces: new Map([[workspaceId, workspace]]),
    sessions: { getOrCreate() { throw new Error("异步回答不得调用旧 RPC session"); }, hasActiveTurn: () => false },
    queueDispatcher: { kickIfIdle() { kicks++; } },
    onBeforeEmitConversationEvent() {},
    send(message: ClientToServerMessage) {
      if (localPersistence && message.t === "conversation.event") append(message.event);
      sent.push(message);
    },
  } as unknown as ApiHandlerContext;
  const base = { ts: 1, engine: "codex" as const, workspaceId, threadId };
  append({ ...base, type: "userInput.requested", payload: { request: { requestId: "call_async", params: {
    workspaceId, threadId, turnId: "turn" as any, itemId: "call_async" as any, delivery: "async",
    questions: [{ id: "question_1", header: "范围", question: "是否开源 Web？", options: [{ label: "全部", description: "" }] }],
  } as any } } });
  append({ ...base, type: "turn.completed", payload: { turnId: "turn" as any, result: {} } });
  const answers = { question_1: { answers: ["全部"] } };
  const request = { t: "api.req" as const, id: "respond", method: "userInput.respond", path: "/user-input/respond", body: { workspaceId, threadId, requestId: "call_async", answers } };
  t.after(() => { app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { ctx, get db() { return db; }, sent, request, workspaceId, threadId, kicks: () => kicks,
    /** 模拟独立 Client 重启，只保留磁盘事实，不依赖原内存线程。 */
    reopen() {
      app.close(); app = openClientDb({ dbPath: path.join(root, "app.db") });
      db = app.forWorkspace(workspaceId); ctx.db = db; ctx.threads = new ThreadStore();
    },
  };
}

test("回合结束后回答沿原队列续聊，重复提交只入队一次且保留问题上下文", async t => {
  const f = fixture(t);
  await handleUserInputRespond(f.ctx, f.request);
  const queue = f.db.threadMessageQueue.listActiveByThread(f.threadId);
  assert.equal(queue.length, 1);
  assert.match(queue[0]!.text, /是否开源 Web？/u);
  assert.match(queue[0]!.text, /全部/u);
  assert.equal(f.db.conversationEvents.readPresentation(f.threadId).items.find(item => item.kind === "userInputRequest")?.state, "submitted");
  await handleUserInputRespond(f.ctx, f.request);
  assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 1);
  assert.ok(f.sent.some(message => message.t === "api.res" && message.status === 200));
});

test("问题回答校验失败不入队，不调用 provider，不返回成功", async t => {
  const f = fixture(t);
  await handleUserInputRespond(f.ctx, { ...f.request, body: { ...f.request.body, answers: { invented: { answers: ["答案"] } } } });
  assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 0);
  assert.ok(f.sent.some(message => message.t === "api.res" && message.status === 400));
});

test("异步回答投影、校验和队列快照取得同步许可，屏障失败不继续", async t => {
  const f = fixture(t);
  let permitted = false, flushed = false, reads = 0;
  f.ctx.withDatabase = async (_requestId, operation) => {
    assert.equal(permitted, false); permitted = true;
    try { const value = operation(); assert.equal(Boolean(value && typeof (value as any).then === "function"), false); return value; }
    finally { permitted = false; }
  };
  f.ctx.flushLocalEvents = async () => { assert.equal(permitted, false); flushed = true; };
  const read = f.db.conversationEvents.readPresentation.bind(f.db.conversationEvents);
  f.db.conversationEvents.readPresentation = threadId => { assert.equal(permitted, true); assert.equal(flushed, true); reads++; return read(threadId); };
  await handleUserInputRespond(f.ctx, { ...f.request, body: { ...f.request.body, answers: { invalid: { answers: ["invalid"] } } } });
  assert.ok(reads > 0);
  const before = reads;
  f.ctx.flushLocalEvents = async () => { throw new Error("ASYNC_INPUT_INDEX_BARRIER_FAILED"); };
  await assert.rejects(handleUserInputRespond(f.ctx, f.request), /ASYNC_INPUT_INDEX_BARRIER_FAILED/);
  assert.equal(reads, before);
});

test("已提交问题不能换另一份答案重放", async t => {
  const f = fixture(t);
  await handleUserInputRespond(f.ctx, f.request);
  await handleUserInputRespond(f.ctx, { ...f.request, body: { ...f.request.body, answers: { question_1: { answers: ["另一份"] } } } });
  assert.ok(f.sent.some(message => message.t === "api.res" && message.status === 409));
  assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 1);
});

test("回答事件持久化失败停止派发，保留显式失败且可安全重试", async t => {
  const f = fixture(t);
  const send = f.ctx.send;
  f.ctx.send = message => {
    if (message.t === "conversation.event") throw new Error("persist failed");
    return send(message);
  };
  await assert.rejects(handleUserInputRespond(f.ctx, f.request), /persist failed/u);
  assert.equal(f.kicks(), 0);
  assert.equal(f.sent.some(message => message.t === "api.res" && message.status === 200), false);
  f.ctx.send = send;
  await handleUserInputRespond(f.ctx, f.request);
  assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 1);
  assert.equal(f.db.threadQueueStates.getState(f.threadId).paused, false, "保存恢复后原回答队列应继续派发");
});

test("独立 Client 在回答已发送但事件尚未回流时重试，不重复续聊或允许改答", async t => {
  const f = fixture(t, false);
  await handleUserInputRespond(f.ctx, f.request);
  const original = f.db.threadMessageQueue.listActiveByThread(f.threadId)[0]!;
  f.db.threadMessageQueue.markSent(original.id, "follow_up" as any);
  f.reopen();
  assert.equal(f.db.conversationEvents.readPresentation(f.threadId).items.find(item => item.kind === "userInputRequest")?.state, "pending");
  await handleUserInputRespond(f.ctx, f.request);
  assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 0);
  assert.equal(f.db.threadMessageQueue.getById(original.id)?.status, "sent");
  await handleUserInputRespond(f.ctx, { ...f.request, body: { ...f.request.body, answers: { question_1: { answers: ["改答"] } } } });
  assert.equal(f.sent.at(-1)?.t, "api.res");
  assert.ok(f.sent.some(message => message.t === "api.res" && message.status === 409));
  assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 0);
});

test("并发提交同一个异步回答只保留一项队列", async t => {
  const f = fixture(t, false);
  await Promise.all([handleUserInputRespond(f.ctx, f.request), handleUserInputRespond(f.ctx, { ...f.request, id: "concurrent" })]);
  assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 1);
});

test("回答已入队但通知失败，重试会重新通知并恢复同一项", async t => {
  const f = fixture(t), send = f.ctx.send;
  f.ctx.send = message => {
    if (message.t === "conversation.event") throw new Error("notification failed");
    return send(message);
  };
  await assert.rejects(handleUserInputRespond(f.ctx, f.request), /notification failed/u);
  assert.equal(f.kicks(), 0);
  f.ctx.send = send;
  await handleUserInputRespond(f.ctx, f.request);
  assert.equal(f.db.threadQueueStates.getState(f.threadId).paused, false);
  assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 1);
  assert.equal(f.sent.filter(message => message.t === "conversation.event" && message.event.type === "userInput.resolved").length, 1);
});

test("异步回答通知失败及重试均不能覆盖原有暂停", async t => {
  for (const reason of ["user_pause", "user_stop", "rollback", "session_invalidated"] as const) {
    const f = fixture(t), send = f.ctx.send;
    f.db.threadQueueStates.pause(f.threadId, f.workspaceId, reason);
    f.ctx.send = message => {
      if (message.t === "conversation.event") throw new Error("notification failed");
      return send(message);
    };
    await assert.rejects(handleUserInputRespond(f.ctx, f.request), /notification failed/u);
    assert.equal(f.db.threadQueueStates.getState(f.threadId).pausedReason, reason);
    f.ctx.send = send;
    await handleUserInputRespond(f.ctx, f.request);
    assert.equal(f.db.threadQueueStates.getState(f.threadId).pausedReason, reason);
    assert.equal(f.db.threadQueueStates.getState(f.threadId).paused, true);
    assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 1);
  }
});

test("已取消的异步回答重试显式失败，不恢复暂停或重新入队", async t => {
  for (const localPersistence of [true, false]) {
    const f = fixture(t, localPersistence);
    await handleUserInputRespond(f.ctx, f.request);
    const queued = f.db.threadMessageQueue.listActiveByThread(f.threadId)[0]!;
    f.db.threadMessageQueue.cancelActiveByThread(f.threadId, "user_stop", "cancelled by user");
    f.db.threadQueueStates.pause(f.threadId, f.workspaceId, "user_stop");
    f.sent.length = 0;
    await handleUserInputRespond(f.ctx, f.request);
    assert.ok(f.sent.some(message => message.t === "api.res" && message.status === 409));
    assert.equal(f.db.threadMessageQueue.getById(queued.id)?.status, "cancelled");
    assert.equal(f.db.threadMessageQueue.listActiveByThread(f.threadId).length, 0);
    assert.equal(f.db.threadQueueStates.getState(f.threadId).pausedReason, "user_stop");
  }
});
