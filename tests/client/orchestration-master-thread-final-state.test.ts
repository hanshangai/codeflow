import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  OrchestrationInstance,
  TaskIntake,
  ThreadSummary,
  ThreadId,
  WorkflowDefinition,
  WorkflowProposal,
  WorkspaceId,
} from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { handleOrchInstancesStart } from "../../apps/desktop/client/src/app/handlers/orchestrationHandlers.ts";
import { handleThreadsList, handleThreadsLoad, handleThreadsSummary } from "../../apps/desktop/client/src/app/handlers/threadHandlers.ts";

function createWorkflow(workspaceId: WorkspaceId): WorkflowDefinition {
  return {
    id: "wf-standard" as any,
    workspaceId,
    family: "feature-dev",
    name: "CodeFlow 标准功能开发",
    description: "标准流程",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "prd", type: "role", roleId: "role-prd" as any, label: "需求分析", position: { x: 160, y: 0 }, inputBindings: [] },
      { id: "end", type: "end", label: "结束", position: { x: 320, y: 0 } },
    ],
    edges: [
      { id: "start-prd", sourceNodeId: "start", targetNodeId: "prd", dataMappings: [] },
      { id: "prd-end", sourceNodeId: "prd", targetNodeId: "end", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createIntake(workspaceId: WorkspaceId): TaskIntake {
  return {
    id: "intake-1" as any,
    workspaceId,
    triggerMode: "manual",
    taskType: "feature",
    title: "鲜花市场首页",
    goal: "实现鲜花市场首页",
    background: null,
    acceptanceCriteria: [{ id: "ac-1", text: "首页可展示主要内容", blocking: true }],
    workbenchItemRefs: null,
    seedArtifactRefs: null,
    constraints: { requireUserConfirmation: true, nodeApprovalMode: "manual" },
    requester: { source: "ui" },
    createdAt: 1,
    updatedAt: 1,
  };
}

function createProposal(workspaceId: WorkspaceId, workflow: WorkflowDefinition, intake: TaskIntake): WorkflowProposal {
  return {
    id: "proposal-1" as any,
    workspaceId,
    intakeId: intake.id,
    intakeSnapshot: intake,
    status: "confirmed",
    recommendedFamily: workflow.family ?? "feature-dev",
    rationale: "使用用户选定工作流固化本次执行方案",
    draftWorkflow: workflow,
    draftRoleBindings: [{ nodeId: "prd", roleId: "role-prd" as any }],
    draftKnowledgeBindings: [],
    warnings: [],
    requiresConfirmation: true,
    confirmedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("handleOrchInstancesStart no longer creates orchestration master thread", async () => {
  const workspaceId = "ws-start-instance" as WorkspaceId;
  const workflow = createWorkflow(workspaceId);
  const intake = createIntake(workspaceId);
  const proposal = createProposal(workspaceId, workflow, intake);
  let createdInstanceInput: Record<string, unknown> | null = null;
  let apiResponse: any = null;
  let startedInstanceId: string | null = null;

  const ctx = {
    workspaces: new Map([[workspaceId, process.cwd()]]),
    db: {
      db: {
        transaction<T extends (...args: any[]) => any>(fn: T): T {
          return fn;
        },
      },
      orchProposals: {
        get(id: string) {
          return id === proposal.id ? proposal : null;
        },
        confirm() {
          throw new Error("confirmed proposal should not be confirmed again");
        },
      },
      orchInstances: {
        listByWorkspace() {
          return [];
        },
        create(input: Record<string, unknown>) {
          createdInstanceInput = input;
          return {
            id: "instance-1",
            workspaceId,
            workflowId: workflow.id,
            proposalId: proposal.id,
            intakeSnapshot: intake,
            workflowSnapshot: workflow,
            roleSnapshots: {},
            toolsetSnapshots: {},
            runtimeConfig: input.runtimeConfig ?? null,
            artifactIndex: {},
            masterThreadId: null,
            status: "pending",
            nodeStates: {
              start: { nodeId: "start", status: "pending", retryCount: 0 },
              prd: { nodeId: "prd", status: "pending", retryCount: 0 },
              end: { nodeId: "end", status: "pending", retryCount: 0 },
            },
            createdAt: 1,
            updatedAt: 1,
          } satisfies OrchestrationInstance;
        },
      },
      orchRoles: {
        get() {
          return null;
        },
      },
      orchEvents: {
        append() {},
      },
      orchWorkflowExecutionDefaults: {
        get() {
          return null;
        },
      },
      threads: {
        create() {
          throw new Error("master thread should not be created");
        },
        updatePrefs() {
          throw new Error("master thread prefs should not be updated");
        },
      },
    },
    orchAssetLaunchSnapshot: {
      createFromWorkflow(_runtimeWorkspaceId: WorkspaceId, frozenWorkflow: WorkflowDefinition) {
        return {
          authorityMode: "legacy",
          workflow: { assetType: "workflow", assetId: frozenWorkflow.id, definition: frozenWorkflow, source: null },
          roles: {
            "role-prd": {
              assetType: "role",
              assetId: "role-prd",
              definition: {
                id: "role-prd",
                workspaceId,
                name: "需求分析",
                executionConfig: { preferredEngine: "codex", engineProfiles: { codex: { enabled: true } } },
              },
              source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 },
            },
          },
          knowledgeBundles: {},
          toolsets: {},
          skills: {},
        };
      },
    },
    threads: {
      create() {
        throw new Error("runtime master thread should not be created");
      },
    },
    orchEngine: {
      start(instanceId: string) {
        startedInstanceId = instanceId;
        return Promise.resolve();
      },
      async startInBackground(instanceId: string) {
        startedInstanceId = instanceId;
      },
    },
    send(message: unknown) {
      apiResponse = message;
    },
  } as any;

  await handleOrchInstancesStart(ctx, {
    t: "api.req",
    id: "req-start-instance",
    method: "orch.instances.start",
    path: "/orch/instances/start",
    body: {
      workspaceId,
      proposalId: proposal.id,
      executionEngineStrategy: "follow-role",
    },
  } as any);

  assert.ok(createdInstanceInput);
  assert.equal("masterThreadId" in createdInstanceInput!, false);
  assert.equal(startedInstanceId, "instance-1");
  assert.equal(apiResponse?.status, 200);
  assert.equal(apiResponse?.body?.instanceId, "instance-1");
});

test("handleThreadsList hides legacy orchestration master threads", () => {
  const workspaceId = "ws-thread-list" as WorkspaceId;
  const visibleNodeId = "orch-node-1" as ThreadId;
  const hiddenMasterId = "orch-master-legacy" as ThreadId;
  let apiResponse: any = null;

  const threads: ThreadSummary[] = [
    {
      id: hiddenMasterId,
      title: "[编排主线程] CodeFlow 标准功能开发",
      threadType: "orchestration",
      threadSubtype: "master",
      archived: false,
      createdAt: 3,
      updatedAt: 3,
      engine: "codex",
    },
    {
      id: visibleNodeId,
      title: "[编排节点] 需求分析",
      threadType: "orchestration",
      threadSubtype: "node",
      archived: false,
      createdAt: 2,
      updatedAt: 2,
      engine: "codex",
    },
    {
      id: "chat-1" as ThreadId,
      title: "普通会话",
      threadType: "chat",
      threadSubtype: null,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      engine: "claude",
    },
  ];

  handleThreadsList({
    workspaces: new Map([[workspaceId, process.cwd()]]),
    db: {
      db: {
        transaction<T extends (...args: any[]) => any>(fn: T): T {
          return fn;
        },
      },
      threads: {
        listActiveChatWorkflows() {
          return [];
        },
        listByWorkspace() {
          return {
            threads,
            hasMore: false,
            nextCursor: null,
          };
        },
      },
      turns: {
        listRunningByWorkspace() {
          return {
            [hiddenMasterId]: { runningTurnId: "turn-master", runningTurnStartedAt: 100 },
            [visibleNodeId]: { runningTurnId: "turn-node", runningTurnStartedAt: 200 },
            "chat-1": { runningTurnId: "turn-chat", runningTurnStartedAt: 300 },
          };
        },
      },
    },
    send(message: unknown) {
      apiResponse = message;
    },
  } as any, {
    t: "api.req",
    id: "req-list-threads",
    method: "threads.list",
    path: "/threads/list",
    body: { workspaceId, includeArchived: true },
  } as any);

  assert.equal(apiResponse?.status, 200);
  assert.deepEqual(
    apiResponse?.body?.threads?.map((item: ThreadSummary) => item.id),
    [visibleNodeId, "chat-1"],
  );
  assert.deepEqual(
    Object.keys(apiResponse?.body?.runningByThreadId ?? {}).sort(),
    ["chat-1", visibleNodeId].sort(),
  );
});

test("handleThreadsList exposes runtime active running state when turn index is empty", () => {
  const workspaceId = "ws-thread-list-runtime-running" as WorkspaceId;
  const threadId = "thread-runtime-list" as ThreadId;
  let apiResponse: any = null;

  handleThreadsList({
    workspaces: new Map([[workspaceId, process.cwd()]]),
    db: {
      db: {
        transaction<T extends (...args: any[]) => any>(fn: T): T {
          return fn;
        },
      },
      threads: {
        listActiveChatWorkflows() {
          return [];
        },
        listByWorkspace() {
          return {
            threads: [
              {
                id: threadId,
                title: "运行中会话",
                threadType: "chat",
                threadSubtype: null,
                archived: false,
                createdAt: 1,
                updatedAt: 2,
                engine: "codex",
              },
            ],
            hasMore: false,
            nextCursor: null,
          };
        },
      },
      turns: {
        listRunningByWorkspace() {
          return {};
        },
      },
    },
    getActiveThreadTurn(input: { workspaceId?: WorkspaceId | null; threadId: ThreadId }) {
      assert.equal(input.workspaceId, workspaceId);
      assert.equal(input.threadId, threadId);
      return { turnId: "turn-runtime-list" as any, startedAt: 456, source: "runtime" };
    },
    send(message: unknown) {
      apiResponse = message;
    },
  } as any, {
    t: "api.req",
    id: "req-list-runtime-running",
    method: "threads.list",
    path: "/threads/list",
    body: { workspaceId },
  } as any);

  assert.equal(apiResponse?.status, 200);
  assert.deepEqual(apiResponse?.body?.runningByThreadId, {
    [threadId]: {
      runningTurnId: "turn-runtime-list",
      runningTurnStartedAt: 456,
      runningSource: "runtime",
    },
  });
});

test("handleThreadsLoad exposes runtime active running state when turn index is empty", async () => {
  const workspaceId = "ws-thread-load-runtime-running" as WorkspaceId;
  const threadId = "thread-runtime-load" as ThreadId;
  let apiResponse: any = null;

  await handleThreadsLoad({
    workspaces: new Map([[workspaceId, process.cwd()]]),
    db: {
      db: {
        transaction<T extends (...args: any[]) => any>(fn: T): T {
          return fn;
        },
      },
      threads: {
        get(id: ThreadId) {
          if (id !== threadId) return null;
          return {
            id: threadId,
            workspaceId,
            title: "运行中会话",
            threadType: "chat",
            threadSubtype: null,
            archived: false,
            pinnedAt: null,
            createdAt: 1,
            updatedAt: 2,
            engine: "codex",
            sessionId: null,
            model: null,
            effort: null,
            accessMode: null,
            planMode: false,
            autoCompactPct: null,
            contextWindow: null,
            serviceTier: null,
            roleId: null,
          };
        },
      },
      conversationEvents: {
        listByThreadForReplay(id: ThreadId) {
          assert.equal(id, threadId);
          return { events: [], hasMore: false };
        },
        /** 删除事实独立于历史分页窗口返回。 */
        listDeletedMessageIds() { return []; },
      },
      turns: {
        listRunningByWorkspace() {
          return {};
        },
        hasAnyByThread(id: ThreadId) {
          assert.equal(id, threadId);
          return false;
        },
      },
      threadDrafts: {
        get(id: ThreadId) {
          assert.equal(id, threadId);
          return null;
        },
      },
    },
    getActiveThreadTurn(input: { workspaceId?: WorkspaceId | null; threadId: ThreadId }) {
      assert.equal(input.workspaceId, workspaceId);
      assert.equal(input.threadId, threadId);
      return { turnId: "turn-runtime-load" as any, startedAt: 789, source: "runtime" };
    },
    send(message: unknown) {
      apiResponse = message;
    },
  } as any, {
    t: "api.req",
    id: "req-load-runtime-running",
    method: "threads.load",
    path: "/threads/load",
    body: { workspaceId, threadId, limit: 50 },
  } as any);

  assert.equal(apiResponse?.status, 200);
  assert.deepEqual(apiResponse?.body?.running, {
    runningTurnId: "turn-runtime-load",
    runningTurnStartedAt: 789,
    runningSource: "runtime",
  });
});

test("handleThreadsSummary reads running state from thread turn index", () => {
  const workspaceId = "ws-thread-summary" as WorkspaceId;
  const threadId = "thread-summary-1" as ThreadId;
  let apiResponse: any = null;

  handleThreadsSummary({
    workspaces: new Map([[workspaceId, process.cwd()]]),
    db: {
      db: {
        transaction<T extends (...args: any[]) => any>(fn: T): T {
          return fn;
        },
      },
      threads: {
        get(id: ThreadId) {
          if (id !== threadId) return null;
          return {
            id: threadId,
            workspaceId,
            title: "普通会话",
            threadType: "chat",
            threadSubtype: null,
            archived: false,
            createdAt: 1,
            updatedAt: 2,
            engine: "codex",
          };
        },
      },
      turns: {
        listRunningByWorkspace(id: WorkspaceId) {
          assert.equal(id, workspaceId);
          return {
            [threadId]: {
              runningTurnId: "turn-running" as any,
              runningTurnStartedAt: 123,
            },
          };
        },
      },
    },
    send(message: unknown) {
      apiResponse = message;
    },
  } as any, {
    t: "api.req",
    id: "req-summary-thread",
    method: "threads.summary",
    path: "/threads/summary",
    body: { workspaceId, threadId },
  } as any);

  assert.equal(apiResponse?.status, 200);
  assert.deepEqual(apiResponse?.body?.running, {
    runningTurnId: "turn-running",
    runningTurnStartedAt: 123,
  });
});

test("orch instance repo persists null masterThreadId for new instances", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-orch-instance-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-instance-repo" as WorkspaceId;

  try {
    const db = openClientDb({ dbPath });
    try {
      db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
      const workflow = createWorkflow(workspaceId);
      const intake = createIntake(workspaceId);
      const created = db.orchInstances.create({
        workspaceId,
        workflowId: workflow.id,
        workflowSnapshot: workflow,
        intakeSnapshot: intake,
        roleSnapshots: {},
        toolsetSnapshots: {},
        runtimeConfig: null,
        artifactIndex: {},
      });

      const loaded = db.orchInstances.get(created.id);
      assert.equal(created.masterThreadId, null);
      assert.equal(loaded?.masterThreadId ?? null, null);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

