import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import ts from "typescript";
import { useAccountStore } from "../src/store/account.ts";
import { useConfigStore } from "../src/store/config.ts";
import { createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";

/** 仅控制外部响应时序，保留实际 store 登录和认证上下文。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 安装受控 preload；浏览器分支没有桥，均不连接真实 Server。 */
function setup(t: test.TestContext, request?: (input: any) => Promise<any>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: request ? { codeflowDesktop: {
    request, getState: async () => ({ status: "ready" }),
  } } : undefined });
  t.after(() => previous ? Object.defineProperty(globalThis, "window", previous) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.serverWsOrigin = "wss://cloud.example";
  config.desktopRuntime = { status: "ready", requestId: "runtime", releaseId: null, errorCode: null };
  return { config, account: useAccountStore() };
}

const login = (userId: string) => ({ email: `${userId}@example.test`, password: "test", captchaToken: "test" });
const loginBody = (userId: string) => ({ ok: true, sessionToken: `session-${userId}`, sessionExpiresAt: Date.now() + 60_000,
  userSummary: { userId }, accountRole: "personal_normal", accessContext: {}, homePath: `/chat?from=${userId}` });
const loginResponse = (userId: string) => new Response(JSON.stringify(loginBody(userId)));
const cloudResponse = (userId: string | null, generation: number) => ({ status: 200, body: { ok: true, account: {
  status: userId ? "linked" : "unlinked", generation, serverOrigin: userId ? "https://cloud.example" : null,
  userSummary: userId ? { userId } : null, errorCode: null,
} } });

test("browser login keeps B when the older A response arrives last", async (t) => {
  const { config, account } = setup(t);
  const requests = new Map<string, ReturnType<typeof deferred<Response>>>();
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const pending = deferred<Response>();
    requests.set(JSON.parse(String(init?.body)).email, pending);
    return pending.promise;
  });
  const first = account.login(login("A"));
  const second = account.login(login("B"));
  requests.get("B@example.test")!.resolve(loginResponse("B"));
  await second;
  const rejection = assert.rejects(first, isCancelledRequestError);
  requests.get("A@example.test")!.resolve(loginResponse("A"));
  await rejection;
  assert.equal(config.userSummary?.userId, "B");
  assert.equal(config.sessionToken, "session-B");
});

for (const change of ["logout", "cancel", "origin"] as const) {
  test(`browser pending login cannot restore an account after ${change}`, async (t) => {
    const { config, account } = setup(t);
    config.$patch({ authMode: "account", accountRole: "personal_normal", sessionToken: "session-old",
      sessionExpiresAt: Date.now() + 60_000, userSummary: { userId: "old" } as any });
    const pending = deferred<Response>();
    t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => String(url).endsWith("/login")
      ? pending.promise : new Response(JSON.stringify(String(url).endsWith("/logout")
        ? { ok: true, loggedOutAt: 1 } : { ok: true, userId: "old", cancelledAt: 1 })));
    const first = account.login(login("A"));
    if (change === "origin") config.serverWsOrigin = "wss://other.example";
    else if (change === "logout") await account.logout();
    else await account.cancelAccount({ reason: "other" });
    const rejection = assert.rejects(first, isCancelledRequestError);
    pending.resolve(loginResponse("A"));
    await rejection;
    assert.equal(config.sessionToken, change === "origin" ? "session-old" : null);
  });
}

test("desktop login cannot return old success after B takes ownership during A's link", async (t) => {
  const pendingA = deferred<any>();
  const startedA = deferred<void>();
  const { config, account } = setup(t, async (request) => {
    if (request.method.endsWith("unlink")) return cloudResponse(null, 1);
    if (request.body.sessionToken === "session-A") { startedA.resolve(); return pendingA.promise; }
    return cloudResponse("B", 3);
  });
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) =>
    loginResponse(JSON.parse(String(init?.body)).email.startsWith("A") ? "A" : "B"));
  const first = account.login(login("A"));
  await startedA.promise;
  await account.login(login("B"));
  const rejection = assert.rejects(first, isCancelledRequestError);
  pendingA.resolve(cloudResponse("A", 2));
  await rejection;
  assert.equal(config.userSummary?.userId, "B");
  assert.equal(config.desktopCloudAccount?.userSummary?.userId, "B");
});

test("a pending browser login cannot replace a session established by another authentication entry", async (t) => {
  const { config, account } = setup(t);
  const pending = deferred<Response>();
  t.mock.method(globalThis, "fetch", async () => pending.promise);
  const run = account.login(login("A"));
  config.sessionToken = "session-B";
  config.userSummary = { userId: "B" } as any;
  const rejection = assert.rejects(run, isCancelledRequestError);
  pending.resolve(loginResponse("A"));
  await rejection;
  assert.equal(config.sessionToken, "session-B");
});

for (const desktop of [false, true]) {
  test(`${desktop ? "desktop" : "browser"} current login still installs its own session`, async (t) => {
    const { config, account } = setup(t, desktop ? async (request) => cloudResponse(request.method.endsWith("unlink") ? null : "A", 2) : undefined);
    t.mock.method(globalThis, "fetch", async () => loginResponse("A"));
    const result = await account.login(login("A"));
    assert.equal(result.ok, true);
    assert.equal(config.sessionToken, "session-A");
    assert.equal(config.userSummary?.userId, "A");
  });
}

test("login network failure preserves the API failure contract and records one safe failure", async (t) => {
  const { config, account } = setup(t);
  const failure = new TypeError("secret-password-never-log");
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async () => { throw failure; });
  const result = await account.login(login("A"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "CLIENT_ERROR");
  assert.equal(config.sessionToken, null);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /secret-password-never-log|A@example/u);
});

/** 执行实际登录 submit，记录用户可见的提示、导航和错误。 */
function submitLogin(result: object | Error, takeOver = false) {
  const source = readFileSync(new URL("../src/features/account/components/auth-login-page.vue", import.meta.url), "utf8");
  const start = source.indexOf("async function submit()");
  const end = source.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start);
  const config = { serverWsOrigin: "wss://cloud.example", sessionToken: "session-A", userSummary: { userId: "A" } };
  const events: string[] = [];
  const submitting = ref(false);
  const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
  const submit = new Function("config", "account", "prepareLoginSubmit", "submitting", "form", "captchaEnabled", "captchaToken", "setError",
    "clearError", "lockedUntil", "resetCaptchaAfterLoginFailure", "trackProductEventWithEmail", "message", "router", "route",
    "resolvePostLoginTarget", "createCancelledRequestError", "isCancelledRequestError", code + "\nreturn submit;")(
    config, { login: async () => {
      if (result instanceof Error) throw result;
      if (takeOver) queueMicrotask(() => { config.sessionToken = "session-B"; config.userSummary = { userId: "B" }; });
      return result;
    } }, () => {}, submitting, { email: "A@example.test", password: "test" }, false, ref(""),
    () => events.push("error"), () => {}, ref(0), () => events.push("reset-captcha"),
    (name: string) => events.push(name), { success: () => events.push("success") }, { push: async () => { events.push("navigate"); } },
    { query: {} }, () => "/chat", createCancelledRequestError, isCancelledRequestError,
  ) as () => Promise<any>;
  return { submit, config, events, submitting };
}

test("login page cannot report A success or navigate after B logs in before its continuation", async () => {
  const fixture = submitLogin(loginBody("A"), true);
  await assert.rejects(fixture.submit(), isCancelledRequestError);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.submitting.value, false);
});

test("login page keeps a network failure explicit and shows it before releasing busy", async () => {
  const error = new TypeError("network unavailable");
  const fixture = submitLogin(error);
  await assert.rejects(fixture.submit(), (failure) => failure === error);
  assert.deepEqual(fixture.events, ["error"]);
  assert.equal(fixture.submitting.value, false);
});

test("current login page success still reports success and navigates", async () => {
  const fixture = submitLogin(loginBody("A"));
  await fixture.submit();
  assert.deepEqual(fixture.events, ["auth_success", "success", "navigate"]);
});

test("login page keeps scope cancellation rejected without failure UI", async () => {
  const fixture = submitLogin(createCancelledRequestError("scope-change"));
  await assert.rejects(fixture.submit(), isCancelledRequestError);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.submitting.value, false);
});

test("login page returns an explicit API failure while keeping captcha failure handling", async () => {
  const failure = { ok: false, code: "UNAUTHORIZED", message: "wrong password", details: { remainingAttempts: 2 } };
  const fixture = submitLogin(failure);
  const result = await fixture.submit();
  assert.equal(result, failure);
  assert.deepEqual(fixture.events, ["auth_failed", "reset-captcha", "error"]);
  assert.equal(fixture.submitting.value, false);
});
