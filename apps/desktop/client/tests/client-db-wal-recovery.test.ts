import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ClientConfig } from "../src/config.js";
import { openClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { confirmPlainClientDbInitialized, prepareClientDbSecurity, type ClientDbStartupContext } from "../src/security/clientDbSecurity.js";

type StorageScope = "desktop" | "account";

/** 仅创建独占临时库；桌面路径沿现环境合同注入并在结束时还原。 */
function fixture(t: test.TestContext, scope: StorageScope, state: "pending" | "ready") {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, "codeflow-wal-startup-"));
  t.after(() => {
    assert.equal(path.dirname(root), tempRoot);
    assert.ok(path.basename(root).startsWith("codeflow-wal-startup-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dbPath = path.join(root, "client.db");
  if (scope === "desktop") {
    const keys = ["CODEFLOWAI_CLIENT_CONFIG_PATH", "CODEFLOWAI_CLIENT_DB_PATH"] as const;
    const before = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CODEFLOWAI_CLIENT_CONFIG_PATH = path.join(root, "config.json");
    process.env.CODEFLOWAI_CLIENT_DB_PATH = dbPath;
    t.after(() => {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }
  const ownership = scope === "desktop"
    ? { schemaVersion: 3, ownership: "local_os_user" }
    : { schemaVersion: 2, accountNamespace: "acct_walStartupTest", deviceAuthMode: "runtime", deviceId: null };
  fs.writeFileSync(`${dbPath}.meta.json`, JSON.stringify({
    ...ownership, storageMode: "plain_sqlite", initializationState: state, preservedMarker: "保留原始归属",
  }) + "\n", "utf8");
  const startupContext: ClientDbStartupContext = {
    dbPath, explicitDbPath: true, accountNamespace: scope === "account" ? "acct_walStartupTest" : null,
    ...(scope === "desktop" ? { storageScope: "local_user" } : {}),
  };
  const config = { clientId: "wal-startup-test", serverWsUrl: "ws://127.0.0.1:1/ws/client", apiKey: "" } as ClientConfig;
  return { root, dbPath, input: { config, startupContext, dbPath, clientVersion: "1.0.0" } };
}

/** 子进程不关闭连接直接退出，留下真实已提交 WAL 和未提交事务。 */
function leaveWalAfterExit(dbPath: string): void {
  const result = spawnSync(process.execPath, ["--input-type=module", "-", dbPath], {
    cwd: path.dirname(dbPath),
    input: `
      import assert from 'node:assert/strict';
      import path from 'node:path';
      import { DatabaseSync } from 'node:sqlite';
      const dbPath = process.argv[2];
      assert.ok(path.isAbsolute(dbPath));
      assert.equal(path.dirname(dbPath), process.cwd());
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('base'); PRAGMA wal_checkpoint(TRUNCATE);");
      db.exec("INSERT INTO retained VALUES ('committed-in-wal'); BEGIN; INSERT INTO retained VALUES ('uncommitted');");
      process.exit(73);
    `,
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 73, result.stderr);
  assert.ok(fs.statSync(`${dbPath}-wal`).size > 32);
}

/** 精确中断真实首次 open 的首条 PRAGMA，子进程只允许在夹具根内建库。 */
function interruptFirstOpen(dbPath: string): void {
  const root = path.dirname(dbPath);
  const result = spawnSync(process.execPath, [
    "--conditions=development", "--import", import.meta.resolve("tsx"), "--input-type=module", "-",
    dbPath, new URL("../src/db/clientDb.ts", import.meta.url).href,
  ], {
    cwd: root, env: { ...process.env, CODEFLOWAI_CLIENT_LOG_DIR: path.join(root, "logs") },
    input: `
      import assert from 'node:assert/strict';
      import path from 'node:path';
      import { DatabaseSync } from 'node:sqlite';
      const dbPath = process.argv[2];
      assert.ok(path.isAbsolute(dbPath));
      assert.equal(path.dirname(dbPath), process.cwd());
      const original = DatabaseSync.prototype.exec;
      // 在原生开库之后、任何 schema 写入之前模拟进程退出。
      DatabaseSync.prototype.exec = function(sql) {
        if (sql.startsWith('PRAGMA busy_timeout =')) process.exit(77);
        return original.call(this, sql);
      };
      const { openClientDb } = await import(process.argv[3]);
      openClientDb({ dbPath });
      throw new Error('First-open interruption was not reached');
    `,
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 77, result.stderr);
  assert.equal(fs.statSync(dbPath).size, 0);
}

/** 按原适配器读取真实历史，同时核对 SQLite 完整性。 */
function readHistory(dbPath: string): unknown[] {
  const db = openSqliteDb(dbPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    return db.prepare("SELECT value FROM retained ORDER BY rowid").all();
  } finally { db.close(); }
}

for (const scope of ["desktop", "account"] as const) {
  test(`${scope} pending startup retries an empty database left by interrupted first open`, async (t) => {
    const { dbPath, input } = fixture(t, scope, "pending");
    await prepareClientDbSecurity(input);
    interruptFirstOpen(dbPath);
    const metadata = fs.readFileSync(`${dbPath}.meta.json`);

    await prepareClientDbSecurity(input);

    assert.equal(fs.statSync(dbPath).size, 0);
    assert.deepEqual(fs.readFileSync(`${dbPath}.meta.json`), metadata);
    const db = openClientDb({ dbPath });
    try {
      assert.equal(db.db.pragma("integrity_check", { simple: true }), "ok");
      assert.ok(Number(db.db.pragma("user_version", { simple: true })) > 0);
      confirmPlainClientDbInitialized({ ...input.startupContext });
    } finally { db.close(); }
    assert.equal(JSON.parse(fs.readFileSync(`${dbPath}.meta.json`, "utf8")).initializationState, "ready");
    await prepareClientDbSecurity(input);
  });

  for (const state of ["ready", "missing", "wal", "shm", "journal"] as const) {
    test(`${scope} empty database with ${state} evidence remains rejected without changes`, async (t) => {
      const { dbPath, input } = fixture(t, scope, state === "ready" ? "ready" : "pending");
      fs.writeFileSync(dbPath, Buffer.alloc(0));
      if (state === "missing") fs.unlinkSync(`${dbPath}.meta.json`);
      if (state === "wal" || state === "shm" || state === "journal") fs.writeFileSync(`${dbPath}-${state}`, "retained-sidecar", "utf8");
      const metadata = state === "missing" ? null : fs.readFileSync(`${dbPath}.meta.json`);

      await assert.rejects(() => prepareClientDbSecurity(input), {
        code: state === "missing" ? "CLIENT_DB_STORAGE_OWNERSHIP_UNKNOWN" : "CLIENT_DB_STORAGE_FORMAT_MISMATCH",
      });

      assert.equal(fs.statSync(dbPath).size, 0);
      if (metadata) assert.deepEqual(fs.readFileSync(`${dbPath}.meta.json`), metadata);
      else assert.equal(fs.existsSync(`${dbPath}.meta.json`), false);
      if (state === "wal" || state === "shm" || state === "journal") assert.equal(fs.readFileSync(`${dbPath}-${state}`, "utf8"), "retained-sidecar");
    });
  }

  test(`${scope} pending startup still rejects nonempty invalid database bytes`, async (t) => {
    const { dbPath, input } = fixture(t, scope, "pending");
    fs.writeFileSync(dbPath, "incomplete-sqlite-data", "utf8");
    const metadata = fs.readFileSync(`${dbPath}.meta.json`);
    await assert.rejects(() => prepareClientDbSecurity(input), { code: "CLIENT_DB_STORAGE_FORMAT_MISMATCH" });
    assert.equal(fs.readFileSync(dbPath, "utf8"), "incomplete-sqlite-data");
    assert.deepEqual(fs.readFileSync(`${dbPath}.meta.json`), metadata);
  });

  test(`${scope} pending startup does not initialize a hard-linked empty file`, async (t) => {
    const { root, dbPath, input } = fixture(t, scope, "pending");
    const retainedPath = path.join(root, "retained-empty.db");
    fs.writeFileSync(retainedPath, Buffer.alloc(0));
    fs.linkSync(retainedPath, dbPath);
    const metadata = fs.readFileSync(`${dbPath}.meta.json`);
    await assert.rejects(() => prepareClientDbSecurity(input), { code: "CLIENT_DB_STORAGE_FORMAT_MISMATCH" });
    assert.equal(fs.statSync(dbPath).size, 0);
    assert.equal(fs.statSync(retainedPath).size, 0);
    assert.deepEqual(fs.readFileSync(`${dbPath}.meta.json`), metadata);
  });

  for (const state of ["pending", "ready"] as const) {
    test(`${scope} ${state} startup retains committed WAL history after an abrupt process exit`, async (t) => {
      const { root, dbPath, input } = fixture(t, scope, state);
      leaveWalAfterExit(dbPath);
      const mainOnly = path.join(root, "main-only.db");
      fs.copyFileSync(dbPath, mainOnly);
      assert.deepEqual(readHistory(mainOnly), [{ value: "base" }]);
      const metadata = fs.readFileSync(`${dbPath}.meta.json`);

      await prepareClientDbSecurity(input);

      assert.deepEqual(fs.readFileSync(`${dbPath}.meta.json`), metadata);
      assert.deepEqual(readHistory(dbPath), [{ value: "base" }, { value: "committed-in-wal" }]);
      const reopened = openSqliteDb(dbPath, { fileMustExist: true });
      try { reopened.prepare("INSERT INTO retained VALUES (?)").run("after-restart"); }
      finally { reopened.close(); }
      await prepareClientDbSecurity(input);
      assert.deepEqual(readHistory(dbPath), [
        { value: "base" }, { value: "committed-in-wal" }, { value: "after-restart" },
      ]);
    });
  }

  test(`${scope} startup rejects malformed SQLite pages without replacing the database or metadata`, async (t) => {
    const { root, dbPath, input } = fixture(t, scope, "ready");
    const db = openSqliteDb(dbPath);
    try { db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('retained');"); }
    finally { db.close(); }
    const broken = fs.readFileSync(dbPath);
    assert.equal(broken.subarray(0, 16).toString("utf8"), "SQLite format 3\0");
    broken[100] = 0xff;
    fs.writeFileSync(dbPath, broken);
    const metadata = fs.readFileSync(`${dbPath}.meta.json`);
    const names = fs.readdirSync(root).sort();

    await assert.rejects(() => prepareClientDbSecurity(input), /malformed|corrupt/i);

    assert.deepEqual(fs.readFileSync(dbPath), broken);
    assert.deepEqual(fs.readFileSync(`${dbPath}.meta.json`), metadata);
    assert.deepEqual(fs.readdirSync(root).sort(), names);
  });
}

test("account pending empty database with an existing device remains rejected", async (t) => {
  const { dbPath, input } = fixture(t, "account", "pending");
  fs.writeFileSync(dbPath, Buffer.alloc(0));
  const metadata = JSON.parse(fs.readFileSync(`${dbPath}.meta.json`, "utf8"));
  fs.writeFileSync(`${dbPath}.meta.json`, JSON.stringify({ ...metadata, deviceId: "runtime_existing" }), "utf8");
  const before = fs.readFileSync(`${dbPath}.meta.json`);
  await assert.rejects(() => prepareClientDbSecurity(input), { code: "CLIENT_DB_STORAGE_FORMAT_MISMATCH" });
  assert.equal(fs.statSync(dbPath).size, 0);
  assert.deepEqual(fs.readFileSync(`${dbPath}.meta.json`), before);
});

test("account pending empty database still requires its original account namespace", async (t) => {
  const { dbPath, input } = fixture(t, "account", "pending");
  fs.writeFileSync(dbPath, Buffer.alloc(0));
  const before = fs.readFileSync(`${dbPath}.meta.json`);
  input.startupContext.accountNamespace = "acct_anotherOwner";
  await assert.rejects(() => prepareClientDbSecurity(input), { code: "CLIENT_DB_STORAGE_ACCOUNT_MISMATCH" });
  assert.equal(fs.statSync(dbPath).size, 0);
  assert.deepEqual(fs.readFileSync(`${dbPath}.meta.json`), before);
});
