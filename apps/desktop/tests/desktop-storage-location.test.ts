import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import syncFs from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { resolveDesktopStorageLocation, persistDesktopStorageLocation, completeDesktopStorageLocation, readDesktopJsonFile,
  appendDesktopStartupDiagnostic, rebindDesktopInstallRoot, verifyDesktopStorageLocation } from "../src/desktopStorageLocation.js";
import { verifyDesktopReinstallStorage, completeDesktopReinstallLocation } from "../src/desktopStorageLocation.js";
import crypto from "node:crypto";
import type { DesktopStorageLocation } from "../src/desktopStorageLocation.js";

/** 新登记能力必须先在业务断言失败，不依赖模块加载错误。 */
async function registrationApi() {
  const module = await import("../src/desktopStorageLocation.js") as unknown as Record<string, unknown>;
  assert.equal(typeof module.registerDesktopInstallation, "function");
  return module.registerDesktopInstallation as (input: { userDataDir: string; installRoot: string; beforePersist?: (location: DesktopStorageLocation) => Promise<void> }) => Promise<DesktopStorageLocation>;
}

type RemovalRoots = { dataDir: { dev: string; ino: string; birthtimeNs: string }; userDataDir: { dev: string; ino: string; birthtimeNs: string } };

/** 动态取得新增接口，使缺能力时先落业务断言而非模块加载错误。 */
async function removalApi() {
  const module = await import("../src/desktopStorageLocation.js") as unknown as Record<string, unknown>;
  for (const name of ["inspectDesktopRemovalRoots", "verifyDesktopRemovalLocation", "removeDesktopStorageLocation"]) {
    assert.equal(typeof module[name], "function", `remove storage capability missing: ${name}`);
  }
  return module as unknown as {
    inspectDesktopRemovalRoots(location: DesktopStorageLocation): Promise<RemovalRoots>;
    verifyDesktopRemovalLocation(location: DesktopStorageLocation, roots: RemovalRoots, allowMissingLocator: boolean): Promise<void>;
    removeDesktopStorageLocation(location: DesktopStorageLocation, roots: RemovalRoots, requestId: string): Promise<void>;
  };
}

/** 只在测试私有根建立完整 locator，后续故障断言直接观察真实磁盘。 */
async function removalFixture(t: test.TestContext) {
  const f = await fixture(t), initial = await resolveDesktopStorageLocation(f.input);
  await persistDesktopStorageLocation(initial); await ready(f);
  const location = await completeDesktopStorageLocation(initial), api = await removalApi();
  const roots = await api.inspectDesktopRemovalRoots(location), bytes = await fs.readFile(f.locator);
  const requestId = "remove:storage-01", hash = crypto.createHash("sha256").update(requestId).digest("hex");
  const capture = path.join(f.userDataDir, `desktop-data-location.json.removing-${hash}-${crypto.randomUUID()}.tmp`);
  return { ...f, ...api, location, roots, bytes, requestId, capture };
}

/** 所有文件均位于测试自有临时根，退出后只清理该根。 */
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-d16-location-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), installRoot = path.join(root, "install"), dataDir = path.join(root, "data");
  await fs.mkdir(userDataDir); await fs.mkdir(installRoot);
  const input = { userDataDir, installRoot, configuredDataDir: dataDir }, locator = path.join(userDataDir, "desktop-data-location.json");
  return { root, userDataDir, installRoot, dataDir, input, locator };
}

/** 用真实签名身份及磁盘 SQLite 建立 ready 归属，不启动普通 Client。 */
async function ready(f: Awaited<ReturnType<typeof fixture>>, id = "custom-stable-client") {
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  await fs.writeFile(path.join(f.dataDir, "config.json"), JSON.stringify({ clientId: id, apiKey: "fixture-secret" }));
  await fs.writeFile(path.join(f.dataDir, "codeflowai.db.meta.json"), JSON.stringify({ schemaVersion: 3, storageMode: "plain_sqlite", ownership: "local_os_user", initializationState: "ready" }));
  const db = new DatabaseSync(path.join(f.dataDir, "codeflowai.db"));
  try { db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)"); db.prepare("INSERT INTO meta VALUES (?, ?)").run("client_id", id); }
  finally { db.close(); }
  return identity;
}

test("selected custom path persists before data exists and survives restart without env", async t => {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f.input);
  await persistDesktopStorageLocation(location);
  assert.equal((await fs.readdir(f.root)).includes("data"), false);
  const loaded = await resolveDesktopStorageLocation({ userDataDir: f.userDataDir, installRoot: f.installRoot });
  assert.equal(loaded.dataDir, f.dataDir); assert.equal(loaded.clientId, null); assert.equal(loaded.deviceId, null);
  const bytes = await fs.readFile(f.locator);
  await persistDesktopStorageLocation(loaded); assert.deepEqual(await fs.readFile(f.locator), bytes);
  await assert.rejects(resolveDesktopStorageLocation({ ...f.input, configuredDataDir: path.join(f.root, "other") }), /DESKTOP_STORAGE_LOCATION_CONFLICT/u);
});

test("macOS 首次启动尚无定位文件时重绑不阻塞创建", async t => {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f.input);
  await rebindDesktopInstallRoot(location);
  await persistDesktopStorageLocation(location);
  const created = JSON.parse(await fs.readFile(f.locator, "utf8")) as { installRoot: string };
  assert.equal(created.installRoot, f.installRoot);
});

test("macOS 应用移动后只重绑安装根并保留数据目录", async t => {
  const f = await fixture(t), initial = await resolveDesktopStorageLocation(f.input);
  await persistDesktopStorageLocation(initial);
  const movedRoot = path.join(f.root, "Applications", "CodeFlow.app");
  await fs.mkdir(movedRoot, { recursive: true });
  await assert.rejects(resolveDesktopStorageLocation({ userDataDir: f.userDataDir, installRoot: movedRoot }),
    /DESKTOP_STORAGE_LOCATION_CONFLICT/u);
  const rebound = await resolveDesktopStorageLocation({
    userDataDir: f.userDataDir, installRoot: movedRoot, allowInstallRootChange: true,
  });
  assert.equal(rebound.installRoot, movedRoot);
  assert.equal(rebound.dataDir, initial.dataDir);
  assert.equal(rebound.clientId, initial.clientId);
  // 写回后再次启动必须接受新安装根。
  await rebindDesktopInstallRoot(rebound);
  const reloaded = await resolveDesktopStorageLocation({ userDataDir: f.userDataDir, installRoot: movedRoot });
  assert.equal(reloaded.installRoot, movedRoot);
  assert.equal((JSON.parse(await fs.readFile(f.locator, "utf8")) as { installRoot: string }).installRoot, movedRoot);
});

test("macOS 应用移动后已有身份仍可通过归属校验", async t => {
  const f = await fixture(t), selected = await resolveDesktopStorageLocation(f.input);
  await persistDesktopStorageLocation(selected);
  await ready(f);
  await completeDesktopStorageLocation(selected);
  const movedRoot = path.join(f.root, "Applications", "CodeFlow.app");
  await fs.mkdir(movedRoot, { recursive: true });
  const rebound = await resolveDesktopStorageLocation({
    userDataDir: f.userDataDir, installRoot: movedRoot, allowInstallRootChange: true,
  });
  await rebindDesktopInstallRoot(rebound);
  assert.deepEqual(await verifyDesktopStorageLocation(rebound), rebound);
});

test("installation registers over a retained default workspace without modifying project files", async t => {
  const f = await fixture(t), register = await registrationApi(), workspace = path.join(f.userDataDir, "runtime/workspace");
  await fs.mkdir(path.join(workspace, ".codeflow"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".codeflow/workspace.db"), "retained history");
  const location = await register({ userDataDir: f.userDataDir, installRoot: f.installRoot });
  assert.equal(location.clientId, null); assert.equal(location.deviceId, null);
  assert.equal(await fs.readFile(path.join(workspace, ".codeflow/workspace.db"), "utf8"), "retained history");
  assert.deepEqual((await resolveDesktopStorageLocation({ userDataDir: f.userDataDir, installRoot: f.installRoot })), location);
});

test("installation rejects a linked retained workspace before registering a location", async t => {
  const f = await fixture(t), register = await registrationApi(), runtime = path.join(f.userDataDir, "runtime");
  await fs.mkdir(runtime); await fs.mkdir(f.dataDir);
  await fs.symlink(f.dataDir, path.join(runtime, "workspace"), "junction");
  await assert.rejects(register({ userDataDir: f.userDataDir, installRoot: f.installRoot }));
  assert.equal(await readDesktopJsonFile(f.locator), null);
});

test("ready records only matching persistent config DB and signed identity", async t => {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f.input);
  await persistDesktopStorageLocation(location); const identity = await ready(f);
  const dbBefore = await fs.readFile(path.join(f.dataDir, "codeflowai.db"));
  const completed = await completeDesktopStorageLocation(location);
  assert.equal(completed.clientId, "custom-stable-client"); assert.equal(completed.deviceId, identity.deviceId);
  const record = JSON.parse(await fs.readFile(f.locator, "utf8"));
  assert.deepEqual(Object.keys(record).sort(), ["appId", "clientId", "dataDir", "deviceId", "installRoot", "schemaVersion"].sort());
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, "codeflowai.db")), dbBefore);
  const bytes = await fs.readFile(f.locator); await completeDesktopStorageLocation(completed);
  assert.deepEqual(await fs.readFile(f.locator), bytes); assert.doesNotMatch(bytes.toString(), /fixture-secret/u);
});

for (const variant of ["env", "db", "meta", "identity", "config"] as const) test(`ready refuses ${variant} ownership mismatch without rewriting locator`, async t => {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f.input);
  await persistDesktopStorageLocation(location); await ready(f);
  const original = await fs.readFile(f.locator);
  if (variant === "db") {
    const db = new DatabaseSync(path.join(f.dataDir, "codeflowai.db"));
    try { db.exec("UPDATE meta SET value = 'foreign' WHERE key = 'client_id'"); } finally { db.close(); }
  }
  if (variant === "meta") await fs.writeFile(path.join(f.dataDir, "codeflowai.db.meta.json"), JSON.stringify({ schemaVersion: 3, storageMode: "plain_sqlite", ownership: "local_os_user", initializationState: "pending" }));
  if (variant === "identity") await fs.writeFile(path.join(f.dataDir, "device-identity.json"), "{}");
  if (variant === "config") await fs.writeFile(path.join(f.dataDir, "config.json"), JSON.stringify({ clientId: " custom-stable-client ", apiKey: "fixture-secret" }));
  await assert.rejects(completeDesktopStorageLocation(location, variant === "env" ? "foreign" : undefined));
  assert.deepEqual(await fs.readFile(f.locator), original);
});

test("existing signed data without a locator cannot be silently adopted", async t => {
  const f = await fixture(t); await ready(f);
  await assert.rejects(resolveDesktopStorageLocation(f.input), /DESKTOP_STORAGE_LOCATION_REQUIRED/u);
  await assert.rejects(fs.stat(f.locator), { code: "ENOENT" });
});

for (const content of ["null", "{}", "[]", '{"schemaVersion":2}', Buffer.from([0xff])]) test(`invalid existing locator is never treated as missing: ${Buffer.isBuffer(content) ? "invalid UTF8" : content}`, async t => {
  const f = await fixture(t); await fs.writeFile(f.locator, content);
  await assert.rejects(resolveDesktopStorageLocation(f.input));
  assert.deepEqual(await fs.readFile(f.locator), Buffer.from(content));
});

test("safe JSON reader rejects hardlinks and directory inputs", async t => {
  const f = await fixture(t), original = path.join(f.root, "original.json"); await fs.writeFile(original, "{}");
  await fs.link(original, f.locator); await assert.rejects(readDesktopJsonFile(f.locator), /DESKTOP_STORAGE_FILE_INVALID/u);
  await assert.rejects(readDesktopJsonFile(f.userDataDir), /DESKTOP_STORAGE_FILE_INVALID/u);
});

test("locator rename failure preserves original facts and cleans only its own temporary file", async t => {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f.input), failure = Object.assign(new Error("fixture rename"), { code: "EACCES" });
  const marker = path.join(f.userDataDir, "other-owner.tmp"); await fs.writeFile(marker, "untouched");
  const restore = t.mock.method(fs, "rename", async () => { throw failure; });
  await assert.rejects(persistDesktopStorageLocation(location), error => error === failure); restore.mock.restore();
  assert.deepEqual(await fs.readdir(f.userDataDir), ["other-owner.tmp"]); assert.equal(await fs.readFile(marker, "utf8"), "untouched");
});

test("a Windows short path cannot place storage inside the installation", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), executable = path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:D16_ALIAS_TARGET).ShortPath"],
    { env: { ...process.env, D16_ALIAS_TARGET: f.installRoot }, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr); if (result.error) throw result.error;
  await assert.rejects(resolveDesktopStorageLocation({ ...f.input, configuredDataDir: path.join(result.stdout.trim(), "storage") }), /DESKTOP_STORAGE_PATH_INVALID/u);
});

test("ready rejects config changes during identity verification", async t => {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f.input);
  await persistDesktopStorageLocation(location); await ready(f);
  const before = await fs.readFile(f.locator), lstat = fs.lstat;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const entry = await lstat(...args);
    if (String(args[0]) === path.join(f.dataDir, "device-identity.json")) syncFs.writeFileSync(path.join(f.dataDir, "config.json"), JSON.stringify({ clientId: "changed-during-verification" }));
    return entry;
  });
  await assert.rejects(completeDesktopStorageLocation(location), /DESKTOP_STORAGE_FILE_CHANGED/u);
  assert.deepEqual(await fs.readFile(f.locator), before);
});

test("reading a closed WAL database does not create source sidecars", async t => {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f.input);
  await persistDesktopStorageLocation(location); await ready(f);
  const db = new DatabaseSync(path.join(f.dataDir, "codeflowai.db"));
  try { db.exec("PRAGMA journal_mode = WAL"); } finally { db.close(); }
  const entries = await fs.readdir(f.dataDir);
  await completeDesktopStorageLocation(location);
  assert.deepEqual(await fs.readdir(f.dataDir), entries);
});

test("read verification includes committed WAL ownership and leaves every source byte unchanged", async t => {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f.input);
  await persistDesktopStorageLocation(location); await ready(f);
  const db = new DatabaseSync(path.join(f.dataDir, "codeflowai.db"));
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; UPDATE meta SET value = 'foreign-wal-owner' WHERE key = 'client_id'");
    const before = await fs.readFile(path.join(f.dataDir, "codeflowai.db-wal"));
    await assert.rejects(completeDesktopStorageLocation(location), /DESKTOP_STORAGE_OWNERSHIP_CONFLICT/u);
    assert.deepEqual(await fs.readFile(path.join(f.dataDir, "codeflowai.db-wal")), before);
  } finally { db.close(); }
});

test("startup diagnostics refuse a logs junction without writing its external target", async t => {
  const f = await fixture(t), external = path.join(f.root, "external"); await fs.mkdir(external);
  await fs.symlink(external, path.join(f.userDataDir, "logs"), "junction");
  assert.throws(() => appendDesktopStartupDiagnostic(f.userDataDir, '{"errorCode":"fixture"}\n'), /DESKTOP_STORAGE_PATH_INVALID/u);
  assert.deepEqual(await fs.readdir(external), []);
});

test("startup diagnostics append safely and reject a hardlinked log", async t => {
  const f = await fixture(t), logs = path.join(f.userDataDir, "logs"), log = path.join(logs, "desktop-errors.jsonl");
  appendDesktopStartupDiagnostic(f.userDataDir, "first\n"); appendDesktopStartupDiagnostic(f.userDataDir, "second\n");
  assert.equal(await fs.readFile(log, "utf8"), "first\nsecond\n");
  await fs.link(log, path.join(f.root, "external.log"));
  assert.throws(() => appendDesktopStartupDiagnostic(f.userDataDir, "rejected\n"), /DESKTOP_STORAGE_FILE_INVALID/u);
  assert.equal(await fs.readFile(log, "utf8"), "first\nsecond\n");
});

for (const stage of ["open", "writeFile", "sync", "close"] as const) test(`initial locator ${stage} failure never creates private data or succeeds`, async t => {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f.input), open = fs.open;
  const failure = Object.assign(new Error(`fixture ${stage}`), { code: "D16_TEST_WRITE_FAILED" });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const temporary = String(args[0]).endsWith(".tmp");
    if (temporary && stage === "open") throw failure;
    const handle = await open(...args);
    if (!temporary) return handle;
    return new Proxy(handle, { get(target, property) {
      if (property === stage) return async () => { if (stage === "close") await target.close(); throw failure; };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(persistDesktopStorageLocation(location), error => error === failure || (error instanceof AggregateError && error.errors.includes(failure)));
  await assert.rejects(fs.stat(f.locator), { code: "ENOENT" }); await assert.rejects(fs.stat(f.dataDir), { code: "ENOENT" });
});

test("atomic write and cleanup double failure preserve both causes", async t => {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f.input);
  const primary = new Error("fixture rename"), cleanup = new Error("fixture cleanup");
  t.mock.method(fs, "rename", async () => { throw primary; }); t.mock.method(fs, "unlink", async () => { throw cleanup; });
  await assert.rejects(persistDesktopStorageLocation(location), error => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup);
  await assert.rejects(fs.stat(f.locator), { code: "ENOENT" });
});

test("ready snapshot cleanup failure remains a failed registration", async t => {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f.input); await persistDesktopStorageLocation(location); await ready(f);
  const before = await fs.readFile(f.locator), rm = fs.rm, cleanup = new Error("fixture snapshot cleanup");
  let retained: string | undefined;
  const mock = t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).includes("codeflow-storage-check-")) { retained = String(args[0]); throw cleanup; }
    return rm(...args);
  });
  await assert.rejects(completeDesktopStorageLocation(location), error => error === cleanup);
  mock.mock.restore(); if (retained) await rm(retained, { recursive: true });
  assert.deepEqual(await fs.readFile(f.locator), before);
});

test("reinstall verifies retained ownership before identity and updates only the exact old locator to next", async t => {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f.input); await persistDesktopStorageLocation(location);
  const old = await ready(f), registered = await completeDesktopStorageLocation(location);
  await fs.unlink(path.join(f.dataDir, "device-identity.json"));
  const authorization = { clientId: registered.clientId!, oldDeviceId: old.deviceId,
    nextDeviceId: "16e38f2a-0640-49b0-a871-a897e5fcae81", createdAt: "2026-10-31T00:00:00.000Z" };
  const before = await fs.readFile(f.locator);
  await verifyDesktopReinstallStorage(registered, authorization); assert.deepEqual(await fs.readFile(f.locator), before);
  await assert.rejects(completeDesktopReinstallLocation(registered, authorization), /DESKTOP_DEVICE_IDENTITY_MISSING/u);
  await loadOrCreateDeviceIdentity(f.dataDir, { deviceId: authorization.nextDeviceId, createdAt: authorization.createdAt });
  const completed = await completeDesktopReinstallLocation(registered, authorization);
  assert.equal(completed.deviceId, authorization.nextDeviceId); assert.equal(completed.clientId, registered.clientId);
  const bytes = await fs.readFile(f.locator); await completeDesktopReinstallLocation(completed, authorization);
  assert.deepEqual(await fs.readFile(f.locator), bytes);
});

test("remove validates physical roots and deletes only the exact locator after application DB is gone", async t => {
  const f = await removalFixture(t);
  for (const root of [f.roots.dataDir, f.roots.userDataDir]) {
    assert.deepEqual(Object.keys(root).sort(), ["birthtimeNs", "dev", "ino"]);
    for (const value of Object.values(root)) assert.match(value, /^[1-9][0-9]*$/u);
  }
  for (const name of ["config.json", "codeflowai.db", "codeflowai.db.meta.json"]) await fs.unlink(path.join(f.dataDir, name));
  const identity = await fs.readFile(path.join(f.dataDir, "device-identity.json"));
  const result = path.join(f.userDataDir, "desktop-uninstall-result.json"); await fs.writeFile(result, "retained result");
  await f.verifyDesktopRemovalLocation(f.location, f.roots, false);
  await f.removeDesktopStorageLocation(f.location, f.roots, f.requestId);
  await f.removeDesktopStorageLocation(f.location, f.roots, f.requestId);
  await f.verifyDesktopRemovalLocation(f.location, f.roots, true);
  await assert.rejects(f.verifyDesktopRemovalLocation(f.location, f.roots, false));
  assert.deepEqual(await fs.readdir(f.dataDir), ["device-identity.json"]);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, "device-identity.json")), identity);
  assert.equal(await fs.readFile(result, "utf8"), "retained result");
  assert.deepEqual(await fs.readdir(f.userDataDir), ["desktop-uninstall-result.json"]);
});

test("remove exposes the existing synchronous root guard for each destructive boundary", async t => {
  const f = await removalFixture(t), module = await import("../src/desktopStorageLocation.js") as unknown as Record<string, unknown>;
  assert.equal(typeof module.assertDesktopRemovalRoots, "function");
  const guard = module.assertDesktopRemovalRoots as (location: DesktopStorageLocation, roots: RemovalRoots) => void;
  assert.equal(guard(f.location, f.roots), undefined);
  await fs.rename(f.dataDir, `${f.dataDir}-old`); await fs.mkdir(f.dataDir);
  assert.throws(() => guard(f.location, f.roots));
});

for (const root of ["dataDir", "userDataDir"] as const) test(`remove rejects rebuilt ${root} but accepts its content changes`, async t => {
  const f = await removalFixture(t), directory = f[root];
  const marker = path.join(directory, "marker"); await fs.writeFile(marker, "content change");
  await f.verifyDesktopRemovalLocation(f.location, f.roots, false); await fs.unlink(marker);
  await fs.rename(directory, `${directory}-old`); await fs.mkdir(directory);
  if (root === "userDataDir") await fs.writeFile(f.locator, f.bytes);
  await assert.rejects(f.verifyDesktopRemovalLocation(f.location, f.roots, true));
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, f.requestId));
  assert.deepEqual(await fs.readFile(f.locator), f.bytes);
});

for (const invalid of ["0", "01", "-1", "1.5", "9".repeat(81), 1, null]) test(`remove rejects invalid root identity ${String(invalid)}`, async t => {
  const f = await removalFixture(t), roots = structuredClone(f.roots);
  (roots.dataDir as Record<string, unknown>).ino = invalid;
  await assert.rejects(f.verifyDesktopRemovalLocation(f.location, roots, false));
  assert.deepEqual(await fs.readFile(f.locator), f.bytes);
});

for (const shape of ["missing", "junction", "hardlink", "extra-field", "foreign-client", "invalid-utf8"] as const)
test(`remove rejects ${shape} locator or roots without deleting evidence`, async t => {
  const f = await removalFixture(t);
  if (shape === "missing") { await fs.rename(f.dataDir, `${f.dataDir}-old`); }
  if (shape === "junction") {
    await fs.rename(f.dataDir, `${f.dataDir}-old`); await fs.symlink(`${f.dataDir}-old`, f.dataDir, process.platform === "win32" ? "junction" : "dir");
  }
  if (shape === "hardlink") await fs.link(f.locator, path.join(f.root, "linked.json"));
  if (shape === "extra-field" || shape === "foreign-client") {
    const value = JSON.parse(f.bytes.toString());
    if (shape === "extra-field") value.extra = true; else value.clientId = "foreign";
    await fs.writeFile(f.locator, JSON.stringify(value));
  }
  if (shape === "invalid-utf8") await fs.writeFile(f.locator, Buffer.from([0xff]));
  const bytes = await fs.readFile(f.locator);
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, f.requestId));
  assert.deepEqual(await fs.readFile(f.locator), bytes);
});

for (const phase of ["before", "after"] as const) test(`remove locator capture rename ${phase} failure preserves evidence and same request resumes`, async t => {
  const f = await removalFixture(t), rename = fs.rename, failure = new Error("fixture locator rename failed");
  const fault = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[0]) !== f.locator) return rename(...args);
    assert.doesNotMatch(path.basename(String(args[1])), /:/u);
    if (phase === "after") await rename(...args);
    throw failure;
  });
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, f.requestId), error => error === failure);
  const names = await fs.readdir(f.userDataDir); assert.equal(names.length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.userDataDir, names[0]!)), f.bytes);
  assert.equal(names[0] === "desktop-data-location.json", phase === "before");
  fault.mock.restore(); await f.removeDesktopStorageLocation(f.location, f.roots, f.requestId);
  assert.deepEqual(await fs.readdir(f.userDataDir), []);
});

for (const shape of ["foreign-request", "unknown", "multiple", "standard-present", "hardlink", "wrong-fields",
  "uppercase-unknown", "uppercase-capture", "uppercase-nonce", "standard-uppercase-family"] as const)
test(`remove refuses ${shape} capture without touching standard locator or capture`, async t => {
  const f = await removalFixture(t);
  if (shape !== "standard-present" && shape !== "standard-uppercase-family") await fs.unlink(f.locator);
  let capture = f.capture;
  if (shape === "foreign-request") capture = capture.replace(/removing-[0-9a-f]{64}-/u, `removing-${"a".repeat(64)}-`);
  if (shape === "unknown") capture = `${f.locator}.unknown.tmp`;
  if (shape === "uppercase-unknown" || shape === "standard-uppercase-family") capture = path.join(f.userDataDir, "DESKTOP-DATA-LOCATION.JSON.unknown.tmp");
  if (shape === "uppercase-capture") capture = path.join(f.userDataDir, path.basename(f.capture).toUpperCase());
  if (shape === "uppercase-nonce") capture = f.capture.replace(/[0-9a-f-]{36}\.tmp$/u, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.tmp");
  const bytes = shape === "wrong-fields" ? Buffer.from(JSON.stringify({ ...JSON.parse(f.bytes.toString()), clientId: "foreign" })) : f.bytes;
  await fs.writeFile(capture, bytes);
  if (shape === "multiple") await fs.writeFile(f.capture.replace(/[0-9a-f-]{36}\.tmp$/u, `${crypto.randomUUID()}.tmp`), f.bytes);
  if (shape === "hardlink") await fs.link(capture, path.join(f.root, "linked-capture"));
  const names = await fs.readdir(f.userDataDir), before = await Promise.all(names.map(name => fs.readFile(path.join(f.userDataDir, name))));
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, f.requestId));
  assert.deepEqual(await fs.readdir(f.userDataDir), names);
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(f.userDataDir, name)))), before);
});

for (const mutation of ["inode", "size", "mtime"] as const) test(`remove catches locator ${mutation} replacement at capture and preserves captured evidence`, async t => {
  const f = await removalFixture(t), rename = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[0]) !== f.locator) return rename(...args);
    if (mutation === "inode") { await rename(f.locator, path.join(f.root, "old-locator")); await fs.writeFile(f.locator, f.bytes); }
    if (mutation === "size") await fs.appendFile(f.locator, " ");
    if (mutation === "mtime") await fs.utimes(f.locator, new Date("2001-01-01"), new Date("2001-01-01"));
    await rename(...args);
  });
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, f.requestId));
  const captures = await fs.readdir(f.userDataDir); assert.equal(captures.length, 1);
  assert.match(captures[0]!, /^desktop-data-location\.json\.removing-/u);
  assert.deepEqual(await fs.readFile(path.join(f.userDataDir, captures[0]!)), mutation === "size" ? Buffer.concat([f.bytes, Buffer.from(" ")]) : f.bytes);
});

test("remove never unlinks a third locator published during capture", async t => {
  const f = await removalFixture(t), rename = fs.rename, third = Buffer.from(JSON.stringify({ ...JSON.parse(f.bytes.toString()), clientId: "third" }));
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args); if (String(args[0]) === f.locator) await fs.writeFile(f.locator, third);
  });
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, f.requestId));
  assert.deepEqual(await fs.readFile(f.locator), third);
  assert.equal((await fs.readdir(f.userDataDir)).length, 2);
});

for (const phase of ["before", "after", "no-op"] as const) test(`remove locator unlink ${phase} is verified and same request can resume`, async t => {
  const f = await removalFixture(t), unlink = fs.unlink, failure = new Error("fixture unlink failed");
  const fault = t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    assert.notEqual(String(args[0]), f.locator);
    if (!String(args[0]).startsWith(`${f.locator}.removing-`)) return unlink(...args);
    if (phase === "after") await unlink(...args);
    if (phase !== "no-op") throw failure;
  });
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, f.requestId), error => phase === "no-op" || error === failure);
  fault.mock.restore(); await f.removeDesktopStorageLocation(f.location, f.roots, f.requestId);
  assert.deepEqual(await fs.readdir(f.userDataDir), []);
});

test("remove preserves read and close failures together without deleting locator", async t => {
  const f = await removalFixture(t), open = fs.open, primary = new Error("fixture read failed"), cleanup = new Error("fixture close failed");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); if (String(args[0]) !== f.locator) return file;
    return new Proxy(file, { get(target, field) {
      if (field === "read") return async () => { throw primary; };
      if (field === "close") return async () => { await target.close(); throw cleanup; };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, f.requestId), error => error instanceof AggregateError
    && error.errors.includes(primary) && error.errors.includes(cleanup));
  assert.deepEqual(await fs.readFile(f.locator), f.bytes);
});

test("remove detects root replacement during locator open before any deletion", async t => {
  const f = await removalFixture(t), open = fs.open; let replaced = false;
  const identity = await fs.readFile(path.join(f.dataDir, "device-identity.json"));
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (!replaced && String(args[0]) === f.locator) {
      replaced = true; await fs.rename(f.dataDir, `${f.dataDir}-old`); await fs.mkdir(f.dataDir);
    }
    return file;
  });
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, f.requestId));
  assert.deepEqual(await fs.readFile(f.locator), f.bytes);
  assert.deepEqual(await fs.readFile(path.join(`${f.dataDir}-old`, "device-identity.json")), identity);
  assert.deepEqual(await fs.readdir(f.dataDir), []);
});

test("remove reports close failure after locator deletion and resumes without recreating it", async t => {
  const f = await removalFixture(t), open = fs.open, cleanup = new Error("fixture close after delete failed");
  const fault = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); if (String(args[0]) !== f.locator) return file;
    return new Proxy(file, { get(target, field) {
      if (field === "close") return async () => { await target.close(); throw cleanup; };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, f.requestId), error => error === cleanup);
  assert.deepEqual(await fs.readdir(f.userDataDir), []);
  fault.mock.restore(); await f.removeDesktopStorageLocation(f.location, f.roots, f.requestId);
  assert.deepEqual(await fs.readdir(f.userDataDir), []);
});

test("remove preserves a third locator appearing at capture unlink and fails instead of completing", async t => {
  const f = await removalFixture(t), unlink = fs.unlink, third = Buffer.from(JSON.stringify({ ...JSON.parse(f.bytes.toString()), clientId: "third" }));
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]).startsWith(`${f.locator}.removing-`)) await fs.writeFile(f.locator, third);
    await unlink(...args);
  });
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, f.requestId));
  assert.deepEqual(await fs.readFile(f.locator), third);
  assert.deepEqual(await fs.readdir(f.userDataDir), ["desktop-data-location.json"]);
});

test("remove rechecks captured pathname after final awaited handle metadata and preserves its replacement", async t => {
  const f = await removalFixture(t), open = fs.open;
  const third = Buffer.from(JSON.stringify({ ...JSON.parse(f.bytes.toString()), clientId: "third" }));
  let reads = 0, finalStats = 0, replaced: string | undefined;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); if (String(args[0]) !== f.locator) return file;
    return new Proxy(file, { get(target, field) {
      if (field === "read") return async (...values: Parameters<typeof target.read>) => { const result = await target.read(...values); reads++; return result; };
      if (field === "stat") return async (...values: Parameters<typeof target.stat>) => {
        const stat = await target.stat(...values);
        if (reads === 2 && ++finalStats === 2) {
          const capture = (await fs.readdir(f.userDataDir)).find(name => name.startsWith("desktop-data-location.json.removing-"))!;
          replaced = path.join(f.userDataDir, capture);
          await fs.rename(replaced, path.join(f.root, "original-capture")); await fs.writeFile(replaced, third);
        }
        return stat;
      };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, f.requestId));
  assert.ok(replaced); assert.deepEqual(await fs.readFile(replaced), third);
  assert.deepEqual(await fs.readFile(path.join(f.root, "original-capture")), f.bytes);
});

for (const requestId of ["", "../escape", "a/b", "a\\b", "a".repeat(129)]) test(`remove refuses invalid request ${requestId}`, async t => {
  const f = await removalFixture(t);
  await assert.rejects(f.removeDesktopStorageLocation(f.location, f.roots, requestId));
  assert.deepEqual(await fs.readFile(f.locator), f.bytes);
});

test("installation registration persists only default dual null and preserves an existing custom choice", async t => {
  const f = await fixture(t), register = await registrationApi();
  const location = await register({ userDataDir: f.userDataDir, installRoot: f.installRoot });
  assert.equal(location.dataDir, path.join(f.userDataDir, "runtime")); assert.equal(location.clientId, null); assert.equal(location.deviceId, null);
  assert.deepEqual(await fs.readdir(location.dataDir), []);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(f.locator, "utf8"))).sort(), ["appId", "clientId", "dataDir", "deviceId", "installRoot", "schemaVersion"]);
  const registered = await fs.readFile(f.locator), custom = await resolveDesktopStorageLocation(f.input); assert.equal(custom.dataDir, f.dataDir);
  assert.deepEqual(await fs.readFile(f.locator), registered);
  await persistDesktopStorageLocation(custom);
  assert.deepEqual(await register({ userDataDir: f.userDataDir, installRoot: f.installRoot }), custom);
  assert.deepEqual(await resolveDesktopStorageLocation({ userDataDir: f.userDataDir, installRoot: f.installRoot }), custom);
  assert.deepEqual(await fs.readdir(f.dataDir).catch(error => { if (error.code === "ENOENT") return []; throw error; }), []);
});

test("installation registration invokes the record gate before creating runtime or locator", async t => {
  const f = await fixture(t), register = await registrationApi(), failure = new Error("fixture pending record");
  await assert.rejects(register({ userDataDir: f.userDataDir, installRoot: f.installRoot, beforePersist: async () => { throw failure; } }), error => error === failure);
  await assert.rejects(fs.lstat(f.locator), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "runtime")), { code: "ENOENT" });
});

test("installation registration refuses evidence created while its pending gate awaits", async t => {
  const f = await fixture(t), register = await registrationApi(), runtime = path.join(f.userDataDir, "runtime");
  await assert.rejects(register({ userDataDir: f.userDataDir, installRoot: f.installRoot, beforePersist: async () => {
    await fs.mkdir(runtime); await fs.writeFile(path.join(runtime, "unknown"), "new evidence");
  } }));
  await assert.rejects(fs.lstat(f.locator), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(runtime, "unknown"), "utf8"), "new evidence");
});

test("initial custom selection refuses a nonempty target and preserves default choice", async t => {
  const f = await fixture(t), register = await registrationApi(); await register({ userDataDir: f.userDataDir, installRoot: f.installRoot });
  await fs.mkdir(f.dataDir); await fs.writeFile(path.join(f.dataDir, "unknown"), "custom evidence");
  const before = await fs.readFile(f.locator); await assert.rejects(resolveDesktopStorageLocation(f.input));
  assert.deepEqual(await fs.readFile(f.locator), before);
});

for (const name of ["config.json", "device-identity.json", ".shell-update-file-auth", "unknown"])
test(`initial custom selection refuses nonempty default ${name}`, async t => {
  const f = await fixture(t), register = await registrationApi();
  const location = await register({ userDataDir: f.userDataDir, installRoot: f.installRoot });
  await fs.writeFile(path.join(location.dataDir, name), "unowned evidence");
  const bytes = await fs.readFile(f.locator);
  await assert.rejects(resolveDesktopStorageLocation(f.input)); assert.deepEqual(await fs.readFile(f.locator), bytes);
  assert.equal(await fs.readFile(path.join(location.dataDir, name), "utf8"), "unowned evidence");
});

for (const stage of ["open", "writeFile", "sync", "close", "rename"] as const)
test(`installation registration ${stage} failure is explicit and never initializes business data`, async t => {
  const f = await fixture(t), register = await registrationApi(), open = fs.open, rename = fs.rename, failure = new Error(`fixture registration ${stage}`);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (stage === "open") throw failure;
    const file = await open(...args);
    return new Proxy(file, { get(target, field) {
      if (field === stage) return async () => { if (stage === "close") await target.close(); throw failure; };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { if (String(args[1]) === f.locator && stage === "rename") throw failure; return rename(...args); });
  await assert.rejects(register({ userDataDir: f.userDataDir, installRoot: f.installRoot }));
  assert.deepEqual(await fs.readdir(path.join(f.userDataDir, "runtime")), []);
  await assert.rejects(fs.lstat(f.locator), { code: "ENOENT" });
});
