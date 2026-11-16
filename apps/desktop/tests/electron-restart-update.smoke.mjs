import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as tar from "tar";
import { DESKTOP_STARTUP_CAPABILITY_PATH, formatDesktopVersion } from "@codeflowai/shared";
import { computeReleaseDirectorySha256, computeReleasePackageSha256, readReleaseBundleFiles, signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import { desktopDevicePublicKeySha256, readDesktopDeviceHeaders } from "@codeflowai/shared/desktop-device-auth";

/**
 * 真实 Electron 窗口、默认 ClientRuntime 子进程和 SQLite 协议验收。
 * 临时 Client/Web/HTTP 服务只驱动协议，不代表产品 Client、渲染器业务或真实 Server 验收。
 * 运行前在 apps/desktop 执行 pnpm build；失败保留独占临时目录，成功自动清理。
 * CODEFLOW_RESTART_SMOKE_KEEP_ROOT=1 可保留成功的 verification.json 与轨迹。
 */
const entry = fileURLToPath(import.meta.url);
const shellVersion = "1.0.0";

/** 每条轨迹同步落盘，关联资源、进程与启动围栏。 */
function trace(root, event) {
  fsSync.appendFileSync(path.join(root, "trace.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

/** 流式核对相同壳文件，避免把 Electron 可执行文件整体放入内存。 */
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** 临时 Client 实际打开 SQLite；只有 continue 才放行业务，关闭必须释放数据库。 */
function fixtureClient(version, schemaVersion, root) {
  return `
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const version = ${JSON.stringify(version)}, schemaVersion = ${schemaVersion};
const requestId = process.env.CODEFLOWAI_DESKTOP_REQUEST_ID;
const startupMode = process.env.CODEFLOWAI_DESKTOP_STARTUP_MODE;
const continuationId = process.env.CODEFLOWAI_DESKTOP_STARTUP_CONTINUATION_ID;
const traceFile = ${JSON.stringify(path.join(root, "trace.jsonl"))};
let admitted = startupMode === "automatic", db;
/** 夹具轨迹包含真实进程与数据库事实，不记录环境变量或凭据。 */
function record(event) { fs.appendFileSync(traceFile, JSON.stringify({ at: new Date().toISOString(), version, pid: process.pid, requestId, ...event }) + "\\n", "utf8"); }
/** IPC 发送失败必须使夹具失败，不能伪造成功。 */
function send(message) { process.send(message, error => { if (error) throw error; }); }
/** 释放实际 SQLite 连接后退出，异常交给进程失败边界。 */
function close() { db.close(); record({ event: "client.closed" }); process.exit(0); }
try {
  db = new DatabaseSync(process.env.CODEFLOWAI_CLIENT_DB_PATH);
  const previousSchema = db.prepare("PRAGMA user_version").get().user_version;
  if (previousSchema > schemaVersion) throw new Error("FIXTURE_SCHEMA_DOWNGRADE");
  db.exec("CREATE TABLE IF NOT EXISTS fixture_state (id INTEGER PRIMARY KEY, version TEXT NOT NULL)");
  db.prepare("INSERT OR REPLACE INTO fixture_state VALUES (1, ?)").run(version);
  db.exec("PRAGMA user_version = " + schemaVersion);
  record({ event: "client.ready", startupMode, continuationId, previousSchema, schemaVersion, execPath: process.execPath, parentPid: process.ppid });
  process.on("message", message => {
    if (message.requestId !== requestId) throw new Error("FIXTURE_REQUEST_ID_MISMATCH");
    if (message.t === "desktop.shutdown") { close(); return; }
    if (message.t !== "desktop.api.req") throw new Error("FIXTURE_MESSAGE_INVALID");
    const method = message.request.method;
    let body;
    if (method === "runtime.startup.continue") {
      if (admitted || message.request.body.continuationId !== continuationId) throw new Error("FIXTURE_CONTINUATION_INVALID");
      admitted = true; record({ event: "client.continued", continuationId }); body = { ok: true };
    } else if (method === "fixture.inspect") {
      body = { version, schemaVersion: db.prepare("PRAGMA user_version").get().user_version,
        storedVersion: db.prepare("SELECT version FROM fixture_state WHERE id = 1").get().version,
        integrity: db.prepare("PRAGMA integrity_check").get().integrity_check, pid: process.pid, admitted, startupMode, execPath: process.execPath };
    } else throw new Error("FIXTURE_METHOD_UNEXPECTED: " + method);
    send({ t: "desktop.api.res", requestId, id: message.id, response: { status: 200, body } });
  });
  process.on("disconnect", close);
  send({ t: "desktop.ready", requestId, health: { protocolVersion: 1, clientVersion: version, dbSchemaVersion: schemaVersion, database: "ready" },
    ...(startupMode === "held" ? { startup: { continuationId, admission: "paused" } } : {}) });
} catch (error) { record({ event: "client.failed", code: "FIXTURE_CLIENT_FAILED", rootCause: error.message }); throw error; }
`;
}

/** 给真实库存签名；工件和安装基线使用相同 held 能力声明。 */
async function createRelease(root, version, schemaVersion, privateKey, { baseline = false, brokenWeb = false } = {}) {
  const releaseId = `fixture-${version}`, directory = path.join(root, releaseId);
  await fs.mkdir(path.join(directory, "client", "dist"), { recursive: true });
  await fs.mkdir(path.join(directory, "web"));
  const source = fixtureClient(version, schemaVersion, root);
  await fs.writeFile(path.join(directory, "client", "dist", "index.cjs"), source, "utf8");
  await fs.writeFile(path.join(directory, DESKTOP_STARTUP_CAPABILITY_PATH), JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1,
    clientEntrySha256: crypto.createHash("sha256").update(source).digest("hex") }), "utf8");
  await fs.writeFile(path.join(directory, "web", "index.html"), `<!doctype html><html><head><meta charset="utf-8"></head><body>${version}<script>
    window.fixtureVersion = ${JSON.stringify(version)};
    ${brokenWeb ? "throw new Error('FIXTURE_WEB_BOOT_FAILED');" : "document.documentElement.dataset.codeflowReady = '1';"}
  </script></body></html>`, "utf8");
  const files = await readReleaseBundleFiles(directory), archiveFile = path.join(root, `${releaseId}.tar.gz`);
  await tar.c({ cwd: directory, file: archiveFile, gzip: true, portable: true }, ["web", "client"]);
  const archive = await fs.readFile(archiveFile), webSha256 = computeReleaseDirectorySha256(files, "web"), clientSha256 = computeReleaseDirectorySha256(files, "client");
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId, version, webVersion: version, clientVersion: version,
    protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: schemaVersion, platform: process.platform, arch: process.arch,
    keyId: "fixture", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z", files, webSha256, clientSha256,
    packageSha256: computeReleasePackageSha256(webSha256, clientSha256), archiveSha256: crypto.createHash("sha256").update(archive).digest("hex"), archiveSize: archive.length }, privateKey);
  await fs.writeFile(path.join(directory, baseline ? "baseline-release-manifest.json" : "manifest.json"), JSON.stringify(manifest), "utf8");
  return { directory, manifest, archive };
}

/** 仅回送本次协议所需响应；未知路由和处理异常明确失败。 */
async function serveFixture(root, identity, releases, getOffered) {
  const errors = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const metadata = readDesktopDeviceHeaders(request.rawHeaders), pathname = new URL(request.url, "http://127.0.0.1").pathname;
      response.setHeader("content-type", "application/json");
      let result;
      if (pathname.endsWith("/devices/register")) result = { ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) };
      else if (pathname === "/api/software/desktop/release-availability") {
        const offered = getOffered(); result = { ok: true, available: Boolean(offered), deviceId: identity.deviceId, requestId: metadata.requestId,
          ...(offered ? { manifest: offered.manifest } : {}) };
      } else if (pathname.endsWith("/update-receipts")) {
        trace(root, { event: "server.receipt", stage: body.stage, releaseId: body.releaseId, requestId: body.requestId });
        result = { ok: true, deviceId: body.deviceId, requestId: body.requestId, releaseId: body.releaseId, archiveSha256: body.archiveSha256,
          stage: body.stage, at: body.at, payloadSha256: body.payloadSha256 };
      } else if (pathname.endsWith("/update-failures")) result = { ok: true, deviceId: body.deviceId, errorId: body.errorId, payloadSha256: body.payloadSha256 };
      else {
        const target = releases.find(release => pathname.includes(`/${release.manifest.releaseId}/`));
        assert.ok(target, `FIXTURE_HTTP_ROUTE_UNEXPECTED: ${pathname}`);
        if (pathname.endsWith("/archive")) {
          response.writeHead(200, { "content-type": "application/octet-stream", etag: `"${target.manifest.archiveSha256}"`, "content-length": target.archive.length });
          response.end(target.archive); return;
        }
        assert.ok(pathname.endsWith("/switch-authorization"), `FIXTURE_HTTP_ROUTE_UNEXPECTED: ${pathname}`);
        result = { ok: true, authorized: true, deviceId: identity.deviceId, requestId: metadata.requestId,
          releaseId: target.manifest.releaseId, archiveSha256: target.manifest.archiveSha256 };
      }
      response.end(JSON.stringify(result));
    })().catch(error => {
      errors.push(error); trace(root, { event: "server.failed", code: "FIXTURE_HTTP_FAILED", rootCause: error.message });
      response.writeHead(500); response.end(JSON.stringify({ ok: false, code: "FIXTURE_HTTP_FAILED" }));
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`,
    /** 释放本脚本的监听和连接，随后检查异步处理异常。 */
    async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); assert.deepEqual(errors, []); } };
}

/** 真实应用重建保留同一数据目录，验证后台准备、held 激活及坏 Web 恢复。 */
async function runElectron(root) {
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", path.join(root, "profile"));
  // 应用实例重建沿用本次 Electron 宿主，最后一个窗口关闭时暂不结束验收进程。
  app.on("window-all-closed", () => {});
  let application, window, bridge, server, offered;
  const errors = [], summaries = [];
  try {
    const { createDesktopApplication } = await import("../dist/desktopApplication.js");
    const { loadWeb } = await import("../dist/webLoader.js");
    const { loadOrCreateDeviceIdentity } = await import("../dist/deviceIdentity.js");
    const { readActivePointer } = await import("../dist/releaseBundleCoordinator.js");
    const { readPendingRelease } = await import("../dist/pendingRelease.js");
    await app.whenReady();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519"), dataDir = path.join(root, "data");
    const baseline = await createRelease(root, "2026.11.08.01", 1, privateKey, { baseline: true });
    const releases = [await createRelease(root, "2026.11.09.01", 2, privateKey), await createRelease(root, "2026.11.09.02", 3, privateKey),
      await createRelease(root, "2026.11.09.03", 4, privateKey, { brokenWeb: true })];
    server = await serveFixture(root, await loadOrCreateDeviceIdentity(dataDir), releases, () => offered);
    const host = {
      /** 使用真实 Chromium 窗口，沙箱保持 Electron 默认隔离。 */
      createWindow() { window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); return window; },
      /** 使用产品就绪门禁；真实页面不发 ready 时必须失败。 */
      async loadWeb(target, releaseDir) { await loadWeb(target, pathToFileURL(path.join(releaseDir, "web", "index.html")).href, { requireReady: true, timeoutMs: 800 });
        trace(root, { event: "web.ready", version: await target.webContents.executeJavaScript("window.fixtureVersion") }); },
      /** 托盘与桥注册仅提供生命周期适配，不替代窗口、ClientRuntime 或数据库。 */
      createTray() { return { destroy() {} }; },
      /** 直接保存真实应用桥，业务请求继续通过默认 ClientRuntime IPC。 */
      registerBridge(value) { bridge = value; return () => { bridge = undefined; }; },
      onUpdateError(error, context) { errors.push(error); trace(root, { event: "update.failed", code: "SMOKE_UPDATE_FAILED", requestId: context.requestId, rootCause: error.message }); },
      onUpdateRetry(context) { throw new Error(`FIXTURE_UNEXPECTED_RETRY: ${context.error.message}`); },
      quit() { trace(root, { event: "application.exited" }); },
    };
    /** 每次构造使用默认 ClientRuntime，禁止进程或健康替身。 */
    async function start() {
      application = createDesktopApplication({ dataDir, initialReleaseDir: baseline.directory, requireBaseline: true,
        shellVersion, trustedReleaseKeys: { fixture: publicKey }, configuredServerOrigin: server.origin, host });
      await application.start();
    }
    /** 在真实 IPC 后读取数据库和进程事实，核对展示号与壳版本。 */
    async function inspect(version, schemaVersion) {
      const response = await bridge.request({ method: "fixture.inspect" }); assert.equal(response.status, 200);
      const state = response.body; assert.equal(state.version, version); assert.equal(state.storedVersion, version);
      assert.equal(state.schemaVersion, schemaVersion); assert.equal(state.integrity, "ok"); assert.equal(state.admitted, true);
      assert.equal(state.execPath, process.execPath); assert.ok(state.pid !== process.pid);
      const details = await application.getUpdateDetails(); assert.equal(details.current.shellVersion, shellVersion);
      assert.equal(details.current.bundle.version, version);
      return { ...state, displayVersion: formatDesktopVersion(shellVersion, version) };
    }
    await start();
    let current = await inspect(baseline.manifest.version, 1);
    const initialExecutable = await digest(process.execPath);
    for (const [index, candidate] of releases.entries()) {
      offered = candidate;
      const before = current, pointer = await readActivePointer(dataDir), db = await fs.readFile(path.join(dataDir, "codeflowai.db"));
      assert.equal(await application.checkForUpdates(), null);
      assert.equal((await application.getUpdateDetails()).bundle.result, "prepared");
      assert.equal(await readActivePointer(dataDir), pointer);
      assert.deepEqual(await fs.readFile(path.join(dataDir, "codeflowai.db")), db);
      assert.deepEqual(await inspect(before.version, before.schemaVersion), before);
      assert.equal((await readPendingRelease(dataDir)).releaseId, candidate.manifest.releaseId);
      trace(root, { event: "background.prepared", version: candidate.manifest.version, runningVersion: before.version, pid: before.pid });
      await application.exit(); application = undefined;
      await start();
      const failed = index === releases.length - 1, expected = failed ? releases[1] : candidate;
      current = await inspect(expected.manifest.version, failed ? 3 : index + 2);
      assert.notEqual(current.pid, before.pid); assert.equal(current.startupMode, "held");
      assert.equal(await readActivePointer(dataDir), expected.manifest.releaseId); assert.equal(await readPendingRelease(dataDir), null);
      const details = await application.getUpdateDetails(); assert.equal(details.bundle.result, failed ? "restored" : "healthy");
      if (failed) { assert.ok(application.updateCheckFailure); assert.equal(errors.length, 1); }
      else { assert.equal(application.updateCheckFailure, null); assert.equal(errors.length, 0); }
      summaries.push({ candidate: candidate.manifest.version, result: details.bundle.result, ...current });
    }
    assert.equal(await digest(process.execPath), initialExecutable, "同一壳升级不得改写可执行文件");
    await application.exit(); application = undefined;
    const events = (await fs.readFile(path.join(root, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    for (const [index, event] of events.entries()) if (event.event === "client.continued") {
      const ready = events.findIndex(item => item.event === "client.ready" && item.requestId === event.requestId);
      assert.ok(ready >= 0 && ready < index); assert.equal(events[ready].startupMode, "held");
      assert.ok(events.slice(ready + 1, index).some(item => item.event === "web.ready" && item.version === event.version), "Web ready 必须先于任务放行");
    }
    const bad = events.findIndex(event => event.event === "client.ready" && event.version === "2026.11.09.03");
    assert.ok(bad >= 0 && events[bad].schemaVersion === 4);
    const restored = events.slice(bad + 1).find(event => event.event === "client.ready");
    assert.equal(restored.version, "2026.11.09.02"); assert.equal(restored.previousSchema, 3);
    assert.equal(events.some(event => event.event === "client.continued" && event.version === "2026.11.09.03"), false);
    const report = { status: "passed", boundary: "真实Electron/窗口/默认ClientRuntime/SQLite；Client、Web、HTTP为协议夹具", shellVersion,
      shellSha256: initialExecutable, baseline: baseline.manifest.version, summaries };
    await fs.writeFile(path.join(root, "verification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await server.close(); server = undefined;
    console.log(JSON.stringify(report)); app.exit(0);
  } catch (error) {
    trace(root, { event: "smoke.failed", code: "ELECTRON_RESTART_UPDATE_SMOKE_FAILED", rootCause: error.stack });
    console.error(error);
    try { if (application) await application.exit(); if (server) await server.close(); }
    catch (cleanup) { console.error(new AggregateError([error, cleanup], "ELECTRON_RESTART_UPDATE_SMOKE_CLEANUP_FAILED")); }
    window?.destroy(); app.exit(1);
  }
}

// Electron 需先完成入口求值才能发 ready，不能在模块顶层等待 app.whenReady。
if (process.versions.electron) void runElectron(process.argv[2]);
else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-restart-update-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const electron = createRequire(import.meta.url)("electron");
    const result = await promisify(execFile)(electron, [entry, root], { env, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    process.stdout.write(result.stdout);
    if (process.env.CODEFLOW_RESTART_SMOKE_KEEP_ROOT === "1") console.log(`SMOKE_ROOT ${root}`);
    else await fs.rm(root, { recursive: true });
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw new Error(`ELECTRON_RESTART_UPDATE_SMOKE_FAILED: ${root}`, { cause: error });
  }
}
