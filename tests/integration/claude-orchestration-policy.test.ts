import test from "node:test";
import assert from "node:assert/strict";
import { ENGINE_MODEL_CATALOG_SCHEMA_VERSION } from "../../packages/shared/src/index.ts";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "../../packages/shared/src/engineModelCatalogSeed.ts";
import {
  applyEngineModelCatalogSnapshot,
  resetEngineModelCatalogRuntimeForTest,
} from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";

import {
  buildClaudeArgs,
  resolveClaudeLaunchModelId,
  resolveClaudeLaunchEffort,
  resolveClaudeModelRuntimeEnv,
  resolveClaudeModelSettingsEnv,
  resolveClaudePermissionLaunchMode,
  shouldClaudeForceSandboxEnv,
} from "../../apps/desktop/client/src/engines/claude/claudeCli.ts";
import { resolveClaudeControlMode } from "../../apps/desktop/client/src/engines/claude/claudeApproval.ts";
import { buildClaudeChildEnv } from "../../apps/desktop/client/src/engines/claude/claudeThreadSession.ts";

test.before(() => {
  applyEngineModelCatalogSnapshot({
    schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
    configVersion: 1,
    capturedAt: 0,
    rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1],
  });
});
test.after(() => resetEngineModelCatalogRuntimeForTest());

const EXPECTED_FIXED_PROMPT_CACHING_ENV = {
  ENABLE_PROMPT_CACHING_1H: "1",
  FORCE_PROMPT_CACHING_5M: "0",
  DISABLE_PROMPT_CACHING: "0",
  DISABLE_PROMPT_CACHING_HAIKU: "0",
  DISABLE_PROMPT_CACHING_SONNET: "0",
  DISABLE_PROMPT_CACHING_OPUS: "0",
  DISABLE_PROMPT_CACHING_FABLE: "0",
  DISABLE_PROMPT_CACHING_MYTHOS: "0",
} as const;

function readPermissionMode(args: string[]): string | null {
  const index = args.indexOf("--permission-mode");
  return index >= 0 ? String(args[index + 1] ?? "") : null;
}

/** 读取 Claude `--settings` 中最终注入的环境变量。 */
function readSettingsEnv(args: string[]): Record<string, string> {
  const index = args.indexOf("--settings");
  assert.ok(index >= 0);
  const settings = JSON.parse(String(args[index + 1] ?? "{}")) as { env?: Record<string, string> };
  return settings.env ?? {};
}

test("buildClaudeArgs uses the long-lived Desktop/Agent SDK stream protocol", () => {
  const args = buildClaudeArgs({
    text: "persistent stream",
    sessionId: null,
    planMode: false,
    accessMode: "current",
    conversationProfile: "default",
    inputFormat: "stream-json",
  });

  assert.equal(args.includes("-p"), false);
  assert.deepEqual(args.slice(0, 4), ["--input-format", "stream-json", "--output-format", "stream-json"]);
  assert.equal(args.includes("--verbose"), true);
});

test("buildClaudeArgs fixes prompt caching in flag settings", () => {
  const args = buildClaudeArgs({
    text: "fixed prompt cache",
    sessionId: null,
    planMode: false,
    accessMode: "current",
    conversationProfile: "default",
    inputFormat: "text",
  });

  assert.deepEqual(readSettingsEnv(args), EXPECTED_FIXED_PROMPT_CACHING_ENV);
});

test("buildClaudeArgs keeps auto compact settings with fixed prompt caching", () => {
  const args = buildClaudeArgs({
    text: "fixed prompt cache with auto compact",
    sessionId: null,
    planMode: false,
    accessMode: "current",
    conversationProfile: "default",
    inputFormat: "text",
    autoCompactPct: 85,
  });

  assert.deepEqual(readSettingsEnv(args), {
    ...EXPECTED_FIXED_PROMPT_CACHING_ENV,
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "85",
  });
});

test("buildClaudeArgs keeps normal chat read-only mapped to Claude plan mode", () => {
  const args = buildClaudeArgs({
    text: "read only chat",
    sessionId: null,
    planMode: false,
    accessMode: "read-only",
    conversationProfile: "default",
    inputFormat: "text",
  });

  assert.equal(readPermissionMode(args), "plan");
});

test("resolveClaudePermissionLaunchMode keeps orchestration read-only on default mode instead of fake hard read-only", () => {
  assert.deepEqual(resolveClaudePermissionLaunchMode({
    planMode: false,
    accessMode: "read-only",
    conversationProfile: "orchestration",
  }), {
    permissionMode: "default",
    dangerouslySkipPermissions: false,
  });
});

test("resolveClaudeControlMode keeps orchestration read-only aligned with default mode while normal chat stays on plan", () => {
  assert.equal(resolveClaudeControlMode({
    planMode: false,
    accessMode: "read-only",
    conversationProfile: "orchestration",
  }), "default");
  assert.equal(resolveClaudeControlMode({
    planMode: false,
    accessMode: "read-only",
    conversationProfile: "default",
  }), "plan");
});

test("buildClaudeArgs keeps orchestration current turns on acceptEdits mode", () => {
  const readOnlyArgs = buildClaudeArgs({
    text: "orchestration current",
    sessionId: null,
    planMode: false,
    accessMode: "current",
    conversationProfile: "orchestration",
    inputFormat: "text",
  });
  assert.equal(readPermissionMode(readOnlyArgs), "acceptEdits");
});

test("buildClaudeArgs keeps orchestration full-access on Claude bypass permissions", () => {
  const fullAccessArgs = buildClaudeArgs({
    text: "orchestration full access",
    sessionId: null,
    planMode: false,
    accessMode: "full-access",
    conversationProfile: "orchestration",
    inputFormat: "text",
  });
  assert.equal(readPermissionMode(fullAccessArgs), null);
  assert.ok(fullAccessArgs.includes("--dangerously-skip-permissions"));
});

test("buildClaudeArgs adds per-turn MCP config without hiding local MCP configs", () => {
  const args = buildClaudeArgs({
    text: "orchestration with platform tools",
    sessionId: null,
    planMode: false,
    accessMode: "current",
    conversationProfile: "orchestration",
    inputFormat: "text",
    mcpConfigPath: "C:/tmp/aidt-runtime-mcp.json",
  });

  assert.deepEqual(args.slice(args.indexOf("--mcp-config"), args.indexOf("--mcp-config") + 2), [
    "--mcp-config",
    "C:/tmp/aidt-runtime-mcp.json",
  ]);
  assert.equal(args.includes("--strict-mcp-config"), false);
});

test("buildClaudeArgs uses append system prompt file when provided", () => {
  const args = buildClaudeArgs({
    text: "orchestration with long system prompt",
    sessionId: null,
    planMode: false,
    accessMode: "current",
    conversationProfile: "orchestration",
    inputFormat: "stream-json",
    appendSystemPrompt: "inline system prompt should not be passed",
    appendSystemPromptFilePath: "C:/tmp/append-system-prompt.txt",
  });

  assert.equal(args.includes("--append-system-prompt"), false);
  assert.deepEqual(args.slice(args.indexOf("--append-system-prompt-file"), args.indexOf("--append-system-prompt-file") + 2), [
    "--append-system-prompt-file",
    "C:/tmp/append-system-prompt.txt",
  ]);
});

test("buildClaudeArgs omits strict MCP flag when no per-turn MCP config is provided", () => {
  const args = buildClaudeArgs({
    text: "orchestration without platform tools",
    sessionId: null,
    planMode: false,
    accessMode: "current",
    conversationProfile: "orchestration",
    inputFormat: "text",
    strictMcpConfig: true,
  });

  assert.equal(args.includes("--mcp-config"), false);
  assert.equal(args.includes("--strict-mcp-config"), false);
});

test("buildClaudeArgs passes selected DeepSeek model and effort as launch parameters", () => {
  const args = buildClaudeArgs({
    text: "use deepseek",
    sessionId: null,
    planMode: false,
    accessMode: "current",
    conversationProfile: "default",
    model: "deepseek-v4-pro",
    effort: "high",
    inputFormat: "text",
  });

  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "deepseek-v4-pro[1m]"]);
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "high"]);
});

test("buildClaudeArgs appends the 1M transport marker to the base DeepSeek Flash model", () => {
  const args = buildClaudeArgs({
    text: "use deepseek flash",
    sessionId: null,
    planMode: false,
    accessMode: "current",
    conversationProfile: "default",
    model: "deepseek-flash",
    effort: "high",
    inputFormat: "text",
  });

  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "deepseek-flash[1m]"]);
});

test("buildClaudeArgs passes explicit DeepSeek Flash 1M through Claude Code transport marker", () => {
  const args = buildClaudeArgs({
    text: "use deepseek flash 1m",
    sessionId: null,
    planMode: false,
    accessMode: "current",
    conversationProfile: "default",
    model: "deepseek-v4-flash[1m]",
    effort: "high",
    inputFormat: "text",
  });

  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "deepseek-v4-flash[1m]"]);
});

// 覆盖完整启动配置，防止 Flash 入口的子任务被错误映射到 Pro。
test("DeepSeek V4.1 Flash launches preserve the selected model and context", () => {
  for (const [model, launchModel] of [
    ["deepseek-flash", "deepseek-flash[1m]"],
    ["deepseek-flash[1m]", "deepseek-flash[1m]"],
  ] as const) {
    const args = buildClaudeArgs({
      text: "use deepseek vision",
      sessionId: null,
      planMode: false,
      accessMode: "current",
      model,
      effort: "max",
      inputFormat: "text",
    });
    assert.equal(args[args.indexOf("--model") + 1], launchModel);
    assert.equal(args[args.indexOf("--effort") + 1], "max");

    const providers: string[] = [];
    const env = buildClaudeChildEnv({
      ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-pro[1m]",
    }, {
      dangerouslySkipPermissions: false,
      model,
      hasConfiguredCredentials: () => true,
      readCredentials: (providerId) => {
        providers.push(providerId);
        return { apiKey: "test-token", baseUrl: "https://api.deepseek.com/anthropic" };
      },
    });
    assert.deepEqual(providers, ["deepseek"]);
    assert.equal(env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    for (const key of [
      "ANTHROPIC_MODEL", "ANTHROPIC_REASONING_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) {
      assert.equal(env[key], launchModel, `${model}: ${key}`);
    }
  }
});

test("buildClaudeArgs passes DeepSeek max effort through to Claude Code", () => {
  const args = buildClaudeArgs({
    text: "use deepseek",
    sessionId: null,
    planMode: false,
    accessMode: "current",
    conversationProfile: "default",
    model: "deepseek-v4-pro",
    effort: "max",
    inputFormat: "text",
  });

  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "deepseek-v4-pro[1m]"]);
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "max"]);
});

test("resolveClaudeModelRuntimeEnv maps DeepSeek V4 to Claude Code runtime env", () => {
  assert.equal(resolveClaudeLaunchModelId("deepseek-v4-pro"), "deepseek-v4-pro[1m]");
  assert.equal(resolveClaudeLaunchModelId("deepseek-v4-flash"), "deepseek-v4-flash[1m]");
  assert.equal(resolveClaudeLaunchModelId("deepseek-v4-flash[1m]"), "deepseek-v4-flash[1m]");
  assert.deepEqual(resolveClaudeModelRuntimeEnv("deepseek-v4-pro"), {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_REASONING_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash[1m]",
    ANTHROPIC_SMALL_FAST_MODEL: "deepseek-flash[1m]",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-flash[1m]",
  });
  assert.deepEqual(resolveClaudeModelRuntimeEnv("deepseek-v4-flash"), {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    ANTHROPIC_MODEL: "deepseek-v4-flash[1m]",
    ANTHROPIC_REASONING_MODEL: "deepseek-v4-flash[1m]",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "deepseek-v4-flash[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-flash[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-flash[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash[1m]",
    ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4-flash[1m]",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash[1m]",
  });
  assert.deepEqual(resolveClaudeModelRuntimeEnv("deepseek-v4-flash[1m]"), {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    ANTHROPIC_MODEL: "deepseek-v4-flash[1m]",
    ANTHROPIC_REASONING_MODEL: "deepseek-v4-flash[1m]",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "deepseek-v4-flash[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-flash[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-flash[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash[1m]",
    ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4-flash[1m]",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash[1m]",
  });
  assert.deepEqual(resolveClaudeModelRuntimeEnv("claude-opus-4-7"), {});
});

test("resolveClaudeModelRuntimeEnv maps single-model Claude-compatible providers", () => {
  assert.equal(resolveClaudeModelRuntimeEnv("kimi-k3").ANTHROPIC_DEFAULT_OPUS_MODEL, "kimi-k3[1m]");
  assert.equal(resolveClaudeModelRuntimeEnv("kimi-k3").CLAUDE_CODE_SUBAGENT_MODEL, "kimi-k3[1m]");
  assert.deepEqual(resolveClaudeModelRuntimeEnv("kimi-k2.6"), {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    ANTHROPIC_MODEL: "kimi-k2.6",
    ANTHROPIC_REASONING_MODEL: "kimi-k2.6",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "kimi-k2.6",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k2.6",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k2.6",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2.6",
    ANTHROPIC_SMALL_FAST_MODEL: "kimi-k2.6",
    CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k2.6",
  });
  assert.equal(resolveClaudeModelRuntimeEnv("glm-5.1").ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.1");
  assert.equal(resolveClaudeModelRuntimeEnv("qwen3.7-max").CLAUDE_CODE_SUBAGENT_MODEL, "qwen3.7-max");
});

test("buildClaudeChildEnv injects DeepSeek runtime credentials into provider-managed env", () => {
  const env = buildClaudeChildEnv({}, {
    dangerouslySkipPermissions: false,
    model: "deepseek-v4-pro",
    hasConfiguredCredentials: () => true,
    readCredentials: () => ({
      apiKey: "test-token",
      baseUrl: "https://proxy.example.com/anthropic",
    }),
  });

  assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://proxy.example.com/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "test-token");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "deepseek-flash[1m]");
});

test("buildClaudeChildEnv overrides inherited prompt caching conflicts", () => {
  const env = buildClaudeChildEnv({
    ENABLE_PROMPT_CACHING_1H: "0",
    FORCE_PROMPT_CACHING_5M: "1",
    DISABLE_PROMPT_CACHING: "true",
    DISABLE_PROMPT_CACHING_HAIKU: "1",
    DISABLE_PROMPT_CACHING_SONNET: "yes",
    DISABLE_PROMPT_CACHING_OPUS: "on",
    DISABLE_PROMPT_CACHING_FABLE: "1",
    DISABLE_PROMPT_CACHING_MYTHOS: "true",
    CODEFLOWAI_CLAUDE_PROMPT_CACHING_1H: "0",
  }, {
    dangerouslySkipPermissions: false,
    providerId: "anthropic",
  });

  for (const [key, value] of Object.entries(EXPECTED_FIXED_PROMPT_CACHING_ENV)) {
    assert.equal(env[key], value);
  }
});

test("buildClaudeChildEnv uses explicit provider for catalog Claude-compatible models", () => {
  const seenProviders: string[] = [];
  const env = buildClaudeChildEnv({}, {
    dangerouslySkipPermissions: false,
    model: "kimi-k2.6",
    providerId: "moonshot",
    hasConfiguredCredentials: () => true,
    readCredentials: (providerId) => {
      seenProviders.push(providerId);
      return {
        apiKey: "moonshot-token",
        baseUrl: "https://proxy.example.com/anthropic",
      };
    },
  });

  assert.deepEqual(seenProviders, ["moonshot"]);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "moonshot-token");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://proxy.example.com/anthropic");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "kimi-k2.6");
});

test("buildClaudeChildEnv fails fast when DeepSeek runtime credentials are missing", () => {
  assert.throws(
    () => buildClaudeChildEnv({}, {
      dangerouslySkipPermissions: false,
      model: "deepseek-v4-pro",
      hasConfiguredCredentials: () => true,
      readCredentials: () => ({}),
    }),
    /当前模型需要 DeepSeek Key/,
  );
  assert.throws(
    () => buildClaudeChildEnv({}, {
      dangerouslySkipPermissions: false,
      model: "deepseek-v4-pro",
      hasConfiguredCredentials: () => true,
      readCredentials: () => ({ apiKey: "test-token", baseUrl: null }),
    }),
    /DeepSeek 需要先在 Claude 凭据中配置 Anthropic Base URL/,
  );
  assert.throws(
    () => buildClaudeChildEnv({}, {
      dangerouslySkipPermissions: false,
      model: "kimi-k2.6",
      hasConfiguredCredentials: () => true,
      readCredentials: () => ({ apiKey: "test-token", baseUrl: null }),
    }),
    /Moonshot \/ Kimi 需要先在 Claude 凭据中配置 Anthropic Base URL/,
  );
});

test("buildClaudeChildEnv clears inherited DeepSeek env for managed Anthropic models", () => {
  const env = buildClaudeChildEnv({
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_AUTH_TOKEN: "deepseek-token",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "kimi-k3[1m]",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    MAX_THINKING_TOKENS: "31999",
    CLAUDE_CODE_MODEL_CAPABILITIES: "kimi-k2.7-code=-effort,-adaptive_thinking",
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
    ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES: "thinking",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash[1m]",
  }, {
    dangerouslySkipPermissions: false,
    model: "claude-opus-4-7",
    hasConfiguredCredentials: () => true,
    readCredentials: () => ({
      apiKey: "anthropic-token",
      baseUrl: "https://anthropic.example.com/v1",
    }),
  });

  assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "anthropic-token");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://anthropic.example.com/v1");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  assert.equal(env.MAX_THINKING_TOKENS, undefined);
  assert.equal(env.CLAUDE_CODE_MODEL_CAPABILITIES, undefined);
  assert.equal(env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES, undefined);
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
});

test("native 1M models preserve their transport marker while accepting a smaller user context window", () => {
  for (const model of ["kimi-k3", "glm-5.3", "glm-5.3-flash", "claude-sonnet-5", "claude-fable-5-1", "claude-opus-5-5"]) {
    const args = buildClaudeArgs({
      text: "verify 1m",
      sessionId: null,
      planMode: false,
      accessMode: "current",
      model,
      contextWindow: 200_000, // 用户可把原生 1M 模型的上下文预算调小。
      effort: "high",
      inputFormat: "text",
      autoCompactPct: 95,
    });
    assert.equal(args[args.indexOf("--model") + 1], `${model}[1m]`);
    assert.equal(resolveClaudeLaunchModelId(`${model}[1m]`), `${model}[1m]`);
    const flagEnv = readSettingsEnv(args);
    assert.equal(flagEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
    assert.equal(flagEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
    assert.equal(flagEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "95");
    const env = buildClaudeChildEnv({
      CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5",
    }, {
      dangerouslySkipPermissions: false,
      model,
      contextWindow: 200_000,
      hasConfiguredCredentials: () => true,
      readCredentials: () => ({ apiKey: "test-token", baseUrl: "https://gateway.example.com/anthropic" }),
    });
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
    assert.equal(env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
    if (!model.startsWith("claude-")) {
      assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "200000");
      assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, `${model}[1m]`);
      assert.equal(flagEnv.ANTHROPIC_DEFAULT_FABLE_MODEL, `${model}[1m]`);
    }
  }
});

test("Kimi Code and GLM 5.3 enforce thinking without inventing Kimi effort levels", () => {
  for (const model of ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "glm-5.3", "glm-5.3-flash"]) {
    const isKimi = model.startsWith("kimi-");
    const args = buildClaudeArgs({
      text: "verify thinking",
      sessionId: null,
      planMode: false,
      accessMode: "current",
      model,
      effort: isKimi ? null : "max",
      inputFormat: "text",
    });
    const env = buildClaudeChildEnv({ MAX_THINKING_TOKENS: "0" }, {
      dangerouslySkipPermissions: false,
      model,
      hasConfiguredCredentials: () => true,
      readCredentials: () => ({ apiKey: "test-token", baseUrl: "https://provider.example.com/anthropic" }),
    });
    assert.equal(readSettingsEnv(args).MAX_THINKING_TOKENS, "31999");
    assert.equal(env.MAX_THINKING_TOKENS, "31999");
   assert.equal(args.includes("--effort"), !isKimi);
    const expectedCapabilities = `${model}=thinking,interleaved_thinking,-adaptive_thinking,-xhigh_effort,${isKimi ? "-effort,-max_effort" : "effort,max_effort"}`;
    assert.equal(env.CLAUDE_CODE_MODEL_CAPABILITIES, expectedCapabilities);
    assert.equal(readSettingsEnv(args).CLAUDE_CODE_MODEL_CAPABILITIES, expectedCapabilities);
    assert.equal(env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, "0");
    if (isKimi) {
      assert.equal(args[args.indexOf("--model") + 1], model);
      assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, model);
      assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "256000");
      assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "256000");
    }
  }
  assert.equal(resolveClaudeModelSettingsEnv("kimi-k2.6").MAX_THINKING_TOKENS, undefined);
  assert.equal(resolveClaudeModelSettingsEnv("glm-5.1").MAX_THINKING_TOKENS, undefined);
});

test("Claude 用户上下文预算接受任意有效窗口并受目录最大值限制", () => {
  assert.equal(resolveClaudeModelSettingsEnv("claude-opus-5-5", 150_000).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "150000");
  assert.equal(resolveClaudeModelSettingsEnv("claude-opus-5-5", 1_500_000).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1000000");
  assert.equal(resolveClaudeModelSettingsEnv("claude-opus-4-7", 1_500_000).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
});

test("context configuration preserves catalog windows and rejects removed models", () => {
  assert.equal(resolveClaudeLaunchModelId("claude-fable-5"), "claude-fable-5");
  assert.equal(resolveClaudeModelSettingsEnv("claude-fable-5").CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  assert.equal(resolveClaudeModelSettingsEnv("claude-fable-5").CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
  assert.equal(resolveClaudeLaunchModelId("qwen3.7-max", 1_000_000), "qwen3.7-max[1m]");
  assert.equal(resolveClaudeModelSettingsEnv("qwen3.7-max", 2_000_000).CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000");
  assert.deepEqual(resolveClaudeModelSettingsEnv(null), {});
  assert.throws(
    () => resolveClaudeModelSettingsEnv("custom-model", Number.NaN),
    (error: unknown) => (error as { code?: string }).code === "ENGINE_MODEL_NOT_AVAILABLE",
  );
  assert.throws(
    () => resolveClaudeModelRuntimeEnv("deepseek-v4-unknown"),
    (error: unknown) => (error as { code?: string }).code === "ENGINE_MODEL_NOT_AVAILABLE",
  );
});

test("native Claude 1M launches do not require third-party credentials", () => {
  const env = buildClaudeChildEnv({}, {
    dangerouslySkipPermissions: false,
    model: "claude-sonnet-5",
  });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1000000");
});

test("missing effort uses catalog defaults without adding an unsupported Kimi Code effort", () => {
  assert.equal(resolveClaudeLaunchEffort("glm-5.3", null), "max");
  assert.equal(resolveClaudeLaunchEffort("glm-5.3-flash[1m]", null), "max");
  assert.equal(resolveClaudeLaunchEffort("kimi-k3", null), "max");
  assert.equal(resolveClaudeLaunchEffort("claude-sonnet-5", null), "high");
  assert.equal(resolveClaudeLaunchEffort("kimi-k2.7-code", null), null);
  assert.equal(resolveClaudeLaunchEffort("kimi-k2.7-code", null), null);
  assert.equal(resolveClaudeLaunchEffort("glm-5.3", "low"), "low");
  const args = buildClaudeArgs({
    text: "default effort", sessionId: null, planMode: false, accessMode: "current",
    model: "glm-5.3", inputFormat: "text",
  });
  assert.equal(args[args.indexOf("--effort") + 1], "max");
  assert.equal(readSettingsEnv(args).CLAUDE_CODE_EFFORT_LEVEL, "max");
});

test("shouldClaudeForceSandboxEnv only enables sandbox override for Unix root bypass runs", () => {
  assert.equal(shouldClaudeForceSandboxEnv({
    dangerouslySkipPermissions: true,
    platform: "linux",
    env: {},
    getuid: () => 0,
    geteuid: () => 0,
  }), true);

  assert.equal(shouldClaudeForceSandboxEnv({
    dangerouslySkipPermissions: true,
    platform: "darwin",
    env: { SUDO_USER: "alice" },
    getuid: null,
    geteuid: null,
  }), true);

  assert.equal(shouldClaudeForceSandboxEnv({
    dangerouslySkipPermissions: true,
    platform: "win32",
    env: { SUDO_USER: "alice" },
    getuid: () => 0,
    geteuid: () => 0,
  }), false);

  assert.equal(shouldClaudeForceSandboxEnv({
    dangerouslySkipPermissions: true,
    platform: "linux",
    env: { IS_SANDBOX: "1" },
    getuid: () => 0,
    geteuid: () => 0,
  }), false);
});
