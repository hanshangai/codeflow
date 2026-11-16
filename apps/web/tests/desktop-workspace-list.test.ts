import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceSummary } from "@codeflowai/shared";
import { listWorkspaces } from "../src/api/workspaces/index.ts";
import { isCancelledRequestError } from "../src/api/request.ts";
import { createPinia, setActivePinia } from "pinia";
import { useConfigStore } from "../src/store/config.ts";
import { useWorkspacesStore } from "../src/store/workspaces.ts";

const local = { id: "desktop:local", title: "Local", path: "C:/project", createdAt: 1, updatedAt: 1, kind: "local" } as WorkspaceSummary;
const shared = { id: "shared:joined", title: "Joined", path: "Joined", createdAt: 2, updatedAt: 2, kind: "shared", entryStatus: "host_offline" } as WorkspaceSummary;
const online = { serverWsOrigin: "wss://cloud.test", sessionToken: "session", webSessionId: "web", desktopClientId: "desktop" };

/** 只模拟 IPC 与 HTTP 边界；执行真实列表聚合和请求取消逻辑。 */
function fixture(t: test.TestContext, desktop = true) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: string[] = [];
  const bridge = { getState: async () => ({}), request: async () => { calls.push("local"); return { status: 200, body: { ok: true, workspaces: [local] } }; } };
  Object.defineProperty(globalThis, "window", { value: desktop ? { codeflowDesktop: bridge } : {}, configurable: true });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(url));
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer session");
    return new Response(JSON.stringify({ ok: true, workspaces: [
      { ...local, hostedSharedCount: 1 }, shared,
    ], workspaceListAuthoritative: true, activeClientCount: 1, workspaceListSuccessCount: 1, workspaceListFailureCount: 0 }));
  });
  return { calls, bridge };
}

test("桌面联网列表合并已加入共享入口并保留本地托管标记，不重复本地条目", async t => {
  const f = fixture(t);
  const result = await listWorkspaces(online, { currentWorkspaceId: shared.id });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.workspaces.map(w => w.id), [local.id, shared.id]);
  assert.equal(result.workspaces[0]?.hostedSharedCount, 1);
  assert.equal(result.workspaces[1]?.entryStatus, "host_offline");
  assert.equal(result.workspaceListAuthoritative, true);
  assert.deepEqual(f.calls, ["local", "https://cloud.test/api/workspaces?currentWorkspaceId=shared%3Ajoined"]);
});

for (const ctx of [{ ...online, sessionToken: null }, { ...online, webSessionId: null }]) {
  test(`桌面未登录或云连接断开时仍独立读取本地：${ctx.sessionToken === null ? "logout" : "offline"}`, async t => {
    const f = fixture(t);
    const result = await listWorkspaces(ctx);
    assert.deepEqual(result, { ok: true, workspaces: [local] });
    assert.deepEqual(f.calls, ["local"]);
  });
}

test("云端没有本机投影时，合并列表仍保留 IPC 的本地工作区", async t => {
  fixture(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: true, workspaces: [shared] })));
  const result = await listWorkspaces(online);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.workspaces, [local, shared]);
});

test("首次启动显式仅读本机时，已有云会话也不等待账号列表", async t => {
  const f = fixture(t);
  assert.deepEqual(await listWorkspaces(online, { localOnly: true }), { ok: true, workspaces: [local] });
  assert.deepEqual(f.calls, ["local"]);
});

test("云端列表失败显式返回原失败，不能伪装成只有本地的成功列表", async t => {
  fixture(t);
  const failure = { ok: false, code: "FORBIDDEN", message: "共享工作区权限读取失败", details: { requestId: "cloud-list" } };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(failure), { status: 403 }));
  assert.deepEqual(await listWorkspaces(online), failure);
});

test("本机列表失败时停止聚合，不继续发起云请求", async t => {
  const f = fixture(t);
  f.bridge.request = async () => { throw new Error("LOCAL_LIST_FAILED"); };
  await assert.rejects(listWorkspaces(online), /LOCAL_LIST_FAILED/);
  assert.deepEqual(f.calls, []);
});

test("取消在途云列表后不返回旧账号的合并结果", async t => {
  fixture(t);
  let release!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, "fetch", async () => { started(); return new Promise<Response>(resolve => { release = resolve; }); });
  const controller = new AbortController();
  const pending = listWorkspaces(online, { signal: controller.signal });
  const rejected = assert.rejects(pending, isCancelledRequestError);
  await ready;
  controller.abort("scope-change");
  release(new Response(JSON.stringify({ ok: true, workspaces: [shared] })));
  await rejected;
});

test("纯 Web 仅请求服务端权威列表", async t => {
  const f = fixture(t, false);
  const result = await listWorkspaces(online);
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls, ["https://cloud.test/api/workspaces"]);
});

for (const [status, restore] of [[200, false], [401, false], [200, true], [401, true]] as const) {
  test(`切换账号并重置列表后，旧云响应 ${status} 不回填共享入口或清除新会话${restore ? "，即使恢复原会话值" : ""}`, async t => {
    fixture(t);
    setActivePinia(createPinia());
    const config = useConfigStore(), store = useWorkspacesStore();
    config.serverWsOrigin = online.serverWsOrigin;
    config.sessionToken = online.sessionToken;
    config.webSessionId = online.webSessionId;
    let release!: (response: Response) => void, started!: () => void, clears = 0;
    const ready = new Promise<void>(resolve => { started = resolve; });
    t.mock.method(globalThis, "fetch", async () => { started(); return new Promise<Response>(resolve => { release = resolve; }); });
    const pending = store.refresh({ ...online, clearSession: () => { clears++; } });
    await ready;
    config.sessionToken = "new-account-session";
    config.webSessionId = "new-web-session";
    if (restore) { config.sessionToken = online.sessionToken; config.webSessionId = online.webSessionId; }
    store.$reset();
    release(new Response(JSON.stringify(status === 200 ? { ok: true, workspaces: [shared] }
      : { ok: false, code: "UNAUTHORIZED", message: "旧会话已退出" }), { status }));
    await pending;
    assert.deepEqual(store.workspaces, []);
    assert.equal(store.lastError, null);
    assert.equal(config.sessionToken, restore ? online.sessionToken : "new-account-session");
    assert.equal(clears, 0);
  });
}

test("当前账号自身收到 401 时保留明确认证失败，不能当作旧账号取消", async t => {
  fixture(t);
  setActivePinia(createPinia());
  const config = useConfigStore(), store = useWorkspacesStore();
  config.serverWsOrigin = online.serverWsOrigin;
  config.sessionToken = online.sessionToken;
  config.webSessionId = online.webSessionId;
  config.authMode = "account";
  config.accountRole = "personal_normal";
  config.userSummary = { userId: "owner" } as typeof config.userSummary;
  config.sessionExpiresAt = Date.now() + 60_000;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "账号会话已过期，请重新登录" }), { status: 401 }));
  await assert.rejects(store.refresh({ ...online, ensureSession: () => config.ensureSession(), clearSession: () => config.clearSession() }),
    (error: unknown) => error instanceof Error && /账号会话已过期/u.test(error.message));
  assert.match(store.lastError ?? "", /账号会话已过期/u);
  assert.equal(config.sessionToken, null);
});
