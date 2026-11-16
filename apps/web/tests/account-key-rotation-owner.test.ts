import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import ts from "typescript";
import { useConfigStore } from "../src/store/config.ts";
import { captureAccountSession, useAccountStore } from "../src/store/account.ts";
import { createApiResultError, createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";

/** 控制真实请求的完成顺序，不替换 store 的认证逻辑。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 只隔离 preload 和网络，保留真实账号 store。 */
function setup(t: test.TestContext, desktop = false) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: desktop ? { codeflowDesktop: {
    getState: async () => ({ status: "ready" }), request: async () => { throw new Error("UNEXPECTED_DESKTOP_REQUEST"); },
  } } : undefined });
  t.after(() => previous ? Object.defineProperty(globalThis, "window", previous) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", accountRole: "personal_normal",
    sessionToken: "session-A", sessionExpiresAt: Date.now() + 60_000, userSummary: { userId: "A" } as any });
  return { config, account: useAccountStore() };
}

/** 构造轮换接口已有的新会话及个人资料合同。 */
function rotation(userId: string) {
  return { ok: true, sessionToken: `rotated-${userId}`, sessionExpiresAt: Date.now() + 60_000,
    authMode: "account", accountRole: "personal_normal", accessContext: {}, homePath: "/chat", userSummary: { userId },
    summary: { userId, email: `${userId}@example.test`, fullName: userId, phone: "", avatarUrl: null,
      accountRole: "personal_normal", accessContext: {}, enterpriseSummary: null } };
}

for (const desktop of [false, true]) for (const status of [200, 401]) {
  test(`${desktop ? "desktop" : "browser"} rotation cannot overwrite or clear B after A's delayed HTTP ${status}`, async (t) => {
    const { config, account } = setup(t, desktop), started = deferred<void>(), reply = deferred<Response>();
    t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer session-A");
      started.resolve(); return reply.promise;
    });
    const run = account.rotateDefaultKey();
    await started.promise;
    config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
    const rejection = assert.rejects(run, isCancelledRequestError);
    reply.resolve(new Response(JSON.stringify(status === 200 ? rotation("A")
      : { ok: false, code: "UNAUTHORIZED", message: "A expired" }), { status }));
    await rejection;
    assert.equal(config.sessionToken, "session-B"); assert.equal(config.userSummary?.userId, "B");
    assert.equal(account.meSummary, null); assert.equal(account.rotatingDefaultKey, false);
  });
}

test("rotation rechecks its owner after asynchronous session validation", async (t) => {
  const { config, account } = setup(t), validated = deferred<string>();
  let requests = 0;
  t.mock.method(config, "ensureSession", async () => validated.promise);
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response(JSON.stringify(rotation("A"))); });
  const run = account.rotateDefaultKey();
  config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
  const rejection = assert.rejects(run, isCancelledRequestError);
  validated.resolve("session-A");
  await rejection; assert.equal(requests, 0); assert.equal(config.sessionToken, "session-B");
});

test("an old rotation cannot release the new account's busy state", async (t) => {
  const { config, account } = setup(t);
  const startedA = deferred<void>(), startedB = deferred<void>(), replyA = deferred<Response>(), replyB = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (new Headers(init?.headers).get("Authorization") === "Bearer session-A") { startedA.resolve(); return replyA.promise; }
    startedB.resolve(); return replyB.promise;
  });
  const first = account.rotateDefaultKey(); await startedA.promise;
  account.resetRuntimeState(); config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
  const second = account.rotateDefaultKey(); await startedB.promise;
  const rejection = assert.rejects(first, isCancelledRequestError); replyA.resolve(new Response(JSON.stringify(rotation("A"))));
  await rejection; assert.equal(account.rotatingDefaultKey, true);
  replyB.resolve(new Response(JSON.stringify(rotation("B")))); await second;
  assert.equal(config.sessionToken, "rotated-B"); assert.equal(account.rotatingDefaultKey, false);
});

test("a late rotation failure cannot report on the expired replacement account", async (t) => {
  const { config, account } = setup(t), started = deferred<void>(), reply = deferred<Response>();
  t.mock.method(globalThis, "fetch", async () => { started.resolve(); return reply.promise; });
  const run = account.rotateDefaultKey(); await started.promise;
  config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any; config.expireCurrentSession();
  const rejection = assert.rejects(run, isCancelledRequestError);
  reply.resolve(new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "cannot rotate" }), { status: 409 }));
  await rejection; assert.equal(config.sessionToken, null);
});

for (const desktop of [false, true]) test(`${desktop ? "desktop" : "browser"} current rotation applies its own new session`, async (t) => {
  const { config, account } = setup(t, desktop);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(rotation("A"))));
  assert.equal((await account.rotateDefaultKey()).ok, true);
  assert.equal(config.sessionToken, "rotated-A"); assert.equal(config.userSummary?.userId, "A");
  assert.equal(account.meSummary?.fullName, "A"); assert.equal(account.rotatingDefaultKey, false);
});

for (const failure of ["api", "network", "expired", "unauthorized"] as const) test(`rotation ${failure} failure stays explicit and records safe context once`, async (t) => {
  const { config, account } = setup(t), logs: unknown[][] = [], error = new TypeError("private-response-text");
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async () => {
    if (failure === "network") throw error;
    return new Response(JSON.stringify({ ok: false, code: failure === "unauthorized" ? "UNAUTHORIZED" : "CONFLICT",
      message: "cannot rotate", details: { requestId: "session-A" } }), { status: failure === "unauthorized" ? 401 : 409 });
  });
  if (failure === "expired") config.sessionExpiresAt = 0;
  if (failure === "network") await assert.rejects(account.rotateDefaultKey(), (cause) => cause === error);
  else {
    const result = await account.rotateDefaultKey();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, failure === "expired" || failure === "unauthorized" ? "UNAUTHORIZED" : "CONFLICT");
  }
  assert.equal(config.sessionToken, failure === "expired" || failure === "unauthorized" ? null : "session-A");
  assert.equal(account.rotatingDefaultKey, false); assert.equal(logs.length, 1);
  assert.equal((logs[0][1] as { userId: string }).userId, "A");
  assert.doesNotMatch(JSON.stringify(logs), /session-A|private-response-text/u);
});

/** 执行原弹窗函数，仅记录外部重连与可见反馈。 */
function rotationHandler(takeOver: boolean, reconnectError?: Error, afterConnect = false, apiFailure = false, actualConnect = false,
  actual?: ReturnType<typeof setup>, afterResult?: () => void, reconnectChange?: () => void) {
  const source = readFileSync(new URL("../src/components/app-shell/app-shell-modals.vue", import.meta.url), "utf8");
  const start = source.indexOf("async function handleRotateDefaultKey("), end = source.indexOf("async function handleChangePassword(", start);
  assert.ok(start >= 0 && end > start);
  const events: string[] = [], logs: unknown[][] = [], result = rotation("A");
  const config = actual?.config ?? useConfigStore(createPinia());
  if (!actual) config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", sessionToken: result.sessionToken, userSummary: result.userSummary as any,
    connected: true, connectionStatus: "connected" });
  /** 在恢复到页面动作前切换到 B。 */
  const replace = () => { config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any; };
  const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
  const shell = { config, connectError: null as string | null, disconnect: () => events.push("disconnect"), connect: async () => {
    events.push("connect"); if (takeOver && afterConnect) replace(); reconnectChange?.(); if (reconnectError) throw reconnectError;
  } };
  if (actualConnect) {
    const appShell = readFileSync(new URL("../src/composables/useAppShell.ts", import.meta.url), "utf8");
    const connectStart = appShell.indexOf("async function connect()"), connectEnd = appShell.indexOf("function disconnect()", connectStart);
    assert.ok(connectStart >= 0 && connectEnd > connectStart);
    const connectionError = { /** 映射实际 ref 值，测试不复制 connect 的错误处理。 */
      get value() { return shell.connectError; }, /** 同步实际 connect 写回的失败态。 */
      set value(value: string | null) { shell.connectError = value; } };
    shell.connect = new Function("logoutInProgress", "connectError", "ws", "isCancelledRequestError", "trackProductEvent",
      ts.transpile(appShell.slice(connectStart, connectEnd), { target: ts.ScriptTarget.ES2022 }) + "\nreturn connect;")(
      { value: false }, connectionError, { connect: async () => { events.push("connect"); throw reconnectError; } },
      isCancelledRequestError, () => events.push("connection-failure"));
  }
  const handler = new Function("account", "shell", "message", "createApiResultError", "createCancelledRequestError", "isCancelledRequestError", "console", "captureAccountSession", code + "\nreturn handleRotateDefaultKey;")(
    { rotateDefaultKey: async () => {
      if (actual) { const response = await actual.account.rotateDefaultKey(); if (afterResult) queueMicrotask(afterResult); return response; }
      const owner = captureAccountSession(config);
      if (takeOver && !afterConnect) queueMicrotask(replace);
      return apiFailure ? { ok: false, code: "CONFLICT", message: "cannot rotate" } : { ...result, assertCurrent: owner.assertCurrent }; } },
    shell,
    { success: () => events.push("success"), error: () => events.push("error"), warning: () => events.push("warning") },
    createApiResultError, createCancelledRequestError, isCancelledRequestError, { error: (...args: unknown[]) => { logs.push(args); } }, captureAccountSession,
  ) as () => Promise<void>;
  return { handler, events, logs, config };
}

test("rotation UI cannot reconnect B or report A's late success", async () => {
  const f = rotationHandler(true); await assert.rejects(f.handler(), isCancelledRequestError); assert.deepEqual(f.events, []);
});

test("rotation UI rechecks its owner after reconnecting", async () => {
  const f = rotationHandler(true, undefined, true);
  await assert.rejects(f.handler(), isCancelledRequestError); assert.deepEqual(f.events, ["disconnect", "connect"]);
});

test("rotation UI keeps reconnect failure rejected after warning", async () => {
  const error = new Error("reconnect unavailable"), f = rotationHandler(false, error);
  await assert.rejects(f.handler(), (failure) => failure === error);
  assert.deepEqual(f.events, ["disconnect", "connect", "warning"]);
});

test("rotation UI API failure remains rejected after its error toast", async () => {
  const f = rotationHandler(false, undefined, false, true);
  await assert.rejects(f.handler(), (error: any) => error.code === "CONFLICT"); assert.deepEqual(f.events, ["error"]);
});

test("rotation UI cannot show an old API failure on B", async () => {
  const f = rotationHandler(true, undefined, false, true);
  await assert.rejects(f.handler(), isCancelledRequestError); assert.deepEqual(f.events, []);
});

test("rotation UI respects the actual shell connect failure state", async () => {
  const f = rotationHandler(false, new Error("reconnect unavailable"), false, false, true);
  await assert.rejects(f.handler(), /reconnect unavailable/u);
  assert.deepEqual(f.events, ["disconnect", "connect", "connection-failure", "warning"]);
  assert.equal(f.logs.length, 1); assert.doesNotMatch(JSON.stringify(f.logs), /rotated-A|session-A|reconnect unavailable/u);
});

for (const replace of [false, true]) test(`rotation UI ${replace ? "cancels old" : "reports owned"} 401 feedback`, async (t) => {
  const actual = setup(t);
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" }), { status: 401 }));
  const f = rotationHandler(false, undefined, false, false, false, actual, replace ? () => {
    actual.config.$patch({ authMode: "account", sessionToken: "session-B", userSummary: { userId: "B" } as any });
    actual.config.expireCurrentSession();
  } : undefined);
  await assert.rejects(f.handler(), replace ? isCancelledRequestError : (error: any) => error.code === "UNAUTHORIZED");
  assert.deepEqual(f.events, replace ? [] : ["error"]);
});

test("rotation UI cannot resume old success after reconnect changes A to B to A", async () => {
  const f = rotationHandler(false, undefined, false, false, false, undefined, undefined, () => {
    const token = f.config.sessionToken, userSummary = f.config.userSummary;
    f.config.$patch({ sessionToken: "session-B", userSummary: { userId: "B" } as any });
    f.config.$patch({ sessionToken: token, userSummary });
  });
  await assert.rejects(f.handler(), isCancelledRequestError); assert.deepEqual(f.events, ["disconnect", "connect"]);
});

test("rotation UI retains the owner installed by the store before its continuation", async (t) => {
  const actual = setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(rotation("A"))));
  const f = rotationHandler(false, undefined, false, false, false, actual, () => {
    const token = actual.config.sessionToken, userSummary = { ...actual.config.userSummary } as any;
    actual.config.$patch({ sessionToken: "session-B", userSummary: { userId: "B" } as any });
    actual.config.$patch({ sessionToken: token, userSummary });
  });
  await assert.rejects(f.handler(), isCancelledRequestError); assert.deepEqual(f.events, []);
});

for (const readFailure of [false, true]) test(`rotation UI reports owned 401 ${readFailure ? "body failure" : "non-JSON"} without replacing the cause`, async (t) => {
  const actual = setup(t), original = new TypeError("private-body-error");
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => ({ status: 401, text: async () => { if (readFailure) throw original; return "private-body-text"; } } as Response));
  const f = rotationHandler(false, undefined, false, false, false, actual);
  await assert.rejects(f.handler(), readFailure ? (error) => error === original : (error: any) => error.code === "NON_JSON");
  assert.deepEqual(f.events, ["error"]);
});
