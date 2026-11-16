import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import {
  ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
  createDefaultRoleExecutionConfig,
  type EngineModelCatalogItem,
  type EngineModelCatalogSnapshot,
} from "@codeflowai/shared";

import { useEngineStore } from "../src/store/engine.ts";
import { resolveCatalogRoleExecutionConfigForEngine } from "../src/composables/runtimeRoleExecutionConfig.ts";

test("角色 auto 配置只使用动态目录默认模型且空目录不回退静态清单", () => {
  const config = createDefaultRoleExecutionConfig("codex");
  const dynamic = resolveCatalogRoleExecutionConfigForEngine(config, "codex", [{
    id: "gpt-dynamic",
    displayName: "GPT Dynamic",
    description: "",
    inputModalities: ["text"],
    supportedReasoningEfforts: [{ reasoningEffort: "ultra", description: "最高" }],
    defaultReasoningEffort: "ultra",
    contextWindow: 320_000,
    supportsFastMode: false,
    supports1MContext: false,
    isDefault: true,
    providerId: "openai",
    providerLabel: "OpenAI",
  }]);
  assert.equal(dynamic.model, "gpt-dynamic");
  assert.equal(dynamic.effort, "ultra");

  const unavailable = resolveCatalogRoleExecutionConfigForEngine(config, "codex", []);
  assert.equal(unavailable.model, "");
  assert.equal(unavailable.effort, "");
});

test("角色自定义配置缺少模型时不补入 Shared 静态默认", () => {
  const config = createDefaultRoleExecutionConfig("codex");
  config.engineProfiles.codex.mode = "custom";
  config.engineProfiles.codex.customConfig = {
    model: "",
    effort: "",
    accessMode: "current",
    autoCompactPct: 90,
    contextWindow: null,
    maxRetries: 0,
  };
  const resolved = resolveCatalogRoleExecutionConfigForEngine(config, "codex", []);
  assert.equal(resolved.model, "");
  assert.equal(resolved.effort, "");
});

test("目录推送后迟到的旧状态响应不能回退模型和同步状态", async (t) => {
  setActivePinia(createPinia());
  const store = useEngineStore();
  const response = deferred<Response>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => await response.promise;
  t.after(() => { globalThis.fetch = originalFetch; });

  const refresh = store.refresh(requestContext(), "workspace-a");
  store.applyCatalog(snapshot(3, "gpt-newer"));
  response.resolve(jsonResponse(engineStatusResponse(2, "gpt-older", "old-client", 2, "applied")));
  await refresh;

  const scoped = store.byWorkspaceId["workspace-a"]!;
  assert.equal(scoped.catalogVersion, 3);
  assert.equal(scoped.hostAppliedCatalogVersion, 2);
  assert.equal(scoped.hostCatalogSyncState, "waiting");
  assert.equal(scoped.engines.find((item) => item.engineType === "codex")?.models?.[0]?.id, "gpt-newer");
});

test("同工作区较早发起的状态请求不能覆盖较新的响应", async (t) => {
  setActivePinia(createPinia());
  const store = useEngineStore();
  store.applyCatalog(snapshot(3, "gpt-newer"));
  const first = deferred<Response>();
  const second = deferred<Response>();
  const queue = [first, second];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => await queue.shift()!.promise;
  t.after(() => { globalThis.fetch = originalFetch; });

  const olderRequest = store.refresh(requestContext(), "workspace-a");
  const newerRequest = store.refresh(requestContext(), "workspace-a");
  second.resolve(jsonResponse(engineStatusResponse(3, "gpt-newer", "new-client", 3, "applied")));
  await newerRequest;
  first.resolve(jsonResponse(engineStatusResponse(3, "gpt-newer", "old-client", 3, "applied")));
  await olderRequest;

  assert.equal(
    store.byWorkspaceId["workspace-a"]?.engines.find((item) => item.engineType === "codex")?.version,
    "new-client",
  );
});

test("全局目录刷新时保留当前 Client 的自定义模型", async (t) => {
  setActivePinia(createPinia());
  const store = useEngineStore();
  store.applyCatalog(snapshot(2, "gpt-global"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    ...engineStatusResponse(2, "gpt-global", "client", 2, "applied"),
    customModelsByEngine: {
      codex: [{ id: "vendor/custom", displayName: "自定义模型", isDefault: false }],
    },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  await store.refresh(requestContext(), "workspace-a");
  assert.equal(
    store.byWorkspaceId["workspace-a"]?.engines.find((item) => item.engineType === "codex")?.models.some((model) => model.id === "vendor/custom"),
    true,
  );

  store.applyCatalog(snapshot(3, "gpt-newer"));
  const codexModels = store.engines.find((item) => item.engineType === "codex")?.models ?? [];
  assert.equal(
    codexModels.some((model) => model.id === "vendor/custom"),
    true,
  );
  assert.equal(codexModels.some((model) => model.id === "gpt-global"), false);
});

test("不同工作区的自定义模型覆盖层互不串用", async (t) => {
  setActivePinia(createPinia());
  const store = useEngineStore();
  store.applyCatalog(snapshot(2, "gpt-global"));
  const responses = ["workspace-a/custom", "workspace-b/custom"];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    ...engineStatusResponse(2, "gpt-global", "client", 2, "applied"),
    customModelsByEngine: {
      codex: [{ id: responses.shift()!, displayName: "自定义模型", isDefault: false }],
    },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  await store.refresh(requestContext(), "workspace-a");
  await store.refresh(requestContext(), "workspace-b");
  store.applyCatalog(snapshot(3, "gpt-newer"));

  const workspaceAModels = store.byWorkspaceId["workspace-a"]?.engines.find((item) => item.engineType === "codex")?.models ?? [];
  const workspaceBModels = store.byWorkspaceId["workspace-b"]?.engines.find((item) => item.engineType === "codex")?.models ?? [];
  assert.equal(workspaceAModels.some((model) => model.id === "workspace-a/custom"), true);
  assert.equal(workspaceAModels.some((model) => model.id === "workspace-b/custom"), false);
  assert.equal(workspaceBModels.some((model) => model.id === "workspace-b/custom"), true);
  assert.equal(workspaceBModels.some((model) => model.id === "workspace-a/custom"), false);
});

test("等待目录 ACK 时状态刷新失败保留门禁，后续成功刷新可自动解除", async (t) => {
  setActivePinia(createPinia());
  const store = useEngineStore();
  store.applyCatalog(snapshot(3, "gpt-newer"));
  const originalFetch = globalThis.fetch;
  const responses = [
    jsonResponse(engineStatusResponse(3, "gpt-newer", "client", 2, "waiting")),
    new Response(JSON.stringify({ ok: false, message: "状态暂不可用" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
    jsonResponse(engineStatusResponse(3, "gpt-newer", "client", 3, "applied")),
  ];
  globalThis.fetch = async () => responses.shift()!;
  t.after(() => { globalThis.fetch = originalFetch; });

  await store.refresh(requestContext(), "workspace-a");
  assert.equal(store.byWorkspaceId["workspace-a"]?.hostCatalogSyncState, "waiting");
  await assert.rejects(store.refresh(requestContext(), "workspace-a"), /状态暂不可用/);
  assert.equal(store.byWorkspaceId["workspace-a"]?.hostCatalogSyncState, "waiting");
  assert.ok(store.byWorkspaceId["workspace-a"]?.lastError);
  await store.refresh(requestContext(), "workspace-a");
  assert.equal(store.byWorkspaceId["workspace-a"]?.hostCatalogSyncState, "applied");
  assert.equal(store.byWorkspaceId["workspace-a"]?.lastError, null);
});

test("本机模型目录不被已有或后续 Server 目录覆盖", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }),
    request: async () => ({ status: 200, body: engineStatusResponse(0, "gpt-local", "local", 0, "applied") }),
  } } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("本机模型不得请求 Server"); });
  setActivePinia(createPinia());
  const store = useEngineStore();
  store.applyCatalog(snapshot(5, "gpt-server"));
  await store.refresh({ ...requestContext(), desktopClientId: "local-client" }, "local-client:ws");
  assert.equal(store.byType.get("codex")?.models?.[0]?.id, "gpt-local");
  store.applyCatalog(snapshot(6, "gpt-server-new"));
  assert.equal(store.byType.get("codex")?.models?.[0]?.id, "gpt-local");
  assert.equal(store.byTypeForWorkspace("local-client:ws").get("codex")?.models?.[0]?.id, "gpt-local");
});

function requestContext() {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "test-session",
    webSessionId: "web-test",
  };
}

function snapshot(configVersion: number, codexModelId: string): EngineModelCatalogSnapshot {
  return {
    schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
    configVersion,
    capturedAt: 1,
    rows: [
      row("claude", "claude-runtime", "anthropic"),
      row("codex", codexModelId, "openai"),
    ],
  };
}

function row(
  engine: "claude" | "codex",
  modelId: string,
  providerId: "anthropic" | "openai",
): EngineModelCatalogItem {
  return {
    catalogItemId: `${engine}-${modelId}`,
    engine,
    providerId,
    providerLabel: providerId === "anthropic" ? "Anthropic Claude" : "OpenAI",
    modelId,
    displayName: modelId,
    description: "",
    inputModalities: ["text"],
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "深度思考" }],
    defaultReasoningEffort: "high",
    contextWindow: 200_000,
    maxContextWindow: null,
    supportsFastMode: false,
    supports1MContext: false,
    isDefault: true,
    sortOrder: 1,
    runtimeProfileId: "native",
    transportModelId: null,
    fastTaskModelId: null,
    subagentModelId: null,
  };
}

function engineStatusResponse(
  catalogVersion: number,
  codexModelId: string,
  version: string,
  hostAppliedCatalogVersion: number,
  hostCatalogSyncState: "applied" | "waiting",
) {
  return {
    ok: true,
    catalogVersion,
    hostAppliedCatalogVersion,
    hostCatalogSyncState,
    engines: [
      {
        engineType: "claude",
        installed: true,
        version,
        binPath: "claude",
        features: {},
        models: [{ id: "claude-runtime", displayName: "claude-runtime", isDefault: true }],
        error: null,
      },
      {
        engineType: "codex",
        installed: true,
        version,
        binPath: "codex",
        features: {},
        models: [{ id: codexModelId, displayName: codexModelId, isDefault: true }],
        error: null,
      },
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
