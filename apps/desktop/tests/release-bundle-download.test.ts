import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { buildDesktopDevicePayload, verifyDesktopDeviceSignature } from "@codeflowai/shared/desktop-device-auth";
import { signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { createDesktopUpdateTransport } from "../src/updateTransport.js";
import { downloadReleaseBundle } from "../src/releaseBundleDownload.js";
import { createUpdateNetworkRetry } from "../src/updateNetworkRetry.js";

/** 每个测试使用临时签名、公钥与真实 loopback HTTP，不读取生产材料。 */
async function fixture(t: TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-download-"));
  const rootDir = path.join(temporary, "updates");
  const identityDir = path.join(temporary, "identity");
  const identity = await loadOrCreateDeviceIdentity(identityDir);
  const keys = crypto.generateKeyPairSync("ed25519");
  const archive = Buffer.from("signed archive bytes for resumable desktop delivery\n".repeat(4096));
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  const payload = { schemaVersion: 2, releaseId: "download-1", version: "1.0.0", webVersion: "1.0.0", clientVersion: "1.0.0",
    protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 1, platform: "win32", arch: "x64", webSha256: "a".repeat(64),
    clientSha256: "b".repeat(64), packageSha256: "c".repeat(64), archiveSha256: digest, archiveSize: archive.length,
    files: [{ path: "client/dist/index.cjs", size: 1, sha256: "d".repeat(64) }, { path: "web/index.html", size: 1, sha256: "e".repeat(64) }],
    createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2026-10-25T00:00:00.000Z", keyId: "test-key" };
  /** 测试变体仍由真实私钥签署，隔离传输检查与签名门禁。 */
  const manifestBytes = (overrides: Record<string, unknown> = {}) => Buffer.from(`${JSON.stringify(signReleaseBundleManifest({ ...payload, ...overrides }, keys.privateKey), null, 2)}\n`);
  const requests: Array<{ range: string | undefined; ifMatch: string | undefined; url: string | undefined }> = [];
  let serve = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const start = req.headers.range ? Number(/^bytes=(\d+)-$/.exec(req.headers.range)![1]) : 0;
    res.writeHead(start ? 206 : 200, { etag: `"${digest}"`, "content-length": archive.length - start,
      ...(start ? { "content-range": `bytes ${start}-${archive.length - 1}/${archive.length}` } : {}) });
    res.end(archive.subarray(start));
  };
  const server = http.createServer((req, res) => {
    verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ deviceId: identity.deviceId,
      method: req.method!, url: req.url!, body: Buffer.alloc(0), requestId: String(req.headers["x-codeflow-request-id"]),
      timestamp: Number(req.headers["x-codeflow-timestamp"]), range: req.headers.range, ifMatch: req.headers["if-match"] }),
    String(req.headers["x-codeflow-signature"]));
    requests.push({ range: req.headers.range, ifMatch: req.headers["if-match"], url: req.url });
    serve(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("desktop-download-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  /** 恢复时重新建立传输器，缓存恢复仅依赖落盘事实。 */
  const createTransport = (getNetworkContext?: Parameters<typeof createDesktopUpdateTransport>[0]["getNetworkContext"]) => createDesktopUpdateTransport({ dataDir: identityDir, identity,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, getNetworkContext });
  const options = { rootDir, manifestBytes: manifestBytes(), archivePath: "/api/software/desktop/releases/download-1/archive",
    transport: createTransport(), trustedReleaseKeys: { "test-key": keys.publicKey }, platform: "win32", arch: "x64",
    now: () => Date.parse("2026-10-24T12:00:00.000Z"), requestId: "download-test" };
  return { archive, digest, rootDir, manifestBytes, requests, options, createTransport,
    directory: path.join(rootDir, ".staging", `download-${crypto.createHash("sha256").update(options.manifestBytes).digest("hex")}`),
    /** 故障由真实 HTTP 响应注入，下载器和签名链保持原实现。 */
    setServe(handler: typeof serve) { serve = handler; } };
}

test("合法新发布复用归档时隔离清单缓存并可在重试时复用各自完整下载", async t => {
  const f = await fixture(t);
  const first = await downloadReleaseBundle(f.options);
  const manifestBytes = f.manifestBytes({ releaseId: "download-2" });
  const options = { ...f.options, manifestBytes, archivePath: "/api/software/desktop/releases/download-2/archive", requestId: "download-second" };
  const second = await downloadReleaseBundle(options);
  assert.notEqual(second.directory, first.directory);
  assert.equal(second.manifest.releaseId, "download-2");
  assert.deepEqual(await fs.readFile(second.archivePath), f.archive);
  assert.deepEqual(await fs.readFile(path.join(first.directory, "manifest.json")), f.options.manifestBytes);
  assert.deepEqual(await fs.readFile(path.join(second.directory, "manifest.json")), manifestBytes);
  assert.equal((await downloadReleaseBundle(options)).directory, second.directory);
  assert.equal((await downloadReleaseBundle(f.options)).directory, first.directory);
  assert.equal(f.requests.length, 2);
});

test("first signed download persists exact manifest bytes and verifies completed cache without HTTP", async t => {
  const f = await fixture(t);
  const phases: string[] = [];
  const progress: Array<[number, number]> = [];
  const result = await downloadReleaseBundle({ ...f.options, onPhase(phase) { phases.push(phase); },
    onProgress(received, total) { progress.push([received, total]); } });
  assert.deepEqual(phases, ["download", "verify"]);
  assert.ok(progress.length > 0);
  assert.deepEqual(progress.at(-1), [f.archive.length, f.archive.length], "最后一条进度覆盖完整归档");
  assert.ok(progress.every(([received, total]) => total === f.archive.length && received >= 0 && received <= total));
  assert.equal(result.requestId, "download-test");
  assert.equal(result.directory, f.directory);
  assert.equal(result.archivePath, path.join(f.directory, "bundle.tar.gz"));
  assert.deepEqual(await fs.readFile(result.archivePath), f.archive);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "manifest.json")), f.options.manifestBytes);
  assert.deepEqual(await fs.readdir(f.directory), ["bundle.tar.gz", "manifest.json"]);
  assert.deepEqual(f.requests, [{ range: undefined, ifMatch: `"${f.digest}"`, url: f.options.archivePath }]);
  assert.equal((await downloadReleaseBundle({ ...f.options, transport: f.createTransport() })).archivePath, result.archivePath);
  assert.equal(f.requests.length, 1);
});

for (const cause of [undefined, false]) test(`phase observation rejects ${String(cause)} and releases the original download lock`, async t => {
  const f = await fixture(t);
  await assert.rejects(downloadReleaseBundle({ ...f.options, onPhase() { throw cause; } }), error =>
    error instanceof Error && error.message === "DESKTOP_RELEASE_DOWNLOAD_FAILED" && error.cause === cause);
  assert.equal(f.requests.length, 0);
  const result = await downloadReleaseBundle(f.options);
  assert.deepEqual(await fs.readFile(result.archivePath), f.archive);
});

for (const level of ["root", "staging", "download"] as const) {
  test(`download accepts a concurrently created ${level} directory after validating it`, async t => {
    const f = await fixture(t);
    const target = level === "root" ? f.rootDir : level === "staging" ? path.dirname(f.directory) : f.directory;
    const mkdir = fs.mkdir;
    let injected = false;
    // 在检查后、创建前插入真实竞争写入，让原 mkdir 自行返回 EEXIST。
    t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
      if (args[0] === target && !injected) { injected = true; await mkdir(target); }
      return await mkdir(...args);
    });
    const result = await downloadReleaseBundle(f.options);
    assert.equal(injected, true);
    assert.deepEqual(await fs.readFile(result.archivePath), f.archive);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(await fs.readdir(f.directory), ["bundle.tar.gz", "manifest.json"]);
  });
}

for (const kind of ["file", "link"] as const) {
  test(`download rejects a concurrently created ${kind} at its staging directory`, async t => {
    const f = await fixture(t);
    const target = path.dirname(f.directory);
    const external = path.join(path.dirname(f.rootDir), "other-directory");
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "sentinel"), "keep");
    const mkdir = fs.mkdir;
    let injected = false;
    // 竞争方写入仍由真实 mkdir 报冲突，后续必须核对实际类型。
    t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
      if (args[0] === target && !injected) {
        injected = true;
        if (kind === "file") await fs.writeFile(target, "keep");
        else await fs.symlink(external, target, "junction");
      }
      return await mkdir(...args);
    });
    await assert.rejects(() => downloadReleaseBundle(f.options), { code: "DESKTOP_RELEASE_CACHE_UNSAFE", requestId: "download-test" });
    assert.equal(injected, true);
    assert.equal(f.requests.length, 0);
    if (kind === "file") assert.equal(await fs.readFile(target, "utf8"), "keep");
    else assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
    assert.deepEqual(await fs.readdir(external), ["sentinel"]);
    assert.equal(await fs.readFile(path.join(external, "sentinel"), "utf8"), "keep");
  });
}

for (const code of ["EACCES", "EIO"] as const) {
  test(`download preserves ${code} while creating its staging directory`, async t => {
    const f = await fixture(t);
    const target = path.dirname(f.directory);
    const original = Object.assign(new Error("cache directory creation failed"), { code });
    const mkdir = fs.mkdir;
    t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
      if (args[0] === target) throw original;
      return await mkdir(...args);
    });
    await assert.rejects(() => downloadReleaseBundle(f.options), (error: any) => {
      assert.equal(error.code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
      assert.equal(error.requestId, "download-test");
      assert.equal(error.cause, original);
      return true;
    });
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await fs.readdir(f.rootDir), []);
  });
}

test("download preserves a directory revalidation failure after concurrent creation", async t => {
  const f = await fixture(t);
  const target = path.dirname(f.directory);
  const original = Object.assign(new Error("cache directory validation failed"), { code: "EIO" });
  const mkdir = fs.mkdir, lstat = fs.lstat;
  let injected = false;
  // mkdir 的真实冲突后，重新读取失败也必须终止下载。
  t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
    if (args[0] === target && !injected) { injected = true; await mkdir(target); }
    return await mkdir(...args);
  });
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === target && injected) throw original;
    return await lstat(...args);
  });
  await assert.rejects(() => downloadReleaseBundle(f.options), (error: any) => {
    assert.equal(error.code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
    assert.equal(error.requestId, "download-test");
    assert.equal(error.cause, original);
    return true;
  });
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await fs.readdir(target), []);
});

test("download reports received only after the complete archive is promoted", async t => {
  const f = await fixture(t);
  const reports: Array<{ requestId: string; archivePath: string }> = [];
  const result = await downloadReleaseBundle({ ...f.options, receivedReporter: async (received: { requestId: string; archivePath: string }) => {
    reports.push({ requestId: received.requestId, archivePath: received.archivePath });
    assert.equal((await fs.stat(received.archivePath)).isFile(), true);
    assert.deepEqual(await fs.readFile(received.archivePath), f.archive);
  } });
  assert.deepEqual(reports, [{ requestId: "download-test", archivePath: result.archivePath }]);
});

test("received reporter failure keeps the verified archive and fails the download", async t => {
  const f = await fixture(t);
  const failure = new Error("report offline");
  await assert.rejects(() => downloadReleaseBundle({ ...f.options, receivedReporter: async () => { throw failure; } }),
    (error: any) => error.code === "DESKTOP_RELEASE_DOWNLOAD_FAILED" && error.requestId === "download-test" && error.cause === failure);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "bundle.tar.gz")), f.archive);
});

test("failed archive promotion never reports received", async t => {
  const f = await fixture(t);
  const rename = fs.rename;
  let reports = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (args[0] === path.join(f.directory, "bundle.tar.gz.part")) throw Object.assign(new Error("rename failed"), { code: "EIO" });
    await rename(...args);
  });
  await assert.rejects(() => downloadReleaseBundle({ ...f.options, receivedReporter: async () => { reports += 1; } }), { code: "DESKTOP_RELEASE_DOWNLOAD_FAILED" });
  assert.equal(reports, 0);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "bundle.tar.gz.part")), f.archive);
  await assert.rejects(() => fs.access(path.join(f.directory, "bundle.tar.gz")), { code: "ENOENT" });
});

for (const operation of ["lstat", "stat"] as const) {
  test(`new manifest first ${operation} failure cleans its empty file and permits an explicit retry`, async t => {
    const f = await fixture(t);
    const manifestPath = path.join(f.directory, "manifest.json");
    const original = Object.assign(new Error(`first ${operation} failed`), { code: "EIO" });
    let injected = false;
    if (operation === "lstat") {
      const lstat = fs.lstat;
      t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === manifestPath && !injected) { injected = true; throw original; }
        return await lstat(...args);
      });
    } else {
      const open = fs.open;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const file = await open(...args);
        if (args[0] === manifestPath) {
          const stat = file.stat.bind(file);
          t.mock.method(file, "stat", async () => {
            if (!injected) { injected = true; throw original; }
            return await stat();
          });
        }
        return file;
      });
    }
    await assert.rejects(() => downloadReleaseBundle(f.options), (error: any) => {
      assert.equal(error.code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
      assert.equal(error.requestId, "download-test");
      assert.equal(error.cause, original);
      return true;
    });
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await fs.readdir(f.directory), []);
    const result = await downloadReleaseBundle(f.options);
    assert.deepEqual(await fs.readFile(result.archivePath), f.archive);
    assert.equal(f.requests.length, 1);
  });
}

test("new manifest first validation failure preserves a path replacement and exposes both failures", async t => {
  const f = await fixture(t);
  const manifestPath = path.join(f.directory, "manifest.json");
  const replacement = Buffer.from("replacement belongs to another writer");
  const original = Object.assign(new Error("first validation failed"), { code: "EIO" });
  const lstat = fs.lstat;
  let injected = false;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === manifestPath && !injected) {
      injected = true;
      await fs.rename(manifestPath, path.join(f.directory, "original-manifest"));
      await fs.writeFile(manifestPath, replacement);
      throw original;
    }
    return await lstat(...args);
  });
  await assert.rejects(() => downloadReleaseBundle(f.options), (error: any) => {
    assert.equal(error.code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors[0], original);
    assert.equal(error.cause.errors[1].code, "DESKTOP_RELEASE_CACHE_UNSAFE");
    return true;
  });
  assert.deepEqual(await fs.readFile(manifestPath), replacement);
  assert.equal(f.requests.length, 0);
});

test("new manifest stays intact when repeated validation failure prevents confirming ownership", async t => {
  const f = await fixture(t);
  const manifestPath = path.join(f.directory, "manifest.json");
  const original = Object.assign(new Error("first validation failed"), { code: "EIO" });
  const cleanup = Object.assign(new Error("ownership validation failed"), { code: "EACCES" });
  const lstat = fs.lstat;
  let attempts = 0;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === manifestPath) throw attempts++ === 0 ? original : cleanup;
    return await lstat(...args);
  });
  await assert.rejects(() => downloadReleaseBundle(f.options), (error: any) => {
    assert.equal(error.code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [original, cleanup]);
    return true;
  });
  assert.equal((await fs.readFile(manifestPath)).length, 0);
  assert.equal(f.requests.length, 0);
});

for (const stage of ["write", "sync"] as const) {
  test(`new manifest ${stage} failure removes only the owned new file and allows an explicit retry`, async t => {
    const f = await fixture(t);
    const manifestPath = path.join(f.directory, "manifest.json");
    const original = Object.assign(new Error(`manifest ${stage} failed`), { code: stage === "write" ? "ENOSPC" : "EIO" });
    const open = fs.open;
    let injected = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (args[0] === manifestPath && !injected) {
        injected = true;
        if (stage === "write") {
          t.mock.method(file, "writeFile", async () => {
            await file.write(f.options.manifestBytes.subarray(0, 23), 0, 23, 0);
            assert.equal((await file.stat()).size, 23);
            throw original;
          });
        } else t.mock.method(file, "sync", async () => { throw original; });
      }
      return file;
    });
    await assert.rejects(() => downloadReleaseBundle(f.options), (error: any) => {
      assert.equal(error.code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
      assert.equal(error.requestId, "download-test");
      assert.equal(error.cause, original);
      return true;
    });
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await fs.readdir(f.directory), []);
    const result = await downloadReleaseBundle(f.options);
    assert.deepEqual(await fs.readFile(result.archivePath), f.archive);
    assert.deepEqual(await fs.readFile(manifestPath), f.options.manifestBytes);
    assert.equal(f.requests.length, 1);
  });
}

test("new manifest cleanup failure exposes both partial-write and unlink causes without continuing", async t => {
  const f = await fixture(t);
  const manifestPath = path.join(f.directory, "manifest.json");
  const original = Object.assign(new Error("manifest write failed"), { code: "ENOSPC" });
  const cleanup = Object.assign(new Error("manifest unlink failed"), { code: "EACCES" });
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === manifestPath) t.mock.method(file, "writeFile", async () => {
      await file.write(f.options.manifestBytes.subarray(0, 23), 0, 23, 0);
      throw original;
    });
    return file;
  });
  const unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (target: Parameters<typeof fs.unlink>[0]) => {
    if (target === manifestPath) throw cleanup;
    return await unlink(target);
  });
  await assert.rejects(() => downloadReleaseBundle(f.options), (error: any) => {
    assert.equal(error.code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
    assert.equal(error.requestId, "download-test");
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [original, cleanup]);
    return true;
  });
  assert.deepEqual(await fs.readFile(manifestPath), f.options.manifestBytes.subarray(0, 23));
  assert.equal(f.requests.length, 0);
});

test("existing manifest read failure preserves the existing manifest", async t => {
  const f = await fixture(t);
  const manifestPath = path.join(f.directory, "manifest.json");
  await fs.mkdir(f.directory, { recursive: true });
  await fs.writeFile(manifestPath, f.options.manifestBytes);
  const original = Object.assign(new Error("manifest read failed"), { code: "EIO" });
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === manifestPath) t.mock.method(file, "readFile", async () => { throw original; });
    return file;
  });
  await assert.rejects(() => downloadReleaseBundle(f.options), (error: any) => {
    assert.equal(error.code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
    assert.equal(error.cause, original);
    return true;
  });
  assert.deepEqual(await fs.readFile(manifestPath), f.options.manifestBytes);
  assert.equal(f.requests.length, 0);
});

test("failed new manifest cleanup refuses to unlink a replacement at the same path", async t => {
  const f = await fixture(t);
  const manifestPath = path.join(f.directory, "manifest.json");
  const original = Object.assign(new Error("manifest sync failed"), { code: "EIO" });
  const replacement = Buffer.from("replacement belongs to another writer");
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === manifestPath) t.mock.method(file, "sync", async () => {
      await fs.rename(manifestPath, path.join(f.directory, "original-manifest"));
      await fs.writeFile(manifestPath, replacement);
      throw original;
    });
    return file;
  });
  await assert.rejects(() => downloadReleaseBundle(f.options), (error: any) => {
    assert.equal(error.code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors[0], original);
    assert.equal(error.cause.errors[1].code, "DESKTOP_RELEASE_CACHE_UNSAFE");
    return true;
  });
  assert.deepEqual(await fs.readFile(manifestPath), replacement);
  assert.equal(f.requests.length, 0);
});

test("truncated response retains received bytes and a fresh transport resumes the exact signed range", async t => {
  const f = await fixture(t);
  f.setServe((_req, res) => {
    res.writeHead(200, { etag: `"${f.digest}"`, "content-length": f.archive.length });
    res.write(f.archive.subarray(0, 32768));
    setTimeout(() => res.destroy(), 30);
  });
  await assert.rejects(() => downloadReleaseBundle(f.options), { code: "DESKTOP_RELEASE_DOWNLOAD_FAILED", requestId: "download-test" });
  const part = await fs.readFile(path.join(f.directory, "bundle.tar.gz.part"));
  assert.equal(part.length, 32768);
  assert.deepEqual(part, f.archive.subarray(0, part.length));
  f.setServe((req, res) => {
    assert.equal(req.headers.range, "bytes=32768-");
    res.writeHead(206, { etag: `"${f.digest}"`, "content-length": f.archive.length - part.length,
      "content-range": `bytes 32768-${f.archive.length - 1}/${f.archive.length}`, "content-encoding": "identity" });
    res.end(f.archive.subarray(part.length));
  });
  const { downloadReleaseBundle: reloaded } = await import(`../src/releaseBundleDownload.js?reload=${crypto.randomUUID()}`);
  const result = await reloaded({ ...f.options, transport: f.createTransport() });
  assert.deepEqual(await fs.readFile(result.archivePath), f.archive);
  assert.equal(f.requests.length, 2);
});

test("trust, signature, expiry, platform and invalid JSON fail before any network or cache creation", async t => {
  const f = await fixture(t);
  const tampered = JSON.parse(f.options.manifestBytes.toString("utf8"));
  tampered.version = "forged";
  const variants = [
    { trustedReleaseKeys: {} }, { manifestBytes: Buffer.from(JSON.stringify(tampered)) },
    { manifestBytes: f.manifestBytes({ expiresAt: "2026-10-24T01:00:00.000Z" }) },
    { platform: "darwin" }, { arch: "arm64" }, { manifestBytes: Buffer.from("private-manifest-fragment") },
    { manifestBytes: Buffer.from([0xff]) },
    { manifestBytes: Buffer.from(JSON.stringify({ ...JSON.parse(f.options.manifestBytes.toString("utf8")), "private-manifest-fragment": true })) },
    { manifestBytes: f.manifestBytes({ keyId: "private-manifest-fragment" }) },
  ];
  for (const variant of variants) {
    await assert.rejects(() => downloadReleaseBundle({ ...f.options, ...variant }), (error: any) => {
      assert.equal(typeof error.code, "string");
      assert.equal(error.requestId, "download-test");
      assert.doesNotMatch(String(error) + String(error.cause), /private-manifest-fragment/u);
      return true;
    });
  }
  assert.equal(f.requests.length, 0);
  await assert.rejects(() => fs.access(f.rootDir), { code: "ENOENT" });
});

for (const invalid of ["etag", "weak-etag", "encoding", "length", "range", "status"] as const) {
  test(`first response rejects invalid ${invalid} without persisting body bytes`, async t => {
    const f = await fixture(t);
    f.setServe((_req, res) => {
      res.writeHead(invalid === "status" ? 206 : 200, { etag: invalid === "etag" ? '"wrong"' : invalid === "weak-etag" ? `W/"${f.digest}"` : `"${f.digest}"`,
        "content-length": invalid === "length" ? f.archive.length - 1 : f.archive.length,
        ...(invalid === "range" || invalid === "status" ? { "content-range": `bytes 0-${f.archive.length - 1}/${f.archive.length}` } : {}),
        ...(invalid === "encoding" ? { "content-encoding": "gzip" } : {}) });
      res.end(f.archive);
    });
    await assert.rejects(() => downloadReleaseBundle(f.options), {
      code: invalid === "etag" ? "DESKTOP_RELEASE_ETAG_MISMATCH" : "DESKTOP_RELEASE_RESPONSE_INVALID", requestId: "download-test" });
    if (invalid === "etag") await assert.rejects(() => fs.access(path.join(f.directory, "bundle.tar.gz.part")), { code: "ENOENT" });
    else assert.equal((await fs.stat(path.join(f.directory, "bundle.tar.gz.part"))).size, 0);
    assert.equal(f.requests.length, 1);
  });
}

for (const invalid of ["status", "start", "end", "total", "length", "etag"] as const) {
  test(`resume rejects invalid ${invalid} without modifying its previous prefix`, async t => {
    const f = await fixture(t);
    await fs.mkdir(f.directory, { recursive: true });
    await fs.writeFile(path.join(f.directory, "manifest.json"), f.options.manifestBytes);
    const prefix = f.archive.subarray(0, 111);
    await fs.writeFile(path.join(f.directory, "bundle.tar.gz.part"), prefix);
    f.setServe((_req, res) => {
      res.writeHead(invalid === "status" ? 200 : 206, { etag: invalid === "etag" ? '"wrong"' : `"${f.digest}"`,
        "content-length": f.archive.length - (invalid === "length" ? 112 : 111),
        "content-range": `bytes ${invalid === "start" ? 110 : 111}-${f.archive.length - (invalid === "end" ? 2 : 1)}/${f.archive.length + (invalid === "total" ? 1 : 0)}` });
      res.end(f.archive.subarray(111));
    });
    await assert.rejects(() => downloadReleaseBundle(f.options), {
      code: invalid === "etag" ? "DESKTOP_RELEASE_ETAG_MISMATCH" : "DESKTOP_RELEASE_RESPONSE_INVALID" });
    if (invalid === "etag") await assert.rejects(() => fs.access(path.join(f.directory, "bundle.tar.gz.part")), { code: "ENOENT" });
    else assert.deepEqual(await fs.readFile(path.join(f.directory, "bundle.tar.gz.part")), prefix);
  });
}

test("digest mismatch removes the owned partial archive and explicitly fails before any retry", async t => {
  const f = await fixture(t);
  const damaged = Buffer.from(f.archive); damaged[0] ^= 1;
  f.setServe((_req, res) => { res.writeHead(200, { etag: `"${f.digest}"`, "content-length": damaged.length }); res.end(damaged); });
  await assert.rejects(() => downloadReleaseBundle(f.options), { code: "DESKTOP_RELEASE_ARCHIVE_MISMATCH" });
  await assert.rejects(() => fs.access(path.join(f.directory, "bundle.tar.gz.part")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(f.directory, "manifest.json")), f.options.manifestBytes);
  assert.equal(f.requests.length, 1);
});

test("failure to discard a corrupt owned archive retains both original and cleanup causes", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { recursive: true });
  await fs.writeFile(path.join(f.directory, "manifest.json"), f.options.manifestBytes);
  const partPath = path.join(f.directory, "bundle.tar.gz.part");
  await fs.writeFile(partPath, Buffer.alloc(f.archive.length + 1));
  const unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (target: Parameters<typeof fs.unlink>[0]) => {
    if (target === partPath) throw Object.assign(new Error("discard denied"), { code: "EACCES" });
    return await unlink(target);
  });
  await assert.rejects(() => downloadReleaseBundle(f.options), (error: any) => {
    assert.equal(error.code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
    assert.equal(error.requestId, "download-test");
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors[0].code, "DESKTOP_RELEASE_ARCHIVE_MISMATCH");
    assert.equal(error.cause.errors[1].code, "EACCES");
    return true;
  });
  assert.equal((await fs.stat(partPath)).size, f.archive.length + 1);
  assert.equal(f.requests.length, 0);
});

test("completed cache is rehashed and any corruption is a visible failure", async t => {
  const f = await fixture(t);
  const result = await downloadReleaseBundle(f.options);
  const damaged = Buffer.from(f.archive); damaged[0] ^= 1;
  await fs.writeFile(result.archivePath, damaged);
  await assert.rejects(() => downloadReleaseBundle(f.options), { code: "DESKTOP_RELEASE_ARCHIVE_MISMATCH" });
  await assert.rejects(() => fs.access(result.archivePath), { code: "ENOENT" });
  assert.equal(f.requests.length, 1);
});

test("manifest conflicts and orphaned data remain untouched, oversized owned data is discarded before HTTP", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { recursive: true });
  const partPath = path.join(f.directory, "bundle.tar.gz.part");
  await fs.writeFile(partPath, "orphan");
  await assert.rejects(() => downloadReleaseBundle(f.options), { code: "DESKTOP_RELEASE_CACHE_CONFLICT" });
  assert.equal(await fs.readFile(partPath, "utf8"), "orphan");
  await fs.writeFile(path.join(f.directory, "manifest.json"), f.manifestBytes({ releaseId: "other-release" }));
  await assert.rejects(() => downloadReleaseBundle(f.options), { code: "DESKTOP_RELEASE_CACHE_CONFLICT" });
  await fs.writeFile(path.join(f.directory, "manifest.json"), f.options.manifestBytes);
  await fs.writeFile(partPath, Buffer.alloc(f.archive.length + 1));
  await assert.rejects(() => downloadReleaseBundle(f.options), { code: "DESKTOP_RELEASE_ARCHIVE_MISMATCH" });
  await assert.rejects(() => fs.access(partPath), { code: "ENOENT" });
  assert.equal(f.requests.length, 0);
});

test("cancellation retains its valid partial prefix, releases the lock and rejects concurrent writers", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let onStarted!: () => void;
  const started = new Promise<void>(resolve => { onStarted = resolve; });
  f.setServe((_req, res) => {
    res.writeHead(200, { etag: `"${f.digest}"`, "content-length": f.archive.length });
    res.write(f.archive.subarray(0, 1234));
    onStarted();
  });
  const abort = new AbortController();
  t.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const pending = downloadReleaseBundle({ ...f.options, signal: abort.signal });
  const partPath = path.join(f.directory, "bundle.tar.gz.part");
  try {
    await Promise.race([started, pending.then(() => assert.fail("download completed before cancellation"))]);
    await assert.rejects(() => downloadReleaseBundle(f.options), { code: "DESKTOP_RELEASE_DOWNLOAD_BUSY" });
    const deadline = Date.now() + 2000;
    while ((await fs.stat(partPath)).size !== 1234 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(await fs.readFile(partPath), f.archive.subarray(0, 1234));
    abort.abort();
    await assert.rejects(pending, { code: "DESKTOP_RELEASE_DOWNLOAD_CANCELLED", requestId: "download-test" });
  } finally { abort.abort(); }
  assert.deepEqual(await fs.readFile(partPath), f.archive.subarray(0, 1234));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(() => downloadReleaseBundle({ ...f.options, signal: cancelled.signal }), { code: "DESKTOP_RELEASE_DOWNLOAD_CANCELLED" });
  assert.equal(f.requests.length, 1);
  f.setServe((req, res) => {
    assert.equal(req.headers.range, "bytes=1234-");
    res.writeHead(206, { etag: `"${f.digest}"`, "content-length": f.archive.length - 1234,
      "content-range": `bytes 1234-${f.archive.length - 1}/${f.archive.length}` });
    res.end(f.archive.subarray(1234));
  });
  assert.deepEqual(await fs.readFile((await downloadReleaseBundle(f.options)).archivePath), f.archive);
});

test("a directory link at the fixed partial path cannot modify its external target", async t => {
  const f = await fixture(t);
  const external = path.join(path.dirname(f.rootDir), "external-target");
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, "sentinel"), "keep");
  await fs.mkdir(f.directory, { recursive: true });
  await fs.writeFile(path.join(f.directory, "manifest.json"), f.options.manifestBytes);
  await fs.symlink(external, path.join(f.directory, "bundle.tar.gz.part"), "junction");
  await assert.rejects(() => downloadReleaseBundle(f.options), { code: "DESKTOP_RELEASE_CACHE_UNSAFE" });
  assert.deepEqual(await fs.readdir(external), ["sentinel"]);
  assert.equal(f.requests.length, 0);
});

test("hard-linked partial archives are rejected before network or writes", async t => {
  const f = await fixture(t);
  const external = path.join(path.dirname(f.rootDir), "external-hardlink");
  await fs.writeFile(external, "keep");
  await fs.mkdir(f.directory, { recursive: true });
  await fs.writeFile(path.join(f.directory, "manifest.json"), f.options.manifestBytes);
  await fs.link(external, path.join(f.directory, "bundle.tar.gz.part"));
  await assert.rejects(() => downloadReleaseBundle(f.options), { code: "DESKTOP_RELEASE_CACHE_UNSAFE" });
  assert.equal(await fs.readFile(external, "utf8"), "keep");
  assert.equal(f.requests.length, 0);
});

test("a complete verified partial archive is promoted without a new request", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { recursive: true });
  await fs.writeFile(path.join(f.directory, "manifest.json"), f.options.manifestBytes);
  await fs.writeFile(path.join(f.directory, "bundle.tar.gz.part"), f.archive);
  const result = await downloadReleaseBundle(f.options);
  assert.deepEqual(await fs.readFile(result.archivePath), f.archive);
  assert.equal(f.requests.length, 0);
  await assert.rejects(() => fs.access(path.join(f.directory, "bundle.tar.gz.part")), { code: "ENOENT" });
});

test("cancellation during final fsync keeps the complete partial file without promoting success", async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === path.join(f.directory, "bundle.tar.gz.part")) {
      const sync = file.sync.bind(file);
      t.mock.method(file, "sync", async () => { await sync(); abort.abort(); });
    }
    return file;
  });
  await assert.rejects(() => downloadReleaseBundle({ ...f.options, signal: abort.signal }), { code: "DESKTOP_RELEASE_DOWNLOAD_CANCELLED" });
  await assert.rejects(() => fs.access(path.join(f.directory, "bundle.tar.gz")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(f.directory, "bundle.tar.gz.part")), f.archive);
});

test("cache directory links are refused without touching their external target", async t => {
  const f = await fixture(t);
  const external = path.join(path.dirname(f.rootDir), "external");
  await fs.mkdir(external);
  await fs.mkdir(f.rootDir);
  await fs.writeFile(path.join(external, "sentinel"), "keep");
  await fs.symlink(external, path.join(f.rootDir, ".staging"), "junction");
  await assert.rejects(() => downloadReleaseBundle(f.options), { code: "DESKTOP_RELEASE_CACHE_UNSAFE" });
  assert.deepEqual(await fs.readdir(external), ["sentinel"]);
  assert.equal(f.requests.length, 0);
});

test("archive targets cannot escape the configured signed Server origin or follow redirects", async t => {
  const f = await fixture(t);
  for (const archivePath of ["https://other.invalid/archive", "//other.invalid/archive", "/api/software/desktop/../outside"]) {
    await assert.rejects(() => downloadReleaseBundle({ ...f.options, archivePath }));
  }
  assert.equal(f.requests.length, 0);
  f.setServe((_req, res) => { res.writeHead(302, { location: "https://other.invalid/archive" }); res.end(); });
  await assert.rejects(() => downloadReleaseBundle(f.options), { code: "DESKTOP_RELEASE_DOWNLOAD_FAILED" });
  assert.equal(f.requests.length, 1);
});

test("network retry resumes an interrupted signed archive from the exact persisted prefix", async t => {
  const f = await fixture(t);
  const events: Array<{ retry: number; delayMs: number; error: unknown }> = [];
  const signal = new AbortController().signal;
  const networkRetry = createUpdateNetworkRetry({ signal, onRetry: event => { events.push(event); } });
  let served = 0, reports = 0;
  f.setServe((request, response) => {
    if (++served === 1) { response.writeHead(503, { "retry-after": "0" }); response.end("{}"); return; }
    if (served === 2) {
      response.writeHead(200, { etag: `"${f.digest}"`, "content-length": f.archive.length });
      response.write(f.archive.subarray(0, 1234));
      setTimeout(() => response.destroy(), 30); return;
    }
    assert.equal(request.headers.range, "bytes=1234-");
    response.writeHead(206, { etag: `"${f.digest}"`, "content-length": f.archive.length - 1234,
      "content-range": `bytes 1234-${f.archive.length - 1}/${f.archive.length}` });
    response.end(f.archive.subarray(1234));
  });
  const transport = f.createTransport(() => ({ signal, retry: networkRetry }));
  const result = await downloadReleaseBundle({ ...f.options, transport, signal, networkRetry, receivedReporter: async () => { reports++; } });
  assert.deepEqual(await fs.readFile(result.archivePath), f.archive);
  assert.equal(reports, 1);
  assert.deepEqual(events.map(event => [event.retry, event.delayMs]), [[1, 0], [2, 2000]]);
  assert.equal((events[0]!.error as { code: string }).code, "DESKTOP_UPDATE_HTTP_FAILED");
  assert.equal((events[1]!.error as { code: string }).code, "DESKTOP_UPDATE_TRANSPORT_FAILED");
  assert.equal(events.every(event => (event.error as { requestId: string }).requestId === "download-test"), true);
  assert.equal(f.requests.length, 3);
});

test("filesystem EPIPE, digest mismatch and cleanup failure cannot restart archive download", async t => {
  for (const kind of ["write", "digest", "cleanup"]) await t.test(kind, async subtest => {
    const f = await fixture(subtest);
    let retries = 0, reports = 0;
    const networkRetry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry: () => { retries++; } });
    if (kind === "write") {
      const open = fs.open;
      subtest.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const file = await open(...args);
        if (args[0] === path.join(f.directory, "bundle.tar.gz.part")) subtest.mock.method(file, "write", async () => {
          throw Object.assign(new Error("storage pipe failed"), { code: "EPIPE" });
        });
        return file;
      });
    } else {
      const damaged = Buffer.from(f.archive); damaged[0] ^= 1;
      f.setServe((_request, response) => { response.writeHead(200, { etag: `"${f.digest}"`, "content-length": damaged.length }); response.end(damaged); });
      if (kind === "cleanup") {
        const unlink = fs.unlink;
        subtest.mock.method(fs, "unlink", async (target: Parameters<typeof fs.unlink>[0]) => {
          if (target === path.join(f.directory, "bundle.tar.gz.part")) throw Object.assign(new Error("cleanup failed"), { code: "EACCES" });
          await unlink(target);
        });
      }
    }
    await assert.rejects(() => downloadReleaseBundle({ ...f.options, networkRetry, receivedReporter: async () => { reports++; } }), (error: any) => {
      assert.equal(error.code, kind === "digest" ? "DESKTOP_RELEASE_ARCHIVE_MISMATCH" : "DESKTOP_RELEASE_DOWNLOAD_FAILED");
      if (kind === "write") assert.equal(error.cause.code, "EPIPE");
      if (kind === "cleanup") assert.ok(error.cause instanceof AggregateError);
      return true;
    });
    assert.equal(retries, 0); assert.equal(reports, 0); assert.equal(f.requests.length, 1);
  });
});

/** 使用真实流与读取器，仅在实际释放锁后注入独立收尾故障。 */
function cleanupResponse(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, body: ReadableStream<Uint8Array>, releaseFailure?: Error): Response {
  const response = new Response(body, { headers: { etag: `"${f.digest}"`, "content-length": String(f.archive.length) } });
  if (releaseFailure) {
    const getReader = body.getReader.bind(body);
    t.mock.method(body, "getReader", () => {
      const reader = getReader(), releaseLock = reader.releaseLock.bind(reader);
      t.mock.method(reader, "releaseLock", () => { releaseLock(); throw releaseFailure; });
      return reader;
    });
  }
  return response;
}

/** 展开实际cause与聚合，缺失cause不补undefined，保留原错误实体作断言。 */
function cleanupCauses(value: unknown): unknown[] {
  if (value instanceof AggregateError) return [value, ...value.errors.flatMap(cleanupCauses)];
  return value instanceof Error && Object.hasOwn(value, "cause") ? [value, ...cleanupCauses(value.cause)] : [value];
}

for (const original of [Object.freeze(Object.assign(new Error("body read failed"), { code: "ECONNRESET" })), undefined])
test(`archive reader cleanup retains a ${original === undefined ? "undefined" : "network"} read failure with release failure`, async t => {
  const f = await fixture(t), releaseFailure = Object.assign(new Error("reader release failed"), { code: "EPIPE" });
  const response = cleanupResponse(t, f, new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } }), releaseFailure);
  let retries = 0, reports = 0;
  const networkRetry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry: () => { retries++; } });
  await assert.rejects(downloadReleaseBundle({ ...f.options, transport: { request: async () => response }, networkRetry: original === undefined ? undefined : networkRetry,
    receivedReporter: async () => { reports++; } }), (failure: unknown) => {
    assert.equal((failure as { requestId: string }).requestId, "download-test");
    const causes = cleanupCauses(failure);
    assert.ok(causes.includes(original)); assert.ok(causes.includes(releaseFailure));
    assert.ok(causes.some(value => value instanceof AggregateError));
    return true;
  });
  assert.equal(retries, 0); assert.equal(reports, 0); assert.equal(response.body!.locked, false);
  assert.equal((await fs.stat(path.join(f.directory, "bundle.tar.gz.part"))).size, 0);
});

test("archive reader cleanup retains response rejection, cancellation and release failures", async t => {
  const f = await fixture(t), cancelFailure = new Error("reader cancel failed"), releaseFailure = new Error("reader release failed");
  let cancellations = 0;
  const response = cleanupResponse(t, f, new ReadableStream<Uint8Array>({ cancel() { cancellations++; throw cancelFailure; } }), releaseFailure);
  response.headers.set("content-length", "1");
  await assert.rejects(downloadReleaseBundle({ ...f.options, transport: { request: async () => response } }), (failure: unknown) => {
    assert.equal((failure as { code: string }).code, "DESKTOP_RELEASE_RESPONSE_INVALID");
    assert.equal((failure as { requestId: string }).requestId, "download-test");
    const causes = cleanupCauses(failure);
    assert.ok(causes.includes(cancelFailure)); assert.ok(causes.includes(releaseFailure));
    assert.ok(causes.some(value => value instanceof Error && value.message === "DESKTOP_RELEASE_RESPONSE_INVALID"));
    return true;
  });
  assert.equal(cancellations, 1); assert.equal(response.body!.locked, false);
  assert.equal((await fs.stat(path.join(f.directory, "bundle.tar.gz.part"))).size, 0);
});

test("archive reader cleanup retains disk, cancellation and release failures without reporting success", async t => {
  const f = await fixture(t), original = Object.assign(new Error("disk write failed"), { code: "EIO" });
  const cancelFailure = new Error("reader cancel failed"), releaseFailure = new Error("reader release failed");
  const response = cleanupResponse(t, f, new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(f.archive); }, cancel() { throw cancelFailure; },
  }), releaseFailure);
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === path.join(f.directory, "bundle.tar.gz.part")) t.mock.method(file, "write", async () => { throw original; });
    return file;
  });
  let reports = 0;
  await assert.rejects(downloadReleaseBundle({ ...f.options, transport: { request: async () => response },
    receivedReporter: async () => { reports++; } }), (failure: unknown) => {
    const causes = cleanupCauses(failure);
    for (const cause of [original, cancelFailure, releaseFailure]) assert.ok(causes.includes(cause));
    return true;
  });
  assert.equal(reports, 0); assert.equal(response.body!.locked, false);
});

test("archive reader cleanup rejects release failure after EOF and permits explicit reuse of the complete prefix", async t => {
  const f = await fixture(t), releaseFailure = new Error("reader release failed");
  const response = cleanupResponse(t, f, new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(f.archive); controller.close(); } }), releaseFailure);
  let reports = 0;
  await assert.rejects(downloadReleaseBundle({ ...f.options, transport: { request: async () => response },
    receivedReporter: async () => { reports++; } }), (failure: unknown) => cleanupCauses(failure).includes(releaseFailure));
  assert.equal(reports, 0); assert.equal(response.body!.locked, false);
  await assert.rejects(fs.stat(path.join(f.directory, "bundle.tar.gz")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(f.directory, "bundle.tar.gz.part")), f.archive);
  const result = await downloadReleaseBundle(f.options);
  assert.deepEqual(await fs.readFile(result.archivePath), f.archive); assert.equal(f.requests.length, 0);
});

for (const releaseFails of [false, true])
test(`archive reader cleanup preserves cancellation ${releaseFails ? "with release failure" : "without cleanup failure"}`, async t => {
  const f = await fixture(t), abort = new AbortController(), original = new Error("download cancelled");
  const releaseFailure = new Error("reader release failed");
  const response = cleanupResponse(t, f, new ReadableStream<Uint8Array>({
    pull() { abort.abort(original); throw new DOMException("aborted", "AbortError"); },
  }, { highWaterMark: 0 }), releaseFails ? releaseFailure : undefined);
  const networkRetry = createUpdateNetworkRetry({ signal: abort.signal, onRetry: () => { assert.fail("cancelled reads cannot retry"); } });
  await assert.rejects(downloadReleaseBundle({ ...f.options, signal: abort.signal, networkRetry, transport: { request: async () => response } }), (failure: unknown) => {
    assert.equal((failure as { code: string }).code, "DESKTOP_RELEASE_DOWNLOAD_CANCELLED");
    assert.equal((failure as { requestId: string }).requestId, "download-test");
    const causes = cleanupCauses(failure);
    assert.ok(causes.includes(original));
    if (releaseFails) assert.ok(causes.includes(releaseFailure));
    else assert.equal((failure as Error).cause, original);
    return true;
  });
  assert.equal(response.body!.locked, false);
});

/** 真实句柄先完成关闭，再报告独立失败，测试不得遗留占用缓存的句柄。 */
function failClosedFile(t: TestContext, file: Awaited<ReturnType<typeof fs.open>>, cause: unknown): void {
  const close = file.close.bind(file);
  t.mock.method(file, "close", async () => { await close(); throw cause; });
}

for (const stage of ["archive-write", "manifest-write", "manifest-read"] as const)
for (const original of [undefined, false, Object.freeze(new Error("file operation failed"))])
test(`archive file close retains ${stage} ${String(original)} rejection with close failure`, async t => {
  const f = await fixture(t), manifestPath = path.join(f.directory, "manifest.json");
  const archive = stage === "archive-write", existing = stage === "manifest-read";
  if (existing) { await fs.mkdir(f.directory, { recursive: true }); await fs.writeFile(manifestPath, f.options.manifestBytes); }
  const target = archive ? path.join(f.directory, "bundle.tar.gz.part") : manifestPath;
  const closeFailure = Object.freeze(Object.assign(new Error("file close failed"), { code: "EIO" })), open = fs.open;
  let opened: Awaited<ReturnType<typeof fs.open>> | undefined, reports = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === target && !opened) {
      opened = file; failClosedFile(t, file, closeFailure);
      if (archive) t.mock.method(file, "write", async () => { throw original; });
      else if (existing) t.mock.method(file, "readFile", async () => { throw original; });
      else t.mock.method(file, "writeFile", async () => { throw original; });
    }
    return file;
  });
  const networkRetry = createUpdateNetworkRetry({ signal: new AbortController().signal,
    onRetry: () => { assert.fail("file operation and close failures cannot retry automatically"); } });
  await assert.rejects(downloadReleaseBundle({ ...f.options, networkRetry, receivedReporter: async () => { reports++; } }), (failure: unknown) => {
    assert.equal((failure as { code: string }).code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
    assert.equal((failure as { requestId: string }).requestId, "download-test");
    assert.ok((failure as Error).cause instanceof AggregateError);
    const errors = ((failure as Error).cause as AggregateError).errors;
    assert.equal(errors.length, 2); assert.equal(errors[0], original); assert.equal(errors[1], closeFailure);
    return true;
  });
  assert.equal(opened?.fd, -1); assert.equal(reports, 0); assert.equal(f.requests.length, archive ? 1 : 0);
  if (archive) assert.equal((await fs.stat(target)).size, 0);
  else if (existing) assert.deepEqual(await fs.readFile(target), f.options.manifestBytes);
  else await assert.rejects(fs.stat(target), { code: "ENOENT" });
  const result = await downloadReleaseBundle(f.options);
  assert.deepEqual(await fs.readFile(result.archivePath), f.archive);
  assert.equal(f.requests.length, archive ? 2 : 1);
});

test("archive file close retains an undefined received rejection and the already promoted archive", async t => {
  const f = await fixture(t), closeFailure = new Error("file close failed"), open = fs.open;
  let opened: Awaited<ReturnType<typeof fs.open>> | undefined, reports = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === path.join(f.directory, "bundle.tar.gz.part")) { opened = file; failClosedFile(t, file, closeFailure); }
    return file;
  });
  await assert.rejects(downloadReleaseBundle({ ...f.options, receivedReporter: async () => { reports++; throw undefined; } }), (failure: unknown) => {
    assert.equal((failure as { requestId: string }).requestId, "download-test");
    assert.ok((failure as Error).cause instanceof AggregateError);
    const errors = ((failure as Error).cause as AggregateError).errors;
    assert.equal(errors.length, 2); assert.equal(errors[0], undefined); assert.equal(errors[1], closeFailure);
    return true;
  });
  assert.equal(reports, 1); assert.equal(opened?.fd, -1); assert.equal(f.requests.length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "bundle.tar.gz")), f.archive);
  await assert.rejects(fs.stat(path.join(f.directory, "bundle.tar.gz.part")), { code: "ENOENT" });
});

for (const stage of ["manifest", "archive"] as const)
test(`archive file close exposes a lone ${stage} close failure without rolling back completed bytes`, async t => {
  const f = await fixture(t), closeFailure = new Error("file close failed"), open = fs.open;
  const target = path.join(f.directory, stage === "manifest" ? "manifest.json" : "bundle.tar.gz.part");
  let opened: Awaited<ReturnType<typeof fs.open>> | undefined, reports = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === target && !opened) { opened = file; failClosedFile(t, file, closeFailure); }
    return file;
  });
  await assert.rejects(downloadReleaseBundle({ ...f.options, receivedReporter: async () => { reports++; } }), (failure: unknown) => {
    assert.equal((failure as { code: string }).code, "DESKTOP_RELEASE_DOWNLOAD_FAILED");
    assert.equal((failure as Error).cause, closeFailure);
    return true;
  });
  assert.equal(opened?.fd, -1); assert.equal(reports, stage === "archive" ? 1 : 0);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "manifest.json")), f.options.manifestBytes);
  if (stage === "archive") assert.deepEqual(await fs.readFile(path.join(f.directory, "bundle.tar.gz")), f.archive);
  const result = await downloadReleaseBundle(f.options);
  assert.deepEqual(await fs.readFile(result.archivePath), f.archive); assert.equal(f.requests.length, 1);
});

for (const stage of ["manifest", "archive"] as const)
test(`archive file close preserves ${stage} primary, discard and close failures together`, async t => {
  const f = await fixture(t), closeFailure = new Error("file close failed"), cleanupFailure = new Error("file discard failed");
  const target = path.join(f.directory, stage === "manifest" ? "manifest.json" : "bundle.tar.gz.part"), open = fs.open, unlink = fs.unlink;
  let opened: Awaited<ReturnType<typeof fs.open>> | undefined, reports = 0;
  if (stage === "archive") {
    const corrupt = Buffer.from(f.archive); corrupt[0] ^= 1;
    f.setServe((_request, response) => { response.writeHead(200, { etag: `"${f.digest}"`, "content-length": corrupt.length }); response.end(corrupt); });
  }
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === target) {
      opened = file; failClosedFile(t, file, closeFailure);
      if (stage === "manifest") t.mock.method(file, "writeFile", async () => { throw undefined; });
    }
    return file;
  });
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => { if (args[0] === target) throw cleanupFailure; return await unlink(...args); });
  await assert.rejects(downloadReleaseBundle({ ...f.options, receivedReporter: async () => { reports++; } }), (failure: unknown) => {
    const causes = cleanupCauses(failure);
    assert.ok(causes.includes(cleanupFailure)); assert.ok(causes.includes(closeFailure));
    if (stage === "manifest") assert.ok(causes.includes(undefined));
    else assert.ok(causes.some(value => value instanceof Error && value.message === "DESKTOP_RELEASE_ARCHIVE_MISMATCH"));
    return true;
  });
  assert.equal(opened?.fd, -1); assert.equal(reports, 0); assert.equal(f.requests.length, stage === "archive" ? 1 : 0);
  assert.equal((await fs.stat(target)).size, stage === "archive" ? f.archive.length : 0);
});
