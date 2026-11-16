import test from "node:test";
import assert from "node:assert/strict";

import type { WorkflowEdge, WorkflowNode } from "@codeflowai/shared";
import { resolveAllowedReworkTargets } from "../src/features/orchestration/rework-targets.ts";

/** 构造测试用角色节点，并按需挂载显式退回策略。 */
function roleNode(id: string, label: string, allowedTargetNodeIds?: string[] | null): WorkflowNode {
  return {
    id,
    type: "role",
    roleId: `role.${id}` as any,
    label,
    position: { x: 0, y: 0 },
    reworkPolicy: allowedTargetNodeIds ? { allowedTargetNodeIds } : null,
  };
}

/** 构造测试用非角色配置节点，验证上游遍历不会被配置节点截断。 */
function configNode(id: string, type: WorkflowNode["type"]): WorkflowNode {
  return {
    id,
    type,
    label: id,
    position: { x: 0, y: 0 },
  };
}

/** 构造测试用工作流连线。 */
function edge(id: string, sourceNodeId: string, targetNodeId: string): WorkflowEdge {
  return {
    id,
    sourceNodeId,
    targetNodeId,
    dataMappings: [],
  };
}

test("resolveAllowedReworkTargets prefers explicit allowed targets", () => {
  const nodes = [
    roleNode("prd", "PRD"),
    roleNode("ui", "UI"),
    roleNode("review", "人工审核", ["ui"]),
  ];
  const edges = [
    edge("prd-ui", "prd", "ui"),
    edge("ui-review", "ui", "review"),
  ];

  assert.deepEqual(resolveAllowedReworkTargets(nodes, edges, "review"), [
    { id: "ui", label: "UI" },
  ]);
});

test("resolveAllowedReworkTargets falls back to upstream role nodes across config nodes", () => {
  const nodes = [
    roleNode("prd", "PRD"),
    configNode("fork", "parallel-fork"),
    roleNode("dgn", "DGN"),
    roleNode("review", "人工审核"),
  ];
  const edges = [
    edge("prd-fork", "prd", "fork"),
    edge("fork-dgn", "fork", "dgn"),
    edge("dgn-review", "dgn", "review"),
  ];

  assert.deepEqual(resolveAllowedReworkTargets(nodes, edges, "review"), [
    { id: "dgn", label: "DGN" },
    { id: "prd", label: "PRD" },
  ]);
});

test("resolveAllowedReworkTargets drops explicit targets missing from workflow", () => {
  const nodes = [
    roleNode("dev", "DEV"),
    roleNode("review", "人工审核", ["missing", "dev"]),
  ];
  const edges = [
    edge("dev-review", "dev", "review"),
  ];

  assert.deepEqual(resolveAllowedReworkTargets(nodes, edges, "review"), [
    { id: "dev", label: "DEV" },
  ]);
});
