import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopUpdateReceipt } from "@codeflowai/shared/desktop-update-receipt";
import { buildDesktopDevicePayload, verifyDesktopDeviceSignature } from "@codeflowai/shared/desktop-device-auth";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { createDesktopUpdateTransport } from "../src/updateTransport.js";
import { createUpdateReceiptDelivery } from "../src/updateReceiptDelivery.js";
import { createUpdateReceiptJournal } from "../src/updateReceiptJournal.js";

test("delivery registers only when pending and reuses receipt request IDs", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-receipt-delivery-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID();
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "prepared", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  const journal = createUpdateReceiptJournal(root); await journal.record(receipt);
  let registered = 0; let requestId = "";
  const delivery = createUpdateReceiptDelivery({ journal, deviceId, transport: {
    async register() { registered += 1; },
    async requestJson(input) { requestId = input.requestId; return { ok: true, deviceId, requestId, releaseId: receipt.releaseId,
      archiveSha256: receipt.archiveSha256, stage: receipt.stage, at: receipt.at, payloadSha256: receipt.payloadSha256 }; },
  } });
  await delivery.flush(); assert.equal(registered, 1); assert.equal(requestId, receipt.requestId); assert.equal((await journal.pending(deviceId)).length, 0);
  await delivery.flush(); assert.equal(registered, 1);
});

test("delivery extracts and validates the server API envelope before acknowledging", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-receipt-delivery-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID();
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "prepared", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  const journal = createUpdateReceiptJournal(root); await journal.record(receipt);
  const delivery = createUpdateReceiptDelivery({ journal, deviceId, transport: {
    async register() {}, async requestJson() { return { ok: true, deviceId: receipt.deviceId, requestId: receipt.requestId,
      releaseId: receipt.releaseId, archiveSha256: receipt.archiveSha256, stage: receipt.stage, at: receipt.at, payloadSha256: receipt.payloadSha256 }; },
  } });
  await delivery.flush();
  assert.deepEqual(await journal.pending(deviceId), []);
});

test("delivery leaves receipt pending when network or acknowledgement fails", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-receipt-delivery-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID();
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "healthy", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  const journal = createUpdateReceiptJournal(root); await journal.record(receipt);
  const delivery = createUpdateReceiptDelivery({ journal, deviceId, transport: {
    async register() { throw new Error("offline"); }, async requestJson() { throw new Error("unreachable"); },
  } });
  await assert.rejects(() => delivery.flush(), /offline/); assert.equal((await journal.pending(deviceId)).length, 1);
});

for (const original of [Object.freeze(Object.assign(new Error("registration unavailable"), {
  code: "DESKTOP_DEVICE_REGISTRATION_FAILED", requestId: "registration-request",
})), undefined, null, false]) {
  test(`registration rejection ${String(original)} retains the pending receipt context`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-receipt-register-context-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const deviceId = crypto.randomUUID();
    const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
      archiveSha256: "a".repeat(64), stage: "healthy", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
    const journal = createUpdateReceiptJournal(root); await journal.record(receipt);
    const file = path.join(root, "update-receipts.jsonl"), before = await fs.readFile(file);
    const delivery = createUpdateReceiptDelivery({ journal, deviceId, transport: {
      async register() { throw original; },
      async requestJson() { assert.fail("registration failure must prevent receipt upload"); },
    } });
    await assert.rejects(() => delivery.flush(), (error: any) => {
      assert.ok(error !== null && typeof error === "object");
      assert.equal(error.code, "DESKTOP_UPDATE_RECEIPT_SEND_FAILED");
      assert.equal(error.requestId, receipt.requestId);
      assert.equal(Object.hasOwn(error, "cause"), true);
      assert.equal(error.cause, original);
      return true;
    });
    assert.deepEqual(await fs.readFile(file), before);
    assert.deepEqual(await createUpdateReceiptJournal(root).pending(deviceId), [receipt]);
  });
}

test("registration cancellation retains the original stop reason in the receipt failure chain", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-receipt-register-cancel-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID(), stop = new Error("controlled stop"), abort = new AbortController();
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "received", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  const journal = createUpdateReceiptJournal(root); await journal.record(receipt); abort.abort(stop);
  const delivery = createUpdateReceiptDelivery({ journal, deviceId, signal: abort.signal, transport: {
    async register(options) { assert.equal(options?.signal, abort.signal); options.signal.throwIfAborted(); },
    async requestJson() { assert.fail("cancelled registration must not upload a receipt"); },
  } });
  await assert.rejects(() => delivery.flush(), (error: any) => {
    assert.equal(error.code, "DESKTOP_UPDATE_RECEIPT_SEND_FAILED");
    assert.equal(error.requestId, receipt.requestId);
    assert.equal(error.cause, stop);
    return true;
  });
  assert.deepEqual(await createUpdateReceiptJournal(root).pending(deviceId), [receipt]);
});

test("real registration failure retains both request identities and replays the receipt after recovery", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-receipt-register-http-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identityDir = path.join(root, "identity"), identity = await loadOrCreateDeviceIdentity(identityDir), deviceId = identity.deviceId;
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "healthy", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  const journal = createUpdateReceiptJournal(root); await journal.record(receipt);
  const journalPath = path.join(root, "update-receipts.jsonl"), before = await fs.readFile(journalPath);
  const requests: Array<{ method: string; url: string; requestId: string; timestamp: number; signature: string; body: Buffer }> = [];
  let unavailable = true;
  // 仅回环响应注入故障，登记、签名和回执持久化均使用原实现。
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ method: request.method!, url: request.url!, requestId: String(request.headers["x-codeflow-request-id"]),
      timestamp: Number(request.headers["x-codeflow-timestamp"]), signature: String(request.headers["x-codeflow-signature"]), body: Buffer.concat(chunks) });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/software/desktop/devices/register") {
      if (unavailable) { response.writeHead(503); response.end(JSON.stringify({ ok: false, code: "DESKTOP_DEVICE_REGISTRATION_UNAVAILABLE" })); }
      else response.end(JSON.stringify({ ok: true, deviceId,
        publicKeySha256: crypto.createHash("sha256").update(Buffer.from(identity.publicKeyBase64, "base64")).digest("hex") }));
    } else response.end(JSON.stringify({ ok: true, deviceId, requestId: receipt.requestId, releaseId: receipt.releaseId,
      archiveSha256: receipt.archiveSha256, stage: receipt.stage, at: receipt.at, payloadSha256: receipt.payloadSha256 }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const transport = createDesktopUpdateTransport({ dataDir: identityDir, identity,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  const delivery = createUpdateReceiptDelivery({ journal, deviceId, transport });
  await assert.rejects(() => delivery.flush(), (error: any) => {
    assert.equal(error.code, "DESKTOP_UPDATE_RECEIPT_SEND_FAILED");
    assert.equal(error.requestId, receipt.requestId);
    assert.equal(error.cause.code, "DESKTOP_DEVICE_REGISTRATION_UNAVAILABLE");
    assert.equal(error.cause.status, 503);
    assert.equal(error.cause.requestId, requests[0]!.requestId);
    assert.notEqual(error.cause.requestId, receipt.requestId);
    return true;
  });
  assert.deepEqual(requests.map(request => request.url), ["/api/software/desktop/devices/register"]);
  assert.deepEqual(await fs.readFile(journalPath), before);
  assert.deepEqual(await createUpdateReceiptJournal(root).pending(deviceId), [receipt]);
  unavailable = false;
  await delivery.flush();
  assert.deepEqual(requests.map(request => request.url), ["/api/software/desktop/devices/register",
    "/api/software/desktop/devices/register", "/api/software/desktop/update-receipts"]);
  assert.deepEqual(JSON.parse(requests[2]!.body.toString("utf8")), receipt);
  assert.equal(requests[2]!.requestId, receipt.requestId);
  for (const request of requests) verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({
    deviceId, method: request.method, url: request.url, requestId: request.requestId, timestamp: request.timestamp, body: request.body,
  }), request.signature);
  assert.deepEqual(await createUpdateReceiptJournal(root).pending(deviceId), []);
  await delivery.flush();
  assert.equal(requests.length, 3);
});

test("delivery exposes the requestId of the pending receipt that actually failed", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-receipt-delivery-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID();
  const first = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "received", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  const second = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "verified", at: "2026-10-24T00:00:01.000Z", errorCode: null, errorId: null });
  const journal = createUpdateReceiptJournal(root); await journal.record(first); await journal.record(second);
  let sent = 0;
  const delivery = createUpdateReceiptDelivery({ journal, deviceId, transport: {
    async register() {},
    async requestJson(input) {
      sent += 1;
      if (sent === 2) throw Object.assign(new Error("offline"), { code: "DESKTOP_UPDATE_UNAVAILABLE" });
      return { ok: true, deviceId: first.deviceId, requestId: first.requestId, releaseId: first.releaseId,
        archiveSha256: first.archiveSha256, stage: first.stage, at: first.at, payloadSha256: first.payloadSha256 };
    },
  } });
  await assert.rejects(() => delivery.flush(), (error: any) => {
    assert.equal(error.requestId, second.requestId);
    assert.equal(error.code, "DESKTOP_UPDATE_RECEIPT_SEND_FAILED");
    return true;
  });
  assert.deepEqual(await journal.pending(deviceId), [second]);
});

test("delivery rejects an acknowledgement envelope with unknown fields", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-receipt-delivery-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID();
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "prepared", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  const journal = createUpdateReceiptJournal(root); await journal.record(receipt);
  const delivery = createUpdateReceiptDelivery({ journal, deviceId, transport: {
    async register() {}, async requestJson() { return { ok: true, deviceId: receipt.deviceId, requestId: receipt.requestId,
      releaseId: receipt.releaseId, archiveSha256: receipt.archiveSha256, stage: receipt.stage, at: receipt.at, payloadSha256: receipt.payloadSha256, extra: true }; },
  } });
  await assert.rejects(() => delivery.flush(), /DESKTOP_UPDATE_RECEIPT_ACK_INVALID/);
  assert.deepEqual(await journal.pending(deviceId), [receipt]);
});
