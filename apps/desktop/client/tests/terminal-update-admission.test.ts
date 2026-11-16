import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { after, mock, type TestContext } from "node:test";
import type { IPty } from "node-pty";

import { logger } from "../src/logger.js";
import type { TerminalConfigPersistence, TerminalManagerDeps } from "../src/terminal/terminalManager.js";

type Config = Parameters<TerminalConfigPersistence["save"]>[0];
type FakePty = {
  writes: string[];
  sizes: number[][];
  kills: number;
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: (event: { exitCode: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
};

const spawned: FakePty[] = [];
const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
// 只替换外部 PTY，实际创建、恢复、事件和持久化仍经过真实 manager。
mock.method(nodePty, "spawn", () => {
  const pty: FakePty = {
    writes: [], sizes: [], kills: 0,
    onData: () => {},
    onExit: () => {},
    write: (data) => { pty.writes.push(data); },
    resize: (cols, rows) => { pty.sizes.push([cols, rows]); },
    kill: () => { pty.kills += 1; },
  };
  spawned.push(pty);
  return pty as unknown as IPty;
});
const { TerminalManager } = await import("../src/terminal/terminalManager.js");
after(() => mock.restoreAll());

/** 构建真实 manager，只在其既有 PTY 与持久化依赖边界记录副作用。 */
function createFixture(t: TestContext, isTaskAdmissionPaused?: () => boolean) {
  const records = new Map<string, Config>();
  const removed: string[] = [];
  const saved: Config[] = [];
  const created: Array<{ id: string; requestId?: string }> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const persistence: TerminalConfigPersistence = {
    save: (config) => { saved.push(config); records.set(config.id, config); },
    remove: (id) => { removed.push(id); records.delete(id); },
    updateLabel: (id, label) => { records.get(id)!.label = label; },
    listByWorkspace: (workspaceId) => [...records.values()].filter((config) => config.workspaceId === workspaceId),
  };
  t.mock.method(logger, "info", () => {});
  t.mock.method(logger, "warn", (_tag: string, _message: string, data?: unknown) => {
    warnings.push(data as Record<string, unknown>);
  });
  t.mock.method(logger, "error", (_tag: string, _message: string, data?: unknown) => {
    warnings.push(data as Record<string, unknown>);
  });
  const deps: TerminalManagerDeps = {
    writeWorkspaceLog(_workspaceId, entry) { if (entry.level !== "info" && entry.level !== "debug") warnings.push(entry.data as Record<string, unknown>); },
    onError(error) { throw error; },
    workspaces: new Map([["ws-1", process.cwd()]]),
    onOutput: () => {},
    onCreated: (terminal, requestId) => { created.push({ id: terminal.id, requestId }); },
    onExited: () => {},
    persistence,
    isTaskAdmissionPaused,
  };
  const manager = new TerminalManager(deps);
  const initialSpawnCount = spawned.length;
  t.after(() => manager.dispose());
  return { manager, deps, records, removed, saved, created, warnings, persistence,
    spawnCount: () => spawned.length - initialSpawnCount };
}

/** 生成旧配置，保留可验证的恢复 ID。 */
function oldConfig(id = "old-1"): Config {
  return { id, workspaceId: "ws-1", label: id, shell: null, cwd: null };
}

test("paused create rejects before workspace resolution and every launch side effect", (t) => {
  const f = createFixture(t, () => true);
  assert.throws(() => f.manager.create({ workspaceId: "unknown", requestId: "req-create" }), {
    code: "DESKTOP_UPDATE_TASKS_PAUSED",
  });
  assert.equal(f.spawnCount(), 0);
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.manager.list("unknown"), []);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.warnings[0].errorCode, "DESKTOP_UPDATE_TASKS_PAUSED");
  assert.equal(f.warnings[0].requestId, "req-create");
  assert.equal(f.warnings[0].workspaceId, "unknown");
  assert.ok(f.warnings[0].rootCause);
});

test("create resumes without consuming a terminal ID while paused", (t) => {
  let paused = true;
  const f = createFixture(t, () => paused);
  assert.throws(() => f.manager.create({ workspaceId: "ws-1" }), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
  assert.equal(typeof f.warnings[0].requestId, "string");
  assert.ok(f.warnings[0].requestId);
  paused = false;
  const terminal = f.manager.create({ workspaceId: "ws-1", requestId: "req-resumed" });
  assert.match(terminal.id, /_1$/);
  assert.equal(terminal.status, "running");
  assert.equal(f.spawnCount(), 1);
  assert.equal(f.saved.length, 1);
  assert.deepEqual(f.created, [{ id: terminal.id, requestId: "req-resumed" }]);
});

test("paused restore preserves old configuration without reading or launching", (t) => {
  const f = createFixture(t, () => true);
  const config = oldConfig();
  f.records.set(config.id, config);
  const list = t.mock.method(f.persistence, "listByWorkspace");
  assert.throws(() => f.manager.restoreAll("ws-1"), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
  assert.equal(list.mock.callCount(), 0);
  assert.deepEqual([...f.records.values()], [config]);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.created, []);
  assert.equal(f.spawnCount(), 0);
  assert.equal(f.warnings[0].requestId, "terminal-restore:ws-1");
});

test("restore rechecks after reading configuration and resumes with that configuration intact", (t) => {
  let paused = false;
  const f = createFixture(t, () => paused);
  const config = oldConfig();
  f.records.set(config.id, config);
  const list = t.mock.method(f.persistence, "listByWorkspace", () => { paused = true; return [config]; });
  assert.throws(() => f.manager.restoreAll("ws-1"), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
  assert.deepEqual([...f.records.values()], [config]);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.created, []);
  assert.equal(f.spawnCount(), 0);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.warnings[0].terminalId, config.id);
  assert.equal(f.warnings[0].requestId, "terminal-restore:ws-1:old-1");
  list.mock.restore();
  paused = false;
  const restored = f.manager.restoreAll("ws-1");
  assert.equal(restored.length, 1);
  assert.equal(restored[0].label, config.label);
  assert.equal(f.spawnCount(), 1);
  assert.deepEqual(f.removed, [config.id]);
  assert.equal(f.records.has(config.id), false);
  assert.equal(f.records.has(restored[0].id), true);
});

test("restore stops at a newly paused item without swallowing failure or changing running terminals", (t) => {
  let paused = false;
  const f = createFixture(t, () => paused);
  for (const id of ["old-1", "old-2", "old-3"]) f.records.set(id, oldConfig(id));
  const created = f.deps.onCreated;
  f.deps.onCreated = (terminal, requestId) => { created(terminal, requestId); paused = true; };
  assert.throws(() => f.manager.restoreAll("ws-1"), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
  assert.equal(f.spawnCount(), 1);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.removed, ["old-1"]);
  assert.equal(f.records.has("old-2"), true);
  assert.equal(f.records.has("old-3"), true);
  assert.equal(f.manager.list("ws-1")[0].status, "running");
  assert.equal(spawned.at(-1)!.kills, 0);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.warnings[0].terminalId, "old-2");
});

test("admission callback errors propagate from create and restore without side effects", (t) => {
  const failure = Object.assign(new Error("update admission store unavailable"), { code: "ADMISSION_STORE_UNAVAILABLE" });
  const f = createFixture(t, () => { throw failure; });
  const config = oldConfig();
  f.records.set(config.id, config);
  assert.throws(() => f.manager.create({ workspaceId: "ws-1", requestId: "req-error" }), (error) => error === failure);
  assert.throws(() => f.manager.restoreAll("ws-1"), (error) => error === failure);
  assert.equal(f.spawnCount(), 0);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.created, []);
  assert.deepEqual([...f.records.values()], [config]);
  assert.equal(f.warnings.length, 2);
  assert.equal(f.warnings[0].requestId, "req-error");
  assert.equal((f.warnings[0].rootCause as { code: string }).code, "UNCLASSIFIED_ERROR");
  assert.ok(f.warnings[0].errorCode);
});

test("restore does not swallow callback failure discovered before an individual item", (t) => {
  let failure: Error | undefined;
  const f = createFixture(t, () => { if (failure) throw failure; return false; });
  const config = oldConfig();
  f.records.set(config.id, config);
  t.mock.method(f.persistence, "listByWorkspace", () => {
    failure = new Error("per-item admission read failed");
    return [config];
  });
  assert.throws(() => f.manager.restoreAll("ws-1"), (error) => error === failure);
  assert.equal(f.spawnCount(), 0);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.created, []);
  assert.deepEqual([...f.records.values()], [config]);
  assert.equal(f.warnings[0].terminalId, config.id);
});

test("paused admission keeps existing PTY input resize list and close available", (t) => {
  let paused = false;
  let reads = 0;
  const f = createFixture(t, () => { reads += 1; return paused; });
  const terminal = f.manager.create({ workspaceId: "ws-1" });
  const pty = spawned.at(-1)!;
  paused = true;
  f.manager.write(terminal.id, "echo still-running\r");
  f.manager.resize(terminal.id, 80, 24);
  assert.deepEqual(pty.writes, ["echo still-running\r"]);
  assert.deepEqual(pty.sizes, [[80, 24]]);
  assert.equal(f.manager.list("ws-1")[0].status, "running");
  assert.equal(f.manager.get(terminal.id)?.status, "running");
  assert.equal(pty.kills, 0);
  assert.equal(f.manager.close(terminal.id), true);
  assert.equal(pty.kills, 1);
  assert.deepEqual(f.manager.list("ws-1"), []);
  assert.equal(reads, 1);
});

test("omitting the optional admission callback preserves terminal creation", (t) => {
  const f = createFixture(t);
  const terminal = f.manager.create({ workspaceId: "ws-1" });
  assert.equal(terminal.status, "running");
  assert.equal(f.spawnCount(), 1);
  assert.equal(f.created.length, 1);
});
