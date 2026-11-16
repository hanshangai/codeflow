import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DesktopBridgeApi, DesktopEvent, DesktopUpdateDiagnostics } from "@codeflowai/shared";
import type { DesktopUpdateFailureRecord } from "@codeflowai/shared/desktop-update-failure";
import type { ClientRuntime } from "../src/clientRuntime.js";
import { createDesktopApplication, type DesktopHost } from "../src/desktopApplication.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";

const deviceId = "868683b1-e79b-4509-9ca1-97b7786e5344";
const foreignDevice = "f163c0d0-607d-4136-bc19-a41a9c543c14";
const context = { deviceId, shellVersion: "1.0.0", currentReleaseId: "installation", webVersion: "1.0.0", clientVersion: "1.0.0" };
const bindingInput = { ...context, requestId: "binding-1", releaseId: "next", phase: "verify", recovery: "not_needed" as const };

/** 使用真实日志和独占临时目录，不接触真实身份或网络。 */
async function fixture(t: test.TestContext) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-update-diagnostics-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, journal: createUpdateFailureJournal(dataDir) };
}

/** 缺能力时明确 RED，返回结果继续按真实历史与 ACK 验证。 */
function diagnostics(journal: ReturnType<typeof createUpdateFailureJournal>, device: string) {
  const method = (journal as unknown as { diagnostics?: (device: string) => Array<{ record: DesktopUpdateFailureRecord; reported: boolean }> }).diagnostics;
  assert.equal(typeof method, "function", "journal must expose current-device diagnostics");
  return method!(device);
}

test("diagnostics retains acknowledged mixed history after reopening and isolates the current device", async t => {
  const { dataDir, journal } = await fixture(t);
  const binding = journal.record({ ...bindingInput, error: new Error("DESKTOP_RELEASE_SIGNATURE_INVALID") });
  await journal.flush(deviceId, async record => record);
  const shell = journal.recordShell({ ...context, requestId: "shell-1", shellId: null, phase: "prepare", recovery: "not_needed",
    error: new Error("DESKTOP_SHELL_NETWORK_FAILED: token=PRIVATE_SECRET") });
  journal.record({ ...bindingInput, deviceId: foreignDevice, error: new Error("EIO") });
  const before = await fs.readFile(path.join(dataDir, "errors.jsonl"));
  const result = diagnostics(createUpdateFailureJournal(dataDir), deviceId);
  assert.deepEqual(result, [{ record: binding, reported: true }, { record: shell, reported: false }]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/);
  result[0]!.record.rootCause.code = "MUTATED";
  assert.deepEqual(diagnostics(journal, deviceId), [{ record: binding, reported: true }, { record: shell, reported: false }]);
  assert.deepEqual(await fs.readFile(path.join(dataDir, "errors.jsonl")), before);
  assert.deepEqual(await fs.readdir(dataDir), ["errors.jsonl"]);
});

test("only an exact ACK changes a diagnostic to reported without deleting its recovery evidence", async t => {
  const { dataDir, journal } = await fixture(t);
  const record = journal.record({ ...bindingInput, recovery: "restored", error: new Error("EIO") });
  const before = await fs.readFile(path.join(dataDir, "errors.jsonl"));
  await assert.rejects(journal.flush(deviceId, async value => ({ ...value, payloadSha256: "0".repeat(64) })), /DESKTOP_UPDATE_ACK_MISMATCH/);
  assert.deepEqual(diagnostics(journal, deviceId), [{ record, reported: false }]);
  assert.deepEqual(await fs.readFile(path.join(dataDir, "errors.jsonl")), before);
  await journal.flush(deviceId, async value => value);
  assert.deepEqual(diagnostics(createUpdateFailureJournal(dataDir), deviceId), [{ record, reported: true }]);
});

test("an absent diagnostic journal is empty without creating any file", async t => {
  const { dataDir, journal } = await fixture(t);
  assert.deepEqual(diagnostics(journal, deviceId), []);
  assert.deepEqual(await fs.readdir(dataDir), []);
});

for (const invalid of ["foreign-row", "wrong-ack", "invalid-utf8"] as const) {
  test(`diagnostics refuses ${invalid} rather than returning partial history`, async t => {
    const { dataDir, journal } = await fixture(t);
    const record = journal.record({ ...bindingInput, error: new Error("EIO") });
    const bad = invalid === "invalid-utf8" ? Buffer.from([0xff]) : JSON.stringify(invalid === "foreign-row"
      ? { kind: "failure", deviceId: foreignDevice }
      : { schemaVersion: 1, kind: "ack", errorId: record.errorId, deviceId, payloadSha256: "0".repeat(64) }) + "\n";
    await fs.appendFile(path.join(dataDir, "errors.jsonl"), bad);
    assert.throws(() => diagnostics(journal, deviceId), invalid === "invalid-utf8" ? /encoded data|encoding/iu : /DESKTOP_UPDATE_JOURNAL_INVALID/);
  });
}

/** 应用只替换窗口/运行时；身份和日志仍走真实入口，查询不得调用 Client。 */
async function applicationFixture(t: test.TestContext, start = true) {
  const f = await fixture(t), identity = await loadOrCreateDeviceIdentity(f.dataDir);
  let bridge!: DesktopBridgeApi;
  const actions: string[] = [];
  const runtime: ClientRuntime = {
    start: async () => {}, waitReady: async () => {}, stop: async () => {}, drain: async () => { actions.push("drain"); },
    request: async () => { assert.fail("diagnostics must not call Client"); },
    onEvent: (_listener: (event: DesktopEvent) => void) => () => {},
    snapshot: () => ({ status: "ready", requestId: null, releaseId: null, errorCode: null, pid: 123,
      health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } }),
  };
  const window = Object.assign(new EventEmitter(), { show() {}, focus() {}, hide() {}, destroy() {} });
  const host: DesktopHost = { createWindow: () => window, loadWeb: async () => {}, createTray: () => ({ destroy() {} }),
    registerBridge: value => { bridge = value; return () => {}; }, quit() {} };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host, createRuntime: () => runtime });
  if (start) { await app.start(); t.after(() => app.exit()); }
  return { ...f, identity, actions, bridge, app, runtime };
}

test("the application exposes only current-device diagnostics without runtime, network or file side effects", async t => {
  const f = await applicationFixture(t);
  const record = f.journal.record({ ...bindingInput, deviceId: f.identity.deviceId, error: new Error("EIO") });
  f.journal.record({ ...bindingInput, error: new Error("EIO") });
  const get = (f.bridge as { getUpdateDiagnostics?: () => Promise<DesktopUpdateDiagnostics> }).getUpdateDiagnostics;
  assert.equal(typeof get, "function", "application must expose fixed diagnostics");
  const files = await fs.readdir(f.dataDir), before = await fs.readFile(path.join(f.dataDir, "errors.jsonl"));
  assert.deepEqual(await get!(), { deviceId: f.identity.deviceId, failures: [{ record, reported: false }] });
  assert.deepEqual(f.actions, []);
  assert.deepEqual(await fs.readdir(f.dataDir), files);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, "errors.jsonl")), before);
  await assert.rejects(f.bridge.request({ method: "runtime.update.prepare" } as never), /DESKTOP_UPDATE_CONTROL_FORBIDDEN/);
});

test("a diagnostic read remains available while an existing lifecycle operation holds its lock", async t => {
  const f = await applicationFixture(t);
  let release!: () => void, entered!: () => void;
  const draining = new Promise<void>(resolve => { entered = resolve; });
  const get = (f.bridge as { getUpdateDiagnostics?: () => Promise<DesktopUpdateDiagnostics> }).getUpdateDiagnostics;
  assert.equal(typeof get, "function", "diagnostics must be independent of the operation lock");
  f.runtime.drain = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
  const exiting = f.app.exit(); await draining;
  try { assert.deepEqual(await get!(), { deviceId: f.identity.deviceId, failures: [] }); }
  finally { release(); await exiting; f.runtime.drain = async () => {}; }
});

test("identity not ready explicitly rejects diagnostics instead of impersonating an empty device", async t => {
  const f = await applicationFixture(t, false);
  const get = (f.app as { getUpdateDiagnostics?: () => Promise<DesktopUpdateDiagnostics> }).getUpdateDiagnostics;
  assert.equal(typeof get, "function", "application must own diagnostics identity readiness");
  await assert.rejects(get!(), error => error instanceof Error && (error as Error & { code?: string }).code === "DESKTOP_UPDATE_DIAGNOSTICS_FAILED");
  assert.deepEqual(f.actions, []);
});

test("corrupt journal failures retain a structured root code without returning partial diagnostics", async t => {
  const f = await applicationFixture(t);
  await fs.writeFile(path.join(f.dataDir, "errors.jsonl"), "PRIVATE_INVALID_JSON\n", "utf8");
  await assert.rejects(f.bridge.getUpdateDiagnostics!(), error => {
    assert.ok(error instanceof Error);
    assert.equal((error.cause as { code?: string }).code, "DESKTOP_UPDATE_JOURNAL_INVALID");
    return true;
  });
});

for (const cause of [Object.assign(new Error("controlled disk failure"), { code: "EACCES" }), false, null, undefined, 0, ""]) {
  test(`application preserves ${cause instanceof Error ? "EACCES" : String(cause)} disk cause and the actual device`, async t => {
    const f = await applicationFixture(t), read = fsSync.readFileSync;
    t.mock.method(fsSync, "readFileSync", (...args: Parameters<typeof fsSync.readFileSync>) => {
      if (args[0] === path.join(f.dataDir, "errors.jsonl")) throw cause;
      return read(...args);
    });
    const get = (f.bridge as { getUpdateDiagnostics?: () => Promise<DesktopUpdateDiagnostics> }).getUpdateDiagnostics;
    assert.equal(typeof get, "function", "diagnostic read failures must reject");
    await assert.rejects(get!(), error => {
      assert.ok(error instanceof Error); assert.equal(error.cause, cause);
      assert.equal((error as Error & { code?: string }).code, "DESKTOP_UPDATE_DIAGNOSTICS_FAILED");
      assert.equal((error as Error & { deviceId?: string }).deviceId, f.identity.deviceId);
      return true;
    });
    assert.deepEqual(f.actions, []);
  });
}
