import test from "node:test";
import assert from "node:assert/strict";

import type {
  NodeExecutionState,
  OrchestrationInstance,
  OrchestrationInstanceSummary,
  OrchestrationStatus,
  WorkspaceId,
} from "@codeflowai/shared";

import {
  handleApiRequest,
} from "../../apps/desktop/client/src/app/handleApiRequest.ts";
import {
  handleReminderItemsList,
  handleReminderWorkspaceSummaries,
} from "../../apps/desktop/client/src/app/handlers/reminderHandlers.ts";
import {
  buildOrchInstanceSummaryProjection,
  OrchInstanceSummaryProjectionError,
} from "../../apps/desktop/client/src/db/orchInstanceSummaryProjection.ts";
import { OrchInstanceRepo } from "../../apps/desktop/client/src/db/repos/orchInstanceRepo.ts";
import { logger } from "../../apps/desktop/client/src/logger.ts";

const WORKSPACE_ID = "ws-orchestration-reminders" as WorkspaceId;

type SummaryFixtureInput = {
  id: string;
  intakeId?: string;
  intakeTitle: string;
  status: OrchestrationStatus;
  nodeStatus?: NodeExecutionState["status"];
  nodeLabel?: string;
  humanActionSource?: NodeExecutionState["humanActionSource"];
  conclusion?: NodeExecutionState["conclusion"];
  updatedAt: number;
};

/** 构造经生产投影派生的最小编排摘要，避免测试手写非法摘要。 */
function createSummary(input: SummaryFixtureInput): OrchestrationInstanceSummary {
  const intakeId = input.intakeId ?? `intake-${input.id}`;
  const nodeId = `node-${input.id}`;
  const instance = {
    id: input.id,
    workspaceId: WORKSPACE_ID,
    workflowId: `workflow-${input.id}`,
    proposalId: null,
    intakeSnapshot: {
      id: intakeId,
      workspaceId: WORKSPACE_ID,
      triggerMode: "manual",
      taskType: "feature",
      title: input.intakeTitle,
      goal: `${input.intakeTitle}目标`,
      requester: { source: "ui" },
      createdAt: 1,
      updatedAt: input.updatedAt,
    },
    workflowSnapshot: {
      id: `workflow-${input.id}`,
      workspaceId: WORKSPACE_ID,
      name: `${input.intakeTitle}流程`,
      description: "",
      nodes: [{
        id: nodeId,
        type: "role",
        roleId: `role-${input.id}`,
        label: input.nodeLabel ?? "执行节点",
        position: { x: 0, y: 0 },
      }],
      edges: [],
      version: 1,
    },
    assetRuntimeSnapshot: null,
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: null,
    status: input.status,
    nodeStates: {
      [nodeId]: {
        nodeId,
        status: input.nodeStatus ?? "pending",
        retryCount: 0,
        humanActionSource: input.humanActionSource ?? null,
        conclusion: input.conclusion ?? null,
      },
    },
    createdAt: 1,
    updatedAt: input.updatedAt,
  } as OrchestrationInstance;
  return buildOrchInstanceSummaryProjection(instance).summary;
}

/** 构造只暴露摘要读取的 Handler 上下文，并让任何详情读取立即失败。 */
function createHarness(summaries: OrchestrationInstanceSummary[]) {
  const responses: any[] = [];
  let summaryReads = 0;
  let detailReads = 0;
  const ctx = {
    db: {
      /** 测试聚合逻辑不建立工作区库，沿原上下文保留读取归属。 */
      forWorkspace() { return this; },
      /** 日志夹具复用真实日志边界，保留损坏投影错误的关联断言。 */
      writeWorkspaceLog(_workspaceId: WorkspaceId, entry: { level: "debug" | "warn" | "error"; tag: string; message: string; data: Record<string, unknown> }) {
        logger[entry.level](entry.tag, entry.message, entry.data);
      },
      workspaces: {
        list: () => [{ id: WORKSPACE_ID, title: "编排提醒", path: "Z:/workspace" }],
        get: () => ({ id: WORKSPACE_ID, title: "编排提醒", path: "Z:/workspace" }),
      },
      threads: { listByWorkspace: () => ({ threads: [] }) },
      turns: { listRunningByWorkspace: () => ({}) },
      threadReminderStates: { listByWorkspace: () => [] },
      orchIntakes: { listByWorkspace: () => [] },
      orchInstances: {
        listReminderSummariesByWorkspace: () => {
          summaryReads += 1;
          return summaries;
        },
        listByWorkspace: () => {
          detailReads += 1;
          throw new Error("提醒路径禁止读取编排详情");
        },
      },
      reminderReceipts: { get: () => null, listByWorkspace: () => [] },
      reminderIgnores: { get: () => null, listByWorkspace: () => [] },
    },
    workspaces: new Map([[WORKSPACE_ID, "Z:/workspace"]]),
    send(message: unknown) {
      responses.push(message);
    },
  } as any;
  return {
    ctx,
    getResponse(requestId: string) {
      return responses.find((response) => response.id === requestId) ?? null;
    },
    get summaryReads() {
      return summaryReads;
    },
    get detailReads() {
      return detailReads;
    },
  };
}

test("orchestration reminders use summary projections without reading instance detail JSON", () => {
  const summaries = [
    createSummary({
      id: "completed",
      intakeTitle: "完成需求",
      status: "completed",
      nodeStatus: "completed",
      updatedAt: 600,
    }),
    createSummary({
      id: "waiting-start",
      intakeTitle: "启动需求",
      status: "waiting-start",
      nodeStatus: "waiting-start",
      nodeLabel: "启动节点",
      updatedAt: 500,
    }),
    createSummary({
      id: "waiting-feedback",
      intakeTitle: "补充需求",
      status: "waiting-feedback",
      nodeStatus: "waiting-feedback",
      nodeLabel: "反馈节点",
      humanActionSource: "human_input",
      conclusion: {
        nextAction: "ask_human",
        summary: "请补充接口说明",
        humanInput: { summary: "请补充接口说明" },
      } as any,
      updatedAt: 400,
    }),
    createSummary({
      id: "waiting-approval",
      intakeTitle: "审批需求",
      status: "paused",
      nodeStatus: "waiting-approval",
      nodeLabel: "审批节点",
      humanActionSource: "approval",
      conclusion: { nextAction: "rework", summary: "建议退回" } as any,
      updatedAt: 300,
    }),
    createSummary({
      id: "failed",
      intakeTitle: "失败需求",
      status: "failed",
      nodeStatus: "failed",
      updatedAt: 200,
    }),
    createSummary({
      id: "paused",
      intakeTitle: "暂停需求",
      status: "paused",
      nodeStatus: "pending",
      updatedAt: 100,
    }),
  ];
  const harness = createHarness(summaries);

  handleReminderWorkspaceSummaries(harness.ctx, { id: "workspace-summary" } as any);
  handleReminderItemsList(harness.ctx, {
    id: "items-list",
    body: { workspaceId: WORKSPACE_ID },
  } as any);

  const workspaceSummary = harness.getResponse("workspace-summary")?.body?.summaries?.[0];
  assert.equal(workspaceSummary?.pendingActionCount, 5);
  assert.equal(workspaceSummary?.pendingReceiptCount, 1);
  assert.equal(harness.summaryReads, 2);
  assert.equal(harness.detailReads, 0);

  const items = harness.getResponse("items-list")?.body?.items ?? [];
  const byInstanceId = new Map<string, any>(
    items.map((item: any) => [String(item.routeTarget.instanceId), item] as const),
  );
  assert.deepEqual(
    pickReminderFields(byInstanceId.get("completed")),
    ["receipt", "待查收", "success", "编排执行已完成，等待您查看结果。", "open_orch_artifacts", "查看结果"],
  );
  assert.deepEqual(
    pickReminderFields(byInstanceId.get("waiting-start")),
    ["action", "待启动", "warning", "启动节点 · 等待人工启动", "open_orch_primary_action", "启动节点"],
  );
  assert.deepEqual(
    pickReminderFields(byInstanceId.get("waiting-feedback")),
    ["action", "待补充", "warning", "反馈节点 · 请补充接口说明", "open_orch_primary_action", "补充并继续"],
  );
  assert.deepEqual(
    pickReminderFields(byInstanceId.get("waiting-approval")),
    ["action", "待确认退回", "info", "审批节点 · 建议退回，等待人工确认", "open_orch_primary_action", "查看结果并决策"],
  );
  assert.deepEqual(
    pickReminderFields(byInstanceId.get("failed")),
    ["action", "失败", "danger", "执行失败，建议先进入执行工作区查看详情。", "open_orch_monitor", "查看执行"],
  );
  assert.deepEqual(
    pickReminderFields(byInstanceId.get("paused")),
    ["action", "已暂停", "warning", "执行已暂停，等待您继续处理。", "open_orch_monitor", "查看执行"],
  );
  assert.equal(byInstanceId.get("waiting-feedback")?.routeTarget.nodeId, "node-waiting-feedback");
  assert.match(byInstanceId.get("waiting-feedback")?.ignoreMarker ?? "", /^orch:waiting-feedback:feedback:node-waiting-feedback:400$/);
});

test("orchestration reminders keep an older active instance ahead of a newer completed instance", () => {
  const intakeId = "intake-shared";
  const harness = createHarness([
    createSummary({
      id: "newer-completed",
      intakeId,
      intakeTitle: "同一需求",
      status: "completed",
      nodeStatus: "completed",
      updatedAt: 200,
    }),
    createSummary({
      id: "older-active",
      intakeId,
      intakeTitle: "同一需求",
      status: "waiting-start",
      nodeStatus: "waiting-start",
      updatedAt: 100,
    }),
  ]);

  handleReminderItemsList(harness.ctx, {
    id: "active-first",
    body: { workspaceId: WORKSPACE_ID },
  } as any);

  const items = harness.getResponse("active-first")?.body?.items ?? [];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.routeTarget?.instanceId, "older-active");
  assert.equal(items[0]?.statusLabel, "待启动");
  assert.equal(harness.detailReads, 0);
});

test("orchestration reminder summary failures return a stable code and structured API log", async (t) => {
  const harness = createHarness([]);
  const errorLogs: Array<{ tag: string; message: string; data: Record<string, unknown> }> = [];
  t.mock.method(logger, "error", (tag: string, message: string, data?: unknown) => {
    errorLogs.push({ tag, message, data: data as Record<string, unknown> });
  });
  harness.ctx.db.orchInstances.listReminderSummariesByWorkspace = () => {
    throw new OrchInstanceSummaryProjectionError(
      "ORCH_INSTANCE_SUMMARY_PROJECTION_JSON_INVALID",
      "编排摘要投影损坏",
      { workspaceId: WORKSPACE_ID, instanceId: "instance-corrupt" },
    );
  };

  await handleApiRequest(harness.ctx, {
    id: "projection-failed",
    method: "reminders.items",
    body: { workspaceId: WORKSPACE_ID },
  } as any);

  const response = harness.getResponse("projection-failed");
  assert.equal(response?.status, 500);
  assert.equal(response?.body?.code, "ORCH_INSTANCE_SUMMARY_PROJECTION_JSON_INVALID");
  assert.equal(response?.body?.message, "编排摘要投影损坏");
  assert.equal(harness.detailReads, 0);
  assert.match(String((errorLogs[0]?.data.rootCause as { fingerprint?: string })?.fingerprint), /^[a-f0-9]{64}$/u);
  assert.deepEqual(errorLogs, [{
    tag: "orch-api",
    message: "failed api.req",
    data: {
      id: "projection-failed",
      requestId: "projection-failed",
      code: "ORCH_INSTANCE_SUMMARY_PROJECTION_JSON_INVALID",
      errorCode: "ORCH_INSTANCE_SUMMARY_PROJECTION_JSON_INVALID",
      event: { category: "orch-api", action: "reminders.items", outcome: "fail" },
      method: "reminders.items",
      workspaceId: WORKSPACE_ID,
      intakeId: null,
      instanceId: "instance-corrupt",
      ms: errorLogs[0]?.data.ms,
      rootCause: { type: "object", code: "ORCH_INSTANCE_SUMMARY_PROJECTION_JSON_INVALID",
        fingerprint: (errorLogs[0]?.data.rootCause as { fingerprint: string }).fingerprint },
    },
  }]);
  assert.equal(typeof errorLogs[0]?.data.ms, "number");
});

test("generic orchestration feedback uses neutral action copy", () => {
  const harness = createHarness([
    createSummary({
      id: "generic-feedback",
      intakeTitle: "普通反馈需求",
      status: "waiting-feedback",
      nodeStatus: "waiting-feedback",
      updatedAt: 100,
    }),
  ]);

  handleReminderItemsList(harness.ctx, {
    id: "generic-feedback-copy",
    body: { workspaceId: WORKSPACE_ID },
  } as any);

  const item = harness.getResponse("generic-feedback-copy")?.body?.items?.[0];
  assert.equal(item?.primaryActionLabel, "查看并处理");
  assert.equal(harness.detailReads, 0);
});

test("reminder summary repository does not apply the paged list limit of 200", () => {
  const seed = createSummary({
    id: "seed",
    intakeTitle: "批量需求",
    status: "failed",
    nodeStatus: "failed",
    updatedAt: 1,
  });
  const summaries = Array.from({ length: 201 }, (_, index) => ({
    ...seed,
    id: `instance-${index}` as any,
    intakeId: `intake-${index}` as any,
    runSummary: { ...seed.runSummary, instanceId: `instance-${index}` as any },
  }));
  let reads = 0;
  const repo = new OrchInstanceRepo(
    {} as any,
    {} as any,
    {
      listByWorkspace(workspaceId: WorkspaceId) {
        reads += 1;
        assert.equal(workspaceId, WORKSPACE_ID);
        return summaries;
      },
    } as any,
  );

  assert.equal(repo.listReminderSummariesByWorkspace(WORKSPACE_ID).length, 201);
  assert.equal(reads, 1);
});

/** 只截取提醒展示合同字段，减少断言噪音。 */
function pickReminderFields(item: any): unknown[] {
  return [
    item?.displayKind,
    item?.statusLabel,
    item?.tone,
    item?.summary,
    item?.primaryActionKind,
    item?.primaryActionLabel,
  ];
}
