import test from "node:test";
import assert from "node:assert/strict";

import type { WorkflowDefinition, WorkspaceId } from "@codeflowai/shared";
import {
  buildRerunNodeIds,
  buildRerunRoleExecutionOverrides,
  collectRerunAffectedNodeIds,
  collectRerunScopeRoleIds,
  validateRerunNodeIds,
  validateRerunExecutionOverrideDraft,
} from "../src/features/orchestration/rerun-execution-config.ts";

/** 构造带分支的最小流程，验证重跑范围不会回溯到已通过上游。 */
function buildWorkflow(): WorkflowDefinition {
  const workspaceId = "ws-rerun-execution-config" as WorkspaceId;
  return {
    id: "wf-rerun-execution-config" as any,
    workspaceId,
    family: "feature-dev",
    name: "重跑配置测试",
    description: "验证重跑范围角色覆盖",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "product", type: "role", roleId: "role-product" as any, label: "产品", position: { x: 0, y: 80 } },
      { id: "fork", type: "parallel-fork", label: "分叉", position: { x: 0, y: 160 } },
      { id: "frontend", type: "role", roleId: "role-frontend" as any, label: "前端", position: { x: -120, y: 240 } },
      { id: "backend", type: "role", roleId: "role-backend" as any, label: "后端", position: { x: 120, y: 240 } },
      { id: "end", type: "end", label: "结束", position: { x: 0, y: 320 } },
    ],
    edges: [
      { id: "start-product", sourceNodeId: "start", targetNodeId: "product", dataMappings: [] },
      { id: "product-fork", sourceNodeId: "product", targetNodeId: "fork", dataMappings: [] },
      { id: "fork-frontend", sourceNodeId: "fork", targetNodeId: "frontend", dataMappings: [] },
      { id: "fork-backend", sourceNodeId: "fork", targetNodeId: "backend", dataMappings: [] },
      { id: "frontend-end", sourceNodeId: "frontend", targetNodeId: "end", dataMappings: [] },
      { id: "backend-end", sourceNodeId: "backend", targetNodeId: "end", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("重跑范围只覆盖起点及其下游角色，整个流程范围保留全部角色", () => {
  const workflow = buildWorkflow();

  assert.deepEqual(collectRerunAffectedNodeIds(workflow, "frontend"), ["frontend", "end"]);
  assert.deepEqual(collectRerunScopeRoleIds(workflow, "frontend", "affected"), ["role-frontend"]);
  assert.deepEqual(collectRerunScopeRoleIds(workflow, "frontend", "all"), ["role-product", "role-frontend", "role-backend"]);
});

test("精确范围支持仅重跑起点，并拒绝跨过未选择中间节点", () => {
  const workflow = buildWorkflow();
  assert.deepEqual(buildRerunNodeIds(workflow, "product", "single"), ["product"]);
  assert.equal(buildRerunNodeIds(workflow, "product", "downstream"), null);

  const disconnected = buildRerunNodeIds(workflow, "product", "custom", ["frontend"]);
  assert.match(validateRerunNodeIds(workflow, "product", disconnected) ?? "", /补充中间节点/);
  const connected = buildRerunNodeIds(workflow, "product", "custom", ["fork", "frontend"]);
  assert.equal(validateRerunNodeIds(workflow, "product", connected), null);
  assert.deepEqual(collectRerunScopeRoleIds(workflow, "product", "affected", connected), ["role-product", "role-frontend"]);
});

test("角色覆盖为每个目标角色生成独立对象，并保留显式不发送 effort", () => {
  const overrides = buildRerunRoleExecutionOverrides(["role-a", "role-b", "role-a"], {
    engine: "codex",
    model: "gpt-5.6-terra",
    effort: "",
    autoCompactPct: 90.4,
  });

  assert.deepEqual(overrides, {
    "role-a": {
      engine: "codex",
      model: "gpt-5.6-terra",
      effort: null,
      autoCompactPct: 90,
    },
    "role-b": {
      engine: "codex",
      model: "gpt-5.6-terra",
      effort: null,
      autoCompactPct: 90,
    },
  });
});

test("重跑覆盖草稿拒绝空模型和越界数值", () => {
  assert.equal(validateRerunExecutionOverrideDraft({
    engine: "codex",
    model: "",
    effort: "max",
    autoCompactPct: null,
  }), "请选择模型或填写模型 ID");
  assert.equal(validateRerunExecutionOverrideDraft({
    engine: "codex",
    model: "gpt-5.6-terra",
    effort: "max",
    autoCompactPct: 100,
  }), "自动压缩比例应在 50-99 之间");
});
