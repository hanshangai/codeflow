import assert from "node:assert/strict";
import test from "node:test";

import { CLAUDE_MODELS } from "@codeflowai/shared";

import { buildModelSelectOptionGroups } from "../src/composables/modelSelectOptions.ts";

test("已合并的历史别名归一到目录条目，不再产生当前模型兜底项", () => {
  const groups = buildModelSelectOptionGroups(CLAUDE_MODELS, "deepseek-flash[1m]", { engine: "claude" });

  // 兜底组只有「当前模型」与「当前模型（已移除）」两种标签；别名命中目录时不应出现任何一种。
  assert.equal(groups.some((group) => group.label.startsWith("当前模型")), false);
  assert.equal(
    groups.some((group) => group.options.some((option) => option.value === "deepseek-flash[1m]")),
    false,
  );
  assert.equal(
    groups.some((group) => group.options.some((option) => option.value === "deepseek-flash")),
    true,
  );
});

test("目录外的未知模型保留「当前模型（已移除）」兜底项", () => {
  const groups = buildModelSelectOptionGroups(CLAUDE_MODELS, "unknown-model-x", { engine: "claude" });
  const fallback = groups.find((group) => group.label === "当前模型（已移除）");

  assert.ok(fallback);
  assert.equal(fallback.options[0]?.value, "unknown-model-x");
  assert.equal(fallback.options[0]?.label, "unknown-model-x（已移除）");
});

test("未提供引擎时不归一别名，历史别名落入「当前模型（已移除）」兜底", () => {
  const groups = buildModelSelectOptionGroups(CLAUDE_MODELS, "deepseek-flash[1m]");
  const fallback = groups.find((group) => group.label === "当前模型（已移除）");

  assert.ok(fallback);
  assert.equal(fallback.options[0]?.value, "deepseek-flash[1m]");
});
