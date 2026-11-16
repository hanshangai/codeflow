import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test, { mock } from "node:test";
import { openClientDb } from "../src/db/clientDb.js";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.js";
import * as terminalEvents from "../src/terminal/localTerminalEvents.js";

const nativePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
const ptys: Array<{ writes: string[]; output: (data: string) => void }> = [];
mock.method(nativePty, "spawn", () => {
  const pty = { writes: [] as string[], output(_data: string) {} };
  ptys.push(pty);
  return { process: "powershell.exe", onData(listener: (data: string) => void) { pty.output = listener; return { dispose() {} }; },
    onExit() { return { dispose() {} }; }, write(data: string) { pty.writes.push(data); }, resize() {}, kill() {} } as any;
});
const { TerminalManager } = await import("../src/terminal/terminalManager.js");
const { executeDesktopApiRequest } = await import("../src/app/executeDesktopApiRequest.js");
const terminalHandlers = await import("../src/app/handlers/terminalHandlers.js");

/** 使用真实终端管理器与SQLite；可启用真实 Writer 许可，仅替换系统 PTY 边界。 */
function fixture(t: test.TestContext, linked: boolean, coordinated = false) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-terminal-routing-"));
  const application = openClientDb({ dbPath: path.join(root, "application.db") });
  const workspaceId = "local-client:workspace" as any, events: any[] = [];
  application.workspaces.upsert({ id: workspaceId, title: "Local", path: root });
  const workspaces = new Map([[workspaceId, root]]);
  const manager = new TerminalManager({ workspaces, writeWorkspaceLog: application.writeWorkspaceLog,
    persistence: coordinated ? {
      save: config => application.forWorkspace(config.workspaceId).terminalConfigs.insert(config),
      remove: (id, idWorkspace) => { application.forWorkspace(idWorkspace).terminalConfigs.delete(id); },
      updateLabel: (id, label, idWorkspace) => application.forWorkspace(idWorkspace).terminalConfigs.updateLabel(id, label),
      listByWorkspace: idWorkspace => application.forWorkspace(idWorkspace).terminalConfigs.listByWorkspace(idWorkspace),
    } : undefined,
    onError(error) { throw error; }, onOutput(terminal, data) { events.push(terminalEvents.toDesktopTerminalEvent({ t: "terminal.output", workspaceId, terminalId: terminal.id, data }, "local-client")); },
    onCreated(terminal, requestId) { events.push(terminalEvents.toDesktopTerminalEvent({ t: "terminal.created", terminal, requestId }, "local-client")); }, onExited() {} });
  const context = { db: application.forWorkspace(workspaceId), clientId: "local-client", workspaces, terminalManager: manager,
    publishTerminalEvent(event: unknown) { events.push(event); }, desktopCloudAccount: linked ? { getOwner: () => ({ ownerUserId: "owner" }) } : undefined,
    send() { assert.fail("local terminal must not use the server API response channel"); } } as any;
  const writer = coordinated ? new ClientDbWriterService({ db: application, dbPath: path.join(root, "application.db"), onFatalError(error) { throw error; } }) : undefined;
  if (writer) context.withDatabase = <T>(id: string, operation: () => T) => writer.withLegacyDatabase(id, operation);
  t.after(async () => { try { await writer?.close(); } finally { try { manager.dispose(); } finally { application.close(); fs.rmSync(root, { recursive: true, force: true }); } } });
  return { application, writer, manager, events, workspaceId, workspaces,
    /** 经过既有可信校验及本机控制处理器。 */
    call(method: string, body: Record<string, unknown>) {
      return executeDesktopApiRequest(context, { method, body } as any, { requestId: `${method}-test`, startedAt: 1, clientVersion: "1.0.0" });
    } };
}

test("terminal.list 在真实 Writer 许可内恢复配置且并发或已有终端不重复启动", async t => {
  const f = fixture(t, false, true), writer = f.writer!;
  await writer.ready();
  await writer.withLegacyDatabase("seed-terminal", () => f.application.forWorkspace(f.workspaceId).terminalConfigs.insert({
    id: "persisted-terminal", workspaceId: f.workspaceId, label: "恢复终端", shell: "powershell.exe", cwd: ".",
  }));
  assert.throws(() => f.application.forWorkspace(f.workspaceId).terminalConfigs.listByWorkspace(f.workspaceId), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
  const before = ptys.length;
  const [response, concurrent] = await Promise.all([
    f.call("terminal.list", { workspaceId: f.workspaceId, requestId: "restore-terminal" }),
    f.call("terminal.list", { workspaceId: f.workspaceId, requestId: "restore-terminal-concurrent" }),
  ]);
  assert.equal(response.status, 200);
  assert.equal(concurrent.status, 200);
  assert.equal(ptys.length, before + 1);
  assert.equal((response.body as any).terminals.length, 1);
  assert.equal((response.body as any).terminals[0].label, "恢复终端");
  assert.equal((response.body as any).terminals[0].clientId, "local-client");
  assert.equal(f.events.filter(event => event.t === "terminal.created").length, 1);
  const configs = await writer.withLegacyDatabase("verify-terminal", () => f.application.forWorkspace(f.workspaceId).terminalConfigs.listByWorkspace(f.workspaceId));
  assert.equal(configs.length, 1);
  assert.equal(configs[0].id, (response.body as any).terminals[0].id);
  const repeated = await f.call("terminal.list", { workspaceId: f.workspaceId });
  assert.equal(repeated.status, 200);
  assert.equal(ptys.length, before + 1);
  assert.equal((repeated.body as any).terminals[0].id, configs[0].id);
});

test("terminal.list 持久化读取失败显式拒绝且不启动进程", async t => {
  const f = fixture(t, false, true), writer = f.writer!;
  await writer.ready();
  await writer.withLegacyDatabase("break-terminal-storage", () => f.application.forWorkspace(f.workspaceId).db.exec("DROP TABLE terminal_configs"));
  const before = ptys.length;
  await assert.rejects(f.call("terminal.list", { workspaceId: f.workspaceId }), /WORKSPACE_ADDITIONAL_SCHEMA_INVALID:terminal_configs/u);
  assert.equal(ptys.length, before);
  assert.equal(f.events.length, 0);
  assert.equal(f.manager.list(f.workspaceId).length, 0);
  assert.equal(await writer.withLegacyDatabase("verify-workspace", () => f.application.workspaces.get(f.workspaceId)?.title), "Local");
});

for (const linked of [false, true]) {
  test(`账号关联=${linked}时真实TerminalManager创建、输入、输出仅一次`, async t => {
    const f = fixture(t, linked);
    const created = await f.call("terminal.create", { workspaceId: f.workspaceId, shell: "powershell.exe", requestId: "create-1" });
    assert.equal(created.status, 200);
    const terminalId = (created.body as any).terminal.id, pty = ptys.at(-1)!;
    assert.equal((await f.call("terminal.input", { workspaceId: f.workspaceId, terminalId, data: "one" })).status, 200);
    assert.deepEqual(pty.writes, ["one"]);
    pty.output("output"); t.mock.timers.tick(16);
    assert.equal(f.events.filter(event => event.t === "terminal.created").length, 1);
    assert.deepEqual(f.events.filter(event => event.t === "terminal.output").map(event => event.data), ["output"]);
    assert.equal((await f.call("terminal.input", { workspaceId: "other-client:workspace", terminalId, data: "forbidden" })).status, 403);
    assert.deepEqual(pty.writes, ["one"]);
  });
}

test("桌面事件始终先投本机，云副本被拒绝交由云模块显式失败", () => {
  const route = (terminalEvents as any).publishTerminalRuntimeMessage;
  assert.equal(typeof route, "function");
  const delivered: string[] = [], failures: Error[] = [];
  const message = { t: "terminal.output", workspaceId: "local-client:workspace", terminalId: "term", data: "one" };
  route(message, { clientId: "local-client", publishLocal() { delivered.push("local"); }, cloud: {
    send() { delivered.push("cloud"); return { accepted: false, reason: "disconnected" }; },
    fail(error: Error) { failures.push(error); },
  } });
  assert.deepEqual(delivered, ["local", "cloud"]);
  assert.equal((failures[0] as any).code, "TERMINAL_CLOUD_EVENT_REJECTED");
  assert.equal((failures[0] as any).terminalId, "term");
  assert.equal((failures[0] as any).workspaceId, "local-client:workspace");
  delivered.length = 0;
  assert.throws(() => route(message, { clientId: "local-client", publishLocal() { throw new Error("local failed"); }, cloud: {
    send() { delivered.push("cloud"); return { accepted: true }; }, fail() { assert.fail("unexpected cloud failure"); },
  } }), /local failed/);
  assert.deepEqual(delivered, []);
});

test("云账号终端入口沿原handler执行且拒绝过期账号与未知工作区", async t => {
  const f = fixture(t, true);
  const created = await f.call("terminal.create", { workspaceId: f.workspaceId, shell: "powershell.exe" });
  assert.equal(created.status, 200);
  const terminalId = (created.body as any).terminal.id, pty = ptys.at(-1)!;
  const handleCloud = (terminalHandlers as any).handleDesktopCloudTerminalMessage;
  assert.equal(typeof handleCloud, "function");
  const sent: any[] = [];
  let stale = false;
  const deps = { terminalManager: f.manager, workspaces: f.workspaces,
    assertOwner() { if (stale) throw new Error("stale owner"); },
    send(message: any) { terminalEvents.publishTerminalRuntimeMessage(message, { clientId: "local-client", publishLocal(event) { f.events.push(event); },
      cloud: { send(outbound) { sent.push(outbound); return { accepted: true }; }, fail(error) { throw error; } } }); },
  };
  handleCloud(deps, { t: "terminal.input", workspaceId: f.workspaceId, terminalId, data: "remote" });
  assert.deepEqual(pty.writes, ["remote"]);
  handleCloud(deps, { t: "terminal.rename", workspaceId: f.workspaceId, terminalId, label: "remote label" });
  assert.equal(f.manager.get(terminalId)?.label, "remote label");
  assert.equal(f.events.filter(event => event.t === "terminal.renamed").length, 1);
  assert.equal(sent.filter(event => event.t === "terminal.renamed").length, 1);
  assert.throws(() => handleCloud(deps, { t: "terminal.input", workspaceId: "foreign:workspace", terminalId, data: "forbidden" }),
    (error: any) => error.code === "DESKTOP_CLOUD_TERMINAL_SCOPE_REQUIRED");
  stale = true;
  assert.throws(() => handleCloud(deps, { t: "terminal.input", workspaceId: f.workspaceId, terminalId, data: "stale" }), /stale owner/);
  assert.deepEqual(pty.writes, ["remote"]);
});
