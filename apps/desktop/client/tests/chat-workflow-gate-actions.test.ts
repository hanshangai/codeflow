import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ThreadId, WorkflowId, WorkspaceId } from "@codeflowai/shared";

import type { ApiHandlerContext } from "../src/app/handleApiRequest.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { ChatWorkflowService } from "../src/orchestration/chatWorkflowService.ts";

const WORKSPACE_ID = "ws-gate-actions" as WorkspaceId;
const THREAD_ID = "chat-gate-actions" as ThreadId;
const WORKFLOW_ID = "workflow-gate-actions" as WorkflowId;
const ACTOR = "owner";

const WORKFLOW_SNAPSHOT = {
  id: WORKFLOW_ID,
  workspaceId: "",
  name: "TDD 流程",
  description: "",
  family: "feature-dev",
  version: 1,
  nodes: [
    { id: "e2e", type: "role", roleId: "role-e2e", label: "E2E 集成测试节点", position: { x: 0, y: 0 } },
    { id: "git", type: "role", roleId: "role-git", label: "代码提交", position: { x: 0, y: 60 } },
  ],
  edges: [{ id: "edge-e2e-git", sourceNodeId: "e2e", targetNodeId: "git", dataMappings: [] }],
};

/** 装配真实 SQLite + 会话工作流服务，并暴露把节点置为「门禁未过」的入口。 */
function createHarness(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-gate-"));
  const db = openClientDb({ dbPath: path.join(directory, "test.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.workspaces.upsert({ id: WORKSPACE_ID, title: "gate", path: directory });
  db.threads.create({ id: THREAD_ID, workspaceId: WORKSPACE_ID, engine: "codex", title: "gate" });

  // 推荐时必须能解析出启动快照，否则会话工作流服务会以资产不可用拒绝建卡。
  const asset = {
    authorityMode: "legacy" as const,
    workflow: {
      assetId: WORKFLOW_ID,
      assetType: "workflow",
      source: { authorityMode: "legacy" as const, createdAt: 1, updatedAt: 1 },
      definition: { ...WORKFLOW_SNAPSHOT, workspaceId: WORKSPACE_ID },
    },
    roles: {},
    knowledgeBundles: {},
    toolsets: {},
    skills: {},
  };
  const ctx = {
    db,
    workspaces: new Map([[WORKSPACE_ID, directory]]),
    sessions: { hasActiveTurn: () => false },
    orchAssetLaunchSnapshot: { createFromWorkflowId: () => asset, createFromWorkflow: () => asset },
    orchEngine: { start: async () => {} },
    send: () => {},
  } as unknown as ApiHandlerContext;
  const service = new ChatWorkflowService(ctx);
  service.repo.setEnabled(THREAD_ID, true);

  /** 建卡并绑定实例，然后按 kind 设置节点状态。 */
  const linkNode = (kind: "gate" | "feedback") => {
    const task = service.recommend({
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: "turn-1", actorUserId: ACTOR, workflowId: WORKFLOW_ID,
      title: "门禁动作验证", goal: "验证门禁待办提供忽略入口", context: "", rationale: "门禁卡住时需要人工放行",
      acceptanceCriteria: ["门禁未过时可忽略并继续"],
    }).task;
    const instance = db.orchInstances.create({
      workspaceId: WORKSPACE_ID, workflowId: WORKFLOW_ID, workflowSnapshot: WORKFLOW_SNAPSHOT as never,
      intakeSnapshot: { id: "intake-gate", workspaceId: WORKSPACE_ID, triggerMode: "manual", taskType: "feature", title: "门禁动作验证", goal: "验证门禁待办提供忽略入口" } as never,
    });
    db.orchInstances.updateNodeStates(instance.id, {
      e2e: {
        nodeId: "e2e", status: "waiting-feedback", retryCount: 0, assigneeUserIds: [], completedAt: null,
        ...(kind === "gate"
          ? {
              humanActionSource: "gate",
              error: "门禁未通过: e2e-runtime-precheck(正则不匹配: 运行态前置)",
              gateResults: [{ criterionId: "e2e-runtime-precheck", passed: false, outcome: "fail", evaluatorKind: "deterministic", message: "正则不匹配: 运行态前置" }],
            }
          : { humanActionSource: "human_input" }),
      },
      git: { nodeId: "git", status: "pending", retryCount: 0, assigneeUserIds: [], completedAt: null },
    } as never);
    db.orchInstances.updateStatus(instance.id, "waiting-feedback");
    service.repo.linkInstance(task.id, instance.id);
    return service.view(service.repo.get(task.id)!, ACTOR);
  };

  return { db, service, linkNode };
}

test("门禁未过的待办提供「重新评估门禁」与「忽略门禁继续」", (t) => {
  const { service, linkNode } = createHarness(t);
  linkNode("gate");

  const todo = service.snapshot(WORKSPACE_ID, THREAD_ID, ACTOR).tasks[0]!.todos[0]!;
  assert.equal(todo.nodeId, "e2e");
  assert.deepEqual(todo.actions.map((action) => action.action), ["reevaluate_gates", "override", "resume_with_input"]);
  assert.equal(todo.actions.find((action) => action.action === "override")?.label, "忽略门禁继续");
  assert.match(todo.actions.find((action) => action.action === "override")?.effect ?? "", /忽略门禁未通过结果/u);
});

test("非门禁的等待反馈待办仍只提供「补充并继续」，不出现忽略门禁入口", (t) => {
  const { service, linkNode } = createHarness(t);
  linkNode("feedback");

  const todo = service.snapshot(WORKSPACE_ID, THREAD_ID, ACTOR).tasks[0]!.todos[0]!;
  assert.deepEqual(todo.actions.map((action) => action.action), ["resume_with_input"]);
});

test("动作白名单只认待办里给出的动作：门禁动作不能提交到非门禁待办", async (t) => {
  const { service, linkNode } = createHarness(t);
  const view = linkNode("feedback");
  const todo = view.todos[0]!;

  await assert.rejects(
    service.action({
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, taskId: view.task.id, requestId: "req-1",
      expectedVersion: view.task.version,
      action: "feedback", nodeId: todo.nodeId, nodeVersion: todo.version, feedbackAction: "override",
    }, ACTOR),
    (error: unknown) => (error as { code?: string }).code === "CHAT_WORKFLOW_TODO_EXPIRED",
  );
});
