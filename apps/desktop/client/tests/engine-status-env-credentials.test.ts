import assert from "node:assert/strict";
import test from "node:test";

import { mergeNativeAuthWithProcessEnv } from "../src/app/handlers/engineHandlers.ts";

const none = { available: false, source: "none", issue: null } as const;

test("process env credentials count as local api key when native files are absent", () => {
  for (const [engine, env] of [
    ["claude", { ANTHROPIC_AUTH_TOKEN: "token" }],
    ["claude", { ANTHROPIC_API_KEY: "key" }],
    ["codex", { OPENAI_API_KEY: "key" }],
  ] as const) {
    assert.deepEqual(mergeNativeAuthWithProcessEnv(engine, none, env), { available: true, source: "local_api_key", issue: null });
  }
  assert.deepEqual(mergeNativeAuthWithProcessEnv("claude", none, { OPENAI_API_KEY: "key" }), none);
  assert.deepEqual(mergeNativeAuthWithProcessEnv("codex", none, { ANTHROPIC_AUTH_TOKEN: "token" }), none);
  assert.deepEqual(mergeNativeAuthWithProcessEnv("claude", none, { ANTHROPIC_AUTH_TOKEN: "  " }), none);
  const oauth = { available: true, source: "local_oauth", issue: null } as const;
  assert.deepEqual(mergeNativeAuthWithProcessEnv("claude", oauth, { ANTHROPIC_AUTH_TOKEN: "token" }), oauth);
});
