import test from "node:test";
import assert from "node:assert/strict";
import type { DesktopAccountScheduledTaskConfig, DesktopAccountScheduledTaskListResponseBody, DesktopAccountScheduledTaskRun, DesktopApiRequest, DesktopApiResponse, DesktopBridgeApi, LocalScheduledTaskCreateRequestBody } from "@codeflowai/shared";
import { reactive } from "vue";
import * as api from "../src/api/scheduled-tasks/index.ts";

/** 仅模拟 preload 和 HTTP 边界，保留真实 wrapper 与序列化。 */
function boundary(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: DesktopApiRequest[] = [];
  const calls = { http: 0, session: 0 };
  const control: { response: DesktopApiResponse; failure?: Error } = { response: { status: 200, body: { ok: true } } };
  const urls: string[] = [];
  const bridge: DesktopBridgeApi = {
    getState: async () => ({ status: "ready", requestId: "test", releaseId: null, errorCode: null }),
    request: async (request) => {
      requests.push(structuredClone(request));
      if (control.failure) throw control.failure;
      return control.response;
    },
    openWindow: async () => {}, exit: async () => {}, onEvent: () => () => {},
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: bridge } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    calls.http++;
    urls.push(String(input));
    return new Response(JSON.stringify({ ok: true, items: [], total: 0 }), { status: 200 });
  });
  const ctx = { serverWsOrigin: "ws://server", sessionToken: "session", webSessionId: "web", desktopClientId: "local",
    ensureSession: async () => { calls.session++; return "session"; } };
  return { requests, calls, control, ctx, urls };
}

const body: LocalScheduledTaskCreateRequestBody = {
  name: "本机任务", description: null, taskType: "script", cronExpr: "0 9 * * *", timezone: "Asia/Shanghai",
  enabled: true, payload: { shell: "sh", command: "pwd", envRefs: ["HOME"] }, timeoutMs: 60_001,
  concurrencyPolicy: "queue_one", missedPolicy: "run_once_on_reconnect",
};

test("本机八个 wrapper 直接派发固定方法、CAS 和真实分页且零 HTTP", async (t) => {
  const h = boundary(t);
  await api.listLocalScheduledTasks({ limit: 7, offset: 14 });
  await api.createLocalScheduledTask(body);
  await api.updateLocalScheduledTask({ ...body, taskId: "id", expectedRevision: 4 });
  await api.setLocalScheduledTaskEnabled({ taskId: "id", expectedRevision: 4, enabled: false });
  await api.deleteLocalScheduledTask({ taskId: "id", expectedRevision: 4 });
  await api.runLocalScheduledTaskNow("id");
  await api.listLocalScheduledTaskRuns({ limit: 5, offset: 10 });
  await api.previewLocalScheduledTaskCron({ cronExpr: "0 9 * * *", count: 3 });
  assert.deepEqual(h.requests, [
    { method: "scheduledTasks.local.list", body: { limit: 7, offset: 14 } },
    { method: "scheduledTasks.local.create", body },
    { method: "scheduledTasks.local.update", body: { ...body, taskId: "id", expectedRevision: 4 } },
    { method: "scheduledTasks.local.setEnabled", body: { taskId: "id", expectedRevision: 4, enabled: false } },
    { method: "scheduledTasks.local.delete", body: { taskId: "id", expectedRevision: 4 } },
    { method: "scheduledTasks.local.runNow", body: { taskId: "id" } },
    { method: "scheduledTasks.local.runs", body: { limit: 5, offset: 10 } },
    { method: "scheduledTasks.local.cronPreview", body: { cronExpr: "0 9 * * *", count: 3 } },
  ]);
  assert.deepEqual(h.calls, { http: 0, session: 0 });
});

test("本机删除保留真实墓碑，冲突和缺桥显式失败且不回落 HTTP", async (t) => {
  const h = boundary(t);
  const tombstone = { ...body, id: "deleted", revision: 9, deletedAt: 123 };
  const response = { ok: true, deleted: true, task: tombstone };
  h.control.response = { status: 200, body: response };
  assert.strictEqual(await api.deleteLocalScheduledTask({ taskId: "deleted", expectedRevision: 8 }), response);
  const conflict = { ok: false, code: "CONFLICT", message: "修订冲突", details: { requestId: "conflict" } };
  h.control.response = { status: 409, body: conflict };
  assert.strictEqual(await api.updateLocalScheduledTask({ ...body, taskId: "id", expectedRevision: 4 }), conflict);
  Reflect.deleteProperty(window, "codeflowDesktop");
  await assert.rejects(api.listLocalScheduledTasks(), /DESKTOP_BRIDGE_REQUIRED/u);
  assert.deepEqual(h.calls, { http: 0, session: 0 });
});

test("账号列表仍走原 HTTP 入口并传递分页", async (t) => {
  const h = boundary(t);
  assert.deepEqual(await api.listScheduledTasks(h.ctx, { limit: 10, offset: 20 }), { ok: true, items: [], total: 0 });
  assert.deepEqual(h.requests, []);
  assert.equal(h.calls.http, 1);
  assert.equal(new URL(h.urls[0]!).search, '?limit=10&offset=20');
});

test("本机桥异常及畸形响应显式reject，失败不会继续HTTP", async (t) => {
  const h = boundary(t);
  const failure = new Error('DESKTOP_API_TIMEOUT');
  h.control.failure = failure;
  await assert.rejects(api.listLocalScheduledTasks(), error => error === failure);
  h.control.failure = undefined;
  for (const response of [{status:200,body:'invalid'}, {status:500,body:{ok:true}}]) {
    h.control.response = response;
    await assert.rejects(api.listLocalScheduledTasks(), /DESKTOP_API_RESPONSE_INVALID/u);
  }
  assert.deepEqual(h.calls, {http:0,session:0});
});

test("桌面账号六个入口沿preload保留修订、停止状态和本地历史，零HTTP", async (t) => {
  const h = boundary(t);
  const item: DesktopAccountScheduledTaskConfig = {
    task: { ...body, id: "account-task", ownerUserId: "owner", clientId: "desktop", deviceId: "device", deviceKind: "desktop", configRevision: 8,
      clientNameSnapshot: "桌面", deviceLabelSnapshot: null, nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: 100, createdAt: 1, updatedAt: 100 },
    localRevision: 12, pending: true, stopIntent: "disabled",
  };
  const run: DesktopAccountScheduledTaskRun = {
    id: "run", taskId: "deleted-task", clientId: "desktop", deviceId: "device", deviceKind: "desktop", workspaceId: null,
    workflowInstanceId: null, workflowNameSnapshot: null, workflowVersion: null, scheduledAt: 100, startedAt: 100, finishedAt: 120,
    status: "success", triggerSource: "manual", attempt: 1, durationMs: 20, summary: "完成", errorMessage: null, outputExcerpt: null,
    createdAt: 100, source: "account", taskNameSnapshot: "已删除任务",
  };
  const list = { ok: true, clientId: "desktop", deviceId: "device", items: [item] } satisfies { ok: true } & DesktopAccountScheduledTaskListResponseBody;
  h.control.response = { status: 200, body: list };
  assert.strictEqual(await api.listDesktopAccountScheduledTasks(), list);
  const synced = { ok: true, clientId: "desktop", deviceId: "device", items: [{ ...item, pending: false }] } satisfies { ok: true } & DesktopAccountScheduledTaskListResponseBody;
  h.control.response = { status: 200, body: synced };
  assert.strictEqual(await api.syncDesktopAccountScheduledTasks(), synced);
  const updated = { ok: true, item };
  h.control.response = { status: 200, body: updated };
  const edit = reactive({ taskId: "account-task", expectedLocalRevision: 11, config: { ...body, enabled: false } });
  assert.strictEqual(await api.updateDesktopAccountScheduledTask(edit), updated);
  edit.config.enabled = true;
  const deleted = { ok: true, deleted: true };
  h.control.response = { status: 200, body: deleted };
  assert.strictEqual(await api.deleteDesktopAccountScheduledTask({ taskId: "account-task", expectedLocalRevision: 12 }), deleted);
  const triggered = { ok: true, run: { ...run, taskId: "account-task", taskNameSnapshot: body.name } };
  h.control.response = { status: 200, body: triggered };
  assert.strictEqual(await api.runDesktopAccountScheduledTaskNow("account-task"), triggered);
  const history = { ok: true, items: [run], total: 24 };
  h.control.response = { status: 200, body: history };
  assert.strictEqual(await api.listDesktopAccountScheduledTaskRuns({ taskId: "deleted-task", limit: 7, offset: 14 }), history);
  await api.listDesktopAccountScheduledTaskRuns();
  assert.deepEqual(h.requests, [
    { method: "scheduledTasks.account.list", body: {} },
    { method: "scheduledTasks.account.sync", body: {} },
    { method: "scheduledTasks.account.update", body: { taskId: "account-task", expectedLocalRevision: 11, config: { ...body, enabled: false } } },
    { method: "scheduledTasks.account.delete", body: { taskId: "account-task", expectedLocalRevision: 12 } },
    { method: "scheduledTasks.account.runNow", body: { taskId: "account-task" } },
    { method: "scheduledTasks.account.runs", body: { taskId: "deleted-task", limit: 7, offset: 14 } },
    { method: "scheduledTasks.account.runs", body: {} },
  ]);
  assert.deepEqual(h.calls, { http: 0, session: 0 });
});

test("桌面账号失败不转HTTP、不重试、不伪成功", async (t) => {
  const h = boundary(t);
  const actions = [
    () => api.listDesktopAccountScheduledTasks(),
    () => api.syncDesktopAccountScheduledTasks(),
    () => api.updateDesktopAccountScheduledTask({ taskId: "task", expectedLocalRevision: 0, config: body }),
    () => api.deleteDesktopAccountScheduledTask({ taskId: "task", expectedLocalRevision: 0 }),
    () => api.runDesktopAccountScheduledTaskNow("task"),
    () => api.listDesktopAccountScheduledTaskRuns(),
  ];
  const conflict = { ok: false, code: "CONFLICT", message: "任务已变化", details: { requestId: "conflict" } };
  h.control.response = { status: 409, body: conflict };
  for (const action of actions) assert.strictEqual(await action(), conflict);
  const failure = new Error("DESKTOP_API_TIMEOUT");
  h.control.failure = failure;
  for (const action of actions) await assert.rejects(action(), error => error === failure);
  h.control.failure = undefined;
  for (const response of [{ status: 200, body: "invalid" }, { status: 500, body: { ok: true } }]) {
    h.control.response = response;
    for (const action of actions) await assert.rejects(action(), /DESKTOP_API_RESPONSE_INVALID/u);
  }
  assert.equal(h.requests.length, 24);
  Reflect.deleteProperty(window, "codeflowDesktop");
  for (const action of actions) await assert.rejects(action(), /DESKTOP_BRIDGE_REQUIRED/u);
  assert.equal(h.requests.length, 24);
  assert.deepEqual(h.calls, { http: 0, session: 0 });
});
