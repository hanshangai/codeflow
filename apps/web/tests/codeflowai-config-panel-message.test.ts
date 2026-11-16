import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/features/settings/components/codeflowai-config-panel.vue", import.meta.url),
  "utf8",
);

test("duplicate config load failures replace one message instead of stacking", () => {
  assert.match(source, /const CONFIG_LOAD_ERROR_MESSAGE_KEY = "codeflowai-config-load-error";/u);
  assert.match(
    source,
    /message\.error\(\{\s*content: e instanceof Error \? e\.message : String\(e\),\s*key: CONFIG_LOAD_ERROR_MESSAGE_KEY,\s*duration: 3,/u,
  );
});
