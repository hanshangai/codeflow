import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowNode } from "@codeflowai/shared";

import { buildWorkflowReworkEdges, isWorkflowReworkVisualEdge } from "../src/features/orchestration/components/workflow-rework-edges.ts";
import { workflowNodeBoxSize } from "../src/features/orchestration/workflow-node-cards.ts";

function role(id: string, x: number, y: number, targets: string[] = []): WorkflowNode {
  return {
    id,
    type: "role",
    label: id,
    position: { x, y },
    reworkPolicy: targets.length ? { allowedTargetNodeIds: targets } : null,
  };
}

const dimensions = { nodeWidth: 200, nodeHeight: 130, dark: false };

test("横向流程的多条回退线指向目标节点，并占用不同的上方轨道", () => {
  const nodes = [
    role("solution", 300, 500),
    role("dev", 600, 500),
    role("review", 900, 500, ["dev", "solution"]),
    role("e2e", 1200, 500, ["dev"]),
  ];
  const edges = buildWorkflowReworkEdges(nodes, dimensions);
  assert.equal(edges.length, 3);
  assert.ok(edges.every((edge) => edge.selectable === false && isWorkflowReworkVisualEdge(edge)));
  assert.deepEqual(new Set(edges.map((edge) => `${edge.source}->${edge.target}`)),
    new Set(["review->dev", "review->solution", "e2e->dev"]));

  const rails = edges.map((edge) => (edge.data as { routePoints: Array<{ x: number; y: number }> }).routePoints[1]!.y);
  assert.equal(new Set(rails).size, 3);
  assert.ok(rails.every((y) => y < 500));
  for (const edge of edges) {
    const points = (edge.data as { routePoints: Array<{ x: number; y: number }> }).routePoints;
    assert.equal(points[0]!.y, 500);
    assert.equal(points.at(-1)!.y, 500);
    assert.equal(edge.label, "退回");
  }
  const reviewPorts = edges.filter((edge) => edge.source === "review")
    .map((edge) => (edge.data as { routePoints: Array<{ x: number; y: number }> }).routePoints[0]!.x);
  assert.equal(new Set(reviewPorts).size, 2);
  const devPorts = edges.filter((edge) => edge.target === "dev")
    .map((edge) => (edge.data as { routePoints: Array<{ x: number; y: number }> }).routePoints.at(-1)!.x);
  assert.equal(new Set(devPorts).size, 2);
});

test("竖向流程从左侧分轨回到上游，失效目标不会生成连线", () => {
  const nodes = [
    role("solution", 400, 100),
    role("dev", 400, 400),
    role("review", 400, 700, ["solution", "dev", "missing", "review"]),
  ];
  const edges = buildWorkflowReworkEdges(nodes, dimensions);
  assert.equal(edges.length, 2);
  const railXs = edges.map((edge) => (edge.data as { routePoints: Array<{ x: number; y: number }> }).routePoints[1]!.x);
  assert.equal(new Set(railXs).size, 2);
  assert.ok(railXs.every((x) => x < 400));
  assert.ok(edges.every((edge) => edge.source === "review" && edge.target !== "review"));
});

test("没有显式回退配置时不额外绘制执行边", () => {
  assert.deepEqual(buildWorkflowReworkEdges([role("solution", 0, 0), role("review", 300, 0)], dimensions), []);
});

/** 起止节点缩成正方形后，图边界必须按真实尺寸估算，否则竖排流程会被误判成横排、轨道绕错轴。 */
test("边界上的起止节点按正方形解析尺寸，不再把竖排流程误判成横排", () => {
  const terminal = (id: string, type: "start" | "end", x: number, y: number): WorkflowNode =>
    ({ id, type, label: id, position: { x, y }, reworkPolicy: null }) as unknown as WorkflowNode;
  const nodes = [
    terminal("start", "start", 0, 0),
    terminal("end", "end", 900, 0),
    role("roleA", 0, 924, ["roleB"]),
    role("roleB", 300, 900),
  ];

  // 对照：沿用统一卡片尺寸时，end 的 200 宽会把图宽抬到 1100 > 高 1054，被误判成横排。
  const fixed = buildWorkflowReworkEdges(nodes, dimensions);
  const fixedPoints = (fixed[0]!.data as { routePoints: Array<{ x: number; y: number }> }).routePoints;
  assert.ok(fixedPoints[1]!.x > 0, "统一尺寸下确实会走横排轨道（未修复前的行为）");

  // 注意 workflowNodeBoxSize 的基准尺寸用 { width, height }，与 options 的 { nodeWidth, nodeHeight } 命名不同。
  const cardSize = { width: dimensions.nodeWidth, height: dimensions.nodeHeight };
  const sized = buildWorkflowReworkEdges(nodes, {
    ...dimensions,
    resolveNodeSize: (node) => workflowNodeBoxSize(node.type, cardSize),
  });
  assert.equal(sized.length, 1);
  const points = (sized[0]!.data as { routePoints: Array<{ x: number; y: number }> }).routePoints;
  assert.ok(points[1]!.x < 0, `竖排回退线应走图左侧轨道，实际 x=${points[1]!.x}`);
});
