import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const layoutSource = readFileSync(new URL("../src/features/admin/components/admin-layout.vue", import.meta.url), "utf8");

test("relay usage page scrolls in the admin content viewport", () => {
  const internalScrollPanels = layoutSource.match(/const internalScrollPanels = new Set<AdminPanel>\(\[([\s\S]*?)\]\);/u)?.[1] ?? "";
  const contentRule = layoutSource.match(/\.admin-layout__content \{([\s\S]*?)\n\}/u)?.[1] ?? "";

  assert.doesNotMatch(internalScrollPanels, /"relay-self-usage"/u);
  assert.match(contentRule, /min-height: 0;/u);
  assert.match(contentRule, /overflow: auto;/u);
});
