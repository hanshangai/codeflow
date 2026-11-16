import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openClientDb } from "../src/db/clientDb.js";
import { CLIENT_DB_SCHEMA_VERSION } from "../src/db/migrateClientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";

/** 模拟旧版库：重新建 notes 表并回退到 v100，验证 v101 物理清理。 */
function seedLegacyNotes(dbPath: string): void {
  const db = openSqliteDb(dbPath, { fileMustExist: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_workspace ON notes(workspace_id, updated_at DESC);
      INSERT INTO notes (id, workspace_id, title, content, created_at, updated_at)
        VALUES ('legacy-note', 'legacy-workspace', '旧笔记', '历史内容', 1, 1);
      PRAGMA user_version = 100;
    `);
  } finally {
    db.close();
  }
}

/** 只读核对 notes 表与索引已被物理删除，且版本已升级。 */
function assertNotesRemoved(dbPath: string): void {
  const db = openSqliteDb(dbPath, { fileMustExist: true, readonly: true });
  try {
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'notes'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_notes_workspace'").get(), undefined);
    assert.equal(Number(db.pragma("user_version", { simple: true })), CLIENT_DB_SCHEMA_VERSION);
  } finally {
    db.close();
  }
}

test("v101 物理删除应用库与工作区库中的旧 notes 表", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDbPath = path.join(root, "application.db");
  const workspaceDirectory = path.join(root, "workspace");
  const workspaceId = "notes-cleanup:workspace";
  fs.mkdirSync(workspaceDirectory);

  let db = openClientDb({ dbPath: appDbPath });
  db.workspaces.upsert({ id: workspaceId as never, title: "笔记清理", path: workspaceDirectory });
  db.forWorkspace(workspaceId as never);
  db.close();

  const workspaceDbPath = path.join(workspaceDirectory, ".codeflowai", "workspace.db");
  seedLegacyNotes(appDbPath);
  seedLegacyNotes(workspaceDbPath);

  db = openClientDb({ dbPath: appDbPath });
  db.forWorkspace(workspaceId as never);
  db.close();

  assertNotesRemoved(appDbPath);
  assertNotesRemoved(workspaceDbPath);
});
