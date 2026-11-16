import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import ts from "typescript";
import { captureAccountSession, useAccountStore } from "../src/store/account.ts";
import { useConfigStore } from "../src/store/config.ts";
import { createApiResultError, createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";

/** 仅控制网络时序，所有账号动作使用实际store。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 在无桌面桥的独立Pinia实例中验证账号HTTP边界。 */
function setup(t: test.TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
  t.after(() => previous ? Object.defineProperty(globalThis, "window", previous) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", accountRole: "personal_normal", sessionToken: "session-A",
    sessionExpiresAt: Date.now() + 60_000, userSummary: { userId: "A" } as any });
  return { config, account: useAccountStore() };
}

/** 使用两现动作，不在测试里复制刷新或认证逻辑。 */
function operate(account: ReturnType<typeof useAccountStore>, password: boolean) {
  return password ? account.changePassword({ oldPassword: "test-old", newPassword: "test-new", confirmPassword: "test-new" }) : account.sendDefaultKey();
}

/** 提供原API成功信封，凭据从不进入响应或输出。 */
function success() { return new Response(JSON.stringify({ ok: true, changedAt: 1, sentAt: 1, recipient: "A@example.test", cooldownSec: 60 })); }

/** 提供原概况接口用于后置刷新。 */
function summary() { return new Response(JSON.stringify({ ok: true, userId: "A", fullName: "A", email: "A@example.test", phone: "",
  avatarUrl: null, accountRole: "personal_normal", accessContext: {}, enterpriseSummary: null })); }

for (const password of [false, true]) {
  const name = password ? "password change" : "default key sending";
  for (const status of [200, 401]) test(`${name} late HTTP ${status} cannot clear or refresh B`, async (t) => {
    const { config, account } = setup(t), started = deferred<void>(), reply = deferred<Response>(); const methods: string[] = [];
    t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET"); if (init?.method === "GET") return summary(); started.resolve(); return reply.promise;
    });
    const run = operate(account, password); await started.promise;
    config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
    const rejected = assert.rejects(run, isCancelledRequestError);
    reply.resolve(status === 200 ? success() : new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" }), { status }));
    await rejected; assert.equal(config.sessionToken, "session-B"); assert.deepEqual(methods, ["POST"]);
  });

  test(`${name} cannot return success after B takes over during summary refresh`, async (t) => {
    const { config, account } = setup(t), started = deferred<void>(), reply = deferred<Response>();
    t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "GET") return success(); started.resolve(); return reply.promise;
    });
    const run = operate(account, password); await started.promise;
    config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
    const rejected = assert.rejects(run, isCancelledRequestError); reply.resolve(summary()); await rejected;
    assert.equal(config.sessionToken, "session-B"); assert.equal(account.meSummary, null);
  });

  test(`${name} old finally cannot release B's pending action`, async (t) => {
    const { config, account } = setup(t), startedA = deferred<void>(), startedB = deferred<void>(), replyA = deferred<Response>(), replyB = deferred<Response>();
    t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return summary();
      if (new Headers(init?.headers).get("Authorization") === "Bearer session-A") { startedA.resolve(); return replyA.promise; }
      startedB.resolve(); return replyB.promise;
    });
    const first = operate(account, password); await startedA.promise;
    account.resetRuntimeState(); config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
    const second = operate(account, password); await startedB.promise;
    const rejected = assert.rejects(first, isCancelledRequestError); replyA.resolve(success()); await rejected;
    assert.equal(password ? account.changingPassword : account.sendingDefaultKey, true);
    replyB.resolve(success()); await second; assert.equal(password ? account.changingPassword : account.sendingDefaultKey, false);
  });

  for (const network of [false, true]) test(`${name} reports ${network ? "network" : "API"} refresh failure while preserving its completed Server operation`, async (t) => {
    const { account } = setup(t), original = new TypeError("private-summary-failure"), methods: string[] = [];
    t.mock.method(console, "error", () => {});
    t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET"); if (init?.method !== "GET") return success();
      if (network) throw original;
      return new Response(JSON.stringify({ ok: false, code: "INTERNAL_ERROR", message: "cannot refresh" }), { status: 503 });
    });
    if (network) await assert.rejects(operate(account, password), (error: any) => error.cause === original && error.details?.operationCompleted === true
      && error.details.requestId === account.meLoadError?.requestId);
    else {
      const result = await operate(account, password); assert.equal(result.ok, false);
      if (!result.ok) assert.equal((result.details as { operationCompleted?: boolean })?.operationCompleted, true);
    }
    assert.deepEqual(methods, ["POST", "GET"]);
  });

  test(`${name} reports a refresh 401 as authentication failure after completing the operation`, async (t) => {
    const { account, config } = setup(t); let posts = 0;
    t.mock.method(console, "error", () => {});
    t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "GET") { posts++; return success(); }
      return new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" }), { status: 401 });
    });
    const result = await operate(account, password);
    assert.equal(result.ok, false); if (!result.ok) {
      assert.equal(result.code, "UNAUTHORIZED"); assert.equal((result.details as { operationCompleted?: boolean }).operationCompleted, true);
    }
    assert.equal(posts, 1); assert.equal(config.sessionToken, null);
  });

  for (const summaryFirst of [false, true]) test(`${name} keeps completion facts when joining a pending summary 401 started ${summaryFirst ? "before" : "during"} POST`, async (t) => {
    const { account } = setup(t), postStarted = deferred<void>(), getStarted = deferred<void>(), post = deferred<Response>(), get = deferred<Response>();
    const methods: string[] = [];
    t.mock.method(console, "error", () => {});
    t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "GET") { getStarted.resolve(); return get.promise; }
      postStarted.resolve(); return post.promise;
    });
    let summaryRun: ReturnType<typeof account.loadMeSummary>;
    let run: ReturnType<typeof operate>;
    if (summaryFirst) { summaryRun = account.loadMeSummary(true); await getStarted.promise; run = operate(account, password); await postStarted.promise; }
    else { run = operate(account, password); await postStarted.promise; summaryRun = account.loadMeSummary(true); await getStarted.promise; }
    post.resolve(success()); await new Promise<void>((resolve) => setImmediate(resolve));
    get.resolve(new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" }), { status: 401 }));
    const result = await run; await summaryRun;
    assert.equal(result.ok, false); if (!result.ok) {
      assert.equal(result.code, "UNAUTHORIZED"); assert.equal((result.details as { operationCompleted?: boolean }).operationCompleted, true);
    }
    assert.equal(methods.filter((method) => method === "POST").length, 1); assert.equal(methods.filter((method) => method === "GET").length, 1);
  });

  for (const outcome of ["success", "api", "network", "expired", "unauthorized"] as const) test(`${name} current ${outcome} keeps the original failure contract and safe logs`, async (t) => {
    const { account, config } = setup(t), error = new TypeError("private-api-error"), logs: unknown[][] = [], methods: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET"); if (init?.method === "GET") return summary();
      if (outcome === "network") throw error;
      if (outcome === "success") return success();
      return new Response(JSON.stringify({ ok: false, code: outcome === "unauthorized" ? "UNAUTHORIZED" : "CONFLICT", message: "cannot operate",
        details: { requestId: "session-A" } }), { status: outcome === "unauthorized" ? 401 : 409 });
    });
    if (outcome === "expired") config.sessionExpiresAt = 0;
    if (outcome === "network") await assert.rejects(operate(account, password), (cause) => cause === error);
    else {
      const result = await operate(account, password); assert.equal(result.ok, outcome === "success");
      if (!result.ok) assert.equal(result.code, ["expired", "unauthorized"].includes(outcome) ? "UNAUTHORIZED" : "CONFLICT");
    }
    assert.equal(logs.length, outcome === "success" ? 0 : 1); assert.doesNotMatch(JSON.stringify(logs), /private-api-error|session-A/u);
    assert.equal(password ? account.changingPassword : account.sendingDefaultKey, false);
    if (outcome !== "success") assert.equal(methods.includes("GET"), false);
  });
}

/** 执行实际两handler及其共用辅助函数，隔离可见提示。 */
function handler(password: boolean, takeOver: boolean, failure = false, actual?: ReturnType<typeof setup>) {
  const source = readFileSync(new URL("../src/components/app-shell/app-shell-modals.vue", import.meta.url), "utf8");
  const ast = ts.createSourceFile("modals.ts", source.slice(source.indexOf("<script setup lang=\"ts\">") + 24, source.indexOf("</script>")), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(["handleSendDefaultKey", "handleChangePassword", "handleAccountSelfService"]);
  const code = ast.statements.filter(ts.isFunctionDeclaration).filter((node) => node.name && names.has(node.name.text)).map((node) => node.getFullText(ast)).join("\n");
  const events: string[] = [], config = actual?.config ?? useConfigStore(createPinia());
  if (!actual) config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", sessionToken: "session-A", userSummary: { userId: "A" } as any });
  /** 模拟store完成后、页面恢复前另一个账号接管。 */
  const operation = async () => {
    if (actual) return await operate(actual.account, password);
    if (takeOver) queueMicrotask(() => { config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any; });
    return failure ? { ok: false, code: "CONFLICT", message: "cannot update" } : { ok: true };
  };
  const fn = new Function("account", "shell", "showResultToast", "message", "createApiResultError", "createCancelledRequestError", "isCancelledRequestError", "captureAccountSession",
    ts.transpile(code, { target: ts.ScriptTarget.ES2022 }) + `\nreturn ${password ? "handleChangePassword" : "handleSendDefaultKey"};`)(
    { sendDefaultKey: operation, changePassword: operation }, { config }, () => events.push("toast"),
    { error: () => events.push("error"), success: () => events.push("success") }, createApiResultError, createCancelledRequestError, isCancelledRequestError, captureAccountSession,
  ) as (payload?: object) => Promise<void>;
  return { invoke: () => fn(password ? { oldPassword: "old", newPassword: "new", confirmPassword: "new" } : undefined), events };
}

for (const password of [false, true]) for (const failure of [false, true]) test(`${password ? "password" : "send key"} UI cannot show old ${failure ? "failure" : "success"} on B`, async () => {
  const f = handler(password, true, failure); await assert.rejects(f.invoke(), isCancelledRequestError); assert.deepEqual(f.events, []);
});

for (const password of [false, true]) test(`${password ? "password" : "send key"} UI API failure stays rejected after its toast`, async () => {
  const f = handler(password, false, true); await assert.rejects(f.invoke(), (error: any) => error.code === "CONFLICT"); assert.deepEqual(f.events, ["error"]);
});

for (const password of [false, true]) for (const readFailure of [false, true]) test(`${password ? "password" : "send key"} UI preserves completion when refresh 401 ${readFailure ? "body reading fails" : "is non-JSON"}`, async (t) => {
  const actual = setup(t), original = new TypeError("private-body-error");
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "GET") return success();
    return { status: 401, text: async () => { if (readFailure) throw original; return "private-non-json"; } } as Response;
  });
  const f = handler(password, false, false, actual);
  await assert.rejects(f.invoke(), (error: any) => error.code === "UNAUTHORIZED" && error.details?.operationCompleted === true
    && (!readFailure || error.cause === original));
  assert.deepEqual(f.events, ["error"]);
});
