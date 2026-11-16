import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) => readFileSync(new URL(`../src/features/orchestration/components/${file}`, import.meta.url), "utf8");
const layoutSource = read("orchestration-layout.vue");

test("builtin asset copy entry lives in each asset list instead of a global notice", () => {
  assert.doesNotMatch(layoutSource, /内置资产只读，复制后即可修改/u);
  assert.match(layoutSource, /@copy-builtin="copyBuiltinAsset\('workflow', \$event\)"/u);
  assert.match(layoutSource, /@copy-builtin="copyBuiltinAsset\('role', \$event\)"/u);
  assert.match(layoutSource, /@copy-builtin="copyBuiltinAsset\('knowledge_bundle', \$event\)"/u);
  assert.match(layoutSource, /@copy-builtin="copyBuiltinAsset\('toolset', \$event\)"/u);
  assert.match(layoutSource, /@copy-builtin="copyBuiltinAsset\('skill', \$event\)"/u);
});

for (const file of ["workflow-sidebar.vue", "role-list.vue", "knowledge-bundle-list.vue", "toolset-list.vue", "skill-list.vue"]) {
  test(`${file} exposes a copy action for builtin assets`, () => {
    const source = read(file);
    assert.match(source, /canCopyBuiltin\?: boolean;/u, file);
    assert.match(source, /copyingBuiltinAssetId\?: string \| null;/u, file);
    assert.match(source, /emit\('copy-builtin',/u, file);
    assert.match(source, /内置资产的复制入口常驻显示/u, file);
  });
}
