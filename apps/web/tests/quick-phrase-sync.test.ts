import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import type { DesktopApiRequest, DesktopBridgeApi, QuickPhrase, QuickPhraseCollection } from "@codeflowai/shared";
import { resetQuickPhraseSync, syncQuickPhrasesToAccount } from "../src/features/composer/quickPhraseSync.ts";
import { useConfigStore } from "../src/store/config.ts";

const phrase = (id: string, title: string): QuickPhrase => ({ id, title, content: `${title} 内容`, sortOrder: 0, version: 1, createdAt: 1, updatedAt: 1 });

/** 安装内存 localStorage，隔离合并记录。 */
function installStorage(t: test.TestContext): void {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  }, writable: true, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
    resetQuickPhraseSync();
  });
}

/** 安装桌面桥，本机提示词直接返回固定集合。 */
function installBridge(t: test.TestContext, requests: DesktopApiRequest[], local: QuickPhrase[]): void {
  const bridge: DesktopBridgeApi = {
    getState: async () => ({ status: "ready", requestId: "runtime", releaseId: null, errorCode: null }),
    openWindow: async () => {}, exit: async () => {}, onEvent: () => () => {},
    request: async (request) => {
      requests.push(request);
      if (request.method === "quickPhrases.list") return { status: 200, body: { ok: true, revision: 3, items: local } };
      throw new Error(`unexpected desktop request ${request.method}`);
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { codeflowDesktop: bridge }, writable: true, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

test("登录后按标题合并本机提示词，账号已有项优先且已合并项不重复上传", async (t) => {
  setActivePinia(createPinia());
  useConfigStore().$patch({ authMode: "account", connected: true, serverWsOrigin: "ws://localhost:39280", sessionToken: "test-session",
    desktopRuntime: { status: "ready", requestId: "runtime", releaseId: null, errorCode: null },
    desktopClient: { clientId: "client-a", version: "1.0.0", connectedAt: 1, workspaceIds: [] } });
  installStorage(t);
  const requests: DesktopApiRequest[] = [];
  installBridge(t, requests, [phrase("l1", "同名项"), phrase("l2", "本机独有")]);
  let collection: QuickPhraseCollection = { revision: 1, items: [phrase("a1", "同名项")] };
  const creates: unknown[] = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    if (init?.body) {
      const body = JSON.parse(String(init.body)) as { clientRequestId: string; title: string; content: string };
      creates.push(body);
      collection = { ...collection, items: [...collection.items, phrase(`a${collection.items.length + 1}`, body.title)] };
    }
    return new Response(JSON.stringify({ ok: true, ...collection }), { status: 200 });
  };
  const ctx = { serverWsOrigin: "ws://localhost:39280", sessionToken: "test-session", webSessionId: null, desktopClientId: "client-a" };

  await syncQuickPhrasesToAccount(ctx, "ws://localhost:39280", "user-a");
  assert.deepEqual(creates, [{ clientRequestId: "merge:l2", title: "本机独有", content: "本机独有 内容" }]);

  await syncQuickPhrasesToAccount(ctx, "ws://localhost:39280", "user-a");
  assert.equal(creates.length, 1);

  resetQuickPhraseSync();
  await syncQuickPhrasesToAccount(ctx, "ws://localhost:39280", "user-a");
  assert.equal(creates.length, 1, "已合并项不应因重新登录再次上传");
});

test("本机提示词已归属其他账号时不再合并到新账号", async (t) => {
  setActivePinia(createPinia());
  useConfigStore().$patch({ authMode: "account", connected: true, serverWsOrigin: "ws://localhost:39280", sessionToken: "test-session",
    desktopRuntime: { status: "ready", requestId: "runtime", releaseId: null, errorCode: null },
    desktopClient: { clientId: "client-a", version: "1.0.0", connectedAt: 1, workspaceIds: [] } });
  installStorage(t);
  localStorage.setItem("codeflowai.quick-phrases.owner", "ws://localhost:39280::user-a");
  const requests: DesktopApiRequest[] = [];
  installBridge(t, requests, [phrase("l1", "本机项")]);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let serverCalls = 0;
  globalThis.fetch = async () => { serverCalls += 1; return new Response("{}", { status: 200 }); };
  const ctx = { serverWsOrigin: "ws://localhost:39280", sessionToken: "test-session", webSessionId: null, desktopClientId: "client-a" };

  await syncQuickPhrasesToAccount(ctx, "ws://localhost:39280", "user-b");

  assert.equal(serverCalls, 0);
});

test("合并记录损坏时重建记录并继续合并", async (t) => {
  setActivePinia(createPinia());
  useConfigStore().$patch({ authMode: "account", connected: true, serverWsOrigin: "ws://localhost:39280", sessionToken: "test-session",
    desktopRuntime: { status: "ready", requestId: "runtime", releaseId: null, errorCode: null },
    desktopClient: { clientId: "client-a", version: "1.0.0", connectedAt: 1, workspaceIds: [] } });
  installStorage(t);
  const scope = "ws://localhost:39280::user-e";
  localStorage.setItem(`codeflowai.quick-phrases.merged:${scope}`, "{bad");
  const requests: DesktopApiRequest[] = [];
  installBridge(t, requests, [phrase("l1", "本机项")]);
  const creates: unknown[] = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    if (init?.body) creates.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true, revision: 1, items: [] }), { status: 200 });
  };
  const ctx = { serverWsOrigin: "ws://localhost:39280", sessionToken: "test-session", webSessionId: null, desktopClientId: "client-a" };

  await syncQuickPhrasesToAccount(ctx, "ws://localhost:39280", "user-e");

  assert.equal(creates.length, 1);
  assert.deepEqual(JSON.parse(localStorage.getItem(`codeflowai.quick-phrases.merged:${scope}`)!), ["l1"]);
});
