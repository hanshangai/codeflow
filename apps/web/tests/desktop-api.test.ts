import test from "node:test";
import assert from "node:assert/strict";
import type { DesktopBridgeApi, DesktopApiRequest } from "@codeflowai/shared";
import { requestJson, isCancelledRequestError, createApiResultError } from "../src/api/request.ts";
import { listOrchRoles, listOrchWorkflows } from "../src/api/orchestration/index.ts";
import { getDesktopBridge, resolveDesktopApiRequest } from "../src/services/desktop.ts";
import { createPinia, setActivePinia } from "pinia";
import { useConfigStore } from "../src/store/config.ts";
import { usePresenceStore } from "../src/store/presence.ts";
import { useEngineKeysStore } from "../src/store/engineKeys.ts";
import { createWebSocketClient } from "../src/services/ws.ts";

test("API 错误转换给出描述并保留原失败与关联请求", () => {
  const result = { ok: false as const, code: "INTERNAL" as const, message: "DESKTOP_API_TIMEOUT", details: { requestId: "api:timeout" } };
  const error = createApiResultError(result);
  assert.match(error.message, /本机.*超时/);
  assert.doesNotMatch(error.message, /DESKTOP_|INTERNAL/);
  assert.equal(error.code, "INTERNAL");
  assert.equal(error.details, result.details);
  assert.equal(error.cause, result);
  assert.equal(createApiResultError({ ...result, message: "工作区已删除，请重新选择" }).message, "工作区已删除，请重新选择");
});

/** 每项测试隔离 preload 全局对象，不依赖浏览器或 Server。 */
function installBridge(t: test.TestContext, bridge: unknown): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { codeflowDesktop: bridge }, writable: true, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

test("desktop workspace requests bypass cloud login and never retry a failed local write remotely", async (t) => {
  const requests: DesktopApiRequest[] = [];
  const bridge: DesktopBridgeApi = {
    getState: async () => ({ status: "ready", requestId: "process", releaseId: null, errorCode: null }),
    openWindow: async () => {}, exit: async () => {}, onEvent: () => () => {},
    request: async (request) => { requests.push(request); return { status: 200, body: { ok: true, workspaces: [] } }; },
  };
  installBridge(t, bridge);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("local request must not reach Server"); });
  const ctx = { serverWsOrigin: "ws://server", sessionToken: null, webSessionId: null, desktopClientId: "local-data",
    ensureSession: async () => { throw new Error("local request must not require login"); } };
  assert.equal(getDesktopBridge(), bridge);
  assert.deepEqual(await requestJson(ctx, { method: "GET", path: "/api/workspaces?currentWorkspaceId=old" }), { ok: true, workspaces: [] });
  assert.deepEqual(requests, [{ method: "workspaces.list" }]);
  bridge.request = async () => { throw new Error("DESKTOP_API_TIMEOUT"); };
  await assert.rejects(requestJson(ctx, { method: "POST", path: "/api/workspaces/upsert", body: { title: "Local", path: "C:/project" } }), /DESKTOP_API_TIMEOUT/);
});

test("desktop routing leaves shared and other Client targets on the authenticated Server path", () => {
  assert.equal(resolveDesktopApiRequest({ method: "POST", path: "/api/workspaces/delete", body: { workspaceId: "shared:one" } }, "local-data"), null);
  assert.equal(resolveDesktopApiRequest({ method: "POST", path: "/api/workspaces/upsert", body: { clientId: "other", path: "C:/project" } }, "local-data"), null);
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/workspaces/other%3Aws/me/execution-profile" }, "local-data"), null);
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/account/me/summary" }, "local-data"), null);
  for (const unknownClient of [null, undefined]) {
    assert.equal(resolveDesktopApiRequest({ method: "POST", path: "/api/workspaces/upsert", body: { clientId: "other", path: "C:/project" } }, unknownClient), null);
    assert.equal(resolveDesktopApiRequest({ method: "POST", path: "/api/workspaces/delete", body: { workspaceId: "other:ws" } }, unknownClient), null);
    assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/workspaces/other%3Aws/me/execution-profile" }, unknownClient), null);
  }
  assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: "/api/workspaces/local-data%3Aws/me/execution-profile", body: { profileText: "local" } }, "local-data"),
    { method: "workspaceExecutionProfile.update", body: { workspaceId: "local-data:ws", profileText: "local" } });
});

test("desktop cancellation preserves scope semantics and malformed responses fail explicitly", async (t) => {
  let resolve!: (value: { status: number; body: unknown }) => void;
  const bridge = { getState: async () => ({}), request: () => new Promise<{ status: number; body: unknown }>((done) => { resolve = done; }) };
  installBridge(t, bridge);
  const ctx = { serverWsOrigin: "", sessionToken: null, webSessionId: null };
  const controller = new AbortController();
  const pending = requestJson(ctx, { method: "GET", path: "/api/workspaces", signal: controller.signal });
  controller.abort("workspace-switch");
  await assert.rejects(pending, (error) => isCancelledRequestError(error) && error.kind === "workspace-switch");
  resolve({ status: 200, body: { ok: true, workspaces: [] } });
  bridge.request = async () => ({ status: 200, body: "unexpected" });
  await assert.rejects(requestJson(ctx, { method: "GET", path: "/api/workspaces" }), /DESKTOP_API_RESPONSE_INVALID/);
});

test("desktop history paths preserve pagination and keep remote query targets on Server", () => {
  assert.deepEqual(resolveDesktopApiRequest({ method: "GET", path: "/api/threads?workspaceId=local-data%3Aws&scope=current&limit=20&cursor=next&onlyRelatedToMe=false" }, "local-data"),
    { method: "threads.list", body: { workspaceId: "local-data:ws", scope: "current", limit: 20, cursor: "next", onlyRelatedToMe: false } });
  assert.deepEqual(resolveDesktopApiRequest({ method: "GET", path: "/api/threads/groups?workspaceId=local-data%3Aws" }, "local-data"),
    { method: "threads.groups.list", body: { workspaceId: "local-data:ws" } });
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/threads?workspaceId=other%3Aws" }, "local-data"), null);
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/threads?workspaceId=shared%3Atopic" }, "local-data"), null);
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/threads?workspaceId=other%3Aws" }), null);
  for (const [path, method] of [["load", "threads.load"], ["events", "threads.events"], ["summary", "threads.summary"], ["prefs", "threads.prefs"], ["latest-prefs", "threads.latestPrefs"]]) {
    assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: `/api/threads/${path}`, body: { workspaceId: "local-data:ws", threadId: "thread" } }, "local-data"),
      { method, body: { workspaceId: "local-data:ws", threadId: "thread" } });
  }
});

test("local readiness is independent from cloud connection and targets only its actual workspace", async (t) => {
  const client = { clientId: "local-data", version: "1.0.0", connectedAt: 1, workspaceIds: ["local-data:ws"] };
  const bridge: DesktopBridgeApi = {
    getState: async () => ({ status: "ready", requestId: "process", releaseId: null, errorCode: null }),
    request: async () => ({ status: 200, body: { ok: true, client } }), openWindow: async () => {}, exit: async () => {}, onEvent: () => () => {},
  };
  installBridge(t, bridge);
  setActivePinia(createPinia());
  const config = useConfigStore();
  const presence = usePresenceStore();
  await config.refreshDesktopRuntime();
  assert.equal(config.localRuntimeReady, true);
  assert.equal(config.connected, false);
  assert.equal(config.canConnectServer, false);
  assert.equal(presence.runtimeStateForWorkspace("local-data:ws").status, "online");
  assert.notEqual(presence.runtimeStateForWorkspace("another:ws").status, "online");
  assert.equal(presence.online.onlineClients.length, 0, "local readiness does not fabricate account presence");
  bridge.getState = async () => ({ status: "failed", requestId: "process", releaseId: null, errorCode: "CLIENT_EXIT_1" });
  await config.refreshDesktopRuntime();
  assert.equal(config.localRuntimeReady, false);
  assert.notEqual(presence.runtimeStateForWorkspace("local-data:ws").status, "online");
  bridge.onEvent = undefined;
  await assert.rejects(config.refreshDesktopRuntime(), /DESKTOP_EVENT_BRIDGE_REQUIRED/);
  assert.equal(config.localRuntimeReady, false);
});

test("logging out of the cloud account keeps the local desktop workspace selection", (t) => {
  installBridge(t, { getState: async () => ({}), request: async () => ({}) });
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.workspaceId = "local-data:ws";
  config.authMode = "account";
  config.sessionToken = "test-session";
  config.logout();
  assert.equal(config.workspaceId, "local-data:ws");
  assert.equal(config.homePath, "/chat");
  assert.equal(config.authMode, null);
  assert.equal(config.sessionToken, null);
});

test("desktop asset requests keep local ownership and omit only Server revision metadata", () => {
  for (const [path, collection, field] of [["roles", "roles", "role"], ["workflows", "workflows", "workflow"],
    ["knowledge-bundles", "knowledgeBundles", "bundle"], ["toolsets", "toolsets", "toolset"], ["skills", "skills", "skill"]]) {
    assert.deepEqual(resolveDesktopApiRequest({ method: "GET", path: `/api/orch/${path}?workspaceId=local-data%3Aws` }, "local-data"),
      { method: `orch.${collection}.list`, body: { workspaceId: "local-data:ws" } });
    assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: `/api/orch/${path}/upsert`, body: { workspaceId: "local-data:ws", [field!]: { id: "asset" }, clientRequestId: "web-request", expectedRevision: 2 } }, "local-data"),
      { method: `orch.${collection}.upsert`, body: { workspaceId: "local-data:ws", [field!]: { id: "asset" } } });
    assert.equal(resolveDesktopApiRequest({ method: "GET", path: `/api/orch/${path}?workspaceId=shared%3Aone` }, "local-data"), null);
    assert.equal(resolveDesktopApiRequest({ method: "GET", path: `/api/orch/${path}?workspaceId=other%3Aws` }, "local-data"), null);
  }
  assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: "/api/orch/assets/copy", body: { workspaceId: "local-data:ws", assetType: "role", assetId: "role" } }, "local-data"),
    { method: "orch.assets.copy", body: { workspaceId: "local-data:ws", assetType: "role", assetId: "role" } });
  const forged = resolveDesktopApiRequest({ method: "POST", path: "/api/orch/roles/upsert", body: { workspaceId: "local-data:ws", role: {}, allowBuiltinAssetUpdate: true } }, "local-data");
  assert.equal(forged?.body?.allowBuiltinAssetUpdate, true, "untrusted permission fields still reach the rejecting boundary");
});

test("desktop execution lists consume their routing purpose before the fixed IPC boundary", async t => {
  const methods: string[] = [];
  installBridge(t, {
    getState: async () => ({}),
    /** Client 列表只接受 workspaceId，来源参数不得扩展本机 IPC 合同。 */
    request: async (request: DesktopApiRequest) => {
      assert.deepEqual(request.body, { workspaceId: "local-data:ws" });
      methods.push(request.method);
      return { status: 200, body: { ok: true, roles: [], workflows: [] } };
    },
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("local execution list must not reach Server"); });
  const ctx = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "local-data" };

  assert.equal((await listOrchRoles(ctx, "local-data:ws", "execution")).ok, true);
  assert.equal((await listOrchWorkflows(ctx, "local-data:ws", "execution")).ok, true);
  assert.deepEqual(methods, ["orch.roles.list", "orch.workflows.list"]);
  for (const collection of ["roles", "workflows"]) {
    for (const workspaceId of ["shared:one", "other:ws"]) {
      assert.equal(resolveDesktopApiRequest({ method: "GET",
        path: `/api/orch/${collection}?workspaceId=${encodeURIComponent(workspaceId)}&purpose=execution` }, "local-data"), null);
    }
  }
});

test("desktop software status routes local and empty workspaces while migration stays on the server adapter", () => {
  const ws = "local-data:ws";
  // 迁移在桌面单机由 workspaceDirectoryMigrationLocal 直连 Client；连接 Server 时仍走原 HTTP 路由。
  const migrations = `/api/workspaces/${encodeURIComponent(ws)}/directory-migrations`;
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: `${migrations}/op-1` }, "local-data"), null);
  assert.equal(resolveDesktopApiRequest({ method: "POST", path: migrations, body: {} }, "local-data"), null);

  const statusPath = `/api/software/update-status?workspaceId=${encodeURIComponent(ws)}`;
  assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: statusPath, body: { forceRefresh: true } }, "local-data"),
    { method: "software.update.status", body: { forceRefresh: true } });
  assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: `/api/software/npm-install?workspaceId=${encodeURIComponent(ws)}`, body: { npmPackage: "@openai/codex" } }, "local-data"),
    { method: "software.npm.install", body: { npmPackage: "@openai/codex" } });
  // CLI 安装是本机全局能力：未选工作区时也必须直连本机 Client，不能回退 Server 鉴权。
  assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: "/api/software/update-status", body: { forceRefresh: true } }, "local-data"),
    { method: "software.update.status", body: { forceRefresh: true } });
  assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: "/api/software/npm-install", body: { npmPackage: "@openai/codex" } }, "local-data"),
    { method: "software.npm.install", body: { npmPackage: "@openai/codex" } });
  assert.equal(resolveDesktopApiRequest({ method: "POST", path: "/api/software/update-status?workspaceId=shared%3Aone", body: {} }, "local-data"), null);
  assert.equal(resolveDesktopApiRequest({ method: "POST", path: "/api/software/update-status?workspaceId=other%3Aws", body: {} }, "local-data"), null);
});

test("desktop engine status routes only an explicit local workspace", () => {
  assert.deepEqual(resolveDesktopApiRequest({ method: "GET", path: "/api/engines/status?workspaceId=local-data%3Aws" }, "local-data"),
    { method: "engines.status", body: { workspaceId: "local-data:ws" } });
  for (const target of ["", "other:ws", "shared:one"]) {
    assert.equal(resolveDesktopApiRequest({ method: "GET", path: `/api/engines/status?workspaceId=${encodeURIComponent(target)}` }, "local-data"), null);
  }
});

test("desktop chat, draft, queue and user keys keep the existing Client method contract", () => {
  for (const [path, method] of [["/api/threads/create", "threads.create"], ["/api/threads/send", "threads.sendMessage"],
    ["/api/threads/update-prefs", "threads.updatePrefs"], ["/api/threads/draft/save", "threads.draft.save"],
    ["/api/threads/queue/append", "threads.queue.append"], ["/api/turns/interrupt", "turns.interrupt"]]) {
    const body = { workspaceId: "local-data:ws", threadId: "thread" };
    assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: path!, body }, "local-data"), { method, body });
    assert.equal(resolveDesktopApiRequest({ method: "POST", path: path!, body: { ...body, workspaceId: "shared:one" } }, "local-data"), null);
  }
  for (const [suffix, method] of [["", "upsert"], ["/delete", "delete"], ["/activate", "activate"], ["/deactivate", "deactivate"]]) {
    assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: `/api/engine-keys${suffix}?workspaceId=local-data%3Aws`, body: { id: "key" } }, "local-data"),
      { method: `engineKeys.${method}`, body: { id: "key", workspaceId: "local-data:ws" } });
    assert.equal(resolveDesktopApiRequest({ method: "POST", path: `/api/engine-keys${suffix}?workspaceId=shared%3Aone`, body: { id: "key" } }, "local-data"), null);
  }
});

test("desktop engine-key changes refresh the selected local workspace and fence the account owner", async (t) => {
  let finish!: (value: any) => void;
  let delayed = false;
  const key = { id: "local-key", label: "local", engine: "codex", providerId: "openai", apiKey: "", baseUrl: null, isActive: true, createdAt: 1, updatedAt: 1 };
  installBridge(t, { getState: async () => ({}), request: async () => delayed ? new Promise((resolve) => { finish = resolve; }) : { status: 200, body: { ok: true, keys: [key] } } });
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.workspaceId = "local:ws";
  config.sessionToken = "session-A";
  config.userSummary = { userId: "A" } as any;
  config.desktopRuntime = { status: "ready", requestId: "runtime", releaseId: null, errorCode: null };
  config.desktopClient = { clientId: "local", version: "1", connectedAt: 1, workspaceIds: ["local:ws"] };
  const engineKeys = useEngineKeysStore();
  const client = createWebSocketClient({ config, chat: { markWorkspaceSubscribed() {} }, presence: {}, engine: {}, engineKeys } as any);
  client.replaceLocalWorkspaceSubscription("local:ws" as any);
  client.receiveDesktopEvent({ t: "engineKeys.changed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engineKeys.keys[0]?.id, "local-key");
  delayed = true;
  client.receiveDesktopEvent({ t: "engineKeys.changed" });
  await new Promise((resolve) => setImmediate(resolve));
  config.sessionToken = "session-B";
  config.userSummary = { userId: "B" } as any;
  finish({ status: 200, body: { ok: true, keys: [{ ...key, id: "late-A" }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engineKeys.keys.some((entry) => entry.id === "late-A"), false);
});
