import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.ts";

function withDb(fn: (db: SqliteDb) => void): void {
  const db = openSqliteDb(":memory:");
  try {
    fn(db);
  } finally {
    db.close();
  }
}

test("SqliteDb compatibility: basic statements, params, and row shape", () => {
  withDb((db) => {
    db.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        data BLOB NOT NULL
      );
    `);

    const insert = db.prepare("INSERT INTO records (name, enabled, data) VALUES (:name, :enabled, :data)");
    const result = insert.run({
      name: "alpha",
      enabled: true,
      data: Buffer.from("payload", "utf8"),
    });

    assert.equal(Number(result.changes ?? 0), 1);
    assert.equal(Number(result.lastInsertRowid ?? 0), 1);

    const row = db.prepare("SELECT id, name, enabled, data FROM records WHERE id = ?").get(1) as {
      id: number;
      name: string;
      enabled: number;
      data: Buffer;
    };
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.equal(row.id, 1);
    assert.equal(row.name, "alpha");
    assert.equal(row.enabled, 1);
    assert.equal(Buffer.isBuffer(row.data), true);
    assert.equal(row.data.toString("utf8"), "payload");

    const rows = db.prepare("SELECT name FROM records WHERE enabled = ?").all(true) as Array<{ name: string }>;
    assert.deepEqual(rows, [{ name: "alpha" }]);

    const iterated = [...db.prepare("SELECT name FROM records ORDER BY id").iterate()] as Array<{ name: string }>;
    assert.deepEqual(iterated, [{ name: "alpha" }]);

    db.exec("CREATE TABLE optional_values (value TEXT)");
    db.prepare("INSERT INTO optional_values (value) VALUES (?)").run(undefined);
    const optional = db.prepare("SELECT value FROM optional_values").get() as { value: string | null };
    assert.equal(optional.value, null);
  });
});

test("SqliteDb compatibility: PRAGMA simple and file persistence", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-sqlite-compat-"));
  const dbPath = path.join(tmpDir, "compat.db");
  try {
    const first = openSqliteDb(dbPath);
    try {
      first.pragma("user_version = 17");
      first.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      first.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run("persisted", "ok");
      assert.equal(Number(first.pragma("user_version", { simple: true }) ?? 0), 17);
    } finally {
      first.close();
    }

    const second = openSqliteDb(dbPath);
    try {
      assert.equal(Number(second.pragma("user_version", { simple: true }) ?? 0), 17);
      const row = second.prepare("SELECT value FROM kv WHERE key = ?").get("persisted") as { value: string };
      assert.equal(row.value, "ok");
    } finally {
      second.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("SqliteDb compatibility: transactions commit, rollback, and nested savepoints", () => {
  withDb((db) => {
    db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)");

    const outerCommit = db.transaction(() => {
      db.prepare("INSERT INTO items (id, value) VALUES (?, ?)").run("a", "committed");
    });
    outerCommit();
    assert.equal(countItems(db), 1);

    const outerRollback = db.transaction(() => {
      db.prepare("INSERT INTO items (id, value) VALUES (?, ?)").run("b", "rolled-back");
      throw new Error("force outer rollback");
    });
    assert.throws(() => outerRollback(), /force outer rollback/);
    assert.equal(countItems(db), 1);

    const nestedRollback = db.transaction(() => {
      db.prepare("INSERT INTO items (id, value) VALUES (?, ?)").run("c", "outer-kept");
      const inner = db.transaction(() => {
        db.prepare("INSERT INTO items (id, value) VALUES (?, ?)").run("d", "inner-rolled-back");
        throw new Error("force inner rollback");
      });
      assert.throws(() => inner(), /force inner rollback/);
    });
    nestedRollback();

    const rows = db.prepare("SELECT id, value FROM items ORDER BY id").all() as Array<{ id: string; value: string }>;
    assert.deepEqual(rows, [
      { id: "a", value: "committed" },
      { id: "c", value: "outer-kept" },
    ]);
  });
});

test("main client SQLite does not declare the SQLCipher native dependency", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies?.["better-sqlite3-multiple-ciphers"], undefined);
});

function countItems(db: SqliteDb): number {
  const row = db.prepare("SELECT COUNT(1) AS c FROM items").get() as { c: number };
  return Number(row.c ?? 0);
}
