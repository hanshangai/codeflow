import test from "node:test";
import assert from "node:assert/strict";

import { tryExtractTokenUsage } from "../../apps/desktop/client/src/engines/claude/claudeJson.ts";

test("tryExtractTokenUsage prefers the current Claude model when modelUsage contains multiple entries", () => {
  const usage = tryExtractTokenUsage({
    type: "result",
    usage: {
      input_tokens: 80_600,
      output_tokens: 2_048,
    },
    result: {
      modelUsage: {
        "claude-opus-4-7": { contextWindow: 200_000 },
        "claude-opus-4-7[1m]": { contextWindow: 1_000_000 },
      },
    },
  }, "claude-opus-4-7[1m]");

  assert.equal(usage?.inputTokens, 80_600);
  assert.equal(usage?.outputTokens, 2_048);
  assert.equal(usage?.modelContextWindow, 1_000_000);
});

test("tryExtractTokenUsage uses the event model id before falling back to modelUsage ordering", () => {
  const usage = tryExtractTokenUsage({
    type: "result",
    model: "claude-opus-4-7[1m]",
    usage: {
      input_tokens: 80_600,
    },
    result: {
      modelUsage: {
        "claude-opus-4-7": { contextWindow: 200_000 },
        "claude-opus-4-7[1m]": { contextWindow: 1_000_000 },
      },
    },
  });

  assert.equal(usage?.modelContextWindow, 1_000_000);
});

test("tryExtractTokenUsage leaves contextWindow unset when multi-model usage is ambiguous", () => {
  const usage = tryExtractTokenUsage({
    type: "result",
    usage: {
      input_tokens: 80_600,
    },
    result: {
      modelUsage: {
        "claude-opus-4-7": { contextWindow: 200_000 },
        "claude-opus-4-7[1m]": { contextWindow: 1_000_000 },
      },
    },
  });

  assert.equal(usage?.inputTokens, 80_600);
  assert.equal(usage?.modelContextWindow, null);
});

test("tryExtractTokenUsage merges nested stream usage and ignores zero placeholders", () => {
  const usage = tryExtractTokenUsage({
    type: "stream_event",
    usage: { input_tokens: 0, output_tokens: 0 },
    event: {
      type: "message_delta",
      usage: { input_tokens: 23_668, output_tokens: 92 },
    },
  });

  assert.deepEqual(usage, {
    inputTokens: 23_668,
    outputTokens: 92,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    modelContextWindow: null,
  });
});
