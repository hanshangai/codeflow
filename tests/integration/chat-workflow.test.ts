import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { ChatWorkflowService, chatWorkflowHash, assertChatWorkflowDirectoryAvailable } from "../../apps/desktop/client/src/orchestration/chatWorkflowService.ts";
import { createDefaultRoleExecutionConfig, resolveChatWorkflowNaturalAction, buildSharedWorkspaceHostRpcPayload, resolveSharedWorkspaceEffectiveOperationPolicy, type ChatWorkflowSnapshot, type ChatWorkflowActionInput, type OrchestrationAssetRuntimeSnapshot, type SharedWorkspaceHostRpcMethod } from "../../packages/shared/src/index.ts";
import type { ApiHandlerContext } from "../../apps/desktop/client/src/app/handleApiRequest.ts";
import { reserveChatWorkflowDirectory } from "../../apps/desktop/client/src/orchestration/workspaceExecutionGuard.ts";
import { handleSharedWorkspaceCommand } from "../../apps/desktop/client/src/app/handlers/sharedWorkspaceHandlers.ts";
import { logger } from "../../apps/desktop/client/src/logger.ts";
import { handleChatWorkflowRequest } from "../../apps/desktop/client/src/app/handlers/chatWorkflowHandlers.ts";
import { ThreadQueueDispatcher } from "../../apps/desktop/client/src/queue/threadQueueDispatcher.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";
import { setTimeout as delay } from "node:timers/promises";
import { applyEngineModelCatalogSnapshot, resetEngineModelCatalogRuntimeForTest } from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "../../packages/shared/src/engineModelCatalogSeed.ts";
import { ENGINE_MODEL_CATALOG_SCHEMA_VERSION } from "../../packages/shared/src/index.ts";

type Harness = ReturnType<typeof harness>;

function prepareAction(h: Harness, requestId = "start"): ChatWorkflowActionInput {
  const rec = h.recommend();
  const prepared = h.service.prepareStart(h.workspaceId, h.threadId, rec.task.id, rec.task.version, "owner");
  return { workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: prepared.task.version, requestId, action: "start" };
}

/** 断言调用抛出指定业务错误码与状态码：只匹配 message 无法锁住对外契约。 */
function assertWorkflowError(fn: () => unknown, code: string, status: number): void {
  try { fn(); } catch (error) {
    assert.equal((error as { code?: string }).code, code);
    assert.equal((error as { status?: number }).status, status);
    return;
  }
  assert.fail(`预期抛出 ${code}`);
}

function persistInterruptedStart(h: Harness, input: ChatWorkflowActionInput) {
  const task = h.service.repo.get(input.taskId)!;
  h.service.repo.update({ ...task, state: "starting", instanceId: null }, task.version);
  h.db.db.prepare("INSERT OR REPLACE INTO chat_workflow_actions (request_id, task_id, actor_user_id, input_hash, state, created_at, updated_at) VALUES (?, ?, 'owner', ?, 'processing', 1, 1)")
    .run(input.requestId, task.id, chatWorkflowHash({ ...input, actorUserId: "owner" }));
}

async function sharedChatRequest(h: Harness, method: SharedWorkspaceHostRpcMethod, actorUserId: string, body: Record<string, unknown> = {}) {
  const messages: any[] = [];
  const ctx = { ...h.ctx, sessions: { ...h.ctx.sessions, beginThreadOperation: () => () => {} }, send: (message: unknown) => messages.push(message) } as unknown as ApiHandlerContext;
  const payload = buildSharedWorkspaceHostRpcPayload({ method, path: "/orch/chat/test", body: { threadId: h.threadId, actorUserId, ...body }, action: method.split(".").pop() } as any);
  const policy = resolveSharedWorkspaceEffectiveOperationPolicy("orch.workflow.use", payload)!;
  await handleSharedWorkspaceCommand(ctx, {
    sharedWorkspaceId: "sw-test", actorUserId, actorRemoteSessionId: "session-test", hostBindingId: "binding-test",
    localWorkspaceId: h.workspaceId, routeEventId: "route-test", operationId: `test-${method}`, operationKey: "orch.workflow.use",
    policy: { ...policy, upgradedFromOperationId: null }, lockToken: "test-lock", lockVersion: 1,
    authorization: { actorAssetRole: "member", authorizationResult: "allowed", authorizationReason: "", assetType: "workflow", assetId: "", assetAction: "use" },
    payload, createdAt: Date.now(),
  } as any);
  return messages.find(message => message.t === "sharedWorkspace.route.result")?.message;
}

/** 大多数用例先创建推荐，夹具显式启用；禁用场景自行覆盖原会话设置。 */
function harness(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-test-"));
  const rootDb = openClientDb({ dbPath: path.join(directory, "test.db") });
  t.after(() => { rootDb.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "ws-test" as any;
  const threadId = "chat-test" as any;
  rootDb.workspaces.upsert({ id: workspaceId, title: "test", path: directory });
  // 会话事实按生产路径落在工作区库，共享路由 scoped 后可见。
  const db = rootDb.forWorkspace(workspaceId);
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "test" });
  const asset: OrchestrationAssetRuntimeSnapshot = {
    authorityMode: "legacy",
    workflow: { assetId: "workflow-test", assetType: "workflow", source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 }, definition: {
      id: "workflow-test" as any, workspaceId, name: "测试工作流", description: "测试", family: "feature-dev", version: 1,
      nodes: [{ id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } }, { id: "dev", type: "role", roleId: "role-test" as any, label: "开发", position: { x: 0, y: 50 } }, { id: "end", type: "end", label: "结束", position: { x: 0, y: 100 } }],
      edges: [{ id: "edge", sourceNodeId: "start", targetNodeId: "dev", dataMappings: [] }, { id: "edge-end", sourceNodeId: "dev", targetNodeId: "end", dataMappings: [] }],
    } } as any,
    roles: {}, knowledgeBundles: {}, toolsets: {}, skills: {},
  };
  asset.roles["role-test"] = { assetId: "role-test", assetType: "role", source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 }, definition: {
    id: "role-test", workspaceId, name: "开发", description: "开发", responsibility: "实现需求", systemPrompt: "实现需求",
    inputDefinition: { instructions: "{{requirement}}", requiredFields: [] },
    outputDefinition: { instructions: "结果", deliveryMode: "direct", format: "markdown", requiredFields: [] },
    gateCriteria: [], executionConfig: createDefaultRoleExecutionConfig("codex"), defaultKnowledgeBundleIds: [], toolRefs: [], kind: "custom",
  } } as any;
  const sent: unknown[] = [];
  const kicks: string[] = [];
  // 生产上下文按工作区换取 scoped orchEngine，mock 保留同一实例以复用测试内动态替换的方法。
  const orchEngine: any = { start: async () => {} };
  orchEngine.forWorkspace = () => orchEngine;
  const ctx = { db, workspaces: new Map([[workspaceId, directory]]), sessions: { hasActiveTurn: () => false },
    queueDispatcher: { kickIfIdle: (id: string) => kicks.push(id) },
    orchAssetLaunchSnapshot: { createFromWorkflowId: () => asset, createFromWorkflow: () => asset },
    // 生产端由该钩子把 turn.started 落库，发送分支依赖 turns.get(turnId) 判断回合仍在进行。
    onBeforeEmitConversationEvent: (event: any) => {
      if (event?.type === "turn.started" && event.payload?.turnId) {
        db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, engine: event.engine,
          turnId: event.payload.turnId, startedAt: event.ts, startEventSeq: null });
      }
    },
    orchEngine, send: (message: unknown) => sent.push(message),
  } as unknown as ApiHandlerContext;
  const service = new ChatWorkflowService(ctx);
  service.repo.setEnabled(threadId, true);
  const recommend = (turnId = "turn-1") => service.recommend({ workspaceId, threadId, turnId, actorUserId: "owner", workflowId: "workflow-test", title: "导出订单", goal: "导出管理员可访问的订单", context: "来源：用户消息", rationale: "包含权限与验证", acceptanceCriteria: ["非管理员无法导出"] });
  return { db, ctx, service, asset, workspaceId, threadId, recommend, directory, sent, kicks };
}

test("choosing ordinary chat durably queues the task and wakes the source conversation once", async t => {
  const h = harness(t);
  const rec = h.recommend();
  const input: ChatWorkflowActionInput = { workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: rec.task.version, requestId: "dismiss-once", action: "dismiss" };
  const result = await h.service.action(input, "owner");
  assert.equal(result.task.state, "dismissed");
  const items = h.db.threadMessageQueue.listActiveByThread(h.threadId);
  assert.equal(items.length, 1, "dismiss must create a real continuation, not just a notice");
  assert.match(items[0]!.text, /本次不用工作流/);
  assert.ok(items[0]!.text.includes(rec.task.goal));
  assert.ok(items[0]!.text.includes(rec.task.acceptanceCriteria[0]!));
  assert.equal(items[0]!.sendOptions.forceNewTurn, true);
  assert.deepEqual(h.kicks, [h.threadId]);
  assert.equal(h.db.orchInstances.listByWorkspace(h.workspaceId).length, 0);
  await h.service.action(input, "owner");
  assert.equal(h.db.threadMessageQueue.listActiveByThread(h.threadId).length, 1);
  h.db.threadMessageQueue.markSent(items[0]!.id, "continuation-turn" as any);
  await h.service.action(input, "owner");
  assert.equal((h.db.db.prepare("SELECT count(*) n FROM thread_message_queue WHERE thread_id = ?").get(h.threadId) as any)?.n, 1);
});

test("queue persistence failure rolls back the dismissal and receipt so the same request can retry", async t => {
  const h = harness(t);
  const rec = h.recommend();
  const input: ChatWorkflowActionInput = { workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: rec.task.version, requestId: "retry-dismiss", action: "dismiss" };
  const fail = t.mock.method(h.service.repo, "update", () => { throw new Error("disk write failed"); });
  await assert.rejects(h.service.action(input, "owner"), /disk write failed/);
  assert.equal(h.service.repo.get(rec.task.id)?.state, "recommended");
  assert.equal(h.db.threadMessageQueue.listActiveByThread(h.threadId).length, 0);
  assert.equal(h.db.db.prepare("SELECT 1 FROM chat_workflow_actions WHERE request_id = ?").get(input.requestId), undefined);
  assert.equal(h.kicks.length, 0);
  fail.mock.restore();
  await h.service.action(input, "owner");
  assert.equal(h.db.threadMessageQueue.listActiveByThread(h.threadId).length, 1);
});

test("wake failure preserves one durable continuation and an explicit retry only wakes it", async t => {
  const h = harness(t);
  const rec = h.recommend();
  const input: ChatWorkflowActionInput = { workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: rec.task.version, requestId: "wake-dismiss", action: "dismiss" };
  const fail = t.mock.method(h.ctx.queueDispatcher!, "kickIfIdle", () => { throw new Error("wake failed"); });
  await assert.rejects(h.service.action(input, "owner"), /已保存会话续跑任务/);
  assert.equal(h.service.repo.get(rec.task.id)?.state, "dismissed");
  assert.equal(h.db.threadMessageQueue.listActiveByThread(h.threadId).length, 1);
  fail.mock.restore();
  await h.service.action(input, "owner");
  assert.equal(h.db.threadMessageQueue.listActiveByThread(h.threadId).length, 1);
  assert.deepEqual(h.kicks, [h.threadId]);
});

test("removing a continuation from the queue does not revive it on replay or show a false retry", async t => {
  const h = harness(t);
  const rec = h.recommend();
  const input: ChatWorkflowActionInput = { workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: rec.task.version, requestId: "removed-dismiss", action: "dismiss" };
  const result = await h.service.action(input, "owner");
  h.db.threadMessageQueue.remove(h.threadId, result.task.continuationQueueItemId!);
  const replay = await h.service.action(input, "owner");
  assert.equal(replay.continuation?.status, "cancelled");
  assert.equal(h.db.threadMessageQueue.listActiveByThread(h.threadId).length, 0);
});

test("deleting an unstarted recommendation removes the card and its action receipts", t => {
  const h = harness(t);
  const rec = h.recommend();
  // 回执只有在这张卡上提交过操作才会存在；不连带清理会让同 requestId 的重试命中过期快照。
  h.db.db.prepare("INSERT INTO chat_workflow_actions (request_id, task_id, actor_user_id, input_hash, state, created_at, updated_at) VALUES ('rec-receipt', ?, 'owner', 'hash', 'processing', 1, 1)").run(rec.task.id);

  const removed = h.service.remove(h.workspaceId, h.threadId, rec.task.id, rec.task.version, "owner");

  assert.deepEqual(removed, { taskId: rec.task.id, cancelledContinuationQueueItemId: null, deletedIntakeId: null });
  assert.deepEqual(h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks, []);
  assert.equal((h.db.db.prepare("SELECT count(1) AS n FROM chat_workflow_actions WHERE task_id = ?").get(rec.task.id) as any).n, 0);
});

test("deleting a dismissed card cancels its pending continuation and broadcasts the queue change", async t => {
  const h = harness(t);
  const rec = h.recommend();
  const dismissed = await h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: rec.task.version, requestId: "dismiss-delete", action: "dismiss" }, "owner");
  const queueItemId = dismissed.task.continuationQueueItemId!;
  assert.equal(h.db.threadMessageQueue.getById(queueItemId)?.status, "pending");
  h.sent.length = 0;

  const removed = h.service.remove(h.workspaceId, h.threadId, rec.task.id, dismissed.task.version, "owner");

  assert.equal(removed.cancelledContinuationQueueItemId, queueItemId);
  assert.equal(h.db.threadMessageQueue.getById(queueItemId), null);
  assert.equal(h.db.threadMessageQueue.listActiveByThread(h.threadId).length, 0);
  // 不广播时队列面板仍会显示这条已被取消的待发消息。
  assert.deepEqual((h.sent as any[]).filter(message => message.t === "thread.queue.changed").map(message => message.reason), ["removed"]);
});

test("deletion rejects non-initiators, stale versions and in-flight continuations without changing anything", async t => {
  const h = harness(t);
  const rec = h.recommend();
  const dismissed = await h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: rec.task.version, requestId: "dismiss-reject", action: "dismiss" }, "owner");
  const queueItemId = dismissed.task.continuationQueueItemId!;

  assertWorkflowError(() => h.service.remove(h.workspaceId, h.threadId, rec.task.id, dismissed.task.version, "other"), "CHAT_WORKFLOW_INITIATOR_REQUIRED", 403);
  assertWorkflowError(() => h.service.remove(h.workspaceId, h.threadId, rec.task.id, dismissed.task.version - 1, "owner"), "CHAT_WORKFLOW_VERSION_CONFLICT", 409);
  // 续跑消息正在发送时拒绝删除，避免「卡片已删但消息仍发出」的错位。
  h.db.threadMessageQueue.claimNextPending(h.threadId);
  assertWorkflowError(() => h.service.remove(h.workspaceId, h.threadId, rec.task.id, dismissed.task.version, "owner"), "CHAT_WORKFLOW_DELETE_CONTINUATION_SENDING", 409);
  assert.equal(h.service.repo.get(rec.task.id)?.id, rec.task.id);
  assert.equal(h.db.threadMessageQueue.getById(queueItemId)?.status, "sending");

  // 已发出的续跑项不属于取消范围：允许删卡、保留队列项。
  h.db.threadMessageQueue.markSent(queueItemId, null);
  const removed = h.service.remove(h.workspaceId, h.threadId, rec.task.id, dismissed.task.version, "owner");
  assert.equal(removed.taskId, rec.task.id);
  assert.equal(removed.cancelledContinuationQueueItemId, null);
  assert.equal(h.db.threadMessageQueue.getById(queueItemId)?.status, "sent");
});

test("started or in-flight cards must be terminated before the card itself can be deleted", async t => {
  const h = harness(t);
  const pendingStart = h.service.action(prepareAction(h), "owner");
  const interim = h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks[0]!;
  assert.equal(interim.task.state, "starting");
  assertWorkflowError(() => h.service.remove(h.workspaceId, h.threadId, interim.task.id, interim.task.version, "owner"), "CHAT_WORKFLOW_DELETE_STARTING", 409);

  const started = await pendingStart;
  assert.ok(started.task.instanceId);
  assertWorkflowError(() => h.service.remove(h.workspaceId, h.threadId, started.task.id, started.task.version, "owner"), "CHAT_WORKFLOW_DELETE_INSTANCE_BOUND", 409);
  assert.equal(h.db.orchInstances.listByWorkspace(h.workspaceId).length, 1);
  assert.ok(h.service.repo.get(started.task.id));
});

test("a superseded card can only be deleted with its current version", t => {
  const h = harness(t);
  const first = h.recommend();
  const second = h.recommend("turn-2");
  const superseded = h.service.repo.get(first.task.id)!;
  assert.equal(superseded.state, "superseded");
  assert.equal(superseded.instanceId, null, "被替代的卡片仍无实例，只有版本检查能拦住过期请求");
  assertWorkflowError(() => h.service.remove(h.workspaceId, h.threadId, first.task.id, first.task.version, "owner"), "CHAT_WORKFLOW_VERSION_CONFLICT", 409);

  assert.equal(h.service.remove(h.workspaceId, h.threadId, first.task.id, superseded.version, "owner").taskId, first.task.id);
  assert.deepEqual(h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks.map(view => view.task.id), [second.task.id]);
});

test("deleting a prepared card removes its own intake and proposal and leaves sibling cards untouched", t => {
  const h = harness(t);
  const rec = h.recommend();
  const prepared = h.service.prepareStart(h.workspaceId, h.threadId, rec.task.id, rec.task.version, "owner");
  assert.ok(prepared.task.intakeId && prepared.task.proposalId);
  // 兄弟卡片会把这张卡的 state 刷成 superseded 并递增版本，删除必须用最新版本。
  const sibling = h.recommend("turn-2");
  const current = h.service.repo.get(prepared.task.id)!;
  const countRows = (table: string) => Number((h.db.db.prepare(`SELECT count(1) AS n FROM ${table}`).get() as any)?.n);
  assert.equal(countRows("orch_intakes"), 1);
  assert.equal(countRows("orch_proposals"), 1);

  const removed = h.service.remove(h.workspaceId, h.threadId, prepared.task.id, current.version, "owner");

  assert.equal(removed.deletedIntakeId, prepared.task.intakeId);
  assert.equal(h.service.repo.get(prepared.task.id), null);
  assert.equal(countRows("orch_intakes"), 0);
  assert.equal(countRows("orch_proposals"), 0);
  assert.deepEqual(h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks.map(view => view.task.id), [sibling.task.id]);
});

test("a card whose intake is still referenced by a dirty sibling refuses deletion and rolls back", t => {
  const h = harness(t);
  const rec = h.recommend();
  const prepared = h.service.prepareStart(h.workspaceId, h.threadId, rec.task.id, rec.task.version, "owner");
  // 一卡一需求由 prepareStart 保证；这里直接落一行脏数据，验证守卫显式暴露而不是留下无主需求。
  h.db.db.prepare(`INSERT INTO chat_workflow_tasks (id, workspace_id, thread_id, source_turn_id, instance_id, state, version, task_json, created_at, updated_at)
    VALUES ('dirty-card', ?, ?, 'turn-1', NULL, 'recommended', 1, ?, 1, 1)`)
    .run(h.workspaceId, h.threadId, JSON.stringify({ ...prepared.task, id: "dirty-card", proposalId: null }));

  assertWorkflowError(() => h.service.remove(h.workspaceId, h.threadId, prepared.task.id, prepared.task.version, "owner"), "CHAT_WORKFLOW_INTAKE_REFERENCED", 409);
  assert.ok(h.service.repo.get(prepared.task.id), "整体回滚后卡片仍在");
  assert.equal((h.db.db.prepare("SELECT count(1) AS n FROM orch_intakes").get() as any).n, 1);
});

test("a parallel deletion of the same card is rejected by the operation lock", t => {
  const h = harness(t);
  const rec = h.recommend();
  // 用删除路径自身重入模拟并发：持锁期间第二次调用必须被拒，且不得改动卡片。
  t.mock.method(h.service.repo, "deleteTask", () => {
    h.service.remove(h.workspaceId, h.threadId, rec.task.id, rec.task.version, "owner");
    return false;
  });
  assertWorkflowError(() => h.service.remove(h.workspaceId, h.threadId, rec.task.id, rec.task.version, "owner"), "CHAT_WORKFLOW_ACTION_BUSY", 409);
  assert.equal(h.service.repo.get(rec.task.id)?.id, rec.task.id);
});

test("a deleted recommendation leaves no dismissed list behind for the same goal", async t => {
  const h = harness(t);
  const rec = h.recommend();
  const dismissed = await h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: rec.task.version, requestId: "dismiss-then-delete", action: "dismiss" }, "owner");
  assertWorkflowError(() => h.recommend("turn-2"), "CHAT_WORKFLOW_RECOMMENDATION_DISMISSED", 409);

  h.service.remove(h.workspaceId, h.threadId, rec.task.id, dismissed.task.version, "owner");

  assert.equal(h.recommend("turn-2").task.state, "recommended");
});

test("the delete request returns the removed task id and refuses a missing expected version", async t => {
  const h = harness(t);
  const logs: Array<{ message: string; data?: any }> = [];
  t.mock.method(logger, "info", (_tag: string, message: string, data?: unknown) => { logs.push({ message, data }); });
  const rec = h.recommend();
  await handleChatWorkflowRequest(h.ctx, { t: "api.req", id: "delete-request", method: "orch.chat.delete", path: "/orch/chat/delete", body: {
    workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: rec.task.version, actorUserId: "owner", requestId: "web-side-request",
  } });
  const response = (h.sent as any[]).find(message => message.t === "api.res");
  assert.equal(response?.body.ok, true);
  assert.deepEqual(response?.body.removed, { taskId: rec.task.id });
  assert.equal(h.service.repo.get(rec.task.id), null);
  // 排障边界：网页侧 requestId 与 RPC 信封 id 分属两个 id，必须都落日志才能把两边串起来。
  const deletion = logs.find(entry => entry.message === "chat workflow card deleted")?.data;
  assert.equal(deletion?.code, "CHAT_WORKFLOW_CARD_DELETED");
  assert.equal(deletion?.callerRequestId, "web-side-request");
  assert.equal(deletion?.taskId, rec.task.id);
  assert.equal(deletion?.actorUserId, "owner");

  // 缺 expectedVersion 时 Number(undefined) 为 NaN，一律 409，不得退化成「删掉当前版本」。
  const again = h.recommend("turn-2");
  await handleChatWorkflowRequest(h.ctx, { t: "api.req", id: "delete-without-version", method: "orch.chat.delete", path: "/orch/chat/delete", body: {
    workspaceId: h.workspaceId, threadId: h.threadId, taskId: again.task.id, actorUserId: "owner",
  } });
  const failed = (h.sent as any[]).filter(message => message.t === "api.res").at(-1);
  assert.equal(failed?.status, 409);
  assert.equal(failed?.body.code, "CHAT_WORKFLOW_VERSION_CONFLICT");
  assert.ok(h.service.repo.get(again.task.id));
});

test("old dismissed cards can explicitly continue without auto-running on snapshot", async t => {
  const h = harness(t);
  const rec = h.recommend();
  const old = h.service.repo.update({ ...rec.task, state: "dismissed" }, rec.task.version);
  h.service.snapshot(h.workspaceId, h.threadId, "owner");
  assert.equal(h.db.threadMessageQueue.listActiveByThread(h.threadId).length, 0);
  await h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: old.id, expectedVersion: old.version, requestId: "repair-old-dismiss", action: "dismiss" }, "owner");
  assert.equal(h.db.threadMessageQueue.listActiveByThread(h.threadId).length, 1);
});

test("natural refusal uses the same durable continuation and preserves manual queue pauses", async t => {
  const h = harness(t);
  h.recommend();
  h.db.threadQueueStates.pause(h.threadId, h.workspaceId, "user_pause");
  const action = resolveChatWorkflowNaturalAction("本次直接在会话处理", h.service.snapshot(h.workspaceId, h.threadId, "owner"))!;
  await handleChatWorkflowRequest(h.ctx, { t: "api.req", id: "natural-request", method: "orch.chat.action", path: "/orch/chat/action", body: {
    ...action, workspaceId: h.workspaceId, threadId: h.threadId, requestId: "natural-once", actorUserId: "owner",
  } });
  const response = (h.sent as any[]).find(m => m.t === "api.res");
  assert.equal(response?.body.ok, true);
  assert.equal(response?.body.view.continuation.paused, true);
  assert.equal(response?.body.view.continuation.status, "pending");
  assert.equal(h.db.threadQueueStates.getState(h.threadId).pausedReason, "user_pause");
});

test("shared refusal retains authenticated actor and shared write context when queued", async t => {
  const h = harness(t);
  const rec = h.recommend();
  h.db.threads.setSharedAcl(h.threadId, { sharedWorkspaceId: "sw-test" as any, ownerUserId: "owner", visibility: "participants", participantUserIds: [], updatedAt: 1 });
  const action = { taskId: rec.task.id, expectedVersion: rec.task.version, requestId: "shared-dismiss", action: "dismiss", actorUserId: "forged" };
  const denied = await sharedChatRequest(h, "orch.chat.action", "unrelated", action);
  assert.equal(denied?.status, "failed");
  assert.equal(h.db.threadMessageQueue.listActiveByThread(h.threadId).length, 0);
  const accepted = await sharedChatRequest(h, "orch.chat.action", "owner", action);
  assert.equal(accepted?.status, "succeeded", JSON.stringify(accepted));
  const item = h.db.threadMessageQueue.listActiveByThread(h.threadId)[0]!;
  assert.equal(h.db.threadMessageQueue.getSharedWorkspaceToolContext(item.id)?.toolPolicyKey, "ai.shared.write");
  assert.deepEqual(h.db.threadMessageQueue.getExecutionProfileContext(item.id), { userId: "owner", scope: { scopeType: "shared_workspace", scopeId: "sw-test" } });
  assert.equal((item.sendOptions as any).__executionProfileContext, undefined);
});

test("dismissal reaches the normal provider send after an active turn ends", async t => {
  applyEngineModelCatalogSnapshot({ schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 1, capturedAt: 0, rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1] });
  t.after(() => resetEngineModelCatalogRuntimeForTest());
  const h = harness(t);
  const rec = h.recommend();
  const providerInputs: any[] = [];
  let active = true;
  // 模拟正常 provider 的发送与助手对账，覆盖完整成功收尾入口。
  const session = { engine: "codex", resolvePlatformToolTransport: () => "native-dynamic", async sendMessage(input: any) {
    providerInputs.push(input);
    return { responseText: "处理完成" };
  }, async prepareAssistantTerminalEvents() {
    return { events: [], latestAssistantText: "处理完成" };
  } };
  h.ctx.threads = new ThreadStore();
  h.ctx.sessions = { hasActiveTurn: () => active, canAppendInput: () => false, beginThreadOperation: () => () => {}, getOrCreate: () => session } as any;
  h.ctx.orchEngine.buildManagedServiceToolRegistry = () => null;
  h.db.db.prepare("UPDATE threads SET access_mode = 'full-access', plan_mode = 0 WHERE id = ?").run(h.threadId);
  const dispatcher = new ThreadQueueDispatcher(h.ctx);
  h.ctx.queueDispatcher = dispatcher;
  const result = await h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: rec.task.version, requestId: "provider-dismiss", action: "dismiss" }, "owner");
  assert.equal(providerInputs.length, 0);
  assert.equal(result.continuation?.status, "pending");
  active = false;
  dispatcher.kickIfIdle(h.threadId);
  for (let i = 0; i < 50 && !providerInputs.length; i++) await delay(10);
  assert.equal(providerInputs.length, 1, JSON.stringify({ events: h.sent, queue: h.db.threadMessageQueue.getById(result.task.continuationQueueItemId!) }));
  assert.equal(providerInputs[0].accessMode, "full-access");
  assert.equal(providerInputs[0].planMode, false);
  assert.match(providerInputs[0].userMessage, /本次不用工作流/);
  assert.match(providerInputs[0].developerMessage, /dismissed/);
  const listed = await providerInputs[0].executeHostTool({ toolId: "runtime.chatWorkflow", toolInput: { action: "list" }, accessMode: "full-access" });
  assert.equal(listed.output.tasks[0].canAccept, true, "queued provider tools must retain the authenticated actor");
  // Wait for the dispatcher's ACK/finalization and its one deferred empty-queue kick.
  await delay(100);
  const sentItem = h.db.threadMessageQueue.getById(result.task.continuationQueueItemId!);
  assert.equal(sentItem?.status, "sent");
  // 此夹具只收集事件；队列 ACK 之外还须产出对应回合的唯一成功终态。
  assert.ok(sentItem?.sentTurnId);
  const terminalEvents = (h.sent as any[]).filter(m => m.event?.type === "turn.completed" || m.event?.type === "turn.error").map(m => m.event);
  assert.deepEqual(terminalEvents.map(event => event.type), ["turn.completed"]);
  assert.equal(terminalEvents[0].payload.turnId, sentItem.sentTurnId);
  assert.equal((h.sent as any[]).filter(m => m.event?.type === "item.userMessage.created").length, 1);
});

test("recommendations are durable, do not start instances, and supersede prior proposals", t => {
  const h = harness(t);
  const first = h.recommend();
  assert.equal(h.db.orchInstances.listByWorkspace(h.workspaceId).length, 0);
  assert.equal(h.recommend().task.id, first.task.id);
  const second = h.recommend("turn-2");
  assert.equal(h.service.repo.get(first.task.id)?.state, "superseded");
  assert.equal(new ChatWorkflowService(h.ctx).snapshot(h.workspaceId, h.threadId, "owner").tasks[0]?.task.id, second.task.id);
  h.service.repo.setEnabled(h.threadId, false);
  assert.equal(new ChatWorkflowService(h.ctx).repo.isEnabled(h.threadId), false);
  assert.equal(h.service.repo.isEnabled("another-chat"), false);
});

test("start preparation checks identity, ownership, and asset revision", t => {
  const h = harness(t);
  const view = h.recommend();
  assert.throws(() => h.service.prepareStart(h.workspaceId, h.threadId, view.task.id, 1, "other"), /发起人/);
  assert.throws(() => h.service.requireTask("other-ws", h.threadId, view.task.id), /工作区/);
  h.asset.workflow.definition.version = 2;
  assert.throws(() => h.service.prepareStart(h.workspaceId, h.threadId, view.task.id, 1, "owner"), /配置已变更/);
});

test("confirmed start is idempotent and source-thread deletion is blocked", async t => {
  const h = harness(t);
  const recommended = h.recommend();
  const prepared = h.service.prepareStart(h.workspaceId, h.threadId, recommended.task.id, 1, "owner");
  const action = { workspaceId: h.workspaceId, threadId: h.threadId, taskId: prepared.task.id, expectedVersion: prepared.task.version, requestId: "start-once", action: "start" as const };
  const result = await h.service.action(action, "owner");
  assert.ok(result.task.instanceId);
  const replay = await h.service.action(action, "owner");
  assert.equal(replay.task.instanceId, result.task.instanceId);
  assert.equal(h.db.orchInstances.listByWorkspace(h.workspaceId).length, 1);
  assert.equal(h.db.threads.getCleanupBusinessBlockedReasons([h.threadId]).get(h.threadId), "active_orchestration");
  assert.throws(() => h.recommend("second-task"), /已有进行中/);
});

test("result acceptance requires current version and original initiator", async t => {
  const h = harness(t);
  const rec = h.recommend();
  const prepared = h.service.prepareStart(h.workspaceId, h.threadId, rec.task.id, rec.task.version, "owner");
  const started = await h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: prepared.task.version, requestId: "start", action: "start" }, "owner");
  h.db.db.prepare("UPDATE orch_instances SET status = 'completed' WHERE id = ?").run(started.task.instanceId);
  const view = h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks[0]!;
  const input = { workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: view.task.version, requestId: "accept", action: "accept" as const, resultVersion: view.resultVersion! };
  await assert.rejects(h.service.action(input, "other"), /发起人/);
  await assert.rejects(h.service.action({ ...input, resultVersion: "old" }, "owner"), /结果版本/);
  const accepted = await h.service.action(input, "owner");
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.task.acceptedBy, "owner");
});

test("natural decisions do not approve ambiguous or multiple pending items", t => {
  const h = harness(t);
  const view = h.recommend();
  let snapshot: ChatWorkflowSnapshot = { recommendationEnabled: true, tasks: [view] };
  assert.equal(resolveChatWorkflowNaturalAction("可以", snapshot), null);
  assert.equal(resolveChatWorkflowNaturalAction("确认启动工作流", snapshot)?.action, "start");
  view.task.state = "linked"; view.status = "waiting-approval";
  view.todos = [{ nodeId: "review", label: "审核", version: "v1", status: "waiting-approval", summary: "结果", question: "是否通过", actions: [{ action: "approve", label: "通过", effect: "推进" }], branches: [] }];
  assert.equal(resolveChatWorkflowNaturalAction("审核通过", snapshot)?.nodeVersion, "v1");
  view.todos.push({ ...view.todos[0]!, nodeId: "review-2" });
  assert.equal(resolveChatWorkflowNaturalAction("审核通过", snapshot), null);
});

test("prefixed approval carries the note while a bare keyword never becomes review feedback", t => {
  const h = harness(t);
  const view = h.recommend();
  view.task.state = "linked"; view.status = "waiting-approval";
  view.todos = [{ nodeId: "review", label: "审核", version: "v1", status: "waiting-approval", summary: "结果", question: "是否通过", actions: [{ action: "approve", label: "通过", effect: "推进" }], branches: [] }];
  const snapshot: ChatWorkflowSnapshot = { recommendationEnabled: true, tasks: [view] };
  const expected = { taskId: view.task.id, expectedVersion: view.task.version, action: "feedback", nodeId: "review", nodeVersion: "v1", feedbackAction: "approve" };
  // 尾句号随 normalized 一起剥掉，冒号后原文作为本次审批意见下传。
  assert.deepEqual(resolveChatWorkflowNaturalAction("审核通过：权限验证符合要求。", snapshot), { ...expected, feedback: "权限验证符合要求" });
  for (const alias of ["同意：权限验证符合要求", "同意方案：权限验证符合要求", "通过审核:权限验证符合要求"]) {
    assert.deepEqual(resolveChatWorkflowNaturalAction(alias, snapshot), { ...expected, feedback: "权限验证符合要求" });
  }
  // 空意见必须省略 feedback 键：引擎按「有意见才注入下游」判空，多一个 undefined 键会让断言与请求体都失真。
  assert.equal(resolveChatWorkflowNaturalAction("审核通过：", snapshot)?.feedback, undefined);
  // 裸关键词只批准、不携带附言：旧实现把关键词原文当意见注入下游节点 prompt。
  assert.equal(resolveChatWorkflowNaturalAction("同意", snapshot)?.feedback, undefined);

  view.todos.push({ ...view.todos[0]!, nodeId: "review-2" });
  assert.equal(resolveChatWorkflowNaturalAction("审核通过：权限验证符合要求", snapshot), null);
  view.todos = [view.todos[0]!];
  // 存在「已完成未验收」任务时前缀批准必须放弃：那条待验收文案与节点审批无法在会话框区分（H3）。
  const completed = structuredClone(view);
  completed.status = "completed"; completed.accepted = false;
  assert.equal(resolveChatWorkflowNaturalAction("审核通过：权限验证符合要求", { recommendationEnabled: true, tasks: [completed, view] }), null);
});

test("a unique waiting-input todo accepts the full conversation text while ambiguous todos do not", t => {
  const h = harness(t);
  const view = h.recommend();
  view.task.state = "linked";
  view.status = "waiting-feedback";
  view.todos = [{ nodeId: "solution", label: "方案设计", version: "node-v1", status: "waiting-feedback", summary: "方案待确认", question: "请补充决策", actions: [{ action: "resume_with_input", label: "补充并继续", effect: "继续" }], branches: [] }];
  let snapshot: ChatWorkflowSnapshot = { recommendationEnabled: true, tasks: [view] };
  const text = "生产回调域使用 codeflowai.cn；本地测试环境暂不启用扫码登录。";
  assert.deepEqual(resolveChatWorkflowNaturalAction(text, snapshot), {
    taskId: view.task.id, expectedVersion: view.task.version, action: "feedback", nodeId: "solution",
    nodeVersion: "node-v1", feedbackAction: "resume_with_input", feedback: text,
  });
  view.todos.push({ ...view.todos[0]!, nodeId: "security", version: "node-v2" });
  assert.equal(resolveChatWorkflowNaturalAction(text, snapshot), null);
  snapshot = { recommendationEnabled: true, tasks: [{ ...view, todos: [] }] };
  assert.equal(resolveChatWorkflowNaturalAction(text, snapshot), null);
});

test("successful feedback no longer leaves a notice in the conversation", async t => {
  const h = harness(t);
  const view = h.recommend();
  const opinion = "回调域名使用生产地址，扫码登录仅在本地测试环境关闭。";
  const persistedEvents: unknown[] = [];
  (h.ctx as any).onBeforeEmitConversationEvent = (event: unknown) => persistedEvents.push(event);
  t.mock.method(ChatWorkflowService.prototype, "action", async () => view);
  const base = {
    workspaceId: h.workspaceId, threadId: h.threadId, actorUserId: "owner", taskId: view.task.id,
    expectedVersion: view.task.version, action: "feedback", nodeId: "solution", nodeVersion: "node-v1",
  };

  // 输入框自然语言提交与工作流面板按钮提交都不应再产生会话事件。
  await handleChatWorkflowRequest(h.ctx, {
    t: "api.req", id: "feedback-notice", method: "orch.chat.action", path: "/orch/chat/action",
    body: { ...base, requestId: "feedback-notice-action", feedbackAction: "resume_with_input", feedback: opinion },
  });
  await handleChatWorkflowRequest(h.ctx, {
    t: "api.req", id: "feedback-panel", method: "orch.chat.action", path: "/orch/chat/action",
    body: { ...base, requestId: "feedback-panel-action", feedbackAction: "approve", feedback: opinion },
  });

  assert.equal((h.sent as any[]).some(message => message.t === "conversation.event"), false);
  assert.equal(persistedEvents.length, 0);
  assert.equal((h.sent as any[]).filter(message => message.t === "api.res").every(message => message.body.ok), true);
});

test("failed feedback does not emit a success notice", async t => {
  const h = harness(t);
  const view = h.recommend();
  t.mock.method(ChatWorkflowService.prototype, "action", async () => { throw new Error("feedback failed"); });

  await handleChatWorkflowRequest(h.ctx, {
    t: "api.req", id: "feedback-failed", method: "orch.chat.action", path: "/orch/chat/action",
    body: {
      workspaceId: h.workspaceId, threadId: h.threadId, actorUserId: "owner", taskId: view.task.id,
      expectedVersion: view.task.version, requestId: "feedback-failed-action", action: "feedback",
    },
  });

  assert.equal((h.sent as any[]).some(message => message.t === "conversation.event"), false);
  assert.equal((h.sent as any[]).find(message => message.t === "api.res")?.body.ok, false);
});

test("workspace aliases may run alongside an active workflow while unknown workspaces remain rejected", async t => {
  const h = harness(t);
  const rec = h.recommend();
  const prepared = h.service.prepareStart(h.workspaceId, h.threadId, rec.task.id, 1, "owner");
  await h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: prepared.task.version, requestId: "start", action: "start" }, "owner");
  h.ctx.workspaces.set("alias" as any, h.directory);
  assert.doesNotThrow(() => assertChatWorkflowDirectoryAvailable(h.ctx, "alias"));
  assert.throws(() => assertChatWorkflowDirectoryAvailable(h.ctx, "missing"), /工作区目录不可用/);
});

test("disabled and dismissed recommendations cannot silently recur", async t => {
  const h = harness(t);
  h.service.repo.setEnabled(h.threadId, false);
  assert.throws(() => h.recommend(), /已关闭主动推荐/);
  h.service.repo.setEnabled(h.threadId, true);
  const view = h.recommend();
  await h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: view.task.id, expectedVersion: view.task.version, requestId: "dismiss", action: "dismiss" }, "owner");
  assert.throws(() => h.recommend("turn-2"), /已拒绝/);
});

test("late recommendations from an older turn are rejected", t => {
  const h = harness(t);
  h.db.turns.insertStarted({ workspaceId: h.workspaceId, threadId: h.threadId, engine: "codex", turnId: "turn-new" as any, startedAt: 100, startEventSeq: null });
  assert.throws(() => h.recommend("turn-old"), /已发送新的消息/);
  assert.equal(h.service.repo.list(h.threadId).length, 0);
});

test("ordinary chat reservations permit concurrent workflow starts", t => {
  const h = harness(t);
  const release = reserveChatWorkflowDirectory(h.ctx, h.workspaceId, "thread-a", false);
  const releaseSecond = reserveChatWorkflowDirectory(h.ctx, h.workspaceId, "thread-b", false);
  const releaseRead = reserveChatWorkflowDirectory(h.ctx, h.workspaceId, "thread-c", true);
  assert.doesNotThrow(() => assertChatWorkflowDirectoryAvailable(h.ctx, h.workspaceId));
  release();
  assert.doesNotThrow(() => assertChatWorkflowDirectoryAvailable(h.ctx, h.workspaceId));
  releaseSecond();
  assert.doesNotThrow(() => assertChatWorkflowDirectoryAvailable(h.ctx, h.workspaceId));
  releaseRead();
});

test("persisted active ordinary turns do not force another chat into read-only", t => {
  const h = harness(t);
  h.db.turns.insertStarted({ workspaceId: h.workspaceId, threadId: h.threadId, engine: "codex", turnId: "turn-running" as any, startedAt: 100, startEventSeq: null });
  h.ctx.sessions.hasActiveTurn = () => true;
  const release = reserveChatWorkflowDirectory(h.ctx, h.workspaceId, "another-chat", false);
  assert.doesNotThrow(() => assertChatWorkflowDirectoryAvailable(h.ctx, h.workspaceId));
  release();
});

test("ordinary chat writes remain available alongside workflows including draining paused nodes", async t => {
  const h = harness(t);
  const started = await h.service.action(prepareAction(h), "owner");
  const instance = h.db.orchInstances.get(started.task.instanceId as any)!;
  reserveChatWorkflowDirectory(h.ctx, h.workspaceId, "other-chat", false)();
  const releaseRead = reserveChatWorkflowDirectory(h.ctx, h.workspaceId, "discussion", true);
  releaseRead();
  h.db.threads.create({ id: "node-thread" as any, workspaceId: h.workspaceId, engine: "codex", title: "开发节点", threadType: "orchestration" });
  instance.nodeStates.dev = { nodeId: "dev", status: "running", retryCount: 0, threadId: "node-thread" as any };
  h.db.db.prepare("UPDATE orch_instances SET status = 'paused', node_states_json = ? WHERE id = ?").run(JSON.stringify(instance.nodeStates), instance.id);
  h.db.turns.insertStarted({ workspaceId: h.workspaceId, threadId: "node-thread" as any, engine: "codex", turnId: "node-turn" as any, startedAt: 100, startEventSeq: null });
  h.ctx.sessions.hasActiveTurn = () => true;
  reserveChatWorkflowDirectory(h.ctx, h.workspaceId, "other-chat", false)();
  h.ctx.sessions.hasActiveTurn = () => false;
  reserveChatWorkflowDirectory(h.ctx, h.workspaceId, "other-chat", false)();
});

test("stale node decisions fail before changing an instance", async t => {
  const h = harness(t);
  const rec = h.recommend();
  const prepared = h.service.prepareStart(h.workspaceId, h.threadId, rec.task.id, 1, "owner");
  const started = await h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: prepared.task.version, requestId: "start", action: "start" }, "owner");
  const instance = h.db.orchInstances.get(started.task.instanceId as any)!;
  instance.nodeStates.dev = { nodeId: "dev", status: "waiting-approval", retryCount: 0, output: "待审核结果" };
  h.db.db.prepare("UPDATE orch_instances SET status = 'waiting-approval', node_states_json = ? WHERE id = ?").run(JSON.stringify(instance.nodeStates), instance.id);
  const view = h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks[0]!;
  assert.equal(view.todos.length, 1);
  instance.nodeStates.dev.output = "已修订结果";
  h.db.db.prepare("UPDATE orch_instances SET node_states_json = ? WHERE id = ?").run(JSON.stringify(instance.nodeStates), instance.id);
  await assert.rejects(h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: view.task.version, requestId: "old-approve", action: "feedback", nodeId: "dev", nodeVersion: view.todos[0]!.version, feedbackAction: "approve" }, "owner"), /待办已处理或结果发生变化/);
});

test("rework plan is read-only until confirmed and expires when results change", async t => {
  const h = harness(t);
  const rec = h.recommend();
  const prepared = h.service.prepareStart(h.workspaceId, h.threadId, rec.task.id, 1, "owner");
  const started = await h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: prepared.task.version, requestId: "start", action: "start" }, "owner");
  const before = h.db.orchInstances.get(started.task.instanceId as any)!;
  const planned = h.service.planRework(h.workspaceId, h.threadId, rec.task.id, "dev", "增加导出时间", "owner");
  assert.deepEqual(planned.task.rework?.affectedNodeIds, ["dev", "end"]);
  assert.deepEqual(h.db.orchInstances.get(before.id), before);
  h.db.db.prepare("UPDATE orch_instances SET status = 'completed' WHERE id = ?").run(before.id);
  await assert.rejects(h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: rec.task.id, expectedVersion: planned.task.version, requestId: "rework", action: "confirm_rework", resultVersion: planned.resultVersion! }, "owner"), /执行结果已变化/);
});

test("artifact changes invalidate the old approval while an unrelated branch stays actionable", async t => {
  const h = harness(t);
  const started = await h.service.action(prepareAction(h), "owner");
  const instance = h.db.orchInstances.get(started.task.instanceId as any)!;
  const artifact = h.db.orchArtifacts.create({ instanceId: instance.id, nodeId: "dev", kind: "document", version: 1, title: "result", status: "draft", contentJson: "v1", contentHash: "hash-v1" } as any);
  instance.nodeStates.dev = { nodeId: "dev", status: "waiting-approval", retryCount: 0, output: "see artifact" };
  h.db.db.prepare("UPDATE orch_instances SET status = 'waiting-approval', node_states_json = ?, artifact_index_json = ? WHERE id = ?")
    .run(JSON.stringify(instance.nodeStates), JSON.stringify({ dev: [artifact.id] }), instance.id);
  const before = h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks[0]!;
  // 无关产物不应使当前待办失效。
  h.db.orchArtifacts.create({ ...artifact, nodeId: "other", contentHash: "other" });
  assert.equal(h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks[0]!.todos[0]!.version, before.todos[0]!.version);
  h.db.orchArtifacts.updateWorkspace(artifact.id, { contentHash: "hash-v2", manifest: { summary: "updated result" } as any });
  const after = h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks[0]!;
  assert.notEqual(before.resultVersion, after.resultVersion);
  let submissions = 0;
  h.ctx.orchEngine.submitFeedback = async () => { submissions++; };
  const input: ChatWorkflowActionInput = { workspaceId: h.workspaceId, threadId: h.threadId, taskId: before.task.id,
    expectedVersion: before.task.version, requestId: "old-approval", action: "feedback", nodeId: "dev", nodeVersion: before.todos[0]!.version, feedbackAction: "approve" };
  await assert.rejects(h.service.action(input, "owner"), /待办已处理|结果发生变化/);
  assert.equal(submissions, 0);
  await h.service.action({ ...input, requestId: "current-approval", nodeVersion: after.todos[0]!.version }, "owner");
  assert.equal(submissions, 1);
});

test("concurrent polling leaves an active start intact and its receipt completed", async t => {
  const h = harness(t);
  const input = prepareAction(h);
  const pendingStart = h.service.action(input, "owner");
  const interim = h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks[0]!;
  assert.equal(interim.task.state, "starting");
  const version = interim.task.version;
  assert.equal(h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks[0]!.task.version, version);
  const view = await pendingStart;
  assert.ok(view.task.instanceId);
  assert.equal((h.db.db.prepare("SELECT state FROM chat_workflow_actions WHERE request_id = ?").get(input.requestId) as any).state, "completed");
  assert.equal((await h.service.action(input, "owner")).task.instanceId, view.task.instanceId);
  assert.equal(h.db.orchInstances.listByWorkspace(h.workspaceId).length, 1);
});

test("updates to a referenced upstream artifact also expire the node decision", async t => {
  const h = harness(t);
  const started = await h.service.action(prepareAction(h), "owner");
  const instance = h.db.orchInstances.get(started.task.instanceId as any)!;
  const upstream = h.db.orchArtifacts.create({ instanceId: instance.id, nodeId: "upstream", kind: "document", version: 1, title: "input", status: "draft", contentJson: "v1", contentHash: "input-v1" } as any);
  instance.nodeStates.dev = { nodeId: "dev", status: "waiting-approval", retryCount: 0, inputArtifactIds: [upstream.id] };
  h.db.db.prepare("UPDATE orch_instances SET status = 'waiting-approval', node_states_json = ? WHERE id = ?").run(JSON.stringify(instance.nodeStates), instance.id);
  const before = h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks[0]!;
  h.db.orchArtifacts.updateWorkspace(upstream.id, { contentHash: "input-v2" });
  await assert.rejects(h.service.action({ workspaceId: h.workspaceId, threadId: h.threadId, taskId: before.task.id,
    expectedVersion: before.task.version, requestId: "upstream-approval", action: "feedback", nodeId: "dev",
    nodeVersion: before.todos[0]!.version, feedbackAction: "approve" }, "owner"), /待办已处理|结果发生变化/);
});

test("interrupted start without an instance becomes retryable without replaying the old request", async t => {
  const h = harness(t);
  const input = prepareAction(h);
  persistInterruptedStart(h, input);
  const service = new ChatWorkflowService(h.ctx);
  const recovered = service.snapshot(h.workspaceId, h.threadId, "owner").tasks[0]!;
  assert.equal(recovered.task.instanceId, null);
  assert.equal(recovered.task.state, "recommended");
  assert.equal(h.db.threads.getCleanupBusinessBlockedReasons([h.threadId]).has(h.threadId), false);
  await assert.rejects(service.action(input, "owner"), /启动已中断/);
  const retry = await service.action({ ...input, requestId: "retry", expectedVersion: recovered.task.version }, "owner");
  assert.ok(retry.task.instanceId);
  assert.equal(h.db.orchInstances.listByWorkspace(h.workspaceId).length, 1);
});

test("interrupted start with a persisted instance restores the original receipt without creating a duplicate", async t => {
  const h = harness(t);
  const input = prepareAction(h);
  const started = await h.service.action(input, "owner");
  persistInterruptedStart(h, input);
  const service = new ChatWorkflowService(h.ctx);
  const replay = await service.action(input, "owner");
  assert.equal(replay.task.instanceId, started.task.instanceId);
  assert.equal(replay.task.state, "linked");
  assert.equal(h.db.orchInstances.listByWorkspace(h.workspaceId).length, 1);
  assert.equal((h.db.db.prepare("SELECT state FROM chat_workflow_actions WHERE request_id = ?").get(input.requestId) as any).state, "completed");
});

test("a failed start response after instance persistence is reconciled and remains idempotent", async t => {
  const h = harness(t);
  const input = prepareAction(h);
  h.ctx.orchEngine.start = () => { throw new Error("start response interrupted after persistence"); };
  const recovered = await h.service.action(input, "owner");
  assert.ok(recovered.task.instanceId);
  assert.equal((await h.service.action(input, "owner")).task.instanceId, recovered.task.instanceId);
  assert.equal((h.db.db.prepare("SELECT state FROM chat_workflow_actions WHERE request_id = ?").get(input.requestId) as any).state, "completed");
  assert.equal(h.db.orchInstances.listByWorkspace(h.workspaceId).length, 1);
});

test("shared chat RPCs enforce thread ACLs for all writes and bind the actor to the envelope", async t => {
  const h = harness(t);
  const rec = h.recommend();
  h.db.threads.setSharedAcl(h.threadId, { sharedWorkspaceId: "sw-test" as any, ownerUserId: "owner", visibility: "participants", participantUserIds: [], updatedAt: 1 });
  for (const method of ["orch.chat.settings", "orch.chat.prepare", "orch.chat.action", "orch.chat.rework", "orch.chat.delete"] as const) {
    const denied = await sharedChatRequest(h, method, "unrelated", { actorUserId: "owner", enabled: false, taskId: rec.task.id });
    assert.equal(denied?.status, "failed", method);
    assert.equal(denied?.error?.code, "SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN", method);
  }
  assert.equal(h.service.repo.isEnabled(h.threadId), true);
  assert.equal(h.service.repo.get(rec.task.id)?.proposalId, null);
  const read = await sharedChatRequest(h, "orch.chat.get", "unrelated", { actorUserId: "owner" });
  assert.equal(read?.status, "succeeded");
  assert.equal(read?.result.tasks[0].canAccept, false);
  const ownWrite = await sharedChatRequest(h, "orch.chat.settings", "owner", { enabled: false });
  assert.equal(ownWrite?.status, "succeeded");
  assert.equal(h.service.repo.isEnabled(h.threadId), false);
  // 即便是 owner，也不能访问没有绑定本共享空间 ACL 的线程。
  h.db.threads.setSharedAcl(h.threadId, { sharedWorkspaceId: "sw-other" as any, ownerUserId: "owner", visibility: "participants", participantUserIds: [], updatedAt: 2 });
  const wrongWorkspace = await sharedChatRequest(h, "orch.chat.get", "owner");
  assert.equal(wrongWorkspace?.status, "failed");
  assert.equal(wrongWorkspace?.error?.code, "SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN");
});

test("snapshot hides cards whose workflow instance no longer exists", async t => {
  const h = harness(t);
  const started = await h.service.action(prepareAction(h), "owner");
  h.db.orchInstances.delete(started.task.instanceId as any);

  assert.deepEqual(h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks, [], "实例已删的卡片不再返回");

  // 未启动的推荐卡不绑定实例，必须照常显示并可启动。
  const recommended = h.recommend("turn-2");
  const tasks = h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks;
  assert.deepEqual(tasks.map(view => view.task.id), [recommended.task.id]);
  assert.equal(tasks[0]!.task.instanceId, null);
});

test("snapshot hides a starting card whose bound instance is gone", async t => {
  const h = harness(t);
  const started = await h.service.action(prepareAction(h), "owner");
  const task = h.service.repo.get(started.task.id)!;
  h.service.repo.update({ ...task, state: "starting" }, task.version);
  h.db.orchInstances.delete(started.task.instanceId as any);

  // 恢复流程会把 starting 落回 recommended 但保留已悬空的 instance_id，展示层必须继续隐藏它。
  assert.deepEqual(h.service.snapshot(h.workspaceId, h.threadId, "owner").tasks, []);
  assert.equal(h.service.repo.get(started.task.id)?.instanceId, started.task.instanceId);
});
