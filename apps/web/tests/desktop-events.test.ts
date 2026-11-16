import assert from "node:assert/strict";
import test from "node:test";
import { createPinia } from "pinia";
import type { ConversationEventEnvelope, DesktopBridgeApi } from "@codeflowai/shared";
import { createWebSocketClient } from "../src/services/ws.ts";
import { subscribeDesktopEvents } from "../src/services/desktop.ts";
import { useThreadQueueStore } from "../src/store/threadQueue.ts";

const workspaceId = "local-client:workspace";

/** 不创建网络连接，只注入现有事件合批器所需状态。 */
function setup(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { setTimeout, clearTimeout }, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const applied: ConversationEventEnvelope[] = [];
  let subscribed = 0;
  const config = { workspaceId, localRuntimeReady: true, desktopClient: { clientId: "local-client", workspaceIds: [workspaceId] }, setConnectionStatus() {} };
  const client = createWebSocketClient({ config, chat: { threadPresentationVersionByThreadId: {}, applyEngineEvent(event: ConversationEventEnvelope) { applied.push(event); }, markWorkspaceSubscribed() { subscribed += 1; } },
    presence: { ready: false, clearSharedWriterPresenceSnapshot() {}, beginActiveWorkspaceSnapshot() {} }, engine: {} } as any);
  return { client, config, applied, subscribed: () => subscribed };
}

/** 无业务副作用的 canonical 事件用于验证进入原合批入口的时序与归属。 */
function event(seq: number, target = workspaceId): ConversationEventEnvelope {
  return { schema: 1, seq, ts: seq, workspaceId: target as any, threadId: "thread-local" as any,
    engine: "codex", type: "turn.started", payload: { turnId: "turn-local" as any } };
}

test("desktop orchestration events enter both original reducers only in the selected workspace", async t => {
  const f = setup(t), chatEvents: unknown[] = [], orchestrationEvents: unknown[] = [];
  const client = createWebSocketClient({ config: f.config, chat: { markWorkspaceSubscribed() {}, handleOrchestrationEvent(event: unknown) { chatEvents.push(event); } },
    presence: {}, engine: {}, orchestration: { async onOrchestrationEvent(_ctx: unknown, workspace: unknown, event: unknown, options: any) { orchestrationEvents.push([workspace, event]); assert.equal(options.allowNetworkHydration(), true); } } } as any);
  client.replaceLocalWorkspaceSubscription(workspaceId as any);
  const record = { id: "event-1", instanceId: "instance" as any, nodeId: null, type: "orchestration.started", payloadJson: "{}", createdAt: 1 };
  client.receiveDesktopEvent({ t: "orchestration.event", workspaceId: workspaceId as any, event: record });
  client.receiveDesktopEvent({ t: "orchestration.event", workspaceId: "foreign:workspace" as any, event: record });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(chatEvents, [record]);
  assert.deepEqual(orchestrationEvents, [[workspaceId, record]]);
});

test("desktop events use existing batching and survive cloud disconnect", async (t) => {
  const f = setup(t);
  f.client.replaceLocalWorkspaceSubscription(workspaceId as any);
  f.client.receiveDesktopEvent({ t: "conversation.event", event: event(1) });
  f.client.replaceLocalWorkspaceSubscription(workspaceId as any);
  f.client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(f.applied.map((value) => value.seq), [1]);
  assert.equal(f.subscribed(), 1);
});

test("desktop event subscription follows exact local workspace and clears pending old scope", async (t) => {
  const f = setup(t);
  f.client.replaceLocalWorkspaceSubscription(workspaceId as any);
  f.client.receiveDesktopEvent({ t: "conversation.event", event: event(1, "other-client:workspace") });
  f.client.receiveDesktopEvent({ t: "conversation.event", event: event(2) });
  f.client.replaceLocalWorkspaceSubscription(null);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(f.applied, []);
  assert.throws(() => f.client.replaceLocalWorkspaceSubscription("shared:workspace" as any), /DESKTOP_WORKSPACE_NOT_LOCAL/);
});

test("local queue changes refresh the existing queue projection only for the current workspace", async t => {
  const f = setup(t), refreshed: unknown[] = [];
  const original = f.client;
  original.replaceLocalWorkspaceSubscription(workspaceId as any);
  const queue = { ingestServerEvent: async (...args: unknown[]) => { refreshed.push(args.slice(1)); } };
  // 使用相同真实 WS adapter，只替换已有队列 store 的消费边界。
  const client = createWebSocketClient({ config: f.config, chat: { markWorkspaceSubscribed() {} },
    presence: {}, engine: {}, threadQueue: queue } as any);
  client.replaceLocalWorkspaceSubscription(workspaceId as any);
  client.receiveDesktopEvent({ t: "thread.queue.changed", workspaceId: workspaceId as any, threadId: "thread" as any, reason: "paused" });
  client.receiveDesktopEvent({ t: "thread.queue.changed", workspaceId: "other:workspace" as any, threadId: "thread" as any, reason: "paused" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(refreshed, [[workspaceId, "thread"]]);
});

test("local queue API failure reaches the existing error boundary and permits the next refresh", async t => {
  const f = setup(t), errors: string[] = [], warnings: unknown[][] = [];
  const queue = useThreadQueueStore(createPinia());
  const slot = queue.ensureSlot("thread" as any);
  slot.state = { ...slot.state, workspaceId: workspaceId as any, paused: true, pausedReason: "user_pause" };
  let failed = true;
  Object.assign(window, { codeflowDesktop: { getState: async () => ({}), request: async () => failed
    ? { status: 503, body: { ok: false, code: "INTERNAL", message: "queue read failed", details: { requestId: "queue-failure" } } }
    : { status: 200, body: { ok: true, items: [], state: { ...slot.state, paused: false, pausedReason: null } } } } });
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  const client = createWebSocketClient({ config: f.config, chat: { markWorkspaceSubscribed() {} }, presence: {}, engine: {},
    threadQueue: queue, onError: (error: string) => { errors.push(error); } } as any);
  client.replaceLocalWorkspaceSubscription(workspaceId as any);
  client.receiveDesktopEvent({ t: "thread.queue.changed", workspaceId: workspaceId as any, threadId: "thread" as any, reason: "paused" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ["本机队列刷新失败：queue read failed"]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0]![1], { workspaceId, threadId: "thread", code: "INTERNAL", requestId: "queue-failure", reason: "queue read failed" });
  assert.equal((warnings[0]![2] as { code: string }).code, "INTERNAL");
  assert.equal(slot.error, "queue read failed");
  assert.equal(slot.loading, false);
  assert.equal(slot.state.paused, true);
  failed = false;
  client.receiveDesktopEvent({ t: "thread.queue.changed", workspaceId: workspaceId as any, threadId: "thread" as any, reason: "resumed" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(slot.error, null);
  assert.equal(slot.state.paused, false);
  assert.equal(errors.length, 1);
});

test("old shell event capability fails explicitly and subscription releases its listener", (t) => {
  setup(t);
  const bridge = { getState: async () => ({}), request: async () => ({}) } as unknown as DesktopBridgeApi;
  Object.assign(window, { codeflowDesktop: bridge });
  assert.throws(() => subscribeDesktopEvents(() => {}), /DESKTOP_EVENT_BRIDGE_REQUIRED/);
  let released = 0;
  bridge.onEvent = () => () => { released += 1; };
  const stop = subscribeDesktopEvents(() => {});
  stop();
  assert.equal(released, 1);
});

test("workspace selection change cannot render an already queued local event into the next scope", async (t) => {
  const f = setup(t);
  f.client.replaceLocalWorkspaceSubscription(workspaceId as any);
  f.client.receiveDesktopEvent({ t: "conversation.event", event: event(1) });
  f.config.workspaceId = "local-client:next";
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(f.applied, []);
});

test("remote tail cannot enter the newly selected local workspace before its subscription is ready", async (t) => {
  const f = setup(t);
  const remote = "other-client:workspace";
  const sockets: any[] = [];
  class Socket {
    static OPEN = 1;
    OPEN = 1;
    readyState = 1;
    sent: any[] = [];
    onmessage?: (event: { data: string }) => void;
    /** 接收和发送使用实际 WS adapter 的 JSON 边界。 */
    constructor(_url: string) { sockets.push(this); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close() {}
    emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: true, bridgeToken: "local-test" }), { status: 200 }));
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { value: Socket, configurable: true });
  t.after(() => {
    f.client.disconnect();
    if (originalSocket) Object.defineProperty(globalThis, "WebSocket", originalSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  });
  Object.assign(f.config, { workspaceId: remote, serverWsOrigin: "ws://server", wsWebUrl: "ws://server/ws/web",
    ensureSession: async () => "local-session", setLastBackfillCount() {} });
  const subscription = f.client as any;
  await subscription.connect();
  const pending = subscription.replaceWorkspaceSubscription(remote);
  const socket = sockets[0]!;
  socket.emit({ t: "web.subscribeAck", requestId: socket.sent.at(-1).requestId, workspaceId: remote, bufferedCount: 0 });
  await pending;
  f.config.workspaceId = workspaceId;
  socket.emit({ t: "conversation.event", event: event(1, remote) });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(f.applied, []);
});

/** 本机终端控制面测试夹具：只提供现有 store/桥接边界。 */
function terminalSetup(t: test.TestContext, options: { linked?: boolean } = {}) {
  const f = setup(t);
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  const listed: unknown[][] = [], listAll: unknown[] = [], online: string[][] = [], errors: unknown[][] = [];
  const bridge = {
    getState: async () => ({}),
    request: async (request: { method: string; body?: Record<string, unknown> }) => {
      requests.push({ method: request.method, body: request.body ?? {} });
      if (request.method === "terminal.list") {
        return { status: 200, body: { ok: true, terminals: [{ id: "term-1", clientId: "local-client", workspaceId, label: "Terminal", shell: null,
          cwd: null, status: "running", exitCode: null, createdAt: 1, foregroundProcess: null, scrollback: "hello" }] } };
      }
      return { status: 200, body: { ok: true } };
    },
  };
  Object.assign(window, { codeflowDesktop: bridge });
  const config = { ...f.config, isDesktop: true, desktopCloudAccountLinked: options.linked === true };
  const terminal = {
    onTerminalListed: (...args: unknown[]) => { listed.push(args); },
    onTerminalListAllResult: (message: unknown) => { listAll.push(message); },
    syncOnlineClients: (clientIds: string[]) => { online.push(clientIds); },
    onTerminalError: (...args: unknown[]) => { errors.push(args); },
    failListAll: (...args: unknown[]) => { errors.push(["failListAll", ...args]); },
    onTerminalCreated: () => {}, onTerminalOutput: () => {}, onTerminalExited: () => {}, onTerminalClosed: () => {},
    onTerminalRenamed: () => {}, onTerminalForegroundChanged: () => {},
  };
  const client = createWebSocketClient({ config, chat: { markWorkspaceSubscribed() {} }, presence: {}, engine: {}, terminal } as any);
  return { ...f, client, config, terminal, requests, listed, listAll, online, errors };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("local desktop terminal messages use the bridge API and never the WebSocket", async (t) => {
  const f = terminalSetup(t);
  assert.equal(f.client.sendTerminal({ t: "terminal.input", clientId: "local-client", workspaceId, terminalId: "term-1", data: "ls" }), true);
  assert.equal(f.client.sendTerminal({ t: "terminal.resize", clientId: "local-client", workspaceId, terminalId: "term-1", cols: 80, rows: 24 }), true);
  await settle();
  assert.deepEqual(f.requests, [
    { method: "terminal.input", body: { workspaceId, terminalId: "term-1", data: "ls" } },
    { method: "terminal.resize", body: { workspaceId, terminalId: "term-1", cols: 80, rows: 24 } },
  ]);
  assert.deepEqual(f.errors, []);
});

test("local desktop terminal list and listAll synthesize the existing store projections", async (t) => {
  const f = terminalSetup(t);
  f.client.sendTerminal({ t: "terminal.list", clientId: "local-client", workspaceId, requestId: "list-1" });
  await settle();
  assert.deepEqual(f.listed[0]?.slice(0, 3), ["local-client", workspaceId, "list-1"]);
  assert.equal((f.listed[0]?.[3] as Array<{ clientId: string }>)[0]?.clientId, "local-client");

  f.client.sendTerminal({ t: "terminal.listAll", requestId: "all-1" });
  await settle();
  assert.deepEqual(f.online.at(-1), ["local-client"]);
  assert.deepEqual(f.listAll.at(-1), { t: "terminal.listAll.result", requestId: "all-1",
    targets: [{ clientId: "local-client", workspaceId }],
    terminals: [{ id: "term-1", clientId: "local-client", workspaceId, label: "Terminal", shell: null, cwd: null,
      status: "running", exitCode: null, createdAt: 1, foregroundProcess: null, scrollback: "hello" }], failures: [] });
});

test("local desktop terminal controls stay ordered across async bridge requests", async (t) => {
  const f = terminalSetup(t);
  const order: string[] = [];
  const request = window.codeflowDesktop!.request;
  window.codeflowDesktop!.request = async (value) => { order.push(`${value.method}:${String(value.body?.data ?? value.body?.terminalId)}`); await settle(); return request(value); };
  f.client.sendTerminal({ t: "terminal.input", clientId: "local-client", workspaceId, terminalId: "term-1", data: "first" });
  f.client.sendTerminal({ t: "terminal.input", clientId: "local-client", workspaceId, terminalId: "term-1", data: "second" });
  f.client.sendTerminal({ t: "terminal.close", clientId: "local-client", workspaceId, terminalId: "term-1" });
  await settle(); await settle(); await settle();
  assert.deepEqual(order, ["terminal.input:first", "terminal.input:second", "terminal.close:term-1"]);
});

test("linked desktop accounts keep local terminal controls on the desktop bridge", async (t) => {
  const f = terminalSetup(t, { linked: true });
  assert.equal(f.client.sendTerminal({ t: "terminal.input", clientId: "local-client", workspaceId, terminalId: "term-1", data: "ls" }), true);
  await settle();
  assert.deepEqual(f.requests, [{ method: "terminal.input", body: { workspaceId, terminalId: "term-1", data: "ls" } }]);
});
