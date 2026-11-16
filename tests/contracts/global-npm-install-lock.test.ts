import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireGlobalNpmInstall,
  getActiveGlobalNpmInstall,
  resetGlobalNpmInstallLockForTests,
} from "../../apps/desktop/client/src/app/handlers/globalNpmInstallLock.ts";

test("global npm install lock rejects a second concurrent task", () => {
  resetGlobalNpmInstallLockForTests();
  const first = acquireGlobalNpmInstall("大模型 CLI 更新：@anthropic-ai/claude-code");
  assert.equal(first.ok, true);

  const second = acquireGlobalNpmInstall("大模型 CLI 更新：@openai/codex");
  assert.equal(second.ok, false);
  if (second.ok) {
    assert.fail("second acquire should have been rejected");
  }
  assert.equal(second.activeTask.label, "大模型 CLI 更新：@anthropic-ai/claude-code");

  if (first.ok) {
    first.release();
  }
  assert.equal(getActiveGlobalNpmInstall(), null);
});

test("global npm install lock can be reacquired after release", () => {
  resetGlobalNpmInstallLockForTests();
  const first = acquireGlobalNpmInstall("客户端升级：2026.04.05.01 -> 2026.04.05.02");
  assert.equal(first.ok, true);
  if (!first.ok) {
    assert.fail("first acquire should have succeeded");
  }

  first.release();
  const second = acquireGlobalNpmInstall("大模型 CLI 更新：@openai/codex");
  assert.equal(second.ok, true);
  if (!second.ok) {
    assert.fail("second acquire should have succeeded after release");
  }

  second.release();
  assert.equal(getActiveGlobalNpmInstall(), null);
});
