import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowEdge, WorkflowNode } from "@codeflowai/shared";

import { orderWorkflowNodesForDisplay } from "../src/orchestration/workflowStageOrder.ts";

/** 只填排序真正读取的字段：id 参与拓扑，type 参与并行段识别。 */
function node(id: string, type = "role"): WorkflowNode {
  return { id, type, label: id } as unknown as WorkflowNode;
}

function edge(source: string, target: string): WorkflowEdge {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target } as unknown as WorkflowEdge;
}

const idsOf = (nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] =>
  orderWorkflowNodesForDisplay(nodes, edges).map((entry) => entry.node.id);

/** 自定义工作流的数组是「节点添加顺序」，先放 END 也会排在最前，卡片必须按依赖重排。 */
test("线性流程按依赖顺序排列，与数组顺序无关", () => {
  const nodes = [node("end", "end"), node("b"), node("start", "start"), node("a")];
  const edges = [edge("start", "a"), edge("a", "b"), edge("b", "end")];
  assert.deepEqual(idsOf(nodes, edges), ["start", "a", "b", "end"]);
});

/** 数组顺序本来就等于流程顺序时不得被改动：内置工作流的数组是人工按流程写好的。 */
test("数组顺序已经正确时输出逐项不变", () => {
  const nodes = [node("start", "start"), node("a"), node("b"), node("end", "end")];
  const edges = [edge("start", "a"), edge("a", "b"), edge("b", "end")];
  assert.deepEqual(idsOf(nodes, edges), ["start", "a", "b", "end"]);
});

/** 并行分支按拓扑展开；段内节点标出所属段与分支序号，fork/join 自身不属于任何分支。 */
test("并行分支标出所属段与分支序号", () => {
  const nodes = [
    node("start", "start"), node("fork", "parallel-fork"),
    node("a1"), node("a2"), node("b1"),
    node("join", "parallel-join"), node("end", "end"),
  ];
  const edges = [
    edge("start", "fork"),
    edge("fork", "a1"), edge("a1", "a2"),
    edge("fork", "b1"),
    edge("a2", "join"), edge("b1", "join"),
    edge("join", "end"),
  ];

  const ordered = orderWorkflowNodesForDisplay(nodes, edges);
  assert.deepEqual(ordered.map((entry) => entry.node.id), ["start", "fork", "a1", "a2", "b1", "join", "end"]);

  const branchOf = new Map(ordered.map((entry) => [entry.node.id, entry.parallelBranchIndex]));
  assert.equal(branchOf.get("a1"), 0);
  assert.equal(branchOf.get("a2"), 0, "同一分支内保持同一序号");
  assert.equal(branchOf.get("b1"), 1);
  assert.equal(branchOf.get("fork"), null, "fork 自身不属于任何分支");
  assert.equal(branchOf.get("join"), null, "join 自身不属于任何分支");
  assert.equal(branchOf.get("start"), null);
  assert.deepEqual(
    ordered.filter((entry) => entry.isBranchStart).map((entry) => entry.node.id),
    ["a1", "b1"],
    "两个分支各有一个起点",
  );
});

/** 分支序号按分支首个节点在原数组中的位置排序，不受 edges 书写顺序影响。 */
test("分支序号按原数组位置决定，不随连线顺序变化", () => {
  const nodes = [
    node("start", "start"), node("fork", "parallel-fork"),
    node("earlier"), node("later"),
    node("join", "parallel-join"), node("end", "end"),
  ];
  // 数组里 earlier 在前；故意把 later 的边写在前面，分支序号仍应让 earlier 为 0。
  const edges = [
    edge("start", "fork"),
    edge("fork", "later"), edge("fork", "earlier"),
    edge("later", "join"), edge("earlier", "join"),
    edge("join", "end"),
  ];
  const branchOf = new Map(orderWorkflowNodesForDisplay(nodes, edges).map((entry) => [entry.node.id, entry.parallelBranchIndex]));
  assert.equal(branchOf.get("earlier"), 0);
  assert.equal(branchOf.get("later"), 1);
});

/**
 * 分支在数组里交错时（a1、b1、a2），拓扑序会把 a2 排在 b1 之后。
 * 分支起点必须按展示顺序取「该分支最早出现的节点」，否则 a2 会被误判成新分支的开始。
 */
test("分支交错时每个分支只标一个起点", () => {
  const nodes = [
    node("start", "start"), node("fork", "parallel-fork"),
    node("a1"), node("b1"), node("a2"),
    node("join", "parallel-join"), node("end", "end"),
  ];
  const edges = [
    edge("start", "fork"),
    edge("fork", "a1"), edge("fork", "b1"),
    edge("a1", "a2"), edge("b1", "join"), edge("a2", "join"),
    edge("join", "end"),
  ];
  const ordered = orderWorkflowNodesForDisplay(nodes, edges);
  assert.deepEqual(ordered.map((entry) => entry.node.id), ["start", "fork", "a1", "b1", "a2", "join", "end"]);
  assert.deepEqual(
    ordered.filter((entry) => entry.isBranchStart).map((entry) => entry.node.id),
    ["a1", "b1"],
    "a2 是分支①的第二个节点，不该被标成起点",
  );
  const branchOf = new Map(ordered.map((entry) => [entry.node.id, entry.parallelBranchIndex]));
  assert.equal(branchOf.get("a2"), 0, "a2 仍属于分支①");
});

/** fork 不一定配有 join（资产校验不强制成对），END 必须算作边界，不能被当成并行分支成员。 */
test("fork 无配对 join 时 END 不归属任何分支", () => {
  const nodes = [node("start", "start"), node("fork", "parallel-fork"), node("a1"), node("b1"), node("end", "end")];
  const edges = [edge("start", "fork"), edge("fork", "a1"), edge("fork", "b1"), edge("a1", "end"), edge("b1", "end")];
  const byId = new Map(orderWorkflowNodesForDisplay(nodes, edges).map((entry) => [entry.node.id, entry]));
  assert.equal(byId.get("end")?.parallelBranchIndex, null, "END 不该带分支序号");
  assert.equal(byId.get("end")?.isBranchStart, false, "END 前不该画 ∥");
  assert.equal(byId.get("a1")?.parallelBranchIndex, 0);
  assert.equal(byId.get("b1")?.parallelBranchIndex, 1);
});

/** 有环或孤立节点时必须补齐，宁可顺序不完美也不能丢节点。 */
test("有环时未排到的节点按原顺序补齐，不丢节点", () => {
  const nodes = [node("start", "start"), node("x"), node("y")];
  const edges = [edge("start", "x"), edge("x", "y"), edge("y", "x")];
  const ids = idsOf(nodes, edges);
  assert.equal(ids.length, 3, "节点数必须与输入一致");
  assert.equal(ids[0], "start");
  assert.deepEqual(new Set(ids), new Set(["start", "x", "y"]));
});

/** 自环边不能把节点永远卡在环上。 */
test("自环边被忽略，节点照常参与排序", () => {
  const nodes = [node("start", "start"), node("a"), node("end", "end")];
  const edges = [edge("start", "a"), edge("a", "a"), edge("a", "end")];
  assert.deepEqual(idsOf(nodes, edges), ["start", "a", "end"]);
});
