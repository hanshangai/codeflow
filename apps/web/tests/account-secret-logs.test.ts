import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useAccountStore } from "../src/store/account.ts";
import { useConfigStore } from "../src/store/config.ts";

const loginInput = { email: "A@example.test", password: "LOGIN_PASSWORD_SECRET", captchaToken: "CAPTCHA_TOKEN_SECRET" };
const passwordInput = { oldPassword: "OLD_PASSWORD_SECRET", newPassword: "NEW_PASSWORD_SECRET", confirmPassword: "CONFIRM_PASSWORD_SECRET" };

/** 保留真实账号动作，只在外部HTTP与窗口边界隔离。 */
function setup(t: test.TestContext, request?: () => Promise<unknown>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: request ? { codeflowDesktop: {
    request, getState: async () => ({ status: "ready" }),
  } } : undefined });
  t.after(() => previous ? Object.defineProperty(globalThis, "window", previous) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.$patch({ serverWsOrigin: "wss://cloud.example", authMode: "account", sessionToken: "session-A", accountRole: "personal_normal",
    sessionExpiresAt: Date.now() + 60_000, userSummary: { userId: "A" } as any });
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  return { config, account: useAccountStore(), logs };
}

for (const secret of [loginInput.password, loginInput.captchaToken, passwordInput.oldPassword, passwordInput.newPassword, passwordInput.confirmPassword])
  for (const field of ["code", "requestId", "serverRequestId"] as const)
    test(`account diagnostics exclude ${secret.split("_SECRET")[0]} echoed through ${field}`, async (t) => {
      const { account, logs } = setup(t), login = [loginInput.password, loginInput.captchaToken].includes(secret);
      t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: field === "code" ? secret : "CONFLICT",
        message: "cannot complete", details: field === "code" ? {} : { [field]: `prefix-${secret}-suffix` } }), { status: 409 }));
      const result = await (login ? account.login(loginInput) : account.changePassword(passwordInput));
      assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, field === "code" ? secret : "CONFLICT");
      assert.equal(logs.length, 1); assert.doesNotMatch(JSON.stringify(logs), /LOGIN_PASSWORD_SECRET|CAPTCHA_TOKEN_SECRET|OLD_PASSWORD_SECRET|NEW_PASSWORD_SECRET|CONFIRM_PASSWORD_SECRET/u);
      assert.match((logs[0][1] as { requestId: string }).requestId, /^account-(login|change-password)-/u);
    });

for (const login of [false, true]) test(`${login ? "login" : "password"} diagnostics retain a safe Server correlation`, async (t) => {
  const { account, logs } = setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "cannot complete",
    details: { requestId: "server-safe-request" } }), { status: 409 }));
  assert.equal((await (login ? account.login(loginInput) : account.changePassword(passwordInput))).ok, false);
  assert.equal(logs.length, 1); assert.equal((logs[0][1] as { requestId: string }).requestId, "server-safe-request");
});

test("password diagnostics exclude thrown secret fields while keeping the original error", async (t) => {
  const { account, logs } = setup(t), original = Object.assign(new TypeError("private-network-text"), {
    code: passwordInput.oldPassword, details: { requestId: passwordInput.newPassword },
  });
  t.mock.method(globalThis, "fetch", async () => { throw original; });
  await assert.rejects(account.changePassword(passwordInput), (error) => error === original);
  assert.equal(logs.length, 1); assert.doesNotMatch(JSON.stringify(logs), /PASSWORD_SECRET|private-network-text/u);
  assert.equal(account.changingPassword, false);
});

for (const operation of ["password", "login", "member"] as const) test(`${operation} freezes the submitted secrets before authentication awaits`, async (t) => {
  const login = operation === "login";
  let release!: (value: any) => void;
  const waiting = new Promise<any>((resolve) => { release = resolve; });
  const { account, config, logs } = setup(t, login ? async () => waiting : undefined);
  const input = login ? { ...loginInput } : operation === "member"
    ? { newPassword: passwordInput.newPassword, confirmPassword: passwordInput.confirmPassword } : { ...passwordInput };
  const submitted: Record<string, string>[] = [];
  if (!login) t.mock.method(config, "ensureSession", async () => waiting);
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); submitted.push(body);
    return new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "cannot complete", details: { requestId: body.password ?? body.newPassword } }), { status: 409 });
  });
  const run = login ? account.login(input as typeof loginInput) : operation === "member"
    ? account.resetEnterpriseMemberPassword("membership-M", input as typeof passwordInput) : account.changePassword(input as typeof passwordInput);
  if ("password" in input) input.password = "CHANGED_PASSWORD_SECRET";
  if ("newPassword" in input) input.newPassword = input.confirmPassword = "CHANGED_PASSWORD_SECRET";
  release(login ? { status: 200, body: { ok: true, account: { status: "unlinked", generation: 1, serverOrigin: null,
    userSummary: null, errorCode: null } } } : "session-A");
  assert.equal((await run).ok, false);
  assert.deepEqual(submitted, [login ? loginInput : operation === "member"
    ? { newPassword: passwordInput.newPassword, confirmPassword: passwordInput.confirmPassword } : passwordInput]);
  assert.equal(logs.length, 1); assert.doesNotMatch(JSON.stringify(logs), /PASSWORD_SECRET|CAPTCHA_TOKEN_SECRET/u);
});
