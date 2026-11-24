import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createReleaseBundleCoordinator as createCoordinator, readActivePointer, resolveActiveRelease } from "../src/releaseBundleCoordinator.js";
import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";
import { signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import type { DesktopUpdateReceipt } from "@codeflowai/shared/desktop-update-receipt";
import * as releaseSigning from "@codeflowai/shared/desktop-release-signing";
import * as releaseCoordinator from "../src/releaseBundleCoordinator.js";
import { DESKTOP_STARTUP_CAPABILITY_PATH } from "@codeflowai/shared";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const trustedReleaseKeys = { fixture: publicKey };

const failureContext = { deviceId: "868683b1-e79b-4509-9ca1-97b7786e5344", shellVersion: "1.0.0", currentReleaseId: "installation", webVersion: "1.0.0", clientVersion: "1.0.0" };

test("活动与基线默认只检查入口，显式 full 仍核完整依赖", async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-installed-startup-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const source = await createPackage(rootDir);
  await fs.mkdir(path.join(source, "client/node_modules"));
  const extra = path.join(source, "client/node_modules/dependency.js");
  await fs.writeFile(extra, "original", "utf8");
  const original = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
  const { signature: _signature, ...payload } = original;
  const inventory = await releaseSigning.readReleaseBundleFiles(source);
  const clientSha256 = releaseSigning.computeReleaseDirectorySha256(inventory, "client");
  const manifest = signReleaseBundleManifest({ ...payload, files: inventory, clientSha256,
    packageSha256: packageHash(payload.webSha256, clientSha256) }, privateKey);
  await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(source, "baseline-release-manifest.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(extra, "changed", "utf8");
  const trust = { trustedReleaseKeys };
  assert.equal((await releaseCoordinator.resolveBaselineRelease(source, { ...trust, verification: "startup" })).manifest.releaseId, manifest.releaseId);
  assert.equal((await releaseCoordinator.resolveBaselineRelease(source, trust)).manifest.releaseId, manifest.releaseId);
  await assert.rejects(releaseCoordinator.resolveBaselineRelease(source, { ...trust, verification: "full" }), /Client payload SHA-256/u);
  await fs.unlink(path.join(source, "baseline-release-manifest.json"));
  const releaseDir = path.join(rootDir, "releases", manifest.releaseId);
  await fs.mkdir(path.dirname(releaseDir)); await fs.rename(source, releaseDir);
  await fs.writeFile(path.join(rootDir, "active-release.json"), JSON.stringify({ releaseId: manifest.releaseId }), "utf8");
  assert.equal((await resolveActiveRelease(rootDir, { ...trust, verification: "startup" }))?.releaseId, manifest.releaseId);
  assert.equal((await resolveActiveRelease(rootDir, trust))?.releaseId, manifest.releaseId);
  await assert.rejects(resolveActiveRelease(rootDir, { ...trust, verification: "full" }), /Client payload SHA-256/u);
});

test("prepare resume switch 只读取签名清单与 held marker，fresh 不触发全量校验", async t => {
  const f = await startupProofPackage(startupMarker());
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const { signature: _signature, ...payload } = f.manifest;
  const manifest = signReleaseBundleManifest({ ...payload, expiresAt: "2099-01-01T00:00:00.000Z" }, privateKey);
  await fs.writeFile(f.manifestFile, JSON.stringify(manifest), "utf8");
  await fs.rm(path.join(f.directory, "baseline-release-manifest.json"));
  await fs.writeFile(path.join(f.directory, "client/dist/index.cjs"), "changed", "utf8");
  const readFile = fs.readFile.bind(fs);
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    assert.ok(String(args[0]).endsWith(".json"), "运行时不应读取资源正文");
    return await readFile(...args);
  });
  const coordinator = createCoordinator({ rootDir: f.root, trustedReleaseKeys, requireHeldStartup: true, getFailureContext: () => failureContext });
  const prepared = await coordinator.prepare(f.directory);
  const resumed = await coordinator.resume({ requestId: prepared.requestId, releaseId: manifest.releaseId, stagingDir: prepared.stagingDir });
  const active = await coordinator.switch(resumed, { async checkCompatibility() {}, async drain() {}, async restartClient() {},
    async reloadWeb() {}, async waitHealthy() { return true; }, async restoreInitialRelease() {} });
  assert.equal((await resolveActiveRelease(f.root, { trustedReleaseKeys, requireHeldStartup: true }))?.releaseId, active.releaseId);
});

test("coordinator阶段轨迹按requestId标注开始、耗时和失败码", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-coordinator-trace-"));
  const directory = await createPackage(root);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const trace: Array<{ requestId: string; phase: string; outcome: string; durationMs?: number; errorCode?: string }> = [];
  const coordinator = createCoordinator({ rootDir: root, trustedReleaseKeys, getFailureContext: () => failureContext,
    onDiagnostic: event => trace.push(event) });
  const prepared = await coordinator.prepare(directory);
  await assert.rejects(coordinator.switch(prepared, { async checkCompatibility() {}, async drain() {},
    async restartClient() { throw Object.assign(new Error("private detail"), { code: "FIXTURE_CLIENT_START_FAILED" }); },
    async reloadWeb() {}, async waitHealthy() { return true; }, async restoreInitialRelease() {} }));
  assert.ok(trace.some(event => event.phase === "prepare" && event.outcome === "success" && event.requestId === prepared.requestId));
  assert.ok(trace.some(event => event.phase === "restart-client" && event.outcome === "failure"
    && event.errorCode === "FIXTURE_CLIENT_START_FAILED" && event.requestId === prepared.requestId));
  assert.ok(trace.every(event => event.durationMs === undefined || Number.isSafeInteger(event.durationMs) && event.durationMs >= 0));
  assert.equal(JSON.stringify(trace).includes("private detail"), false);
});

/** 更新测试固定可信身份和版本，不从现有安装目录读取设备数据。 */
function createReleaseBundleCoordinator(input: { rootDir: string; now?: () => number; reportReceipt?: (receipt: DesktopUpdateReceipt) => Promise<void> }) {
  return createCoordinator({ ...input, trustedReleaseKeys, getFailureContext: () => failureContext,
    reportReceipt: input.reportReceipt });
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function packageHash(webSha256: string, clientSha256: string): string {
  return sha256(`client\0${clientSha256}\nweb\0${webSha256}\n`);
}

function directoryHash(fileName: string, content: string): string {
  return sha256(`${fileName}\0${sha256(content)}\n`);
}

for (const observerFailure of [undefined, false]) test(`rollback still runs and preserves falsy observation failure ${String(observerFailure)}`, async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-update-observer-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const source = await createPackage(rootDir), primary = new Error("WEB_RELOAD_FAILED"); let restored = 0;
  const coordinator = createCoordinator({ rootDir, trustedReleaseKeys, getFailureContext: () => failureContext,
    onProgress(observation) { if (observation.phase === "rollback") throw observerFailure; } });
  const prepared = await coordinator.prepare(source);
  await assert.rejects(coordinator.switch(prepared, { async checkCompatibility() {}, async drain() {}, async restartClient() {},
    async reloadWeb() { throw primary; }, async waitHealthy() { return true; }, async restoreInitialRelease() { restored++; } }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], primary);
    assert.ok(error.errors.some(cause => cause === observerFailure || cause instanceof AggregateError && cause.errors.includes(observerFailure))); return true;
  });
  assert.equal(restored, 1); assert.equal(await readActivePointer(rootDir), null);
});

/** 真实资源使用临时测试密钥签名，禁止依赖安装包或生产信任根。 */
async function createPackage(root: string, options: { wrongClientHash?: boolean; releaseId?: string; expiresAt?: string; platform?: string; arch?: string } = {}): Promise<string> {
  const packageDir = path.join(root, `incoming-${options.releaseId ?? "new-release"}`);
  await fs.mkdir(path.join(packageDir, "web"), { recursive: true });
  await fs.mkdir(path.join(packageDir, "client", "dist"), { recursive: true });
  const web = "<!doctype html><title>CodeFlow</title>";
  const client = "console.log('client');";
  const webSha256 = directoryHash("index.html", web);
  const clientSha256 = directoryHash("dist/index.cjs", client);
  await fs.writeFile(path.join(packageDir, "web", "index.html"), web, "utf8");
  await fs.writeFile(path.join(packageDir, "client", "dist", "index.cjs"), client, "utf8");
  await fs.writeFile(path.join(packageDir, "manifest.json"), JSON.stringify(signReleaseBundleManifest({
    schemaVersion: 2,
    releaseId: options.releaseId ?? "new-release",
    version: "2026.10.24.01",
    webVersion: "2.0.0", clientVersion: "1.9.0", capabilityVersion: 1,
    platform: options.platform ?? process.platform, arch: options.arch ?? process.arch,
    protocolVersion: 1,
    dbSchemaVersion: 88,
    webSha256,
    clientSha256: options.wrongClientHash ? "0".repeat(64) : clientSha256,
    packageSha256: packageHash(webSha256, clientSha256),
    files: [{ path: "client/dist/index.cjs", size: Buffer.byteLength(client), sha256: sha256(client) },
      { path: "web/index.html", size: Buffer.byteLength(web), sha256: sha256(web) }],
    archiveSha256: "f".repeat(64), archiveSize: 100, keyId: "fixture",
    createdAt: "2026-10-24T00:00:00.000Z",
    expiresAt: options.expiresAt ?? "2099-10-24T00:00:00.000Z",
  }, privateKey)), "utf8");
  return packageDir;
}

test("preparation trusts signed aggregate metadata without hashing expanded resources", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  try {
    const packageDir = await createPackage(tempDir, { wrongClientHash: true });
    const coordinator = createReleaseBundleCoordinator({ rootDir: tempDir });
    assert.equal((await coordinator.prepare(packageDir)).manifest.releaseId, "new-release");
    assert.equal(await readActivePointer(tempDir), null);
    assert.equal(createUpdateFailureJournal(tempDir).pending(failureContext.deviceId).length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("rolls back the whole bundle when health confirmation fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  try {
    const previousPackage = await createPackage(tempDir, { releaseId: "previous-release", expiresAt: "2026-10-24T00:00:01.000Z" });
    await fs.mkdir(path.join(tempDir, "releases"), { recursive: true });
    await fs.rename(previousPackage, path.join(tempDir, "releases", "previous-release"));
    await fs.writeFile(path.join(tempDir, "active-release.json"), JSON.stringify({ releaseId: "previous-release" }), "utf8");
    const packageDir = await createPackage(tempDir, { releaseId: "new-release" });
    const receipts: DesktopUpdateReceipt[] = [];
    const coordinator = createReleaseBundleCoordinator({ rootDir: tempDir, reportReceipt: async receipt => { receipts.push(receipt); } });
    const prepared = await coordinator.prepare(packageDir);
    const restartedReleases: string[] = [];
    await assert.rejects(
      () => coordinator.switch(prepared, {
        checkCompatibility: async () => {},
        drain: async () => {},
        restartClient: async (_releaseDir, manifest) => { restartedReleases.push(manifest.releaseId); },
        reloadWeb: async () => {},
        waitHealthy: async (releaseDir) => path.basename(releaseDir) === "previous-release",
        restoreInitialRelease: async () => {},
      }),
      /健康检查失败/,
    );
    assert.equal(await readActivePointer(tempDir), "previous-release");
    assert.deepEqual(restartedReleases, ["new-release", "previous-release"]);
    const errorLog = await fs.readFile(path.join(tempDir, "errors.jsonl"), "utf8");
    assert.match(errorLog, /new-release/);
    assert.match(errorLog, /requestId/);
    const failure = JSON.parse(errorLog.trim()) as { errorId: string };
    const terminal = receipts.find(receipt => receipt.stage === "rolled_back");
    assert.equal(terminal?.errorId, failure.errorId);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("does not commit the previous pointer before rollback health succeeds", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  try {
    const previousPackage = await createPackage(tempDir, { releaseId: "previous-release" });
    await fs.mkdir(path.join(tempDir, "releases"), { recursive: true });
    await fs.rename(previousPackage, path.join(tempDir, "releases", "previous-release"));
    await fs.writeFile(path.join(tempDir, "active-release.json"), JSON.stringify({ releaseId: "previous-release" }), "utf8");
    const packageDir = await createPackage(tempDir, { releaseId: "new-release" });
    const coordinator = createReleaseBundleCoordinator({ rootDir: tempDir });
    const prepared = await coordinator.prepare(packageDir);
    await assert.rejects(() => coordinator.switch(prepared, {
      checkCompatibility: async () => {}, drain: async () => {}, restartClient: async () => {}, reloadWeb: async () => {},
      waitHealthy: async () => false, restoreInitialRelease: async () => {},
    }), error => error instanceof AggregateError && error.errors.some(cause => cause instanceof Error && cause.message.includes("回退绑定包健康检查失败")));
    assert.equal(await readActivePointer(tempDir), "previous-release");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("restart checks entry presence without reading resource hashes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  try {
    const coordinator = createReleaseBundleCoordinator({ rootDir: tempDir });
    const prepared = await coordinator.prepare(await createPackage(tempDir));
    const active = await coordinator.switch(prepared, {
      checkCompatibility: async () => {},
      drain: async () => {},
      restartClient: async () => {},
      reloadWeb: async () => {},
      waitHealthy: async () => true,
      restoreInitialRelease: async () => {},
    });
    assert.equal((await resolveActiveRelease(tempDir, { trustedReleaseKeys }))?.releaseDir, active.releaseDir);
    await fs.writeFile(path.join(active.releaseDir, "web", "index.html"), "tampered", "utf8");
    assert.equal((await resolveActiveRelease(tempDir, { trustedReleaseKeys }))?.releaseDir, active.releaseDir);
    await fs.rm(path.join(active.releaseDir, "web", "index.html"));
    await assert.rejects(() => resolveActiveRelease(tempDir, { trustedReleaseKeys }), /ENOENT/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("restores the installation bundle when the first update fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  try {
    let restored = false;
    const coordinator = createReleaseBundleCoordinator({ rootDir: tempDir });
    const prepared = await coordinator.prepare(await createPackage(tempDir));
    await assert.rejects(() => coordinator.switch(prepared, {
      checkCompatibility: async () => {},
      drain: async () => {},
      restartClient: async () => { throw new Error("new runtime failed"); },
      reloadWeb: async () => {},
      waitHealthy: async () => true,
      restoreInitialRelease: async () => { restored = true; },
    }), /new runtime failed/);
    assert.equal(restored, true);
    assert.equal(await readActivePointer(tempDir), null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("refuses a staged bundle whose entry disappears after preparation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  try {
    let drained = false;
    const coordinator = createReleaseBundleCoordinator({ rootDir: tempDir });
    const prepared = await coordinator.prepare(await createPackage(tempDir));
    await fs.rm(path.join(prepared.stagingDir, "client", "dist", "index.cjs"));
    await assert.rejects(() => coordinator.switch(prepared, {
      checkCompatibility: async () => {},
      drain: async () => { drained = true; },
      restartClient: async () => {},
      reloadWeb: async () => {},
      waitHealthy: async () => true,
      restoreInitialRelease: async () => {},
    }), /ENOENT/);
    assert.equal(drained, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("retries the same complete release after a failed first activation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const coordinator = createReleaseBundleCoordinator({ rootDir: root });
  const packageDir = await createPackage(root);
  const hooks = {
    checkCompatibility: async () => {},
    drain: async () => {}, restartClient: async () => {}, reloadWeb: async () => {},
    waitHealthy: async () => false, restoreInitialRelease: async () => {},
  };
  await assert.rejects(async () => coordinator.switch(await coordinator.prepare(packageDir), hooks), /健康检查失败/);
  hooks.waitHealthy = async () => true;
  const active = await coordinator.switch(await coordinator.prepare(packageDir), hooks);
  assert.equal(active.releaseId, "new-release");
  assert.equal(await readActivePointer(root), "new-release");
});

test("keeps the confirmed pointer until the new runtime and Web pass health checks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const coordinator = createReleaseBundleCoordinator({ rootDir: root });
  const prepared = await coordinator.prepare(await createPackage(root));
  await coordinator.switch(prepared, {
    checkCompatibility: async () => {},
    drain: async () => {}, restartClient: async () => {}, reloadWeb: async () => {},
    waitHealthy: async () => {
      assert.equal(await readActivePointer(root), null);
      return true;
    },
    restoreInitialRelease: async () => {},
  });
  assert.equal(await readActivePointer(root), "new-release");
});

test("validates the same portable digest for nested files and adjacent file names", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageDir = await createPackage(root);
  await fs.mkdir(path.join(packageDir, "web", "a"));
  await fs.writeFile(path.join(packageDir, "web", "a", "index.html"), "nested", "utf8");
  await fs.writeFile(path.join(packageDir, "web", "a0.js"), "adjacent", "utf8");
  const manifestPath = path.join(packageDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.webSha256 = sha256(`a/index.html\0${sha256("nested")}\na0.js\0${sha256("adjacent")}\nindex.html\0${sha256("<!doctype html><title>CodeFlow</title>")}\n`);
  manifest.packageSha256 = packageHash(manifest.webSha256, manifest.clientSha256);
  manifest.files.push({ path: "web/a/index.html", size: 6, sha256: sha256("nested") }, { path: "web/a0.js", size: 8, sha256: sha256("adjacent") });
  manifest.files.sort((left: { path: string }, right: { path: string }) => left.path < right.path ? -1 : 1);
  const { signature: _signature, ...payload } = manifest;
  await fs.writeFile(manifestPath, JSON.stringify(signReleaseBundleManifest(payload, privateKey)), "utf8");
  const prepared = await createReleaseBundleCoordinator({ rootDir: root }).prepare(packageDir);
  assert.equal(prepared.manifest.webSha256, manifest.webSha256);
});

test("compatibility failure happens before stopping the old runtime and is recorded", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const coordinator = createReleaseBundleCoordinator({ rootDir: root });
  const prepared = await coordinator.prepare(await createPackage(root));
  let drained = false;
  await assert.rejects(() => coordinator.switch(prepared, {
    checkCompatibility: async () => { throw new Error("DESKTOP_DB_SCHEMA_UPDATE_UNSUPPORTED"); },
    drain: async () => { drained = true; }, restartClient: async () => {}, reloadWeb: async () => {},
    waitHealthy: async () => true, restoreInitialRelease: async () => {},
  }), /DESKTOP_DB_SCHEMA_UPDATE_UNSUPPORTED/);
  assert.equal(drained, false);
  assert.equal(await readActivePointer(root), null);
  const log = JSON.parse((await fs.readFile(path.join(root, "errors.jsonl"), "utf8")).trim());
  assert.equal(log.phase, "compatibility");
  assert.equal(log.requestId, prepared.requestId);
});

test("failed update journals recovery and safe evidence ready for exact acknowledgement", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const coordinator = createReleaseBundleCoordinator({ rootDir: root });
  const prepared = await coordinator.prepare(await createPackage(root));
  const original = new Error("Bearer PRIVATE_TOKEN; 聊天正文; /private/workspace");
  await assert.rejects(() => coordinator.switch(prepared, {
    checkCompatibility: async () => {}, drain: async () => {}, restartClient: async () => { throw original; },
    reloadWeb: async () => {}, waitHealthy: async () => true, restoreInitialRelease: async () => {},
  }), error => error === original);
  const records = createUpdateFailureJournal(root).pending(failureContext.deviceId);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.requestId, prepared.requestId);
  assert.equal(records[0]!.phase, "restart-client");
  assert.equal(records[0]!.recovery, "restored");
  assert.equal(records[0]!.shellVersion, "1.0.0");
  assert.ok(!JSON.stringify(records).includes("PRIVATE_TOKEN"));
});

test("failed rollback is recorded once with both diagnostic causes and no false recovery", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const coordinator = createReleaseBundleCoordinator({ rootDir: root });
  const prepared = await coordinator.prepare(await createPackage(root));
  await assert.rejects(() => coordinator.switch(prepared, {
    checkCompatibility: async () => {}, drain: async () => {}, restartClient: async () => { throw Object.assign(new Error("secret"), { code: "EACCES" }); },
    reloadWeb: async () => {}, waitHealthy: async () => true,
    restoreInitialRelease: async () => { throw Object.assign(new Error("another secret"), { code: "ENOENT" }); },
  }), AggregateError);
  const [record] = createUpdateFailureJournal(root).pending(failureContext.deviceId);
  assert.equal(record!.recovery, "failed");
  assert.equal(record!.rootCause.code, "EACCES");
  assert.equal(record!.rollbackError!.code, "ENOENT");
});

test("healthy receipt failure preserves the activated pointer and does not claim rollback", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receipts: unknown[] = [];
  const coordinator = createReleaseBundleCoordinator({ rootDir: root, reportReceipt: async receipt => { receipts.push(receipt); if ((receipt as { stage: string }).stage === "healthy") throw new Error("receipt offline"); } });
  const prepared = await coordinator.prepare(await createPackage(root));
  await assert.rejects(() => coordinator.switch(prepared, {
    checkCompatibility: async () => {}, drain: async () => {}, restartClient: async () => {}, reloadWeb: async () => {}, waitHealthy: async () => true, restoreInitialRelease: async () => {},
  }), /DESKTOP_RELEASE_RECEIPT_FAILED/);
  assert.equal(await readActivePointer(root), prepared.manifest.releaseId);
  const record = createUpdateFailureJournal(root).pending(failureContext.deviceId)[0]!;
  assert.equal(record.recovery, "not_needed");
  assert.deepEqual(receipts.map(value => (value as { stage: string }).stage), ["verified", "prepared", "switched", "healthy"]);
});

test("reports switched before healthy after committing the active pointer", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receipts: string[] = [];
  const coordinator = createReleaseBundleCoordinator({ rootDir: root, reportReceipt: async receipt => { receipts.push(receipt.stage); } });
  const prepared = await coordinator.prepare(await createPackage(root));
  await coordinator.switch(prepared, {
    checkCompatibility: async () => {}, drain: async () => {}, restartClient: async () => {}, reloadWeb: async () => {}, waitHealthy: async () => true, restoreInitialRelease: async () => {},
  });
  assert.deepEqual(receipts, ["verified", "prepared", "switched", "healthy"]);
  assert.equal(await readActivePointer(root), prepared.manifest.releaseId);
});

test("active pointer read failure is journaled before any runtime side effects", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const coordinator = createReleaseBundleCoordinator({ rootDir: root });
  const prepared = await coordinator.prepare(await createPackage(root));
  await fs.writeFile(path.join(root, "active-release.json"), "{broken", "utf8");
  let drained = false;
  await assert.rejects(() => coordinator.switch(prepared, {
    checkCompatibility: async () => {}, drain: async () => { drained = true; }, restartClient: async () => {},
    reloadWeb: async () => {}, waitHealthy: async () => true, restoreInitialRelease: async () => {},
  }), SyntaxError);
  assert.equal(drained, false);
  const [record] = createUpdateFailureJournal(root).pending(failureContext.deviceId);
  assert.equal(record!.phase, "read-active");
  assert.equal(record!.rootCause.code, "INVALID_JSON");
  assert.equal(record!.recovery, "not_needed");
});

test("new bundles reject untrusted or altered signatures before staging", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-signature-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageDir = await createPackage(root);
  const untrusted = createCoordinator({ rootDir: root, trustedReleaseKeys: {}, getFailureContext: () => failureContext });
  await assert.rejects(() => untrusted.prepare(packageDir), /UNTRUSTED_KEY/);
  const manifestPath = path.join(packageDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, webVersion: "tampered" }), "utf8");
  await assert.rejects(() => createReleaseBundleCoordinator({ rootDir: root }).prepare(packageDir), /SIGNATURE_INVALID/);
  assert.equal(await readActivePointer(root), null);
});

test("new bundles enforce expiry and platform while a verified active bundle can expire offline", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-expiry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageDir = await createPackage(root, { expiresAt: "2026-10-25T00:00:00.000Z" });
  const expired = createReleaseBundleCoordinator({ rootDir: root, now: () => Date.parse("2026-10-26T00:00:00.000Z") });
  await assert.rejects(() => expired.prepare(packageDir), /EXPIRED/);
  const timely = createReleaseBundleCoordinator({ rootDir: root, now: () => Date.parse("2026-10-24T12:00:00.000Z") });
  const active = await timely.switch(await timely.prepare(packageDir), { checkCompatibility: async () => {}, drain: async () => {},
    restartClient: async () => {}, reloadWeb: async () => {}, waitHealthy: async () => true, restoreInitialRelease: async () => {} });
  assert.equal((await resolveActiveRelease(root, { trustedReleaseKeys }))?.releaseId, active.releaseId);
  await assert.rejects(() => resolveActiveRelease(root), /UNTRUSTED_KEY/);
  const other = await createPackage(root, { releaseId: "other-platform", platform: process.platform === "win32" ? "darwin" : "win32", arch: "x64" });
  await assert.rejects(() => timely.prepare(other), /PLATFORM_MISMATCH/);
});

test("expanded resources skip inventory hashes while missing entries still fail", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageDir = await createPackage(root);
  const manifestPath = path.join(packageDir, "manifest.json");
  const original = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const { signature: _signature, ...payload } = structuredClone(original);
  payload.files[0].size += 1;
  await fs.writeFile(manifestPath, JSON.stringify(signReleaseBundleManifest(payload, privateKey)), "utf8");
  const coordinator = createReleaseBundleCoordinator({ rootDir: root });
  await coordinator.prepare(packageDir);
  await fs.writeFile(manifestPath, JSON.stringify(original), "utf8");
  await fs.writeFile(path.join(packageDir, "web", "extra.js"), "extra", "utf8");
  await coordinator.prepare(packageDir);
  await fs.rm(path.join(packageDir, "web", "extra.js"));
  await fs.rm(path.join(packageDir, "client", "dist", "index.cjs"));
  await assert.rejects(() => coordinator.prepare(packageDir), /ENOENT|Client payload SHA-256|FILES_MISMATCH/);
});

test("switch rechecks a staged signature and rollback refuses a corrupted signed previous release", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-reverify-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const coordinator = createReleaseBundleCoordinator({ rootDir: root });
  const prepared = await coordinator.prepare(await createPackage(root));
  const manifestPath = path.join(prepared.stagingDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, signature: "A".repeat(86) + "==" }), "utf8");
  let drained = false;
  const hooks = { checkCompatibility: async () => {}, drain: async () => { drained = true; }, restartClient: async () => {},
    reloadWeb: async () => {}, waitHealthy: async () => true, restoreInitialRelease: async () => {} };
  await assert.rejects(() => coordinator.switch(prepared, hooks), /SIGNATURE_INVALID/);
  assert.equal(drained, false);
  const previous = await createPackage(root, { releaseId: "previous" });
  await fs.mkdir(path.join(root, "releases"), { recursive: true });
  await fs.rename(previous, path.join(root, "releases", "previous"));
  await fs.writeFile(path.join(root, "active-release.json"), JSON.stringify({ releaseId: "previous" }), "utf8");
  const previousManifestPath = path.join(root, "releases", "previous", "manifest.json");
  const previousManifest = JSON.parse(await fs.readFile(previousManifestPath, "utf8"));
  await fs.writeFile(previousManifestPath, JSON.stringify({ ...previousManifest, clientVersion: "corrupt" }), "utf8");
  const next = await coordinator.prepare(await createPackage(root, { releaseId: "next" }));
  await assert.rejects(() => coordinator.switch(next, { ...hooks, waitHealthy: async () => false }),
    (error: unknown) => error instanceof AggregateError && error.errors.some(cause => cause.message.includes("SIGNATURE_INVALID")));
});

/** 使用现签名器重签真实库存，畸形 marker 不能被库存不匹配提前掩盖。 */
async function startupProofPackage(marker?: Uint8Array) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-startup-proof-"));
  const directory = await createPackage(root, { releaseId: "fixed", expiresAt: "2026-10-25T00:00:00.000Z" });
  if (marker) await fs.writeFile(path.join(directory, DESKTOP_STARTUP_CAPABILITY_PATH), marker);
  const manifestFile = path.join(directory, "manifest.json");
  const { signature: _signature, ...payload } = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  const files = await releaseSigning.readReleaseBundleFiles(directory);
  const webSha256 = releaseSigning.computeReleaseDirectorySha256(files, "web"), clientSha256 = releaseSigning.computeReleaseDirectorySha256(files, "client");
  const manifest = signReleaseBundleManifest({ ...payload, files, webSha256, clientSha256,
    packageSha256: releaseSigning.computeReleasePackageSha256(webSha256, clientSha256) }, privateKey);
  await fs.writeFile(manifestFile, JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(directory, "baseline-release-manifest.json"), JSON.stringify(manifest), "utf8");
  return { root, directory, manifest, manifestFile };
}

/** marker 固定绑定本测试原 Client 入口，正文可以单独损坏而保持有效签名。 */
function startupMarker(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: sha256("console.log('client');"), ...overrides }), "utf8");
}

test("held active gate rejects an old signed package while ordinary offline startup still works", async () => {
  const f = await startupProofPackage();
  await fs.rm(path.join(f.directory, "baseline-release-manifest.json"));
  await fs.mkdir(path.join(f.root, "releases")); await fs.rename(f.directory, path.join(f.root, "releases", "fixed"));
  await fs.writeFile(path.join(f.root, "active-release.json"), JSON.stringify({ releaseId: "fixed" }), "utf8");
  assert.equal((await resolveActiveRelease(f.root, { trustedReleaseKeys }))?.releaseId, "fixed");
  await assert.rejects(() => resolveActiveRelease(f.root, { trustedReleaseKeys, requireHeldStartup: true }), /DESKTOP_STARTUP_CAPABILITY/u);
});

test("held payload core and fixed baseline verify the same signed inventory offline", async () => {
  const f = await startupProofPackage(startupMarker());
  assert.equal(typeof releaseSigning.verifyReleaseBundlePayload, "function");
  assert.deepEqual(await releaseSigning.verifyReleaseBundlePayload({ directory: f.directory, manifest: f.manifest, trustedKeys: trustedReleaseKeys,
    requireHeldStartup: true }), f.manifest);
  assert.equal(typeof releaseCoordinator.resolveBaselineRelease, "function");
  const baseline = await releaseCoordinator.resolveBaselineRelease(f.directory, { trustedReleaseKeys, requireHeldStartup: true });
  assert.equal(baseline.releaseDir, f.directory); assert.deepEqual(baseline.manifest, f.manifest);
  await assert.rejects(() => releaseSigning.verifyReleaseBundlePayload({ directory: f.directory, manifest: f.manifest, trustedKeys: trustedReleaseKeys,
    requireHeldStartup: true, requireFresh: true }), /EXPIRED/u);
  await assert.rejects(() => releaseCoordinator.resolveBaselineRelease(f.directory, { requireHeldStartup: true }), /UNTRUSTED_KEY/u);
  await fs.rm(path.join(f.directory, "baseline-release-manifest.json"));
  await assert.rejects(() => releaseCoordinator.resolveBaselineRelease(f.directory, { trustedReleaseKeys, requireHeldStartup: true }),
    error => error instanceof Error && (error as NodeJS.ErrnoException).code === "DESKTOP_RELEASE_BASELINE_MISSING"
      && (error.cause as NodeJS.ErrnoException)?.code === "ENOENT");
});

for (const [name, marker] of [
  ["schema", startupMarker({ schemaVersion: 2 })], ["protocol", startupMarker({ heldStartupProtocol: "1" })],
  ["extra", startupMarker({ extra: true })], ["entry binding", startupMarker({ clientEntrySha256: "f".repeat(64) })],
  ["oversize", Buffer.concat([startupMarker(), Buffer.alloc(1025, 0x20)])], ["utf8", Buffer.from([0xc3, 0x28])],
] as const) test(`held payload refuses a signed invalid marker: ${name}`, async () => {
  const f = await startupProofPackage(marker);
  assert.equal(typeof releaseSigning.verifyReleaseBundlePayload, "function");
  await assert.rejects(() => releaseSigning.verifyReleaseBundlePayload({ directory: f.directory, manifest: f.manifest, trustedKeys: trustedReleaseKeys,
    requireHeldStartup: true }));
});

test("held marker must remain a signed ordinary file and baseline proof cannot enter the active root", async () => {
  const f = await startupProofPackage(startupMarker());
  assert.equal(typeof releaseSigning.verifyReleaseBundlePayload, "function");
  const marker = path.join(f.directory, DESKTOP_STARTUP_CAPABILITY_PATH);
  await fs.writeFile(marker, startupMarker({ heldStartupProtocol: 2 }));
  await assert.rejects(() => releaseSigning.verifyReleaseBundlePayload({ directory: f.directory, manifest: f.manifest, trustedKeys: trustedReleaseKeys,
    requireHeldStartup: true }));
  await fs.rm(marker); await fs.mkdir(marker);
  await assert.rejects(() => releaseSigning.verifyReleaseBundlePayload({ directory: f.directory, manifest: f.manifest, trustedKeys: trustedReleaseKeys,
    requireHeldStartup: true }));
  await fs.rm(marker, { recursive: true }); await fs.writeFile(marker, startupMarker());
  await fs.mkdir(path.join(f.root, "releases")); await fs.rename(f.directory, path.join(f.root, "releases", "fixed"));
  await fs.writeFile(path.join(f.root, "active-release.json"), JSON.stringify({ releaseId: "fixed" }), "utf8");
  await assert.rejects(() => resolveActiveRelease(f.root, { trustedReleaseKeys, requireHeldStartup: true }), /ROOT_INVALID/u);
  await fs.rm(path.join(f.root, "releases", "fixed", "baseline-release-manifest.json"));
  assert.equal((await resolveActiveRelease(f.root, { trustedReleaseKeys, requireHeldStartup: true }))?.releaseId, "fixed");
});

test("held marker is bounded on one descriptor even when the filesystem returns short reads", async t => {
  const f = await startupProofPackage(startupMarker()), markerPath = path.join(f.directory, DESKTOP_STARTUP_CAPABILITY_PATH);
  const open = fs.open.bind(fs), readFile = fs.readFile.bind(fs);
  let opens = 0, closes = 0, reads = 0;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    assert.notEqual(String(args[0]), markerPath, "held marker must not use an unbounded path read");
    return readFile(...args);
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) !== markerPath) return handle;
    opens++;
    return new Proxy(handle, { get(target, property) {
      if (property === "read") return async (buffer: Buffer, offset: number, length: number, position: number) => {
        assert.ok(length <= 1025); reads++;
        return target.read(buffer, offset, Math.min(length, 3), position);
      };
      if (property === "close") return async () => { closes++; await target.close(); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  assert.deepEqual(await releaseSigning.verifyReleaseBundlePayload({ directory: f.directory, manifest: f.manifest, trustedKeys: trustedReleaseKeys,
    requireHeldStartup: true }), f.manifest);
  assert.equal(opens, 1); assert.equal(closes, 1); assert.ok(reads > 2);
});

for (const cause of [undefined, new Error("read failed")] as const) test(`held marker preserves read and close causes including undefined: ${String(cause)}`, async t => {
  const f = await startupProofPackage(startupMarker()), markerPath = path.join(f.directory, DESKTOP_STARTUP_CAPABILITY_PATH);
  const open = fs.open.bind(fs), cleanup = new Error("close failed");
  let closed = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) !== markerPath) return handle;
    return new Proxy(handle, { get(target, property) {
      if (property === "read") return async () => { throw cause; };
      if (property === "close") return async () => { await target.close(); closed++; throw cleanup; };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(() => releaseSigning.verifyReleaseBundlePayload({ directory: f.directory, manifest: f.manifest, trustedKeys: trustedReleaseKeys,
    requireHeldStartup: true }), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === cause && error.errors[1] === cleanup);
  assert.equal(closed, 1);
});

test("held marker close failure alone remains explicit and a changed file cannot pass", async t => {
  const f = await startupProofPackage(startupMarker()), markerPath = path.join(f.directory, DESKTOP_STARTUP_CAPABILITY_PATH);
  const open = fs.open.bind(fs), cleanup = new Error("close failed");
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) !== markerPath) return handle;
    return new Proxy(handle, { get(target, property) {
      if (property === "close") return async () => { await target.close(); throw cleanup; };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(() => releaseSigning.verifyReleaseBundlePayload({ directory: f.directory, manifest: f.manifest, trustedKeys: trustedReleaseKeys,
    requireHeldStartup: true }), error => error === cleanup);
  mocked.mock.restore();
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) !== markerPath) return handle;
    return new Proxy(handle, { get(target, property) {
      if (property === "read") return async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await target.read(buffer, offset, length, position);
        if (position === 0) await fs.appendFile(markerPath, " ", "utf8");
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(() => releaseSigning.verifyReleaseBundlePayload({ directory: f.directory, manifest: f.manifest, trustedKeys: trustedReleaseKeys,
    requireHeldStartup: true }), /CAPABILITY_FILE_INVALID/u);
});
