import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import ts from "typescript";
import { captureAccountSession, useAccountStore } from "../src/store/account.ts";
import { useConfigStore } from "../src/store/config.ts";
import { createApiResultError, createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";

const input = { newPassword: "test-password", confirmPassword: "test-password" };

/** 控制真实API响应时序，不访问真实账号或密码。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 建立独立Pinia，desktop分支仅提供平台标识。 */
function setup(t: test.TestContext, desktop = false) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: desktop ? { codeflowDesktop: {
    request: async () => { throw new Error("UNEXPECTED_DESKTOP_REQUEST"); }, getState: async () => ({ status: "ready" }),
  } } : undefined });
  t.after(() => previous ? Object.defineProperty(globalThis, "window", previous) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia()); const config = useConfigStore(), account = useAccountStore();
  config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", accountRole: "enterprise_admin", sessionToken: "session-A",
    sessionExpiresAt: Date.now() + 60_000, userSummary: { userId: "A", enterpriseId: "enterprise-E" } as any });
  return { config, account };
}

/** 使用原API成功信封，不伪造后置会话或刷新。 */
function success() { return new Response(JSON.stringify({ ok: true, targetUserId: "member-user", resetAt: 1 })); }

for (const desktop of [false, true]) for (const status of [200, 401]) test(`${desktop ? "desktop" : "browser"} member password late HTTP ${status} cannot act on B`, async (t) => {
  const { config, account } = setup(t, desktop), started = deferred<void>(), reply = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer session-A"); started.resolve(); return reply.promise;
  });
  const run = account.resetEnterpriseMemberPassword("membership-M", input); await started.promise;
  account.resetRuntimeState(); config.sessionToken = "session-B"; config.userSummary = { userId: "B", enterpriseId: "enterprise-E" } as any;
  const rejected = assert.rejects(run, isCancelledRequestError);
  reply.resolve(status === 200 ? success() : new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" }), { status }));
  await rejected; assert.equal(config.sessionToken, "session-B"); assert.equal(account.resettingEnterprisePassword, false);
});

test("member password authentication wait cannot borrow B's session", async (t) => {
  const { config, account } = setup(t), validation = deferred<string>(); let calls = 0;
  t.mock.method(config, "ensureSession", async () => validation.promise);
  t.mock.method(globalThis, "fetch", async () => { calls++; return success(); });
  const run = account.resetEnterpriseMemberPassword("membership-M", input);
  config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
  const rejected = assert.rejects(run, isCancelledRequestError); validation.resolve("session-A"); await rejected; assert.equal(calls, 0);
});

test("old member password finally cannot release B's pending reset", async (t) => {
  const { config, account } = setup(t), startedA = deferred<void>(), startedB = deferred<void>(), replyA = deferred<Response>(), replyB = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (new Headers(init?.headers).get("Authorization") === "Bearer session-A") { startedA.resolve(); return replyA.promise; }
    startedB.resolve(); return replyB.promise;
  });
  const first = account.resetEnterpriseMemberPassword("membership-M", input); await startedA.promise;
  account.resetRuntimeState(); config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
  const second = account.resetEnterpriseMemberPassword("membership-N", input); await startedB.promise;
  const rejected = assert.rejects(first, isCancelledRequestError); replyA.resolve(success()); await rejected; assert.equal(account.resettingEnterprisePassword, true);
  replyB.resolve(success()); await second; assert.equal(account.resettingEnterprisePassword, false);
});

for (const outcome of ["success", "api", "network", "expired", "unauthorized"] as const) test(`member password current ${outcome} stays explicit with safe member diagnostics`, async (t) => {
  const { config, account } = setup(t), logs: unknown[][] = [], error = new TypeError("private-api-text");
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async () => {
    if (outcome === "success") return success(); if (outcome === "network") throw error;
    return new Response(JSON.stringify({ ok: false, code: outcome === "unauthorized" ? "UNAUTHORIZED" : "CONFLICT", message: "cannot reset",
      details: { requestId: "session-A" } }), { status: outcome === "unauthorized" ? 401 : 409 });
  });
  if (outcome === "expired") config.sessionExpiresAt = 0;
  if (outcome === "network") await assert.rejects(account.resetEnterpriseMemberPassword("membership-M", input), (cause) => cause === error);
  else {
    const result = await account.resetEnterpriseMemberPassword("membership-M", input); assert.equal(result.ok, outcome === "success");
    if (!result.ok) assert.equal(result.code, ["expired", "unauthorized"].includes(outcome) ? "UNAUTHORIZED" : "CONFLICT");
  }
  assert.equal(account.resettingEnterprisePassword, false); assert.equal(logs.length, outcome === "success" ? 0 : 1);
  if (logs.length) {
    const entry = logs[0][1] as { userId: string; membershipId: string; enterpriseId: string };
    assert.equal(entry.userId, "A"); assert.equal(entry.membershipId, "membership-M"); assert.equal(entry.enterpriseId, "enterprise-E");
  }
  assert.doesNotMatch(JSON.stringify(logs), /test-password|private-api-text|session-A/u);
});

test("member password diagnostics cannot expose a token-shaped target", async (t) => {
  const { account } = setup(t), logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "cannot reset" }), { status: 409 }));
  assert.equal((await account.resetEnterpriseMemberPassword("session-A", input)).ok, false);
  assert.equal(logs.length, 1); assert.doesNotMatch(JSON.stringify(logs), /test-password|session-A/u);
});

for (const field of ["requestId", "serverRequestId", "code", "membershipId", "enterpriseId", "userId", "confirmPassword"] as const)
  test(`member password diagnostics exclude submitted secrets from ${field}`, async (t) => {
    const { config, account } = setup(t), logs: unknown[][] = [];
    const secretInput = { newPassword: "RESET_PASSWORD_SECRET", confirmPassword: "CONFIRM_PASSWORD_SECRET" };
    if (field === "userId") config.userSummary = { userId: secretInput.newPassword, enterpriseId: "enterprise-E" } as any;
    if (field === "enterpriseId") account.enterpriseScopeId = secretInput.newPassword;
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false,
      code: field === "code" ? secretInput.newPassword : "CONFLICT", message: "cannot reset",
      details: { [field === "serverRequestId" ? "serverRequestId" : "requestId"]:
        field === "confirmPassword" ? secretInput.confirmPassword : secretInput.newPassword },
    }), { status: 409 }));
    assert.equal((await account.resetEnterpriseMemberPassword(field === "membershipId" ? secretInput.newPassword : "membership-M", secretInput)).ok, false);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(JSON.stringify(logs), /RESET_PASSWORD_SECRET|CONFIRM_PASSWORD_SECRET/u);
  });

test("member password diagnostics identify the managed enterprise for a super admin", async (t) => {
  const { config, account } = setup(t), logs: unknown[][] = [];
  config.accountRole = "super_admin"; config.userSummary = { userId: "A", enterpriseId: null } as any;
  account.enterpriseScopeId = "managed-E";
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "cannot reset" }), { status: 409 }));
  assert.equal((await account.resetEnterpriseMemberPassword("membership-M", input)).ok, false);
  assert.equal(logs.length, 1); assert.equal((logs[0][1] as { enterpriseId: string }).enterpriseId, "managed-E");
});

/** 提取两个真实页面handler及既有共用提示函数。 */
function handler(admin: boolean, takeOver: boolean, failure = false, actual?: ReturnType<typeof setup>, afterResult?: () => void) {
  const source = readFileSync(new URL(admin ? "../src/features/admin/components/enterprise-management-panel.vue" : "../src/components/app-shell/app-shell-modals.vue", import.meta.url), "utf8");
  const ast = ts.createSourceFile("page.ts", source.slice(source.indexOf(">") + 1, source.indexOf("</script>")), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(["handleResetEnterpriseMemberPassword", "handleAccountSelfService"]);
  const code = ast.statements.filter(ts.isFunctionDeclaration).filter((node) => node.name && names.has(node.name.text)).map((node) => node.getFullText(ast)).join("\n");
  const events: string[] = [], config = actual?.config ?? useConfigStore(createPinia());
  if (!actual) config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", sessionToken: "session-A", userSummary: { userId: "A" } as any });
  const invoke = new Function("account", "config", "shell", "showResultToast", "message", "createApiResultError", "createCancelledRequestError", "isCancelledRequestError", "captureAccountSession",
    ts.transpile(code, { target: ts.ScriptTarget.ES2022 }) + "\nreturn handleResetEnterpriseMemberPassword;")(
    { resetEnterpriseMemberPassword: async () => { if (actual) {
      const result = await actual.account.resetEnterpriseMemberPassword("membership-M", input);
      if (afterResult) queueMicrotask(afterResult);
      return result;
    }
      if (takeOver) queueMicrotask(() => { config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any; });
      return failure ? { ok: false, code: "CONFLICT", message: "cannot reset" } : { ok: true }; } }, config, { config }, () => events.push("toast"),
    { error: () => events.push("error") }, createApiResultError, createCancelledRequestError, isCancelledRequestError, captureAccountSession,
  ) as (payload: object) => Promise<void>;
  return { invoke: () => invoke({ membershipId: "membership-M", ...input }), events };
}

for (const admin of [false, true]) for (const failure of [false, true]) test(`${admin ? "admin panel" : "drawer"} member password UI cannot show A's late ${failure ? "failure" : "success"} on B`, async () => {
  const f = handler(admin, true, failure); await assert.rejects(f.invoke(), isCancelledRequestError); assert.deepEqual(f.events, []);
});

for (const admin of [false, true]) for (const failure of [false, true]) test(`${admin ? "admin panel" : "drawer"} member password UI keeps current ${failure ? "failure" : "success"} feedback`, async () => {
  const f = handler(admin, false, failure);
  if (failure) await assert.rejects(f.invoke(), (error: any) => error.code === "CONFLICT"); else await f.invoke();
  assert.deepEqual(f.events, [failure ? "error" : "toast"]);
});

for (const admin of [false, true]) for (const readFailure of [false, true]) test(`${admin ? "admin panel" : "drawer"} member password UI preserves owned 401 ${readFailure ? "body failure" : "non-JSON"}`, async (t) => {
  const actual = setup(t), error = new TypeError("private-response-text");
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => ({ status: 401, text: async () => { if (readFailure) throw error; return "private-body-text"; } } as Response));
  const f = handler(admin, false, false, actual);
  await assert.rejects(f.invoke(), (cause: any) => cause.code === "UNAUTHORIZED" && (!readFailure || cause.cause === error));
  assert.deepEqual(f.events, ["error"]);
});

for (const admin of [false, true]) test(`${admin ? "admin panel" : "drawer"} member password UI cancels a 401 after B logs in and expires`, async (t) => {
  const actual = setup(t);
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" }), { status: 401 }));
  const f = handler(admin, false, false, actual, () => {
    actual.config.$patch({ authMode: "account", sessionToken: "session-B", userSummary: { userId: "B" } as any });
    actual.config.expireCurrentSession();
  });
  await assert.rejects(f.invoke(), isCancelledRequestError); assert.deepEqual(f.events, []);
});
