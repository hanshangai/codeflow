import test from "node:test";
import assert from "node:assert/strict";

import type { TokenUsageState } from "@codeflowai/shared";

import {
  hasCurrentUsageData,
  resolveNextStableTokenUsage,
  resolveStableTokenUsageOnContentChange,
} from "../src/features/composer/context-usage-snapshot.ts";

function buildUsage(
  overrides: {
    current?: Partial<TokenUsageState["current"]>;
    cumulative?: Partial<TokenUsageState["cumulative"]>;
    turnPeak?: Partial<TokenUsageState["turnPeak"]>;
  } = {},
): TokenUsageState {
  return {
    current: {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      totalTokens: null,
      reasoningOutputTokens: null,
      modelContextWindow: null,
      ...overrides.current,
    },
    cumulative: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: null,
      reasoningOutputTokens: null,
      ...overrides.cumulative,
    },
    turnPeak: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      ...overrides.turnPeak,
    },
  };
}

test("window-only token usage is not treated as displayable context usage", () => {
  const usage = buildUsage({
    current: { modelContextWindow: 200_000 },
  });

  assert.equal(hasCurrentUsageData(usage), false);
  assert.equal(resolveStableTokenUsageOnContentChange(usage), null);
});

test("native total token usage is treated as displayable context usage", () => {
  const usage = buildUsage({
    current: { totalTokens: 178_043, modelContextWindow: 258_400 },
  });

  assert.equal(hasCurrentUsageData(usage), true);
  assert.deepEqual(resolveStableTokenUsageOnContentChange(usage), usage);
});

test("manual interrupt keeps the last real context snapshot when usage becomes null", () => {
  const previous = buildUsage({
    current: {
      inputTokens: 12_345,
      outputTokens: 678,
      cachedInputTokens: 900,
      cacheCreationInputTokens: 120,
      modelContextWindow: 200_000,
    },
    cumulative: {
      inputTokens: 12_345,
      outputTokens: 678,
      cachedInputTokens: 900,
      cacheCreationInputTokens: 120,
    },
    turnPeak: {
      inputTokens: 12_345,
      outputTokens: 678,
      cachedInputTokens: 900,
      cacheCreationInputTokens: 120,
    },
  });

  const next = resolveNextStableTokenUsage(previous, null);

  assert.notEqual(next, previous);
  assert.deepEqual(next, previous);
});

test("window-only follow-up usage keeps the last real context snapshot and only refreshes meta fields", () => {
  const previous = buildUsage({
    current: {
      inputTokens: 4_096,
      outputTokens: 512,
      cachedInputTokens: 1_024,
      cacheCreationInputTokens: 256,
      modelContextWindow: 128_000,
    },
    cumulative: {
      inputTokens: 4_096,
      outputTokens: 512,
      cachedInputTokens: 1_024,
      cacheCreationInputTokens: 256,
    },
    turnPeak: {
      inputTokens: 4_096,
      outputTokens: 512,
      cachedInputTokens: 1_024,
      cacheCreationInputTokens: 256,
    },
  });
  const followUp = buildUsage({
    current: { modelContextWindow: 256_000 },
    cumulative: {
      inputTokens: 8_192,
      outputTokens: 1_024,
      cachedInputTokens: 2_048,
      cacheCreationInputTokens: 512,
    },
  });

  const next = resolveNextStableTokenUsage(previous, followUp);

  assert.notEqual(next, previous);
  assert.equal(next?.current.inputTokens, 4_096);
  assert.equal(next?.current.cachedInputTokens, 1_024);
  assert.equal(next?.current.modelContextWindow, 256_000);
  assert.deepEqual(next?.cumulative, followUp.cumulative);
});

test("new real usage snapshot replaces the preserved snapshot", () => {
  const previous = buildUsage({
    current: { inputTokens: 1_000, modelContextWindow: 128_000 },
  });
  const current = buildUsage({
    current: {
      inputTokens: 32_768,
      outputTokens: 2_048,
      cachedInputTokens: 8_192,
      cacheCreationInputTokens: 4_096,
      modelContextWindow: 256_000,
    },
    cumulative: {
      inputTokens: 32_768,
      outputTokens: 2_048,
      cachedInputTokens: 8_192,
      cacheCreationInputTokens: 4_096,
    },
  });

  const next = resolveNextStableTokenUsage(previous, current);

  assert.deepEqual(next, current);
});
