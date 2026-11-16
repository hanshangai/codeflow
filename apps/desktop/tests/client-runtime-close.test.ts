import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createClientRuntime } from "../src/clientRuntime.js";

/** 分别驱动exit和close，暴露直接child尚未收口的真实事件窗口。 */
class ControlledChild extends EventEmitter {
  sent: unknown[] = [];
  constructor(autoSpawn = true) { super(); if (autoSpawn) queueMicrotask(() => this.emit("spawn")); }
  /** 只确认IPC发送，由测试明确交还进程终止和资源关闭事实。 */
  send(message: unknown, callback: (error: Error | null) => void): boolean {
    this.sent.push(message); callback(null); return true;
  }
}

/** 临时目录跟随本轮D盘TEMP，清理前确保可控child已完成close。 */
async function fixture(t: TestContext) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-client-close-"));
  const child = new ControlledChild();
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child });
  await runtime.start();
  t.after(async () => { child.emit("close", 0, null); await fs.rm(dataDir, { recursive: true }); });
  return { child, runtime, dataDir };
}

test("drain retains the child owner until close and rejects a successor after exit", async t => {
  const f = await fixture(t);
  let settled = false;
  const draining = f.runtime.drain(1000).then(() => { settled = true; });
  f.child.emit("exit", 0, null);
  await new Promise(setImmediate);
  assert.equal(settled, false, "exit cannot confirm closed stdio and IPC resources");
  await assert.rejects(f.runtime.start(), /CLIENT_RUNTIME_ALREADY_RUNNING/u);
  f.child.emit("close", 0, null);
  await draining;
  assert.equal(f.runtime.snapshot().status, "stopped");
});

test("drain called after exit only waits for the original close without sending shutdown", async t => {
  const f = await fixture(t);
  f.child.emit("exit", 0, null);
  let settled = false;
  const draining = f.runtime.drain(1000).then(() => { settled = true; });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.equal(f.child.sent.length, 0);
  f.child.emit("close", 0, null);
  await draining;
});

test("close timeout retains ownership so a later drain can finish the same child", async t => {
  const f = await fixture(t);
  f.child.emit("exit", 0, null);
  await assert.rejects(f.runtime.drain(15), /CLIENT_DRAIN_TIMEOUT/u);
  await assert.rejects(f.runtime.start(), /CLIENT_RUNTIME_ALREADY_RUNNING/u);
  assert.equal(f.child.sent.length, 0);
  f.child.emit("close", 0, null);
  await f.runtime.drain(100);
  assert.equal(f.runtime.snapshot().status, "failed");
});

test("a later clean exit and close cannot erase an already observed drain failure", async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.drain(15), /CLIENT_DRAIN_TIMEOUT/u);
  f.child.emit("exit", 0, null);
  f.child.emit("close", 0, null);
  await f.runtime.drain();
  assert.equal(f.runtime.snapshot().status, "failed");
  assert.equal(f.runtime.snapshot().errorCode, "CLIENT_DRAIN_TIMEOUT");
});

test("nonzero exit remains a failure but drain waits for close before returning it", async t => {
  const f = await fixture(t);
  let outcome: unknown;
  const draining = f.runtime.drain(1000).then(() => { outcome = "success"; return "success"; }, error => { outcome = error; return error as unknown; });
  f.child.emit("exit", 7, null);
  await new Promise(setImmediate);
  assert.equal(outcome, undefined);
  f.child.emit("close", 7, null);
  const result = await draining;
  assert.ok(result instanceof Error);
  assert.match(result.message, /CLIENT_EXIT_7/u);
});

test("close timeout preserves a nonzero exit observed while drain was already waiting", async t => {
  const f = await fixture(t);
  const observed = assert.rejects(f.runtime.drain(15), error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some(value => value instanceof Error && value.message === "CLIENT_EXIT_7"));
    assert.ok(error.errors.some(value => value instanceof Error && value.message === "CLIENT_DRAIN_TIMEOUT"));
    return true;
  });
  f.child.emit("exit", 7, null);
  await observed;
  f.child.emit("close", 7, null);
  await f.runtime.drain();
});

test("an undefined process error remains an explicit original cause through close", async t => {
  const f = await fixture(t);
  const observed = assert.rejects(f.runtime.drain(1000), error => {
    assert.ok(error instanceof Error);
    assert.equal(Object.hasOwn(error, "cause"), true);
    assert.equal(error.cause, undefined);
    return true;
  });
  f.child.emit("error", undefined);
  f.child.emit("exit", 0, null);
  f.child.emit("close", 0, null);
  await observed;
});

test("a thrown undefined shutdown send failure keeps its cause and pending close owner", async t => {
  const f = await fixture(t);
  f.child.send = () => { throw undefined; };
  await assert.rejects(f.runtime.drain(1000), error => {
    assert.ok(error instanceof Error);
    assert.equal(Object.hasOwn(error, "cause"), true);
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(f.runtime.start(), /CLIENT_RUNTIME_ALREADY_RUNNING/u);
  f.child.emit("exit", 0, null);
  f.child.emit("close", 0, null);
  await f.runtime.drain();
});

test("an error between exit and close preserves the original exit failure", async t => {
  const f = await fixture(t), cause = Object.assign(new Error("close boundary failed"), { code: "EIO" });
  const draining = f.runtime.drain(1000);
  const observed = assert.rejects(draining, error => {
    const values: unknown[] = [];
    /** 原始异常身份与退出码都必须保留，不能被后到错误覆盖。 */
    const collect = (value: unknown): void => { values.push(value); if (value instanceof AggregateError) value.errors.forEach(collect); if (value instanceof Error && Object.hasOwn(value, "cause")) collect(value.cause); };
    collect(error);
    assert.ok(values.includes(cause));
    assert.ok(values.some(value => value instanceof Error && value.message === "CLIENT_EXIT_7"));
    return true;
  });
  f.child.emit("exit", 7, null);
  f.child.emit("error", cause);
  f.child.emit("close", 7, null);
  await observed;
});

test("shutdown delivery failure remains alongside exit failure when the same child closes during drain", async t => {
  const f = await fixture(t);
  let finishShutdown!: (error: Error | null) => void;
  f.child.send = (message, callback) => {
    assert.equal((message as { t: string }).t, "desktop.shutdown");
    finishShutdown = callback;
    return true;
  };
  const shutdownFailure = Object.assign(new Error("SHUTDOWN_DELIVERY_FAILED"), { code: "EPIPE" });
  const outcome = f.runtime.drain(1000).then(() => undefined, error => error as unknown);
  assert.equal(typeof finishShutdown, "function");
  f.child.emit("exit", 7, null);
  f.child.emit("close", 7, null);
  finishShutdown(shutdownFailure);
  const values: unknown[] = [];
  /** 同一异常对象只交还一次，退出主因和关闭请求投递副因都不能丢。 */
  const collect = (value: unknown): void => { values.push(value); if (value instanceof AggregateError) value.errors.forEach(collect); };
  collect(await outcome);
  assert.equal(values.filter(value => value === shutdownFailure).length, 1);
  assert.equal(values.filter(value => value instanceof Error && value.message === "CLIENT_EXIT_7").length, 1);
  await f.runtime.drain();
});

test("drain does not duplicate a shutdown cause already contained in its failure aggregate", async t => {
  const f = await fixture(t);
  let finishShutdown!: (error: Error | null) => void;
  f.child.send = (message, callback) => {
    assert.equal((message as { t: string }).t, "desktop.shutdown");
    finishShutdown = callback; return true;
  };
  const shutdownFailure = Object.assign(new Error("SHUTDOWN_DELIVERY_FAILED"), { code: "EPIPE" });
  const outcome = f.runtime.drain(1000).then(() => undefined, error => error as unknown);
  finishShutdown(shutdownFailure);
  const values: unknown[] = [];
  /** 展开聚合只计实际原异常身份，防止catch重复包入同一失败。 */
  const collect = (value: unknown): void => { values.push(value); if (value instanceof AggregateError) value.errors.forEach(collect); };
  collect(await outcome);
  assert.equal(values.filter(value => value === shutdownFailure).length, 1);
  f.child.emit("exit", 0, null);
  f.child.emit("close", 0, null);
  await f.runtime.drain();
});

test("exit immediately rejects pending API work and revokes events while close is pending", async t => {
  const f = await fixture(t), received: unknown[] = [];
  const requestId = f.runtime.snapshot().requestId;
  f.child.emit("message", { t: "desktop.ready", requestId, health: { protocolVersion: 1, clientVersion: "1", dbSchemaVersion: 1, database: "ready" } });
  f.runtime.onEvent(event => received.push(event));
  const response = assert.rejects(f.runtime.request({ method: "workspaces.list" }), /DESKTOP_API_CLIENT_EXIT/u);
  f.child.emit("exit", 0, null);
  await response;
  const before = f.child.sent.length;
  f.child.emit("message", { t: "desktop.event", requestId, event: { t: "thread.queue.changed", workspaceId: "w", threadId: "t", reason: "paused" } });
  f.child.emit("message", { t: "desktop.orchAsset.trust.req", requestId, id: "late" });
  assert.deepEqual(received, []);
  assert.equal(f.child.sent.length, before);
  await assert.rejects(f.runtime.request({ method: "workspaces.list" }), /CLIENT_NOT_READY/u);
  f.child.emit("close", 0, null);
});

test("spawn failure keeps its resource owner until the subsequent close", { timeout: 2000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-client-close-spawn-"));
  const child = new ControlledChild(false), cause = Object.assign(new Error("spawn rejected"), { code: "ENOENT" });
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => {
    queueMicrotask(() => child.emit("error", cause)); return child;
  } });
  t.after(async () => { child.emit("close", -1, null); await fs.rm(dataDir, { recursive: true }); });
  await assert.rejects(runtime.start(), error => error === cause);
  await assert.rejects(runtime.start(), /CLIENT_RUNTIME_ALREADY_RUNNING/u);
  const draining = runtime.drain(1000);
  assert.equal(child.sent.length, 0);
  child.emit("close", -1, null);
  await draining;
});

/** 真实Windows探针按PID读取创建时间、路径与命令，不按名称清理其他进程。 */
function readProcessIdentity(pid: number): unknown {
  if (process.platform !== "win32") return { pid };
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if(!$p){'null'}else{[pscustomobject]@{pid=[int]$p.ProcessId;createdAt=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;commandLine=$p.CommandLine}|ConvertTo-Json -Compress}`;
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, encoding: "utf8", timeout: 15000 }));
}

for (const exitCode of [0, 7]) {
  test(`real child retains IPC cleanup until close and reports exit code ${exitCode}`, { timeout: 30000 }, async t => {
    const evidence = process.env.CF_CLOSE_EVIDENCE_ROOT ?? os.tmpdir();
    await fs.mkdir(evidence, { recursive: true });
    const dataDir = await fs.mkdtemp(path.join(evidence, "cf-client-close-real-"));
    const entry = path.join(dataDir, "fixture.cjs");
    await fs.writeFile(entry, `process.on("message", message => { if (message.t === "desktop.shutdown" && message.requestId === process.env.CODEFLOWAI_DESKTOP_REQUEST_ID) process.exit(${exitCode}); });
process.send({ t: "desktop.ready", requestId: process.env.CODEFLOWAI_DESKTOP_REQUEST_ID, health: { protocolVersion: 1, clientVersion: "1", dbSchemaVersion: 1, database: "ready" } });
`, "utf8");
    const events: Array<{ event: string; at: number; code?: number | null }> = [];
    let child!: ChildProcess;
    let identity: unknown;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const runtime = createClientRuntime({ entry, dataDir, spawn(file, args, options) {
      child = spawn(file, args, options);
      child.once("spawn", () => { identity = readProcessIdentity(child.pid!); events.push({ event: "spawn", at: performance.now() }); });
      child.once("exit", code => events.push({ event: "exit", at: performance.now(), code }));
      child.once("close", code => { events.push({ event: "close", at: performance.now(), code }); resolveClosed(); });
      return child;
    } });
    t.after(async () => {
      await runtime.drain(5000);
      await closed;
      const after = process.platform === "win32" ? readProcessIdentity(child.pid!) : null;
      assert.equal(after, null);
      await fs.writeFile(path.join(dataDir, "result.json"), JSON.stringify({ identity, events, snapshot: runtime.snapshot(), owned: 0 }, null, 2) + "\n", { flag: "wx" });
    });
    await runtime.start();
    await runtime.waitReady(10000);
    if (exitCode === 0) await runtime.drain(5000);
    else await assert.rejects(runtime.drain(5000), /CLIENT_EXIT_7/u);
    events.push({ event: "drain-returned", at: performance.now() });
    assert.deepEqual(events.map(event => event.event), ["spawn", "exit", "close", "drain-returned"]);
    assert.equal(events[1]!.code, exitCode);
    assert.equal(events[2]!.code, exitCode);
    assert.equal(runtime.snapshot().pid, null);
    assert.equal(runtime.snapshot().status, exitCode === 0 ? "stopped" : "failed");
  });
}
