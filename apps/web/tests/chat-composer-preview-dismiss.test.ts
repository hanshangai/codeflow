import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/features/composer/components/chat-composer.vue", import.meta.url),
  "utf8",
);

test("composer focus closes global file preview windows", () => {
  assert.match(
    source,
    /function closePreviewWindowsOnComposerFocus\(\): void \{[\s\S]*?if \(!ui\.explorerPreviewWindows\.length\) return;[\s\S]*?ui\.closeAllPreviewWindows\(\);[\s\S]*?\}/u,
  );
  assert.match(source, /<a-textarea[\s\S]*?@focus="closePreviewWindowsOnComposerFocus"/u);
});
