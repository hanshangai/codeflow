import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import test, { after, mock, type TestContext } from "node:test";
import type { IPty } from "node-pty";

import { logger } from "../src/logger.js";
import type { TerminalConfigPersistence, TerminalManagerDeps } from "../src/terminal/terminalManager.js";

type Config = Parameters<TerminalConfigPersistence["save"]>[0];
type FakePty = {
  kills: number;
  killError?: Error;
  killErrorAfterExit?: Error;
  onKill?: () => void;
  exitOnKill: boolean;
  listeners: Set<(event: { exitCode: number }) => void>;
  emitExit(exitCode?: number): void;
  emitData(data: string): void;
  kill(): void;
};

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
const originalSpawn = nodePty.spawn;
const spawned: FakePty[] = [];
let realPty: IPty | undefined;
let useRealPty = false;
mock.method(nodePty, "spawn", (...args: Parameters<typeof nodePty.spawn>) => {
  if (useRealPty) { realPty = originalSpawn(...args); return realPty; }
  let receiveData: (data: string) => void = () => {};
  const terminal: FakePty = {
    kills: 0, exitOnKill: false, listeners: new Set(),
    emitExit(exitCode = 0) { for (const listener of [...terminal.listeners]) listener({ exitCode }); },
    emitData(data) { receiveData(data); },
    kill() { terminal.kills += 1; if (terminal.killError) throw terminal.killError; terminal.onKill?.(); if (terminal.exitOnKill) terminal.emitExit(); if (terminal.killErrorAfterExit) throw terminal.killErrorAfterExit; },
  };
  spawned.push(terminal);
  return { ...terminal,
    onData: (listener: (data: string) => void) => { receiveData = listener; return { dispose() {} }; },
    onExit: (listener: (event: { exitCode: number }) => void) => { terminal.listeners.add(listener); return { dispose() { terminal.listeners.delete(listener); } }; },
    write() {}, resize() {},
  } as unknown as IPty;
});
const { TerminalManager } = await import("../src/terminal/terminalManager.js");
after(() => mock.restoreAll());

/** 使用真实 Manager，只替换外部 PTY 和持久化边界。 */
function fixture(t: TestContext) {
  const records = new Map<string, Config>();
  const logs: Array<Record<string, unknown>> = [];
  const outputs: string[] = [];
  const exits: string[] = [];
  const persistence: TerminalConfigPersistence = {
    save(config) { records.set(config.id, config); },
    remove(id) { records.delete(id); },
    updateLabel() {},
    listByWorkspace: workspaceId => [...records.values()].filter(config => config.workspaceId === workspaceId),
  };
  t.mock.method(logger, "info", () => {});
  t.mock.method(logger, "warn", () => {});
  t.mock.method(logger, "error", (_tag: string, _message: string, details?: unknown) => { logs.push(details as Record<string, unknown>); });
  const deps: TerminalManagerDeps = {
    writeWorkspaceLog(_workspaceId, entry) { if (entry.level !== "info" && entry.level !== "debug") logs.push(entry.data as Record<string, unknown>); },
    onError(error) { throw error; },
    workspaces: new Map([["workspace-a", process.cwd()], ["workspace-b", process.cwd()]]), persistence,
    onCreated() {}, onOutput(_terminal, data) { outputs.push(data); },
    onExited(terminal) { exits.push(terminal.id); },
  };
  const manager = new TerminalManager(deps);
  t.after(() => { for (const pty of spawned) { pty.killError = undefined; pty.killErrorAfterExit = undefined; } manager.dispose(); });
  return { manager, deps, persistence, records, logs, outputs, exits };
}

/** 创建可单独控制真实退出通知的终端。 */
function create(f: ReturnType<typeof fixture>, workspaceId = "workspace-a") {
  const info = f.manager.create({ workspaceId, requestId: "create-terminal", shell: "powershell.exe" });
  return { info, pty: spawned.at(-1)! };
}

test("update stop is a no-op without terminals and projects real running state", async t => {
  const f = fixture(t);
  assert.equal(f.manager.hasRunningTerminals(), false);
  await f.manager.stopAllForUpdate({ requestId: "update-empty" });
  const { pty } = create(f);
  assert.equal(f.manager.hasRunningTerminals(), true);
  pty.emitExit();
  assert.equal(f.manager.hasRunningTerminals(), false);
  await f.manager.stopAllForUpdate({ requestId: "update-exited" });
  assert.equal(pty.kills, 0);
  assert.equal(f.records.size, 0);
});

test("update stop diagnostics never include external credential text", async t => {
  const f = fixture(t), { pty } = create(f);
  const secret = "d09f-synthetic-secret-token";
  pty.killError = new Error(`authorization=Bearer ${secret}`);
  await assert.rejects(f.manager.stopAllForUpdate({ requestId: "update-private-error" }));
  assert.equal(JSON.stringify(f.logs).includes(secret), false);
  assert.equal(f.logs[0].errorCode, "DESKTOP_UPDATE_TERMINAL_KILL_FAILED");
  assert.equal(f.logs[0].requestId, "update-private-error");
});

test("update stop waits for the actual exit before deleting configuration", async t => {
  const f = fixture(t), { info, pty } = create(f);
  pty.emitData("last output");
  let settled = false;
  const stopping = f.manager.stopAllForUpdate({ requestId: "update-wait", timeoutMs: 1000 }).then(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(pty.kills, 1);
  assert.equal(settled, false);
  assert.equal(f.records.has(info.id), true);
  assert.equal(f.manager.get(info.id)?.status, "running");
  pty.emitExit(7);
  await stopping;
  assert.equal(f.manager.get(info.id), null);
  assert.equal(f.records.has(info.id), false);
  assert.deepEqual(f.outputs, ["last output"]);
  assert.deepEqual(f.exits, [info.id]);
  assert.equal(pty.listeners.size, 1, "temporary exit subscription is released");
});

test("update stop handles synchronous exit and all workspaces without restoring terminals", async t => {
  const f = fixture(t), first = create(f), second = create(f, "workspace-b");
  first.pty.exitOnKill = true;
  second.pty.exitOnKill = true;
  await f.manager.stopAllForUpdate({ requestId: "update-all" });
  assert.equal(first.pty.kills, 1);
  assert.equal(second.pty.kills, 1);
  assert.equal(f.manager.hasRunningTerminals(), false);
  assert.equal(f.records.size, 0);
  assert.deepEqual(f.manager.restoreAll("workspace-a"), []);
  assert.deepEqual(f.manager.restoreAll("workspace-b"), []);
});

test("kill failure is explicit and preserves the live terminal and configuration", async t => {
  const f = fixture(t), { info, pty } = create(f);
  pty.killError = new Error("kill denied");
  await assert.rejects(f.manager.stopAllForUpdate({ requestId: "update-kill" }), { code: "DESKTOP_UPDATE_TERMINAL_KILL_FAILED", cause: pty.killError });
  assert.equal(f.manager.get(info.id)?.status, "running");
  assert.equal(f.records.has(info.id), true);
  assert.equal(pty.listeners.size, 1);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].errorCode, "DESKTOP_UPDATE_TERMINAL_KILL_FAILED");
  assert.equal(f.logs[0].requestId, "update-kill");
  assert.equal(f.logs[0].workspaceId, "workspace-a");
  assert.equal(f.logs[0].terminalId, info.id);
  assert.equal((f.logs[0].rootCause as { code: string }).code, "UNCLASSIFIED_ERROR");
});

test("exit timeout keeps a manageable terminal and permits an explicit retry", async t => {
  const f = fixture(t), { info, pty } = create(f);
  await assert.rejects(f.manager.stopAllForUpdate({ requestId: "update-timeout", timeoutMs: 10 }), { code: "DESKTOP_UPDATE_TERMINAL_EXIT_TIMEOUT" });
  assert.equal(f.manager.get(info.id)?.status, "running");
  assert.equal(f.records.has(info.id), true);
  assert.equal(pty.listeners.size, 1);
  assert.equal(f.logs.length, 1);
  pty.exitOnKill = true;
  await f.manager.stopAllForUpdate({ requestId: "update-retry" });
  assert.equal(f.manager.get(info.id), null);
  assert.equal(f.records.size, 0);
});

test("synchronous exit does not hide a subsequent kill failure", async t => {
  const f = fixture(t), { info, pty } = create(f);
  pty.exitOnKill = true;
  pty.killErrorAfterExit = new Error("native close failed");
  await assert.rejects(f.manager.stopAllForUpdate({ requestId: "update-late-kill-error" }), { code: "DESKTOP_UPDATE_TERMINAL_KILL_FAILED", cause: pty.killErrorAfterExit });
  assert.equal(f.manager.get(info.id)?.status, "exited");
  assert.equal(f.records.has(info.id), true);
});

test("an exhausted shared budget does not start stopping another terminal", async t => {
  const f = fixture(t), first = create(f), second = create(f, "workspace-b");
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  first.pty.exitOnKill = true;
  second.pty.exitOnKill = true;
  first.pty.onKill = () => { now += 20; };
  await assert.rejects(f.manager.stopAllForUpdate({ requestId: "update-total-budget", timeoutMs: 10 }), { code: "DESKTOP_UPDATE_TERMINAL_EXIT_TIMEOUT" });
  assert.equal(first.pty.kills, 1);
  assert.equal(second.pty.kills, 0);
  assert.equal(f.manager.get(second.info.id)?.status, "running");
  assert.equal(f.records.has(second.info.id), true);
});

test("configuration failure after exit is explicit and retry does not kill again", async t => {
  const f = fixture(t), { info, pty } = create(f);
  pty.exitOnKill = true;
  const remove = f.persistence.remove;
  const failure = new Error("database unavailable");
  f.persistence.remove = () => { throw failure; };
  await assert.rejects(f.manager.stopAllForUpdate({ requestId: "update-persist" }), { code: "DESKTOP_UPDATE_TERMINAL_CONFIG_FAILED", cause: failure });
  assert.equal(f.manager.get(info.id)?.status, "exited");
  assert.equal(f.records.has(info.id), true);
  assert.equal(f.logs.length, 1);
  f.persistence.remove = remove;
  await f.manager.stopAllForUpdate({ requestId: "update-persist-retry" });
  assert.equal(pty.kills, 1);
  assert.equal(f.manager.get(info.id), null);
  assert.equal(f.records.size, 0);
});

test("invalid update stop budgets fail before stopping any terminal", async t => {
  const f = fixture(t), { pty } = create(f);
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5]) {
    await assert.rejects(f.manager.stopAllForUpdate({ requestId: "update-budget", timeoutMs }), { code: "DESKTOP_UPDATE_TERMINAL_STOP_INVALID" });
  }
  assert.equal(pty.kills, 0);
  assert.equal(f.records.size, 1);
});

test("real PowerShell exits before update stop resolves", { skip: process.platform !== "win32", timeout: 20_000 }, async t => {
  const f = fixture(t);
  const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
  const fork = childProcess.fork;
  const helpers: Array<{ child: ChildProcess; exited: Promise<void>; exitedAt: string | null }> = [];
  t.mock.method(childProcess, "fork", (...args: Parameters<typeof fork>) => {
    const child = fork(...args);
    if (String(args[0]).includes("conpty_console_list_agent")) {
      const record = { child, exited: Promise.resolve(), exitedAt: null as string | null };
      record.exited = new Promise<void>(resolve => child.once("exit", () => { record.exitedAt = new Date().toISOString(); resolve(); }));
      helpers.push(record);
    }
    return child;
  });
  useRealPty = true;
  let shellPid: number | undefined;
  let shellExitedAt: string | undefined;
  try {
    const info = f.manager.create({ workspaceId: "workspace-a", shell: "powershell.exe", requestId: "real-update-create" });
    assert.ok(realPty);
    const pid = realPty.pid;
    shellPid = pid;
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    process.kill(pid, 0);
    const marker = `__UPDATE_PTY_${pid}_READY__`;
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => { subscription.dispose(); reject(new Error("PowerShell readiness timed out")); }, 10_000);
      const subscription = realPty!.onData(data => {
        output += data;
        if (output.includes(marker)) { clearTimeout(timer); subscription.dispose(); resolve(); }
      });
      realPty!.write(`Write-Output '${marker}'\r`);
    });
    await f.manager.stopAllForUpdate({ requestId: "real-update-stop", timeoutMs: 10_000 });
    assert.equal(f.manager.get(info.id), null);
    assert.equal(f.records.has(info.id), false);
    assert.deepEqual(f.exits, [info.id]);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    shellExitedAt = new Date().toISOString();
  } finally {
    useRealPty = false;
    await f.manager.stopAllForUpdate({ requestId: "real-update-cleanup", timeoutMs: 10_000 });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(helpers.map(helper => helper.exited)), new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("ConPTY helper did not exit")), 7000);
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
    assert.ok(helpers.length > 0, "observed this stop operation's native console helper");
    for (const helper of helpers) {
      assert.ok(helper.child.pid);
      assert.throws(() => process.kill(helper.child.pid!, 0), { code: "ESRCH" });
    }
    t.diagnostic(JSON.stringify({ shellPid, shellExitedAt, helpers: helpers.map(helper => ({ pid: helper.child.pid, exitCode: helper.child.exitCode, signal: helper.child.signalCode, exitedAt: helper.exitedAt })) }));
  }
});
