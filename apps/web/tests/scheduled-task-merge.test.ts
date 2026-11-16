import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import type { DesktopApiRequest, DesktopBridgeApi, LocalScheduledTaskConfig, ScheduledTask } from "@codeflowai/shared";
import { mergeLocalScheduledTasks } from "../src/features/settings/scheduledTaskMerge.ts";
import { useConfigStore } from "../src/store/config.ts";

const userSummary = { userId: "user-a", email: "test@example.test", fullName: "测试", phone: "", avatarUrl: null,
  accountRole: "personal_normal" as const, status: "active" as const, enterpriseId: null, enterpriseName: null };

const localTask = (id: string, name: string, revision: number): LocalScheduledTaskConfig => ({
  id, clientId: "client-a", deviceId: "device-a", name, description: null, taskType: "script",
  cronExpr: "0 9 * * *", timezone: "Asia/Shanghai", enabled: true,
  payload: { shell: "powershell", command: "echo hi" }, concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 600_000,
  source: "local", workspaceScope: null, revision, deletedAt: null, createdAt: 1, updatedAt: 1,
});

const accountTask = (id: string, name: string): ScheduledTask => ({
  id, ownerUserId: "user-a", clientId: "client-a", deviceId: "device-a", clientNameSnapshot: "本机", deviceLabelSnapshot: null,
  name, description: null, taskType: "script", cronExpr: "0 10 * * *", timezone: "Asia/Shanghai", enabled: true,
  payload: { shell: "powershell", command: "echo account" }, concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed",
  timeoutMs: 600_000, nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1,
});

/** 隔离任务归属记录，模拟本机任务所属账号。 */
function installStorage(t: test.TestContext): void {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  }, writable: true, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
}

/** 安装桌面桥，记录本机任务写入并返回账号快照。 */
function installBridge(t: test.TestContext, requests: DesktopApiRequest[], deleted: string[]): void {
  const bridge: DesktopBridgeApi = {
    getState: async () => ({ status: "ready", requestId: "runtime", releaseId: null, errorCode: null }),
    openWindow: async () => {}, exit: async () => {}, onEvent: () => () => {},
    request: async (request) => {
      requests.push(request);
      if (request.method === "scheduledTasks.local.list") return { status: 200, body: { ok: true, total: 2, items: [localTask("l1", "同名任务", 1), localTask("l2", "本机独有", 2)] } };
      if (request.method === "scheduledTasks.local.delete") {
        deleted.push(String((request.body as { taskId: string }).taskId));
        return { status: 200, body: { ok: true, deleted: true, task: localTask("l1", "同名任务", 1) } };
      }
      if (request.method === "scheduledTasks.account.sync") {
        return { status: 200, body: { ok: true, clientId: "client-a", deviceId: "device-a", items: [] } };
      }
      throw new Error(`unexpected desktop request ${request.method}`);
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { codeflowDesktop: bridge }, writable: true, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

test("登录后本机任务合并到账号当前设备，账号同名任务优先并清理本机副本", async (t) => {
  setActivePinia(createPinia());
  useConfigStore().$patch({
    authMode: "account", serverWsOrigin: "ws://localhost:39280", sessionToken: "test-session", sessionExpiresAt: Date.now() + 3_600_000,
    userSummary, desktopRuntime: { status: "ready", requestId: "runtime", releaseId: null, errorCode: null },
    desktopClient: { clientId: "client-a", deviceId: "device-a", version: "1.0.0", connectedAt: 1, workspaceIds: [] },
    desktopCloudAccount: { status: "linked", generation: 1, serverOrigin: "http://localhost:39280", userSummary, errorCode: null },
  });
  installStorage(t);
  const requests: DesktopApiRequest[] = [], deleted: string[] = [];
  installBridge(t, requests, deleted);
  const created: unknown[] = [];
  let listQuery = "";
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      created.push(body);
      return new Response(JSON.stringify({ ok: true, task: accountTask("a2", String(body.name)) }), { status: 200 });
    }
    listQuery = new URL(String(url)).search;
    return new Response(JSON.stringify({ ok: true, total: 1, items: [accountTask("a1", "同名任务")] }), { status: 200 });
  };
  const ctx = { serverWsOrigin: "ws://localhost:39280", sessionToken: "test-session", webSessionId: null, desktopClientId: "client-a" };

  const result = await mergeLocalScheduledTasks(ctx);

  assert.deepEqual(result, { merged: 1, skipped: 1 });
  assert.deepEqual(created, [{
    clientId: "client-a", deviceId: "device-a", name: "本机独有", description: null, taskType: "script",
    cronExpr: "0 9 * * *", timezone: "Asia/Shanghai", enabled: true, payload: { shell: "powershell", command: "echo hi" },
    concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 600_000,
  }]);
  assert.match(listQuery, /clientId=client-a/u);
  assert.match(listQuery, /deviceId=device-a/u);
  assert.deepEqual(deleted, ["l1", "l2"]);
  assert.equal(requests.some((request) => request.method === "scheduledTasks.account.sync"), true);
});
