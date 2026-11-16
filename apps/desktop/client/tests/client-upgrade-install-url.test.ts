import test from "node:test";
import assert from "node:assert/strict";

import { resolveClientUpgradeInstallUrl } from "../src/app/handlers/softwareUpdateHandlers.ts";

test("resolveClientUpgradeInstallUrl 允许当前 Server 同源 HTTPS 下载路径", () => {
  const installUrl = resolveClientUpgradeInstallUrl({
    serverWsUrl: "wss://codeflow-test.hanshangai.com/ws",
    downloadPath: "/downloads/codeflowai-2026.04.29.07.tgz",
    installUrl: null,
  });

  assert.equal(installUrl, "https://codeflow-test.hanshangai.com/downloads/codeflowai-2026.04.29.07.tgz");
});

test("resolveClientUpgradeInstallUrl 仍拒绝任意公网 HTTP 绝对安装地址", () => {
  const installUrl = resolveClientUpgradeInstallUrl({
    serverWsUrl: null,
    downloadPath: null,
    installUrl: "http://example.com/downloads/codeflowai-2026.04.29.07.tgz",
  });

  assert.equal(installUrl, null);
});

test("resolveClientUpgradeInstallUrl 忽略不同主机公网 HTTP 安装地址并使用当前 Server 下载路径", () => {
  const installUrl = resolveClientUpgradeInstallUrl({
    serverWsUrl: "wss://codeflow-test.hanshangai.com/ws/client",
    downloadPath: "/downloads/codeflowai-2026.04.29.07-win32-x64.tgz",
    installUrl: "http://example.com:39281/downloads/codeflowai-2026.04.29.07-win32-x64.tgz",
  });

  assert.equal(installUrl, "https://codeflow-test.hanshangai.com/downloads/codeflowai-2026.04.29.07-win32-x64.tgz");
});

test("resolveClientUpgradeInstallUrl 拒绝不符合 client 包命名规则的相对路径", () => {
  const installUrl = resolveClientUpgradeInstallUrl({
    serverWsUrl: "wss://codeflow-test.hanshangai.com/ws",
    downloadPath: "/downloads/evil.tgz",
    installUrl: null,
  });

  assert.equal(installUrl, null);
});
