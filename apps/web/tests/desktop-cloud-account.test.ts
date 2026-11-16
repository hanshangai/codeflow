import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useConfigStore } from "../src/store/config.ts";
import { useAccountStore } from "../src/store/account.ts";
import { useWorkspacesStore } from "../src/store/workspaces.ts";
import { createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";
import { readFileSync } from "node:fs";
import { computed, ref, watch } from "vue";
import ts from "typescript";
import { describeUserFacingError } from "@codeflowai/shared";

/** 隔离 preload 边界，保留 ConfigStore 的会话与迟到结果行为。 */
function setup(t: test.TestContext, request: (input: any) => Promise<any>) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: { request, getState: async () => ({ status: "ready" }) } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "window", descriptor) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.serverWsOrigin = "wss://cloud.example";
  config.authMode = "account";
  config.accountRole = "personal_normal";
  config.userSummary = { userId: "A" } as any;
  config.sessionToken = "session-A";
  config.sessionExpiresAt = Date.now() + 60_000;
  config.desktopRuntime = { status: "ready", requestId: "runtime", releaseId: null, errorCode: null };
  config.desktopClient = { clientId: "local", version: "1", workspaceIds: ["local:ws"], connectedAt: 1 };
  return config;
}

const state = (status: string, generation: number, userId: string | null = "A") => ({ status, generation, serverOrigin: userId ? "https://cloud.example" : null, userSummary: userId ? { userId } : null, errorCode: null });
const response = (account: unknown) => ({ status: 200, body: { ok: true, account } });

/** 控制真实请求的完成时点，以复现账号切换期间的异步响应。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 运行实际 Shell 与账号/工作区 store，仅替换传输、断连和路由边界。 */
function integratedShellLogout(config: ReturnType<typeof useConfigStore>, navigations: string[]) {
  const source = readFileSync(new URL("../src/composables/useAppShell.ts", import.meta.url), "utf8");
  const start = source.indexOf("  async function logout()");
  const end = source.indexOf("  function hasAccountSession", start);
  assert.ok(start >= 0 && end > start);
  const workspaces = useWorkspacesStore();
  const context = computed(() => ({ serverWsOrigin: config.serverWsOrigin, sessionToken: config.sessionToken,
    webSessionId: config.webSessionId, desktopClientId: config.desktopClient?.clientId }));
  const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
  return new Function("config", "account", "workspaces", "ctx", "logoutInProgress", "watch", "createCancelledRequestError", "isCancelledRequestError",
    "cancelWorkspaceActivationTask", "cancelRuntimeReads", "ws", "resetAllStores", "router", "message", code + "\nreturn logout;")(
    config, useAccountStore(), workspaces, context, ref(false), watch, createCancelledRequestError, isCancelledRequestError,
    () => {}, () => {}, { disconnect: () => {} }, () => workspaces.$reset(),
    { push: async (path: string) => { navigations.push(path); } }, { error: () => {} },
  ) as () => Promise<void>;
}

/** 执行原自动同步入口，保留真实 store 和 preload 请求边界。 */
function automaticAccountSync(config: ReturnType<typeof useConfigStore>, error: (text: string) => void) {
  const source = readFileSync(new URL("../src/composables/useAppShell.ts", import.meta.url), "utf8");
  const noticeStart = source.indexOf("  let desktopAccountFailureNotice");
  const start = noticeStart >= 0 ? noticeStart : source.indexOf("  async function syncDesktopAccount(");
  const end = source.indexOf("  watch(", start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ESNext });
  return new Function("config", "message", "describeUserFacingError", "isCancelledRequestError", code + "\nreturn syncDesktopAccount;")(
    config, { error }, describeUserFacingError, isCancelledRequestError) as (manual?: boolean) => Promise<boolean>;
}

test("automatic desktop account sync waits for local readiness and resumes after recovery", async (t) => {
  const methods: string[] = [];
  const messages: string[] = [];
  const config = setup(t, async (request) => {
    methods.push(request.method);
    return response(state(request.method.endsWith("unlink") ? "unlinked" : "linked", 2, request.method.endsWith("unlink") ? null : "A"));
  });
  const sync = automaticAccountSync(config, (text) => messages.push(text));
  const client = config.desktopClient;
  config.desktopCloudAccount = { ...state("failed", 1), errorCode: "PREVIOUS_ACCOUNT_FAILURE" } as any;
  config.desktopCloudAccountError = "PREVIOUS_ACCOUNT_FAILURE";
  for (const status of [null, "starting", "running", "draining", "stopped", "failed", "ready"] as const) {
    config.desktopRuntime = status === null ? null : { status, requestId: "recovering", releaseId: null, errorCode: null };
    config.desktopClient = status === "ready" ? null : client;
    assert.equal(await sync(), false, String(status));
    assert.deepEqual(methods, [], String(status));
    assert.equal(config.desktopCloudAccount?.errorCode, "PREVIOUS_ACCOUNT_FAILURE");
    assert.equal(config.desktopCloudAccountError, "PREVIOUS_ACCOUNT_FAILURE");
    assert.equal(config.desktopCloudAccountLinked, false);
  }
  assert.deepEqual(messages, []);
  config.desktopClient = client;
  assert.equal(await sync(), true);
  assert.deepEqual(methods, ["runtime.cloudAccount.unlink", "runtime.cloudAccount.link"]);
  assert.equal(config.desktopCloudAccountLinked, true);
  assert.equal(config.desktopCloudAccountError, null);
});

test("automatic account sync leaves the browser path untouched", async (t) => {
  const methods: string[] = [];
  const config = setup(t, async (request) => { methods.push(request.method); return response(state("unlinked", 1, null)); });
  Reflect.deleteProperty(globalThis, "window");
  assert.equal(await automaticAccountSync(config, assert.fail)(), true);
  assert.deepEqual(methods, []);
});

test("a ready automatic sync still exposes a failed revocation and stops linking", async (t) => {
  const methods: string[] = [];
  const messages: string[] = [];
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...values: unknown[]) => { logs.push(values); });
  const config = setup(t, async (request) => {
    methods.push(request.method);
    return { status: 500, body: { ok: false, code: "INTERNAL_ERROR", message: "revocation failed" } };
  });
  assert.equal(await automaticAccountSync(config, (text) => messages.push(text))(), false);
  assert.deepEqual(methods, ["runtime.cloudAccount.unlink"]);
  assert.equal(config.desktopCloudAccount?.status, "failed");
  assert.equal(config.desktopCloudAccountError, "INTERNAL_ERROR");
  assert.equal(config.localRuntimeReady, true);
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0]!, /INTERNAL_ERROR/);
  assert.equal(logs.length, 1);
  assert.equal((logs[0]![1] as { requestId: string }).requestId, "runtime");
});

test("持续关联失败只提示一次，后台保留失败并退避重试，手动重试可立即再提示", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.method(console, "error", () => {});
  let links = 0;
  const config = setup(t, async request => {
    if (request.method.endsWith("link") && !request.method.endsWith("unlink")) {
      links++;
      return { status: 403, body: { ok: false, code: "DESKTOP_DEVICE_AUTH_INVALID", message: "设备认证未通过" } };
    }
    return response(state("unlinked", 1, null));
  });
  config.sessionExpiresAt = Date.now() + 3600_000;
  const messages: string[] = [], sync = automaticAccountSync(config, text => messages.push(text));
  assert.equal(await sync(), false);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /设备认证/);
  assert.doesNotMatch(messages[0]!, /DESKTOP_|AUTH_INVALID/);
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(65_000); assert.equal(await sync(), false); }
  assert.equal(links, 6, "后台真实重试不能被弹窗去重抑制");
  assert.equal(messages.length, 1);
  assert.equal(config.desktopCloudAccount?.status, "failed");
  assert.equal(await sync(true), false);
  assert.equal(links, 7, "手动重试无需等待退避期限");
  assert.equal(messages.length, 2);
});

for (const ownerChange of ["user", "token"]) test(`关联恢复后再次失败可提示，${ownerChange} 变化后的迟到失败不提示新会话`, async t => {
  t.mock.method(console, "error", () => {});
  const config = setup(t, async () => response(state("linked", 1)));
  let failing = true, delayed: (() => void) | undefined;
  t.mock.method(config, "syncDesktopCloudAccount", async () => {
    if (delayed) await new Promise<void>(resolve => { delayed = resolve; });
    if (failing) {
      config.desktopCloudAccount = { ...state("failed", 1), errorCode: "DESKTOP_DEVICE_AUTH_INVALID" } as any;
      config.desktopCloudAccountError = "DESKTOP_DEVICE_AUTH_INVALID";
      throw Object.assign(new Error("private details"), { code: "DESKTOP_DEVICE_AUTH_INVALID" });
    }
    config.desktopCloudAccount = state("linked", 1) as any;
    config.desktopCloudAccountError = null;
    return config.desktopCloudAccount;
  });
  const messages: string[] = [], sync = automaticAccountSync(config, text => messages.push(text));
  await sync(); await sync(); assert.equal(messages.length, 1);
  failing = false; await sync(); failing = true; await sync(); assert.equal(messages.length, 2);
  failing = false; await sync(); failing = true;
  delayed = () => {};
  const pending = sync();
  if (ownerChange === "user") config.userSummary = { userId: "B" } as any;
  else config.sessionToken = "session-B";
  delayed!(); await pending;
  assert.equal(messages.length, 2);
});

test("已登录但关联失败时仍能打开真实状态面板入口", () => {
  const source = readFileSync(new URL("../src/components/app-shell/app-topbar.vue", import.meta.url), "utf8");
  const start = source.indexOf("const showDesktopLocalPopover = computed(");
  const end = source.indexOf("const desktopClientVersionLabel", start);
  assert.ok(start >= 0 && end > start);
  const config = { isDesktop: true, hasActiveSession: true };
  const props = { shell: { config, desktopAccountFailureDescription: "设备认证未通过" as string | null } };
  const shared = ref(false);
  const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ESNext });
  const gate = new Function("computed", "props", "isCurrentSharedWorkspace", "shouldShowDesktopLocalClientPopover", code + "\nreturn showDesktopLocalPopover;")(
    computed, props, shared, (input: { isDesktop: boolean; hasActiveSession: boolean; isCurrentSharedWorkspace: boolean }) => input.isDesktop && !input.hasActiveSession && !input.isCurrentSharedWorkspace);
  assert.equal(gate.value, true);
  shared.value = true;
  assert.equal(gate.value, false, "共享工作区保留原远端 Client 入口");
});

test("正常取消的账号关联不弹故障消息，仍保留关联未成功的返回值", async t => {
  const config = setup(t, async () => response(state("unlinked", 1, null)));
  t.mock.method(config, "syncDesktopCloudAccount", async () => { throw Object.assign(new Error("DESKTOP_CLOUD_LINK_CANCELLED"), { code: "DESKTOP_CLOUD_LINK_CANCELLED" }); });
  assert.equal(await automaticAccountSync(config, assert.fail)(), false);
});

test("an explicit revocation remains required while the local runtime is unavailable", async (t) => {
  const methods: string[] = [];
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...values: unknown[]) => { logs.push(values); });
  const config = setup(t, async (request) => {
    methods.push(request.method);
    throw Object.assign(new Error("CLIENT_NOT_READY"), { code: "CLIENT_NOT_READY" });
  });
  config.desktopRuntime!.status = "running";
  config.desktopClient = null;
  await assert.rejects(config.unlinkDesktopCloudAccount(), /CLIENT_NOT_READY/);
  assert.deepEqual(methods, ["runtime.cloudAccount.unlink"]);
  assert.equal(config.desktopCloudAccount?.status, "failed");
  assert.equal(config.desktopCloudAccountError, "CLIENT_NOT_READY");
  assert.equal(logs.length, 1);
});

test("desktop linking sends only the temporary session and never treats Web connection as authenticated hello", async (t) => {
  const requests: any[] = [];
  const config = setup(t, async (request) => { requests.push(request); return response(state(request.method.endsWith("unlink") ? "unlinked" : "linking", 1)); });
  config.connected = true;
  await config.syncDesktopCloudAccount();
  assert.equal(config.desktopCloudAccountLinked, false);
  assert.deepEqual(requests.find((request) => request.method === "runtime.cloudAccount.link"), { method: "runtime.cloudAccount.link", body: { serverOrigin: "https://cloud.example", sessionToken: "session-A" } });
  await config.syncDesktopCloudAccount();
  assert.equal(requests.filter((request) => request.method === "runtime.cloudAccount.link").length, 1);
});

test("fresh action proxies reuse the same desktop association during polling", async (t) => {
  const methods: string[] = [];
  const config = setup(t, async (request) => {
    methods.push(request.method);
    return response(state(request.method.endsWith("unlink") ? "unlinked" : "linked", 2));
  });
  // Pinia 开发工具每次调用 action 都使用新的代理；同一状态只能关联一次。
  for (let index = 0; index < 3; index++) {
    await config.syncDesktopCloudAccount.call(new Proxy(config, {}));
  }
  assert.deepEqual(methods, [
    "runtime.cloudAccount.unlink", "runtime.cloudAccount.link",
    "runtime.cloudAccount.status", "runtime.cloudAccount.status",
  ]);
  assert.equal(config.desktopCloudAccountLinked, true);
});

test("separate config stores cannot share a desktop association for the same account", async (t) => {
  const methods: string[] = [];
  const config = setup(t, async (request) => {
    methods.push(request.method);
    return response(state(request.method.endsWith("unlink") ? "unlinked" : "linked", 2));
  });
  await config.syncDesktopCloudAccount();
  const otherConfig = useConfigStore(createPinia());
  otherConfig.$patch(config.$state);
  await otherConfig.syncDesktopCloudAccount();
  assert.deepEqual(methods, [
    "runtime.cloudAccount.unlink", "runtime.cloudAccount.link",
    "runtime.cloudAccount.unlink", "runtime.cloudAccount.link",
  ]);
});

test("switching accounts revokes A before linking B and late A state cannot claim B", async (t) => {
  const requests: string[] = [];
  let resolveA!: (value: any) => void;
  const config = setup(t, async (request) => {
    requests.push(request.method + (request.body?.sessionToken ?? ""));
    if (request.body?.sessionToken === "session-A") return new Promise((resolve) => { resolveA = resolve; });
    return response(request.method.endsWith("unlink") ? state("unlinked", 2, null) : state("linked", 3, "B"));
  });
  const first = config.syncDesktopCloudAccount();
  await new Promise((resolve) => setImmediate(resolve));
  config.userSummary = { userId: "B" } as any;
  config.sessionToken = "session-B";
  const second = config.syncDesktopCloudAccount();
  resolveA(response(state("linked", 1)));
  await Promise.all([first, second]);
  assert.equal(config.desktopCloudAccount?.userSummary?.userId, "B");
  assert.equal(config.desktopCloudAccountLinked, true);
  assert.ok(requests.lastIndexOf("runtime.cloudAccount.unlink") < requests.indexOf("runtime.cloudAccount.linksession-B"));
});

test("desktop topbar exposes credential cleanup failure while keeping the authenticated owner", t => {
  const config = setup(t, async () => response(state("linked", 1)));
  config.desktopCloudAccount = { ...state("linked", 1), errorCode: "DESKTOP_CREDENTIAL_RELEASE_FAILED" } as any;
  const source = readFileSync(new URL("../src/composables/useAppShell.ts", import.meta.url), "utf8");
  const start = source.indexOf("  const connectionLabel = computed(");
  const end = source.indexOf("  const isMobileModalViewport = computed(", start);
  assert.ok(start >= 0 && end > start);
  const labels = new Function("computed", "config", source.slice(start, end) + "\nreturn { connectionLabel, connectionTagColor };")(computed, config);
  assert.equal(config.desktopCloudAccountLinked, true);
  assert.equal(labels.connectionLabel.value, "凭据清理失败");
  assert.equal(labels.connectionTagColor.value, "red");
});

test("desktop topbar separates an auto Key failure from its authenticated account", t => {
  const config = setup(t, async () => response(state("linked", 1)));
  config.desktopCloudAccount = { ...state("linked", 1), builtInRelayErrorCode: "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED" } as any;
  const source = readFileSync(new URL("../src/composables/useAppShell.ts", import.meta.url), "utf8");
  const start = source.indexOf("  const connectionLabel = computed(");
  const end = source.indexOf("  const isMobileModalViewport = computed(", start);
  assert.ok(start >= 0 && end > start);
  const labels = new Function("computed", "config", source.slice(start, end) + "\nreturn { connectionLabel, connectionTagColor };")(computed, config);
  assert.equal(config.desktopCloudAccountLinked, true);
  assert.equal(labels.connectionLabel.value, "已关联 · Key 启用失败");
  assert.equal(labels.connectionTagColor.value, "orange");
  config.desktopCloudAccount = { ...state("linked", 1), builtInRelayErrorCode: "DESKTOP_BUILTIN_AUTO_ENABLE_MARKER_FAILED" } as any;
  assert.equal(labels.connectionLabel.value, "已关联 · Key 初始化记录失败");
  assert.equal(labels.connectionTagColor.value, "orange");
  config.desktopCloudAccount = { ...state("linked", 1), builtInRelayErrorCode: null } as any;
  assert.equal(labels.connectionLabel.value, "已关联");
  assert.equal(labels.connectionTagColor.value, "green");
});

test("editing an unknown legacy Key requires new secret entry instead of reusing its old value", () => {
  const source = readFileSync(new URL("../src/features/settings/components/engine-keys-panel.vue", import.meta.url), "utf8");
  const start = source.indexOf("function startEdit("); const end = source.indexOf("/** 关闭弹框", start);
  assert.ok(start >= 0 && end > start);
  const fields = { editingId: ref(null), formEngine: ref(""), formProviderId: ref(""), formLabel: ref(""), formApiKey: ref(""), formBaseUrl: ref(""), modalVisible: ref(false) };
  const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ESNext });
  const edit = new Function("resetForm", ...Object.keys(fields), code + "\nreturn startEdit;")(() => {}, ...Object.values(fields));
  edit({ id: "legacy", engine: "codex", providerId: "openai", label: "old", apiKey: "old-secret", source: "unknown" });
  assert.equal(fields.formApiKey.value, "");
  assert.equal(fields.editingId.value, "legacy");
  edit({ id: "configured", engine: "codex", providerId: "openai", label: "local", apiKey: "explicit-secret", source: "user_configured" });
  assert.equal(fields.formApiKey.value, "explicit-secret");
});

test("failed desktop unlink is visible and prevents the next account link", async (t) => {
  let links = 0;
  const config = setup(t, async (request) => {
    if (request.method.endsWith("unlink")) return { status: 500, body: { ok: false, code: "INTERNAL_ERROR", message: "unlink failed" } };
    links++;
    return response(state("linked", 1));
  });
  await assert.rejects(config.syncDesktopCloudAccount(), /unlink failed/);
  assert.equal(links, 0);
  assert.equal(config.desktopCloudAccount?.status, "failed");
  assert.equal(config.desktopCloudAccountLinked, false);
  const delayed = await config.syncDesktopCloudAccount();
  assert.equal(links, 0, "polling must not restore the old association after failed revocation");
  assert.equal(delayed?.status, "failed");
  assert.equal(config.desktopCloudAccount?.status, "failed");
});

for (const failure of ["state", "http", "throw"] as const) {
  test(`desktop account ${failure} failures back off relinking while exposing the failed state`, async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, "now", () => now);
    const links: number[] = [];
    const messages: string[] = [];
    const logs = t.mock.method(console, "error", () => {});
    const failed = { ...state("failed", 2), errorCode: "CLOUD_AUTH_FAILED" };
    const config = setup(t, async (request) => {
      if (request.method.endsWith("unlink")) return response(state("unlinked", 1, null));
      if (request.method.endsWith("status")) return response(failed);
      links.push(now - 1_000_000);
      if (failure === "throw") throw Object.assign(new Error("cloud link failed"), { code: "CLOUD_AUTH_FAILED" });
      if (failure === "http") return { status: 403, body: { ok: false, code: "CLOUD_AUTH_FAILED", message: "cloud link failed" } };
      return response(failed);
    });
    config.sessionExpiresAt = now + 3_600_000;
    const sync = automaticAccountSync(config, (text) => messages.push(text));
    for (const elapsed of [0, 1_000, 4_999, 5_000, 10_000, 14_999, 15_000, 30_000, 35_000, 70_000, 75_000, 130_000, 135_000, 190_000, 195_000]) {
      now = 1_000_000 + elapsed;
      assert.equal(await sync(), false);
      assert.equal(config.desktopCloudAccount?.status, "failed");
      assert.equal(config.desktopCloudAccountError, "CLOUD_AUTH_FAILED");
    }
    assert.deepEqual(links, [0, 5_000, 15_000, 35_000, 75_000, 135_000, 195_000]);
    assert.equal(messages.length, 1);
    assert.equal(logs.mock.callCount(), failure === "state" ? 0 : links.length);
  });
}

for (const change of ["token", "user", "origin", "runtime"] as const) {
  test(`desktop account ${change} changes bypass the old owner's retry delay`, async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, "now", () => now);
    const methods: string[] = [];
    const config = setup(t, async (request) => {
      methods.push(request.method);
      return response(request.method.endsWith("unlink") ? state("unlinked", 1, null) : { ...state("failed", 2), errorCode: "CLOUD_AUTH_FAILED" });
    });
    await config.syncDesktopCloudAccount();
    now += 1_000;
    if (change === "token") config.sessionToken = "session-rotated";
    if (change === "user") config.userSummary = { userId: "B" } as any;
    if (change === "origin") config.serverWsOrigin = "wss://new-cloud.example";
    if (change === "runtime") config.desktopRuntime!.requestId = "new-runtime";
    await config.syncDesktopCloudAccount();
    assert.deepEqual(methods, ["runtime.cloudAccount.unlink", "runtime.cloudAccount.link", "runtime.cloudAccount.unlink", "runtime.cloudAccount.link"]);
  });
}

test("desktop account recovery clears retry delay and explicit unlink never waits for it", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  let healthy = false;
  let links = 0;
  let unlinks = 0;
  const config = setup(t, async (request) => {
    if (request.method.endsWith("unlink")) { unlinks++; return response(state("unlinked", 1, null)); }
    if (request.method.endsWith("link")) links++;
    return response(healthy ? state("linked", 2) : { ...state("failed", 2), errorCode: "CLOUD_AUTH_FAILED" });
  });
  await config.syncDesktopCloudAccount();
  now += 5_000;
  await config.syncDesktopCloudAccount();
  assert.equal(links, 2);
  healthy = true;
  now += 1_000;
  await config.syncDesktopCloudAccount();
  assert.equal(config.desktopCloudAccountLinked, true);
  assert.equal(config.desktopCloudAccountError, null);
  healthy = false;
  now += 1_000;
  await config.syncDesktopCloudAccount();
  assert.equal(links, 3, "a recovered owner may reconnect immediately after a new disconnect");
  await config.unlinkDesktopCloudAccount();
  await config.syncDesktopCloudAccount();
  assert.equal(unlinks, 2);
  assert.equal(links, 3);
  assert.equal(config.desktopCloudAccount?.status, "unlinked");
});

test("a late link from the previous runtime cannot overwrite the replacement runtime", async (t) => {
  const pending = deferred<any>();
  const config = setup(t, async (request) => request.method.endsWith("unlink") ? response(state("unlinked", 1, null)) : pending.promise);
  const linking = config.syncDesktopCloudAccount();
  await new Promise((resolve) => setImmediate(resolve));
  config.desktopRuntime!.requestId = "new-runtime";
  config.desktopCloudAccount = state("unlinked", 5, null) as any;
  pending.resolve(response(state("linked", 2)));
  await linking;
  assert.equal(config.desktopCloudAccount?.status, "unlinked");
  assert.equal(config.desktopCloudAccount?.generation, 5);
});

test("failed status requests during backoff preserve failure without delaying the next attempt or repeating its popup", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const links: number[] = [];
  const messages: string[] = [];
  const logs = t.mock.method(console, "error", () => {});
  const config = setup(t, async (request) => {
    if (request.method.endsWith("unlink")) return response(state("unlinked", 1, null));
    if (request.method.endsWith("link")) links.push(now - 1_000_000);
    throw Object.assign(new Error("bridge unavailable"), { code: "CLIENT_NOT_READY" });
  });
  const sync = automaticAccountSync(config, (text) => messages.push(text));
  for (const elapsed of [0, 1_000, 5_000, 6_000, 10_000, 15_000]) {
    now = 1_000_000 + elapsed;
    assert.equal(await sync(), false);
    assert.equal(config.desktopCloudAccountError, "CLIENT_NOT_READY");
  }
  assert.deepEqual(links, [0]);
  assert.equal(messages.length, 1);
  assert.equal(logs.mock.callCount(), 3);
});

test("an unlinked poll during retry delay cannot erase a failed association", async (t) => {
  t.mock.method(Date, "now", () => 1_000_000);
  const config = setup(t, async (request) => response(request.method.endsWith("link") && !request.method.endsWith("unlink")
    ? { ...state("failed", 2), errorCode: "CLOUD_AUTH_FAILED" } : state("unlinked", 1, null)));
  await config.syncDesktopCloudAccount();
  const delayed = await config.syncDesktopCloudAccount();
  assert.equal(delayed?.status, "failed");
  assert.equal(config.desktopCloudAccount?.status, "failed");
  assert.equal(config.desktopCloudAccountError, "CLOUD_AUTH_FAILED");
});

test("expired sessions revoke association while preserving local readiness", async (t) => {
  const requests: any[] = [];
  const config = setup(t, async (request) => { requests.push(request); return response(state("unlinked", 2, null)); });
  config.desktopRuntime = { status: "ready", requestId: "runtime", releaseId: null, errorCode: null };
  config.desktopClient = { clientId: "local", version: "1", workspaceIds: ["local:ws"], connectedAt: 1 };
  config.expireCurrentSession();
  await config.syncDesktopCloudAccount();
  assert.equal(config.desktopCloudAccountLinked, false);
  assert.equal(config.localRuntimeReady, true);
  assert.equal(requests.at(-1)?.method, "runtime.cloudAccount.unlink");
});

test("desktop account switch stops before login when revocation fails", async (t) => {
  const config = setup(t, async () => ({ status: 500, body: { ok: false, code: "INTERNAL_ERROR", message: "cannot revoke" } }));
  let serverRequests = 0;
  t.mock.method(globalThis, "fetch", async () => { serverRequests++; throw new Error("must not start login"); });
  await assert.rejects(useAccountStore().login({ email: "B@example.test", password: "test", captchaToken: "captcha" }), /cannot revoke/);
  assert.equal(serverRequests, 0);
  assert.equal(config.userSummary?.userId, "A");
});

test("account logout propagates a failed server revocation and preserves the session", async (t) => {
  const config = setup(t, async (request) => response(state(request.method.endsWith("unlink") ? "unlinked" : "linked", 2, null)));
  Reflect.deleteProperty(globalThis, "window");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: "INTERNAL_ERROR", message: "logout failed" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(useAccountStore().logout(), (error: any) => error.code === "INTERNAL_ERROR");
  assert.equal(config.sessionToken, "session-A");
  assert.equal(config.userSummary?.userId, "A");
});

test("account logout propagates a network failure and preserves the session", async (t) => {
  const config = setup(t, async (request) => response(state(request.method.endsWith("unlink") ? "unlinked" : "linked", 2, null)));
  Reflect.deleteProperty(globalThis, "window");
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("network unavailable"); });
  await assert.rejects(useAccountStore().logout(), /network unavailable/u);
  assert.equal(config.sessionToken, "session-A");
  assert.equal(config.userSummary?.userId, "A");
});

test("logout stops before contacting Server when the account changes during desktop unlink", async (t) => {
  const unlinked = deferred<any>();
  const config = setup(t, async () => unlinked.promise);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Headers(init?.headers).get("Authorization") ?? "");
    return new Response(JSON.stringify({ ok: true, loggedOutAt: Date.now() }));
  });
  const account = useAccountStore();
  const reset = t.mock.method(account, "resetRuntimeState");
  const run = account.logout();
  config.sessionToken = "session-B";
  config.userSummary = { userId: "B" } as any;
  unlinked.resolve(response(state("unlinked", 2, null)));
  await assert.rejects(run, isCancelledRequestError);
  assert.deepEqual(requests, []);
  assert.equal(reset.mock.callCount(), 0);
  assert.equal(config.sessionToken, "session-B");
  assert.equal(config.userSummary?.userId, "B");
});

for (const desktop of [false, true]) {
  for (const status of [200, 401, 500]) {
    for (const closing of [false, true]) {
      test(`${desktop ? "desktop" : "browser"} logout cannot clear the new session after an old HTTP ${status} with logout gate ${closing}`, async (t) => {
        const config = setup(t, async () => response(state("unlinked", 2, null)));
        if (!desktop) Reflect.deleteProperty(globalThis, "window");
        config.setLogoutInProgress(closing);
        const requested = deferred<void>();
        const pending = deferred<Response>();
        const authorizations: (string | null)[] = [];
        const logs = t.mock.method(console, "error", () => {});
        t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
          authorizations.push(new Headers(init?.headers).get("Authorization"));
          requested.resolve();
          return pending.promise;
        });
        const account = useAccountStore();
        const reset = t.mock.method(account, "resetRuntimeState");
        const run = account.logout();
        await requested.promise;
        assert.deepEqual(authorizations, ["Bearer session-A"]);
        config.sessionToken = "session-B";
        config.userSummary = { userId: "B" } as any;
        config.workspaceId = "local:B";
        const rejection = status === 500 ? assert.rejects(run)
          : assert.rejects(run, (error) => isCancelledRequestError(error) && error.kind === "scope-change");
        pending.resolve(new Response(JSON.stringify(status === 200
          ? { ok: true, loggedOutAt: Date.now() }
          : { ok: false, code: status === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR", message: "old session failed" }), { status }));
        await rejection;
        assert.equal(config.sessionToken, "session-B");
        assert.equal(config.userSummary?.userId, "B");
        assert.equal(config.workspaceId, "local:B");
        assert.equal(reset.mock.callCount(), 0);
        if (status === 500) {
          assert.equal(logs.mock.callCount(), 1);
          assert.equal(logs.mock.calls[0]?.arguments[1]?.userId, "A");
          assert.doesNotMatch(JSON.stringify(logs.mock.calls), /session-A|session-B/u);
        }
      });
    }
  }

  test(`${desktop ? "desktop" : "browser"} logout clears the unchanged owner only after Server success`, async (t) => {
    const methods: string[] = [];
    const config = setup(t, async (request) => { methods.push(request.method); return response(state("unlinked", 2, null)); });
    if (!desktop) Reflect.deleteProperty(globalThis, "window");
    config.workspaceId = "local:A";
    t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer session-A");
      assert.equal(config.sessionToken, "session-A");
      methods.push("Server.logout");
      return new Response(JSON.stringify({ ok: true, loggedOutAt: Date.now() }));
    });
    const account = useAccountStore();
    const reset = t.mock.method(account, "resetRuntimeState");
    await account.logout();
    assert.deepEqual(methods, desktop ? ["runtime.cloudAccount.unlink", "Server.logout"] : ["Server.logout"]);
    assert.equal(config.sessionToken, null);
    assert.equal(config.userSummary, null);
    assert.equal(reset.mock.callCount(), 1);
    if (desktop) assert.equal(config.workspaceId, "local:A");
  });
}

test("desktop logout keeps an unlinked owner suppressed after Server failure", async (t) => {
  const methods: string[] = [];
  const config = setup(t, async (request) => { methods.push(request.method); return response(state("unlinked", 2, null)); });
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, code: "INTERNAL_ERROR", message: "logout failed" }), { status: 500 }));
  await assert.rejects(useAccountStore().logout(), (error: any) => error.code === "INTERNAL_ERROR");
  await config.syncDesktopCloudAccount();
  assert.deepEqual(methods, ["runtime.cloudAccount.unlink"]);
  assert.equal(config.sessionToken, "session-A");
  assert.equal(config.desktopCloudAccountLinked, false);
});

test("logout logs reject arbitrary error fields while preserving the original failure", async (t) => {
  const config = setup(t, async () => response(state("unlinked", 2, null)));
  Reflect.deleteProperty(globalThis, "window");
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false,
    code: "Bearer session-A", message: "private response text", details: { requestId: "Bearer session-B" },
  }), { status: 500 }));
  await assert.rejects(useAccountStore().logout(), (error: any) => error.code === "Bearer session-A");
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /session-A|session-B|private response text/u);
  assert.match(JSON.stringify(logs), /ACCOUNT_LOGOUT_FAILED/u);
  assert.equal(config.sessionToken, "session-A");
});

for (const field of ["requestId", "code"] as const) {
  test(`logout logs cannot expose a token-shaped ${field}`, async (t) => {
    const config = setup(t, async () => response(state("unlinked", 2, null)));
    Reflect.deleteProperty(globalThis, "window");
    config.sessionToken = "SESSION_SECRET";
    const logs: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false,
      code: field === "code" ? "SESSION_SECRET" : "INTERNAL_ERROR", message: "logout failed",
      details: { requestId: field === "requestId" ? "SESSION_SECRET" : "trace-123" },
    }), { status: 500 }));
    await assert.rejects(useAccountStore().logout());
    assert.equal(logs.length, 1);
    assert.doesNotMatch(JSON.stringify(logs), /SESSION_SECRET/u);
  });
}

test("an old unlink failure cannot overwrite the new owner state or misattribute its log", async (t) => {
  const pending = deferred<any>();
  const config = setup(t, async () => pending.promise);
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const unlink = config.unlinkDesktopCloudAccount();
  config.sessionToken = "session-B";
  config.userSummary = { userId: "B" } as any;
  config.desktopCloudAccount = state("linked", 7, "B") as any;
  const newAccount = config.desktopCloudAccount;
  const rejection = assert.rejects(unlink, /old unlink failed/u);
  pending.resolve({ status: 500, body: { ok: false, code: "INTERNAL_ERROR", message: "old unlink failed" } });
  await rejection;
  assert.deepEqual(config.desktopCloudAccount, newAccount);
  assert.equal(config.desktopCloudAccountError, null);
  assert.equal(config.sessionToken, "session-B");
  assert.equal(logs.length, 1);
  assert.equal((logs[0]?.[1] as { userId?: string }).userId, "A");
});

test("desktop association logs cannot expose a token-shaped error code", async (t) => {
  const config = setup(t, async () => ({ status: 500, body: { ok: false, code: "SESSION_SECRET", message: "unlink failed" } }));
  config.sessionToken = "SESSION_SECRET";
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  await assert.rejects(config.unlinkDesktopCloudAccount(), /unlink failed/u);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /SESSION_SECRET/u);
});

test("actual logout cannot commit an old workspace list into the account that logged in during refresh", async (t) => {
  const listed = deferred<void>();
  const pending = deferred<any>();
  const config = setup(t, async (request) => {
    if (request.method === "workspaces.list") { listed.resolve(); return pending.promise; }
    assert.equal(request.method, "runtime.cloudAccount.unlink");
    return response(state("unlinked", 2, null));
  });
  t.mock.method(config, "refreshDesktopRuntime", async () => {});
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: true, loggedOutAt: Date.now() })));
  const workspaces = useWorkspacesStore();
  const navigations: string[] = [];
  const logout = integratedShellLogout(config, navigations)();
  await listed.promise;
  config.sessionToken = "session-B";
  config.authMode = "account";
  config.userSummary = { userId: "B" } as any;
  config.workspaceId = "local:B";
  workspaces.workspaces = [{ id: "local:B", title: "B", path: "B", createdAt: 2, updatedAt: 2 }] as any;
  const rejection = assert.rejects(logout, isCancelledRequestError);
  pending.resolve({ status: 200, body: { ok: true,
    workspaces: [{ id: "local:A", title: "A", path: "A", createdAt: 1, updatedAt: 1 }],
    workspaceListAuthoritative: true, activeClientCount: 1, workspaceListSuccessCount: 1, workspaceListFailureCount: 0,
  } });
  await rejection;
  assert.equal(config.workspaceId, "local:B");
  assert.deepEqual(workspaces.workspaces.map((workspace) => workspace.id), ["local:B"]);
  assert.equal(config.sessionToken, "session-B");
  assert.deepEqual(navigations, []);
});

test("an explicit unlink holds the old session revoked until the session owner changes", async (t) => {
  const methods: string[] = [];
  const config = setup(t, async (request) => { methods.push(request.method); return response(state(request.method.endsWith("unlink") ? "unlinked" : "linked", 2, null)); });
  await config.unlinkDesktopCloudAccount();
  await config.syncDesktopCloudAccount();
  assert.deepEqual(methods, ["runtime.cloudAccount.unlink"]);
  config.sessionToken = "new-session";
  await config.syncDesktopCloudAccount();
  assert.equal(methods.at(-1), "runtime.cloudAccount.link");
});

test("concurrent refreshes share one pending association and do not rotate the generation", async (t) => {
  let release!: (value: any) => void;
  const methods: string[] = [];
  const config = setup(t, async (request) => {
    methods.push(request.method);
    if (request.method.endsWith("unlink")) return new Promise((resolve) => { release = resolve; });
    return response(state("linked", 2));
  });
  // 不同 action 代理也必须合并在途请求。
  const first = config.syncDesktopCloudAccount.call(new Proxy(config, {}));
  const second = config.syncDesktopCloudAccount.call(new Proxy(config, {}));
  release(response(state("unlinked", 1, null)));
  await Promise.all([first, second]);
  assert.deepEqual(methods, ["runtime.cloudAccount.unlink", "runtime.cloudAccount.link"]);
});

test("a stopped local Client cannot keep a prior hello marked linked", async (t) => {
  const config = setup(t, async () => response(state("linked", 2)));
  config.desktopCloudAccount = state("linked", 2) as any;
  config.desktopRuntime = { status: "failed", requestId: "runtime", releaseId: null, errorCode: "CLIENT_EXIT_1" };
  assert.equal(config.desktopCloudAccountLinked, false);
});

test("a new local Client process recovers the unchanged temporary session", async (t) => {
  let links = 0;
  const config = setup(t, async (request) => {
    if (request.method.endsWith("link") && !request.method.endsWith("unlink")) links++;
    // 新进程丢失内存关联，状态查询返回 unlinked，前端应按原作用域恢复 link。
    if (request.method.endsWith("status")) return response(state("unlinked", 2, null));
    return response(state(request.method.endsWith("unlink") ? "unlinked" : "linked", links + 1, request.method.endsWith("unlink") ? null : "A"));
  });
  await config.syncDesktopCloudAccount();
  config.desktopRuntime!.requestId = "new-process";
  await config.syncDesktopCloudAccount();
  assert.equal(links, 2);
});

test("a late login response cannot replace the account selected by the newer login", async (t) => {
  const config = setup(t, async (request) => response(state(request.method.endsWith("unlink") ? "unlinked" : "linked", 3, request.method.endsWith("unlink") ? null : "B")));
  const finish = new Map<string, (value: Response) => void>();
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => { finish.set(JSON.parse(String(init?.body)).email, resolve); }));
  const account = useAccountStore();
  const first = account.login({ email: "A@example.test", password: "test", captchaToken: "captcha" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = account.login({ email: "B@example.test", password: "test", captchaToken: "captcha" });
  await new Promise((resolve) => setImmediate(resolve));
  const loginResponse = (userId: string) => new Response(JSON.stringify({ ok: true, sessionToken: `session-${userId}`, sessionExpiresAt: Date.now() + 60_000, accountRole: "personal_normal", accessContext: {}, userSummary: { userId }, homePath: "/chat" }));
  finish.get("B@example.test")!(loginResponse("B"));
  await second;
  finish.get("A@example.test")!(loginResponse("A"));
  await assert.rejects(first, isCancelledRequestError);
  assert.equal(config.userSummary?.userId, "B");
});
