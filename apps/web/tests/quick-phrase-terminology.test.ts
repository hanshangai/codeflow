import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function readSource(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("常用提示词相关入口与反馈文案保持一致", () => {
  const oldTerm = "\u5e38\u7528\u8bed";
  const sources = [
    "apps/web/src/features/composer/components/quick-phrase-picker.vue",
    "apps/web/src/store/quickPhrases.ts",
    "apps/web/src/services/ws.ts",
  ].map(readSource);

  for (const source of sources) {
    assert.equal(source.includes(oldTerm), false);
    assert.match(source, /常用提示词/u);
  }

  assert.match(sources[0]!, /quick_phrase_open/u);
  assert.match(sources[1]!, /quickPhrases/u);
});
