import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { quarantineInvalidPlainSqliteSidecarsForRetry } from "../../apps/desktop/client/src/db/clientDb.ts";


test("plain client db opener can quarantine invalid sqlite sidecars", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-client-sidecar-recovery-"));
  const dbPath = path.join(tempDir, "client.db");
  try {
    fs.writeFileSync(dbPath, Buffer.concat([
      Buffer.from("SQLite format 3\0", "utf8"),
      Buffer.alloc(512),
    ]));
    fs.writeFileSync(`${dbPath}-wal`, Buffer.from("invalid wal"));
    fs.writeFileSync(`${dbPath}-shm`, Buffer.from("invalid shm"));

    const quarantined = quarantineInvalidPlainSqliteSidecarsForRetry(dbPath);

    assert.equal(quarantined.length, 2);
    assert.equal(fs.existsSync(`${dbPath}-wal`), false);
    assert.equal(fs.existsSync(`${dbPath}-shm`), false);
    for (const item of quarantined) {
      assert.equal(fs.existsSync(item.to), true);
      assert.equal(path.dirname(item.to), tempDir);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
