import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panelSource = readFileSync(new URL("../src/features/admin/components/account-relay-usage-panel.vue", import.meta.url), "utf8");

test("relay usage summary mounts once and remains cached across tab switches", () => {
  assert.match(panelSource, /const summaryTabVisited = ref\(activeUsageTab\.value === "summary"\)/u);
  assert.match(panelSource, /if \(activeUsageTab\.value === "summary"\) \{\s*summaryTabVisited\.value = true;/u);
  assert.match(panelSource, /<AccountRelayUsageSummaryTab v-if="summaryTabVisited" ref="summaryTabRef"/u);
  assert.doesNotMatch(panelSource, /<AccountRelayUsageSummaryTab v-if="activeUsageTab === 'summary'"/u);
});
