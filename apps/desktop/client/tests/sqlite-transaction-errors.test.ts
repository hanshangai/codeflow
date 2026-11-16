import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openSqliteDb } from "../src/db/sqliteDb.js";

/** 每个用例独占真实内存库，退出时关闭，不访问业务文件。 */
function fixture(t: test.TestContext) {
  const db = openSqliteDb(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE items(value TEXT NOT NULL)");
  return db;
}

/** 双故障必须保留原对象与因果关系，供处理边界检索结构化上下文。 */
function assertRollbackFailure(error: unknown, primary: unknown, rollback: Error): boolean {
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, "SQLITE_TRANSACTION_ROLLBACK_FAILED");
  assert.equal((error as AggregateError & { code?: string }).code, "SQLITE_TRANSACTION_ROLLBACK_FAILED");
  assert.deepEqual(error.errors, [primary, rollback]);
  assert.equal(error.errors[0], primary);
  assert.equal(error.errors[1], rollback);
  assert.equal(error.cause, primary);
  return true;
}

test("failed outer rollback preserves the business error and rollback error objects", (t) => {
  const db = fixture(t);
  const primary = Object.assign(new Error("business failed"), {
    code: "BUSINESS_FAILED", requestId: "transaction-outer", entityId: "item-1", details: { operation: "save" },
  });
  const rollback = Object.assign(new Error("rollback denied"), { code: "EIO" });
  const exec = DatabaseSync.prototype.exec;
  const sqls: string[] = [];
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    sqls.push(sql);
    if (sql === "ROLLBACK") throw rollback;
    return exec.call(this, sql);
  });
  assert.throws(db.transaction(() => {
    db.exec("INSERT INTO items VALUES ('pending')");
    throw primary;
  }), (error: unknown) => assertRollbackFailure(error, primary, rollback));
  assert.deepEqual(sqls, ["BEGIN", "INSERT INTO items VALUES ('pending')", "ROLLBACK"]);
});

test("failed rollback after a native deferred constraint error retains the original SQLite diagnostics", (t) => {
  const db = fixture(t);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE parent(id INTEGER PRIMARY KEY);
    CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);`);
  const rollback = Object.assign(new Error("rollback denied"), { code: "EIO" });
  const exec = DatabaseSync.prototype.exec;
  let commitError: unknown;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "ROLLBACK") throw rollback;
    try { return exec.call(this, sql); }
    catch (error) { if (sql === "COMMIT") commitError = error; throw error; }
  });
  assert.throws(db.transaction(() => {
    db.exec("INSERT INTO child VALUES (999)");
  }), (error: unknown) => {
    assert.ok(commitError instanceof Error);
    assert.equal((commitError as Error & { code?: string }).code, "ERR_SQLITE_ERROR");
    assert.equal((commitError as Error & { errcode?: number }).errcode, 787);
    return assertRollbackFailure(error, commitError, rollback);
  });
});

for (const failedSql of ["ROLLBACK TO SAVEPOINT cf_tx_1", "RELEASE SAVEPOINT cf_tx_1"]) {
  test(`nested cleanup failure preserves both errors and rolls back its outer transaction (${failedSql})`, (t) => {
    const db = fixture(t);
    const primary = Object.assign(new Error("nested business failed"), { code: "NESTED_FAILED", requestId: "transaction-nested" });
    const rollback = Object.assign(new Error("savepoint cleanup failed"), { code: "EIO" });
    const exec = DatabaseSync.prototype.exec;
    const sqls: string[] = [];
    t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      sqls.push(sql);
      if (sql === failedSql) throw rollback;
      return exec.call(this, sql);
    });
    assert.throws(db.transaction(() => {
      db.exec("INSERT INTO items VALUES ('outer')");
      db.transaction(() => {
        db.exec("INSERT INTO items VALUES ('inner')");
        throw primary;
      })();
    }), (error: unknown) => assertRollbackFailure(error, primary, rollback));
    assert.equal(sqls.at(-1), "ROLLBACK");
    assert.equal(sqls.includes("COMMIT"), false);
    assert.deepEqual(db.prepare("SELECT value FROM items").all(), []);
    db.transaction(() => { db.exec("INSERT INTO items VALUES ('after-failure')"); })();
    assert.deepEqual(db.prepare("SELECT value FROM items").all(), [{ value: "after-failure" }]);
  });
}

test("successful rollback rethrows the exact business error and leaves later transactions usable", (t) => {
  const db = fixture(t);
  const primary = Object.assign(new Error("business failed"), { code: "BUSINESS_FAILED", requestId: "transaction-original" });
  assert.throws(db.transaction(() => {
    db.exec("INSERT INTO items VALUES ('discarded')");
    throw primary;
  }), (error: unknown) => error === primary);
  assert.deepEqual(db.prepare("SELECT value FROM items").all(), []);
  db.transaction(() => { db.exec("INSERT INTO items VALUES ('committed')"); })();
  assert.deepEqual(db.prepare("SELECT value FROM items").all(), [{ value: "committed" }]);
});
