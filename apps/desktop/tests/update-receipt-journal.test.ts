import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopUpdateReceipt, toDesktopUpdateReceiptAck, type DesktopUpdateReceipt, type DesktopUpdateReceiptAck } from "@codeflowai/shared/desktop-update-receipt";
import { createUpdateReceiptJournal } from "../src/updateReceiptJournal.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-receipt-journal-"));
  const deviceId = crypto.randomUUID();
  const receipt = (stage: DesktopUpdateReceipt["stage"] = "prepared", options: { requestId?: string; releaseId?: string } = {}): DesktopUpdateReceipt => createDesktopUpdateReceipt({
    schemaVersion: 1, deviceId, requestId: options.requestId ?? crypto.randomUUID(), releaseId: options.releaseId ?? "release-1", archiveSha256: "a".repeat(64), stage,
    at: "2026-10-24T00:00:00.000Z", errorCode: stage === "rolled_back" || stage === "unavailable" ? "DESKTOP_RELEASE_FAILED" : null,
    errorId: stage === "rolled_back" || stage === "unavailable" ? crypto.randomUUID() : null,
  });
  return { root, deviceId, receipt, async close() { await fs.rm(root, { recursive: true, force: true }); } };
}

test("journal persists receipts across restart and removes only exact acknowledged evidence", async t => {
  const f = await fixture(); t.after(f.close); const record = f.receipt(); const journal = createUpdateReceiptJournal(f.root);
  assert.deepEqual(await journal.record(record), record);
  const ack: DesktopUpdateReceiptAck = { deviceId: record.deviceId, requestId: record.requestId, releaseId: record.releaseId,
    archiveSha256: record.archiveSha256, stage: record.stage, at: record.at, payloadSha256: record.payloadSha256 };
  assert.deepEqual(await journal.pending(f.deviceId), [record]); await journal.acknowledge(ack);
  assert.deepEqual(await createUpdateReceiptJournal(f.root).pending(f.deviceId), []); await journal.acknowledge(ack);
});

test("journal restores restrictive permissions before appending to an existing file", async t => {
  const f = await fixture(); t.after(f.close); const journal = createUpdateReceiptJournal(f.root); const record = f.receipt(); let chmodCalls = 0;
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); const chmod = file.chmod.bind(file);
    t.mock.method(file, "chmod", async (mode: number) => { chmodCalls += 1; return await chmod(mode); }); return file;
  });
  await journal.record(record);
  const filePath = path.join(f.root, "update-receipts.jsonl");
  await fs.chmod(filePath, 0o644);
  await journal.record(f.receipt());
  assert.equal(chmodCalls, 2);
  if (process.platform !== "win32") assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
});

test("journal serializes conflicting same-key record and acknowledge operations", async t => {
  const f = await fixture(); t.after(f.close); const journal = createUpdateReceiptJournal(f.root);
  const requestId = crypto.randomUUID();
  const first = f.receipt("prepared", { requestId, releaseId: "release-1" });
  const conflict = f.receipt("prepared", { requestId, releaseId: "release-2" });
  const results = await Promise.allSettled([journal.record(first), journal.record(conflict)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.deepEqual(await journal.pending(f.deviceId), [first]);
  const ack: DesktopUpdateReceiptAck = { deviceId: first.deviceId, requestId: first.requestId, releaseId: first.releaseId,
    archiveSha256: first.archiveSha256, stage: first.stage, at: first.at, payloadSha256: first.payloadSha256 };
  await Promise.all([journal.acknowledge(ack), journal.acknowledge(ack)]);
  assert.deepEqual(await createUpdateReceiptJournal(f.root).pending(f.deviceId), []);
});

test("journal rejects malformed evidence without skipping damaged lines", async t => {
  const f = await fixture(); t.after(f.close); const journal = createUpdateReceiptJournal(f.root); const record = f.receipt(); await journal.record(record);
  await assert.rejects(() => journal.record({ ...record, releaseId: "../other" }), /DESKTOP_UPDATE_RECEIPT_INVALID/);
  await fs.appendFile(path.join(f.root, "update-receipts.jsonl"), "{bad-json}\n");
  await assert.rejects(() => journal.pending(f.deviceId), /DESKTOP_UPDATE_RECEIPT_JOURNAL_INVALID/);
});

for (const kind of ["receipt", "ack"] as const) for (const operation of ["writeFile", "sync"] as const) {
  test(`${kind} ${operation} failure restores the journal bytes and permits an explicit retry`, async t => {
    const f = await fixture(); t.after(f.close);
    const journal = createUpdateReceiptJournal(f.root), first = f.receipt(), second = f.receipt();
    await journal.record(first);
    if (kind === "ack") await journal.record(second);
    const filePath = path.join(f.root, "update-receipts.jsonl"), before = await fs.readFile(filePath);
    const original = Object.assign(new Error("journal append failed"), { code: "EIO" });
    const open = fs.open;
    let injected = false, sent = 0;
    // 只注入一次故障，部分字节和后续恢复均使用真实文件句柄。
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (args[0] === filePath && args[1] === "a") {
        const writeFile = file.writeFile.bind(file), sync = file.sync.bind(file);
        if (operation === "writeFile") t.mock.method(file, "writeFile", async (...writeArgs: Parameters<typeof file.writeFile>) => {
          if (!injected) { injected = true; await writeFile(String(writeArgs[0]).slice(0, 23), "utf8"); throw original; }
          return await writeFile(...writeArgs);
        });
        else t.mock.method(file, "sync", async () => {
          if (!injected) { injected = true; throw original; }
          return await sync();
        });
      }
      return file;
    });
    await assert.rejects(() => kind === "receipt" ? journal.record(second) : journal.flush(f.deviceId, async receipt => {
      sent += 1; return toDesktopUpdateReceiptAck(receipt);
    }), (error: any) => {
      if (kind === "receipt") assert.equal(error, original);
      else {
        assert.equal(error.code, "DESKTOP_UPDATE_RECEIPT_ACK_FAILED");
        assert.equal(error.requestId, first.requestId);
        assert.equal(error.cause, original);
      }
      return true;
    });
    assert.equal(injected, true);
    assert.equal(sent, kind === "ack" ? 1 : 0);
    assert.deepEqual(await fs.readFile(filePath), before);
    assert.deepEqual(await createUpdateReceiptJournal(f.root).pending(f.deviceId), kind === "ack" ? [first, second] : [first]);
    if (kind === "receipt") assert.deepEqual(await journal.record(second), second);
    const replay: string[] = [];
    await journal.flush(f.deviceId, async receipt => { replay.push(receipt.requestId); return toDesktopUpdateReceiptAck(receipt); });
    assert.deepEqual(replay, [first.requestId, second.requestId]);
    assert.deepEqual(await createUpdateReceiptJournal(f.root).pending(f.deviceId), []);
  });
}

for (const operation of ["truncate", "sync", "close"] as const) {
  test(`ACK rollback ${operation} failure blocks further journal use and invalidates restart`, async t => {
    const f = await fixture(); t.after(f.close);
    const journal = createUpdateReceiptJournal(f.root), first = f.receipt(), second = f.receipt();
    await journal.record(first); await journal.record(second);
    const filePath = path.join(f.root, "update-receipts.jsonl");
    const original = new Error("ACK sync failed"), rollback = new Error("ACK rollback failed");
    const open = fs.open;
    let sent = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (args[0] === filePath) {
        if (args[1] === "a") {
          const sync = file.sync.bind(file);
          let calls = 0;
          t.mock.method(file, "sync", async () => { if (++calls === 1) throw original; return await sync(); });
        } else if (args[1] === "r+") {
          if (operation === "sync") t.mock.method(file, "sync", async () => { throw rollback; });
          else if (operation === "truncate") t.mock.method(file, "truncate", async () => { throw rollback; });
          else {
            const close = file.close.bind(file);
            t.mock.method(file, "close", async () => { await close(); throw rollback; });
          }
        }
      }
      return file;
    });
    await assert.rejects(() => journal.flush(f.deviceId, async receipt => { sent += 1; return toDesktopUpdateReceiptAck(receipt); }), (error: any) => {
      assert.equal(error.code, "DESKTOP_UPDATE_RECEIPT_ACK_FAILED");
      assert.equal(error.requestId, first.requestId);
      assert.ok(error.cause instanceof AggregateError);
      assert.deepEqual(error.cause.errors, [original, rollback]);
      return true;
    });
    assert.equal(sent, 1);
    const failedBytes = await fs.readFile(filePath);
    await assert.rejects(() => journal.pending(f.deviceId), /DESKTOP_UPDATE_RECEIPT_JOURNAL_UNAVAILABLE/);
    await assert.rejects(() => journal.find(f.deviceId, first.requestId, first.stage), /DESKTOP_UPDATE_RECEIPT_JOURNAL_UNAVAILABLE/);
    await assert.rejects(() => journal.record(f.receipt()), /DESKTOP_UPDATE_RECEIPT_JOURNAL_UNAVAILABLE/);
    await assert.rejects(() => journal.acknowledge(toDesktopUpdateReceiptAck(first)), /DESKTOP_UPDATE_RECEIPT_JOURNAL_UNAVAILABLE/);
    await assert.rejects(() => journal.flush(f.deviceId, async () => { assert.fail("unavailable journal must not send"); }), /DESKTOP_UPDATE_RECEIPT_JOURNAL_UNAVAILABLE/);
    assert.deepEqual(await fs.readFile(filePath), failedBytes);
    await assert.rejects(() => createUpdateReceiptJournal(f.root).pending(f.deviceId), /DESKTOP_UPDATE_RECEIPT_JOURNAL_INVALID/);
  });
}

for (const operation of ["writeFile", "sync"] as const) {
  test(`failed invalid marker ${operation} retains all causes and stops the current journal`, async t => {
    const f = await fixture(); t.after(f.close);
    const journal = createUpdateReceiptJournal(f.root), record = f.receipt(); await journal.record(record);
    const filePath = path.join(f.root, "update-receipts.jsonl"), open = fs.open;
    const original = new Error("append sync failed"), rollback = new Error("truncate failed"), marker = new Error("invalid marker failed");
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (args[0] === filePath && args[1] === "a") {
        const writeFile = file.writeFile.bind(file);
        let syncCalls = 0, writeCalls = 0;
        t.mock.method(file, "sync", async () => {
          if (++syncCalls === 1) throw original;
          throw marker;
        });
        if (operation === "writeFile") t.mock.method(file, "writeFile", async (...writeArgs: Parameters<typeof file.writeFile>) => {
          if (++writeCalls > 1) throw marker;
          return await writeFile(...writeArgs);
        });
      } else if (args[0] === filePath && args[1] === "r+") t.mock.method(file, "truncate", async () => { throw rollback; });
      return file;
    });
    await assert.rejects(() => journal.acknowledge(toDesktopUpdateReceiptAck(record)), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [original, rollback, marker]);
      return true;
    });
    await assert.rejects(() => journal.pending(f.deviceId), /DESKTOP_UPDATE_RECEIPT_JOURNAL_UNAVAILABLE/);
  });
}

for (const cause of [undefined, false, new Error("append failed")] as const) {
  test(`append rejection ${String(cause)} is retained when close also fails`, async t => {
    const f = await fixture(); t.after(f.close);
    const journal = createUpdateReceiptJournal(f.root), record = f.receipt(); await journal.record(record);
    const filePath = path.join(f.root, "update-receipts.jsonl"), before = await fs.readFile(filePath), open = fs.open;
    const cleanup = new Error("journal close failed");
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (args[0] === filePath && args[1] === "a") {
        const close = file.close.bind(file);
        t.mock.method(file, "writeFile", async () => { throw cause; });
        t.mock.method(file, "close", async () => { await close(); throw cleanup; });
      }
      return file;
    });
    await assert.rejects(() => journal.record(f.receipt()), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [cause, cleanup]);
      return true;
    });
    assert.deepEqual(await fs.readFile(filePath), before);
    assert.deepEqual(await createUpdateReceiptJournal(f.root).pending(f.deviceId), [record]);
  });
}

for (const operation of ["chmod", "stat"] as const) {
  test(`pre-append ${operation} failure preserves bytes without attempting rollback`, async t => {
    const f = await fixture(); t.after(f.close);
    const journal = createUpdateReceiptJournal(f.root), record = f.receipt(); await journal.record(record);
    const filePath = path.join(f.root, "update-receipts.jsonl"), before = await fs.readFile(filePath), open = fs.open;
    const original = new Error("journal preparation failed");
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === filePath && args[1] === "r+") assert.fail("pre-append failure must not restore content");
      const file = await open(...args);
      if (args[0] === filePath && args[1] === "a") t.mock.method(file, operation, async () => { throw original; });
      return file;
    });
    await assert.rejects(() => journal.record(f.receipt()), error => error === original);
    assert.deepEqual(await fs.readFile(filePath), before);
    assert.deepEqual(await createUpdateReceiptJournal(f.root).pending(f.deviceId), [record]);
  });
}

test("a failed first append restores an empty journal and allows the same receipt to be recorded", async t => {
  const f = await fixture(); t.after(f.close);
  const journal = createUpdateReceiptJournal(f.root), record = f.receipt(), open = fs.open;
  const original = new Error("first append failed");
  let injected = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === path.join(f.root, "update-receipts.jsonl") && args[1] === "a") {
      const sync = file.sync.bind(file);
      t.mock.method(file, "sync", async () => { if (!injected) { injected = true; throw original; } await sync(); });
    }
    return file;
  });
  await assert.rejects(() => journal.record(record), error => error === original);
  assert.equal((await fs.stat(path.join(f.root, "update-receipts.jsonl"))).size, 0);
  assert.deepEqual(await createUpdateReceiptJournal(f.root).pending(f.deviceId), []);
  assert.deepEqual(await journal.record(record), record);
  assert.deepEqual(await createUpdateReceiptJournal(f.root).pending(f.deviceId), [record]);
});

test("close failure after a synced ACK remains explicit and preserves the durable confirmation", async t => {
  const f = await fixture(); t.after(f.close);
  const journal = createUpdateReceiptJournal(f.root), record = f.receipt(); await journal.record(record);
  const filePath = path.join(f.root, "update-receipts.jsonl"), open = fs.open, original = new Error("synced ACK close failed");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === filePath && args[1] === "a") {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => { await close(); throw original; });
    }
    return file;
  });
  await assert.rejects(() => journal.acknowledge(toDesktopUpdateReceiptAck(record)), error => error === original);
  assert.deepEqual(await createUpdateReceiptJournal(f.root).pending(f.deviceId), []);
  assert.deepEqual(await journal.find(f.deviceId, record.requestId, record.stage), record);
});

test("flush is serial, keeps evidence pending on send or ACK failure, and accepts exact ACK only", async t => {
  const f = await fixture(); t.after(f.close); const journal = createUpdateReceiptJournal(f.root);
  const first = f.receipt(); const second = f.receipt(); await journal.record(first); await journal.record(second);
  let active = 0; let maxActive = 0;
  await assert.rejects(() => journal.flush(f.deviceId, async receipt => { active += 1; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 1)); active -= 1; throw new Error("send failed"); }));
  assert.equal(maxActive, 1); assert.equal((await journal.pending(f.deviceId)).length, 2);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const firstFlush = journal.flush(f.deviceId, async receipt => { await held; return { deviceId: receipt.deviceId, requestId: receipt.requestId, releaseId: receipt.releaseId,
    archiveSha256: receipt.archiveSha256, stage: receipt.stage, at: receipt.at, payloadSha256: receipt.payloadSha256 }; });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => journal.flush(f.deviceId, async receipt => ({ deviceId: receipt.deviceId, requestId: receipt.requestId, releaseId: receipt.releaseId,
    archiveSha256: receipt.archiveSha256, stage: receipt.stage, at: receipt.at, payloadSha256: receipt.payloadSha256 })), /IN_PROGRESS/);
  release(); await firstFlush; assert.equal((await journal.pending(f.deviceId)).length, 0);
});

test("flush rejects an ACK for another stage with the same requestId", async t => {
  const f = await fixture(); t.after(f.close); const journal = createUpdateReceiptJournal(f.root);
  const requestId = crypto.randomUUID();
  const prepared = f.receipt("prepared", { requestId });
  const switched = f.receipt("switched", { requestId });
  await journal.record(prepared); await journal.record(switched);
  const crossStageAck: DesktopUpdateReceiptAck = { deviceId: switched.deviceId, requestId: switched.requestId,
    releaseId: switched.releaseId, archiveSha256: switched.archiveSha256, stage: switched.stage, at: switched.at, payloadSha256: switched.payloadSha256 };

  await assert.rejects(() => journal.flush(f.deviceId, async () => crossStageAck), /DESKTOP_UPDATE_RECEIPT_ACK_INVALID/);
  assert.deepEqual(await journal.pending(f.deviceId), [prepared, switched]);
});
