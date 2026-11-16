import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import type { CancelMyAccountRequestBody } from "@codeflowai/shared";
import ts from "typescript";
import { useConfigStore } from "../src/store/config.ts";
import { useAccountStore } from "../src/store/account.ts";
import { createApiResultError, createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";

/** 控制请求完成时点，复现真实 store 的异步边界。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 仅替换 preload/HTTP，保留真实账号与会话动作。 */
function setup(t: test.TestContext, desktop = false, request?: (input: any) => Promise<any>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: desktop ? { codeflowDesktop: {
    getState: async () => ({ status: "ready" }),
    request: request ?? (async () => ({ status: 200, body: { ok: true,
      account: { status: "unlinked", generation: 2, serverOrigin: null, userSummary: null, errorCode: null } } })),
  } } : undefined });
  t.after(() => previous ? Object.defineProperty(globalThis, "window", previous) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", accountRole: "personal_normal",
    sessionToken: "session-A", sessionExpiresAt: Date.now() + 60_000, userSummary: { userId: "A" } as any,
    desktopRuntime: { status: "ready", requestId: "runtime", releaseId: null, errorCode: null } });
  return { config, account: useAccountStore() };
}

const input: CancelMyAccountRequestBody = { reason: "other", reasonText: "test" };
const success = () => new Response(JSON.stringify({ ok: true, userId: "A", cancelledAt: Date.now() }));

test("account cancellation must stop before Server when ownership changes during desktop unlink", async (t) => {
  const unlink = deferred<any>();
  const { config, account } = setup(t, true, async () => unlink.promise);
  const authorizations: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("Authorization"));
    return success();
  });
  const run = account.cancelAccount(input);
  config.sessionToken = "session-B";
  config.userSummary = { userId: "B" } as any;
  const rejection = assert.rejects(run, isCancelledRequestError);
  unlink.resolve({ status: 200, body: { ok: true, account: { status: "unlinked", generation: 2 } } });
  await rejection;
  assert.deepEqual(authorizations, []);
  assert.equal(config.sessionToken, "session-B");
});

for (const desktop of [false, true]) {
  for (const status of [200, 401]) {
    test(`${desktop ? "desktop" : "browser"} cancellation cannot clear B after A's delayed HTTP ${status}`, async (t) => {
      const { config, account } = setup(t, desktop);
      const started = deferred<void>();
      const reply = deferred<Response>();
      t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer session-A");
        started.resolve();
        return reply.promise;
      });
      const reset = t.mock.method(account, "resetRuntimeState");
      const run = account.cancelAccount(input);
      await started.promise;
      config.sessionToken = "session-B";
      config.userSummary = { userId: "B" } as any;
      const rejection = assert.rejects(run, isCancelledRequestError);
      reply.resolve(status === 200 ? success() : new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "A expired" }), { status }));
      await rejection;
      assert.equal(config.sessionToken, "session-B");
      assert.equal(config.userSummary?.userId, "B");
      assert.equal(reset.mock.callCount(), 0);
    });
  }
}

/** 执行实际弹窗提交函数，记录其可见提示与导航。 */
function cancellationHandler(outcome: object | Error, takeOver = false) {
  const source = readFileSync(new URL("../src/components/app-shell/app-shell-modals.vue", import.meta.url), "utf8");
  const start = source.indexOf("async function handleCancelAccount(");
  const end = source.indexOf("async function handleSaveProfile", start);
  assert.ok(start >= 0 && end > start);
  const events: string[] = [];
  const config = { serverWsOrigin: "wss://cloud.example", sessionToken: null as string | null, authMode: null as string | null };
  const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
  const handler = new Function("account", "shell", "message", "createApiResultError", "createCancelledRequestError", "isCancelledRequestError", code + "\nreturn handleCancelAccount;")(
    { cancelAccount: async () => {
      if (outcome instanceof Error) throw outcome;
      if (takeOver) queueMicrotask(() => { config.sessionToken = "session-B"; config.authMode = "account"; });
      return outcome;
    } }, { config, router: { push: async () => { events.push("navigate"); } } },
    { success: () => events.push("success"), error: () => events.push("error") },
    createApiResultError, createCancelledRequestError, isCancelledRequestError,
  ) as (value: typeof input) => Promise<void>;
  return { handler, events, config };
}

test("account cancellation UI cannot report success or navigate after a new account logs in", async () => {
  const fixture = cancellationHandler({ ok: true, userId: "A", cancelledAt: 1 }, true);
  await assert.rejects(fixture.handler(input), isCancelledRequestError);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.config.sessionToken, "session-B");
});

test("account cancellation UI surfaces a network failure and keeps it rejected", async () => {
  const error = new TypeError("network unavailable");
  const fixture = cancellationHandler(error);
  await assert.rejects(fixture.handler(input), (failure) => failure === error);
  assert.deepEqual(fixture.events, ["error"]);
});

test("account cancellation UI keeps an API failure explicit", async () => {
  const fixture = cancellationHandler({ ok: false, code: "CONFLICT", message: "cannot cancel" });
  await assert.rejects(fixture.handler(input), (error: any) => error.code === "CONFLICT");
  assert.deepEqual(fixture.events, ["error"]);
});

test("a failed desktop login cannot leave an earlier cancellation busy forever", async (t) => {
  const { account } = setup(t, true);
  const started = deferred<void>();
  const pending = deferred<Response>();
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/cancel")) { started.resolve(); return pending.promise; }
    assert.equal(String(url).endsWith("/login"), true);
    return new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "login failed" }), { status: 401 });
  });
  const run = account.cancelAccount(input);
  await started.promise;
  await account.login({ email: "B@example.test", password: "test", captchaToken: "test" });
  pending.resolve(new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "cancel failed" }), { status: 409 }));
  await run;
  assert.equal(account.cancellingAccount, false);
});

test("an earlier cancellation cannot release the new account's pending cancellation busy state", async (t) => {
  const { config, account } = setup(t);
  const startedA = deferred<void>();
  const startedB = deferred<void>();
  const replyA = deferred<Response>();
  const replyB = deferred<Response>();
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const token = new Headers(init?.headers).get("Authorization");
    if (token === "Bearer session-A") { startedA.resolve(); return replyA.promise; }
    assert.equal(token, "Bearer session-B");
    startedB.resolve();
    return replyB.promise;
  });
  const first = account.cancelAccount(input);
  await startedA.promise;
  account.resetRuntimeState();
  config.sessionToken = "session-B";
  config.userSummary = { userId: "B" } as any;
  const second = account.cancelAccount(input);
  await startedB.promise;
  const rejected = assert.rejects(first, isCancelledRequestError);
  replyA.resolve(success());
  await rejected;
  assert.equal(account.cancellingAccount, true);
  replyB.resolve(new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "cannot cancel B" }), { status: 409 }));
  await second;
  assert.equal(account.cancellingAccount, false);
  assert.equal(config.sessionToken, "session-B");
});

test("cancellation rechecks its owner after asynchronous session validation", async (t) => {
  const { config, account } = setup(t);
  const validated = deferred<string>();
  let requests = 0;
  t.mock.method(config, "ensureSession", async () => validated.promise);
  t.mock.method(globalThis, "fetch", async () => { requests++; return success(); });
  const run = account.cancelAccount(input);
  config.sessionToken = "session-B";
  config.userSummary = { userId: "B" } as any;
  const rejection = assert.rejects(run, isCancelledRequestError);
  validated.resolve("session-A");
  await rejection;
  assert.equal(requests, 0);
  assert.equal(config.sessionToken, "session-B");
  assert.equal(account.cancellingAccount, false);
});

for (const desktop of [false, true]) {
  test(`${desktop ? "desktop" : "browser"} cancellation success clears only its original account`, async (t) => {
    const { config, account } = setup(t, desktop);
    t.mock.method(globalThis, "fetch", async () => success());
    const result = await account.cancelAccount(input);
    assert.equal(result.ok, true);
    assert.equal(config.sessionToken, null);
    assert.equal(config.userSummary, null);
    assert.equal(account.cancellingAccount, false);
  });
}

for (const network of [false, true]) {
  test(`cancellation ${network ? "network" : "API"} failure preserves its session and records safe context`, async (t) => {
    const { config, account } = setup(t);
    const logs: unknown[][] = [];
    const failure = new TypeError("private response text");
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    t.mock.method(globalThis, "fetch", async () => {
      if (network) throw failure;
      return new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "cannot cancel", details: { requestId: "session-A" } }), { status: 409 });
    });
    if (network) await assert.rejects(account.cancelAccount(input), (error) => error === failure);
    else assert.equal((await account.cancelAccount(input)).ok, false);
    assert.equal(config.sessionToken, "session-A");
    assert.equal(account.cancellingAccount, false);
    assert.equal(logs.length, 1);
    assert.equal((logs[0]?.[1] as { userId: string }).userId, "A");
    assert.doesNotMatch(JSON.stringify(logs), /session-A|private response text/u);
  });
}

test("a failed Client unlink prevents any Server cancellation and is logged once", async (t) => {
  const { config, account } = setup(t, true, async () => ({ status: 500, body: { ok: false, code: "INTERNAL_ERROR", message: "unlink failed" } }));
  let requests = 0;
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async () => { requests++; return success(); });
  await assert.rejects(account.cancelAccount(input), /unlink failed/u);
  assert.equal(requests, 0);
  assert.equal(logs.length, 1);
  assert.equal(config.sessionToken, "session-A");
  assert.equal(account.cancellingAccount, false);
});

test("account cancellation UI reports success and navigates for an unchanged logged-out state", async () => {
  const fixture = cancellationHandler({ ok: true, userId: "A", cancelledAt: 1 });
  await fixture.handler(input);
  assert.deepEqual(fixture.events, ["success", "navigate"]);
});

test("account cancellation UI keeps a scope change rejected without an error toast", async () => {
  const fixture = cancellationHandler(createCancelledRequestError("scope-change"));
  await assert.rejects(fixture.handler(input), isCancelledRequestError);
  assert.deepEqual(fixture.events, []);
});

for (const closing of [false, true]) {
  test(`an expired current session is an explicit authentication failure with logout gate ${closing}`, async (t) => {
    const { config, account } = setup(t);
    config.sessionExpiresAt = Date.now() - 1;
    config.setLogoutInProgress(closing);
    let requests = 0;
    const logs: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    t.mock.method(globalThis, "fetch", async () => { requests++; return success(); });
    const result = await account.cancelAccount(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "UNAUTHORIZED");
    assert.equal(requests, 0);
    assert.equal(logs.length, 1);
    assert.equal((logs[0]?.[1] as { userId: string }).userId, "A");
    assert.equal(account.cancellingAccount, false);
  });
}
