import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { applyEngineEventToConversation, buildThreadPresentation, createConversationState, type DesktopApiRequest, type EngineEventEnvelope, type ThreadId, type WorkspaceId } from "@codeflowai/shared";
import { useChatStore } from "../src/store/chat.ts";
import { useConfigStore } from "../src/store/config.ts";
import { createProcessDetailsLoader } from "../src/features/chat/processDetails.ts";
import type { ThreadProcessDetails } from "@codeflowai/shared";
import type { EngineEventEnvelope } from "@codeflowai/shared";
import { createWebSocketClient } from "../src/services/ws.ts";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import * as vue from "vue";
import * as threadApi from "../src/api/threads/index.ts";
import * as requestApi from "../src/api/request.ts";
import * as renderNodes from "../src/features/messages/assistantRenderNodes.ts";
import * as prepareItems from "../src/features/messages/prepareConversationItems.ts";
import { useApiContext } from "../src/composables/useApiContext.ts";

const workspaceId = "desktop:lazy" as WorkspaceId;
const threadId = "lazy-thread" as ThreadId;

test("浏览器 Pinia devtools 的 action 代理共享面板登记并正确清理", () => {
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000,
    input: `
      globalThis.window = { location: new URL("file:///desktop-test") };
      const assert = (await import("node:assert/strict")).default;
      const { createApp } = await import("vue");
      const { createPinia } = await import("pinia");
      const { useChatStore } = await import("./src/store/chat.ts");
      const pinia = createPinia();
      createApp({}).use(pinia);
      const chat = useChatStore(pinia);
      const surface = { workspaceId: "workspace", threadId: "thread" };
      const first = {}, second = {};
      chat.setThreadPresentationSurface(first, surface);
      assert.equal(chat.isThreadPresentationVisible("workspace", "thread"), true);
      chat.setThreadPresentationSurface(second, surface);
      chat.setThreadPresentationSurface(first, null);
      assert.equal(chat.isThreadPresentationVisible("workspace", "thread"), true);
      chat.setThreadPresentationSurface(second, null);
      assert.equal(chat.isThreadPresentationVisible("workspace", "thread"), false);
      chat.setThreadPresentationSurface(first, surface);
      chat.handleThreadChangedFromServer({ threadId: "thread", kind: "deleted" });
      assert.equal(chat.isThreadPresentationVisible("workspace", "thread"), false);
      chat.setThreadPresentationSurface(first, surface);
      chat.resetForWorkspace();
      assert.equal(chat.isThreadPresentationVisible("workspace", "thread"), false);
    `,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

/** 真实 WS/Pinia 传输桩仅替代 IPC，验证隐藏面板不发完整展示请求。 */
function presentationTransport(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: DesktopApiRequest[] = [];
  let version = 10;
  let response: Promise<unknown> | null = null;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    codeflowDesktop: { getState: async () => ({ status: "ready" }), request: async (request: DesktopApiRequest) => {
      requests.push(request);
      assert.equal(request.method, "threads.presentation");
      return response ?? { status: 200, body: { ok: true, presentation: buildThreadPresentation(createConversationState(threadId), version) } };
    } },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore(), chat = useChatStore();
  config.workspaceId = workspaceId;
  config.desktopRuntime = { status: "ready", requestId: "local", releaseId: null, errorCode: null };
  config.desktopClient = { clientId: "desktop", name: "本机", version: "1", platform: "win32", arch: "x64", connectedAt: 1, workspaceIds: [workspaceId] };
  const errors: string[] = [];
  const ws = createWebSocketClient({ config, chat, presence: {} as never, engine: {} as never, onError: error => errors.push(error) });
  t.after(ws.disconnect);
  ws.replaceLocalWorkspaceSubscription(workspaceId);
  chat.loadedThreads[threadId] = true;
  chat.threadPresentationVersionByThreadId[threadId] = 1;
  return { chat, ws, requests, errors,
    setVersion: (next: number) => { version = next; },
    setResponse: (next: Promise<unknown>) => { response = next; },
    flush: async () => { t.mock.timers.tick(200); await new Promise(resolve => setImmediate(resolve)); },
    ctx: { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" },
  };
}

test("快照在途的新通知不拒绝本次有效响应，接续读取追上最新版本", async t => {
  const f = presentationTransport(t);
  f.chat.setThreadPresentationSurface({}, { workspaceId, threadId });
  let first!: (value: unknown) => void, second!: (value: unknown) => void;
  f.setResponse(new Promise(resolve => { first = resolve; }));
  f.ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: 10 });
  await f.flush();
  f.ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: 20 });
  f.setResponse(new Promise(resolve => { second = resolve; }));
  first({ status: 200, body: { ok: true, presentation: buildThreadPresentation(createConversationState(threadId), 10) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.chat.threadPresentationVersionByThreadId[threadId], 10, "返回版本覆盖请求起点即可展示");
  assert.equal(f.chat.threadPresentationRequiredVersionByThreadId[threadId], 20);
  assert.equal(f.requests.length, 2, "同一读取流水线串行追赶，不等待下一条通知");
  second({ status: 200, body: { ok: true, presentation: buildThreadPresentation(createConversationState(threadId), 20) } });
  await f.flush();
  assert.equal(f.chat.threadPresentationVersionByThreadId[threadId], 20);
  assert.equal(f.chat.threadPresentationErrorByThreadId[threadId], undefined);
  assert.deepEqual(f.errors, []);
});

test("重新展示的主动读取在没有后续 WS 调度时仍串行补齐在途积累版本", async t => {
  const f = presentationTransport(t);
  f.chat.setThreadPresentationSurface({}, { workspaceId, threadId });
  f.chat.requireThreadPresentationVersion(threadId, 10);
  let first!: (value: unknown) => void;
  f.setResponse(new Promise(resolve => { first = resolve; }));
  const refreshing = f.chat.refreshThreadPresentation(f.ctx, { workspaceId, threadId, visibleOnly: true });
  await new Promise(resolve => setImmediate(resolve));
  const higherVersion = f.chat.refreshThreadPresentation(f.ctx, { workspaceId, threadId, version: 20, visibleOnly: true });
  f.setResponse(Promise.resolve({ status: 200, body: { ok: true,
    presentation: buildThreadPresentation(createConversationState(threadId), 20) } }));
  first({ status: 200, body: { ok: true, presentation: buildThreadPresentation(createConversationState(threadId), 10) } });
  await Promise.all([refreshing, higherVersion]);
  assert.equal(f.requests.length, 2);
  assert.equal(f.chat.threadPresentationVersionByThreadId[threadId], 20);
  assert.equal(f.chat.threadPresentationErrorByThreadId[threadId], undefined);
});

test("隐藏会话只累积展示版本和资源副作用，重新可见补读权威快照", async t => {
  const f = presentationTransport(t);
  f.chat.selectedThreadId = threadId;
  f.ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: 10,
    toolCompleted: { seq: 10, toolName: "Write", hasFileChanges: true, managedServicesChanged: true } });
  await f.flush();
  assert.equal(f.requests.length, 0, "选中和曾加载不代表存在可见面板");
  assert.equal(f.chat.threadPresentationRequiredVersionByThreadId[threadId], 10);
  assert.equal(f.chat.fileChangeTick, 1);
  assert.equal(f.chat.fileChangesByThreadId[threadId]?.stale, true);
  assert.equal(f.chat.managedServicesByThreadId[threadId]?.stale, true);
  const panel = {};
  f.chat.setThreadPresentationSurface(panel, { workspaceId, threadId });
  await f.chat.refreshThreadPresentation(f.ctx, { workspaceId, threadId, visibleOnly: true });
  assert.equal(f.requests.length, 1);
  assert.equal(f.chat.threadPresentationVersionByThreadId[threadId], 10);
  f.chat.setThreadPresentationSurface(panel, null);
  f.setVersion(20);
  f.ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: 20 });
  await f.flush();
  assert.equal(f.requests.length, 1);
  f.chat.setThreadPresentationSurface(panel, { workspaceId, threadId });
  await f.chat.refreshThreadPresentation(f.ctx, { workspaceId, threadId, visibleOnly: true });
  assert.equal(f.requests.length, 2);
  assert.equal(f.chat.threadPresentationVersionByThreadId[threadId], 20);
});

test("同线程双面板按各自生命周期保留刷新，最后隐藏取消在途展示", async t => {
  const f = presentationTransport(t);
  const first = {}, second = {};
  f.chat.setThreadPresentationSurface(first, { workspaceId, threadId });
  f.chat.setThreadPresentationSurface(second, { workspaceId, threadId });
  f.chat.setThreadPresentationSurface(first, null);
  f.ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: 10 });
  await f.flush();
  assert.equal(f.requests.length, 1, "嵌入面板不依赖全局选中线程");
  let resolveLate!: (value: unknown) => void;
  f.setResponse(new Promise(resolve => { resolveLate = resolve; }));
  f.ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: 20 });
  await f.flush();
  assert.equal(f.requests.length, 2);
  f.chat.setThreadPresentationSurface(second, null);
  f.setResponse(Promise.resolve({ status: 200, body: { ok: true,
    presentation: buildThreadPresentation(createConversationState(threadId), 30) } }));
  f.chat.setThreadPresentationSurface(first, { workspaceId, threadId });
  await f.chat.refreshThreadPresentation(f.ctx, { workspaceId, threadId, visibleOnly: true });
  assert.equal(f.requests.length, 3, "立即重新展示不复用刚取消的在途读取");
  resolveLate({ status: 200, body: { ok: true, presentation: buildThreadPresentation(createConversationState(threadId), 20) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.chat.threadPresentationVersionByThreadId[threadId], 30, "隐藏前的迟到快照不能回退新展示结果");
  assert.equal(f.chat.threadPresentationRequiredVersionByThreadId[threadId], 20);
  assert.equal(f.chat.threadPresentationErrorByThreadId[threadId], undefined);
  f.chat.resetForWorkspace();
  assert.equal(f.chat.isThreadPresentationVisible(workspaceId, threadId), false);
});

test("真实面板可见性监听处理嵌入、主选择、KeepAlive 和重置后重新加载", async t => {
  const f = presentationTransport(t);
  const source = readFileSync(new URL("../src/features/chat/components/chat-panel.vue", import.meta.url), "utf8");
  const start = source.indexOf("const activeThreadId = computed<ThreadId | null>");
  const end = source.indexOf("const processCacheEpoch", start);
  assert.ok(start >= 0 && end > start);
  const script = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const refreshes: Promise<void>[] = [];
  /** 执行 SFC 的真实可见性监听，只替代框架生命周期调度而保留 Pinia 和 Vue watch。 */
  function mountPanel(threadId?: ThreadId) {
    const hooks = { mounted: [] as Array<() => void>, activated: [] as Array<() => void>, deactivated: [] as Array<() => void>, unmounted: [] as Array<() => void> };
    const props = vue.reactive({ workspaceId, threadId, interactionActive: undefined as boolean | undefined });
    const scope = vue.effectScope();
    scope.run(() => new Function("props", "chat", "refreshVisibleThreadPresentation", "vue", `
      const {computed, ref, watch, onMounted, onActivated, onDeactivated, onUnmounted} = vue;
      ${script}`)(props, f.chat, (workspaceId: WorkspaceId, threadId: ThreadId) => {
      refreshes.push(f.chat.refreshThreadPresentation(f.ctx, { workspaceId, threadId, visibleOnly: true }));
    }, { ...vue,
      onMounted: (fn: () => void) => hooks.mounted.push(fn), onActivated: (fn: () => void) => hooks.activated.push(fn),
      onDeactivated: (fn: () => void) => hooks.deactivated.push(fn), onUnmounted: (fn: () => void) => hooks.unmounted.push(fn),
    }));
    const unmount = () => { scope.stop(); hooks.unmounted.forEach(fn => fn()); };
    t.after(unmount);
    hooks.mounted.forEach(fn => fn());
    return { props, unmount, activate: () => hooks.activated.forEach(fn => fn()), deactivate: () => hooks.deactivated.forEach(fn => fn()) };
  }
  f.chat.requireThreadPresentationVersion(threadId, 10);
  const first = mountPanel(threadId), second = mountPanel(threadId);
  await Promise.all(refreshes);
  assert.equal(f.requests.length, 1, "同线程面板补读复用现有 singleflight");
  first.deactivate();
  assert.equal(f.chat.isThreadPresentationVisible(workspaceId, threadId), true);
  second.props.interactionActive = false;
  assert.equal(f.chat.isThreadPresentationVisible(workspaceId, threadId), false);
  f.setVersion(20);
  f.ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: 20 });
  f.ws.receiveDesktopEvent({ t: "conversation.event", event: { schema: 1, seq: 21, ts: 1, engine: "codex", workspaceId, threadId,
    type: "turn.completed", payload: { turnId: "background" } } });
  f.setVersion(21);
  await f.flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.chat.conversations[threadId]?.completedTurnIds.background, true, "隐藏仍执行 canonical 终态处理");
  first.activate();
  await Promise.all(refreshes);
  assert.equal(f.chat.threadPresentationVersionByThreadId[threadId], 21);
  first.unmount();
  second.props.interactionActive = true;
  f.chat.resetForWorkspace();
  f.chat.threadPresentationVersionByThreadId[threadId] = 1;
  f.chat.requireThreadPresentationVersion(threadId, 21);
  f.chat.loadedThreads[threadId] = true;
  await Promise.all(refreshes);
  assert.equal(f.chat.threadPresentationVersionByThreadId[threadId], 21);
  second.unmount();
  f.chat.selectedThreadId = threadId;
  const primary = mountPanel();
  assert.equal(f.chat.isThreadPresentationVisible(workspaceId, threadId), true);
  f.chat.selectedThreadId = "other" as ThreadId;
  assert.equal(f.chat.isThreadPresentationVisible(workspaceId, threadId), false);
  assert.equal(f.chat.isThreadPresentationVisible(workspaceId, "other" as ThreadId), true);
  primary.unmount();
  assert.equal(f.chat.isThreadPresentationVisible(workspaceId, "other" as ThreadId), false);
});

test("回滚重置版本要求保留仍展示面板，删除会话释放其全部登记", async t => {
  const f = presentationTransport(t);
  f.chat.setThreadPresentationSurface({}, { workspaceId, threadId });
  f.chat.setThreadPresentationSurface({}, { workspaceId, threadId });
  f.ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: 20 });
  f.chat.prepareThreadRollbackHistoryReload(threadId, 20);
  f.chat.requireThreadPresentationVersion(threadId, 19);
  await f.flush();
  assert.equal(f.requests.length, 0);
  assert.equal(f.chat.threadPresentationRequiredVersionByThreadId[threadId], undefined);
  assert.equal(f.chat.isThreadPresentationVisible(workspaceId, threadId), true);
  f.chat.loadedThreads[threadId] = true;
  f.chat.threadPresentationVersionByThreadId[threadId] = 21;
  f.setVersion(22);
  f.ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: 22 });
  await f.flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.chat.threadPresentationVersionByThreadId[threadId], 22);
  f.chat.handleThreadChangedFromServer({ workspaceId, threadId, kind: "deleted" });
  assert.equal(f.chat.isThreadPresentationVisible(workspaceId, threadId), false);
  assert.equal(f.chat.threadPresentationRequiredVersionByThreadId[threadId], undefined);
});

test("打开会话使用轻量快照，保留正文和过程摘要且不回放详情", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: DesktopApiRequest[] = [];
  const state = createConversationState(threadId);
  state.items.push({ kind: "message", id: "answer", role: "assistant", text: "正文" },
    { kind: "reasoning", id: "reason", content: "未展开的详细推理" });
  const presentation = buildThreadPresentation(state, 10);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }),
    request: async (request: DesktopApiRequest) => {
      requests.push(request);
      assert.equal(request.method, "threads.load");
      return { status: 200, body: { ok: true, thread: { id: threadId, engine: "codex", title: "会话", createdAt: 1, updatedAt: 1 },
        presentation, events: [], running: null, hasMore: false, oldestSeq: null, latestSeq: 10, rawEventCount: 0 } };
    },
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  useConfigStore().workspaceId = workspaceId;
  const chat = useChatStore();
  await chat.loadThread({ serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" }, { workspaceId, threadId });
  assert.deepEqual(chat.conversations[threadId]?.items.map(item => item.kind), ["message", "process"]);
  assert.equal(requests[0]?.body?.presentation, "lazy");
  assert.equal(chat.threadLoadMetaByThreadId[threadId]?.hasMore, false);
  assert.equal(chat.threadReplayEventsByThreadId[threadId]?.length, 0);
});

test("冷投影先显示有界历史，后台补齐窗口快照而不阻塞首次加载", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: DesktopApiRequest[] = [];
  const turn = { workspaceId, threadId, engine: "codex" as const };
  const user = { schema: 1 as const, seq: 1, ts: 1, ...turn, type: "item.userMessage.created", payload: { itemId: "user", text: "问题" } } as EngineEventEnvelope;
  const answer = { schema: 1 as const, seq: 2, ts: 2, ...turn, type: "item.agentMessage.delta", payload: { itemId: "answer", delta: "有界历史先显示" } } as EngineEventEnvelope;
  const complete = createConversationState(threadId);
  complete.items.push({ kind: "message", id: "user", role: "user", text: "问题", createdAt: 1 },
    { kind: "message", id: "answer", role: "assistant", text: "投影完成", createdAt: 2 });
  let finishProjection!: (response: unknown) => void, presentationReads = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: { getState: async () => ({ status: "ready" }),
    request: async (request: DesktopApiRequest) => {
      requests.push(request);
      if (request.method === "threads.load") return { status: 200, body: { ok: true, presentationPending: true,
        thread: { id: threadId, workspaceId, engine: "codex", title: "冷会话", createdAt: 1, updatedAt: 2, threadType: "chat", threadSubtype: null, sessionId: null },
        events: [user, answer], rawEventCount: 2, oldestSeq: 1, latestSeq: 2, hasMore: true, deletedMessageIds: [], running: null,
        hasRealTurnActivity: true, managedServices: null, draft: null } };
      assert.equal(request.method, "threads.presentation");
      assert.equal(request.body?.presentationLimit, 30, "后台补齐也只读取首屏窗口");
      if (++presentationReads > 1) return { status: 200, body: { ok: true, presentation: buildThreadPresentation(complete, 3) } };
      return new Promise(resolve => { finishProjection = resolve; });
    },
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  useConfigStore().workspaceId = workspaceId;
  const chat = useChatStore();
  chat.setThreadPresentationSurface({}, { workspaceId, threadId });
  const ctx = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };
  await chat.loadThread(ctx, { workspaceId, threadId });
  assert.equal(chat.conversations[threadId]?.items.find(item => item.id === "answer")?.kind === "message"
    && (chat.conversations[threadId]?.items.find(item => item.id === "answer") as any).text, "有界历史先显示");
  assert.equal(chat.loadedThreads[threadId], true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2, "完整投影准备在首次加载结束后启动");
  finishProjection({ status: 200, body: { ok: true, presentation: buildThreadPresentation(complete, 2) } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((chat.conversations[threadId]?.items.find(item => item.id === "answer") as any).text, "投影完成");
  assert.equal(chat.threadPresentationVersionByThreadId[threadId], 2);
  assert.equal(chat.threadPresentationErrorByThreadId[threadId], undefined);
  assert.equal(chat.threadLoadMetaByThreadId[threadId]?.presentationPaged, undefined, "历史翻页仍沿canonical seq游标");
  chat.requireThreadPresentationVersion(threadId, 3);
  await chat.refreshThreadPresentation(ctx, { workspaceId, threadId, version: 3 });
  assert.equal(requests[2]?.body?.presentationLimit, 30, "后续事件刷新继续限制为首屏窗口");
});

test("冷建完成后旧投影快照保留canonical beforeSeq分页窗口", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: DesktopApiRequest[] = [];
  const turn = { workspaceId, threadId, engine: "codex" as const };
  const older = { schema: 1 as const, seq: 1, ts: 1, ...turn, type: "item.userMessage.created", payload: { itemId: "older", text: "更早" } } as EngineEventEnvelope;
  const recent = { schema: 1 as const, seq: 2, ts: 2, ...turn, type: "item.userMessage.created", payload: { itemId: "recent", text: "最近" } } as EngineEventEnvelope;
  const answer = { schema: 1 as const, seq: 3, ts: 3, ...turn, type: "item.agentMessage.delta", payload: { itemId: "answer", delta: "回答" } } as EngineEventEnvelope;
  const complete = createConversationState(threadId);
  for (const event of [older, recent, answer]) applyEngineEventToConversation(complete, event);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: { getState: async () => ({ status: "ready" }),
    request: async (request: DesktopApiRequest) => {
      requests.push(request);
      if (request.method === "threads.load" && requests.length === 1) return { status: 200, body: { ok: true, presentationPending: true,
        thread: { id: threadId, workspaceId, engine: "codex", title: "冷会话", createdAt: 1, updatedAt: 3, threadType: "chat", threadSubtype: null, sessionId: null },
        events: [recent, answer], rawEventCount: 2, oldestSeq: 2, latestSeq: 3, hasMore: true, deletedMessageIds: [], running: null,
        hasRealTurnActivity: true, managedServices: null, draft: null } };
      if (request.method === "threads.presentation") return { status: 200, body: { ok: true, presentation: buildThreadPresentation(complete, 3) } };
      assert.equal(request.method, "threads.load");
      assert.equal(request.body?.beforeSeq, 2);
      return { status: 200, body: { ok: true, thread: { id: threadId, workspaceId, engine: "codex", title: "冷会话", createdAt: 1, updatedAt: 3 },
        events: [older], rawEventCount: 1, oldestSeq: 1, latestSeq: 3, hasMore: false, deletedMessageIds: [], running: null, managedServices: null } };
    },
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia()); useConfigStore().workspaceId = workspaceId;
  const chat = useChatStore(); chat.setThreadPresentationSurface({}, { workspaceId, threadId });
  const ctx = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };
  await chat.loadThread(ctx, { workspaceId, threadId });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(chat.threadPresentationVersionByThreadId[threadId], 3);
  assert.equal(chat.threadLoadMetaByThreadId[threadId]?.presentationPaged, undefined, "继续沿最初canonical窗口游标分页");
  await chat.loadThreadPage(ctx, { workspaceId, threadId });
  assert.equal(requests[2]?.method, "threads.load");
  assert.deepEqual(chat.conversations[threadId]?.items.filter(item => item.kind === "message").map(item => item.id), ["older", "recent", "answer"]);
});

test("折叠过程不读取；展开按固定版本分页并以快照替换，收起停止补读", async () => {
  const reads: Array<{ afterSeq?: number; throughSeq?: number; cursor?: string }> = [];
  const loader = createProcessDetailsLoader(async body => {
    reads.push(body);
    return { items: [{ kind: "reasoning", id: "r", content: body.afterSeq ? "完整新版" : "初始" }],
      version: body.throughSeq!, hasMore: !body.cursor && !body.afterSeq, nextCursor: !body.cursor && !body.afterSeq ? "page2" : null };
  });
  await loader.refresh(10);
  assert.equal(reads.length, 0);
  await loader.setOpen(true, 10);
  assert.deepEqual(reads, [{ throughSeq: 10 }], "首次展开只读取一页");
  assert.equal(loader.state.hasMore, true);
  await loader.loadMore();
  assert.deepEqual(reads, [{ throughSeq: 10 }, { throughSeq: 10, cursor: "page2" }]);
  await loader.refresh(12);
  assert.deepEqual(reads[2], { afterSeq: 10, throughSeq: 12 });
  assert.deepEqual(loader.state.items.map(item => "content" in item ? item.content : ""), ["完整新版"]);
  await loader.setOpen(false, 12);
  await loader.refresh(15);
  assert.equal(reads.length, 3);
  await loader.setOpen(true, 15);
  assert.deepEqual(reads[3], { afterSeq: 12, throughSeq: 15 });
});

test("未读旧页期间补读变化按成员顺序插入，加载旧页不覆盖新快照", async () => {
  const loader = createProcessDetailsLoader(async body => {
    if (body.afterSeq) return { items: [{ kind: "reasoning", id: "b", content: "新B" }, { kind: "reasoning", id: "c", content: "新C" }],
      itemOrder: ["a", "b", "c"], version: 20, hasMore: false, nextCursor: null };
    if (body.cursor) return { items: [{ kind: "reasoning", id: "b", content: "旧B" }],
      itemOrder: ["a", "b", "c"], version: 10, hasMore: false, nextCursor: null };
    return { items: [{ kind: "reasoning", id: "a", content: "A" }], itemOrder: ["a", "b"], version: 10, hasMore: true, nextCursor: "a" };
  });
  await loader.setOpen(true, 10);
  await loader.refresh(20);
  await loader.loadMore();
  assert.deepEqual(loader.state.items.map(item => item.id), ["a", "b", "c"]);
  assert.equal(loader.state.items[1]?.kind === "reasoning" && loader.state.items[1]?.content, "新B");
  assert.equal(loader.state.version, 20);
});

test("过程快照版本超出请求边界时显式失败，不跳过尚未补读的变化", async () => {
  const loader = createProcessDetailsLoader(async () => ({ items: [], version: 30, hasMore: false, nextCursor: null }));
  await assert.rejects(loader.setOpen(true, 10), /版本/);
  assert.equal(loader.state.version, 0);
});

test("加载旧页期间收到新版本，旧页完成后立即补读变化", async () => {
  let resolveOlder!: (page: ThreadProcessDetails) => void;
  const loader = createProcessDetailsLoader(async body => {
    if (body.cursor) return new Promise(resolve => { resolveOlder = resolve; });
    return { items: [{ kind: "reasoning", id: "a", content: body.afterSeq ? "新版" : "旧版" }],
      version: body.throughSeq!, hasMore: !body.afterSeq, nextCursor: body.afterSeq ? null : "older" };
  });
  await loader.setOpen(true, 10);
  const older = loader.loadMore();
  const update = loader.refresh(20);
  resolveOlder({ items: [], version: 10, hasMore: false, nextCursor: null });
  await Promise.all([older, update]);
  assert.equal(loader.state.version, 20);
  assert.equal(loader.state.items[0]?.kind === "reasoning" && loader.state.items[0]?.content, "新版");
});

test("展开补读期间的新版本接续读取，关闭后的迟到结果不更新缓存", async () => {
  let resolvePage!: (value: ThreadProcessDetails) => void;
  const versions: number[] = [];
  const loader = createProcessDetailsLoader(async body => {
    versions.push(body.throughSeq!);
    if (versions.length === 1) return new Promise<ThreadProcessDetails>(resolve => { resolvePage = resolve; });
    return { items: [{ kind: "reasoning", id: "r", content: "新版" }], version: body.throughSeq!, hasMore: false, nextCursor: null };
  });
  const first = loader.setOpen(true, 10);
  const changed = loader.refresh(20);
  resolvePage({ items: [], version: 10, hasMore: false, nextCursor: null });
  await Promise.all([first, changed]);
  assert.deepEqual(versions, [10, 20]);
  assert.equal(loader.state.version, 20);

  let resolveLate!: (value: ThreadProcessDetails) => void;
  const late = createProcessDetailsLoader(() => new Promise(resolve => { resolveLate = resolve; }));
  const pending = late.setOpen(true, 30);
  await late.setOpen(false, 30);
  resolveLate({ items: [{ kind: "reasoning", id: "late", content: "迟到" }], version: 30, hasMore: false, nextCursor: null });
  await pending;
  assert.equal(late.state.items.length, 0);
  assert.equal(late.state.version, 0);
});

test("过程读取失败显式保留错误，重试后恢复且失效清空旧详情", async () => {
  let fail = true;
  const loader = createProcessDetailsLoader(async body => {
    if (fail) throw new Error("详情读取失败");
    return { items: [{ kind: "reasoning", id: "r", content: "恢复" }], version: body.throughSeq!, hasMore: false, nextCursor: null };
  });
  await assert.rejects(loader.setOpen(true, 10), /详情读取失败/);
  assert.equal(loader.state.error, "详情读取失败");
  assert.equal(loader.state.loading, false);
  fail = false;
  await loader.refresh(10);
  assert.equal(loader.state.error, null);
  assert.equal(loader.state.items.length, 1);
  loader.dispose();
  assert.equal(loader.state.items.length, 0);
});

test("轻量刷新保留请求期间的正文尾部，历史失效后迟到快照不覆盖会话", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let resolveSnapshot!: (value: unknown) => void;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }),
    request: async (request: DesktopApiRequest) => {
      assert.equal(request.method, "threads.presentation");
      return new Promise(resolve => { resolveSnapshot = resolve; });
    },
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  useConfigStore().workspaceId = workspaceId;
  const chat = useChatStore();
  chat.loadedThreads[threadId] = true;
  chat.threadPresentationVersionByThreadId[threadId] = 1;
  const ctx = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };
  const refreshing = chat.refreshThreadPresentation(ctx, { workspaceId, threadId, version: 10 });
  chat.applyEngineEvent({ schema: 1, seq: 11, ts: 1, engine: "codex", workspaceId, threadId,
    type: "item.agentMessage.delta", payload: { itemId: "answer", delta: "实时尾部" } } as EngineEventEnvelope);
  const state = createConversationState(threadId);
  state.items.push({ kind: "message", id: "answer", role: "assistant", text: "快照" });
  resolveSnapshot({ status: 200, body: { ok: true, presentation: buildThreadPresentation(state, 10) } });
  await refreshing;
  assert.equal(chat.conversations[threadId]?.items[0]?.kind === "message" && chat.conversations[threadId]?.items[0]?.text, "快照实时尾部");
  const stale = chat.refreshThreadPresentation(ctx, { workspaceId, threadId, version: 20 });
  chat.invalidateThreadHistoryReads(threadId, "clear");
  resolveSnapshot({ status: 200, body: { ok: true, presentation: buildThreadPresentation(createConversationState(threadId), 20) } });
  await stale;
  assert.equal(chat.conversations[threadId]?.items.length, 1);
  assert.equal(chat.threadPresentationVersionByThreadId[threadId], 10);
});

test("会话重新读取轻量快照时保留请求前已收到的正文尾部", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const state = createConversationState(threadId);
  state.items.push({ kind: "message", id: "answer", role: "assistant", text: "快照" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }), request: async () => ({ status: 200, body: { ok: true,
      thread: { id: threadId, engine: "codex", title: "会话", createdAt: 1, updatedAt: 1 }, events: [],
      presentation: buildThreadPresentation(state, 10), running: null, hasMore: false, latestSeq: 10 } }),
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const chat = useChatStore();
  chat.applyEngineEvent({ schema: 1, seq: 11, ts: 1, engine: "codex", workspaceId, threadId,
    type: "item.agentMessage.delta", payload: { itemId: "answer", delta: "已有尾部" } } as EngineEventEnvelope);
  await chat.loadThread({ serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" }, { workspaceId, threadId });
  assert.equal(chat.conversations[threadId]?.items[0]?.kind === "message" && chat.conversations[threadId]?.items[0]?.text, "快照已有尾部");
  assert.deepEqual(chat.threadReplayEventsByThreadId[threadId]?.map(event => event.seq), [11]);
});

test("轻量快照覆盖的迟到正文增量不能再次拼接", () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const state = chat.ensureConversation(threadId);
  state.items.push({ kind: "message", id: "answer", role: "assistant", text: "完整正文" });
  state._indexById.set("answer", state.items[0]!);
  chat.threadPresentationVersionByThreadId[threadId] = 10;
  chat.applyEngineEvent({ schema: 1, seq: 9, ts: 1, engine: "codex", workspaceId, threadId,
    type: "item.agentMessage.delta", payload: { itemId: "answer", delta: "重复" } } as EngineEventEnvelope);
  assert.equal(state.items[0]?.kind === "message" && state.items[0]?.text, "完整正文");
});

test("轻量快照落后已收到的通知时显式失败，重试仍要求追上高水位", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let version = 5;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }), request: async () => ({ status: 200, body: { ok: true,
      presentation: buildThreadPresentation(createConversationState(threadId), version) } }),
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const chat = useChatStore();
  chat.loadedThreads[threadId] = true;
  chat.threadPresentationVersionByThreadId[threadId] = 1;
  const ctx = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };
  await assert.rejects(chat.refreshThreadPresentation(ctx, { workspaceId, threadId, version: 10 }), /版本/);
  assert.ok(chat.threadPresentationErrorByThreadId[threadId]);
  await assert.rejects(chat.refreshThreadPresentation(ctx, { workspaceId, threadId }), /版本/);
  version = 10;
  await chat.refreshThreadPresentation(ctx, { workspaceId, threadId });
  assert.equal(chat.threadPresentationVersionByThreadId[threadId], 10);
  assert.equal(chat.threadPresentationErrorByThreadId[threadId], undefined);
});

test("迟到的首屏快照不能回退已接受的展示版本", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }), request: async () => ({ status: 200, body: { ok: true,
      thread: { id: threadId, engine: "codex", title: "会话", createdAt: 1, updatedAt: 1 }, events: [],
      presentation: buildThreadPresentation(createConversationState(threadId), 10), running: null, hasMore: false, latestSeq: 10 } }),
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const chat = useChatStore();
  chat.threadPresentationVersionByThreadId[threadId] = 20;
  chat.ensureConversation(threadId).items.push({ kind: "message", id: "new", role: "assistant", text: "新快照" });
  await assert.rejects(chat.loadThread({ serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" }, { workspaceId, threadId }), /版本/);
  assert.equal(chat.threadPresentationVersionByThreadId[threadId], 20);
  assert.equal(chat.conversations[threadId]?.items.length, 1);
});

test("桌面同身份轮询保留展开过程，版本增量不清空而真实作用域变化清理缓存", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let clientId = "desktop";
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready", requestId: "runtime", releaseId: "release", errorCode: null }),
    onEvent: () => () => {},
    request: async () => ({ status: 200, body: { ok: true, client: { clientId, version: "1", workspaceIds: [workspaceId], connectedAt: 1 } } }),
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore();
  await config.refreshDesktopRuntime();
  const { ctx } = useApiContext();
  const requests: Array<{ throughSeq?: number; afterSeq?: number }> = [];
  let finish!: () => void;
  const loader = createProcessDetailsLoader(async request => {
    requests.push(request);
    return await new Promise(resolve => { finish = () => resolve({ items: [{ kind: "reasoning", id: "r", content: "相同推理正文" }],
      version: request.throughSeq!, hasMore: false, nextCursor: null }); });
  });
  const props = vue.shallowReactive({ workspaceId: String(workspaceId), threadId: String(threadId),
    item: vue.reactive({ version: 10 }), get apiContext() { return ctx.value; } });
  const source = readFileSync(new URL("../src/features/messages/components/process-details.vue", import.meta.url), "utf8");
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/u)![1]!;
  const ast = ts.createSourceFile("process-details.ts", script, ts.ScriptTarget.Latest, true);
  const watchers = ast.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === "watch").map(node => node.getText(ast)).join("\n");
  const scope = vue.effectScope();
  scope.run(() => new Function("watch", "props", "loader", "opened", "reportFailure", ts.transpile(watchers, { target: ts.ScriptTarget.ES2022 }))(
    vue.watch, props, loader, vue.ref(true), (error: unknown) => assert.fail(String(error))));
  t.after(() => { scope.stop(); loader.dispose(); });
  const first = loader.setOpen(true, 10);
  finish(); await first;
  const cached = loader.state.items;
  for (let poll = 0; poll < 3; poll++) {
    const previousContext = ctx.value;
    await config.refreshDesktopRuntime(); await vue.nextTick();
    assert.notEqual(ctx.value, previousContext, "运行时轮询重新生成请求上下文");
    assert.equal(loader.state.items, cached, "相同身份不能清空正文或重建内部条目");
    assert.equal(requests.length, 1, "相同身份不能重复读取详情");
  }
  props.item.version = 11; await vue.nextTick();
  assert.equal(loader.state.items, cached, "真实版本变化补读期间保留旧正文");
  assert.equal(requests.at(-1)?.afterSeq, 10);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(loader.state.version, 11);
  const changes = [() => { props.workspaceId = "other-workspace"; }, () => { props.threadId = "other-thread"; },
    () => { config.serverWsOrigin = "wss://other.example"; }, () => { config.sessionToken = "other-session"; },
    () => { config.webSessionId = "other-web-session"; }, async () => { clientId = "other-client"; await config.refreshDesktopRuntime(); }];
  for (const change of changes) {
    const before = requests.length;
    await change(); await vue.nextTick();
    assert.equal(loader.state.items.length, 0, "真实作用域变化必须清理旧正文");
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1)?.afterSeq, undefined, "新作用域不能沿用旧版本游标");
    finish(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(loader.state.items.length, 1);
  }
});

test("删除和回滚使过程组件缓存换代，销毁后的迟到读取不能恢复旧正文", async t => {
  const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
  const source = readFileSync(new URL("../src/features/messages/components/process-details.vue", import.meta.url), "utf8");
  const compiled = ts.transpileModule(compileScript(parse(source).descriptor, { id: "process-test" }).content,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, any> } } };
  const unmount: Array<() => void> = [];
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (id === "vue") return { ...vue, onBeforeUnmount: (callback: () => void) => unmount.push(callback) };
    if (id === "../../../api/request") return requestApi;
    if (id === "../../../api/threads") return threadApi;
    if (id === "../../chat/processDetails") return { createProcessDetailsLoader };
    if (id === "../assistantRenderNodes") return renderNodes;
    if (id === "../prepareConversationItems") return prepareItems;
    if (id.endsWith(".vue") || id === "@ant-design/icons-vue") return {};
    throw new Error(`unexpected import ${id}`);
  }, module, module.exports);
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let resolveLate!: (page: unknown) => void;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }), request: async () => new Promise(resolve => { resolveLate = resolve; }),
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  const props = vue.reactive({ item: { kind: "process", id: "process:r", preview: "", itemCount: 1,
    statusCounts: { done: 0, running: 0, warning: 0, failed: 0 }, version: 10 }, workspaceId, threadId,
    apiContext: { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" } });
  const scope = vue.effectScope();
  const component = scope.run(() => module.exports.default.setup(props, { expose: () => {} }))!;
  t.after(() => { unmount.forEach(callback => callback()); scope.stop(); });
  component.onToggle({ target: { open: true } });
  setActivePinia(createPinia());
  const chat = useChatStore();
  chat.applyThreadMessageDeletions(threadId, ["deleted"]);
  assert.equal(chat.threadContentEpochByThreadId[threadId], 1);
  chat.clearThreadReplayState(threadId);
  assert.equal(chat.threadContentEpochByThreadId[threadId], 2);
  unmount.forEach(callback => callback());
  resolveLate({ status: 200, body: { ok: true, items: [{ kind: "reasoning", id: "r", content: "旧正文" }], version: 10, hasMore: false, nextCursor: null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(component.loader.state.items.length, 0);
});

test("运行中折叠过程合并版本通知，只刷新摘要且保留终态刷新", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: DesktopApiRequest[] = [];
  let version = 10;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    codeflowDesktop: { getState: async () => ({ status: "ready" }), request: async (request: DesktopApiRequest) => {
      requests.push(request);
      assert.equal(request.method, "threads.presentation");
      return { status: 200, body: { ok: true, presentation: buildThreadPresentation(createConversationState(threadId), version) } };
    } },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore(), chat = useChatStore();
  config.workspaceId = workspaceId;
  config.desktopRuntime = { status: "ready", requestId: "local", releaseId: null, errorCode: null };
  config.desktopClient = { clientId: "desktop", name: "本机", version: "1", platform: "win32", arch: "x64", connectedAt: 1, workspaceIds: [workspaceId] };
  chat.loadedThreads[threadId] = true;
  chat.threadPresentationVersionByThreadId[threadId] = 1;
  const errors: string[] = [];
  const invalidated: string[] = [];
  const ws = createWebSocketClient({ config, chat, presence: {} as never, engine: {} as never,
    explorer: { viewMode: "files", invalidateGitStatus: () => { invalidated.push(workspaceId); } } as never,
    onError: message => errors.push(message) });
  t.after(ws.disconnect);
  ws.replaceLocalWorkspaceSubscription(workspaceId);
  chat.loadedThreads[threadId] = true;
  chat.setThreadPresentationSurface({}, { workspaceId, threadId });
  for (const changed of [7, 8, 10]) ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: changed });
  t.mock.timers.tick(200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(chat.threadPresentationVersionByThreadId[threadId], 10);
  version = 11;
  ws.receiveDesktopEvent({ t: "conversation.event", event: { schema: 1, seq: 11, ts: 1, engine: "codex", workspaceId, threadId,
    type: "turn.completed", payload: { turnId: "done" } } });
  t.mock.timers.tick(200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(invalidated.length, 1, "轮次结束独立触发一次 Git 缓存失效");
  const change = { t: "conversation.changed" as const, workspaceId, threadId, version: 12,
    toolCompleted: { seq: 12, toolName: "Write", hasFileChanges: true, managedServicesChanged: true } };
  ws.receiveDesktopEvent(change);
  const afterFirstSignal = invalidated.length;
  ws.receiveDesktopEvent(change);
  assert.equal(chat.fileChangeTick, 1, "无正文完成信号保留文件变更副作用，重复信号不重复触发");
  assert.equal(chat.fileChangesByThreadId[threadId]?.stale, true);
  assert.equal(afterFirstSignal, 2, "写文件完成在轮次结束之外再失效一次");
  assert.equal(invalidated.length, afterFirstSignal, "重复完成信号不能再次失效 Git 缓存");
  assert.equal(chat.conversations[threadId]?.items.some(item => item.kind === "tool"), false);
  assert.deepEqual(errors, []);
});

test("加载期间过程通知保留到首屏结束，正文增量跨快照序号不重复", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let resolveLoad!: (value: unknown) => void;
  let summaries = 0;
  const base = createConversationState(threadId);
  base.items.push({ kind: "message", id: "answer", role: "assistant", text: "旧" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    codeflowDesktop: { getState: async () => ({ status: "ready" }), request: async (request: DesktopApiRequest) => {
      if (request.method === "threads.load") return new Promise(resolve => { resolveLoad = resolve; });
      assert.equal(request.method, "threads.presentation");
      summaries++;
      const updated = createConversationState(threadId);
      updated.items.push({ kind: "message", id: "answer", role: "assistant", text: "旧新" });
      return { status: 200, body: { ok: true, presentation: buildThreadPresentation(updated, 20) } };
    } },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore(), chat = useChatStore();
  config.workspaceId = workspaceId;
  config.desktopRuntime = { status: "ready", requestId: "local", releaseId: null, errorCode: null };
  config.desktopClient = { clientId: "desktop", name: "本机", version: "1", platform: "win32", arch: "x64", connectedAt: 1, workspaceIds: [workspaceId] };
  const ws = createWebSocketClient({ config, chat, presence: {} as never, engine: {} as never });
  t.after(ws.disconnect);
  ws.replaceLocalWorkspaceSubscription(workspaceId);
  const loading = chat.loadThread({ serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" }, { workspaceId, threadId });
  chat.setThreadPresentationSurface({}, { workspaceId, threadId });
  for (const [seq, delta] of [[10, "旧"], [11, "新"]] as const) ws.receiveDesktopEvent({ t: "conversation.event", event: {
    schema: 1, seq, ts: 1, engine: "codex", workspaceId, threadId, type: "item.agentMessage.delta", payload: { itemId: "answer", engineMessageId: "answer", delta },
  } });
  ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: 20 });
  t.mock.timers.tick(200);
  assert.equal(summaries, 0);
  resolveLoad({ status: 200, body: { ok: true, thread: { id: threadId, engine: "codex", title: "会话", createdAt: 1, updatedAt: 1 },
    presentation: buildThreadPresentation(base, 10), events: [], running: null, hasMore: false, latestSeq: 10 } });
  await loading;
  assert.equal(chat.conversations[threadId]?.items[0]?.kind === "message" && chat.conversations[threadId]?.items[0]?.text, "旧新");
  t.mock.timers.tick(200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(summaries, 1);
  assert.equal(chat.threadPresentationVersionByThreadId[threadId], 20);
});

test("摘要先包含终态或新轮次时同步运行提示，迟到终态不覆盖新轮次", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let snapshot = createConversationState(threadId);
  snapshot.completedTurnIds.old = true;
  let version = 20;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }), request: async () => ({ status: 200,
      body: { ok: true, presentation: buildThreadPresentation(snapshot, version) } }),
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const chat = useChatStore();
  chat.loadedThreads[threadId] = true;
  chat.threadPresentationVersionByThreadId[threadId] = 10;
  chat.applyThreadRunningState(threadId, { runningTurnId: "old", runningTurnStartedAt: 1 });
  chat.setThreadRunningHint(threadId, { runningTurnId: "old", runningTurnStartedAt: 1 });
  const ctx = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };
  await chat.refreshThreadPresentation(ctx, { workspaceId, threadId, version: 19 });
  chat.applyEngineEvent({ schema: 1, seq: 20, ts: 20, engine: "codex", workspaceId, threadId,
    type: "turn.completed", payload: { turnId: "old" } } as EngineEventEnvelope);
  assert.equal(chat.threadDisplayRunningStateForThread(threadId), null);
  snapshot = createConversationState(threadId);
  snapshot.completedTurnIds.old = true;
  snapshot.runningTurnId = "new";
  snapshot.runningTurnStartedAt = 21;
  version = 22;
  await chat.refreshThreadPresentation(ctx, { workspaceId, threadId, version: 22 });
  chat.applyEngineEvent({ schema: 1, seq: 20, ts: 20, engine: "codex", workspaceId, threadId,
    type: "turn.completed", payload: { turnId: "old" } } as EngineEventEnvelope);
  assert.equal(chat.threadDisplayRunningStateForThread(threadId)?.runningTurnId, "new");
});

test("回滚前排队和迟到的过程通知不污染版本要求或触发工具副作用", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let version = 10, summaries = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    codeflowDesktop: { getState: async () => ({ status: "ready" }), request: async (request: DesktopApiRequest) => {
      if (request.method === "threads.presentation") summaries++;
      return { status: 200, body: { ok: true, thread: { id: threadId, engine: "codex", title: "会话", createdAt: 1, updatedAt: 1 },
        events: [], presentation: buildThreadPresentation(createConversationState(threadId), version), running: null, hasMore: false, latestSeq: version } };
    } },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const chat = useChatStore(), config = useConfigStore();
  config.workspaceId = workspaceId;
  config.desktopRuntime = { status: "ready", requestId: "local", releaseId: null, errorCode: null };
  config.desktopClient = { clientId: "desktop", name: "本机", version: "1", platform: "win32", arch: "x64", connectedAt: 1, workspaceIds: [workspaceId] };
  const errors: string[] = [];
  const ws = createWebSocketClient({ config, chat, presence: {} as never, engine: {} as never, onError: text => errors.push(text) });
  t.after(() => { ws.replaceLocalWorkspaceSubscription(null); ws.disconnect(); });
  ws.replaceLocalWorkspaceSubscription(workspaceId);
  chat.loadedThreads[threadId] = true;
  chat.threadPresentationVersionByThreadId[threadId] = 10;
  chat.setThreadPresentationSurface({}, { workspaceId, threadId });
  ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: 20 });
  chat.prepareThreadRollbackHistoryReload(threadId, 20);
  const ctx = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };
  await chat.loadThread(ctx, { workspaceId, threadId });
  ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version: 20,
    toolCompleted: { seq: 20, toolName: "Write", hasFileChanges: true, managedServicesChanged: true } });
  t.mock.timers.tick(200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chat.threadPresentationErrorByThreadId[threadId], undefined);
  assert.equal(chat.threadPresentationRequiredVersionByThreadId[threadId], undefined);
  assert.equal(chat.fileChangeTick, 0);
  assert.equal(summaries, 0);
  version = 21;
  ws.receiveDesktopEvent({ t: "conversation.changed", workspaceId, threadId, version });
  t.mock.timers.tick(200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chat.threadPresentationVersionByThreadId[threadId], 21);
  assert.deepEqual(errors, []);
});

test("首屏快照之后缓冲的审批结果更新规划和权限偏好", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let resolveLoad!: (value: unknown) => void;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }), request: async () => new Promise(resolve => { resolveLoad = resolve; }),
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const chat = useChatStore();
  const loading = chat.loadThread({ serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" }, { workspaceId, threadId });
  chat.applyEngineEvent({ schema: 1, seq: 11, ts: 11, engine: "codex", workspaceId, threadId, type: "approval.resolved",
    payload: { requestId: "approval", approved: true, nextPlanMode: false, nextAccessMode: "full-access" } } as EngineEventEnvelope);
  resolveLoad({ status: 200, body: { ok: true,
    thread: { id: threadId, engine: "codex", title: "会话", createdAt: 1, updatedAt: 1, planMode: true, accessMode: "read-only" },
    events: [], presentation: buildThreadPresentation(createConversationState(threadId), 10), running: null, hasMore: false, latestSeq: 10 } });
  await loading;
  assert.equal(chat.threadPrefsByThreadId[threadId]?.planMode, false);
  assert.equal(chat.threadPrefsByThreadId[threadId]?.accessMode, "full-access");
});

for (const successor of ["stopped", "pending", "running"] as const) test(`迟到摘要不覆盖请求期间的权威运行状态：${successor}`, async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let resolveSummary!: (value: unknown) => void;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }), request: async (request: DesktopApiRequest) => {
      if (request.method === "threads.presentation") return new Promise(resolve => { resolveSummary = resolve; });
      return { status: 200, body: { ok: true, running: successor === "running"
        ? { runningTurnId: "new", runningTurnStartedAt: 21 } : null } };
    },
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const chat = useChatStore();
  chat.loadedThreads[threadId] = true;
  chat.threadPresentationVersionByThreadId[threadId] = 10;
  chat.applyThreadRunningState(threadId, { runningTurnId: "old", runningTurnStartedAt: 1 });
  chat.setThreadRunningHint(threadId, { runningTurnId: "old", runningTurnStartedAt: 1 });
  const snapshot = buildThreadPresentation(chat.ensureConversation(threadId), 20);
  const ctx = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };
  const refreshing = chat.refreshThreadPresentation(ctx, { workspaceId, threadId, version: 20 });
  await chat.interruptTurn(ctx, { workspaceId, threadId, turnId: "old" });
  if (successor === "pending") chat.setThreadPendingDispatch(threadId, "new");
  resolveSummary({ status: 200, body: { ok: true, presentation: snapshot } });
  await refreshing;
  assert.equal(chat.threadPendingDispatchByThreadId[threadId]?.turnId, successor === "pending" ? "new" : undefined);
  assert.equal(chat.threadDisplayRunningStateForThread(threadId)?.runningTurnId ?? null, successor === "stopped" ? null : "new");
});

test("摘要只确认所属派发，不清除未出现在快照中的后继派发", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const snapshot = createConversationState(threadId);
  snapshot.runningTurnId = "old";
  snapshot.runningTurnStartedAt = 1;
  let version = 20;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }), request: async () => ({ status: 200,
      body: { ok: true, presentation: buildThreadPresentation(snapshot, version) } }),
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const chat = useChatStore();
  chat.loadedThreads[threadId] = true;
  chat.threadPresentationVersionByThreadId[threadId] = 10;
  chat.setThreadRunningHint(threadId, null);
  chat.setThreadPendingDispatch(threadId, "new");
  const ctx = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };
  await chat.refreshThreadPresentation(ctx, { workspaceId, threadId, version: 20 });
  assert.equal(chat.threadPendingDispatchByThreadId[threadId]?.turnId, "new");
  assert.equal(chat.threadDisplayRunningStateForThread(threadId)?.runningTurnId, "new");
  snapshot.runningTurnId = "new";
  snapshot.runningTurnStartedAt = 21;
  version = 21;
  await chat.refreshThreadPresentation(ctx, { workspaceId, threadId, version });
  assert.equal(chat.threadPendingDispatchByThreadId[threadId], undefined);
  assert.equal(chat.threadDisplayRunningStateForThread(threadId)?.runningTurnId, "new");
  snapshot.completedTurnIds.new = true;
  snapshot.runningTurnId = null;
  snapshot.runningTurnStartedAt = null;
  version = 22;
  await chat.refreshThreadPresentation(ctx, { workspaceId, threadId, version });
  assert.equal(chat.threadDisplayRunningStateForThread(threadId), null);
});

test("过程详情不再渲染整段加载提示，避免流式补读导致列表高度变化", () => {
  const source = readFileSync(new URL("../src/features/messages/components/process-details.vue", import.meta.url), "utf8");
  assert.doesNotMatch(source, /正在加载过程/u);
});
