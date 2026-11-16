import assert from "node:assert/strict";
import test from "node:test";

import { createToolPresentation } from "../src/engines/tool-presentation.ts";

test("Agent 工具按 description/subagent_type 派生摘要", () => {
  assert.equal(
    createToolPresentation({
      toolName: "Agent",
      input: { description: "Explore checkout files", subagent_type: "Explore" },
    }).summary,
    "[Explore] Explore checkout files",
  );
});

test("Agent 工具缺 description 时回落到 subagent_type 与 prompt", () => {
  assert.equal(
    createToolPresentation({ toolName: "Agent", input: { description: "检查结账流程" } }).summary,
    "检查结账流程",
  );
  assert.equal(
    createToolPresentation({ toolName: "Agent", input: { subagent_type: "Plan" } }).summary,
    "subagent: Plan",
  );
  assert.equal(
    createToolPresentation({ toolName: "Agent", input: { prompt: "p".repeat(120) } }).summary,
    `启动 agent: ${"p".repeat(77)}...`,
  );
});

test("Task 工具摘要与 Agent 同形，collabAgentToolCall 既有行为不变", () => {
  assert.equal(
    createToolPresentation({ toolName: "Task", input: { description: "d", subagent_type: "Explore" } }).summary,
    "[Explore] d",
  );
  assert.equal(
    createToolPresentation({ toolName: "collabAgentToolCall", input: { tool: "spawnAgent", prompt: "检查构建产物" } }).summary,
    "启动 agent: 检查构建产物",
  );
  assert.equal(
    createToolPresentation({ toolName: "collabAgentToolCall", input: { tool: "wait" } }).summary,
    "等待 agent",
  );
});
