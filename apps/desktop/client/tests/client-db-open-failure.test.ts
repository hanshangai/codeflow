import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openClientDb, quarantineInvalidPlainSqliteSidecarsForRetry } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { logger } from "../src/logger.js";

/** 合成 sidecar 必须在首次 application_id 读取前注入故障，避免原生关闭先处理它们。 */
function fixture(t: test.TestContext) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, "codeflow-db-open-failure-"));
  t.after(() => {
    assert.equal(path.dirname(root), tempRoot);
    assert.ok(path.basename(root).startsWith("codeflow-db-open-failure-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dbPath = path.join(root, "client.db");
  const db = openSqliteDb(dbPath);
  try { db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('history');"); }
  finally { db.close(); }
  fs.writeFileSync(`${dbPath}-wal`, "invalid-wal-marker", "utf8");
  fs.writeFileSync(`${dbPath}-shm`, "invalid-shm-marker", "utf8");
  return { root, dbPath };
}

/** 展开聚合错误，仅用于核对原始失败对象仍可追踪。 */
function failures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(failures) : [error];
}

test("initial migration close failure preserves both errors and stops sidecar quarantine", (t) => {
  const { root, dbPath } = fixture(t);
  const primary = Object.assign(new Error("initial migration failed"), { code: "ERR_SQLITE_ERROR", errcode: 26 });
  const cleanup = new Error("initial close failed");
  const prepare = DatabaseSync.prototype.prepare;
  const close = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA application_id") throw primary;
    return prepare.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    close.call(this);
    throw cleanup;
  });
  assert.throws(() => openClientDb({ dbPath }), (error: unknown) => {
    assert.ok(failures(error).includes(primary));
    assert.ok(failures(error).includes(cleanup));
    return true;
  });
  assert.deepEqual(fs.readdirSync(root).sort(), ["client.db", "client.db-shm", "client.db-wal"]);
  assert.equal(fs.readFileSync(`${dbPath}-wal`, "utf8"), "invalid-wal-marker");
  assert.equal(fs.readFileSync(`${dbPath}-shm`, "utf8"), "invalid-shm-marker");
});

test("retry close failure stops restoration and retains original quarantined bytes", (t) => {
  const { root, dbPath } = fixture(t);
  const primary = Object.assign(new Error("initial migration failed"), { code: "ERR_SQLITE_ERROR", errcode: 26 });
  const retry = new Error("retry migration failed");
  const cleanup = new Error("retry close failed");
  const prepare = DatabaseSync.prototype.prepare;
  const close = DatabaseSync.prototype.close;
  let attempts = 0;
  let closes = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA application_id") throw ++attempts === 1 ? primary : retry;
    return prepare.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    close.call(this);
    if (++closes === 2) throw cleanup;
  });
  assert.throws(() => openClientDb({ dbPath }), (error: unknown) => {
    assert.ok(failures(error).includes(retry));
    assert.ok(failures(error).includes(cleanup));
    return true;
  });
  const names = fs.readdirSync(root);
  for (const suffix of ["wal", "shm"]) {
    assert.equal(fs.existsSync(`${dbPath}-${suffix}`), false);
    const quarantined = names.find((name) => name.startsWith(`client.db-${suffix}.invalid-`));
    assert.ok(quarantined);
    assert.equal(fs.readFileSync(path.join(root, quarantined), "utf8"), `invalid-${suffix}-marker`);
  }
});

test("retry restoration failure remains visible alongside the migration error", (t) => {
  const { dbPath } = fixture(t);
  const primary = Object.assign(new Error("initial migration failed"), { code: "ERR_SQLITE_ERROR", errcode: 26 });
  const retry = new Error("retry migration failed");
  const restore = Object.assign(new Error("restore permission denied"), { code: "EACCES" });
  const prepare = DatabaseSync.prototype.prepare;
  const rename = fs.renameSync;
  let attempts = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA application_id") throw ++attempts === 1 ? primary : retry;
    return prepare.call(this, sql);
  });
  t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(source).includes(".invalid-")) throw restore;
    return rename(source, target);
  });
  assert.throws(() => openClientDb({ dbPath }), (error: unknown) => {
    assert.ok(failures(error).includes(retry));
    assert.ok(failures(error).includes(restore));
    return true;
  });
});

test("partial quarantine failure restores sidecars already moved by this attempt", (t) => {
  const { root, dbPath } = fixture(t);
  const failure = Object.assign(new Error("second sidecar rename denied"), { code: "EACCES" });
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(source) === `${dbPath}-shm`) throw failure;
    return rename(source, target);
  });
  assert.throws(() => quarantineInvalidPlainSqliteSidecarsForRetry(dbPath), (error: unknown) => error === failure);
  assert.deepEqual(fs.readdirSync(root).sort(), ["client.db", "client.db-shm", "client.db-wal"]);
  assert.equal(fs.readFileSync(`${dbPath}-wal`, "utf8"), "invalid-wal-marker");
});

test("successful retry keeps history and retains the original quarantined evidence", (t) => {
  const { root, dbPath } = fixture(t);
  const primary = Object.assign(new Error("initial migration failed"), { code: "ERR_SQLITE_ERROR", errcode: 26 });
  const warnings: Record<string, unknown>[] = [];
  const outcomes: Record<string, unknown>[] = [];
  t.mock.method(logger, "warn", (_tag: string, _message: string, data: Record<string, unknown>) => { warnings.push(data); });
  t.mock.method(logger, "info", (_tag: string, _message: string, data: Record<string, unknown>) => { outcomes.push(data); });
  const prepare = DatabaseSync.prototype.prepare;
  let first = true;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (first && sql === "PRAGMA application_id") { first = false; throw primary; }
    return prepare.call(this, sql);
  });
  const db = openClientDb({ dbPath });
  try {
    assert.deepEqual(db.db.prepare("SELECT value FROM retained").all(), [{ value: "history" }]);
    assert.equal(db.db.pragma("integrity_check", { simple: true }), "ok");
  } finally { db.close(); }
  assert.equal(warnings.length, 1);
  const warning = warnings[0];
  assert.equal(warning.errorCode, "CLIENT_DB_SIDECAR_RETRY");
  assert.match(String(warning.requestId), /^client-db-open:[0-9]+:[a-f0-9-]{36}$/);
  assert.equal(warning.dbPath, dbPath);
  assert.equal(warning.retryAttempt, 1);
  assert.equal(warning.maxRetries, 1);
  assert.deepEqual(warning.rootCause, { code: "ERR_SQLITE_ERROR", errcode: 26, message: "initial migration failed" });
  assert.equal(warning.sidecarValidity, "unverified");
  assert.equal(warning.impact, "wal_only_committed_transactions_may_be_unavailable");
  assert.equal(warning.manualRecoveryGuide, "docs/superpowers/plans/2026-10-27-client-db-open-failure.md#manual-recovery");
  assert.deepEqual(warning.event, { category: "database", action: "sidecar_retry", outcome: "start" });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].requestId, warning.requestId);
  assert.deepEqual(outcomes[0].event, { category: "database", action: "sidecar_retry", outcome: "success" });
  assert.equal(outcomes[0].dataRecoveryVerified, false);
  const sidecars = warning.sidecars as { from: string; to: string }[];
  assert.equal(sidecars.length, 2);
  for (const suffix of ["wal", "shm"]) {
    const quarantined = fs.readdirSync(root).find((name) => name.startsWith(`client.db-${suffix}.invalid-`));
    assert.ok(quarantined);
    assert.equal(fs.readFileSync(path.join(root, quarantined), "utf8"), `invalid-${suffix}-marker`);
    assert.deepEqual(sidecars.find((item) => item.from === `${dbPath}-${suffix}`), { from: `${dbPath}-${suffix}`, to: path.join(root, quarantined) });
  }
});

test("failed retry closes its connection before restoring every sidecar", (t) => {
  const { root, dbPath } = fixture(t);
  const primary = Object.assign(new Error("initial migration failed"), { code: "ERR_SQLITE_ERROR", errcode: 26 });
  const retry = Object.assign(new Error("retry migration failed"), { code: "ERR_SQLITE_ERROR", errcode: 26 });
  const prepare = DatabaseSync.prototype.prepare;
  const close = DatabaseSync.prototype.close;
  const rename = fs.renameSync;
  const warnings: Record<string, unknown>[] = [];
  const outcomes: unknown[] = [];
  t.mock.method(logger, "warn", (_tag: string, _message: string, data: Record<string, unknown>) => { warnings.push(data); });
  t.mock.method(logger, "info", (_tag: string, _message: string, data: unknown) => { outcomes.push(data); });
  let attempts = 0;
  let closes = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA application_id") throw ++attempts === 1 ? primary : retry;
    return prepare.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) { close.call(this); closes += 1; });
  t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(source).includes(".invalid-")) assert.equal(closes, 2);
    return rename(source, target);
  });
  assert.throws(() => openClientDb({ dbPath }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "CLIENT_DB_SIDECAR_RETRY_FAILED");
    assert.deepEqual(failures(error), [primary, retry]);
    assert.equal(error.cause, retry);
    assert.equal((error as AggregateError & { requestId?: string }).requestId, warnings[0]?.requestId);
    return true;
  });
  assert.equal(attempts, 2);
  assert.equal(warnings.length, 1);
  assert.equal(outcomes.length, 0);
  assert.deepEqual(fs.readdirSync(root).sort(), ["client.db", "client.db-shm", "client.db-wal"]);
  for (const suffix of ["wal", "shm"]) assert.equal(fs.readFileSync(`${dbPath}-${suffix}`, "utf8"), `invalid-${suffix}-marker`);
});

test("restoration refuses an occupied target and preserves both versions", (t) => {
  const { root, dbPath } = fixture(t);
  const primary = Object.assign(new Error("initial migration failed"), { code: "ERR_SQLITE_ERROR", errcode: 26 });
  const retry = new Error("retry migration failed");
  const prepare = DatabaseSync.prototype.prepare;
  let attempts = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA application_id") {
      if (++attempts === 1) throw primary;
      fs.writeFileSync(`${dbPath}-shm`, "new-sidecar-do-not-overwrite", "utf8");
      throw retry;
    }
    return prepare.call(this, sql);
  });
  assert.throws(() => openClientDb({ dbPath }), (error: unknown) => {
    assert.ok(failures(error).includes(retry));
    assert.ok(failures(error).some((cause) => cause instanceof Error && (cause as NodeJS.ErrnoException).code === "EEXIST"));
    return true;
  });
  assert.equal(fs.readFileSync(`${dbPath}-shm`, "utf8"), "new-sidecar-do-not-overwrite");
  const original = fs.readdirSync(root).find((name) => name.startsWith("client.db-shm.invalid-"));
  assert.ok(original);
  assert.equal(fs.readFileSync(path.join(root, original), "utf8"), "invalid-shm-marker");
});

test("partial quarantine rollback failure retains the move and rollback errors", (t) => {
  const { root, dbPath } = fixture(t);
  const move = Object.assign(new Error("second move denied"), { code: "EACCES" });
  const restore = Object.assign(new Error("rollback denied"), { code: "EACCES" });
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(source) === `${dbPath}-shm`) throw move;
    if (String(source).includes(".invalid-")) throw restore;
    return rename(source, target);
  });
  assert.throws(() => quarantineInvalidPlainSqliteSidecarsForRetry(dbPath), (error: unknown) => {
    assert.ok(failures(error).includes(move));
    assert.ok(failures(error).includes(restore));
    return true;
  });
  assert.equal(fs.readFileSync(`${dbPath}-shm`, "utf8"), "invalid-shm-marker");
  const original = fs.readdirSync(root).find((name) => name.startsWith("client.db-wal.invalid-"));
  assert.ok(original);
  assert.equal(fs.readFileSync(path.join(root, original), "utf8"), "invalid-wal-marker");
});

for (const errcode of [5, undefined]) {
  test(`SQLite error text does not trigger recovery without NOTADB errcode (${String(errcode)})`, (t) => {
    const { root, dbPath } = fixture(t);
    const primary = Object.assign(new Error("diagnostic context: file is not a database"), { code: "ERR_SQLITE_ERROR", errcode });
    const prepare = DatabaseSync.prototype.prepare;
    let first = true;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (first && sql === "PRAGMA application_id") { first = false; throw primary; }
      return prepare.call(this, sql);
    });
    assert.throws(() => openClientDb({ dbPath }), (error: unknown) => error === primary);
    assert.deepEqual(fs.readdirSync(root).sort(), ["client.db", "client.db-shm", "client.db-wal"]);
    for (const suffix of ["wal", "shm"]) assert.equal(fs.readFileSync(`${dbPath}-${suffix}`, "utf8"), `invalid-${suffix}-marker`);
  });
}

test("native SQLite NOTADB failures expose the numeric recovery discriminator", (t) => {
  const { dbPath } = fixture(t);
  fs.writeFileSync(dbPath, "invalid-database-without-sqlite-header", "utf8");
  assert.throws(() => openClientDb({ dbPath }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, "ERR_SQLITE_ERROR");
    assert.equal((error as Error & { errcode?: number }).errcode, 26);
    return true;
  });
  assert.equal(fs.readFileSync(dbPath, "utf8"), "invalid-database-without-sqlite-header");
});
