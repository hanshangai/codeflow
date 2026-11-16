import test from "node:test";
import assert from "node:assert/strict";

import type { Edge } from "@vue-flow/core";

import { withWorkflowEdgeRouting } from "../src/features/orchestration/components/workflow-edge-layout.ts";
import { workflowNodeBoxSize } from "../src/features/orchestration/workflow-node-cards.ts";

const NODE_SIZE = { width: 208, height: 126 };

type NodeLike = { id: string; position: { x: number; y: number } };

function buildNode(id: string, x: number, y = 0): NodeLike {
  return { id, position: { x, y } };
}

function buildEdge(id: string, source: string, target: string, data: Record<string, unknown> = {}): Edge {
  return { id, source, target, type: "workflow-smooth", data } as unknown as Edge;
}

function readRoutePoints(edge: Edge): Array<{ x: number; y: number }> | undefined {
  return (edge.data as { routePoints?: Array<{ x: number; y: number }> }).routePoints;
}

/** 水平绕行折线的通道 y 落在两个 stub 之间的那一段。 */
function readHorizontalRail(points: Array<{ x: number; y: number }>): number {
  return points[2]!.y;
}

test("直连没有压到卡片时不生成绕行折线", () => {
  const nodes = [buildNode("start", 0), buildNode("end", 600)];
  const routed = withWorkflowEdgeRouting([buildEdge("e1", "start", "end")], nodes, NODE_SIZE);

  assert.equal(readRoutePoints(routed[0]!), undefined);
});

test("横穿中间卡片的直连边改走卡片下方的通道", () => {
  const nodes = [buildNode("start", 0), buildNode("mid", 300), buildNode("end", 600)];
  const routed = withWorkflowEdgeRouting([buildEdge("e1", "start", "end")], nodes, NODE_SIZE);

  const points = readRoutePoints(routed[0]!);
  assert.ok(points, "跨越型直连边应当补齐绕行折线");
  assert.equal(points.length, 6);
  // 折线首尾必须落在卡片锚点上，否则线头会离开卡片。
  assert.deepEqual(points[0], { x: 208, y: 63 });
  assert.deepEqual(points.at(-1), { x: 600, y: 63 });
  // 通道必须绕到中间卡片（y 0~126）下面。
  assert.ok(readHorizontalRail(points) > 126, `通道 y=${readHorizontalRail(points)} 未绕开卡片`);
});

test("已带自动布局路由的边保持原样", () => {
  const nodes = [buildNode("start", 0), buildNode("mid", 300), buildNode("end", 600)];
  const stored = [{ x: 1, y: 1 }, { x: 2, y: 2 }];
  const routed = withWorkflowEdgeRouting(
    [buildEdge("e1", "start", "end", { routePoints: stored })],
    nodes,
    NODE_SIZE,
  );

  assert.deepEqual(readRoutePoints(routed[0]!), stored);
});

/** 开始/结束是正方形 bbox：锚点必须落在正方形的边上，而不是卡片矩形的边上。 */
test("按节点类型解析尺寸时，开始/结束的锚点落在正方形边上", () => {
  const nodes = [
    { id: "start", position: { x: 0, y: 0 }, type: "start" },
    { id: "mid", position: { x: 300, y: 0 }, type: "role" },
    { id: "end", position: { x: 600, y: 0 }, type: "end" },
  ];
  const routed = withWorkflowEdgeRouting(
    [buildEdge("e1", "start", "end")],
    nodes,
    (node) => workflowNodeBoxSize(node.type, NODE_SIZE),
  );

  const points = readRoutePoints(routed[0]!)!;
  // start 右锚点 = 0 + 126（正方形边长取节点高度），不再是 208；纵向仍取高度中点。
  assert.deepEqual(points[0], { x: 126, y: 63 });
  assert.deepEqual(points.at(-1), { x: 600, y: 63 });
  assert.ok(readHorizontalRail(points) > 126, "通道仍需绕开中间的卡片");
});

test("同一区间的多条绕行线各占一条通道，不互相重叠", () => {
  const nodes = [buildNode("start", 0), buildNode("mid", 300), buildNode("end", 600), buildNode("end2", 600, 160)];
  const routed = withWorkflowEdgeRouting(
    [buildEdge("e1", "start", "end"), buildEdge("e2", "start", "end2")],
    nodes,
    NODE_SIZE,
  );

  const rails = routed.map((edge) => readHorizontalRail(readRoutePoints(edge)!));
  assert.equal(rails.length, 2);
  assert.notEqual(rails[0], rails[1], "同一区间的绕行线应分配到不同通道");
  assert.ok(rails.every((rail) => rail > 126));
});
