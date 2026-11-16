import assert from "node:assert/strict";
import test from "node:test";

import { resolveBuiltInRelayBaseUrl } from "../../apps/web/src/features/settings/composables/useBuiltInRelayKey.ts";

test("built-in relay base url keeps Claude-compatible engines on public root", () => {
  assert.equal(resolveBuiltInRelayBaseUrl("claude", "https://relay.example.test/"), "https://relay.example.test");
});

test("built-in relay base url uses OpenAI v1 suffix for Codex", () => {
  assert.equal(resolveBuiltInRelayBaseUrl("codex", "https://relay.example.test/"), "https://relay.example.test/v1");
});

test("built-in relay base url rejects missing public url", () => {
  assert.throws(() => resolveBuiltInRelayBaseUrl("codex", "  "), /公开地址未配置/);
});
