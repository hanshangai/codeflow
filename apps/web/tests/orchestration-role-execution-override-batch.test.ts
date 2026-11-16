import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultRoleExecutionConfig } from "@codeflowai/shared";
import {
  applyRoleExecutionOverrideBatch,
  disableRoleExecutionOverrideBatch,
  listCommonRoleExecutionEngines,
  type RoleExecutionOverrideDraft,
} from "../src/features/orchestration/role-execution-override-batch.ts";

/** 构造指定启用引擎的角色配置，保持测试只关注公共引擎交集。 */
function buildExecutionConfig(enabledEngines: Array<"codex" | "claude">) {
  const config = createDefaultRoleExecutionConfig("codex");
  config.engineProfiles.codex.enabled = enabledEngines.includes("codex");
  config.engineProfiles.claude.enabled = enabledEngines.includes("claude");
  config.preferredEngine = config.engineProfiles.codex.enabled ? "codex" : "claude";
  return config;
}

test("批量设置只提供全部唯一角色共同启用的引擎", () => {
  assert.deepEqual(listCommonRoleExecutionEngines([
    { roleId: "role-a", executionConfig: buildExecutionConfig(["codex", "claude"]) },
    { roleId: "role-b", executionConfig: buildExecutionConfig(["codex"]) },
    { roleId: "role-a", executionConfig: buildExecutionConfig(["codex", "claude"]) },
  ]), ["codex"]);
  assert.deepEqual(listCommonRoleExecutionEngines([
    { roleId: "role-a", executionConfig: buildExecutionConfig(["codex"]) },
    { roleId: "role-b", executionConfig: buildExecutionConfig(["claude"]) },
  ]), []);
  assert.deepEqual(listCommonRoleExecutionEngines([]), []);
});

test("批量设置按唯一角色复制独立草稿并保留集合外配置", () => {
  const current: Record<string, RoleExecutionOverrideDraft> = {
    "role-outside": {
      enabled: true,
      engine: "claude",
      model: "claude-sonnet-4-5",
      effort: "high",
      autoCompactPct: 88,
    },
  };
  const next = applyRoleExecutionOverrideBatch(current, ["role-a", "role-b", "role-a", ""], {
    engine: "codex",
    model: "gpt-5.6-terra",
    effort: "max",
    autoCompactPct: 90,
  });

  assert.deepEqual(Object.keys(next).sort(), ["role-a", "role-b", "role-outside"]);
  assert.deepEqual(next["role-a"], {
    enabled: true,
    engine: "codex",
    model: "gpt-5.6-terra",
    effort: "max",
    autoCompactPct: 90,
  });
  assert.notEqual(next["role-a"], next["role-b"]);
  assert.equal(next["role-outside"], current["role-outside"]);
  assert.equal(current["role-a"], undefined);
});

test("恢复跟随角色定义只关闭目标覆盖且不丢失草稿字段", () => {
  const current: Record<string, RoleExecutionOverrideDraft> = {
    "role-a": {
      enabled: true,
      engine: "codex",
      model: "gpt-5.6-terra",
      effort: "high",
      autoCompactPct: 90,
    },
    "role-b": {
      enabled: true,
      engine: "claude",
      model: "claude-sonnet-4-5",
      effort: "high",
      autoCompactPct: 88,
    },
  };
  const next = disableRoleExecutionOverrideBatch(current, ["role-a", "role-a"]);

  assert.equal(next["role-a"]?.enabled, false);
  assert.equal(next["role-a"]?.model, "gpt-5.6-terra");
  assert.equal(next["role-b"]?.enabled, true);
  assert.equal(current["role-a"]?.enabled, true);
});
