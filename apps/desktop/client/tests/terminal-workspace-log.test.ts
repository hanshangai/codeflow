import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test, { mock } from "node:test";
import type { WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import type { TerminalManagerDeps } from "../src/terminal/terminalManager.js";
import { writeTerminalActions } from "../src/terminal/terminalActionsConfig.js";

type FakePty = { process: string; kills: number; writes: string[]; writeFailure: { reason: unknown } | null;
  killFailure: { reason: unknown } | null; data: (text: string) => void; exit: (code: number) => void };
const spawned: FakePty[] = [];
const nativePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
mock.method(nativePty, "spawn", () => {
  const pty: FakePty = { process: "powershell.exe", kills: 0, writes: [], writeFailure: null, killFailure: null, data() {}, exit() {} };
  spawned.push(pty);
  return { get process() { return pty.process; }, onData(listener: FakePty["data"]) { pty.data = listener; return { dispose() {} }; },
    onExit(listener: (event: { exitCode: number }) => void) { pty.exit = code => listener({ exitCode: code }); return { dispose() {} }; },
    write(text: string) { if (pty.writeFailure) throw pty.writeFailure.reason; pty.writes.push(text); }, resize() {},
    kill() { pty.kills++; if (pty.killFailure) throw pty.killFailure.reason; } } as any;
});
const { TerminalManager } = await import("../src/terminal/terminalManager.js");
const { handleTerminalMessage } = await import("../src/app/handlers/terminalHandlers.js");

/** 实际固定日志与两工作区注册，只替换本机 PTY 边界。 */
function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-workspace-log-"));
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  const workspaces = new Map<string, string>();
  for (const name of ["a", "b"]) {
    const directory = path.join(root, name); fs.mkdirSync(directory); workspaces.set(name, directory);
    db.workspaces.upsert({ id: name as WorkspaceId, title: name, path: directory });
  }
  const reported: unknown[] = [];
  const deps: TerminalManagerDeps = { workspaces, writeWorkspaceLog: db.writeWorkspaceLog,
    onCreated() {}, onOutput() {}, onExited() {}, onError(error) { reported.push(error); } };
  const manager = new TerminalManager(deps);
  t.after(() => { for (const pty of spawned) pty.killFailure = null; try { manager.dispose(); } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); } });
  /** 经原 create 入口启动并返回本次唯一 PTY。 */
  function create(workspaceId = "a") { const terminal = manager.create({ workspaceId, requestId: `create-${workspaceId}`, shell: "powershell.exe" }); return { terminal, pty: spawned.at(-1)! }; }
  return { root, db, deps, manager, reported, create };
}

/** 只遍历测试已知的聚合容器，未知业务对象仅比较身份。 */
function contains(value: unknown, expected: unknown): boolean {
  if (value === expected) return true;
  return value instanceof AggregateError && value.errors.some(child => contains(child, expected));
}

test("PTY失败只写原entry工作区固定日志，业务错与日志错共同向调用者失败", t => {
  const f = fixture(t), { terminal, pty } = f.create("b");
  const business = new Error("authorization=Bearer synthetic-private-token");
  pty.writeFailure = { reason: business };
  assert.throws(() => f.manager.write(terminal.id, "input"), error => error === business);
  const directory = path.join(f.root, "b", ".codeflowai");
  const text = fs.readdirSync(directory).filter(name => name.endsWith(".log")).map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("");
  assert.match(text, /TERMINAL_WRITE_FAILED/);
  assert.equal(text.includes("synthetic-private-token"), false);
  assert.equal(fs.existsSync(path.join(f.root, "a", ".codeflowai")), false);
  const logFailure = new Error("fixed-writer-failed");
  f.deps.writeWorkspaceLog = () => { throw logFailure; };
  assert.throws(() => f.manager.write(terminal.id, "input"), error => contains(error, business) && contains(error, logFailure));
});

test("PTY输出timer失败停止后续动作，原退出事实仍更新并由dispose消费投递再失败", t => {
  const f = fixture(t), { terminal, pty } = f.create();
  const business = undefined, logging = new Error("fixed-log-failed"), delivery = new Error("terminal-error-delivery-failed");
  f.deps.onOutput = () => { throw business; };
  f.deps.writeWorkspaceLog = () => { throw logging; };
  f.deps.onError = error => { f.reported.push(error); throw delivery; };
  pty.data("buffered");
  assert.doesNotThrow(() => t.mock.timers.tick(16));
  assert.equal(f.reported.length, 1);
  assert.equal(pty.kills, 1);
  assert.throws(() => f.manager.write(terminal.id, "blocked"), error => contains(error, business) && contains(error, logging) && contains(error, delivery));
  assert.doesNotThrow(() => pty.exit(9));
  assert.equal(f.manager.get(terminal.id)?.status, "exited");
  assert.equal(f.manager.get(terminal.id)?.exitCode, 9);
  assert.throws(() => f.manager.dispose(), error => contains(error, business) && contains(error, logging) && contains(error, delivery));
  assert.equal(f.manager.get(terminal.id), null);
});

test("PTY dispose收齐各entry清理错误，失败owner保留供重试", t => {
  const f = fixture(t), first = f.create("a"), second = f.create("b");
  const firstFailure = 0, secondFailure = new Error("second-kill-failed"), logging = new Error("fixed-log-failed");
  first.pty.killFailure = { reason: firstFailure }; second.pty.killFailure = { reason: secondFailure };
  f.deps.writeWorkspaceLog = () => { throw logging; };
  assert.throws(() => f.manager.dispose(), error => contains(error, firstFailure) && contains(error, secondFailure) && contains(error, logging));
  assert.equal(first.pty.kills, 1); assert.equal(second.pty.kills, 1);
  assert.ok(f.manager.get(first.terminal.id)); assert.ok(f.manager.get(second.terminal.id));
  first.pty.killFailure = null; second.pty.killFailure = null;
  f.deps.writeWorkspaceLog = f.db.writeWorkspaceLog;
  f.manager.dispose();
});

test("PTY延迟动作归entry管理，关闭即取消且timer写入失败显式保留", t => {
  const f = fixture(t);
  const first = f.create();
  f.manager.scheduleCommand(first.terminal.id, "must-not-run", 500);
  f.manager.close(first.terminal.id);
  t.mock.timers.tick(500);
  assert.deepEqual(first.pty.writes, []);
  const second = f.create("b"), business = new Error("delayed-write-failed");
  second.pty.writeFailure = { reason: business };
  f.manager.scheduleCommand(second.terminal.id, "command", 500);
  t.mock.timers.tick(500);
  assert.equal(f.reported.length, 1);
  assert.throws(() => f.manager.close(second.terminal.id), error => contains(error, business));
  assert.equal(f.manager.get(second.terminal.id), null);
});

test("PTY自然退出收齐末段输出和通知失败，状态先记录真实退出且不重复kill", t => {
  const f = fixture(t), { terminal, pty } = f.create();
  const output = 0, exiting = new Error("exit-delivery-failed"), logging = false;
  f.deps.onOutput = () => { throw output; };
  f.deps.onExited = () => { throw exiting; };
  f.deps.writeWorkspaceLog = () => { throw logging; };
  pty.data("last-output");
  assert.doesNotThrow(() => pty.exit(13));
  assert.equal(f.manager.get(terminal.id)?.status, "exited");
  assert.equal(f.manager.get(terminal.id)?.exitCode, 13);
  assert.equal(pty.kills, 0);
  assert.equal(f.reported.length, 1);
  assert.throws(() => f.manager.close(terminal.id), error => contains(error, output) && contains(error, exiting) && contains(error, logging));
  assert.equal(f.manager.get(terminal.id), null);
});

test("PTY诊断不执行异常getter，descriptor反射再错保留原业务对象", t => {
  const f = fixture(t), { terminal, pty } = f.create();
  let getters = 0;
  const original = Object.defineProperty(new Error("test"), "message", { get() { getters++; throw new Error("getter-must-not-run"); } });
  pty.writeFailure = { reason: original };
  assert.throws(() => f.manager.write(terminal.id, "input"), error => error === original);
  assert.equal(getters, 0);
  const reflection = new Error("descriptor-failed");
  const proxy = new Proxy(original, { getOwnPropertyDescriptor() { throw reflection; } });
  pty.writeFailure = { reason: proxy };
  assert.throws(() => f.manager.write(terminal.id, "input"), error => contains(error, proxy) && contains(error, reflection));
  assert.equal(getters, 0);
});

test("PTY更新停止清理已失败entry后仍拒绝，原后台失败不会变为更新成功", async t => {
  const f = fixture(t), { terminal, pty } = f.create();
  const failure = new Error("background-output-failed");
  f.deps.onOutput = () => { throw failure; };
  pty.data("last-output"); t.mock.timers.tick(16); pty.exit(1);
  await assert.rejects(f.manager.stopAllForUpdate({ requestId: "consume-pty-failure" }), error => error === failure);
  assert.equal(f.manager.get(terminal.id), null);
  await f.manager.stopAllForUpdate({ requestId: "clean-retry" });
});

test("runAction原handler将命令交给entry，关闭取消后没有孤儿timer", t => {
  const f = fixture(t);
  writeTerminalActions(f.deps.workspaces.get("a")!, [{ id: "run", label: "运行", command: "must-not-run", shell: "powershell.exe",
    cwd: null, icon: null, color: null, order: 0, autoRun: false, enabled: true }]);
  const responses: unknown[] = [];
  handleTerminalMessage({ terminalManager: f.manager, workspaces: f.deps.workspaces as Map<WorkspaceId, string>,
    send: message => { responses.push(message); } }, { t: "terminal.runAction", workspaceId: "a", actionId: "run", requestId: "run-action" });
  const terminal = f.manager.list("a")[0]!;
  assert.ok(terminal);
  const pty = spawned.at(-1)!;
  f.manager.close(terminal.id); t.mock.timers.tick(500);
  assert.deepEqual(pty.writes, []);
  assert.deepEqual(responses, []);
});

test("终端原handler隔离同步PTY失败，明确错误响应且响应拒绝保原业务错", t => {
  const f = fixture(t), { terminal, pty } = f.create();
  const business = new Error("input-failed"); pty.writeFailure = { reason: business };
  const responses: any[] = [];
  const deps = { terminalManager: f.manager, workspaces: f.deps.workspaces as Map<WorkspaceId, string>,
    send(message: unknown): { accepted: boolean } { responses.push(message); return { accepted: true }; } };
  const input = { t: "terminal.input" as const, terminalId: terminal.id, workspaceId: "a", data: "input" };
  assert.doesNotThrow(() => handleTerminalMessage(deps, input));
  assert.equal(responses.length, 1); assert.equal(responses[0].t, "terminal.error");
  assert.equal(responses[0].terminalId, terminal.id);
  deps.send = message => { responses.push(message); return { accepted: false }; };
  assert.throws(() => handleTerminalMessage(deps, input), error => contains(error, business));
  assert.equal(responses.length, 2);
});

test("已创建PTY沿原entry固定W写日志，运行Map移除后也不退应用日志", t => {
  const f = fixture(t), { terminal, pty } = f.create("b");
  const logged: string[] = [], failure = new Error("write-after-workspace-map-removal");
  f.deps.writeWorkspaceLog = workspaceId => { logged.push(workspaceId); };
  f.deps.workspaces.delete("b"); pty.writeFailure = { reason: failure };
  assert.throws(() => f.manager.write(terminal.id, "input"), error => error === failure);
  assert.deepEqual(logged, ["b"]);
});
