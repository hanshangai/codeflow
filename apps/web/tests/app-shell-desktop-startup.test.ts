import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createPinia, setActivePinia } from "pinia";
import { computed, ref, watch } from "vue";
import type { DesktopBridgeApi, DesktopRuntimeState } from "@codeflowai/shared";
import { useConfigStore } from "../src/store/config.ts";
import { useWorkspacesStore } from "../src/store/workspaces.ts";
import { isDesktopWorkspace } from "../src/services/desktop.ts";
import { createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";

/** 执行实际 Shell mounted 生命周期，保留真实 config 状态读取及业务围栏。 */
function fixture(t: test.TestContext, options: { workspaces?: number; failure?: Error; cloudFailure?: Error; directory?: Promise<void>; realDirectory?: boolean } = {}) {
  const source = readFileSync(new URL("../src/composables/useAppShell.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("shell.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const shell = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "useAppShell") as ts.FunctionDeclaration;
  const mounted = shell.body!.statements.find(statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    && statement.expression.expression.getText(ast) === "onMounted" && statement.getText(ast).includes("refreshDesktopRuntime"));
  assert.ok(mounted);
  const original = Object.getOwnPropertyDescriptor(globalThis, "window"), events: string[] = [], logs: unknown[][] = [];
  let held = true, refreshes = 0, fail = options.failure;
  const bridge: DesktopBridgeApi = { getState: async (): Promise<DesktopRuntimeState> => ({ status: held ? "starting" : "ready",
    requestId: "startup", releaseId: "release", errorCode: null }), onEvent: () => () => {}, openWindow: async () => {}, exit: async () => {},
    request: async request => {
      if (held) throw new Error("DESKTOP_STARTUP_HELD");
      events.push(request.method);
      if (request.method === "workspaces.list" && options.realDirectory) {
        await options.directory;
        return { status: 200, body: { ok: true, workspaces: [{ id: "local:workspace", title: "Local", path: "C:/project", createdAt: 1, updatedAt: 1 }] } };
      }
      return { status: 200, body: { ok: true, client: { clientId: "local", version: "1.0.0", workspaceIds: ["local:workspace"], connectedAt: 1 } } };
    } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: bridge, addEventListener() {} } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore();
  const startupComplete = ref(false);
  const readinessCode = shell.body!.statements.filter(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => ["localWorkspaceReady", "currentWorkspaceReady"].includes(declaration.name.getText(ast))))
    .map(statement => statement.getText(ast)).join("\n");
  const workspaceReady = new Function("config", "computed", "isDesktopWorkspace", "desktopStartupComplete",
    ts.transpile(`${readinessCode}\nreturn currentWorkspaceReady;`, { target: ts.ScriptTarget.ES2022 }))(config, computed, isDesktopWorkspace, startupComplete);
  const refreshAfterConnect = shell.body!.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "refreshWorkspaceListAfterConnect");
  assert.ok(refreshAfterConnect);
  const workspaces = options.realDirectory ? useWorkspacesStore() : { get workspaces() { return Array.from({ length: options.workspaces ?? 1 }); },
    /** 首次本地目录与账号聚合有独立故障，防止测试隐藏启动耦合。 */
    refresh: async (_ctx?: unknown, opts?: { localOnly?: boolean }) => {
      refreshes++; if (fail) throw fail;
      if (!opts?.localOnly && options.cloudFailure) throw options.cloudFailure;
      await options.directory; events.push("workspaces");
    } };
  const feedback = { error: () => events.push("error") };
  const diagnostics = { error: (...args: unknown[]) => { logs.push(args); }, warn: (...args: unknown[]) => { logs.push(args); } };
  const refreshWorkspaceList = new Function("config", "workspaces", "ctx", "ensureWorkspaceSelectionStable", "fetchClientVersionInfo", "isCancelledRequestError", "console", "message", "desktopStartupComplete",
    ts.transpile(`${refreshAfterConnect.getText(ast)}\nreturn refreshWorkspaceListAfterConnect;`, { target: ts.ScriptTarget.ES2022 }))(
    config, workspaces, { value: {} }, () => {}, async () => {}, isCancelledRequestError, diagnostics, feedback, startupComplete);
  let poll!: () => void;
  const code = ts.transpile(mounted.getText(ast), { target: ts.ScriptTarget.ES2022 });
  new Function("config", "onMounted", "subscribeDesktopEvents", "ws", "syncDesktopAccount", "workspaces", "ctx", "openSettingsOrWizard",
    "message", "setInterval", "window", "document", "handleThreadUrlChanged", "THREAD_URL_CHANGED_EVENT", "handleWorkspaceUrlSync", "WORKSPACE_URL_SYNC_EVENT",
    "refreshEngineStatusAfterVisible", "console", "desktopStartupComplete", "isCancelledRequestError", "refreshWorkspaceListAfterConnect", `let stopDesktopEvents = null, desktopStatusTimer = null;\n${code}`)(
    config, (fn: () => void) => fn(), () => () => {}, { receiveDesktopEvent() {} }, async () => { if (config.localRuntimeReady) events.push("sync-account"); },
    workspaces,
    { value: {} }, () => events.push("settings"), { error: () => events.push("error") }, (fn: () => void) => { poll = fn; return 1; },
    { addEventListener() {} }, { addEventListener() {} }, () => {}, "thread", () => {}, "workspace", () => {},
    diagnostics, startupComplete, isCancelledRequestError, refreshWorkspaceList,
  );
  /** 排空真实状态查询、目录读取和轮询续体。 */
  const settle = async () => { for (let index = 0; index < 4; index++) await new Promise<void>(resolve => setImmediate(resolve)); };
  return { config, events, logs, settle, workspaceReady, refreshWorkspaceList, startupComplete, refreshes: () => refreshes, release: () => { held = false; }, clearFailure: () => { fail = undefined; },
    poll: async () => { poll(); await settle(); } };
}

test("held放行前不请求业务、不弹设置，放行后的轮询仍执行一次首次工作区加载", async t => {
  const f = fixture(t); await f.settle();
  assert.equal(f.config.desktopRuntime?.status, "starting");
  assert.equal(f.config.desktopError, null);
  assert.equal(f.startupComplete.value, false);
  assert.deepEqual(f.events, []);
  f.release(); await f.poll();
  assert.equal(f.config.localRuntimeReady, true);
  assert.equal(f.startupComplete.value, true);
  assert.equal(f.refreshes(), 1);
  assert.deepEqual(f.events, ["runtime.info", "sync-account", "workspaces"]);
  await f.poll();
  assert.equal(f.refreshes(), 1);
});

test("首次本地加载成功后云列表失败应明确提示，但不把本机运行时标为失败", async t => {
  const f = fixture(t, { cloudFailure: new Error("ACCOUNT_WORKSPACE_LIST_FAILED") });
  f.config.connected = true;
  await f.settle(); f.release(); await f.poll();
  assert.equal(f.config.localRuntimeReady, true);
  assert.equal(f.config.desktopError, null);
  assert.equal(f.startupComplete.value, true);
  assert.equal(f.events.includes("workspaces"), true);
  assert.equal(f.events.includes("error"), true);
  assert.ok(f.logs.some(log => JSON.stringify(log).includes("ACCOUNT_WORKSPACE_LIST_FAILED")));
  assert.equal(f.refreshes(), 2);
  await f.poll();
  assert.equal(f.refreshes(), 2, "云失败不应令首次初始化在轮询中反复重跑");
});

test("云端先连上不能提前激活桌面工作区或绕过本机首次加载", async t => {
  const f = fixture(t);
  f.config.workspaceId = "local:workspace";
  f.config.connected = true;
  await f.settle();
  assert.equal(f.workspaceReady.value, false);
  f.refreshWorkspaceList(); await f.settle();
  assert.deepEqual(f.events, []);
  f.release(); await f.poll();
  assert.equal(f.workspaceReady.value, true);
  f.config.connected = false;
  assert.equal(f.workspaceReady.value, true, "本机就绪后不依赖云端在线");
  f.config.workspaceId = "remote:workspace";
  assert.equal(f.workspaceReady.value, false);
  f.config.connected = true;
  assert.equal(f.workspaceReady.value, true, "远端工作区仍依赖云端连接");
});

test("延后首次加载得到空目录时才沿原入口打开设置", async t => {
  const f = fixture(t, { workspaces: 0 }); await f.settle();
  assert.equal(f.events.includes("settings"), false);
  f.release(); await f.poll();
  assert.deepEqual(f.events, ["runtime.info", "sync-account", "workspaces", "settings"]);
});

test("首次目录失败保持显式失败，后续恢复仍补做首次加载", async t => {
  const f = fixture(t, { failure: new Error("WORKSPACE_READ_FAILED") }); await f.settle();
  f.release(); await f.poll();
  assert.equal(f.config.desktopRuntime?.status, "failed");
  assert.equal(f.config.desktopError, "WORKSPACE_READ_FAILED");
  assert.equal(f.startupComplete.value, false);
  assert.equal(f.events.includes("settings"), false, "失败留在启动页，不打开设置遮挡失败原因");
  assert.ok(f.logs.some(log => JSON.stringify(log).includes("WORKSPACE_READ_FAILED")));
  f.clearFailure(); await f.poll();
  assert.equal(f.refreshes(), 2);
  assert.equal(f.config.localRuntimeReady, true);
  assert.equal(f.events.at(-1), "workspaces");
});

test("账号作用域取消目录读取不伪造Client失败，下轮仍补齐首次加载", async t => {
  const f = fixture(t, { failure: createCancelledRequestError("scope-change") });
  await f.settle();
  f.release(); await f.poll();
  assert.equal(f.config.desktopRuntime?.status, "ready");
  assert.equal(f.config.desktopError, null);
  assert.equal(f.startupComplete.value, false);
  assert.deepEqual(f.logs, []);
  f.clearFailure(); await f.poll();
  assert.equal(f.refreshes(), 2);
  assert.equal(f.config.localRuntimeReady, true);
  assert.equal(f.startupComplete.value, true);
});

test("首次目录仍在读取时轮询复用原在途初始化，不重复加载目录", async t => {
  let finish!: () => void;
  const directory = new Promise<void>(resolve => { finish = resolve; });
  t.after(() => finish());
  const f = fixture(t, { directory }); await f.settle();
  f.release(); await f.poll(); await f.poll();
  assert.equal(f.refreshes(), 1);
  assert.equal(f.startupComplete.value, false, "目录未完成时仍停留启动页");
  finish(); await f.settle(); await f.poll();
  assert.equal(f.refreshes(), 1);
  assert.equal(f.startupComplete.value, true);
  assert.equal(f.events.filter(event => event === "workspaces").length, 1);
});

test("恢复上次工作区时目录完成前不激活会话，完成后断云也自动触发首次列表加载", async t => {
  let finish!: () => void;
  const directory = new Promise<void>(resolve => { finish = resolve; });
  t.after(() => finish());
  const f = fixture(t, { realDirectory: true, directory });
  f.config.workspaceId = "local:workspace";
  const directoryStore = useWorkspacesStore();
  const activations: boolean[] = [];
  const stop = watch(() => f.workspaceReady.value, ready => {
    if (ready) activations.push(directoryStore.byId.has(f.config.workspaceId));
  });
  t.after(stop);
  await f.settle(); f.release(); await f.poll();
  assert.equal(f.config.localRuntimeReady, true);
  assert.equal(f.startupComplete.value, false);
  assert.equal(f.workspaceReady.value, false, "runtime.info就绪不能抢在首次目录前激活会话");
  assert.deepEqual(activations, []);
  finish(); await f.settle();
  assert.equal(f.config.connected, false);
  assert.equal(f.workspaceReady.value, true);
  assert.deepEqual(activations, [true], "目录完成且工作区ID不变也应自动激活一次");
  await f.poll();
  assert.deepEqual(activations, [true], "相同运行态轮询不能重复加载列表");
});

test("真实列表在首次 IPC 读取中切换账号时，取消不得完成启动或打开设置", async t => {
  let finish!: () => void;
  const directory = new Promise<void>(resolve => { finish = resolve; });
  t.after(() => finish());
  const f = fixture(t, { realDirectory: true, directory });
  f.config.workspaceId = "local:workspace";
  await f.settle(); f.release(); await f.poll();
  f.config.sessionToken = "changed-owner";
  finish(); await f.settle();
  assert.equal(f.startupComplete.value, false);
  assert.equal(f.config.localRuntimeReady, true);
  assert.equal(f.config.desktopError, null);
  assert.equal(f.events.includes("settings"), false);
  await f.poll();
  assert.equal(f.startupComplete.value, true);
});
