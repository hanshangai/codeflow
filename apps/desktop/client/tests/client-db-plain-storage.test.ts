import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ClientConfig } from "../src/config.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { confirmPlainClientDbInitialized, prepareClientDbSecurity, prepareClientDeviceIdentity, resolveClientDbStartupContext } from "../src/security/clientDbSecurity.js";

/** 普通账号库只使用隔离测试目录，不读取旧 Client 目录或系统凭据。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-plain-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "client.db");
  const startupContext = { accountNamespace: "acct_plainStorageTest", dbPath, explicitDbPath: true };
  return { root, dbPath, startupContext, clientVersion: "1.0.0", config: { clientId: "test-client", serverWsUrl: "ws://localhost:39280/ws/client", apiKey: "test-api-key" } as ClientConfig };
}

test("plain storage creates runtime metadata without migration or encryption fields", async (t) => {
  const input = fixture(t);
  await prepareClientDbSecurity(input);
  const meta = JSON.parse(fs.readFileSync(`${input.dbPath}.meta.json`, "utf8"));
  assert.equal(meta.storageMode, "plain_sqlite");
  assert.equal(meta.deviceAuthMode, "runtime");
  assert.equal(meta.migratedFrom, undefined);
  assert.equal(meta.migrationState, undefined);
  const db = openSqliteDb(input.dbPath);
  db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('history')");
  db.close();
  confirmPlainClientDbInitialized({ dbPath: input.dbPath, accountNamespace: input.startupContext.accountNamespace });
  await prepareClientDbSecurity(input);
  const reopened = openSqliteDb(input.dbPath, { readonly: true });
  try { assert.deepEqual(reopened.prepare("SELECT value FROM retained").get(), { value: "history" }); }
  finally { reopened.close(); }
});

test("plain startup context no longer requests or returns legacy database metadata", async (t) => {
  const input = fixture(t);
  let body: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ ok: true, accountNamespace: "acct_plainStorageTest", serverNow: 1 }));
  });
  const context = await resolveClientDbStartupContext(input);
  assert.equal(body?.legacyDbId, undefined);
  assert.equal(Object.hasOwn(context, "legacyDb"), false);
});

test("plain device registration reuses runtime identity without creating private keys", async (t) => {
  const input = fixture(t);
  await prepareClientDbSecurity(input);
  const calls: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true }));
  });
  const first = await prepareClientDeviceIdentity(input);
  const second = await prepareClientDeviceIdentity(input);
  assert.deepEqual(second, first);
  assert.equal(first.authMode, "runtime");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.devicePublicKey, undefined);
});

test("plain storage preserves unsupported metadata and never creates a replacement database", async (t) => {
  const input = fixture(t);
  const original = JSON.stringify({ schemaVersion: 1, storageMode: "unsupported" });
  fs.writeFileSync(`${input.dbPath}.meta.json`, original, "utf8");
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network access"); });
  await assert.rejects(() => prepareClientDbSecurity(input), { code: "CLIENT_DB_STORAGE_META_UNSUPPORTED" });
  assert.equal(fs.readFileSync(`${input.dbPath}.meta.json`, "utf8"), original);
  assert.equal(fs.existsSync(input.dbPath), false);
});

for (const response of [
  { status: 403, body: JSON.stringify({ ok: false, code: "FORBIDDEN", message: "secret-echo-test-api-key" }) },
  { status: 502, body: "upstream secret-echo-test-api-key unavailable" },
  { status: 200, body: "malformed secret-echo-test-api-key" },
]) {
  test(`plain startup API fails safely without echoing response content (${response.status})`, async (t) => {
    const input = fixture(t);
    t.mock.method(globalThis, "fetch", async () => new Response(response.body, { status: response.status, headers: { "x-request-id": "startup-request-1" } }));
    await assert.rejects(() => resolveClientDbStartupContext(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, "CLIENT_DB_STARTUP_API_FAILED");
      assert.match(error.message, /startup-context/);
      assert.match(error.message, new RegExp(String(response.status)));
      assert.doesNotMatch(error.message, /secret-echo|test-api-key|DB security/);
      assert.equal((error as Error & { requestId?: string }).requestId, "startup-request-1");
      return true;
    });
  });
}
