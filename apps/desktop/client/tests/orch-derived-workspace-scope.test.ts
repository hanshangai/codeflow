import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultRoleExecutionConfig, type NodeExecutionProfileScope, type OrchestrationAssetRuntimeSnapshot } from "../../../../packages/shared/src/index.ts";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.ts";
import { handleChatWorkflowRequest } from "../src/app/handlers/chatWorkflowHandlers.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { ChatWorkflowService } from "../src/orchestration/chatWorkflowService.ts";
import { logger } from "../src/logger.ts";

/** 真实 SQLite 与准备服务；只替代外部资产读取，显式启用本测试会话的推荐。 */
function createHarness(t: test.TestContext, scope?: NodeExecutionProfileScope, sharedWorkspaceId?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-derived-scope-"));
  const workspaceId = "ws-derived" as any;
  const threadId = "thread-derived" as any;
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.workspaces.upsert({ id: workspaceId, title: "derived", path: directory });
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "derived" });
  if (sharedWorkspaceId) db.threads.setSharedAcl(threadId, { sharedWorkspaceId: sharedWorkspaceId as any, ownerUserId: "owner", visibility: "participants", participantUserIds: [], updatedAt: 1 });
  const role = { id: "role-derived", workspaceId, name: "开发", description: "开发", responsibility: "实现", systemPrompt: "实现需求",
    inputDefinition: { instructions: "需求", requiredFields: [] }, outputDefinition: { instructions: "结果", deliveryMode: "direct", format: "markdown", requiredFields: [] },
    gateCriteria: [], executionConfig: createDefaultRoleExecutionConfig("codex"), defaultKnowledgeBundleIds: [], toolRefs: [], kind: "custom" };
  const asset = { authorityMode: "legacy", workflow: { assetType: "workflow", assetId: "wf-derived", source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 },
    definition: { id: "wf-derived", workspaceId, name: "派生范围工作流", description: "测试", family: "feature-dev", version: 1,
      nodes: [{ id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } }, { id: "dev", type: "role", roleId: role.id, label: "开发", position: { x: 0, y: 50 } }],
      edges: [{ id: "edge", sourceNodeId: "start", targetNodeId: "dev", dataMappings: [] }] } },
    roles: { [role.id]: { assetType: "role", assetId: role.id, source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 }, definition: role } },
    knowledgeBundles: {}, toolsets: {}, skills: {} } as unknown as OrchestrationAssetRuntimeSnapshot;
  const sent: any[] = [];
  const ctx = { db, workspaces: new Map([[workspaceId, directory]]), intakeWorkspaceScope: scope,
    orchAssetLaunchSnapshot: { createFromWorkflowId: () => asset },
    orchAssetRuntimeRead: { openWorkspace: () => ({ getAsset: () => asset.workflow, listAssets: () => [] }) },
    send(message: unknown) { sent.push(message); } } as unknown as ApiHandlerContext;
  const service = new ChatWorkflowService(ctx);
  service.repo.setEnabled(threadId, true);
  const recommended = service.recommend({ workspaceId, threadId, turnId: "turn-derived", actorUserId: "owner", workflowId: "wf-derived",
    title: "派生范围", goal: "验证准备需求归属", context: "敏感需求正文不可进入错误日志", rationale: "验证准备", acceptanceCriteria: ["保留原归属"] });
  /** 重入沿用持久版本，避免用陈旧卡片掩盖范围判断。 */
  function prepare() {
    const task = service.repo.get(recommended.task.id)!;
    return service.prepareStart(workspaceId, threadId, task.id, task.version, "owner");
  }
  /** 经过原错误处理边界捕获 requestId、固定错误码与安全原因。 */
  async function dispatch() {
    const task = service.repo.get(recommended.task.id)!;
    await handleChatWorkflowRequest(ctx, { t: "api.req", id: "req-derived", method: "orch.chat.prepare", path: "/orch/chat/prepare",
      body: { workspaceId, threadId, taskId: task.id, expectedVersion: task.version, actorUserId: "owner", workspaceScope: { scopeType: "local_workspace", scopeId: "attacker" } } } as any);
    return sent.find(message => message.t === "api.res" && message.id === "req-derived");
  }
  return { db, service, ctx, workspaceId, threadId, recommended, prepare, dispatch };
}

for (const scope of [
  { scopeType: "local_workspace", scopeId: "ws-derived" },
  { scopeType: "shared_workspace", scopeId: "sw-derived" },
] as const) {
  test(`聊天准备持久 ${scope.scopeType} 并由提案快照继承`, async t => {
    const h = createHarness(t, scope, scope.scopeType === "shared_workspace" ? scope.scopeId : undefined);
    const response = await h.dispatch();
    assert.equal(response.status, 200);
    const task = h.service.repo.get(h.recommended.task.id)!;
    assert.deepEqual(h.db.orchIntakes.get(task.intakeId as any)?.workspaceScope, scope);
    assert.deepEqual(h.db.orchProposals.get(task.proposalId as any)?.intakeSnapshot.workspaceScope, scope);
    const intakeBefore = h.db.orchIntakes.get(task.intakeId as any);
    assert.deepEqual(h.prepare().task, task);
    assert.deepEqual(h.db.orchIntakes.get(task.intakeId as any), intakeBefore);
  });
}

test("共享源线程在未知入口准备仍为未知，已准备重入不按当前范围回填", t => {
  const h = createHarness(t, undefined, "sw-derived");
  const prepared = h.prepare();
  assert.equal(h.db.orchIntakes.get(prepared.task.intakeId as any)?.workspaceScope ?? null, null);
  h.ctx.intakeWorkspaceScope = { scopeType: "shared_workspace", scopeId: "sw-derived" };
  assert.deepEqual(h.prepare().task, prepared.task);
  assert.equal(h.db.orchIntakes.get(prepared.task.intakeId as any)?.workspaceScope ?? null, null);
  assert.equal(h.db.orchProposals.get(prepared.task.proposalId as any)?.intakeSnapshot.workspaceScope ?? null, null);
});

test("已准备需求冲突在任务恢复前失败，旧任务提案及记录数不变", async t => {
  const h = createHarness(t, { scopeType: "local_workspace", scopeId: "ws-derived" });
  const prepared = h.prepare();
  const starting = h.service.repo.update({ ...prepared.task, state: "starting" }, prepared.task.version);
  const proposalBefore = h.db.orchProposals.get(starting.proposalId as any);
  const logs: any[] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { logs.push(args); });
  h.ctx.intakeWorkspaceScope = { scopeType: "shared_workspace", scopeId: "sw-derived" };
  const response = await h.dispatch();
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "FORBIDDEN");
  assert.deepEqual(h.service.repo.get(starting.id), starting);
  assert.deepEqual(h.db.orchProposals.get(starting.proposalId as any), proposalBefore);
  assert.equal(h.db.orchIntakes.listByWorkspace(h.workspaceId).length, 1);
  assert.equal(h.db.orchProposals.listByWorkspace(h.workspaceId).length, 1);
  const detail = logs.find(args => args[2]?.code === "FORBIDDEN")?.[2];
  assert.equal(detail?.requestId, "req-derived");
  assert.equal(detail?.taskId, starting.id);
  assert.equal(JSON.stringify(logs).includes("敏感需求正文"), false);
});

for (const scope of [
  { scopeType: "local_workspace", scopeId: "ws-derived" },
  { scopeType: "shared_workspace", scopeId: "sw-other" },
] as const) {
  test(`可信 ${scope.scopeType} 与持久共享源线程冲突时不准备任何记录`, async t => {
    const h = createHarness(t, scope, "sw-derived");
    const before = h.service.repo.get(h.recommended.task.id);
    const response = await h.dispatch();
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "FORBIDDEN");
    assert.deepEqual(h.service.repo.get(h.recommended.task.id), before);
    assert.equal(h.db.orchIntakes.listByWorkspace(h.workspaceId).length, 0);
    assert.equal(h.db.orchProposals.listByWorkspace(h.workspaceId).length, 0);
  });
}

test("已准备提案快照与实际需求归属冲突时显式失败且不改任务", async t => {
  const h = createHarness(t, { scopeType: "local_workspace", scopeId: "ws-derived" });
  const prepared = h.prepare();
  h.db.db.prepare("UPDATE orch_proposals SET proposal_json = json_set(proposal_json, '$.intakeSnapshot.workspaceScope', json(?)) WHERE id = ?")
    .run(JSON.stringify({ scopeType: "shared_workspace", scopeId: "sw-other" }), prepared.task.proposalId);
  const response = await h.dispatch();
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "FORBIDDEN");
  assert.deepEqual(h.service.repo.get(prepared.task.id), prepared.task);
});

for (const missing of ["intake", "proposal"] as const) {
  test(`已准备任务缺少 ${missing} 引用时显式失败，不重建记录`, async t => {
    const h = createHarness(t);
    const prepared = h.prepare();
    h.db.db.prepare(missing === "intake" ? "DELETE FROM orch_intakes WHERE id = ?" : "DELETE FROM orch_proposals WHERE id = ?")
      .run(missing === "intake" ? prepared.task.intakeId : prepared.task.proposalId);
    const countBefore = h.db.orchProposals.listByWorkspace(h.workspaceId).length;
    const response = await h.dispatch();
    assert.equal(response.body.ok, false);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "CONFLICT");
    assert.deepEqual(h.service.repo.get(prepared.task.id), prepared.task);
    assert.equal(h.db.orchProposals.listByWorkspace(h.workspaceId).length, countBefore);
  });
}
