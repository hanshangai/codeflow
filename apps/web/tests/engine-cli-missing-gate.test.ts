import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isEngineCliConfirmedMissing, resolveEngineCliStatusIssue } from "../src/utils/engineAvailability.ts";

/** 只构造判定所需字段，其余状态由类型断言隔离。 */
function status(overrides: Record<string, unknown>) {
  return { engineType: "claude", installed: false, version: null, binPath: null, features: {}, models: [],
    detectionStatus: "unavailable", error: "spawn claude ENOENT", ...overrides } as never;
}

test("confirmed missing CLI blocks execution while timeout remains advisory", () => {
  const missing = status({});
  assert.equal(isEngineCliConfirmedMissing(missing), true);
  assert.equal(resolveEngineCliStatusIssue("claude", missing), "Claude CLI 未安装或无法启动");

  const timeout = status({ detectionStatus: "timeout", error: "timeout" });
  assert.equal(isEngineCliConfirmedMissing(timeout), false);
  assert.match(resolveEngineCliStatusIssue("claude", timeout) ?? "", /仍可尝试/u);

  const legacyTimeout = status({ detectionStatus: undefined, error: "timeout" });
  assert.equal(isEngineCliConfirmedMissing(legacyTimeout), false);

  assert.equal(isEngineCliConfirmedMissing(status({ installed: true })), false);
  assert.equal(resolveEngineCliStatusIssue("claude", status({ installed: true })), null);
  assert.equal(isEngineCliConfirmedMissing(null), false);
});

test("composer wires the missing CLI gate to direct install/repair", () => {
  const source = readFileSync(new URL("../src/features/composer/components/chat-composer.vue", import.meta.url), "utf8");
  assert.match(source, /isEngineCliConfirmedMissing/u);
  assert.match(source, /engineCliMissingIssue/u);
  assert.match(source, /if \(engineCliMissingIssue\.value\) return engineCliMissingIssue\.value;/u);
  assert.match(source, /async function repairEngineCli\(/u);
  assert.match(source, /npmInstall\(/u);
  assert.match(source, /安装\/修复 CLI/u);
  assert.match(source, /currentModelProviderIssue && !engineCliMissing/u);
});
