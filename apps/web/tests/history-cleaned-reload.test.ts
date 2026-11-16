import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { createWebSocketClient } from "../src/services/ws.ts";
import { useConfigStore } from "../src/store/config.ts";
import { useChatStore } from "../src/store/chat.ts";
import { usePresenceStore } from "../src/store/presence.ts";
import { useEngineStore } from "../src/store/engine.ts";

test("历史失效后重读已展示会话，迟到异区通知不触碰当前投影", async () => {
  setActivePinia(createPinia());
  const config = useConfigStore(), chat = useChatStore();
  Object.assign(config, { serverWsOrigin: "ws://127.0.0.1:39280", authMode: "account", accountRole: "personal_normal",
    userSummary: { userId: "history-owner", accountRole: "personal_normal", status: "active" }, sessionToken: "history-session", sessionExpiresAt: Date.now() + 60_000 });
  const original = { window: globalThis.window, socket: globalThis.WebSocket, fetch: globalThis.fetch };
  const sockets: any[] = [], loads: any[] = [], errors: string[] = [];
  class Socket {
    static OPEN = 1; OPEN = 1; readyState = 1; sent: any[] = [];
    onmessage: any; onclose: any; onopen: any;
    /** 记录测试连接，供用例驱动原分发器。 */
    constructor() { sockets.push(this); }
    /** 只替换传输，保留原消息分发及Store失效逻辑。 */
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    /** 正常关闭测试连接并通知原生命周期。 */
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    /** 将受控帧交给原消息分发器。 */
    emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, bridgeToken: "history-bridge" }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  (globalThis as any).window = { setTimeout, clearTimeout };
  (globalThis as any).WebSocket = Socket;
  let client: ReturnType<typeof createWebSocketClient> | undefined;
  try {
    client = createWebSocketClient({ config, chat, presence: usePresenceStore(), engine: useEngineStore(), onError: value => errors.push(value) });
    await client.connect();
    const socket = sockets[0], subscribed = client.replaceWorkspaceSubscription("workspace-a" as never);
    socket.emit({ t: "web.subscribeAck", requestId: socket.sent.at(-1).requestId, workspaceId: "workspace-a", bufferedCount: 0 });
    await subscribed;
    chat.selectedThreadId = "thread-a" as never;
    chat.loadedThreads["thread-a"] = true;
    (chat as any).loadThread = async (_ctx: unknown, body: unknown) => { loads.push(body); };
    socket.emit({ t: "threads.changed", workspaceId: "workspace-a", threadId: "thread-a", kind: "history_cleaned" });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(loads.length, 1);
    assert.equal(loads[0].threadId, "thread-a");
    assert.equal(loads[0].workspaceId, "workspace-a");
    chat.selectedThreadId = null;
    socket.emit({ t: "threads.changed", workspaceId: "workspace-a", threadId: "thread-a", kind: "history_cleaned" });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(loads.length, 2, "非选中投影在前次重读期间再次失效仍须补读");
    const epoch = chat.threadContentEpochByThreadId["thread-a"];
    socket.emit({ t: "threads.changed", workspaceId: "workspace-b", threadId: "thread-a", kind: "history_cleaned" });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(loads.length, 2);
    assert.equal(chat.threadContentEpochByThreadId["thread-a"], epoch);
    (chat as any).loadThread = async () => { throw new Error("HISTORY_READ_FAILED"); };
    socket.emit({ t: "threads.changed", workspaceId: "workspace-a", threadId: "thread-a", kind: "history_cleaned" });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(errors.some(value => value.includes("HISTORY_READ_FAILED")));
  } finally {
    client?.disconnect(); globalThis.fetch = original.fetch;
    (globalThis as any).window = original.window; (globalThis as any).WebSocket = original.socket;
  }
});
