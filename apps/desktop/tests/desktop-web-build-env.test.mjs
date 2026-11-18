import test from "node:test";
import assert from "node:assert/strict";
import { resolveDesktopWebBuildEnv } from "../../../tools/release/desktop-resources.mjs";

test("测试桌面 Web 使用 HTTPS 环境对应的 WSS，清除外部旧环境污染", () => {
  const env = resolveDesktopWebBuildEnv({ environment: "test" }, { VITE_CODEFLOWAI_SERVER_WS_ORIGIN: "ws://127.0.0.1:39280", VITE_AIDT_CODE_SERVER_WS_ORIGIN: "wss://wrong.example", OTHER: "keep" });
  assert.equal(env.VITE_CODEFLOWAI_SERVER_WS_ORIGIN, "wss://codeflow-test.hanshangai.com");
  assert.equal(env.VITE_AIDT_CODE_SERVER_WS_ORIGIN, undefined);
  assert.equal(env.OTHER, "keep");
});

test("生产桌面与测试环境显式隔离，未知目标拒绝打包", () => {
  assert.equal(resolveDesktopWebBuildEnv({ environment: "production" }, {}).VITE_CODEFLOWAI_SERVER_WS_ORIGIN, "wss://codeflow.hanshangai.com");
  assert.throws(() => resolveDesktopWebBuildEnv({ environment: "invalid" }, {}), /DESKTOP_WEB_BUILD_ENVIRONMENT_INVALID/u);
});
