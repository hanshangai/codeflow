import test from "node:test";
import assert from "node:assert/strict";

import { createPinia, setActivePinia } from "pinia";

import type { ApiRequestContext } from "../src/api/request.ts";
import { useChatStore } from "../src/store/chat.ts";
import { buildWorkspacesRefreshScopeKey } from "../src/store/workspaces.ts";

const originalFetch = globalThis.fetch;

function createApiContext(): ApiRequestContext {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "session-demo",
    webSessionId: "web-demo",
    ensureSession: async () => "session-demo",
    clearSession() {},
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("markManagedServicesChanged keeps issuing refresh signals while list is already stale", () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const threadId = "thread-demo" as any;

  store.setThreadManagedServicesScope(threadId, {
    visible: true,
    threadId,
  });

  store.markManagedServicesChanged(threadId);
  let state = store.managedServicesStateForThread(threadId);
  assert.equal(state.stale, true);
  assert.equal(state.refreshTick, 1);
  assert.equal(state.version, 0);

  store.markManagedServicesChanged(threadId);
  state = store.managedServicesStateForThread(threadId);
  assert.equal(state.stale, true);
  assert.equal(state.refreshTick, 2);
  assert.equal(state.version, 0);
});

test("workspace refresh scope no longer varies with web session id", () => {
  const first = buildWorkspacesRefreshScopeKey({
    serverWsOrigin: "ws://127.0.0.1:39280/ws/web",
    sessionToken: "session-demo",
  } as any);
  const second = buildWorkspacesRefreshScopeKey({
    serverWsOrigin: "ws://127.0.0.1:39280/ws/web",
    sessionToken: "session-demo",
  } as any);

  assert.equal(first, second);
  assert.equal(first.includes("web-"), false);
});

test("file changes resource enters stale mode and self-heals after refresh", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-file-demo" as any;

  store.markThreadFileChangesChanged(threadId);
  let state = store.fileChangesByThreadId[String(threadId)];
  assert.equal(state?.stale, true);
  assert.equal(state?.refreshTick, 1);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/file-changes/list") {
      return jsonResponse({
        ok: true,
        items: [{
          path: "src/demo.ts",
          status: "modified",
          lastTurnId: "turn-demo",
          lastChangedAt: 1,
          canUndo: true,
          stepKey: null,
          isAccepted: false,
          acceptedBlobId: null,
        }],
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.refreshThreadFileChanges(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId,
    force: true,
  });

  state = store.fileChangesByThreadId[String(threadId)];
  assert.equal(state?.stale, false);
  assert.equal(state?.hydrated, true);
  assert.equal(state?.refreshTick, 1);
  assert.equal(state?.items.length, 1);
  assert.equal(state?.items[0]?.path, "src/demo.ts");
});
