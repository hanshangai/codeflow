import assert from "node:assert/strict";
import test from "node:test";

import {
  ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
  createDefaultRoleExecutionConfig,
  type EngineModelCatalogSnapshot,
} from "@codeflowai/shared";
import {
  applyEngineModelCatalogSnapshot,
  acquireEngineModelCatalogDispatchLease,
  assertEngineModelCatalogDispatchLeaseCurrent,
  assertRuntimeEngineModelAvailable,
  cancelEngineModelCatalogDispatchPause,
  confirmEngineModelCatalogApplied,
  getRuntimeEngineModels,
  getRuntimeEngineModelsIfReady,
  pauseEngineModelCatalogDispatch,
  pauseEngineModelCatalogDispatchForReconnect,
  resetEngineModelCatalogRuntimeForTest,
  resolveRuntimeEngineModelProviderId,
  resolveRuntimeRoleExecutionConfigForEngine,
  setEngineModelCatalogCustomModels,
} from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";
import {
  resolveClaudeLaunchEffort,
  resolveClaudeLaunchModelId,
  resolveClaudeModelRuntimeEnv,
  resolveClaudeModelSettingsEnv,
} from "../../apps/desktop/client/src/engines/claude/claudeCli.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { AiGateEvaluationService } from "../../apps/desktop/client/src/orchestration/aiGateEvaluationService.ts";

test.afterEach(() => resetEngineModelCatalogRuntimeForTest());

test("目录同步前拒绝任何模型执行", () => {
  assert.throws(
    () => assertRuntimeEngineModelAvailable("claude", "claude-opus-4-7"),
    (error: unknown) => (error as { code?: string }).code === "ENGINE_MODEL_CATALOG_NOT_READY",
  );
});

test("同一 provider 启动链拒绝跨目录版本或摘要继续派发", () => {
  const setup = { configVersion: 2, digest: "a".repeat(64) };
  assert.doesNotThrow(() => assertEngineModelCatalogDispatchLeaseCurrent(setup, { ...setup }));
  assert.throws(
    () => assertEngineModelCatalogDispatchLeaseCurrent(setup, { configVersion: 3, digest: "b".repeat(64) }),
    (error: unknown) => (error as { code?: string }).code === "ENGINE_MODEL_CATALOG_CHANGED_DURING_DISPATCH",
  );
  assert.throws(
    () => assertEngineModelCatalogDispatchLeaseCurrent(setup, { configVersion: 2, digest: "b".repeat(64) }),
    (error: unknown) => (error as { code?: string }).code === "ENGINE_MODEL_CATALOG_CHANGED_DURING_DISPATCH",
  );
});

test("Client 原子应用目录并让运行链读取动态模型与分层档案", () => {
  const snapshot = makeSnapshot(2);
  const ack = applyEngineModelCatalogSnapshot(snapshot, 123);

  assert.equal(ack.configVersion, 2);
  assert.match(ack.digest, /^[a-f0-9]{64}$/);
  assert.equal(ack.appliedAt, 123);
  assert.equal(getRuntimeEngineModels("claude").find((model) => model.id === "deepseek-next")?.displayName, "DeepSeek Next");
  assert.equal(getRuntimeEngineModels("claude").find((model) => model.id === "claude-opus-4-7"), undefined);
  assert.equal(resolveRuntimeEngineModelProviderId("claude", "deepseek-next"), "deepseek");
  assert.equal(resolveRuntimeEngineModelProviderId("claude", "deepseek-next[1m]"), "deepseek");
  assert.doesNotThrow(() => assertRuntimeEngineModelAvailable("claude", "deepseek-v4-flash"));
  assert.equal(resolveRuntimeEngineModelProviderId("claude", "deepseek-v4-flash"), "deepseek");
  assert.equal(resolveRuntimeEngineModelProviderId("codex", "gpt-next"), "openai");
  assert.equal(
    resolveRuntimeRoleExecutionConfigForEngine(createDefaultRoleExecutionConfig("codex"), "codex").model,
    "gpt-next",
  );
  assert.equal(resolveClaudeLaunchModelId("deepseek-next"), "deepseek-next-pro[1m]");
  assert.deepEqual(resolveClaudeModelRuntimeEnv("deepseek-next"), {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    ANTHROPIC_MODEL: "deepseek-next-pro[1m]",
    ANTHROPIC_REASONING_MODEL: "deepseek-next-pro[1m]",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "deepseek-next-pro[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-next-pro[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-next-pro[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-next-flash[1m]",
    ANTHROPIC_SMALL_FAST_MODEL: "deepseek-next-flash[1m]",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-next-subagent[1m]",
  });
  assert.equal(resolveClaudeModelRuntimeEnv("kimi-next").ANTHROPIC_DEFAULT_OPUS_MODEL, "kimi-next-runtime");
  assert.equal(resolveClaudeModelSettingsEnv("kimi-next").CLAUDE_CODE_AUTO_COMPACT_WINDOW, "256000");
  assert.equal(resolveClaudeModelSettingsEnv("glm-next").MAX_THINKING_TOKENS, "31999");
  assert.equal(resolveClaudeLaunchEffort("glm-next", null), "max");
  assert.throws(
    () => assertRuntimeEngineModelAvailable("codex", "gpt-removed"),
    (error: unknown) => (error as { code?: string }).code === "ENGINE_MODEL_NOT_AVAILABLE",
  );
});

test("Client 将本地自定义模型叠加到 Server 目录并在冲突时保留全局模型", () => {
  applyEngineModelCatalogSnapshot(makeSnapshot(2));
  setEngineModelCatalogCustomModels([{
    id: "local-qwen-model",
    engine: "claude",
    providerId: "qwen",
    modelId: "qwen-local-custom",
    displayName: "本地 Qwen 自定义模型",
    inputModalities: ["text"],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    contextWindow: 128_000,
    maxContextWindow: null,
    supportsFastMode: false,
    supports1MContext: false,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }, {
    id: "local-conflict",
    engine: "claude",
    providerId: "qwen",
    modelId: "deepseek-next",
    displayName: "不应覆盖全局模型",
    inputModalities: ["text"],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    contextWindow: null,
    maxContextWindow: null,
    supportsFastMode: false,
    supports1MContext: false,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }]);
  const models = getRuntimeEngineModels("claude");
  assert.equal(models.find((model) => model.id === "qwen-local-custom")?.displayName, "本地 Qwen 自定义模型");
  assert.equal(models.find((model) => model.id === "deepseek-next")?.displayName, "DeepSeek Next");
  assert.equal(getRuntimeEngineModels("codex").some((model) => model.id === "qwen-local-custom"), false);
  assert.equal(resolveRuntimeEngineModelProviderId("claude", "qwen-local-custom"), "qwen");
});

test("目录同步后本地自定义模型的 1M 别名仍可通过运行时门禁", () => {
  applyEngineModelCatalogSnapshot(makeSnapshot(2));
  setEngineModelCatalogCustomModels([{
    id: "local-qwen-1m",
    engine: "claude",
    providerId: "qwen",
    modelId: "custom-qwen-long-context",
    displayName: "长上下文 Qwen",
    inputModalities: ["text"],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    contextWindow: 128_000,
    maxContextWindow: 1_000_000,
    supportsFastMode: false,
    supports1MContext: true,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }]);

  assert.doesNotThrow(() => assertRuntimeEngineModelAvailable("claude", "custom-qwen-long-context[1m]"));
  assert.equal(resolveRuntimeEngineModelProviderId("claude", "custom-qwen-long-context[1m]"), "qwen");
});

test("ThreadRepo 使用动态默认模型且恢复默认不回退静态目录", () => {
  applyEngineModelCatalogSnapshot(makeSnapshot(2));
  const db = openClientDb({ dbPath: ":memory:", resolveEngineModels: getRuntimeEngineModelsIfReady });
  try {
    db.workspaces.upsert({ id: "workspace-runtime-default" as never, title: "动态目录测试", path: "." });
    const thread = db.threads.create({
      id: "thread-runtime-default" as never,
      workspaceId: "workspace-runtime-default" as never,
      engine: "codex",
      title: "动态默认模型",
    });
    assert.equal(thread.model, "gpt-next");
    assert.equal(thread.effort, "high");
    assert.equal(thread.contextWindow, 180_000);

    db.threads.updatePrefs(thread.id, { model: null, effort: null, contextWindow: null });
    const restored = db.threads.get(thread.id);
    assert.equal(restored?.model, "gpt-next");
    assert.equal(restored?.effort, "high");
    assert.equal(restored?.contextWindow, 180_000);
  } finally {
    db.close();
  }
});

test("AI 门禁在创建评估线程前拒绝已删除模型", async () => {
  applyEngineModelCatalogSnapshot(makeSnapshot(2));
  const service = new AiGateEvaluationService({ db: {} } as never);
  await assert.rejects(
    service.evaluate({ engine: "codex", model: "gpt-removed", effort: null } as never),
    (error: unknown) => (error as { code?: string }).code === "ENGINE_MODEL_NOT_AVAILABLE",
  );
});

test("Client 拒绝旧版本和同版本异内容且保留最后有效目录", () => {
  applyEngineModelCatalogSnapshot(makeSnapshot(3));
  assert.throws(
    () => applyEngineModelCatalogSnapshot(makeSnapshot(2)),
    (error: unknown) => (error as { code?: string }).code === "ENGINE_MODEL_CATALOG_STALE",
  );
  const conflict = makeSnapshot(3);
  conflict.rows[0] = { ...conflict.rows[0]!, displayName: "冲突内容" };
  assert.throws(
    () => applyEngineModelCatalogSnapshot(conflict),
    (error: unknown) => (error as { code?: string }).code === "ENGINE_MODEL_CATALOG_VERSION_COLLISION",
  );
  assert.equal(getRuntimeEngineModels("claude").find((model) => model.id === "deepseek-next")?.displayName, "DeepSeek Next");
});

test("目录发布等待在途启动并在 appliedConfirmed 前阻止新的自主派发", async () => {
  const current = applyEngineModelCatalogSnapshot(makeSnapshot(2));
  const activeLease = await acquireEngineModelCatalogDispatchLease();
  const pausePromise = pauseEngineModelCatalogDispatch({
    operationId: "publish-1",
    configVersion: current.configVersion,
    digest: current.digest,
  });
  let pauseSettled = false;
  void pausePromise.then(() => { pauseSettled = true; });
  await Promise.resolve();
  assert.equal(pauseSettled, false);

  activeLease.release();
  const pauseAck = await pausePromise;
  assert.equal(pauseAck.operationId, "publish-1");

  let nextLeaseSettled = false;
  const nextLeasePromise = acquireEngineModelCatalogDispatchLease().then((lease) => {
    nextLeaseSettled = true;
    return lease;
  });
  const applied = applyEngineModelCatalogSnapshot(makeSnapshot(3), 200, "publish-1");
  await Promise.resolve();
  assert.equal(nextLeaseSettled, false);
  assert.throws(
    () => confirmEngineModelCatalogApplied({ ...applied, operationId: "publish-other" }),
    (error: unknown) => (error as { code?: string }).code === "ENGINE_MODEL_CATALOG_CONFIRMATION_OPERATION_MISMATCH",
  );

  confirmEngineModelCatalogApplied(applied);
  const nextLease = await nextLeasePromise;
  assert.equal(nextLease.configVersion, 3);
  nextLease.release();
});

test("发布取消和断线重连只释放匹配操作建立的目录暂停", async () => {
  const current = applyEngineModelCatalogSnapshot(makeSnapshot(2));
  await pauseEngineModelCatalogDispatch({
    operationId: "publish-cancel",
    configVersion: current.configVersion,
    digest: current.digest,
  });
  const blockedByPublish = acquireEngineModelCatalogDispatchLease();
  cancelEngineModelCatalogDispatchPause("publish-other");
  let publishReleased = false;
  void blockedByPublish.then(() => { publishReleased = true; });
  await Promise.resolve();
  assert.equal(publishReleased, false);
  cancelEngineModelCatalogDispatchPause("publish-cancel");
  (await blockedByPublish).release();

  const reconnectOperationId = pauseEngineModelCatalogDispatchForReconnect("reconnect-1");
  assert.equal(reconnectOperationId, "reconnect-1");
  const blockedByReconnect = acquireEngineModelCatalogDispatchLease();
  let reconnectReleased = false;
  void blockedByReconnect.then(() => { reconnectReleased = true; });
  await Promise.resolve();
  assert.equal(reconnectReleased, false);

  const reapplied = applyEngineModelCatalogSnapshot(makeSnapshot(2), 300, "reconnect-1");
  confirmEngineModelCatalogApplied(reapplied);
  (await blockedByReconnect).release();
});

test("落后 Client 可先暂停并等待新目录应用确认", async () => {
  const current = applyEngineModelCatalogSnapshot(makeSnapshot(2));
  const pauseAck = await pauseEngineModelCatalogDispatch({
    operationId: "publish-stale-client",
    configVersion: 3,
    digest: "a".repeat(64),
  });
  assert.equal(pauseAck.configVersion, 3);
  const blocked = acquireEngineModelCatalogDispatchLease();
  let released = false;
  void blocked.then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false);
  const applied = applyEngineModelCatalogSnapshot(makeSnapshot(3), 400, "publish-stale-client");
  confirmEngineModelCatalogApplied(applied);
  (await blocked).release();
  assert.equal(current.configVersion, 2);
});

function makeSnapshot(configVersion: number): EngineModelCatalogSnapshot {
  return {
    schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
    configVersion,
    capturedAt: 100,
    rows: [
      {
        catalogItemId: "claude-deepseek-next",
        engine: "claude",
        providerId: "deepseek",
        providerLabel: "DeepSeek",
        modelId: "deepseek-next",
        displayName: "DeepSeek Next",
        description: "",
        inputModalities: ["text"],
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "深度思考" }],
        defaultReasoningEffort: "high",
        contextWindow: 200_000,
        maxContextWindow: 1_000_000,
        supportsFastMode: false,
        supports1MContext: true,
        isDefault: true,
        sortOrder: 1,
        runtimeProfileId: "claude_compatible_tiered",
        transportModelId: "deepseek-next-pro[1m]",
        fastTaskModelId: "deepseek-next-flash[1m]",
        subagentModelId: "deepseek-next-subagent[1m]",
      },
      {
        catalogItemId: "claude-kimi-next",
        engine: "claude",
        providerId: "moonshot",
        providerLabel: "Moonshot / Kimi",
        modelId: "kimi-next",
        displayName: "Kimi Next",
        description: "",
        inputModalities: ["text"],
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        contextWindow: 256_000,
        maxContextWindow: null,
        supportsFastMode: false,
        supports1MContext: false,
        isDefault: false,
        sortOrder: 3,
        runtimeProfileId: "claude_compatible_single_model",
        transportModelId: "kimi-next-runtime",
        fastTaskModelId: null,
        subagentModelId: null,
      },
      {
        catalogItemId: "claude-glm-next",
        engine: "claude",
        providerId: "zai",
        providerLabel: "Z.AI / 智谱",
        modelId: "glm-next",
        displayName: "GLM Next",
        description: "",
        inputModalities: ["text"],
        supportedReasoningEfforts: [{ reasoningEffort: "max", description: "深度思考" }],
        defaultReasoningEffort: "max",
        contextWindow: 200_000,
        maxContextWindow: null,
        supportsFastMode: false,
        supports1MContext: false,
        isDefault: false,
        sortOrder: 4,
        runtimeProfileId: "claude_compatible_required_thinking",
        transportModelId: "glm-next",
        fastTaskModelId: null,
        subagentModelId: null,
      },
      {
        catalogItemId: "claude-deepseek-flash",
        engine: "claude",
        providerId: "deepseek",
        providerLabel: "DeepSeek",
        modelId: "deepseek-flash",
        displayName: "DeepSeek Flash",
        description: "",
        inputModalities: ["text"],
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        contextWindow: 200_000,
        maxContextWindow: 1_000_000,
        supportsFastMode: false,
        supports1MContext: true,
        isDefault: false,
        sortOrder: 2,
        runtimeProfileId: "claude_compatible_single_model",
        transportModelId: "deepseek-flash",
        fastTaskModelId: null,
        subagentModelId: null,
      },
      {
        catalogItemId: "codex-gpt-next",
        engine: "codex",
        providerId: "openai",
        providerLabel: "OpenAI",
        modelId: "gpt-next",
        displayName: "GPT Next",
        description: "",
        inputModalities: ["text"],
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "深度思考" }],
        defaultReasoningEffort: "high",
        contextWindow: 180_000,
        maxContextWindow: null,
        supportsFastMode: true,
        supports1MContext: false,
        isDefault: true,
        sortOrder: 1,
        runtimeProfileId: "native",
        transportModelId: null,
        fastTaskModelId: null,
        subagentModelId: null,
      },
    ],
  };
}
