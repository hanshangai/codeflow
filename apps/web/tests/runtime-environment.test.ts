import assert from "node:assert/strict";
import test from "node:test";

import { resolveRuntimeEnvironment, resolveRuntimeEnvironmentBadge } from "../src/utils/runtimeEnvironment.ts";

test("构建注入优先决定运行环境", () => {
  assert.equal(resolveRuntimeEnvironment({ VITE_CODEFLOWAI_RUNTIME_ENV: "test", DEV: false }), "test");
  assert.equal(resolveRuntimeEnvironment({ VITE_CODEFLOWAI_RUNTIME_ENV: "production", DEV: true }), "production");
  assert.equal(resolveRuntimeEnvironment({ VITE_CODEFLOWAI_RUNTIME_ENV: "dev", DEV: false }), "dev");
});

test("未注入时本地 Vite dev 显示 DEV，其余视为生产", () => {
  assert.equal(resolveRuntimeEnvironment({ DEV: true }), "dev");
  assert.equal(resolveRuntimeEnvironment({}), "production");
  assert.deepEqual(resolveRuntimeEnvironmentBadge({ VITE_CODEFLOWAI_RUNTIME_ENV: "dev" }), {
    label: "DEV",
    title: "本地开发环境",
  });
  assert.deepEqual(resolveRuntimeEnvironmentBadge({ VITE_CODEFLOWAI_RUNTIME_ENV: "test" }), {
    label: "TEST",
    title: "测试环境",
  });
  assert.equal(resolveRuntimeEnvironmentBadge({ VITE_CODEFLOWAI_RUNTIME_ENV: "production" }), null);
});
