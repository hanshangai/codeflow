import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveSharedWorkspaceEffectiveOperationPolicy, type ConversationEventEnvelope, type ThreadId, type WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.ts";
import { handleApiRequest, type ApiHandlerContext } from "../src/app/handleApiRequest.ts";
import { handleSharedWorkspaceCommand } from "../src/app/handlers/sharedWorkspaceHandlers.ts";
import { executeHostRpcHttpTask } from "../src/app/executeHostRpcHttpTask.ts";
import { ChatWorkflowService } from "../src/orchestration/chatWorkflowService.ts";
import type { WsSendJsonResult } from "../src/transport/wsTransport.ts";

const workspaceId = "client:messages" as WorkspaceId;
const threadId = "thread-messages" as ThreadId;

/** 每例使用独立临时库，包含运行中的回合及独立引擎历史。 */
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-message-delete-"));
  const dbPath = path.join(directory, "client.db");
  let db = openClientDb({ dbPath });
  db.workspaces.upsert({ id: workspaceId, title: "Messages", path: directory });
  db.threads.create({ id: threadId, workspaceId, title: "Messages", engine: "codex" });
  db.threads.setSessionId(threadId, "native-session" as any);
  db.turns.insertStarted({ threadId, workspaceId, engine: "codex", turnId: "turn-1" as any, startedAt: 1, startEventSeq: 1 });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { get db() { return db; }, directory, reopen() { db.close(); db = openClientDb({ dbPath }); } };
}

/** 构造与真实流式通道相同的正文事件。 */
function event(seq: number, type: ConversationEventEnvelope["type"], payload: unknown): ConversationEventEnvelope {
  return { schema: 1, seq, ts: seq, workspaceId, threadId, engine: "codex", type, payload } as ConversationEventEnvelope;
}

/** 模拟传输层即时接收结果；控制响应的本地截取不属于网络发送。 */
function sendResult(accepted = true): WsSendJsonResult {
  return { accepted, reason: accepted ? null : "not_connected", messageType: "conversation.event", readyState: 1,
    bufferedAmount: 0, bytes: 1, queuedAt: Date.now(), callbackError: null };
}

test("永久删除正文及附件，运行态、其他消息和原始引擎历史保持可用", (t) => {
  const f = fixture(t);
  f.db.conversationEvents.appendEnvelopes([
    event(1, "turn.started", { turnId: "turn-1" }),
    event(2, "item.userMessage.created", { itemId: "user-1", turnId: "turn-1", text: "private text", images: ["data:image/png;base64,AA=="] }),
    event(3, "item.agentMessage.delta", { itemId: "assistant-1", delta: "answer" }),
  ]);
  f.db.turns.setUserMessage("turn-1" as any, { userItemId: "user-1" as any, userText: "private text" });
  f.db.rawEvents.appendEnvelope({ schema: 1, seq: 4, ts: 4, workspaceId, threadId, engine: "codex", source: "test", data: { text: "native history" } } as any);
  f.db.conversationEvents.deleteMessage(threadId, "user-1");
  f.db.conversationEvents.deleteMessage(threadId, "user-1");
  f.reopen();
  assert.deepEqual(f.db.conversationEvents.listDeletedMessageIds(threadId), ["user-1"]);
  assert.equal(JSON.stringify(f.db.conversationEvents.listByThread(threadId)).includes("private text"), false);
  assert.equal(f.db.turns.get("turn-1" as any)?.userText, "private text");
  assert.equal(f.db.turns.get("turn-1" as any)?.status, "started");
  assert.equal(f.db.threads.get(threadId)?.sessionId, "native-session");
  assert.equal(f.db.rawEvents.getLatestSeqByThread(threadId), 4);
  assert.equal(f.db.conversationEvents.listByThread(threadId).some((row) => row.type === "item.agentMessage.delta"), true);
});

test("删除先于 ACK 落库时，迟到正文不恢复聊天记录，原始输入仍供回合执行使用", (t) => {
  const { db } = fixture(t);
  db.conversationEvents.deleteMessage(threadId, "message-1");
  const types = ["item.userMessage.created", "item.userMessage.engineCall.created", "item.agentMessage.started", "item.agentMessage.delta", "item.agentMessage.snapshot", "item.agentMessage.completed"] as const;
  db.conversationEvents.appendEnvelopes(types.map((type, index) => event(index + 2, type, { itemId: "message-1", text: "late", delta: "late", turnId: "turn-1" })));
  db.turns.setUserMessage("turn-1" as any, { userItemId: "message-1" as any, userText: "late" });
  assert.equal(db.conversationEvents.listByThread(threadId).length, 0);
  assert.equal(db.turns.get("turn-1" as any)?.userText, "late");
  db.conversationEvents.appendEnvelope(event(20, "turn.completed", { turnId: "turn-1" }));
  assert.equal(db.conversationEvents.listByThread(threadId).at(-1)?.type, "turn.completed");
});

test("旧版 SQLite 升级补齐删除表，保留原有消息且会话删除时级联清理", (t) => {
  const f = fixture(t);
  f.db.conversationEvents.appendEnvelope(event(2, "item.userMessage.created", { itemId: "user-1", text: "keep" }));
  f.db.db.exec("DROP TABLE conversation_message_deletions; PRAGMA user_version = 87;");
  f.reopen();
  assert.equal(f.db.db.pragma("user_version", { simple: true }), 88);
  assert.equal(f.db.conversationEvents.listByThread(threadId).length, 1);
  f.db.conversationEvents.deleteMessage(threadId, "user-1");
  f.db.db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
  assert.deepEqual(f.db.conversationEvents.listDeletedMessageIds(threadId), []);
});

test("删除按会话隔离；正文清理失败会回滚删除标记，执行输入保持不变", (t) => {
  const { db } = fixture(t);
  const otherThreadId = "other-thread" as ThreadId;
  db.threads.create({ id: otherThreadId, workspaceId, title: "Other", engine: "codex" });
  db.conversationEvents.appendEnvelopes([
    event(2, "item.userMessage.created", { itemId: "same-id", text: "first" }),
    { ...event(3, "item.userMessage.created", { itemId: "same-id", text: "second" }), threadId: otherThreadId },
  ]);
  db.turns.setUserMessage("turn-1" as any, { userItemId: "same-id" as any, userText: "first" });
  db.db.exec("CREATE TEMP TRIGGER reject_message_delete BEFORE DELETE ON conversation_events BEGIN SELECT RAISE(ABORT, 'event delete failed'); END;");
  assert.throws(() => db.conversationEvents.deleteMessage(threadId, "same-id"), /event delete failed/);
  assert.equal(db.conversationEvents.isMessageDeleted(threadId, "same-id"), false);
  assert.equal(db.conversationEvents.listByThread(threadId).length, 1);
  assert.equal(db.turns.get("turn-1" as any)?.userText, "first");
  db.db.exec("DROP TRIGGER reject_message_delete;");
  db.conversationEvents.deleteMessage(threadId, "same-id");
  assert.equal(db.conversationEvents.listByThread(threadId).length, 0);
  assert.equal(db.conversationEvents.listByThread(otherThreadId).length, 1);
  assert.equal(db.conversationEvents.isMessageDeleted(otherThreadId, "same-id"), false);
});

test("运行中删除 API 不获取执行锁，并返回删除通知；工作区越权不产生写入", async (t) => {
  const f = fixture(t);
  const sent: any[] = [];
  const ctx = {
    db: f.db, workspaces: new Map([[workspaceId, f.directory]]), send: (message: unknown) => { sent.push(message); return sendResult(); },
    sessions: { beginThreadOperation() { throw new Error("must not acquire execution lock"); } },
  } as unknown as ApiHandlerContext;
  const request = { t: "api.req" as const, id: "delete-1", method: "threads.messages.delete", path: "/threads/messages/delete", body: { workspaceId, threadId, itemId: "assistant-live" } };
  await handleApiRequest(ctx, request);
  assert.equal(sent.at(-1)?.body.ok, true);
  assert.equal(sent[0]?.event.type, "item.message.deleted");
  assert.equal(f.db.turns.get("turn-1" as any)?.status, "started");
  sent.length = 0;
  await handleApiRequest(ctx, { ...request, body: { ...request.body, workspaceId: "other-workspace", itemId: "other" } });
  assert.notEqual(sent.at(-1)?.status, 200);
  assert.equal(f.db.conversationEvents.isMessageDeleted(threadId, "other"), false);
});

test("持久化失败显式失败，不广播成功删除通知", async (t) => {
  const f = fixture(t);
  const sent: any[] = [];
  f.db.conversationEvents.deleteMessage = () => { throw new Error("disk failure"); };
  await handleApiRequest({ db: f.db, workspaces: new Map([[workspaceId, f.directory]]), send: (message: unknown) => sent.push(message) } as any,
    { t: "api.req", id: "delete-fail", method: "threads.messages.delete", path: "/threads/messages/delete", body: { workspaceId, threadId, itemId: "message-1" } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.ok, false);
  assert.match(sent[0].body.message, /disk failure/);
});

test("删除通知被拒绝时返回明确失败，已持久化的删除事实仍有效", async (t) => {
  const { db, directory } = fixture(t);
  const sent: any[] = [];
  await handleApiRequest({ db, workspaces: new Map([[workspaceId, directory]]), send(message: any) {
    sent.push(message);
    return { accepted: false, reason: "not_connected" };
  } } as any, { t: "api.req", id: "delete-notify-fail", method: "threads.messages.delete", path: "/threads/messages/delete",
    body: { workspaceId, threadId, itemId: "message-1" } });
  assert.equal(db.conversationEvents.isMessageDeleted(threadId, "message-1"), true);
  assert.equal(sent.at(-1)?.body.ok, false);
  assert.match(sent.at(-1)?.body.message, /not_connected/);
});

test("共享 Host 只允许有会话写权限的成员删除，运行中仍可操作", async (t) => {
  const f = fixture(t);
  f.db.threads.setSharedAcl(threadId, { sharedWorkspaceId: "shared-review", ownerUserId: "owner", visibility: "team", participantUserIds: [], updatedAt: Date.now() });
  const messages: any[] = [];
  const policy = resolveSharedWorkspaceEffectiveOperationPolicy("context.thread.message.delete", { threadId });
  assert.ok(policy);
  const envelope = {
    sharedWorkspaceId: "shared-review", localWorkspaceId: workspaceId, hostBindingId: "binding-review",
    actorUserId: "owner", actorRemoteSessionId: "session-review", routeEventId: "route-review", operationId: "delete-owner",
    operationKey: "context.thread.message.delete", policy: { ...policy, upgradedFromOperationId: null },
    authorization: { actorAssetRole: "member", authorizationResult: "allowed", authorizationReason: "", assetType: "unknown", assetId: "", assetAction: "use" },
    lockToken: null, lockVersion: null, payload: { threadId, itemId: "shared-message" }, createdAt: Date.now(),
  } as any;
  const context = { db: f.db, workspaces: new Map([[workspaceId, f.directory]]), send: (message: unknown) => { messages.push(message); return sendResult(); } } as any;
  await handleSharedWorkspaceCommand(context, { ...envelope, actorUserId: "viewer", operationId: "delete-viewer" });
  assert.equal(messages.at(-1)?.message.status, "failed");
  assert.equal(f.db.conversationEvents.isMessageDeleted(threadId, "shared-message"), false);
  await handleSharedWorkspaceCommand(context, envelope);
  assert.equal(messages.at(-1)?.message.status, "succeeded", JSON.stringify(messages.at(-1)));
  assert.equal(f.db.conversationEvents.isMessageDeleted(threadId, "shared-message"), true);
  assert.equal(f.db.turns.get("turn-1" as any)?.status, "started");
});

test("删除运行中的用户消息不改变工作流显式请求判断，重开后仍保留执行意图", (t) => {
  const f = fixture(t);
  const text = "使用工作流修复问题";
  f.db.turns.setUserMessage("turn-1" as any, { userItemId: "user-1" as any, userText: text });
  f.db.conversationEvents.appendEnvelope(event(2, "item.userMessage.created", { itemId: "user-1", turnId: "turn-1", text }));
  const context = { db: f.db, orchAssetLaunchSnapshot: { createFromWorkflowId: () => ({
    workflow: { definition: { id: "workflow-review", name: "Review", nodes: [], edges: [] } },
  }) } } as any;
  const input = { workspaceId, threadId, turnId: "turn-1", actorUserId: "owner", workflowId: "workflow-review",
    title: "Review", goal: "Fix deletion", context: "", rationale: "Review", acceptanceCriteria: ["works"] };
  const service = new ChatWorkflowService(context);
  assert.equal(service.repo.isEnabled(threadId), false);
  const before = service.recommend(input).task.id;
  f.db.conversationEvents.deleteMessage(threadId, "user-1");
  assert.equal(service.recommend(input).task.id, before);
  assert.equal(f.db.conversationEvents.listByThread(threadId).length, 0);
  f.reopen();
  assert.equal(new ChatWorkflowService({ ...context, db: f.db }).recommend(input).task.id, before);
  assert.equal(f.db.turns.get("turn-1" as any)?.status, "started");
  f.db.turns.setUserMessage("turn-1" as any, { userItemId: "user-1" as any, userText: "不要使用工作流" });
  assert.throws(() => new ChatWorkflowService({ ...context, db: f.db }).recommend(input), { code: "CHAT_WORKFLOW_RECOMMENDATION_DISABLED" });
});

test("共享与 HTTP 转发都保留删除通知的成功、拒绝或缺失结果", async (t) => {
  for (const channel of ["shared-ws", "local-http", "shared-http"] as const) {
    for (const outcome of ["accepted", "rejected", "missing"] as const) {
      await t.test(`${channel}: ${outcome}`, async (t) => {
        const { db, directory } = fixture(t);
        db.threads.setSharedAcl(threadId, { sharedWorkspaceId: "shared-review", ownerUserId: "owner", visibility: "team", participantUserIds: [], updatedAt: Date.now() });
        const sent: any[] = [];
        const context = { db, workspaces: new Map([[workspaceId, directory]]), send(message: any) {
          sent.push(message);
          return outcome === "missing" ? undefined : sendResult(outcome === "accepted");
        } } as ApiHandlerContext;
        const policy = resolveSharedWorkspaceEffectiveOperationPolicy("context.thread.message.delete", { threadId })!;
        const envelope = { sharedWorkspaceId: "shared-review", localWorkspaceId: workspaceId, hostBindingId: "binding-review",
          actorUserId: "owner", actorRemoteSessionId: "session-review", routeEventId: "route-review", operationId: "delete-review",
          operationKey: "context.thread.message.delete", policy: { ...policy, upgradedFromOperationId: null },
          authorization: { actorAssetRole: "member", authorizationResult: "allowed", authorizationReason: "", assetType: "unknown", assetId: "", assetAction: "use" },
          lockToken: null, lockVersion: null, payload: { threadId, itemId: "message-review" }, createdAt: Date.now() } as any;
        if (channel === "shared-ws") {
          await handleSharedWorkspaceCommand(context, envelope);
        } else {
          const message = channel === "shared-http" ? { t: "sharedWorkspace.command", envelope } : {
            t: "api.req", id: "delete-http", method: "threads.messages.delete", path: "/threads/messages/delete",
            body: { workspaceId, threadId, itemId: "message-review" },
          };
          const responses = await executeHostRpcHttpTask(context, { operationId: "operation-review", message, queueMs: 0 } as any);
          assert.equal(sent.some((message) => message.t === "api.res" || message.t.startsWith("sharedWorkspace.route.")), false);
          sent.push(...responses);
        }
        assert.equal(sent.filter((message) => message.t === "conversation.event").length, 1);
        const result = sent.at(-1);
        const succeeded = result.t === "api.res" ? result.body.ok : result.message.status === "succeeded";
        assert.equal(succeeded, outcome === "accepted");
        if (outcome !== "accepted") {
          assert.match(result.t === "api.res" ? result.body.message : result.message.error.message, /删除通知发送失败/);
        }
        assert.equal(db.conversationEvents.isMessageDeleted(threadId, "message-review"), true);
        assert.equal(db.turns.get("turn-1" as any)?.status, "started");
      });
    }
  }
});
