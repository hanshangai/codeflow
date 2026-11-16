import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createPinia, setActivePinia } from "pinia";
import { CODEX_MODELS, type ThreadId, type ThreadPrefs, type ThreadSummary, type WorkspaceId } from "@codeflowai/shared";

import type { ApiRequestContext } from "../src/api/request.ts";
import { useChatStore } from "../src/store/chat.ts";
import { useEngineStore } from "../src/store/engine.ts";
import { useEngineKeysStore } from "../src/store/engineKeys.ts";

const originalFetch = globalThis.fetch;
const composerSource = readFileSync(
  new URL("../src/features/composer/components/chat-composer.vue", import.meta.url),
  "utf8",
);

type PendingFetch = {
  body: { workspaceId: string; threadId: string; prefs: ThreadPrefs };
  resolve: (response: Response) => void;
};

/** 创建不依赖真实登录态的 API 上下文。 */
function createApiContext(): ApiRequestContext {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "session-demo",
    webSessionId: "web-demo",
    ensureSession: async () => "session-demo",
    clearSession() {},
  };
}

/** 创建统一 JSON API 响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 构造偏好读取 scope 所需的最小 thread 摘要。 */
function createThreadSummary(threadId: ThreadId): ThreadSummary {
  return {
    id: threadId,
    title: `会话 ${threadId}`,
    threadType: "chat",
    threadSubtype: null,
    archived: false,
    pinnedAt: null,
    groupId: null,
    createdAt: 1,
    updatedAt: 2,
    engine: "codex",
  };
}

/** 等待异步请求进入测试 gate，避免依赖固定延时。 */
async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("新建 GPT 会话默认关闭 Fast 和 Spec，不继承最近会话的开启态", async (t) => {
  for (const supportsFastMode of [true, false]) {
    setActivePinia(createPinia());
    const store = useChatStore();
    const engines = useEngineStore();
    const workspaceId = "client-a:workspace-fast-default" as WorkspaceId;
    const model = { ...CODEX_MODELS[0]!, supportsFastMode, isDefault: true };
    engines.activeWorkspaceId = workspaceId;
    engines.engines = [{
      engineType: "codex", installed: true, version: "test", binPath: "codex", models: [model], error: null,
      features: { streaming: true, reasoning: true, toolUse: true, imageInput: true, sessionContinuation: true },
    }];
    t.mock.method(engines, "refresh", async () => {});
    t.mock.method(useEngineKeysStore(), "refresh", async () => {});
    t.mock.method(store, "refreshThreads", async () => {});
    let submittedPrefs: ThreadPrefs | null = null;
    const threadId = `thread-fast-default-${supportsFastMode}` as ThreadId;
    const previousThreadId = "thread-existing-enabled" as ThreadId;
    store.setThreadPrefs(previousThreadId, { model: model.id, serviceTier: "fast", knowledgeEnabled: true });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/threads/latest-prefs") return jsonResponse({ ok: true, prefs: { model: model.id, serviceTier: "fast", knowledgeEnabled: true } });
      if (path === "/api/threads/create") {
        submittedPrefs = JSON.parse(String(init?.body)).initialPrefs;
        return jsonResponse({ ok: true, threadId });
      }
      throw new Error(`unexpected request: ${path}`);
    }) as typeof fetch;

    assert.equal(await store.createThread(createApiContext(), { workspaceId, engine: "codex", title: "Fast 默认值" }), threadId);
    assert.equal((submittedPrefs as ThreadPrefs | null)?.serviceTier, null);
    assert.equal((submittedPrefs as ThreadPrefs | null)?.knowledgeEnabled, false);
    assert.equal(store.threadPrefsByThreadId[String(threadId)]?.serviceTier, null);
    assert.equal(store.threadPrefsByThreadId[String(threadId)]?.knowledgeEnabled, false);
    assert.equal(store.threadPrefsByThreadId[String(previousThreadId)]?.serviceTier, "fast");
    assert.equal(store.threadPrefsByThreadId[String(previousThreadId)]?.knowledgeEnabled, true);
  }
});

test("迟到的 prefs GET 不覆盖本地尚未确认的模型修改", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:workspace-a" as WorkspaceId;
  const threadId = "thread-prefs-late-read" as ThreadId;
  let resolveRead: ((response: Response) => void) | null = null;

  store.threads = [createThreadSummary(threadId)];
  store.setThreadPrefs(threadId, { model: "gpt-5.6-sol", effort: "high" });
  globalThis.fetch = (async () => await new Promise<Response>((resolve) => {
    resolveRead = resolve;
  })) as typeof fetch;

  const read = store.refreshThreadPrefs(ctx, workspaceId, threadId);
  await waitFor(() => resolveRead !== null, "prefs GET did not start");
  store.patchThreadPrefs(threadId, { model: "gpt-5.5" }, workspaceId);
  resolveRead!(jsonResponse({ ok: true, prefs: { model: "gpt-5.6-sol", effort: "medium" } }));
  await read;

  assert.deepEqual(store.threadPrefsByThreadId[String(threadId)], {
    model: "gpt-5.5",
    effort: "medium",
  });
  assert.deepEqual(store.threadBasePrefsByThreadId[String(threadId)], {
    model: "gpt-5.5",
    effort: "medium",
  });
  assert.deepEqual(store.pendingThreadPrefsByThreadId[String(threadId)], { model: "gpt-5.5" });
});

test("保存 ACK 后才返回的旧 GET 不覆盖已确认模型且保留远端其它字段", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:workspace-ack-read" as WorkspaceId;
  const threadId = "thread-prefs-ack-read" as ThreadId;
  let resolveRead: ((response: Response) => void) | null = null;

  store.threads = [createThreadSummary(threadId)];
  store.setThreadPrefs(threadId, { model: "base-model", effort: "high" });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/threads/prefs") {
      return await new Promise<Response>((resolve) => {
        resolveRead = resolve;
      });
    }
    if (path === "/api/threads/update-prefs") return jsonResponse({ ok: true });
    throw new Error(`unexpected request: ${path}`);
  }) as typeof fetch;

  const read = store.refreshThreadPrefs(ctx, workspaceId, threadId);
  await waitFor(() => resolveRead !== null, "prefs GET did not start");
  store.patchThreadPrefs(threadId, { model: "gpt-5.5" }, workspaceId);
  await store.saveThreadPrefs(ctx, workspaceId, threadId);
  resolveRead!(jsonResponse({ ok: true, prefs: { model: "base-model", effort: "medium" } }));
  await read;

  assert.deepEqual(store.threadPrefsByThreadId[String(threadId)], {
    model: "gpt-5.5",
    effort: "medium",
  });
  assert.deepEqual(store.threadBasePrefsByThreadId[String(threadId)], {
    model: "gpt-5.5",
    effort: "medium",
  });
  assert.equal(store.pendingThreadPrefsByThreadId[String(threadId)], undefined);
});

test("已有本地 pending 后才启动的读请求，在 ACK 后返回旧快照仍保留本地字段", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:workspace-pending-before-read" as WorkspaceId;
  const threadId = "thread-prefs-pending-before-read" as ThreadId;
  let resolveRead: ((response: Response) => void) | null = null;

  store.threads = [createThreadSummary(threadId)];
  store.setThreadPrefs(threadId, { model: "base-model", effort: "high" });
  store.patchThreadPrefs(threadId, { model: "gpt-5.5" }, workspaceId);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/threads/prefs") {
      return await new Promise<Response>((resolve) => {
        resolveRead = resolve;
      });
    }
    if (path === "/api/threads/update-prefs") return jsonResponse({ ok: true });
    throw new Error(`unexpected request: ${path}`);
  }) as typeof fetch;

  const read = store.refreshThreadPrefs(ctx, workspaceId, threadId);
  await waitFor(() => resolveRead !== null, "prefs GET did not start");
  await store.saveThreadPrefs(ctx, workspaceId, threadId);
  resolveRead!(jsonResponse({ ok: true, prefs: { model: "base-model", effort: "medium" } }));
  await read;

  assert.deepEqual(store.threadPrefsByThreadId[String(threadId)], {
    model: "gpt-5.5",
    effort: "medium",
  });
  assert.deepEqual(store.threadBasePrefsByThreadId[String(threadId)], {
    model: "gpt-5.5",
    effort: "medium",
  });
  assert.equal(store.pendingThreadPrefsByThreadId[String(threadId)], undefined);
});

test("loadThread 旧快照与保存 ACK 交错后，分页回放仍保留已确认模型", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:workspace-load-page" as WorkspaceId;
  const threadId = "thread-prefs-load-page" as ThreadId;
  const key = String(threadId);
  let loadCount = 0;

  store.threads = [createThreadSummary(threadId)];
  store.setThreadPrefs(threadId, { model: "base-model", effort: "high" });
  store.threadBasePrefsByThreadId[key] = { model: "base-model", effort: "high" };
  store.patchThreadPrefs(threadId, { model: "gpt-5.5" }, workspaceId);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/threads/update-prefs") return jsonResponse({ ok: true });
    if (path !== "/api/threads/load") throw new Error(`unexpected request: ${path}`);
    loadCount += 1;
    const events = loadCount === 1
      ? []
      : [{
        schema: 1,
        seq: 1,
        ts: 1,
        workspaceId,
        threadId,
        engine: "codex",
        type: "turn.started",
        payload: { turnId: "turn-page" },
      }];
    return jsonResponse({
      ok: true,
      thread: {
        id: threadId,
        workspaceId,
        engine: "codex",
        title: "分页回放",
        threadType: "chat",
        threadSubtype: null,
        sessionId: null,
        createdAt: 1,
        updatedAt: 1,
        model: "base-model",
        effort: "medium",
        accessMode: "current",
        planMode: false,
        autoCompactPct: null,
        contextWindow: null,
      },
      hasRealTurnActivity: false,
      managedServices: null,
      running: null,
      events,
      hasMore: loadCount === 1,
      oldestSeq: loadCount === 1 ? 2 : 1,
      latestSeq: loadCount === 1 ? 2 : 1,
      rawEventCount: events.length,
    });
  }) as typeof fetch;

  await store.loadThread(ctx, { workspaceId, threadId });
  assert.equal(store.threadLoadMetaByThreadId[key]?.hasMore, true);
  assert.equal(store.threadPrefsByThreadId[key]?.model, "gpt-5.5");
  assert.equal(store.threadBasePrefsByThreadId[key]?.model, "gpt-5.5");
  assert.deepEqual(store.pendingThreadPrefsByThreadId[key], { model: "gpt-5.5" });

  await store.saveThreadPrefs(ctx, workspaceId, threadId);
  assert.equal(store.pendingThreadPrefsByThreadId[key], undefined);
  assert.equal(store.threadBasePrefsByThreadId[key]?.model, "gpt-5.5");

  await store.loadThreadPage(ctx, { workspaceId, threadId });
  assert.equal(store.threadPrefsByThreadId[key]?.model, "gpt-5.5");
  assert.equal(store.threadBasePrefsByThreadId[key]?.model, "gpt-5.5");
});

test("同一 thread 的 prefs 保存串行执行且旧 ACK 不清除请求期间的新值", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:workspace-serial" as WorkspaceId;
  const threadId = "thread-prefs-serial" as ThreadId;
  const requests: PendingFetch[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as PendingFetch["body"];
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return await new Promise<Response>((resolve) => {
      requests.push({
        body,
        resolve: (response) => {
          inFlight -= 1;
          resolve(response);
        },
      });
    });
  }) as typeof fetch;

  store.patchThreadPrefs(threadId, { model: "gpt-5.5" }, workspaceId);
  const firstSave = store.saveThreadPrefs(ctx, workspaceId, threadId);
  await waitFor(() => requests.length === 1, "first prefs save did not start");
  assert.deepEqual(requests[0]?.body.prefs, { model: "gpt-5.5" });

  store.patchThreadPrefs(threadId, { model: "gpt-5.6-terra", effort: "ultra" }, workspaceId);
  const secondSave = store.saveThreadPrefs(ctx, workspaceId, threadId);
  await Promise.resolve();
  assert.equal(requests.length, 1);

  requests[0]!.resolve(jsonResponse({ ok: true }));
  await firstSave;
  await waitFor(() => requests.length === 2, "second prefs save did not start");
  assert.deepEqual(store.pendingThreadPrefsByThreadId[String(threadId)], {
    model: "gpt-5.6-terra",
    effort: "ultra",
  });
  assert.deepEqual(requests[1]?.body.prefs, {
    model: "gpt-5.6-terra",
    effort: "ultra",
  });

  requests[1]!.resolve(jsonResponse({ ok: true }));
  await secondSave;
  assert.equal(maxInFlight, 1);
  assert.equal(store.pendingThreadPrefsByThreadId[String(threadId)], undefined);
  assert.deepEqual(store.threadPrefsByThreadId[String(threadId)], {
    model: "gpt-5.6-terra",
    effort: "ultra",
  });
});

test("prefs 保存失败保留显式 null 补丁并允许后续重试", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:workspace-retry" as WorkspaceId;
  const threadId = "thread-prefs-retry" as ThreadId;
  const requestBodies: PendingFetch["body"][] = [];
  let shouldFail = true;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as PendingFetch["body"]);
    return shouldFail
      ? jsonResponse({ ok: false, code: "CLIENT_ERROR", message: "偏好保存失败" }, 502)
      : jsonResponse({ ok: true });
  }) as typeof fetch;

  store.setThreadPrefs(threadId, { model: "gpt-5.5", effort: "high" });
  store.patchThreadPrefs(threadId, { model: null }, workspaceId);
  await assert.rejects(store.saveThreadPrefs(ctx, workspaceId, threadId), /偏好保存失败/u);
  assert.deepEqual(requestBodies[0]?.prefs, { model: null });
  assert.deepEqual(store.pendingThreadPrefsByThreadId[String(threadId)], { model: null });

  shouldFail = false;
  await store.saveThreadPrefs(ctx, workspaceId, threadId);
  assert.deepEqual(requestBodies[1]?.prefs, { model: null });
  assert.equal(store.pendingThreadPrefsByThreadId[String(threadId)], undefined);
  assert.deepEqual(store.threadPrefsByThreadId[String(threadId)], { model: null, effort: "high" });
});

test("已删除 thread 的偏好保存响应会清理旧投影，不污染后续会话", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:workspace-deleted-prefs" as WorkspaceId;
  const threadId = "thread-deleted-prefs" as ThreadId;

  store.threads = [createThreadSummary(threadId)];
  store.setThreadPrefs(threadId, { model: "gpt-5.5" });
  store.patchThreadPrefs(threadId, { model: "gpt-5.6-sol" }, workspaceId);
  globalThis.fetch = (async () => jsonResponse({ ok: false, code: "CLIENT_ERROR", message: "thread 不存在" }, 502)) as typeof fetch;

  await store.saveThreadPrefs(ctx, workspaceId, threadId);

  assert.deepEqual(store.threads, []);
  assert.equal(store.pendingThreadPrefsByThreadId[String(threadId)], undefined);
  assert.equal(store.threadPrefsByThreadId[String(threadId)], undefined);
});

test("workspace 重置后旧 prefs ACK 不清除新 scope 的 pending", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const oldWorkspaceId = "client-a:workspace-old" as WorkspaceId;
  const newWorkspaceId = "client-a:workspace-new" as WorkspaceId;
  const threadId = "thread-prefs-reused-id" as ThreadId;
  let resolveOldSave: ((response: Response) => void) | null = null;

  globalThis.fetch = (async () => await new Promise<Response>((resolve) => {
    resolveOldSave = resolve;
  })) as typeof fetch;

  store.patchThreadPrefs(threadId, { model: "gpt-5.5" }, oldWorkspaceId);
  const oldSave = store.saveThreadPrefs(ctx, oldWorkspaceId, threadId);
  await waitFor(() => resolveOldSave !== null, "old prefs save did not start");

  store.resetForWorkspace();
  store.patchThreadPrefs(threadId, { model: "gpt-5.6-terra" }, newWorkspaceId);
  resolveOldSave!(jsonResponse({ ok: true }));
  await oldSave;

  assert.deepEqual(store.pendingThreadPrefsByThreadId[String(threadId)], { model: "gpt-5.6-terra" });
  assert.deepEqual(store.threadPrefsByThreadId[String(threadId)], { model: "gpt-5.6-terra" });
});

test("workspace 重置后旧 prefs 失败不向新 scope 抛出错误", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const oldWorkspaceId = "client-a:workspace-stale-error-old" as WorkspaceId;
  const newWorkspaceId = "client-a:workspace-stale-error-new" as WorkspaceId;
  const threadId = "thread-prefs-stale-error" as ThreadId;
  let resolveOldSave: ((response: Response) => void) | null = null;

  globalThis.fetch = (async () => await new Promise<Response>((resolve) => {
    resolveOldSave = resolve;
  })) as typeof fetch;

  store.patchThreadPrefs(threadId, { model: "gpt-5.5" }, oldWorkspaceId);
  const oldSave = store.saveThreadPrefs(ctx, oldWorkspaceId, threadId);
  await waitFor(() => resolveOldSave !== null, "old prefs save did not start");

  store.resetForWorkspace();
  store.patchThreadPrefs(threadId, { model: "gpt-5.6-terra" }, newWorkspaceId);
  resolveOldSave!(jsonResponse({ ok: false, code: "CLIENT_ERROR", message: "旧 scope 失败" }, 502));
  await oldSave;

  assert.deepEqual(store.pendingThreadPrefsByThreadId[String(threadId)], { model: "gpt-5.6-terra" });
});

test("workspace 重置后旧 prefs 网络抛错不向新 scope 抛出错误", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const oldWorkspaceId = "client-a:workspace-network-error-old" as WorkspaceId;
  const newWorkspaceId = "client-a:workspace-network-error-new" as WorkspaceId;
  const threadId = "thread-prefs-network-error" as ThreadId;
  let rejectOldSave: ((error: unknown) => void) | null = null;

  globalThis.fetch = (async () => await new Promise<Response>((_resolve, reject) => {
    rejectOldSave = reject;
  })) as typeof fetch;

  store.patchThreadPrefs(threadId, { model: "gpt-5.5" }, oldWorkspaceId);
  const oldSave = store.saveThreadPrefs(ctx, oldWorkspaceId, threadId);
  await waitFor(() => rejectOldSave !== null, "old prefs save did not start");

  store.resetForWorkspace();
  store.patchThreadPrefs(threadId, { model: "gpt-5.6-terra" }, newWorkspaceId);
  rejectOldSave!(new Error("旧 scope network down"));
  await oldSave;

  assert.deepEqual(store.pendingThreadPrefsByThreadId[String(threadId)], { model: "gpt-5.6-terra" });
});

test("workspace prefs drain 等待旧 thread 在途写入并在失败后按冻结身份重试", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctxAtPatch = createApiContext();
  const ctxAtFlush = { ...createApiContext(), sessionToken: "session-new", ensureSession: async () => "session-new" };
  const workspaceId = "client-a:workspace-drain" as WorkspaceId;
  const threadId = "thread-prefs-drain-old" as ThreadId;
  const calls: Array<{ authorization: string | null; prefs: ThreadPrefs }> = [];
  let resolveFirst: ((response: Response) => void) | null = null;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as PendingFetch["body"];
    const headers = new Headers(init?.headers);
    calls.push({
      authorization: headers.get("authorization"),
      prefs: body.prefs,
    });
    if (calls.length === 1) {
      return await new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  store.patchThreadPrefs(threadId, { model: "gpt-5.5" }, workspaceId, { apiContext: ctxAtPatch });
  const firstSave = store.saveThreadPrefs(ctxAtPatch, workspaceId, threadId);
  await waitFor(() => calls.length === 1, "initial prefs save did not start");
  const drain = store.flushPendingThreadPrefs(ctxAtFlush, workspaceId);
  assert.ok(drain);
  let drainSettled = false;
  void drain!.then(() => { drainSettled = true; });
  await Promise.resolve();
  assert.equal(drainSettled, false);

  resolveFirst!(jsonResponse({ ok: false, code: "CLIENT_ERROR", message: "第一次失败" }, 502));
  await assert.rejects(firstSave, /第一次失败/u);
  await waitFor(() => calls.length === 2, "drain did not retry the failed prefs save");
  await drain;

  assert.equal(calls[0]?.authorization, "Bearer session-demo");
  assert.equal(calls[1]?.authorization, "Bearer session-demo");
  assert.deepEqual(calls[0]?.prefs, { model: "gpt-5.5" });
  assert.deepEqual(calls[1]?.prefs, { model: "gpt-5.5" });
  assert.equal(store.pendingThreadPrefsByThreadId[String(threadId)], undefined);
});

test("Composer debounce 使用调度时捕获的 thread scope", () => {
  assert.match(composerSource, /workspaceId: props\.workspaceId/u);
  assert.match(composerSource, /threadId: props\.threadId/u);
  assert.match(composerSource, /workspaceScopeToken: chat\.captureThreadDraftWorkspaceScopeToken\(\)/u);
  assert.match(composerSource, /setTimeout\(\(\) => \{[\s\S]*?const task = flushPrefsSave\(scope\);[\s\S]*?\}, 300\)/u);
  assert.match(
    composerSource,
    /chat\.saveThreadPrefs\(scope\.apiContext, scope\.workspaceId, scope\.threadId, \{/u,
  );
  assert.match(composerSource, /workspaceScopeToken: scope\.workspaceScopeToken/u);
  assert.match(composerSource, /freezeThreadPrefsApiContext\(ctx\.value\)/u);
  assert.match(composerSource, /chat\.patchThreadPrefs\(props\.threadId, patch, props\.workspaceId, \{ apiContext: ctx\.value \}\)/u);
  assert.match(composerSource, /const prefsTask = flushPendingPrefsForWorkspace\(\{ propagateError: true \}\)/u);
  assert.match(composerSource, /chat\.flushPendingThreadPrefs\(ctx\.value, props\.workspaceId, \{/u);
  assert.match(composerSource, /if \(!draftDirty\) \{[\s\S]*?return prefsTask\.finally\(/u);
  assert.match(composerSource, /Promise\.all\(\[prefsTask, draftTask\]\)/u);
  assert.match(composerSource, /const task = flushPrefsSave\(scope\);[\s\S]*?reportThreadPrefsSaveFailure\(scope, error\)/u);
  assert.doesNotMatch(
    composerSource,
    /chat\.saveThreadPrefs\(ctx\.value, props\.workspaceId, props\.threadId\)/u,
  );
});
