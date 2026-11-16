import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import ts from "typescript";
import { captureAccountSession, useAccountStore } from "../src/store/account.ts";
import { useConfigStore } from "../src/store/config.ts";
import { createApiResultError, createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";

/** 控制真实 HTTP 边界时序，不处理真实邀请。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 独立 Pinia；桌面场景仅提供平台标识，不启动 Client。 */
function setup(t: test.TestContext, desktop = false) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: desktop ? { codeflowDesktop: {
    request: async () => { throw new Error("UNEXPECTED_DESKTOP_REQUEST"); }, getState: async () => ({ status: "ready" }),
  } } : undefined });
  t.after(() => previous ? Object.defineProperty(globalThis, "window", previous) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore(), account = useAccountStore();
  config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", accountRole: "personal_normal", sessionToken: "session-A",
    sessionExpiresAt: Date.now() + 60_000, userSummary: { userId: "A", enterpriseId: null } as any });
  return { config, account };
}

/** 使用原邀请响应信封，不返回或轮换会话。 */
function success(action: "accept" | "decline" = "accept") {
  return new Response(JSON.stringify({ ok: true, invitationId: "invitation-I", enterpriseId: "enterprise-E",
    status: action === "accept" ? "accepted" : "declined", respondedAt: 1, membershipId: action === "accept" ? "membership-M" : null }));
}

/** 后置读取使用当前测试账号的资料响应。 */
function summary(userId = "A", patch: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ ok: true, userId, fullName: userId, email: `${userId}@example.test`, phone: "", avatarUrl: null,
    accountRole: "personal_normal", accessContext: {}, enterpriseSummary: null, pendingEnterpriseInvitations: [], ...patch }));
}

for (const desktop of [false, true]) for (const status of [200, 401]) test(`${desktop ? "desktop" : "browser"} invitation late HTTP ${status} cannot clear or refresh B`, async (t) => {
  const { config, account } = setup(t, desktop), started = deferred<void>(), reply = deferred<Response>(), methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET"); if (init?.method === "GET") return summary("B");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer session-A"); started.resolve(); return reply.promise;
  });
  const run = account.respondEnterpriseInvitation("invitation-I", "accept"); await started.promise;
  account.resetRuntimeState(); config.sessionToken = "session-B"; config.userSummary = { userId: "B", enterpriseId: null } as any;
  const rejected = assert.rejects(run, isCancelledRequestError);
  reply.resolve(status === 200 ? success() : new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" }), { status }));
  await rejected; assert.equal(config.sessionToken, "session-B"); assert.deepEqual(methods, ["POST"]);
});

test("invitation authentication wait cannot borrow B's credentials", async (t) => {
  const { config, account } = setup(t), validation = deferred<string>(); let calls = 0;
  t.mock.method(config, "ensureSession", async () => validation.promise);
  t.mock.method(globalThis, "fetch", async () => { calls++; return success(); });
  const run = account.respondEnterpriseInvitation("invitation-I", "accept");
  config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
  const rejected = assert.rejects(run, isCancelledRequestError); validation.resolve("session-A"); await rejected; assert.equal(calls, 0);
});

test("invitation cannot report success after B takes over during profile refresh", async (t) => {
  const { config, account } = setup(t), started = deferred<void>(), reply = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "GET") return success(); started.resolve(); return reply.promise;
  });
  const run = account.respondEnterpriseInvitation("invitation-I", "accept"); await started.promise;
  config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
  const rejected = assert.rejects(run, isCancelledRequestError); reply.resolve(summary()); await rejected;
  assert.equal(config.sessionToken, "session-B"); assert.equal(account.meSummary, null);
});

test("invitation old finally cannot release B's pending response", async (t) => {
  const { config, account } = setup(t), startedA = deferred<void>(), startedB = deferred<void>(), replyA = deferred<Response>(), replyB = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "GET") return summary(config.userSummary?.userId);
    if (new Headers(init?.headers).get("Authorization") === "Bearer session-A") { startedA.resolve(); return replyA.promise; }
    startedB.resolve(); return replyB.promise;
  });
  const first = account.respondEnterpriseInvitation("invitation-I", "accept"); await startedA.promise;
  account.resetRuntimeState(); config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any;
  const second = account.respondEnterpriseInvitation("invitation-J", "decline"); await startedB.promise;
  const settled = first.then(() => undefined, (error: unknown) => error); replyA.resolve(success()); await settled;
  const busy = account.respondingEnterpriseInvitation; replyB.resolve(success("decline")); await second;
  assert.equal(busy, true); assert.equal(account.respondingEnterpriseInvitation, false);
});

for (const network of [false, true]) test(`invitation preserves completion when profile refresh has ${network ? "network" : "API"} failure`, async (t) => {
  const { account } = setup(t), original = new TypeError("private-refresh-error"), methods: string[] = [];
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET"); if (init?.method !== "GET") return success();
    if (network) throw original;
    return new Response(JSON.stringify({ ok: false, code: "INTERNAL_ERROR", message: "cannot refresh" }), { status: 503 });
  });
  if (network) await assert.rejects(account.respondEnterpriseInvitation("invitation-I", "accept"), (error: any) => error.cause === original
    && error.details?.operationCompleted === true && error.details.requestId === account.meLoadError?.requestId);
  else {
    const result = await account.respondEnterpriseInvitation("invitation-I", "accept"); assert.equal(result.ok, false);
    if (!result.ok) assert.equal((result.details as { operationCompleted?: boolean }).operationCompleted, true);
  }
  assert.deepEqual(methods, ["POST", "GET"]);
});

for (const summaryFirst of [false, true]) test(`invitation keeps completion when joining summary 401 started ${summaryFirst ? "before" : "during"} POST`, async (t) => {
  const { account } = setup(t), postStarted = deferred<void>(), getStarted = deferred<void>(), post = deferred<Response>(), get = deferred<Response>();
  const methods: string[] = [];
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "GET") { getStarted.resolve(); return get.promise; }
    postStarted.resolve(); return post.promise;
  });
  let summaryRun: ReturnType<typeof account.loadMeSummary>, run: ReturnType<typeof account.respondEnterpriseInvitation>;
  if (summaryFirst) { summaryRun = account.loadMeSummary(true); await getStarted.promise; run = account.respondEnterpriseInvitation("invitation-I", "accept"); await postStarted.promise; }
  else { run = account.respondEnterpriseInvitation("invitation-I", "accept"); await postStarted.promise; summaryRun = account.loadMeSummary(true); await getStarted.promise; }
  post.resolve(success()); await new Promise<void>((resolve) => setImmediate(resolve));
  get.resolve(new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" }), { status: 401 }));
  const result = await run; await summaryRun; assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "UNAUTHORIZED");
    assert.equal((result.details as { operationCompleted?: boolean; requestId?: string }).operationCompleted, true);
    assert.equal((result.details as { requestId?: string }).requestId, account.meLoadError?.requestId);
  }
  assert.equal(methods.filter((method) => method === "POST").length, 1); assert.equal(methods.filter((method) => method === "GET").length, 1);
});

test("invitation 401 cannot mistake an expired replacement account for its original owner", async (t) => {
  const { config, account } = setup(t), reading = deferred<void>(), body = deferred<string>();
  t.mock.method(globalThis, "fetch", async () => ({ status: 401, text: async () => { reading.resolve(); return body.promise; } } as Response));
  const run = account.respondEnterpriseInvitation("invitation-I", "accept"); await reading.promise;
  config.$patch({ authMode: "account", sessionToken: "session-B", userSummary: { userId: "B" } as any });
  config.expireCurrentSession();
  const rejected = assert.rejects(run, isCancelledRequestError);
  body.resolve(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" })); await rejected;
});

test("invitation diagnostics exclude token-shaped targets and retain a safe correlation ID", async (t) => {
  const { account } = setup(t), logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "private-text",
    details: { requestId: "safe-server-id" } }), { status: 409 }));
  assert.equal((await account.respondEnterpriseInvitation("session-A", "decline")).ok, false);
  assert.equal(logs.length, 1); assert.equal((logs[0][1] as { requestId: string }).requestId, "safe-server-id");
  assert.doesNotMatch(JSON.stringify(logs), /session-A|private-text/u);
});

test("invitation success reloads after POST instead of accepting an older pending profile", async (t) => {
  const { account } = setup(t), reading = deferred<void>(), posting = deferred<void>(), old = deferred<Response>(), post = deferred<Response>();
  const methods: string[] = []; let reads = 0;
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    if (init?.method !== "GET") { posting.resolve(); return post.promise; }
    if (++reads === 1) { reading.resolve(); return old.promise; }
    return summary();
  });
  const initial = account.loadMeSummary(true); await reading.promise;
  const run = account.respondEnterpriseInvitation("invitation-I", "accept"); await posting.promise;
  post.resolve(success()); await new Promise<void>((resolve) => setImmediate(resolve));
  old.resolve(summary("A", { pendingEnterpriseInvitations: [{ invitationId: "invitation-I", status: "pending" }] }));
  await initial; assert.equal((await run).ok, true);
  assert.deepEqual(methods, ["GET", "POST", "GET"]); assert.deepEqual(account.meSummary?.pendingEnterpriseInvitations, []);
});

for (const action of ["accept", "decline"] as const) for (const outcome of ["success", "api", "network", "expired", "unauthorized"] as const)
  test(`invitation ${action} current ${outcome} keeps explicit results and safe diagnostics`, async (t) => {
    const { config, account } = setup(t), logs: unknown[][] = [], methods: string[] = [], original = new TypeError("private-request-error");
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET"); if (init?.method === "GET") return summary();
      assert.equal(String(url), "https://cloud.example/api/account/me/enterprise-invitations/invitation-I/respond");
      assert.deepEqual(JSON.parse(String(init?.body)), { action });
      if (outcome === "network") throw original; if (outcome === "success") return success(action);
      return new Response(JSON.stringify({ ok: false, code: outcome === "unauthorized" ? "UNAUTHORIZED" : "CONFLICT", message: "cannot respond",
        details: { requestId: "session-A" } }), { status: outcome === "unauthorized" ? 401 : 409 });
    });
    if (outcome === "expired") config.sessionExpiresAt = 0;
    if (outcome === "network") await assert.rejects(account.respondEnterpriseInvitation("invitation-I", action), (error) => error === original);
    else {
      const result = await account.respondEnterpriseInvitation("invitation-I", action); assert.equal(result.ok, outcome === "success");
      if (!result.ok) assert.equal(result.code, ["expired", "unauthorized"].includes(outcome) ? "UNAUTHORIZED" : "CONFLICT");
    }
    assert.equal(account.respondingEnterpriseInvitation, false); assert.equal(logs.length, outcome === "success" ? 0 : 1);
    if (logs.length) {
      const entry = logs[0][1] as { userId: string; invitationId: string; action: string };
      assert.equal(entry.userId, "A"); assert.equal(entry.invitationId, "invitation-I"); assert.equal(entry.action, action);
    }
    assert.doesNotMatch(JSON.stringify(logs), /private-request-error|session-A/u);
    assert.equal(methods.includes("GET"), outcome === "success");
  });

/** 提取真实邀请 handler 与共用提示函数，验证其可见副作用。 */
function handler(takeOver: boolean, failure = false, actual?: ReturnType<typeof setup>, afterResult?: () => void) {
  const source = readFileSync(new URL("../src/components/app-shell/app-shell-modals.vue", import.meta.url), "utf8");
  const ast = ts.createSourceFile("modals.ts", source.slice(source.indexOf(">") + 1, source.indexOf("</script>")), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(["handleRespondEnterpriseInvitation", "handleAccountSelfService"]);
  const code = ast.statements.filter(ts.isFunctionDeclaration).filter((node) => node.name && names.has(node.name.text)).map((node) => node.getFullText(ast)).join("\n");
  const events: string[] = [], config = actual?.config ?? useConfigStore(createPinia());
  if (!actual) config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", sessionToken: "session-A", userSummary: { userId: "A" } as any });
  const invoke = new Function("account", "shell", "showResultToast", "message", "createApiResultError", "createCancelledRequestError", "isCancelledRequestError", "captureAccountSession",
    ts.transpile(code, { target: ts.ScriptTarget.ES2022 }) + "\nreturn handleRespondEnterpriseInvitation;")({ respondEnterpriseInvitation: async () => {
      if (actual) {
        const result = await actual.account.respondEnterpriseInvitation("invitation-I", "accept");
        if (afterResult) queueMicrotask(afterResult);
        return result;
      }
      if (takeOver) queueMicrotask(() => { config.sessionToken = "session-B"; config.userSummary = { userId: "B" } as any; });
      return failure ? { ok: false, code: "CONFLICT", message: "cannot respond" } : { ok: true };
    } }, { config }, () => events.push("toast"), { error: () => events.push("error") }, createApiResultError, createCancelledRequestError, isCancelledRequestError, captureAccountSession,
  ) as (payload: object) => Promise<void>;
  return { invoke: () => invoke({ invitationId: "invitation-I", action: "accept" }), events };
}

for (const failure of [false, true]) test(`invitation UI cannot show A's late ${failure ? "failure" : "success"} on B`, async () => {
  const f = handler(true, failure); await assert.rejects(f.invoke(), isCancelledRequestError); assert.deepEqual(f.events, []);
});

test("invitation UI keeps current API failure rejected after its feedback", async () => {
  const f = handler(false, true); await assert.rejects(f.invoke(), (error: any) => error.code === "CONFLICT"); assert.deepEqual(f.events, ["error"]);
});

test("invitation UI keeps current success feedback", async () => {
  const f = handler(false); await f.invoke(); assert.deepEqual(f.events, ["toast"]);
});

test("invitation UI cannot report A's 401 after B logs in and expires before feedback", async (t) => {
  const actual = setup(t);
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "expired" }), { status: 401 }));
  const f = handler(false, false, actual, () => {
    actual.config.$patch({ authMode: "account", sessionToken: "session-B", userSummary: { userId: "B" } as any });
    actual.config.expireCurrentSession();
  });
  await assert.rejects(f.invoke(), isCancelledRequestError); assert.deepEqual(f.events, []);
});

for (const afterPost of [false, true]) for (const readFailure of [false, true])
  test(`invitation UI keeps owned 401 ${readFailure ? "body failure" : "non-JSON"} during ${afterPost ? "refresh" : "POST"}`, async (t) => {
    const actual = setup(t), original = new TypeError("private-response-text");
    t.mock.method(console, "error", () => {});
    t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (afterPost && init?.method !== "GET") return success();
      return { status: 401, text: async () => { if (readFailure) throw original; return "private-body-text"; } } as Response;
    });
    const f = handler(false, false, actual);
    await assert.rejects(f.invoke(), (error: any) => error.code === "UNAUTHORIZED" && (!readFailure || error.cause === original)
      && (!afterPost || error.details?.operationCompleted === true));
    assert.deepEqual(f.events, ["error"]);
  });
