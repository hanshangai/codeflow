import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OrchestrationId, ThreadId, WorkflowId, WorkspaceId } from "@codeflowai/shared";

import type { ApiHandlerContext } from "../src/app/handleApiRequest.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { resetOrchCurrentDefinitionLabelLogDedupeForTest } from "../src/orchestration/orchCurrentDefinitionLabels.ts";
import type { OrchAssetAuthorityRuntimeReadService } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.ts";
import { ChatWorkflowService } from "../src/orchestration/chatWorkflowService.ts";

const WORKFLOW_ID = "workflow-label" as WorkflowId;

/** 冻结快照：改名前的流程名与节点名。 */
const FROZEN_WORKFLOW = {
  id: WORKFLOW_ID,
  workspaceId: "",
  name: "旧流程名",
  description: "冻结快照",
  family: "feature-dev",
  version: 1,
  nodes: [
    { id: "dev", type: "role", roleId: "role-dev", label: "开发", position: { x: 0, y: 0 } },
    { id: "review", type: "role", roleId: "role-review", label: "审核", position: { x: 0, y: 60 } },
  ],
  edges: [{ id: "edge-dev-review", sourceNodeId: "dev", targetNodeId: "review", dataMappings: [] }],
};

/** 当前定义：改名后的流程名与节点名。 */
const CURRENT_WORKFLOW = {
  ...FROZEN_WORKFLOW,
  name: "新流程名",
  nodes: FROZEN_WORKFLOW.nodes.map((item) => ({ ...item, label: `新${item.label}` })),
};

/**
 * 打开真实 Client SQLite 并装配会话工作流服务。
 * withCurrentDefinition=false 时不装配资产运行读取，用于验证降级分支仍显示冻结快照名。
 */
function createHarness(t: test.TestContext, withCurrentDefinition = true) {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-current-label-"));
  const db = openClientDb({ dbPath: path.join(directory, "test.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "ws-current-label" as WorkspaceId;
  const threadId = "chat-current-label" as ThreadId;
  db.workspaces.upsert({ id: workspaceId, title: "current-label", path: directory });
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "current-label" });
  const frozen = { ...FROZEN_WORKFLOW, workspaceId } as never;
  const asset = {
    authorityMode: "legacy",
    workflow: { assetId: WORKFLOW_ID, assetType: "workflow", source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 }, definition: frozen },
    roles: {}, knowledgeBundles: {}, toolsets: {}, skills: {},
  };
  const currentRead = {
    openWorkspace: () => ({
      authorityMode: "legacy" as const,
      listAssets: () => [],
      getServerReadinessRequirement: () => null,
      getAsset: () => ({
        assetType: "workflow",
        assetId: WORKFLOW_ID,
        definition: { ...CURRENT_WORKFLOW, workspaceId },
        source: { authorityMode: "legacy" as const, createdAt: 1, updatedAt: 1 },
      }),
    }),
  } as unknown as OrchAssetAuthorityRuntimeReadService;
  const ctx = {
    db,
    workspaces: new Map([[workspaceId, directory]]),
    sessions: { hasActiveTurn: () => false },
    orchAssetLaunchSnapshot: { createFromWorkflowId: () => asset, createFromWorkflow: () => asset },
    ...(withCurrentDefinition ? { orchAssetRuntimeRead: currentRead } : {}),
    orchEngine: { start: async () => {} },
    send: () => {},
  } as unknown as ApiHandlerContext;
  const service = new ChatWorkflowService(ctx);
  service.repo.setEnabled(threadId, true);

  /** 推荐一条任务并关联一个已改名工作流的运行中实例。 */
  const linkRunningInstance = () => {
    const task = service.recommend({
      workspaceId, threadId, turnId: "turn-1", actorUserId: "owner", workflowId: WORKFLOW_ID,
      title: "改名验证", goal: "验证展示层取当前定义", context: "", rationale: "节点名需要跟随当前定义",
      acceptanceCriteria: ["卡片显示新节点名"],
    }).task;
    const instance = db.orchInstances.create({
      workspaceId, workflowId: WORKFLOW_ID, workflowSnapshot: frozen as never,
      intakeSnapshot: { id: "intake-current-label", workspaceId, triggerMode: "manual", taskType: "feature", title: "改名验证", goal: "验证展示层取当前定义" } as never,
    });
    db.orchInstances.updateNodeStates(instance.id, {
      dev: { nodeId: "dev", status: "waiting-feedback", retryCount: 0, assigneeUserIds: [], completedAt: null },
      review: { nodeId: "review", status: "pending", retryCount: 0, assigneeUserIds: [], completedAt: null },
    });
    db.orchInstances.updateStatus(instance.id, "waiting-feedback");
    // 执行事件里冻结的仍是旧节点名，用于验证卡片动态文案按 nodeId 取当前定义。
    db.orchEvents.append({
      instanceId: instance.id, nodeId: "dev", type: "orchestration.nodeStateChanged",
      payloadJson: JSON.stringify({ instanceId: instance.id, nodeId: "dev", nodeLabel: "开发", status: "completed" }),
    } as never);
    return { linked: service.repo.linkInstance(task.id, instance.id), instanceId: instance.id };
  };
  return { db, service, workspaceId, threadId, linkRunningInstance };
}

/** 读取落库的 task_json，用于确认展示替换没有写回冻结事实。 */
function readStoredTaskJson(db: ReturnType<typeof openClientDb>, taskId: string) {
  const row = db.db.prepare("SELECT task_json FROM chat_workflow_tasks WHERE id = ?").get(taskId) as { task_json: string } | undefined;
  return JSON.parse(row!.task_json) as { workflow: { name: string; nodes: Array<{ label: string }> } };
}

test("会话卡片按 nodeId 显示当前定义的流程名与节点名", (t) => {
  const h = createHarness(t);
  const { linked } = h.linkRunningInstance();

  const view = h.service.view(linked, "owner");

  assert.deepEqual(view.stages.map((stage) => stage.label), ["新开发", "新审核"]);
  assert.equal(view.todos.length, 1);
  assert.equal(view.todos[0]!.label, "新开发");
  assert.deepEqual(view.todos[0]!.branches.map((branch) => branch.label), ["新审核"]);
  assert.equal(view.task.workflow.name, "新流程名");
  assert.deepEqual(view.task.workflow.nodes.map((node) => node.label), ["新开发", "新审核"]);
  assert.deepEqual(view.updates.map((update) => update.text), ["新开发：阶段完成"], "执行动态文案同样按 nodeId 取当前定义名");

  // 冻结事实与落库任务不得被就地改写。
  assert.equal(linked.workflow.name, "旧流程名");
  assert.deepEqual(linked.workflow.nodes.map((node) => node.label), ["开发", "审核"]);
  const snapshot = h.db.orchInstances.get(linked.instanceId as OrchestrationId)!.workflowSnapshot;
  assert.equal(snapshot.name, "旧流程名");
  assert.deepEqual(snapshot.nodes.map((node) => node.label), ["开发", "审核"]);
  const stored = readStoredTaskJson(h.db, linked.id);
  assert.equal(stored.workflow.name, "旧流程名");
  assert.deepEqual(stored.workflow.nodes.map((node) => node.label), ["开发", "审核"]);
  // 事件落库事实不得被改写。
  const storedEvent = h.db.db.prepare("SELECT payload_json FROM orch_events WHERE instance_id = ?").get(String(linked.instanceId)) as { payload_json: string };
  assert.equal((JSON.parse(storedEvent.payload_json) as { nodeLabel: string }).nodeLabel, "开发");
});

test("未装配资产运行读取时卡片保留冻结快照名，且不复制任务对象", (t) => {
  const h = createHarness(t, false);
  const { linked } = h.linkRunningInstance();

  const view = h.service.view(linked, "owner");

  assert.deepEqual(view.stages.map((stage) => stage.label), ["开发", "审核"]);
  assert.deepEqual(view.todos[0]!.branches.map((branch) => branch.label), ["审核"]);
  assert.deepEqual(view.updates.map((update) => update.text), ["开发：阶段完成"], "读不到当前定义时动态文案保留冻结旧名");
  assert.equal(view.task.workflow.name, "旧流程名");
  assert.equal(view.task, linked, "读不到当前定义时不得复制任务对象");
  assert.deepEqual(readStoredTaskJson(h.db, linked.id).workflow.nodes.map((node) => node.label), ["开发", "审核"]);
});
