import test from "node:test";
import assert from "node:assert/strict";

import type { WorkflowDefinition } from "../../packages/shared/src/index.ts";
import { renderTemplate } from "../../apps/desktop/client/src/orchestration/templateRenderer.ts";

function createWorkflow(): WorkflowDefinition {
  return {
    id: "wf-1" as any,
    workspaceId: "ws-1" as any,
    family: "feature-dev",
    name: "模板测试",
    description: "模板测试",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "analysis", type: "role", roleId: "role-1" as any, label: "需求分析", position: { x: 0, y: 0 } },
    ],
    edges: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("renderTemplate keeps standalone requirement punctuation unchanged", () => {
  const rendered = renderTemplate("{{requirement}}", {
    context: {},
    workflow: createWorkflow(),
    globals: {
      requirement: "请为 test-role 新增导出统计能力。",
    },
  });

  assert.equal(rendered, "请为 test-role 新增导出统计能力。");
});

test("renderTemplate trims trailing sentence punctuation when requirement is embedded into a larger sentence", () => {
  const rendered = renderTemplate("请结合 {{requirement}}、上游方案与输入结果完成实现", {
    context: {},
    workflow: createWorkflow(),
    globals: {
      requirement: "请为 test-role 新增导出统计能力。",
    },
  });

  assert.equal(rendered, "请结合 请为 test-role 新增导出统计能力、上游方案与输入结果完成实现");
  assert.doesNotMatch(rendered, /。、|，、/);
});
