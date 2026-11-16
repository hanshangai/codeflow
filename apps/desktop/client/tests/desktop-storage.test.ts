import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readClientConfig } from "../src/config.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { confirmPlainClientDbInitialized, prepareClientDbSecurity, prepareClientDeviceIdentity, resolveClientDbStartupContext } from "../src/security/clientDbSecurity.js";

/** 使用独立临时目录和壳身份，所有网络访问均让测试立即失败。 */
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-desktop-storage-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envKeys = ["CODEFLOWAI_CLIENT_CONFIG_PATH", "CODEFLOWAI_CLIENT_DB_PATH", "CODEFLOWAI_API_KEY", "CODEFLOWAI_CLIENT_ID", "CODEFLOWAI_SERVER_WS"];
  const before = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.CODEFLOWAI_CLIENT_CONFIG_PATH = path.join(directory, "config.json");
  process.env.CODEFLOWAI_CLIENT_DB_PATH = path.join(directory, "codeflowai.db");
  process.env.CODEFLOWAI_SERVER_WS = "ws://127.0.0.1:1/ws/client";
  t.after(() => { for (const [key, value] of before) value === undefined ? delete process.env[key] : process.env[key] = value; });
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { networkCalls += 1; throw new Error("unexpected network access"); });
  const deviceId = crypto.randomUUID();
  fs.writeFileSync(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId, createdAt: "2026-10-24T00:00:00.000Z" }), "utf8");
  return { directory, dbPath: process.env.CODEFLOWAI_CLIENT_DB_PATH, deviceId, networkCalls: () => networkCalls };
}

/** 准备本地上下文，不需要连接不可达 Server。 */
async function localContext() {
  const config = readClientConfig({ desktop: true });
  const startupContext = await resolveClientDbStartupContext({ config, clientVersion: "1.0.0", desktop: true });
  return { config, startupContext, clientVersion: "1.0.0", dbPath: startupContext.dbPath };
}

test("desktop storage initializes and reopens local SQLite without account or Server", async (t) => {
  const f = fixture(t);
  const input = await localContext();
  assert.equal(input.startupContext.accountNamespace, null);
  assert.equal(input.startupContext.storageScope, "local_user");
  await prepareClientDbSecurity(input);
  const db = openSqliteDb(f.dbPath);
  db.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('history');");
  db.close();
  confirmPlainClientDbInitialized({ dbPath: f.dbPath, accountNamespace: null, storageScope: "local_user" });
  assert.deepEqual(await prepareClientDeviceIdentity(input), { deviceId: f.deviceId, authMode: "local" });
  const meta = JSON.parse(fs.readFileSync(`${f.dbPath}.meta.json`, "utf8"));
  assert.equal(meta.ownership, "local_os_user");
  assert.equal(meta.initializationState, "ready");
  assert.equal(meta.accountNamespace, undefined);
  await prepareClientDbSecurity(await localContext());
  const reopened = openSqliteDb(f.dbPath);
  try { assert.deepEqual(reopened.prepare("SELECT value FROM retained").get(), { value: "history" }); }
  finally { reopened.close(); }
  assert.equal(f.networkCalls(), 0);
});

test("desktop storage refuses missing initialized database or missing ownership metadata", async (t) => {
  const f = fixture(t);
  const input = await localContext();
  await prepareClientDbSecurity(input);
  const db = openSqliteDb(f.dbPath);
  db.exec("PRAGMA user_version = 1");
  db.close();
  confirmPlainClientDbInitialized({ dbPath: f.dbPath, accountNamespace: null, storageScope: "local_user" });
  fs.unlinkSync(f.dbPath);
  await assert.rejects(() => prepareClientDbSecurity(input), { code: "CLIENT_DB_STORAGE_FILE_MISSING" });
  assert.equal(fs.existsSync(f.dbPath), false);
  const restored = openSqliteDb(f.dbPath);
  restored.exec("PRAGMA user_version = 1");
  restored.close();
  fs.unlinkSync(`${f.dbPath}.meta.json`);
  await assert.rejects(() => prepareClientDbSecurity(input), { code: "CLIENT_DB_STORAGE_OWNERSHIP_UNKNOWN" });
  assert.equal(f.networkCalls(), 0);
});

test("desktop storage does not claim account databases", async (t) => {
  const f = fixture(t);
  const input = await localContext();
  fs.writeFileSync(`${f.dbPath}.meta.json`, JSON.stringify({ schemaVersion: 2, storageMode: "plain_sqlite", accountNamespace: "acct_existingOwner", migrationState: "ready" }), "utf8");
  await assert.rejects(() => prepareClientDbSecurity(input), { code: "CLIENT_DB_STORAGE_OWNERSHIP_MISMATCH" });
  assert.equal(fs.existsSync(f.dbPath), false);
  assert.equal(f.networkCalls(), 0);
});

test("desktop identity is read from the shell and never recreated or registered", async (t) => {
  const f = fixture(t);
  const input = await localContext();
  const identityPath = path.join(f.directory, "device-identity.json");
  assert.deepEqual(await prepareClientDeviceIdentity(input), { deviceId: f.deviceId, authMode: "local" });
  fs.writeFileSync(identityPath, JSON.stringify({ deviceId: "------------------------------------", createdAt: "2026-10-24" }), "utf8");
  await assert.rejects(() => prepareClientDeviceIdentity(input), { code: "DESKTOP_DEVICE_IDENTITY_INVALID" });
  fs.unlinkSync(identityPath);
  await assert.rejects(() => prepareClientDeviceIdentity(input), /ENOENT/);
  assert.equal(fs.existsSync(identityPath), false);
  assert.equal(f.networkCalls(), 0);
});

test("reinstalled shell identity does not change retained SQLite ownership", async (t) => {
  const f = fixture(t);
  const input = await localContext();
  await prepareClientDbSecurity(input);
  const db = openSqliteDb(f.dbPath);
  db.exec("PRAGMA user_version = 1");
  db.close();
  confirmPlainClientDbInitialized({ dbPath: f.dbPath, accountNamespace: null, storageScope: "local_user" });
  const replacement = crypto.randomUUID();
  fs.writeFileSync(path.join(f.directory, "device-identity.json"), JSON.stringify({ deviceId: replacement, createdAt: "2026-10-24T01:00:00.000Z" }), "utf8");
  await prepareClientDbSecurity(input);
  assert.deepEqual(await prepareClientDeviceIdentity(input), { deviceId: replacement, authMode: "local" });
  assert.equal(readClientConfig({ desktop: true }).clientId, input.config.clientId);
  assert.equal(f.networkCalls(), 0);
});

test("desktop storage preserves corrupt metadata or SQLite instead of replacing them", async (t) => {
  const f = fixture(t);
  const input = await localContext();
  await prepareClientDbSecurity(input);
  const metaPath = `${f.dbPath}.meta.json`;
  const pendingMeta = fs.readFileSync(metaPath, "utf8");
  fs.writeFileSync(metaPath, "{broken", "utf8");
  await assert.rejects(() => prepareClientDbSecurity(input), SyntaxError);
  assert.equal(fs.readFileSync(metaPath, "utf8"), "{broken");
  fs.writeFileSync(metaPath, pendingMeta, "utf8");
  fs.writeFileSync(f.dbPath, "encrypted-or-corrupt-data", "utf8");
  await assert.rejects(() => prepareClientDbSecurity(input), { code: "CLIENT_DB_STORAGE_FORMAT_MISMATCH" });
  assert.equal(fs.readFileSync(f.dbPath, "utf8"), "encrypted-or-corrupt-data");
  assert.equal(f.networkCalls(), 0);
});
