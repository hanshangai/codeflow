import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useAccountStore } from "../src/store/account.ts";
import { useConfigStore } from "../src/store/config.ts";

const key = "codeflowai_ACCOUNTINSTALLTEST1234567890";
const token = "synthetic-install-account-session";
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
test.afterEach(() => { globalThis.fetch = originalFetch; console.error = originalConsoleError; });

function setup() {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const account = useAccountStore();
  account.resetRuntimeState();
  config.$patch({
    authMode: "account", accountRole: "personal_normal", serverWsOrigin: "ws://192.0.2.10:39280",
    sessionToken: token, sessionExpiresAt: Date.now() + 60_000, connected: false, webSessionId: null,
    userSummary: { userId: "installer-user", email: "installer@example.test", fullName: "Installer", phone: "", avatarUrl: null, accountRole: "personal_normal", status: "active", enterpriseId: null, enterpriseName: null },
  });
  return { config, account };
}

function summary(rawKey = key) {
  return { ok: true, userId: "installer-user", email: "installer@example.test", fullName: "Installer", phone: "", avatarUrl: null, accountRole: "personal_normal", accessContext: "personal", enterpriseSummary: null,
    keySummary: { status: "active", rawKey },
  };
}
const response = (body: object) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("网页登录后可读取安装 Key，不需要 Client 或 WebSocket 会话，并合并并发请求", async () => {
  const { config, account } = setup();
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), "http://192.0.2.10:39280/api/account/me/summary");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    assert.equal(new Headers(init?.headers).has("x-web-session-id"), false);
    return response(summary());
  }) as typeof fetch;
  const results = await Promise.all([account.loadMeSummary(true), account.loadMeSummary(true)]);
  assert.equal(calls, 1);
  assert.equal(results[0]?.keySummary?.rawKey, key);
  assert.equal(results[1]?.keySummary?.rawKey, key);
  assert.equal(config.connected, false);
  assert.equal(config.webSessionId, null);
  assert.equal(account.meLoading, false);
  assert.equal(account.meLoadError, null);
});

test("Key 接口失败明确结束加载，记录脱敏错误，重试后恢复", async () => {
  const { account } = setup();
  const logs: unknown[][] = [];
  console.error = (...args) => { logs.push(args); };
  globalThis.fetch = (async () => response({ ok: false, code: "INTERNAL_ERROR", message: key + token })) as typeof fetch;
  assert.equal(await account.loadMeSummary(true), null);
  assert.equal(account.meLoading, false);
  assert.equal(account.meLoadError?.code, "INTERNAL_ERROR");
  assert.equal(logs.length, 1);
  assert.ok(account.meLoadError?.requestId);
  assert.ok(!JSON.stringify(logs).includes(key) && !JSON.stringify(logs).includes(token));
  assert.ok(!JSON.stringify(account.meLoadError).includes(key));
  globalThis.fetch = (async () => response(summary())) as typeof fetch;
  assert.ok(await account.loadMeSummary(true));
  assert.equal(account.meLoadError, null);
  assert.equal(account.meLoading, false);
});

test("网络异常结束 Key 加载，错误消息不泄露响应内容", async () => {
  const { account } = setup();
  const logs: unknown[][] = [];
  console.error = (...args) => { logs.push(args); };
  globalThis.fetch = (async () => { throw new TypeError(key + token); }) as typeof fetch;
  await assert.rejects(account.loadMeSummary(true));
  assert.equal(account.meLoading, false);
  assert.equal(account.meLoadError?.code, "NETWORK_ERROR");
  assert.equal(logs.length, 1);
  assert.ok(!JSON.stringify(logs).includes(key) && !JSON.stringify(logs).includes(token));
});

for (const staleFails of [false, true]) {
  test(`切换账号或 Server 后不复用旧请求、不显示旧 Key（旧请求${staleFails ? "失败" : "成功"}）`, async () => {
    const { config, account } = setup();
    let resolveOld!: (value: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const old = new Promise<Response>(resolve => { resolveOld = resolve; });
    const nextKey = "codeflowai_NEXTINSTALLTEST1234567890";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) { entered(); return old; }
      return response(summary(nextKey));
    }) as typeof fetch;
    const first = account.loadMeSummary(true);
    await started;
    config.sessionToken = "another-synthetic-session";
    config.serverWsOrigin = "wss://another.example.test";
    account.resetRuntimeState();
    await account.loadMeSummary(true);
    resolveOld(response(staleFails ? { ok: false, code: "INTERNAL_ERROR" } : summary()));
    assert.equal(await first, null);
    assert.equal(calls, 2);
    assert.equal(account.meSummary?.keySummary?.rawKey, nextKey);
    assert.equal(account.meLoadError, null);
    assert.equal(account.meLoading, false);
  });
}
