import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panelSource = readFileSync(new URL("../src/features/admin/components/admin-mobile-settings-panel.vue", import.meta.url), "utf8");

test("all account roles retain notifications without H5 application configuration", () => {
  assert.match(panelSource, /<MessageNotificationsPanel :surface=/u);
  assert.doesNotMatch(panelSource, /AdminOfficeH5Panel|canManageOfficeH5|办公 H5/u);
  assert.match(panelSource, /grid-template-rows: minmax\(0, 1fr\)/u);
  // 面板不再有标题区，避免有人把「移动端配置」页头加回来。
  assert.doesNotMatch(panelSource, /admin-mobile-settings-panel__header|移动端配置/u);
});
