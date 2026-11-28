import assert from "node:assert/strict";
import test from "node:test";
import { getEngineModels, type EngineCustomModelEntry } from "@codeflowai/shared";
import {
  assertRuntimeEngineModelAvailable,
  getRuntimeEngineModelInfo,
  getRuntimeEngineModels,
  resetEngineModelCatalogRuntimeForTest,
  setEngineModelCatalogCustomModels,
} from "../src/engines/engineModelCatalogRuntime.ts";

test.beforeEach(() => resetEngineModelCatalogRuntimeForTest());
test.afterEach(() => resetEngineModelCatalogRuntimeForTest());

/** 构造一份最小的本机自定义模型条目，仅用于验证合并与别名。 */
function customModel(overrides: Partial<EngineCustomModelEntry> & Pick<EngineCustomModelEntry, "engine" | "modelId">): EngineCustomModelEntry {
  return {
    id: `test:${overrides.engine}:${overrides.modelId}`,
    providerId: overrides.engine === "claude" ? "anthropic" : "openai",
    displayName: overrides.modelId,
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
    ...overrides,
  };
}

test("未初始化即返回内置模型", () => {
  for (const engine of ["codex", "claude"] as const) {
    assert.deepEqual(
      getRuntimeEngineModels(engine).map(model => model.id),
      getEngineModels(engine).map(model => model.id),
    );
    const defaultModel = getRuntimeEngineModels(engine).find(model => model.isDefault);
    assert.ok(defaultModel, `${engine} 应存在内置默认模型`);
  }
});

test("自定义模型合并进内置列表且内置 ID 优先", () => {
  const builtInDefault = getEngineModels("claude").find(model => model.isDefault)!;
  setEngineModelCatalogCustomModels([
    customModel({ engine: "claude", modelId: "custom-1", displayName: "Custom One" }),
    customModel({ engine: "claude", modelId: builtInDefault.id, displayName: "内置被覆盖" }),
  ]);

  const models = getRuntimeEngineModels("claude");
  const custom = models.find(model => model.id === "custom-1");
  assert.ok(custom);
  assert.equal(custom.isDefault, false);
  assert.equal(custom.displayName, "Custom One");
  const builtIn = models.find(model => model.id === builtInDefault.id);
  assert.equal(builtIn?.displayName, builtInDefault.displayName, "内置 ID 必须优先于同名自定义模型");
  assert.equal(models.filter(model => model.id === builtInDefault.id).length, 1);
});

test("[1m] 别名按支持 1M 的基型派生并使用 1M 窗口", () => {
  setEngineModelCatalogCustomModels([
    customModel({ engine: "claude", modelId: "custom-1m", supports1MContext: true, contextWindow: 200_000 }),
  ]);

  const alias = getRuntimeEngineModelInfo("claude", "custom-1m[1m]");
  assert.ok(alias);
  assert.equal(alias.id, "custom-1m[1m]");
  assert.equal(alias.contextWindow, 1_000_000);
  assert.equal(alias.maxContextWindow, 1_000_000);
  assert.doesNotThrow(() => assertRuntimeEngineModelAvailable("claude", "custom-1m[1m]"));
  assert.equal(getRuntimeEngineModelInfo("claude", "missing[1m]"), null);
});
