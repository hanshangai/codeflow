import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createClientRuntime } from "../src/clientRuntime.js";
import type { ReleaseBundleManifest } from "../src/contracts.js";
import type { DesktopEvent, DesktopUpdateControlRequest } from "@codeflowai/shared";
import fsSync from "node:fs";

test("held startup snapshots its identity and replaces inherited startup environment", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-held-runtime-")); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.property(process, "env", { ...process.env, CODEFLOWAI_DESKTOP_STARTUP_MODE: "held", CODEFLOWAI_DESKTOP_STARTUP_CONTINUATION_ID: "inherited" });
  const startup = { mode: "held" as const, continuationId: "candidate-1" }, child = new FakeChild(false);
  let env!: NodeJS.ProcessEnv;
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, startup, spawn: (_file, _args, options) => { env = options.env; return child; } });
  startup.continuationId = "mutated";
  await runtime.start();
  assert.equal(env.CODEFLOWAI_DESKTOP_STARTUP_MODE, "held"); assert.equal(env.CODEFLOWAI_DESKTOP_STARTUP_CONTINUATION_ID, "candidate-1");
  child.emit("message", { t: "desktop.ready", requestId: runtime.snapshot().requestId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 94, database: "ready" }, startup: { continuationId: "candidate-1", admission: "paused" } });
  await runtime.waitReady();
  assert.deepEqual(runtime.snapshot().startup, { continuationId: "candidate-1", admission: "paused" });
  const fact = runtime.snapshot().startup!; fact.continuationId = "mutated";
  assert.equal(runtime.snapshot().startup?.continuationId, "candidate-1"); child.emit("exit", 0, null);
});

for (const startupFact of [undefined, { continuationId: "wrong", admission: "paused" }, { continuationId: "candidate-1", admission: "running" }, { continuationId: "candidate-1", admission: "paused", extra: true }]) {
  test(`held readiness rejects an absent or uncorrelated pause fact: ${JSON.stringify(startupFact)}`, async t => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-held-ready-")); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const child = new FakeChild(false), runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, startup: { mode: "held", continuationId: "candidate-1" }, spawn: () => child });
    await runtime.start();
    child.emit("message", { t: "desktop.ready", requestId: runtime.snapshot().requestId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 94, database: "ready" }, ...(startupFact ? { startup: startupFact } : {}) });
    await assert.rejects(runtime.waitReady(), /DESKTOP_STARTUP_READY_INVALID/u); child.emit("exit", 0, null);
  });
}

test("automatic runtime removes inherited held identity and rejects malformed typed startup before spawn", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-automatic-runtime-")); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.property(process, "env", { ...process.env, CODEFLOWAI_DESKTOP_STARTUP_MODE: "held", CODEFLOWAI_DESKTOP_STARTUP_CONTINUATION_ID: "inherited" });
  const child = new FakeChild(false); let env!: NodeJS.ProcessEnv;
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: (_file, _args, options) => { env = options.env; return child; } });
  await runtime.start(); assert.equal(env.CODEFLOWAI_DESKTOP_STARTUP_MODE, "automatic"); assert.equal(env.CODEFLOWAI_DESKTOP_STARTUP_CONTINUATION_ID, undefined);
  child.emit("exit", 0, null);
  assert.throws(() => createClientRuntime({ entry: "fixture.cjs", dataDir, startup: { mode: "held", continuationId: "../escape" }, spawn() { assert.fail("invalid startup spawned"); } }), /DESKTOP_STARTUP_INPUT_INVALID/u);
});

class FakeChild extends EventEmitter {
  constructor(private readonly autoExit = true) {
    super();
    queueMicrotask(() => this.emit("spawn"));
  }

  killedWith: NodeJS.Signals | undefined;
  sentMessage: unknown;

  /** 普通fake按Node顺序交还exit和close；分离窗口由专门close测试控制。 */
  override emit(event: string | symbol, ...args: any[]): boolean {
    const result = super.emit(event, ...args);
    if (event === "exit") super.emit("close", ...args);
    return result;
  }

  /** 模拟父进程请求有界退出，不发送系统终止信号。 */
  send(message: unknown, callback: (error: Error | null) => void): boolean {
    this.sentMessage = message;
    callback(null);
    if (this.autoExit) queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killedWith = signal;
    if (this.autoExit) queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

test("starts the existing Client entry with the desktop data directory", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const child = new FakeChild();
  const runtime = createClientRuntime({
    entry: "client/index.js",
    dataDir,
    spawn: (file, args, options) => {
      calls.push({ file, args, env: options.env });
      return child;
    },
  });
  await runtime.start();
  assert.deepEqual(calls[0]?.args, ["--trace-uncaught", "client/index.js", "--foreground"]);
  assert.equal(calls[0]?.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(calls[0]?.env.CODEFLOWAI_CLIENT_DB_PATH, path.join(dataDir, "codeflowai.db"));
  assert.equal(runtime.snapshot().status, "running");
});

test("captures Client stderr so uncaught source lines survive the crash", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild();
  const stderr = new EventEmitter();
  Object.defineProperty(child, "stderr", { value: stderr });
  const runtime = createClientRuntime({ entry: "client/index.js", dataDir, spawn: () => child });
  await runtime.start();
  stderr.emit("data", Buffer.from("<anonymous>:1\nrequire('worker_threads')\n"));
  stderr.emit("close");
  const logPath = path.join(dataDir, "logs", "client-stderr.log");
  let content = "";
  for (let attempt = 0; attempt < 100 && !content.includes("worker_threads"); attempt++) {
    content = await fs.readFile(logPath, "utf8").catch(() => "");
    if (!content.includes("worker_threads")) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match(content, /require\('worker_threads'\)/u);
  await runtime.stop();
});

test("runtime keeps business event bodies owned by the Client producer", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-keys-event-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false), received: DesktopEvent[] = [];
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => child });
  runtime.onEvent(event => { received.push(event); });
  await runtime.start();
  const requestId = runtime.snapshot().requestId;
  child.emit("message", { t: "desktop.ready", requestId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 90, database: "ready" } });
  child.emit("message", { t: "desktop.event", requestId, event: { t: "engineKeys.changed" } });
  assert.deepEqual(received, [{ t: "engineKeys.changed" }]);
  child.emit("message", { t: "desktop.event", requestId, event: { t: "engineKeys.changed", revision: 2 } });
  assert.deepEqual(received, [{ t: "engineKeys.changed" }, { t: "engineKeys.changed", revision: 2 }]);
  assert.equal(runtime.snapshot().status, "ready");
  child.emit("exit", 0, null);
});

test("new business events pass the stable envelope while parent controls remain outside it", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-new-event-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false), received: unknown[] = [];
  const runtime = createClientRuntime({ entry: "client/dist/index.cjs", dataDir, spawn: () => child });
  runtime.onEvent(event => received.push(event));
  await runtime.start();
  const requestId = runtime.snapshot().requestId;
  child.emit("message", { t: "desktop.ready", requestId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 90, database: "ready" } });
  const event = { t: "future.business.changed", payload: { revision: 2 } };
  child.emit("message", { t: "desktop.event", requestId: "foreign-parent", event });
  assert.deepEqual(received, []);
  child.emit("message", { t: "desktop.event", requestId, event });
  assert.deepEqual(received, [event]);
  child.emit("message", { t: "desktop.shutdown", requestId, event });
  assert.equal(runtime.snapshot().status, "ready");
  child.emit("message", { t: "desktop.event", requestId, event: { t: "desktop.shutdown" } });
  assert.equal(runtime.snapshot().status, "failed");
  child.emit("exit", 0, null);
});

test("CLI runtime follows the selected signed resource and rejects incomplete resources", async t => {
  const { resolveClientCliRuntime } = await import("../src/clientRuntime.js");
  assert.equal(typeof resolveClientCliRuntime, "function");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-release-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  for (const release of ["first", "second"]) {
    const releaseDir = path.join(root, release);
    await fs.mkdir(path.join(releaseDir, "client", "npm", "bin"), { recursive: true });
    await fs.writeFile(path.join(releaseDir, "client", "npm", "bin", "npm-cli.js"), "npm", "utf8");
    await fs.writeFile(path.join(releaseDir, "client", "cli-runtime.json"), "{}", "utf8");
    assert.deepEqual(resolveClientCliRuntime({ releaseDir, dataDir, required: true }), {
      root: path.join(dataDir, "cli-runtime"), npmCliPath: path.join(releaseDir, "client", "npm", "bin", "npm-cli.js"),
      manifestPath: path.join(releaseDir, "client", "cli-runtime.json"),
    });
  }
  const empty = path.join(root, "empty");
  assert.equal(resolveClientCliRuntime({ releaseDir: empty, dataDir }), undefined);
  assert.throws(() => resolveClientCliRuntime({ releaseDir: empty, dataDir, required: true }), /DESKTOP_CLI_RUNTIME_MISSING/u);
  await fs.rm(path.join(root, "second", "client", "cli-runtime.json"));
  assert.throws(() => resolveClientCliRuntime({ releaseDir: path.join(root, "second"), dataDir }), /DESKTOP_CLI_RUNTIME_MISSING/u);
});

test("runtime rejects signed Node or ABI incompatibility before spawning and logs the failure", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-runtime-abi-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "client", "dist", "index.cjs"), dataDir = path.join(root, "data");
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const marker = { schemaVersion: 1, platform: process.platform, arch: process.arch,
    nodeMajor: Number(process.versions.node.split(".")[0]), modules: process.versions.modules };
  for (const mutation of [{ nodeMajor: marker.nodeMajor + 1 }, { modules: "0" }, { arch: "wrong" }, { schemaVersion: 2 }]) {
    await fs.writeFile(path.join(root, "client", "desktop-runtime.json"), JSON.stringify({ ...marker, ...mutation }), "utf8");
    const runtime = createClientRuntime({ entry, dataDir, spawn() { assert.fail("incompatible runtime spawned"); } });
    await assert.rejects(runtime.start(), /CLIENT_RUNTIME_INCOMPATIBLE/u);
    assert.equal(runtime.snapshot().status, "failed");
  }
  const records = (await fs.readFile(path.join(dataDir, "logs", "desktop-runtime-errors.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records.length, 4);
  assert.ok(records.every(record => record.requestId && record.rootCause.includes("CLIENT_RUNTIME_INCOMPATIBLE")));
  await fs.writeFile(path.join(root, "client", "desktop-runtime.json"), JSON.stringify(marker), "utf8");
  const child = new FakeChild(false), compatible = createClientRuntime({ entry, dataDir, spawn: () => child });
  await compatible.start();
  child.emit("exit", 0, null);
});

test("start waits for the child spawn event", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new EventEmitter() as FakeChild;
  let started = false;
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => child });
  const pending = runtime.start().then(() => { started = true; });
  await Promise.resolve();
  assert.equal(started, false);
  child.emit("spawn");
  await pending;
  assert.equal(runtime.snapshot().status, "running");
});

test("local requests require readiness and correlate responses with the current child", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-api-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let child!: FakeChild;
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => { child = new FakeChild(false); return child; } });
  await assert.rejects(() => runtime.request({ method: "workspaces.list" }), /CLIENT_NOT_READY/);
  await runtime.start();
  await assert.rejects(() => runtime.request({ method: "workspaces.list" }), /CLIENT_NOT_READY/);
  const requestId = runtime.snapshot().requestId;
  child!.emit("message", { t: "desktop.ready", requestId,
    health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } });
  const pending = runtime.request({ method: "workspaces.list" }, 100);
  const message = child.sentMessage as { t: string; requestId: string; id: string };
  assert.equal(message.t, "desktop.api.req");
  assert.equal(message.requestId, requestId);
  let settled = false;
  void pending.then(() => { settled = true; });
  child.emit("message", { t: "desktop.api.res", requestId: "stale", id: message.id, response: { status: 200, body: {} } });
  child.emit("message", { t: "desktop.api.res", requestId, id: "another-request", response: { status: 200, body: {} } });
  await Promise.resolve();
  assert.equal(settled, false);
  const response = { status: 200, body: { ok: true, workspaces: [] } };
  child.emit("message", { t: "desktop.api.res", requestId, id: message.id, response });
  assert.deepEqual(await pending, response);
  assert.equal(child.listenerCount("message"), 1, "request listeners are released");
  child.emit("exit", 0, null);
});

test("parent update control shares correlation and preserves explicit Client failures", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-update-control-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let child!: FakeChild;
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => { child = new FakeChild(false); return child; } });
  await assert.rejects(() => runtime.request({ method: "runtime.update.prepare" }), /CLIENT_NOT_READY/);
  await runtime.start();
  const requestId = runtime.snapshot().requestId;
  child.emit("message", { t: "desktop.ready", requestId,
    health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } });
  const methods: DesktopUpdateControlRequest["method"][] = ["runtime.update.prepare", "runtime.update.interrupt", "runtime.update.cancel"];
  for (const [index, method] of methods.entries()) {
    const pending = runtime.request({ method });
    const message = child.sentMessage as { t: string; requestId: string; id: string; request: DesktopUpdateControlRequest };
    assert.equal(message.t, "desktop.api.req");
    assert.equal(message.requestId, requestId);
    assert.deepEqual(message.request, { method });
    let completed = false;
    void pending.then(() => { completed = true; });
    child.emit("message", { t: "desktop.api.res", requestId: "old-parent", id: message.id, response: { status: 200, body: { ok: true } } });
    await Promise.resolve();
    assert.equal(completed, false);
    const response = index === 0 ? { status: 503, body: { ok: false, code: "DESKTOP_UPDATE_CONTROL_UNAVAILABLE" } }
      : index === 1 ? { status: 409, body: { ok: false, code: "DESKTOP_UPDATE_NOT_PREPARED" } }
      : { status: 200, body: { ok: true } };
    child.emit("message", { t: "desktop.api.res", requestId, id: message.id, response });
    assert.deepEqual(await pending, response);
    assert.equal(runtime.snapshot().status, "ready");
    assert.equal(child.listenerCount("message"), 1);
  }
  const events: DesktopEvent[] = [];
  runtime.onEvent(event => events.push(event));
  child.emit("message", { t: "desktop.event", requestId, event: committedEvent() });
  assert.deepEqual(events, [committedEvent()]);
  child.emit("exit", 0, null);
});

test("local request timeout, shutdown and child exit fail explicitly without marking a healthy runtime failed", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-api-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => child });
  await runtime.start();
  child.emit("message", { t: "desktop.ready", requestId: runtime.snapshot().requestId,
    health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } });
  await assert.rejects(() => runtime.request({ method: "workspaces.list" }, 1), /DESKTOP_API_TIMEOUT/);
  assert.equal(runtime.snapshot().status, "ready");
  assert.equal(child.listenerCount("message"), 1);
  const pending = runtime.request({ method: "workspaces.list" });
  const rejected = assert.rejects(pending, /DESKTOP_API_CLIENT_EXIT/);
  const draining = runtime.drain(100);
  await assert.rejects(() => runtime.request({ method: "workspaces.list" }), /CLIENT_NOT_READY/);
  child.emit("exit", 0, null);
  await rejected;
  await draining;
  const records = (await fs.readFile(path.join(dataDir, "logs", "desktop-runtime-errors.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.requestId && record.method === "workspaces.list"));
});

for (const method of ["runtime.update.interrupt", "runtime.update.cancel", "scheduledTasks.local.runNow"] as const) test(`${method} waits beyond the ordinary API timeout but fails promptly on IPC disconnect`, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-control-wait-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => child });
  await runtime.start();
  child.emit("message", { t: "desktop.ready", requestId: runtime.snapshot().requestId,
    health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let outcome: unknown;
  const pending = runtime.request({ method }).then(value => { outcome = value; return value; }, error => { outcome = error; return error as unknown; });
  t.mock.timers.tick(180_001);
  await new Promise(setImmediate);
  assert.equal(outcome, undefined, "the parent must wait for the original strict stop owner");
  child.emit("disconnect");
  const failure = await pending;
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /DESKTOP_API_CLIENT_DISCONNECTED/);
  assert.equal(child.listenerCount("disconnect"), 0);
  assert.equal(runtime.snapshot().status, "ready");
});

test("long local runNow preserves exact response correlation while ordinary requests retain their timer", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-local-run-wait-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false), runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => child });
  await runtime.start();
  const requestId = runtime.snapshot().requestId;
  child.emit("message", { t: "desktop.ready", requestId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 92, database: "ready" } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let outcome: unknown;
  const running = runtime.request({ method: "scheduledTasks.local.runNow", body: { taskId: "task" } }).then(response => { outcome = response; return response; });
  const request = child.sentMessage as { id: string };
  const ordinary = runtime.request({ method: "workspaces.list" }).then(response => response, error => error);
  t.mock.timers.tick(180_001); await new Promise(setImmediate);
  assert.match((await ordinary).message, /DESKTOP_API_TIMEOUT/); assert.equal(outcome, undefined);
  child.emit("message", { t: "desktop.api.res", requestId: "stale", id: request.id, response: { status: 200, body: {} } });
  child.emit("message", { t: "desktop.api.res", requestId, id: "other", response: { status: 200, body: {} } });
  await new Promise(setImmediate); assert.equal(outcome, undefined);
  const response = { status: 200, body: { ok: true, run: { id: "run", status: "timeout" } } };
  child.emit("message", { t: "desktop.api.res", requestId, id: request.id, response });
  assert.deepEqual(await running, response); assert.equal(child.listenerCount("message"), 1);
  child.emit("exit", 0, null);
});

test("drain requests Client cleanup through IPC and waits for close", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild();
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => child });
  await runtime.start();
  await runtime.drain(100);
  assert.equal(child.killedWith, undefined);
  assert.deepEqual(child.sentMessage, { t: "desktop.shutdown", requestId: runtime.snapshot().requestId });
  assert.equal(runtime.snapshot().status, "stopped");
});

test("drain fails when Client cleanup exits with a nonzero code", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
  try {
    const child = new FakeChild(false);
    const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => child });
    await runtime.start();
    const draining = runtime.drain(100);
    child.emit("exit", 1, null);
    await assert.rejects(() => draining, /CLIENT_EXIT_1/);
    assert.equal(runtime.snapshot().status, "failed");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("drain timeout marks the runtime failed", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => child });
  await runtime.start();
  await assert.rejects(() => runtime.drain(1), /CLIENT_DRAIN_TIMEOUT/);
  assert.equal(runtime.snapshot().status, "failed");
  assert.equal(runtime.snapshot().errorCode, "CLIENT_DRAIN_TIMEOUT");
});

test("explicit shutdown forces a timed out Client and waits for its close", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-force-stop-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  let forced = 0;
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child,
    forceKill: async target => { assert.equal(target, child); forced++; child.emit("exit", null, "SIGKILL"); } });
  await runtime.start();
  await runtime.drain(1, { force: true });
  assert.equal(forced, 1);
  assert.equal(runtime.snapshot().status, "stopped");
  assert.equal(runtime.snapshot().pid, null);
});

test("explicit shutdown accepts an already closed failed Client without pretending it saved successfully", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-failed-stop-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child });
  await runtime.start();
  const stopping = runtime.drain(100, { force: true });
  child.emit("exit", 1, null);
  await stopping;
  assert.equal(runtime.snapshot().status, "stopped");
  assert.equal(runtime.snapshot().errorCode, "CLIENT_EXIT_1");
});

test("failed force termination still blocks release of the live Client", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-force-failed-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child,
    forceKill: async () => { throw new Error("FORCE_TERMINATION_DENIED"); } });
  await runtime.start();
  await assert.rejects(runtime.drain(1, { force: true }), /CLIENT_FORCE_STOP_FAILED/);
  assert.equal(runtime.snapshot().status, "failed");
  child.emit("exit", 0, null);
});

test("a Client that already exited waits for close without targeting its old PID", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-late-close-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  let forced = false;
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child,
    forceKill: async () => { forced = true; throw new Error("OLD_PID_MUST_NOT_BE_TARGETED"); } });
  await runtime.start();
  const stopping = runtime.drain(1, { force: true });
  EventEmitter.prototype.emit.call(child, "exit", 0, null);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(forced, false);
  child.emit("close", 0, null);
  await stopping;
  assert.equal(runtime.snapshot().status, "stopped");
});

test("natural close during force termination wins over a process-not-found helper error", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-force-race-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child,
    forceKill: async () => { child.emit("exit", 0, null); throw Object.assign(new Error("PROCESS_NOT_FOUND"), { code: "ESRCH" }); } });
  await runtime.start();
  await runtime.drain(1, { force: true });
  assert.equal(runtime.snapshot().status, "stopped");
  assert.equal(runtime.snapshot().pid, null);
});

test("root close cannot hide a failure to verify the remaining process tree", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-tree-failure-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child,
    forceKill: async () => { child.emit("exit", 0, null); throw new Error("CLIENT_PROCESS_TREE_STOP_TIMEOUT"); } });
  await runtime.start();
  await assert.rejects(runtime.drain(1, { force: true }), /CLIENT_FORCE_STOP_FAILED/);
  assert.equal(runtime.snapshot().status, "failed");
  await assert.rejects(runtime.drain(1, { force: true }), /CLIENT_FORCE_STOP_FAILED/);
  await assert.rejects(runtime.start(), /CLIENT_FORCE_STOP_FAILED/);
});

test("exit before close cannot clear an earlier unconfirmed process tree failure", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-tree-exit-race-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  let attempts = 0;
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child,
    forceKill: async () => { attempts++; throw new Error("CLIENT_PROCESS_TREE_STOP_TIMEOUT"); } });
  await runtime.start();
  await assert.rejects(runtime.drain(1, { force: true }), /CLIENT_FORCE_STOP_FAILED/);
  EventEmitter.prototype.emit.call(child, "exit", 0, null);
  await assert.rejects(runtime.drain(1, { force: true }), /CLIENT_FORCE_STOP_FAILED/);
  child.emit("close", 0, null);
  await assert.rejects(runtime.drain(1, { force: true }), /CLIENT_FORCE_STOP_FAILED/);
  assert.equal(attempts, 1);
});

test("a real hung Client and its engine child are terminated together", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-real-force-stop-"));
  const entry = path.join(dataDir, "fixture.cjs"), pidFile = path.join(dataDir, "engine.pid");
  let rootPid: number | null = null, enginePid = 0;
  /** 仅检查本测试创建的 PID；权限及其它进程查询错误不能冒充已经退出。 */
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  t.after(async () => {
    for (const pid of [enginePid, rootPid]) {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(entry, `
const {spawn}=require('node:child_process'),fs=require('node:fs');
const engine=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:process.platform!=='win32'});
engine.once('spawn',()=>{
  fs.writeFileSync(${JSON.stringify(pidFile)},String(engine.pid));
  process.send({t:'desktop.ready',requestId:process.env.CODEFLOWAI_DESKTOP_REQUEST_ID,
    health:{protocolVersion:1,clientVersion:'fixture',dbSchemaVersion:88,database:'ready'}});
});
process.on('message',()=>{});setInterval(()=>{},1000);
`, "utf8");
  const runtime = createClientRuntime({ entry, dataDir });
  await runtime.start(); rootPid = runtime.snapshot().pid;
  await runtime.waitReady(3000);
  enginePid = Number(await fs.readFile(pidFile, "utf8"));
  assert.equal(alive(enginePid), true);
  await runtime.drain(20, { force: true });
  for (let attempt = 0; attempt < 40 && alive(enginePid); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(runtime.snapshot().status, "stopped");
  assert.equal(alive(rootPid!), false);
  assert.equal(alive(enginePid), false);
});

test("force termination retains startup ownership after the root closes", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-force-owner-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  let entered!: () => void, release!: () => void, spawns = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => { spawns++; return spawns === 1 ? child : new FakeChild(); },
    forceKill: async () => { child.emit("exit", 0, null); entered(); await held; } });
  await runtime.start();
  const stopping = runtime.drain(1, { force: true });
  await started;
  try { await assert.rejects(runtime.start(), /CLIENT_RUNTIME_(STOPPING|ALREADY_RUNNING)/); }
  finally { release(); await stopping; }
  assert.equal(spawns, 1);
});

test("concurrent forced drains wait for the same process tree verification", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-force-shared-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  let entered!: () => void, release!: () => void, attempts = 0, secondFinished = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child,
    forceKill: async () => { attempts++; child.emit("exit", 0, null); entered(); await held; } });
  await runtime.start();
  const first = runtime.drain(1, { force: true });
  await started;
  const second = runtime.drain(1, { force: true }).then(() => { secondFinished = true; });
  try { await new Promise(setImmediate); assert.equal(secondFinished, false); }
  finally { release(); await Promise.all([first, second]); }
  assert.equal(attempts, 1);
});

test("late close after successful tree termination does not permanently block retries", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-force-late-success-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child,
    forceKill: async () => { EventEmitter.prototype.emit.call(child, "exit", 0, null); } });
  await runtime.start();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stopping = assert.rejects(runtime.drain(1, { force: true }), /CLIENT_FORCE_STOP_FAILED/);
  t.mock.timers.tick(2); await new Promise(setImmediate);
  t.mock.timers.tick(5_001); await stopping;
  child.emit("close", 0, null);
  await runtime.drain(1, { force: true });
  assert.equal(runtime.snapshot().pid, null);
});

test("a real child confirms readiness and exits through the IPC cleanup boundary", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const entry = path.join(dataDir, "fixture.cjs");
  await fs.writeFile(entry, `
process.on("message", message => {
  if (message.t === "desktop.shutdown" && message.requestId === process.env.CODEFLOWAI_DESKTOP_REQUEST_ID) process.exit(0);
});
process.send({ t: "desktop.ready", requestId: process.env.CODEFLOWAI_DESKTOP_REQUEST_ID,
  health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } });
`, "utf8");
  const runtime = createClientRuntime({ entry, dataDir });
  await runtime.start();
  try {
    await runtime.waitReady(3000);
    assert.equal(runtime.snapshot().status, "ready");
  } finally {
    await runtime.drain(3000);
  }
  assert.equal(runtime.snapshot().status, "stopped");
});

test("only a matching runtime health receipt makes the selected release ready", async (t) => {
  const originalVersion = process.env.CODEFLOWAI_VERSION;
  process.env.CODEFLOWAI_VERSION = "inherited-server-version";
  t.after(() => {
    if (originalVersion === undefined) delete process.env.CODEFLOWAI_VERSION;
    else process.env.CODEFLOWAI_VERSION = originalVersion;
  });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild();
  let env: NodeJS.ProcessEnv | undefined;
  const manifest = { releaseId: "new-release", version: "2.0.0", clientVersion: "1.0.0", protocolVersion: 1, dbSchemaVersion: 88 } as ReleaseBundleManifest;
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir,
    expectedRelease: manifest,
    spawn: (_file, _args, options) => { env = options.env; return child; },
  });
  await runtime.start();
  const waiting = runtime.waitReady(100);
  const health = { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" };
  child.emit("message", { t: "desktop.ready", requestId: "stale", health });
  assert.equal(runtime.snapshot().status, "running");
  child.emit("message", { t: "desktop.ready", requestId: runtime.snapshot().requestId, health });
  await waiting;
  assert.equal(runtime.snapshot().releaseId, "new-release");
  assert.equal(env?.CODEFLOWAI_DESKTOP_DB_SCHEMA_VERSION, "88");
  assert.equal(env?.CODEFLOWAI_VERSION, undefined);
  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.health, health);
  snapshot.health!.clientVersion = "mutated";
  assert.equal(runtime.snapshot().health?.clientVersion, "1.0.0");
  await runtime.drain();
});

test("rejects missing or incompatible health without allowing a later receipt to hide the failure", async (t) => {
  const health = { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" };
  for (const [invalid, code] of [[undefined, "CLIENT_HEALTH_INVALID"], [{ ...health, protocolVersion: 2 }, "CLIENT_HEALTH_PROTOCOL_MISMATCH"],
    [{ ...health, clientVersion: "0.9.0" }, "CLIENT_HEALTH_VERSION_MISMATCH"], [{ ...health, dbSchemaVersion: 89 }, "CLIENT_HEALTH_DB_SCHEMA_MISMATCH"],
    [{ ...health, database: "failed" }, "CLIENT_HEALTH_DATABASE_NOT_READY"]] as const) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const child = new FakeChild();
    const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir,
      expectedRelease: { releaseId: "new-release", clientVersion: "1.0.0", protocolVersion: 1, dbSchemaVersion: 88 },
      spawn: () => child,
    });
    await runtime.start();
    const waiting = runtime.waitReady(100);
    const requestId = runtime.snapshot().requestId;
    child.emit("message", { t: "desktop.ready", requestId, health: invalid });
    await assert.rejects(() => waiting, { code });
    child.emit("message", { t: "desktop.ready", requestId, health });
    assert.equal(runtime.snapshot().status, "failed");
    const log = JSON.parse((await fs.readFile(path.join(dataDir, "logs", "desktop-runtime-errors.jsonl"), "utf8")).trim());
    assert.equal(log.requestId, requestId);
    assert.equal(log.releaseId, "new-release");
    assert.match(log.errorCode, /CLIENT_HEALTH_/);
    await runtime.drain();
  }
});

test("records a structured log when Client emits an error", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
  try {
    const child = new FakeChild();
    const runtime = createClientRuntime({ entry: "client/index.js", dataDir, spawn: () => child });
    await runtime.start();
    child.emit("error", new Error("spawn failed"));
    const log = await fs.readFile(path.join(dataDir, "logs", "desktop-runtime-errors.jsonl"), "utf8");
    assert.match(log, /CLIENT_PROCESS_ERROR/);
    assert.match(log, /spawn failed/);
    assert.match(log, /requestId/);
    assert.equal(runtime.snapshot().status, "failed");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("drain exposes an unobserved asynchronous exit before allowing a retry", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => child });
  await runtime.start();
  child.emit("exit", 1, null);
  await assert.rejects(() => runtime.drain(), /CLIENT_EXIT_1/);
  await runtime.drain();
  assert.equal(runtime.snapshot().status, "failed");
});

test("a later process exit preserves the original error and failed error log", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "logs"), "not a directory", "utf8");
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => child });
  await runtime.start();
  child.emit("error", new Error("original process failure"));
  child.emit("exit", 1, null);
  await assert.rejects(() => runtime.drain(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    const messages = (value: unknown): string => value instanceof AggregateError
      ? value.errors.map(messages).join(" ") : value instanceof Error ? value.message : String(value);
    assert.match(messages(error), /original process failure/);
    return true;
  });
});

/** 使用完整 canonical 信封，避免把输入事件或 raw trace 当作提交事实。 */
function committedEvent(seq = 9): Extract<DesktopEvent, { t: "conversation.event" }> {
  return { t: "conversation.event", event: { schema: 1, seq, ts: 1000, workspaceId: "client:workspace" as any,
    threadId: "thread-1" as any, engine: "codex", type: "thread.started", payload: {} } };
}

test("runtime events require current child and parent association and unsubscribe across restarts", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-events-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const children: FakeChild[] = [];
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => { const child = new FakeChild(false); children.push(child); return child; } });
  const received: DesktopEvent[] = [];
  const unsubscribe = runtime.onEvent((event) => received.push(event));
  await runtime.start();
  const first = children[0]!;
  const firstId = runtime.snapshot().requestId;
  first.emit("message", { t: "desktop.ready", requestId: firstId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } });
  first.emit("message", { t: "desktop.event", requestId: "stale", event: committedEvent() });
  assert.deepEqual(received, []);
  first.emit("message", { t: "desktop.event", requestId: firstId, event: committedEvent() });
  assert.deepEqual(received, [committedEvent()]);
  const orchestration: DesktopEvent = { t: "orchestration.event", workspaceId: "client:workspace" as any,
    event: { id: "orch-event" as any, instanceId: "instance" as any, nodeId: null, type: "orchestration.started", payloadJson: "{}", createdAt: 1 } };
  first.emit("message", { t: "desktop.event", requestId: firstId, event: orchestration });
  assert.deepEqual(received, [committedEvent(), orchestration]);
  first.emit("exit", 0, null);
  assert.equal(first.listenerCount("message"), 0);
  await runtime.start();
  const second = children[1]!;
  const secondId = runtime.snapshot().requestId;
  second.emit("message", { t: "desktop.ready", requestId: secondId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } });
  first.emit("message", { t: "desktop.event", requestId: secondId, event: committedEvent(10) });
  second.emit("message", { t: "desktop.event", requestId: firstId, event: committedEvent(10) });
  second.emit("message", { t: "desktop.event", requestId: firstId, event: orchestration });
  second.emit("message", { t: "desktop.event", requestId: secondId, event: committedEvent(10) });
  assert.deepEqual(received, [committedEvent(), orchestration, committedEvent(10)]);
  unsubscribe();
  second.emit("message", { t: "desktop.event", requestId: secondId, event: committedEvent(11) });
  assert.equal(received.length, 3);
  second.emit("exit", 0, null);
});

test("invalid committed event or listener failure is logged and leaves runtime explicitly failed", async (t) => {
  for (const input of [undefined, [], {}, { t: "" }, { t: 1 }, { t: "bad event" }, { t: "runtime.update.prepare" }]) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-events-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const child = new FakeChild(false);
    const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child });
    await runtime.start();
    const requestId = runtime.snapshot().requestId;
    child.emit("message", { t: "desktop.ready", requestId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } });
    child.emit("message", { t: "desktop.event", requestId, event: input });
    assert.equal(runtime.snapshot().status, "failed");
    const records = (await fs.readFile(path.join(dataDir, "logs", "desktop-runtime-errors.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.at(-1).requestId, requestId);
    assert.equal(records.at(-1).errorCode, "DESKTOP_EVENT_FAILED");
    child.emit("exit", 0, null);
  }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-listener-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child });
  runtime.onEvent(() => { throw new Error("consumer failed"); });
  await runtime.start();
  child.emit("message", { t: "desktop.ready", requestId: runtime.snapshot().requestId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } });
  child.emit("message", { t: "desktop.event", requestId: runtime.snapshot().requestId, event: committedEvent() });
  assert.equal(runtime.snapshot().status, "failed");
  assert.match(await fs.readFile(path.join(dataDir, "logs", "desktop-runtime-errors.jsonl"), "utf8"), /consumer failed/);
  child.emit("exit", 0, null);
});

test("queue notifications use the same ready runtime boundary as committed events", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-queue-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild();
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => child });
  await runtime.start();
  const requestId = runtime.snapshot().requestId;
  child.emit("message", { t: "desktop.ready", requestId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 1, database: "ready" } });
  const received: DesktopEvent[] = [];
  runtime.onEvent(event => received.push(event));
  const changed = { t: "thread.queue.changed", workspaceId: "client:workspace", threadId: "thread", reason: "paused" };
  child.emit("message", { t: "desktop.event", requestId, event: changed });
  assert.deepEqual(received, [changed]);
  assert.equal(runtime.snapshot().status, "ready");
  await runtime.stop();
});

test("runtime accepts already in-flight events during drain and rejects events before ready", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-event-drain-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const children: FakeChild[] = [];
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => { const child = new FakeChild(false); children.push(child); return child; } });
  const received: DesktopEvent[] = [];
  runtime.onEvent((event) => received.push(event));
  await runtime.start();
  children[0]!.emit("message", { t: "desktop.event", requestId: runtime.snapshot().requestId, event: committedEvent() });
  assert.equal(runtime.snapshot().status, "failed");
  assert.deepEqual(received, []);
  children[0]!.emit("exit", 0, null);
  await runtime.start();
  const child = children[1]!;
  const requestId = runtime.snapshot().requestId;
  child.emit("message", { t: "desktop.ready", requestId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } });
  const draining = runtime.drain(100);
  child.emit("message", { t: "desktop.event", requestId, event: committedEvent() });
  assert.deepEqual(received, [committedEvent()]);
  child.emit("exit", 0, null);
  await draining;
});

test("drain rejects an event delivery failure that occurs before a clean child exit", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-drain-failure-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child });
  runtime.onEvent(() => { throw new Error("renderer delivery failed during drain"); });
  await runtime.start();
  const requestId = runtime.snapshot().requestId;
  child.emit("message", { t: "desktop.ready", requestId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } });
  const draining = runtime.drain(100);
  child.emit("message", { t: "desktop.event", requestId, event: committedEvent() });
  child.emit("exit", 0, null);
  await assert.rejects(draining, /renderer delivery failed during drain/);
  assert.equal(runtime.snapshot().status, "failed");
  await runtime.drain();
});

test("first desktop start seeds a default workspace while later starts keep the store authoritative", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-default-workspace-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const children: FakeChild[] = [], envs: NodeJS.ProcessEnv[] = [];
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: (_file, _args, options) => {
    envs.push(options.env);
    const child = new FakeChild(false);
    children.push(child);
    return child;
  } });
  await runtime.start();
  assert.deepEqual(JSON.parse(envs[0]!.CODEFLOWAI_WORKSPACES_JSON!), [{ path: path.join(dataDir, "workspace"), label: "默认工作区" }]);
  assert.equal(fsSync.existsSync(path.join(dataDir, "workspace")), true);
  children[0]!.emit("exit", 0, null);
  await fs.writeFile(path.join(dataDir, "codeflowai.db"), "");
  await runtime.start();
  assert.equal(envs[1]!.CODEFLOWAI_WORKSPACES_JSON, undefined);
  children[1]!.emit("exit", 0, null);
});

test("explicit workspace configuration suppresses the first-start default", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-configured-workspace-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const configured = JSON.stringify([{ path: dataDir, label: "自定义工作区" }]);
  t.mock.property(process, "env", { ...process.env, CODEFLOWAI_WORKSPACES_JSON: configured });
  let child!: FakeChild, env!: NodeJS.ProcessEnv;
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: (_file, _args, options) => {
    env = options.env;
    child = new FakeChild(false);
    return child;
  } });
  await runtime.start();
  assert.equal(env.CODEFLOWAI_WORKSPACES_JSON, configured);
  assert.equal(fsSync.existsSync(path.join(dataDir, "workspace")), false);
  child.emit("exit", 0, null);
});

test("runtime forwards terminal business payloads without duplicating Client ownership validation", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-terminal-event-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild(false), received: DesktopEvent[] = [];
  const runtime = createClientRuntime({ entry: "client/index.cjs", dataDir, spawn: () => child });
  runtime.onEvent(event => { received.push(event); });
  await runtime.start();
  const requestId = runtime.snapshot().requestId;
  child.emit("message", { t: "desktop.ready", requestId, health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 90, database: "ready" } });
  const event = { t: "terminal.output", clientId: "local-client", workspaceId: "local-client:workspace", terminalId: "term-1", data: "ok" };
  child.emit("message", { t: "desktop.event", requestId, event });
  assert.deepEqual(received, [event]);
  child.emit("message", { t: "desktop.event", requestId, event: { ...event, revision: 2 } });
  assert.deepEqual(received, [event, { ...event, revision: 2 }]);
  assert.equal(runtime.snapshot().status, "ready");
  child.emit("exit", 0, null);
});
