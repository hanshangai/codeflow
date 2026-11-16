import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import {
  prepareClientUpgradePackage, verifyPreparedClientUpgradePackage, cleanupClientUpgradePackage,
  ClientUpgradePackageError,
} from "../../apps/desktop/client/src/update/clientUpgradePackage.ts";
import { runPosixClientUpgrade } from "../../apps/desktop/client/src/update/clientUpgradeLifecycle.ts";

const archive = gzipSync(Buffer.from("synthetic test archive; no application code is executed"));
const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
async function server(t: TestContext, handler: http.RequestListener): Promise<string> {
  const instance = http.createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  t.after(async () => { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); });
  return `http://127.0.0.1:${(instance.address() as import("node:net").AddressInfo).port}`;
}
function trackDirectories(t: TestContext): string[] {
  const directories: string[] = [];
  const original = fs.promises.mkdtemp.bind(fs.promises);
  t.mock.method(fs.promises, "mkdtemp", async (prefix: string) => { const dir = await original(prefix); directories.push(dir); return dir; });
  return directories;
}

test("真实 HTTP 下载、SHA256 校验、停机前复核及清理；请求不携带 Client 凭据", async t => {
  const requests: string[] = [];
  const stages: string[] = [];
  const base = await server(t, (req, res) => {
    requests.push(req.url!);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-client-api-key"], undefined);
    res.end(req.url!.includes(".sha256") ? sha(archive).toUpperCase() + "\n" : archive);
  });
  const prepared = await prepareClientUpgradePackage({ installUrl: base + "/client.tgz?download=1", onProgress: p => stages.push(p.stage) });
  assert.deepEqual(requests, ["/client.tgz.sha256?download=1", "/client.tgz?download=1"]);
  assert.deepEqual(stages, ["checksum", "download", "verified"]);
  assert.deepEqual(fs.readFileSync(prepared.archivePath), archive);
  assert.equal(fs.existsSync(prepared.archivePath + ".part"), false);
  verifyPreparedClientUpgradePackage(prepared);
  await cleanupClientUpgradePackage(prepared);
  assert.equal(fs.existsSync(prepared.directory), false);
});

for (const scenario of ["checksum-404", "archive-404", "checksum-invalid", "checksum-large", "hash-mismatch", "non-gzip", "empty", "too-large", "disconnect", "timeout", "cancel"]) {
  test(`下载准备失败不进入停机/安装阶段，并清理半包：${scenario}`, async t => {
    const directories = trackDirectories(t);
    const controller = new AbortController();
    const data = scenario === "non-gzip" ? Buffer.from("not gzip") : scenario === "empty" ? Buffer.alloc(0) : archive;
    const base = await server(t, (req, res) => {
      if (req.url!.endsWith(".sha256")) {
        if (scenario === "checksum-404") res.writeHead(404);
        res.end(scenario === "checksum-invalid" ? "not-a-digest" : scenario === "checksum-large" ? "a".repeat(1025)
          : scenario === "hash-mismatch" ? "0".repeat(64) : sha(data));
      } else {
        if (scenario === "archive-404") { res.writeHead(404); res.end(); }
        else if (scenario === "too-large") { res.writeHead(200, { "content-length": String(256 * 1024 * 1024 + 1) }); res.flushHeaders(); }
        else if (scenario === "disconnect") { res.destroy(); }
        else if (scenario === "timeout") { res.writeHead(200); res.write(archive.subarray(0, 3)); }
        else if (scenario === "cancel") { res.writeHead(200); res.write(archive.subarray(0, 3)); controller.abort(); }
        else res.end(data);
      }
    });
    const calls: string[] = [];
    await assert.rejects(async () => {
      const prepared = await prepareClientUpgradePackage({ installUrl: base + "/client.tgz", timeoutMs: 500, signal: controller.signal });
      calls.push("stop-or-install");
      await cleanupClientUpgradePackage(prepared);
    }, error => error instanceof ClientUpgradePackageError && error.stage === "prepare");
    assert.deepEqual(calls, []);
    assert.equal(directories.length, 1);
    assert.equal(fs.existsSync(directories[0]), false, "失败下载不能遗留打开的文件句柄或半包");
  });
}

test("慢下载期间真实旧进程持续运行；下载结束后才允许调用停止", async t => {
  const old = spawn(process.execPath, ["-e", "setInterval(()=>process.stdout.write('alive\\n'),20)"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let heartbeats = 0; old.stdout.on("data", data => heartbeats += String(data).split("alive").length - 1);
  t.after(() => { if (old.exitCode === null && !old.killed) old.kill(); });
  const base = await server(t, (req, res) => {
    if (req.url!.endsWith(".sha256")) { res.end(sha(archive)); return; }
    res.write(archive.subarray(0, 3));
    const timer = setTimeout(() => res.end(archive.subarray(3)), 250);
    res.on("close", () => clearTimeout(timer));
  });
  const prepared = await prepareClientUpgradePackage({ installUrl: base + "/client.tgz" });
  assert.equal(old.exitCode, null);
  assert.ok(heartbeats >= 2, "下载阶段不能阻塞或停止旧进程");
  const calls: string[] = [];
  const result = runPosixClientUpgrade({
    previous: { running: true, clientPid: old.pid!, supervisorPid: old.pid! }, expectedVersion: "test-target",
    verifyPackage: () => { verifyPreparedClientUpgradePackage(prepared); calls.push("verified"); },
    run: args => {
      calls.push(args[0]);
      if (args[0] === "--stop") { assert.equal(old.exitCode, null); old.kill(); }
      return { status: 0, stdout: args[0] === "--version" ? "test-target" : JSON.stringify({ schemaVersion: 1,
        connected: true, clientRunning: true, supervisorRunning: true, clientPid: old.pid! + 1, stage: "ready" }) };
    }, install: () => { calls.push("offline-install"); assert.deepEqual(fs.readFileSync(prepared.archivePath), archive); },
  });
  assert.equal(result.restarted, true);
  assert.deepEqual(calls, ["verified", "--stop", "offline-install", "--version", "--daemon", "--connected"]);
  await cleanupClientUpgradePackage(prepared);
});

test("下载后包被篡改时，停机前复核拒绝升级", async t => {
  const base = await server(t, (req, res) => res.end(req.url!.endsWith(".sha256") ? sha(archive) : archive));
  const prepared = await prepareClientUpgradePackage({ installUrl: base + "/client.tgz" });
  fs.appendFileSync(prepared.archivePath, "tampered");
  assert.throws(() => verifyPreparedClientUpgradePackage(prepared), /SHA256/);
  await cleanupClientUpgradePackage(prepared);
});

test("同源下载跳转可用；跨源跳转不跟随，且旧 Client 不受影响", async t => {
  let externalRequests = 0;
  const external = await server(t, (_req, res) => { externalRequests++; res.end(archive); });
  let crossOrigin = false;
  const base = await server(t, (req, res) => {
    if (req.url === "/client.tgz.sha256") { res.writeHead(302, { location: "/checksum" }); res.end(); }
    else if (req.url === "/checksum") res.end(sha(archive));
    else if (req.url === "/client.tgz") { res.writeHead(307, { location: crossOrigin ? external + "/payload" : "/payload" }); res.end(); }
    else res.end(archive);
  });
  const prepared = await prepareClientUpgradePackage({ installUrl: base + "/client.tgz" });
  await cleanupClientUpgradePackage(prepared);
  crossOrigin = true;
  await assert.rejects(prepareClientUpgradePackage({ installUrl: base + "/client.tgz" }), error => error instanceof ClientUpgradePackageError && error.code === "CLIENT_UPGRADE_REDIRECT_REJECTED");
  assert.equal(externalRequests, 0);
});

test("清理不递归删除其他文件，也拒绝非专属临时目录", async t => {
  const base = await server(t, (req, res) => res.end(req.url!.endsWith(".sha256") ? sha(archive) : archive));
  const prepared = await prepareClientUpgradePackage({ installUrl: base + "/client.tgz" });
  const marker = path.join(prepared.directory, "unrelated.txt"); fs.writeFileSync(marker, "keep");
  await assert.rejects(cleanupClientUpgradePackage(prepared));
  assert.equal(fs.readFileSync(marker, "utf8"), "keep");
  fs.unlinkSync(marker); fs.rmdirSync(prepared.directory);
  await assert.rejects(cleanupClientUpgradePackage({ directory: path.resolve(os.tmpdir()), archivePath: path.join(os.tmpdir(), "client.tgz"), sha256: sha(archive) }), /路径不合法/);
});
