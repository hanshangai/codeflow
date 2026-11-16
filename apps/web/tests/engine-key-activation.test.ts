import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import ts from "typescript";

import { CODEX_KEY_SWITCH_CONFLICT_REASONS } from "@codeflowai/shared";
import type { EngineKeyEntry } from "@codeflowai/shared";

import { activateEngineKey, deactivateEngineKey, deleteEngineKey, upsertEngineKey } from "../src/api/engineKeys.ts";
import { createCancelledRequestError, isCancelledRequestError, type ApiRequestContext } from "../src/api/request.ts";
import { useApiContext } from "../src/composables/useApiContext.ts";
import { useConfigStore } from "../src/store/config.ts";
import { useEngineKeysStore } from "../src/store/engineKeys.ts";
import { CODEX_RELAY_TARGET, useBuiltInRelayKey } from "../src/features/settings/composables/useBuiltInRelayKey.ts";

const originalFetch = globalThis.fetch;
const panelSource = readFileSync(
  new URL("../src/features/settings/components/engine-keys-panel.vue", import.meta.url),
  "utf8",
);

/** 创建固定登录态请求上下文，供 Engine Key API body 契约测试复用。 */
function createApiContext(): ApiRequestContext {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "session-engine-key-test",
    webSessionId: "web-engine-key-test",
    ensureSession: async () => "session-engine-key-test",
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("engine key API preserves conflict details and sends stop flag only after confirmation", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({
        ok: false,
        code: "CONFLICT",
        message: "当前 Client 有 2 个 Codex 回合运行中",
        details: {
          reason: CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired,
          runningCount: 2,
        },
      }), { status: 409, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const ctx = createApiContext();
  const first = await activateEngineKey(ctx, { id: "key-target" }, "workspace-target");
  assert.equal(first.ok, false);
  if (first.ok) assert.fail("first activation must return a conflict");
  assert.equal(first.code, "CONFLICT");
  assert.deepEqual(first.details, {
    reason: CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired,
    runningCount: 2,
  });

  const confirmed = await activateEngineKey(
    ctx,
    { id: "key-target", stopRunningTurns: true },
    "workspace-target",
  );
  assert.equal(confirmed.ok, true);
  assert.deepEqual(bodies, [
    { id: "key-target" },
    { id: "key-target", stopRunningTurns: true },
  ]);
});

test("engine key upsert forwards the confirmed running-turn stop flag", async () => {
  let body: unknown = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const result = await upsertEngineKey(createApiContext(), {
    id: "key-target",
    label: "Codex",
    engine: "codex",
    providerId: "openai",
    apiKey: "masked-key",
    baseUrl: null,
    stopRunningTurns: true,
  }, "workspace-target");

  assert.equal(result.ok, true);
  assert.deepEqual(body, {
    id: "key-target",
    label: "Codex",
    engine: "codex",
    providerId: "openai",
    apiKey: "masked-key",
    baseUrl: null,
    stopRunningTurns: true,
  });
});

test("engine key panel confirms only the registered running-turn reason", () => {
  assert.match(panelSource, /record\.code !== "CONFLICT"/u);
  assert.match(
    panelSource,
    /details\.reason !== CODEX_KEY_SWITCH_CONFLICT_REASONS\.runningTurnsConfirmRequired/u,
  );
  assert.match(panelSource, /Modal\.confirm\(/u);
  assert.match(panelSource, /\{ id, stopRunningTurns: true \}/u);
  assert.match(panelSource, /\{ \.\.\.payload, stopRunningTurns: true \}/u);
  assert.doesNotMatch(panelSource, /controlledExperimentRunning[^\n]*Modal\.confirm/u);
  assert.doesNotMatch(panelSource, /runningTurnsStopFailed[^\n]*Modal\.confirm/u);
});

test("browser built-in relay keeps the Server raw-key path and structured confirmed-stop activation", async () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.serverWsOrigin = "wss://cloud.example";
  config.workspaceId = "remote:ws";
  config.authMode = "account";
  config.accountRole = "personal_normal";
  config.userSummary = { userId: "A" } as any;
  config.sessionToken = "session-A";
  config.sessionExpiresAt = Date.now() + 60_000;
  const key = { id: "relay", label: "CodeFlow 内置中转（Codex）", engine: "codex", providerId: "openai", apiKey: "raw-relay", baseUrl: "https://relay.example", isActive: false, createdAt: 1, updatedAt: 1 };
  const calls: { path: string; body: any; token: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path, body, token: new Headers(init?.headers).get("Authorization") ?? "" });
    let result: object;
    if (path.endsWith("/ensure")) result = { ok: true, status: { state: "enabled", publicBaseUrl: "https://relay.example" }, key: { rawKey: "raw-relay" } };
    else if (path === "/api/engine-keys" && init?.method === "GET") result = { ok: true, keys: [key] };
    else if (path === "/api/engine-keys") result = { ok: true, key };
    else if (path === "/api/engine-keys/activate") result = body.stopRunningTurns ? { ok: true } : { ok: false, code: "CONFLICT", message: "running turns", details: { reason: CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired, runningCount: 2 } };
    else throw new Error(`unexpected request: ${path}`);
    return new Response(JSON.stringify(result), { status: "ok" in result && !result.ok ? 409 : 200 });
  }) as typeof fetch;
  const relay = useBuiltInRelayKey();
  await assert.rejects(relay.syncBuiltInRelayKey(CODEX_RELAY_TARGET, "remote:ws"), (error: any) => error.code === "CONFLICT" && error.details.runningCount === 2);
  await relay.syncBuiltInRelayKey(CODEX_RELAY_TARGET, "remote:ws", undefined, { stopRunningTurns: true });
  assert.deepEqual(calls.filter((call) => call.path.endsWith("/activate")).map((call) => call.body), [{ id: "relay" }, { id: "relay", stopRunningTurns: true }]);
  assert.equal(calls.find((call) => call.path === "/api/engine-keys" && call.body)?.body.apiKey, "raw-relay");
  assert.ok(calls.every((call) => call.token === "Bearer session-A"));
});

type MutationAction = "doActivate" | "doSubmit" | "doDeactivate" | "doDelete";

/** 执行实际面板变更入口与真实 API/store，仅控制 preload 响应和确认时点。 */
function setupPanelMutation(t: test.TestContext, action: MutationAction, conflict: boolean, failure = false, remoteUnauthorized = false, key?: EngineKeyEntry) {
  let finishRequest!: (value: unknown) => void;
  let failRequest!: (reason: unknown) => void;
  let finishConfirmation!: (confirmed: boolean) => void;
  const initial = new Promise((resolve, reject) => { finishRequest = resolve; failRequest = reject; });
  const confirmation = new Promise<boolean>(resolve => { finishConfirmation = resolve; });
  const requests: any[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }),
    request: async (request: any) => {
      requests.push(request);
      if (requests.length === 1) return initial;
      return { status: 200, body: request.method === "engineKeys.list" ? { ok: true, keys: [] } : { ok: true } };
    },
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
      requests.push({ authorization: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body)) });
      return initial as Promise<Response>;
    });
  }
  const engineKeys = useEngineKeysStore();
  const { ctx } = useApiContext();
  const errors: string[] = [];
  const successes: string[] = [];
  const warnings: string[] = [];
  const source = readFileSync(new URL("../src/features/settings/components/engine-keys-panel.vue", import.meta.url), "utf8");
  /** 保留真实函数体，提取边界缺失时显式失败。 */
  const extract = (signature: string, endMarker = "\n/** ") => {
    const start = source.indexOf(signature);
    const end = source.indexOf(endMarker, start);
    assert.ok(start > 0 && end > start, signature);
    return source.slice(start, end);
  };
  const snippets = [extract("function captureRelayScope()", "\nconst LEGACY_"), extract("function readRunningCodexTurnConflict("),
    extract("async function refresh(workspaceId:"), extract(`async function ${action}(`, action === "doDelete" ? "\nonMounted(" : "\n/** ")];
  const compiled = ts.transpileModule(`${snippets.join("\n")}\nreturn ${action};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const deps = {
    config, ctx, engineKeys, props: { active: true }, effectiveWorkspaceId: { get value() { return config.workspaceId; } },
    canUseEngineKeyRoute: { value: true }, disabledReason: { value: "" }, keys: { value: key ? [key] : [] },
    getKeyRelayTarget: () => null, syncBuiltInRelay: async () => { throw new Error("UNEXPECTED_BUILTIN"); },
    switchingId: { value: null }, deactivatingId: { value: null }, deletingId: { value: null }, submitting: { value: false },
    editingId: { value: null }, formLabel: { value: "Self configured" }, formApiKey: { value: "test-user-key" },
    formBaseUrl: { value: "https://api.example/v1" }, formEngine: { value: "codex" }, formProviderId: { value: "openai" },
    requiresClaudeCompatibleBaseUrl: () => false, getProviderDisplayLabel: () => "Codex", closeModal: () => {},
    activateEngineKey, deactivateEngineKey, deleteEngineKey, upsertEngineKey, CODEX_KEY_SWITCH_CONFLICT_REASONS,
    confirmRunningCodexTurnStop: async () => confirmation,
    message: { info: () => {}, warning: (value: string) => warnings.push(value), error: (value: string) => errors.push(value), success: (value: string) => successes.push(value) },
    trackProductEvent: () => {}, createCancelledRequestError, isCancelledRequestError,
  };
  const execute = new Function(...Object.keys(deps), compiled)(...Object.values(deps)) as (id: string) => Promise<void>;
  const run = execute("self-configured-key");
  if (failure) failRequest(new Error("current mutation failed"));
  else if (!remoteUnauthorized) finishRequest({ status: conflict ? 409 : 200, body: conflict
      ? { ok: false, code: "CONFLICT", message: "running", details: { reason: CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired, runningCount: 1 } }
      : { ok: true } });
  return { config, requests, run, errors, successes, warnings, finishConfirmation, finishRequest };
}

for (const apiKey of ["", " \t\n"]) {
  test(`actual activation refuses a retained empty self-configured key ${JSON.stringify(apiKey)}`, async t => {
    const key: EngineKeyEntry = { id: "self-configured-key", source: "user_configured", label: "Retained key", engine: "codex", providerId: "openai",
      apiKey, baseUrl: "https://api.example/v1", isActive: false, createdAt: 1, updatedAt: 2 };
    const fixture = setupPanelMutation(t, "doActivate", false, false, false, key);
    await fixture.run;
    assert.deepEqual(fixture.requests, []);
    assert.deepEqual(fixture.successes, []);
    assert.equal(fixture.warnings.length, 1);
    assert.match(fixture.warnings[0]!, /重新录入/u);
    assert.equal(key.apiKey, apiKey);
  });
}

for (const action of ["doActivate", "doSubmit"] as const) {
  test(`actual ${action} cancels A's pending confirmation when B takes ownership`, async t => {
    const fixture = setupPanelMutation(t, action, true);
    await new Promise(resolve => setImmediate(resolve));
    fixture.config.sessionToken = "session-B";
    fixture.config.userSummary = { userId: "B" } as any;
    fixture.config.desktopCloudAccount = { generation: 5 } as any;
    fixture.finishConfirmation(true);
    await fixture.run;
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.successes, []);
    assert.deepEqual(fixture.errors, []);
  });

  test(`actual ${action} retries a confirmed stop for the unchanged owner`, async t => {
    const fixture = setupPanelMutation(t, action, true);
    await new Promise(resolve => setImmediate(resolve));
    fixture.finishConfirmation(true);
    await fixture.run;
    assert.equal(fixture.requests[1].body.stopRunningTurns, true);
    assert.equal(fixture.requests[2].method, "engineKeys.list");
    assert.equal(fixture.successes.length, 1);
    assert.deepEqual(fixture.errors, []);
  });
}

for (const action of ["doActivate", "doSubmit", "doDeactivate", "doDelete"] as const) {
  test(`actual ${action} does not publish or refresh A's late success into B`, async t => {
    const fixture = setupPanelMutation(t, action, false);
    fixture.config.sessionToken = "session-B";
    fixture.config.userSummary = { userId: "B" } as any;
    fixture.config.desktopCloudAccount = { generation: 5 } as any;
    await fixture.run;
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.successes, []);
    assert.deepEqual(fixture.errors, []);
  });

  test(`actual ${action} keeps the current owner's transport failure visible`, async t => {
    const fixture = setupPanelMutation(t, action, false, true);
    await fixture.run;
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.successes, []);
    assert.deepEqual(fixture.errors, ["current mutation failed"]);
  });

  test(`actual ${action} cannot clear B's session after A's delayed remote 401`, async t => {
    const fixture = setupPanelMutation(t, action, false, false, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fixture.requests.map(request => request.authorization), ["Bearer session-A"]);
    fixture.config.sessionToken = "session-B";
    fixture.config.userSummary = { userId: "B" } as any;
    fixture.config.desktopCloudAccount = { generation: 5 } as any;
    fixture.finishRequest(new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "A expired" }), { status: 401 }));
    await fixture.run;
    assert.equal(fixture.config.sessionToken, "session-B");
    assert.deepEqual(fixture.requests.map(request => request.authorization), ["Bearer session-A"]);
    assert.deepEqual(fixture.successes, []);
    assert.deepEqual(fixture.errors, []);
  });
}
