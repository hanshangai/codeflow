import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultRoleExecutionConfig, type ChatWorkflowView, type OrchestrationAssetRuntimeSnapshot, type ThreadId, type WorkspaceId } from "@codeflowai/shared";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import { handleChatWorkflowRequest } from "../src/app/handlers/chatWorkflowHandlers.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.ts";
import { ChatWorkflowService, executeChatWorkflowTool } from "../src/orchestration/chatWorkflowService.ts";
import { handleOrchInstancesPause, handleOrchInstancesResume, handleOrchInstancesCancel, handleOrchInstancesFeedback,
  handleOrchInstancesRerunFromNode, handleOrchNodesStart, handleOrchNodesCancel, handleOrchNodesSkip,
  handleOrchIntakesDelete, handleOrchKnowledgeBundlesDelete, handleOrchArtifactRevise } from "../src/app/handlers/orchestrationHandlers.ts";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.ts";

const workspaceId = "desktop:project" as WorkspaceId;
const threadId = "desktop-workflow" as ThreadId;
const actorUserId = "local:desktop";

/** 只替代引擎执行，保留真实工作流建卡、准备、实例持久化与请求处理。 */
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-workflow-"));
  const rootDb = openClientDb({ dbPath: path.join(directory, "test.db") });
  let writer: ClientDbWriterService | undefined;
  t.after(async () => { try { await writer?.close(); } finally { rootDb.close(); fs.rmSync(directory, { recursive: true, force: true }); } });
  rootDb.workspaces.upsert({ id: workspaceId, title: "本机", path: directory });
  const db = rootDb.forWorkspace(workspaceId);
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "本机流程" });
  const asset = {
    authorityMode: "legacy",
    workflow: { assetId: "local-workflow", assetType: "workflow", source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 }, definition: {
      id: "local-workflow", workspaceId, name: "本机流程", description: "", family: "feature-dev", version: 1,
      nodes: [{ id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } }, { id: "dev", type: "role", roleId: "developer", label: "开发", position: { x: 0, y: 50 } }, { id: "end", type: "end", label: "结束", position: { x: 0, y: 100 } }],
      edges: [{ id: "edge", sourceNodeId: "start", targetNodeId: "dev", dataMappings: [] }, { id: "edge-end", sourceNodeId: "dev", targetNodeId: "end", dataMappings: [] }],
    } }, roles: { developer: { assetId: "developer", assetType: "role", source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 }, definition: {
      id: "developer", workspaceId, name: "开发", description: "实现", responsibility: "开发", systemPrompt: "实现需求",
      inputDefinition: { instructions: "{{requirement}}", requiredFields: [] },
      outputDefinition: { instructions: "交付", deliveryMode: "direct", format: "markdown", requiredFields: [] },
      gateCriteria: [], executionConfig: createDefaultRoleExecutionConfig("codex"), defaultKnowledgeBundleIds: [], toolRefs: [], kind: "custom",
    } } }, knowledgeBundles: {}, toolsets: {}, skills: {},
  } as unknown as OrchestrationAssetRuntimeSnapshot;
  const orchEngine = {
    start: async () => {},
    /** 后台准入仍委托本夹具的原可观察引擎入口。 */
    async startInBackground() { await this.start(); },
    /** 替代引擎调度，保留动作可观察的持久化状态变更。 */
    submitFeedback: async (instanceId: string) => { db.orchInstances.updateStatus(instanceId as never, "running"); },
    /** 替代引擎停止，标记实例已取消供真实卡片服务回读。 */
    cancel: (instanceId: string) => { db.orchInstances.updateStatus(instanceId as never, "cancelled"); },
    forWorkspace() { return this; },
  };
  const ctx = {
    db, clientId: "desktop", localWorkspaceOnly: true,
    intakeWorkspaceScope: { scopeType: "local_workspace", scopeId: workspaceId },
    workspaces: new Map([[workspaceId, directory]]), sessions: { hasActiveTurn: () => false }, orchEngine,
    orchAssetLaunchSnapshot: { createFromWorkflowId: () => asset, createFromWorkflow: () => asset },
    send: () => {},
  } as unknown as ApiHandlerContext;
  const service = new ChatWorkflowService(ctx);
  service.repo.setEnabled(threadId, true);
  /** 走真实宿主工具创建待确认卡片，推荐本身不能启动实例。 */
  const recommend = () => {
    const result = executeChatWorkflowTool(ctx, { workspaceId, threadId, turnId: "turn-1", actorUserId }, {
      action: "recommend", workflowId: "local-workflow", title: "恢复本机工作流", goal: "执行本机流程", rationale: "用户要求使用", acceptanceCriteria: ["确认后启动"],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.output as ChatWorkflowView;
  };
  /** 捕获 handler 的显式成功或失败响应，不调用 Server。 */
  const request = async (method: ApiRequestMessage["method"], body: Record<string, unknown>) => {
    let response: { status: number; body: Record<string, any> } | undefined;
    await handleChatWorkflowRequest({ ...ctx, send: message => {
      if (message.t === "api.res") response = { status: message.status, body: message.body as Record<string, any> };
    } }, { t: "api.req", id: "desktop-request", method, path: "/desktop", body: {
      workspaceId, threadId, actorUserId, executionProfileScope: { scopeType: "local_workspace", scopeId: workspaceId }, ...body,
    } } as ApiRequestMessage);
    assert.ok(response);
    return response;
  };
  return { ctx, db, service, recommend, request,
    /** 启用真实Worker许可，保留原资产和实例仓储。 */
    async enableWriter() {
      writer = new ClientDbWriterService({ db: rootDb, dbPath: path.join(directory, "test.db"), onFatalError(error) { throw error; } });
      await writer.ready();
      ctx.withDatabase = (requestId, operation) => writer!.withLegacyDatabase(requestId, operation);
      return writer;
    },
  };
}

test("会话工作流卡片读取、设置和准备在真实Writer短许可内完成", async t => {
  const h = fixture(t), recommended = h.recommend();
  const writer = new ClientDbWriterService({ db: h.db, dbPath: path.join(h.ctx.workspaces.get(workspaceId)!, "test.db"), onFatalError(error) { assert.fail(error); } });
  try {
    await writer.ready();
    h.ctx.withDatabase = (requestId, operation) => writer.withLegacyDatabase(requestId, operation);
    assert.equal((await h.request("orch.chat.get", {})).status, 200);
    assert.equal((await h.request("orch.chat.settings", { enabled: true })).status, 200);
    assert.equal((await h.request("orch.chat.prepare", { taskId: recommended.task.id, expectedVersion: recommended.task.version })).status, 200);
  } finally { await writer.close(); }
});

test("工作流action在真实Writer下分段落库且引擎派发不持许可", async t => {
  const h = fixture(t);
  const recommended = h.recommend();
  const prepared = h.service.prepareStart(workspaceId, threadId, recommended.task.id, recommended.task.version, actorUserId);
  const writer = await h.enableWriter();
  let dispatched = 0;
  (h.ctx.orchEngine as any).start = async () => {
    dispatched += 1;
    assert.throws(() => h.db.orchInstances.listByWorkspace(workspaceId), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
  };
  const result = await h.service.action({ workspaceId, threadId, taskId: prepared.task.id, expectedVersion: prepared.task.version,
    action: "start", requestId: "writer-start" }, actorUserId);
  assert.ok(result.task.instanceId);
  assert.equal(dispatched, 1);
  assert.equal(await writer.withLegacyDatabase("verify-action", () => h.db.orchInstances.listByWorkspace(workspaceId).length), 1);
  const repeated = await h.service.action({ workspaceId, threadId, taskId: prepared.task.id, expectedVersion: prepared.task.version,
    action: "start", requestId: "writer-start" }, actorUserId);
  assert.equal(repeated.task.instanceId, result.task.instanceId);
});

test("会话续跑通知被拒绝时显式失败并停止派发，原请求重试不重复入队", async t => {
  const h = fixture(t), recommended = h.recommend();
  const writer = await h.enableWriter();
  let kicks = 0;
  h.ctx.queueDispatcher = { kickIfIdle() { kicks += 1; } } as never;
  h.ctx.send = () => ({ accepted: false, reason: "offline" } as never);
  const input = { workspaceId, threadId, taskId: recommended.task.id, expectedVersion: recommended.task.version,
    action: "dismiss" as const, requestId: "writer-dismiss" };
  await assert.rejects(h.service.action(input, actorUserId), error => (error as any).code === "CHAT_WORKFLOW_CONTINUATION_NOTIFY_FAILED");
  assert.equal(kicks, 0);
  h.ctx.send = () => ({ accepted: true, bytes: 1 });
  await h.service.action(input, actorUserId);
  assert.equal(kicks, 1);
  assert.equal(await writer.withLegacyDatabase("verify-continuation", () => h.db.threadMessageQueue.listActiveByThread(threadId).length), 1);
});

test("实例及节点控制在真实Writer下分段读取，异步Engine控制不持许可", async t => {
  const h = fixture(t), recommendation = h.recommend();
  const prepared = h.service.prepareStart(workspaceId, threadId, recommendation.task.id, recommendation.task.version, actorUserId);
  const writer = await h.enableWriter();
  const started = await h.service.action({ workspaceId, threadId, taskId: prepared.task.id, expectedVersion: prepared.task.version,
    action: "start", requestId: "control-start" }, actorUserId);
  const instanceId = started.task.instanceId!;
  let controls = 0;
  /** 真实仓储只在模拟Engine自己的短许可内访问。 */
  const control = async () => {
    assert.throws(() => h.db.orchInstances.get(instanceId as never), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
    controls += 1;
  };
  Object.assign(h.ctx.orchEngine, { pause: control, resumeInBackground: control, startWaitingNode: control,
    cancelNode: control, skipWaitingNode: control, submitFeedback: control, rerunFromNode: control,
    ensureAssetRuntimeSnapshotForExecution: () => writer.withLegacyDatabase("engine-snapshot", () => h.db.orchInstances.get(instanceId as never)),
    validateRerunFromNodeScope: () => { assert.ok(h.db.orchInstances.get(instanceId as never)); },
  });
  for (const handler of [handleOrchInstancesPause, handleOrchInstancesResume, handleOrchNodesStart, handleOrchNodesCancel,
    handleOrchNodesSkip, handleOrchInstancesFeedback, handleOrchInstancesRerunFromNode, handleOrchInstancesCancel]) {
    const responses: any[] = [];
    await handler({ ...h.ctx, send: message => { responses.push(message); } }, {
      t: "api.req", id: handler.name, method: handler.name, path: "/control", body: {
        workspaceId, instanceId, nodeId: handler === handleOrchInstancesResume ? null : "dev", targetNodeId: "dev",
        action: "resume_with_input", feedback: "继续执行",
      },
    } as ApiRequestMessage);
    assert.equal(responses.find(message => message.t === "api.res")?.status, 200, handler.name);
  }
  assert.equal(controls, 7);
});

test("需求级联删除在真实Writer下等待取消后删除原需求提案及实例", async t => {
  const h = fixture(t), recommended = h.recommend();
  const prepared = h.service.prepareStart(workspaceId, threadId, recommended.task.id, recommended.task.version, actorUserId);
  const writer = await h.enableWriter();
  const started = await h.service.action({ workspaceId, threadId, taskId: prepared.task.id, expectedVersion: prepared.task.version,
    action: "start", requestId: "delete-start" }, actorUserId);
  let cancelled = 0;
  (h.ctx.orchEngine as any).cancelAndWait = async () => {
    assert.throws(() => h.db.orchInstances.get(started.task.instanceId as never), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
    cancelled += 1;
  };
  const responses: any[] = [];
  await handleOrchIntakesDelete({ ...h.ctx, send: message => { responses.push(message); } }, {
    t: "api.req", id: "delete-intake", method: "orch.intakes.delete", path: "/delete", body: {
      workspaceId, intakeId: started.task.intakeId, forceDeleteRunning: true,
    },
  });
  assert.equal(responses.find(message => message.t === "api.res")?.status, 200);
  assert.equal(cancelled, 1);
  assert.equal(await writer.withLegacyDatabase("verify-intake-deleted", () => h.db.orchIntakes.get(started.task.intakeId as never)), null);
  assert.equal(await writer.withLegacyDatabase("verify-instance-deleted", () => h.db.orchInstances.get(started.task.instanceId as never)), null);
});

test("孤儿知识包删除在真实Writer下释放联网等待并重新准入写库", async t => {
  const h = fixture(t);
  const bundle = h.db.orchKnowledgeBundles.upsert({ workspaceId, id: "orphan-knowledge" as never, name: "孤儿", description: "",
    kind: "builtin", scope: "shared", sourceRefs: [] } as never);
  const writer = await h.enableWriter();
  h.ctx.loadServerDefaultBundles = async () => {
    assert.throws(() => h.db.orchKnowledgeBundles.get(bundle.id), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
    return [];
  };
  const responses: any[] = [];
  await handleOrchKnowledgeBundlesDelete({ ...h.ctx, send: message => { responses.push(message); } }, {
    t: "api.req", id: "delete-knowledge", method: "orch.knowledgeBundles.delete", path: "/delete", body: { workspaceId, bundleId: bundle.id },
  });
  assert.equal(responses.find(message => message.t === "api.res")?.status, 200);
  assert.equal(await writer.withLegacyDatabase("verify-knowledge-deleted", () => h.db.orchKnowledgeBundles.get(bundle.id)), null);
});

test("工件修订在真实Writer下等待资产恢复后读取写入并回读", async t => {
  const h = fixture(t), recommended = h.recommend();
  const prepared = h.service.prepareStart(workspaceId, threadId, recommended.task.id, recommended.task.version, actorUserId);
  const started = await h.service.action({ workspaceId, threadId, taskId: prepared.task.id, expectedVersion: prepared.task.version,
    action: "start", requestId: "artifact-start" }, actorUserId);
  const instanceId = started.task.instanceId as never;
  const artifact = h.db.orchArtifacts.create({ instanceId, nodeId: "dev", kind: "result", version: 1,
    title: "修订", schemaRef: null, status: "draft", contentJson: "{}" } as never);
  const writer = await h.enableWriter();
  Object.assign(h.ctx.orchEngine, {
    ensureAssetRuntimeSnapshotForExecution: async () => {
      assert.throws(() => h.db.orchArtifacts.get(artifact.id), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
      return await writer.withLegacyDatabase("artifact-asset-ready", () => h.db.orchInstances.get(instanceId));
    },
    reviseArtifact: () => { assert.ok(h.db.orchArtifacts.get(artifact.id)); return artifact; },
  });
  const responses: any[] = [];
  await handleOrchArtifactRevise({ ...h.ctx, send: message => { responses.push(message); } }, {
    t: "api.req", id: "revise-artifact", method: "orch.artifacts.revise", path: "/revise", body: {
      workspaceId, instanceId, nodeId: "dev", artifactId: artifact.id, answer: { mode: "text", summary: "修订结果", text: "正文" },
    },
  });
  assert.equal(responses.find(message => message.t === "api.res")?.status, 200, JSON.stringify(responses));
});

test("本机自然确认先准备需求和提案，再启动且重复确认不创建第二个实例", async t => {
  const h = fixture(t);
  const recommended = h.recommend();
  assert.equal(h.db.orchInstances.listByWorkspace(workspaceId).length, 0);
  const result = await h.request("orch.chat.natural" as ApiRequestMessage["method"], { text: "确认启动工作流", requestId: "natural-start" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.handled, true);
  assert.equal(result.body.action, "start");
  const view = result.body.view as ChatWorkflowView;
  assert.ok(view.task.intakeId && view.task.proposalId && view.task.instanceId);
  assert.equal(h.db.orchIntakes.get(view.task.intakeId as never)?.workspaceScope?.scopeType, "local_workspace");
  const repeated = await h.request("orch.chat.action", { taskId: recommended.task.id, expectedVersion: recommended.task.version, action: "start", requestId: "retry-start" });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.view.task.instanceId, view.task.instanceId);
  assert.equal(h.db.orchInstances.listByWorkspace(workspaceId).length, 1);
});

test("本机卡片直接启动自动准备，远程入口仍要求 Server 已完成准备", async t => {
  for (const local of [true, false]) {
    const h = fixture(t);
    h.ctx.localWorkspaceOnly = local;
    const recommended = h.recommend();
    const result = await h.request("orch.chat.action", { taskId: recommended.task.id, expectedVersion: recommended.task.version, action: "start", requestId: `start-${local}` });
    assert.equal(result.status, local ? 200 : 409, JSON.stringify(result.body));
    assert.equal(h.db.orchInstances.listByWorkspace(workspaceId).length, local ? 1 : 0);
    if (!local) assert.equal(result.body.code, "CHAT_WORKFLOW_START_INVALID");
  }
});

test("自然意图未命中返回未处理，准备失败则显式失败且没有实例副作用", async t => {
  const h = fixture(t);
  const unmatched = await h.request("orch.chat.natural" as ApiRequestMessage["method"], { text: "继续讨论需求", requestId: "unmatched" });
  assert.equal(unmatched.status, 200);
  assert.equal(unmatched.body.handled, false);
  h.recommend();
  const failed = await h.request("orch.chat.natural" as ApiRequestMessage["method"], { text: "确认启动工作流", requestId: "wrong-actor", actorUserId: "local:other" });
  assert.equal(failed.status, 403);
  assert.equal(failed.body.code, "CHAT_WORKFLOW_INITIATOR_REQUIRED");
  assert.equal(h.db.orchInstances.listByWorkspace(workspaceId).length, 0);
  assert.equal(h.db.orchIntakes.listByWorkspace(workspaceId).length, 0);
});

test("更新暂停期间自然启动在准备前拒绝，需求、提案、实例与动作回执均不新增", async t => {
  const h = fixture(t);
  const recommended = h.recommend();
  h.ctx.isTaskAdmissionPaused = () => true;
  const result = await h.request("orch.chat.natural", { text: "确认启动工作流", requestId: "paused-start" });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "DESKTOP_UPDATE_TASKS_PAUSED");
  assert.equal(h.db.orchIntakes.listByWorkspace(workspaceId).length, 0);
  assert.equal(h.db.db.prepare("SELECT count(*) AS total FROM orch_proposals").get()?.total, 0);
  assert.equal(h.db.orchInstances.listByWorkspace(workspaceId).length, 0);
  assert.equal(h.db.db.prepare("SELECT count(*) AS total FROM chat_workflow_actions").get()?.total, 0);
  assert.equal(h.service.repo.get(recommended.task.id)?.version, recommended.task.version);
});

test("更新暂停期间自然补充拒绝且不消费待办，终止工作流仍可执行", async t => {
  const h = fixture(t);
  h.recommend();
  const started = await h.request("orch.chat.natural", { text: "确认启动工作流", requestId: "start-before-pause" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const view = started.body.view as ChatWorkflowView;
  const instanceId = view.task.instanceId as never;
  h.db.orchInstances.updateNodeStates(instanceId, {
    dev: { nodeId: "dev", status: "waiting-feedback", retryCount: 0, assigneeUserIds: [], completedAt: null, humanActionSource: "human_input" },
  } as never);
  h.db.orchInstances.updateStatus(instanceId, "waiting-feedback");
  const before = h.db.orchInstances.get(instanceId)!;
  h.ctx.isTaskAdmissionPaused = () => true;
  const rejected = await h.request("orch.chat.natural", { text: "补充：保留现有数据库", requestId: "paused-feedback" });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, "DESKTOP_UPDATE_TASKS_PAUSED");
  assert.deepEqual(h.db.orchInstances.get(instanceId)?.nodeStates, before.nodeStates);
  assert.equal(h.db.orchInstances.get(instanceId)?.status, "waiting-feedback");
  assert.equal(h.db.db.prepare("SELECT 1 FROM chat_workflow_actions WHERE request_id = ?").get("paused-feedback"), undefined);
  const cancelled = await h.request("orch.chat.natural", { text: "终止工作流", requestId: "cancel-during-pause" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.action, "cancel");
  assert.equal(h.db.orchInstances.get(instanceId)?.status, "cancelled");
});
