import test from "node:test";
import assert from "node:assert/strict";

import {
  assertReasoningEffortSupportedForModel,
  CODEX_MODELS,
  CLAUDE_MODELS,
  filterEngineModelsByProviderIds,
  getDefaultEngineModel,
  getDefaultEngineProviderId,
  getEngineModelInfo,
  getEngineModelProviderId,
  getSupportedReasoningEffortsForProvider,
  isEngineProviderAllowed,
  mergeEngineModelsWithCustomModels,
  normalizeEngineKeyProviderId,
  resolveCatalogDefaultThreadPrefs,
  resolveThreadPrefsWithCatalogDefaults,
  toEngineModelInfoFromCustomModel,
} from "../../packages/shared/src/engineCatalog.ts";

test("Claude Fable 5.2 is the default 1M model", () => {
  const defaultModel = getDefaultEngineModel("claude");
  assert.equal(defaultModel?.id, "claude-fable-5-2");
  assert.equal(defaultModel?.displayName, "Claude Fable 5.2");
  assert.equal(defaultModel?.contextWindow, 1_000_000);
  assert.equal(defaultModel?.defaultReasoningEffort, "high");
});

test("Claude Fable 5.1 is exposed as an opt-in native 1M model", () => {
  const fable51 = getEngineModelInfo("claude", "claude-fable-5-1");
  assert.equal(fable51?.displayName, "Claude Fable 5.1");
  assert.equal(fable51?.providerId, "anthropic");
  assert.equal(fable51?.isDefault, false);
  assert.deepEqual(
    fable51?.supportedReasoningEfforts?.map((item) => item.reasoningEffort),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(fable51?.defaultReasoningEffort, "high");
  assert.deepEqual(fable51?.inputModalities, ["text", "image"]);
  assert.equal(fable51?.contextWindow, 1_000_000);
  assert.equal(fable51?.supports1MContext ?? false, false);
  assert.equal(fable51?.maxContextWindow ?? null, null);
  assert.equal(
    resolveThreadPrefsWithCatalogDefaults("claude", { model: "claude-fable-5-1", contextWindow: 1_000_000 }).contextWindow,
    1_000_000,
  );
});

test("Claude Opus 5.5 is exposed as an opt-in native 1M model", () => {
  const opus55 = getEngineModelInfo("claude", "claude-opus-5-5");
  assert.equal(opus55?.displayName, "Claude Opus 5.5");
  assert.equal(opus55?.providerId, "anthropic");
  assert.equal(opus55?.isDefault, false);
  assert.deepEqual(
    opus55?.supportedReasoningEfforts?.map((item) => item.reasoningEffort),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(opus55?.defaultReasoningEffort, "medium");
  assert.deepEqual(opus55?.inputModalities, ["text", "image"]);
  assert.equal(opus55?.contextWindow, 1_000_000);
  assert.equal(opus55?.supports1MContext ?? false, false);
  assert.equal(opus55?.maxContextWindow ?? null, null);
  assert.equal(
    resolveThreadPrefsWithCatalogDefaults("claude", { model: "claude-opus-5-5", contextWindow: 200_000 }).contextWindow,
    1_000_000,
  );
  assert.throws(() => assertReasoningEffortSupportedForModel("claude", "claude-opus-5-5", "ultra"), /不支持/);
});

test("Claude Opus 5 is exposed as fixed 200K and 1M entries", () => {
  const baseModel = getEngineModelInfo("claude", "claude-opus-5");
  const oneMillionModel = getEngineModelInfo("claude", "claude-opus-5[1m]");
  assert.equal(baseModel?.displayName, "Claude Opus 5");
  assert.equal(baseModel?.contextWindow, 200_000);
  assert.deepEqual(baseModel?.supportedReasoningEfforts?.map((item) => item.reasoningEffort), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(baseModel?.defaultReasoningEffort, "high");
  assert.equal(oneMillionModel?.displayName, "Claude Opus 5 1M");
  assert.equal(oneMillionModel?.contextWindow, 1_000_000);
  assert.equal(oneMillionModel?.defaultReasoningEffort, "high");
  assert.equal(oneMillionModel?.supports1MContext ?? false, false);
  assert.equal(oneMillionModel?.maxContextWindow ?? null, null);
});

test("Claude catalog retains the two latest releases in each Anthropic model family", () => {
  assert.deepEqual(CLAUDE_MODELS.filter((model) => model.providerId === "anthropic").map((model) => model.id), [
    "claude-fable-5-2", "claude-fable-5-1",
    "claude-opus-5-5", "claude-opus-5", "claude-opus-5[1m]",
    "claude-sonnet-5-5", "claude-sonnet-5",
    "claude-haiku-5-5", "claude-haiku-4-5-20251001",
  ]);
});

test("Claude catalog defaults resolve to Fable 5.2 with a 1M window", () => {
  const defaults = resolveCatalogDefaultThreadPrefs("claude");
  assert.equal(defaults.model, "claude-fable-5-2");
  assert.equal(defaults.contextWindow, 1_000_000);
  assert.equal(defaults.effort, "high");
});

test("Claude catalog exposes supported DeepSeek models without retired Flash entries", () => {
  const deepseekModels = CLAUDE_MODELS.filter((item) => item.id.startsWith("deepseek-"));
  assert.deepEqual(
    deepseekModels.map((item) => item.id),
    ["deepseek-flash", "deepseek-v4-pro"],
  );

  for (const model of deepseekModels) {
    assert.equal(model.providerId, "deepseek");
    assert.equal(model.providerLabel, "DeepSeek");
    assert.equal(model.defaultReasoningEffort, "high");
    assert.deepEqual(
      model.supportedReasoningEfforts?.map((item) => item.reasoningEffort),
      ["low", "high", "max"],
    );
    assert.deepEqual(model.inputModalities, model.id === "deepseek-v4-pro" ? ["text"] : ["text", "image"]);
  }
  assert.equal(getEngineModelInfo("claude", "deepseek-flash")?.displayName, "DeepSeek V4.1 Flash 1M");
  // 合并前的显式 [1m] 变体按静默别名归一为合并后的条目，不提示下线。
  const silentAliasedFlash = getEngineModelInfo("claude", "deepseek-flash[1m]");
  assert.equal(silentAliasedFlash?.id, "deepseek-flash");
  assert.equal(silentAliasedFlash?.displayName, "DeepSeek V4.1 Flash 1M");
  assert.doesNotMatch(silentAliasedFlash?.displayName ?? "", /已下线/);
  assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: "deepseek-flash" }).contextWindow, 1_000_000);
  assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: "deepseek-flash[1m]" }).contextWindow, 1_000_000);
  // 读取时归一：历史会话的显式 [1m] 变体直接换成合并后的 ID，不保留旧变体。
  assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: "deepseek-flash[1m]" }).model, "deepseek-flash");
  assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: "deepseek-v4-pro", effort: "low" }).effort, "low");
  assert.equal(getEngineModelInfo("claude", "deepseek-v4-pro")?.contextWindow, 1_000_000);
});

test("retired DeepSeek aliases retain historical capabilities without reappearing in selectors", () => {
  for (const modelId of ["deepseek-v4-flash", "deepseek-v4-flash[1m]", "deepseek-v4-flash-vision-exp", "deepseek-v4-flash-vision-exp[1m]"]) {
    assert.equal(CLAUDE_MODELS.some((model) => model.id === modelId), false);
    const legacy = getEngineModelInfo("claude", modelId);
    assert.equal(legacy?.id, modelId);
    assert.match(legacy?.displayName ?? "", /已下线/);
    assert.deepEqual(legacy?.inputModalities, ["text", "image"]);
    assert.deepEqual(legacy?.supportedReasoningEfforts?.map((item) => item.reasoningEffort), ["low", "high", "max"]);
    assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: modelId }).model, modelId);
  }
  assert.equal(getEngineModelInfo("claude", "deepseek-v4-flash")?.contextWindow, 1_000_000);
  assert.equal(getEngineModelInfo("claude", "deepseek-v4-flash[1m]")?.contextWindow, 1_000_000);
  assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: "deepseek-v4-flash-vision-exp" }).contextWindow, 1_000_000);
  assert.equal(getEngineModelInfo("claude", "deepseek-v4-flash", filterEngineModelsByProviderIds(CLAUDE_MODELS, ["anthropic"])), null);
});

test("Sonnet 5 exposes native 1M, images and the advanced effort ladder", () => {
  const model = getEngineModelInfo("claude", "claude-sonnet-5");
  assert.equal(model?.providerId, "anthropic");
  assert.equal(model?.contextWindow, 1_000_000);
  assert.equal(model?.isDefault, false);
  assert.deepEqual(model?.inputModalities, ["text", "image"]);
  assert.deepEqual(model?.supportedReasoningEfforts?.map((item) => item.reasoningEffort), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(model?.defaultReasoningEffort, "high");
  assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: "claude-sonnet-5", contextWindow: 200_000 }).contextWindow, 1_000_000);
  assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", "claude-sonnet-5[1m]", "max"));
  assert.throws(() => assertReasoningEffortSupportedForModel("claude", "claude-sonnet-5", "ultra"), /不支持/);
});

test("Kimi catalog includes K3.1 Pro variants and K3", () => {
  assert.deepEqual(CLAUDE_MODELS.filter((model) => model.providerId === "moonshot").map((model) => model.id), [
    "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3",
  ]);
  for (const modelId of ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3"]) {
    const model = getEngineModelInfo("claude", modelId);
    assert.equal(model?.contextWindow, 1_000_000);
    assert.deepEqual(model?.inputModalities, ["text", "image"]);
    assert.equal(model?.defaultReasoningEffort, "max");
  }
});

test("GLM 5.3 models expose 1M and documented efforts with vision limited to Flash", () => {
  for (const modelId of ["glm-5.3", "glm-5.3-flash"]) {
    const model = getEngineModelInfo("claude", modelId);
    assert.equal(model?.providerId, "zai");
    assert.equal(model?.contextWindow, 1_000_000);
    assert.deepEqual(model?.inputModalities, modelId === "glm-5.3" ? ["text"] : ["text", "image"]);
    assert.deepEqual(model?.supportedReasoningEfforts?.map((item) => item.reasoningEffort), ["low", "high", "max"]);
    assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: modelId }).effort, "max");
    assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", `${modelId}[1m]`, "low"));
    assert.throws(() => assertReasoningEffortSupportedForModel("claude", `${modelId}[1m]`, "medium"), /不支持/);
  }
});

test("Haiku 4.5 remains available without adjustable reasoning effort", () => {
  const model = getEngineModelInfo("claude", "claude-haiku-4-5-20251001");
  assert.deepEqual(model?.supportedReasoningEfforts, []);
  assert.equal(model?.defaultReasoningEffort, null);
});

test("GLM and Qwen expose the two latest compatible versions", () => {
  assert.deepEqual(CLAUDE_MODELS.filter((model) => model.providerId === "zai").map((model) => model.id), [
    "glm-5.4", "glm-5.3", "glm-5.3-flash",
  ]);
  assert.deepEqual(CLAUDE_MODELS.filter((model) => model.providerId === "qwen").map((model) => model.id), [
    "qwen4-max", "qwen3.8-max", "qwen3.8-flash",
  ]);
  assert.equal(getEngineModelInfo("claude", "glm-5.4")?.contextWindow, 1_000_000);
  assert.equal(getEngineModelInfo("claude", "qwen4-max")?.contextWindow, 983_616);
});

test("model catalogs declare provider metadata for grouped selectors", () => {
  assert.deepEqual(
    [...new Set(CLAUDE_MODELS.map((item) => item.providerLabel))],
    ["Anthropic Claude", "DeepSeek", "Moonshot / Kimi", "Z.AI / 智谱", "Qwen Cloud"],
  );
  assert.deepEqual(
    [...new Set(CODEX_MODELS.map((item) => item.providerLabel))],
    ["OpenAI"],
  );
});

test("provider helpers map model ids and key providers by engine", () => {
  assert.equal(getDefaultEngineProviderId("claude"), "anthropic");
  assert.equal(getDefaultEngineProviderId("codex"), "openai");
  assert.equal(getEngineModelProviderId("claude", "claude-fable-5-1"), "anthropic");
  assert.equal(getEngineModelProviderId("claude", "claude-fable-5"), "anthropic");
  assert.equal(getEngineModelProviderId("claude", "claude-opus-5"), "anthropic");
  assert.equal(getEngineModelProviderId("claude", "claude-opus-4-8"), "anthropic");
  assert.equal(getEngineModelProviderId("claude", "deepseek-flash"), "deepseek");
  assert.equal(getEngineModelProviderId("claude", "deepseek-flash[1m]"), "deepseek");
  assert.equal(getEngineModelProviderId("claude", "deepseek-v4-pro"), "deepseek");
  assert.equal(getEngineModelProviderId("claude", "deepseek-v4-pro[1m]"), "deepseek");
  assert.equal(getEngineModelProviderId("claude", "deepseek-v4-flash[1m]"), "deepseek");
  assert.equal(getEngineModelProviderId("claude", "kimi-k3"), "moonshot");
  assert.equal(getEngineModelProviderId("claude", "kimi-k2.6"), "moonshot");
  assert.equal(getEngineModelProviderId("claude", "glm-5.1"), "zai");
  assert.equal(getEngineModelProviderId("claude", "qwen3.7-max"), "qwen");
  assert.equal(getEngineModelProviderId("codex", "gpt-5.5"), "openai");
  assert.equal(getEngineModelProviderId("codex", "gpt-6.1-sol"), "openai");
  assert.equal(getEngineModelProviderId("codex", "gpt-6-sol"), "openai");
  assert.equal(getEngineModelProviderId("codex", "gpt-6-luna"), "openai");
  assert.equal(normalizeEngineKeyProviderId("claude", null), "anthropic");
  assert.equal(normalizeEngineKeyProviderId("claude", "deepseek"), "deepseek");
  assert.equal(normalizeEngineKeyProviderId("claude", "moonshot"), "moonshot");
  assert.equal(normalizeEngineKeyProviderId("claude", "zai"), "zai");
  assert.equal(normalizeEngineKeyProviderId("claude", "qwen"), "qwen");
  assert.equal(normalizeEngineKeyProviderId("codex", "deepseek"), null);
  assert.equal(normalizeEngineKeyProviderId("codex", "qwen"), null);
  assert.equal(isEngineProviderAllowed("codex", "openai"), true);
  assert.deepEqual(
    filterEngineModelsByProviderIds(CLAUDE_MODELS, ["deepseek"]).map((item) => item.id),
    ["deepseek-flash", "deepseek-v4-pro"],
  );
  assert.deepEqual(
    filterEngineModelsByProviderIds(CLAUDE_MODELS, ["qwen"]).map((item) => item.id),
    ["qwen4-max", "qwen3.8-max", "qwen3.8-flash"],
  );
});

test("Claude catalog does not expose deprecated DeepSeek compatibility aliases", () => {
  // 注意：`deepseek-flash[1m]` 是静默归一条目（见上文 Flash 合并用例），不属于此处断言为 null 的弃用别名。
  assert.equal(getEngineModelInfo("claude", "deepseek-v4-pro[1m]"), null);
  assert.equal(getEngineModelInfo("claude", "deepseek-chat"), null);
  assert.equal(getEngineModelInfo("claude", "deepseek-reasoner"), null);
});

test("Codex defaults to GPT-6.2 Sol with an 872K window, xhigh and standard tier", () => {
  const defaultModel = getDefaultEngineModel("codex");
  assert.equal(defaultModel?.id, "gpt-6.2-sol");
  assert.equal(defaultModel?.contextWindow, 500_000);
  const defaults = resolveCatalogDefaultThreadPrefs("codex");
  assert.equal(defaults.model, "gpt-6.2-sol");
  assert.equal(defaults.effort, "xhigh");
  assert.equal(defaults.autoCompactPct, 95);
  assert.equal(defaults.contextWindow, 872_000);
  assert.equal(defaults.serviceTier, null);
});

test("Codex catalog lists GPT-6.2 and excludes GPT-5.5 and GPT-5.6", () => {
  assert.deepEqual(CODEX_MODELS.map((item) => item.id), [
    "gpt-6.2-sol", "gpt-6.2-astra", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna",
  ]);
  for (const modelId of ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini"]) {
    assert.equal(getEngineModelInfo("codex", modelId), null);
  }
});

test("GPT-6 Astra is opt-in and exposes current Codex capabilities", () => {
  const astra = getEngineModelInfo("codex", "gpt-6-astra");
  assert.equal(astra?.isDefault, false);
  assert.deepEqual(astra?.inputModalities, ["text", "image"]);
  assert.deepEqual(
    astra?.supportedReasoningEfforts?.map((item) => item.reasoningEffort),
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.equal(astra?.defaultReasoningEffort, "xhigh");
  assert.equal(astra?.contextWindow, 272_000);
  assert.equal(astra?.supports1MContext, true);
  assert.equal(astra?.maxContextWindow, 872_000);
  assert.equal(
    resolveThreadPrefsWithCatalogDefaults("codex", { model: "gpt-6-astra", contextWindow: 1_000_000 }).contextWindow,
    872_000,
  );
});

test("GPT-6 Sol and Luna expose their documented 1.05M multimodal capability", () => {
  for (const [modelId, description] of [
    ["gpt-6-sol", "Codex 复杂编码与代理模型，适合高价值工程任务"],
    ["gpt-6-luna", "Codex 高效模型，适合聚焦、重复与高吞吐任务"],
  ] as const) {
    const model = getEngineModelInfo("codex", modelId);
    assert.equal(model?.displayName, modelId === "gpt-6-sol" ? "GPT-6 Sol" : "GPT-6 Luna");
    assert.equal(model?.description, description);
    assert.equal(model?.isDefault, false);
    assert.deepEqual(model?.inputModalities, ["text", "image"]);
    assert.deepEqual(
      model?.supportedReasoningEfforts?.map((item) => item.reasoningEffort),
      ["none", "low", "medium", "high", "xhigh", "max"],
    );
    assert.equal(model?.defaultReasoningEffort, "medium");
    assert.equal(model?.contextWindow, 1_050_000);
    assert.equal(model?.maxContextWindow, 1_050_000);
    assert.equal(model?.supports1MContext, true);
    assert.equal(model?.supportsFastMode, true);
    assert.throws(() => assertReasoningEffortSupportedForModel("codex", modelId, "minimal"), /不支持/);
    assert.throws(() => assertReasoningEffortSupportedForModel("codex", modelId, "ultra"), /不支持/);
    assert.equal(
      resolveThreadPrefsWithCatalogDefaults("codex", { model: modelId, contextWindow: 200_000 }).contextWindow,
      1_050_000,
    );
    assert.equal(
      resolveThreadPrefsWithCatalogDefaults("codex", { model: modelId, serviceTier: "fast" }).serviceTier,
      "fast",
    );
  }
});

test("GPT-6.1 Sol exposes its documented effort ladder and Fast mode", () => {
  const model = getEngineModelInfo("codex", "gpt-6.1-sol");
  assert.equal(model?.displayName, "GPT-6.1 Sol");
  assert.equal(model?.providerId, "openai");
  assert.equal(model?.isDefault, false);
  assert.deepEqual(model?.inputModalities, ["text", "image"]);
  assert.deepEqual(
    model?.supportedReasoningEfforts?.map((item) => item.reasoningEffort),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(model?.defaultReasoningEffort, "medium");
  assert.equal(model?.contextWindow, 1_000_000);
  assert.equal(model?.maxContextWindow, 1_000_000);
  assert.equal(model?.supports1MContext, true);
  assert.equal(model?.supportsFastMode, true);
  assert.throws(() => assertReasoningEffortSupportedForModel("codex", "gpt-6.1-sol", "none"), /不支持/);
  assert.throws(() => assertReasoningEffortSupportedForModel("codex", "gpt-6.1-sol", "minimal"), /不支持/);
  assert.throws(() => assertReasoningEffortSupportedForModel("codex", "gpt-6.1-sol", "ultra"), /不支持/);
  assert.equal(
    resolveThreadPrefsWithCatalogDefaults("codex", { model: "gpt-6.1-sol", serviceTier: "fast" }).serviceTier,
    "fast",
  );
  assert.equal(
    resolveThreadPrefsWithCatalogDefaults("codex", { model: "gpt-6.1-sol", contextWindow: 200_000 }).contextWindow,
    1_000_000,
  );
});

test("Codex Fast mode is exposed as a model capability for eligible GPT models", () => {
  assert.equal(getEngineModelInfo("codex", "gpt-6-astra")?.supportsFastMode, true);
  assert.equal(getEngineModelInfo("codex", "gpt-6.1-sol")?.supportsFastMode, true);
  assert.equal(getEngineModelInfo("codex", "gpt-6-sol")?.supportsFastMode, true);
  assert.equal(getEngineModelInfo("codex", "gpt-6-luna")?.supportsFastMode, true);
  assert.equal(getEngineModelInfo("codex", "gpt-6.2-sol")?.supportsFastMode, true);
  assert.equal(getEngineModelInfo("codex", "gpt-6.2-astra")?.supportsFastMode, true);
});

test("Codex service tier is kept only for Fast-capable Codex models", () => {
  assert.equal(
    resolveThreadPrefsWithCatalogDefaults("codex", { model: "gpt-6.2-sol", serviceTier: "fast" }).serviceTier,
    "fast",
  );
  assert.equal(
    resolveThreadPrefsWithCatalogDefaults("codex", { model: "custom-codex-model", serviceTier: "fast" }).serviceTier,
    null,
  );
  assert.equal(
    resolveThreadPrefsWithCatalogDefaults("claude", { model: "claude-fable-5", serviceTier: "fast" }).serviceTier,
    null,
  );
});

test("GPT 默认使用标准档，仅在显式开启且模型支持时保留 Fast", () => {
  assert.equal(resolveThreadPrefsWithCatalogDefaults("codex").serviceTier, null);
  for (const model of CODEX_MODELS) {
    assert.equal(
      resolveThreadPrefsWithCatalogDefaults("codex", { model: model.id }).serviceTier,
      null,
      model.id,
    );
    assert.equal(resolveThreadPrefsWithCatalogDefaults("codex", { model: model.id, serviceTier: null }).serviceTier, null);
    assert.equal(resolveThreadPrefsWithCatalogDefaults("codex", { model: model.id, serviceTier: "fast" }).serviceTier, model.supportsFastMode ? "fast" : null);
  }
  assert.equal(resolveThreadPrefsWithCatalogDefaults("codex", { model: "unknown-model" }).serviceTier, null);
  assert.equal(resolveThreadPrefsWithCatalogDefaults("claude").serviceTier, null);
  const models = [{ ...CODEX_MODELS[0]!, supportsFastMode: false, isDefault: true }];
  assert.equal(resolveCatalogDefaultThreadPrefs("codex", models).serviceTier, null);
  assert.equal(resolveThreadPrefsWithCatalogDefaults("codex", { model: models[0]!.id }, models).serviceTier, null);
});

test("GPT-6.2 Sol and Astra expose the supported reasoning ladder and 872K windows", () => {
  for (const modelId of ["gpt-6.2-sol", "gpt-6.2-astra"]) {
    const model = getEngineModelInfo("codex", modelId);
    assert.deepEqual(model?.supportedReasoningEfforts?.map((item) => item.reasoningEffort), ["low", "medium", "high", "xhigh", "max", "ultra"]);
    assert.deepEqual(model?.inputModalities, ["text", "image"]);
    assert.equal(resolveThreadPrefsWithCatalogDefaults("codex", { model: modelId }).contextWindow, 872_000);
  }
});

test("新旧会话统一使用模型最大窗口，历史覆盖值不再生效", () => {
  const models = [{ id: "context-model", displayName: "Context", isDefault: true,
    contextWindow: 200_000, maxContextWindow: 800_000, supports1MContext: false }];
  for (const engine of ["claude", "codex"] as const) {
    assert.equal(resolveThreadPrefsWithCatalogDefaults(engine, { model: "context-model" }, models).contextWindow, 800_000);
    assert.equal(resolveThreadPrefsWithCatalogDefaults(engine, { model: "context-model", contextWindow: 150_000 }, models).contextWindow, 800_000);
    assert.equal(resolveThreadPrefsWithCatalogDefaults(engine, { model: "context-model", contextWindow: 450_000 }, models).contextWindow, 800_000);
    assert.equal(resolveThreadPrefsWithCatalogDefaults(engine, { model: "context-model", contextWindow: 1_000_000 }, models).contextWindow, 800_000);
  }
  assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: "context-model", contextWindow: 50_000 }, models).contextWindow, 800_000);
});

test("仅声明最大容量的旧自定义模型不被缺省容量抬高", () => {
  const models = [{ id: "max-only-model", displayName: "Max only", isDefault: true, maxContextWindow: 128_000 }];
  for (const engine of ["codex", "claude"] as const) {
    assert.equal(resolveCatalogDefaultThreadPrefs(engine, models).contextWindow, 128_000);
    assert.equal(resolveThreadPrefsWithCatalogDefaults(engine, { model: "max-only-model", contextWindow: 32_000 }, models).contextWindow, 128_000);
  }
});

test("provider effort options follow engine/provider capabilities", () => {
  assert.deepEqual(
    getSupportedReasoningEffortsForProvider("codex", "openai").map((item) => item.reasoningEffort),
    ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.deepEqual(
    getSupportedReasoningEffortsForProvider("claude", "deepseek").map((item) => item.reasoningEffort),
    ["low", "high", "max"],
  );
  assert.deepEqual(
    getSupportedReasoningEffortsForProvider("claude", "anthropic").map((item) => item.reasoningEffort),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(getSupportedReasoningEffortsForProvider("claude", "moonshot").map((item) => item.reasoningEffort), ["low", "medium", "high", "max"]);
  assert.deepEqual(getSupportedReasoningEffortsForProvider("claude", "zai").map((item) => item.reasoningEffort), ["low", "high", "max"]);
  assert.deepEqual(getSupportedReasoningEffortsForProvider("claude", "qwen"), []);
});

test("thread prefs resolver repairs stale or unsupported historical effort values", () => {
  assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: "kimi-k3", effort: "medium" }).effort, "max");
  assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: "qwen4-max", effort: "max" }).effort, null);
  assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: "deepseek-v4-pro", effort: "medium" }).effort, "high");
});

test("explicit effort validation rejects unsupported model tiers without changing missing-effort defaults", () => {
  assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", "deepseek-flash", "low"));
  assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", "deepseek-flash[1m]", "max"));
  assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", "deepseek-v4-pro", "low"));
  assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", "deepseek-v4-pro[1m]", "low"));
  assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", "deepseek-v4-flash", "low"));
  assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", "deepseek-v4-flash", "max"));
  assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", "deepseek-v4-pro", "max"));
  assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", "deepseek-v4-pro[1m]", "max"));
  assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", "claude-sonnet-5-5", "max"));
  assert.throws(
    () => assertReasoningEffortSupportedForModel("claude", "deepseek-v4-pro", "medium"),
    /模型「deepseek-v4-pro」不支持思考强度「medium」/,
  );
  assert.throws(
    () => assertReasoningEffortSupportedForModel("claude", "deepseek-v4-pro[1m]", "medium"),
    /模型「deepseek-v4-pro」不支持思考强度「medium」/,
  );
  assert.throws(
    () => assertReasoningEffortSupportedForModel("claude", "claude-haiku-4-5-20251001", "high"),
    /不支持思考强度「high」/,
  );
  assert.throws(
    () => assertReasoningEffortSupportedForModel("claude", "deepseek-v4-pro", "extreme"),
    /不支持的思考强度「extreme」/,
  );
  assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", "vendor/unknown-model", "high"));
  assert.doesNotThrow(() => assertReasoningEffortSupportedForModel("claude", "deepseek-v4-pro", null));
  assert.equal(resolveThreadPrefsWithCatalogDefaults("claude", { model: "deepseek-v4-pro" }).effort, "high");
});

test("custom models merge into catalog with provider metadata", () => {
  const custom = toEngineModelInfoFromCustomModel({
    id: "custom-1",
    engine: "claude",
    providerId: "anthropic",
    modelId: "moonshot-k2-0711",
    displayName: "Moonshot K2",
    inputModalities: ["text"],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    contextWindow: 200_000,
    maxContextWindow: null,
    supportsFastMode: false,
    supports1MContext: false,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  });
  const merged = mergeEngineModelsWithCustomModels("claude", CLAUDE_MODELS, [custom]);

  assert.equal(getEngineModelInfo("claude", "moonshot-k2-0711", merged)?.displayName, "Moonshot K2");
  assert.equal(getEngineModelProviderId("claude", "moonshot-k2-0711", merged), "anthropic");
});

test("custom model without effort catalog does not fall back to engine default effort", () => {
  const custom = toEngineModelInfoFromCustomModel({
    id: "custom-2",
    engine: "codex",
    providerId: "openai",
    modelId: "vendor/custom-codex",
    displayName: "Vendor Custom Codex",
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
  });
  const merged = mergeEngineModelsWithCustomModels("codex", CODEX_MODELS, [custom]);

  assert.equal(resolveThreadPrefsWithCatalogDefaults("codex", { model: "vendor/custom-codex" }, merged).effort, null);
});

test("custom model with configured default effort uses that effort", () => {
  const custom = toEngineModelInfoFromCustomModel({
    id: "custom-3",
    engine: "codex",
    providerId: "openai",
    modelId: "vendor/reasoning-codex",
    displayName: "Vendor Reasoning Codex",
    inputModalities: ["text"],
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "low" }, { reasoningEffort: "high", description: "high" }],
    defaultReasoningEffort: "high",
    contextWindow: 128_000,
    maxContextWindow: null,
    supportsFastMode: true,
    supports1MContext: false,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  });
  const merged = mergeEngineModelsWithCustomModels("codex", CODEX_MODELS, [custom]);

  assert.equal(resolveThreadPrefsWithCatalogDefaults("codex", { model: "vendor/reasoning-codex" }, merged).effort, "high");
  assert.equal(resolveThreadPrefsWithCatalogDefaults("codex", { model: "vendor/reasoning-codex", serviceTier: "fast" }, merged).serviceTier, "fast");
});
