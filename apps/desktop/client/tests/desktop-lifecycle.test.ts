import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

import * as desktopLifecycle from "../src/runtime/desktopLifecycle.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { CLIENT_DB_SCHEMA_VERSION } from "../src/db/migrateClientDb.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork, execFileSync, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { logger } from "../src/logger.js";
import type { DesktopStartupMode } from "@codeflowai/shared";
import type { DesktopStartupOperation } from "../src/runtime/desktopStartupRecovery.js";
import { openClientDb } from "../src/db/clientDb.js";
import { WorkspaceExecutionProfileRepo } from "../src/db/repos/workspaceExecutionProfileRepo.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import type { WorkspaceId } from "@codeflowai/shared";
import { ScheduledTaskConfigRepo } from "../src/db/repos/scheduledTaskConfigRepo.js";

const { createDesktopLifecycle } = desktopLifecycle;

for (const mode of ["success", "diagnostic", "delivery"] as const) test(`GITW real channel keeps read/log causes and diagnostic third cause ${mode}`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-runtime-causes-")), project = path.join(root, "project"); await fs.mkdir(project);
  execFileSync("git", ["init", "-q"], { cwd: project, windowsHide: true });
  const db = openClientDb({ dbPath: path.join(root, "client.db") }), workspaceId = "local-client:git" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "Git", path: project });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const logging = false, diagnostic = new Error("PRIVATE_DIAGNOSTIC"), delivery = new Error("DELIVERY_FAILED"), sent: any[] = [], logs: any[] = [];
  const writes = t.mock.method(db, "writeWorkspaceLog", () => { throw logging; });
  t.mock.method(logger, "error", (_tag: string, message: string, data: unknown) => { logs.push({ message, data }); if (message === "desktop API request failed" && mode === "diagnostic") throw diagnostic; });
  const channel = createChannel(); channel.send = (message: any, callback) => { sent.push(message); callback(message.id === "git-causes" && mode === "delivery" ? delivery : null); };
  const ctx = { db, clientId: "local-client", workspaces: new Map([[workspaceId, project]]), send() {} } as unknown as ApiHandlerContext;
  let original: unknown, stopped: unknown, shutdowns = 0;
  const lifecycle = createDesktopLifecycle(channel, "git-parent", { abortStartup() { assert.fail("unexpected abort"); } });
  await lifecycle.ready((_reason, error) => { stopped = error; shutdowns++; }, healthy, async (request, id) => {
    try { return await executeDesktopApiRequest(ctx, request, { requestId: id, clientVersion: "1.0.0", startedAt: Date.now() }); }
    catch (error) { original = error; throw error; }
  });
  channel.emit("message", { t: "desktop.api.req", requestId: "git-parent", id: "git-causes", request: { method: "git.status", body: { workspaceId, repositoryPath: "../outside" } } });
  for (let index = 0; !original && index < 100; index++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(setImmediate);
  assert.ok(original instanceof AggregateError); assert.equal((original as any).code, "GIT_READ_REQUEST_LOG_FAILED");
  assert.equal(original.errors[1], logging); assert.equal(original.cause, original.errors[0]); assert.equal(writes.mock.callCount(), 1);
  const data = logs.find(row => row.message === "desktop API request failed")!.data;
  assert.equal(data.requestId, "git-causes"); assert.equal(data.workspaceId, workspaceId); assert.equal(data.rootCause.errors[1].type, "boolean");
  assert.doesNotMatch(JSON.stringify([logs, sent]), /PRIVATE_|stack/);
  if (mode === "delivery") {
    assert.ok(stopped instanceof AggregateError); assert.equal(stopped.message, "GIT_READ_RESPONSE_FAILED");
    assert.equal(stopped.errors[0], original); assert.equal(stopped.errors[1], delivery); assert.equal(stopped.cause, original);
    assert.equal(sent.filter(row => row.id === "git-causes").length, 1); await assert.rejects(lifecycle.drainRequests(), error => error === stopped);
  } else if (mode === "diagnostic") {
    assert.ok(stopped instanceof AggregateError); assert.equal(stopped.message, "DESKTOP_GIT_READ_FAILURE_DIAGNOSTIC_FAILED");
    assert.equal(stopped.errors[0], original); assert.equal(stopped.errors[1], diagnostic); assert.equal(stopped.cause, original);
    assert.equal(sent.some(row => row.id === "git-causes"), false); await assert.rejects(lifecycle.drainRequests(), error => error === stopped);
  } else {
    assert.equal(sent.filter(row => row.id === "git-causes").length, 1); assert.equal(sent.find(row => row.id === "git-causes").response.status, 500);
    channel.emit("message", { t: "desktop.api.req", requestId: "git-parent", id: "git-next", request: { method: "runtime.info" } });
    await new Promise(setImmediate); assert.equal(sent.find(row => row.id === "git-next").response.status, 200); assert.equal(shutdowns, 0); await lifecycle.drainRequests();
  }
});

for (const diagnosticFails of [false, true]) test(`LSLOG 原 channel 消费请求双因与诊断第三因 ${diagnosticFails}`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scheduled-runtime-causes-")), project = path.join(root, "project"); await fs.mkdir(project);
  const db = openClientDb({ dbPath: path.join(root, "client.db") }), workspaceId = "local-client:scheduled" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "scheduled", path: project });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const business = Object.assign(new Error("PRIVATE_SCHEDULED_BODY_中文_🔒"), { code: "EIO" }), logging = false;
  const diagnostic = new Error("PRIVATE_DIAGNOSTIC_BODY"), logs: any[] = [], sent: any[] = [];
  let original: unknown, stopped: unknown, shutdowns = 0;
  t.mock.method(ScheduledTaskConfigRepo.prototype, "create", () => { throw business; });
  const writes = t.mock.method(db, "writeWorkspaceLog", () => { throw logging; });
  t.mock.method(logger, "error", (_tag: string, message: string, data: unknown) => {
    logs.push({ message, data }); if (message === "desktop API request failed" && diagnosticFails) throw diagnostic;
  });
  const channel = createChannel(); channel.send = (message, callback) => { sent.push(message); callback(null); };
  const ctx = { db, clientId: "local-client", deviceId: "local-device", localWorkspaceOnly: true,
    workspaces: new Map([[workspaceId, project]]), send() {} } as unknown as ApiHandlerContext;
  const lifecycle = createDesktopLifecycle(channel, "scheduled-parent", { abortStartup() { assert.fail("unexpected abort"); } });
  await lifecycle.ready((_reason, error) => { stopped = error; shutdowns++; }, healthy, async (request, id) => {
    try { return await executeDesktopApiRequest(ctx, request, { requestId: id, clientVersion: "1.0.0", startedAt: Date.now() }); }
    catch (error) { original = error; throw error; }
  });
  channel.emit("message", { t: "desktop.api.req", requestId: "scheduled-parent", id: "scheduled-causes", request: {
    method: "scheduledTasks.local.create", body: { name: "任务", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
      payload: { shell: "sh", command: "PRIVATE_COMMAND", contextWorkspaceId: workspaceId }, concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 1_000 } } });
  await new Promise(setImmediate);
  assert.ok(original instanceof AggregateError); assert.equal((original as AggregateError & { code: string }).code, "SCHEDULED_TASK_REQUEST_LOG_FAILED");
  assert.equal(original.errors[1], false); assert.equal(original.cause, original.errors[0]); assert.equal(writes.mock.calls.length, 1);
  const data = logs.find(log => log.message === "desktop API request failed")!.data;
  assert.equal(data.rootCause.errors[0].cause.systemCode, "EIO"); assert.equal(data.rootCause.errors[1].type, "boolean");
  assert.doesNotMatch(JSON.stringify([logs, sent]), /PRIVATE_|🔒|stack/);
  if (diagnosticFails) {
    assert.ok(stopped instanceof AggregateError); assert.equal(stopped.errors[0], original); assert.equal(stopped.errors[1], diagnostic); assert.equal(stopped.cause, original);
    assert.equal(sent.some(row => row.id === "scheduled-causes"), false);
  } else {
    assert.equal(sent.find(row => row.id === "scheduled-causes")?.response.status, 500);
    channel.emit("message", { t: "desktop.api.req", requestId: "scheduled-parent", id: "scheduled-next", request: { method: "runtime.info" } });
    await new Promise(setImmediate); assert.equal(sent.find(row => row.id === "scheduled-next")?.response.status, 200); assert.equal(shutdowns, 0);
  }
  if (diagnosticFails) await assert.rejects(lifecycle.drainRequests(), error => error === stopped);
  else await lifecycle.drainRequests();
});

test("Profile runtime keeps both safe causes through channel executor and central API", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "profile-runtime-")), project = path.join(root, "project"); await fs.mkdir(project);
  const db = openClientDb({ dbPath: path.join(root, "client.db") }), workspaceId = "local-client:profile" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "Profile", path: project });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const business = Object.assign(new Error("PRIVATE_PROFILE_BODY"), { code: "EIO" }), logging = Object.assign(new Error("API_SECRET"), { code: "ENOSPC" });
  t.mock.method(WorkspaceExecutionProfileRepo.prototype, "get", () => { throw business; });
  t.mock.method(db, "writeWorkspaceLog", () => { throw logging; });
  const logs = t.mock.method(logger, "error", (tag: string) => { if (tag === "workspace-profile") throw logging; }), channel = createChannel(), sent: any[] = []; let stopped = 0;
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const ctx = { db, clientId: "local-client", workspaces: new Map([[workspaceId, project]]), send() {} } as unknown as ApiHandlerContext;
  const lifecycle = createDesktopLifecycle(channel, "profile-parent", { abortStartup() { assert.fail("unexpected abort"); } });
  await lifecycle.ready(() => { stopped++; }, healthy, (request, id) => executeDesktopApiRequest(ctx, request, { requestId: id, clientVersion: "1.0.0", startedAt: Date.now() }));
  channel.emit("message", { t: "desktop.api.req", requestId: "profile-parent", id: "profile-double", request: { method: "workspaceExecutionProfile.get", body: { workspaceId } } });
  await new Promise(setImmediate);
  const response = sent.find(row => row.id === "profile-double")?.response;
  assert.equal(response?.status, 500); assert.equal(response.body.code, "DESKTOP_API_REQUEST_FAILED");
  const diagnostics = logs.mock.calls.filter(call => call.arguments[1] === "desktop API request failed"); assert.equal(diagnostics.length, 1);
  const data = diagnostics[0]!.arguments[2] as any;
  assert.equal(data.requestId, "profile-double"); assert.equal(data.parentRequestId, "profile-parent"); assert.equal(data.workspaceId, workspaceId);
  assert.ok(Array.isArray(data.rootCause.errors), "known Profile aggregate must retain both safe diagnostic causes");
  assert.equal(data.rootCause.errors[0].cause.code, "EIO"); assert.equal(data.rootCause.errors[1].code, "ENOSPC");
  assert.doesNotMatch(JSON.stringify([data, response]), /PRIVATE_|API_SECRET|stack/);
  assert.equal(logs.mock.calls.filter(call => call.arguments[1] === "workspace Profile request failed").length, 0);
  channel.emit("message", { t: "desktop.api.req", requestId: "profile-parent", id: "profile-next", request: { method: "runtime.info" } });
  await new Promise(setImmediate); assert.equal(sent.find(row => row.id === "profile-next")?.response.status, 200); assert.equal(stopped, 0);
  await lifecycle.drainRequests();
});

/** 原channel/ready接真实executor；仅注入仓储和W/诊断失败，捕获完整原聚合。 */
async function profileRuntimeFixture(t: test.TestContext, input: { business: unknown; logging: unknown; diagnostic?: { error: unknown }; method?: "get" | "update" | "status" }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "profile-runtime-causes-")), project = path.join(root, "project"); await fs.mkdir(project);
  const db = openClientDb({ dbPath: path.join(root, "client.db") }), workspaceId = "local-client:profile" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "Profile", path: project });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const method = input.method ?? "get", repository = method === "update" ? "upsert" : method === "status" ? "listStatuses" : "get";
  t.mock.method(WorkspaceExecutionProfileRepo.prototype, repository, () => { throw input.business; });
  const workspaceLogs = t.mock.method(db, "writeWorkspaceLog", () => { throw input.logging; });
  const logs = t.mock.method(logger, "error", (_tag: string, message: string) => { if (message === "desktop API request failed" && input.diagnostic) throw input.diagnostic.error; });
  const channel = createChannel(), sent: any[] = []; let stopped: Error | undefined, original: unknown, shutdowns = 0;
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const ctx = { db, clientId: "local-client", workspaces: new Map([[workspaceId, project]]), send() {} } as unknown as ApiHandlerContext;
  const lifecycle = createDesktopLifecycle(channel, "profile-parent", { abortStartup() { assert.fail("unexpected abort"); } });
  await lifecycle.ready((_reason, error) => { stopped = error; shutdowns++; }, healthy, async (request, id) => {
    try { return await executeDesktopApiRequest(ctx, request, { requestId: id, clientVersion: "1.0.0", startedAt: Date.now() }); }
    catch (error) { original = error; throw error; }
  });
  channel.emit("message", { t: "desktop.api.req", requestId: "profile-parent", id: "profile-causes", request: { method: `workspaceExecutionProfile.${method}`,
    body: { workspaceId, ...(method === "update" ? { profileText: "PRIVATE_PROFILE" } : {}) } } });
  await new Promise(setImmediate);
  return { lifecycle, logs, workspaceLogs, sent, original: () => original, stopped: () => stopped, shutdowns: () => shutdowns };
}

for (const [method, logging] of [["get", undefined], ["update", null], ["status", false], ["get", 0], ["get", ""]] as const) {
  test(`Profile runtime distinguishes safe falsy causes for ${method}: ${typeof logging}-${String(logging)}`, async t => {
    const f = await profileRuntimeFixture(t, { business: undefined, logging, method });
    const original = f.original(); assert.ok(original instanceof AggregateError);
    assert.equal(original.errors[0].cause, undefined); assert.equal(Object.hasOwn(original.errors[0], "cause"), true); assert.equal(original.errors[1], logging);
    const data = f.logs.mock.calls.find(call => call.arguments[1] === "desktop API request failed")!.arguments[2] as any;
    assert.deepEqual(data.rootCause.errors[0].cause, { type: "undefined" });
    assert.deepEqual(data.rootCause.errors[1], { type: logging === null ? "null" : typeof logging });
    assert.equal(f.workspaceLogs.mock.callCount(), 1); assert.equal(f.sent.at(-1).response.status, 500); assert.equal(f.shutdowns(), 0);
    await f.lifecycle.drainRequests();
  });
}

test("Profile runtime never executes arbitrary diagnostic getters and bounds circular causes", async t => {
  let getters = 0; const logging = new Error("API_SECRET");
  for (const key of ["name", "message", "code", "errno", "errcode"]) Object.defineProperty(logging, key, { configurable: true, get() { getters++; throw new Error("PRIVATE_GETTER"); } });
  Object.defineProperty(logging, "cause", { value: logging });
  const f = await profileRuntimeFixture(t, { business: {}, logging });
  const data = f.logs.mock.calls.find(call => call.arguments[1] === "desktop API request failed")!.arguments[2] as any;
  assert.equal(getters, 0); assert.deepEqual(data.rootCause.errors[0].cause, { type: "object" });
  assert.ok(data.rootCause.errors[1].cause.cause); assert.equal(Object.hasOwn(data.rootCause.errors[1].cause.cause, "cause"), false);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_|API_SECRET|stack/); assert.equal(f.shutdowns(), 0);
  await f.lifecycle.drainRequests();
});

test("Profile runtime treats arbitrary logging objects as opaque without reading accessors", async t => {
  let getters = 0;
  const logging = Object.defineProperty({}, "code", { get() { getters++; throw new Error("PRIVATE_OBJECT"); } });
  const f = await profileRuntimeFixture(t, { business: new Error("PRIVATE_BUSINESS"), logging });
  const data = f.logs.mock.calls.find(call => call.arguments[1] === "desktop API request failed")!.arguments[2] as any;
  assert.equal(getters, 0); assert.deepEqual(data.rootCause.errors[1], { type: "object" });
  assert.equal((f.original() as AggregateError).errors[1], logging); assert.equal(f.sent.at(-1).response.status, 500);
  await f.lifecycle.drainRequests();
});

test("Profile runtime diagnostic failure retains the exact aggregate and third cause before original shutdown", async t => {
  const business = new Error("PRIVATE_BUSINESS"), logging = new Error("PRIVATE_LOGGING"), diagnostic = new Error("PRIVATE_DIAGNOSTIC");
  const f = await profileRuntimeFixture(t, { business, logging, diagnostic: { error: diagnostic } });
  const original = f.original(); assert.ok(original instanceof AggregateError);
  assert.equal(original.errors[0].cause, business); assert.equal(original.errors[1], logging);
  const stopped = f.stopped(); assert.ok(stopped instanceof AggregateError);
  assert.deepEqual(stopped.errors, [original, diagnostic]); assert.equal(stopped.cause, original); assert.equal(f.shutdowns(), 1);
  assert.equal(f.sent.filter(row => row.t === "desktop.api.res").length, 0); assert.equal(f.workspaceLogs.mock.callCount(), 1);
  await assert.rejects(f.lifecycle.drainRequests(), error => error === stopped);
});

/** 提供固定健康回执，生命周期测试不依赖真实 Client 初始化。 */
function healthy() {
  return { protocolVersion: 1 as const, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" as const };
}

/** 创建只传送生命周期消息的父进程通道。 */
function createChannel(): EventEmitter & { send(message: unknown, callback: (error: Error | null) => void): void } {
  return Object.assign(new EventEmitter(), { send: (_message: unknown, callback: (error: Error | null) => void) => callback(null) });
}

test("本地事件恢复可发布且早到请求等待原恢复，业务恢复在其完成后登记", async () => {
  const channel = createChannel(), sent: any[] = [], calls: string[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "recover-parent", { abortStartup() { assert.fail("unexpected abort"); } });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = lifecycle.ready(() => {}, healthy, async () => {
    calls.push("api"); return { status: 200, body: { ok: true } };
  }, undefined, {
    async recoverLocalEvents() {
      calls.push("events"); lifecycle.publishEvent({ t: "reminders.changed", workspaceId: "workspace" }); await hold;
    },
    recover() { calls.push("business"); },
  });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["events"]);
  channel.emit("message", { t: "desktop.api.req", requestId: "recover-parent", id: "early", request: { method: "runtime.info" } });
  await new Promise(setImmediate);
  assert.equal(sent.some(message => message.t === "desktop.api.res" && message.id === "early"), false);
  release(); await ready; await new Promise(setImmediate);
  assert.deepEqual(calls, ["events", "business", "api"]);
  assert.equal(sent.find(message => message.id === "early").response.status, 200);
  await lifecycle.drainRequests();
});

test("desktop lifecycle publishes persisted orchestration records without canonical sequence", async () => {
  const channel = createChannel(), sent: unknown[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "desktop-request", { abortStartup: () => assert.fail("unexpected timeout") });
  await lifecycle.ready(() => {}, healthy);
  const event = { t: "orchestration.event" as const, workspaceId: "local:workspace" as any,
    event: { id: "event-1", instanceId: "instance" as any, nodeId: null, type: "orchestration.started", payloadJson: "{}", createdAt: 1 } };
  lifecycle.publishEvent(event);
  assert.deepEqual(sent[1], { t: "desktop.event", requestId: "desktop-request", event });
  assert.throws(() => lifecycle.publishEvent({ ...event, event: { ...event.event, id: "" } }), /DESKTOP_EVENT_INVALID/);
});

test("desktop lifecycle forwards key changes without credential fields", async () => {
  const channel = createChannel(), sent: unknown[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "keys-event", { abortStartup: () => assert.fail("unexpected abort") });
  await lifecycle.ready(() => {}, healthy);
  lifecycle.publishEvent({ t: "engineKeys.changed" });
  assert.deepEqual(sent[1], { t: "desktop.event", requestId: "keys-event", event: { t: "engineKeys.changed" } });
  assert.throws(() => lifecycle.publishEvent({ t: "engineKeys.changed", rawKey: "forbidden" } as any), /DESKTOP_EVENT_INVALID/u);
});

test("desktop IPC shutdown reuses Client cleanup once and validates the parent request", async () => {
  const channel = createChannel();
  const reasons: string[] = [];
  await createDesktopLifecycle(channel, "desktop-request", { abortStartup: () => assert.fail("unexpected timeout") }).ready((reason) => { reasons.push(reason); }, healthy);
  channel.emit("message", { t: "desktop.shutdown", requestId: "another-request" });
  assert.deepEqual(reasons, []);
  channel.emit("message", { t: "desktop.shutdown", requestId: "desktop-request" });
  channel.emit("message", { t: "desktop.shutdown", requestId: "desktop-request" });
  assert.deepEqual(reasons, ["desktop_exit"]);
});

test("losing the parent IPC connection requests the same Client cleanup", async () => {
  const channel = createChannel();
  const reasons: string[] = [];
  await createDesktopLifecycle(channel, "desktop-request", { abortStartup: () => assert.fail("unexpected timeout") }).ready((reason) => { reasons.push(reason); }, healthy);
  channel.emit("disconnect");
  assert.deepEqual(reasons, ["desktop_parent_disconnected"]);
});

test("a shutdown received during initialization is delivered without publishing readiness", async () => {
  const channel = createChannel();
  const sent: unknown[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "desktop-request", { abortStartup: () => assert.fail("unexpected timeout") });
  channel.emit("message", { t: "desktop.shutdown", requestId: "desktop-request" });
  const reasons: string[] = [];
  await lifecycle.ready((reason) => { reasons.push(reason); }, () => assert.fail("health must not run during shutdown"));
  assert.deepEqual(reasons, ["desktop_exit"]);
  assert.deepEqual(sent, []);
});

test("parent disconnect during blocked startup has a bounded failure boundary", async () => {
  const channel = createChannel();
  const reason = new Promise<string>((resolve) => {
    createDesktopLifecycle(channel, "desktop-request", { abortStartup: resolve, initializationStopTimeoutMs: 1 });
  });
  channel.emit("disconnect");
  const keepAlive = setTimeout(() => assert.fail("startup abort did not run"), 1000);
  try {
    assert.equal(await reason, "desktop_parent_disconnected");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("an already disconnected parent enters cleanup when initialization completes", async () => {
  const channel = Object.assign(createChannel(), { connected: false });
  const reasons: string[] = [];
  const lifecycle = createDesktopLifecycle(channel, "desktop-request", { abortStartup: () => assert.fail("unexpected timeout") });
  await lifecycle.ready((reason) => { reasons.push(reason); }, () => assert.fail("health must not run during shutdown"));
  assert.deepEqual(reasons, ["desktop_parent_disconnected"]);
});

test("a readiness delivery error requests cleanup before returning failure", async () => {
  const channel = createChannel();
  channel.send = (_message, callback) => callback(new Error("IPC closed"));
  const reasons: string[] = [];
  const lifecycle = createDesktopLifecycle(channel, "desktop-request", { abortStartup: () => assert.fail("unexpected timeout") });
  await assert.rejects(() => lifecycle.ready((reason) => { reasons.push(reason); }, healthy), /IPC closed/);
  assert.deepEqual(reasons, ["desktop_ready_failed"]);
});

test("readiness contains the actual runtime health", async () => {
  const channel = createChannel();
  const sent: unknown[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  await createDesktopLifecycle(channel, "request", { abortStartup: () => assert.fail("unexpected timeout") }).ready(() => {}, healthy);
  assert.deepEqual(sent, [{ t: "desktop.ready", requestId: "request", health: {
    protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready",
  } }]);
});

test("关闭先拒绝API并保留晚到终态发布，最终排空后禁止发布", async () => {
  const channel = createChannel(), sent: any[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "drain-events", { abortStartup: () => assert.fail("unexpected abort") });
  await lifecycle.ready(() => {}, healthy, async () => assert.fail("新API不能进入业务"));
  await lifecycle.drainRequests(1000, { keepEventPublishing: true });
  const terminal = { t: "conversation.event", event: { schema: 1, seq: 100, ts: 1, workspaceId: "workspace", threadId: "thread", engine: "codex", type: "turn.completed", payload: { turnId: "turn" } } } as any;
  lifecycle.publishEvent(terminal);
  channel.emit("message", { t: "desktop.api.req", requestId: "drain-events", id: "late-api", request: { method: "runtime.info" } });
  await lifecycle.drainRequests();
  assert.ok(sent.some(message => message.t === "desktop.event" && message.event.event?.type === "turn.completed"));
  assert.equal(sent.find(message => message.id === "late-api")?.response.status, 503);
  assert.throws(() => lifecycle.publishEvent(terminal), /DESKTOP_EVENT_NOT_READY/);
});

test("异步健康检查完成前不发布ready，期间关闭后不得迟到发布", async () => {
  for (const stopDuringRead of [false, true]) {
    const channel = createChannel(), sent: any[] = [];
    channel.send = (message, callback) => { sent.push(message); callback(null); };
    const lifecycle = createDesktopLifecycle(channel, "async-health", { abortStartup: () => assert.fail("unexpected timeout") });
    let release!: () => void, stopped = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = lifecycle.ready(() => { stopped++; }, async () => { await gate; return healthy(); });
    assert.equal(sent.length, 0, "健康Promise不是可发布的健康快照");
    if (stopDuringRead) channel.emit("message", { t: "desktop.shutdown", requestId: "async-health" });
    release(); await ready;
    assert.equal(stopped, Number(stopDuringRead));
    assert.equal(sent.filter(message => message.t === "desktop.ready").length, Number(!stopDuringRead));
    if (!stopDuringRead) assert.deepEqual(sent[0].health, healthy());
  }
});

test("failed database health cleans up before rejecting readiness without sending success", async () => {
  const channel = createChannel();
  let sent = false;
  let cleaned = false;
  channel.send = (_message, callback) => { sent = true; callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "request", { abortStartup: () => assert.fail("unexpected timeout") });
  await assert.rejects(() => lifecycle.ready(async (_reason, error) => {
    assert.match(error?.message ?? "", /database closed/);
    await Promise.resolve();
    cleaned = true;
  }, () => { throw new Error("database closed"); }), /database closed/);
  assert.equal(sent, false);
  assert.equal(cleaned, true);
});

test("desktop health queries SQLite and checks its actual schema version", () => {
  const db = openSqliteDb(":memory:");
  try {
    db.pragma(`user_version = ${CLIENT_DB_SCHEMA_VERSION}`);
    assert.deepEqual(desktopLifecycle.readDesktopClientHealth(db, "1.0.0"), {
      protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: CLIENT_DB_SCHEMA_VERSION, database: "ready",
    });
    db.pragma("user_version = 1");
    assert.throws(() => desktopLifecycle.readDesktopClientHealth(db, "1.0.0"), /DESKTOP_DB_SCHEMA_MISMATCH/);
    db.pragma(`user_version = ${CLIENT_DB_SCHEMA_VERSION}`);
    assert.throws(() => desktopLifecycle.readDesktopClientHealth(db, null), /DESKTOP_CLIENT_VERSION_REQUIRED/);
    db.close();
    assert.throws(() => desktopLifecycle.readDesktopClientHealth(db, "1.0.0"));
  } finally {
    db.close();
  }
});

test("desktop target schema is checked against compiled Client before opening the database", () => {
  desktopLifecycle.assertDesktopDbSchemaVersion(undefined);
  desktopLifecycle.assertDesktopDbSchemaVersion(String(CLIENT_DB_SCHEMA_VERSION));
  for (const version of ["", "invalid", "1", String(CLIENT_DB_SCHEMA_VERSION + 1)]) {
    assert.throws(() => desktopLifecycle.assertDesktopDbSchemaVersion(version), /DESKTOP_DB_SCHEMA_INCOMPATIBLE/);
  }
});

test("health and shutdown failures both remain observable", async () => {
  const channel = createChannel();
  const lifecycle = createDesktopLifecycle(channel, "request", { abortStartup: () => assert.fail("unexpected timeout") });
  const healthError = new Error("database failed");
  const shutdownError = new Error("cleanup failed");
  await assert.rejects(() => lifecycle.ready(() => { throw shutdownError; }, () => { throw healthError; }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [healthError, shutdownError]);
    return true;
  });
});

test("real Client rejects incompatible target schema before reading config or creating a database", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-preflight-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, "client.db");
  const forkOptions = {
    execArgv: ["--conditions=development", "--import", "tsx"],
    env: { ...process.env, CODEFLOWAI_DESKTOP_REQUEST_ID: "preflight-request", CODEFLOWAI_DESKTOP_DB_SCHEMA_VERSION: "1",
      CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(directory, "missing-config.json"), CODEFLOWAI_CLIENT_DB_PATH: dbPath,
      CODEFLOWAI_CLIENT_LOG_DIR: path.join(directory, "logs") },
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  } satisfies ForkOptions & { windowsHide: boolean };
  const child = fork(fileURLToPath(new URL("../src/index.ts", import.meta.url)), ["--foreground"], forkOptions);
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdout!.resume();
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Client preflight did not exit")); }, 10_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); resolve(code); });
  });
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /DESKTOP_DB_SCHEMA_INCOMPATIBLE/);
  await assert.rejects(() => fs.access(dbPath), { code: "ENOENT" });
});

test("desktop API rejects wrong parents, startup and shutdown before entering the handler", async () => {
  const channel = createChannel();
  const sent: any[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  const request = { t: "desktop.api.req", requestId: "parent", id: "api-id", request: { method: "runtime.info" } };
  channel.emit("message", request);
  await new Promise(setImmediate);
  assert.equal(sent.at(-1)?.response.status, 503);
  let handled = 0;
  await lifecycle.ready(() => {}, healthy, async () => { handled += 1; return { status: 200, body: { ok: true } }; });
  channel.emit("message", { ...request, requestId: "wrong-parent" });
  await new Promise(setImmediate);
  assert.equal(sent.at(-1)?.response.status, 403);
  assert.equal(handled, 0);
  channel.emit("message", request);
  await new Promise(setImmediate);
  assert.deepEqual(sent.at(-1), { t: "desktop.api.res", requestId: "parent", id: "api-id", response: { status: 200, body: { ok: true } } });
  assert.equal(handled, 1);
  channel.emit("message", { t: "desktop.shutdown", requestId: "parent" });
  channel.emit("message", request);
  await new Promise(setImmediate);
  assert.equal(sent.at(-1)?.response.status, 503);
  assert.equal(handled, 1);
});

test("desktop API handler exceptions return explicit failure and keep later requests usable", async () => {
  const channel = createChannel();
  const sent: any[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  let handled = 0;
  await createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") }).ready(() => assert.fail("request failure must remain isolated"), healthy, async (_request, id) => {
    assert.equal(id, "api-id");
    if (handled++ === 0) throw new Error("test database failure");
    return { status: 200, body: { ok: true } };
  });
  const request = { t: "desktop.api.req", requestId: "parent", id: "api-id", request: { method: "runtime.info" } };
  channel.emit("message", request);
  await new Promise(setImmediate);
  assert.equal(sent.at(-1)?.response.status, 500);
  assert.equal(sent.at(-1)?.response.body.ok, false);
  channel.emit("message", request);
  await new Promise(setImmediate);
  assert.equal(sent.at(-1)?.response.status, 200);
});

test("desktop shutdown drains accepted API work while refusing new requests", async () => {
  const channel = createChannel();
  const sent: any[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  let release!: () => void;
  const running = new Promise<void>((resolve) => { release = resolve; });
  let closed = false;
  await lifecycle.ready(async () => { await lifecycle.drainRequests(); closed = true; }, healthy, async () => { await running; return { status: 200, body: { ok: true } }; });
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "accepted", request: { method: "runtime.info" } });
  channel.emit("message", { t: "desktop.shutdown", requestId: "parent" });
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "refused", request: { method: "runtime.info" } });
  await new Promise(setImmediate);
  assert.equal(closed, false);
  assert.equal(sent.find((message) => message.id === "refused")?.response.status, 503);
  release();
  await new Promise(setImmediate);
  assert.equal(closed, true);
  assert.equal(sent.find((message) => message.id === "accepted")?.response.status, 200);
});

test("desktop API stays unavailable until readiness has actually been delivered", async () => {
  const channel = createChannel();
  const sent: any[] = [];
  let deliverReady!: () => void;
  channel.send = (message: any, callback) => {
    sent.push(message);
    if (message.t === "desktop.ready") deliverReady = () => callback(null);
    else callback(null);
  };
  let handled = false;
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  const ready = lifecycle.ready(() => {}, healthy, async () => { handled = true; return { status: 200, body: {} }; });
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "too-early", request: { method: "runtime.info" } });
  await new Promise(setImmediate);
  assert.equal(sent.find(message => message.t === "desktop.api.res" && message.id === "too-early")?.response.status, 503);
  assert.equal(handled, false);
  deliverReady();
  await ready;
});

test("desktop API response delivery failure requests one cleanup without waiting for itself", async () => {
  const channel = createChannel();
  channel.send = (message: any, callback) => callback(message.t === "desktop.api.res" ? new Error("IPC send failed") : null);
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  const reasons: string[] = [];
  await lifecycle.ready(async (reason, error) => {
    reasons.push(reason);
    assert.match(error?.message ?? "", /IPC send failed/);
    await assert.rejects(() => lifecycle.drainRequests(), /IPC send failed/);
  }, healthy, async () => ({ status: 200, body: { ok: true } }));
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "delivery-failure", request: { method: "runtime.info" } });
  await new Promise(setImmediate);
  assert.deepEqual(reasons, ["desktop_api_delivery_failed"]);
});

test("desktop API drain timeout fails explicitly and leaves new requests refused", async () => {
  const channel = createChannel();
  const sent: any[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  let release!: () => void;
  const running = new Promise<void>((resolve) => { release = resolve; });
  let handled = 0;
  await lifecycle.ready(() => {}, healthy, async () => { handled += 1; await running; return { status: 200, body: {} }; });
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "pending", request: { method: "runtime.info" } });
  await assert.rejects(() => lifecycle.drainRequests(1), /DESKTOP_API_DRAIN_TIMEOUT/);
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "late", request: { method: "runtime.info" } });
  await new Promise(setImmediate);
  assert.equal(handled, 1);
  assert.equal(sent.find((message) => message.id === "pending"), undefined);
  assert.equal(sent.find((message) => message.id === "late")?.response.status, 503);
  release();
  await lifecycle.drainRequests();
});

test("desktop API missing correlation returns a failure without executing business logic", async () => {
  const channel = createChannel();
  const sent: any[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  let handled = false;
  await createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") }).ready(() => {}, healthy, async () => {
    handled = true;
    return { status: 200, body: {} };
  });
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", request: { method: "runtime.info" } });
  await new Promise(setImmediate);
  assert.equal(sent.at(-1)?.response.status, 400);
  assert.equal(handled, false);
});

test("desktop committed event publishing requires readiness and drain waits for IPC acceptance", async () => {
  const channel = createChannel();
  const sent: unknown[] = [];
  let deliver!: () => void;
  channel.send = (message: any, callback) => {
    sent.push(message);
    if (message.t === "desktop.event") deliver = () => callback(null);
    else callback(null);
  };
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  const event = { t: "conversation.event" as const, event: { schema: 1 as const, seq: 10, ts: 1000,
    workspaceId: "client:workspace" as any, threadId: "thread-1" as any, engine: "codex" as const, type: "thread.started" as const, payload: {} } };
  assert.throws(() => lifecycle.publishEvent(event), /DESKTOP_EVENT_NOT_READY/);
  await lifecycle.ready(() => {}, healthy);
  assert.throws(() => lifecycle.publishEvent({ t: "raw.event", event: event.event } as any), /DESKTOP_EVENT_INVALID/);
  lifecycle.publishEvent(event);
  assert.deepEqual(sent.at(-1), { t: "desktop.event", requestId: "parent", event });
  let drained = false;
  const draining = lifecycle.drainRequests().then(() => { drained = true; });
  await new Promise(setImmediate);
  assert.equal(drained, false);
  deliver();
  await draining;
  assert.equal(drained, true);
  assert.throws(() => lifecycle.publishEvent(event), /DESKTOP_EVENT_NOT_READY/);
});

test("desktop committed event send failure reaches the existing cleanup boundary", async () => {
  const channel = createChannel();
  channel.send = (message: any, callback) => callback(message.t === "desktop.event" ? new Error("event IPC failed") : null);
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  const reasons: string[] = [];
  await lifecycle.ready(async (reason, error) => {
    reasons.push(reason);
    assert.match(error?.message ?? "", /event IPC failed/);
    await assert.rejects(() => lifecycle.drainRequests(), /event IPC failed/);
  }, healthy);
  lifecycle.publishEvent({ t: "conversation.event", event: { schema: 1, seq: 11, ts: 1000, workspaceId: "client:workspace" as any,
    threadId: "thread-1" as any, engine: "codex", type: "thread.started", payload: {} } });
  await new Promise(setImmediate);
  assert.deepEqual(reasons, ["desktop_event_delivery_failed"]);
  assert.throws(() => lifecycle.publishEvent({} as any), /DESKTOP_EVENT_NOT_READY/);
});

test("drain includes canonical delivery produced by an already accepted API", async () => {
  const channel = createChannel();
  let deliverEvent!: () => void;
  channel.send = (message: any, callback) => {
    if (message.t === "desktop.event") deliverEvent = () => callback(null);
    else callback(null);
  };
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  let releaseApi!: () => void;
  const work = new Promise<void>((resolve) => { releaseApi = resolve; });
  await lifecycle.ready(() => {}, healthy, async () => {
    await work;
    lifecycle.publishEvent({ t: "conversation.event", event: { schema: 1, seq: 11, ts: 1000, workspaceId: "client:workspace" as any,
      threadId: "thread-1" as any, engine: "codex", type: "thread.started", payload: {} } });
    return { status: 200, body: { ok: true } };
  });
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "event-producing-api", request: { method: "runtime.info" } });
  let finished = false;
  const draining = lifecycle.drainRequests().then(() => { finished = true; });
  releaseApi();
  await new Promise(setImmediate);
  assert.equal(finished, false, "the accepted API finished but its committed event is still in flight");
  deliverEvent();
  await draining;
  assert.equal(finished, true);
});

test("event delivery failure during shutdown rejects the active drain and cleanup runs once", async () => {
  const channel = createChannel();
  const failure = new Error("event IPC failed during shutdown");
  channel.send = (message: any, callback) => callback(message.t === "desktop.event" ? failure : null);
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  let releaseApi!: () => void;
  const gate = new Promise<void>((resolve) => { releaseApi = resolve; });
  let cleanupCalls = 0;
  let drainFailure: unknown;
  let drainSucceeded = false;
  await lifecycle.ready(async (reason, error) => {
    cleanupCalls += 1;
    assert.equal(reason, "desktop_exit");
    assert.equal(error, undefined, "cleanup started before the delivery failed");
    try { await lifecycle.drainRequests(); drainSucceeded = true; }
    catch (error) { drainFailure = error; }
  }, healthy, async () => {
    await gate;
    lifecycle.publishEvent({ t: "conversation.event", event: { schema: 1, seq: 12, ts: 1000, workspaceId: "client:workspace" as any,
      threadId: "thread-1" as any, engine: "codex", type: "thread.started", payload: {} } });
    return { status: 200, body: { ok: true } };
  });
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "shutdown-event-api", request: { method: "runtime.info" } });
  channel.emit("message", { t: "desktop.shutdown", requestId: "parent" });
  releaseApi();
  await new Promise(setImmediate);
  assert.equal(cleanupCalls, 1);
  assert.equal(drainSucceeded, false);
  assert.equal(drainFailure, failure, "the original failure must reach the nonzero exit boundary");
  await assert.rejects(() => lifecycle.drainRequests(), (error) => error === failure);
});

test("queue change uses the existing desktop event channel and participates in drain", async () => {
  const channel = createChannel();
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  await lifecycle.ready(() => {}, healthy);
  lifecycle.publishEvent({ t: "thread.queue.changed", workspaceId: "client:workspace" as any, threadId: "thread" as any, reason: "paused" });
  await lifecycle.drainRequests();
  assert.throws(() => lifecycle.publishEvent({ t: "thread.queue.changed", workspaceId: "client:workspace" as any, threadId: "thread" as any, reason: "paused" }), /DESKTOP_EVENT_NOT_READY/);
});

/** 仅替代父 IPC 通道，更新钩子与生命周期仍走真实请求分发。 */
async function createUpdateFixture(hooks?: {
  prepare(): Promise<{ hasRunningSessions: boolean }>;
  interrupt(): Promise<void>;
  resume(): Promise<void>;
}) {
  const channel = createChannel();
  const sent: any[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "update-parent", { abortStartup: () => assert.fail("unexpected abort") });
  const business: string[] = [];
  await lifecycle.ready(() => assert.fail("update failure must not shut down Client"), healthy, async (request) => {
    business.push(request.method);
    return { status: 200, body: { ok: true } };
  }, hooks);
  /** 发出真实父请求并等到本次响应，不用调用私有控制方法。 */
  const request = async (method: string, id = method, parent = "update-parent", extra = {}) => {
    channel.emit("message", { t: "desktop.api.req", requestId: parent, id, request: { method, ...extra } });
    await new Promise(setImmediate);
    return sent.find((message) => message.id === id)?.response;
  };
  return { lifecycle, channel, sent, business, request };
}

test("update control rejects foreign parents and missing hooks without entering business logic", async () => {
  let called = 0;
  const hooks = { prepare: async () => { called++; return { hasRunningSessions: false }; }, interrupt: async () => {}, resume: async () => {} };
  const f = await createUpdateFixture(hooks);
  assert.equal((await f.request("runtime.update.prepare", "foreign", "other-parent")).status, 403);
  assert.equal(called, 0);
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), false);
  const unavailable = await createUpdateFixture();
  for (const method of ["runtime.update.prepare", "runtime.update.cancel", "runtime.update.interrupt"]) {
    const response = await unavailable.request(method);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "DESKTOP_UPDATE_CONTROL_UNAVAILABLE");
  }
  assert.deepEqual(f.business, []);
  assert.deepEqual(unavailable.business, []);
  assert.equal(unavailable.lifecycle.isTaskAdmissionPaused(), false);
});

test("update prepare freezes synchronously while approvals and committed events stay available", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await createUpdateFixture({ prepare: async () => { await gate; return { hasRunningSessions: true }; }, interrupt: async () => {}, resume: async () => {} });
  f.channel.emit("message", { t: "desktop.api.req", requestId: "update-parent", id: "prepare", request: { method: "runtime.update.prepare" } });
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), true, "freeze happens before the first awaited activity read");
  assert.equal(f.sent.find(message => message.id === "prepare"), undefined);
  assert.equal((await f.request("approvals.respond")).status, 200);
  f.lifecycle.publishEvent({ t: "thread.queue.changed", workspaceId: "workspace" as any, threadId: "thread" as any, reason: "paused" });
  assert.equal(f.sent.at(-1).t, "desktop.event");
  release();
  await new Promise(setImmediate);
  assert.deepEqual(f.sent.find(message => message.id === "prepare").response, { status: 200, body: { ok: true, hasRunningSessions: true } });
  assert.deepEqual(f.business, ["approvals.respond"]);
});

test("update cancel reopens admission for the original resume hook and is idempotent", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let resumed = 0;
  const f = await createUpdateFixture({ prepare: async () => ({ hasRunningSessions: false }), interrupt: async () => { }, resume: async () => {
    resumed++;
    assert.equal(f.lifecycle.isTaskAdmissionPaused(), false, "the original resume entry must be able to dispatch");
    await gate;
  } });
  assert.deepEqual((await f.request("runtime.update.prepare")).body, { ok: true, hasRunningSessions: false });
  const cancelling = f.request("runtime.update.cancel");
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), false);
  assert.equal(resumed, 1);
  release();
  assert.deepEqual(await cancelling, { status: 200, body: { ok: true } });
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), false);
  assert.deepEqual(await f.request("runtime.update.cancel", "cancel-again"), { status: 200, body: { ok: true } });
  assert.equal(resumed, 1, "an already restored control is idempotent");
});

test("update interrupt requires preparation and preserves the paused state after success", async () => {
  let interrupted = 0;
  const f = await createUpdateFixture({ prepare: async () => ({ hasRunningSessions: true }), interrupt: async () => { interrupted++; }, resume: async () => {} });
  const early = await f.request("runtime.update.interrupt", "early");
  assert.equal(early.status, 409);
  assert.equal(early.body.code, "DESKTOP_UPDATE_NOT_PREPARED");
  assert.equal(interrupted, 0);
  await f.request("runtime.update.prepare");
  assert.deepEqual(await f.request("runtime.update.interrupt"), { status: 200, body: { ok: true } });
  assert.equal(interrupted, 1);
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), true);
});

test("update control rejects overlapping operations and drains accepted control work", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let interrupted = 0, resumed = 0;
  const f = await createUpdateFixture({ prepare: async () => { await gate; return { hasRunningSessions: true }; }, interrupt: async () => { interrupted++; }, resume: async () => { resumed++; } });
  f.channel.emit("message", { t: "desktop.api.req", requestId: "update-parent", id: "pending", request: { method: "runtime.update.prepare" } });
  for (const method of ["runtime.update.prepare", "runtime.update.interrupt"]) {
    const response = await f.request(method, `overlap:${method}`);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "DESKTOP_UPDATE_CONTROL_IN_PROGRESS");
  }
  assert.equal(interrupted, 0);
  assert.equal(resumed, 0);
  let drained = false;
  const draining = f.lifecycle.drainRequests().then(() => { drained = true; });
  await new Promise(setImmediate);
  assert.equal(drained, false);
  release();
  await draining;
  assert.equal(f.sent.find(message => message.id === "pending").response.status, 200);
});

for (const method of ["runtime.update.prepare", "runtime.update.interrupt"] as const) test(`cancel waits for the current ${method} owner and restores admission`, async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  let activeSignal: AbortSignal | undefined;
  /** 模拟已发出的资源动作；取消只能等待它结算，不能伪装完成。 */
  const work = async (control?: { signal: AbortSignal }) => {
    activeSignal = control?.signal;
    calls.push("current");
    await pending;
    control?.signal.throwIfAborted();
    calls.push("next");
  };
  const f = await createUpdateFixture({
    prepare: async (control?: { signal: AbortSignal }) => { if (method === "runtime.update.prepare") await work(control); return { hasRunningSessions: true }; },
    interrupt: work,
    resume: async () => { calls.push("resume"); },
  });
  if (method === "runtime.update.interrupt") await f.request("runtime.update.prepare", "initial-prepare");
  assert.equal(await f.request(method, "pending-control"), undefined);
  assert.deepEqual(calls, ["current"]);
  assert.equal(await f.request("runtime.update.cancel", "cancel-after-timeout"), undefined);
  assert.equal(activeSignal?.aborted, true);
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), true);
  release();
  for (let index = 0; index < 10 && !f.sent.some(message => message.id === "cancel-after-timeout"); index++) await new Promise(setImmediate);
  assert.equal(f.sent.find(message => message.id === "pending-control").response.status, 500);
  assert.equal(f.sent.find(message => message.id === "cancel-after-timeout").response.status, 200);
  assert.deepEqual(calls, ["current", "resume"]);
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), false);
});

test("update hooks receive the exact control request and cancellation signal", async () => {
  const contexts: any[] = [];
  const f = await createUpdateFixture({
    prepare: async (control?: unknown) => { contexts.push(control); return { hasRunningSessions: false }; },
    interrupt: async (control?: unknown) => { contexts.push(control); }, resume: async () => {},
  });
  await f.request("runtime.update.prepare", "precise-prepare");
  await f.request("runtime.update.interrupt", "precise-interrupt");
  assert.deepEqual(contexts.map(control => control?.requestId), ["precise-prepare", "precise-interrupt"]);
  assert.ok(contexts.every(control => control.signal instanceof AbortSignal && !control.signal.aborted));
});

test("update hook failures remain explicit and restore the closed admission after resume failure", async () => {
  for (const failureStage of ["prepare", "interrupt", "resume"] as const) {
    let fail = true;
    const f = await createUpdateFixture({
      prepare: async () => { if (failureStage === "prepare" && fail) throw new Error("activity read failed"); return { hasRunningSessions: true }; },
      interrupt: async () => { if (failureStage === "interrupt" && fail) throw new Error("turn interrupt failed"); },
      resume: async () => { if (failureStage === "resume" && fail) throw new Error("scheduler resume failed"); },
    });
    const prepare = await f.request("runtime.update.prepare");
    const response = failureStage === "prepare" ? prepare : await f.request(failureStage === "interrupt" ? "runtime.update.interrupt" : "runtime.update.cancel");
    assert.equal(response.status, 500);
    assert.equal(response.body.code, "DESKTOP_UPDATE_CONTROL_FAILED");
    assert.equal(response.body.message, "更新控制失败，请重试并查看诊断");
    assert.equal(f.lifecycle.isTaskAdmissionPaused(), true);
    fail = false;
    assert.equal((await f.request("runtime.update.cancel", "recover")).status, 200);
    assert.equal(f.lifecycle.isTaskAdmissionPaused(), false);
    assert.equal((await f.request("runtime.info")).status, 200);
    assert.deepEqual(f.business, ["runtime.info"]);
  }
});

test("update preparation freezes immediately then waits for previously accepted short API work", async () => {
  const channel = createChannel(), sent: any[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  let release!: () => void;
  const accepted = new Promise<void>(resolve => { release = resolve; });
  let activityReads = 0;
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  await lifecycle.ready(() => {}, healthy, async () => { await accepted; return { status: 200, body: { ok: true } }; }, {
    prepare: async () => { activityReads++; return { hasRunningSessions: true }; }, interrupt: async () => {}, resume: async () => {},
  });
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "accepted", request: { method: "threads.sendMessage" } });
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "prepare", request: { method: "runtime.update.prepare" } });
  assert.equal(lifecycle.isTaskAdmissionPaused(), true);
  await new Promise(setImmediate);
  assert.equal(activityReads, 0, "activity must include side effects of previously accepted asynchronous APIs");
  assert.equal(sent.find(message => message.id === "prepare"), undefined);
  release();
  await new Promise(setImmediate);
  assert.equal(activityReads, 1);
  assert.deepEqual(sent.filter(message => message.t === "desktop.api.res").map(message => message.id), ["accepted", "prepare"]);
});

test("local runNow is excluded only from the short update barrier while shutdown waits for completion and delivery", async () => {
  const channel = createChannel(), sent: any[] = [];
  let releaseRun!: () => void, acceptResponse!: () => void;
  const run = new Promise<void>(resolve => { releaseRun = resolve; });
  channel.send = (message: any, callback) => {
    sent.push(message);
    if (message.id === "run") acceptResponse = () => callback(null); else callback(null);
  };
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  await lifecycle.ready(async () => { await lifecycle.drainRequests(); }, healthy, async () => {
    await run; return { status: 200, body: { ok: true } };
  }, { prepare: async () => ({ hasRunningSessions: true }), interrupt: async () => {}, resume: async () => {} });
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "run", request: { method: "scheduledTasks.local.runNow" } });
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "prepare", request: { method: "runtime.update.prepare" } });
  try {
    await new Promise(setImmediate);
    assert.deepEqual(sent.find(message => message.id === "prepare")?.response.body, { ok: true, hasRunningSessions: true });
    let drained = false;
    const draining = lifecycle.drainRequests().then(() => { drained = true; });
    await new Promise(setImmediate); assert.equal(drained, false);
    releaseRun(); await new Promise(setImmediate); assert.equal(drained, false);
    acceptResponse(); await draining; assert.equal(drained, true);
  } finally {
    releaseRun(); await new Promise(setImmediate); acceptResponse?.(); await lifecycle.drainRequests();
  }
});

test("local runNow response delivery failure closes once and rejects the global drain", async t => {
  const channel = createChannel();
  let release!: () => void, closed = 0;
  const run = new Promise<void>(resolve => { release = resolve; });
  const failure = new Error("local run IPC failure");
  channel.send = (message: any, callback) => callback(message.id === "run" ? failure : null);
  t.mock.method(logger, "error", () => {});
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  await lifecycle.ready(() => { closed++; }, healthy, async () => { await run; return { status: 200, body: { ok: true } }; });
  channel.emit("message", { t: "desktop.api.req", requestId: "parent", id: "run", request: { method: "scheduledTasks.local.runNow" } });
  channel.emit("disconnect"); release(); await new Promise(setImmediate);
  assert.equal(closed, 1);
  await assert.rejects(() => lifecycle.drainRequests(), error => error === failure);
  channel.emit("disconnect"); assert.equal(closed, 1);
});

test("update control rejects unexpected payloads and malformed activity without false idle success", async () => {
  let prepared = 0;
  const f = await createUpdateFixture({ prepare: async () => { prepared++; return { hasRunningSessions: "false" as any }; }, interrupt: async () => {}, resume: async () => {} });
  for (const extra of [{ body: {} }, { extra: true }]) {
    const response = await f.request("runtime.update.prepare", `invalid:${prepared}:${JSON.stringify(extra)}`, "update-parent", extra);
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "DESKTOP_UPDATE_CONTROL_INVALID");
  }
  assert.equal(prepared, 0);
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), false);
  const response = await f.request("runtime.update.prepare");
  assert.equal(response.status, 500);
  assert.equal(response.body.message, "更新控制失败，请重试并查看诊断");
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), true);
});

test("update control obeys delivered readiness and shutdown even without a business handler", async () => {
  const channel = createChannel(), sent: any[] = [];
  let deliverReady!: () => void;
  channel.send = (message: any, callback) => {
    sent.push(message);
    if (message.t === "desktop.ready") deliverReady = () => callback(null);
    else callback(null);
  };
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  const request = { t: "desktop.api.req", requestId: "parent", id: "startup", request: { method: "runtime.update.prepare" } };
  channel.emit("message", request);
  await new Promise(setImmediate);
  assert.equal(sent.find(message => message.id === "startup").response.status, 503);
  let called = 0;
  const ready = lifecycle.ready(() => {}, healthy, undefined, { prepare: async () => { called++; return { hasRunningSessions: false }; }, interrupt: async () => {}, resume: async () => {} });
  channel.emit("message", { ...request, id: "undelivered" });
  await new Promise(setImmediate);
  assert.equal(sent.find(message => message.id === "undelivered").response.status, 503);
  assert.equal(called, 0);
  deliverReady();
  await ready;
  channel.emit("message", { ...request, id: "ready" });
  await new Promise(setImmediate);
  assert.equal(sent.find(message => message.id === "ready").response.status, 200);
  assert.equal(called, 1);
  channel.emit("message", { t: "desktop.shutdown", requestId: "parent" });
  channel.emit("message", { ...request, id: "stopped" });
  await new Promise(setImmediate);
  assert.equal(sent.find(message => message.id === "stopped").response.status, 503);
  assert.equal(called, 1);
});

test("update hook errors log once with request and operation context", async (t) => {
  const logged = t.mock.method(logger, "error", () => {});
  const f = await createUpdateFixture({ prepare: async () => { throw new Error("activity database unavailable"); }, interrupt: async () => {}, resume: async () => {} });
  const response = await f.request("runtime.update.prepare", "failing-update-request");
  assert.equal(response.status, 500);
  assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual(logged.mock.calls[0].arguments, ["desktop-api", "desktop API request failed", {
    code: "DESKTOP_UPDATE_CONTROL_FAILED", requestId: "failing-update-request", parentRequestId: "update-parent",
    method: "runtime.update.prepare", workspaceId: null, status: 500, rootCause: { type: "Error", fingerprint: createHash("sha256").update("activity database unavailable").digest("hex") },
  }]);
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), true);
});

test("update arbitrary error text stays out of responses and diagnostic logs", async t => {
  const logged = t.mock.method(logger, "error", () => {});
  const f = await createUpdateFixture({ prepare: async () => { throw new Error("API_KEY_TEST_SENTINEL"); }, interrupt: async () => {}, resume: async () => {} });
  const response = await f.request("runtime.update.prepare", "secret-error");
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify([response, logged.mock.calls]).includes("API_KEY_TEST_SENTINEL"), false);
  const context = logged.mock.calls[0].arguments[2] as { rootCause: { fingerprint: string } };
  assert.match(context.rootCause.fingerprint, /^[a-f0-9]{64}$/);
});

for (const signal of ["shutdown", "disconnect"] as const) test(`waiting update cancellation never resumes scheduling after ${signal}`, async () => {
  const channel = createChannel(), sent: any[] = [], calls: string[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "parent", { abortStartup: () => assert.fail("unexpected abort") });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await lifecycle.ready(() => { calls.push("shutdown"); }, healthy, undefined, {
    prepare: async () => ({ hasRunningSessions: true }),
    interrupt: async () => { calls.push("interrupt"); await pending; },
    resume: async () => { calls.push("resume"); },
  });
  const request = (method: string, id: string) => channel.emit("message", { t: "desktop.api.req", requestId: "parent", id, request: { method } });
  request("runtime.update.prepare", "prepare");
  await new Promise(setImmediate);
  request("runtime.update.interrupt", "interrupt");
  await new Promise(setImmediate);
  request("runtime.update.cancel", "cancel");
  await new Promise(setImmediate);
  if (signal === "shutdown") channel.emit("message", { t: "desktop.shutdown", requestId: "parent" });
  else channel.emit("disconnect");
  release();
  await lifecycle.drainRequests();
  assert.deepEqual(calls, ["interrupt", "shutdown"]);
  assert.equal(lifecycle.isTaskAdmissionPaused(), true);
  assert.equal(sent.find(message => message.id === "cancel")?.response.status, 503);
});

/** 真实lifecycle与受控IPC验证首次接续，恢复入口不复制另一套状态。 */
async function startupFixture(input: { mode?: "automatic" | "held"; recover?: (operation: DesktopStartupOperation) => void; holdResponse?: boolean } = {}) {
  const channel = createChannel(), sent: any[] = [], calls: string[] = [], deliveries: Array<() => void> = [];
  channel.send = (message: any, callback) => {
    sent.push(message);
    if (input.holdResponse && message.t === "desktop.api.res" && message.id.startsWith("continue")) deliveries.push(() => callback(null));
    else callback(null);
  };
  const startup: DesktopStartupMode = input.mode === "automatic" ? { mode: "automatic" } : { mode: "held", continuationId: "candidate-continue-1" };
  const lifecycle = createDesktopLifecycle(channel, "startup-parent", { startup, abortStartup: () => assert.fail("unexpected abort") });
  let shutdownError: Error | undefined;
  await lifecycle.ready(async (_reason: string, error?: Error) => {
    shutdownError = error;
    calls.push("shutdown");
    await lifecycle.drainRequests(100);
    calls.push("cleaned");
  }, healthy, async () => ({ status: 200, body: { ok: true } }), {
    prepare: async () => { calls.push("prepare"); return { hasRunningSessions: false }; },
    interrupt: async () => { calls.push("interrupt"); }, resume: async () => { calls.push("resume"); },
  }, { recover(operation) { calls.push("recover"); input.recover?.(operation); } });
  /** 父请求使用独立id，正文continuationId固定本次启动归属。 */
  const request = async (method: string, id: string, body?: unknown) => {
    channel.emit("message", { t: "desktop.api.req", requestId: "startup-parent", id, request: { method, ...(body !== undefined ? { body } : {}) } });
    await new Promise(setImmediate);
    return sent.find(message => message.id === id)?.response;
  };
  return { channel, sent, calls, deliveries, lifecycle, request, shutdownError: () => shutdownError };
}

test("held lifecycle starts paused and publishes matching paused readiness without recovery", async () => {
  const f = await startupFixture();
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), true);
  assert.deepEqual(f.sent[0].startup, { continuationId: "candidate-continue-1", admission: "paused" });
  assert.deepEqual(f.calls, []);
});

test("held startup continuation recovers exactly once and rejects a different identity", async () => {
  const f = await startupFixture();
  assert.equal((await f.request("runtime.startup.continue", "continue-1", { continuationId: "candidate-continue-1" })).status, 200);
  assert.equal((await f.request("runtime.startup.continue", "continue-2", { continuationId: "candidate-continue-1" })).status, 200);
  assert.equal((await f.request("runtime.startup.continue", "continue-other", { continuationId: "other" })).status, 409);
  assert.deepEqual(f.calls, ["recover"]);
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), false);
});

test("held startup cannot be opened through reversible update controls", async () => {
  const f = await startupFixture();
  for (const method of ["runtime.update.prepare", "runtime.update.cancel", "runtime.update.interrupt"]) {
    assert.equal((await f.request(method, method)).status, 409);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), true);
});

test("startup continuation rejects extra or accessor input without executing recovery", async () => {
  const f = await startupFixture(); let getters = 0;
  for (const body of [{ continuationId: "candidate-continue-1", extra: true }, Object.defineProperty({}, "continuationId", {
    enumerable: true, get() { getters++; return "candidate-continue-1"; },
  })]) assert.equal((await f.request("runtime.startup.continue", `bad-${getters}-${f.sent.length}`, body)).status, 400);
  assert.equal(getters, 0); assert.deepEqual(f.calls, []);
});

for (const kind of ["string", "number", "boolean", "null", "body-accessor", "workspace-accessor", "workspace-data"] as const) {
  test(`invalid startup ${kind} keeps its 400 without reading accessors or closing the runtime`, async t => {
    const warnings = t.mock.method(logger, "warn", () => {}), errors = t.mock.method(logger, "error", () => {});
    const f = await startupFixture(); let getters = 0;
    const request: Record<string, unknown> = { method: "runtime.startup.continue" };
    if (kind === "body-accessor") Object.defineProperty(request, "body", { enumerable: true, get() { getters++; throw new Error("PRIVATE_BODY_SENTINEL"); } });
    else if (kind === "workspace-accessor") request.body = Object.defineProperty({ continuationId: "candidate-continue-1" }, "workspaceId", {
      enumerable: true, get() { getters++; throw new Error("PRIVATE_WORKSPACE_SENTINEL"); },
    });
    else request.body = kind === "string" ? "PRIVATE_BODY_SENTINEL" : kind === "number" ? 7 : kind === "boolean" ? true : kind === "null" ? null
      : { continuationId: "candidate-continue-1", workspaceId: "PRIVATE_WORKSPACE_SENTINEL" };
    f.channel.emit("message", { t: "desktop.api.req", requestId: "startup-parent", id: "invalid-startup", request });
    await new Promise(setImmediate);
    assert.equal(f.sent.find(message => message.id === "invalid-startup")?.response.status, 400);
    assert.equal(getters, 0); assert.equal(f.lifecycle.isTaskAdmissionPaused(), true); assert.deepEqual(f.calls, []);
    assert.equal(errors.mock.callCount(), 0); assert.equal(warnings.mock.callCount(), 1);
    assert.equal((warnings.mock.calls[0]!.arguments[2] as { workspaceId: unknown }).workspaceId, null);
    assert.equal(JSON.stringify(warnings.mock.calls).includes("PRIVATE_"), false);
    const continued = await f.request("runtime.startup.continue", "continue-after-invalid", { continuationId: "candidate-continue-1" });
    assert.equal(continued.status, 200); assert.deepEqual(f.calls, ["recover"]); assert.equal(f.lifecycle.isTaskAdmissionPaused(), false);
  });
}

test("automatic readiness uses the same first recovery without waiting for long business work", async () => {
  const f = await startupFixture({ mode: "automatic" });
  assert.deepEqual(f.calls, ["recover"]);
  assert.equal(Object.hasOwn(f.sent[0], "startup"), false);
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), false);
});

test("failed first recovery freezes immediately and closes only after its response leaves requests", async t => {
  t.mock.method(logger, "error", () => {});
  const cause = Object.assign(new Error("private-startup-body"), { code: "EIO" });
  const f = await startupFixture({ holdResponse: true, recover() { throw cause; } });
  const response = await f.request("runtime.startup.continue", "continue-fail", { continuationId: "candidate-continue-1" });
  assert.equal(response.status, 500); assert.equal(f.lifecycle.isTaskAdmissionPaused(), true);
  assert.deepEqual(f.calls, ["recover"]);
  f.deliveries[0]!(); await new Promise(setImmediate);
  assert.deepEqual(f.calls, ["recover", "shutdown", "cleaned"]);
  assert.equal(f.shutdownError()?.cause, cause);
});

test("late first recovery failure freezes and cleans up without treating business error as IPC damage", async t => {
  t.mock.method(logger, "error", () => {});
  let fail!: DesktopStartupOperation["fail"];
  const f = await startupFixture({ recover(operation) { fail = operation.fail; } });
  await f.request("runtime.startup.continue", "continue-first", { continuationId: "candidate-continue-1" });
  const cause = new Error("late orchestration entry failure");
  fail(cause, "orchestration"); await new Promise(setImmediate);
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), true);
  assert.deepEqual(f.calls, ["recover", "shutdown", "cleaned"]);
  assert.equal(f.shutdownError()?.cause, cause);
});

test("a recovery hook that reports failure synchronously cannot return a successful continuation", async t => {
  t.mock.method(logger, "error", () => {});
  const f = await startupFixture({ recover(operation) { operation.fail(undefined, "scheduled_tasks"); } });
  const response = await f.request("runtime.startup.continue", "continue-sync-failure", { continuationId: "candidate-continue-1" });
  assert.equal(response.status, 500);
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), true);
  assert.deepEqual(f.calls, ["recover", "shutdown", "cleaned"]);
  assert.equal(Object.hasOwn(f.shutdownError()!, "cause"), true);
  assert.equal(f.shutdownError()?.cause, undefined);
});

for (const logFailure of [false, true]) test(`startup failure and failed response retain both causes after requests are removed: ${logFailure}`, async t => {
  const logCause = new Error("delivery log unavailable");
  t.mock.method(logger, "error", (_tag: string, message: string) => { if (logFailure && message === "desktop IPC delivery failed") throw logCause; });
  const channel = createChannel(), cause = new Error("first recovery failed"), deliveryCause = new Error("IPC response failed");
  let observed: Error | undefined;
  let cleaned = false;
  const lifecycle = createDesktopLifecycle(channel, "startup-parent", { startup: { mode: "held", continuationId: "candidate-continue-1" }, abortStartup() {} });
  channel.send = (message: any, callback) => callback(message.t === "desktop.api.res" ? deliveryCause : null);
  await lifecycle.ready(async (_reason: string, error?: Error) => {
    observed = error;
    await assert.rejects(lifecycle.drainRequests(), error => error instanceof AggregateError);
    cleaned = true;
  }, healthy, undefined, undefined, { recover() { throw cause; } });
  channel.emit("message", { t: "desktop.api.req", requestId: "startup-parent", id: "continue-failed-response",
    request: { method: "runtime.startup.continue", body: { continuationId: "candidate-continue-1" } } });
  await new Promise(setImmediate);
  assert.equal(cleaned, true);
  const values: unknown[] = [];
  /** 主错及投递副错必须保留原对象身份，不能以日志代替。 */
  const collect = (error: unknown): void => { values.push(error); if (error instanceof AggregateError) error.errors.forEach(collect); if (error instanceof Error && Object.hasOwn(error, "cause")) collect(error.cause); };
  collect(observed);
  assert.ok(values.includes(cause)); assert.ok(values.includes(deliveryCause));
  if (logFailure) assert.ok(values.includes(logCause));
});

test("startup input snapshots data descriptors and rejects additional or accessor fields", async () => {
  let gets = 0;
  for (const startup of [{ mode: "held", continuationId: "candidate", extra: true },
    Object.defineProperty({ mode: "held" }, "continuationId", { enumerable: true, get() { gets++; return "candidate"; } })]) {
    assert.throws(() => createDesktopLifecycle(createChannel(), "parent", { startup: startup as never, abortStartup() {} }), /DESKTOP_STARTUP_INPUT_INVALID/u);
  }
  assert.equal(gets, 0);
});

test("startup abort caused by an already reported failure keeps one primary cause and one log", async t => {
  const logged = t.mock.method(logger, "error", () => {}), cause = new Error("entry failed");
  const f = await startupFixture({ recover(operation) { operation.fail(cause, "scheduled_tasks"); operation.signal.throwIfAborted(); } });
  assert.equal((await f.request("runtime.startup.continue", "continue-fail-once", { continuationId: "candidate-continue-1" })).status, 500);
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(f.shutdownError()?.cause, cause);
});

test("startup logging failure remains a secondary cause and still closes without unhandled rejection", async t => {
  const cause = new Error("entry failure"), logCause = new Error("log unavailable");
  t.mock.method(logger, "error", () => { throw logCause; });
  let fail!: DesktopStartupOperation["fail"];
  const f = await startupFixture({ recover(operation) { fail = operation.fail; } });
  await f.request("runtime.startup.continue", "continue-late-log", { continuationId: "candidate-continue-1" });
  assert.doesNotThrow(() => fail(cause, "orchestration"));
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, ["recover", "shutdown", "cleaned"]);
  assert.ok(f.shutdownError() instanceof AggregateError);
  assert.ok((f.shutdownError() as AggregateError).errors.some(error => error === logCause));
});

test("startup failure keeps its shutdown error identity as later entry failures arrive", async t => {
  const logged = t.mock.method(logger, "error", () => {}), cause = new Error("first entry"), second = new Error("second entry");
  let fail!: DesktopStartupOperation["fail"];
  const f = await startupFixture({ recover(operation) { fail = operation.fail; } });
  await f.request("runtime.startup.continue", "continue-two-failures", { continuationId: "candidate-continue-1" });
  fail(cause, "scheduled_tasks"); const observed = f.shutdownError();
  fail(second, "orchestration");
  assert.equal(f.shutdownError(), observed);
  assert.ok(observed instanceof AggregateError);
  assert.ok(observed.errors.some(error => error instanceof Error && error.cause === second));
  assert.equal(logged.mock.callCount(), 2);
});

test("failed continuation replays its settled failure without invoking recovery a second time", async t => {
  const logged = t.mock.method(logger, "error", () => {});
  const f = await startupFixture({ recover() { throw new Error("first entry failed"); } });
  const first = await f.request("runtime.startup.continue", "continue-failed-first", { continuationId: "candidate-continue-1" });
  const replay = await f.request("runtime.startup.continue", "continue-failed-replay", { continuationId: "candidate-continue-1" });
  assert.deepEqual(replay, first); assert.equal(first.status, 500); assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual(f.calls, ["recover", "shutdown", "cleaned"]);
});

test("late recovery failure waits for an already pending response before unified cleanup", async t => {
  t.mock.method(logger, "error", () => {}); let fail!: DesktopStartupOperation["fail"];
  const f = await startupFixture({ holdResponse: true, recover(operation) { fail = operation.fail; } });
  await f.request("runtime.startup.continue", "continue-pending-late-failure", { continuationId: "candidate-continue-1" });
  fail(new Error("late entry failed"), "orchestration");
  assert.equal(f.lifecycle.isTaskAdmissionPaused(), true); assert.deepEqual(f.calls, ["recover"]);
  f.deliveries[0]!(); await new Promise(setImmediate);
  assert.deepEqual(f.calls, ["recover", "shutdown", "cleaned"]);
});

/** 原更新控制失败后诊断/响应再失败，统一停止与排空须保留原拒绝实体。 */
for (const method of ["runtime.update.prepare", "runtime.update.interrupt", "runtime.update.cancel"] as const)
for (const original of [undefined, false, Object.freeze(new Error("PRIVATE_UPDATE_BODY")),
  Object.freeze(new AggregateError([new Error("PRIVATE_UPDATE_DETAIL")], "PRIVATE_UPDATE_AGGREGATE"))])
for (const boundary of ["diagnostic", "response", "delivery-log"] as const)
test(`D09 control causes retain ${method} ${String(original)} and ${boundary} failure`, async t => {
  const diagnostic = new Error("PRIVATE_DIAGNOSTIC_BODY"), delivery = new Error("PRIVATE_RESPONSE_BODY"), lastLog = new Error("PRIVATE_DELIVERY_LOG_BODY");
  const logs: Array<{ message: string; data: any }> = [], sent: any[] = [];
  t.mock.method(logger, "error", (_tag: string, message: string, data: unknown) => {
    logs.push({ message, data });
    if (boundary === "diagnostic" && message === "desktop API request failed") throw diagnostic;
    if (boundary === "delivery-log" && message === "desktop IPC delivery failed") throw lastLog;
  });
  const channel = createChannel();
  channel.send = (message: any, callback) => {
    sent.push(message); callback(message.id === "failed-update-control" && boundary !== "diagnostic" ? delivery : null);
  };
  const lifecycle = createDesktopLifecycle(channel, "update-causes-parent", { abortStartup() { assert.fail("unexpected startup abort"); } });
  let stopped: unknown, shutdowns = 0, cleaned = false, fail = false;
  const calls: string[] = [];
  await lifecycle.ready(async (_reason, error) => {
    stopped = error; shutdowns++;
    await assert.rejects(lifecycle.drainRequests(), cause => cause === stopped);
    cleaned = true;
  }, healthy, async () => { assert.fail("control must not enter business handler"); }, {
    prepare: async () => { calls.push("prepare"); if (fail) throw original; return { hasRunningSessions: true }; },
    interrupt: async () => { calls.push("interrupt"); if (fail) throw original; },
    resume: async () => { calls.push("cancel"); if (fail) throw original; },
  });
  if (method !== "runtime.update.prepare") {
    channel.emit("message", { t: "desktop.api.req", requestId: "update-causes-parent", id: "initial-prepare", request: { method: "runtime.update.prepare" } });
    await new Promise(setImmediate);
    assert.equal(sent.find(row => row.id === "initial-prepare").response.status, 200);
  }
  fail = true;
  channel.emit("message", { t: "desktop.api.req", requestId: "update-causes-parent", id: "failed-update-control", request: { method } });
  await new Promise(setImmediate);
  assert.ok(stopped instanceof AggregateError);
  const combined: unknown = boundary === "delivery-log" ? stopped.errors[0] : stopped;
  if (boundary === "delivery-log") { assert.equal(stopped.errors.length, 2); assert.equal(stopped.errors[1], lastLog); assert.equal(stopped.message, "DESKTOP_IPC_DELIVERY_LOG_FAILED"); }
  assert.ok(combined instanceof AggregateError);
  assert.equal(combined.errors.length, 2); assert.equal(combined.errors[0], original);
  assert.equal(combined.errors[1], boundary === "diagnostic" ? diagnostic : delivery); assert.equal(combined.cause, original);
  assert.equal(combined.message, boundary === "diagnostic" ? "DESKTOP_UPDATE_CONTROL_DIAGNOSTIC_FAILED" : "DESKTOP_UPDATE_CONTROL_RESPONSE_FAILED");
  assert.equal(shutdowns, 1); assert.equal(cleaned, true); assert.equal(lifecycle.isTaskAdmissionPaused(), true);
  assert.equal(calls.at(-1), method === "runtime.update.cancel" ? "cancel" : method === "runtime.update.interrupt" ? "interrupt" : "prepare");
  const response = sent.find(row => row.id === "failed-update-control");
  if (boundary === "diagnostic") assert.equal(response, undefined);
  else { assert.equal(response.response.status, 500); assert.equal(response.response.body.code, "DESKTOP_UPDATE_CONTROL_FAILED"); }
  const failures = logs.filter(row => row.message === "desktop API request failed");
  assert.equal(failures.length, 1); assert.equal(failures[0]!.data.requestId, "failed-update-control");
  assert.equal(failures[0]!.data.parentRequestId, "update-causes-parent"); assert.equal(failures[0]!.data.method, method);
  assert.doesNotMatch(JSON.stringify([logs, sent]), /PRIVATE_/u);
  await assert.rejects(lifecycle.drainRequests(), cause => cause === stopped);
});

test("desktop lifecycle publishes terminal events and rejects malformed ownership", async () => {
  const channel = createChannel(), sent: unknown[] = [];
  channel.send = (message, callback) => { sent.push(message); callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "terminal-events", { abortStartup: () => assert.fail("unexpected abort") });
  await lifecycle.ready(() => {}, healthy);
  const event = { t: "terminal.output" as const, clientId: "local-client", workspaceId: "local:workspace", terminalId: "term-1", data: "ok" };
  lifecycle.publishEvent(event);
  assert.deepEqual(sent[1], { t: "desktop.event", requestId: "terminal-events", event });
  assert.throws(() => lifecycle.publishEvent({ ...event, workspaceId: "" } as any), /DESKTOP_EVENT_INVALID/u);
});

test("desktop lifecycle refuses terminal events before ready", () => {
  const lifecycle = createDesktopLifecycle(createChannel(), "terminal-not-ready", { abortStartup: () => {} });
  assert.throws(() => lifecycle.publishEvent({ t: "terminal.closed", clientId: "local-client", workspaceId: "local:workspace", terminalId: "term-1" }),
    /DESKTOP_EVENT_NOT_READY/u);
});
