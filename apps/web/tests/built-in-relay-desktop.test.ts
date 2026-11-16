import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useConfigStore } from "../src/store/config.ts";
import { CODEX_RELAY_TARGET, useBuiltInRelayKey } from "../src/features/settings/composables/useBuiltInRelayKey.ts";
import { isCancelledRequestError } from "../src/api/request.ts";

const key = { id: "relay", label: "Client generated", engine: "codex", providerId: "openai", apiKey: "", baseUrl: "https://relay.example", isActive: true, createdAt: 1, updatedAt: 1, source: "builtin", serverOrigin: "https://cloud.example", ownerUserId: "A" };

/** 使用真实 composable 与 store，只替换受限 preload 传输。 */
function setup(t: test.TestContext, request: (input: any) => Promise<any>) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: { request, getState: async () => ({ status: "ready" }) } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "window", descriptor) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.serverWsOrigin = "wss://cloud.example";
  config.workspaceId = "local:ws";
  config.authMode = "account";
  config.userSummary = { userId: "A" } as any;
  config.sessionToken = "session-A";
  config.sessionExpiresAt = Date.now() + 60_000;
  config.desktopRuntime = { status: "ready", requestId: "runtime", releaseId: null, errorCode: null };
  config.desktopClient = { clientId: "local", version: "1", connectedAt: 1, workspaceIds: ["local:ws"] };
  config.desktopCloudAccount = { status: "linked", generation: 4, serverOrigin: "https://cloud.example", userSummary: { userId: "A" } as any, errorCode: null };
  return { config, relay: useBuiltInRelayKey() };
}

test("desktop manual auto and reset use Client ensure without requesting a raw key or ordinary upsert", async (t) => {
  const requests: any[] = [];
  const { relay } = setup(t, async (request) => { requests.push(request); return { status: 200, body: request.method === "engineKeys.list" ? { ok: true, keys: [key] } : { ok: true, key, accountGeneration: 4 } }; });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("desktop ensure must not request Server rawKey"); });
  for (const intent of ["manual", "auto", "reset"] as const) {
    assert.equal((await relay.syncBuiltInRelayKey(CODEX_RELAY_TARGET, "local:ws", undefined, { intent }))?.id, "relay");
  }
  assert.deepEqual(requests.filter((request) => request.method !== "engineKeys.list"), ["manual", "auto", "reset"].map((intent) => ({ method: "engineKeys.builtInRelay.ensure", body: { workspaceId: "local:ws", engine: "codex", providerId: "openai", intent } })));
});

test("desktop relay cannot be claimed by a label or a different trusted owner", (t) => {
  const { relay } = setup(t, async () => ({}));
  assert.equal(relay.isBuiltInRelayKey({ ...key, source: undefined, label: "CodeFlow 内置中转（Codex）" } as any, CODEX_RELAY_TARGET), false);
  assert.equal(relay.isBuiltInRelayKey({ ...key, ownerUserId: "B" } as any, CODEX_RELAY_TARGET), false);
  assert.equal(relay.isBuiltInRelayKey(key as any, CODEX_RELAY_TARGET), true);
});

test("late desktop ensure from A is cancelled before B key list or notice can be updated", async (t) => {
  let finish!: (value: any) => void;
  let lists = 0;
  const { config, relay } = setup(t, async (request) => {
    if (request.method === "engineKeys.list") { lists++; return { status: 200, body: { ok: true, keys: [key] } }; }
    return new Promise((resolve) => { finish = resolve; });
  });
  const pending = relay.syncBuiltInRelayKey(CODEX_RELAY_TARGET, "local:ws");
  await new Promise((resolve) => setImmediate(resolve));
  config.sessionToken = "session-B";
  config.userSummary = { userId: "B" } as any;
  finish({ status: 200, body: { ok: true, key, accountGeneration: 4 } });
  await assert.rejects(pending, isCancelledRequestError);
  assert.equal(lists, 0);
});

test("desktop local ready and Web connected do not authorize relay before Client hello", async (t) => {
  let requests = 0;
  const { config, relay } = setup(t, async () => { requests++; return {}; });
  config.connected = true;
  config.desktopCloudAccount!.status = "linking";
  await assert.rejects(relay.syncBuiltInRelayKey(CODEX_RELAY_TARGET, "local:ws"), /DESKTOP_CLOUD_ACCOUNT_REQUIRED/);
  assert.equal(requests, 0);
});
