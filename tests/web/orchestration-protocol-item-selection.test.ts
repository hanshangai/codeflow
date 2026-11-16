import test from "node:test";
import assert from "node:assert/strict";

import { resolveProtocolSelectedFilePath } from "../../apps/web/src/features/messages/protocol-file-selection.ts";

test("resolveProtocolSelectedFilePath keeps the current file when it still exists", () => {
  const selected = resolveProtocolSelectedFilePath({
    currentSelectedFilePath: "b.log",
    nextFilePaths: ["a.md", "b.log", "c.json"],
  });

  assert.equal(selected, "b.log");
});

test("resolveProtocolSelectedFilePath falls back to the first file when selection is missing", () => {
  const selected = resolveProtocolSelectedFilePath({
    currentSelectedFilePath: "missing.log",
    nextFilePaths: ["a.md", "b.log", "c.json"],
  });

  assert.equal(selected, "a.md");
});

test("resolveProtocolSelectedFilePath returns null when there are no files", () => {
  const selected = resolveProtocolSelectedFilePath({
    currentSelectedFilePath: "b.log",
    nextFilePaths: [],
  });

  assert.equal(selected, null);
});
