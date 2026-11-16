import test from "node:test";
import assert from "node:assert/strict";

import { summarizeImageInputs } from "../src/diagnostics/imageInputDiagnostics.ts";

test("summarizeImageInputs distinguishes pasted data URLs and local paths", () => {
  const summary = summarizeImageInputs([
    "data:image/png;base64,AAAA",
    "D:\\cf\\.codex\\test-home.png",
    "https://example.com/image.png",
    "data:image/png;base64,",
    "",
  ]);

  assert.deepEqual(summary, {
    imageCount: 5,
    nonEmptyImageCount: 4,
    emptyImageCount: 1,
    dataUrlCount: 2,
    malformedDataUrlCount: 1,
    remoteUrlCount: 1,
    localPathCount: 1,
    otherCount: 0,
  });
});

test("summarizeImageInputs does not expose image content", () => {
  const summary = summarizeImageInputs(["data:image/png;base64,secret-image-content"]);

  assert.equal(summary.dataUrlCount, 1);
  assert.equal(JSON.stringify(summary).includes("secret-image-content"), false);
});
