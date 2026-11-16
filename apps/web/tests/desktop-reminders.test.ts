import assert from "node:assert/strict";
import test from "node:test";
import { createPinia } from "pinia";
import { createWebSocketClient } from "../src/services/ws.ts";
import { useReminderStore } from "../src/store/reminders.ts";

test("local reminder changes refresh the real store offline and expose failures", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const workspaceId = "local-reminders:project", requests: string[] = [], errors: string[] = [], logs: unknown[][] = [];
  let fail = false;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout,
    codeflowDesktop: { getState: async () => ({}), request: async (request: { method: string }) => {
      requests.push(request.method);
      return fail ? { status: 503, body: { ok: false, code: "REMINDER_READ_FAILED", message: "本机读取失败", details: { requestId: "reminder-read" } } }
        : { status: 200, body: { ok: true, items: [], summary: { workspaceId, pendingActionCount: 0, pendingReceiptCount: 0, updatedAt: null } } };
    } } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("UNEXPECTED_SERVER_REQUEST"); });
  t.mock.method(console, "warn", (...values: unknown[]) => logs.push(values));
  const reminders = useReminderStore(createPinia());
  const config = { workspaceId, localRuntimeReady: true, desktopClient: { clientId: "local-reminders", workspaceIds: [workspaceId] }, setConnectionStatus() {} };
  const client = createWebSocketClient({ config, chat: { markWorkspaceSubscribed() {} }, presence: {}, engine: {}, reminders,
    onError: (error: string) => errors.push(error) } as any);
  client.replaceLocalWorkspaceSubscription(workspaceId as any);
  client.disconnect();
  client.receiveDesktopEvent({ t: "reminders.changed", workspaceId: "other:project" } as any);
  client.receiveDesktopEvent({ t: "reminders.changed", workspaceId } as any);
  client.receiveDesktopEvent({ t: "reminders.changed", workspaceId } as any);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.deepEqual(requests, ["reminders.items"]);
  assert.equal(reminders.currentWorkspaceId, workspaceId);
  fail = true;
  client.receiveDesktopEvent({ t: "reminders.changed", workspaceId } as any);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(reminders.lastError, "本机读取失败");
  assert.deepEqual(errors, ["提醒刷新失败：本机读取失败"]);
  assert.equal(logs.length, 1);
  assert.equal((logs[0]![1] as any).requestId, "reminder-read");
  fail = false;
  client.receiveDesktopEvent({ t: "reminders.changed", workspaceId } as any);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(reminders.lastError, null);
});

test("late local reminder failure cannot replace the next workspace error state", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  let rejectOld!: (error: Error) => void;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: { getState: async () => ({}),
    request: async (request: { body: { workspaceId: string } }) => request.body.workspaceId === "local:old"
      ? new Promise((_resolve, reject) => { rejectOld = reject; })
      : { status: 200, body: { ok: true, items: [], summary: { workspaceId: "local:new", pendingActionCount: 0, pendingReceiptCount: 0, updatedAt: null } } },
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  const store = useReminderStore(createPinia());
  const ctx = { desktopClientId: "local", serverWsOrigin: "", sessionToken: null, webSessionId: null };
  const older = store.refreshCurrentWorkspace(ctx, "local:old" as any);
  await store.refreshCurrentWorkspace(ctx, "local:new" as any);
  rejectOld(new Error("旧工作区读取失败"));
  await older;
  assert.equal(store.currentWorkspaceId, "local:new");
  assert.equal(store.lastError, null);
});
