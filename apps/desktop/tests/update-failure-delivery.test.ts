import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";
import { deliverDesktopUpdateFailures } from "../src/updateFailureDelivery.js";
import { createDesktopUpdateTransport } from "../src/updateTransport.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { buildDesktopDevicePayload, verifyDesktopDeviceSignature, desktopDevicePublicKeySha256 } from "@codeflowai/shared/desktop-device-auth";
import { assertDesktopUpdateFailureRecord, type ShellUpdateFailureRecord } from "@codeflowai/shared/desktop-update-failure";

/** 在既有 journal 上验证新入口，RED 必须来自真实方法缺失。 */
function recordShell(journal: ReturnType<typeof createUpdateFailureJournal>, deviceId: string): ShellUpdateFailureRecord {
  const method = (journal as unknown as Record<string, unknown>).recordShell;
  assert.equal(typeof method, "function", "single failure journal must expose recordShell");
  return (method as (input: unknown) => ShellUpdateFailureRecord)({ deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1", clientVersion: "1",
    requestId: "shell-handoff-request", shellId: "shell-next", phase: "handoff", recovery: "restored", error: new Error("DESKTOP_SHELL_HANDOFF_HELPER_FAILED") });
}

test("real signed HTTP replays the exact shell failure before the later binding failure after a lost ACK", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-shell-failure-http-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = await loadOrCreateDeviceIdentity(root), journal = createUpdateFailureJournal(root);
  const shell = recordShell(journal, identity.deviceId);
  const binding = journal.record({ deviceId: identity.deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1", clientVersion: "1",
    requestId: "later-binding", releaseId: "release-next", phase: "prepare", recovery: "not_needed", error: new Error("EIO") });
  const accepted = new Map<string, string>(), sends: string[] = [], failures: unknown[] = [];
  let loseAck = true;
  /** 真实签名核原字节；受控丢 ACK 仍让客户端显式失败并停止后续发送。 */
  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), requestId = String(request.headers["x-codeflow-request-id"]);
    verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ deviceId: identity.deviceId, method: request.method!, url: request.url!, body: bytes,
      requestId, timestamp: Number(request.headers["x-codeflow-timestamp"]), range: null, ifMatch: null }), String(request.headers["x-codeflow-signature"]));
    assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/software/desktop/devices/register") {
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) })); return;
    }
    assert.equal(request.method, "POST"); assert.equal(request.url, "/api/software/desktop/update-failures");
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); assertDesktopUpdateFailureRecord(value);
    assert.equal(requestId, value.errorId); assert.equal(value.deviceId, identity.deviceId); sends.push(value.errorId);
    if (value.errorCode === "DESKTOP_SHELL_UPDATE_FAILED") { assert.equal(value.shellId, "shell-next"); assert.equal(Object.hasOwn(value, "releaseId"), false); }
    const previous = accepted.get(value.errorId); if (previous) assert.equal(previous, bytes.toString("utf8")); else accepted.set(value.errorId, bytes.toString("utf8"));
    if (loseAck) { response.destroy(); return; }
    response.end(JSON.stringify({ ok: true, errorId: value.errorId, deviceId: value.deviceId, payloadSha256: value.payloadSha256 }));
  };
  const handlers = new Set<Promise<void>>();
  const server = http.createServer((request, response) => {
    const task = handle(request, response); handlers.add(task);
    void task.then(() => handlers.delete(task), cause => { failures.push(cause); handlers.delete(task); response.destroy(cause instanceof Error ? cause : new Error("FIXTURE_HANDLER_FAILED")); });
  });
  server.on("error", error => failures.push(error));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const transport = createDesktopUpdateTransport({ dataDir: root, identity, configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  await assert.rejects(() => deliverDesktopUpdateFailures({ journal, deviceId: identity.deviceId, transport }), { code: "DESKTOP_UPDATE_TRANSPORT_FAILED", requestId: shell.requestId });
  assert.deepEqual(sends, [shell.errorId]); assert.deepEqual(createUpdateFailureJournal(root).pending(identity.deviceId), [shell, binding]);
  loseAck = false;
  await deliverDesktopUpdateFailures({ journal: createUpdateFailureJournal(root), deviceId: identity.deviceId, transport });
  assert.deepEqual(sends, [shell.errorId, shell.errorId, binding.errorId]); assert.equal(accepted.size, 2); assert.deepEqual(journal.pending(identity.deviceId), []);
  assert.equal(handlers.size, 0); assert.deepEqual(failures, []);
});

test("shell failure delivery rejects wrong ACK and retains the shell request context", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-shell-failure-ack-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID(), journal = createUpdateFailureJournal(root), shell = recordShell(journal, deviceId);
  let sends = 0;
  await assert.rejects(() => deliverDesktopUpdateFailures({ journal, deviceId, transport: {
    async register() {}, async requestJson(input) { sends++; assert.equal(input.requestId, shell.errorId); return { ok: true, deviceId, errorId: shell.errorId, payloadSha256: "0".repeat(64) }; },
  } }), { code: "DESKTOP_UPDATE_FAILURE_ACK_INVALID", requestId: shell.requestId });
  assert.equal(sends, 1); assert.deepEqual(journal.pending(deviceId), [shell]);
});

test("failure delivery keeps lost acknowledgements pending and replays exact evidence without a second outbox", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-failure-delivery-"));
  const deviceId = crypto.randomUUID();
  const journal = createUpdateFailureJournal(root);
  let registrations = 0, sends = 0;
  const received = new Map<string, string>();
  const transport = {
    async register() { registrations++; },
    async requestJson(input: any) {
      sends++;
      const record = input.body;
      assert.equal(input.path, "/api/software/desktop/update-failures");
      assert.equal(input.requestId, record.errorId);
      const original = received.get(record.errorId);
      if (original) assert.equal(JSON.stringify(record), original);
      else received.set(record.errorId, JSON.stringify(record));
      if (sends === 1) throw new Error("acknowledgement lost");
      return { ok: true, deviceId, errorId: record.errorId, payloadSha256: record.payloadSha256 };
    },
  };
  try {
    const record = journal.record({ deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1", clientVersion: "1",
      requestId: "update-request", releaseId: "release-2", phase: "prepare", recovery: "not_needed", error: new Error("private-message") });
    await assert.rejects(() => deliverDesktopUpdateFailures({ journal, deviceId, transport }), /acknowledgement lost/);
    assert.deepEqual(createUpdateFailureJournal(root).pending(deviceId), [record]);
    await deliverDesktopUpdateFailures({ journal, deviceId, transport });
    assert.equal(journal.pending(deviceId).length, 0);
    assert.equal(received.size, 1);
    assert.equal(registrations, 2);
    await deliverDesktopUpdateFailures({ journal, deviceId, transport });
    await deliverDesktopUpdateFailures({ journal, deviceId: crypto.randomUUID(), transport });
    assert.equal(registrations, 2);
    assert.deepEqual(await fs.readdir(root), ["errors.jsonl"]);
    assert.doesNotMatch(await fs.readFile(path.join(root, "errors.jsonl"), "utf8"), /private-message/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("registration failure or wrong acknowledgement never confirms the original recovery evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-failure-reject-"));
  const deviceId = crypto.randomUUID();
  const journal = createUpdateFailureJournal(root);
  let sends = 0;
  try {
    const record = journal.record({ deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1", clientVersion: "1",
      requestId: "update-request", releaseId: "release-2", phase: "health", recovery: "restored", error: new Error("EIO") });
    await assert.rejects(() => deliverDesktopUpdateFailures({ journal, deviceId, transport: {
      async register() { throw new Error("registration failed"); }, async requestJson() { sends++; return {} as any; },
    } }), /registration failed/);
    assert.equal(sends, 0);
    await assert.rejects(() => deliverDesktopUpdateFailures({ journal, deviceId, transport: {
      async register() {}, async requestJson() { sends++; return { ok: true, ...record, deviceId: crypto.randomUUID() }; },
    } }), /DESKTOP_UPDATE_FAILURE_ACK_INVALID/);
    assert.deepEqual(journal.pending(deviceId), [record]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("acknowledgement mismatch exposes a fixed error code and the failed record requestId", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-failure-ack-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID();
  const journal = createUpdateFailureJournal(root);
  const record = journal.record({ deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1", clientVersion: "1",
    requestId: "failed-request", releaseId: "release-2", phase: "prepare", recovery: "not_needed", error: new Error("EIO") });
  await assert.rejects(() => deliverDesktopUpdateFailures({ journal, deviceId, transport: {
    async register() {},
    async requestJson() { return { ok: true, deviceId, errorId: crypto.randomUUID(), payloadSha256: "f".repeat(64) }; },
  } }), (error: any) => {
    assert.equal(error.code, "DESKTOP_UPDATE_FAILURE_ACK_INVALID");
    assert.equal(error.requestId, record.requestId);
    return true;
  });
  assert.deepEqual(journal.pending(deviceId), [record]);
});

test("registration failure reports the pending record requestId instead of the registration requestId", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-failure-register-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID();
  const journal = createUpdateFailureJournal(root);
  const record = journal.record({ deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1", clientVersion: "1",
    requestId: "failure-request", releaseId: "release-2", phase: "prepare", recovery: "not_needed", error: new Error("EIO") });
  await assert.rejects(() => deliverDesktopUpdateFailures({ journal, deviceId, transport: {
    async register() { throw Object.assign(new Error("registration failed"), { code: "DESKTOP_DEVICE_REGISTRATION_FAILED", requestId: "register-request" }); },
    async requestJson() { throw new Error("must not send"); },
  } }), (error: any) => {
    assert.equal(error.code, "DESKTOP_DEVICE_REGISTRATION_FAILED");
    assert.equal(error.requestId, record.requestId);
    return true;
  });
  assert.deepEqual(journal.pending(deviceId), [record]);
});

test("delivery rejects an acknowledgement envelope with extra fields", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-failure-ack-shape-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID();
  const journal = createUpdateFailureJournal(root);
  const record = journal.record({ deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1", clientVersion: "1",
    requestId: "failure-request", releaseId: "release-2", phase: "prepare", recovery: "not_needed", error: new Error("EIO") });
  await assert.rejects(() => deliverDesktopUpdateFailures({ journal, deviceId, transport: {
    async register() {},
    async requestJson() { return { ok: true, errorId: record.errorId, deviceId, payloadSha256: record.payloadSha256, extra: "reject" }; },
  } }), (error: any) => {
    assert.equal(error.code, "DESKTOP_UPDATE_FAILURE_ACK_INVALID");
    assert.equal(error.requestId, record.requestId);
    return true;
  });
  assert.deepEqual(journal.pending(deviceId), [record]);
});
