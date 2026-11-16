import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  backupCodexNativeConfigFiles,
  readClaudeNativeAuthStateFromData,
  readClaudeNativeAuthStateFromText,
  readCodexNativeAuthStateFromText,
  readCodexModelProviderStateFromText,
  switchCodexAuthFile,
  updateCodexModelProviderConfigText,
} from "../../apps/desktop/client/src/enginesConfig.ts";

/** 提取 CodeFlow 托管 Provider 段，避免测试误约束其他 Provider。 */
function readManagedCodexProviderBlock(content: string): string {
  const match = content.match(/# \[codeflowai:model-provider:begin\][\s\S]*?# \[codeflowai:model-provider:end\]/);
  assert.ok(match, "CodeFlow managed provider block should exist");
  return match[0];
}

/** 创建隔离的 Codex auth.json 测试路径，并在用例结束后清理。 */
function createCodexAuthTestPath(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-codex-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "auth.json");
}

test("Codex CodeFlowAI provider should become active even when another provider was active before", () => {
  const input = [
    'model_provider = "recycleai"',
    'model = "gpt-5.4"',
    "",
    "[model_providers.recycleai]",
    'base_url = "https://right.codes/codex/v1"',
    'name = "recycleai"',
    "requires_openai_auth = true",
    "",
    "# [codeflowai:model-provider:begin]",
    "[model_providers.codeflowai]",
    'name = "CodeFlowAI Managed"',
    'base_url = "https://stale.example/v1"',
    "# [codeflowai:model-provider:end]",
    "",
  ].join("\n");

  const output = updateCodexModelProviderConfigText(input, "https://right.codes/codex/v1");
  const state = readCodexModelProviderStateFromText(output);
  const managedBlock = readManagedCodexProviderBlock(output);

  assert.equal(state.activeProvider, "codeflowai");
  assert.equal(state.managedBaseUrl, "https://right.codes/codex/v1");
  assert.equal(state.managedPreviousProvider, "recycleai");
  assert.match(output, /model_provider = "codeflowai"/);
  assert.doesNotMatch(output, /^model_provider = "recycleai"$/m);
  assert.match(managedBlock, /^requires_openai_auth = true$/m);
  assert.doesNotMatch(managedBlock, /^env_key\s*=/m);
  assert.match(output, /\[model_providers\.recycleai\][\s\S]*?requires_openai_auth = true/);
  assert.match(output, /^stream_idle_timeout_ms = 180000$/m);
  assert.match(output, /^stream_max_retries = 5$/m);
});

test("Codex config read should ignore inactive CodeFlowAI provider blocks", () => {
  const input = [
    'model_provider = "recycleai"',
    "",
    "[model_providers.recycleai]",
    'base_url = "https://right.codes/codex/v1"',
    "",
    "# [codeflowai:model-provider:begin]",
    "[model_providers.codeflowai]",
    'name = "CodeFlowAI Managed"',
    'base_url = "https://right.codes/codex/v1"',
    "# [codeflowai:model-provider:end]",
    "",
  ].join("\n");

  const state = readCodexModelProviderStateFromText(input);
  assert.equal(state.activeProvider, "recycleai");
  assert.equal(state.managedBaseUrl, null);
});

test("Codex managed provider rewrite should use native auth.json instead of env_key", () => {
  const input = [
    'model_provider = "codeflowai"',
    "",
    "# [codeflowai:model-provider:begin]",
    "[model_providers.codeflowai]",
    'name = "CodeFlowAI Managed"',
    'base_url = "https://stale.example/v1"',
    "stream_idle_timeout_ms = 300000",
    "stream_max_retries = 2",
    'env_key = "LEGACY_CODEX_API_KEY"',
    "requires_openai_auth = true",
    "# [codeflowai:model-provider:end]",
    "",
  ].join("\n");

  const output = updateCodexModelProviderConfigText(input, "https://right.codes/codex/v1");
  const managedBlock = readManagedCodexProviderBlock(output);

  assert.match(output, /base_url = "https:\/\/right\.codes\/codex\/v1"/);
  assert.match(output, /^stream_idle_timeout_ms = 180000$/m);
  assert.match(output, /^stream_max_retries = 5$/m);
  assert.doesNotMatch(output, /^stream_idle_timeout_ms = 300000$/m);
  assert.doesNotMatch(output, /^stream_max_retries = 2$/m);
  assert.match(managedBlock, /^requires_openai_auth = true$/m);
  assert.doesNotMatch(managedBlock, /LEGACY_CODEX_API_KEY|^env_key\s*=/m);
  assert.equal(updateCodexModelProviderConfigText(output, "https://right.codes/codex/v1"), output);
});

test("Clearing Codex CodeFlowAI provider should restore the previous active provider", () => {
  const managed = updateCodexModelProviderConfigText(
    [
      'model_provider = "recycleai"',
      "",
      "[model_providers.recycleai]",
      'base_url = "https://right.codes/codex/v1"',
      "",
    ].join("\n"),
    "https://right.codes/codex/v1",
  );

  const restored = updateCodexModelProviderConfigText(managed, null);
  const state = readCodexModelProviderStateFromText(restored);

  assert.equal(state.activeProvider, "recycleai");
  assert.equal(state.managedBaseUrl, null);
  assert.equal(state.managedPreviousProvider, null);
  assert.match(restored, /^model_provider = "recycleai"$/m);
  assert.doesNotMatch(restored, /codeflowai:model-provider/);
});

test("Codex native auth detects local API key without exposing the key", () => {
  const state = readCodexNativeAuthStateFromText(JSON.stringify({ OPENAI_API_KEY: "sk-test-secret" }));

  assert.equal(state.available, true);
  assert.equal(state.source, "local_api_key");
  assert.equal(state.issue, null);
});

test("Codex native auth detects local OAuth refresh token", () => {
  const state = readCodexNativeAuthStateFromText(JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { refresh_token: "refresh-secret" },
  }));

  assert.equal(state.available, true);
  assert.equal(state.source, "local_oauth");
  assert.equal(state.issue, null);
});

test("Codex native auth follows ChatGPT mode when OAuth and API key both exist", () => {
  const state = readCodexNativeAuthStateFromText(JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: "sk-test-secret",
    tokens: { refresh_token: "refresh-secret" },
  }));

  assert.equal(state.available, true);
  assert.equal(state.source, "local_oauth");
  assert.equal(state.issue, null);
});

test("Codex auth switch backs up OAuth file and creates an API-key-only file", (t) => {
  const authPath = createCodexAuthTestPath(t);
  const backupPath = `${authPath}.codeflow-backup`;
  const original = '{\n  "auth_mode": "chatgpt",\n  "tokens": { "refresh_token": "refresh-secret" }\n}\n';
  fs.writeFileSync(authPath, original, "utf-8");

  switchCodexAuthFile(authPath, " sk-test-secret ");

  assert.equal(fs.readFileSync(backupPath, "utf-8"), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf-8")), {
    OPENAI_API_KEY: "sk-test-secret",
  });
});

test("Codex auth switch keeps the original backup while changing managed keys", (t) => {
  const authPath = createCodexAuthTestPath(t);
  const backupPath = `${authPath}.codeflow-backup`;
  const original = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh-secret"}}\n';
  fs.writeFileSync(authPath, original, "utf-8");

  switchCodexAuthFile(authPath, "sk-first");
  switchCodexAuthFile(authPath, "sk-second");

  assert.equal(fs.readFileSync(backupPath, "utf-8"), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf-8")), {
    OPENAI_API_KEY: "sk-second",
  });
});

test("Codex auth switch restores the original file when managed key is cleared", (t) => {
  const authPath = createCodexAuthTestPath(t);
  const backupPath = `${authPath}.codeflow-backup`;
  const original = '{\n  "auth_mode": "chatgpt",\n  "tokens": { "refresh_token": "refresh-secret" }\n}\n';
  fs.writeFileSync(authPath, original, "utf-8");

  switchCodexAuthFile(authPath, "sk-test-secret");
  switchCodexAuthFile(authPath, null);

  assert.equal(fs.readFileSync(authPath, "utf-8"), original);
  assert.equal(fs.existsSync(backupPath), false);
});

test("Codex auth switch preserves legacy OAuth data when no backup exists", (t) => {
  const authPath = createCodexAuthTestPath(t);
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: "sk-test-secret",
    tokens: { refresh_token: "refresh-secret" },
  }), "utf-8");

  switchCodexAuthFile(authPath, null);

  const restored = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  assert.equal(restored.OPENAI_API_KEY, undefined);
  assert.equal(restored.auth_mode, "chatgpt");
  assert.equal(restored.tokens.refresh_token, "refresh-secret");
});

test("Codex native config backup keeps timestamped pairs and only the latest five", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-codex-config-backup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authPath = path.join(root, "auth.json");
  const configPath = path.join(root, "config.toml");
  const backupRoot = path.join(root, "backups");
  const snapshots: string[] = [];

  for (let index = 0; index < 7; index += 1) {
    const auth = JSON.stringify({ OPENAI_API_KEY: `key-${index}` }, null, 2) + "\n";
    const config = `model_provider = "provider-${index}"\n`;
    fs.writeFileSync(authPath, auth, "utf-8");
    fs.writeFileSync(configPath, config, "utf-8");
    snapshots.push(backupCodexNativeConfigFiles({
      authPath,
      configPath,
      backupRoot,
      now: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    }));
  }

  const directories = fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.equal(directories.length, 5);
  assert.equal(fs.existsSync(snapshots[0]), false);
  assert.equal(fs.existsSync(snapshots[1]), false);
  assert.equal(fs.existsSync(snapshots[2]), true);

  const latest = snapshots[6]!;
  assert.equal(fs.readFileSync(path.join(latest, "auth.json"), "utf-8"), JSON.stringify({ OPENAI_API_KEY: "key-6" }, null, 2) + "\n");
  assert.equal(fs.readFileSync(path.join(latest, "config.toml"), "utf-8"), "model_provider = \"provider-6\"\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(latest, "manifest.json"), "utf-8")), {
    version: 1,
    createdAt: "2026-01-01T00:00:06.000Z",
    files: { authJson: true, configToml: true },
  });
});

test("Codex native config backup records missing source files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-codex-config-backup-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = backupCodexNativeConfigFiles({
    authPath: path.join(root, "missing-auth.json"),
    configPath: path.join(root, "missing-config.toml"),
    backupRoot: path.join(root, "backups"),
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(fs.existsSync(path.join(snapshot, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(snapshot, "config.toml")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(snapshot, "manifest.json"), "utf-8")), {
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    files: { authJson: false, configToml: false },
  });
});

test("Codex native auth reports invalid JSON as unavailable", () => {
  const state = readCodexNativeAuthStateFromText("{");

  assert.equal(state.available, false);
  assert.equal(state.source, "none");
  assert.equal(state.issue, "auth.json 不是有效 JSON");
});

test("Codex native auth reports incomplete ChatGPT OAuth as unavailable", () => {
  const state = readCodexNativeAuthStateFromText(JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));

  assert.equal(state.available, false);
  assert.equal(state.source, "none");
  assert.equal(state.issue, "本机 Codex OAuth 缺少 refresh_token");
});

test("Claude native auth detects local OAuth refresh token", () => {
  const state = readClaudeNativeAuthStateFromText(JSON.stringify({
    claudeAiOauth: { refreshToken: "refresh-secret" },
  }));

  assert.equal(state.available, true);
  assert.equal(state.source, "local_oauth");
  assert.equal(state.issue, null);
});

test("Claude native auth reports incomplete OAuth as unavailable", () => {
  const state = readClaudeNativeAuthStateFromData({ claudeAiOauth: { accessToken: "access-secret" } });

  assert.equal(state.available, false);
  assert.equal(state.source, "none");
  assert.equal(state.issue, "本机 Claude OAuth 缺少 refreshToken");
});

test("Claude native auth reports invalid JSON as unavailable", () => {
  const state = readClaudeNativeAuthStateFromText("{");

  assert.equal(state.available, false);
  assert.equal(state.source, "none");
  assert.equal(state.issue, ".credentials.json 不是有效 JSON");
});
