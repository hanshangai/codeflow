import test from "node:test";
import assert from "node:assert/strict";

import type { OrchestrationRunSummary, WorkflowNode } from "@codeflowai/shared";

import type { OrchAssetAuthorityRuntimeReadService } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.ts";
import {
  OrchCurrentWorkflowLabelResolver,
  relabelRunSummary,
  relabelWorkflowDefinition,
  relabelWorkflowNodes,
  resetOrchCurrentDefinitionLabelLogDedupeForTest,
} from "../src/orchestration/orchCurrentDefinitionLabels.ts";
import { logger } from "../src/logger.ts";

const WORKSPACE_ID = "ws-current-labels";

/** 当前定义夹具：null 表示资产不存在，"throw" 表示缓存读取失败。 */
type DefinitionFixture = { name: string; nodes: WorkflowNode[] } | null | "throw";

function node(id: string, label: string): WorkflowNode {
  return { id, type: "role", roleId: `role-${id}` as never, label, position: { x: 0, y: 0 } };
}

/** 构造只暴露 openWorkspace/getAsset 的资产读取替身，并记录调用次数。 */
function createFakeRead(definitions: Record<string, DefinitionFixture>) {
  const calls = { openWorkspace: 0, getAsset: 0, reads: [] as string[] };
  const read = {
    openWorkspace: (workspaceId: string) => {
      calls.openWorkspace += 1;
      return {
        authorityMode: "legacy" as const,
        listAssets: () => [],
        getServerReadinessRequirement: () => null,
        getAsset: (assetType: string, assetId: string) => {
          calls.getAsset += 1;
          calls.reads.push(`${workspaceId}:${assetId}`);
          const definition = definitions[assetId];
          if (definition === undefined || definition === null) return null;
          if (definition === "throw") throw new Error("asset cache unavailable");
          return {
            assetType,
            assetId,
            definition: { id: assetId, workspaceId, name: definition.name, description: "", nodes: definition.nodes, edges: [], version: 1 },
            source: { authorityMode: "legacy" as const, createdAt: 1, updatedAt: 1 },
          };
        },
      };
    },
  };
  return { read: read as unknown as OrchAssetAuthorityRuntimeReadService, calls };
}

/** 捕获 logger.warn 的结构化负载，用于断言降级日志。 */
function captureWarnings(t: test.TestContext): Array<Record<string, unknown>> {
  const warnings: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "warn", (_tag: string, _message: string, data?: unknown) => {
    warnings.push((data ?? {}) as Record<string, unknown>);
  });
  return warnings;
}

function findWarning(warnings: Array<Record<string, unknown>>, code: string) {
  return warnings.find((item) => item.code === code) ?? null;
}

test("同一 (workspaceId, workflowId) 只读取一次资产，两个 workflowId 共用一次会话", (t) => {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  captureWarnings(t);
  const { read, calls } = createFakeRead({
    "workflow-a": { name: "流程 A", nodes: [node("dev", "开发")] },
    "workflow-b": { name: "流程 B", nodes: [node("dev", "开发 B")] },
  });
  const resolver = new OrchCurrentWorkflowLabelResolver(read);

  const first = resolver.resolve(WORKSPACE_ID, "workflow-a");
  const second = resolver.resolve(WORKSPACE_ID, "workflow-a");
  const other = resolver.resolve(WORKSPACE_ID, "workflow-b");

  assert.equal(calls.openWorkspace, 1);
  assert.equal(calls.getAsset, 2);
  assert.deepEqual(calls.reads, [`${WORKSPACE_ID}:workflow-a`, `${WORKSPACE_ID}:workflow-b`]);
  assert.equal(first, second, "同一工作流的解析结果必须记忆化复用");
  assert.equal(first?.name, "流程 A");
  assert.equal(other?.name, "流程 B");
  assert.equal(first?.nodeLabels.get("dev"), "开发");
  assert.equal(other?.nodeLabels.get("dev"), "开发 B");
});

test("读不到流程定义时返回 null，未知工作流与空 workflowId 都不读取资产", (t) => {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  const warnings = captureWarnings(t);
  const { read, calls } = createFakeRead({ "workflow-missing": null });
  const resolver = new OrchCurrentWorkflowLabelResolver(read);

  assert.equal(resolver.resolve(WORKSPACE_ID, "workflow-missing"), null);
  assert.equal(resolver.resolve(WORKSPACE_ID, "workflow-missing"), null);
  assert.equal(resolver.resolve(WORKSPACE_ID, ""), null);
  assert.equal(resolver.resolve(WORKSPACE_ID, null), null);
  assert.equal(calls.getAsset, 1, "只有第一次解析会真正读取资产");
  assert.equal(calls.openWorkspace, 1);
  const warning = findWarning(warnings, "ORCH_NODE_LABEL_DEFINITION_UNAVAILABLE");
  assert.ok(warning, "资产缺失必须留下结构化日志");
  assert.equal(warning?.workspaceId, WORKSPACE_ID);
  assert.equal(warning?.workflowId, "workflow-missing");
  assert.equal(warnings.filter((item) => item.code === "ORCH_NODE_LABEL_DEFINITION_UNAVAILABLE").length, 1, "轮询不得重复刷同一条日志");
});

test("资产读取抛错只降级为 null 并带 cause 与 requestId，不向调用方抛错", (t) => {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  const warnings = captureWarnings(t);
  const { read } = createFakeRead({ "workflow-throws": "throw" });

  assert.equal(new OrchCurrentWorkflowLabelResolver(read, "req-label-2").resolve(WORKSPACE_ID, "workflow-throws"), null);
  const warning = findWarning(warnings, "ORCH_NODE_LABEL_DEFINITION_UNAVAILABLE");
  assert.equal(warning?.cause, "asset cache unavailable");
  assert.equal(warning?.requestId, "req-label-2");
});

test("未装配资产读取服务时返回 null 并只记录一次 READER_ABSENT", (t) => {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  const warnings = captureWarnings(t);
  const resolver = new OrchCurrentWorkflowLabelResolver(undefined);

  assert.equal(resolver.resolve(WORKSPACE_ID, "workflow-a"), null);
  assert.equal(resolver.resolve(WORKSPACE_ID, "workflow-b"), null);
  assert.deepEqual(warnings.map((item) => item.code), ["ORCH_NODE_LABEL_READER_ABSENT"]);
});

test("流程名为空时 name 为 null，调用方保留快照旧名", (t) => {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  captureWarnings(t);
  const { read } = createFakeRead({ "workflow-no-name": { name: "   ", nodes: [node("dev", "新开发")] } });

  assert.equal(new OrchCurrentWorkflowLabelResolver(read).resolve(WORKSPACE_ID, "workflow-no-name")?.name, null);
});

test("节点在当前定义缺失时保留旧名、保持顺序与数量，并记录一次缺失日志", (t) => {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  const warnings = captureWarnings(t);
  const { read } = createFakeRead({ "workflow-a": { name: "流程 A", nodes: [node("dev", "新开发")] } });
  const labels = new OrchCurrentWorkflowLabelResolver(read, "req-label-1").resolve(WORKSPACE_ID, "workflow-a");
  const frozen = [node("start", "开始"), node("dev", "开发"), node("end", "结束")];

  const relabeled = relabelWorkflowNodes(frozen, labels);

  assert.deepEqual(relabeled.map((item) => item.id), ["start", "dev", "end"]);
  assert.deepEqual(relabeled.map((item) => item.label), ["开始", "新开发", "结束"]);
  assert.deepEqual(frozen.map((item) => item.label), ["开始", "开发", "结束"], "入参不得被就地改写");
  assert.equal(relabeled[1] === frozen[1], false);
  assert.equal(relabeled[0], frozen[0], "未改名节点无需复制");
  const missing = warnings.filter((item) => item.code === "ORCH_NODE_LABEL_NODE_MISSING");
  assert.deepEqual(missing.map((item) => item.missingNodeId), ["start", "end"], "缺失日志必须带完整 nodeId 以便检索");
  assert.equal(missing[0]?.workspaceId, WORKSPACE_ID);
  assert.equal(missing[0]?.workflowId, "workflow-a");
  assert.equal(missing[0]?.requestId, "req-label-1", "降级日志必须带 requestId");
  relabelWorkflowNodes(frozen, labels);
  assert.equal(warnings.filter((item) => item.code === "ORCH_NODE_LABEL_NODE_MISSING").length, 2, "每个缺失节点只记录一次");
});

test("labels 为 null 时三个替换函数原样返回入参", () => {
  const frozen = [node("dev", "开发")];
  const workflow = { id: "workflow-a", workspaceId: WORKSPACE_ID, name: "旧流程", description: "", nodes: frozen, edges: [], version: 1 } as never;
  const summary = summaryFixture();

  assert.equal(relabelWorkflowNodes(frozen, null), frozen);
  assert.equal(relabelWorkflowDefinition(workflow, null), workflow);
  assert.equal(relabelRunSummary(summary, null), summary);
});

/** 构造等待人工处理的运行摘要，detailText 以旧节点名开头。 */
function summaryFixture(overrides: Partial<OrchestrationRunSummary> = {}): OrchestrationRunSummary {
  return {
    instanceId: "instance-a" as never,
    statusLabel: "待反馈",
    statusTone: "warning",
    progressDone: 1,
    progressTotal: 3,
    progressRatio: 1 / 3,
    progressText: "已完成 1/3 节点",
    detailText: "开发 · 等待人工处理",
    activeNodeId: "dev",
    activeNodeLabel: "开发",
    activeNodeStatus: "waiting-feedback",
    waitingActionKind: "feedback",
    artifactCount: 0,
    ...overrides,
  };
}

test("运行摘要按旧节点名做 detailText 前缀替换，再覆盖 activeNodeLabel", (t) => {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  const warnings = captureWarnings(t);
  const { read } = createFakeRead({ "workflow-a": { name: "流程 A", nodes: [node("dev", "新开发")] } });
  const labels = new OrchCurrentWorkflowLabelResolver(read).resolve(WORKSPACE_ID, "workflow-a");

  const relabeled = relabelRunSummary(summaryFixture(), labels);

  assert.equal(relabeled.activeNodeLabel, "新开发");
  assert.equal(relabeled.detailText, "新开发 · 等待人工处理");
  assert.equal(relabeled.statusLabel, "待反馈", "状态文案不带节点名，不得改动");
  assert.equal(relabeled.progressText, "已完成 1/3 节点");
  assert.deepEqual(warnings, []);
});

test("detailText 不以旧节点名开头时保留原文，只改 activeNodeLabel 并记录契约漂移", (t) => {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  const warnings = captureWarnings(t);
  const { read } = createFakeRead({ "workflow-a": { name: "流程 A", nodes: [node("dev", "新开发")] } });
  const labels = new OrchCurrentWorkflowLabelResolver(read).resolve(WORKSPACE_ID, "workflow-a");

  const relabeled = relabelRunSummary(summaryFixture({ detailText: "等待补充 · 旧文案" }), labels);

  assert.equal(relabeled.activeNodeLabel, "新开发");
  assert.equal(relabeled.detailText, "等待补充 · 旧文案", "不得静默拼接新节点名");
  const drift = findWarning(warnings, "ORCH_NODE_LABEL_DETAIL_PREFIX_MISMATCH");
  assert.equal(drift?.instanceId, "instance-a");
  assert.equal(drift?.nodeId, "dev");
});

test("冻结节点名带空白时按原始旧名整体换名，不误报契约漂移", (t) => {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  const warnings = captureWarnings(t);
  const { read } = createFakeRead({ "workflow-a": { name: "流程 A", nodes: [node("dev", "新开发")] } });
  const labels = new OrchCurrentWorkflowLabelResolver(read).resolve(WORKSPACE_ID, "workflow-a");

  // shared 派生 detailText 与 activeNodeLabel 用同一个未 trim 的 node.label。
  const relabeled = relabelRunSummary(summaryFixture({ activeNodeLabel: "  开发", detailText: "  开发 · 等待人工处理" }), labels);

  assert.equal(relabeled.activeNodeLabel, "新开发");
  assert.equal(relabeled.detailText, "新开发 · 等待人工处理");
  assert.deepEqual(warnings, [], "前缀成立时不得记契约漂移");
});

test("活跃节点缺失或摘要无活跃节点时保持摘要原样", (t) => {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  const warnings = captureWarnings(t);
  const { read } = createFakeRead({ "workflow-a": { name: "流程 A", nodes: [node("other", "另一个节点")] } });
  const labels = new OrchCurrentWorkflowLabelResolver(read).resolve(WORKSPACE_ID, "workflow-a");

  const missingNode = relabelRunSummary(summaryFixture(), labels);
  assert.equal(missingNode.activeNodeLabel, "开发");
  assert.equal(missingNode.detailText, "开发 · 等待人工处理");
  assert.equal(findWarning(warnings, "ORCH_NODE_LABEL_NODE_MISSING")?.workspaceId, WORKSPACE_ID);

  const completed = summaryFixture({ activeNodeId: null, activeNodeLabel: null, detailText: "当前执行已完成" });
  assert.equal(relabelRunSummary(completed, labels), completed);
});

test("流程定义替换只改名称与节点名，其余字段与入参保持不变", (t) => {
  resetOrchCurrentDefinitionLabelLogDedupeForTest();
  captureWarnings(t);
  const { read } = createFakeRead({ "workflow-a": { name: "新流程名", nodes: [node("dev", "新开发")] } });
  const labels = new OrchCurrentWorkflowLabelResolver(read).resolve(WORKSPACE_ID, "workflow-a");
  const frozen = {
    id: "workflow-a",
    workspaceId: WORKSPACE_ID,
    name: "旧流程名",
    description: "描述",
    family: "feature-dev",
    nodes: [node("dev", "开发")],
    edges: [{ id: "edge", sourceNodeId: "dev", targetNodeId: "dev", dataMappings: [] }],
    version: 7,
  } as never;

  const relabeled = relabelWorkflowDefinition(frozen, labels);

  assert.equal(relabeled.name, "新流程名");
  assert.deepEqual(relabeled.nodes.map((item: WorkflowNode) => item.label), ["新开发"]);
  assert.equal(relabeled.version, 7);
  assert.equal(relabeled.description, "描述");
  assert.deepEqual(relabeled.edges, frozen.edges);
  assert.equal((frozen as { name: string }).name, "旧流程名");
  assert.deepEqual((frozen as { nodes: WorkflowNode[] }).nodes.map((item) => item.label), ["开发"]);
});
