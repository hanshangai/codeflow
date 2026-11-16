import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("../src/features/orchestration-metrics/OrchestrationMetricsPanel.vue", import.meta.url), "utf8");

test("orchestration metrics keeps a viewport-owned scroll region in every data state", () => {
  const rootRule = panel.match(/\.orchestration-metrics \{([\s\S]*?)\n\}/u)?.[1] ?? "";

  assert.match(rootRule, /grid-auto-rows: max-content;/u);
  assert.match(rootRule, /align-content: start;/u);
  assert.match(rootRule, /height: 100%;/u);
  assert.match(rootRule, /min-height: 0;/u);
  assert.match(rootRule, /overflow: auto;/u);
});

test("orchestration metrics resets only when scalar session identity changes", () => {
  assert.match(
    panel,
    /watch\(\s*\[\s*\(\) => config\.serverWsOrigin,\s*\(\) => String\(config\.userSummary\?\.userId \?\? ""\),\s*\(\) => config\.sessionToken \?\? "",\s*\],\s*\(\[serverWsOrigin, userId, sessionToken\]\)/u,
  );
  assert.doesNotMatch(
    panel,
    /watch\(\s*\(\) => \[config\.serverWsOrigin, String\(config\.userSummary\?\.userId/u,
  );
});

test("orchestration metrics keeps the initial loading state until the first dashboard batch settles", () => {
  assert.match(panel, /const initializing = ref\(true\);/u);
  assert.match(panel, /const loading = computed\(\(\) => initializing\.value \|\|/u);
  assert.match(
    panel,
    /async function initializeMetricView\(\): Promise<void> \{[\s\S]*?initializing\.value = true;[\s\S]*?await loadDashboard\(\);[\s\S]*?finally \{[\s\S]*?requestVersion === initializationRequestVersion\) initializing\.value = false;/u,
  );
  // 卡片区改由外层 template 以 activeTab === 'overview' && summary 守卫；!initializing 由上方分支顺序（initial-loading 在前）保证。
  assert.match(panel, /<template v-if="activeTab === 'overview' && summary">\s*<div class="orchestration-metrics__cards">/u);

  const loadingStateIndex = panel.indexOf('<div v-if="initializing" class="orchestration-metrics__initial-loading"');
  const emptyStateIndex = panel.indexOf('<a-empty v-else-if="showEmpty');
  const contentStateIndex = panel.indexOf('<template v-else-if="summary || activeTab');
  assert.ok(loadingStateIndex >= 0);
  assert.ok(emptyStateIndex > loadingStateIndex);
  assert.ok(contentStateIndex > emptyStateIndex);
});

/** 编排度量与交付效能是两套口径：空态入口必须先预检交付事实，避免引导到同样为空的视图。 */
test("orchestration metrics probes delivery facts before offering the cross-metric entry", () => {
  assert.match(panel, /const deliveryEntryState = ref<"idle" \| "probing" \| "available" \| "empty">\("idle"\);/u);
  assert.match(panel, /const result = await getOrchestrationMetricDelivery\(ctx\.value, buildQueryFilters\(1, 1\)\);/u);
  assert.match(panel, /deliveryEntryState\.value = !result\.ok \|\| result\.total > 0 \? "available" : "empty";/u);
  assert.match(
    panel,
    /<a-button v-if="deliveryEntryState === 'available'" @click="activeTab = 'delivery'">查看交付效能<\/a-button>/u,
  );
  // 不允许退回无条件展示跨口径入口。
  assert.doesNotMatch(panel, /<a-button @click="activeTab = 'delivery'">查看交付效能<\/a-button>/u);
  // 预检必须挂在查询完成路径上，否则状态永远停在 idle、入口不会出现。
  assert.match(
    panel,
    /await Promise\.all\(requests\);\s*if \(requestVersion !== dashboardRequestVersion \|\| !componentActive\) return;\s*void probeDeliveryEntry\(\);/u,
  );
});
