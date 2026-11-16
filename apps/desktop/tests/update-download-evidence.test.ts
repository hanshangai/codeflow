import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { buildDesktopDevicePayload, desktopDevicePublicKeySha256, verifyDesktopDeviceSignature } from "@codeflowai/shared/desktop-device-auth";
import { signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import { assertUpdateFailureRecord, type UpdateFailureRecord } from "@codeflowai/shared/desktop-update-failure";
import { createDesktopApplication, type DesktopHost } from "../src/desktopApplication.js";
import type { ClientRuntime } from "../src/clientRuntime.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { readActivePointer } from "../src/releaseBundleCoordinator.js";
import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";
import { createUpdateReceiptJournal } from "../src/updateReceiptJournal.js";

/** 只使用临时身份、签名字节和真实 HTTP；窗口与 Client 不执行实际业务。 */
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-download-evidence-"));
  const identity = await loadOrCreateDeviceIdentity(root);
  const keys = crypto.generateKeyPairSync("ed25519");
  const archive = Buffer.from("PRIVATE_ARCHIVE_CONTENT\n".repeat(4096));
  const archiveSha256 = crypto.createHash("sha256").update(archive).digest("hex");
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: "evidence-release", version: "2.0.0",
    webVersion: "2.0.0", clientVersion: "2.0.0", protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 92,
    platform: process.platform, arch: process.arch, webSha256: "a".repeat(64), clientSha256: "b".repeat(64),
    packageSha256: "c".repeat(64), archiveSha256, archiveSize: archive.length,
    files: [{ path: "client/dist/index.cjs", size: 1, sha256: "d".repeat(64) }, { path: "web/index.html", size: 1, sha256: "e".repeat(64) }],
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyId: "fixture" }, keys.privateKey);
  const directory = path.join(root, ".staging", `download-${crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`);
  const partPath = path.join(directory, "bundle.tar.gz.part");
  const actions: string[] = [];
  const archiveRequests: Array<{ range?: string; ifMatch?: string; requestId: string }> = [];
  const failures: UpdateFailureRecord[] = [];
  const failureRequestIds: string[] = [];
  const serverErrors: unknown[] = [];
  const handlers: Promise<void>[] = [];
  let mode: "interrupt" | "complete" = "interrupt";
  let ack: "http-failure" | "disconnect" | "mismatch" | "exact" = "exact";
  let interruptedResponse: http.ServerResponse | undefined;
  let responseStarted!: () => void;
  const started = new Promise<void>(resolve => { responseStarted = resolve; });
  const server = http.createServer((request, response) => {
    handlers.push(serve(request, response).catch(error => {
      serverErrors.push(error);
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }));
  });

  /** 服务端核验真实签名；只注入正文断流或失败 ACK，不伪造产品侧结果。 */
  async function serve(request: http.IncomingMessage, response: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const requestId = String(request.headers["x-codeflow-request-id"]);
    verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ deviceId: identity.deviceId,
      method: request.method!, url: request.url!, body: bytes, requestId, timestamp: Number(request.headers["x-codeflow-timestamp"]),
      range: request.headers.range, ifMatch: request.headers["if-match"] }), String(request.headers["x-codeflow-signature"]));
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/software/desktop/devices/register") {
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
    } else if (request.url === "/api/software/desktop/release") {
      response.end(JSON.stringify(manifest));
    } else if (request.url === `/api/software/desktop/releases/${manifest.releaseId}/archive`) {
      archiveRequests.push({ range: request.headers.range, ifMatch: request.headers["if-match"], requestId });
      const start = request.headers.range ? Number(/^bytes=(\d+)-$/u.exec(request.headers.range)![1]) : 0;
      response.writeHead(start ? 206 : 200, { "content-type": "application/octet-stream", etag: `"${archiveSha256}"`,
        "content-length": archive.length - start, ...(start ? { "content-range": `bytes ${start}-${archive.length - 1}/${archive.length}` } : {}) });
      if (mode === "interrupt") {
        interruptedResponse = response;
        response.write(archive.subarray(0, 4096));
        responseStarted();
      } else response.end(archive.subarray(start));
    } else if (request.url === "/api/software/desktop/update-receipts") {
      const value = JSON.parse(bytes.toString("utf8"));
      response.end(JSON.stringify({ ok: true, deviceId: value.deviceId, requestId: value.requestId, releaseId: value.releaseId,
        archiveSha256: value.archiveSha256, stage: value.stage, at: value.at, payloadSha256: value.payloadSha256 }));
    } else if (request.url === "/api/software/desktop/update-failures") {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      assertUpdateFailureRecord(value);
      failures.push(value);
      failureRequestIds.push(requestId);
      if (ack === "disconnect") response.destroy();
      else if (ack === "http-failure") {
        response.writeHead(503);
        response.end(JSON.stringify({ ok: false, code: "DESKTOP_UPDATE_HTTP_FAILED" }));
      } else response.end(JSON.stringify({ ok: true, deviceId: value.deviceId, errorId: value.errorId,
        payloadSha256: ack === "mismatch" ? "0".repeat(64) : value.payloadSha256 }));
    } else throw new Error(`UNEXPECTED_TEST_ROUTE: ${request.method} ${request.url}`);
  }

  const runtime: ClientRuntime = {
    start: async () => { actions.push("start"); }, waitReady: async () => {}, stop: async () => { actions.push("stop"); },
    drain: async () => { actions.push("drain"); }, request: async () => { throw new Error("UNEXPECTED_CLIENT_REQUEST"); },
    onEvent: () => () => {}, snapshot: () => ({ status: "ready", requestId: null, releaseId: null, errorCode: null, pid: 123,
      health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 92, database: "ready" } }),
  };
  const window = Object.assign(new EventEmitter(), {
    show: () => {}, focus: () => {}, hide: () => {}, destroy: () => { actions.push("destroy"); },
  });
  const host: DesktopHost = {
    createWindow: () => window, loadWeb: async () => { actions.push("load-web"); },
    createTray: () => ({ destroy: () => {} }), registerBridge: () => () => {}, quit: () => { actions.push("quit"); },
  };
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const app = createDesktopApplication({ dataDir: root, initialReleaseDir: root, shellVersion: "1.0.0", host, createRuntime: () => runtime,
    trustedReleaseKeys: { fixture: keys.publicKey }, configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  t.after(async () => {
    const errors: unknown[] = [];
    server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    catch (error) { errors.push(error); }
    for (const result of await Promise.allSettled(handlers)) if (result.status === "rejected") errors.push(result.reason);
    errors.push(...serverErrors);
    try { await app.exit(); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "DOWNLOAD_EVIDENCE_FIXTURE_CLEANUP_FAILED");
    await fs.rm(root, { recursive: true, force: true });
  });
  await app.start();

  /** 等真实部分文件写入后才断开，避免用固定延时猜测客户端已消费正文。 */
  async function interrupt(requestId: string, check: (error: unknown) => boolean) {
    const rejection = assert.rejects(() => app.downloadAvailableReleaseBundle({ requestId }), check);
    let failure: unknown;
    try {
      await Promise.race([started, rejection.then(() => assert.fail("DOWNLOAD_FINISHED_BEFORE_INTERRUPT"))]);
      const deadline = Date.now() + 5_000;
      while ((await fs.stat(partPath)).size !== 4096) {
        assert.ok(Date.now() < deadline, "PARTIAL_ARCHIVE_NOT_WRITTEN");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } catch (error) { failure = error; }
    finally { interruptedResponse?.destroy(); }
    try { await rejection; }
    catch (error) {
      if (failure !== undefined && failure !== error) throw new AggregateError([failure, error], "DOWNLOAD_EVIDENCE_INTERRUPT_FAILED");
      throw error;
    }
    if (failure !== undefined) throw failure;
  }

  return { root, app, identity, manifest, archive, archiveSha256, directory, partPath, actions, archiveRequests, failures, failureRequestIds,
    interrupt, complete: () => { mode = "complete"; }, setAck: (value: typeof ack) => { ack = value; } };
}

/** 固定诊断和业务身份，不把未知异常原文或归档内容写入错误日志。 */
async function evidence(f: Awaited<ReturnType<typeof fixture>>, requestId: string) {
  const journal = createUpdateFailureJournal(f.root);
  const pending = journal.pending(f.identity.deviceId);
  assert.equal(pending.length, 1);
  const record = pending[0]!;
  assertUpdateFailureRecord(record);
  assert.deepEqual({ deviceId: record.deviceId, requestId: record.requestId, releaseId: record.releaseId,
    phase: record.phase, recovery: record.recovery, currentReleaseId: record.currentReleaseId, shellVersion: record.shellVersion,
    webVersion: record.webVersion, clientVersion: record.clientVersion, errorCode: record.errorCode, rootCode: record.rootCause.code },
  { deviceId: f.identity.deviceId, requestId, releaseId: f.manifest.releaseId, phase: "download", recovery: "not_needed",
    currentReleaseId: "installation", shellVersion: "1.0.0", webVersion: "1.0.0", clientVersion: "1.0.0",
    errorCode: "DESKTOP_RELEASE_FAILED", rootCode: "DESKTOP_RELEASE_DOWNLOAD_FAILED" });
  const contents = await fs.readFile(path.join(f.root, "errors.jsonl"), "utf8");
  assert.equal(contents.trim().split("\n").length, 1);
  assert.equal(contents.includes("PRIVATE_"), false);
  assert.equal(contents.includes(f.root.replaceAll("\\", "\\\\")), false);
  await assert.rejects(() => fs.access(path.join(f.root, "update-receipts.jsonl")), { code: "ENOENT" });
  assert.deepEqual(await createUpdateReceiptJournal(f.root).pending(f.identity.deviceId), []);
  assert.equal(f.actions.includes("drain"), false);
  assert.equal(f.actions.includes("stop"), false);
  assert.equal(await readActivePointer(f.root), null);
  return record;
}

test("archive body interruption persists one safe failure and explicit resume preserves its evidence", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const requestId = crypto.randomUUID();
  await f.interrupt(requestId, error => {
    assert.equal((error as { code: string }).code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
    assert.equal((error as { requestId: string }).requestId, requestId);
    return true;
  });
  const record = await evidence(f, requestId);
  assert.deepEqual(await fs.readFile(f.partPath), f.archive.subarray(0, 4096));
  await assert.rejects(() => fs.access(path.join(f.directory, "bundle.tar.gz")), { code: "ENOENT" });
  f.complete();
  const downloaded = await f.app.downloadAvailableReleaseBundle({ requestId });
  assert.equal(downloaded.requestId, requestId);
  assert.equal(downloaded.manifest.archiveSha256, f.archiveSha256);
  assert.deepEqual(await fs.readFile(downloaded.archivePath), f.archive);
  assert.deepEqual(f.archiveRequests, [
    { range: undefined, ifMatch: `"${f.archiveSha256}"`, requestId },
    { range: "bytes=4096-", ifMatch: `"${f.archiveSha256}"`, requestId },
  ]);
  await assert.rejects(() => fs.access(f.partPath), { code: "ENOENT" });
  assert.deepEqual(createUpdateFailureJournal(f.root).pending(f.identity.deviceId), [record]);
  assert.deepEqual(await createUpdateReceiptJournal(f.root).pending(f.identity.deviceId), []);
  const receipts = (await fs.readFile(path.join(f.root, "update-receipts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].kind, "receipt");
  assert.equal(receipts[0].receipt.stage, "received");
  assert.equal(receipts[0].receipt.requestId, requestId);
  assert.equal(receipts[0].receipt.archiveSha256, f.archiveSha256);
  assert.equal(receipts[1].kind, "ack");
  assert.equal(f.actions.includes("drain"), false);
  assert.equal(await readActivePointer(f.root), null);
});

for (const rejectedAck of ["http-failure", "disconnect", "mismatch"] as const) {
  test(`interrupted download evidence survives ${rejectedAck} and replays the exact record`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const requestId = crypto.randomUUID();
    await f.interrupt(requestId, error => {
      assert.equal((error as { code: string }).code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
      return true;
    });
    const record = await evidence(f, requestId);
    const original = await fs.readFile(path.join(f.root, "errors.jsonl"));
    f.setAck(rejectedAck);
    await assert.rejects(() => f.app.flushFailures(), error => {
      assert.equal((error as { requestId: string }).requestId, requestId);
      assert.equal((error as { code: string }).code, rejectedAck === "mismatch" ? "DESKTOP_UPDATE_FAILURE_ACK_INVALID"
        : rejectedAck === "disconnect" ? "DESKTOP_UPDATE_TRANSPORT_FAILED" : "DESKTOP_UPDATE_HTTP_FAILED");
      return true;
    });
    assert.deepEqual(await fs.readFile(path.join(f.root, "errors.jsonl")), original);
    assert.deepEqual(createUpdateFailureJournal(f.root).pending(f.identity.deviceId), [record]);
    f.setAck("exact");
    await f.app.flushFailures();
    await f.app.flushFailures();
    assert.deepEqual(f.failures, [record, record]);
    assert.deepEqual(f.failureRequestIds, [record.errorId, record.errorId]);
    assert.deepEqual(createUpdateFailureJournal(f.root).pending(f.identity.deviceId), []);
    const lines = (await fs.readFile(path.join(f.root, "errors.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(lines, [record, { schemaVersion: 1, kind: "ack", errorId: record.errorId,
      deviceId: record.deviceId, payloadSha256: record.payloadSha256 }]);
    assert.equal(f.archiveRequests.length, 1);
    assert.equal(f.actions.includes("drain"), false);
  });
}

test("archive interruption and evidence fsync failure keep both causes and stop before received", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const requestId = crypto.randomUUID();
  const ioError = Object.assign(new Error("PRIVATE_EVIDENCE_WRITE_ERROR"), { code: "EIO" });
  const original = fsSync.fsyncSync;
  let injected = false;
  const sync = t.mock.method(fsSync, "fsyncSync", (...args: Parameters<typeof fsSync.fsyncSync>) => {
    if (!injected) { injected = true; throw ioError; }
    return original(...args);
  });
  await f.interrupt(requestId, error => {
    assert.ok(error instanceof AggregateError);
    assert.equal((error as AggregateError & { code: string }).code, "DESKTOP_UPDATE_FAILURE_LOG_FAILED");
    assert.equal((error as AggregateError & { requestId: string }).requestId, requestId);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
    assert.equal(error.errors[1], ioError);
    return true;
  });
  sync.mock.restore();
  assert.equal(injected, true);
  assert.equal((await fs.readFile(path.join(f.root, "errors.jsonl"))).length, 0);
  assert.deepEqual(createUpdateFailureJournal(f.root).pending(f.identity.deviceId), []);
  assert.deepEqual(await createUpdateReceiptJournal(f.root).pending(f.identity.deviceId), []);
  assert.equal(f.archiveRequests.length, 1);
  await assert.rejects(() => fs.access(path.join(f.root, "update-receipts.jsonl")), { code: "ENOENT" });
  assert.equal(f.actions.includes("drain"), false);
  assert.equal(await readActivePointer(f.root), null);
});
