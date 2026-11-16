import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  clientNeedsPackageUpgrade,
  isClientConnectionRetiredMessage,
  isClientUpgradeTargetReached,
} from "../src/features/settings/clientUpgradePolicy.ts";

test("源码 Client 不提醒升级，安装版和旧版 Client 仍按版本比较", () => {
  assert.equal(clientNeedsPackageUpgrade({ version: "2026.10.07.02", capabilities: { selfUpgrade: false } }, "2026.10.14.01"), false);
  assert.equal(clientNeedsPackageUpgrade({ version: "2026.10.07.02", capabilities: { selfUpgrade: true } }, "2026.10.14.01"), true);
  assert.equal(clientNeedsPackageUpgrade({ version: "2026.10.07.02" }, "2026.10.14.01"), true);
  assert.equal(clientNeedsPackageUpgrade({ version: "2026.10.14.01" }, "2026.10.14.01"), false);
  assert.equal(clientNeedsPackageUpgrade({ version: "2026.10.07.02" }, null), false);
});

test("Client 重新在线但版本未达到目标时不能判定升级成功", () => {
  assert.equal(isClientUpgradeTargetReached("2026.07.01.01", "2026.07.02.01"), false);
  assert.equal(isClientUpgradeTargetReached("2026.07.02.01", "2026.07.02.01"), true);
  assert.equal(isClientUpgradeTargetReached("2026.07.03.01", "2026.07.02.01"), true);
  assert.equal(isClientUpgradeTargetReached(null, "2026.07.02.01"), false);
});

test("Codex 状态检测不展示 Client 连接退役的内部提示", () => {
  assert.equal(isClientConnectionRetiredMessage("client 连接已退役：clientId=desktop-1, reason=socket_closed"), true);
  assert.equal(isClientConnectionRetiredMessage("Client 未连接"), false);
  assert.equal(isClientConnectionRetiredMessage("Codex CLI 检测失败"), false);
});

test("升级弹窗只通过实际版本完成升级且手动命令不含废弃 disturl", () => {
  const source = fs.readFileSync(
    new URL("../src/features/settings/components/client-upgrade-modal.vue", import.meta.url),
    "utf8",
  );

  assert.match(source, /isClientUpgradeTargetReached\(res\.clientVersion, latestVersion\.value\)/);
  assert.doesNotMatch(source, /seenOffline|presence\.isCurrentWorkspaceClientOnline/);
  assert.doesNotMatch(source, /--disturl/);
});

test("Client 管理弹窗不再内置 Codex CLI 升级入口", () => {
  const source = fs.readFileSync(
    new URL("../src/features/settings/components/client-management-modal.vue", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /CODEX_NPM_PACKAGE|loadCodexCliStatus|codexStatus|模型命令行依赖|Codex CLI 需要管理员权限/);
});
