import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.js";

/** 每个用例使用独立内存库，验证事务边界而不触碰业务数据库。 */
function fixture(t: test.TestContext): SqliteDb {
  const db = openSqliteDb(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE items(value TEXT NOT NULL)");
  return db;
}

test("transaction options select BEGIN IMMEDIATE while the default stays deferred", (t) => {
  const db = fixture(t);
  const statements: string[] = [];
  const originalExec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    statements.push(sql);
    return originalExec.call(this, sql);
  });

  db.transaction(() => db.exec("INSERT INTO items VALUES ('deferred')"))();
  db.transaction(() => db.exec("INSERT INTO items VALUES ('immediate')"), { mode: "immediate" })();

  assert.deepEqual(statements, [
    "BEGIN",
    "INSERT INTO items VALUES ('deferred')",
    "COMMIT",
    "BEGIN IMMEDIATE",
    "INSERT INTO items VALUES ('immediate')",
    "COMMIT",
  ]);
});

test("immediate acquires the write lock before the callback and releases it after commit", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-transaction-lock-"));
  const first = openSqliteDb(path.join(directory, "test.db"), { busyTimeoutMs: 0 });
  const second = openSqliteDb(path.join(directory, "test.db"), { busyTimeoutMs: 0 });
  t.after(() => { second.close(); first.close(); fs.rmSync(directory, { recursive: true }); });
  first.exec("CREATE TABLE items(value TEXT NOT NULL)");

  first.transaction(() => {
    second.prepare("INSERT INTO items VALUES ('deferred-contender')").run();
  })();
  first.transaction(() => {
    assert.throws(() => second.prepare("INSERT INTO items VALUES ('blocked')").run(),
      (error: unknown) => error instanceof Error
        && (error as Error & { errcode?: number }).errcode === 5);
  }, { mode: "immediate", requireOutermost: true })();
  second.prepare("INSERT INTO items VALUES ('after-commit')").run();
  assert.deepEqual(first.prepare("SELECT value FROM items ORDER BY rowid").all(), [
    { value: "deferred-contender" }, { value: "after-commit" },
  ]);
});

test("exclusive 在业务回调前排除独立reader，提交后读写恢复", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-exclusive-lock-"));
  const first = openSqliteDb(path.join(directory, "test.db"), { busyTimeoutMs: 0 });
  const reader = openSqliteDb(path.join(directory, "test.db"), { readonly: true, busyTimeoutMs: 0 });
  t.after(() => { reader.close(); first.close(); fs.rmSync(directory, { recursive: true }); });
  first.exec("CREATE TABLE items(value TEXT NOT NULL)");
  reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) FROM items").get();
  let calls = 0;
  assert.throws(first.transaction(() => { calls++; }, { mode: "exclusive", requireOutermost: true }),
    (error: any) => error.errcode === 5);
  assert.equal(calls, 0);
  reader.exec("ROLLBACK");
  first.transaction(() => {
    calls++;
    assert.throws(() => reader.prepare("SELECT COUNT(*) FROM items").get(), (error: any) => error.errcode === 5);
    first.prepare("INSERT INTO items VALUES ('once')").run();
  }, { mode: "exclusive", requireOutermost: true })();
  assert.equal(calls, 1);
  assert.deepEqual(reader.prepare("SELECT value FROM items").all(), [{ value: "once" }]);
  assert.throws(() => first.transaction(() => first.transaction(() => {}, { mode: "exclusive" })())(), /SQLITE_TRANSACTION_MODE_NESTED/u);
});

test("a failed immediate BEGIN preserves the native error and leaves later transactions usable", (t) => {
  const db = fixture(t);
  const nativeExec = DatabaseSync.prototype.exec;
  const failure = Object.assign(new Error("write lock unavailable"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  let callbacks = 0;
  const exec = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") throw failure;
    return nativeExec.call(this, sql);
  });
  assert.throws(() => db.transaction(() => { callbacks++; }, { mode: "immediate", requireOutermost: true })(),
    error => error === failure);
  assert.equal(callbacks, 0);
  exec.mock.restore();
  db.transaction(() => db.exec("INSERT INTO items VALUES ('after-begin-failure')"), { mode: "immediate", requireOutermost: true })();
  assert.deepEqual(db.prepare("SELECT value FROM items").all(), [{ value: "after-begin-failure" }]);
});

test("rejecting nested options leaves the caller's transaction and ordinary savepoints usable", (t) => {
  const db = fixture(t);
  const guarded = db.transaction((value: string) => db.prepare("INSERT INTO items VALUES (?)").run(value),
    { requireOutermost: true });
  db.transaction(() => {
    db.exec("INSERT INTO items VALUES ('outer')");
    assert.throws(() => guarded("rejected"), { message: "SQLITE_TRANSACTION_ALREADY_ACTIVE" });
    assert.throws(() => db.transaction(() => undefined, { mode: "immediate" })(), { message: "SQLITE_TRANSACTION_MODE_NESTED" });
    db.transaction(() => db.exec("INSERT INTO items VALUES ('savepoint')"))();
  }, { mode: "immediate" })();
  guarded("later-outermost");
  assert.deepEqual(db.prepare("SELECT value FROM items ORDER BY rowid").all(), [
    { value: "outer" }, { value: "savepoint" }, { value: "later-outermost" },
  ]);
});

test("nested immediate transaction fails before opening a savepoint", (t) => {
  const db = fixture(t);
  assert.throws(
    () => db.transaction(() => {
      db.transaction(() => undefined, { mode: "immediate" })();
    })(),
    (error: unknown) => error instanceof Error
      && error.message === "SQLITE_TRANSACTION_MODE_NESTED"
      && (error as Error & { code?: string }).code === "SQLITE_TRANSACTION_MODE_NESTED",
  );
  assert.deepEqual(db.prepare("SELECT value FROM items").all(), []);
});

test("requireOutermost rejects an ambient transaction and leaves it usable", (t) => {
  const db = fixture(t);
  assert.throws(
    () => db.transaction(() => {
      db.transaction(() => undefined, { requireOutermost: true })();
    })(),
    (error: unknown) => error instanceof Error
      && error.message === "SQLITE_TRANSACTION_ALREADY_ACTIVE"
      && (error as Error & { code?: string }).code === "SQLITE_TRANSACTION_ALREADY_ACTIVE",
  );
  db.transaction(() => db.exec("INSERT INTO items VALUES ('after')"))();
  assert.deepEqual(db.prepare("SELECT value FROM items").all(), [{ value: "after" }]);
});

test("requireOutermost immediate transaction rolls back its own work on failure", (t) => {
  const db = fixture(t);
  const failure = new Error("asset group failed");
  assert.throws(
    () => db.transaction(() => {
      db.exec("INSERT INTO items VALUES ('discarded')");
      throw failure;
    }, { mode: "immediate", requireOutermost: true })(),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(db.prepare("SELECT value FROM items").all(), []);
});
