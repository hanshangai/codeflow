import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import dayjs from "dayjs";
import ts from "typescript";
import * as vue from "vue";

import { createPinia, setActivePinia } from "pinia";
import type {
  ClientId,
  ClientDbCleanupStatus,
  ClientDbStorageSummary,
  ManagedServiceSnapshot,
  ThreadDraft,
  ThreadFileChangeSummary,
  ThreadId,
  ThreadSummary,
  WorkspaceId,
} from "@codeflowai/shared";

import { createApiResultError, isCancelledRequestError, type ApiRequestContext } from "../src/api/request.ts";
import { getClientDbCleanupStatus, startClientDbCleanup } from "../src/api/threads/index.ts";
import { useChatStore } from "../src/store/chat.ts";

const originalFetch = globalThis.fetch;

/** 读取 Client 历史清理弹窗源码，锁定最小交互与真实文案。 */
function readCleanupModalSource(): string {
  return readFileSync(new URL("../src/features/settings/components/client-data-cleanup-modal.vue", import.meta.url), "utf8");
}

/** 构造完整的 Client 权威清理状态，不从前端状态推算结果。 */
function cleanupStorage(status: ClientDbCleanupStatus, error: string | null = null): ClientDbStorageSummary {
  return {
    databaseBytes: 10_000, reusableBytes: 4_000, liveBytes: 6_000,
    cleanup: {
      jobId: "cleanup-demo", status, phase: null, inactiveBefore: 1_789_401_600_000,
      startedAt: 1, finishedAt: null, currentThreadId: null, selectedThreadCount: 0,
      processedThreadCount: 0, skippedThreadCount: 0, batchCount: 0,
      deletedConversationEventCount: 0, deletedRawEngineEventCount: 0,
      deletedPromptSnapshotCount: 0, deletedFileBlobCount: 0, deletedFileBlobBytes: 0,
      reusableBytesBefore: 4_000, reusableBytesAfter: null, error,
    },
  };
}

/** 执行清理弹窗真实 setup；只替换 API、确认对话框和计时器。 */
function cleanupModalFixture(t: test.TestContext) {
  const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
  const script = ts.transpileModule(compileScript(parse(readCleanupModalSource()).descriptor, { id: "cleanup-lifecycle" }).content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const props = vue.reactive({ clientId: "client-a", open: true, disabled: false });
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const beforeUnmount: (() => void)[] = [];
  const errors: string[] = [], successes: string[] = [];
  const confirmations: { onOk: () => Promise<void>; content: string }[] = [];
  const statusRequests: { clientId: string; signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const startRequests: { body: { clientId: string; inactiveBefore: number }; resolve: (value: unknown) => void }[] = [];
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, any> } } };
  new Function("require", "module", "exports", "setTimeout", "clearTimeout", script)((id: string) => {
    if (id === "vue") return { ...vue, onBeforeUnmount: (callback: () => void) => beforeUnmount.push(callback) };
    if (id === "dayjs") return { default: dayjs };
    if (id === "ant-design-vue") return {
      Modal: { confirm: (options: typeof confirmations[number]) => confirmations.push(options) },
      message: { error: (text: string) => errors.push(text), success: (text: string) => successes.push(text) },
    };
    if (id === "@ant-design/icons-vue") return {};
    if (id === "../../../composables/useApiContext") return { useApiContext: () => ({ ctx: vue.ref({}) }) };
    if (id === "../../../api/request") return { createApiResultError, isCancelledRequestError };
    if (id === "../../../api/threads") return {
      getClientDbCleanupStatus: (_ctx: unknown, clientId: string, { signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => statusRequests.push({ clientId, signal, resolve, reject })),
      startClientDbCleanup: (_ctx: unknown, body: typeof startRequests[number]["body"]) => new Promise(resolve => startRequests.push({ body, resolve })),
    };
    throw new Error(`unexpected cleanup modal import: ${id}`);
  }, module, module.exports,
  (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
  (id: number) => timers.delete(id));
  const scope = vue.effectScope();
  const state = scope.run(() => module.exports.default.setup(props, { expose() {}, emit() {} }))!;
  t.after(() => { beforeUnmount.forEach(callback => callback()); scope.stop(); });
  return { props, timers, state, statusRequests, startRequests, confirmations, errors, successes };
}

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

/** 构造会话列表所需的最小摘要。 */
function createThreadSummary(threadId: string): ThreadSummary {
  return {
    id: threadId as ThreadId,
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

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("client database cleanup API uses one GET/POST resource and the inactive cutoff", async () => {
  const ctx = createApiContext();
  const clientId = "client-a" as ClientId;
  const inactiveBefore = 1_789_401_600_000;
  const requestedPaths: string[] = [];
  const requestedBodies: unknown[] = [];
  const requestSignals: Array<AbortSignal | null | undefined> = [];
  const storage = {
    databaseBytes: 10_000,
    reusableBytes: 4_000,
    liveBytes: 6_000,
    cleanup: {
      jobId: "cleanup-demo",
      status: "queued",
      phase: null,
      inactiveBefore,
      startedAt: 1,
      finishedAt: null,
      currentThreadId: null,
      selectedThreadCount: 0,
      processedThreadCount: 0,
      skippedThreadCount: 0,
      batchCount: 0,
      deletedConversationEventCount: 0,
      deletedRawEngineEventCount: 0,
      deletedPromptSnapshotCount: 0,
      deletedFileBlobCount: 0,
      deletedFileBlobBytes: 0,
      reusableBytesBefore: 4_000,
      reusableBytesAfter: null,
      error: null,
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requestedPaths.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    requestSignals.push(init?.signal);
    if (init?.body) requestedBodies.push(JSON.parse(String(init.body)));
    return jsonResponse({ ok: true, storage });
  }) as typeof fetch;

  const controller = new AbortController();
  const statusResult = await getClientDbCleanupStatus(ctx, clientId, { signal: controller.signal });
  const startResult = await startClientDbCleanup(ctx, { clientId, inactiveBefore });

  assert.equal(statusResult.ok && statusResult.storage.cleanup.status, "queued");
  assert.equal(startResult.ok && startResult.storage.cleanup.inactiveBefore, inactiveBefore);
  assert.deepEqual(requestedPaths, [
    "GET /api/client-db/cleanup?clientId=client-a",
    "POST /api/client-db/cleanup",
  ]);
  assert.deepEqual(requestedBodies, [{ clientId, inactiveBefore }]);
  assert.ok(requestSignals[0], "status request should carry a cancellation signal");
});

test("cleanup modal keeps only a local-day cutoff, truthful logical-space copy, and active-job polling", () => {
  const source = readCleanupModalSource();

  assert.match(source, /cleanupDate\.value\.startOf\("day"\)\.valueOf\(\)/);
  assert.match(source, /disableFutureDate/);
  assert.match(source, /将被永久删除/);
  assert.match(source, /空间已转为数据库内部可复用空间/);
  assert.match(source, /label="数据库文件"/);
  assert.match(source, /label="数据库内部可复用空间"/);
  assert.match(source, /cleanupStatus\.value === "queued" \|\| cleanupStatus\.value === "running"/);
  assert.match(source, /if \(!props\.open \|\| props\.disabled \|\| !cleanupActive\.value\) return;/);
  assert.match(source, /const POLL_INTERVAL_MS = 2_000;/);
  assert.match(source, /setTimeout\(\(\) => \{/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /controller\?\.abort\(\)/);
  assert.match(source, /if \(!value && starting\.value\) return;/);
  assert.match(source, /:closable="!starting"/);
  assert.doesNotMatch(source, /setInterval\(/);
  assert.doesNotMatch(source, /previewThreadCleanup|batchDeleteThreads|startClientDbCompaction|getClientDbStorageStatus/);
  assert.doesNotMatch(source, /<a-table|<a-steps|<a-progress|压缩数据库/);
});

test("cleanup confirmation submits local midnight and a late ACK cannot restart polling after close", async t => {
  const f = cleanupModalFixture(t);
  assert.equal(f.statusRequests[0].clientId, "client-a");
  f.statusRequests[0].resolve({ ok: true, storage: cleanupStorage("idle") });
  await vue.nextTick();
  f.state.cleanupDate.value = dayjs("2026-09-15T15:45:00");
  assert.equal(f.state.disableFutureDate(dayjs().add(1, "day")), true);
  assert.equal(f.state.disableFutureDate(dayjs()), false);
  f.state.confirmCleanup();
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0].content, /永久删除/);
  const pending = f.confirmations[0].onOk();
  assert.deepEqual(f.startRequests[0].body, {
    clientId: "client-a", inactiveBefore: new Date(2026, 8, 15).getTime(),
  });
  f.props.open = false;
  await vue.nextTick();
  f.startRequests[0].resolve({ ok: true, storage: cleanupStorage("queued") });
  await pending;
  assert.equal(f.timers.size, 0);
  assert.equal(f.state.storage.value.cleanup.status, "idle", "迟到 ACK 不覆盖已关闭范围");
  assert.deepEqual(f.successes, []);
});

test("cleanup status failure stops polling and blocks cleanup side effects", async t => {
  const f = cleanupModalFixture(t);
  f.statusRequests[0].resolve({ ok: true, storage: cleanupStorage("running") });
  await vue.nextTick();
  assert.equal(f.timers.size, 1);
  const pending = f.state.loadCleanupStatus();
  assert.equal(f.timers.size, 0);
  f.statusRequests[1].reject(new Error("database unavailable"));
  await pending;
  assert.equal(f.state.statusError.value, "database unavailable");
  assert.equal(f.state.statusLoading.value, false);
  assert.deepEqual(f.errors, ["database unavailable"]);
  assert.equal(f.timers.size, 0);
  const recovered = f.state.loadCleanupStatus();
  f.statusRequests[2].resolve({ ok: true, storage: cleanupStorage("idle") });
  await recovered;
  f.state.cleanupDate.value = dayjs("2026-09-15");
  assert.equal(f.state.canStartCleanup.value, true, "恢复后允许为有效日期启动清理");
  const failedAgain = f.state.loadCleanupStatus();
  f.statusRequests[3].reject(new Error("status unavailable"));
  await failedAgain;
  assert.equal(f.state.canStartCleanup.value, false);
  f.state.confirmCleanup();
  await f.state.runCleanup(new Date(2026, 8, 15).getTime());
  assert.deepEqual(f.confirmations, []);
  assert.deepEqual(f.startRequests, []);
  assert.deepEqual(f.successes, []);
});

test("cleanup start rejection preserves the error without reporting success or polling", async t => {
  const f = cleanupModalFixture(t);
  f.statusRequests[0].resolve({ ok: true, storage: cleanupStorage("idle") });
  await vue.nextTick();
  f.state.cleanupDate.value = dayjs("2026-09-15");
  const pending = f.state.runCleanup(new Date(2026, 8, 15).getTime());
  assert.equal(f.startRequests.length, 1);
  f.startRequests[0].resolve({ ok: false, code: "CLIENT_DB_CLEANUP_FAILED", message: "cleanup rejected", requestId: "request-cleanup" });
  await pending;
  assert.equal(f.state.statusError.value, "cleanup rejected");
  assert.equal(f.state.starting.value, false);
  assert.equal(f.state.storage.value.cleanup.status, "idle");
  assert.equal(f.state.canStartCleanup.value, false);
  assert.deepEqual(f.errors, ["cleanup rejected"]);
  assert.deepEqual(f.successes, []);
  assert.equal(f.timers.size, 0);
});

test("cleanup close aborts an in-flight status read and keeps failed background jobs visible", async t => {
  const f = cleanupModalFixture(t);
  f.props.open = false;
  await vue.nextTick();
  assert.equal(f.statusRequests[0].signal.aborted, true);
  f.statusRequests[0].resolve({ ok: true, storage: cleanupStorage("running") });
  await vue.nextTick();
  assert.equal(f.state.storage.value, null);
  assert.equal(f.timers.size, 0);
  f.props.open = true;
  await vue.nextTick();
  f.statusRequests[1].resolve({ ok: true, storage: cleanupStorage("failed", "batch delete failed") });
  await vue.nextTick();
  assert.equal(f.state.cleanupAlertType.value, "error");
  assert.equal(f.state.cleanupStatusMessage.value, "清理失败");
  assert.equal(f.state.cleanupStatusDescription.value, "batch delete failed");
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.successes, []);
});

test("history_cleaned drops only history and session projection while preserving thread metadata", () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const threadId = "thread-history-cleaned";
  const id = threadId as ThreadId;
  const summary = createThreadSummary(threadId);
  const fileChanges = { loading: true, items: [{ path: "demo.ts" }] } as any;

  store.threads = [summary];
  store.selectedThreadId = id;
  store.extraThreadSummariesById[threadId] = summary;
  store.loadedThreads[threadId] = true;
  store.threadLoadMetaByThreadId[threadId] = {
    limit: 500,
    loadedEvents: 1,
    hasMore: false,
    oldestLoadedSeq: 1,
    loadingMore: false,
  };
  store.fileChangesByThreadId[threadId] = fileChanges;
  store.threadPrefsByThreadId[threadId] = { model: "demo" };
  store.threadBasePrefsByThreadId[threadId] = { model: "base" };
  store.threadDraftByThreadId[threadId] = { version: 1 } as any;
  store.threadManagedServicesScopeByThreadId[threadId] = { visible: true, threadId: id };
  store.managedServicesByThreadId[threadId] = {
    loading: true,
    items: [{ serviceId: "service-old" }],
    error: null,
    version: 5,
    refreshTick: 7,
    hydrated: true,
    stale: false,
  } as any;
  store.threadContentEpochByThreadId[threadId] = 3;
  const conversation = store.ensureConversation(id);
  conversation.engineSessionId = "session-demo";
  conversation.items = [{ kind: "systemNotice", id: "notice-demo" } as any];

  const shouldHydrate = store.handleThreadChangedFromServer({
    workspaceId: "client-a:workspace-a" as WorkspaceId,
    threadId: id,
    kind: "history_cleaned",
    patch: null,
  });

  assert.equal(shouldHydrate, false);
  assert.equal(store.selectedThreadId, id);
  assert.deepEqual(store.threads, [summary]);
  assert.equal(store.loadedThreads[threadId], undefined);
  assert.equal(store.threadLoadMetaByThreadId[threadId], undefined);
  assert.deepEqual(conversation.items, []);
  assert.equal(conversation.engineSessionId, null);
  assert.deepEqual(store.fileChangesByThreadId[threadId], fileChanges);
  assert.deepEqual(store.threadPrefsByThreadId[threadId], { model: "demo" });
  assert.deepEqual(store.threadBasePrefsByThreadId[threadId], { model: "base" });
  assert.deepEqual(store.threadDraftByThreadId[threadId], { version: 1 });
  assert.deepEqual(store.threadManagedServicesScopeByThreadId[threadId], { visible: true, threadId: id });
  assert.deepEqual(store.managedServicesByThreadId[threadId], {
    loading: false,
    items: [],
    error: null,
    version: 0,
    refreshTick: 8,
    hydrated: false,
    stale: true,
  });
  assert.deepEqual(store.extraThreadSummariesById[threadId], summary);
  assert.equal(store.threadContentEpochByThreadId[threadId], 4);
});

test("history_cleaned does not cancel in-flight prefs, draft, or file-change reads", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:workspace-a" as WorkspaceId;
  const threadId = "thread-history-read-scope" as ThreadId;
  const pending = new Map<string, { resolve: (response: Response) => void; signal: AbortSignal | null }>();

  store.threads = [createThreadSummary(String(threadId))];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    return await new Promise<Response>((resolve) => {
      pending.set(path, { resolve, signal: init?.signal ?? null });
    });
  }) as typeof fetch;

  const prefsRead = store.refreshThreadPrefs(ctx, workspaceId, threadId);
  const draftRead = store.getThreadDraft(ctx, workspaceId, threadId, { force: true });
  const fileChangesRead = store.refreshThreadFileChanges(ctx, { workspaceId, threadId });
  for (let attempt = 0; attempt < 10 && pending.size < 3; attempt += 1) await Promise.resolve();
  assert.equal(pending.size, 3);

  store.handleThreadChangedFromServer({ workspaceId, threadId, kind: "history_cleaned", patch: null });
  for (const request of pending.values()) assert.equal(request.signal?.aborted, false);

  const draft: ThreadDraft = {
    text: "保留草稿",
    images: [],
    files: [],
    version: 2,
    updatedAt: 3,
    updatedByWebSessionId: "web-demo",
  };
  const fileChange: ThreadFileChangeSummary = {
    path: "demo.ts",
    status: "modified",
    lastTurnId: "turn-demo" as ThreadFileChangeSummary["lastTurnId"],
    lastChangedAt: 4,
    canUndo: true,
    stepKey: null,
    isAccepted: false,
    acceptedBlobId: null,
  };
  pending.get("/api/threads/prefs")?.resolve(jsonResponse({ ok: true, prefs: { model: "demo-model" } }));
  pending.get("/api/threads/draft/get")?.resolve(jsonResponse({ ok: true, draft }));
  pending.get("/api/threads/file-changes/list")?.resolve(jsonResponse({ ok: true, items: [fileChange] }));

  await Promise.all([prefsRead, draftRead, fileChangesRead]);
  assert.deepEqual(store.threadPrefsByThreadId[String(threadId)], { model: "demo-model" });
  assert.deepEqual(store.threadDraftByThreadId[String(threadId)], draft);
  assert.deepEqual(store.fileChangesByThreadId[String(threadId)]?.items, [fileChange]);
  assert.equal(store.fileChangesByThreadId[String(threadId)]?.loading, false);
});

test("history_cleaned rejects a stale managed-services response without dropping its scope", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:workspace-a" as WorkspaceId;
  const threadId = "thread-managed-services-scope" as ThreadId;
  let resolveRequest!: ((response: Response) => void);
  let requestSignal!: AbortSignal | null;

  store.threadManagedServicesScopeByThreadId[String(threadId)] = { visible: true, threadId };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? null;
    return await new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
  }) as typeof fetch;

  const read = store.refreshThreadManagedServices(ctx, { workspaceId, threadId, force: true });
  for (let attempt = 0; attempt < 10 && !resolveRequest; attempt += 1) await Promise.resolve();
  assert.ok(resolveRequest);

  store.handleThreadChangedFromServer({ workspaceId, threadId, kind: "history_cleaned", patch: null });
  assert.equal(requestSignal?.aborted, true);
  const staleService: ManagedServiceSnapshot = {
    serviceId: "service-old",
    status: "ready",
    pid: 123,
    command: "node",
    args: [],
    workingDirectory: "Z:/code/aidt-code",
    startupTimeoutMs: 10_000,
    readySummary: "ready",
    startedAt: 1,
    readyAt: 2,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
  };
  resolveRequest(jsonResponse({ ok: true, items: [staleService] }));
  await read;

  assert.deepEqual(store.threadManagedServicesScopeByThreadId[String(threadId)], { visible: true, threadId });
  assert.deepEqual(store.managedServicesByThreadId[String(threadId)]?.items, []);
  assert.equal(store.managedServicesByThreadId[String(threadId)]?.loading, false);
  assert.equal(store.managedServicesByThreadId[String(threadId)]?.refreshTick, 1);
  assert.equal(store.managedServicesByThreadId[String(threadId)]?.stale, true);
});

test("deleted thread broadcasts still remove the ordinary local thread projection", () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const threadId = "thread-broadcast-delete";
  const id = threadId as ThreadId;
  store.threads = [createThreadSummary(threadId)];
  store.selectedThreadId = id;
  store.syncPrimaryThreadUrl = (() => {}) as typeof store.syncPrimaryThreadUrl;
  store.ensureConversation(id);
  store.loadedThreads[threadId] = true;
  store.fileChangesByThreadId[threadId] = { items: [{ path: "demo.ts" }] } as any;

  const shouldHydrate = store.handleThreadChangedFromServer({
    workspaceId: "client-a:workspace-a" as WorkspaceId,
    threadId: id,
    kind: "deleted",
    patch: null,
  });

  assert.equal(shouldHydrate, false);
  assert.deepEqual(store.threads, []);
  assert.equal(store.selectedThreadId, null);
  assert.equal(store.conversations[threadId], undefined);
  assert.equal(store.loadedThreads[threadId], undefined);
  assert.equal(store.fileChangesByThreadId[threadId], undefined);
});

test("delete refresh does not re-add a thread from a stale list response", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:workspace-delete-refresh" as WorkspaceId;
  const threadId = "thread-delete-refresh" as ThreadId;
  const summary = createThreadSummary(threadId);
  store.threads = [summary];
  store.selectedThreadId = threadId;
  store.syncPrimaryThreadUrl = (() => {}) as typeof store.syncPrimaryThreadUrl;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/threads/delete") return jsonResponse({ ok: true });
    if (path === "/api/threads") return jsonResponse({ ok: true, threads: [summary], hasMore: false, nextCursor: null });
    throw new Error(`unexpected request: ${path}`);
  }) as typeof fetch;

  await store.deleteThread(ctx, { workspaceId, threadId });

  assert.deepEqual(store.threads, []);
  assert.equal(store.selectedThreadId, null);
});
