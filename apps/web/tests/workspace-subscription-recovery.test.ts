import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import { createWebSocketClient } from "../src/services/ws.ts";
import { useConfigStore } from "../src/store/config.ts";
import { useChatStore } from "../src/store/chat.ts";
import { usePresenceStore } from "../src/store/presence.ts";
import { useEngineStore } from "../src/store/engine.ts";

import { workspaceSubscriptionMatchesSelection } from "../src/utils/workspaceId.ts";

const shellSource = readFileSync(new URL("../src/composables/useAppShell.ts", import.meta.url), "utf8");
const wsSource = readFileSync(new URL("../src/services/ws.ts", import.meta.url), "utf8");

test("订阅覆盖判定按共享 topic 与本地别名链分别比对", () => {
  assert.equal(workspaceSubscriptionMatchesSelection(null, "workspace-a"), false);
  assert.equal(workspaceSubscriptionMatchesSelection("", "workspace-a"), false);
  assert.equal(workspaceSubscriptionMatchesSelection("workspace-a", "workspace-a"), true);
  assert.equal(workspaceSubscriptionMatchesSelection("workspace-a", "workspace-b"), false);
  // 未选中工作区时不存在订阅要求。
  assert.equal(workspaceSubscriptionMatchesSelection(null, ""), true);
  // 共享工作区按共享 topic 比对，不参与本地别名链。
  assert.equal(workspaceSubscriptionMatchesSelection("shared:topic-1", "shared:topic-1"), true);
  assert.equal(workspaceSubscriptionMatchesSelection("shared:topic-1", "shared:topic-2"), false);
  assert.equal(workspaceSubscriptionMatchesSelection("shared:topic-1", "workspace-a"), false);
});

test("Client 恢复在线时重跑激活以补上工作区订阅", () => {
  assert.match(
    shellSource,
    /workspaceActivation\.phase !== "settled" \|\| !chat\.workspaceActivation\.degraded\) return;[\s\S]*?chat\.requestWorkspaceHydration\(\);[\s\S]*?startAuxiliaryRefresh\(config\.workspaceId\);/u,
  );
});

test("服务端报错与本地订阅失配同时成立时触发一次重新激活", () => {
  assert.match(
    wsSource,
    /if \(msg\.t === "error"\) \{[\s\S]*?if \(!workspaceSubscriptionMatchesSelection\(currentSubscribedWorkspaceId, deps\.config\.workspaceId\)\) \{\s*deps\.chat\.requestWorkspaceHydration\(\);/u,
  );
});

test("个人和共享订阅失败按requestId拒绝，旧错误不能取消新订阅", async () => {
  setActivePinia(createPinia());
  const config = useConfigStore(), chat = useChatStore();
  Object.assign(config, { serverWsOrigin: "ws://127.0.0.1:39280", authMode: "account", accountRole: "personal_normal",
    userSummary: { userId: "owner", accountRole: "personal_normal", status: "active" }, sessionToken: "session", sessionExpiresAt: Date.now() + 60_000 });
  const original = { window: globalThis.window, socket: globalThis.WebSocket, fetch: globalThis.fetch };
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1; OPEN = 1; readyState = 1; sent: any[] = [];
    onmessage?: (event: { data: string }) => void; onclose?: (event: { code: number }) => void;
    /** 保留生产消息处理器，只替换网络边界。 */
    constructor() { sockets.push(this); }
    /** 记录真正发出的订阅请求标识。 */
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    /** 清理受控连接并通知原生命周期。 */
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    /** 将关联失败交给原 WebSocket 处理器。 */
    emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, bridgeToken: "bridge" }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  (globalThis as any).window = { setTimeout, clearTimeout };
  (globalThis as any).WebSocket = Socket;
  let client: ReturnType<typeof createWebSocketClient> | undefined;
  try {
    client = createWebSocketClient({ config, chat, presence: usePresenceStore(), engine: useEngineStore() });
    await client.connect();
    const socket = sockets[0]!;
    const personal = client.replaceWorkspaceSubscription("workspace" as never);
    const personalFailure = assert.rejects(personal, /READ_BARRIER_FAILED/);
    const firstRequestId = socket.sent.at(-1).requestId;
    socket.emit({ t: "error", requestId: firstRequestId, message: "READ_BARRIER_FAILED" });
    await personalFailure;
    const shared = client.subscribeSharedWorkspace("shared-workspace");
    const sharedFailure = assert.rejects(shared, /HOST_EPOCH_STALE/);
    let settled = false;
    void shared.then(() => { settled = true; }, () => { settled = true; });
    socket.emit({ t: "error", requestId: firstRequestId, message: "OLD_FAILURE" });
    await Promise.resolve();
    assert.equal(settled, false);
    socket.emit({ t: "error", requestId: socket.sent.at(-1).message.requestId, message: "HOST_EPOCH_STALE" });
    await sharedFailure;
  } finally {
    client?.disconnect(); globalThis.fetch = original.fetch;
    (globalThis as any).window = original.window; (globalThis as any).WebSocket = original.socket;
  }
});
