import assert from "node:assert/strict";
import test from "node:test";
import { createPinia } from "pinia";
import { createWebSocketClient } from "../src/services/ws.ts";
import { terminalKey, useTerminalStore } from "../src/store/terminal.ts";

const workspaceId = "local-client:workspace";
const nextWorkspaceId = "local-client:next";

/** 运行真实 WS 路由与终端 store，仅替换网络和桌面 IPC 边界。 */
function fixture(t: test.TestContext, linked = true) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(events, { setTimeout, clearTimeout }) });
  const requests: any[] = [], sockets: Socket[] = [], logs: unknown[][] = [];
  class Socket {
    static OPEN = 1;
    OPEN = 1;
    readyState = 1;
    sent: any[] = [];
    onmessage?: (event: { data: string }) => void;
    constructor(_url: string) { sockets.push(this); }
    /** 保留原消息编码，记录外发副作用。 */
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close() {}
    /** 经生产 onmessage 处理入站消息。 */
    emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: Socket });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: true, bridgeToken: "test" }), { status: 200 }));
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
  Object.assign(window, { codeflowDesktop: { getState: async () => ({}), request: async (request: any) => {
    requests.push(request);
    return { status: 200, body: { ok: true, terminals: [] } };
  } } });
  const config = { workspaceId, localRuntimeReady: true, isDesktop: true, connected: false, desktopCloudAccountLinked: linked,
    desktopClient: { clientId: "local-client", workspaceIds: [workspaceId, nextWorkspaceId] }, serverWsOrigin: "ws://server", wsWebUrl: "ws://server/ws/web",
    ensureSession: async () => "test", setConnectionStatus() {}, setLastBackfillCount() {} };
  const terminal = useTerminalStore(createPinia());
  const client = createWebSocketClient({ config, terminal, chat: { markWorkspaceSubscribed() {} },
    presence: { ready: false, clearSharedWriterPresenceSnapshot() {} }, engine: {} } as any);
  client.replaceLocalWorkspaceSubscription(workspaceId as any);
  t.after(() => {
    client.disconnect();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
    if (originalSocket) Object.defineProperty(globalThis, "WebSocket", originalSocket); else Reflect.deleteProperty(globalThis, "WebSocket");
  });
  return { config, terminal, client, requests, sockets, logs };
}

/** 等待原串行 IPC 队列完成一轮。 */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

for (const linked of [false, true]) {
  test(`本机终端在账号关联=${linked}且Web断连时只执行一次桌面输入`, async t => {
    const f = fixture(t, linked);
    assert.equal(f.client.sendTerminal({ t: "terminal.input", clientId: "local-client", workspaceId, terminalId: "term", data: "echo test" }), true);
    await settle();
    assert.deepEqual(f.requests, [{ method: "terminal.input", body: { workspaceId, terminalId: "term", data: "echo test" } }]);
    assert.equal(f.sockets.length, 0);
  });
}

test("云连接断开只清除远端在线状态，本机终端仍可操作", t => {
  const f = fixture(t);
  f.terminal.syncOnlineClients(["local-client", "remote-client"]);
  f.client.disconnect();
  assert.deepEqual(f.terminal.onlineClientIds, ["local-client"]);
});

test("指定其他Client的终端控制保持WS，不能因同名工作区进入本机", async t => {
  const f = fixture(t);
  await f.client.connect();
  const message = { t: "terminal.input" as const, clientId: "remote-client", workspaceId, terminalId: "term", data: "remote" };
  assert.equal(f.client.sendTerminal(message), true);
  await settle();
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.sockets[0]!.sent, [message]);
});

test("本机实时输出只应用桌面副本，远端输出保留且旧工作区隔离", async t => {
  const f = fixture(t);
  await f.client.connect();
  const output = { t: "terminal.output" as const, clientId: "local-client", workspaceId, terminalId: "term", data: "once" };
  f.client.receiveDesktopEvent(output);
  f.sockets[0]!.emit(output);
  assert.equal(f.terminal.scrollbackByTerminalKey[terminalKey({ clientId: "local-client", workspaceId, id: "term" })], "once");
  f.sockets[0]!.emit({ ...output, clientId: "remote-client", data: "remote" });
  assert.equal(f.terminal.scrollbackByTerminalKey[terminalKey({ clientId: "remote-client", workspaceId, id: "term" })], "remote");
  f.config.workspaceId = nextWorkspaceId;
  f.client.replaceLocalWorkspaceSubscription(nextWorkspaceId as any);
  f.client.receiveDesktopEvent({ ...output, data: "late" });
  assert.equal(f.terminal.scrollbackByTerminalKey[terminalKey({ clientId: "local-client", workspaceId, id: "term" })], "once");
});

test("账号聚合在线时仍走WS，断连后可读取本机列表", async t => {
  const f = fixture(t);
  await f.client.connect();
  f.config.connected = true;
  assert.equal(f.client.sendTerminal({ t: "terminal.listAll", requestId: "online" }), true);
  await settle();
  assert.deepEqual(f.sockets[0]!.sent, [{ t: "terminal.listAll", requestId: "online" }]);
  assert.equal(f.requests.length, 0);
  f.client.disconnect(); f.config.connected = false;
  f.terminal.beginListAll("offline");
  assert.equal(f.client.sendTerminal({ t: "terminal.listAll", requestId: "offline" }), true);
  await settle();
  assert.equal(f.requests[0].method, "terminal.list");
  assert.equal(f.terminal.listLoading, false);
});

test("本机API失败显式报错并保留诊断，不回退WS", async t => {
  const f = fixture(t);
  await f.client.connect();
  window.codeflowDesktop!.request = async () => ({ status: 503, body: { ok: false, code: "PTY_UNAVAILABLE", message: "pty failed", details: { requestId: "failure-1" } } });
  const errors: any[] = [];
  window.addEventListener("terminal:error", event => { errors.push((event as CustomEvent).detail); });
  f.client.sendTerminal({ t: "terminal.create", workspaceId, requestId: "create-failed" });
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].requestId, "create-failed");
  assert.equal(f.logs[0]![1] && (f.logs[0]![1] as any).errorCode, "PTY_UNAVAILABLE");
  assert.deepEqual(f.sockets[0]!.sent, []);
});

test("切换工作区后迟到的本机聚合结果不覆盖新范围", async t => {
  const f = fixture(t);
  let respond!: (response: any) => void;
  window.codeflowDesktop!.request = async () => new Promise(resolve => { respond = resolve; });
  f.terminal.beginListAll("old-list");
  f.client.sendTerminal({ t: "terminal.listAll", requestId: "old-list" });
  await settle();
  f.config.workspaceId = nextWorkspaceId;
  f.client.replaceLocalWorkspaceSubscription(nextWorkspaceId as any);
  f.terminal.beginListAll("new-list");
  respond({ status: 200, body: { ok: true, terminals: [] } });
  await settle();
  assert.equal(f.terminal.listRequestId, "new-list");
  assert.equal(f.terminal.listLoading, true);
  assert.equal(f.logs.length, 1);
});
