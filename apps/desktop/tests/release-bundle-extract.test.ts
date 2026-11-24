import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import { Header, create as createArchive, type HeaderData } from "tar";
import { computeReleaseDirectorySha256, computeReleasePackageSha256, readReleaseBundleFiles, signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import { createReleaseBundleCoordinator, readActivePointer } from "../src/releaseBundleCoordinator.js";
import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";
// @ts-expect-error Native build script is exercised with the production Node loader.
import { buildReleaseBundle } from "../scripts/build-release-bundle.mjs";

type Entry = HeaderData & { content?: string | Buffer };
const context = { deviceId: "868683b1-e79b-4509-9ca1-97b7786e5344", shellVersion: "1", currentReleaseId: "installation", webVersion: "1", clientVersion: "1" };

/** 创建有效头和可控正文，不依赖系统解包器来生成恶意归档。 */
function archive(entries: Entry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const header = new Header({ mode: 0o755, ...entry, size: entry.size ?? content.length });
    const block = Buffer.alloc(512);
    header.encode(block);
    chunks.push(block, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

/** 每项仅访问临时资源，工件及发布签名均来自真实 builder。 */
async function fixture(t: TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-extract-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith("desktop-extract-"));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const rootDir = path.join(temporary, "updates");
  const resourcesDir = path.join(temporary, "resources");
  await fs.mkdir(path.join(resourcesDir, "client", "dist"), { recursive: true });
  await fs.mkdir(path.join(resourcesDir, "web", "empty"), { recursive: true });
  await fs.writeFile(path.join(resourcesDir, "web", "index.html"), "页面", "utf8");
  await fs.writeFile(path.join(resourcesDir, "client", "dist", "index.cjs"), "client", "utf8");
  const keys = crypto.generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(temporary, "private.pem");
  await fs.writeFile(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  const metadata = { releaseId: "extract-1", version: "2", webVersion: "2", clientVersion: "2", protocolVersion: 1,
    capabilityVersion: 1, dbSchemaVersion: 88, platform: process.platform, arch: process.arch, keyId: "fixture",
    createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2099-10-24T00:00:00.000Z" };
  const outputDir = path.join(temporary, "built");
  const built = await buildReleaseBundle({ resourcesDir, outputDir, metadata, privateKeyFile });
  const incoming = path.join(temporary, "download");
  await fs.mkdir(incoming);
  for (const file of ["manifest.json", "bundle.tar.gz"]) await fs.copyFile(path.join(outputDir, file), path.join(incoming, file));
  const coordinator = createReleaseBundleCoordinator({ rootDir, trustedReleaseKeys: { fixture: keys.publicKey }, getFailureContext: () => context });
  /** 可信签名覆盖恶意归档，确保测试实际进入条目校验。 */
  const replaceArchive = async (bytes: Buffer, change: Record<string, unknown> = {}) => {
    const { signature: _signature, ...payload } = built.manifest;
    const manifest = signReleaseBundleManifest({ ...payload, archiveSize: bytes.length,
      archiveSha256: crypto.createHash("sha256").update(bytes).digest("hex"), ...change }, keys.privateKey);
    await fs.writeFile(path.join(incoming, "bundle.tar.gz"), bytes);
    await fs.writeFile(path.join(incoming, "manifest.json"), JSON.stringify(manifest), "utf8");
  };
  const entries: Entry[] = [{ path: "web/index.html", type: "File", content: "页面" },
    { path: "client/dist/index.cjs", type: "File", content: "client" }];
  return { temporary, rootDir, resourcesDir, incoming, coordinator, replaceArchive, entries, built, keys };
}

test("downloaded builder archive prepares through the original coordinator without changing active state", async t => {
  const f = await fixture(t);
  const prepared = await f.coordinator.prepare(f.incoming);
  assert.equal(await fs.readFile(path.join(prepared.stagingDir, "web", "index.html"), "utf8"), "页面");
  assert.equal((await fs.stat(path.join(prepared.stagingDir, "web", "empty"))).isDirectory(), true);
  assert.deepEqual((await fs.readdir(prepared.stagingDir)).sort(), ["client", "manifest.json", "web"]);
  assert.equal(await readActivePointer(f.rootDir), null);
  assert.deepEqual((await fs.readdir(f.incoming)).sort(), ["bundle.tar.gz", "manifest.json"]);
  assert.equal(createUpdateFailureJournal(f.rootDir).pending(context.deviceId).length, 0);
});

for (const bad of [
  { name: "parent traversal", entry: { path: "web/../../escaped", type: "File", content: "escape" } },
  { name: "absolute path", entry: { path: "/web/escape", type: "File", content: "escape" } },
  { name: "backslash alias", entry: { path: "web\\escape", type: "File", content: "escape" } },
  { name: "symbolic link", entry: { path: "web/link", type: "SymbolicLink", linkpath: "../../escape" } },
  { name: "hard link", entry: { path: "web/link", type: "Link", linkpath: "client/dist/index.cjs" } },
  { name: "special file", entry: { path: "web/fifo", type: "FIFO" } },
  { name: "extra file", entry: { path: "web/extra", type: "File", content: "extra" } },
  { name: "duplicate file", entry: { path: "web/index.html", type: "File", content: "页面" } },
  { name: "case alias", entry: { path: "Web/index.html", type: "File", content: "页面" } },
  { name: "file used as directory", entry: { path: "web/index.html/child", type: "Directory" } },
] satisfies Array<{ name: string; entry: Entry }>) {
  test(`archive rejects ${bad.name} and preserves cache with one failure record`, async t => {
    const f = await fixture(t);
    await f.replaceArchive(archive([...f.entries, bad.entry]));
    await assert.rejects(() => f.coordinator.prepare(f.incoming), /DESKTOP_RELEASE_/);
    assert.equal(await readActivePointer(f.rootDir), null);
    assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
    assert.equal(createUpdateFailureJournal(f.rootDir).pending(context.deviceId).length, 1);
    assert.deepEqual((await fs.readdir(f.incoming)).sort(), ["bundle.tar.gz", "manifest.json"]);
    await assert.rejects(() => fs.access(path.join(f.temporary, "escaped")), { code: "ENOENT" });
  });
}

test("archive rejects a missing signed file and wrong size", async t => {
  const f = await fixture(t);
  for (const entries of [[f.entries[0]!], [{ ...f.entries[0]!, content: "wrong-size" }, f.entries[1]!]]) {
    await f.replaceArchive(archive(entries));
    await assert.rejects(() => f.coordinator.prepare(f.incoming), /DESKTOP_RELEASE_|SHA-256/);
    assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
  }
});

test("archive uses its signed whole-package digest without hashing each extracted file", async t => {
  const f = await fixture(t);
  await f.replaceArchive(archive([{ ...f.entries[0]!, content: "wrong!" }, f.entries[1]!]));
  const prepared = await f.coordinator.prepare(f.incoming);
  assert.equal(await fs.readFile(path.join(prepared.stagingDir, "web/index.html"), "utf8"), "wrong!");
});

test("archive decoding hashes and reads the archive once", async t => {
  const f = await fixture(t), open = fs.open.bind(fs);
  let zeroReads = 0, bytesRead = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]) === path.join(f.incoming, "bundle.tar.gz")) {
      const read = file.read.bind(file);
      t.mock.method(file, "read", async (...readArgs: Parameters<typeof file.read>) => {
        if ((readArgs as readonly unknown[])[3] === 0) zeroReads++;
        const result = await read(...readArgs);
        bytesRead += result.bytesRead;
        return result;
      });
    }
    return file;
  });
  await f.coordinator.prepare(f.incoming);
  assert.equal(zeroReads, 1);
  assert.equal(bytesRead, f.built.manifest.archiveSize);
});

test("archive length and digest are rechecked before any payload is prepared", async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.incoming, "bundle.tar.gz"), "changed");
  await assert.rejects(() => f.coordinator.prepare(f.incoming), /ARCHIVE_MISMATCH/);
  assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
});

for (const truncated of ["gzip", "tar"] as const) {
  test(`truncated ${truncated} is an explicit preparation failure`, async t => {
    const f = await fixture(t);
    const bytes = truncated === "gzip" ? archive(f.entries).subarray(0, -7) : gzipSync(Buffer.alloc(30, 1));
    await f.replaceArchive(bytes);
    await assert.rejects(() => f.coordinator.prepare(f.incoming));
    assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
  });
}

test("untrusted archive manifest fails before staging or extraction", async t => {
  const f = await fixture(t);
  const manifestPath = path.join(f.incoming, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, version: "tampered" }), "utf8");
  await assert.rejects(() => f.coordinator.prepare(f.incoming), /SIGNATURE_INVALID/);
  await assert.rejects(() => fs.access(path.join(f.rootDir, ".staging")), { code: "ENOENT" });
});

test("archive cancellation stops preparation and closes owned files before cleaning staging", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const open = fs.open.bind(fs);
  let cancelled = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).includes(`${path.sep}.staging${path.sep}`) && String(args[0]).endsWith("index.html")) {
      const write = file.write.bind(file);
      t.mock.method(file, "write", async (...writeArgs: Parameters<typeof file.write>) => {
        const result = await write(...writeArgs);
        cancelled = true;
        controller.abort();
        return result;
      });
    }
    return file;
  });
  await assert.rejects(() => f.coordinator.prepare(f.incoming, { signal: controller.signal }));
  assert.equal(cancelled, true);
  assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
  t.mock.restoreAll();
  await f.coordinator.prepare(f.incoming);
});

for (const code of ["ENOSPC", "EIO"]) {
  test(`payload ${code} fails, releases files and permits explicit retry`, async t => {
    const f = await fixture(t);
    const open = fs.open.bind(fs);
    const original = Object.assign(new Error("payload write failed"), { code });
    let injected = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (!injected && String(args[0]).includes(`${path.sep}.staging${path.sep}`) && String(args[0]).endsWith("index.html")) {
        injected = true;
        t.mock.method(file, "write", async () => { throw original; });
      }
      return file;
    });
    await assert.rejects(() => f.coordinator.prepare(f.incoming), error => error === original);
    assert.equal(injected, true);
    assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
    t.mock.restoreAll();
    await f.coordinator.prepare(f.incoming);
  });
}

test("preparation cleanup failure preserves both extraction and cleanup errors", async t => {
  const f = await fixture(t);
  await f.replaceArchive(archive([...f.entries, { path: "web/extra", type: "File", content: "extra" }]));
  const remove = fs.rm.bind(fs);
  const cleanup = Object.assign(new Error("cleanup denied"), { code: "EACCES" });
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).includes(`${path.sep}.staging${path.sep}`)) throw cleanup;
    return await remove(...args);
  });
  await assert.rejects(() => f.coordinator.prepare(f.incoming), error => error instanceof AggregateError
    && error.errors.some(cause => cause === cleanup) && error.errors.some(cause => String(cause).includes("DESKTOP_RELEASE_")));
  t.mock.restoreAll();
});

test("archive preserves portable executable permissions while removing special mode bits", async t => {
  const f = await fixture(t);
  await f.replaceArchive(archive(f.entries.map(entry => ({ ...entry, mode: 0o6755 }))));
  const prepared = await f.coordinator.prepare(f.incoming);
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(prepared.stagingDir, "client", "dist", "index.cjs"))).mode & 0o7777, 0o755);
});

test("archive preparation can switch and recover using the original coordinator hooks", async t => {
  const f = await fixture(t);
  const operations: string[] = [];
  const prepared = await f.coordinator.prepare(f.incoming, { requestId: "one-update-request" });
  assert.equal(prepared.requestId, "one-update-request");
  const hooks = {
    checkCompatibility: async () => { operations.push("compatible"); }, drain: async () => { operations.push("drain"); },
    restartClient: async () => { operations.push("client"); }, reloadWeb: async () => { operations.push("web"); },
    waitHealthy: async () => false, restoreInitialRelease: async () => { operations.push("restore"); },
  };
  await assert.rejects(() => f.coordinator.switch(prepared, hooks), /健康检查失败/);
  assert.deepEqual(operations, ["compatible", "drain", "client", "web", "restore"]);
  assert.equal(await readActivePointer(f.rootDir), null);
  assert.equal(createUpdateFailureJournal(f.rootDir).pending(context.deviceId)[0]!.requestId, "one-update-request");
  const active = await f.coordinator.switch(await f.coordinator.prepare(f.incoming), { ...hooks, waitHealthy: async () => true });
  assert.equal(await readActivePointer(f.rootDir), active.releaseId);
});

test("a signed archive without its tar end marker is rejected", async t => {
  const f = await fixture(t);
  const complete = gunzipSync(archive(f.entries));
  await f.replaceArchive(gzipSync(complete.subarray(0, -1024)));
  await assert.rejects(() => f.coordinator.prepare(f.incoming), /DESKTOP_RELEASE_/);
});

test("malformed pax metadata cannot be ignored before an otherwise valid payload", async t => {
  const f = await fixture(t);
  await f.replaceArchive(archive([{ path: "PaxHeader/test", type: "ExtendedHeader", content: "99 path=web/ignored\n" }, ...f.entries]));
  await assert.rejects(() => f.coordinator.prepare(f.incoming), /DESKTOP_RELEASE_/);
});

test("payload close errors are retained with the write failure", async t => {
  const f = await fixture(t);
  const open = fs.open.bind(fs);
  const original = Object.assign(new Error("payload failed"), { code: "EIO" });
  const closing = Object.assign(new Error("payload close failed"), { code: "EACCES" });
  let injected = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (!injected && String(args[0]).includes(`${path.sep}.staging${path.sep}`) && String(args[0]).endsWith("index.html")) {
      injected = true;
      const close = file.close.bind(file);
      t.mock.method(file, "write", async () => { throw original; });
      t.mock.method(file, "close", async () => { await close(); throw closing; });
    }
    return file;
  });
  await assert.rejects(() => f.coordinator.prepare(f.incoming), error => error instanceof AggregateError
    && error.errors.includes(original) && error.errors.includes(closing));
  assert.equal(injected, true);
  assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
});

test("normal pax paths and UTF-8 resource names remain compatible with the signed inventory", async t => {
  const f = await fixture(t);
  const relative = `web/目录-${"a".repeat(64)}/文件-${"b".repeat(64)}.txt`;
  await fs.mkdir(path.dirname(path.join(f.resourcesDir, relative)), { recursive: true });
  await fs.writeFile(path.join(f.resourcesDir, relative), "长路径内容", "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of createArchive({ cwd: f.resourcesDir, gzip: true }, ["web", "client"])) chunks.push(chunk);
  const files = await readReleaseBundleFiles(f.resourcesDir);
  const webSha256 = computeReleaseDirectorySha256(files, "web");
  const clientSha256 = computeReleaseDirectorySha256(files, "client");
  await f.replaceArchive(Buffer.concat(chunks), { files, webSha256, clientSha256,
    packageSha256: computeReleasePackageSha256(webSha256, clientSha256) });
  const prepared = await f.coordinator.prepare(f.incoming);
  assert.equal(await fs.readFile(path.join(prepared.stagingDir, relative), "utf8"), "长路径内容");
});

test("large rejected archives close all file operations before staging cleanup", async t => {
  const f = await fixture(t);
  const content = crypto.randomBytes(2 * 1024 * 1024);
  const files = [...f.built.manifest.files, { path: "web/large.bin", size: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex") }].sort((a, b) => a.path < b.path ? -1 : 1);
  const webSha256 = computeReleaseDirectorySha256(files, "web");
  const clientSha256 = computeReleaseDirectorySha256(files, "client");
  await f.replaceArchive(archive([{ path: "web/large.bin", type: "File", content }, ...f.entries,
    { path: "web/extra", type: "File", content: "extra" }]), { files, webSha256, clientSha256,
    packageSha256: computeReleasePackageSha256(webSha256, clientSha256) });
  const open = fs.open.bind(fs);
  const remove = fs.rm.bind(fs);
  let opened = 0;
  let cleaned = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    opened += 1;
    const close = file.close.bind(file);
    t.mock.method(file, "close", async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      await close();
      opened -= 1;
    });
    return file;
  });
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).includes(`${path.sep}.staging${path.sep}`)) {
      assert.equal(opened, 0, "staging cleanup must await every file close");
      cleaned = true;
    }
    await remove(...args);
  });
  await assert.rejects(() => f.coordinator.prepare(f.incoming), /DESKTOP_RELEASE_/);
  assert.equal(cleaned, true);
  assert.equal(opened, 0);
  t.mock.restoreAll();
});

test("archive bytes are hashed during the actual decoding pass", async t => {
  const f = await fixture(t);
  const open = fs.open.bind(fs);
  let changed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]) === path.join(f.incoming, "bundle.tar.gz")) {
      const read = file.read.bind(file);
      let firstBlocks = 0;
      t.mock.method(file, "read", async (...readArgs: Parameters<typeof file.read>) => {
        if ((readArgs as readonly unknown[])[3] === 0 && ++firstBlocks === 1) {
          const bytes = await fs.readFile(path.join(f.incoming, "bundle.tar.gz"));
          bytes[4] = bytes[4]! ^ 1;
          await fs.writeFile(path.join(f.incoming, "bundle.tar.gz"), bytes);
          changed = true;
        }
        return await read(...readArgs);
      });
    }
    return file;
  });
  await assert.rejects(() => f.coordinator.prepare(f.incoming), /ARCHIVE_MISMATCH/);
  assert.equal(changed, true);
  assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
});

/** 真实句柄先完成关闭再拒绝，保留独立关闭错误且不让夹具占用缓存。 */
function rejectClosedFile(t: TestContext, file: Awaited<ReturnType<typeof fs.open>>, cause: unknown): void {
  const close = file.close.bind(file);
  t.mock.method(file, "close", async () => { await close(); throw cause; });
}

/** 递归读取实际cause与聚合，原错误引用及显式undefined均不能补造。 */
function extractCauses(value: unknown): unknown[] {
  if (value instanceof AggregateError) return [value, ...value.errors.flatMap(extractCauses)];
  return value instanceof Error && Object.hasOwn(value, "cause") ? [value, ...extractCauses(value.cause)] : [value];
}

for (const original of [undefined, false]) test(`archive read preserves a lone primitive rejection: ${String(original)}`, async t => {
  const f = await fixture(t), open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]) === path.join(f.incoming, "bundle.tar.gz")) t.mock.method(file, "read", async () => { throw original; });
    return file;
  });
  await assert.rejects(f.coordinator.prepare(f.incoming), failure => { assert.equal(failure, original); return true; });
  assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
});

for (const stage of ["archive-read", "payload-write", "payload-sync"] as const)
for (const original of [undefined, false, Object.freeze(new Error("extract operation failed"))])
test(`extract close causes retain ${stage} ${String(original)} and its independent close failure`, async t => {
  const f = await fixture(t), archivePath = path.join(f.incoming, "bundle.tar.gz");
  const archiveBefore = await fs.readFile(archivePath), manifestBefore = await fs.readFile(path.join(f.incoming, "manifest.json"));
  const closing = Object.freeze(new Error("extract close failed")), open = fs.open;
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  let injected = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); handles.push(file);
    const target = String(args[0]);
    const selected = stage === "archive-read" ? target === archivePath
      : target.includes(`${path.sep}.staging${path.sep}`) && target.endsWith(`${path.sep}web${path.sep}index.html`);
    if (selected && !injected) {
      injected = true; rejectClosedFile(t, file, closing);
      if (stage === "archive-read") t.mock.method(file, "read", async () => { throw original; });
      else if (stage === "payload-write") t.mock.method(file, "write", async () => { throw original; });
      else t.mock.method(file, "sync", async () => { throw original; });
    }
    return file;
  });
  await assert.rejects(f.coordinator.prepare(f.incoming, { requestId: "extract-close-request" }), (failure: unknown) => {
    assert.ok(failure instanceof AggregateError);
    assert.equal(failure.errors.length, 2); assert.equal(failure.errors[0], original); assert.equal(failure.errors[1], closing);
    return true;
  });
  assert.equal(injected, true); assert.ok(handles.length > 0); assert.ok(handles.every(file => file.fd === -1));
  assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
  assert.equal(await readActivePointer(f.rootDir), null);
  assert.deepEqual(await fs.readFile(archivePath), archiveBefore);
  assert.deepEqual(await fs.readFile(path.join(f.incoming, "manifest.json")), manifestBefore);
  const records = createUpdateFailureJournal(f.rootDir).pending(context.deviceId);
  assert.equal(records.length, 1); assert.equal(records[0]!.requestId, "extract-close-request");
  const prepared = await f.coordinator.prepare(f.incoming, { requestId: "extract-explicit-retry" });
  assert.equal(await fs.readFile(path.join(prepared.stagingDir, "web", "index.html"), "utf8"), "页面");
});

for (const stage of ["archive", "payload"] as const)
test(`extract close causes expose a lone ${stage} close failure and permit explicit retry`, async t => {
  const f = await fixture(t), closing = new Error("extract close failed"), open = fs.open;
  let failed: Awaited<ReturnType<typeof fs.open>> | undefined;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args), target = String(args[0]);
    const selected = stage === "archive" ? target === path.join(f.incoming, "bundle.tar.gz")
      : target.includes(`${path.sep}.staging${path.sep}`) && target.endsWith(`${path.sep}web${path.sep}index.html`);
    if (selected && !failed) { failed = file; rejectClosedFile(t, file, closing); }
    return file;
  });
  await assert.rejects(f.coordinator.prepare(f.incoming), (failure: unknown) => { assert.equal(failure, closing); return true; });
  assert.equal(failed?.fd, -1); assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
  assert.equal(createUpdateFailureJournal(f.rootDir).pending(context.deviceId).length, 1);
  await f.coordinator.prepare(f.incoming);
});

test("extract close causes retain an undefined write and both file close failures before staging cleanup", async t => {
  const f = await fixture(t), archiveClose = new Error("archive close failed"), payloadClose = new Error("payload close failed");
  const open = fs.open, remove = fs.rm, handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  let cleaned = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); handles.push(file);
    const target = String(args[0]);
    if (target === path.join(f.incoming, "bundle.tar.gz")) rejectClosedFile(t, file, archiveClose);
    if (target.includes(`${path.sep}.staging${path.sep}`) && target.endsWith(`${path.sep}web${path.sep}index.html`)) {
      rejectClosedFile(t, file, payloadClose);
      t.mock.method(file, "write", async () => { throw undefined; });
    }
    return file;
  });
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).includes(`${path.sep}.staging${path.sep}`)) {
      assert.ok(handles.length > 0); assert.ok(handles.every(file => file.fd === -1)); cleaned = true;
    }
    return await remove(...args);
  });
  await assert.rejects(f.coordinator.prepare(f.incoming), (failure: unknown) => {
    const causes = extractCauses(failure);
    assert.ok(causes.includes(undefined)); assert.ok(causes.includes(payloadClose)); assert.ok(causes.includes(archiveClose));
    return true;
  });
  assert.equal(cleaned, true); assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
  assert.equal(createUpdateFailureJournal(f.rootDir).pending(context.deviceId).length, 1);
});

/** 真实I/O结算时取消，核原原因、失败日志、清理边界及显式重试。 */
for (const stage of ["write", "sync"] as const)
for (const outcome of ["cancel", "error", "undefined", "false", "error-close", "cancel-close", "aggregate", "aggregate-close"] as const)
test(`extract cancellation causes retain ${stage} ${outcome} before cleanup and explicit retry`, async t => {
  const f = await fixture(t), controller = new AbortController(), requestId = crypto.randomUUID();
  const cancelled = Object.freeze(new Error("extract cancelled")), closing = Object.freeze(new Error("payload close failed"));
  const diskFailure = outcome === "undefined" ? undefined : outcome === "false" ? false
    : outcome.startsWith("aggregate") ? Object.freeze(new AggregateError([new Error("disk detail")], "disk aggregate"))
    : Object.freeze(new Error("payload disk failed"));
  const hasDiskFailure = outcome !== "cancel" && outcome !== "cancel-close", hasCloseFailure = outcome.endsWith("-close");
  const receipts: string[] = [];
  const coordinator = createReleaseBundleCoordinator({ rootDir: f.rootDir, trustedReleaseKeys: { fixture: f.keys.publicKey },
    getFailureContext: () => context, isCancellation: error => error === cancelled,
    reportReceipt: async receipt => { receipts.push(receipt.stage); } });
  const archivePath = path.join(f.incoming, "bundle.tar.gz"), manifestPath = path.join(f.incoming, "manifest.json");
  const archiveBefore = await fs.readFile(archivePath), manifestBefore = await fs.readFile(manifestPath);
  const open = fs.open, remove = fs.rm, handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  let injected = false, cleaned = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); handles.push(file);
    const target = String(args[0]);
    if (!injected && target.includes(`${path.sep}.staging${path.sep}`) && target.endsWith(`${path.sep}web${path.sep}index.html`)) {
      injected = true;
      if (hasCloseFailure) rejectClosedFile(t, file, closing);
      if (stage === "write") {
        const write = file.write.bind(file);
        t.mock.method(file, "write", async (...writeArgs: Parameters<typeof file.write>) => {
          const result = await write(...writeArgs);
          controller.abort(cancelled);
          if (hasDiskFailure) throw diskFailure;
          return result;
        });
      } else {
        const sync = file.sync.bind(file);
        t.mock.method(file, "sync", async () => {
          await sync();
          controller.abort(cancelled);
          if (hasDiskFailure) throw diskFailure;
        });
      }
    }
    return file;
  });
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).includes(`${path.sep}.staging${path.sep}`)) {
      assert.ok(handles.length > 0); assert.ok(handles.every(file => file.fd === -1)); cleaned = true;
    }
    return await remove(...args);
  });
  await assert.rejects(coordinator.prepare(f.incoming, { signal: controller.signal, requestId }), (failure: unknown) => {
    const causes = extractCauses(failure);
    assert.equal(causes.filter(cause => cause === cancelled).length, 1);
    if (hasDiskFailure) assert.equal(causes.filter(cause => cause === diskFailure).length, 1);
    if (hasCloseFailure) assert.equal(causes.filter(cause => cause === closing).length, 1);
    if (!hasDiskFailure && !hasCloseFailure) assert.equal(failure, cancelled);
    else assert.ok(failure instanceof AggregateError);
    return true;
  });
  assert.equal(injected, true); assert.equal(cleaned, true); assert.deepEqual(receipts, []);
  assert.ok(handles.every(file => file.fd === -1)); assert.deepEqual(await fs.readdir(path.join(f.rootDir, ".staging")), []);
  assert.equal(await readActivePointer(f.rootDir), null);
  assert.deepEqual(await fs.readFile(archivePath), archiveBefore); assert.deepEqual(await fs.readFile(manifestPath), manifestBefore);
  const records = createUpdateFailureJournal(f.rootDir).pending(context.deviceId);
  assert.equal(records.length, hasDiskFailure || hasCloseFailure ? 1 : 0);
  if (records.length) {
    const record = records[0]!;
    assert.ok(record.errorCode === "DESKTOP_RELEASE_FAILED");
    assert.equal(record.requestId, requestId); assert.equal(record.releaseId, f.built.manifest.releaseId);
    assert.equal(record.phase, "prepare");
  }
  const prepared = await coordinator.prepare(f.incoming, { requestId: crypto.randomUUID() });
  assert.equal(await fs.readFile(path.join(prepared.stagingDir, "web", "index.html"), "utf8"), "页面");
  assert.deepEqual(receipts, ["verified", "prepared"]);
});

/** 多边界同时失败仍须把磁盘叶因写入既有深度的耐久日志。 */
for (const stage of ["write", "sync"] as const)
test(`extract cancellation journal retains ${stage} and both closes when staging cleanup also fails`, async t => {
  const f = await fixture(t), controller = new AbortController(), requestId = crypto.randomUUID();
  const cancelled = new Error("extract cancelled"), disk = Object.assign(new Error("payload failed"), { code: "EIO" });
  const payloadClose = Object.assign(new Error("payload close failed"), { code: "EBADF" });
  const archiveClose = Object.assign(new Error("archive close failed"), { code: "ENOSPC" });
  const cleanup = Object.assign(new Error("staging cleanup failed"), { code: "EACCES" });
  const open = fs.open, remove = fs.rm, handles: Awaited<ReturnType<typeof fs.open>>[] = [], receipts: string[] = [];
  const coordinator = createReleaseBundleCoordinator({ rootDir: f.rootDir, trustedReleaseKeys: { fixture: f.keys.publicKey },
    getFailureContext: () => context, isCancellation: error => error === cancelled,
    reportReceipt: async receipt => { receipts.push(receipt.stage); } });
  let injected = false, cleanupFailed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); handles.push(file);
    const target = String(args[0]);
    if (!injected && target === path.join(f.incoming, "bundle.tar.gz")) rejectClosedFile(t, file, archiveClose);
    if (!injected && target.includes(`${path.sep}.staging${path.sep}`) && target.endsWith(`${path.sep}web${path.sep}index.html`)) {
      injected = true; rejectClosedFile(t, file, payloadClose);
      if (stage === "write") {
        const write = file.write.bind(file);
        t.mock.method(file, "write", async (...writeArgs: Parameters<typeof file.write>) => {
          await write(...writeArgs); controller.abort(cancelled); throw disk;
        });
      } else {
        const sync = file.sync.bind(file);
        t.mock.method(file, "sync", async () => { await sync(); controller.abort(cancelled); throw disk; });
      }
    }
    return file;
  });
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (!cleanupFailed && String(args[0]).includes(`${path.sep}.staging${path.sep}`)) {
      assert.ok(handles.length > 0); assert.ok(handles.every(file => file.fd === -1));
      cleanupFailed = true; throw cleanup;
    }
    return await remove(...args);
  });
  await assert.rejects(coordinator.prepare(f.incoming, { signal: controller.signal, requestId }), (failure: unknown) => {
    const causes = extractCauses(failure);
    for (const original of [cancelled, disk, payloadClose, archiveClose, cleanup]) assert.equal(causes.filter(cause => cause === original).length, 1);
    return true;
  });
  assert.equal(injected, true); assert.equal(cleanupFailed, true); assert.deepEqual(receipts, []);
  assert.equal(await readActivePointer(f.rootDir), null);
  const records = createUpdateFailureJournal(f.rootDir).pending(context.deviceId);
  assert.equal(records.length, 1); assert.equal(records[0]!.requestId, requestId);
  const diagnostic = JSON.stringify(records[0]!.rootCause);
  for (const original of [disk, payloadClose, archiveClose, cleanup]) assert.ok(diagnostic.includes(`"code":"${original.code}"`), original.code);
  const prepared = await coordinator.prepare(f.incoming);
  assert.equal(await fs.readFile(path.join(prepared.stagingDir, "web", "index.html"), "utf8"), "页面");
  assert.deepEqual(receipts, ["verified", "prepared"]);
});

/** 真实解包读取结算时取消，核原因保留和纯取消分类。 */
for (const outcome of ["cancel", "error", "undefined", "false", "aggregate", "read-only", "cleanup", "aggregate-cleanup"] as const)
for (const closeFails of [false, true])
test(`extract read cancellation retains ${outcome} with close=${closeFails} and permits explicit retry`, async t => {
  const f = await fixture(t), controller = new AbortController(), requestId = crypto.randomUUID();
  const cancelled = Object.freeze(new Error("extract cancelled"));
  const disk = Object.freeze(Object.assign(new Error("archive read failed"), { code: "EIO" }));
  const original = outcome === "undefined" ? undefined : outcome === "false" ? false
    : outcome.startsWith("aggregate") ? Object.freeze(new AggregateError([disk], "archive read aggregate")) : disk;
  const closing = Object.freeze(Object.assign(new Error("archive close failed"), { code: "EBADF" }));
  const cleanup = Object.freeze(Object.assign(new Error("staging cleanup failed"), { code: "EACCES" }));
  const cleanupFails = outcome.endsWith("cleanup");
  const hasReadFailure = outcome !== "cancel", hasCancellation = outcome !== "read-only", receipts: string[] = [];
  const coordinator = createReleaseBundleCoordinator({ rootDir: f.rootDir, trustedReleaseKeys: { fixture: f.keys.publicKey },
    getFailureContext: () => context, isCancellation: error => error === cancelled,
    reportReceipt: async receipt => { receipts.push(receipt.stage); } });
  const archivePath = path.join(f.incoming, "bundle.tar.gz"), manifestPath = path.join(f.incoming, "manifest.json");
  const archiveBefore = await fs.readFile(archivePath), manifestBefore = await fs.readFile(manifestPath);
  const open = fs.open, remove = fs.rm, handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  let injected = false, cleaned = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); handles.push(file);
    if (!injected && String(args[0]) === archivePath) {
      const read = file.read.bind(file);
      let zeroReads = 0;
      t.mock.method(file, "read", async (...readArgs: Parameters<typeof file.read>) => {
        const result = await read(...readArgs);
        if ((readArgs as readonly unknown[])[3] === 0 && ++zeroReads === 1) {
          injected = true;
          if (closeFails) rejectClosedFile(t, file, closing);
          if (hasCancellation) controller.abort(cancelled);
          if (hasReadFailure) throw original;
        }
        return result;
      });
    }
    return file;
  });
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).includes(`${path.sep}.staging${path.sep}`)) {
      assert.ok(handles.length > 0); assert.ok(handles.every(file => file.fd === -1));
      if (cleanupFails && !cleaned) { cleaned = true; throw cleanup; }
      cleaned = true;
    }
    return await remove(...args);
  });
  await assert.rejects(coordinator.prepare(f.incoming, { signal: controller.signal, requestId }), (failure: unknown) => {
    const causes = extractCauses(failure);
    assert.equal(causes.filter(cause => cause === cancelled).length, hasCancellation ? 1 : 0);
    if (hasReadFailure) assert.equal(causes.filter(cause => cause === original).length, 1);
    if (closeFails) assert.equal(causes.filter(cause => cause === closing).length, 1);
    if (cleanupFails) assert.equal(causes.filter(cause => cause === cleanup).length, 1);
    if (!hasReadFailure && !closeFails) assert.equal(failure, cancelled);
    if (outcome === "read-only" && !closeFails) assert.equal(failure, original);
    return true;
  });
  assert.equal(injected, true); assert.equal(cleaned, true); assert.deepEqual(receipts, []);
  assert.ok(handles.every(file => file.fd === -1)); assert.equal((await fs.readdir(path.join(f.rootDir, ".staging"))).length, cleanupFails ? 1 : 0);
  assert.equal(await readActivePointer(f.rootDir), null);
  assert.deepEqual(await fs.readFile(archivePath), archiveBefore); assert.deepEqual(await fs.readFile(manifestPath), manifestBefore);
  const records = createUpdateFailureJournal(f.rootDir).pending(context.deviceId);
  assert.equal(records.length, hasReadFailure || closeFails ? 1 : 0);
  if (records.length) {
    assert.equal(records[0]!.requestId, requestId); assert.equal(records[0]!.phase, "prepare");
    const diagnostic = JSON.stringify(records[0]!.rootCause);
    if (["error", "aggregate", "read-only", "cleanup", "aggregate-cleanup"].includes(outcome)) assert.ok(diagnostic.includes('"code":"EIO"'));
    if (closeFails) assert.ok(diagnostic.includes('"code":"EBADF"'));
    if (cleanupFails) assert.ok(diagnostic.includes('"code":"EACCES"'));
  }
  const prepared = await coordinator.prepare(f.incoming);
  assert.equal(await fs.readFile(path.join(prepared.stagingDir, "web", "index.html"), "utf8"), "页面");
  assert.deepEqual(receipts, ["verified", "prepared"]);
});

/** 两个真实操作已在途时分别先结束读取或条目，取消只保留一次。 */
for (const order of ["read-first", "entry-first"] as const)
test(`extract read cancellation retains concurrent ${order} causes once in the journal`, { timeout: 10_000 }, async t => {
  const f = await fixture(t), controller = new AbortController(), requestId = crypto.randomUUID();
  const content = crypto.randomBytes(256 * 1024);
  const files = [...f.built.manifest.files, { path: "web/large.bin", size: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex") }].sort((a, b) => a.path < b.path ? -1 : 1);
  const webSha256 = computeReleaseDirectorySha256(files, "web"), clientSha256 = computeReleaseDirectorySha256(files, "client");
  await f.replaceArchive(archive([f.entries[0]!, { path: "web/large.bin", type: "File", content }, f.entries[1]!]),
    { files, webSha256, clientSha256, packageSha256: computeReleasePackageSha256(webSha256, clientSha256) });
  const cancelled = new Error("extract cancelled"), disk = Object.assign(new Error("archive read failed"), { code: "EIO" });
  const entryClose = Object.assign(new Error("entry close failed"), { code: "EBADF" });
  const archiveClose = Object.assign(new Error("archive close failed"), { code: "ENOSPC" });
  const cleanup = Object.assign(new Error("staging cleanup failed"), { code: "EACCES" });
  let syncStarted!: () => void, finishSync!: () => void, entryClosed!: () => void;
  const syncing = new Promise<void>(resolve => { syncStarted = resolve; }), releaseSync = new Promise<void>(resolve => { finishSync = resolve; });
  const closed = new Promise<void>(resolve => { entryClosed = resolve; });
  const open = fs.open, remove = fs.rm, handles: Awaited<ReturnType<typeof fs.open>>[] = [], receipts: string[] = [];
  const coordinator = createReleaseBundleCoordinator({ rootDir: f.rootDir, trustedReleaseKeys: { fixture: f.keys.publicKey },
    getFailureContext: () => context, isCancellation: error => error === cancelled,
    reportReceipt: async receipt => { receipts.push(receipt.stage); } });
  let injected = false, cleanupFailed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); handles.push(file);
    const target = String(args[0]);
    if (target === path.join(f.incoming, "bundle.tar.gz")) {
      rejectClosedFile(t, file, archiveClose);
      const read = file.read.bind(file);
      let zeroReads = 0;
      t.mock.method(file, "read", async (...readArgs: Parameters<typeof file.read>) => {
        const result = await read(...readArgs), position = (readArgs as readonly unknown[])[3];
        if (position === 0) zeroReads += 1;
        if (zeroReads === 1 && position !== 0 && !injected) {
          await syncing; injected = true; controller.abort(cancelled);
          if (order === "read-first") setImmediate(finishSync);
          else { finishSync(); await closed; await new Promise<void>(resolve => setImmediate(resolve)); }
          throw disk;
        }
        return result;
      });
    }
    if (target.includes(`${path.sep}.staging${path.sep}`) && target.endsWith(`${path.sep}web${path.sep}index.html`)) {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => { await close(); entryClosed(); throw entryClose; });
      const sync = file.sync.bind(file);
      t.mock.method(file, "sync", async () => { await sync(); syncStarted(); await releaseSync; });
    }
    return file;
  });
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (!cleanupFailed && String(args[0]).includes(`${path.sep}.staging${path.sep}`)) {
      assert.ok(handles.length > 0); assert.ok(handles.every(file => file.fd === -1));
      cleanupFailed = true; throw cleanup;
    }
    return await remove(...args);
  });
  await assert.rejects(coordinator.prepare(f.incoming, { signal: controller.signal, requestId }), (failure: unknown) => {
    const causes = extractCauses(failure);
    for (const original of [cancelled, disk, entryClose, archiveClose, cleanup]) assert.equal(causes.filter(cause => cause === original).length, 1);
    return true;
  });
  assert.equal(injected, true); assert.equal(cleanupFailed, true); assert.deepEqual(receipts, []);
  const records = createUpdateFailureJournal(f.rootDir).pending(context.deviceId);
  assert.equal(records.length, 1); assert.equal(records[0]!.requestId, requestId);
  const diagnostic = JSON.stringify(records[0]!.rootCause);
  for (const original of [disk, entryClose, archiveClose, cleanup]) assert.ok(diagnostic.includes(`"code":"${original.code}"`), original.code);
});

