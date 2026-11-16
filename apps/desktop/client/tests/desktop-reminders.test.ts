import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { createDesktopLifecycle } from "../src/runtime/desktopLifecycle.ts";
import { createClientRuntime } from "../../src/clientRuntime.ts";

/** 仅提取 bootstrap 内两个闭包并编译真实实现；不复制业务 body，不启动完整 Client。 */
function reminderFlushFixture(input: { owner: boolean; hostScope: boolean; cloudAccepted?: boolean }) {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const sendStart = source.indexOf("  const sendToServer = ");
  const sendEnd = source.indexOf("  const takeApiResponseDispatch", sendStart);
  const flushStart = source.indexOf("  const flushReminderDirtyWorkspaces = ");
  const flushEnd = source.indexOf("  /**", flushStart + 10);
  assert.ok(sendStart >= 0 && sendEnd > sendStart && flushStart >= 0 && flushEnd > flushStart, "提醒真实闭包未定位");
  const compiled = ts.transpileModule(source.slice(sendStart, sendEnd) + source.slice(flushStart, flushEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const workspaceId = "local:project", localEvents: unknown[] = [], cloudMessages: unknown[] = [], disconnects: Error[] = [], logs: any[] = [], invalidLogs: any[] = [];
  const deliveryOrder: string[] = [];
  const pending = new Set([workspaceId]);
  const env = {
    sanitizeClientToServerMessage: (value: unknown) => value,
    keepFullEventOutput: false,
    config: { clientId: "local" },
    workspaces: new Map([[workspaceId, {}]]),
    desktopLifecycle: { publishEvent: (event: unknown) => { deliveryOrder.push("local"); localEvents.push(event); } },
    desktopHostScopes: input.hostScope ? [{ kind: "shared", clientId: "local", userId: "account-a", workspaceId, sharedWorkspaceId: "shared-project" }] : [],
    desktopCloudAccount: {
      getOwner: () => input.owner ? { ownerUserId: "account-a" } : null,
      send: (message: unknown) => {
        deliveryOrder.push("cloud");
        cloudMessages.push(message);
        return { accepted: input.cloudAccepted !== false, reason: input.cloudAccepted === false ? "cloud disconnected" : null };
      },
      disconnect: (error: Error) => { disconnects.push(error); },
    },
    pendingReminderDirtyWorkspaces: pending,
    reminderDirtyTimer: null,
    db: { writeWorkspaceLog: (_workspaceId: string, value: unknown) => { logs.push(value); } },
    logger: { error: (_tag: string, _message: string, detail: unknown) => { invalidLogs.push(detail); } },
  };
  const flush = new Function("env", `with (env) { ${compiled}; return flushReminderDirtyWorkspaces; }`)(env) as () => void;
  return { flush, pending, workspaceId, localEvents, cloudMessages, disconnects, logs, invalidLogs, deliveryOrder };
}

test("未登录本机提醒只发布一次本机事件，不调用云发送", () => {
  const f = reminderFlushFixture({ owner: false, hostScope: true });
  f.flush();
  assert.deepEqual(f.localEvents, [{ t: "reminders.changed", workspaceId: f.workspaceId }]);
  assert.deepEqual(f.cloudMessages, []);
  assert.deepEqual(f.disconnects, []);
  assert.equal(f.pending.size, 0);
});

test("已关联账号的个人本机提醒不因缺少共享 Host 范围断开账号", () => {
  const f = reminderFlushFixture({ owner: true, hostScope: false });
  f.flush();
  assert.equal(f.localEvents.length, 1);
  assert.deepEqual(f.cloudMessages, []);
  assert.deepEqual(f.disconnects, []);
  assert.deepEqual(f.logs, []);
  assert.equal(f.pending.size, 0);
});

test("匹配当前账号 Host 范围的提醒先发布本机再发送一次云端脏标记", () => {
  const f = reminderFlushFixture({ owner: true, hostScope: true });
  f.flush();
  assert.deepEqual(f.localEvents, [{ t: "reminders.changed", workspaceId: f.workspaceId }]);
  assert.deepEqual(f.cloudMessages, f.localEvents);
  assert.deepEqual(f.deliveryOrder, ["local", "cloud"]);
  assert.deepEqual(f.disconnects, []);
  assert.equal(f.pending.size, 0);
});

test("已授权提醒的云发送失败记录根因并断开云模块，本机事件保持一次", () => {
  const f = reminderFlushFixture({ owner: true, hostScope: true, cloudAccepted: false });
  f.flush();
  assert.equal(f.localEvents.length, 1);
  assert.equal(f.cloudMessages.length, 1);
  assert.equal(f.disconnects.length, 1);
  assert.equal(f.logs[0]?.data.code, "REMINDER_DIRTY_DISPATCH_REJECTED");
  assert.equal(f.logs[0]?.data.reason, "cloud disconnected");
  assert.equal(f.logs[0]?.data.workspaceId, f.workspaceId);
  assert.ok(f.logs[0]?.data.requestId);
  assert.equal(f.pending.size, 0);
});

test("失效工作区明确失败后正常目标仍送达，后续 flush 不被旧目标阻塞", () => {
  const f = reminderFlushFixture({ owner: false, hostScope: false });
  f.pending.clear();
  f.pending.add("local:removed");
  f.pending.add(f.workspaceId);
  assert.throws(() => f.flush(), error => error instanceof AggregateError
    && error.message === "DESKTOP_REMINDER_WORKSPACES_FAILED" && error.errors.length === 1);
  assert.deepEqual(f.localEvents, [{ t: "reminders.changed", workspaceId: f.workspaceId }]);
  assert.equal(f.invalidLogs[0]?.code, "DESKTOP_REMINDER_WORKSPACE_INVALID");
  assert.equal(f.invalidLogs[0]?.workspaceId, "local:removed");
  assert.ok(f.invalidLogs[0]?.requestId);
  assert.equal(f.pending.size, 0);
  f.pending.add(f.workspaceId);
  assert.doesNotThrow(() => f.flush());
  assert.equal(f.localEvents.length, 2);
  assert.equal(f.invalidLogs.length, 1);
});

test("reminder notification crosses Client lifecycle and shell without a cloud session", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-reminders-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), {
    /** 该用例只替换 OS 进程，保留真实 IPC 合同与接收校验。 */
    send(_message: unknown, callback: (error: Error | null) => void) { callback(null); return true; },
    kill() { return true; },
  });
  const runtime = createClientRuntime({ entry: "client-test.cjs", dataDir, spawn: () => {
    queueMicrotask(() => child.emit("spawn")); return child;
  } });
  await runtime.start();
  t.after(() => { child.emit("exit", 0, null); child.emit("close", 0, null); });
  const received: unknown[] = [];
  runtime.onEvent(event => received.push(event));
  const channel = Object.assign(new EventEmitter(), {
    /** 连接两个真实边界，以同步父进程接收替代系统 IPC。 */
    send(message: unknown, callback: (error: Error | null) => void) { child.emit("message", message); callback(null); },
  });
  const lifecycle = createDesktopLifecycle(channel, runtime.snapshot().requestId!, { abortStartup: () => assert.fail("unexpected startup timeout") });
  await lifecycle.ready(() => {}, () => ({ protocolVersion: 1, clientVersion: "1.0.0", database: "ready", dbSchemaVersion: 102 }));
  await runtime.waitReady();
  const event = { t: "reminders.changed" as const, workspaceId: "local:project" as any };
  lifecycle.publishEvent(event);
  assert.deepEqual(received, [event]);
  assert.equal(runtime.snapshot().status, "ready");
  assert.throws(() => lifecycle.publishEvent({ ...event, workspaceId: "" }), /DESKTOP_EVENT_INVALID/);
  assert.throws(() => lifecycle.publishEvent({ ...event, privateData: "invalid" } as any), /DESKTOP_EVENT_INVALID/);
  child.emit("message", { t: "desktop.event", requestId: runtime.snapshot().requestId, event: { ...event, privateData: "invalid" } });
  assert.equal(runtime.snapshot().status, "failed");
  assert.deepEqual(received, [event]);
});
