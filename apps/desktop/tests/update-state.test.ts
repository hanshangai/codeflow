import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import test from "node:test";
import type { DesktopBridgeApi, DesktopUpdateState } from "@codeflowai/shared";
import { createDesktopApplication, type DesktopHost } from "../src/desktopApplication.js";
import type { ClientRuntime } from "../src/clientRuntime.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { desktopDevicePublicKeySha256, readDesktopDeviceHeaders } from "@codeflowai/shared/desktop-device-auth";
import { createUpdateReceiptJournal } from "../src/updateReceiptJournal.js";
import { createDesktopUpdateReceipt } from "@codeflowai/shared/desktop-update-receipt";
import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";
import { toUpdateDiagnosticCause, toShellUpdateDiagnosticCause } from "@codeflowai/shared/desktop-update-failure";

/** 真实身份/HTTP/应用入口；仅窗口与Client进程隔离，不替换更新业务。 */
async function fixture(t: test.TestContext, options: { network?: boolean; start?: boolean } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-update-state-")), identity = await loadOrCreateDeviceIdentity(dataDir);
  const requests: string[] = [], actions: string[] = [], serverErrors: unknown[] = [];
  let bridge!: DesktopBridgeApi;
  const control = { reject: false, failReceipt: false, hold: undefined as (() => Promise<void>) | undefined };
  const server = http.createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) { /* 排空真实请求体，测试不打印其内容。 */ }
      requests.push(request.url!); response.setHeader("content-type", "application/json");
      const meta = readDesktopDeviceHeaders(request.rawHeaders);
      if (request.url!.endsWith("/devices/register")) response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId,
        publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      else if (request.url!.endsWith("/update-receipts")) { response.writeHead(control.failReceipt ? 403 : 500); response.end("{}"); }
      else {
        await control.hold?.();
        if (control.reject) { response.writeHead(403); response.end("{}"); }
        else response.end(JSON.stringify({ ok: true, available: false, deviceId: identity.deviceId, requestId: meta.requestId }));
      }
    })().catch(error => { serverErrors.push(error); response.destroy(error as Error); });
  });
  if (options.network) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const runtime: ClientRuntime = { async start() {}, async waitReady() {}, async stop() {}, async drain() { actions.push("drain"); },
    async request(request) { actions.push(request.method); throw new Error("UNEXPECTED_CLIENT_CALL"); }, onEvent: () => () => {},
    snapshot: () => ({ status: "ready", requestId: null, releaseId: null, errorCode: null, pid: 123,
      health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 101, database: "ready" } }) };
  const window = Object.assign(new EventEmitter(), { show() {}, focus() {}, hide() {}, destroy() {} });
  const host: DesktopHost = { createWindow: () => window, loadWeb: async () => {}, createTray: () => ({ destroy() {} }),
    registerBridge: value => { bridge = value; return () => {}; }, quit() { actions.push("quit"); }, onUpdateError() {}, onUpdateRetry() {} };
  const app = createDesktopApplication({ dataDir, initialReleaseDir: dataDir, host, createRuntime: () => runtime,
    ...(options.network ? { configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` } : {}) });
  if (options.start !== false) await app.start();
  t.after(async () => {
    try { if (options.start !== false) await app.exit(); }
    finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await fs.rm(dataDir, { recursive: true, force: true });
    }
    assert.deepEqual(serverErrors, []);
  });
  return { app, bridge, runtime, control, dataDir, identity, requests, actions };
}

/** 在RED阶段也先断言能力存在，避免缺方法掩盖为夹具异常。 */
function getState(target: unknown): () => Promise<DesktopUpdateState> {
  const method = (target as { getUpdateState?: () => Promise<DesktopUpdateState> }).getUpdateState;
  assert.equal(typeof method, "function", "fixed getUpdateState capability is required"); return method!;
}

test("update state is a current-identity isolated snapshot with no runtime/network/disk effects", async t => {
  const f = await fixture(t), get = getState(f.bridge), before = await fs.readdir(f.dataDir);
  const state = await get();
  assert.deepEqual(state, { deviceId: f.identity.deviceId, operation: "idle", checking: false, transportConfigured: false,
    automaticUpdates: false, updatesSuppressed: false, stoppingUpdates: false, shellOwned: false,
    updateCheckFailure: null, shellUpdateFailure: null, updateReceiptFailure: null, updateFailureFailure: null });
  state.deviceId = "other-device";
  assert.equal((await get()).deviceId, f.identity.deviceId);
  assert.deepEqual(await fs.readdir(f.dataDir), before); assert.deepEqual(f.requests, []); assert.deepEqual(f.actions, []);
});

test("update state rejects identity-not-ready with a structured cause instead of empty success", async t => {
  const f = await fixture(t, { start: false }), get = getState(f.app);
  await assert.rejects(get(), error => {
    assert.ok(error instanceof Error); assert.equal((error as Error & { code: string }).code, "DESKTOP_UPDATE_STATE_FAILED");
    assert.equal((error.cause as { code: string }).code, "DESKTOP_DEVICE_IDENTITY_NOT_READY"); return true;
  });
  assert.deepEqual(f.actions, []);
});

test("update state observes an existing exit gate without joining or advancing it", async t => {
  const f = await fixture(t), get = getState(f.bridge);
  let entered!: () => void, release!: () => void;
  const draining = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.runtime.drain = async () => { entered(); await gate; };
  const flight = f.app.exit(); await draining;
  try { const state = await get(); assert.equal(state.operation, "exiting"); assert.equal(state.stoppingUpdates, true); }
  finally { release(); await flight; f.runtime.drain = async () => {}; }
});

test("bridge manual checks join the original automatic flight and return only void", async t => {
  const f = await fixture(t, { network: true }), get = getState(f.bridge);
  let entered!: () => void, release!: () => void;
  const discovered = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.control.hold = async () => { entered(); await gate; };
  f.app.startAutomaticUpdates(); await discovered;
  const state = await get(); assert.equal(state.operation, "checking"); assert.equal(state.checking, true);
  assert.equal(state.transportConfigured, true); assert.equal(state.automaticUpdates, true);
  const check = (f.bridge as { checkForUpdates?: () => Promise<void> }).checkForUpdates;
  try { assert.equal(typeof check, "function", "fixed checkForUpdates capability is required"); }
  finally { release(); }
  assert.deepEqual(await Promise.all([check!(), check!()]), [undefined, undefined]);
  assert.equal(f.requests.filter(url => url.includes("release-availability")).length, 1);
  assert.equal((await get()).checking, false); assert.deepEqual(f.actions, []);
});

test("manual bridge does not leak ActiveRelease even if the original application result has private paths", async t => {
  const f = await fixture(t);
  const check = (f.bridge as { checkForUpdates?: () => Promise<void> }).checkForUpdates;
  assert.equal(typeof check, "function");
  let calls = 0;
  f.app.checkForUpdates = () => { calls++; return Promise.resolve({ releaseDir: "PRIVATE_PATH", manifest: { signature: "PRIVATE_SIGNATURE" } } as never); };
  assert.equal(await check!(), undefined); assert.equal(calls, 1);
});

test("update state keeps existing faults safe and detached without evaluating error getters", async t => {
  const f = await fixture(t, { network: true }), get = getState(f.bridge);
  f.control.reject = true; await assert.rejects(f.app.checkForUpdates());
  assert.ok(f.app.updateCheckFailure);
  let reads = 0;
  const cause = new Error("PRIVATE_BODY");
  Object.defineProperties(cause, { code: { get() { reads++; throw new Error("PRIVATE_GETTER"); } },
    stack: { get() { reads++; throw new Error("PRIVATE_STACK"); } } });
  f.app.updateCheckFailure.error = new Error("DESKTOP_RELEASE_DOWNLOAD_FAILED: PRIVATE_PATH", { cause });
  const state = await get();
  assert.ok(state.updateCheckFailure);
  assert.equal(state.updateCheckFailure.rootCause.code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
  assert.equal(state.updateCheckFailure.rootCause.causes![0]!.code, "UNCLASSIFIED_ERROR");
  assert.equal(reads, 0); assert.doesNotMatch(JSON.stringify(state), /PRIVATE/);
  state.updateCheckFailure.rootCause.code = "MUTATED";
  assert.equal((await get()).updateCheckFailure!.rootCause.code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
});

test("receipt delivery failure blocks bridge discovery and is projected through the existing public diagnostic map", async t => {
  const f = await fixture(t, { network: true }), get = getState(f.bridge);
  const check = (f.bridge as { checkForUpdates?: () => Promise<void> }).checkForUpdates;
  assert.equal(typeof check, "function"); f.control.failReceipt = true;
  const requestId = crypto.randomUUID();
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: f.identity.deviceId, requestId, releaseId: "candidate",
    archiveSha256: "a".repeat(64), stage: "received", at: new Date().toISOString(), errorCode: null, errorId: null });
  await createUpdateReceiptJournal(f.dataDir).record(receipt);
  await assert.rejects(check!());
  assert.equal(f.requests.some(url => url.includes("release-availability")), false);
  const state = await get(); assert.ok(state.updateReceiptFailure); assert.equal(state.updateReceiptFailure.requestId, requestId);
  assert.equal(state.updateReceiptFailure.rootCause.code, "DESKTOP_UPDATE_HTTP_FAILED");
  assert.equal(state.operation, "idle"); assert.equal(state.checking, false);
});

test("state rejects invalid retained request correlation without leaking arbitrary text", async t => {
  const f = await fixture(t, { network: true }), get = getState(f.bridge);
  f.control.reject = true; await assert.rejects(f.app.checkForUpdates());
  f.app.updateCheckFailure!.requestId = "PRIVATE/path?token=secret";
  await assert.rejects(get(), error => {
    assert.ok(error instanceof Error); assert.equal((error as Error & { code: string }).code, "DESKTOP_UPDATE_STATE_FAILED");
    assert.doesNotMatch(error.message, /PRIVATE|secret/); return true;
  });
});

test("bridge correlates the actual update failure but never labels a lifecycle rejection with its old request", async t => {
  const f = await fixture(t, { network: true });
  f.control.reject = true;
  await assert.rejects(f.bridge.checkForUpdates!(), error => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { updateRequestId: string }).updateRequestId, f.app.updateCheckFailure!.requestId);
    return true;
  });
  let entered!: () => void, release!: () => void;
  const draining = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.runtime.drain = async () => { entered(); await gate; };
  const flight = f.app.exit(); await draining;
  try {
    await assert.rejects(f.bridge.checkForUpdates!(), error => {
      assert.ok(error instanceof Error);
      assert.equal((error.cause as Error).message, "DESKTOP_OPERATION_IN_PROGRESS");
      assert.equal((error as Error & { updateRequestId?: string }).updateRequestId, undefined);
      return true;
    });
  } finally { release(); await flight; f.runtime.drain = async () => {}; }
});

test("error delivery blocks a new check and state never exposes an unknown retained diagnostic code", async t => {
  const f = await fixture(t, { network: true }), get = getState(f.bridge), requestId = crypto.randomUUID();
  createUpdateFailureJournal(f.dataDir).record({ deviceId: f.identity.deviceId, shellVersion: "1.0.0", currentReleaseId: "installation",
    webVersion: "1.0.0", clientVersion: "1.0.0", requestId, releaseId: "candidate", phase: "download", recovery: "not_needed", error: new Error("EIO") });
  f.control.reject = true;
  await assert.rejects(f.bridge.checkForUpdates!());
  assert.equal(f.requests.some(url => url.includes("release-availability")), false);
  assert.equal((await get()).updateFailureFailure!.requestId, requestId);
  f.app.updateFailureFailure!.errorCode = "PRIVATE_SECRET_CODE";
  assert.equal((await get()).updateFailureFailure!.rootCause.code, "UNCLASSIFIED_ERROR");
  assert.doesNotMatch(JSON.stringify(await get()), /PRIVATE/);
});

for (const cause of [false, null, undefined, 0, "", new Error("original failure")]) {
  test(`application check bridge retains original rejected cause ${String(cause)} and device context`, async t => {
    const f = await fixture(t);
    f.app.checkForUpdates = async () => { throw cause; };
    await assert.rejects(f.bridge.checkForUpdates!(), error => {
      assert.ok(error instanceof Error); assert.equal(error.cause, cause);
      assert.equal((error as Error & { deviceId: string }).deviceId, f.identity.deviceId); return true;
    });
  });
}

/** 执行原闭包查询与投影器，仅注入原闭包事实，覆盖无法经页面设置的壳持有态。 */
async function snapshotFacts(facts: Record<string, unknown>): Promise<DesktopUpdateState> {
  const source = await fs.readFile(new URL("../src/desktopApplication.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("desktopApplication.ts", source, ts.ScriptTarget.Latest, true);
  let query: ts.VariableDeclaration | undefined;
  /** 定位真实getUpdateState，不在测试中重写其派生逻辑。 */
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "getUpdateState") query = node;
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(query?.initializer);
  const functions = ast.statements.filter(ts.isFunctionDeclaration).map(node => node.getFullText(ast)).join("\n");
  const compiled = ts.transpileModule(functions + "\nconst get = " + query.initializer.getText(ast) + "; get();", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return await vm.runInNewContext(compiled, { exports: {}, Error, AggregateError, SyntaxError, Object, Reflect, Array,
    toUpdateDiagnosticCause, toShellUpdateDiagnosticCause, identity: { deviceId: "current" }, operation: "checking", updateFlight: Promise.resolve(),
    transport: {}, automaticUpdates: true, updatesSuppressed: true, stoppingUpdates: true, shellOwner: {},
    updateCheckFailure: null, shellUpdateFailure: null, receiptDeliveryFailure: null, failureDeliveryFailure: null, ...facts });
}

test("state projects all original owner/scheduling flags and four fault boundaries without exposing owner methods", async () => {
  let reads = 0;
  const owner = Object.defineProperty({}, "check", { get() { reads++; throw new Error("OWNER_CALLED"); } });
  const state = await snapshotFacts({ shellOwner: owner,
    updateCheckFailure: { requestId: "hot-1", error: new TypeError("PRIVATE", { cause: Object.assign(new Error("PRIVATE"), { code: "EACCES" }) }) },
    shellUpdateFailure: { requestId: "shell-1", error: new Error("DESKTOP_SHELL_OPERATION_FAILED", { cause: new Error("DESKTOP_SHELL_HEALTH_FAILED") }) },
    receiptDeliveryFailure: { requestId: "receipt-1", errorCode: "EIO" },
    failureDeliveryFailure: { requestId: "failure-1", errorCode: "PRIVATE_UNKNOWN" } });
  assert.equal(state.operation, "checking");
  for (const flag of ["checking", "transportConfigured", "automaticUpdates", "updatesSuppressed", "stoppingUpdates", "shellOwned"] as const) assert.equal(state[flag], true);
  assert.equal(state.updateCheckFailure!.rootCause.name, "TypeError");
  assert.equal(state.updateCheckFailure!.rootCause.causes![0]!.code, "EACCES");
  assert.equal(state.shellUpdateFailure!.rootCause.code, "DESKTOP_SHELL_OPERATION_FAILED");
  assert.equal(state.shellUpdateFailure!.rootCause.causes![0]!.code, "DESKTOP_SHELL_HEALTH_FAILED");
  assert.equal(state.updateReceiptFailure!.rootCause.code, "EIO");
  assert.equal(state.updateFailureFailure!.rootCause.code, "UNCLASSIFIED_ERROR");
  assert.equal(reads, 0); assert.doesNotMatch(JSON.stringify(state), /PRIVATE|OWNER_CALLED|helperOwner|canRetry|releaseDir/);
});
