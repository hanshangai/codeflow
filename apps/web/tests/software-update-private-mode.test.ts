import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  formatCliInstallSize,
  isPrivateInstallMode,
  privateInstallActionLabel,
} from "../src/features/settings/softwareInstallPresentation.ts";

const panelSource = readFileSync(
  new URL("../src/features/settings/components/software-update-panel.vue", import.meta.url),
  "utf8",
);

test("private mode labels reuse the CLI as repair instead of a disabled installed state", () => {
  assert.equal(isPrivateInstallMode({ installMode: "private" } as never), true);
  assert.equal(isPrivateInstallMode({ installMode: "global" } as never), false);
  assert.equal(formatCliInstallSize(350000000), "约 334 MB");
  assert.equal(privateInstallActionLabel({ installed: true, updateAvailable: false } as never, true), "重新安装");
  assert.equal(privateInstallActionLabel({ installed: false, updateAvailable: false } as never, true), "安装");
  assert.equal(privateInstallActionLabel({ installed: true, currentVersion: "2.1.283", latestVersion: "2.1.318",
    updateAvailable: false } as never, true), "更新");
  assert.equal(privateInstallActionLabel({ installed: true, currentVersion: "2.1.318", latestVersion: "2.1.283",
    updateAvailable: false } as never, true), "重新安装");
});

test("private mode is only enabled by the explicit private install mode", () => {
  assert.equal(isPrivateInstallMode(null), false);
  assert.equal(isPrivateInstallMode(undefined), false);
  assert.equal(isPrivateInstallMode({} as never), false);
});

test("install size keeps the documented rounding contract and rejects unusable values", () => {
  assert.equal(formatCliInstallSize(1024 * 1024), "约 1 MB");
  assert.equal(formatCliInstallSize(1024 * 1024 * 1.49), "约 1 MB");
  assert.equal(formatCliInstallSize(1024 * 1024 * 1.5), "约 2 MB");
  for (const value of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatCliInstallSize(value), "");
  }
});

test("legacy install labels keep the previous install/update/installed wording", () => {
  assert.equal(privateInstallActionLabel({ installed: false, updateAvailable: false } as never, false), "安装");
  assert.equal(privateInstallActionLabel({ installed: true, updateAvailable: true } as never, false), "更新");
  assert.equal(privateInstallActionLabel({ installed: true, updateAvailable: false } as never, false), "已安装");
  assert.equal(privateInstallActionLabel({ installed: false, updateAvailable: true } as never, true), "安装");
  assert.equal(privateInstallActionLabel({ installed: true, updateAvailable: true } as never, true), "更新");
});

test("private install panel shows the mode tag and estimated size", () => {
  assert.match(panelSource, /isPrivateInstallMode/u);
  assert.match(panelSource, /应用私有/u);
  assert.doesNotMatch(panelSource, /安装到应用数据目录，不需要管理员权限；CLI 版本由应用固定。/u);
  assert.match(panelSource, /formatCliInstallSize/u);
  assert.match(panelSource, /预计占用/u);
});

test("private install panel allows repair and suppresses npm-global privilege guidance", () => {
  assert.match(panelSource, /needsPrivilegePrompt = computed\(\(\) => !isPrivateMode\.value/u);
  assert.match(panelSource, /installRequiresPrivilege[\s\S]*?!isPrivateMode\.value/u);
  assert.match(panelSource, /!isPrivateMode\.value && looksLikePrivilegeError/u);
  assert.match(panelSource, /:disabled="[^"]*!isPrivateMode && item\.installed && !item\.updateAvailable\)/u);
});
