import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createPinia, setActivePinia } from "pinia";
import { computed, nextTick, reactive, ref, watch } from "vue";
import type { DesktopApiRequest, DesktopApiResponse, LoadThreadResponseBody, ThreadId, WorkspaceId, WorkspaceSummary } from "@codeflowai/shared";
import { createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";
import { shouldUseThreadOnlyActivationForRouteChange } from "../src/features/threads/primary-thread-selection.ts";
import { isDesktopWorkspace } from "../src/services/desktop.ts";
import { useChatStore } from "../src/store/chat.ts";
import { useComposerStore } from "../src/store/composer.ts";
import { useConfigStore } from "../src/store/config.ts";
import { useEngineStore } from "../src/store/engine.ts";
import { useReminderStore } from "../src/store/reminders.ts";
import { useWorkspacesStore } from "../src/store/workspaces.ts";
import { isSharedWorkspaceSelectionId, resolveStickyWorkspaceSelection } from "../src/utils/workspaceId.ts";

const workspaceId = "desktop:project" as WorkspaceId;
const threadId = "empty-thread" as ThreadId;
const secondWorkspaceId = "desktop:second" as WorkspaceId;
const thirdWorkspaceId = "desktop:third" as WorkspaceId;
const knownWorkspaces: WorkspaceSummary[] = [workspaceId, secondWorkspaceId, thirdWorkspaceId].map(id => ({
  id, title: id, path: `/projects/${id}`, createdAt: 1, updatedAt: 1, kind: "local", ownerClientId: "desktop",
}));

/** 手动控制传输完成时机，验证等待期间可见的真实 Store 状态。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** 运行真实激活和辅助刷新，保留相关 Store，只替换桌面传输及无关资源边界。 */
async function fixture(t: test.TestContext, options?: {
  engineStatus?: () => Promise<DesktopApiResponse>;
  request?: (request: DesktopApiRequest) => Promise<DesktopApiResponse | undefined>;
  workspaces?: WorkspaceSummary[];
  workspaceId?: WorkspaceId;
  connected?: boolean;
  settleInitially?: boolean;
  startupComplete?: boolean;
}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: DesktopApiRequest[] = [];
  let runtimeId = "runtime-1";
  let runtimeReady = true;
  const client = { clientId: "desktop", version: "test", connectedAt: 1, workspaceIds: knownWorkspaces.map(workspace => workspace.id) };
  const thread = { id: threadId, workspaceId, title: "空会话", engine: "codex" as const, threadType: "chat" as const,
    threadSubtype: null, sessionId: null, archived: false, pinnedAt: null, groupId: null, createdAt: 1, updatedAt: 1 };
  const reminderSummary = { workspaceId, pendingActionCount: 0, pendingReceiptCount: 0, updatedAt: null };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: runtimeReady ? "ready" : "stopped", requestId: runtimeId, releaseId: null, errorCode: null }),
    onEvent: () => () => {},
    /** 仅接受当前激活需要的本机请求，意外调用直接失败。 */
    request: async (request: DesktopApiRequest) => {
      requests.push(request);
      const response = await options?.request?.(request);
      if (response) return response;
      const targetWorkspaceId = request.body?.workspaceId as WorkspaceId ?? workspaceId;
      const targetThread = { ...thread, workspaceId: targetWorkspaceId,
        id: targetWorkspaceId === workspaceId ? threadId : `${targetWorkspaceId}-thread` as ThreadId };
      if (request.method === "runtime.info") return { status: 200, body: { ok: true, client } };
      if (request.method === "workspaces.list") return { status: 200, body: { ok: true, workspaces: knownWorkspaces } };
      if (request.method === "engines.status" && options?.engineStatus) return options.engineStatus();
      if (request.method === "engines.status") return { status: 200, body: { ok: true, engines: [], customModelsByEngine: {} } };
      if (request.method === "reminders.workspaceSummaries") return { status: 200, body: { ok: true, summaries: [reminderSummary] } };
      if (request.method === "reminders.items") return { status: 200, body: { ok: true, items: [], summary: reminderSummary } };
      if (request.method === "workspacePrefs.get") return { status: 200, body: { ok: true,
        prefs: [{ engine: "codex", workMode: "general", contextWindow: 64000, autoCompactPct: 80 }] } };
      if (request.method === "threads.list") return { status: 200, body: { ok: true, threads: [targetThread], nextCursor: null } };
      if (request.method === "threads.load") {
        const body: LoadThreadResponseBody = { thread: { ...targetThread, id: request.body?.threadId as ThreadId }, managedServices: null,
          draft: null, events: [], hasMore: false, oldestSeq: null, latestSeq: null, rawEventCount: 0, running: null, hasRealTurnActivity: false };
        return { status: 200, body: { ok: true, ...body } };
      }
      throw new Error(`unexpected desktop request: ${request.method}`);
    },
  } } });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("本机会话不能请求云端"); });
  setActivePinia(createPinia());
  const config = useConfigStore(), chat = useChatStore();
  const composer = useComposerStore(), engine = useEngineStore(), reminders = useReminderStore(), workspaces = useWorkspacesStore();
  workspaces.workspaces = options?.workspaces ?? knownWorkspaces.map(workspace => ({ ...workspace }));
  config.workspaceId = options?.workspaceId ?? workspaceId;
  config.connected = options?.connected ?? false;
  await config.refreshDesktopRuntime();
  const source = readFileSync(new URL("../src/composables/useAppShell.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("shell.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const shell = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "useAppShell") as ts.FunctionDeclaration;
  assert.ok(shell?.body);
  const names = ["currentAuthScopeKey", "buildShellReadScope", "cancelShellReadTask", "cancelRuntimeReads", "runShellReadTask", "buildWorkspaceActivationScope",
    "cancelWorkspaceActivationTask", "runWorkspaceActivationTask", "runWorkspaceHydrationCoordinator", "runVisibleThreadActivation",
    "fetchClientVersionInfo", "loadWorkspacePrefs", "refreshEngineStatus", "observeAuxiliaryRefresh", "startAuxiliaryRefresh",
    "ensureWorkspaceSelectionStable", "isSharedWorkspaceSelection"];
  const functions = names.map(name => {
    const declaration = shell.body!.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(declaration, name);
    return declaration.getText(ast);
  });
  const activationWatch = shell.body.statements.find(statement => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(ast) === "watch"
    && statement.getText(ast).includes("shouldUseThreadOnlyActivationForRouteChange"));
  assert.ok(activationWatch);
  const workspaceWatch = shell.body.statements.find(statement => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(ast) === "watch"
    && statement.getText(ast).includes('chat.resetForWorkspace("workspace-switch")'));
  assert.ok(workspaceWatch);
  const errors: unknown[] = [];
  const route = reactive({ currentRoute: { value: { name: "chat", fullPath: "/chat", query: {} } } });
  const requestedThreadId = ref<ThreadId>(threadId);
  const desktopStartupComplete = ref(options?.startupComplete ?? true);
  const presence = reactive({ captureActiveWorkspaceSnapshot: () => ({ state: "online" }), online: { onlineClients: [client] },
    activeWorkspaceRuntimeState: { kind: "none", status: "ready" } });
  const readinessCode = shell.body.statements.filter(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => ["localWorkspaceReady", "currentWorkspaceReady"].includes(declaration.name.getText(ast))))
    .map(statement => statement.getText(ast)).join("\n");
  const currentWorkspaceReady = new Function("config", "computed", "isDesktopWorkspace", "desktopStartupComplete", "presence",
    ts.transpile(`${readinessCode}\nreturn currentWorkspaceReady;`, { target: ts.ScriptTarget.ES2022 }))(config, computed, isDesktopWorkspace, desktopStartupComplete, presence);
  const localWorkspaceReady = computed(() => isDesktopWorkspace(config, config.workspaceId ?? ""));
  const workspaceSwitching = ref(false);
  const sandbox: Record<string, any> = {
    config, chat, composer, engine, reminders, console, watch: (...args: Parameters<typeof watch>) => {
      const stop = watch(...args);
      t.after(stop);
      return stop;
    },
    ctx: computed(() => ({ serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" })),
    requestJson: async (_ctx: unknown, request: { path: string }) => {
      assert.equal(request.path, "/api/status");
      return { ok: true, clientVersion: null, latestClientVersion: null, clients: [] };
    },
    resolveWorkspaceClientVersion: () => null, resolveWorkspaceClientInfo: () => null,
    currentWorkspaceReady, localWorkspaceReady, router: route, threadUrlTick: ref(0),
    isPaymentVerificationRoute: ref(false), workspaceSwitching,
    resolveRequestedThreadId: () => requestedThreadId.value, resolveRouteThreadId: () => requestedThreadId.value,
    resolveSharedThreadOnlyRelatedToMe: () => null, workspaces, isSharedWorkspaceSelectionId, resolveStickyWorkspaceSelection,
    ws: { replaceLocalWorkspaceSubscription: () => {} },
    presence,
    explorer: { resetForWorkspace: () => {} }, ui: { closeAllPreviewWindows: () => {} },
    markWorkspacePresenceFromCurrentSnapshot: () => ({ degraded: false }),
    settleRequestedThreadSelection: async (_key: string, _workspace: WorkspaceId, _route: ThreadId, requested: ThreadId) => {
      chat.selectThread(requested);
      return requested;
    },
    isDesktopWorkspace, shouldUseThreadOnlyActivationForRouteChange, AbortController,
    createCancelledRequestError, isCancelledRequestError, isWorkspaceClientOfflineError: () => false,
    trackProductEvent: () => {}, message: { error: (error: unknown) => errors.push(error) },
  };
  vm.runInNewContext(ts.transpileModule(`let workspaceActivationTask = null;
let activeWorkspaceActivationScopeKey = "";
const shellReadTasks = { clientVersion: null, workspacePrefs: null, engine: null };
const auxiliaryRefreshFailures = new WeakMap();
${functions.join("\n")}
${workspaceWatch.getText(ast)}
${activationWatch.getText(ast)}
globalThis.pendingActivation = () => workspaceActivationTask?.promise;
globalThis.cancelReads = () => { cancelWorkspaceActivationTask("component-unmount"); cancelRuntimeReads("component-unmount"); };
// 只观察真实在途读取，避免断言早于辅助刷新结束。
globalThis.pendingReads = () => Object.values(shellReadTasks).filter(Boolean).map(task => task.promise);
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  t.after(async () => {
    const activation = sandbox.pendingActivation(), reads = sandbox.pendingReads();
    sandbox.cancelReads();
    chat.resetForWorkspace("component-unmount");
    try {
      await activation;
      await Promise.all(reads);
    } finally {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
  /** 等激活和辅助读取完成，并确认所有相关 Store 已结束加载。 */
  const settle = async () => {
    await nextTick();
    await sandbox.pendingActivation();
    await Promise.all(sandbox.pendingReads());
    await nextTick();
    assert.deepEqual(errors, []);
    assert.equal(engine.loading || reminders.workspaceSummariesLoading || reminders.currentItemsLoading, false);
    assert.equal(engine.lastError, null);
    assert.equal(reminders.lastError, null);
  };
  if (options?.settleInitially !== false) await settle();
  return { config, chat, composer, engine, reminders, workspaces, workspaceSwitching, requestedThreadId, desktopStartupComplete, settle, requests, errors,
    pendingActivation: () => sandbox.pendingActivation() as Promise<void> | undefined,
    loads: () => requests.filter(request => request.method === "threads.load"),
    poll: async () => { await config.refreshDesktopRuntime(); await settle(); },
    restart: () => { runtimeId = "runtime-2"; },
    setReady: (value: boolean) => { runtimeReady = value; },
  };
}

for (const connected of [false, true]) test(`首次目录完成后自动加载恢复工作区的会话列表，云端已连接=${connected}`, async t => {
  const h = await fixture(t, { startupComplete: false, connected, workspaces: [] });
  assert.equal(h.config.localRuntimeReady, true);
  assert.deepEqual(h.requests.map(request => request.method), ["runtime.info"]);
  assert.equal(h.chat.threads.length, 0);
  h.workspaces.workspaces = knownWorkspaces.map(workspace => ({ ...workspace }));
  h.desktopStartupComplete.value = true;
  await h.settle();
  assert.equal(h.chat.threads[0]?.id, threadId);
  assert.equal(h.requests.filter(request => request.method === "threads.list").length, 1);
  assert.equal(h.requests.some(request => request.method === "workspaces.list"), false, "复用首次目录，不发起相互取消的第二轮目录读取");
  await h.poll();
  assert.equal(h.requests.filter(request => request.method === "threads.list").length, 1);
});

test("已知且本机可用的工作区不等待慢目录读取", async t => {
  const directory = deferred<void>();
  t.after(() => directory.resolve());
  const h = await fixture(t, { settleInitially: false, request: async request => {
    if (request.method === "workspaces.list") await directory.promise;
    return undefined;
  } });
  await new Promise(done => setImmediate(done));
  assert.equal(h.chat.threads[0]?.id, threadId);
  assert.equal(h.chat.loadedThreads[threadId], true);
  assert.equal(h.chat.workspaceActivation.degraded, false);
  await h.settle();
});

test("切区列表和选择就绪后解除遮罩，慢历史仍由原激活任务等待", async t => {
  const history = deferred<void>();
  t.after(() => history.resolve());
  const h = await fixture(t, { request: async request => {
    if (request.method === "threads.load" && request.body?.workspaceId === secondWorkspaceId) await history.promise;
    return undefined;
  } });
  h.config.workspaceId = secondWorkspaceId;
  h.requestedThreadId.value = `${secondWorkspaceId}-thread` as ThreadId;
  await new Promise(done => setImmediate(done));
  assert.equal(h.chat.threads[0]?.id, "desktop:second-thread");
  assert.equal(h.chat.selectedThreadId, "desktop:second-thread");
  assert.equal(h.workspaceSwitching.value, false);
  assert.equal(h.chat.threadLoading?.threadId, "desktop:second-thread");
  assert.equal(h.chat.workspaceActivation.phase, "critical");
  assert.ok(h.pendingActivation(), "历史仍须保持在原 owner 的在途激活任务里");
  history.resolve();
  await h.settle();
  assert.equal(h.chat.loadedThreads["desktop:second-thread"], true);
});

test("切区后的引擎目录不等待慢历史，切换会话打断历史也不会漏掉检测", async t => {
  const history = deferred<void>();
  t.after(() => history.resolve());
  const h = await fixture(t, { engineStatus: async () => ({ status: 200, body: { ok: true, engines: [{
    engineType: "codex", installed: true, version: "test", binPath: "codex", features: {}, error: null,
    models: [{ id: "codex-local", displayName: "Local", isDefault: true }],
  }] } }), request: async request => {
    if (request.method === "threads.load" && request.body?.workspaceId === secondWorkspaceId
      && request.body.threadId === "desktop:second-thread") await history.promise;
    return undefined;
  } });
  h.config.workspaceId = secondWorkspaceId;
  h.requestedThreadId.value = "desktop:second-thread" as ThreadId;
  await new Promise(done => setImmediate(done));
  assert.ok(h.engine.byWorkspaceId[secondWorkspaceId]?.lastUpdatedAt, "慢历史不能挡住本工作区引擎目录");
  assert.equal(h.engine.byTypeForWorkspace(secondWorkspaceId).get("codex")?.models[0]?.id, "codex-local");
  const previous = h.pendingActivation();
  h.requestedThreadId.value = "another-thread" as ThreadId;
  await new Promise(done => setImmediate(done));
  history.resolve();
  await previous;
  await h.settle();
  assert.equal(h.engine.activeWorkspaceId, secondWorkspaceId);
  assert.equal(h.requests.filter(request => request.method === "engines.status" && request.body?.workspaceId === secondWorkspaceId).length, 1);
});

test("轻量会话激活发现目录首次读取被取消时，沿原入口补齐检测", async t => {
  let attempts = 0;
  const h = await fixture(t, { engineStatus: async () => {
    if (++attempts === 1) throw createCancelledRequestError("reconnect-scope-change");
    return { status: 200, body: { ok: true, engines: [] } };
  } });
  assert.equal(h.engine.byWorkspaceId[workspaceId]?.lastUpdatedAt, null);
  h.requestedThreadId.value = "another-thread" as ThreadId;
  await h.settle();
  assert.ok(h.engine.byWorkspaceId[workspaceId]?.lastUpdatedAt);
});

test("切换会话后首次检测才取消，也应结算原请求后补查一次", async t => {
  const cancel = deferred<void>();
  t.after(() => cancel.resolve());
  let attempts = 0;
  const h = await fixture(t, { settleInitially: false, engineStatus: async () => {
    if (++attempts === 1) {
      await cancel.promise;
      throw createCancelledRequestError("reconnect-scope-change");
    }
    return { status: 200, body: { ok: true, engines: [] } };
  } });
  await new Promise(done => setImmediate(done));
  assert.equal(h.engine.byWorkspaceId[workspaceId]?.loading, true);
  h.requestedThreadId.value = "another-thread" as ThreadId;
  await new Promise(done => setImmediate(done));
  cancel.resolve();
  await new Promise(done => setImmediate(done));
  await h.settle();
  assert.ok(h.engine.byWorkspaceId[workspaceId]?.lastUpdatedAt);
  assert.equal(attempts, 2);
});

test("旧工作区首次检测迟到取消，不补查旧工作区或覆盖新目录", async t => {
  const cancel = deferred<void>();
  t.after(() => cancel.resolve());
  let attempts = 0;
  const h = await fixture(t, { settleInitially: false, engineStatus: async () => {
    if (++attempts === 1) {
      await cancel.promise;
      throw createCancelledRequestError("workspace-switch");
    }
    return { status: 200, body: { ok: true, engines: [] } };
  } });
  await new Promise(done => setImmediate(done));
  h.requestedThreadId.value = "another-thread" as ThreadId;
  await new Promise(done => setImmediate(done));
  h.config.workspaceId = secondWorkspaceId;
  h.requestedThreadId.value = "desktop:second-thread" as ThreadId;
  await new Promise(done => setImmediate(done));
  cancel.resolve();
  await h.settle();
  assert.equal(h.engine.activeWorkspaceId, secondWorkspaceId);
  assert.equal(h.requests.filter(request => request.method === "engines.status" && request.body?.workspaceId === workspaceId).length, 1);
});

test("切换会话复用首次检测时，一次失败只记录并提示一次且保留失败态", async t => {
  const response = deferred<DesktopApiResponse>();
  t.after(() => response.resolve({ status: 500, body: { ok: false, message: "engine probe failed" } }));
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const h = await fixture(t, { settleInitially: false, engineStatus: () => response.promise });
  await new Promise(done => setImmediate(done));
  h.requestedThreadId.value = "another-thread" as ThreadId;
  await new Promise(done => setImmediate(done));
  response.resolve({ status: 500, body: { ok: false, message: "engine probe failed" } });
  await new Promise(done => setImmediate(done));
  assert.equal(h.engine.byWorkspaceId[workspaceId]?.lastError, "engine probe failed");
  assert.equal(h.requests.filter(request => request.method === "engines.status").length, 1);
  assert.equal(h.errors.length, 1);
  assert.equal(logs.length, 1);
});

test("快速切区时旧历史迟到不能解除新列表遮罩或覆盖新工作区", async t => {
  const history = deferred<void>(), nextList = deferred<void>();
  t.after(() => { history.resolve(); nextList.resolve(); });
  const h = await fixture(t, { request: async request => {
    if (request.method === "threads.load" && request.body?.workspaceId === secondWorkspaceId) await history.promise;
    if (request.method === "threads.list" && request.body?.workspaceId === thirdWorkspaceId) await nextList.promise;
    return undefined;
  } });
  h.config.workspaceId = secondWorkspaceId;
  h.requestedThreadId.value = "desktop:second-thread" as ThreadId;
  await new Promise(done => setImmediate(done));
  const previousActivation = h.pendingActivation();
  h.config.workspaceId = thirdWorkspaceId;
  h.requestedThreadId.value = "desktop:third-thread" as ThreadId;
  await new Promise(done => setImmediate(done));
  assert.equal(h.workspaceSwitching.value, true);
  history.resolve();
  await previousActivation;
  await new Promise(done => setImmediate(done));
  assert.equal(h.workspaceSwitching.value, true);
  assert.equal(h.chat.workspaceActivation.workspaceId, thirdWorkspaceId);
  assert.equal(h.chat.threads.length, 0);
  assert.equal(h.chat.loadedThreads["desktop:second-thread"], undefined);
  nextList.resolve();
  await h.settle();
  assert.equal(h.workspaceSwitching.value, false);
  assert.equal(h.chat.selectedThreadId, "desktop:third-thread");
  assert.equal(h.chat.loadedThreads["desktop:third-thread"], true);
});

test("新工作区列表失败时显式失败，不能开始读取历史", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const list = deferred<void>();
  t.after(() => list.resolve());
  const h = await fixture(t, { request: async request => {
    if (request.method !== "threads.list" || request.body?.workspaceId !== secondWorkspaceId) return undefined;
    await list.promise;
    return { status: 500, body: { ok: false, message: "thread list failed" } };
  } });
  h.config.workspaceId = secondWorkspaceId;
  h.requestedThreadId.value = "desktop:second-thread" as ThreadId;
  await new Promise(done => setImmediate(done));
  assert.equal(h.workspaceSwitching.value, true);
  const activation = h.pendingActivation();
  list.resolve();
  await assert.rejects(activation!, /thread list failed/);
  await new Promise(done => setImmediate(done));
  assert.equal(h.workspaceSwitching.value, false);
  assert.equal(h.chat.threads.length, 0);
  assert.equal(h.chat.workspaceActivation.degraded, true);
  assert.equal(h.loads().some(request => request.body?.workspaceId === secondWorkspaceId), false);
  assert.match(String(h.errors[0]), /thread list failed/);
  assert.equal(logs.length, 1);
  assert.equal((logs[0]![1] as { workspaceId: string }).workspaceId, secondWorkspaceId);
});

test("解除列表遮罩后的历史失败仍交回激活 owner，保留明确错误", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const history = deferred<void>();
  t.after(() => history.resolve());
  const h = await fixture(t, { request: async request => {
    if (request.method !== "threads.load" || request.body?.workspaceId !== secondWorkspaceId) return undefined;
    await history.promise;
    return { status: 500, body: { ok: false, message: "thread history failed" } };
  } });
  h.config.workspaceId = secondWorkspaceId;
  h.requestedThreadId.value = "desktop:second-thread" as ThreadId;
  await new Promise(done => setImmediate(done));
  const activation = h.pendingActivation();
  assert.equal(h.workspaceSwitching.value, false);
  history.resolve();
  await assert.rejects(activation!, /thread history failed/);
  await new Promise(done => setImmediate(done));
  assert.equal(h.chat.threads[0]?.id, "desktop:second-thread");
  assert.equal(h.chat.loadedThreads["desktop:second-thread"], undefined);
  assert.equal(h.chat.workspaceActivation.degraded, true);
  assert.equal(h.chat.threadLoading, null);
  assert.match(String(h.errors[0]), /thread history failed/);
  assert.equal(logs.length, 1);
  assert.equal((logs[0]![1] as { threadId: string }).threadId, "desktop:second-thread");
});

for (const scenario of [
  { name: "未知本机", workspaceId, workspaces: [] },
  { name: "共享", workspaceId, workspaces: [{ ...knownWorkspaces[0]!, kind: "shared" as const }] },
  { name: "远程", workspaceId: "remote:project" as WorkspaceId,
    workspaces: [{ ...knownWorkspaces[0]!, id: "remote:project" as WorkspaceId, ownerClientId: "remote" }] },
]) {
  test(`${scenario.name}工作区仍等待目录归属校验，失败后不读取会话`, async t => {
    t.mock.method(console, "error", () => {});
    const directory = deferred<void>();
    t.after(() => directory.resolve());
    const h = await fixture(t, { ...scenario, connected: true, settleInitially: false, request: async request => {
      if (request.method !== "workspaces.list") return undefined;
      await directory.promise;
      return { status: 403, body: { ok: false, code: "FORBIDDEN", message: "workspace ownership denied" } };
    } });
    await new Promise(done => setImmediate(done));
    assert.equal(h.workspaces.loading, true);
    assert.equal(h.chat.threads.length, 0);
    assert.equal(h.loads().length, 0);
    const activation = h.pendingActivation();
    directory.resolve();
    await assert.rejects(activation!, /workspace ownership denied/);
    await new Promise(done => setImmediate(done));
    assert.equal(h.chat.workspaceActivation.degraded, true);
    assert.equal(h.chat.threads.length, 0);
    assert.match(String(h.errors[0]), /workspace ownership denied/);
  });
}

test("引擎探测未完成时，会话列表和当前会话仍先完成激活", async t => {
  let resolve!: (value: DesktopApiResponse) => void;
  const pending = new Promise<DesktopApiResponse>(done => { resolve = done; });
  t.after(() => resolve({ status: 200, body: { ok: true, engines: [] } }));
  const h = await fixture(t, { engineStatus: () => pending, settleInitially: false });
  await new Promise(done => setImmediate(done));
  assert.equal(h.chat.threads[0]?.id, threadId);
  assert.equal(h.chat.loadedThreads[threadId], true);
  assert.equal(h.chat.workspaceActivation.phase, "settled");
  assert.equal(h.engine.loading, true);
  resolve({ status: 200, body: { ok: true, engines: [] } });
  await h.settle();
});

test("引擎刷新失败保留明确错误，已经激活的本机会话继续可读", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const h = await fixture(t, { engineStatus: async () => ({ status: 500, body: { ok: false, message: "engine probe failed" } }), settleInitially: false });
  await new Promise(done => setImmediate(done));
  await h.pendingActivation();
  assert.equal(h.chat.threads[0]?.id, threadId);
  assert.equal(h.chat.loadedThreads[threadId], true);
  assert.equal(h.chat.workspaceActivation.degraded, false);
  assert.match(h.engine.lastError!, /engine probe failed/);
  assert.equal(h.errors.length, 1);
  assert.equal(logs.length, 1);
  assert.equal((logs[0]![1] as { operation: string }).operation, "engineStatus");
});

test("空会话成功加载后，相同桌面快照轮询不重读历史或再次进入加载态", async t => {
  const h = await fixture(t);
  assert.equal(h.loads().length, 1);
  assert.equal(h.chat.loadedThreads[threadId], true);
  assert.equal(h.chat.conversations[threadId]?.items.length, 0);
  assert.equal(h.engine.activeWorkspaceId, workspaceId);
  assert.equal(h.reminders.currentWorkspaceId, workspaceId);
  assert.equal(h.composer.getContextWindow(workspaceId, "codex"), 64000);
  assert.equal(h.composer.getAutoCompactPct(workspaceId, "codex"), 80);
  let loadingTransitions = 0;
  const stop = watch(() => h.chat.threadLoading, value => { if (value) loadingTransitions++; }, { flush: "sync" });
  t.after(stop);
  for (let i = 0; i < 3; i++) await h.poll();
  assert.equal(h.loads().length, 1, "相同运行态不应强制重读空历史");
  assert.equal(loadingTransitions, 0, "空会话不应反复显示读取事件中");
  assert.equal(h.chat.threadContentEpochByThreadId[threadId], 1);
});

test("运行时真正换代后，空会话仍重新加载一次权威历史", async t => {
  const h = await fixture(t);
  h.restart();
  await h.poll();
  assert.equal(h.loads().length, 2);
  await h.poll();
  assert.equal(h.loads().length, 2);
});

test("本机断开后恢复就绪，空会话重新读取且后续轮询保持稳定", async t => {
  const h = await fixture(t);
  h.setReady(false);
  await h.poll();
  assert.equal(h.loads().length, 1);
  h.setReady(true);
  await h.poll();
  assert.equal(h.loads().length, 2);
  await h.poll();
  assert.equal(h.loads().length, 2);
});

test("显式刷新和切换会话继续触发原历史读取", async t => {
  const h = await fixture(t);
  h.chat.requestWorkspaceHydration();
  await h.settle();
  assert.equal(h.loads().length, 2);
  h.requestedThreadId.value = "another-empty-thread" as ThreadId;
  await h.settle();
  assert.equal(h.loads().length, 3);
  assert.equal(h.loads().at(-1)?.body?.threadId, "another-empty-thread");
});
