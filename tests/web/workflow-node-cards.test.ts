import test from "node:test";
import assert from "node:assert/strict";

import type { WorkflowNode } from "../../packages/shared/src/index.ts";
import { buildConfigNodeCardViewModel } from "../../apps/web/src/features/orchestration/workflow-node-cards.ts";

test("buildConfigNodeCardViewModel summarizes role nodes with stable metrics and badges", () => {
  const node: WorkflowNode = {
    id: "implementation",
    type: "role",
    label: "开发实现",
    roleId: "role_impl" as any,
    position: { x: 0, y: 0 },
    inputBindings: [
      { sourceNodeId: "analysis", sourceArtifactKind: "analysis-report", targetField: "analysis", required: true },
      { sourceNodeId: "design", sourceArtifactKind: "solution-plan", targetField: "plan", required: true },
    ],
    outputArtifactMode: "file-set",
    outputResultKey: "implementation-report",
    knowledgeOverrideBundleIds: ["kb_a" as any, "kb_b" as any],
    approvalMode: "manual",
    failPolicy: "wait-feedback",
    reworkPolicy: {
      allowedTargetNodeIds: ["analysis", "design"],
    },
  };

  const card = buildConfigNodeCardViewModel(node, { roleName: "开发工程师" });

  assert.equal(card.eyebrow, "开发工程师");
  assert.equal(card.statusLabel, "角色节点");
  assert.deepEqual(card.metrics.map((item) => `${item.label}:${item.value}`), [
    "输入:2",
    "知识:2",
    "多文件输出:",
    "人工审核:",
  ]);
  assert.deepEqual(card.badges.map((item) => item.text), [
    "implementation-report",
    "可退回：analysis、design",
  ]);
});

test("buildConfigNodeCardViewModel keeps condition summary compact", () => {
  const node: WorkflowNode = {
    id: "complexity",
    type: "condition",
    label: "复杂度判断",
    roleId: null,
    conditionExpr: "如果需求包含前端、测试和文档三个维度，就走复杂分支",
    position: { x: 0, y: 0 },
    inputBindings: [],
    outputArtifactMode: null,
    outputResultKey: null,
    knowledgeOverrideBundleIds: [],
    approvalMode: null,
    failPolicy: null,
    reworkPolicy: null,
  };

  const card = buildConfigNodeCardViewModel(node);

  assert.equal(card.eyebrow, "已配置分支条件");
  assert.equal(card.statusLabel, "条件判断");
  assert.deepEqual(card.metrics.map((item) => `${item.label}:${item.value}`), [
    "结果:分支",
  ]);
  assert.match(card.badges[0]?.text ?? "", /如果需求包含前端/);
});

test("buildConfigNodeCardViewModel marks manual condition decisions", () => {
  const node: WorkflowNode = {
    id: "manual-branch",
    type: "condition",
    label: "人工分支",
    roleId: null,
    conditionExpr: null,
    conditionDecisionMode: "manual",
    position: { x: 0, y: 0 },
    inputBindings: [],
    outputArtifactMode: null,
    outputResultKey: null,
    knowledgeOverrideBundleIds: [],
    approvalMode: null,
    failPolicy: null,
    reworkPolicy: null,
  };

  const card = buildConfigNodeCardViewModel(node);

  assert.equal(card.eyebrow, "运行时等待人工选择分支");
  assert.equal(card.badges[0]?.text, "人工选择");
});

test("buildConfigNodeCardViewModel hides zero-value count metrics", () => {
  const node: WorkflowNode = {
    id: "analysis",
    type: "role",
    label: "需求分析",
    roleId: "role_analysis" as any,
    position: { x: 0, y: 0 },
    inputBindings: [],
    outputArtifactMode: "file",
    outputResultKey: "analysis-report",
    knowledgeOverrideBundleIds: [],
    approvalMode: "auto",
    failPolicy: null,
    reworkPolicy: null,
  };

  const card = buildConfigNodeCardViewModel(node, { roleName: "需求分析师" });

  assert.deepEqual(card.metrics.map((item) => `${item.label}:${item.value}`), [
    "单文件输出:",
    "自动审核:",
  ]);
});

test("buildConfigNodeCardViewModel marks same-session sequential work item nodes", () => {
  const node: WorkflowNode = {
    id: "asset-details",
    type: "role",
    label: "资产详情",
    roleId: "role_asset_details" as any,
    position: { x: 0, y: 0 },
    inputBindings: [],
    outputArtifactMode: "file-set",
    outputResultKey: null,
    knowledgeOverrideBundleIds: [],
    approvalMode: "auto",
    failPolicy: "wait-feedback",
    workItemPolicy: { mode: "sequential" },
    reworkPolicy: null,
  };

  const card = buildConfigNodeCardViewModel(node, { roleName: "资产详情 Owner" });

  assert.equal(card.badges.some((item) => item.text === "顺序工作项"), true);
});
