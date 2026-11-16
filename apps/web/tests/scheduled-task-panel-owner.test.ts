import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import * as vue from "vue";
import ts from "typescript";
import * as shared from "@codeflowai/shared";
import type { ScheduledTask } from "@codeflowai/shared";
import * as context from "../src/composables/useApiContext.ts";
import * as api from "../src/api/scheduled-tasks/index.ts";
import * as workspaces from "../src/api/workspaces/index.ts";
import * as orchestration from "../src/api/orchestration/index.ts";
import * as desktop from "../src/services/desktop.ts";
import * as account from "../src/store/account.ts";
import * as request from "../src/api/request.ts";
import * as configModule from "../src/store/config.ts";
import { useConfigStore } from "../src/store/config.ts";

const require = createRequire(import.meta.url);
// Vue 自带编译器；执行完整 script setup，不复制被测方法。
const { parse, compileScript } = require("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
const panelPath = new URL("../src/features/admin/components/AdminScheduledTasksPanel.vue", import.meta.url);
const script = compileScript(parse(readFileSync(panelPath, "utf8")).descriptor, { id: "task-owner-test" }).content;
const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
type Panel = Record<string, any>;
type Pending = { url: URL; init: RequestInit; resolve: (response: Response) => void; reject: (error: Error) => void };

/** 最小完整账号脚本任务，避免校验前置掩盖请求归属。 */
function task(id = "task-A"): ScheduledTask {
  return { id, ownerUserId: "A", clientId: "client-A", deviceId: "device-A", clientNameSnapshot: "fixture", deviceLabelSnapshot: null, name: id, description: null,
    taskType: "script", payload: { shell: "powershell", command: "echo fixture", contextWorkspaceId: null, cwdRelative: ".", envRefs: [] },
    cronExpr: "0 9 * * *", timezone: "Asia/Shanghai", enabled: true, timeoutMs: 60_000,
    concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", createdAt: 1, updatedAt: 1,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null };
}

/** 使用真实配置动作建立会话；所有凭据都是夹具字面量。 */
function login(config: ReturnType<typeof useConfigStore>, id: string) {
  config.setAccountSession({ sessionToken: `session-${id}`, sessionExpiresAt: Date.now() + 60_000, accountRole: "personal_normal",
    userSummary: { userId: id, fullName: id }, accessContext: {}, homePath: "/chat" } as any);
}

/** 排空有限异步续体；不等待外部服务或无限轮询。 */
async function settle() {
  await vue.nextTick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vue.nextTick();
}

/** 只替换 UI/生命周期与网络边界，保留真实 Vue、Pinia、账号 owner 和 API。 */
function setup(t: test.TestContext, source: "account" | "local" | "desktop-account" = "account") {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const localRequests: Array<{ method: string; body?: any; resolve: (response: object) => void }> = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: source !== "account" ? { codeflowDesktop: {
    getState: () => ({}), request: (input: { method: string }) => new Promise((resolve) => { localRequests.push({ ...input, resolve }); }),
  } } : undefined });
  const pinia = createPinia(); setActivePinia(pinia);
  const config = useConfigStore(); config.serverWsOrigin = "wss://cloud.example"; login(config, "A");
  const requests: Pending[] = [], logs: unknown[][] = [], toasts: string[] = [];
  const confirmations: Array<{ onOk: () => Promise<void>; destroyed: boolean }> = [];
  const unmount: Array<() => void> = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", (url: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    requests.push({ url: new URL(String(url)), init, resolve, reject });
  }));
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Panel } } };
  const load = (id: string) => {
    if (id === "vue") return { ...vue, onUnmounted: (callback: () => void) => unmount.push(callback) };
    if (id === "ant-design-vue") return {
      message: { success: (value: string) => toasts.push(value), warning: (value: string) => toasts.push(value) },
      Modal: { confirm: (options: { onOk: () => Promise<void> }) => {
        const confirmation = { ...options, destroyed: false }; confirmations.push(confirmation);
        return { destroy: () => { confirmation.destroyed = true; } };
      } },
    };
    if (id === "@ant-design/icons-vue") return {};
    const modules: Record<string, unknown> = { "@codeflowai/shared": shared, "../../../composables/useApiContext": context,
      "../../../api/scheduled-tasks": api, "../../../api/workspaces": workspaces, "../../../api/orchestration": orchestration,
      "../../../services/desktop": desktop, "../../../store/config": configModule, "../../../store/account": account, "../../../api/request": request };
    assert.ok(id in modules, `unexpected panel import: ${id}`);
    return modules[id];
  };
  new Function("require", "module", "exports", compiled)(load, module, module.exports);
  const props = vue.reactive({ source, active: true }), scope = vue.effectScope();
  const panel = scope.run(() => module.exports.default.setup(props, { expose: () => {} }))!;
  t.after(async () => {
    unmount.forEach((callback) => callback()); scope.stop(); disposePinia(pinia);
    // 释放尚未响应的夹具请求，防止失败用例留下悬挂续体。
    requests.forEach((request) => reply(request, { ok: false, code: "CLIENT_ERROR", message: "fixture closed" }));
    localRequests.forEach((request) => request.resolve({ status: 409, body: { ok: false, code: "CONFLICT", message: "fixture closed" } }));
    await settle();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return { config, panel, props, requests, localRequests, logs, toasts, confirmations, unmount };
}

/** 返回真实 requestJson 可解析的 HTTP 信封。 */
function reply(request: Pending, body: object, status = 200) {
  request.resolve(new Response(JSON.stringify(body), { status }));
}

/** 找到发起账号的实际 HTTP 请求；缺失会直接失败。 */
function find(requests: Pending[], id: string, path: string, method = "GET") {
  const request = requests.find((item) => item.url.pathname === path && item.init.method === method
    && new Headers(item.init.headers).get("Authorization") === `Bearer session-${id}`);
  assert.ok(request, `missing ${id} ${method} ${path}`);
  return request;
}

/** 清空初始化读取，后续用例只控制关心的异步边界。 */
async function ready(fixture: ReturnType<typeof setup>) {
  await settle();
  for (const request of fixture.requests) reply(request, request.url.pathname.endsWith("/devices")
    ? { ok: true, devices: [] } : { ok: true, items: [task()], total: 1 });
  await settle();
  fixture.requests.length = 0;
}

/** 账号本机列表携带Host设备，修订由Client持有。 */
function desktopList(items = [task()], revision = 7) {
  return { ok: true, clientId: "host-client", deviceId: "host-device", items: items.map((item) => ({
    task: { ...item, clientId: "host-client", deviceId: "host-device" }, localRevision: revision, pending: false, stopIntent: null,
  })) };
}

/** 通过真实preload信封释放某一桥调用。 */
function desktopReply(pending: ReturnType<typeof setup>["localRequests"][number], body: object, status = 200) {
  pending.resolve({ status, body });
}

/** 完成桌面账号初读；原管理HTTP读取不得介入。 */
async function readyDesktop(f: ReturnType<typeof setup>, items = [task()]) {
  await settle();
  assert.equal(f.requests.length, 0);
  assert.equal(f.localRequests[0]?.method, "scheduledTasks.account.list");
  desktopReply(f.localRequests[0], desktopList(items)); await settle();
  f.localRequests.length = 0;
}

test("desktop account empty list creates on trusted current device without listing all devices", async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f, []);
  await f.panel.openCreateModal(); await settle();
  assert.equal(f.panel.form.clientId, "host-client"); assert.equal(f.panel.form.deviceId, "host-device");
  assert.equal(f.panel.formModalOpen.value, true);
  assert.equal(f.localRequests[0]?.method, "workspaces.list"); assert.equal(f.requests.length, 0);
});

test("desktop account paginates full local list and explicit refresh uses sync", async t => {
  const f = setup(t, "desktop-account"); const items = Array.from({ length: 25 }, (_, i) => task(`task-${i}`));
  await readyDesktop(f, items);
  assert.equal(f.panel.taskTotal.value, 25); assert.equal(f.panel.tasks.value.length, 20);
  assert.equal(f.panel.tasks.value[0].localRevision, 7);
  f.panel.taskPage.value = 2; const page = f.panel.loadTasks(); await settle();
  assert.equal(f.localRequests[0].method, "scheduledTasks.account.list");
  desktopReply(f.localRequests[0], desktopList(items)); await page;
  assert.equal(f.panel.tasks.value.length, 5); assert.equal(f.panel.tasks.value[0].id, "task-20");
  const refresh = f.panel.loadTasks(true); await settle();
  assert.equal(f.localRequests[1].method, "scheduledTasks.account.sync");
  desktopReply(f.localRequests[1], desktopList([task()])); await refresh;
  assert.equal(f.panel.taskPage.value, 1); assert.equal(f.panel.taskTotal.value, 1);
  assert.equal(f.panel.tasks.value[0].id, "task-A"); assert.equal(f.requests.length, 0);
});

test("desktop account edit uses observed revision, fixed workspace and keeps draft on conflict", async t => {
  const f = setup(t, "desktop-account"); const original = task(); original.payload.contextWorkspaceId = "workspace-A" as never;
  original.timeoutMs = 65_001; await readyDesktop(f, [original]);
  f.panel.openEditModal(f.panel.tasks.value[0]); await settle();
  assert.equal(f.localRequests[0].method, "workspaces.list");
  desktopReply(f.localRequests[0], { ok: true, workspaces: [] }); await settle();
  f.panel.form.name = "revised name"; const save = f.panel.saveTask(); await settle();
  const write = f.localRequests[1]; assert.equal(write.method, "scheduledTasks.account.update");
  assert.equal(write.body.expectedLocalRevision, 7); assert.equal(write.body.config.name, "revised name");
  assert.equal(write.body.config.timeoutMs, 65_001); assert.equal(write.body.config.payload.contextWorkspaceId, "workspace-A");
  assert.equal("clientId" in write.body.config, false); assert.equal("deviceId" in write.body.config, false);
  desktopReply(write, { ok: false, code: "CONFLICT", message: "revision conflict", details: { requestId: "account-edit-1" } }, 409);
  await settle();
  const reconcile = f.localRequests[2];
  if (reconcile) desktopReply(reconcile, desktopList([original]));
  await save;
  assert.equal(f.panel.formModalOpen.value, true); assert.equal(f.panel.form.name, "revised name");
  assert.match(f.panel.formError.value, /revision conflict/u); assert.equal(f.toasts.length, 0);
  assert.equal(f.logs.length, 1); assert.equal(f.requests.length, 0);
});

for (const action of ["edit", "toggle", "delete"] as const)
test(`desktop account ${action} failure reconciles durable local changes without syncing or retrying writes`, async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f); const target = f.panel.tasks.value[0];
  let run: Promise<void>;
  if (action === "edit") {
    f.panel.openEditModal(target); await settle(); desktopReply(f.localRequests[0], { ok: true, workspaces: [] }); await settle();
    f.panel.form.name = "durable draft"; run = f.panel.saveTask();
  } else if (action === "toggle") run = f.panel.setTaskEnabled(target, false);
  else { f.panel.confirmDeleteTask(target); run = assert.rejects(f.confirmations[0].onOk(), /write failed/u); }
  await settle(); const write = f.localRequests.at(-1)!;
  desktopReply(write, { ok: false, code: "CLIENT_ERROR", message: "write failed", details: { requestId: "durable-failure-1" } }, 500);
  await settle();
  const read = f.localRequests.find(p => p.method === "scheduledTasks.account.list");
  if (read) desktopReply(read, action === "delete" ? desktopList([]) : { ...desktopList(), items: [{
    task: { ...target, enabled: action === "toggle" ? false : true, name: action === "edit" ? "durable draft" : target.name },
    localRevision: 8, pending: true, stopIntent: action === "toggle" ? "disabled" : null,
  }] });
  await run;
  assert.ok(read, "failed write must read durable Client state");
  if (action === "delete") assert.equal(f.panel.tasks.value.length, 0);
  else { assert.equal(f.panel.tasks.value[0].localRevision, 8); assert.equal(f.panel.tasks.value[0].pending, true); }
  if (action === "toggle") { assert.equal(f.panel.tasks.value[0].enabled, false); assert.equal(f.panel.tasks.value[0].stopIntent, "disabled"); }
  if (action === "edit") {
    assert.equal(f.panel.form.name, "durable draft"); assert.equal(f.panel.formModalOpen.value, true);
    assert.equal(f.panel.editingTask.value.localRevision, 7);
  }
  assert.match(action === "edit" ? f.panel.formError.value : f.panel.panelError.value, /write failed/u);
  assert.equal(f.localRequests.filter(p => p.method === "scheduledTasks.account.sync").length, 0);
  assert.equal(f.localRequests.filter(p => p.method === write.method).length, 1);
  assert.equal(f.logs.length, 1); assert.deepEqual(f.toasts, []);
});

test("desktop account reconciliation failure preserves both write and read errors", async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f);
  const toggle = f.panel.setTaskEnabled(f.panel.tasks.value[0], false); await settle();
  desktopReply(f.localRequests[0], { ok: false, code: "CLIENT_ERROR", message: "original write failed" }, 500); await settle();
  assert.equal(f.localRequests[1]?.method, "scheduledTasks.account.list");
  desktopReply(f.localRequests[1], { ok: false, code: "CLIENT_ERROR", message: "local read failed" }, 500); await toggle;
  assert.match(f.panel.panelError.value, /original write failed/u); assert.match(f.panel.panelError.value, /local read failed/u);
  assert.equal(f.logs.length, 2); assert.deepEqual(f.toasts, []);
  assert.deepEqual(f.localRequests.map(p => p.method), ["scheduledTasks.account.update", "scheduledTasks.account.list"]);
});

test("desktop account reconciliation cannot restore old failure after owner replacement", async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f);
  const toggle = f.panel.setTaskEnabled(f.panel.tasks.value[0], false); await settle();
  desktopReply(f.localRequests[0], { ok: false, code: "CLIENT_ERROR", message: "private write failure" }, 500); await settle();
  const read = f.localRequests[1]; assert.equal(read?.method, "scheduledTasks.account.list");
  login(f.config, "B"); await settle(); const count = f.localRequests.length;
  desktopReply(read, desktopList([task("private-old-account")])); await toggle;
  assert.deepEqual(f.panel.tasks.value, []); assert.equal(f.panel.panelError.value, ""); assert.equal(f.panel.formError.value, "");
  assert.equal(f.localRequests.length, count); assert.deepEqual(f.toasts, []);
});

test("desktop account creation uses HTTP once then sync failure closes creation and gives refresh guidance", async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f, []); await f.panel.openCreateModal(); await settle();
  desktopReply(f.localRequests[0], { ok: true, workspaces: [] }); await settle();
  Object.assign(f.panel.form, { taskType: "script", name: "new account task", scriptCommand: "echo new" });
  const save = f.panel.saveTask(); await settle();
  const create = find(f.requests, "A", "/api/account/scheduled-tasks", "POST");
  assert.equal(JSON.parse(String(create.init.body)).deviceId, "host-device");
  reply(create, { ok: true, task: task("created-task") }); await settle();
  assert.equal(f.panel.formModalOpen.value, false);
  assert.equal(f.localRequests[1].method, "scheduledTasks.account.sync");
  desktopReply(f.localRequests[1], { ok: false, code: "CLIENT_ERROR", message: "sync failed" }, 503); await save;
  assert.match(f.panel.panelError.value, /已创建.*刷新/u); assert.match(f.panel.panelError.value, /sync failed/u);
  assert.deepEqual(f.toasts, []); assert.equal(f.requests.length, 1); assert.equal(f.logs.length, 1);
});

test("desktop account run and deleted-task history use account bridge with real pagination", async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f); const target = f.panel.tasks.value[0];
  const run = f.panel.runTaskNow(target); await settle();
  assert.equal(f.localRequests[0].method, "scheduledTasks.account.runNow");
  desktopReply(f.localRequests[0], { ok: true, run: { status: "success" } }); await settle();
  assert.equal(f.localRequests[1].method, "scheduledTasks.account.list");
  assert.equal(f.localRequests[2].method, "scheduledTasks.account.runs");
  desktopReply(f.localRequests[1], desktopList()); desktopReply(f.localRequests[2], { ok: true, items: [], total: 0 }); await run;
  const history = f.panel.openRunsDrawer(null); await settle();
  const pending = f.localRequests[3]; assert.equal(pending.method, "scheduledTasks.account.runs");
  assert.deepEqual(pending.body, { limit: 20, offset: 0 });
  desktopReply(pending, { ok: true, items: [{ id: "deleted-run", taskNameSnapshot: "deleted task", source: "account" }], total: 21 }); await history;
  assert.equal(f.panel.runsTotal.value, 21); assert.equal(f.panel.runs.value[0].taskNameSnapshot, "deleted task");
  assert.equal(f.requests.length, 0);
});

test("desktop account deletion uses local revision and keeps history drawer", async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f); const target = f.panel.tasks.value[0];
  f.panel.confirmDeleteTask(target); const deletion = f.confirmations[0].onOk(); await settle();
  assert.equal(f.localRequests[0].method, "scheduledTasks.account.delete");
  assert.deepEqual(f.localRequests[0].body, { taskId: target.id, expectedLocalRevision: 7 });
  desktopReply(f.localRequests[0], { ok: true, deleted: true }); await settle();
  desktopReply(f.localRequests[1], desktopList([])); await deletion;
  assert.equal(f.panel.taskTotal.value, 0); assert.equal(f.requests.length, 0);
});

for (const transition of ["account", "close", "same-account"] as const)
test(`desktop account late sync cannot repopulate after ${transition}`, async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f);
  const refresh = f.panel.loadTasks(true); await settle(); const old = f.localRequests[0];
  assert.equal(old.method, "scheduledTasks.account.sync");
  f.panel.formModalOpen.value = true; f.panel.form.name = "private draft";
  if (transition === "close") f.props.active = false;
  else if (transition === "same-account") f.config.sessionToken = "session-A-renewed";
  else login(f.config, "B");
  assert.equal(f.panel.form.name, ""); assert.equal(f.panel.formModalOpen.value, false);
  desktopReply(old, desktopList([task("private-A")])); await refresh;
  assert.deepEqual(f.panel.tasks.value, []); assert.deepEqual(f.logs, []); assert.deepEqual(f.toasts, []);
});

test("desktop account delayed create cannot sync with a replacement account", async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f, []); await f.panel.openCreateModal(); await settle();
  desktopReply(f.localRequests[0], { ok: true, workspaces: [] }); await settle();
  Object.assign(f.panel.form, { taskType: "script", name: "new task", scriptCommand: "echo new" });
  const save = f.panel.saveTask(); await settle(); const old = f.requests[0]; assert.ok(old);
  login(f.config, "B"); await settle(); const count = f.localRequests.length;
  reply(old, { ok: true, task: task("old-A") }); await save;
  assert.equal(f.localRequests.length, count); assert.equal(f.panel.formModalOpen.value, false); assert.deepEqual(f.toasts, []);
});

test("desktop account without login does not request account bridge or all-device HTTP", async t => {
  const f = setup(t, "desktop-account"); f.config.clearSession(); await settle();
  assert.equal(f.localRequests.length, 0); assert.equal(f.requests.length, 0);
});

test("desktop account toggle preserves original payload and revision then refreshes from Client", async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f); const target = f.panel.tasks.value[0];
  const toggle = f.panel.setTaskEnabled(target, false); await settle();
  const write = f.localRequests[0]; assert.equal(write.method, "scheduledTasks.account.update");
  assert.equal(write.body.expectedLocalRevision, 7); assert.equal(write.body.config.enabled, false);
  assert.deepEqual(write.body.config.payload, target.payload); assert.equal("ownerUserId" in write.body.config, false);
  desktopReply(write, { ok: true, item: { task: { ...target, enabled: false }, localRevision: 8, pending: true, stopIntent: "disabled" } });
  await settle(); assert.equal(f.panel.tasks.value[0].localRevision, 8); assert.equal(f.panel.tasks.value[0].stopIntent, "disabled");
  assert.equal(f.localRequests[1].method, "scheduledTasks.account.list");
  const updated = desktopList([{ ...target, enabled: false }], 8); desktopReply(f.localRequests[1], updated); await toggle;
  assert.equal(f.panel.togglingTaskId.value, ""); assert.equal(f.requests.length, 0);
});

test("desktop account cron uses local preview and failure never falls back to HTTP", async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f); f.panel.formModalOpen.value = true;
  const preview = f.panel.previewCron(); await settle();
  assert.equal(f.localRequests[0].method, "scheduledTasks.local.cronPreview");
  desktopReply(f.localRequests[0], { ok: false, code: "CLIENT_ERROR", message: "invalid cron" }, 400); await preview;
  assert.match(f.panel.formError.value, /invalid cron/u); assert.equal(f.logs.length, 1); assert.equal(f.requests.length, 0);
});

test("desktop account successful edit closes once and reloads local revisions", async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f); const target = f.panel.tasks.value[0];
  f.panel.openEditModal(target); await settle(); desktopReply(f.localRequests[0], { ok: true, workspaces: [] }); await settle();
  f.panel.form.name = "updated task";
  const save = f.panel.saveTask(); const duplicate = f.panel.saveTask(); await settle(); await duplicate;
  assert.equal(f.localRequests.length, 2);
  desktopReply(f.localRequests[1], { ok: true, item: { task: { ...target, name: "updated task" }, localRevision: 8, pending: false, stopIntent: null } });
  await settle(); assert.equal(f.panel.formModalOpen.value, false);
  desktopReply(f.localRequests[2], desktopList([{ ...target, name: "updated task" }], 8)); await save;
  assert.equal(f.panel.tasks.value[0].localRevision, 8); assert.equal(f.panel.tasks.value[0].name, "updated task");
  assert.equal(f.toasts.length, 1); assert.equal(f.requests.length, 0);
});

for (const action of ["edit", "run", "history", "delete"] as const)
test(`desktop account late ${action} result cannot update replacement account UI`, async t => {
  const f = setup(t, "desktop-account"); await readyDesktop(f); const target = f.panel.tasks.value[0];
  let pending: Promise<void>;
  if (action === "edit") {
    f.panel.openEditModal(target); await settle(); desktopReply(f.localRequests[0], { ok: true, workspaces: [] }); await settle();
    pending = f.panel.saveTask();
  } else if (action === "run") pending = f.panel.runTaskNow(target);
  else if (action === "history") pending = f.panel.openRunsDrawer(target);
  else { f.panel.confirmDeleteTask(target); pending = f.confirmations[0].onOk(); }
  await settle(); const old = f.localRequests.at(-1)!; login(f.config, "B"); await settle(); const count = f.localRequests.length;
  desktopReply(old, action === "edit" ? { ok: true, item: { task: target, localRevision: 8, pending: false, stopIntent: null } }
    : action === "run" ? { ok: true, run: { status: "success" } }
    : action === "history" ? { ok: true, items: [{ id: "private-run" }], total: 1 } : { ok: true, deleted: true });
  await pending;
  assert.deepEqual(f.panel.tasks.value, []); assert.deepEqual(f.panel.runs.value, []);
  assert.equal(f.localRequests.length, count); assert.deepEqual(f.toasts, []); assert.equal(f.requests.length, 0);
});

test("account task edits keep the workspace and type changes cannot manufacture a new binding", async t => {
  const f = setup(t); await ready(f);
  const original = task(); original.payload.contextWorkspaceId = "workspace-A" as never;
  f.panel.openEditModal(original);
  assert.equal(f.panel.boundWorkspace.value, "workspace-A"); assert.equal(f.panel.workspaceEditing.value, true);
  assert.equal(f.panel.form.workflowWorkspaceId, "workspace-A");
  f.panel.form.scriptWorkspaceId = "workspace-B";
  assert.throws(() => f.panel.buildSaveBody(), /工作区.*不可更改/u);
  f.panel.form.scriptWorkspaceId = "";
  assert.throws(() => f.panel.buildSaveBody(), /工作区.*不可更改/u);
  f.panel.form.taskType = "workflow"; await settle(); f.panel.form.workflowId = "flow";
  assert.equal(f.panel.buildSaveBody().payload.contextWorkspaceId, "workspace-A");
  f.panel.openEditModal(task()); f.panel.form.taskType = "workflow"; await settle();
  f.panel.form.workflowWorkspaceId = "workspace-A"; f.panel.form.workflowId = "flow";
  assert.throws(() => f.panel.buildSaveBody(), /工作区.*不可更改/u);
  f.panel.resetForm(); assert.equal(f.panel.workspaceEditing.value, false);
  f.panel.form.taskType = "script"; f.panel.form.name = "new task"; f.panel.form.clientId = "client-A"; f.panel.form.deviceId = "device-A";
  f.panel.form.scriptCommand = "echo new"; f.panel.form.scriptWorkspaceId = "workspace-B";
  assert.equal(f.panel.buildSaveBody().payload.contextWorkspaceId, "workspace-B");
});

test("account fixed workspace survives switching device away and back while workflow selection resets", async t => {
  const f = setup(t); await ready(f);
  const original = task(); original.payload.contextWorkspaceId = "workspace-A" as never;
  f.panel.openEditModal(original); await settle();
  f.panel.form.workflowId = "old-flow";
  f.panel.deviceSelectValue.value = "client-B::device-B"; await settle();
  assert.equal(f.panel.form.workflowId, "");
  assert.equal(f.panel.form.scriptWorkspaceId, "workspace-A");
  assert.equal(f.panel.form.workflowWorkspaceId, "workspace-A");
  f.panel.deviceSelectValue.value = "client-A::device-A"; await settle();
  assert.equal(f.panel.buildSaveBody().payload.contextWorkspaceId, "workspace-A");
  f.panel.resetForm(); f.panel.form.workflowWorkspaceId = "workspace-A"; f.panel.form.scriptWorkspaceId = "workspace-A";
  f.panel.resetDeviceAssetFields();
  assert.equal(f.panel.form.scriptWorkspaceId, ""); assert.equal(f.panel.form.workflowWorkspaceId, "");
});

for (const status of [200, 401]) test(`late A list HTTP ${status} cannot replace or expire B`, async (t) => {
  const f = setup(t); await settle(); const first = find(f.requests, "A", "/api/account/scheduled-tasks");
  login(f.config, "B"); await settle();
  reply(find(f.requests, "B", "/api/account/scheduled-tasks"), { ok: true, items: [task("task-B")], total: 1 }); await settle();
  reply(first, status === 200 ? { ok: true, items: [task()], total: 1 } : { ok: false, code: "UNAUTHORIZED", message: "expired A" }, status);
  await settle();
  assert.equal(f.config.sessionToken, "session-B"); assert.equal(f.config.userSummary?.userId, "B");
  assert.equal(f.panel.tasks.value[0].id, "task-B"); assert.equal(f.panel.panelError.value, ""); assert.deepEqual(f.logs, []);
});

test("same-tick A to B to A invalidates old list and all private panel content immediately", async (t) => {
  const f = setup(t); await ready(f);
  const pending = f.panel.loadTasks(); await settle(); const old = find(f.requests, "A", "/api/account/scheduled-tasks");
  f.panel.form.name = "private A"; f.panel.form.scriptCommand = "private command"; f.panel.formModalOpen.value = true;
  f.panel.assets.value = { workspaces: [{ workspaceId: "private" }], workflows: [] };
  f.panel.runs.value = [{ id: "private-run" }]; f.panel.selectedRunsTask.value = task(); f.panel.runsDrawerOpen.value = true;
  f.panel.confirmDeleteTask(task());
  login(f.config, "B"); login(f.config, "A");
  assert.deepEqual(f.panel.tasks.value, []); assert.deepEqual(f.panel.runs.value, []);
  assert.equal(f.panel.assets.value, null); assert.equal(f.panel.selectedRunsTask.value, null);
  assert.equal(f.panel.form.name, ""); assert.equal(f.panel.form.scriptCommand, "");
  assert.equal(f.panel.formModalOpen.value, false); assert.equal(f.panel.runsDrawerOpen.value, false);
  assert.equal(f.confirmations[0].destroyed, true);
  reply(old, { ok: true, items: [task("old-A")], total: 1 }); await pending;
  assert.deepEqual(f.panel.tasks.value, []);
});

test("old delete confirmation cannot issue DELETE under B", async (t) => {
  const f = setup(t); await ready(f); f.panel.confirmDeleteTask(task()); const confirmation = f.confirmations[0];
  login(f.config, "B");
  const deletion = confirmation.onOk(); const rejected = assert.rejects(deletion); await settle();
  for (const request of f.requests.filter((item) => item.init.method === "DELETE")) reply(request, { ok: true, deleted: true });
  // 错误实现会继续重读；释放读取以便断言失败，而不是悬挂用例。
  await settle();
  for (const request of f.requests.filter((item) => item.init.method === "GET")) reply(request, { ok: true, items: [], total: 0, devices: [] });
  await rejected;
  assert.equal(confirmation.destroyed, true);
  assert.equal(f.requests.filter((request) => request.init.method === "DELETE").length, 0);
  assert.deepEqual(f.logs, []); assert.deepEqual(f.toasts, []);
});

for (const operation of ["devices", "assets", "runs", "preview"] as const)
test(`late A ${operation} cannot repopulate B`, async (t) => {
  const f = setup(t); await ready(f); f.panel.formModalOpen.value = true;
  Object.assign(f.panel.form, { clientId: "client-A", deviceId: "device-A" });
  const run = operation === "devices" ? f.panel.loadDevices() : operation === "assets" ? f.panel.loadAssets()
    : operation === "runs" ? f.panel.openRunsDrawer(task()) : f.panel.previewCron();
  await settle(); const old = f.requests[0]; assert.ok(old);
  login(f.config, "B"); await settle();
  reply(old, operation === "devices" ? { ok: true, devices: [{ clientId: "private-A" }] }
    : operation === "assets" ? { ok: true, workspaces: [{ workspaceId: "private-A" }], workflows: [] }
    : operation === "runs" ? { ok: true, items: [{ id: "private-A" }], total: 1 }
    : { ok: true, valid: true, nextRunAts: [123] }); await run;
  assert.deepEqual(f.panel.devices.value, []); assert.equal(f.panel.assets.value, null);
  assert.deepEqual(f.panel.runs.value, []); assert.deepEqual(f.panel.cronPreview.value, []); assert.deepEqual(f.logs, []);
});

for (const operation of ["save", "run"] as const) for (const failure of [false, true])
test(`late A ${operation} ${failure ? "failure" : "success"} cannot finish B UI or trigger B reads`, async (t) => {
  const f = setup(t); await ready(f); Object.assign(f.panel.form, task());
  Object.assign(f.panel.form, { description: "", scriptCommand: "echo fixture" }); f.panel.formModalOpen.value = true;
  const first = operation === "save" ? f.panel.saveTask() : f.panel.runTaskNow(task()); await settle();
  const old = f.requests[0]; assert.ok(old); login(f.config, "B"); await settle();
  Object.assign(f.panel.form, task("task-B"), { description: "", scriptCommand: "echo fixture" }); f.panel.formModalOpen.value = true;
  const second = f.panel.saveTask(); await settle(); const current = f.requests.at(-1)!;
  const count = f.requests.length;
  reply(old, failure ? { ok: false, code: "CONFLICT", message: "old failure" }
    : operation === "save" ? { ok: true, task: task() } : { ok: true, run: { status: "success" } });
  await settle();
  for (const request of f.requests.slice(count)) reply(request, { ok: true, items: [], total: 0 });
  await first;
  assert.equal(f.panel.saving.value, true); assert.equal(f.panel.formModalOpen.value, true);
  assert.equal(f.requests.length, count); assert.deepEqual(f.toasts, []); assert.deepEqual(f.logs, []);
  reply(current, { ok: false, code: "CONFLICT", message: "current failure" }); await second;
  assert.match(f.panel.formError.value, /current failure/u); assert.equal(f.panel.saving.value, false);
});

test("pending ensureSession cannot borrow B credentials for an A write", async (t) => {
  const f = setup(t); await ready(f); Object.assign(f.panel.form, task(), { description: "", scriptCommand: "echo fixture" });
  let release!: (token: string) => void;
  t.mock.method(f.config, "ensureSession", () => new Promise<string>((resolve) => { release = resolve; }));
  const run = f.panel.saveTask(); assert.ok(release); login(f.config, "B"); release("session-B"); await settle();
  for (const request of f.requests) reply(request, { ok: false, code: "CONFLICT", message: "fixture denied" });
  await run;
  assert.equal(f.requests.filter((request) => request.init.method === "POST").length, 0);
  assert.deepEqual(f.logs, []); assert.deepEqual(f.toasts, []);
});

for (const failure of ["api", "network", "unauthorized"] as const)
test(`current list ${failure} failure stays explicit`, async (t) => {
  const f = setup(t); await ready(f); const run = f.panel.loadTasks(); await settle();
  if (failure === "network") f.requests[0].reject(new TypeError("fixture network failed"));
  else reply(f.requests[0], { ok: false, code: failure === "api" ? "CONFLICT" : "UNAUTHORIZED", message: "fixture denied",
    details: { requestId: "fixture-request" } }, failure === "api" ? 409 : 401);
  await run; await settle();
  assert.notEqual(f.panel.panelError.value, ""); assert.equal(f.logs.length, 1); assert.equal(f.panel.loading.value, false);
  if (failure === "unauthorized") { assert.equal(f.config.sessionToken, null); assert.equal(f.requests.length, 1); }
});

for (const change of ["logout", "origin", "hide", "source", "unmount"] as const)
test(`${change} rejects the old account's late list`, async (t) => {
  const f = setup(t); await ready(f); const run = f.panel.loadTasks(); await settle(); const old = f.requests[0];
  if (change === "logout") f.config.expireCurrentSession();
  else if (change === "origin") f.config.serverWsOrigin = "wss://other.example";
  else if (change === "hide") f.props.active = false;
  else if (change === "source") f.props.source = "local";
  else f.unmount.forEach((callback) => callback());
  reply(old, { ok: true, items: [task("late-private")], total: 1 }); await run; await settle();
  assert.ok(f.panel.tasks.value.every((item: ScheduledTask) => item.id !== "late-private"));
  if (change === "logout") { assert.deepEqual(f.panel.tasks.value, []); assert.equal(f.requests.length, 1); }
  if (change === "origin") assert.equal(f.requests.filter((item) => item.url.host === "other.example").length, 2);
});

for (const operation of ["devices", "assets", "runs", "preview", "save", "run", "delete"] as const)
test(`current ${operation} HTTP 401 reports failure after its own session cleanup`, async (t) => {
  const f = setup(t); await ready(f); f.panel.formModalOpen.value = true;
  Object.assign(f.panel.form, task(), { description: "", scriptCommand: "echo fixture" });
  const run = operation === "devices" ? f.panel.loadDevices() : operation === "assets" ? f.panel.loadAssets()
    : operation === "runs" ? f.panel.openRunsDrawer(task()) : operation === "preview" ? f.panel.previewCron()
    : operation === "save" ? f.panel.saveTask() : operation === "run" ? f.panel.runTaskNow(task())
    : (f.panel.confirmDeleteTask(task()), f.confirmations[0].onOk());
  const finished = operation === "delete" ? assert.rejects(run) : run;
  await settle(); assert.equal(f.requests.length, 1);
  reply(f.requests[0], { ok: false, code: "UNAUTHORIZED", message: "fixture expired", details: { requestId: "fixture-request" } }, 401);
  await finished; await settle();
  assert.equal(f.config.sessionToken, null); assert.match(f.panel.panelError.value, /fixture expired/u);
  assert.equal(f.logs.length, 1); assert.equal(f.requests.length, 1); assert.deepEqual(f.toasts, []);
  assert.equal(f.panel.saving.value, false); assert.equal(f.panel.formModalOpen.value, false);
});

for (const editing of [false, true]) test(`current ${editing ? "edit" : "create"} saves and refreshes its own list`, async (t) => {
  const f = setup(t); await ready(f);
  Object.assign(f.panel.form, task(), { id: editing ? "task-A" : "", description: "", scriptCommand: "echo fixture" });
  f.panel.formModalOpen.value = true;
  const run = f.panel.saveTask(); await settle();
  const request = find(f.requests, "A", `/api/account/scheduled-tasks${editing ? "/task-A" : ""}`, "POST");
  assert.equal(JSON.parse(String(request.init.body)).payload.command, "echo fixture");
  reply(request, { ok: true, task: task("saved-A") }); await settle();
  reply(find(f.requests, "A", "/api/account/scheduled-tasks"), { ok: true, items: [task("saved-A")], total: 1 }); await run;
  assert.equal(f.panel.tasks.value[0].id, "saved-A"); assert.equal(f.panel.formModalOpen.value, false);
  assert.equal(f.panel.saving.value, false); assert.equal(f.toasts.length, 1); assert.deepEqual(f.logs, []);
});

test("current delete failure rejects confirmation and preserves task list", async (t) => {
  const f = setup(t); await ready(f); f.panel.confirmDeleteTask(task());
  const failed = assert.rejects(f.confirmations[0].onOk()); await settle();
  reply(find(f.requests, "A", "/api/account/scheduled-tasks/task-A", "DELETE"),
    { ok: false, code: "CONFLICT", message: "fixture conflict", details: { requestId: "fixture-request" } }, 409);
  await failed;
  assert.match(f.panel.panelError.value, /fixture conflict/u); assert.equal(f.panel.tasks.value[0].id, "task-A");
  assert.equal(f.requests.length, 1); assert.equal(f.logs.length, 1); assert.deepEqual(f.toasts, []);
});

for (const refresh of ["profile", "hello"] as const)
test(`same-account ${refresh} refresh keeps draft, tasks and delete confirmation`, async (t) => {
  const f = setup(t); await ready(f); f.panel.formModalOpen.value = true; f.panel.form.name = "draft A";
  f.panel.confirmDeleteTask(task());
  if (refresh === "profile") f.config.applyAccountProfile({ fullName: "revised A", email: "a@example.test", phone: "fixture", avatarUrl: null,
    accountRole: "personal_normal", accessContext: {} as any, enterpriseSummary: null });
  else f.config.applySessionFromHello({ authMode: "account", userSummary: { ...f.config.userSummary!, fullName: "revised A" } });
  assert.equal(f.panel.formModalOpen.value, true); assert.equal(f.panel.form.name, "draft A");
  assert.equal(f.panel.tasks.value[0].id, "task-A"); assert.equal(f.confirmations[0].destroyed, false);
  await settle(); assert.equal(f.requests.length, 0);
});

for (const operation of ["list", "save"] as const) for (const change of ["hide-return", "source-return", "unmount"] as const)
test(`own ${operation} 401 body delayed past ${change} cannot report into another panel view`, async (t) => {
  const f = setup(t); await ready(f);
  Object.assign(f.panel.form, task(), { description: "", scriptCommand: "echo fixture" }); f.panel.formModalOpen.value = true;
  const run = operation === "list" ? f.panel.loadTasks() : f.panel.saveTask(); await settle();
  let release!: (body: string) => void;
  // 真实 requestJson 先清认证再读正文，控制这两个阶段之间的视图切换。
  f.requests[0].resolve({ status: 401, text: () => new Promise<string>((resolve) => { release = resolve; }) } as Response);
  await settle(); assert.equal(f.config.sessionToken, null); assert.ok(release);
  if (change === "hide-return") { f.props.active = false; f.props.active = true; }
  else if (change === "source-return") { f.props.source = "local"; f.props.source = "account"; }
  else f.unmount.forEach((callback) => callback());
  release(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "old expired A" })); await run;
  assert.equal(f.panel.panelError.value, ""); assert.deepEqual(f.logs, []); assert.deepEqual(f.toasts, []);
});

test("current ensureSession expiry remains explicit without sending HTTP", async (t) => {
  const f = setup(t); await ready(f); f.config.sessionExpiresAt = 0;
  await f.panel.loadTasks(); await settle();
  assert.equal(f.config.sessionToken, null); assert.notEqual(f.panel.panelError.value, "");
  assert.equal(f.logs.length, 1); assert.equal(f.requests.length, 0);
});

test("local panel keeps its draft and in-flight list across cloud login changes with zero HTTP", async (t) => {
  const f = setup(t, "local");
  await settle(); f.panel.formModalOpen.value = true; f.panel.form.name = "local draft";
  login(f.config, "B"); await settle();
  f.localRequests[0].resolve({ status: 200, body: { ok: true, items: [task("local-task")], total: 1 } }); await settle();
  assert.equal(f.panel.form.name, "local draft"); assert.equal(f.panel.formModalOpen.value, true);
  assert.equal(f.panel.tasks.value[0].id, "local-task"); assert.equal(f.localRequests.length, 1); assert.equal(f.requests.length, 0);
});

for (const status of [409, 401]) test(`HTTP ${status} task failure logs safe correlation without response body`, async (t) => {
  const f = setup(t); await ready(f);
  Object.assign(f.panel.form, task(), { description: "", scriptCommand: "fixture-script-secret" }); f.panel.formModalOpen.value = true;
  const run = f.panel.saveTask(); await settle();
  reply(find(f.requests, "A", "/api/account/scheduled-tasks/task-A", "POST"), {
    ok: false, code: status === 401 ? "UNAUTHORIZED" : "CONFLICT", message: "session-A fixture-script-secret private-error-body",
    details: { requestId: "server-request-1", nested: { token: "private-nested-token" } },
  }, status); await run;
  const log = f.logs[0]?.[1] as Record<string, unknown>;
  assert.equal(f.logs.length, 1); assert.equal(log.requestId, "server-request-1"); assert.equal(log.taskId, "task-A");
  assert.equal(log.userId, "A"); assert.equal(log.operation, "save"); assert.equal(log.source, "account");
  assert.equal(log.code, status === 401 ? "UNAUTHORIZED" : "CONFLICT");
  assert.doesNotMatch(JSON.stringify(f.logs), /session-A|fixture-script-secret|private-error-body|private-nested-token/u);
  assert.notEqual(status === 401 ? f.panel.panelError.value : f.panel.formError.value, "");
  assert.equal(f.panel.saving.value, false); assert.deepEqual(f.toasts, []); assert.equal(f.requests.length, 1);
});

for (const field of ["requestId", "code", "taskId"] as const)
test(`original 401 credential in ${field} never enters task logs after session cleanup`, async (t) => {
  const f = setup(t); await ready(f);
  if (field === "code") { f.config.sessionToken = "SESSION_A"; await ready(f); }
  const id = field === "taskId" ? "session-A" : "task-A";
  Object.assign(f.panel.form, task(id), { description: "", scriptCommand: "echo fixture" }); f.panel.formModalOpen.value = true;
  const run = f.panel.saveTask(); await settle();
  reply(f.requests[0], { ok: false, code: field === "code" ? "SESSION_A" : "UNAUTHORIZED", message: "expired fixture",
    details: { requestId: field === "requestId" ? "session-A" : "server-request-1" } }, 401); await run;
  assert.equal(f.config.sessionToken, null); assert.equal(f.logs.length, 1);
  assert.doesNotMatch(JSON.stringify(f.logs), /session-A|SESSION_A/u);
  if (field === "taskId") assert.equal((f.logs[0][1] as Record<string, unknown>).taskId, null);
  if (field === "requestId") {
    const requestId = (f.logs[0][1] as Record<string, unknown>).requestId;
    assert.equal(typeof requestId, "string"); assert.notEqual(requestId, ""); assert.notEqual(requestId, "session-A");
  }
  if (field === "code") assert.equal((f.logs[0][1] as Record<string, unknown>).code, "SCHEDULED_TASK_UI_FAILED");
});

test("network failure has a searchable local request id and never logs raw cause", async (t) => {
  const f = setup(t); await ready(f); const run = f.panel.loadTasks(); await settle();
  f.requests[0].reject(new TypeError("private-network-body session-A")); await run;
  const log = f.logs[0]?.[1] as Record<string, unknown>;
  assert.equal(f.logs.length, 1); assert.equal(typeof log.requestId, "string"); assert.notEqual(log.requestId, "");
  assert.equal(log.userId, "A"); assert.equal(log.operation, "list"); assert.equal(log.cause, "网络请求或响应解析失败");
  assert.doesNotMatch(JSON.stringify(f.logs), /private-network-body|session-A/u); assert.notEqual(f.panel.panelError.value, "");
});

test("local task failure logs no preload body and keeps explicit UI failure", async (t) => {
  const f = setup(t, "local"); await settle();
  f.localRequests[0].resolve({ status: 409, body: { ok: false, code: "CONFLICT", message: "private-local-body local-secret",
    details: { requestId: "local-request-1", token: "private-token" } } }); await settle();
  assert.equal(f.logs.length, 1); assert.equal((f.logs[0][1] as Record<string, unknown>).requestId, "local-request-1");
  assert.equal((f.logs[0][1] as Record<string, unknown>).source, "local");
  assert.doesNotMatch(JSON.stringify(f.logs), /private-local-body|local-secret|private-token/u);
  assert.notEqual(f.panel.panelError.value, ""); assert.equal(f.requests.length, 0);
});

for (const requestId of ["fixture-script-secret", "Bearer private-token", "x".repeat(129), { token: "private-token" }])
test(`unsafe error correlation ${typeof requestId === "object" ? "object" : String(requestId).length} is replaced without hiding failure`, async (t) => {
  const f = setup(t); await ready(f);
  Object.assign(f.panel.form, task(), { description: "", scriptCommand: "fixture-script-secret" }); f.panel.formModalOpen.value = true;
  const run = f.panel.saveTask(); await settle();
  reply(f.requests[0], { ok: false, code: "CONFLICT", message: "fixture denied", details: { requestId } }, 401); await run;
  const log = f.logs[0]?.[1] as Record<string, unknown>;
  assert.equal(f.logs.length, 1); assert.equal(typeof log.requestId, "string"); assert.notEqual(log.requestId, "");
  assert.notDeepEqual(log.requestId, requestId); assert.doesNotMatch(JSON.stringify(f.logs), /fixture-script-secret|private-token/u);
  assert.notEqual(f.panel.panelError.value, ""); assert.deepEqual(f.toasts, []);
});

test("delete failure stays rejected while its diagnostic body is excluded", async (t) => {
  const f = setup(t); await ready(f); f.panel.confirmDeleteTask(task());
  const run = assert.rejects(f.confirmations[0].onOk()); await settle();
  reply(f.requests[0], { ok: false, code: "CONFLICT", message: "private-delete-body session-A", details: { requestId: "delete-request-1" } }, 409);
  await run;
  assert.equal(f.logs.length, 1); assert.equal((f.logs[0][1] as Record<string, unknown>).requestId, "delete-request-1");
  assert.equal((f.logs[0][1] as Record<string, unknown>).taskId, "task-A");
  assert.doesNotMatch(JSON.stringify(f.logs), /private-delete-body|session-A/u);
  assert.notEqual(f.panel.panelError.value, ""); assert.equal(f.requests.length, 1); assert.deepEqual(f.toasts, []);
});

test("normalized script remains excluded after its own 401 clears the form", async (t) => {
  const f = setup(t); await ready(f);
  Object.assign(f.panel.form, task(), { description: "", scriptCommand: "  private-trimmed-script  " }); f.panel.formModalOpen.value = true;
  const run = f.panel.saveTask(); await settle();
  assert.equal(JSON.parse(String(f.requests[0].init.body)).payload.command, "private-trimmed-script");
  reply(f.requests[0], { ok: false, code: "UNAUTHORIZED", message: "fixture denied", details: { requestId: "private-trimmed-script" } }, 401);
  await run;
  assert.equal(f.config.sessionToken, null); assert.equal(f.logs.length, 1);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-trimmed-script/u); assert.notEqual(f.panel.panelError.value, "");
});

test("local save excludes submitted script after the user edits the pending draft", async (t) => {
  const f = setup(t, "local"); await settle();
  f.localRequests[0].resolve({ status: 200, body: { ok: true, items: [], total: 0 } }); await settle();
  Object.assign(f.panel.form, { name: "local fixture", taskType: "script", description: "", scriptCommand: "  private-original-local  " });
  f.panel.formModalOpen.value = true;
  const run = f.panel.saveTask(); await settle(); const write = f.localRequests[1]; assert.ok(write);
  f.panel.form.scriptCommand = "new-local-draft";
  write.resolve({ status: 409, body: { ok: false, code: "CONFLICT", message: "fixture denied", details: { requestId: "private-original-local" } } });
  await run;
  assert.equal(f.logs.length, 1); assert.doesNotMatch(JSON.stringify(f.logs), /private-original-local/u);
  assert.notEqual(f.panel.formError.value, ""); assert.equal(f.requests.length, 0); assert.deepEqual(f.toasts, []);
});

for (const action of ["run", "delete", "runs"] as const)
test(`${action} excludes the target task's script when no form is open`, async (t) => {
  const f = setup(t); await ready(f); const target = task();
  target.payload = { shell: "powershell", command: "private-target-script" };
  const run = action === "run" ? f.panel.runTaskNow(target) : action === "runs" ? f.panel.openRunsDrawer(target)
    : (f.panel.confirmDeleteTask(target), assert.rejects(f.confirmations[0].onOk()));
  await settle(); reply(f.requests[0], { ok: false, code: "CONFLICT", message: "fixture denied", details: { requestId: "private-target-script" } }, 409);
  await run;
  assert.equal(f.logs.length, 1); assert.doesNotMatch(JSON.stringify(f.logs), /private-target-script/u);
  assert.notEqual(action === "runs" ? f.panel.runsError.value : f.panel.panelError.value, ""); assert.deepEqual(f.toasts, []);
});

test("late local toggle diagnostic cannot be attributed to the current cloud account", async (t) => {
  const f = setup(t, "local"); await settle();
  f.localRequests[0].resolve({ status: 200, body: { ok: true, items: [], total: 0 } }); await settle();
  const run = f.panel.setTaskEnabled({ ...task(), revision: 1 }, false); await settle(); const write = f.localRequests[1];
  f.props.source = "account"; login(f.config, "B"); await settle();
  write.resolve({ status: 409, body: { ok: false, code: "CONFLICT", message: "fixture denied", details: { requestId: "local-toggle-1" } } });
  await run;
  assert.equal(f.logs.length, 1); assert.equal((f.logs[0][1] as Record<string, unknown>).source, "local");
  assert.equal((f.logs[0][1] as Record<string, unknown>).userId, null); assert.equal(f.panel.panelError.value, "");
});

test("target task failure also excludes a cancelled form's original script after 401", async (t) => {
  const f = setup(t); await ready(f); const edited = task("task-B");
  edited.payload = { shell: "powershell", command: "  private-cancelled-draft  " };
  f.panel.openEditModal(edited); await settle();
  reply(f.requests[0], { ok: true, workspaces: [], workflows: [] }); await settle(); f.requests.length = 0;
  f.panel.formModalOpen.value = false; await settle();
  const target = task(); target.payload = { shell: "powershell", command: "private-target-A" };
  const run = f.panel.runTaskNow(target); await settle();
  reply(f.requests[0], { ok: false, code: "UNAUTHORIZED", message: "fixture denied", details: { requestId: "private-cancelled-draft" } }, 401);
  await run;
  assert.equal(f.config.sessionToken, null); assert.equal(f.logs.length, 1);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-cancelled-draft|private-target-A/u);
  assert.notEqual(f.panel.panelError.value, ""); assert.deepEqual(f.toasts, []);
});
