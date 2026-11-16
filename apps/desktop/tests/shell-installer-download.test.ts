import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { ShellReleasePayload } from "@codeflowai/shared";
import { signShellReleaseManifest } from "@codeflowai/shared/desktop-shell-release-signing";
import * as download from "../src/shellInstallerDownload.js";
import * as artifact from "../src/shellReleaseArtifact.js";
import { createShellUpdateAttemptNetworkAdapter, createShellUpdateAttemptStore, type ShellUpdateAttemptV2 } from "../src/shellUpdateAttempt.js";
import { createUpdateNetworkRetry, type UpdateNetworkAction } from "../src/updateNetworkRetry.js";

const evidence = await fs.mkdtemp(path.join(os.tmpdir(), "cf-shell-installer-"));
after(() => { process.stdout.write(`D13 installer evidence: ${evidence}\n`); });

/** 合成安装器仅用于真实 HTTP/文件校验，绝不运行。 */
async function fixture() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(evidence, "fixture-")));
  const bytes = Buffer.from("synthetic installer only\n".repeat(9000));
  const keys = crypto.generateKeyPairSync("ed25519");
  const payload: ShellReleasePayload = {
    schemaVersion: 1, protocol: "codeflow-desktop-shell-v1", shellId: "shell-download-2", version: "2.0.0", platform: "win32", arch: "x64",
    installerSha256: crypto.createHash("sha256").update(bytes).digest("hex"), installerSize: bytes.length,
    files: ["CodeFlowAI.exe", "resources/app.asar", "resources/release-trust.json"].map(file => ({ path: file, size: 1, sha256: "1".repeat(64) })),
    createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2037-01-01T00:00:00.000Z", keyId: "download-test",
  };
  const manifest = signShellReleaseManifest(payload, keys.privateKey);
  return { directory, bytes, keys, manifest, trustedKeys: { "download-test": keys.publicKey }, requestId: crypto.randomUUID() };
}

/** 本地服务真实发送响应，确保关闭监听与连接后才结束用例。 */
async function server(t: test.TestContext, handle: http.RequestListener) {
  const instance = http.createServer(handle);
  await new Promise<void>((resolve, reject) => { instance.once("error", reject); instance.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { instance.closeAllConnections(); await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve())); });
  const address = instance.address(); assert.ok(address && typeof address !== "string");
  return { request: async (request: { path: string; range?: string; ifMatch?: string; signal?: AbortSignal }) => await fetch(`http://127.0.0.1:${address.port}${request.path}`,
    { headers: { ...(request.range ? { range: request.range } : {}), "if-match": request.ifMatch! }, signal: request.signal }) };
}

/** 固定签名长度、强摘要和精确区间，不靠客户端算法计算期望状态。 */
function headers(response: http.ServerResponse, f: Awaited<ReturnType<typeof fixture>>, start = 0) {
  response.writeHead(start ? 206 : 200, { "content-length": f.bytes.length - start, "content-encoding": "identity",
    etag: `"${f.manifest.installerSha256}"`, ...(start ? { "content-range": `bytes ${start}-${f.bytes.length - 1}/${f.bytes.length}` } : {}) });
}

test("a complete installer is closed and physically verified before returning; cached recovery sends nothing", async t => {
  const f = await fixture(); let sends = 0;
  const transport = await server(t, (request, response) => {
    sends += 1; assert.equal(request.url, "/api/software/desktop/shell-releases/shell-download-2/installer");
    assert.equal(request.headers["if-match"], `"${f.manifest.installerSha256}"`);
    assert.equal(request.headers.range, undefined); headers(response, f); response.end(f.bytes);
  });
  const result = await download.downloadShellInstaller({ ...f, transport });
  assert.deepEqual(await fs.readFile(result.installerPath), f.bytes);
  assert.deepEqual(await artifact.verifyShellInstallerArtifact({ manifest: f.manifest, trustedKeys: f.trustedKeys, installerPath: result.installerPath }), f.manifest);
  assert.equal((await fs.lstat(result.installerPath)).nlink, 1);
  assert.deepEqual(await fs.readdir(path.dirname(result.installerPath)), ["installer.exe"]);
  assert.equal((await download.downloadShellInstaller({ ...f, transport })).installerPath, result.installerPath);
  assert.equal(sends, 1);
});

test("installed cache proof ignores expiry only with explicit installed context and retains physical verification", async t => {
  const f = await fixture(); let sends = 0;
  const transport = await server(t, (_request, response) => { sends++; headers(response, f); response.end(f.bytes); });
  const value = await download.downloadShellInstaller({ ...f, transport });
  const expired = { ...f, now: () => Date.parse("2038-01-01T00:00:00.000Z") };
  const installed = { ...expired, installed: true as const };
  await assert.rejects(download.recoverShellInstaller(expired));
  const recovered = await download.recoverShellInstaller(installed); assert.equal(recovered.status, "verified");
  await assert.rejects(download.downloadShellInstaller({ ...expired, transport }));
  await fs.writeFile(value.installerPath, Buffer.alloc(f.bytes.length));
  await assert.rejects(download.recoverShellInstaller(installed)); assert.equal(sends, 1);
});

test("a real interrupted body preserves a synced prefix, and the next single call requests its exact Range", async t => {
  const f = await fixture(); let sends = 0, observedRange: string | undefined;
  const transport = await server(t, (request, response) => {
    sends += 1;
    if (sends === 1) { headers(response, f); response.write(f.bytes.subarray(0, 32768)); setTimeout(() => response.destroy(), 40); }
    else { observedRange = request.headers.range; const start = Number(observedRange!.match(/^bytes=(\d+)-$/u)![1]); headers(response, f, start); response.end(f.bytes.subarray(start)); }
  });
  await assert.rejects(download.downloadShellInstaller({ ...f, transport }), (error: any) => { assert.equal(error.code, "DESKTOP_UPDATE_TRANSPORT_FAILED"); return true; });
  assert.equal(sends, 1);
  const [child] = await fs.readdir(f.directory); const part = path.join(f.directory, child!, "installer.exe.part");
  assert.equal((await fs.stat(part)).size, 32768);
  const result = await download.downloadShellInstaller({ ...f, transport });
  assert.equal(observedRange, "bytes=32768-"); assert.equal(sends, 2);
  assert.deepEqual(await fs.readFile(result.installerPath), f.bytes);
});

for (const variant of ["etag", "length", "encoding", "status", "range", "hash"] as const) {
  test(`invalid ${variant} fails without publishing an installer or retrying`, async t => {
    const f = await fixture(); let sends = 0;
    const transport = await server(t, (_request, response) => {
      sends += 1;
      response.writeHead(variant === "status" ? 206 : 200, { "content-length": variant === "length" ? f.bytes.length - 1 : f.bytes.length,
        etag: variant === "etag" ? '"incorrect"' : `"${f.manifest.installerSha256}"`, "content-encoding": variant === "encoding" ? "other" : "identity",
        ...(variant === "range" ? { "content-range": `bytes 0-${f.bytes.length - 1}/${f.bytes.length}` } : {}) });
      const bytes = Buffer.from(f.bytes); if (variant === "hash") bytes[0] = bytes[0]! ^ 1;
      response.end(variant === "length" ? bytes.subarray(0, -1) : bytes);
    });
    await assert.rejects(download.downloadShellInstaller({ ...f, transport })); assert.equal(sends, 1);
    const [child] = await fs.readdir(f.directory);
    assert.deepEqual(await fs.readdir(path.join(f.directory, child!)), ["installer.exe.part"]);
  });
}

test("a rejected signature fails before directory access or HTTP", async () => {
  const f = await fixture(); let sends = 0;
  await assert.rejects(download.downloadShellInstaller({ ...f, directory: path.join(f.directory, "absent"), trustedKeys: {},
    transport: { request: async () => { sends += 1; throw new Error("must not send"); } } }));
  assert.equal(sends, 0); assert.deepEqual(await fs.readdir(f.directory), []);
});

test("read-only recovery never sends or promotes a partial unknown result", async t => {
  const f = await fixture();
  assert.deepEqual(await download.recoverShellInstaller(f), { status: "unknown" });
  const transport = await server(t, (_request, response) => { headers(response, f); response.write(f.bytes.subarray(0, 32768)); setTimeout(() => response.destroy(), 30); });
  await assert.rejects(download.downloadShellInstaller({ ...f, transport }));
  const before = await fs.readdir(f.directory);
  assert.deepEqual(await download.recoverShellInstaller(f), { status: "unknown" });
  assert.deepEqual(await fs.readdir(f.directory), before);
});

test("completed recovery rehashes the true installer and rejects tampering without a new send", async t => {
  const f = await fixture(); let sends = 0;
  const transport = await server(t, (_request, response) => { sends += 1; headers(response, f); response.end(f.bytes); });
  const result = await download.downloadShellInstaller({ ...f, transport });
  assert.deepEqual(await download.recoverShellInstaller(f), { status: "verified", value: result });
  await fs.writeFile(result.installerPath, Buffer.alloc(f.bytes.length));
  await assert.rejects(download.recoverShellInstaller(f)); assert.equal(sends, 1);
});

test("a cached installer with a partial sibling or a hard link explicitly conflicts", async t => {
  const f = await fixture(); let sends = 0;
  const transport = await server(t, (_request, response) => { sends += 1; headers(response, f); response.end(f.bytes); });
  const result = await download.downloadShellInstaller({ ...f, transport });
  await fs.writeFile(`${result.installerPath}.part`, Buffer.alloc(1));
  await assert.rejects(download.downloadShellInstaller({ ...f, transport }));
  await fs.unlink(`${result.installerPath}.part`); await fs.link(result.installerPath, path.join(f.directory, "alias.exe"));
  await assert.rejects(download.downloadShellInstaller({ ...f, transport })); assert.equal(sends, 1);
});

for (const operation of ["sync", "close", "write"] as const) {
  test(`${operation} failure explicitly blocks success and preserves the physical failure`, async t => {
    const f = await fixture(), open = fs.open, cause = Object.assign(new Error("synthetic disk failure"), { code: "ECONNRESET" });
    const transport = await server(t, (_request, response) => { headers(response, f); response.end(f.bytes); });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".part") && Number(args[1]) & 2) {
        const close = handle.close.bind(handle);
        t.mock.method(handle, operation, async () => {
          if (operation === "close") await close();
          throw cause;
        });
      }
      return handle;
    });
    await assert.rejects(download.downloadShellInstaller({ ...f, transport }), (error: any) => {
      assert.notEqual(error.code, "DESKTOP_UPDATE_TRANSPORT_FAILED"); assert.ok(hasCause(error, cause)); return true;
    });
  });
}

test("undefined reader failure and independent cancel/release errors are all preserved", async () => {
  const f = await fixture(), cancel = new Error("cancel failed"), release = new Error("release failed");
  const transport = { request: async () => ({ status: 200, headers: new Headers({ "content-length": String(f.bytes.length), etag: `"${f.manifest.installerSha256}"` }),
    body: { getReader: () => ({ read: async () => { throw undefined; }, cancel: async () => { throw cancel; }, releaseLock: () => { throw release; } }) } } as unknown as Response) };
  await assert.rejects(download.downloadShellInstaller({ ...f, transport }), (error: any) => {
    assert.ok(hasCause(error, undefined)); assert.ok(hasCause(error, cancel)); assert.ok(hasCause(error, release));
    assert.equal(error.code, "DESKTOP_SHELL_INSTALLER_DOWNLOAD_FAILED"); return true;
  });
});

test("a new Node process recovers only the signed complete physical installer", async t => {
  const f = await fixture();
  const transport = await server(t, (_request, response) => { headers(response, f); response.end(f.bytes); });
  const result = await download.downloadShellInstaller({ ...f, transport });
  const moduleUrl = pathToFileURL(path.resolve("src/shellInstallerDownload.ts")).href;
  const program = `import fs from 'node:fs'; import {recoverShellInstaller} from ${JSON.stringify(moduleUrl)};
    const input=JSON.parse(fs.readFileSync(0,'utf8')); console.log(JSON.stringify(await recoverShellInstaller(input)));`;
  const child = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-e", program], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20000, input: JSON.stringify({ directory: f.directory, manifest: f.manifest, requestId: f.requestId,
      trustedKeys: { "download-test": f.keys.publicKey.export({ type: "spki", format: "pem" }) } }),
  });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { status: "verified", value: result });
});

test("an ancestor directory alias cannot redirect installer writes", async t => {
  const f = await fixture(), alias = path.join(evidence, `alias-${crypto.randomUUID()}`); let sends = 0;
  await fs.symlink(f.directory, alias, "junction");
  const transport = await server(t, (_request, response) => { sends += 1; headers(response, f); response.end(f.bytes); });
  await assert.rejects(download.downloadShellInstaller({ ...f, directory: alias, transport }));
  assert.equal(sends, 0); assert.deepEqual(await fs.readdir(f.directory), []);
});

test("publication cannot replace a file created by another owner", async t => {
  const f = await fixture(), link = fs.link, foreign = Buffer.from("foreign installer");
  const transport = await server(t, (_request, response) => { headers(response, f); response.end(f.bytes); });
  let target: string | undefined;
  t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => { target = String(args[1]); await fs.writeFile(args[1], foreign, { flag: "wx" }); return await link(...args); });
  await assert.rejects(download.downloadShellInstaller({ ...f, transport }));
  assert.ok(target); assert.deepEqual(await fs.readFile(target), foreign);
});

test("a manifest expiring during the response cannot publish or return success", async t => {
  const f = await fixture(); let now = Date.parse("2036-12-31T23:59:59.000Z");
  const transport = await server(t, (_request, response) => { headers(response, f); now = Date.parse("2037-01-01T00:00:00.000Z"); response.end(f.bytes); });
  await assert.rejects(download.downloadShellInstaller({ ...f, transport, now: () => now }));
  const [child] = await fs.readdir(f.directory); assert.deepEqual(await fs.readdir(path.join(f.directory, child!)), ["installer.exe.part"]);
});

test("installer requests preserve the original signed request identity grammar", async t => {
  const f = await fixture(), transport = await server(t, (_request, response) => { headers(response, f); response.end(f.bytes); });
  for (const requestId of ["shell.check+id:1", "a".repeat(128)]) {
    assert.ok((await download.downloadShellInstaller({ ...f, requestId, transport })).installerPath);
    assert.equal((await download.recoverShellInstaller({ ...f, requestId })).status, "verified");
  }
  for (const requestId of ["_leading", "a".repeat(129), "space id", "", "trailing\n"]) {
    await assert.rejects(download.downloadShellInstaller({ ...f, requestId, transport }));
    await assert.rejects(download.recoverShellInstaller({ ...f, requestId }));
  }
});

test("a bounded error-body transport failure reaches the shared retry with its original cause", async () => {
  const f = await fixture(), cause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  const wrapper = Object.assign(new Error("DESKTOP_UPDATE_RESPONSE_INVALID", { cause }), { code: "DESKTOP_UPDATE_RESPONSE_INVALID", requestId: f.requestId });
  await assert.rejects(download.downloadShellInstaller({ ...f, transport: { request: async () => { throw wrapper; } } }), error => error === wrapper);
  const cleanup = new Error("cleanup failed"), both = new AggregateError([wrapper, cleanup], "ERROR_BODY_CLEANUP_FAILED");
  await assert.rejects(download.downloadShellInstaller({ ...f, transport: { request: async () => { throw both; } } }), (error: any) => {
    assert.equal(error.code, "DESKTOP_SHELL_INSTALLER_DOWNLOAD_FAILED"); assert.equal(error.cause, both); return true;
  });
});

/** 原 store/adapter 持久化真实取消结果，恢复只能检查下载器留下的本地工件。 */
async function cancellationAttempt(f: Awaited<ReturnType<typeof fixture>>, signal: AbortSignal) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(evidence, "attempt-")));
  const store = createShellUpdateAttemptStore(directory);
  const originalState = { activeShellId: "old", previousShellId: null, baselineShellId: "baseline" };
  const attempt: ShellUpdateAttemptV2 = { schemaVersion: 2, requestId: f.requestId, revision: 0, dataDir: directory,
    installationDir: path.join(directory, "installation"), userDataDir: path.join(directory, "profile"), sessionDataDir: path.join(directory, "session"),
    originalState, candidateState: { ...originalState, activeShellId: f.manifest.shellId, previousShellId: "old" },
    binding: { kind: "installation", baselineShellId: "baseline", health: { protocolVersion: 1, clientVersion: "1", dbSchemaVersion: 1, database: "ready" } },
    target: { shellId: f.manifest.shellId, manifestSha256: crypto.createHash("sha256").update(JSON.stringify(f.manifest)).digest("hex"),
      installerSha256: f.manifest.installerSha256, installerSize: f.manifest.installerSize },
    phase: "preparing", retriesUsed: 0, network: null };
  await store.replace(null, attempt);
  const durable = createShellUpdateAttemptNetworkAdapter(store);
  const retry = createUpdateNetworkRetry({ signal, durable, onRetry() { assert.fail("cancellation must not reserve a retry"); } });
  const action: UpdateNetworkAction<download.DownloadedShellInstaller> = { actionKey: "shell-installer", requestSha256: "a".repeat(64),
    /** 取消或清理失败不能产生成功工件。 */
    async persistResult() { assert.fail("cancelled installer must not persist success"); },
    /** 未完成 part 不证明响应成功，也不授权重发。 */
    async recoverResult() {
      const recovered = await download.recoverShellInstaller(f);
      return recovered.status === "unknown" ? recovered : { ...recovered, evidence: { kind: "shell-installer" as const, sha256: recovered.value.sha256 } };
    } };
  return { store, durable, retry, action };
}

for (const reasonKind of ["error", "scalar"] as const) for (const readKind of ["abort-error", "reason", "errored-abort"] as const) {
  test(`installer body cancellation with ${reasonKind}/${readKind} preserves dispatch and the exact reason`, async t => {
    const f = await fixture(), controller = new AbortController(), reason = reasonKind === "error" ? new Error("cancel installer") : "cancel installer";
    const owner = await cancellationAttempt(f, controller.signal), open = fs.open;
    let file: Awaited<ReturnType<typeof fs.open>> | undefined, readFailure: unknown, reads = 0, sends = 0, cancelled = 0, released = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const opened = await open(...args); if (String(args[0]).endsWith(".part") && Number(args[1]) & 2) file = opened; return opened;
    });
    const transport = { request: async () => {
      sends++;
      return { status: 200, headers: new Headers({ "content-length": String(f.bytes.length), etag: `"${f.manifest.installerSha256}"` }),
        body: { getReader: () => ({ read: async () => {
          if (reads++ === 0) return { done: false, value: f.bytes.subarray(0, 32768) };
          controller.abort(reason); readFailure = readKind === "reason" ? reason : new DOMException("cancelled", "AbortError"); throw readFailure;
        }, cancel: async () => { cancelled++; if (readKind === "errored-abort") throw readFailure; }, releaseLock: () => { released++; } }) } } as unknown as Response;
    } };
    let rejected = false, observed: unknown;
    try { await owner.retry.run(() => download.downloadShellInstaller({ ...f, signal: controller.signal, transport }), owner.action); }
    catch (cause) { rejected = true; observed = cause; }
    assert.equal(rejected, true); assert.equal(observed, reason);
    assert.equal(sends, 1); assert.equal(cancelled, 1); assert.equal(released, 1); assert.ok(file); assert.equal(file.fd, -1);
    const state = await owner.store.read(); assert.ok(state && "network" in state);
    assert.equal(state.phase, "preparing"); assert.equal(state.network?.status, "dispatching"); assert.equal(state.retriesUsed, 0);
    const [child] = await fs.readdir(f.directory); const part = path.join(f.directory, child!, "installer.exe.part");
    assert.deepEqual(await fs.readFile(part), f.bytes.subarray(0, 32768));
    assert.deepEqual(await download.recoverShellInstaller(f), { status: "unknown" });
    const resumed = createUpdateNetworkRetry({ signal: new AbortController().signal, durable: owner.durable, onRetry() { assert.fail(); } });
    await assert.rejects(resumed.run(async () => { sends++; assert.fail("unknown dispatch must not replay"); }, owner.action), { code: "DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN" });
    assert.equal(sends, 1);
  });
}

for (const boundary of ["cancel", "release", "sync", "close"] as const) {
  test(`installer cancellation with an independent ${boundary} failure remains failed with both causes`, async t => {
    const f = await fixture(), controller = new AbortController(), reason = new Error("cancel installer"), failure = new Error(`${boundary} failed`);
    const owner = await cancellationAttempt(f, controller.signal), open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith(".part") && Number(args[1]) & 2 && (boundary === "sync" || boundary === "close")) {
        const original = file[boundary].bind(file);
        t.mock.method(file, boundary, async () => { await original(); throw failure; });
      }
      return file;
    });
    const transport = { request: async () => ({ status: 200,
      headers: new Headers({ "content-length": String(f.bytes.length), etag: `"${f.manifest.installerSha256}"` }),
      body: { getReader: () => ({ read: async () => { controller.abort(reason); throw new DOMException("cancelled", "AbortError"); },
        cancel: async () => { if (boundary === "cancel") throw failure; }, releaseLock: () => { if (boundary === "release") throw failure; } }) } } as unknown as Response) };
    await assert.rejects(owner.retry.run(() => download.downloadShellInstaller({ ...f, signal: controller.signal, transport }), owner.action), error => {
      assert.ok(hasCause(error, reason)); assert.ok(hasCause(error, failure)); return true;
    });
    const state = await owner.store.read(); assert.ok(state && "network" in state);
    assert.equal(state.phase, "failed"); assert.equal(state.network?.status, "failed"); assert.equal(state.retriesUsed, 0);
  });
}

for (const variant of ["unrelated-abort-error", "disk-like-read-failure"] as const) {
  test(`installer ${variant} is never replaced with an unrelated cancellation reason`, async () => {
    const f = await fixture(), controller = new AbortController(), reason = new Error("cancel installer");
    const failure = variant === "unrelated-abort-error" ? new DOMException("unrelated abort", "AbortError") : Object.assign(new Error("read failed"), { code: "EIO" });
    const owner = await cancellationAttempt(f, controller.signal);
    const transport = { request: async () => ({ status: 200,
      headers: new Headers({ "content-length": String(f.bytes.length), etag: `"${f.manifest.installerSha256}"` }),
      body: { getReader: () => ({ read: async () => { if (variant === "disk-like-read-failure") controller.abort(reason); throw failure; },
        cancel: async () => { throw failure; }, releaseLock() {} }) } } as unknown as Response) };
    await assert.rejects(owner.retry.run(() => download.downloadShellInstaller({ ...f, signal: controller.signal, transport }), owner.action), error => {
      assert.notEqual(error, reason); assert.ok(hasCause(error, failure)); return true;
    });
    const state = await owner.store.read(); assert.ok(state && "network" in state);
    assert.equal(state.phase, "failed"); assert.equal(state.network?.status, "failed"); assert.equal(state.retriesUsed, 0);
  });
}

test("read-only recovery cancelled while confirming an absent cache never returns unknown", async t => {
  const f = await fixture(), controller = new AbortController(), reason = new Error("cancel recovery"), lstat = fs.lstat;
  let cancelled = false;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    try { return await lstat(...args); }
    catch (cause) {
      if (path.dirname(String(args[0])) === f.directory && cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
        cancelled = true; controller.abort(reason);
      }
      throw cause;
    }
  });
  await assert.rejects(download.recoverShellInstaller({ ...f, signal: controller.signal }), error => hasCause(error, reason));
  assert.equal(cancelled, true); assert.deepEqual(await fs.readdir(f.directory), []);
  assert.deepEqual(await download.recoverShellInstaller(f), { status: "unknown" });
});

/** 错误树按属性存在性查找，undefined 也是必须保留的原始主因。 */
function hasCause(error: unknown, expected: unknown): boolean {
  if (error === expected) return true;
  if (!(error instanceof Error)) return false;
  return (Object.hasOwn(error, "cause") && hasCause(error.cause, expected)) || (error instanceof AggregateError && error.errors.some(item => hasCause(item, expected)));
}
