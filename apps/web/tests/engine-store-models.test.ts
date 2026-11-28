import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { useEngineStore } from "../src/store/engine.ts";

const ctx = { serverWsOrigin: "ws://127.0.0.1:39280", sessionToken: "test", webSessionId: "web" };

/** 构造 engines.status 成功响应，仅保留 Web 实际消费的 engines 与 customModelsByEngine。 */
function engineStatus(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** 内置 Codex 状态；模型与自定义模型均由响应携带，不再依赖目录字段。 */
function codexStatus() {
  return {
    engineType: "codex",
    installed: true,
    version: "1.0.0",
    binPath: null,
    features: {},
    error: null,
    models: [{ id: "gpt-6.2-sol", displayName: "GPT-6.2 Sol", isDefault: true }],
  };
}

test("refresh 使用 status engines 与 customModelsByEngine 并刷新工作区缓存", async t => {
  setActivePinia(createPinia());
  const engines = useEngineStore();
  const original = globalThis.fetch;
  globalThis.fetch = async () => engineStatus({
    ok: true,
    engines: [codexStatus()],
    customModelsByEngine: { codex: [{ id: "custom-1", displayName: "Custom", isDefault: false }] },
  });
  t.after(() => { globalThis.fetch = original; });

  await engines.refresh(ctx, "ws");

  assert.deepEqual(engines.engines.map(engine => engine.engineType), ["codex"]);
  assert.deepEqual(engines.customModelsByEngine.codex?.map(model => model.id), ["custom-1"]);
  assert.deepEqual(engines.byWorkspaceId.ws?.engines.map(engine => engine.engineType), ["codex"]);
  assert.deepEqual(engines.byWorkspaceId.ws?.customModelsByEngine.codex?.map(model => model.id), ["custom-1"]);
  assert.equal(engines.lastError, null);
});

test("refresh 失败保留旧模型并记录错误", async t => {
  setActivePinia(createPinia());
  const engines = useEngineStore();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  globalThis.fetch = async () => engineStatus({
    ok: true,
    engines: [codexStatus()],
    customModelsByEngine: { codex: [{ id: "custom-1", displayName: "Custom", isDefault: false }] },
  });
  await engines.refresh(ctx, "ws");
  const previousEngines = engines.byWorkspaceId.ws?.engines;
  const previousCustom = engines.byWorkspaceId.ws?.customModelsByEngine;
  assert.ok(previousEngines);

  globalThis.fetch = async () => { throw new Error("engine status offline"); };
  await assert.rejects(engines.refresh(ctx, "ws"), /engine status offline/);

  assert.deepEqual(engines.byWorkspaceId.ws?.engines, previousEngines);
  assert.deepEqual(engines.byWorkspaceId.ws?.customModelsByEngine, previousCustom);
  assert.equal(engines.lastError, "engine status offline");
});

test("引擎状态与工作区缓存不再包含目录字段", async t => {
  setActivePinia(createPinia());
  const engines = useEngineStore();
  const original = globalThis.fetch;
  globalThis.fetch = async () => engineStatus({ ok: true, engines: [codexStatus()] });
  t.after(() => { globalThis.fetch = original; });

  await engines.refresh(ctx, "ws");

  for (const state of [engines, engines.byWorkspaceId.ws!]) {
    assert.equal("catalogVersion" in state, false);
    assert.equal("hostAppliedCatalogVersion" in state, false);
    assert.equal("hostCatalogSyncState" in state, false);
  }
});
