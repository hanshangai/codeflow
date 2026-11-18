import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { DesktopStorageLocation } from "../src/desktopStorageLocation.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { assertDesktopMaintenanceStartup, DesktopMaintenanceStartupError } from "../src/desktopMaintenanceRecord.js";
import { prepareDesktopReinstall, finishDesktopReinstall } from "../src/desktopMaintenanceRecord.js";
import * as maintenance from "../src/desktopMaintenanceRecord.js";
import { resolveDesktopStorageLocation, persistDesktopStorageLocation, completeDesktopStorageLocation,
  completeDesktopReinstallLocation, registerDesktopInstallation, assertDesktopUnregisteredStorage } from "../src/desktopStorageLocation.js";

const OLD_DEVICE = "d50fcfbe-f82a-43b9-ab7e-656af07a9a45";
const NEXT_DEVICE = "16e38f2a-0640-49b0-a871-a897e5fcae81";
const LEGACY_AUTHORIZED_PATHS = ["config.json", "codeflowai.db", "codeflowai.db.meta.json", "codeflowai.db-wal", "codeflowai.db-shm", "codeflowai.db-journal",
  "active-release.json", "previous-release.json", "releases", ".staging", "errors.jsonl", "update-receipts.jsonl", "shell-update-attempt.json", "logs", ".shell-update-file-auth"]
  .map(name => `dataDir/${name}`).concat("userDataDir/desktop-data-location.json");
const GENERATED_FILES = ["crash-reports.jsonl", "crash-session.json", "crash-session.clean.json", "crash-session.retry.json",
  "legacy-client-migration-account.json", "legacy-client-migration-journal.json"];
const PRE_UPDATE_AUTHORIZED_PATHS = [...LEGACY_AUTHORIZED_PATHS, ...GENERATED_FILES.map(name => `dataDir/${name}`), "dataDir/legacy-client-migration", "dataDir/cli-runtime"];
const UPDATE_PATHS = ["pending-release.json", "update-database-backup.json", "update-database-backups"];
const AUTHORIZED_PATHS = [...PRE_UPDATE_AUTHORIZED_PATHS, ...UPDATE_PATHS.map(name => `dataDir/${name}`)];
const REMOVAL_ROOTS = { dataDir: { dev: "1", ino: "2", birthtimeNs: "3" }, userDataDir: { dev: "1", ino: "4", birthtimeNs: "5" } };

/** 隔离记录与项目哨兵，门禁必须只读且不能创建业务目录。 */
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-d16-maintenance-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), installRoot = path.join(root, "installation"), dataDir = path.join(root, "private-data");
  await fs.mkdir(userDataDir); await fs.mkdir(installRoot);
  const project = path.join(root, "project", ".codeflow");
  await fs.mkdir(project, { recursive: true }); await fs.writeFile(path.join(project, "keep.txt"), "项目始终保留\n", "utf8");
  const location: DesktopStorageLocation = { schemaVersion: 1, appId: "ai.codeflow.codeflowai", userDataDir, installRoot, dataDir,
    clientId: null, deviceId: null };
  const filePath = path.join(userDataDir, "desktop-uninstall-result.json");
  return { root, userDataDir, location, filePath, project };
}

/** 手写固定载荷，不使用产品解析器产生测试期望。 */
function record(f: Awaited<ReturnType<typeof fixture>>, patch: Record<string, unknown> = {}) {
  return { schemaVersion: 1, appId: "ai.codeflow.codeflowai", requestId: "maintenance:original", mode: "remove", phase: "started",
    installRoot: f.location.installRoot, dataDir: f.location.dataDir, clientId: "stable-client", oldDeviceId: OLD_DEVICE, ...patch };
}

/** 写入仅测试自有记录；回读字节用于证明产品没有推进阶段或修改文件。 */
async function writeRecord(f: Awaited<ReturnType<typeof fixture>>, value: unknown): Promise<Buffer> {
  const bytes = Buffer.from(JSON.stringify(value));
  await fs.writeFile(f.filePath, bytes); return bytes;
}

/** 创建合法签名材料供原只读身份入口校验，不触真实凭据。 */
async function completeLocation(f: Awaited<ReturnType<typeof fixture>>) {
  const identity = await loadOrCreateDeviceIdentity(f.location.dataDir);
  const location = { ...f.location, clientId: "stable-client", deviceId: identity.deviceId };
  await fs.writeFile(path.join(f.userDataDir, "desktop-data-location.json"), JSON.stringify({ schemaVersion: 1,
    appId: location.appId, installRoot: location.installRoot, dataDir: location.dataDir, clientId: location.clientId, deviceId: location.deviceId }));
  return { location, identity };
}

/** 拒绝只暴露固定诊断字段，不污染主线程启动关联字段。 */
function hasCode(code: string) {
  return (error: unknown) => error instanceof DesktopMaintenanceStartupError && error.code === code;
}

/** 真实已清理固定文件与摘要，可保留旧身份供维护生产者验证。 */
async function retainedInstallation(t: test.TestContext, keepIdentity = false) {
  const f = await fixture(t), selected = await resolveDesktopStorageLocation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot, configuredDataDir: f.location.dataDir });
  await persistDesktopStorageLocation(selected);
  const old = await loadOrCreateDeviceIdentity(selected.dataDir);
  await fs.writeFile(path.join(selected.dataDir, "config.json"), JSON.stringify({ clientId: "stable-client", apiKey: "" }));
  await fs.writeFile(path.join(selected.dataDir, "codeflowai.db.meta.json"), JSON.stringify({ schemaVersion: 3, ownership: "local_os_user", storageMode: "plain_sqlite", initializationState: "ready" }));
  const db = new DatabaseSync(path.join(selected.dataDir, "codeflowai.db"));
  try { db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('client_id','stable-client')"); } finally { db.close(); }
  const location = await completeDesktopStorageLocation(selected);
  if (!keepIdentity) await fs.unlink(path.join(selected.dataDir, "device-identity.json"));
  const names = { configSha256: "config.json", databaseSha256: "codeflowai.db", metadataSha256: "codeflowai.db.meta.json" }, retainedFiles: Record<string, string> = {};
  for (const [key, file] of Object.entries(names)) retainedFiles[key] = crypto.createHash("sha256").update(await fs.readFile(path.join(selected.dataDir, file))).digest("hex");
  const value = record(f, { mode: "keep", phase: "completed", oldDeviceId: old.deviceId, nextDeviceId: NEXT_DEVICE, createdAt: "2026-10-31T00:00:00.000Z", retainedFiles });
  await writeRecord(f, value);
  return { ...f, location, value };
}

/** 维护前已使用的安装保留完整归属，记录尚未创建。 */
async function keepInstallation(t: test.TestContext) {
  const f = await retainedInstallation(t, true); await fs.unlink(f.filePath);
  return { ...f, requestId: "keep:current", mode: "keep" as const };
}

/** 查找维护身份捕获名，验证原身份只在临时专属名中短暂存在。 */
async function identityCaptures(dataDir: string): Promise<string[]> {
  return (await fs.readdir(dataDir)).filter(name => name.startsWith("device-identity.json.removing-") && name.endsWith(".tmp"))
    .map(name => path.join(dataDir, name));
}

test("remove maintenance clears a stale client lock but refuses a live one", async t => {
  const f = await keepInstallation(t), lockPath = path.join(f.location.dataDir, "client.0123456789ab.lock");
  const payload = (pid: number) => JSON.stringify({ token: crypto.randomUUID(), pid, clientId: "stable-client", dbPath: path.join(f.location.dataDir, "codeflowai.db"), startedAt: Date.now() });
  await fs.writeFile(lockPath, payload(999_999), "utf8");
  const started = await maintenance.beginDesktopMaintenance({ ...f, mode: "remove" });
  assert.equal(started.phase, "started");
  await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
  await fs.unlink(f.filePath);
  await fs.writeFile(lockPath, payload(process.pid), "utf8");
  await assert.rejects(maintenance.beginDesktopMaintenance({ ...f, mode: "remove" }));
  assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).pid, process.pid);
});

test("keep maintenance persists started before authorization and completes before F4 consumes", async t => {
  const f = await keepInstallation(t), identityPath = path.join(f.location.dataDir, "device-identity.json");
  const oldIdentity = await fs.readFile(identityPath), locator = await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"));
  const started = await maintenance.beginDesktopMaintenance(f);
  assert.equal(started.phase, "started"); assert.equal(started.oldDeviceId, f.location.deviceId);
  assert.deepEqual(JSON.parse(await fs.readFile(f.filePath, "utf8")), started);
  assert.deepEqual(await maintenance.beginDesktopMaintenance(f), started);
  const authorized = await maintenance.authorizeDesktopMaintenance(f, started);
  assert.equal(authorized.phase, "data_action_authorized"); assert.notEqual(authorized.nextDeviceId, started.oldDeviceId);
  assert.match(authorized.nextDeviceId!, /^[0-9a-f-]{36}$/u); assert.ok(authorized.retainedFiles);
  assert.deepEqual(await fs.readFile(identityPath), oldIdentity);
  assert.deepEqual(await maintenance.beginDesktopMaintenance(f), authorized);
  await maintenance.completeDesktopMaintenance(f, authorized);
  const completed: maintenance.MaintenanceRecord = JSON.parse(await fs.readFile(f.filePath, "utf8"));
  assert.deepEqual(completed, { ...authorized, phase: "completed" });
  await assert.rejects(fs.lstat(identityPath), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json")), locator);
  assert.deepEqual(await maintenance.beginDesktopMaintenance(f), completed);
  await maintenance.completeDesktopMaintenance(f, completed);
  const continuation = await prepareDesktopReinstall(f); assert.ok(continuation);
  assert.equal(continuation.authorization.nextDeviceId, authorized.nextDeviceId);
  assert.equal(await fs.readFile(path.join(f.project, "keep.txt"), "utf8"), "项目始终保留\n");
});

for (const invalid of ["request", "profile", "client", "old-device", "half-empty", "persisted-locator"] as const) {
  test(`keep maintenance rejects ${invalid} before creating a record`, async t => {
    const f = await keepInstallation(t), identityPath = path.join(f.location.dataDir, "device-identity.json"), before = await fs.readFile(identityPath);
    const input = { ...f, location: { ...f.location } };
    if (invalid === "request") input.requestId = "bad\nrequest";
    if (invalid === "profile") input.userDataDir = f.root;
    if (invalid === "client") input.location.clientId = "other-client";
    if (invalid === "old-device") input.location.deviceId = NEXT_DEVICE;
    if (invalid === "half-empty") input.location.clientId = null;
    if (invalid === "persisted-locator") await fs.unlink(path.join(f.userDataDir, "desktop-data-location.json"));
    await assert.rejects(maintenance.beginDesktopMaintenance(input));
    await assert.rejects(fs.lstat(f.filePath), { code: "ENOENT" }); assert.deepEqual(await fs.readFile(identityPath), before);
  });
}

test("keep maintenance pending request cannot be taken over or authorized from a stale record", async t => {
  const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f), before = await fs.readFile(f.filePath);
  await assert.rejects(maintenance.beginDesktopMaintenance({ ...f, requestId: "keep:other" }));
  await assert.rejects(maintenance.authorizeDesktopMaintenance(f, { ...started, requestId: "keep:other" }));
  assert.deepEqual(await fs.readFile(f.filePath), before);
  const authorized = await maintenance.authorizeDesktopMaintenance(f, started);
  await assert.rejects(maintenance.authorizeDesktopMaintenance(f, started));
  assert.deepEqual(JSON.parse(await fs.readFile(f.filePath, "utf8")), authorized);
});

for (const dirty of ["apiKey", "-wal", "-journal"] as const) {
  test(`keep maintenance cannot authorize uncleared ${dirty}`, async t => {
    const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f), before = await fs.readFile(f.filePath);
    if (dirty === "apiKey") await fs.writeFile(path.join(f.location.dataDir, "config.json"), JSON.stringify({ clientId: "stable-client", apiKey: "fixture-not-cleared" }));
    else await fs.writeFile(path.join(f.location.dataDir, `codeflowai.db${dirty}`), "not-checkpointed");
    await assert.rejects(maintenance.authorizeDesktopMaintenance(f, started));
    assert.deepEqual(await fs.readFile(f.filePath), before);
    assert.ok((await fs.lstat(path.join(f.location.dataDir, "device-identity.json"))).isFile());
  });
}

for (const operation of ["open", "writeFile", "sync", "close", "rename"] as const) {
  test(`keep maintenance authorization ${operation} failure preserves started and old identity`, async t => {
    const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f), before = await fs.readFile(f.filePath);
    const failure = new Error(`fixture authorization ${operation}`), open = fs.open;
    if (operation === "rename") t.mock.method(fs, "rename", async () => { throw failure; });
    else t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[1] !== "wx" || !String(args[0]).startsWith(f.filePath)) return open(...args);
      if (operation === "open") throw failure;
      const file = await open(...args);
      return new Proxy(file, { get(target, field) {
        if (field === operation) return async () => {
          if (operation === "close") await target.close(); throw failure;
        };
        const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    await assert.rejects(maintenance.authorizeDesktopMaintenance(f, started));
    assert.deepEqual(await fs.readFile(f.filePath), before);
    assert.ok((await fs.lstat(path.join(f.location.dataDir, "device-identity.json"))).isFile());
  });
}

test("keep maintenance start write failure creates no authorization or identity change", async t => {
  const f = await keepInstallation(t), identityPath = path.join(f.location.dataDir, "device-identity.json"), before = await fs.readFile(identityPath);
  t.mock.method(fs, "rename", async () => { throw new Error("fixture started rename"); });
  await assert.rejects(maintenance.beginDesktopMaintenance(f));
  await assert.rejects(fs.lstat(f.filePath), { code: "ENOENT" }); assert.deepEqual(await fs.readFile(identityPath), before);
});

test("keep maintenance refuses changed retained bytes before deleting identity", async t => {
  const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f);
  const authorized = await maintenance.authorizeDesktopMaintenance(f, started), before = await fs.readFile(f.filePath);
  await fs.appendFile(path.join(f.location.dataDir, "config.json"), " ");
  await assert.rejects(maintenance.completeDesktopMaintenance(f, authorized), /DESKTOP_MAINTENANCE_DIGEST_MISMATCH/u);
  assert.deepEqual(await fs.readFile(f.filePath), before);
  assert.ok((await fs.lstat(path.join(f.location.dataDir, "device-identity.json"))).isFile());
});

for (const replacement of ["next", "third"] as const) {
  test(`keep maintenance cannot delete ${replacement} identity using old authorization`, async t => {
    const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f);
    const authorized = await maintenance.authorizeDesktopMaintenance(f, started), identityPath = path.join(f.location.dataDir, "device-identity.json");
    const identity = JSON.parse(await fs.readFile(identityPath, "utf8"));
    identity.deviceId = replacement === "next" ? authorized.nextDeviceId : crypto.randomUUID();
    await fs.writeFile(identityPath, JSON.stringify(identity)); const before = await fs.readFile(identityPath);
    await assert.rejects(maintenance.completeDesktopMaintenance(f, authorized));
    assert.deepEqual(await fs.readFile(identityPath), before);
    assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "data_action_authorized");
  });
}

test("keep maintenance identity unlink failure leaves authorized and permits the same next retry", async t => {
  const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f), authorized = await maintenance.authorizeDesktopMaintenance(f, started);
  const identityPath = path.join(f.location.dataDir, "device-identity.json"), original = await fs.readFile(identityPath), unlink = fs.unlink;
  const fail = t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]).startsWith(`${identityPath}.removing-`)) throw new Error("fixture identity unlink"); return unlink(...args);
  });
  await assert.rejects(maintenance.completeDesktopMaintenance(f, authorized));
  const captures = await identityCaptures(f.location.dataDir);
  assert.deepEqual(JSON.parse(await fs.readFile(f.filePath, "utf8")), authorized); assert.equal(captures.length, 1);
  await assert.rejects(fs.lstat(identityPath), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(captures[0]!), original);
  fail.mock.restore(); await maintenance.completeDesktopMaintenance(f, authorized);
  assert.deepEqual(await identityCaptures(f.location.dataDir), []);
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).nextDeviceId, authorized.nextDeviceId);
});

test("keep maintenance completed rename failure retries missing old identity under the same authorization", async t => {
  const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f), authorized = await maintenance.authorizeDesktopMaintenance(f, started);
  const rename = fs.rename, fail = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === f.filePath) throw new Error("fixture completed rename"); return rename(...args);
  });
  await assert.rejects(maintenance.completeDesktopMaintenance(f, authorized));
  assert.deepEqual(JSON.parse(await fs.readFile(f.filePath, "utf8")), authorized);
  await assert.rejects(fs.lstat(path.join(f.location.dataDir, "device-identity.json")), { code: "ENOENT" });
  assert.deepEqual(await identityCaptures(f.location.dataDir), []);
  fail.mock.restore(); assert.deepEqual(await maintenance.beginDesktopMaintenance(f), authorized);
  await maintenance.completeDesktopMaintenance(f, authorized);
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "completed");
});

test("keep maintenance rechecks the entire retained group before authorization rename", async t => {
  const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f), before = await fs.readFile(f.filePath), open = fs.open;
  let changed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]) === path.join(f.location.dataDir, "codeflowai.db.meta.json")) return new Proxy(file, { get(target, field) {
      if (field === "read") return async (...parameters: Parameters<typeof file.read>) => {
        if (!changed) { changed = true; await fs.appendFile(path.join(f.location.dataDir, "config.json"), " "); }
        return target.read(...parameters);
      };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    return file;
  });
  await assert.rejects(maintenance.authorizeDesktopMaintenance(f, started), /DESKTOP_MAINTENANCE_FILE_CHANGED/u);
  assert.equal(changed, true); assert.deepEqual(await fs.readFile(f.filePath), before);
});

for (const action of ["begin", "complete"] as const) {
  test(`keep maintenance ${action} rejects identity restored during completed verification`, async t => {
    const f = await keepInstallation(t), identityPath = path.join(f.location.dataDir, "device-identity.json"), originalIdentity = await fs.readFile(identityPath);
    const started = await maintenance.beginDesktopMaintenance(f), authorized = await maintenance.authorizeDesktopMaintenance(f, started);
    await maintenance.completeDesktopMaintenance(f, authorized);
    const completed: maintenance.MaintenanceRecord = JSON.parse(await fs.readFile(f.filePath, "utf8")), open = fs.open;
    let restored = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]) === path.join(f.location.dataDir, "codeflowai.db.meta.json")) return new Proxy(file, { get(target, field) {
        if (field === "read") return async (...parameters: Parameters<typeof file.read>) => {
          if (!restored) { restored = true; await fs.writeFile(identityPath, originalIdentity); }
          return target.read(...parameters);
        };
        const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
      } });
      return file;
    });
    await assert.rejects(action === "begin" ? maintenance.beginDesktopMaintenance(f) : maintenance.completeDesktopMaintenance(f, completed));
    assert.equal(restored, true); assert.deepEqual(await fs.readFile(identityPath), originalIdentity);
    assert.deepEqual(JSON.parse(await fs.readFile(f.filePath, "utf8")), completed);
  });
}

test("keep maintenance may replace consumed only for a new request under the current installation", async t => {
  const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f), authorized = await maintenance.authorizeDesktopMaintenance(f, started);
  await maintenance.completeDesktopMaintenance(f, authorized);
  const continuation = await prepareDesktopReinstall(f); assert.ok(continuation);
  await loadOrCreateDeviceIdentity(f.location.dataDir, { deviceId: continuation.authorization.nextDeviceId, createdAt: continuation.authorization.createdAt });
  const location = await completeDesktopReinstallLocation(f.location, continuation.authorization);
  await finishDesktopReinstall({ userDataDir: f.userDataDir, location }, continuation);
  await assert.rejects(maintenance.beginDesktopMaintenance({ ...f, location }));
  const next = await maintenance.beginDesktopMaintenance({ ...f, location, requestId: "keep:later" });
  assert.equal(next.phase, "started"); assert.equal(next.oldDeviceId, authorized.nextDeviceId);
  assert.equal(Object.hasOwn(next, "nextDeviceId"), false); assert.equal(Object.hasOwn(next, "retainedFiles"), false);
});

for (const phase of ["data_action_authorized", "completed"] as const) {
  test(`keep maintenance ${phase} cannot be replaced by another request`, async t => {
    const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f), authorized = await maintenance.authorizeDesktopMaintenance(f, started);
    if (phase === "completed") await maintenance.completeDesktopMaintenance(f, authorized);
    const before = await fs.readFile(f.filePath);
    await assert.rejects(maintenance.beginDesktopMaintenance({ ...f, requestId: "keep:other" }));
    assert.deepEqual(await fs.readFile(f.filePath), before);
  });
}

test("keep maintenance requires authorization before touching old identity", async t => {
  const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f), identityPath = path.join(f.location.dataDir, "device-identity.json");
  const before = await fs.readFile(identityPath);
  await assert.rejects(maintenance.completeDesktopMaintenance(f, started));
  assert.deepEqual(await fs.readFile(identityPath), before);
  assert.deepEqual(JSON.parse(await fs.readFile(f.filePath, "utf8")), started);
});

test("keep maintenance rejects a previously missing WAL created while authorization is being synced", async t => {
  const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f), before = await fs.readFile(f.filePath), open = fs.open;
  let created = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[1] === "wx" && String(args[0]).startsWith(f.filePath)) return new Proxy(file, { get(target, field) {
      if (field === "sync") return async () => {
        await target.sync(); created = true; await fs.writeFile(path.join(f.location.dataDir, "codeflowai.db-wal"), "");
      };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    return file;
  });
  await assert.rejects(maintenance.authorizeDesktopMaintenance(f, started), /DESKTOP_MAINTENANCE_FILE_CHANGED/u);
  assert.equal(created, true); assert.deepEqual(await fs.readFile(f.filePath), before);
  assert.ok((await fs.lstat(path.join(f.location.dataDir, "device-identity.json"))).isFile());
});

test("keep maintenance cannot overwrite a record changed during the final old identity verification", async t => {
  const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f), open = fs.open;
  const replacement = { ...started, requestId: "keep:replacement" }; let createdTemporary = false, replaced = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[1] === "wx" && String(args[0]).startsWith(f.filePath)) createdTemporary = true;
    return file;
  });
  const read = fs.readFile;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (createdTemporary && !replaced && args[0] === path.join(f.location.dataDir, "device-identity.json")) {
      replaced = true; await fs.writeFile(f.filePath, JSON.stringify(replacement));
    }
    return read(...args);
  });
  await assert.rejects(maintenance.authorizeDesktopMaintenance(f, started), /DESKTOP_MAINTENANCE_RECORD_CHANGED/u);
  assert.equal(replaced, true); assert.deepEqual(JSON.parse(await fs.readFile(f.filePath, "utf8")), replacement);
  assert.ok((await fs.lstat(path.join(f.location.dataDir, "device-identity.json"))).isFile());
});

for (const failure of [null, undefined]) {
  test(`keep maintenance preserves primitive filesystem failure ${failure} without replacing its cause`, async t => {
    const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f), authorized = await maintenance.authorizeDesktopMaintenance(f, started);
    const stat = fs.lstat, identityPath = path.join(f.location.dataDir, "device-identity.json"), before = await fs.readFile(f.filePath);
    const aliases = new Set([identityPath, await fs.realpath(identityPath)]); let observed = 0;
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      if (aliases.has(String(args[0])) && ++observed === 3) throw failure; return stat(...args);
    });
    await assert.rejects(maintenance.completeDesktopMaintenance(f, authorized), error =>
      error instanceof DesktopMaintenanceStartupError && error.cause === failure);
    assert.deepEqual(await fs.readFile(f.filePath), before);
  });
}

test("completed keep authorizes reinstalling before fixed identity and consumes only after matching locator", async t => {
  const f = await retainedInstallation(t), continuation = await prepareDesktopReinstall(f);
  assert.ok(continuation); assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "reinstalling");
  await assert.rejects(finishDesktopReinstall(f, continuation), /DESKTOP_MAINTENANCE_OWNERSHIP_MISMATCH/u);
  await loadOrCreateDeviceIdentity(f.location.dataDir, { deviceId: NEXT_DEVICE, createdAt: "2026-10-31T00:00:00.000Z" });
  const location = await completeDesktopReinstallLocation(f.location, continuation.authorization);
  await finishDesktopReinstall({ userDataDir: f.userDataDir, location }, continuation);
  const consumed = JSON.parse(await fs.readFile(f.filePath, "utf8")); assert.equal(consumed.phase, "consumed");
  assert.equal(Object.hasOwn(consumed, "retainedFiles"), false); assert.equal(Object.hasOwn(consumed, "createdAt"), false);
  assert.equal(await prepareDesktopReinstall({ userDataDir: f.userDataDir, location }), null);
  await assertDesktopMaintenanceStartup({ userDataDir: f.userDataDir, location });
});

test("initial retained digest failure leaves completed phase and identity missing", async t => {
  const f = await retainedInstallation(t), before = await fs.readFile(f.filePath);
  await fs.appendFile(path.join(f.location.dataDir, "config.json"), " ");
  await assert.rejects(prepareDesktopReinstall(f), /DESKTOP_MAINTENANCE_DIGEST_MISMATCH/u);
  assert.deepEqual(await fs.readFile(f.filePath), before);
  await assert.rejects(fs.stat(path.join(f.location.dataDir, "device-identity.json")), { code: "ENOENT" });
});

test("reinstalling retries authorized changes without accepting a third identity", async t => {
  const f = await retainedInstallation(t), first = await prepareDesktopReinstall(f); assert.ok(first);
  await loadOrCreateDeviceIdentity(f.location.dataDir, { deviceId: NEXT_DEVICE, createdAt: "2026-10-31T00:00:00.000Z" });
  await fs.appendFile(path.join(f.location.dataDir, "config.json"), " ");
  const resumed = await prepareDesktopReinstall(f); assert.ok(resumed); assert.deepEqual(resumed.authorization, first.authorization);
  const file = path.join(f.location.dataDir, "device-identity.json"), identity = JSON.parse(await fs.readFile(file, "utf8"));
  identity.deviceId = crypto.randomUUID(); await fs.writeFile(file, JSON.stringify(identity));
  await assert.rejects(prepareDesktopReinstall(f), /DESKTOP_REINSTALL_IDENTITY_CONFLICT/u);
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "reinstalling");
});

test("reinstall phase write failure preserves completed authorization and starts no identity", async t => {
  const f = await retainedInstallation(t), before = await fs.readFile(f.filePath), failure = new Error("fixture phase rename");
  t.mock.method(fs, "rename", async () => { throw failure; });
  await assert.rejects(prepareDesktopReinstall(f), error => error instanceof DesktopMaintenanceStartupError && error.cause === failure);
  assert.deepEqual(await fs.readFile(f.filePath), before);
  await assert.rejects(fs.stat(path.join(f.location.dataDir, "device-identity.json")), { code: "ENOENT" });
});

test("consumed write failure retains reinstalling and allows the same next continuation", async t => {
  const f = await retainedInstallation(t), first = await prepareDesktopReinstall(f); assert.ok(first);
  await loadOrCreateDeviceIdentity(f.location.dataDir, { deviceId: NEXT_DEVICE, createdAt: "2026-10-31T00:00:00.000Z" });
  const location = await completeDesktopReinstallLocation(f.location, first.authorization), before = await fs.readFile(f.filePath);
  const rename = t.mock.method(fs, "rename", async () => { throw new Error("fixture consumed rename"); });
  await assert.rejects(finishDesktopReinstall({ userDataDir: f.userDataDir, location }, first));
  assert.deepEqual(await fs.readFile(f.filePath), before); rename.mock.restore();
  const resumed = await prepareDesktopReinstall({ userDataDir: f.userDataDir, location }); assert.ok(resumed);
  await finishDesktopReinstall({ userDataDir: f.userDataDir, location }, resumed);
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "consumed");
});

test("initial digest authorization refuses an earlier file changed during a later digest read", async t => {
  const f = await retainedInstallation(t), before = await fs.readFile(f.filePath), open = fs.open;
  let changed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]) === path.join(f.location.dataDir, "codeflowai.db.meta.json")) return new Proxy(file, { get(target, field) {
      if (field === "read") return async (...parameters: Parameters<typeof file.read>) => {
        if (!changed) { changed = true; await fs.appendFile(path.join(f.location.dataDir, "config.json"), " "); }
        return target.read(...parameters);
      };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    return file;
  });
  await assert.rejects(prepareDesktopReinstall(f), /DESKTOP_MAINTENANCE_FILE_CHANGED/u);
  assert.equal(changed, true); assert.deepEqual(await fs.readFile(f.filePath), before);
  await assert.rejects(fs.stat(path.join(f.location.dataDir, "device-identity.json")), { code: "ENOENT" });
});

test("missing maintenance record leaves private data and project untouched", async t => {
  const f = await fixture(t);
  await assertDesktopMaintenanceStartup(f);
  await assert.rejects(fs.lstat(f.location.dataDir), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(f.userDataDir), []);
  assert.equal(await fs.readFile(path.join(f.project, "keep.txt"), "utf8"), "项目始终保留\n");
});

for (const phase of ["started", "data_action_authorized"] as const) {
  test(`${phase} remove blocks startup without creating data or modifying the record`, async t => {
    const f = await fixture(t), bytes = await writeRecord(f, record(f, { phase,
      ...(phase === "data_action_authorized" ? { authorizedPaths: [...AUTHORIZED_PATHS].reverse(), removalRoots: REMOVAL_ROOTS } : {}) }));
    await assert.rejects(assertDesktopMaintenanceStartup(f), error => {
      assert.ok(error instanceof DesktopMaintenanceStartupError);
      assert.equal(error.code, "DESKTOP_MAINTENANCE_PENDING");
      assert.deepEqual({ maintenanceRequestId: error.maintenanceRequestId, clientId: error.clientId, oldDeviceId: error.oldDeviceId,
        mode: error.mode, maintenancePhase: error.maintenancePhase }, { maintenanceRequestId: "maintenance:original", clientId: "stable-client",
        oldDeviceId: OLD_DEVICE, mode: "remove", maintenancePhase: phase });
      assert.equal(Object.hasOwn(error, "requestId"), false); assert.equal(Object.hasOwn(error, "phase"), false);
      return true;
    });
    assert.deepEqual(await fs.readFile(f.filePath), bytes);
    await assert.rejects(fs.lstat(f.location.dataDir), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(f.project, "keep.txt"), "utf8"), "项目始终保留\n");
  });
}

test("started keep is pending before any next identity is authorized", async t => {
  const f = await fixture(t); await writeRecord(f, record(f, { mode: "keep" }));
  await assert.rejects(assertDesktopMaintenanceStartup(f), hasCode("DESKTOP_MAINTENANCE_PENDING"));
});

for (const phase of ["data_action_authorized", "completed", "reinstalling"] as const) {
  test(`${phase} keep reports unavailable continuation and preserves retained data`, async t => {
    const f = await fixture(t);
    await fs.mkdir(f.location.dataDir); await fs.writeFile(path.join(f.location.dataDir, "codeflowai.db"), "retained-history");
    const bytes = await writeRecord(f, record(f, { mode: "keep", phase, nextDeviceId: NEXT_DEVICE, createdAt: "2026-10-31T00:00:00.000Z" }));
    await assert.rejects(assertDesktopMaintenanceStartup(f), hasCode("DESKTOP_MAINTENANCE_REINSTALL_NOT_READY"));
    assert.deepEqual(await fs.readFile(f.filePath), bytes);
    assert.equal(await fs.readFile(path.join(f.location.dataDir, "codeflowai.db"), "utf8"), "retained-history");
    await assert.rejects(fs.lstat(path.join(f.location.dataDir, "device-identity.json")), { code: "ENOENT" });
  });
}

test("completed remove only permits the existing normal startup gate and never deletes retained evidence", async t => {
  const f = await fixture(t); await fs.mkdir(f.location.dataDir);
  const retained = path.join(f.location.dataDir, "config.json"); await fs.writeFile(retained, "retained-private-data");
  const bytes = await writeRecord(f, record(f, { phase: "completed" }));
  await assertDesktopMaintenanceStartup(f);
  assert.equal(await fs.readFile(retained, "utf8"), "retained-private-data"); assert.deepEqual(await fs.readFile(f.filePath), bytes);
  await assert.rejects(fs.lstat(path.join(f.location.dataDir, "device-identity.json")), { code: "ENOENT" });
});

test("completed remove diagnosis does not bind a later installation to the deleted identity", async t => {
  const f = await fixture(t), { location } = await completeLocation(f);
  await writeRecord(f, record(f, { phase: "completed", clientId: "removed-client" }));
  await assertDesktopMaintenanceStartup({ userDataDir: f.userDataDir, location });
});

test("consumed keep accepts only the exact persisted next installation without writing identity or record", async t => {
  const f = await fixture(t), { location, identity } = await completeLocation(f);
  const identityPath = path.join(location.dataDir, "device-identity.json"), before = await fs.readFile(identityPath);
  const bytes = await writeRecord(f, record(f, { mode: "keep", phase: "consumed", nextDeviceId: identity.deviceId }));
  await assertDesktopMaintenanceStartup({ userDataDir: f.userDataDir, location });
  assert.deepEqual(await fs.readFile(identityPath), before); assert.deepEqual(await fs.readFile(f.filePath), bytes);
});

for (const mismatch of ["empty-locator", "client", "device", "identity", "missing-identity", "legacy-identity"] as const) {
  test(`consumed keep refuses ${mismatch} instead of creating or accepting another identity`, async t => {
    const f = await fixture(t), { location, identity } = await completeLocation(f);
    await writeRecord(f, record(f, { mode: "keep", phase: "consumed", nextDeviceId: identity.deviceId }));
    let candidate = location;
    if (mismatch === "empty-locator") candidate = { ...location, clientId: null, deviceId: null } as unknown as typeof location;
    if (mismatch === "client") candidate = { ...location, clientId: "other-client" };
    if (mismatch === "device") candidate = { ...location, deviceId: NEXT_DEVICE };
    const identityPath = path.join(location.dataDir, "device-identity.json");
    if (mismatch === "identity") {
      const stored = JSON.parse(await fs.readFile(identityPath, "utf8")); stored.deviceId = NEXT_DEVICE;
      await fs.writeFile(identityPath, JSON.stringify(stored));
    }
    if (mismatch === "missing-identity") await fs.unlink(identityPath);
    if (mismatch === "legacy-identity") await fs.writeFile(identityPath, JSON.stringify({ deviceId: identity.deviceId, createdAt: identity.createdAt }));
    const existing = mismatch === "missing-identity" ? null : await fs.readFile(identityPath);
    await assert.rejects(assertDesktopMaintenanceStartup({ userDataDir: f.userDataDir, location: candidate }),
      error => error instanceof DesktopMaintenanceStartupError);
    if (existing) assert.deepEqual(await fs.readFile(identityPath), existing);
    else await assert.rejects(fs.lstat(identityPath), { code: "ENOENT" });
  });
}

for (const patch of [
  { schemaVersion: 2 }, { appId: "other.app" }, { requestId: "unsafe\nrequest" }, { mode: "repair" }, { phase: "unknown" },
  { oldDeviceId: "not-a-device" }, { clientId: "" }, { clientId: null }, { extra: "private-record-value" },
  { phase: "consumed" }, { phase: "reinstalling" }, { nextDeviceId: NEXT_DEVICE },
]) {
  test(`malformed maintenance shape rejects ${JSON.stringify(patch)} without echoing payload`, async t => {
    const f = await fixture(t); await writeRecord(f, record(f, patch));
    await assert.rejects(assertDesktopMaintenanceStartup(f), error => {
      assert.ok(hasCode("DESKTOP_MAINTENANCE_RECORD_INVALID")(error));
      assert.doesNotMatch(String(error) + JSON.stringify(error), /private-record-value|unsafe\nrequest/u);
      return true;
    });
  });
}

for (const authorizedPaths of [[], ["config.json"], [...AUTHORIZED_PATHS, "config.json"], [...AUTHORIZED_PATHS, "../project"],
  ["config.json", "codeflowai.db", "/absolute-path"], "config.json"]) {
  test(`remove authorization rejects missing, repeated or external targets ${JSON.stringify(authorizedPaths)}`, async t => {
    const f = await fixture(t); await writeRecord(f, record(f, { phase: "data_action_authorized", authorizedPaths }));
    await assert.rejects(assertDesktopMaintenanceStartup(f), hasCode("DESKTOP_MAINTENANCE_RECORD_INVALID"));
  });
}

for (const patch of [{ nextDeviceId: OLD_DEVICE }, { nextDeviceId: "invalid" }, { createdAt: "2026-10-31" },
  { createdAt: "2026-10-31T00:00:00Z" }, { digests: { database: "unconfirmed-future-shape" } }]) {
  test(`keep continuation rejects unsupported next identity or payload ${JSON.stringify(patch)}`, async t => {
    const f = await fixture(t); await writeRecord(f, record(f, { mode: "keep", phase: "completed", nextDeviceId: NEXT_DEVICE,
      createdAt: "2026-10-31T00:00:00.000Z", ...patch }));
    await assert.rejects(assertDesktopMaintenanceStartup(f), hasCode("DESKTOP_MAINTENANCE_RECORD_INVALID"));
  });
}

for (const field of ["installRoot", "dataDir"] as const) {
  test(`maintenance ${field} cannot redirect the selected installation`, async t => {
    const f = await fixture(t); await writeRecord(f, record(f, { [field]: path.join(f.root, "unrelated") }));
    await assert.rejects(assertDesktopMaintenanceStartup(f), hasCode("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH"));
    await assert.rejects(fs.lstat(path.join(f.root, "unrelated")), { code: "ENOENT" });
  });
}

test("maintenance profile mismatch rejects before reading another profile", async t => {
  const f = await fixture(t);
  await assert.rejects(assertDesktopMaintenanceStartup({ userDataDir: path.join(f.root, "different-profile"), location: f.location }),
    hasCode("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH"));
});

for (const content of [Buffer.from("{broken"), Buffer.from([0xc3, 0x28]), Buffer.from("[]"), Buffer.from("null")]) {
  test(`invalid maintenance JSON fails explicitly (${content.toString("hex")})`, async t => {
    const f = await fixture(t); await fs.writeFile(f.filePath, content);
    await assert.rejects(assertDesktopMaintenanceStartup(f), error => error instanceof DesktopMaintenanceStartupError);
    assert.deepEqual(await fs.readFile(f.filePath), content);
  });
}

test("record hard links are refused and both names remain unchanged", async t => {
  const f = await fixture(t), bytes = await writeRecord(f, record(f));
  const alias = path.join(f.root, "record-alias.json"); await fs.link(f.filePath, alias);
  await assert.rejects(assertDesktopMaintenanceStartup(f), error => error instanceof DesktopMaintenanceStartupError);
  assert.deepEqual(await fs.readFile(f.filePath), bytes); assert.deepEqual(await fs.readFile(alias), bytes);
});

test("consumed record cannot turn pending while the existing identity is being verified", async t => {
  const f = await fixture(t), { location, identity } = await completeLocation(f);
  await writeRecord(f, record(f, { mode: "keep", phase: "consumed", nextDeviceId: identity.deviceId }));
  const pending = record(f), original = fs.readFile;
  let replaced = false;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (!replaced && args[0] === path.join(location.dataDir, "device-identity.json")) {
      replaced = true; await fs.writeFile(f.filePath, JSON.stringify(pending));
    }
    return await original(...args);
  });
  await assert.rejects(assertDesktopMaintenanceStartup({ userDataDir: f.userDataDir, location }),
    hasCode("DESKTOP_MAINTENANCE_RECORD_CHANGED"));
  assert.deepEqual(JSON.parse(await fs.readFile(f.filePath, "utf8")), pending);
});

test("a junction in the retained data path is refused without entering its target", async t => {
  const f = await fixture(t), target = path.join(f.root, "external-target"); await fs.mkdir(target);
  await fs.symlink(target, f.location.dataDir, "junction"); await writeRecord(f, record(f));
  await assert.rejects(assertDesktopMaintenanceStartup(f), error => error instanceof DesktopMaintenanceStartupError);
  assert.deepEqual(await fs.readdir(target), []);
});

/** 动态断言新增业务入口存在，RED 不依赖静态导入失败。 */
function removalApi() {
  const api = maintenance as unknown as Record<string, unknown>;
  for (const name of ["beginDesktopMaintenance", "authorizeDesktopMaintenance", "completeDesktopMaintenance", "readDesktopMaintenanceStartup"]) {
    assert.equal(typeof api[name], "function", `remove maintenance capability missing: ${name}`);
  }
  return maintenance;
}

for (const mode of ["keep", "remove"] as const) for (const phase of ["started", "data_action_authorized", "completed"] as const) {
  test(`explicit maintenance resume reuses the original ${mode} ${phase} request without writing it`, async t => {
    const f = await keepInstallation(t), input = { ...f, mode };
    const started = await maintenance.beginDesktopMaintenance(input);
    const current = phase === "started" ? started : await maintenance.authorizeDesktopMaintenance(input, started);
    if (phase === "completed") await maintenance.completeDesktopMaintenance(input, current);
    const before = await fs.readFile(f.filePath);
    const resumed = await maintenance.readDesktopMaintenanceStartup({ userDataDir: f.userDataDir, installRoot: f.location.installRoot,
      requestId: "nsis:new-request", mode, ...{ resumePending: true } });
    assert.ok(resumed); assert.equal(resumed.record.requestId, f.requestId); assert.equal(resumed.record.phase, phase);
    assert.equal(resumed.kind, mode === "remove" && phase === "completed" ? "completed" : mode === "remove" && phase === "data_action_authorized" ? "authorized" : "pending");
    assert.deepEqual(await fs.readFile(f.filePath), before);
  });
}

for (const variant of ["mode", "install-root", "reinstalling"] as const) {
  test(`explicit maintenance resume refuses changed ${variant} without rewriting the original record`, async t => {
    const f = variant === "reinstalling" ? await retainedInstallation(t) : await keepInstallation(t);
    if (variant === "reinstalling") await prepareDesktopReinstall({ userDataDir: f.userDataDir, location: f.location });
    else await maintenance.beginDesktopMaintenance({ ...f, requestId: "keep:current", mode: "keep" });
    const before = await fs.readFile(f.filePath);
    await assert.rejects(maintenance.readDesktopMaintenanceStartup({ userDataDir: f.userDataDir,
      installRoot: variant === "install-root" ? path.join(f.root, "other-install") : f.location.installRoot,
      requestId: "nsis:new-request", mode: variant === "mode" ? "remove" : "keep", ...{ resumePending: true } }));
    assert.deepEqual(await fs.readFile(f.filePath), before);
  });
}

test("explicit maintenance resume treats completed removal with a new locator as history", async t => {
  const f = await keepInstallation(t), input = { ...f, mode: "remove" as const };
  const started = await maintenance.beginDesktopMaintenance(input), authorized = await maintenance.authorizeDesktopMaintenance(input, started);
  await maintenance.completeDesktopMaintenance(input, authorized);
  await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot,
    beforePersist: location => assertDesktopMaintenanceStartup({ userDataDir: f.userDataDir, location }) });
  const before = await fs.readFile(f.filePath);
  assert.equal(await maintenance.readDesktopMaintenanceStartup({ userDataDir: f.userDataDir, installRoot: f.location.installRoot,
    requestId: "nsis:new-request", mode: "keep", ...{ resumePending: true } }), null);
  assert.deepEqual(await fs.readFile(f.filePath), before);
});

test("explicit maintenance resume refuses a locator created during its final completed-record read", async t => {
  const f = await keepInstallation(t), input = { ...f, mode: "remove" as const };
  const started = await maintenance.beginDesktopMaintenance(input), authorized = await maintenance.authorizeDesktopMaintenance(input, started);
  await maintenance.completeDesktopMaintenance(input, authorized);
  const before = await fs.readFile(f.filePath), open = fs.open; let reads = 0, injected = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); if (String(args[0]) !== f.filePath) return file;
    return new Proxy(file, { get(target, field) {
      if (field === "close") return async () => { await target.close(); if (++reads === 2) {
        await fs.writeFile(path.join(f.userDataDir, "desktop-data-location.json"), "{}"); injected = true;
      } };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(maintenance.readDesktopMaintenanceStartup({ userDataDir: f.userDataDir, installRoot: f.location.installRoot,
    requestId: "nsis:reopened", mode: "remove", ...{ resumePending: true } }));
  assert.equal(injected, true); assert.deepEqual(await fs.readFile(f.filePath), before);
});

for (const mode of ["keep", "remove"] as const) {
  test(`explicit maintenance resume preserves empty ${mode} authorization without a locator`, async t => {
    const f = await fixture(t), location = await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot });
    const input = { userDataDir: f.userDataDir, location, requestId: `empty:${mode}`, mode };
    const started = await maintenance.beginDesktopMaintenance(input), authorized = await maintenance.authorizeDesktopMaintenance(input, started);
    await fs.unlink(path.join(f.userDataDir, "desktop-data-location.json"));
    const resumed = await maintenance.readDesktopMaintenanceStartup({ userDataDir: f.userDataDir, installRoot: location.installRoot,
      requestId: "nsis:reopened", mode, ...{ resumePending: true } });
    assert.equal(resumed?.kind, "authorized"); assert.deepEqual(resumed?.record, authorized);
    if (resumed?.kind !== "authorized") throw new Error("EXPECTED_ORIGINAL_AUTHORIZATION");
    assert.deepEqual(resumed.location, location);
    await maintenance.completeDesktopMaintenance(input, resumed.record);
    assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "completed");
  });
}

test("explicit maintenance resume never reuses a consumed request", async t => {
  const f = await retainedInstallation(t), continuation = await prepareDesktopReinstall({ userDataDir: f.userDataDir, location: f.location });
  assert.ok(continuation);
  await loadOrCreateDeviceIdentity(f.location.dataDir, { deviceId: continuation.authorization.nextDeviceId, createdAt: continuation.authorization.createdAt });
  const current = await completeDesktopReinstallLocation(f.location, continuation.authorization);
  await finishDesktopReinstall({ userDataDir: f.userDataDir, location: current }, continuation);
  const before = await fs.readFile(f.filePath);
  assert.equal(await maintenance.readDesktopMaintenanceStartup({ userDataDir: f.userDataDir, installRoot: f.location.installRoot,
    requestId: "nsis:reopened", mode: "remove", ...{ resumePending: true } }), null);
  assert.deepEqual(await fs.readFile(f.filePath), before);
});

/** 私有目标逐项写入哨兵；项目和相邻目录始终不属于删除范围。 */
async function removeInstallation(t: test.TestContext) {
  const f = await keepInstallation(t), api = removalApi();
  for (const name of ["active-release.json", "previous-release.json", "errors.jsonl", "update-receipts.jsonl", "shell-update-attempt.json"]) {
    await fs.writeFile(path.join(f.location.dataDir, name), `private ${name}`);
  }
  for (const name of ["releases", ".staging", "logs"]) {
    await fs.mkdir(path.join(f.location.dataDir, name, "nested"), { recursive: true });
    await fs.writeFile(path.join(f.location.dataDir, name, "nested", "private.txt"), "private nested bytes");
  }
  await fs.mkdir(path.join(f.location.dataDir, ".shell-update-file-auth"));
  await fs.writeFile(path.join(f.location.dataDir, ".shell-update-file-auth", "key"), Buffer.alloc(32, 7));
  await fs.writeFile(path.join(f.root, "neighbor.txt"), "external retained bytes");
  return { ...f, api, mode: "remove" as const, requestId: "remove:current" };
}

test("remove persists fixed authorization then deletes private targets locator and identity before compressed completed", async t => {
  const f = await removeInstallation(t), identityPath = path.join(f.location.dataDir, "device-identity.json"), identity = await fs.readFile(identityPath);
  const started = await f.api.beginDesktopMaintenance(f);
  assert.equal(started.mode, "remove"); assert.equal(started.phase, "started");
  const authorized = await f.api.authorizeDesktopMaintenance(f, started);
  assert.deepEqual([...authorized.authorizedPaths!].sort(), [...AUTHORIZED_PATHS].sort());
  assert.ok(authorized.removalRoots); assert.equal(authorized.nextDeviceId, undefined); assert.equal(authorized.retainedFiles, undefined);
  assert.deepEqual(await fs.readFile(identityPath), identity);
  await f.api.completeDesktopMaintenance(f, authorized);
  const completed = JSON.parse(await fs.readFile(f.filePath, "utf8"));
  assert.deepEqual(completed, { ...started, phase: "completed" as const });
  assert.deepEqual(await fs.readdir(f.location.dataDir), []);
  assert.deepEqual(await fs.readdir(f.userDataDir), ["desktop-uninstall-result.json"]);
  assert.equal(await fs.readFile(path.join(f.project, "keep.txt"), "utf8"), "项目始终保留\n");
  assert.equal(await fs.readFile(path.join(f.root, "neighbor.txt"), "utf8"), "external retained bytes");
  await f.api.completeDesktopMaintenance(f, completed);
  const restored = await f.api.readDesktopMaintenanceStartup({ mode: "remove", userDataDir: f.userDataDir, installRoot: f.location.installRoot, requestId: f.requestId });
  assert.equal(restored?.kind, "completed");
});

test("remove cleans generated crash and migration files while retaining the default workspace", async t => {
  const f = await removeInstallation(t), workspace = path.join(f.location.dataDir, "workspace");
  const retiredAttempt = `shell-update-retired-${crypto.randomUUID()}.json`;
  const retiredInstallationAttempt = `shell-update-retired-install-nsis-install-test-${crypto.randomUUID()}.json`;
  const retiredInstallationAttemptLegacy = "shell-update-retired-install-nsis-install-legacy.json";
  await fs.writeFile(path.join(f.location.dataDir, retiredAttempt), "retired update evidence");
  await fs.writeFile(path.join(f.location.dataDir, retiredInstallationAttempt), "retired installation evidence");
  await fs.writeFile(path.join(f.location.dataDir, retiredInstallationAttemptLegacy), "legacy installer evidence");
  await fs.mkdir(path.join(workspace, ".codeflow"), { recursive: true });
  await fs.writeFile(path.join(workspace, "project.txt"), "retained project");
  await fs.writeFile(path.join(workspace, ".codeflow/workspace.db"), "retained workspace history");
  await fs.mkdir(path.join(f.location.dataDir, "logs"), { recursive: true });
  await fs.writeFile(path.join(f.location.dataDir, "logs", "shell-update-retired-install-nsis-install-test-archive.json"), "old update evidence");
  for (const name of GENERATED_FILES) await fs.writeFile(path.join(f.location.dataDir, name), "generated data");
  await fs.mkdir(path.join(f.location.dataDir, "legacy-client-migration", "snapshot"), { recursive: true });
  await fs.writeFile(path.join(f.location.dataDir, "legacy-client-migration/snapshot/source.db"), "archived private data");
  const started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  assert.ok(authorized.authorizedPaths!.includes(`dataDir/${retiredAttempt}`));
  assert.ok(authorized.authorizedPaths!.includes(`dataDir/${retiredInstallationAttempt}`));
  assert.ok(authorized.authorizedPaths!.includes(`dataDir/${retiredInstallationAttemptLegacy}`));
  await f.api.completeDesktopMaintenance(f, authorized);
  assert.deepEqual(await fs.readdir(f.location.dataDir), ["workspace"]);
  assert.equal(await fs.readFile(path.join(workspace, "project.txt"), "utf8"), "retained project");
  assert.equal(await fs.readFile(path.join(workspace, ".codeflow/workspace.db"), "utf8"), "retained workspace history");
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "completed");
  const next = await resolveDesktopStorageLocation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot,
    configuredDataDir: f.location.dataDir });
  await assertDesktopMaintenanceStartup({ userDataDir: f.userDataDir, location: next });
  await persistDesktopStorageLocation(next);
  assert.equal(next.clientId, null);
  assert.equal(await fs.readFile(path.join(workspace, "project.txt"), "utf8"), "retained project");
});

test("remove cleans prepared release records and fixed database backup trees while preserving projects", async t => {
  const f = await removeInstallation(t), workspace = path.join(f.location.dataDir, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "source.ts"), "project source", "utf8");
  await fs.writeFile(path.join(f.location.dataDir, "pending-release.json"), "pending release", "utf8");
  await fs.writeFile(path.join(f.location.dataDir, "update-database-backup.json"), "backup metadata", "utf8");
  const snapshots = path.join(f.location.dataDir, "update-database-backups", ".update-db-owned");
  await fs.mkdir(snapshots, { recursive: true });
  await fs.writeFile(path.join(snapshots, "0.snapshot"), "private database", "utf8");
  const started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  assert.ok(UPDATE_PATHS.every(name => authorized.authorizedPaths!.includes(`dataDir/${name}`)));
  await f.api.completeDesktopMaintenance(f, authorized);
  assert.deepEqual(await fs.readdir(f.location.dataDir), ["workspace"]);
  assert.equal(await fs.readFile(path.join(workspace, "source.ts"), "utf8"), "project source");
  assert.equal(await fs.readFile(path.join(f.project, "keep.txt"), "utf8"), "项目始终保留\n");
});

for (const paths of [PRE_UPDATE_AUTHORIZED_PATHS, PRE_UPDATE_AUTHORIZED_PATHS.filter(name => name !== "dataDir/cli-runtime"), LEGACY_AUTHORIZED_PATHS]) {
  test(`historical remove authorization with ${paths.length} paths keeps its exact pre-update scope`, async t => {
    const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f);
    const authorized = await f.api.authorizeDesktopMaintenance(f, started);
    await writeRecord(f, { ...authorized, authorizedPaths: paths });
    const resumed = await f.api.beginDesktopMaintenance(f);
    assert.deepEqual(resumed.authorizedPaths, paths);
    await f.api.completeDesktopMaintenance(f, resumed);
    assert.deepEqual(await fs.readdir(f.location.dataDir), []);
  });
}

for (const name of UPDATE_PATHS) test(`pre-update remove authorization cannot delete the newly owned ${name}`, async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f);
  const authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const previous = { ...authorized, authorizedPaths: PRE_UPDATE_AUTHORIZED_PATHS };
  const recordBytes = await writeRecord(f, previous), database = await fs.readFile(path.join(f.location.dataDir, "codeflowai.db"));
  const target = path.join(f.location.dataDir, name);
  if (name === "update-database-backups") await fs.mkdir(target); else await fs.writeFile(target, "new update fact", "utf8");
  await assert.rejects(f.api.beginDesktopMaintenance(f));
  await assert.rejects(f.api.completeDesktopMaintenance(f, previous));
  assert.deepEqual(await fs.readFile(f.filePath), recordBytes);
  assert.deepEqual(await fs.readFile(path.join(f.location.dataDir, "codeflowai.db")), database);
  assert.ok(await fs.lstat(target));
});

for (const target of ["update-database-backups", "update-database-backups/.update-db-link"]) {
  test(`remove refuses a junction in ${target} without entering project data`, async t => {
    const f = await removeInstallation(t), destination = path.join(f.location.dataDir, target);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.symlink(f.project, destination, "junction");
    const database = await fs.readFile(path.join(f.location.dataDir, "codeflowai.db"));
    const started = await f.api.beginDesktopMaintenance(f);
    await assert.rejects(f.api.authorizeDesktopMaintenance(f, started));
    assert.deepEqual(await fs.readFile(path.join(f.location.dataDir, "codeflowai.db")), database);
    assert.equal(await fs.readFile(path.join(f.project, "keep.txt"), "utf8"), "项目始终保留\n");
  });
}

test("remove clears owned private CLI runtime while preserving projects", async t => {
  const f = await removeInstallation(t), runtime = path.join(f.location.dataDir, "cli-runtime", "codex");
  await fs.mkdir(runtime, { recursive: true }); await fs.writeFile(path.join(runtime, "runtime.json"), "owned runtime");
  const started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  await f.api.completeDesktopMaintenance(f, authorized);
  assert.deepEqual(await fs.readdir(f.location.dataDir), []);
  assert.equal(await fs.readFile(path.join(f.project, "keep.txt"), "utf8"), "项目始终保留\n");
});

test("remove refuses a CLI runtime junction without deleting its target or private data", async t => {
  const f = await removeInstallation(t), db = path.join(f.location.dataDir, "codeflowai.db"), before = await fs.readFile(db);
  await fs.symlink(f.project, path.join(f.location.dataDir, "cli-runtime"), "junction");
  const started = await f.api.beginDesktopMaintenance(f);
  await assert.rejects(f.api.authorizeDesktopMaintenance(f, started));
  assert.deepEqual(await fs.readFile(db), before);
  assert.equal(await fs.readFile(path.join(f.project, "keep.txt"), "utf8"), "项目始终保留\n");
});

test("previous generated-file authorization cannot delete a newly introduced CLI runtime", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const previous = PRE_UPDATE_AUTHORIZED_PATHS.filter(name => name !== "dataDir/cli-runtime");
  await writeRecord(f, { ...authorized, authorizedPaths: previous });
  await fs.mkdir(path.join(f.location.dataDir, "cli-runtime"));
  await assert.rejects(f.api.beginDesktopMaintenance(f));
  assert.equal((await fs.stat(path.join(f.location.dataDir, "codeflowai.db"))).isFile(), true);
});

for (const mode of ["keep", "remove"] as const) test(`same-root repair preserves an unfinished ${mode} record and original identity`, async t => {
  const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance({ ...f, mode });
  const before = await fs.readFile(f.filePath), identity = await fs.readFile(path.join(f.location.dataDir, "device-identity.json"));
  assert.deepEqual(await maintenance.rebindDesktopKeepInstallation({ ...f, installRoot: f.location.installRoot }), f.location);
  assert.deepEqual(await fs.readFile(f.filePath), before);
  assert.deepEqual(await fs.readFile(path.join(f.location.dataDir, "device-identity.json")), identity);
  await assert.rejects(maintenance.rebindDesktopKeepInstallation({ ...f, installRoot: path.join(f.root, "other-install") }));
  await assert.rejects(assertDesktopMaintenanceStartup(f));
  assert.equal(started.phase, "started");
});

test("remove resumes the previous fixed authorization without extending its deletion scope", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f);
  const authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const previous = { ...authorized, authorizedPaths: LEGACY_AUTHORIZED_PATHS };
  await writeRecord(f, previous);
  const resumed = await f.api.beginDesktopMaintenance(f);
  assert.deepEqual(resumed.authorizedPaths, LEGACY_AUTHORIZED_PATHS);
  await f.api.completeDesktopMaintenance(f, resumed);
  assert.deepEqual(await fs.readdir(f.location.dataDir), []);
});

test("previous remove authorization refuses newly introduced crash files before deleting data", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f);
  const authorized = await f.api.authorizeDesktopMaintenance(f, started);
  await writeRecord(f, { ...authorized, authorizedPaths: LEGACY_AUTHORIZED_PATHS });
  const crash = path.join(f.location.dataDir, "crash-session.json"), db = path.join(f.location.dataDir, "codeflowai.db");
  await fs.writeFile(crash, "new session"); const before = await fs.readFile(db);
  await assert.rejects(f.api.beginDesktopMaintenance(f));
  assert.deepEqual(await fs.readFile(db), before); assert.equal(await fs.readFile(crash, "utf8"), "new session");
});

test("remove refuses a linked default workspace without deleting private or project data", async t => {
  const f = await removeInstallation(t), db = path.join(f.location.dataDir, "codeflowai.db"), before = await fs.readFile(db);
  await fs.symlink(path.dirname(f.project), path.join(f.location.dataDir, "workspace"), "junction");
  const started = await f.api.beginDesktopMaintenance(f);
  await assert.rejects(f.api.authorizeDesktopMaintenance(f, started));
  assert.deepEqual(await fs.readFile(db), before);
  assert.equal(await fs.readFile(path.join(f.project, "keep.txt"), "utf8"), "项目始终保留\n");
});

for (const stage of ["locator", "final-record"] as const) test(`remove rejects a replaced retained workspace during ${stage} completion`, async t => {
  const f = await removeInstallation(t), workspace = path.join(f.location.dataDir, "workspace"), retained = path.join(f.root, "retained-workspace");
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, "project.txt"), "original project");
  const started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  let injected = false, completedWritten = false, reads = 0;
  /** 在真实文件边界替换保留目录，旧目录和替换目录都不能进入删除集合。 */
  const replaceWorkspace = async (): Promise<void> => {
    await fs.rename(workspace, retained); await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "replacement.txt"), "replacement project"); injected = true;
  };
  if (stage === "locator") {
    const unlink = fs.unlink;
    t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
      await unlink(...args);
      if (String(args[0]).startsWith(path.join(f.userDataDir, "desktop-data-location.json.removing-"))) await replaceWorkspace();
    });
  } else {
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]) === f.filePath && completedWritten && ++reads === 2) await replaceWorkspace();
      if (!String(args[0]).startsWith(`${f.filePath}.`)) return file;
      return new Proxy(file, { get(target, field) {
        if (field === "writeFile") return async (...values: Parameters<typeof target.writeFile>) => {
          completedWritten = JSON.parse(String(values[0])).phase === "completed"; return target.writeFile(...values);
        };
        const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    });
  }
  await assert.rejects(f.api.completeDesktopMaintenance(f, authorized), hasCode("DESKTOP_REMOVE_MAINTENANCE_FAILED"));
  assert.equal(injected, true); assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "data_action_authorized");
  assert.equal(await fs.readFile(path.join(retained, "project.txt"), "utf8"), "original project");
  assert.equal(await fs.readFile(path.join(workspace, "replacement.txt"), "utf8"), "replacement project");
  if (stage === "locator") assert.equal((JSON.parse(await fs.readFile(path.join(f.location.dataDir, "device-identity.json"), "utf8"))).deviceId, f.location.deviceId);
});

for (const operation of ["open", "writeFile", "sync", "close", "rename"] as const)
test(`remove authorization ${operation} failure leaves started and all private bytes`, async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), open = fs.open, rename = fs.rename;
  const before = await fs.readFile(path.join(f.location.dataDir, "codeflowai.db")), identity = await fs.readFile(path.join(f.location.dataDir, "device-identity.json"));
  const failure = new Error(`fixture remove authorization ${operation}`);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const temporary = String(args[0]).startsWith(`${f.filePath}.`);
    if (temporary && operation === "open") throw failure;
    const file = await open(...args); if (!temporary) return file;
    return new Proxy(file, { get(target, field) {
      if (field === operation) return async () => { if (operation === "close") await target.close(); throw failure; };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (operation === "rename" && String(args[1]) === f.filePath) throw failure; return rename(...args);
  });
  await assert.rejects(f.api.authorizeDesktopMaintenance(f, started), error => error instanceof DesktopMaintenanceStartupError && error.cause === failure
    || error instanceof DesktopMaintenanceStartupError && error.cause instanceof AggregateError && error.cause.errors.includes(failure));
  assert.deepEqual(JSON.parse(await fs.readFile(f.filePath, "utf8")), started);
  assert.deepEqual(await fs.readFile(path.join(f.location.dataDir, "codeflowai.db")), before);
  assert.deepEqual(await fs.readFile(path.join(f.location.dataDir, "device-identity.json")), identity);
});

for (const name of ["backup.db", "config.json.tmp", "CODEFLOWAI.DB", "shell-update-retired-not-a-uuid.json", ".update-db-unowned", ".shell-update-file-auth-init-unowned", ".shell-update-file-capability-unowned"])
test(`remove authorization refuses unknown root entry ${name} without expanding fixed targets`, async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f);
  const unknown = path.join(f.location.dataDir, name);
  if (name === "CODEFLOWAI.DB") await fs.rename(path.join(f.location.dataDir, "codeflowai.db"), unknown);
  else await fs.writeFile(unknown, "unowned backup");
  const before = await fs.readFile(unknown);
  await assert.rejects(f.api.authorizeDesktopMaintenance(f, started));
  assert.deepEqual(await fs.readFile(unknown), before);
  assert.deepEqual(JSON.parse(await fs.readFile(f.filePath, "utf8")), started);
});

for (const target of ["shell-update-attempt.json", "codeflowai.db", "releases/nested/private.txt", ".shell-update-file-auth/key", "locator", "identity"])
test(`remove failure after deleting ${target} keeps authorization and resumes under the same request`, async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const unlink = fs.unlink, failure = new Error(`fixture interrupted after ${target}`); let interrupted = false;
  const fault = t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    const file = String(args[0]); await unlink(...args);
    const hit = target === "locator" ? file.startsWith(path.join(f.userDataDir, "desktop-data-location.json.removing-"))
      : target === "identity" ? file.startsWith(path.join(f.location.dataDir, "device-identity.json.removing-"))
      : file === path.join(f.location.dataDir, ...target.split("/"));
    if (hit && !interrupted) { interrupted = true; throw failure; }
  });
  await assert.rejects(f.api.completeDesktopMaintenance(f, authorized)); assert.equal(interrupted, true);
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "data_action_authorized");
  fault.mock.restore();
  const restored = await f.api.readDesktopMaintenanceStartup({ mode: "remove", userDataDir: f.userDataDir, installRoot: f.location.installRoot, requestId: f.requestId });
  assert.equal(restored?.kind, "authorized");
  const resumed = await f.api.beginDesktopMaintenance(f); await f.api.completeDesktopMaintenance(f, resumed);
  assert.deepEqual(await fs.readdir(f.location.dataDir), []);
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "completed");
});

test("remove completed publication failure resumes after locator and identity are already missing", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const rename = fs.rename, failure = new Error("fixture completed publish failed");
  const fault = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === f.filePath) throw failure; return rename(...args);
  });
  await assert.rejects(f.api.completeDesktopMaintenance(f, authorized));
  assert.deepEqual(await fs.readdir(f.location.dataDir), []);
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "data_action_authorized");
  fault.mock.restore(); const resumed = await f.api.beginDesktopMaintenance(f); await f.api.completeDesktopMaintenance(f, resumed);
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "completed");
});

test("remove cannot publish completed when a private target reappears after final identity deletion", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const unlink = fs.unlink, restored = path.join(f.location.dataDir, "config.json");
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    await unlink(...args);
    if (String(args[0]).startsWith(path.join(f.location.dataDir, "device-identity.json.removing-"))) await fs.writeFile(restored, "third private config");
  });
  await assert.rejects(f.api.completeDesktopMaintenance(f, authorized));
  assert.equal(await fs.readFile(restored, "utf8"), "third private config");
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "data_action_authorized");
});

test("remove refuses unknown auth contents introduced after authorization without deleting any target", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const unknown = path.join(f.location.dataDir, ".shell-update-file-auth", "unknown"); await fs.writeFile(unknown, "unowned auth bytes");
  const db = await fs.readFile(path.join(f.location.dataDir, "codeflowai.db"));
  await assert.rejects(f.api.completeDesktopMaintenance(f, authorized));
  assert.equal(await fs.readFile(unknown, "utf8"), "unowned auth bytes");
  assert.deepEqual(await fs.readFile(path.join(f.location.dataDir, "codeflowai.db")), db);
});

for (const root of ["dataDir", "userDataDir"] as const) test(`remove resume refuses reconstructed ${root}`, async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f); await f.api.authorizeDesktopMaintenance(f, started);
  const directory = root === "dataDir" ? f.location.dataDir : f.userDataDir;
  await fs.rename(directory, `${directory}-old`); await fs.mkdir(directory);
  if (root === "userDataDir") await fs.copyFile(path.join(`${directory}-old`, "desktop-uninstall-result.json"), f.filePath);
  await assert.rejects(f.api.readDesktopMaintenanceStartup({ mode: "remove", userDataDir: f.userDataDir, installRoot: f.location.installRoot, requestId: f.requestId }));
  assert.deepEqual(await fs.readdir(directory), root === "userDataDir" ? ["desktop-uninstall-result.json"] : []);
});

test("remove startup reader is read only and rejects another pending request", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f); const authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const bytes = await fs.readFile(f.filePath), db = await fs.readFile(path.join(f.location.dataDir, "codeflowai.db"));
  await assert.rejects(f.api.readDesktopMaintenanceStartup({ mode: "remove", userDataDir: f.userDataDir, installRoot: f.location.installRoot, requestId: "other" }));
  const result = await f.api.readDesktopMaintenanceStartup({ mode: "remove", userDataDir: f.userDataDir, installRoot: f.location.installRoot, requestId: f.requestId });
  assert.equal(result?.kind, "authorized"); if (result?.kind === "authorized") assert.deepEqual(result.record, authorized);
  assert.deepEqual(await fs.readFile(f.filePath), bytes); assert.deepEqual(await fs.readFile(path.join(f.location.dataDir, "codeflowai.db")), db);
});

test("remove refuses a third signed identity before deleting any authorized private target", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const thirdRoot = path.join(f.root, "third-identity"); await loadOrCreateDeviceIdentity(thirdRoot);
  const identityPath = path.join(f.location.dataDir, "device-identity.json"), third = await fs.readFile(path.join(thirdRoot, "device-identity.json"));
  await fs.writeFile(identityPath, third); const db = await fs.readFile(path.join(f.location.dataDir, "codeflowai.db"));
  await assert.rejects(f.api.completeDesktopMaintenance(f, authorized));
  assert.deepEqual(await fs.readFile(path.join(f.location.dataDir, "codeflowai.db")), db);
  assert.deepEqual(await fs.readFile(identityPath), third);
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "data_action_authorized");
});

test("remove refuses malformed old capture while business targets remain before deleting any data", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const standard = path.join(f.location.dataDir, "device-identity.json");
  const capture = `${standard}.removing-${authorized.oldDeviceId}-${crypto.randomUUID()}.tmp`;
  await fs.rename(standard, capture); await fs.writeFile(capture, JSON.stringify({ deviceId: authorized.oldDeviceId }));
  const db = await fs.readFile(path.join(f.location.dataDir, "codeflowai.db"));
  await assert.rejects(f.api.completeDesktopMaintenance(f, authorized));
  assert.deepEqual(await fs.readFile(path.join(f.location.dataDir, "codeflowai.db")), db);
  assert.equal(JSON.parse(await fs.readFile(capture, "utf8")).deviceId, authorized.oldDeviceId);
});

test("remove resumes a real identity capture while only D13 auth has been recreated", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const unlink = fs.unlink;
  const fault = t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]).startsWith(path.join(f.location.dataDir, "device-identity.json.removing-"))) throw new Error("fixture retain real capture");
    await unlink(...args);
  });
  await assert.rejects(f.api.completeDesktopMaintenance(f, authorized)); fault.mock.restore();
  const resumed = await f.api.beginDesktopMaintenance(f);
  await fs.mkdir(path.join(f.location.dataDir, ".shell-update-file-auth"));
  await fs.writeFile(path.join(f.location.dataDir, ".shell-update-file-auth", "key"), Buffer.alloc(32, 8));
  await f.api.completeDesktopMaintenance(f, resumed);
  assert.deepEqual(await fs.readdir(f.location.dataDir), []);
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "completed");
});

test("remove refuses malformed locator capture while business targets remain without deleting data", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const locator = path.join(f.userDataDir, "desktop-data-location.json"), hash = crypto.createHash("sha256").update(f.requestId).digest("hex");
  const capture = `${locator}.removing-${hash}-${crypto.randomUUID()}.tmp`;
  await fs.rename(locator, capture); await fs.writeFile(capture, "{}");
  const db = await fs.readFile(path.join(f.location.dataDir, "codeflowai.db")), identity = await fs.readFile(path.join(f.location.dataDir, "device-identity.json"));
  await assert.rejects(f.api.completeDesktopMaintenance(f, authorized));
  assert.deepEqual(await fs.readFile(path.join(f.location.dataDir, "codeflowai.db")), db);
  assert.deepEqual(await fs.readFile(path.join(f.location.dataDir, "device-identity.json")), identity);
  assert.equal(await fs.readFile(capture, "utf8"), "{}");
});

test("remove resumes a real locator capture while only D13 auth has been recreated", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started), unlink = fs.unlink;
  const fault = t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]).startsWith(path.join(f.userDataDir, "desktop-data-location.json.removing-"))) throw new Error("fixture retain real locator capture");
    await unlink(...args);
  });
  await assert.rejects(f.api.completeDesktopMaintenance(f, authorized)); fault.mock.restore();
  const resumed = await f.api.beginDesktopMaintenance(f);
  await fs.mkdir(path.join(f.location.dataDir, ".shell-update-file-auth"));
  await fs.writeFile(path.join(f.location.dataDir, ".shell-update-file-auth", "key"), Buffer.alloc(32, 8));
  await f.api.completeDesktopMaintenance(f, resumed);
  assert.deepEqual(await fs.readdir(f.location.dataDir), []);
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "completed");
});

test("remove rejects a private target recreated during the final record read before completed publication", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  const open = fs.open, restored = path.join(f.location.dataDir, "config.json"); let completedWritten = false, reads = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]) === f.filePath && completedWritten && ++reads === 2) await fs.writeFile(restored, "late private config");
    if (!String(args[0]).startsWith(`${f.filePath}.`)) return file;
    return new Proxy(file, { get(target, field) {
      if (field === "writeFile") return async (...values: Parameters<typeof target.writeFile>) => {
        completedWritten = JSON.parse(String(values[0])).phase === "completed"; return target.writeFile(...values);
      };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(f.api.completeDesktopMaintenance(f, authorized));
  assert.equal(await fs.readFile(restored, "utf8"), "late private config");
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "data_action_authorized");
});

for (const field of ["installRoot", "dataDir"] as const) test(`completed remove history still rejects malformed ${field} syntax`, async t => {
  const f = await fixture(t), api = removalApi();
  await writeRecord(f, record(f, { phase: "completed", [field]: "relative-path" }));
  await assert.rejects(assertDesktopMaintenanceStartup(f), hasCode("DESKTOP_MAINTENANCE_RECORD_INVALID"));
  await assert.rejects(api.readDesktopMaintenanceStartup({ mode: "remove", userDataDir: f.userDataDir, installRoot: f.location.installRoot, requestId: "maintenance:original" }), hasCode("DESKTOP_MAINTENANCE_RECORD_INVALID"));
});

for (const shape of ["link", "hardlink", "nested-unknown-after-snapshot"] as const) test(`remove refuses ${shape} private tree and leaves project bytes`, async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), nested = path.join(f.location.dataDir, "releases", "nested", "private.txt");
  if (shape === "link") { await fs.unlink(nested); await fs.symlink(f.project, nested, process.platform === "win32" ? "junction" : "dir"); }
  if (shape === "hardlink") await fs.link(nested, path.join(f.root, "linked-private"));
  if (shape === "nested-unknown-after-snapshot") {
    const authorized = await f.api.authorizeDesktopMaintenance(f, started), unlink = fs.unlink; let changed = false;
    t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
      if (!changed && String(args[0]) === nested) { changed = true; await fs.writeFile(path.join(path.dirname(nested), "new.txt"), "new unowned bytes"); }
      return unlink(...args);
    });
    await assert.rejects(f.api.completeDesktopMaintenance(f, authorized));
    assert.equal(await fs.readFile(path.join(path.dirname(nested), "new.txt"), "utf8"), "new unowned bytes");
  } else await assert.rejects(f.api.authorizeDesktopMaintenance(f, started));
  assert.equal(await fs.readFile(path.join(f.project, "keep.txt"), "utf8"), "项目始终保留\n");
});

test("remove authorized empty auth recovery completes before a fresh process uses original D13 reader", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f); await f.api.authorizeDesktopMaintenance(f, started);
  await fs.unlink(path.join(f.location.dataDir, "shell-update-attempt.json"));
  await fs.unlink(path.join(f.location.dataDir, ".shell-update-file-auth", "key"));
  const script = `import assert from 'node:assert/strict';
import { readDesktopMaintenanceStartup, beginDesktopMaintenance } from ${JSON.stringify(pathToFileURL(path.resolve("src/desktopMaintenanceRecord.ts")).href)};
import { createShellUpdateAttemptStore } from ${JSON.stringify(pathToFileURL(path.resolve("src/shellUpdateAttempt.ts")).href)};
const input=${JSON.stringify({ mode: "remove", userDataDir: f.userDataDir, installRoot: f.location.installRoot, requestId: f.requestId })};
const startup=await readDesktopMaintenanceStartup(input); assert.equal(startup?.kind,'authorized');
await beginDesktopMaintenance({userDataDir:input.userDataDir,location:startup.location,requestId:input.requestId,mode:'remove'});
assert.equal(await createShellUpdateAttemptStore(startup.location.dataDir).read(),null); process.stdout.write('fresh D13 ordinary');`;
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module"], { input: script, encoding: "utf8", timeout: 45_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); assert.equal(result.error, undefined);
  assert.match(result.stdout, /fresh D13 ordinary/u);
  assert.deepEqual(await fs.readdir(path.join(f.location.dataDir, ".shell-update-file-auth")), ["key"]);
});

for (const shape of ["pending-attempt", "unknown-auth", "auth-directory-missing"] as const) test(`remove authorized begin refuses ${shape} instead of repairing it`, async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f); await f.api.authorizeDesktopMaintenance(f, started);
  await fs.unlink(path.join(f.location.dataDir, ".shell-update-file-auth", "key"));
  if (shape === "auth-directory-missing") await fs.rmdir(path.join(f.location.dataDir, ".shell-update-file-auth"));
  if (shape === "unknown-auth") {
    await fs.unlink(path.join(f.location.dataDir, "shell-update-attempt.json"));
    await fs.writeFile(path.join(f.location.dataDir, ".shell-update-file-auth", "unknown"), "unowned");
  }
  await assert.rejects(f.api.beginDesktopMaintenance(f));
  if (shape === "auth-directory-missing") await assert.rejects(fs.lstat(path.join(f.location.dataDir, ".shell-update-file-auth")), { code: "ENOENT" });
  else assert.deepEqual(await fs.readdir(path.join(f.location.dataDir, ".shell-update-file-auth")), shape === "pending-attempt" ? [] : ["unknown"]);
});

test("completed remove history permits different installation and data roots then only a new request can start again", async t => {
  const f = await removeInstallation(t), started = await f.api.beginDesktopMaintenance(f), authorized = await f.api.authorizeDesktopMaintenance(f, started);
  await f.api.completeDesktopMaintenance(f, authorized);
  const nextInstall = path.join(f.root, "next-install"), nextData = path.join(f.root, "next-data"); await fs.mkdir(nextInstall);
  const selected = await resolveDesktopStorageLocation({ userDataDir: f.userDataDir, installRoot: nextInstall, configuredDataDir: nextData });
  await persistDesktopStorageLocation(selected); const next = await loadOrCreateDeviceIdentity(nextData);
  await fs.writeFile(path.join(nextData, "config.json"), JSON.stringify({ clientId: "next-client", apiKey: "" }));
  await fs.writeFile(path.join(nextData, "codeflowai.db.meta.json"), JSON.stringify({ schemaVersion: 3, ownership: "local_os_user", storageMode: "plain_sqlite", initializationState: "ready" }));
  const db = new DatabaseSync(path.join(nextData, "codeflowai.db"));
  try { db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('client_id','next-client')"); } finally { db.close(); }
  const location = await completeDesktopStorageLocation(selected); assert.equal(location.deviceId, next.deviceId);
  await assertDesktopMaintenanceStartup({ userDataDir: f.userDataDir, location });
  await assert.rejects(f.api.beginDesktopMaintenance({ userDataDir: f.userDataDir, location, requestId: f.requestId, mode: "remove" }));
  const fresh = await f.api.beginDesktopMaintenance({ userDataDir: f.userDataDir, location, requestId: "remove:next", mode: "remove" });
  assert.equal(fresh.phase, "started"); assert.equal(fresh.dataDir, nextData);
});

for (const mode of ["keep", "remove"] as const) test(`empty installation ${mode} uses the original three phases and retains only historical result`, async t => {
  const f = await fixture(t), location = await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot });
  const input = { userDataDir: f.userDataDir, location, requestId: `empty:${mode}`, mode };
  const started = await maintenance.beginDesktopMaintenance(input);
  assert.equal(started.clientId, null); assert.equal(started.oldDeviceId, null);
  await assert.rejects(assertDesktopMaintenanceStartup(input));
  const authorized = await maintenance.authorizeDesktopMaintenance(input, started);
  assert.deepEqual(authorized.authorizedPaths, ["userDataDir/desktop-data-location.json"]);
  assert.ok(authorized.removalRoots); assert.equal(authorized.nextDeviceId, undefined);
  await maintenance.completeDesktopMaintenance(input, authorized);
  const completed = JSON.parse(await fs.readFile(f.filePath, "utf8"));
  assert.deepEqual(completed, { ...started, phase: "completed" });
  assert.deepEqual(await fs.readdir(location.dataDir), []);
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
  await assertDesktopMaintenanceStartup({ userDataDir: f.userDataDir, location: { ...location, installRoot: path.join(f.root, "new-install"), dataDir: path.join(f.root, "new-data") } });
  assert.equal(await prepareDesktopReinstall(input), null);
});

for (const mode of ["keep", "remove"] as const) test(`empty ${mode} refuses new business evidence after browser or authorization without deleting locator`, async t => {
  const f = await fixture(t), location = await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot });
  const input = { userDataDir: f.userDataDir, location, requestId: `empty:${mode}`, mode }, started = await maintenance.beginDesktopMaintenance(input);
  const unexpected = path.join(location.dataDir, "config.json"); await fs.writeFile(unexpected, "new business");
  await assert.rejects(maintenance.authorizeDesktopMaintenance(input, started)); await fs.unlink(unexpected);
  const authorized = await maintenance.authorizeDesktopMaintenance(input, started), locator = await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"));
  await fs.writeFile(unexpected, "new business"); await assert.rejects(maintenance.completeDesktopMaintenance(input, authorized));
  assert.deepEqual(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json")), locator);
  assert.equal(await fs.readFile(unexpected, "utf8"), "new business");
});

/** 根重绑新增能力以真实 keep 保留安装为输入，缺导出时落断言。 */
function rebindApi() {
  const api = maintenance as unknown as Record<string, unknown>;
  assert.equal(typeof api.rebindDesktopKeepInstallation, "function");
  return api.rebindDesktopKeepInstallation as (input: { userDataDir: string; location: DesktopStorageLocation; installRoot: string }) => Promise<DesktopStorageLocation>;
}

for (const failureAt of ["none", "record-before", "record-after", "locator-before", "locator-after"] as const)
test(`keep installation root rebind recovers ${failureAt} using only record then locator`, async t => {
  const f = await retainedInstallation(t), rebind = rebindApi(), target = path.join(f.root, "replacement-install"); await fs.mkdir(target);
  const locatorPath = path.join(f.userDataDir, "desktop-data-location.json"), rename = fs.rename, failure = new Error(`fixture rebind ${failureAt}`);
  const fault = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    const selected = String(args[1]) === f.filePath ? "record" : String(args[1]) === locatorPath ? "locator" : "other";
    if (failureAt === `${selected}-before`) throw failure;
    await rename(...args); if (failureAt === `${selected}-after`) throw failure;
  });
  if (failureAt === "none") await rebind({ userDataDir: f.userDataDir, location: f.location, installRoot: target });
  else await assert.rejects(rebind({ userDataDir: f.userDataDir, location: f.location, installRoot: target }));
  fault.mock.restore();
  const current = await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: target, beforePersist: async () => {} });
  const selected = await rebind({ userDataDir: f.userDataDir, location: current, installRoot: target });
  assert.equal(selected.installRoot, target);
  const record = JSON.parse(await fs.readFile(f.filePath, "utf8"));
  assert.equal(record.installRoot, target); assert.equal(record.rebindFromInstallRoot, f.location.installRoot); assert.equal(record.nextDeviceId, NEXT_DEVICE);
  assert.equal(JSON.parse(await fs.readFile(locatorPath, "utf8")).installRoot, target);
  await assert.rejects(rebind({ userDataDir: f.userDataDir, location: selected, installRoot: path.join(f.root, "third-install") }));
  await assert.rejects(resolveDesktopStorageLocation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot }));
});

test("keep root rebind survives missing old installation and removes its source only at consumed", async t => {
  const f = await retainedInstallation(t), rebind = rebindApi(), target = path.join(f.root, "new-install"); await fs.mkdir(target);
  await fs.rmdir(f.location.installRoot);
  const selected = await rebind({ userDataDir: f.userDataDir, location: f.location, installRoot: target });
  const continuation = await prepareDesktopReinstall({ userDataDir: f.userDataDir, location: selected }); assert.ok(continuation);
  await loadOrCreateDeviceIdentity(selected.dataDir, { deviceId: continuation.authorization.nextDeviceId, createdAt: continuation.authorization.createdAt });
  const completed = await completeDesktopReinstallLocation(selected, continuation.authorization);
  await finishDesktopReinstall({ userDataDir: f.userDataDir, location: completed }, continuation);
  const record = JSON.parse(await fs.readFile(f.filePath, "utf8")); assert.equal(record.phase, "consumed");
  assert.equal(Object.hasOwn(record, "rebindFromInstallRoot"), false);
});

for (const mode of ["keep", "remove"] as const) test(`empty ${mode} resumes authorized after locator capture and completed publication failure`, async t => {
  const f = await fixture(t), location = await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot });
  const input = { userDataDir: f.userDataDir, location, requestId: `empty:${mode}`, mode }, started = await maintenance.beginDesktopMaintenance(input);
  const authorized = await maintenance.authorizeDesktopMaintenance(input, started), rename = fs.rename;
  const fault = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === f.filePath) throw new Error("fixture empty completed failure"); return rename(...args);
  });
  await assert.rejects(maintenance.completeDesktopMaintenance(input, authorized)); fault.mock.restore();
  const recovered = await maintenance.readDesktopMaintenanceStartup({ userDataDir: f.userDataDir, installRoot: location.installRoot, requestId: input.requestId, mode });
  assert.equal(recovered?.kind, "authorized");
  await maintenance.completeDesktopMaintenance(input, authorized);
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).phase, "completed");
  assert.deepEqual(await fs.readdir(location.dataDir), []);
});

test("empty authorization cannot follow a stale started record after another request takes its place", async t => {
  const f = await fixture(t), location = await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot });
  const input = { userDataDir: f.userDataDir, location, requestId: "empty:original", mode: "keep" as const }, started = await maintenance.beginDesktopMaintenance(input);
  await writeRecord(f, { ...started, requestId: "empty:third" });
  await assert.rejects(maintenance.authorizeDesktopMaintenance(input, started));
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).requestId, "empty:third");
});

test("empty keep pending blocks registration before runtime recreation and does not enter F4", async t => {
  const f = await fixture(t), location = await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot });
  const input = { userDataDir: f.userDataDir, location, requestId: "empty:pending", mode: "keep" as const }; await maintenance.beginDesktopMaintenance(input);
  await fs.unlink(path.join(f.userDataDir, "desktop-data-location.json")); await fs.rmdir(location.dataDir);
  await assert.rejects(registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: location.installRoot,
    beforePersist: selected => assertDesktopMaintenanceStartup({ userDataDir: f.userDataDir, location: selected }) }));
  await assert.rejects(fs.lstat(location.dataDir), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
});

for (const phase of ["started", "data_action_authorized", "completed"] as const)
test(`full keep same request ${phase} stays on its original maintenance entry`, async t => {
  const f = await keepInstallation(t), started = await maintenance.beginDesktopMaintenance(f);
  let current = started;
  if (phase !== "started") current = await maintenance.authorizeDesktopMaintenance(f, current);
  if (phase === "completed") { await maintenance.completeDesktopMaintenance(f, current); current = JSON.parse(await fs.readFile(f.filePath, "utf8")); }
  assert.equal(await maintenance.readDesktopMaintenanceStartup({ userDataDir: f.userDataDir, installRoot: f.location.installRoot, requestId: f.requestId, mode: "keep" }), null);
  assert.deepEqual(await maintenance.beginDesktopMaintenance(f), current);
});

test("empty completion preserves locator if new data appears during its file open", async t => {
  const f = await fixture(t), location = await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot });
  const input = { userDataDir: f.userDataDir, location, requestId: "empty:open", mode: "remove" as const }, started = await maintenance.beginDesktopMaintenance(input);
  const authorized = await maintenance.authorizeDesktopMaintenance(input, started), locator = path.join(f.userDataDir, "desktop-data-location.json"), before = await fs.readFile(locator), open = fs.open;
  let opens = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]) === locator && ++opens === 2) await fs.writeFile(path.join(location.dataDir, "config.json"), "new data");
    return file;
  });
  await assert.rejects(maintenance.completeDesktopMaintenance(input, authorized));
  assert.deepEqual(await fs.readFile(locator), before);
  assert.equal(await fs.readFile(path.join(location.dataDir, "config.json"), "utf8"), "new data");
});

test("keep rebind refuses a linked recorded source even after target registration completed", async t => {
  const f = await retainedInstallation(t), rebind = rebindApi(), target = path.join(f.root, "new-install"); await fs.mkdir(target);
  const selected = await rebind({ userDataDir: f.userDataDir, location: f.location, installRoot: target });
  await fs.rmdir(f.location.installRoot); await fs.symlink(f.project, f.location.installRoot, process.platform === "win32" ? "junction" : "dir");
  const before = await fs.readFile(f.filePath); await assert.rejects(rebind({ userDataDir: f.userDataDir, location: selected, installRoot: target }));
  assert.deepEqual(await fs.readFile(f.filePath), before);
});

test("empty authorized startup reader refuses evidence created during its final record read", async t => {
  const f = await fixture(t), location = await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot });
  const input = { userDataDir: f.userDataDir, location, requestId: "reader:final", mode: "keep" as const };
  const started = await maintenance.beginDesktopMaintenance(input); await maintenance.authorizeDesktopMaintenance(input, started);
  const recordPath = f.filePath, open = fs.open; let closes = 0, injected = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); if (String(args[0]) !== recordPath) return file;
    return new Proxy(file, { get(target, field) {
      if (field === "close") return async () => { await target.close(); if (++closes === 2) {
        await fs.writeFile(path.join(location.dataDir, "new-business"), "preserve", "utf8"); injected = true;
      } };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(maintenance.readDesktopMaintenanceStartup({ userDataDir: f.userDataDir, installRoot: location.installRoot, requestId: input.requestId, mode: input.mode }));
  assert.equal(injected, true); assert.equal(await fs.readFile(path.join(location.dataDir, "new-business"), "utf8"), "preserve");
});

test("keep root rebind refuses a changed recorded source during its final record read", async t => {
  const f = await retainedInstallation(t), rebind = rebindApi(), target = path.join(f.root, "final-read-install"); await fs.mkdir(target);
  const selected = await rebind({ userDataDir: f.userDataDir, location: f.location, installRoot: target });
  const unrelated = path.join(f.root, "unrelated-source"); await fs.mkdir(unrelated);
  const recordPath = f.filePath, open = fs.open; let closes = 0, injected = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); if (String(args[0]) !== recordPath) return file;
    return new Proxy(file, { get(target, field) {
      if (field === "close") return async () => { await target.close(); if (++closes === 3) {
        await fs.rmdir(f.location.installRoot); await fs.symlink(unrelated, f.location.installRoot, process.platform === "win32" ? "junction" : "dir"); injected = true;
      } };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(rebind({ userDataDir: f.userDataDir, location: selected, installRoot: target }));
  assert.equal(injected, true);
});

for (const historyMode of ["keep", "remove"] as const) for (const mode of ["keep", "remove"] as const)
test(`empty ${historyMode} completed history permits new initialized ${mode} maintenance`, async t => {
  const f = await fixture(t), empty = await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot });
  const original = { userDataDir: f.userDataDir, location: empty, requestId: `history:${historyMode}`, mode: historyMode };
  const started = await maintenance.beginDesktopMaintenance(original), authorized = await maintenance.authorizeDesktopMaintenance(original, started);
  await maintenance.completeDesktopMaintenance(original, authorized);
  const selected = await resolveDesktopStorageLocation({ userDataDir: f.userDataDir, installRoot: empty.installRoot });
  await assertDesktopMaintenanceStartup({ userDataDir: f.userDataDir, location: selected }); await persistDesktopStorageLocation(selected);
  const identity = await loadOrCreateDeviceIdentity(selected.dataDir);
  await fs.writeFile(path.join(selected.dataDir, "config.json"), JSON.stringify({ clientId: "next-client", apiKey: "" }));
  await fs.writeFile(path.join(selected.dataDir, "codeflowai.db.meta.json"), JSON.stringify({ schemaVersion: 3, ownership: "local_os_user", storageMode: "plain_sqlite", initializationState: "ready" }));
  const db = new DatabaseSync(path.join(selected.dataDir, "codeflowai.db"));
  try { db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('client_id','next-client')"); } finally { db.close(); }
  const location = await completeDesktopStorageLocation(selected); assert.equal(location.deviceId, identity.deviceId);
  await assertDesktopMaintenanceStartup({ userDataDir: f.userDataDir, location });
  await assert.rejects(maintenance.beginDesktopMaintenance({ ...original, location }));
  const next = await maintenance.beginDesktopMaintenance({ userDataDir: f.userDataDir, location, requestId: `next:${mode}`, mode });
  assert.equal(next.phase, "started"); assert.equal(next.clientId, "next-client"); assert.equal(next.oldDeviceId, identity.deviceId);
  assert.equal(next.mode, mode); assert.equal(next.requestId, `next:${mode}`);
});

test("empty completed history rejects the same request under a different maintenance mode", async t => {
  const f = await fixture(t), location = await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot });
  const input = { userDataDir: f.userDataDir, location, requestId: "empty:same-request", mode: "keep" as const };
  const started = await maintenance.beginDesktopMaintenance(input), authorized = await maintenance.authorizeDesktopMaintenance(input, started);
  await maintenance.completeDesktopMaintenance(input, authorized);
  await assert.rejects(maintenance.beginDesktopMaintenance({ ...input, mode: "remove" }), error => error instanceof DesktopMaintenanceStartupError && error.code === "DESKTOP_MAINTENANCE_PENDING");
  const same = await maintenance.beginDesktopMaintenance(input); assert.equal(same.phase, "completed"); assert.equal(same.mode, "keep");
});

/** 首次启动未完成登记时，默认 runtime 会留下应用自身文件；卸载维护不能因此永久阻塞。 */
for (const mode of ["keep", "remove"] as const) test(`pre-registration runtime entries allow ${mode} maintenance`, async t => {
  const f = await fixture(t), location = await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot });
  for (const name of ["workspace", "logs", ".shell-update-file-auth"]) await fs.mkdir(path.join(location.dataDir, name), { recursive: true });
  for (const name of ["device-identity.json", "crash-session.json", "crash-session.clean.json", "crash-reports.jsonl", "errors.jsonl"]) {
    await fs.writeFile(path.join(location.dataDir, name), "{}");
  }
  const input = { userDataDir: f.userDataDir, location, requestId: `pre-registration:${mode}`, mode };
  const started = await maintenance.beginDesktopMaintenance(input);
  assert.equal(started.clientId, null); assert.equal(started.oldDeviceId, null);
  const authorized = await maintenance.authorizeDesktopMaintenance(input, started);
  const resumed = await maintenance.readDesktopMaintenanceStartup({ userDataDir: f.userDataDir, installRoot: f.location.installRoot,
    requestId: input.requestId, mode, resumePending: true });
  assert.equal(resumed?.kind, "authorized");
  await maintenance.completeDesktopMaintenance(input, authorized);
  const completed = JSON.parse(await fs.readFile(f.filePath, "utf8"));
  assert.equal(completed.phase, "completed");
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(location.dataDir)).sort(),
    [".shell-update-file-auth", "crash-reports.jsonl", "crash-session.clean.json", "crash-session.json", "device-identity.json", "errors.jsonl", "logs", "workspace"].sort());
  // 卸载后重新解析与重装登记必须能复用默认 runtime，而不是再次被空存储门禁阻塞。
  assert.equal((await resolveDesktopStorageLocation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot })).dataDir, location.dataDir);
  assert.equal((await registerDesktopInstallation({ userDataDir: f.userDataDir, installRoot: f.location.installRoot,
    beforePersist: async () => {} })).dataDir, location.dataDir);
});

test("maintenance storage guard keeps strict empty checks for unknown entries, links and custom data dirs", async t => {
  const f = await fixture(t), defaultRuntime = path.join(f.userDataDir, "runtime");
  await fs.mkdir(defaultRuntime, { recursive: true });
  await fs.writeFile(path.join(defaultRuntime, "device-identity.json"), "{}");
  await fs.writeFile(path.join(defaultRuntime, "errors.jsonl"), "{}");
  await fs.writeFile(path.join(defaultRuntime, `device-identity.json.${process.pid}.${NEXT_DEVICE}.tmp`), "{}");
  assert.doesNotThrow(() => assertDesktopUnregisteredStorage({ ...f.location, dataDir: defaultRuntime }));
  await fs.writeFile(path.join(defaultRuntime, "codeflowai.db"), "x");
  assert.throws(() => assertDesktopUnregisteredStorage({ ...f.location, dataDir: defaultRuntime }),
    error => (error as { code?: unknown }).code === "DESKTOP_STORAGE_EMPTY_REQUIRED");
  await fs.unlink(path.join(defaultRuntime, "codeflowai.db"));
  await fs.writeFile(path.join(defaultRuntime, "workspace"), "not a directory");
  assert.throws(() => assertDesktopUnregisteredStorage({ ...f.location, dataDir: defaultRuntime }),
    error => (error as { code?: unknown }).code === "DESKTOP_STORAGE_EMPTY_REQUIRED");
  const custom = path.join(f.root, "custom-data");
  await fs.mkdir(custom);
  await fs.writeFile(path.join(custom, "device-identity.json"), "{}");
  assert.throws(() => assertDesktopUnregisteredStorage({ ...f.location, dataDir: custom }),
    error => (error as { code?: unknown }).code === "DESKTOP_STORAGE_EMPTY_REQUIRED");
});
