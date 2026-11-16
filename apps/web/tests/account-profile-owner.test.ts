import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import ts from "typescript";
import { captureAccountSession, useAccountStore } from "../src/store/account.ts";
import { useConfigStore } from "../src/store/config.ts";
import { createApiResultError, createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";

/** 控制接口时序，保留真实账号与请求入口。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 提供非敏感的实际summary字段，便于验证资料归属。 */
function summary(userId: string) {
  return { ok: true, userId, email: `${userId}@example.test`, fullName: userId, phone: `phone-${userId}`,
    avatarUrl: `avatar-${userId}`, accountRole: "personal_normal", accessContext: {}, enterpriseSummary: null };
}

/** 仅隔离外部窗口；不连接真实Server或访问凭据。 */
function setup(t: test.TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
  t.after(() => previous ? Object.defineProperty(globalThis, "window", previous) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", accountRole: "personal_normal",
    sessionToken: "session-A", sessionExpiresAt: Date.now() + 60_000, userSummary: { userId: "A", fullName: "A" } as any });
  const account = useAccountStore(); account.meSummary = summary("A") as any;
  return { config, account };
}

/** 发起原store动作，不在夹具中复制保存实现。 */
function save(account: ReturnType<typeof useAccountStore>, avatar: boolean) {
  return avatar ? account.updateMyAvatar("new-avatar") : account.updateMyProfile({ fullName: "new-A", phone: "new-phone", avatarUrl: "new-avatar" });
}

for (const avatar of [false, true]) for (const status of [200, 401]) test(`${avatar ? "avatar" : "profile"} late HTTP ${status} cannot modify B`, async (t) => {
  const { config, account } = setup(t), started = deferred<void>(), reply = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer session-A"); started.resolve(); return reply.promise;
  });
  const run = save(account, avatar); await started.promise;
  account.resetRuntimeState(); config.sessionToken = "session-B"; config.userSummary = { userId: "B", fullName: "B" } as any;
  account.meSummary = summary("B") as any;
  const rejection = assert.rejects(run, isCancelledRequestError);
  reply.resolve(new Response(JSON.stringify(status === 200 ? summary("A") : { ok: false, code: "UNAUTHORIZED", message: "expired" }), { status }));
  await rejection;
  assert.equal(config.sessionToken, "session-B"); assert.equal(config.userSummary?.fullName, "B"); assert.equal(account.meSummary?.userId, "B");
});

test("avatar summary's late 401 cannot clear B or proceed to POST", async (t) => {
  const { config, account } = setup(t), started = deferred<void>(), reply = deferred<Response>();
  account.meSummary = null; const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET"); started.resolve(); return reply.promise;
  });
  const run = account.updateMyAvatar("new-avatar"); await started.promise;
  config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
  const rejection = assert.rejects(run, isCancelledRequestError);
  reply.resolve(new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" }), { status: 401 }));
  await rejection; assert.equal(config.sessionToken, "session-B"); assert.deepEqual(methods, ["GET"]);
});

test("avatar rechecks its original owner after summary loading before POST", async (t) => {
  const { config, account } = setup(t); account.meSummary = null;
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET"); return new Response(JSON.stringify(summary("A")));
  });
  const stop = account.$onAction(({ name, after }) => {
    if (name === "loadMeSummary") after(() => { config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any; });
  });
  t.after(stop);
  await assert.rejects(account.updateMyAvatar("new-avatar"), isCancelledRequestError);
  assert.deepEqual(methods, ["GET"]); assert.equal(config.sessionToken, "session-B");
});

test("avatar cannot submit a cached profile belonging to another account", async (t) => {
  const { config, account } = setup(t); let calls = 0;
  config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(JSON.stringify(summary("B"))); });
  await assert.rejects(account.updateMyAvatar("new-avatar"), isCancelledRequestError);
  assert.equal(calls, 0); assert.equal(account.savingMeProfile, false);
});

for (const avatar of [false, true]) test(`${avatar ? "avatar" : "profile"} cannot mistake expired B for A after A's 401 body pauses`, async (t) => {
  const { config, account } = setup(t), reading = deferred<void>(), body = deferred<string>();
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => ({ status: 401, text: async () => { reading.resolve(); return body.promise; } } as Response));
  const run = save(account, avatar); await reading.promise;
  config.setAccountSession({ sessionToken: "session-B", sessionExpiresAt: Date.now() + 60_000, accountRole: "personal_normal",
    userSummary: { userId: "B" }, accessContext: {}, homePath: "/chat" } as any);
  account.resetRuntimeState(); config.expireCurrentSession();
  const rejected = assert.rejects(run, isCancelledRequestError);
  body.resolve(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired A" })); await rejected;
  assert.equal(config.sessionToken, null); assert.equal(account.savingMeProfile, false);
});

test("old profile finally cannot release a new avatar's shared busy state", async (t) => {
  const { config, account } = setup(t), startedA = deferred<void>(), startedB = deferred<void>(), replyA = deferred<Response>(), replyB = deferred<Response>();
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (new Headers(init?.headers).get("Authorization") === "Bearer session-A") { startedA.resolve(); return replyA.promise; }
    startedB.resolve(); return replyB.promise;
  });
  const first = save(account, false); await startedA.promise;
  account.resetRuntimeState(); config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any; account.meSummary = summary("B") as any;
  const second = save(account, true); await startedB.promise;
  const rejected = assert.rejects(first, isCancelledRequestError);
  replyA.resolve(new Response(JSON.stringify(summary("A")))); await rejected;
  assert.equal(account.savingMeProfile, true);
  replyB.resolve(new Response(JSON.stringify(summary("B")))); await second; assert.equal(account.savingMeProfile, false);
});

for (const avatar of [false, true]) test(`${avatar ? "avatar" : "profile"} current save applies its own profile`, async (t) => {
  const { config, account } = setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ...summary("A"), fullName: "updated-A" })));
  assert.equal((await save(account, avatar)).ok, true);
  assert.equal(config.userSummary?.fullName, "updated-A"); assert.equal(account.meSummary?.fullName, "updated-A");
  assert.equal(account.savingMeProfile, false);
});

for (const avatar of [false, true]) for (const failure of ["api", "network", "expired", "unauthorized"] as const)
test(`${avatar ? "avatar" : "profile"} ${failure} failure is explicit, safely logged and releases busy`, async (t) => {
  const { config, account } = setup(t), error = new TypeError("private-response-text"), logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async () => {
    if (failure === "network") throw error;
    return new Response(JSON.stringify({ ok: false, code: failure === "unauthorized" ? "UNAUTHORIZED" : "CONFLICT", message: "cannot update",
      details: { requestId: "session-A" } }), { status: failure === "unauthorized" ? 401 : 409 });
  });
  if (failure === "expired") config.sessionExpiresAt = 0;
  if (failure === "network") await assert.rejects(save(account, avatar), (cause) => cause === error);
  else {
    const result = await save(account, avatar); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, ["expired", "unauthorized"].includes(failure) ? "UNAUTHORIZED" : "CONFLICT");
  }
  assert.equal(account.savingMeProfile, false); assert.equal(logs.length, 1);
  assert.equal((logs[0][1] as { userId: string }).userId, "A"); assert.doesNotMatch(JSON.stringify(logs), /session-A|private-response-text/u);
});

test("same-session profile and avatar keep shared busy until both requests finish", async (t) => {
  const { account } = setup(t), replyA = deferred<Response>(), replyB = deferred<Response>(), started = deferred<void>(); let calls = 0;
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => { if (++calls === 1) return replyA.promise; started.resolve(); return replyB.promise; });
  const first = save(account, false), second = save(account, true); await started.promise;
  replyA.resolve(new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "cannot update" }), { status: 409 })); await first;
  assert.equal(account.savingMeProfile, true);
  replyB.resolve(new Response(JSON.stringify(summary("A")))); await second; assert.equal(account.savingMeProfile, false);
});

for (const pendingSummary of [false, true]) test(`avatar summary 401 is an authentication failure with existing request ${pendingSummary}`, async (t) => {
  const { config, account } = setup(t), started = deferred<void>(), reply = deferred<Response>(); account.meSummary = null;
  const methods: string[] = [], logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => { methods.push(init?.method ?? "GET"); started.resolve(); return reply.promise; });
  const summaryRun = pendingSummary ? account.loadMeSummary(true) : undefined;
  if (summaryRun) await started.promise;
  const run = account.updateMyAvatar("new-avatar"); await started.promise;
  reply.resolve(new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" }), { status: 401 }));
  const result = await run; if (summaryRun) await summaryRun;
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "UNAUTHORIZED");
  assert.equal(config.sessionToken, null); assert.deepEqual(methods, ["GET"]); assert.equal(account.savingMeProfile, false); assert.equal(logs.length, 1);
});

for (const network of [false, true]) test(`avatar summary ${network ? "network" : "API"} failure stops the update`, async (t) => {
  const { account } = setup(t), error = new TypeError("summary unavailable"), logs: unknown[][] = []; account.meSummary = null;
  const methods: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET"); if (network) throw error;
    return new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "cannot load" }), { status: 409 });
  });
  if (network) await assert.rejects(account.updateMyAvatar("new-avatar"), (cause) => cause === error);
  else assert.equal((await account.updateMyAvatar("new-avatar")).ok, false);
  assert.deepEqual(methods, ["GET"]); assert.equal(account.savingMeProfile, false); assert.equal(logs.length, 1);
});

/** 执行实际父组件handler，确保旧头像回调不改写新账号表单。 */
function handler(avatar: boolean, takeOver: boolean, failure?: Error | object, callbacks?: { success?: () => void; error?: () => void },
  actual?: ReturnType<typeof setup>, afterResult?: () => void) {
  const source = readFileSync(new URL("../src/components/app-shell/app-shell-modals.vue", import.meta.url), "utf8");
  const start = source.indexOf("async function handleSaveProfile("), end = source.indexOf("async function handleSaveEnterprise(", start);
  assert.ok(start >= 0 && end > start);
  const events: string[] = [], logs: unknown[][] = [], config = actual?.config ?? useConfigStore(createPinia());
  if (!actual) config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", sessionToken: "session-A", userSummary: { userId: "A" } as any });
  /** 模拟await恢复前新账号接管。 */
  const response = async () => {
    if (actual) {
      const result = await save(actual.account, avatar);
      if (afterResult) queueMicrotask(afterResult);
      return result;
    }
    if (takeOver) queueMicrotask(() => { config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any; });
    if (failure instanceof Error) throw failure;
    return failure ?? summary("A");
  };
  const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
  const invoke = new Function("account", "shell", "showResultToast", "message", "createApiResultError", "createCancelledRequestError", "isCancelledRequestError", "console", "captureAccountSession",
    code + `\nreturn ${avatar ? "handleSaveAvatar" : "handleSaveProfile"};`)(
    { updateMyProfile: response, updateMyAvatar: response }, { config }, () => events.push("toast"),
    { error: () => events.push("error"), success: () => events.push("success") }, createApiResultError, createCancelledRequestError, isCancelledRequestError,
    { error: (...args: unknown[]) => { logs.push(args); } }, captureAccountSession,
  ) as (payload: object) => Promise<unknown>;
  return { invoke: () => invoke(avatar ? { avatarUrl: "new-avatar", onSuccess: () => { events.push("callback"); callbacks?.success?.(); },
    onError: () => { events.push("failure-callback"); callbacks?.error?.(); } }
    : { fullName: "A", phone: "", avatarUrl: null }), events, config, logs };
}

for (const avatar of [false, true]) test(`${avatar ? "avatar" : "profile"} UI cannot report old success or run an old callback on B`, async () => {
  const f = handler(avatar, true); await assert.rejects(f.invoke(), isCancelledRequestError); assert.deepEqual(f.events, []);
});

for (const avatar of [false, true]) for (const network of [false, true]) test(`${avatar ? "avatar" : "profile"} UI keeps ${network ? "network" : "API"} failure rejected`, async () => {
  const error = new TypeError("network unavailable"), f = handler(avatar, false, network ? error : { ok: false, code: "CONFLICT", message: "cannot save" });
  await assert.rejects(f.invoke(), network ? (cause) => cause === error : (cause: any) => cause.code === "CONFLICT");
  assert.deepEqual(f.events, avatar ? ["failure-callback", "error"] : ["error"]);
});

test("avatar failure callback cannot make an old error toast appear on B", async () => {
  const f = handler(true, false, { ok: false, code: "CONFLICT", message: "cannot save" }, { error: () => {
    f.config.sessionToken = "session-B"; f.config.userSummary = { userId: "B" } as any;
  } });
  await assert.rejects(f.invoke(), isCancelledRequestError); assert.deepEqual(f.events, ["failure-callback"]);
});

test("avatar success callback failure does not run the API failure callback", async () => {
  const error = new Error("private-callback-text"), f = handler(true, false, undefined, { success: () => { throw error; } });
  await assert.rejects(f.invoke(), (cause) => cause === error); assert.deepEqual(f.events, ["callback", "error"]);
  assert.equal(f.logs.length, 1); assert.doesNotMatch(JSON.stringify(f.logs), /private-callback-text|session-A/u);
});

test("avatar failure callback error preserves the original API failure", async () => {
  const error = new Error("private-callback-text"), f = handler(true, false, { ok: false, code: "CONFLICT", message: "cannot save" }, { error: () => { throw error; } });
  await assert.rejects(f.invoke(), (cause: any) => cause instanceof AggregateError && cause.errors[0]?.code === "CONFLICT" && cause.errors[1] === error);
  assert.equal(f.logs.length, 1); assert.doesNotMatch(JSON.stringify(f.logs), /private-callback-text|session-A/u);
});

for (const avatar of [false, true]) for (const replace of [false, true])
  test(`${avatar ? "avatar" : "profile"} UI ${replace ? "cancels old" : "reports owned"} 401 feedback`, async (t) => {
    const actual = setup(t);
    t.mock.method(console, "error", () => {});
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" }), { status: 401 }));
    const f = handler(avatar, false, undefined, undefined, actual, replace ? () => {
      actual.config.$patch({ authMode: "account", sessionToken: "session-B", userSummary: { userId: "B" } as any });
      actual.config.expireCurrentSession();
    } : undefined);
    await assert.rejects(f.invoke(), replace ? isCancelledRequestError : (error: any) => error.code === "UNAUTHORIZED");
    assert.deepEqual(f.events, replace ? [] : avatar ? ["failure-callback", "error"] : ["error"]);
  });

test("avatar success callback cannot restore old feedback after A to B to A", async () => {
  const f = handler(true, false, undefined, { success: () => {
    f.config.$patch({ sessionToken: "session-B", userSummary: { userId: "B" } as any });
    f.config.$patch({ sessionToken: "session-A", userSummary: { userId: "A" } as any });
  } });
  await assert.rejects(f.invoke(), isCancelledRequestError); assert.deepEqual(f.events, ["callback"]);
});

for (const avatar of [false, true]) for (const readFailure of [false, true])
  test(`${avatar ? "avatar" : "profile"} UI reports owned 401 ${readFailure ? "body failure" : "non-JSON"} without replacing the cause`, async (t) => {
    const actual = setup(t), original = new TypeError("private-body-error");
    t.mock.method(console, "error", () => {});
    t.mock.method(globalThis, "fetch", async () => ({ status: 401, text: async () => { if (readFailure) throw original; return "private-body-text"; } } as Response));
    const f = handler(avatar, false, undefined, undefined, actual);
    await assert.rejects(f.invoke(), readFailure ? (error) => error === original : (error: any) => error.code === "NON_JSON");
    assert.deepEqual(f.events, avatar ? ["failure-callback", "error"] : ["error"]);
  });
