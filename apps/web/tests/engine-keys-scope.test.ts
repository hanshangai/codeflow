import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import ts from "typescript";
import type { EngineKeyEntry } from "@codeflowai/shared";

import { createCancelledRequestError, isCancelledRequestError, type ApiRequestContext } from "../src/api/request.ts";
import { useApiContext } from "../src/composables/useApiContext.ts";
import { useConfigStore } from "../src/store/config.ts";
import {
  refreshEngineKeysScope,
  useEngineKeysStore,
  type EngineKeysListLoader,
  type EngineKeysState,
} from "../src/store/engineKeys.ts";

const ctx: ApiRequestContext = {
  serverWsOrigin: "ws://example.test",
  sessionToken: null,
  webSessionId: null,
};

function createState(): EngineKeysState {
  return {
    keys: [],
    loading: false,
    lastError: null,
    lastUpdatedAt: null,
    activeWorkspaceId: null,
    latestRequestId: 0,
    scopeByWorkspaceId: {},
  };
}

function makeKey(id: string, active = true): EngineKeyEntry {
  return {
    id,
    label: id,
    engine: "codex",
    providerId: "openai",
    apiKey: "masked",
    baseUrl: null,
    isActive: active,
    createdAt: 1,
    updatedAt: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("workspace switch uses last-request-wins and ignores the old response and finally path", async () => {
  const state = createState();
  const requests = new Map<string, ReturnType<typeof deferred<any>>>();
  const loader: EngineKeysListLoader = (async (_ctx, workspaceId) => {
    const request = deferred<any>();
    requests.set(String(workspaceId), request);
    return request.promise;
  }) as EngineKeysListLoader;

  const requestA = refreshEngineKeysScope(state, ctx, "shared:alpha", loader);
  assert.equal(state.scopeByWorkspaceId["shared:alpha"]?.phase, "loading");
  const requestB = refreshEngineKeysScope(state, ctx, "client-b:repo", loader);
  assert.equal(state.activeWorkspaceId, "client-b:repo");
  assert.equal(state.scopeByWorkspaceId["shared:alpha"]?.phase, "unknown");
  assert.equal(state.keys.length, 0);

  requests.get("client-b:repo")?.resolve({ ok: true, keys: [makeKey("key-b")] });
  await requestB;
  assert.equal(state.scopeByWorkspaceId["client-b:repo"]?.phase, "success");
  assert.deepEqual(state.keys.map((key) => key.id), ["key-b"]);

  requests.get("shared:alpha")?.resolve({ ok: true, keys: [makeKey("key-a")] });
  await requestA;
  assert.equal(state.activeWorkspaceId, "client-b:repo");
  assert.deepEqual(state.keys.map((key) => key.id), ["key-b"]);
  assert.equal(state.scopeByWorkspaceId["shared:alpha"]?.phase, "unknown");
});

test("new workspace failure does not expose the previous workspace keys", async () => {
  const state = createState();
  const successLoader = (async () => ({ ok: true, keys: [makeKey("key-a")] })) as EngineKeysListLoader;
  await refreshEngineKeysScope(state, ctx, "client-a:repo", successLoader);
  assert.equal(state.scopeByWorkspaceId["client-a:repo"]?.phase, "success");

  const failedLoader = (async () => {
    throw new Error("workspace B unavailable");
  }) as EngineKeysListLoader;
  await assert.rejects(() => refreshEngineKeysScope(state, ctx, "client-b:repo", failedLoader), /workspace B unavailable/u);

  assert.equal(state.activeWorkspaceId, "client-b:repo");
  assert.equal(state.loading, false);
  assert.equal(state.lastError, "workspace B unavailable");
  assert.deepEqual(state.keys, []);
  assert.equal(state.scopeByWorkspaceId["client-a:repo"]?.phase, "success");
  assert.equal(state.scopeByWorkspaceId["client-b:repo"]?.phase, "error");
});

test("inactive keys in a successful current scope remain pending instead of ready", async () => {
  const state = createState();
  const loader = (async () => ({ ok: true, keys: [makeKey("key-disabled", false)] })) as EngineKeysListLoader;
  await refreshEngineKeysScope(state, ctx, "client-c:repo", loader);
  const snapshot = state.scopeByWorkspaceId["client-c:repo"];
  assert.equal(snapshot?.phase, "success");
  assert.equal(snapshot?.keys.some((key) => key.isActive), false);
});

test("same local workspace cannot commit the previous account's delayed keys or errors", async () => {
  for (const failure of [false, true]) {
    const state = createState();
    const pending = deferred<any>();
    let owner = "A";
    const run = refreshEngineKeysScope(state, ctx, "local:repo", (async () => pending.promise) as EngineKeysListLoader, () => owner === "A");
    owner = "B";
    if (failure) pending.reject(new Error("A failed"));
    else pending.resolve({ ok: true, keys: [makeKey("A-secret")] });
    await assert.rejects(run, failure ? /A failed/ : isCancelledRequestError);
    assert.equal(state.keys.some((key) => key.id === "A-secret"), false);
    assert.notEqual(state.lastError, "A failed");
    assert.notEqual(state.scopeByWorkspaceId["local:repo"]?.phase, "success");
  }
});

/** 运行实际面板刷新函数与真实 store，只替换 preload 传输。 */
function setupPanelRefresh(t: test.TestContext, remoteUnauthorized = false) {
  const pending = deferred<any>();
  const authorizations: (string | null)[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    request: async () => pending.promise, getState: async () => ({ status: "ready" }),
  } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "window", descriptor) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.serverWsOrigin = "wss://cloud.example";
  config.workspaceId = "local:ws";
  config.authMode = "account";
  config.accountRole = "personal_normal";
  config.sessionToken = "session-A";
  config.sessionExpiresAt = Date.now() + 60_000;
  config.userSummary = { userId: "A" } as any;
  config.desktopClient = { clientId: "local", version: "1", connectedAt: 1, workspaceIds: ["local:ws"] };
  config.desktopCloudAccount = { generation: 4 } as any;
  if (remoteUnauthorized) {
    config.workspaceId = "remote:ws";
    t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("Authorization"));
      return pending.promise as Promise<Response>;
    });
  }
  const engineKeys = useEngineKeysStore();
  const { ctx } = useApiContext();
  const source = readFileSync(new URL("../src/features/settings/components/engine-keys-panel.vue", import.meta.url), "utf8");
  const scopeStart = source.indexOf("function captureRelayScope()");
  const scopeEnd = source.indexOf("\nconst LEGACY_", scopeStart);
  const refreshStart = source.indexOf("async function refresh(workspaceId:");
  const refreshEnd = source.indexOf("\n/** ", refreshStart);
  assert.ok(scopeStart > 0 && scopeEnd > scopeStart && refreshStart > 0 && refreshEnd > refreshStart);
  const compiled = ts.transpileModule(`${source.slice(scopeStart, scopeEnd)}\n${source.slice(refreshStart, refreshEnd)}\nreturn refresh;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const errors: string[] = [];
  const refresh = new Function("props", "effectiveWorkspaceId", "canUseEngineKeyRoute", "config", "engineKeys", "ctx", "message", "createCancelledRequestError", "isCancelledRequestError", compiled)(
    { active: true }, { get value() { return config.workspaceId; } }, { value: true }, config, engineKeys, ctx,
    { error: (value: string) => errors.push(value) }, createCancelledRequestError, isCancelledRequestError,
  ) as () => Promise<void>;
  return { config, engineKeys, pending, errors, refresh, authorizations };
}

for (const failure of [false, true]) {
  test(`actual Key panel ignores account A's late ${failure ? "failure" : "keys"} after B takes ownership`, async t => {
    const fixture = setupPanelRefresh(t);
    const run = fixture.refresh();
    fixture.config.sessionToken = "session-B";
    fixture.config.userSummary = { userId: "B" } as any;
    fixture.config.desktopCloudAccount = { generation: 5 } as any;
    if (failure) fixture.pending.reject(new Error("A list failed"));
    else fixture.pending.resolve({ status: 200, body: { ok: true, keys: [makeKey("A-key")] } });
    await run;
    assert.equal(fixture.config.userSummary?.userId, "B");
    assert.equal(fixture.config.sessionToken, "session-B");
    assert.deepEqual(fixture.engineKeys.keys, []);
    assert.equal(fixture.engineKeys.scopeSnapshotForWorkspace("local:ws").phase, "unknown");
    assert.equal(fixture.engineKeys.lastError, null);
    assert.deepEqual(fixture.errors, []);
  });
}

test("actual Key panel keeps the current owner's list failure visible", async t => {
  const fixture = setupPanelRefresh(t);
  const run = fixture.refresh();
  fixture.pending.reject(new Error("current list failed"));
  await run;
  assert.equal(fixture.engineKeys.scopeSnapshotForWorkspace("local:ws").phase, "error");
  assert.equal(fixture.engineKeys.lastError, "current list failed");
  assert.deepEqual(fixture.errors, ["current list failed"]);
});

test("actual Key panel cannot clear B's session after A's delayed remote list 401", async t => {
  const fixture = setupPanelRefresh(t, true);
  const run = fixture.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.authorizations, ["Bearer session-A"]);
  fixture.config.sessionToken = "session-B";
  fixture.config.userSummary = { userId: "B" } as any;
  fixture.config.desktopCloudAccount = { generation: 5 } as any;
  fixture.pending.resolve(new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "A expired" }), { status: 401 }));
  await run;
  assert.equal(fixture.config.sessionToken, "session-B");
  assert.equal(fixture.engineKeys.scopeSnapshotForWorkspace("remote:ws").phase, "unknown");
  assert.deepEqual(fixture.errors, []);
});

test("同工作区刷新保留缓存 Key，不回到首次加载空态", async () => {
  const state = createState();
  state.activeWorkspaceId = "cached:ws";
  state.keys = [makeKey("cached")];
  state.scopeByWorkspaceId["cached:ws"] = {
    workspaceId: "cached:ws",
    phase: "success",
    keys: [makeKey("cached")],
    lastError: null,
    lastUpdatedAt: 1,
    requestId: 1,
  };
  const request = deferred<any>();
  const loader = (async () => request.promise) as EngineKeysListLoader;

  const run = refreshEngineKeysScope(state, ctx, "cached:ws", loader);

  assert.equal(state.scopeByWorkspaceId["cached:ws"]?.phase, "loading");
  assert.deepEqual(state.keys.map((key) => key.id), ["cached"], "刷新期间必须保留上次 Key 列表");
  request.resolve({ ok: true, keys: [makeKey("fresh")] });
  await run;
  assert.deepEqual(state.keys.map((key) => key.id), ["fresh"]);
});
