import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { digestDesktopCrashReport, type DesktopCrashReport } from "@codeflowai/shared/desktop-crash-report";
import { createCrashReportJournal, readCrashSessionMarker, writeCrashCleanMarker, writeCrashSessionMarker } from "../src/crashReportJournal.js";
import { createDesktopCrashCapture } from "../src/crashReportCapture.js";

const deviceId = "868683b1-e79b-4509-9ca1-97b7786e5344";
const sessionId = "ad0f2a9e-3d9b-4f1a-8f7c-2b0e7e1f8c11";

/** 仅使用独立临时目录，禁止接触真实设备、日志或待报证据。 */
async function fixture(t: test.TestContext) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "desktop-crash-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** 共享严格合同生成有效报告，测试只覆盖单字段。 */
function report(overrides: Partial<Omit<DesktopCrashReport, "payloadSha256">> = {}): DesktopCrashReport {
  const payload = {
    schemaVersion: 1 as const, kind: "crash" as const, reportId: crypto.randomUUID(), deviceId, sessionId,
    sessionStartedAt: "2026-01-01T00:00:00.000Z", event: "renderer_process_gone" as const, processType: "renderer" as const,
    reason: "crashed" as const, exitCode: 3, occurredAt: "2026-01-01T00:00:10.000Z", detectedAt: "2026-01-01T00:00:10.000Z",
    phase: null, errorCode: null, requestId: null, causeCodes: [], recentErrors: [],
    versions: { shellVersion: "1.0.0", webVersion: "1.0.0", clientVersion: "1.0.0", releaseId: null, shellId: null },
    platform: "win32" as const, arch: "x64" as const, ...overrides,
  };
  return { ...payload, payloadSha256: digestDesktopCrashReport(payload) };
}

/** 日志入口自行生成 ID 与摘要；测试从完整报告去掉摘要后派生可写草稿。 */
function draft(overrides: Partial<Omit<DesktopCrashReport, "payloadSha256" | "reportId">> = {}): Omit<DesktopCrashReport, "payloadSha256"> {
  const { payloadSha256: _digest, ...value } = report(overrides);
  return { ...value, reportId: crypto.randomUUID() };
}

test("crash journal reopens exact evidence and acknowledges each report once", async t => {
  const directory = await fixture(t), journal = createCrashReportJournal(directory);
  const first = journal.record(draft());
  const second = journal.record(draft());
  assert.deepEqual(createCrashReportJournal(directory).pending(deviceId), [first, second]);
  const sent: DesktopCrashReport[] = [];
  await createCrashReportJournal(directory).flush(deviceId, async record => {
    sent.push(record);
    return { reportId: record.reportId, deviceId: record.deviceId!, payloadSha256: record.payloadSha256 };
  });
  assert.deepEqual(sent, [first, second]);
  assert.deepEqual(journal.pending(deviceId), []);
  await journal.flush(deviceId, async () => { assert.fail("acknowledged reports must not be resent"); });
  const lines = fs.readFileSync(path.join(directory, "crash-reports.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 4);
});

test("crash journal keeps pending evidence on wrong acknowledgement or failed send", async t => {
  const directory = await fixture(t), journal = createCrashReportJournal(directory);
  const first = journal.record(draft());
  const file = path.join(directory, "crash-reports.jsonl"), before = fs.readFileSync(file);
  for (const wrong of [{ reportId: crypto.randomUUID(), deviceId, payloadSha256: first.payloadSha256 },
    { reportId: first.reportId, deviceId: crypto.randomUUID(), payloadSha256: first.payloadSha256 },
    { reportId: first.reportId, deviceId, payloadSha256: "0".repeat(64) }]) {
    await assert.rejects(() => journal.flush(deviceId, async () => wrong), /DESKTOP_CRASH_ACK_MISMATCH/);
    assert.deepEqual(fs.readFileSync(file), before);
  }
  const original = new Error("controlled crash send failure");
  await assert.rejects(() => journal.flush(deviceId, async () => { throw original; }), error => error === original);
  assert.deepEqual(journal.pending(deviceId), [first]);
  await journal.flush(crypto.randomUUID(), async () => { assert.fail("foreign identity must not send"); });
});

test("crash journal caps pending evidence at twenty and drops the oldest entry", async t => {
  const directory = await fixture(t), journal = createCrashReportJournal(directory);
  const reports = Array.from({ length: 21 }, (_, index) => journal.record(draft({
    occurredAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    detectedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
  })));
  const pending = journal.pending(deviceId);
  assert.equal(pending.length, 20);
  assert.equal(pending[0]!.reportId, reports[1]!.reportId);
  assert.equal(pending.at(-1)!.reportId, reports.at(-1)!.reportId);
  assert.equal(journal.pendingCount(), 20);
});

test("crash during delivery keeps every acknowledgement attached to its evidence", async t => {
  const directory = await fixture(t), journal = createCrashReportJournal(directory);
  for (let index = 0; index < 20; index++) journal.record(draft());
  let injected = false;
  await journal.flush(deviceId, async record => {
    if (!injected) { injected = true; journal.record(draft()); }
    return { reportId: record.reportId, deviceId: record.deviceId!, payloadSha256: record.payloadSha256 };
  });
  const reopened = createCrashReportJournal(directory);
  assert.equal(reopened.pending(deviceId).length, 1);
  assert.equal(reopened.pendingCount(), 1);
});

test("crash journal refuses to skip a corrupt line", async t => {
  const directory = await fixture(t), journal = createCrashReportJournal(directory);
  journal.record(draft());
  fs.appendFileSync(path.join(directory, "crash-reports.jsonl"), '{"kind":"crash","payloadSha256":"bad"}\n');
  assert.throws(() => journal.pending(deviceId), /DESKTOP_CRASH_JOURNAL_INVALID/);
  assert.throws(() => journal.record(draft()), /DESKTOP_CRASH_JOURNAL_INVALID/);
  await assert.rejects(() => journal.flush(deviceId, async () => { assert.fail("corrupt journal must not send"); }), /DESKTOP_CRASH_JOURNAL_INVALID/);
  await assert.rejects(() => journal.flush(deviceId, async () => { assert.fail("corrupt journal must not send"); }), /DESKTOP_CRASH_JOURNAL_INVALID/);
});

test("crash journal compacts acknowledged history instead of growing without bound", async t => {
  const directory = await fixture(t), journal = createCrashReportJournal(directory);
  for (let index = 0; index < 205; index++) {
    const item = journal.record(draft());
    await journal.flush(deviceId, async () => ({ reportId: item.reportId, deviceId, payloadSha256: item.payloadSha256 }));
  }
  assert.equal(journal.pendingCount(), 0);
  const lines = fs.readFileSync(path.join(directory, "crash-reports.jsonl"), "utf8").trimEnd().split("\n");
  assert.ok(lines.length < 20, `journal must compact acknowledged history, got ${lines.length} lines`);
});

test("marker write failure removes the temporary file", async t => {
  const directory = await fixture(t);
  t.mock.method(fs, "writeFileSync", () => { throw new Error("disk full"); });
  assert.throws(() => writeCrashSessionMarker(directory, { schemaVersion: 1, sessionId, startedAt: "2026-01-01T00:00:00.000Z",
    deviceId, versions: { shellVersion: "1", webVersion: null, clientVersion: null, releaseId: null, shellId: null }, platform: "win32", arch: "x64" }),
  /disk full/);
  t.mock.restoreAll();
  assert.deepEqual(await fsp.readdir(directory), []);
});

test("capture reports an unclean previous session and a clean marker suppresses it", async t => {
  const directory = await fixture(t);
  writeCrashSessionMarker(directory, { schemaVersion: 1, sessionId, startedAt: "2026-01-01T00:00:00.000Z",
    deviceId, versions: { shellVersion: "1", webVersion: null, clientVersion: null, releaseId: null, shellId: null }, platform: "win32", arch: "x64" });
  const app = new EventEmitter(), capture = createDesktopCrashCapture({ dataDir: directory, app: app as never, shellVersion: "1.0.0" });
  t.after(() => capture.dispose());
  const result = capture.initialize();
  assert.equal(result.abnormal?.event, "abnormal_exit");
  assert.equal(result.abnormal?.errorCode, "DESKTOP_CRASH_ABNORMAL_EXIT");
  assert.equal(result.abnormal?.deviceId, deviceId);
  assert.equal(readCrashSessionMarker(directory)?.sessionId, result.sessionId);
  assert.notEqual(result.sessionId, sessionId);

  const cleanDirectory = await fixture(t);
  writeCrashSessionMarker(cleanDirectory, { schemaVersion: 1, sessionId, startedAt: "2026-01-01T00:00:00.000Z",
    deviceId, versions: { shellVersion: "1", webVersion: null, clientVersion: null, releaseId: null, shellId: null }, platform: "win32", arch: "x64" });
  writeCrashCleanMarker(cleanDirectory, sessionId);
  const cleanCapture = createDesktopCrashCapture({ dataDir: cleanDirectory, app: new EventEmitter() as never, shellVersion: "1.0.0" });
  t.after(() => cleanCapture.dispose());
  assert.equal(cleanCapture.initialize().abnormal, null);
  assert.equal(cleanCapture.journal.pending(deviceId).length, 0);
});

test("capture records renderer, GPU and Client exits without arbitrary error text", async t => {
  const directory = await fixture(t);
  fs.mkdirSync(path.join(directory, "logs"), { recursive: true });
  fs.writeFileSync(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId }));
  fs.writeFileSync(path.join(directory, "logs", "desktop-errors.jsonl"), `${JSON.stringify({
    at: "2026-01-01T00:00:01.000Z", errorCode: "DESKTOP_OPERATION_FAILED", requestId: "request-1",
    channel: "runtime", method: "workspaces.list", message: "PRIVATE_TOKEN", stack: "PRIVATE_STACK",
  })}\n`);
  const app = new EventEmitter(), capture = createDesktopCrashCapture({ dataDir: directory, app: app as never, shellVersion: "1.0.0" });
  t.after(() => capture.dispose());
  capture.initialize();
  app.emit("render-process-gone", {}, {}, { reason: "crashed", exitCode: 5 });
  app.emit("child-process-gone", {}, { type: "GPU", reason: "oom", exitCode: 9 });
  app.emit("child-process-gone", {}, { type: "Utility", reason: "clean-exit", exitCode: 0 });
  assert.equal(capture.reportClientExit({ exitCode: 0, signal: null, expected: false }), null);
  assert.equal(capture.reportClientExit({ exitCode: 7, signal: null, expected: true }), null);
  capture.reportClientExit({ exitCode: 7, signal: null, expected: false });
  const pending = capture.journal.pending(deviceId);
  assert.deepEqual(pending.map(record => [record.event, record.processType, record.reason, record.exitCode]), [
    ["renderer_process_gone", "renderer", "crashed", 5],
    ["child_process_gone", "gpu", "oom", 9],
    ["client_process_exit", "client", "crashed", 7],
  ]);
  assert.deepEqual(pending[0]!.recentErrors, [{ at: "2026-01-01T00:00:01.000Z", errorCode: "DESKTOP_OPERATION_FAILED",
    requestId: "request-1", channel: "runtime", method: "workspaces.list" }]);
  assert.doesNotMatch(fs.readFileSync(path.join(directory, "crash-reports.jsonl"), "utf8"), /PRIVATE_TOKEN|PRIVATE_STACK/);

  capture.expectExit();
  app.emit("render-process-gone", {}, {}, { reason: "killed", exitCode: 1 });
  assert.equal(capture.journal.pending(deviceId).length, 3);

  (process as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit("uncaughtExceptionMonitor",
    Object.assign(new Error("PRIVATE_EXCEPTION_TEXT"), { code: "DESKTOP_TEST_FAILED" }));
  const exception = capture.journal.pending(deviceId).find(record => record.event === "main_uncaught_exception");
  assert.equal(exception?.errorCode, "DESKTOP_TEST_FAILED");
  assert.doesNotMatch(fs.readFileSync(path.join(directory, "crash-reports.jsonl"), "utf8"), /PRIVATE_EXCEPTION_TEXT/);
});

test("recent errors survive a 64KB window that starts inside a multibyte character", async t => {
  const directory = await fixture(t);
  fs.writeFileSync(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId }));
  fs.mkdirSync(path.join(directory, "logs"), { recursive: true });
  const line = (pad: number) => `${JSON.stringify({ at: "2026-01-01T00:00:01.000Z", errorCode: "DESKTOP_TEST_FAILED",
    requestId: "request-1", channel: "runtime", method: "workspaces.list", pad: "x".repeat(pad) })}\n`;
  const base = line(0), pad = 65_533 - base.length * 12;
  assert.ok(pad > 0);
  // 总长 65537，窗口从“中”的第二个字节开始；旧实现会在 fatal 解码处整体失败。
  fs.writeFileSync(path.join(directory, "logs", "desktop-errors.jsonl"), `中\n${line(pad)}${base.repeat(11)}`);
  const app = new EventEmitter(), capture = createDesktopCrashCapture({ dataDir: directory, app: app as never, shellVersion: "1.0.0" });
  t.after(() => capture.dispose());
  capture.initialize();
  app.emit("render-process-gone", {}, {}, { reason: "crashed", exitCode: 2 });
  const [report] = capture.journal.pending(deviceId);
  assert.equal(report?.recentErrors.length, 12);
  assert.equal(report?.recentErrors[0]?.errorCode, "DESKTOP_TEST_FAILED");
});

test("capture keeps platform facts paired when one dimension is unsupported", async t => {
  const directory = await fixture(t);
  fs.writeFileSync(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId }));
  const app = new EventEmitter(), capture = createDesktopCrashCapture({ dataDir: directory, app: app as never, shellVersion: "1.0.0",
    platform: "linux", arch: "x64" });
  t.after(() => capture.dispose());
  capture.initialize();
  app.emit("render-process-gone", {}, {}, { reason: "crashed", exitCode: 2 });
  const [report] = capture.journal.pending(deviceId);
  assert.equal(report?.platform, null);
  assert.equal(report?.arch, null);
});

test("abnormal report falls back to the current installation identity", async t => {
  const directory = await fixture(t);
  fs.writeFileSync(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId }));
  writeCrashSessionMarker(directory, { schemaVersion: 1, sessionId, startedAt: "2026-01-01T00:00:00.000Z",
    deviceId: null, versions: { shellVersion: "1", webVersion: null, clientVersion: null, releaseId: null, shellId: null }, platform: "win32", arch: "x64" });
  const capture = createDesktopCrashCapture({ dataDir: directory, app: new EventEmitter() as never, shellVersion: "1.0.0" });
  t.after(() => capture.dispose());
  assert.equal(capture.initialize().abnormal?.deviceId, deviceId);
});

test("a failed abnormal report is retried on the next startup", async t => {
  const directory = await fixture(t);
  fs.writeFileSync(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId }));
  writeCrashSessionMarker(directory, { schemaVersion: 1, sessionId, startedAt: "2026-01-01T00:00:00.000Z",
    deviceId, versions: { shellVersion: "1", webVersion: null, clientVersion: null, releaseId: null, shellId: null }, platform: "win32", arch: "x64" });
  fs.writeFileSync(path.join(directory, "crash-reports.jsonl"), '{"bad":1}\n');
  const first = createDesktopCrashCapture({ dataDir: directory, app: new EventEmitter() as never, shellVersion: "1.0.0" });
  t.after(() => first.dispose());
  assert.equal(first.initialize().abnormal, null);
  assert.equal(fs.existsSync(path.join(directory, "crash-session.retry.json")), true);
  first.markClean();
  first.dispose();
  fs.rmSync(path.join(directory, "crash-reports.jsonl"));
  const second = createDesktopCrashCapture({ dataDir: directory, app: new EventEmitter() as never, shellVersion: "1.0.0" });
  t.after(() => second.dispose());
  second.initialize();
  assert.equal(fs.existsSync(path.join(directory, "crash-session.retry.json")), false);
  const pending = second.journal.pending(deviceId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.event, "abnormal_exit");
  assert.equal(pending[0]!.sessionId, sessionId);
});

test("capture marker corruption is isolated and surfaced through the host error recorder", async t => {
  const directory = await fixture(t);
  fs.writeFileSync(path.join(directory, "crash-session.json"), '{"schemaVersion":1,"sessionId":"broken"}');
  const errors: Array<{ errorCode: string; requestId: string }> = [];
  const capture = createDesktopCrashCapture({ dataDir: directory, app: new EventEmitter() as never, shellVersion: "1.0.0",
    recordError: (_error, context) => errors.push(context) });
  t.after(() => capture.dispose());
  const result = capture.initialize();
  assert.ok(result.sessionId);
  assert.equal(errors[0]?.errorCode, "DESKTOP_CRASH_SESSION_MARKER_INVALID");
});
