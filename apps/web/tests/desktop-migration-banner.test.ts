import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const banner = readFileSync(
  new URL("../src/features/desktop/components/desktop-migration-banner.vue", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../src/standard-app.vue", import.meta.url), "utf8");

test("迁移提示关闭状态由应用外壳持有，切换视图不重置，刷新后才重新出现", () => {
  assert.match(banner, /closable/u);
  assert.match(banner, /emit\("close"\)/u);
  assert.doesNotMatch(banner, /const visible = ref\(true\)/u);
  assert.match(app, /desktopMigrationBannerDismissed = ref\(false\)/u);
  assert.match(app, /@close="desktopMigrationBannerDismissed = true"/u);
  assert.match(app, /!desktopMigrationBannerDismissed\.value/u);
});
