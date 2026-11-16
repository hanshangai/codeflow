import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { assertDesktopUpdateReceipt, createDesktopUpdateReceipt, digestDesktopUpdateReceipt,
  toDesktopUpdateReceiptAck } from "../../packages/shared/src/desktopUpdateReceipt.js";

/** 生成无业务正文的固定回执，变体用于验证合同拒绝边界。 */
function receipt(overrides: Record<string, unknown> = {}) {
  return createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: crypto.randomUUID(), requestId: crypto.randomUUID(),
    releaseId: "release-1", archiveSha256: "a".repeat(64), stage: "received", at: "2026-10-24T00:00:00.000Z",
    errorCode: null, errorId: null, ...overrides } as Parameters<typeof createDesktopUpdateReceipt>[0]);
}

test("receipt digest and acknowledgement bind the exact safe evidence", () => {
  const record = receipt();
  assertDesktopUpdateReceipt(record);
  assert.equal(digestDesktopUpdateReceipt(record), record.payloadSha256);
  assert.deepEqual(toDesktopUpdateReceiptAck(record), { deviceId: record.deviceId, requestId: record.requestId,
    releaseId: record.releaseId, archiveSha256: record.archiveSha256, stage: record.stage, at: record.at, payloadSha256: record.payloadSha256 });
});

test("receipt rejects a tampered body even when every field has a valid shape", () => {
  const record = receipt();
  assert.throws(() => assertDesktopUpdateReceipt({ ...record, releaseId: "release-2" }), /RECEIPT_INVALID/);
  assert.throws(() => assertDesktopUpdateReceipt({ ...record, payloadSha256: "b".repeat(64) }), /RECEIPT_INVALID/);
});

test("receipt canonical digest does not depend on JSON property order", () => {
  const record = receipt();
  const reordered = Object.fromEntries(Object.entries(record).reverse());
  assertDesktopUpdateReceipt(reordered);
  assert.equal(digestDesktopUpdateReceipt(reordered), record.payloadSha256);
});

test("receipt rejects unknown fields, malformed ids and nonportable target identities", () => {
  const record = receipt();
  for (const change of [{ body: "private" }, { deviceId: "not-device" }, { requestId: "request" },
    { releaseId: "../release" }, { releaseId: "con" }, { releaseId: "release." }, { archiveSha256: "A".repeat(64) },
    { at: "2026-10-24" }, { schemaVersion: 2 }, { stage: "installed" }]) {
    assert.throws(() => assertDesktopUpdateReceipt({ ...record, ...change }), /RECEIPT_INVALID/);
  }
  for (const field of ["deviceId", "requestId", "releaseId", "archiveSha256", "payloadSha256"] as const) {
    assert.throws(() => assertDesktopUpdateReceipt({ ...record, [field]: [record[field]] }), /RECEIPT_INVALID/);
  }
});

test("only recovery terminal receipts carry the stable error reference", () => {
  for (const stage of ["received", "verified", "prepared", "switched", "healthy"] as const) {
    assert.doesNotThrow(() => receipt({ stage }));
    assert.throws(() => receipt({ stage, errorCode: "DESKTOP_RELEASE_FAILED", errorId: crypto.randomUUID() }));
  }
  for (const stage of ["rolled_back", "unavailable"] as const) {
    assert.throws(() => receipt({ stage }));
    assert.doesNotThrow(() => receipt({ stage, errorCode: "DESKTOP_RELEASE_FAILED", errorId: crypto.randomUUID() }));
    assert.throws(() => receipt({ stage, errorCode: "DESKTOP_RELEASE_FAILED", errorId: [crypto.randomUUID()] }));
  }
});
