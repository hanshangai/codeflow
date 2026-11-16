import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import ts from "typescript";
import { captureAccountSession, useAccountStore } from "../src/store/account.ts";
import { useConfigStore } from "../src/store/config.ts";
import { createApiResultError, createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";

/** 控制真实请求时序，不替换账号动作本身。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 只提供本片涉及的企业摘要，不读取真实企业数据。 */
function enterprise(name: string) { return { ok: true, enterpriseId: "enterprise-E", name, status: "active", entitlement: { openedAt: 1, source: "ADMIN", sourceId: "enterprise-E" }, contactName: "contact", contactEmail: "contact@example.test", contactPhone: "" }; }

/** 切换到同一企业内的另一账号，包含正常运行态重置。 */
function select(config: ReturnType<typeof useConfigStore>, account: ReturnType<typeof useAccountStore>, userId: string) {
  account.resetRuntimeState();
  config.$patch({ authMode: "account", accountRole: "enterprise_admin", serverWsOrigin: "wss://cloud.example", sessionToken: `session-${userId}`,
    sessionExpiresAt: Date.now() + 60_000, userSummary: { userId, enterpriseId: "enterprise-E" } as any });
  account.enterpriseScopeId = "enterprise-E"; account.enterpriseSummary = enterprise(userId) as any;
  account.meSummary = { userId, enterpriseSummary: enterprise(userId) } as any;
}

/** browser与desktop均走真实账号HTTP，preload仅作平台标识。 */
function setup(t: test.TestContext, desktop = false) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: desktop ? { codeflowDesktop: {
    request: async () => { throw new Error("UNEXPECTED_DESKTOP_REQUEST"); }, getState: async () => ({ status: "ready" }),
  } } : undefined });
  t.after(() => previous ? Object.defineProperty(globalThis, "window", previous) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia()); const config = useConfigStore(), account = useAccountStore(); select(config, account, "A");
  return { config, account };
}

for (const desktop of [false, true]) for (const status of [200, 401]) test(`${desktop ? "desktop" : "browser"} enterprise profile late HTTP ${status} cannot update or clear B in the same enterprise`, async (t) => {
  const { config, account } = setup(t, desktop), started = deferred<void>(), reply = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer session-A"); started.resolve(); return reply.promise;
  });
  const run = account.updateEnterpriseProfile({ name: "updated-A" }); await started.promise; select(config, account, "B");
  const rejected = assert.rejects(run, isCancelledRequestError);
  reply.resolve(new Response(JSON.stringify(status === 200 ? enterprise("updated-A") : { ok: false, code: "UNAUTHORIZED", message: "expired" }), { status }));
  await rejected; assert.equal(config.sessionToken, "session-B"); assert.equal(account.enterpriseSummary?.name, "B");
  assert.equal(account.meSummary?.enterpriseSummary?.name, "B"); assert.equal(account.savingEnterpriseProfile, false);
});

test("enterprise profile validates ownership after asynchronous authentication before sending", async (t) => {
  const { config, account } = setup(t), validation = deferred<string>(); let requests = 0;
  t.mock.method(config, "ensureSession", async () => validation.promise);
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response(JSON.stringify(enterprise("updated-A"))); });
  const run = account.updateEnterpriseProfile({ name: "updated-A" }); select(config, account, "B");
  const rejected = assert.rejects(run, isCancelledRequestError); validation.resolve("session-A"); await rejected;
  assert.equal(requests, 0); assert.equal(config.sessionToken, "session-B");
});

test("enterprise profile old finally cannot release B's pending save", async (t) => {
  const { config, account } = setup(t), startedA = deferred<void>(), startedB = deferred<void>(), replyA = deferred<Response>(), replyB = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (new Headers(init?.headers).get("Authorization") === "Bearer session-A") { startedA.resolve(); return replyA.promise; }
    startedB.resolve(); return replyB.promise;
  });
  const first = account.updateEnterpriseProfile({ name: "updated-A" }); await startedA.promise; select(config, account, "B");
  const second = account.updateEnterpriseProfile({ name: "updated-B" }); await startedB.promise;
  const rejected = assert.rejects(first, isCancelledRequestError); replyA.resolve(new Response(JSON.stringify(enterprise("updated-A")))); await rejected;
  assert.equal(account.savingEnterpriseProfile, true);
  replyB.resolve(new Response(JSON.stringify(enterprise("updated-B")))); await second; assert.equal(account.savingEnterpriseProfile, false);
});

test("enterprise profile current success updates both enterprise projections", async (t) => {
  const { config, account } = setup(t);
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(JSON.parse(String(init?.body)).enterpriseId, "enterprise-E"); return new Response(JSON.stringify(enterprise("updated-A")));
  });
  assert.equal((await account.updateEnterpriseProfile({ name: "updated-A" })).ok, true);
  assert.equal(config.userSummary?.userId, "A"); assert.equal(account.enterpriseSummary?.name, "updated-A");
  assert.equal(account.meSummary?.enterpriseSummary?.name, "updated-A"); assert.equal(account.savingEnterpriseProfile, false);
});

test("explicit enterprise target does not overwrite the actor's different personal enterprise", async (t) => {
  const { account } = setup(t);
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(JSON.parse(String(init?.body)).enterpriseId, "enterprise-other");
    return new Response(JSON.stringify({ ...enterprise("updated-other"), enterpriseId: "enterprise-other" }));
  });
  await account.updateEnterpriseProfile({ name: "updated-other" }, "enterprise-other");
  assert.equal(account.enterpriseSummary?.enterpriseId, "enterprise-other"); assert.equal(account.meSummary?.enterpriseSummary?.enterpriseId, "enterprise-E");
  assert.equal(account.meSummary?.enterpriseSummary?.name, "A");
});

for (const outcome of ["api", "network", "expired", "unauthorized"] as const) test(`enterprise profile current ${outcome} failure stays explicit and safely logged`, async (t) => {
  const { account, config } = setup(t), error = new TypeError("private-api-error"), logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async () => {
    if (outcome === "network") throw error;
    return new Response(JSON.stringify({ ok: false, code: outcome === "unauthorized" ? "UNAUTHORIZED" : "CONFLICT", message: "cannot update",
      details: { requestId: "session-A" } }), { status: outcome === "unauthorized" ? 401 : 409 });
  });
  if (outcome === "expired") config.sessionExpiresAt = 0;
  if (outcome === "network") await assert.rejects(account.updateEnterpriseProfile({ name: "updated-A" }), (cause) => cause === error);
  else {
    const result = await account.updateEnterpriseProfile({ name: "updated-A" }); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, ["expired", "unauthorized"].includes(outcome) ? "UNAUTHORIZED" : "CONFLICT");
  }
  assert.equal(account.savingEnterpriseProfile, false); assert.equal(account.enterpriseSummary?.name, "A"); assert.equal(logs.length, 1);
  const entry = logs[0][1] as { userId: string; enterpriseId: string; path: string };
  assert.equal(entry.userId, "A"); assert.equal(entry.enterpriseId, "enterprise-E"); assert.equal(entry.path, "/api/account/enterprise/profile/update");
  assert.doesNotMatch(JSON.stringify(logs), /private-api-error|session-A/u);
});

test("enterprise profile diagnostics cannot expose a token-shaped enterprise target", async (t) => {
  const { account } = setup(t), logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "cannot save" }), { status: 409 }));
  assert.equal((await account.updateEnterpriseProfile({ name: "updated-A" }, "session-A")).ok, false);
  assert.equal(logs.length, 1); assert.doesNotMatch(JSON.stringify(logs), /session-A/u);
});

/** 提取实际企业保存及共用提示函数，只有外部结果和提示受控。 */
function handler(takeOver: boolean, fail: boolean) {
  const source = readFileSync(new URL("../src/components/app-shell/app-shell-modals.vue", import.meta.url), "utf8");
  const script = source.slice(source.indexOf(">") + 1, source.indexOf("</script>"));
  const ast = ts.createSourceFile("modals.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(["handleSaveEnterprise", "handleAccountSelfService"]);
  const code = ast.statements.filter(ts.isFunctionDeclaration).filter((node) => node.name && names.has(node.name.text)).map((node) => node.getFullText(ast)).join("\n");
  const events: string[] = [], config = useConfigStore(createPinia());
  config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", sessionToken: "session-A", userSummary: { userId: "A" } as any });
  const invoke = new Function("account", "shell", "showResultToast", "message", "createApiResultError", "createCancelledRequestError", "isCancelledRequestError", "captureAccountSession",
    ts.transpile(code, { target: ts.ScriptTarget.ES2022 }) + "\nreturn handleSaveEnterprise;")(
    { updateEnterpriseProfile: async () => { if (takeOver) queueMicrotask(() => { config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any; });
      return fail ? { ok: false, code: "CONFLICT", message: "cannot save" } : enterprise("updated-A"); } }, { config }, () => events.push("toast"),
    { error: () => events.push("error") }, createApiResultError, createCancelledRequestError, isCancelledRequestError, captureAccountSession,
  ) as (input: object) => Promise<void>;
  return { invoke: () => invoke({ name: "updated-A" }), events };
}

for (const fail of [false, true]) test(`enterprise profile UI cannot show A's late ${fail ? "failure" : "success"} on B`, async () => {
  const f = handler(true, fail); await assert.rejects(f.invoke(), isCancelledRequestError); assert.deepEqual(f.events, []);
});

test("enterprise profile UI API failure stays rejected after feedback", async () => {
  const f = handler(false, true); await assert.rejects(f.invoke(), (error: any) => error.code === "CONFLICT"); assert.deepEqual(f.events, ["error"]);
});

test("enterprise profile UI current success keeps its normal feedback", async () => {
  const f = handler(false, false); await f.invoke(); assert.deepEqual(f.events, ["toast"]);
});
