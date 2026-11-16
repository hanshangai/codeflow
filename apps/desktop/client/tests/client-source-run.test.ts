import assert from "node:assert/strict";
import test from "node:test";

import { isClientSourceRun } from "../src/app/clientInstallEntry.ts";

test("本地源码、构建及仓库 bin 入口不提示安装包升级", () => {
  for (const entry of [
    "D:\\code\\aidt-code\\apps\\desktop\\client\\src\\index.ts",
    "/repo/apps/desktop/client/src/index.ts",
    "/repo/apps/desktop/client/dist/index.cjs",
    "/repo/apps/desktop/client/bin/codeflow.js",
  ]) assert.equal(isClientSourceRun(entry), true, entry);
});

test("已安装 Client 和未知入口保留版本升级提醒", () => {
  for (const entry of [
    "C:\\Users\\user\\AppData\\Local\\CodeFlowAI\\npm\\node_modules\\@codeflowai\\client\\bin\\codeflow.js",
    "/usr/local/lib/node_modules/@codeflowai/client/bin/codeflow.js",
    "/repo/node_modules/@codeflowai/client/bin/codeflow.js",
    "/other/src/index.ts",
    "",
    null,
  ]) assert.equal(isClientSourceRun(entry), false, String(entry));
});
