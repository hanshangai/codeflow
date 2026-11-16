import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { type EngineType, type ThreadId, type ThreadPrefs, type WorkspaceId } from "@codeflowai/shared";
import { useChatStore } from "../src/store/chat.ts";
import { useEngineStore } from "../src/store/engine.ts";
import { useEngineKeysStore } from "../src/store/engineKeys.ts";
import { useConfigStore } from "../src/store/config.ts";

for (const engine of ["codex", "claude"] as EngineType[]) {
  test(`${engine} 新会话使用目录最大窗口且不请求账号偏好`, async t => {
    setActivePinia(createPinia());
    const chat = useChatStore();
    const engines = useEngineStore();
    const workspaceId = "client:maximum-window" as WorkspaceId;
    useConfigStore().$patch({ authMode: "account", sessionToken: "test-session" });
    engines.activeWorkspaceId = workspaceId;
    engines.engines = [{ engineType: engine, installed: true, version: "test", binPath: engine, error: null,
      models: [{ id: "test-model", displayName: "测试", isDefault: true, contextWindow: 200_000, maxContextWindow: 800_000 }],
      features: { streaming: true, reasoning: true, toolUse: true, imageInput: true, sessionContinuation: true } }];
    t.mock.method(engines, "refresh", async () => {});
    t.mock.method(useEngineKeysStore(), "refresh", async () => {});
    t.mock.method(chat, "refreshThreads", async () => {});
    const requests: string[] = [];
    let submittedPrefs: ThreadPrefs | null = null;
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path === "/api/threads/latest-prefs") return Response.json({ ok: true,
        prefs: { model: "test-model", contextWindow: 32_000, autoCompactPct: 80 } });
      assert.equal(path, "/api/threads/create");
      submittedPrefs = JSON.parse(String(init?.body)).initialPrefs;
      return Response.json({ ok: true, threadId: "maximum-thread" });
    };
    const context = { serverWsOrigin: "ws://localhost:39280", sessionToken: "test-session", webSessionId: "test",
      ensureSession: async () => "test-session", clearSession() {} };
    await chat.createThread(context, { workspaceId, engine, title: "最大窗口" });
    assert.equal((submittedPrefs as ThreadPrefs | null)?.contextWindow, 800_000);
    assert.equal((submittedPrefs as ThreadPrefs | null)?.autoCompactPct, 80);
    assert.equal(chat.threadPrefsByThreadId["maximum-thread" as ThreadId]?.contextWindow, 800_000);
    assert.deepEqual(requests, ["/api/threads/latest-prefs", "/api/threads/create"]);
  });
}
