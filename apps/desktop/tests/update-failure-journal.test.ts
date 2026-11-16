import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";
import { digestUpdateFailureRecord, type ShellUpdateFailureRecord, type UpdateFailureContext } from "@codeflowai/shared/desktop-update-failure";

const deviceId = "868683b1-e79b-4509-9ca1-97b7786e5344";
const context = {
  deviceId, shellVersion: "1.0.0", currentReleaseId: "installation", webVersion: "1.0.0", clientVersion: "1.0.0",
  releaseId: "next-release", requestId: "update-request", phase: "restart-client", recovery: "restored" as const,
};

/** 更新日志只使用独立临时目录，禁止接触真实设备和待报记录。 */
async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-update-journal-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, journal: createUpdateFailureJournal(directory) };
}

/** 用真实方法缺失断言取得 RED，不依赖 import 或编译错误。 */
function recordShell(journal: ReturnType<typeof createUpdateFailureJournal>, input: UpdateFailureContext & {
  requestId: string; shellId: string | null; phase: ShellUpdateFailureRecord["phase"]; recovery: ShellUpdateFailureRecord["recovery"]; error: unknown; rollbackError?: unknown;
}): ShellUpdateFailureRecord {
  const method = (journal as unknown as Record<string, unknown>).recordShell;
  assert.equal(typeof method, "function", "single failure journal must expose recordShell");
  return (method as (value: typeof input) => ShellUpdateFailureRecord)(input);
}

/** 壳记录只携带现有上下文，绝不把旧 releaseId 混进新合同。 */
function shellInput() {
  const { releaseId: _releaseId, ...shared } = context;
  return { ...shared, shellId: "shell-next", phase: "handoff" as const };
}

test("D13 shell failure history survives exact ACK and keeps binding and foreign device evidence separate", async t => {
  const { directory, journal } = await fixture(t);
  const shell = recordShell(journal, { ...shellInput(), error: new Error("DESKTOP_SHELL_NETWORK_FAILED") });
  journal.record({ ...context, error: new Error("EIO") });
  await journal.flush(deviceId, async record => record);
  const reopened = createUpdateFailureJournal(directory) as unknown as { shellFailures?: (device: string, request: string) => ShellUpdateFailureRecord[] };
  assert.equal(typeof reopened.shellFailures, "function", "acknowledged shell history must remain readable");
  assert.deepEqual(reopened.shellFailures!(deviceId, context.requestId), [shell]);
  assert.deepEqual(reopened.shellFailures!(crypto.randomUUID(), context.requestId), []);
  assert.deepEqual(reopened.shellFailures!(deviceId, "other-request"), []);
});

test("one journal reopens mixed binding and shell failures and acknowledges each exact record once", async t => {
  const { directory, journal } = await fixture(t);
  const binding = journal.record({ ...context, error: new Error("DESKTOP_RELEASE_SIGNATURE_INVALID") });
  const shell = recordShell(journal, { ...shellInput(), error: new Error("DESKTOP_SHELL_OPERATION_FAILED"),
    rollbackError: new Error("DESKTOP_SHELL_RECOVERY_HELPER_FAILED") });
  const untargeted = recordShell(journal, { ...shellInput(), requestId: "before-discovery", shellId: null, phase: "prepare", recovery: "not_needed",
    error: new Error("DESKTOP_SHELL_NETWORK_FAILED: PRIVATE_NONCE path=C:/private token=PRIVATE_TOKEN") });
  assert.equal(shell.errorCode, "DESKTOP_SHELL_UPDATE_FAILED"); assert.equal(shell.rootCause.code, "DESKTOP_SHELL_OPERATION_FAILED");
  assert.equal(shell.rollbackError?.code, "DESKTOP_SHELL_RECOVERY_HELPER_FAILED");
  assert.equal(Object.hasOwn(shell, "releaseId"), false); assert.equal(Object.hasOwn(binding, "shellId"), false);
  const reopened = createUpdateFailureJournal(directory); assert.deepEqual(reopened.pending(deviceId), [binding, shell, untargeted]);
  const sent: unknown[] = [];
  await reopened.flush(deviceId, async record => { sent.push(record); return record; });
  assert.deepEqual(sent, [binding, shell, untargeted]); assert.deepEqual(journal.pending(deviceId), []);
  await reopened.flush(deviceId, async () => { assert.fail("acknowledged mixed evidence must not be resent"); });
  const bytes = await fs.readFile(path.join(directory, "errors.jsonl"), "utf8");
  assert.equal(bytes.trimEnd().split("\n").length, 6); assert.doesNotMatch(bytes, /PRIVATE_NONCE|C:\/private|PRIVATE_TOKEN/);
  assert.deepEqual(await fs.readdir(directory), ["errors.jsonl"]);
});

test("wrong shell ACK or a failed send stops the mixed batch without clearing or rewriting evidence", async t => {
  const { directory, journal } = await fixture(t);
  const first = recordShell(journal, { ...shellInput(), error: new Error("DESKTOP_SHELL_HEALTH_FAILED") });
  const second = journal.record({ ...context, requestId: "later-binding", error: new Error("EIO") });
  const file = path.join(directory, "errors.jsonl"), before = await fs.readFile(file);
  for (const wrong of [{ ...first, errorId: crypto.randomUUID() }, { ...first, deviceId: crypto.randomUUID() }, { ...first, payloadSha256: "0".repeat(64) }]) {
    let sends = 0;
    await assert.rejects(() => journal.flush(deviceId, async () => { sends++; return wrong; }), /DESKTOP_UPDATE_ACK_MISMATCH/);
    assert.equal(sends, 1); assert.deepEqual(await fs.readFile(file), before);
  }
  const original = new Error("controlled send failure"); let sends = 0;
  await assert.rejects(() => journal.flush(deviceId, async () => { sends++; throw original; }), error => error === original);
  assert.equal(sends, 1); assert.deepEqual(createUpdateFailureJournal(directory).pending(deviceId), [first, second]);
  await journal.flush(crypto.randomUUID(), async () => { assert.fail("foreign identity must not send mixed evidence"); });
});

test("shell append rollback and close failures retain the original three causes", async t => {
  const { directory, journal } = await fixture(t);
  journal.record({ ...context, error: new Error("binding-before-shell") });
  const file = path.join(directory, "errors.jsonl"), original = new Error("shell append sync failed"), rollback = new Error("shell truncate failed"), cleanup = new Error("shell append close failed");
  const open = fsSync.openSync, close = fsSync.closeSync; let appendFd: number | undefined;
  t.mock.method(fsSync, "openSync", (...args: Parameters<typeof fsSync.openSync>) => {
    const fd = open(...args); if (args[0] === file && args[1] === "a" && appendFd === undefined) appendFd = fd; return fd;
  });
  t.mock.method(fsSync, "fsyncSync", () => { throw original; });
  t.mock.method(fsSync, "truncateSync", () => { throw rollback; });
  t.mock.method(fsSync, "closeSync", (fd: number) => { close(fd); if (fd === appendFd) throw cleanup; });
  assert.throws(() => recordShell(journal, { ...shellInput(), error: new Error("DESKTOP_SHELL_INSTALL_FAILED") }), (error: unknown) => {
    assert.ok(error instanceof AggregateError); assert.ok(error.errors[0] instanceof AggregateError);
    assert.deepEqual(error.errors[0].errors, [original, rollback]); assert.equal(error.errors[1], cleanup); return true;
  });
  t.mock.restoreAll();
  assert.throws(() => journal.pending(deviceId), /DESKTOP_UPDATE_JOURNAL_UNAVAILABLE/);
  assert.throws(() => createUpdateFailureJournal(directory).pending(deviceId), /DESKTOP_UPDATE_JOURNAL_INVALID/);
});

test("shell close failure after successful sync preserves the one durable failure and reports failure", async t => {
  const { directory, journal } = await fixture(t);
  const file = path.join(directory, "errors.jsonl"), cleanup = new Error("shell close failed");
  const close = fsSync.closeSync;
  t.mock.method(fsSync, "closeSync", (fd: number) => { close(fd); throw cleanup; });
  assert.throws(() => recordShell(journal, { ...shellInput(), error: new Error("DESKTOP_SHELL_HANDOFF_HELPER_FAILED") }), error => error === cleanup);
  t.mock.restoreAll();
  const pending = createUpdateFailureJournal(directory).pending(deviceId);
  assert.equal(pending.length, 1); assert.equal(pending[0]!.errorCode, "DESKTOP_SHELL_UPDATE_FAILED");
  assert.equal((await fs.readFile(file, "utf8")).trimEnd().split("\n").length, 1);
});

test("a corrupt shell row prevents sending an earlier valid binding row", async t => {
  const { directory, journal } = await fixture(t);
  journal.record({ ...context, error: new Error("EIO") });
  const shell = recordShell(journal, { ...shellInput(), error: new Error("DESKTOP_SHELL_NETWORK_FAILED") });
  const { payloadSha256: _digest, ...payload } = shell;
  const mixed = { ...payload, releaseId: "mixed-domain" };
  const lines = (await fs.readFile(path.join(directory, "errors.jsonl"), "utf8")).split("\n");
  lines[1] = JSON.stringify({ ...mixed, payloadSha256: digestUpdateFailureRecord(mixed) });
  await fs.writeFile(path.join(directory, "errors.jsonl"), lines.join("\n"), "utf8");
  let sends = 0;
  await assert.rejects(() => journal.flush(deviceId, async record => { sends++; return record; }), /DESKTOP_UPDATE_JOURNAL_INVALID/);
  assert.equal(sends, 0);
});

test("persists only diagnostic codes, never arbitrary error messages or custom properties", async (t) => {
  const { directory, journal } = await fixture(t);
  const error = Object.assign(new Error("Bearer secret-key; 用户聊天正文; /private/workspace.txt"), {
    code: "EACCES", token: "another-secret", path: "/private/project", cause: new Error("password=hidden"),
  });
  const recorded = journal.record({ ...context, error });
  const raw = await fs.readFile(path.join(directory, "errors.jsonl"), "utf8");
  for (const sensitive of ["secret-key", "用户聊天正文", "/private", "another-secret", "password=hidden"]) assert.ok(!raw.includes(sensitive));
  assert.equal(recorded.rootCause.code, "EACCES");
  assert.equal(recorded.recovery, "restored");
  assert.deepEqual(journal.pending(deviceId), [recorded]);
  assert.match(recorded.payloadSha256, /^[a-f0-9]{64}$/);
});

test("rebuilds pending failures after restart and acknowledges only the exact record", async (t) => {
  const { directory, journal } = await fixture(t);
  const recorded = journal.record({ ...context, error: new Error("DESKTOP_CURRENT_RUNTIME_NOT_HEALTHY") });
  const restarted = createUpdateFailureJournal(directory);
  await assert.rejects(() => restarted.flush(deviceId, async record => ({
    errorId: record.errorId, deviceId, payloadSha256: "0".repeat(64),
  })), /DESKTOP_UPDATE_ACK_MISMATCH/);
  assert.deepEqual(createUpdateFailureJournal(directory).pending(deviceId), [recorded]);
  const sent: unknown[] = [];
  await restarted.flush(deviceId, async record => {
    sent.push(record);
    return { errorId: record.errorId, deviceId, payloadSha256: record.payloadSha256 };
  });
  assert.deepEqual(sent, [recorded]);
  assert.deepEqual(createUpdateFailureJournal(directory).pending(deviceId), []);
  await restarted.flush(deviceId, async () => { throw new Error("must not resend acknowledged error"); });
});

test("delivery failure preserves records, stops the batch and does not change recovery evidence", async (t) => {
  const { directory, journal } = await fixture(t);
  const first = journal.record({ ...context, error: new Error("DESKTOP_WINDOW_NOT_READY") });
  const second = journal.record({ ...context, requestId: "second-request", recovery: "failed", error: new TypeError("private value") });
  let count = 0;
  await assert.rejects(() => journal.flush(deviceId, async () => { count++; throw new Error("server offline"); }), /server offline/);
  assert.equal(count, 1);
  assert.deepEqual(createUpdateFailureJournal(directory).pending(deviceId), [first, second]);
});

test("acknowledgement fsync failure rolls the file back and keeps the failure pending", async (t) => {
  const { directory, journal } = await fixture(t);
  const record = journal.record({ ...context, error: new Error("failure") });
  const file = path.join(directory, "errors.jsonl");
  const before = await fs.readFile(file);
  const originalFsync = fsSync.fsyncSync;
  let calls = 0;
  t.mock.method(fsSync, "fsyncSync", (fd: number) => {
    calls += 1;
    if (calls === 1) throw new Error("ack fsync failed");
    return originalFsync(fd);
  });
  await assert.rejects(() => journal.flush(deviceId, async value => ({
    errorId: value.errorId, deviceId, payloadSha256: value.payloadSha256,
  })), (error: unknown) => {
    assert.equal(error instanceof Error ? error.message : String(error), "ack fsync failed",
      error instanceof AggregateError ? JSON.stringify(error.errors.map(value => ({ message: value.message, code: value.code }))) : undefined);
    return true;
  });
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(journal.pending(deviceId), [record]);
});

test("acknowledgement rollback failure preserves both append and rollback causes", async (t) => {
  const { directory, journal } = await fixture(t);
  journal.record({ ...context, error: new Error("failure") });
  t.mock.method(fsSync, "fsyncSync", () => {
    throw new Error("ack fsync failed");
  });
  t.mock.method(fsSync, "truncateSync", () => {
    throw new Error("ack truncate failed");
  });
  await assert.rejects(() => journal.flush(deviceId, async value => ({
    errorId: value.errorId, deviceId, payloadSha256: value.payloadSha256,
  })), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(value => value instanceof Error ? value.message : String(value)), ["ack fsync failed", "ack truncate failed"]);
    return true;
  });
  assert.throws(() => journal.pending(deviceId), /DESKTOP_UPDATE_JOURNAL_UNAVAILABLE/);
  assert.throws(() => createUpdateFailureJournal(directory).pending(deviceId), /DESKTOP_UPDATE_JOURNAL_INVALID/);
});

test("an unavailable failure journal refuses new records after storage recovers", async t => {
  const { directory, journal } = await fixture(t);
  journal.record({ ...context, error: new Error("original failure") });
  const original = new Error("ACK sync failed"), rollback = new Error("ACK truncate failed"), sync = fsSync.fsyncSync;
  let calls = 0, failure: AggregateError | undefined;
  t.mock.method(fsSync, "fsyncSync", (fd: number) => { if (++calls === 1) throw original; sync(fd); });
  t.mock.method(fsSync, "truncateSync", () => { throw rollback; });
  await assert.rejects(() => journal.flush(deviceId, async record => record), (error: unknown) => {
    assert.ok(error instanceof AggregateError); failure = error;
    assert.deepEqual(error.errors, [original, rollback]);
    return true;
  });
  t.mock.restoreAll();
  const file = path.join(directory, "errors.jsonl"), before = await fs.readFile(file);
  assert.throws(() => journal.record({ ...context, requestId: "must-not-append", error: new Error("new failure") }), (error: any) => {
    assert.equal(error.message, "DESKTOP_UPDATE_JOURNAL_UNAVAILABLE");
    assert.equal(error.cause, failure);
    return true;
  });
  assert.deepEqual(await fs.readFile(file), before);
  await assert.rejects(() => journal.flush(deviceId, async () => { assert.fail("unavailable journal must not send"); }), /DESKTOP_UPDATE_JOURNAL_UNAVAILABLE/);
  assert.throws(() => createUpdateFailureJournal(directory).pending(deviceId), /DESKTOP_UPDATE_JOURNAL_INVALID/);
});

test("an append stat failure closes the real journal descriptor without changing its bytes", async t => {
  const { directory, journal } = await fixture(t);
  const record = journal.record({ ...context, error: new Error("original failure") });
  const file = path.join(directory, "errors.jsonl"), before = await fs.readFile(file);
  const original = new Error("journal stat failed"), open = fsSync.openSync, stat = fsSync.fstatSync;
  let descriptor: number | undefined;
  t.mock.method(fsSync, "openSync", (...args: Parameters<typeof fsSync.openSync>) => {
    const fd = open(...args); if (args[0] === file && args[1] === "a") descriptor = fd; return fd;
  });
  t.mock.method(fsSync, "fstatSync", () => { throw original; });
  try {
    assert.throws(() => journal.record({ ...context, error: new Error("new failure") }), error => error === original);
    assert.notEqual(descriptor, undefined);
    assert.throws(() => stat(descriptor!), { code: "EBADF" });
  } finally {
    t.mock.restoreAll();
    // RED 时测试也关闭原实现未收尾的句柄，保留主断言失败。
    if (descriptor !== undefined) {
      let live = false;
      try { stat(descriptor); live = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
      if (live) fsSync.closeSync(descriptor);
    }
  }
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(journal.pending(deviceId), [record]);
});

for (const original of [undefined, false, new Error("journal write failed")]) {
  test(`append rejection ${String(original)} is preserved when descriptor close also fails`, async t => {
    const { directory, journal } = await fixture(t);
    const record = journal.record({ ...context, error: new Error("original failure") });
    const file = path.join(directory, "errors.jsonl"), before = await fs.readFile(file), cleanup = new Error("journal close failed");
    const open = fsSync.openSync, close = fsSync.closeSync, write = fsSync.writeFileSync;
    let descriptor: number | undefined;
    t.mock.method(fsSync, "openSync", (...args: Parameters<typeof fsSync.openSync>) => {
      const fd = open(...args); if (args[0] === file && args[1] === "a") descriptor = fd; return fd;
    });
    t.mock.method(fsSync, "writeFileSync", (...args: Parameters<typeof fsSync.writeFileSync>) => {
      if (args[0] === descriptor) throw original; return write(...args);
    });
    t.mock.method(fsSync, "closeSync", (fd: number) => { close(fd); if (fd === descriptor) throw cleanup; });
    assert.throws(() => journal.record({ ...context, error: new Error("new failure") }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [original, cleanup]);
      return true;
    });
    t.mock.restoreAll();
    assert.deepEqual(await fs.readFile(file), before);
    assert.deepEqual(journal.pending(deviceId), [record]);
  });
}

test("rollback sync and close failures both remain attached to the append failure", async t => {
  const { directory, journal } = await fixture(t);
  journal.record({ ...context, error: new Error("original failure") });
  const file = path.join(directory, "errors.jsonl"), before = await fs.readFile(file);
  const original = new Error("append sync failed"), rollback = new Error("rollback sync failed"), cleanup = new Error("rollback close failed");
  const open = fsSync.openSync, close = fsSync.closeSync, sync = fsSync.fsyncSync, truncate = fsSync.truncateSync;
  let rollbackFd: number | undefined, syncCalls = 0, truncated = false;
  t.mock.method(fsSync, "truncateSync", (...args: Parameters<typeof fsSync.truncateSync>) => {
    truncate(...args); truncated = true;
  });
  t.mock.method(fsSync, "openSync", (...args: Parameters<typeof fsSync.openSync>) => {
    const fd = open(...args); if (truncated && args[0] === file && args[1] === "r+") rollbackFd = fd; return fd;
  });
  t.mock.method(fsSync, "fsyncSync", (fd: number) => {
    if (++syncCalls === 1) throw original;
    if (fd === rollbackFd) throw rollback;
    sync(fd);
  });
  t.mock.method(fsSync, "closeSync", (fd: number) => {
    close(fd);
    if (fd === rollbackFd) { rollbackFd = undefined; throw cleanup; }
  });
  assert.throws(() => journal.record({ ...context, error: new Error("new failure") }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], original);
    assert.equal(error.errors.length, 2);
    assert.ok(error.errors[1] instanceof AggregateError);
    assert.deepEqual(error.errors[1].errors, [rollback, cleanup]);
    return true;
  });
  t.mock.restoreAll();
  const after = await fs.readFile(file);
  assert.deepEqual(after.subarray(0, before.length), before);
  assert.deepEqual(JSON.parse(after.subarray(before.length).toString("utf8")), { schemaVersion: 1, kind: "journal-invalid" });
  assert.throws(() => journal.pending(deviceId), /DESKTOP_UPDATE_JOURNAL_UNAVAILABLE/);
  assert.throws(() => createUpdateFailureJournal(directory).pending(deviceId), /DESKTOP_UPDATE_JOURNAL_INVALID/);
});

test("invalid marker write and close failures both remain attached to the rollback failure", async t => {
  const { directory, journal } = await fixture(t);
  journal.record({ ...context, error: new Error("original failure") });
  const file = path.join(directory, "errors.jsonl"), original = new Error("append sync failed"), rollback = new Error("truncate failed");
  const marker = new Error("marker write failed"), cleanup = new Error("marker close failed");
  const open = fsSync.openSync, close = fsSync.closeSync, write = fsSync.writeFileSync;
  let markerFd: number | undefined, opens = 0;
  t.mock.method(fsSync, "openSync", (...args: Parameters<typeof fsSync.openSync>) => {
    const fd = open(...args); if (args[0] === file && args[1] === "a" && ++opens === 2) markerFd = fd; return fd;
  });
  t.mock.method(fsSync, "fsyncSync", () => { throw original; });
  t.mock.method(fsSync, "truncateSync", () => { throw rollback; });
  t.mock.method(fsSync, "writeFileSync", (...args: Parameters<typeof fsSync.writeFileSync>) => {
    if (args[0] === markerFd) throw marker; return write(...args);
  });
  t.mock.method(fsSync, "closeSync", (fd: number) => { close(fd); if (fd === markerFd) throw cleanup; });
  let failure: AggregateError | undefined;
  assert.throws(() => journal.record({ ...context, error: new Error("new failure") }), (error: unknown) => {
    assert.ok(error instanceof AggregateError); failure = error;
    assert.deepEqual(error.errors, [original, rollback]);
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [marker, cleanup]);
    return true;
  });
  t.mock.restoreAll();
  assert.throws(() => journal.record({ ...context, error: new Error("must not append") }), (error: any) => {
    assert.equal(error.message, "DESKTOP_UPDATE_JOURNAL_UNAVAILABLE");
    assert.equal(error.cause, failure);
    return true;
  });
});

test("a close failure after a successful sync reports failure and preserves the durable record", async t => {
  const { directory, journal } = await fixture(t);
  const first = journal.record({ ...context, error: new Error("original failure") });
  const file = path.join(directory, "errors.jsonl"), cleanup = new Error("append close failed");
  const open = fsSync.openSync, close = fsSync.closeSync;
  let descriptor: number | undefined;
  t.mock.method(fsSync, "openSync", (...args: Parameters<typeof fsSync.openSync>) => {
    const fd = open(...args); if (args[0] === file && args[1] === "a") descriptor = fd; return fd;
  });
  t.mock.method(fsSync, "closeSync", (fd: number) => { close(fd); if (fd === descriptor) throw cleanup; });
  t.mock.method(fsSync, "truncateSync", () => { assert.fail("a synchronized record must not be rolled back for a close failure"); });
  assert.throws(() => journal.record({ ...context, requestId: "durable-request", error: new Error("new failure") }), error => error === cleanup);
  t.mock.restoreAll();
  const pending = createUpdateFailureJournal(directory).pending(deviceId);
  assert.equal(pending.length, 2);
  assert.deepEqual(pending[0], first);
  assert.equal(pending[1]!.requestId, "durable-request");
  assert.deepEqual(journal.pending(deviceId), pending);
});

test("a reinstallation cannot upload old-device evidence as the new device", async (t) => {
  const { journal } = await fixture(t);
  const record = journal.record({ ...context, error: new Error("failure") });
  const newDevice = crypto.randomUUID();
  await journal.flush(newDevice, async () => { throw new Error("old identity must not be sent"); });
  assert.deepEqual(journal.pending(deviceId), [record]);
  await assert.rejects(() => journal.flush(deviceId, async () => ({
    errorId: record.errorId, deviceId: newDevice, payloadSha256: record.payloadSha256,
  })), /DESKTOP_UPDATE_ACK_MISMATCH/);
});

test("rejects malformed or tampered persisted evidence rather than skipping it", async (t) => {
  const { directory, journal } = await fixture(t);
  const record = journal.record({ ...context, error: new Error("failure") });
  const file = path.join(directory, "errors.jsonl");
  await fs.writeFile(file, `${JSON.stringify({ ...record, recovery: "failed" })}\n`, "utf8");
  assert.throws(() => journal.pending(deviceId), /DESKTOP_UPDATE_JOURNAL_INVALID/);
  await fs.writeFile(file, Buffer.from([0xff, 0xfe]));
  assert.throws(() => journal.pending(deviceId));
});

test("serializes delivery and preserves a newly recorded failure for the next pump", async (t) => {
  const { journal } = await fixture(t);
  const first = journal.record({ ...context, error: new Error("failure") });
  let acknowledge!: (value: { errorId: string; deviceId: string; payloadSha256: string }) => void;
  const pending = journal.flush(deviceId, () => new Promise(resolve => { acknowledge = resolve; }));
  const second = journal.record({ ...context, requestId: "next-request", error: new Error("failure") });
  await assert.rejects(() => journal.flush(deviceId, async record => record), /DESKTOP_UPDATE_DELIVERY_IN_PROGRESS/);
  acknowledge(first);
  await pending;
  assert.deepEqual(journal.pending(deviceId), [second]);
});

test("journal write failure is explicit and cannot create a successful in-memory record", async (t) => {
  const { directory, journal } = await fixture(t);
  await fs.mkdir(path.join(directory, "errors.jsonl"));
  assert.throws(() => journal.record({ ...context, error: new Error("original") }));
});

test("self-consistent hashes cannot authorize unknown fields or arbitrary diagnostic text for upload", async (t) => {
  const { directory, journal } = await fixture(t);
  const record = journal.record({ ...context, error: new Error("failure") });
  const { payloadSha256: _digest, ...payload } = record;
  for (const invalid of [
    { ...payload, unexpectedBody: "private chat content" },
    { ...payload, rootCause: { ...payload.rootCause, message: "Bearer secret" } },
    { ...payload, rootCause: { name: "Error", code: "SECRET_VALUE" } },
    { ...payload, phase: "private chat content" },
  ]) {
    await fs.writeFile(path.join(directory, "errors.jsonl"), `${JSON.stringify({ ...invalid,
      payloadSha256: crypto.createHash("sha256").update(JSON.stringify(invalid)).digest("hex"),
    })}\n`, "utf8");
    let uploads = 0;
    await assert.rejects(() => journal.flush(deviceId, async value => { uploads++; return value; }), /DESKTOP_UPDATE_JOURNAL_INVALID/);
    assert.equal(uploads, 0);
  }
});

test("preserves real Client health and lifecycle codes without their private message suffix", async (t) => {
  const { journal } = await fixture(t);
  for (const code of ["CLIENT_HEALTH_VERSION_MISMATCH", "CLIENT_HEALTH_DB_SCHEMA_MISMATCH", "CLIENT_READY_TIMEOUT", "CLIENT_EXIT_BEFORE_READY"]) {
    const record = journal.record({ ...context, error: new Error(`${code}: expected=PRIVATE_TOKEN`) });
    assert.equal(record.rootCause.code, code);
    assert.ok(!JSON.stringify(record).includes("PRIVATE_TOKEN"));
  }
});

test("keeps signing release failures searchable without uploading their suffix", async (t) => {
  const { journal } = await fixture(t);
  for (const code of ["DESKTOP_RELEASE_UNTRUSTED_KEY", "DESKTOP_RELEASE_SIGNATURE_INVALID", "DESKTOP_RELEASE_PLATFORM_MISMATCH",
    "DESKTOP_RELEASE_EXPIRED", "DESKTOP_RELEASE_FILES_MISMATCH", "DESKTOP_RELEASE_ARCHIVE_MISMATCH"]) {
    const record = journal.record({ ...context, error: new Error(`${code}: PRIVATE_CONTENT`) });
    assert.equal(record.rootCause.code, code);
    assert.ok(!JSON.stringify(record).includes("PRIVATE_CONTENT"));
  }
});

test("discovery and download diagnostics remain uploadable while private error suffixes are removed", async t => {
  const { journal } = await fixture(t);
  for (const [phase, code] of [["discovery", "DESKTOP_RELEASE_DISCOVERY_FAILED"], ["download", "DESKTOP_RELEASE_RESPONSE_INVALID"],
    ["download", "DESKTOP_UPDATE_TRANSPORT_FAILED"], ["download", "DESKTOP_RELEASE_CACHE_UNSAFE"]]) {
    const record = journal.record({ ...context, phase: phase!, error: new Error(`${code}: PRIVATE_CONTENT`) });
    assert.equal(record.phase, phase);
    assert.equal(record.rootCause.code, code);
    assert.equal(JSON.stringify(record).includes("PRIVATE_CONTENT"), false);
  }
  let received = 0;
  await journal.flush(context.deviceId, async record => {
    received += 1;
    return { errorId: record.errorId, deviceId: record.deviceId, payloadSha256: record.payloadSha256 };
  });
  assert.equal(received, 4);
  assert.deepEqual(journal.pending(context.deviceId), []);
});

test("prepared release, recovery and stable bridge diagnostic codes survive journal reopening without private details", async t => {
  const { directory, journal } = await fixture(t);
  const codes = ["DESKTOP_PENDING_RELEASE_INVALID", "DESKTOP_DB_BACKUP_INVALID", "DESKTOP_DB_BACKUP_FILE_INVALID",
    "DESKTOP_DB_BACKUP_ALREADY_EXISTS", "DESKTOP_DB_BACKUP_HASH_MISMATCH", "DESKTOP_DB_WORKSPACE_PATH_INVALID",
    "DESKTOP_DB_SCHEMA_DOWNGRADE_FORBIDDEN", "DESKTOP_DB_BACKUP_RECOVERY_FAILED", "DESKTOP_WEB_READY_TIMEOUT",
    "DESKTOP_WEB_READY_UNAVAILABLE", "CLIENT_RUNTIME_INCOMPATIBLE", "DESKTOP_CLI_RUNTIME_MISSING",
    "DESKTOP_STARTUP_CONTINUATION_FAILED", "DESKTOP_STARTUP_READY_INVALID", "DESKTOP_UPDATE_NOT_PREPARED",
    "DESKTOP_RESTART_UNAVAILABLE", "DESKTOP_STATE_WRITE_CLEANUP_FAILED", "DESKTOP_FILE_CLOSE_FAILED",
    "DESKTOP_DB_RESTORE_CLEANUP_FAILED", "DESKTOP_DIRECTORY_CLOSE_FAILED"];
  for (const code of codes) {
    const record = journal.record({ ...context, error: new Error(`${code}: PRIVATE_PATH PRIVATE_TOKEN`) });
    assert.equal(record.rootCause.code, code);
  }
  const reopened = createUpdateFailureJournal(directory);
  assert.deepEqual(reopened.pending(deviceId).map(record => record.rootCause.code), codes);
  assert.doesNotMatch(await fs.readFile(path.join(directory, "errors.jsonl"), "utf8"), /PRIVATE_PATH|PRIVATE_TOKEN/);
  let uploads = 0;
  await reopened.flush(deviceId, async record => { uploads++; return record; });
  assert.equal(uploads, 20);
  assert.deepEqual(journal.pending(deviceId), []);
});
