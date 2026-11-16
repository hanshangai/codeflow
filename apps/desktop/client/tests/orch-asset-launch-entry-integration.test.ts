import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
  type EngineModelCatalogSnapshot,
  type OrchestrationAssetRuntimeSnapshot,
  type WorkflowProposal,
  type WorkflowRuntimeDefinition,
  type WorkspaceId,
} from "../../../../packages/shared/src/index.ts";
import { applyEngineModelCatalogSnapshot } from "../src/engines/engineModelCatalogRuntime.ts";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import {
  createScheduledWorkflowInstance,
  handleOrchInstancesStart,
} from "../src/app/handlers/orchestrationHandlers.ts";
import { openClientDb } from "../src/db/clientDb.ts";

/** 打开一个真实 Client SQLite，并装配可观测的启动资产图服务。 */
function createHarness(options: { launchError?: Error; local?: boolean } = {}) {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "orch-launch-entry-"));
  const workspaceId = (options.local ? "local-client:launch-entry" : "ws-launch-entry") as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  db.workspaces.upsert({ id: workspaceId, title: "启动资产图", path: workspacePath });
  const workflow = createWorkflow(workspaceId);
  const launchCalls: string[] = [];
  const startedInstanceIds: string[] = [];
  const responses: any[] = [];
  const emittedEvents: unknown[] = [];
  const orchAssetLaunchSnapshot = {
    /** proposal 路径必须使用冻结工作流，不按 ID 重读。 */
    createFromWorkflow(runtimeWorkspaceId: WorkspaceId, frozenWorkflow: WorkflowRuntimeDefinition) {
      launchCalls.push(`proposal:${runtimeWorkspaceId}:${frozenWorkflow.id}`);
      if (options.launchError) throw options.launchError;
      return createSnapshot(frozenWorkflow, false);
    },
    /** 定时路径必须按 ID 从同一权威会话解析工作流。 */
    createFromWorkflowId(runtimeWorkspaceId: WorkspaceId, workflowId: string) {
      launchCalls.push(`scheduled:${runtimeWorkspaceId}:${workflowId}`);
      if (options.launchError) throw options.launchError;
      assert.equal(workflowId, workflow.id);
      return createSnapshot(workflow, true);
    },
  };
  const ctx = {
    clientId: options.local ? "local-client" : "server-client",
    localWorkspaceOnly: options.local,
    db,
    workspaces: new Map([[workspaceId, workspacePath]]),
    orchAssetLaunchSnapshot,
    orchEngine: {
      /** 当前启动入口只等待原引擎受理，测试桩与该合同保持一致。 */
      startInBackground(instanceId: string) {
        startedInstanceIds.push(instanceId);
        return Promise.resolve();
      },
    },
    send(message: unknown) {
      responses.push(message);
    },
    emitOrchestration(_runtimeWorkspaceId: WorkspaceId, event: unknown) {
      emittedEvents.push(event);
    },
  } as unknown as ApiHandlerContext;
  return {
    ctx,
    db,
    workspaceId,
    workflow,
    launchCalls,
    responses,
    startedInstanceIds,
    emittedEvents,
    cleanup() {
      db.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

/** 构造可由 Task 69 持久化合同验证的最小工作流。 */
function createWorkflow(workspaceId: WorkspaceId): WorkflowRuntimeDefinition {
  return {
    id: "wf-launch-entry" as any,
    workspaceId,
    family: "feature-dev",
    name: "启动资产图工作流",
    description: "验证 proposal 与定时启动",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "role", type: "role", roleId: "role-launch" as any, label: "执行", position: { x: 120, y: 0 } },
      { id: "end", type: "end", label: "结束", position: { x: 240, y: 0 } },
    ],
    edges: [
      { id: "start-role", sourceNodeId: "start", targetNodeId: "role", dataMappings: [] },
      { id: "role-end", sourceNodeId: "role", targetNodeId: "end", dataMappings: [] },
    ],
    version: 3,
  };
}

/** 构造完整本地资产图；proposal 工作流来源允许为空。 */
function createSnapshot(workflow: WorkflowRuntimeDefinition, includeWorkflowSource: boolean): OrchestrationAssetRuntimeSnapshot {
  return {
    authorityMode: "legacy",
    workflow: {
      assetType: "workflow",
      assetId: workflow.id,
      definition: structuredClone(workflow),
      source: includeWorkflowSource ? localSource(20) : null,
    },
    roles: {
      "role-launch": {
        assetType: "role",
        assetId: "role-launch",
        definition: {
          id: "role-launch" as any,
          workspaceId: workflow.workspaceId,
          name: "启动角色",
          description: "执行启动图测试",
          responsibility: "完成任务",
          systemPrompt: "完成任务并返回结果",
          inputDefinition: createDefaultRoleInputDefinition(),
          outputDefinition: createDefaultRoleOutputDefinition(),
          gateCriteria: [],
          executionConfig: createDefaultRoleExecutionConfig("codex"),
          defaultKnowledgeBundleIds: [],
          defaultSkillIds: [],
          toolRefs: [],
          kind: "custom",
          createdAt: 10,
          updatedAt: 20,
        } as any,
        source: localSource(21),
      },
    },
    knowledgeBundles: {},
    toolsets: {},
    skills: {},
  };
}

/** 构造稳定的本地来源。 */
function localSource(syncChangeSeq: number) {
  return {
    authorityMode: "legacy" as const,
    createdAt: 1,
    updatedAt: syncChangeSeq,
  };
}

/** 创建一个可启动的 proposal 及其既有 Intake。 */
function createProposal(
  harness: ReturnType<typeof createHarness>,
  options: { status?: WorkflowProposal["status"]; requiresConfirmation?: boolean } = {},
) {
  const intake = harness.db.orchIntakes.create({
    workspaceId: harness.workspaceId,
    triggerMode: "manual",
    taskType: "feature",
    title: "启动完整资产图",
    goal: "验证启动入口持久化完整资产图",
    constraints: { requireUserConfirmation: true, nodeApprovalMode: "auto" },
    requester: { source: "ui" },
  });
  const proposal = harness.db.orchProposals.create({
    workspaceId: harness.workspaceId,
    intakeId: intake.id,
    intakeSnapshot: intake,
    status: options.status ?? "confirmed",
    recommendedFamily: "feature-dev",
    rationale: "使用冻结工作流",
    draftWorkflow: harness.workflow,
    draftRoleBindings: [{ nodeId: "role", roleId: "role-launch" as any }],
    draftKnowledgeBindings: [],
    warnings: [],
    requiresConfirmation: options.requiresConfirmation ?? true,
    confirmedAt: options.status === "confirmed" || options.status === undefined ? Date.now() : null,
  });
  return { intake, proposal };
}

/** 调用 proposal 启动 API，并返回本次响应。 */
async function startProposal(
  harness: ReturnType<typeof createHarness>,
  proposal: WorkflowProposal,
  extraBody: Record<string, unknown> = {},
): Promise<any> {
  const request: ApiRequestMessage = {
    t: "api.req",
    id: `req-${harness.responses.length + 1}`,
    method: "orch.instances.start",
    path: "/orch/instances/start",
    body: { workspaceId: harness.workspaceId, proposalId: proposal.id, ...extraBody },
  };
  await handleOrchInstancesStart(harness.ctx, request);
  return harness.responses.at(-1);
}

/** 应用只含测试模型的运行时目录；启动校验必须命中真实目录，不做静态回退。 */
let testCatalogVersion = 0;
function applyTestEngineModelCatalog(codexModelIds: string[]): void {
  // 目录是模块级状态：同一版本号内容不同会被判定为版本碰撞，因此每次应用都推进版本。
  testCatalogVersion += 1;
  applyEngineModelCatalogSnapshot({
    schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
    configVersion: testCatalogVersion,
    capturedAt: 1,
    rows: [
      ...codexModelIds.map((modelId, index) => ({
        catalogItemId: `test-${modelId}`,
        engine: "codex" as const,
        providerId: "openai" as const,
        providerLabel: "OpenAI",
        modelId,
        displayName: modelId,
        description: "",
        inputModalities: ["text"] as const,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        contextWindow: 200_000,
        maxContextWindow: null,
        supportsFastMode: false,
        supports1MContext: false,
        isDefault: index === 0,
        sortOrder: index + 1,
        runtimeProfileId: "native",
        transportModelId: null,
        fastTaskModelId: null,
        subagentModelId: null,
      })),
      // 目录校验要求每个引擎至少一个模型，这里固定补一个不会被断言的 claude 条目。
      {
        catalogItemId: "test-claude-default",
        engine: "claude" as const,
        providerId: "anthropic" as const,
        providerLabel: "Anthropic",
        modelId: "claude-test",
        displayName: "claude-test",
        description: "",
        inputModalities: ["text"] as const,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        contextWindow: 200_000,
        maxContextWindow: null,
        supportsFastMode: false,
        supports1MContext: false,
        isDefault: true,
        sortOrder: 1,
        runtimeProfileId: "native",
        transportModelId: null,
        fastTaskModelId: null,
        subagentModelId: null,
      },
    ],
  } as EngineModelCatalogSnapshot);
}

/** 读取指定表的总行数。 */
function countRows(harness: ReturnType<typeof createHarness>, table: "orch_intakes" | "orch_instances" | "orch_events"): number {
  const row = harness.db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

test("proposal 启动保存完整图且不重读 legacy 工作流或角色", async () => {
  const harness = createHarness();
  try {
    const { proposal } = createProposal(harness);
    (harness.db.orchWorkflows as any).get = () => { throw new Error("不应读取 legacy workflow"); };
    (harness.db.orchRoles as any).get = () => { throw new Error("不应读取 legacy role"); };

    const response = await startProposal(harness, proposal);
    const instance = harness.db.orchInstances.get(response.body.instanceId);

    assert.equal(response.status, 200);
    assert.deepEqual(harness.launchCalls, [`proposal:${harness.workspaceId}:${harness.workflow.id}`]);
    assert.equal(instance?.assetRuntimeSnapshot?.authorityMode, "legacy");
    assert.equal(instance?.assetRuntimeSnapshot?.workflow.source, null);
    assert.equal(instance?.assetRuntimeSnapshot?.roles["role-launch"]?.definition.name, "启动角色");
    assert.equal(Object.hasOwn(instance?.assetRuntimeSnapshot?.roles["role-launch"]?.definition ?? {}, "createdAt"), false);
    assert.equal(Object.hasOwn(instance?.roleSnapshots?.["role-launch"] ?? {}, "createdAt"), false);
    assert.equal(harness.db.orchEvents.listByInstance(instance!.id).length, 1);
    assert.deepEqual(harness.startedInstanceIds, [instance!.id]);
  } finally {
    harness.cleanup();
  }
});

test("定时启动按 workflow ID 解析并原子保存完整图", () => {
  const harness = createHarness();
  try {
    (harness.db.orchWorkflows as any).get = () => { throw new Error("不应读取 legacy workflow"); };
    (harness.db.orchRoles as any).get = () => { throw new Error("不应读取 legacy role"); };

    const result = createScheduledWorkflowInstance(harness.ctx, {
      workspaceId: harness.workspaceId,
      workflowId: harness.workflow.id,
      taskName: "每日资产任务",
      intake: { goal: "运行服务端工作流" },
    });
    const instance = harness.db.orchInstances.get(result.instanceId);

    assert.deepEqual(harness.launchCalls, [`scheduled:${harness.workspaceId}:${harness.workflow.id}`]);
    assert.equal(result.workflowName, harness.workflow.name);
    assert.equal(result.workflowVersion, harness.workflow.version);
    assert.equal(instance?.assetRuntimeSnapshot?.workflow.source?.authorityMode, "legacy");
    assert.equal(instance?.intakeSnapshot.requester?.source, "scheduled_task");
    assert.equal(countRows(harness, "orch_intakes"), 1);
    assert.equal(countRows(harness, "orch_instances"), 1);
    assert.equal(countRows(harness, "orch_events"), 1);
    assert.equal(harness.emittedEvents.length, 1);
  } finally {
    harness.cleanup();
  }
});

test("本机定时创建固定真实 workspace scope、actor 和实例 Profile，正文不能声明共享权威", () => {
  const harness = createHarness({ local: true });
  try {
    const result = createScheduledWorkflowInstance(harness.ctx, { workspaceId: harness.workspaceId,
      workflowId: harness.workflow.id, taskName: "本机流程",
      intake: { goal: "local", workspaceScope: { scopeType: "shared_workspace", scopeId: "foreign" }, requester: { userId: "foreign" } } as any });
    const instance = harness.db.orchInstances.get(result.instanceId, { strictScope: true });
    assert.deepEqual(instance?.intakeSnapshot.workspaceScope, { scopeType: "local_workspace", scopeId: harness.workspaceId });
    assert.equal(instance?.intakeSnapshot.requester?.userId, "local:local-client");
    assert.equal(instance?.runtimeConfig?.initiatorUserId, "local:local-client");
    assert.deepEqual(instance?.runtimeConfig?.executionProfileScope, { scopeType: "local_workspace", scopeId: harness.workspaceId });
    assert.equal(instance?.assetRuntimeSnapshot?.roles["role-launch"]?.definition.name, "启动角色");
    harness.ctx.workspaces.set(harness.workspaceId, path.join(os.tmpdir(), "different-hosted-directory"));
    assert.throws(() => createScheduledWorkflowInstance(harness.ctx, { workspaceId: harness.workspaceId,
      workflowId: harness.workflow.id, taskName: "bad workspace" }), { code: "SCHEDULED_TASK_LOCAL_SCOPE_INVALID" });
    assert.equal(countRows(harness, "orch_instances"), 1);
  } finally { harness.cleanup(); }
});

test("完整图解析失败发生在 proposal 确认和全部启动写入之前", async () => {
  const launchError = new Error("Server 启动资产读取失败");
  const harness = createHarness({ launchError });
  try {
    const { proposal } = createProposal(harness, { status: "draft", requiresConfirmation: false });
    const intakeCount = countRows(harness, "orch_intakes");

    await assert.rejects(() => startProposal(harness, proposal), (error) => error === launchError);
    assert.equal(harness.db.orchProposals.get(proposal.id)?.status, "draft");
    assert.equal(countRows(harness, "orch_intakes"), intakeCount);
    assert.equal(countRows(harness, "orch_instances"), 0);
    assert.equal(countRows(harness, "orch_events"), 0);

    assert.throws(
      () => createScheduledWorkflowInstance(harness.ctx, {
        workspaceId: harness.workspaceId,
        workflowId: harness.workflow.id,
        taskName: "失败定时任务",
      }),
      (error) => error === launchError,
    );
    assert.equal(countRows(harness, "orch_intakes"), intakeCount);
    assert.equal(countRows(harness, "orch_instances"), 0);
    assert.equal(countRows(harness, "orch_events"), 0);
  } finally {
    harness.cleanup();
  }
});

test("启动事件写入失败回滚 proposal 确认、Intake 和实例", async () => {
  const harness = createHarness();
  try {
    const { proposal } = createProposal(harness, { status: "draft", requiresConfirmation: false });
    const intakeCount = countRows(harness, "orch_intakes");
    const eventError = new Error("启动事件写入失败");
    (harness.db.orchEvents as any).append = () => { throw eventError; };

    await assert.rejects(() => startProposal(harness, proposal), (error) => error === eventError);
    assert.equal(harness.db.orchProposals.get(proposal.id)?.status, "draft");
    assert.equal(countRows(harness, "orch_instances"), 0);

    assert.throws(
      () => createScheduledWorkflowInstance(harness.ctx, {
        workspaceId: harness.workspaceId,
        workflowId: harness.workflow.id,
        taskName: "事务失败定时任务",
      }),
      (error) => error === eventError,
    );
    assert.equal(countRows(harness, "orch_intakes"), intakeCount);
    assert.equal(countRows(harness, "orch_instances"), 0);
    assert.equal(countRows(harness, "orch_events"), 0);
  } finally {
    harness.cleanup();
  }
});

test("定时启动把流程级模型配置冻结为强制引擎与角色覆盖", () => {
  const harness = createHarness();
  try {
    applyTestEngineModelCatalog(["gpt-5.2-codex"]);
    harness.db.orchWorkflowExecutionDefaults.upsert({
      workspaceId: harness.workspaceId,
      workflowId: harness.workflow.id,
      engine: "codex",
      model: "gpt-5.2-codex",
      updatedByUserId: "user-1",
    });

    const result = createScheduledWorkflowInstance(harness.ctx, {
      workspaceId: harness.workspaceId,
      workflowId: harness.workflow.id,
      taskName: "流程级模型任务",
    });
    const instance = harness.db.orchInstances.get(result.instanceId);

    assert.equal(instance?.runtimeConfig?.executionEngineStrategy, "force-codex");
    assert.deepEqual(instance?.runtimeConfig?.roleExecutionOverrides?.["role-launch"], {
      engine: "codex",
      model: "gpt-5.2-codex",
    });
  } finally {
    harness.cleanup();
  }
});

test("proposal 启动时手工角色模型覆盖优先于流程级默认", async () => {
  const harness = createHarness();
  try {
    applyTestEngineModelCatalog(["gpt-5.2-codex", "manual-model"]);
    harness.db.orchWorkflowExecutionDefaults.upsert({
      workspaceId: harness.workspaceId,
      workflowId: harness.workflow.id,
      engine: "codex",
      model: "gpt-5.2-codex",
    });
    const { proposal } = createProposal(harness);

    const response = await startProposal(harness, proposal, {
      roleExecutionOverrides: { "role-launch": { model: "manual-model" } },
    });
    const instance = harness.db.orchInstances.get(response.body.instanceId);

    assert.equal(response.status, 200);
    assert.equal(instance?.runtimeConfig?.executionEngineStrategy, "force-codex");
    assert.deepEqual(instance?.runtimeConfig?.roleExecutionOverrides?.["role-launch"], {
      engine: "codex",
      model: "manual-model",
    });
  } finally {
    harness.cleanup();
  }
});

test("流程级模型已从目录移除时定时启动显式失败且不落库", () => {
  const harness = createHarness();
  try {
    applyTestEngineModelCatalog(["gpt-5.2-codex"]);
    harness.db.orchWorkflowExecutionDefaults.upsert({
      workspaceId: harness.workspaceId,
      workflowId: harness.workflow.id,
      engine: "codex",
      model: "removed-model",
    });

    assert.throws(
      () => createScheduledWorkflowInstance(harness.ctx, {
        workspaceId: harness.workspaceId,
        workflowId: harness.workflow.id,
        taskName: "失效模型任务",
      }),
      /removed-model/,
    );
    assert.equal(countRows(harness, "orch_instances"), 0);
    assert.equal(countRows(harness, "orch_events"), 0);
  } finally {
    harness.cleanup();
  }
});

test("本次显式指定另一套引擎时流程级模型配置整体让位", async () => {
  const harness = createHarness();
  try {
    applyTestEngineModelCatalog(["gpt-5.2-codex"]);
    harness.db.orchWorkflowExecutionDefaults.upsert({
      workspaceId: harness.workspaceId,
      workflowId: harness.workflow.id,
      engine: "codex",
      model: "gpt-5.2-codex",
    });
    const { proposal } = createProposal(harness);

    const response = await startProposal(harness, proposal, { executionEngineStrategy: "force-claude" });
    const instance = harness.db.orchInstances.get(response.body.instanceId);

    assert.equal(response.status, 200);
    assert.equal(instance?.runtimeConfig?.executionEngineStrategy, "force-claude");
    assert.equal(instance?.runtimeConfig?.roleExecutionOverrides?.["role-launch"], undefined);
  } finally {
    harness.cleanup();
  }
});

test("非法角色覆盖在流程级配置存在时仍被显式拒绝且不落库", async () => {
  const harness = createHarness();
  try {
    applyTestEngineModelCatalog(["gpt-5.2-codex"]);
    harness.db.orchWorkflowExecutionDefaults.upsert({
      workspaceId: harness.workspaceId,
      workflowId: harness.workflow.id,
      engine: "codex",
      model: "gpt-5.2-codex",
    });
    const { proposal } = createProposal(harness);

    const response = await startProposal(harness, proposal, { roleExecutionOverrides: [] });

    assert.equal(response.status, 400);
    assert.match(String(response.body.message ?? ""), /roleExecutionOverrides/);
    assert.equal(countRows(harness, "orch_instances"), 0);
  } finally {
    harness.cleanup();
  }
});
