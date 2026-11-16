import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ClientConfig } from "../src/config.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import {
  confirmPlainClientDbInitialized,
  prepareClientDbSecurity,
  type ClientDbStartupContext,
} from "../src/security/clientDbSecurity.js";

type StorageScope = "desktop" | "account";

/** 只在本片独占临时根准备输入；桌面路径通过原壳环境合同传入。 */
function fixture(t: test.TestContext, scope: StorageScope) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, "codeflow-orphan-sidecar-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    assert.ok(path.basename(root).startsWith("codeflow-orphan-sidecar-"));
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
  const config: ClientConfig = {
    clientId: "orphan-sidecar-test",
    clientIdSource: "env",
    serverWsUrl: "ws://127.0.0.1:1/ws/client",
    apiKey: "",
    apiKeySource: "env",
    allowClientIdOverride: false,
    workspaces: [],
    timeoutPolicy: { mode: "legacy-turn", timeoutMs: 60_000, startupTimeoutMs: 5_000 },
    sessionIdleCleanup: { enabled: false, idleMs: 60_000, scanMs: 5_000 },
    workspacePathIndex: { maxEntries: 100, excludeDirNames: [], excludePathPrefixes: [] },
  };
  const startupContext: ClientDbStartupContext = {
    accountNamespace: scope === "account" ? "acct_orphanSidecarTest" : null,
    dbPath,
    explicitDbPath: true,
    ...(scope === "desktop" ? { storageScope: "local_user" } : {}),
  };
  return { root, input: { config, startupContext, dbPath, clientVersion: "1.0.0" } };
}

/** 直接写入未完成初始化的元数据，保留独立格式以检测意外改写。 */
function writePendingMeta(dbPath: string, scope: StorageScope): void {
  const ownership = scope === "desktop"
    ? { schemaVersion: 3, ownership: "local_os_user" }
    : { schemaVersion: 2, accountNamespace: "acct_orphanSidecarTest", deviceAuthMode: "runtime", deviceId: null };
  fs.writeFileSync(`${dbPath}.meta.json`, JSON.stringify({
    ...ownership,
    storageMode: "plain_sqlite",
    initializationState: "pending",
    preservedMarker: "原始元数据",
  }) + "\n", "utf8");
}

/** 记录隔离目录全部文件的原始字节，同时发现拒绝后新增或移走的文件。 */
function snapshot(root: string): Array<{ name: string; bytes: Buffer }> {
  return fs.readdirSync(root).sort().map((name) => ({ name, bytes: fs.readFileSync(path.join(root, name)) }));
}

for (const scope of ["desktop", "account"] as const) {
  for (const metadata of ["missing", "pending"] as const) {
    for (const sidecar of ["journal", "wal", "shm"] as const) {
      test(`${scope} storage refuses missing database with orphan ${sidecar} and ${metadata} metadata`, async (t) => {
        const { root, input } = fixture(t, scope);
        if (metadata === "pending") writePendingMeta(input.dbPath, scope);
        fs.writeFileSync(`${input.dbPath}-${sidecar}`, Buffer.from(`保留 ${sidecar} 现场\n`, "utf8"));
        const before = snapshot(root);

        await assert.rejects(() => prepareClientDbSecurity(input), { code: "CLIENT_DB_STORAGE_FILE_MISSING" });

        assert.equal(fs.existsSync(input.dbPath), false);
        assert.equal(fs.existsSync(`${input.dbPath}.meta.json`), metadata === "pending");
        assert.deepEqual(snapshot(root), before);
      });
    }

    test(`${scope} storage initializes missing database with ${metadata} metadata and no sidecars`, async (t) => {
      const { root, input } = fixture(t, scope);
      if (metadata === "pending") writePendingMeta(input.dbPath, scope);
      const before = snapshot(root);

      await prepareClientDbSecurity(input);

      assert.equal(fs.existsSync(input.dbPath), false);
      assert.deepEqual(fs.readdirSync(root), ["client.db.meta.json"]);
      if (metadata === "pending") assert.deepEqual(snapshot(root), before);
      assert.equal(JSON.parse(fs.readFileSync(`${input.dbPath}.meta.json`, "utf8")).initializationState, "pending");
      const db = openSqliteDb(input.dbPath);
      try { db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('history')"); }
      finally { db.close(); }
      confirmPlainClientDbInitialized({
        dbPath: input.dbPath,
        accountNamespace: input.startupContext.accountNamespace,
        storageScope: input.startupContext.storageScope,
      });
      assert.equal(JSON.parse(fs.readFileSync(`${input.dbPath}.meta.json`, "utf8")).initializationState, "ready");
      await prepareClientDbSecurity(input);
      const reopened = openSqliteDb(input.dbPath, { readonly: true, fileMustExist: true });
      try { assert.deepEqual(reopened.prepare("SELECT value FROM retained").get(), { value: "history" }); }
      finally { reopened.close(); }
    });
  }
}
