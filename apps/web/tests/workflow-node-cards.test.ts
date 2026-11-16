import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowNode } from "@codeflowai/shared";

import {
  buildConfigNodeCardViewModel,
  buildWorkflowNodeLabelIndex,
  isWorkflowTerminalNodeType,
  workflowNodeBoxSize,
  workflowNodeRadius,
} from "../src/features/orchestration/workflow-node-cards.ts";

const ROLE_NAME = "Loop 方案设计师（SOLUTION）";

/** 构造 role 节点，只填卡片构造函数真正读取的字段。 */
function roleNode(overrides: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: "role-1",
    type: "role",
    label: "方案设计节点",
    roleId: "role-1",
    position: { x: 0, y: 0 },
    inputBindings: [],
    knowledgeOverrideBundleIds: [],
    outputArtifactMode: null,
    approvalMode: null,
    workItemPolicy: null,
    startMode: null,
    outputResultKey: null,
    reworkPolicy: null,
    conditionExpr: null,
    conditionDecisionMode: null,
    ...overrides,
  } as unknown as WorkflowNode;
}

/** 角色名只应出现在卡片副标题；同时进 badge 会让同一张卡片显示两次。 */
test("node card shows the role name exactly once", () => {
  const card = buildConfigNodeCardViewModel(roleNode({ startMode: "manual" }), { roleName: ROLE_NAME });
  assert.equal(card.eyebrow, ROLE_NAME, "副标题应显示角色名");
  assert.deepEqual(card.badges.map((badge) => badge.text), ["手动启动"], "badge 里不得再出现角色名");
});

/** 未绑定角色时副标题给兜底提示，且不产生空 badge。 */
test("node card falls back when no role is bound", () => {
  const card = buildConfigNodeCardViewModel(roleNode({ roleId: null }), { roleName: null });
  assert.equal(card.eyebrow, "未绑定角色");
  assert.deepEqual(card.badges, []);
});

/** 其余 badge 不受影响；超过两个时按既有规则聚合，角色名不得借聚合重新混进来。 */
test("node card keeps the other role badges and aggregates beyond two", () => {
  const card = buildConfigNodeCardViewModel(
    roleNode({ workItemPolicy: { mode: "sequential" }, startMode: "manual", outputResultKey: "solution-plan" }),
    { roleName: ROLE_NAME },
  );
  assert.deepEqual(card.badges.map((badge) => badge.text), ["顺序工作项", "+2"]);
});

/** 退回徽标要列出可退回的节点名，只给个数读不出含义。 */
test("node card lists the rework target names", () => {
  const labels: Record<string, string> = { solution: "方案设计节点", dev: "TDD 开发（红绿重构）" };
  const card = buildConfigNodeCardViewModel(
    roleNode({ reworkPolicy: { allowedTargetNodeIds: ["solution", "dev"] } }),
    { roleName: ROLE_NAME, resolveNodeLabel: (nodeId) => labels[nodeId] ?? null },
  );
  assert.deepEqual(card.badges.map((badge) => badge.text), ["可退回：方案设计节点、TDD 开发（红绿重构）"]);
  assert.ok(
    !card.badges.some((badge) => /退回 \d/u.test(badge.text)),
    "不应再出现只给个数的形式",
  );
});

/** 解析不到节点名时回退显示 id，不能留空。 */
test("node card falls back to the node id when the label cannot be resolved", () => {
  const card = buildConfigNodeCardViewModel(
    roleNode({ reworkPolicy: { allowedTargetNodeIds: ["ghost-node"] } }),
    { roleName: ROLE_NAME },
  );
  assert.deepEqual(card.badges.map((badge) => badge.text), ["可退回：ghost-node"]);
});

const BASE_SIZE = { width: 208, height: 134 };

/** 开始/结束取正方形 bbox（边长沿用节点高度），其余节点保持卡片尺寸。 */
test("start/end use a square box while other node types keep the card size", () => {
  assert.deepEqual(workflowNodeBoxSize("start", BASE_SIZE), { width: 134, height: 134 });
  assert.deepEqual(workflowNodeBoxSize("end", BASE_SIZE), { width: 134, height: 134 });
  assert.deepEqual(workflowNodeBoxSize("role", BASE_SIZE), BASE_SIZE);
  assert.deepEqual(workflowNodeBoxSize(null, BASE_SIZE), BASE_SIZE);
});

/** 只有开始/结束是圆形；其余节点沿用各自的圆角，不要被圆形化。 */
test("only start/end get the circular radius", () => {
  assert.equal(workflowNodeRadius("start"), "50%");
  assert.equal(workflowNodeRadius("end"), "50%");
  assert.equal(workflowNodeRadius("condition"), "22px");
  assert.equal(workflowNodeRadius("role"), "12px");
  assert.equal(isWorkflowTerminalNodeType("start"), true);
  assert.equal(isWorkflowTerminalNodeType("role"), false);
});

/** 节点名索引必须能按 id 取到名字，且忽略空标签（空标签宁可回退显示 id，也不要显示空串）。 */
test("node label index maps ids to labels and skips blank labels", () => {
  const index = buildWorkflowNodeLabelIndex([
    { id: "role-1", label: "方案设计节点" },
    { id: "role-2", label: "  " },
    { id: "role-3", label: null as unknown as string },
  ]);
  assert.equal(index.get("role-1"), "方案设计节点");
  assert.equal(index.get("role-2"), undefined);
  assert.equal(index.get("role-3"), undefined);
  assert.equal(index.size, 1);
});
