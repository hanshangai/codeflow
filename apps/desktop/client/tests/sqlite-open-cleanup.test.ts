import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openSqliteDb } from "../src/db/sqliteDb.js";

for (const closeFails of [false, true]) {
  test(`SQLite initialization failure closes its native connection${closeFails ? " and preserves cleanup failure" : ""}`, (t) => {
    const primary = new Error("busy timeout initialization failed");
    const cleanup = new Error("native close failed");
    const exec = DatabaseSync.prototype.exec;
    const close = DatabaseSync.prototype.close;
    let connection: DatabaseSync | undefined;
    t.after(() => { if (connection?.isOpen) close.call(connection); });
    t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("PRAGMA busy_timeout =")) { connection = this; throw primary; }
      return exec.call(this, sql);
    });
    if (closeFails) {
      t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
        close.call(this);
        throw cleanup;
      });
    }

    assert.throws(() => openSqliteDb(":memory:"), (error: unknown) => {
      if (!closeFails) return error === primary;
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.includes(primary));
      assert.ok(error.errors.includes(cleanup));
      return true;
    });
    assert.ok(connection);
    assert.equal(connection.isOpen, false);
    assert.throws(() => connection!.prepare("SELECT 1"), { code: "ERR_INVALID_STATE" });
  });
}

test("successful SQLite initialization keeps the connection usable and preserves the configured timeout", () => {
  const db = openSqliteDb(":memory:", { busyTimeoutMs: 1234 });
  try {
    assert.equal(db.pragma("busy_timeout", { simple: true }), 1234);
    db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('history');");
    assert.deepEqual(db.prepare("SELECT value FROM retained").get(), { value: "history" });
  } finally { db.close(); }
});

test("SQLite initialization hands a genuinely unclosed connection to its existing owner", t => {
  const original = new Error("initialization failed"), closing = new Error("close not performed"), nativeClose = DatabaseSync.prototype.close;
  let connection: DatabaseSync | undefined, cleanup: (() => void) | undefined;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync) { connection = this; throw original; });
  t.mock.method(DatabaseSync.prototype, "close", () => { throw closing; });
  t.after(() => { if (connection?.isOpen) nativeClose.call(connection); });
  assert.throws(() => openSqliteDb(":memory:", { onInitializationCleanupFailure: (close: () => void) => { cleanup = close; } } as any), error => {
    assert.ok(error instanceof AggregateError); assert.ok(error.errors.includes(original)); assert.ok(error.errors.includes(closing)); return true;
  });
  assert.equal(connection?.isOpen, true); assert.equal(typeof cleanup, "function");
  t.mock.restoreAll(); cleanup!(); assert.equal(connection?.isOpen, false);
});
