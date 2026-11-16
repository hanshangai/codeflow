import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type ClientToServerMessage,
  type NodeExecutionProfileScope,
  type RoleDefinition,
  type WorkflowRuntimeDefinition,
  type WorkspaceId,
} from "../../../../packages/shared/src/index.ts";
import { handleApiRequest, type ApiHandlerContext, type ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import { handleOrchProposalsCreate } from "../src/app/handlers/orchestrationHandlers.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { logger } from "../src/logger.ts";

type RuntimeRoleDefinition = Omit<RoleDefinition, "createdAt" | "updatedAt">;

/** Creates a real Client DB around a fake Server-authority asset session. */
function createHarness(options?: { readError?: Error; withRuntimeRead?: boolean; scope?: NodeExecutionProfileScope }) {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-asset-proposal-"));
  const workspaceId = "ws-asset-proposal" as WorkspaceId;
  const applicationDb = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  applicationDb.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
  const db = applicationDb.forWorkspace(workspaceId);
  const sent: ClientToServerMessage[] = [];
  const openCalls: WorkspaceId[] = [];
  const assetReadCalls: string[] = [];
  const role: RuntimeRoleDefinition = {
    id: "role-server" as any,
    workspaceId,
    name: "Server 页面实现",
    description: "来自 本地工作区会话的角色",
    responsibility: "实现页面",
    systemPrompt: "按需求实现页面",
    inputDefinition: createDefaultRoleInputDefinition(),
    outputDefinition: createDefaultRoleOutputDefinition(),
    gateCriteria: [],
    executionConfig: createDefaultRoleExecutionConfig("codex"),
    defaultKnowledgeBundleIds: [],
    toolRefs: [],
    kind: "custom",
  };
  const workflow: WorkflowRuntimeDefinition = {
    id: "wf-server" as any,
    workspaceId,
    family: "feature-dev",
    name: "Server 标准流程",
    description: "来自 本地工作区会话的工作流",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "role-a", type: "role", roleId: role.id, label: "实现 A", position: { x: 0, y: 120 } },
      { id: "role-b", type: "role", roleId: role.id, label: "实现 B", position: { x: 0, y: 240 } },
      { id: "end", type: "end", label: "结束", position: { x: 0, y: 360 } },
    ],
    edges: [],
    version: 1,
  };

  const orchAssetRuntimeRead = options?.withRuntimeRead === false
    ? undefined
    : {
      /** Pins all reads for one request to this fake Server session. */
      openWorkspace(runtimeWorkspaceId: WorkspaceId) {
        openCalls.push(runtimeWorkspaceId);
        return {
          authorityMode: "legacy" as const,
          listAssets() { return []; },
          getAsset(assetType: "role" | "workflow", assetId: string) {
            assetReadCalls.push(`${assetType}:${assetId}`);
            if (options?.readError) throw options.readError;
            const definition = assetType === "workflow" && assetId === workflow.id
              ? workflow
              : assetType === "role" && assetId === role.id
                ? role
                : null;
            return definition
              ? {
                assetType,
                assetId,
                definition,
                source: { authorityMode: "legacy" as const, createdAt: 1, updatedAt: 1 },
              }
              : null;
          },
        };
      },
    };
  const ctx = {
    db,
    workspaces: new Map([[workspaceId, workspacePath]]),
    orchAssetRuntimeRead,
    intakeWorkspaceScope: options?.scope,
    send(message: ClientToServerMessage) {
      sent.push(message);
    },
  } as unknown as ApiHandlerContext;

  /** Calls the synchronous proposal handler and returns its matching response. */
  function call(body: Record<string, unknown>) {
    const requestId = `req-${sent.length + 1}`;
    handleOrchProposalsCreate(ctx, {
      t: "api.req",
      id: requestId,
      method: "orch.proposals.create",
      path: "/orch.proposals.create",
      body: { workspaceId, ...body },
    } as ApiRequestMessage);
    return sent.find((message) => message.t === "api.res" && message.id === requestId) as any;
  }

  return {
    db,
    ctx,
    workspaceId,
    role,
    workflow,
    openCalls,
    assetReadCalls,
    call,
    /** 经过真实 API 边界验证本地资产读取与提案写入。 */
    async dispatch(body: Record<string, unknown>) {
      const id = `dispatch-${sent.length + 1}`;
      await handleApiRequest(ctx, { t: "api.req", id, method: "orch.proposals.create", path: "/orch/proposals/create", body: { workspaceId, ...body } } as ApiRequestMessage);
      return sent.find(message => message.t === "api.res" && message.id === id) as any;
    },
    cleanup() {
      applicationDb.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

/** Builds the minimal valid intake accepted by manual proposal creation. */
function createIntakeInput(title: string) {
  return {
    triggerMode: "manual",
    taskType: "feature",
    title,
    goal: `完成${title}`,
    requester: { source: "ui" },
  };
}

test("API 创建提案直接读取本地资产且不访问网络", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("UNEXPECTED_ASSET_NETWORK_REQUEST"); });
  const harness = createHarness();
  try {
    const response = await harness.dispatch({ roleId: harness.role.id, intake: createIntakeInput("本地角色") });
    assert.equal(response.status, 200);
    assert.deepEqual(harness.openCalls, [harness.workspaceId]);
    assert.equal(harness.db.orchProposals.listByWorkspace(harness.workspaceId).length, 1);
  } finally { harness.cleanup(); }
});

test("API 本地资产读取失败不创建需求或提案", async () => {
  const harness = createHarness({ readError: new Error("local asset unavailable") });
  try {
    const response = await harness.dispatch({ roleId: harness.role.id, intake: createIntakeInput("失败应中止") });
    assert.equal(response.status, 500);
    assert.equal(response.body.ok, false);
    assert.match(response.body.message, /local asset unavailable/);
    assert.equal(harness.db.orchIntakes.listByWorkspace(harness.workspaceId).length, 0);
    assert.equal(harness.db.orchProposals.listByWorkspace(harness.workspaceId).length, 0);
  } finally { harness.cleanup(); }
});

test("手工工作流提案只读一个 本地会话并生成无时间快照", () => {
  const harness = createHarness();
  try {
    const response = harness.call({
      workflowId: harness.workflow.id,
      intake: createIntakeInput("工作流提案"),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(harness.openCalls, [harness.workspaceId]);
    assert.deepEqual(harness.assetReadCalls, [
      `workflow:${harness.workflow.id}`,
      `role:${harness.role.id}`,
    ]);
    assert.equal(harness.db.orchWorkflows.listByWorkspace(harness.workspaceId).length, 0);
    assert.equal(harness.db.orchRoles.listByWorkspace(harness.workspaceId).length, 0);
    assert.equal(response.body.proposal.draftWorkflow.name, harness.workflow.name);
    assert.equal(Object.hasOwn(response.body.proposal.draftWorkflow, "createdAt"), false);
    assert.equal(Object.hasOwn(response.body.proposal.draftWorkflow, "updatedAt"), false);
  } finally {
    harness.cleanup();
  }
});

test("手工角色提案从 本地角色生成无时间单角色工作流", () => {
  const harness = createHarness();
  try {
    const response = harness.call({
      roleId: harness.role.id,
      intake: createIntakeInput("角色提案"),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(harness.openCalls, [harness.workspaceId]);
    assert.deepEqual(harness.assetReadCalls, [`role:${harness.role.id}`]);
    assert.equal(response.body.proposal.draftWorkflow.name, `单角色执行：${harness.role.name}`);
    assert.equal(Object.hasOwn(response.body.proposal.draftWorkflow, "createdAt"), false);
    assert.equal(Object.hasOwn(response.body.proposal.draftWorkflow, "updatedAt"), false);
  } finally {
    harness.cleanup();
  }
});

test("手工提案 本地读取失败时不回退且不创建 intake 或 proposal", () => {
  const readError = new Error("Server 资产读取失败");
  const harness = createHarness({ readError });
  try {
    assert.throws(
      () => harness.call({ workflowId: harness.workflow.id, intake: createIntakeInput("失败提案") }),
      (error) => error === readError,
    );
    assert.equal(harness.db.orchIntakes.listByWorkspace(harness.workspaceId).length, 0);
    assert.equal(harness.db.orchProposals.listByWorkspace(harness.workspaceId).length, 0);
  } finally {
    harness.cleanup();
  }
});

test("手工提案缺少运行读取装配时显式失败且不写入", () => {
  const harness = createHarness({ withRuntimeRead: false });
  try {
    assert.throws(
      () => harness.call({ roleId: harness.role.id, intake: createIntakeInput("缺少装配") }),
      /资产运行读取服务未装配/,
    );
    assert.equal(harness.db.orchIntakes.listByWorkspace(harness.workspaceId).length, 0);
    assert.equal(harness.db.orchProposals.listByWorkspace(harness.workspaceId).length, 0);
  } finally {
    harness.cleanup();
  }
});

test("实例 Repo 不透传结构兼容工作流的资产时间", () => {
  const harness = createHarness();
  try {
    const intake = harness.db.orchIntakes.create({
      workspaceId: harness.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "历史提案启动",
      goal: "验证实例运行快照",
      requester: { source: "ui" },
    });
    const workflowWithAssetTimes = {
      ...harness.workflow,
      createdAt: 0,
      updatedAt: 0,
    };

    const created = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: harness.workflow.id,
      workflowSnapshot: workflowWithAssetTimes,
      intakeSnapshot: intake,
    });
    const persisted = harness.db.orchInstances.get(created.id);

    assert.equal(Object.hasOwn(created.workflowSnapshot, "createdAt"), false);
    assert.equal(Object.hasOwn(created.workflowSnapshot, "updatedAt"), false);
    assert.equal(Object.hasOwn(persisted?.workflowSnapshot ?? {}, "createdAt"), false);
    assert.equal(Object.hasOwn(persisted?.workflowSnapshot ?? {}, "updatedAt"), false);
  } finally {
    harness.cleanup();
  }
});

for (const scope of [
  { scopeType: "local_workspace", scopeId: "ws-asset-proposal" },
  { scopeType: "shared_workspace", scopeId: "sw-asset-proposal" },
] as const) {
  test(`手工内联提案继承可信 ${scope.scopeType} 且忽略正文伪造`, () => {
    const h = createHarness({ scope });
    try {
      const response = h.call({ roleId: h.role.id, workspaceScope: null, intake: {
        ...createIntakeInput("可信归属"), workspaceScope: { scopeType: "shared_workspace", scopeId: "sw-attacker" },
      } });
      assert.equal(response.status, 200);
      const intake = h.db.orchIntakes.get(response.body.intakeId)!;
      assert.deepEqual(intake.workspaceScope, scope);
      assert.deepEqual(h.db.orchProposals.get(response.body.proposal.id)?.intakeSnapshot.workspaceScope, scope);
    } finally { h.cleanup(); }
  });
}

test("普通 API 内联提案不采正文归属且保持未知", async () => {
  const h = createHarness();
  try {
    const response = await h.dispatch({ roleId: h.role.id, intake: { ...createIntakeInput("未知归属"),
      workspaceScope: { scopeType: "local_workspace", scopeId: h.workspaceId } } });
    assert.equal(response.status, 200);
    assert.equal(h.db.orchIntakes.get(response.body.intakeId)?.workspaceScope ?? null, null);
    assert.equal(response.body.proposal.intakeSnapshot.workspaceScope ?? null, null);
  } finally { h.cleanup(); }
});

test("引用旧未知需求创建提案不按当前可信归属回填", () => {
  const h = createHarness({ scope: { scopeType: "shared_workspace", scopeId: "sw-current" } });
  try {
    const intake = h.db.orchIntakes.create({ workspaceId: h.workspaceId, ...createIntakeInput("旧需求") } as any);
    const response = h.call({ roleId: h.role.id, intakeId: intake.id });
    assert.equal(response.status, 200);
    assert.equal(h.db.orchIntakes.get(intake.id)?.workspaceScope ?? null, null);
    assert.equal(response.body.proposal.intakeSnapshot.workspaceScope ?? null, null);
  } finally { h.cleanup(); }
});

test("引用需求归属冲突在替换旧提案前返回 FORBIDDEN 且无写入", async t => {
  const h = createHarness({ scope: { scopeType: "local_workspace", scopeId: "ws-asset-proposal" } });
  try {
    const intake = h.db.orchIntakes.create({ workspaceId: h.workspaceId, ...createIntakeInput("禁止越界"),
      workspaceScope: { scopeType: "local_workspace", scopeId: h.workspaceId } } as any);
    const first = h.call({ roleId: h.role.id, intakeId: intake.id });
    assert.equal(first.status, 200);
    const before = h.db.orchProposals.get(first.body.proposal.id);
    const logs: any[] = [];
    t.mock.method(logger, "warn", (...args: unknown[]) => { logs.push(args); });
    h.ctx.intakeWorkspaceScope = { scopeType: "shared_workspace", scopeId: "sw-other" };
    const response = await h.dispatch({ roleId: h.role.id, intakeId: intake.id });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "FORBIDDEN");
    assert.deepEqual(h.db.orchProposals.get(first.body.proposal.id), before);
    assert.equal(h.db.orchProposals.listByWorkspace(h.workspaceId).length, 1);
    assert.equal(h.db.orchIntakes.listByWorkspace(h.workspaceId).length, 1);
    const detail = logs.find(args => args[2]?.errorCode === "ORCH_INTAKE_SCOPE_CONFLICT")?.[2];
    assert.equal(detail?.requestId, response.id);
    assert.equal(detail?.workspaceId, h.workspaceId);
    assert.equal(detail?.intakeId, intake.id);
    assert.equal(typeof detail?.rootCause, "string");
    assert.equal(JSON.stringify(logs).includes("禁止越界"), false);
  } finally { h.cleanup(); }
});
