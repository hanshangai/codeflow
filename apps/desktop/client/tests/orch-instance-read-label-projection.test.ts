import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { IntakeId, OrchestrationId, WorkflowId, WorkspaceId } from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import {
  handleOrchInstancesGet,
  handleOrchInstancesList,
  handleOrchInstancesRuntimePatch,
  handleOrchPendingMineList,
} from "../src/app/handlers/orchestrationHandlers.ts";
import { handleReminderItemsList } from "../src/app/handlers/reminderHandlers.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { logger } from "../src/logger.ts";
import { resetOrchCurrentDefinitionLabelLogDedupeForTest } from "../src/orchestration/orchCurrentDefinitionLabels.ts";
import type { OrchAssetAuthorityRuntimeReadService } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.ts";

const WORKSPACE_ID = "ws-read-labels" as WorkspaceId;

/** 当前定义：与冻结快照同 nodeId，节点名带“新”前缀。 */
const CURRENT_LABELS: Record<string, { name: string; labels: Record<string, string> }> = {
  "workflow-label": { name: "新流程名", labels: { dev: "新开发", review: "新审核" } },
  // 当前定义里 review 已被删除，用于验证缺失节点回退旧名。
  "workflow-partial": { name: "新流程名", labels: { dev: "新开发" } },
  // 冻结节点名带前导空格。
  "workflow-spaced": { name: "新流程名", labels: { dev: "新开发" } },
};

/** 构造按 workflowId 返回改名后定义的资产读取替身。 */
function createCurrentDefinitionReader() {
  return {
    openWorkspace: () => ({
      authorityMode: "legacy" as const,
      listAssets: () => [],
      getServerReadinessRequirement: () => null,
      getAsset: (_assetType: string, assetId: string) => {
        const current = CURRENT_LABELS[assetId];
        if (!current) return null;
        return {
          assetType: "workflow",
          assetId,
          definition: {
            id: assetId, name: current.name, description: "", edges: [], version: 2,
            nodes: Object.entries(current.labels).map(([id, label]) => ({ id, type: "role", label, position: { x: 0, y: 0 } })),
          },
          source: { authorityMode: "legacy" as const, createdAt: 1, updatedAt: 2 },
        };
      },
    }),
  } as unknown as OrchAssetAuthorityRuntimeReadService;
}

/** 打开真实 Client SQLite，装配只替换资产读取的 Handler 上下文。 */
function createHarness(t: test.TestContext) {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orch-read-labels-"));
  const db = openClientDb({ dbPath: path.join(directory, "test.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.workspaces.upsert({ id: WORKSPACE_ID, title: "read-labels", path: directory });
  const responses: any[] = [];
  const ctx = {
    db,
    workspaces: new Map([[WORKSPACE_ID, directory]]),
    orchAssetRuntimeRead: createCurrentDefinitionReader(),
    send: (message: unknown) => responses.push(message),
  } as unknown as ApiHandlerContext;
  return {
    db,
    ctx,
    call(handler: (ctx: ApiHandlerContext, req: ApiRequestMessage) => unknown, id: string, body: Record<string, unknown>) {
      responses.length = 0;
      handler(ctx, { id, method: "test", path: "/test", body } as ApiRequestMessage);
      return responses.find((response) => response.id === id)?.body ?? null;
    },
  };
}

/** 创建运行中的实例并灌入指定等待态节点，返回实例 id。 */
function createWaitingInstance(
  db: ReturnType<typeof openClientDb>,
  input: { workflowId: string; intakeId: string; frozenLabel: string; nodeStatus: "waiting-start" | "waiting-feedback" },
) {
  const instance = db.orchInstances.create({
    workspaceId: WORKSPACE_ID,
    workflowId: input.workflowId as WorkflowId,
    workflowSnapshot: {
      id: input.workflowId, workspaceId: WORKSPACE_ID, name: "旧流程名", description: "", family: "feature-dev", version: 1,
      nodes: [
        { id: "dev", type: "condition", label: input.frozenLabel, position: { x: 0, y: 0 } },
        { id: "review", type: "role", roleId: "role-review" as never, label: "审核", position: { x: 0, y: 60 } },
      ],
      edges: [{ id: "edge-dev-review", sourceNodeId: "dev", targetNodeId: "review", dataMappings: [] }],
    } as never,
    intakeSnapshot: { id: input.intakeId, workspaceId: WORKSPACE_ID, triggerMode: "manual", taskType: "feature", title: "展示名需求", goal: "验证展示名取当前定义" } as never,
  });
  db.orchInstances.updateNodeStates(instance.id, {
    dev: { nodeId: "dev", status: input.nodeStatus, retryCount: 0, assigneeUserIds: [], completedAt: null, humanActionSource: "human_input" },
    review: { nodeId: "review", status: "pending", retryCount: 0, assigneeUserIds: [], completedAt: null },
  } as never);
  db.orchInstances.updateStatus(instance.id, input.nodeStatus);
  return instance.id;
}

test("实例详情按当前定义覆盖快照节点名与流程名", (t) => {
  const h = createHarness(t);
  const intake = h.db.orchIntakes.create({
    workspaceId: WORKSPACE_ID, triggerMode: "manual", taskType: "feature", title: "展示名需求", goal: "验证展示名取当前定义",
  } as never);
  const instanceId = createWaitingInstance(h.db, { workflowId: "workflow-label", intakeId: String(intake.id), frozenLabel: "开发", nodeStatus: "waiting-start" });

  const body = h.call(handleOrchInstancesGet, "get", { workspaceId: WORKSPACE_ID, instanceId });

  assert.deepEqual(body.instance.workflowSnapshot.nodes.map((node: any) => node.label), ["新开发", "新审核"]);
  assert.equal(body.instance.workflowSnapshot.name, "新流程名");
  assert.deepEqual(body.instance.workflowSnapshot.nodes.map((node: any) => node.id), ["dev", "review"]);
  // 落库快照仍是冻结旧名。
  const stored = h.db.orchInstances.get(instanceId as OrchestrationId)!.workflowSnapshot;
  assert.deepEqual(stored.nodes.map((node) => node.label), ["开发", "审核"]);
  assert.equal(stored.name, "旧流程名");
});

test("实例列表与运行态补丁按当前定义覆盖流程名与活跃节点名", (t) => {
  const h = createHarness(t);
  const intake = h.db.orchIntakes.create({
    workspaceId: WORKSPACE_ID, triggerMode: "manual", taskType: "feature", title: "展示名需求", goal: "验证展示名取当前定义",
  } as never);
  const instanceId = createWaitingInstance(h.db, { workflowId: "workflow-label", intakeId: String(intake.id), frozenLabel: "开发", nodeStatus: "waiting-start" });
  const frozenSummary = h.db.orchInstances.listSummariesByWorkspace({ workspaceId: WORKSPACE_ID }).instances[0]!.runSummary;
  assert.ok(frozenSummary.detailText?.startsWith("开发 · "), `冻结摘要应带旧节点名：${frozenSummary.detailText}`);

  const listBody = h.call(handleOrchInstancesList, "list", { workspaceId: WORKSPACE_ID });
  const listed = listBody.instances.find((item: any) => item.id === String(instanceId));
  assert.equal(listed.workflowName, "新流程名");
  assert.equal(listed.runSummary.activeNodeLabel, "新开发");
  assert.equal(listed.runSummary.detailText, `新开发${frozenSummary.detailText!.slice("开发".length)}`);
  assert.equal(listed.runSummary.progressText, frozenSummary.progressText, "进度文案不含节点名，不得改动");

  const patchBody = h.call(handleOrchInstancesRuntimePatch, "patch", { workspaceId: WORKSPACE_ID, instanceId });
  assert.equal(patchBody.patch.runSummary.activeNodeLabel, "新开发");
  assert.equal(patchBody.patch.runSummary.detailText, `新开发${frozenSummary.detailText!.slice("开发".length)}`);
  // 补丁是缓存对象，缓存本身必须仍是冻结旧名，避免污染后续读取。
  assert.equal(h.db.orchInstances.getRuntimePatch(instanceId as OrchestrationId)!.runSummary.activeNodeLabel, "开发");
});

test("待我处理与提醒项内嵌的节点名取当前定义", (t) => {
  const h = createHarness(t);
  const intake = h.db.orchIntakes.create({
    workspaceId: WORKSPACE_ID, triggerMode: "manual", taskType: "feature", title: "展示名需求", goal: "验证展示名取当前定义",
  } as never);
  createWaitingInstance(h.db, { workflowId: "workflow-label", intakeId: String(intake.id), frozenLabel: "开发", nodeStatus: "waiting-start" });

  const pendingBody = h.call(handleOrchPendingMineList, "pending", { workspaceId: WORKSPACE_ID });
  const pending = pendingBody.items[0];
  assert.equal(pending.reminder.summary, "新开发 · 等待人工启动");
  assert.equal(pending.listMeta.workflowName, "新流程名");
  assert.equal(pending.pendingMineStatus, "waiting-start");

  const reminderBody = h.call(handleReminderItemsList, "reminders", { workspaceId: WORKSPACE_ID });
  const orchestrationItem = reminderBody.items.find((item: any) => item.sourceType === "orchestration");
  assert.equal(orchestrationItem.summary, "新开发 · 等待人工启动");
  assert.equal(orchestrationItem.routeTarget.nodeId, "dev", "节点身份仍用 nodeId，不受改名影响");
  assert.ok(String(orchestrationItem.routeTarget.intakeId) === String(intake.id as IntakeId));
});

test("冻结节点名带空白时同样整体换名，不留半新半旧摘要", (t) => {
  const h = createHarness(t);
  const warnings: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "warn", (_tag: string, _message: string, data?: unknown) => {
    warnings.push((data ?? {}) as Record<string, unknown>);
  });
  const intake = h.db.orchIntakes.create({
    workspaceId: WORKSPACE_ID, triggerMode: "manual", taskType: "feature", title: "展示名需求", goal: "验证展示名取当前定义",
  } as never);
  // 冻结节点名带前导空格，shared 派生的 detailText 与 activeNodeLabel 用同一个原始 label。
  const instanceId = createWaitingInstance(h.db, { workflowId: "workflow-spaced", intakeId: String(intake.id), frozenLabel: "  开发", nodeStatus: "waiting-start" });
  const frozenSummary = h.db.orchInstances.listSummariesByWorkspace({ workspaceId: WORKSPACE_ID }).instances[0]!.runSummary;
  assert.ok(frozenSummary.detailText?.startsWith("  开发 · "), `冻结摘要应带未 trim 的旧节点名：${frozenSummary.detailText}`);

  const body = h.call(handleOrchInstancesGet, "get", { workspaceId: WORKSPACE_ID, instanceId });

  assert.deepEqual(body.instance.workflowSnapshot.nodes.map((node: any) => node.label), ["新开发", "审核"]);
  const listed = h.call(handleOrchInstancesList, "list", { workspaceId: WORKSPACE_ID }).instances[0];
  assert.equal(listed.runSummary.activeNodeLabel, "新开发");
  assert.equal(listed.runSummary.detailText, "新开发 · 等待人工启动", "detailText 必须整段换名，不得残留旧名");
  assert.deepEqual(warnings.filter((item) => item.code === "ORCH_NODE_LABEL_DETAIL_PREFIX_MISMATCH"), [], "前缀成立时不得记契约漂移");
});

test("当前定义已删除的节点仍显示旧名，日志带 requestId 且不刷屏", (t) => {
  const h = createHarness(t);
  const warnings: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "warn", (_tag: string, _message: string, data?: unknown) => {
    warnings.push((data ?? {}) as Record<string, unknown>);
  });
  const intake = h.db.orchIntakes.create({
    workspaceId: WORKSPACE_ID, triggerMode: "manual", taskType: "feature", title: "展示名需求", goal: "验证展示名取当前定义",
  } as never);
  const instanceId = createWaitingInstance(h.db, { workflowId: "workflow-partial", intakeId: String(intake.id), frozenLabel: "开发", nodeStatus: "waiting-start" });

  const body = h.call(handleOrchInstancesGet, "get-missing", { workspaceId: WORKSPACE_ID, instanceId });
  h.call(handleOrchInstancesGet, "get-missing-again", { workspaceId: WORKSPACE_ID, instanceId });

  assert.deepEqual(body.instance.workflowSnapshot.nodes.map((node: any) => node.label), ["新开发", "审核"], "被删节点回退旧名而不是 nodeId");
  assert.deepEqual(body.instance.workflowSnapshot.nodes.map((node: any) => node.id), ["dev", "review"], "节点身份不受改名影响");
  const missing = warnings.filter((item) => item.code === "ORCH_NODE_LABEL_NODE_MISSING");
  assert.equal(missing.length, 1, "轮询不得重复刷同一条缺失日志");
  assert.equal(missing[0]?.requestId, "get-missing");
  assert.equal(missing[0]?.missingNodeId, "review");
  assert.equal(missing[0]?.workspaceId, WORKSPACE_ID);
  assert.equal(missing[0]?.workflowId, "workflow-partial");
});
