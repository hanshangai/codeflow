import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createPinia, setActivePinia } from "pinia";

import type { ApiRequestContext } from "../src/api/request.ts";
import { createReminderRefreshCoordinator } from "../src/services/reminderRefreshCoordinator.ts";
import { useReminderStore } from "../src/store/reminders.ts";

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

async function tick(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("reminder summary refresh collapses concurrent same-scope requests into one HTTP call", async () => {
  setActivePinia(createPinia());
  const store = useReminderStore();
  const ctx = createApiContext();
  let summaryRequests = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/reminders/workspaces") {
      summaryRequests += 1;
      await tick(25);
      return jsonResponse({ ok: true, summaries: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await Promise.all([
    store.refreshWorkspaceSummaries(ctx),
    store.refreshWorkspaceSummaries(ctx),
  ]);

  assert.equal(summaryRequests, 1);
  assert.equal(store.workspaceSummariesLoading, false);
});

test("reminder item refresh collapses concurrent same-workspace requests into one HTTP call", async () => {
  setActivePinia(createPinia());
  const store = useReminderStore();
  const ctx = createApiContext();
  let itemRequests = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/reminders/items") {
      itemRequests += 1;
      await tick(25);
      return jsonResponse({
        ok: true,
        summary: {
          workspaceId: "client-a:ws-demo",
          pendingActionCount: 0,
          pendingReceiptCount: 0,
          updatedAt: null,
        },
        items: [],
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await Promise.all([
    store.refreshCurrentWorkspace(ctx, "client-a:ws-demo" as any),
    store.refreshCurrentWorkspace(ctx, "client-a:ws-demo" as any),
  ]);

  assert.equal(itemRequests, 1);
  assert.equal(store.currentItemsLoading, false);
});

test("shared workspace reminder refresh stays local until user projection exists", async () => {
  setActivePinia(createPinia());
  const store = useReminderStore();
  const ctx = createApiContext();
  store.summariesByWorkspaceId["shared:workspace-reminder"] = {
    workspaceId: "shared:workspace-reminder" as any,
    pendingActionCount: 2,
    pendingReceiptCount: 3,
    updatedAt: 10,
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`unexpected request: ${new URL(String(input)).pathname}`);
  }) as typeof fetch;

  await store.refreshCurrentWorkspace(ctx, "shared:workspace-reminder" as any);

  assert.equal(store.currentItemsLoading, false);
  assert.deepEqual(store.currentItems, []);
  assert.deepEqual(store.currentSummary, {
    workspaceId: "shared:workspace-reminder",
    pendingActionCount: 0,
    pendingReceiptCount: 0,
    updatedAt: null,
  });
});

test("workspace switch clears the previous reminder projection immediately", () => {
  setActivePinia(createPinia());
  const store = useReminderStore();
  const localWorkspaceId = "client-a:ws-local" as any;
  const sharedWorkspaceId = "shared:ws-shared" as any;
  const reminder = {
    id: "thread:demo:receipt:turn-1",
    sourceType: "chat",
    workspaceId: localWorkspaceId,
    displayKind: "receipt",
    title: "已完成会话",
    statusLabel: "待查收",
    tone: "success",
    summary: "会话已完成",
    updatedAt: 11,
    isActionRequired: false,
    readState: "unread",
    primaryActionKind: "open_chat_thread",
    primaryActionLabel: "查看结果",
    ignoreMarker: "turn-1",
    routeTarget: { workspaceId: localWorkspaceId, threadId: "thread-demo" as any },
  } as const;

  store.applyCurrentWorkspaceItems(localWorkspaceId, [reminder]);
  store.resetForWorkspace(sharedWorkspaceId);

  assert.equal(store.currentWorkspaceId, sharedWorkspaceId);
  assert.deepEqual(store.currentItems, []);
  assert.deepEqual(store.currentSummary, {
    workspaceId: sharedWorkspaceId,
    pendingActionCount: 0,
    pendingReceiptCount: 0,
    updatedAt: null,
  });
  assert.equal(store.threadReceiptItem("thread-demo" as any, sharedWorkspaceId), null);
});

test("late local reminder response cannot overwrite the workspace switched to shared", async () => {
  setActivePinia(createPinia());
  const store = useReminderStore();
  const ctx = createApiContext();
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/reminders/items") return response;
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const refreshPromise = store.refreshCurrentWorkspace(ctx, "client-a:ws-local" as any);
  await tick(0);
  store.resetForWorkspace("shared:ws-shared" as any);
  resolveResponse(jsonResponse({
    ok: true,
    summary: {
      workspaceId: "client-a:ws-local",
      pendingActionCount: 0,
      pendingReceiptCount: 1,
      updatedAt: 11,
    },
    items: [{
      id: "thread:demo:receipt:turn-1",
      sourceType: "chat",
      workspaceId: "client-a:ws-local",
      displayKind: "receipt",
      title: "已完成会话",
      statusLabel: "待查收",
      tone: "success",
      summary: "会话已完成",
      updatedAt: 11,
      isActionRequired: false,
      readState: "unread",
      primaryActionKind: "open_chat_thread",
      primaryActionLabel: "查看结果",
      ignoreMarker: "turn-1",
      routeTarget: { workspaceId: "client-a:ws-local", threadId: "thread-demo" },
    }],
  }));
  await refreshPromise;

  assert.equal(store.currentWorkspaceId, "shared:ws-shared");
  assert.deepEqual(store.currentItems, []);
});

test("thread receipt getter requires the requested workspace", () => {
  setActivePinia(createPinia());
  const store = useReminderStore();
  const localWorkspaceId = "client-a:ws-local" as any;
  const otherWorkspaceId = "client-b:ws-other" as any;
  const item = {
    id: "thread:demo:receipt:turn-1",
    sourceType: "chat",
    workspaceId: localWorkspaceId,
    displayKind: "receipt",
    title: "已完成会话",
    statusLabel: "待查收",
    tone: "success",
    summary: "会话已完成",
    updatedAt: 11,
    isActionRequired: false,
    readState: "unread",
    primaryActionKind: "open_chat_thread",
    primaryActionLabel: "查看结果",
    ignoreMarker: "turn-1",
    routeTarget: { workspaceId: localWorkspaceId, threadId: "thread-demo" as any },
  } as const;
  store.applyCurrentWorkspaceItems(localWorkspaceId, [item]);

  assert.equal(store.threadReceiptItem("thread-demo" as any, localWorkspaceId)?.id, item.id);
  assert.equal(store.threadReceiptItem("thread-demo" as any, otherWorkspaceId), null);
});

test("mark reminder read uses the stable ignore marker", async () => {
  setActivePinia(createPinia());
  const store = useReminderStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const item = {
    id: "thread:demo:receipt:turn:with-colon",
    sourceType: "chat",
    workspaceId,
    displayKind: "receipt",
    title: "已完成会话",
    statusLabel: "待查收",
    tone: "success",
    summary: "会话已完成",
    updatedAt: 11,
    isActionRequired: false,
    readState: "unread",
    primaryActionKind: "open_chat_thread",
    primaryActionLabel: "查看结果",
    ignoreMarker: "turn-marker-with-colon",
    routeTarget: { workspaceId, threadId: "thread-demo" as any },
  } as const;
  store.applyCurrentWorkspaceItems(workspaceId, [item]);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/reminders/mark-read") throw new Error(`unexpected request: ${url.pathname}`);
    assert.deepEqual(JSON.parse(String(init?.body ?? "{}")), {
      workspaceId,
      entityType: "thread",
      entityId: "thread-demo",
      marker: "turn-marker-with-colon",
    });
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  await store.markItemRead(ctx, item);
  assert.deepEqual(store.currentItems, []);
});

test("consume reminder items removes them from current workspace state and recomputes counts", async () => {
  setActivePinia(createPinia());
  const store = useReminderStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const actionItem = {
    id: "thread:demo:error",
    sourceType: "chat",
    workspaceId,
    displayKind: "action",
    title: "异常会话",
    statusLabel: "异常",
    tone: "danger",
    summary: "会话已异常结束",
    updatedAt: 10,
    isActionRequired: true,
    readState: "unread",
    primaryActionKind: "open_chat_thread",
    primaryActionLabel: "查看会话",
    ignoreMarker: "thread-terminal:error:10",
    routeTarget: { workspaceId, threadId: "thread-demo" as any },
  } as const;
  const receiptItem = {
    id: "thread:demo:receipt:turn-1",
    sourceType: "chat",
    workspaceId,
    displayKind: "receipt",
    title: "已完成会话",
    statusLabel: "待查收",
    tone: "success",
    summary: "会话已完成",
    updatedAt: 11,
    isActionRequired: false,
    readState: "unread",
    primaryActionKind: "open_chat_thread",
    primaryActionLabel: "查看结果",
    ignoreMarker: "turn-1",
    routeTarget: { workspaceId, threadId: "thread-demo" as any },
  } as const;

  store.applyCurrentWorkspaceItems(workspaceId, [actionItem, receiptItem]);

  let ignoreRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/reminders/ignore") {
      ignoreRequests += 1;
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.deepEqual(body, {
        workspaceId: "client-a:ws-demo",
        items: [
          { reminderId: actionItem.id, ignoreMarker: actionItem.ignoreMarker },
          { reminderId: receiptItem.id, ignoreMarker: receiptItem.ignoreMarker },
        ],
      });
      return jsonResponse({
        ok: true,
        ignoredIds: [actionItem.id, receiptItem.id],
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const ignoredIds = await store.consumeItems(ctx, [actionItem, receiptItem]);

  assert.equal(ignoreRequests, 1);
  assert.deepEqual(ignoredIds, [actionItem.id, receiptItem.id]);
  assert.deepEqual(store.currentItems, []);
  assert.equal(store.currentSummary?.pendingActionCount, 0);
  assert.equal(store.currentSummary?.pendingReceiptCount, 0);
});

test("提醒需求取消会中止已派发列表请求并阻止迟到写回", async () => {
  setActivePinia(createPinia());
  const store = useReminderStore();
  let observedSignal: AbortSignal | null = null;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  globalThis.fetch = (async (_url, init) => {
    observedSignal = init?.signal as AbortSignal;
    await pending;
    return jsonResponse({ ok: true, summary: { workspaceId: "ws-1", pendingActionCount: 8 }, items: [] });
  }) as typeof fetch;
  const coordinator = createReminderRefreshCoordinator({
    store, getApiContext: createApiContext, getCurrentWorkspaceId: () => "ws-1", delayMs: 0,
  });
  coordinator.enqueue("ws-1");
  await tick(10);
  coordinator.cancel();
  const aborted = (observedSignal as AbortSignal | null)?.aborted;
  finish();
  await tick(10);
  assert.equal(aborted, true);
  assert.equal(store.currentSummary, null);
});

test("reminder refresh coordinator collapses burst workspace changes into one current-workspace refresh", async () => {
  const calls: string[] = [];
  const coordinator = createReminderRefreshCoordinator({
    store: {
      async refreshCurrentWorkspace(_ctx, workspaceId) {
        calls.push(`current:${workspaceId}`);
        await tick(5);
      },
    },
    getApiContext: createApiContext,
    getCurrentWorkspaceId: () => "client-a:ws-demo",
    delayMs: 0,
  });

  coordinator.enqueue("client-a:ws-demo" as any);
  coordinator.enqueue("client-a:ws-demo" as any);
  coordinator.enqueue("client-a:ws-demo" as any);

  await tick(80);

  assert.deepEqual(calls, [
    "current:client-a:ws-demo",
  ]);
});

test("reminder refresh coordinator merges in-flight burst into a single follow-up refresh", async () => {
  const calls: string[] = [];
  const coordinator = createReminderRefreshCoordinator({
    store: {
      async refreshCurrentWorkspace(_ctx, workspaceId) {
        calls.push(`current:${workspaceId}`);
        await tick(30);
      },
    },
    getApiContext: createApiContext,
    getCurrentWorkspaceId: () => "client-a:ws-demo",
    delayMs: 0,
  });

  coordinator.enqueue("client-a:ws-demo" as any);
  await tick(5);
  coordinator.enqueue("client-a:ws-demo" as any);
  coordinator.enqueue("client-a:ws-demo" as any);

  await tick(120);

  assert.deepEqual(calls, [
    "current:client-a:ws-demo",
    "current:client-a:ws-demo",
  ]);
});

test("reminder refresh coordinator ignores background workspace changes until the periodic fallback", async () => {
  const calls: string[] = [];
  const coordinator = createReminderRefreshCoordinator({
    store: {
      async refreshCurrentWorkspace(_ctx, workspaceId) {
        calls.push(`current:${workspaceId}`);
      },
    },
    getApiContext: createApiContext,
    getCurrentWorkspaceId: () => "client-a:ws-current",
    delayMs: 0,
  });

  coordinator.enqueue("client-a:ws-background" as any);
  await tick(20);

  assert.deepEqual(calls, []);
});

test("topbar keeps the global reminder fallback visible-only and at one-minute cadence", () => {
  const source = fs.readFileSync(new URL("../src/components/app-shell/app-topbar.vue", import.meta.url), "utf8");
  assert.match(source, /const REMINDER_REFRESH_INTERVAL_MS = 60_000;/u);
  assert.match(source, /if \(document\.hidden\) return;[\s\S]*?REMINDER_REFRESH_INTERVAL_MS/u);
});
