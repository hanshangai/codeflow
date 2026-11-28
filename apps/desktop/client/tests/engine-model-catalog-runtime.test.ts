import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { serializeEngineModelCatalogDigestPayload, type EngineCustomModelEntry, type EngineModelCatalogSnapshot } from "@codeflowai/shared";
import * as catalog from "../src/engines/engineModelCatalogRuntime.js";
import { resolveClaudeLaunchModelId, resolveClaudeModelRuntimeEnv, resolveClaudeModelSettingsEnv } from "../src/engines/claude/claudeCli.js";

/** 构造独立的 Server 目录，仅包含两个默认模型及一个云端补充模型。 */
function snapshot(configVersion = 1): EngineModelCatalogSnapshot {
  return { schemaVersion: "engine-model-catalog/v1", configVersion, capturedAt: 1, rows: [
    { catalogItemId: "claude-default", engine: "claude", providerId: "anthropic", providerLabel: "Anthropic",
      modelId: "claude-fable-5-2", displayName: "Server override", description: "server", inputModalities: ["text"],
      supportedReasoningEfforts: [], defaultReasoningEffort: null, contextWindow: 100_000, maxContextWindow: null,
      supportsFastMode: false, supports1MContext: false, isDefault: true, sortOrder: 1, runtimeProfileId: "native",
      transportModelId: null, fastTaskModelId: null, subagentModelId: null },
    { catalogItemId: "codex-default", engine: "codex", providerId: "openai", providerLabel: "OpenAI",
      modelId: "gpt-6.1-sol", displayName: "Server Codex", description: "server", inputModalities: ["text"],
      supportedReasoningEfforts: [], defaultReasoningEffort: null, contextWindow: 100_000, maxContextWindow: null,
      supportsFastMode: false, supports1MContext: false, isDefault: true, sortOrder: 1, runtimeProfileId: "native",
      transportModelId: null, fastTaskModelId: null, subagentModelId: null },
    { catalogItemId: "cloud-extra", engine: "codex", providerId: "openai", providerLabel: "OpenAI",
      modelId: "cloud-extra", displayName: "Cloud extra", description: "cloud", inputModalities: ["text"],
      supportedReasoningEfforts: [], defaultReasoningEffort: null, contextWindow: 100_000, maxContextWindow: null,
      supportsFastMode: false, supports1MContext: false, isDefault: false, sortOrder: 2, runtimeProfileId: "native",
      transportModelId: null, fastTaskModelId: null, subagentModelId: null },
  ] };
}

/** 本地自定义目录记录不含凭据，Server 同 ID 不能覆盖它。 */
function customModel(): EngineCustomModelEntry {
  return { id: "custom", engine: "codex", providerId: "openai", modelId: "my-model", displayName: "My local model",
    inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null,
    contextWindow: 200_000, maxContextWindow: null, supportsFastMode: false, supports1MContext: false,
    enabled: true, createdAt: 1, updatedAt: 1 };
}

/** 每项测试隔离模块状态，并在失败后释放目录暂停。 */
function reset(t: test.TestContext): void {
  catalog.resetEngineModelCatalogRuntimeForTest();
  t.after(() => catalog.resetEngineModelCatalogRuntimeForTest());
}

test("desktop local catalog starts without a Server snapshot and keeps native Claude profiles", async (t) => {
  reset(t);
  catalog.initializeLocalEngineModelCatalog();
  catalog.setEngineModelCatalogCustomModels([customModel()]);
  const codexPrefs = catalog.resolveRuntimeThreadPrefsWithCatalogDefaults("codex");
  assert.equal(codexPrefs.model, "gpt-6.2-sol");
  assert.equal(codexPrefs.contextWindow, 872_000);
  const claudePrefs = catalog.resolveRuntimeThreadPrefsWithCatalogDefaults("claude");
  assert.equal(claudePrefs.model, "claude-fable-5-2");
  assert.equal(resolveClaudeModelSettingsEnv(claudePrefs.model).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1000000");
  assert.equal(catalog.getRuntimeEngineModelInfo("codex", "my-model")?.displayName, "My local model");
  assert.equal(catalog.resolveRuntimeEngineModelProviderId("codex", "my-model"), "openai");
  assert.equal(catalog.getActiveEngineModelCatalogSnapshot(), null, "local startup must not fabricate Server application");
  await catalog.waitForEngineModelCatalogDispatchReady();
  const lease = await catalog.acquireEngineModelCatalogDispatchLease();
  lease.release();
  assert.equal(resolveClaudeLaunchModelId("deepseek-v4-pro"), "deepseek-v4-pro[1m]");
  assert.equal(resolveClaudeModelRuntimeEnv("deepseek-v4-pro").CLAUDE_CODE_SUBAGENT_MODEL, "deepseek-flash[1m]");
});

test("confirmed Server supplement cannot override or delete local models or local defaults", (t) => {
  reset(t);
  catalog.initializeLocalEngineModelCatalog();
  catalog.setEngineModelCatalogCustomModels([customModel()]);
  const localClaude = catalog.getRuntimeEngineModelInfo("claude", "claude-fable-5-2");
  const defaults = catalog.getRuntimeEngineModels("codex").filter((model) => model.isDefault).map((model) => model.id);
  const update = snapshot();
  update.rows[1]!.isDefault = false;
  update.rows[2]!.isDefault = true;
  update.rows.push({ ...update.rows[2]!, catalogItemId: "custom-conflict", modelId: "my-model", displayName: "Wrong server name", isDefault: false, sortOrder: 3 });
  update.rows.push({ ...update.rows[0]!, catalogItemId: "alias-conflict", modelId: "claude-opus-5[1m]", displayName: "Wrong alias", isDefault: false, sortOrder: 2 });
  const ack = catalog.applyEngineModelCatalogSnapshot(update, 2, "hello");
  assert.throws(() => catalog.assertRuntimeEngineModelAvailable("codex", "cloud-extra"), /尚未|移除|不可用/);
  catalog.confirmEngineModelCatalogApplied(ack);
  assert.deepEqual(catalog.getRuntimeEngineModelInfo("claude", "claude-fable-5-2"), localClaude);
  assert.equal(catalog.getRuntimeEngineModelCatalogItem("claude", "claude-fable-5-2"), null);
  assert.equal(catalog.getRuntimeEngineModelInfo("codex", "my-model")?.displayName, "My local model");
  assert.equal(catalog.getRuntimeEngineModelInfo("codex", "cloud-extra")?.displayName, "Cloud extra");
  assert.deepEqual(catalog.getRuntimeEngineModels("codex").filter((model) => model.isDefault).map((model) => model.id), defaults);
  assert.ok(catalog.getRuntimeEngineModelInfo("claude", "deepseek-v4-pro"));
  assert.equal(catalog.getRuntimeEngineModelInfo("claude", "claude-opus-5[1m]")?.contextWindow, 1_000_000);
  assert.equal(catalog.getRuntimeEngineModelCatalogItem("claude", "claude-opus-5[1m]"), null);
});

test("desktop publication and disconnect pause only cloud supplement while local dispatch continues", async (t) => {
  reset(t);
  catalog.initializeLocalEngineModelCatalog();
  const ack = catalog.applyEngineModelCatalogSnapshot(snapshot(), 2, "hello");
  catalog.confirmEngineModelCatalogApplied(ack);
  const pause = await catalog.pauseEngineModelCatalogDispatch({ operationId: "publish", configVersion: 2, digest: "a".repeat(64) });
  assert.equal(pause.operationId, "publish");
  assert.equal(catalog.getRuntimeEngineModels("codex").some((model) => model.id === "cloud-extra"), false);
  await catalog.waitForEngineModelCatalogDispatchReady();
  const localLease = await catalog.acquireEngineModelCatalogDispatchLease();
  localLease.release();
  const update = snapshot(2);
  const next = catalog.applyEngineModelCatalogSnapshot(update, 3, "publish");
  assert.equal(next.digest, crypto.createHash("sha256").update(serializeEngineModelCatalogDigestPayload(update)).digest("hex"));
  assert.throws(() => catalog.confirmEngineModelCatalogApplied({ ...next, digest: "b".repeat(64) }), /确认/);
  assert.throws(() => catalog.confirmEngineModelCatalogApplied({ ...next, operationId: "wrong" }), /操作/);
  catalog.confirmEngineModelCatalogApplied(next);
  catalog.pauseEngineModelCatalogDispatchForReconnect("reconnect");
  await catalog.waitForEngineModelCatalogDispatchReady();
  assert.ok(catalog.getRuntimeEngineModelInfo("codex", "gpt-6.1-sol"));
  assert.equal(catalog.getRuntimeEngineModelInfo("codex", "cloud-extra"), null);
});

test("local supplement still rejects stale or collided Server versions", (t) => {
  reset(t);
  catalog.initializeLocalEngineModelCatalog();
  catalog.applyEngineModelCatalogSnapshot(snapshot(2));
  assert.throws(() => catalog.applyEngineModelCatalogSnapshot(snapshot(1)), /旧模型目录版本/);
  const conflict = snapshot(2);
  conflict.rows[2]!.displayName = "changed";
  assert.throws(() => catalog.applyEngineModelCatalogSnapshot(conflict), /同一模型目录版本内容不一致/);
  assert.ok(catalog.getRuntimeEngineModelInfo("claude", "deepseek-v4-pro"));
});

test("desktop owner revocation removes cloud supplement and accepts a new owner catalog version", async (t) => {
  reset(t);
  catalog.initializeLocalEngineModelCatalog();
  catalog.setEngineModelCatalogCustomModels([customModel()]);
  catalog.confirmEngineModelCatalogApplied(catalog.applyEngineModelCatalogSnapshot(snapshot(7), 2, "owner-A"));
  assert.ok(catalog.getRuntimeEngineModelInfo("codex", "cloud-extra"));
  catalog.clearDesktopCloudEngineModelCatalog();
  assert.equal(catalog.getActiveEngineModelCatalogSnapshot(), null);
  assert.equal(catalog.getRuntimeEngineModelInfo("codex", "cloud-extra"), null);
  assert.equal(catalog.getRuntimeEngineModelInfo("codex", "my-model")?.displayName, "My local model");
  assert.ok(catalog.getRuntimeEngineModelInfo("codex", "gpt-6.1-sol"));
  const next = snapshot(1); next.rows[2]!.modelId = "cloud-B";
  catalog.confirmEngineModelCatalogApplied(catalog.applyEngineModelCatalogSnapshot(next, 3, "owner-B"));
  assert.ok(catalog.getRuntimeEngineModelInfo("codex", "cloud-B"));
  assert.equal(catalog.getRuntimeEngineModelInfo("codex", "cloud-extra"), null);
  await catalog.waitForEngineModelCatalogDispatchReady();
});

test("selected local lease stays valid across Server changes while selected cloud lease detects them", async (t) => {
  reset(t);
  catalog.initializeLocalEngineModelCatalog();
  const ack = catalog.applyEngineModelCatalogSnapshot(snapshot(), 2, "hello");
  catalog.confirmEngineModelCatalogApplied(ack);
  const local = await catalog.acquireEngineModelCatalogDispatchLease({ engine: "codex", model: "gpt-6.1-sol" });
  const cloud = await catalog.acquireEngineModelCatalogDispatchLease({ engine: "codex", model: "cloud-extra" });
  local.release();
  cloud.release();
  const update = snapshot(2);
  update.rows[2]!.contextWindow = 200_000;
  const next = catalog.applyEngineModelCatalogSnapshot(update, 3, "updated");
  catalog.confirmEngineModelCatalogApplied(next);
  const localAfter = await catalog.acquireEngineModelCatalogDispatchLease({ engine: "codex", model: "gpt-6.1-sol" });
  const cloudAfter = await catalog.acquireEngineModelCatalogDispatchLease({ engine: "codex", model: "cloud-extra" });
  try {
    catalog.assertEngineModelCatalogDispatchLeaseCurrent(local, localAfter);
    assert.throws(() => catalog.assertEngineModelCatalogDispatchLeaseCurrent(cloud, cloudAfter), /provider 启动期间已更新/);
  } finally {
    localAfter.release();
    cloudAfter.release();
  }
});

test("remote Client keeps Server authority and confirmation fences", async (t) => {
  reset(t);
  assert.throws(() => catalog.getRuntimeEngineModels("codex"), /尚未同步/);
  const ack = catalog.applyEngineModelCatalogSnapshot(snapshot(), 2, "hello");
  let ready = false;
  const waiting = catalog.waitForEngineModelCatalogDispatchReady().then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  catalog.confirmEngineModelCatalogApplied(ack);
  await waiting;
  assert.equal(catalog.getRuntimeEngineModelInfo("claude", "claude-fable-5-2")?.displayName, "Server override");
  assert.equal(catalog.getRuntimeEngineModelInfo("claude", "deepseek-v4-pro"), null);
});

test("implicit provider model lease detects supplement changes after history resume", async (t) => {
  reset(t);
  catalog.initializeLocalEngineModelCatalog();
  catalog.confirmEngineModelCatalogApplied(catalog.applyEngineModelCatalogSnapshot(snapshot(), 2, "hello"));
  const before = await catalog.acquireEngineModelCatalogDispatchLease({ engine: "codex", model: null });
  before.release();
  const update = snapshot(2);
  update.rows[2]!.transportModelId = "cloud-extra-v2";
  catalog.confirmEngineModelCatalogApplied(catalog.applyEngineModelCatalogSnapshot(update, 3, "changed"));
  const after = await catalog.acquireEngineModelCatalogDispatchLease({ engine: "codex", model: null });
  try {
    assert.throws(() => catalog.assertEngineModelCatalogDispatchLeaseCurrent(before, after), /provider 启动期间已更新/);
  } finally {
    after.release();
  }
});

test("Claude 旧窗口值不影响最大容量下发及原生 1M 启用", t => {
  reset(t);
  catalog.initializeLocalEngineModelCatalog();
  catalog.setEngineModelCatalogCustomModels([{
    ...customModel(), engine: "claude", providerId: "anthropic", modelId: "claude-custom",
    contextWindow: 200000, maxContextWindow: 1000000,
  }]);
  assert.equal(resolveClaudeLaunchModelId("claude-custom", 32000), "claude-custom[1m]");
  const env = resolveClaudeModelSettingsEnv("claude-custom", 32000);
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1000000");
  assert.equal(env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "0");
});
