import test from "node:test";
import assert from "node:assert/strict";

import { createPinia, setActivePinia } from "pinia";
import type { ThreadId, WorkspaceId } from "@codeflowai/shared";

import { createWebSocketClient } from "../src/services/ws.ts";
import { useChatStore } from "../src/store/chat.ts";
import { useConfigStore } from "../src/store/config.ts";
import { useEngineStore } from "../src/store/engine.ts";
import { useEngineKeysStore } from "../src/store/engineKeys.ts";
import { usePresenceStore } from "../src/store/presence.ts";

const WORKSPACE_ID = "client-a:ws" as WorkspaceId;

/** 构造只记录发送与投递的 WebSocket 替身；fetch 替身同时服务握手与引擎 Key 接口。 */
function installFakeWebSocket(options: { engineKeys?: Array<Record<string, unknown>> } = {}) {
  const sockets: any[] = [];
  const engineKeyRequests: string[] = [];
  const originalWindow = (globalThis as any).window;
  const originalWebSocket = (globalThis as any).WebSocket;
  const originalFetch = globalThis.fetch;
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 1;
    sent: any[] = [];
    onopen: ((event: unknown) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(public readonly url: string) {
      sockets.push(this);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code: 1000 });
    }
    emit(message: unknown) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }
  (globalThis as any).window = { setTimeout, clearTimeout };
  (globalThis as any).WebSocket = FakeWebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/account/me/ws-bridge") {
      return jsonResponse({ ok: true, bridgeToken: "bridge-engine-keys" });
    }
    if (url.pathname === "/api/engine-keys") {
      engineKeyRequests.push(url.search);
      return jsonResponse({ ok: true, keys: options.engineKeys ?? [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  return {
    sockets,
    engineKeyRequests,
    restore() {
      (globalThis as any).window = originalWindow;
      (globalThis as any).WebSocket = originalWebSocket;
      globalThis.fetch = originalFetch;
    },
  };
}

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response;
}

/**
 * 用最小依赖装配 ws 客户端。engineKeys 是真实 store（走 fetch 替身读 `/api/engine-keys`），
 * 这样断言的是「广播 → Key 真的对链路可见」，而不只是「调了一次刷新」。
 */
async function setup(options: { engineKeys?: Array<Record<string, unknown>> } = {}) {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const chat = useChatStore();
  const presence = usePresenceStore();
  const engine = useEngineStore();
  config.serverWsOrigin = "ws://127.0.0.1:39280";
  config.workspaceId = WORKSPACE_ID;
  // ws.connect 要求已登录的账号会话：只补齐握手需要的最小字段，bridge 走 fetch 替身。
  config.authMode = "account";
  config.accountRole = "personal_normal";
  config.sessionToken = "session-engine-keys";
  config.sessionExpiresAt = Date.now() + 60_000;
  config.userSummary = {
    userId: "user-engine-keys",
    email: "user-engine-keys@codeflow.test",
    fullName: "Engine Keys User",
    phone: "",
    avatarUrl: null,
    accountRole: "personal_normal",
    status: "active",
    enterpriseId: "enterprise_engine_keys",
    enterpriseName: "Enterprise Engine Keys",
  } as any;

  const engineKeys = useEngineKeysStore();
  const fake = installFakeWebSocket({ engineKeys: options.engineKeys });
  const ws = createWebSocketClient({ config, chat, presence, engine, engineKeys });
  await ws.connect();
  const socket = fake.sockets[0];
  assert.ok(socket, "ws 客户端必须建立连接");
  return { ws, socket, engineKeys, config, fake };
}

/** 等待广播引发的异步刷新落定。 */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 一把启用中的 Codex 内置中转 Key，与 Client 自动启用写入的形状一致。 */
function activeCodexKey(): Record<string, unknown> {
  return {
    id: "key-relay-codex",
    label: "CodeFlow 内置中转（Codex）",
    engine: "codex",
    providerId: "openai",
    apiKey: "codeflowai_relay_raw_key",
    baseUrl: "https://relay.test/v1",
    isActive: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 走完订阅握手，让当前订阅工作区确定下来。 */
async function subscribeWorkspace(socket: any, ws: { replaceWorkspaceSubscription: (workspaceId: WorkspaceId | null) => Promise<unknown> }): Promise<void> {
  const subscription = ws.replaceWorkspaceSubscription(WORKSPACE_ID);
  const request = socket.sent.at(-1);
  assert.equal(request.t, "web.subscribeReplace");
  socket.emit({ t: "web.subscribeAck", requestId: request.requestId, workspaceId: WORKSPACE_ID, bufferedCount: 0 });
  await subscription;
}

test("引擎 Key 变化广播后，新 Key 对默认会话链路可见", async () => {
  const { ws, socket, engineKeys, fake } = await setup({ engineKeys: [activeCodexKey()] });
  try {
    await subscribeWorkspace(socket, ws);
    // 广播前：链路读取的两个输入都是空的（默认会话此刻会判 no-usable-engine）。
    assert.deepEqual(engineKeys.providerIdsForEngine("codex"), []);

    socket.emit({ t: "engineKeys.changed" });
    await settle();

    // 广播后：Key 进入当前工作区作用域，provider 判定与 keysPhase 同时就绪——正是链路放行的前提。
    assert.deepEqual(fake.engineKeyRequests, ["?workspaceId=client-a%3Aws"]);
    assert.equal(engineKeys.scopeSnapshotForWorkspace(WORKSPACE_ID).phase, "success");
    assert.deepEqual(engineKeys.providerIdsForEngine("codex"), ["openai"]);
    assert.equal(engineKeys.hasActiveKeyForWorkspace(WORKSPACE_ID), true);
  } finally {
    fake.restore();
  }
});

test("工作区未就绪时不发刷新请求，且不抛错", async () => {
  const { ws, socket, engineKeys, config, fake } = await setup({ engineKeys: [activeCodexKey()] });
  try {
    await subscribeWorkspace(socket, ws);
    config.workspaceId = "";
    socket.emit({ t: "engineKeys.changed" });
    await settle();
    assert.deepEqual(fake.engineKeyRequests, []);
    assert.deepEqual(engineKeys.providerIdsForEngine("codex"), []);
  } finally {
    fake.restore();
  }
});

test("共享工作区不读本机 Key：避免非 Host 拿到 403 并弹用户可见错误", async () => {
  const { ws, socket, engineKeys, config, fake } = await setup({ engineKeys: [activeCodexKey()] });
  try {
    await subscribeWorkspace(socket, ws);
    config.workspaceId = "shared:sw-1";
    socket.emit({ t: "engineKeys.changed" });
    await settle();
    assert.deepEqual(fake.engineKeyRequests, []);
    assert.deepEqual(engineKeys.providerIdsForEngine("codex"), []);
  } finally {
    fake.restore();
  }
});

test("无关消息不会触发引擎 Key 刷新", async () => {
  const { ws, socket, engineKeys, fake } = await setup({ engineKeys: [activeCodexKey()] });
  try {
    await subscribeWorkspace(socket, ws);
    socket.emit({ t: "workspaces.changed", workspaceId: WORKSPACE_ID, kind: "upserted" });
    await settle();
    assert.deepEqual(fake.engineKeyRequests, []);
    assert.deepEqual(engineKeys.providerIdsForEngine("codex"), []);
  } finally {
    fake.restore();
  }
});
