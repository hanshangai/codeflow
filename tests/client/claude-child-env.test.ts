import test from "node:test";
import assert from "node:assert/strict";

import { buildClaudeChildEnv } from "../../apps/desktop/client/src/engines/claude/claudeThreadSession.ts";

test("Claude child env keeps Anthropic OAuth env when only another provider has a key", () => {
  const env = buildClaudeChildEnv({
    ANTHROPIC_AUTH_TOKEN: "oauth-token",
  }, {
    dangerouslySkipPermissions: false,
    providerId: "anthropic",
    hasConfiguredCredentials: (providerId) => providerId === "deepseek",
    readCredentials: (providerId) => providerId === "deepseek"
      ? { apiKey: "sk-deepseek", baseUrl: "https://deepseek.example.test/anthropic" }
      : null,
  });

  assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "oauth-token");
});

test("Claude child env uses managed key only for the selected provider", () => {
  const env = buildClaudeChildEnv({
    ANTHROPIC_AUTH_TOKEN: "oauth-token",
  }, {
    dangerouslySkipPermissions: false,
    providerId: "deepseek",
    hasConfiguredCredentials: (providerId) => providerId === "deepseek",
    readCredentials: (providerId) => providerId === "deepseek"
      ? { apiKey: "sk-deepseek", baseUrl: "https://deepseek.example.test/anthropic" }
      : null,
  });

  assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-deepseek");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://deepseek.example.test/anthropic");
});

test("Claude child env lets the native CLI derive its own entrypoint", () => {
  const env = buildClaudeChildEnv({
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    CLAUDECODE: "1",
  }, {
    dangerouslySkipPermissions: false,
    providerId: "anthropic",
  });

  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.CLAUDECODE, undefined);
});
