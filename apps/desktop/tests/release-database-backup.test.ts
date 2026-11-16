import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createReleaseDatabaseBackup } from "../src/releaseDatabaseBackup.js";

test("failed candidate restores root and workspace databases without changing source", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-db-backup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "project");
  await fs.mkdir(path.join(workspace, ".codeflowai"), { recursive: true });
  const db = new DatabaseSync(path.join(root, "codeflowai.db"));
  db.exec("CREATE TABLE workspaces(path TEXT); CREATE TABLE version(v INTEGER); INSERT INTO version VALUES(1)");
  db.prepare("INSERT INTO workspaces VALUES(?)").run(workspace); db.close();
  const workspaceDb = path.join(workspace, ".codeflowai", "workspace.db");
  const local = new DatabaseSync(workspaceDb); local.exec("CREATE TABLE version(v INTEGER); INSERT INTO version VALUES(1)"); local.close();
  await fs.writeFile(path.join(workspace, "source.ts"), "source");
  const backup = createReleaseDatabaseBackup(root);
  await backup.prepare("next");
  for (const file of [path.join(root, "codeflowai.db"), workspaceDb]) {
    const candidate = new DatabaseSync(file); candidate.exec("UPDATE version SET v=2"); candidate.close();
  }
  await fs.writeFile(path.join(workspace, "source.ts"), "edited");
  await backup.restore();
  for (const file of [path.join(root, "codeflowai.db"), workspaceDb]) {
    const restored = new DatabaseSync(file); assert.equal(restored.prepare("SELECT v FROM version").get()?.v, 1); restored.close();
  }
  assert.equal(await fs.readFile(path.join(workspace, "source.ts"), "utf8"), "edited");
  assert.equal(await backup.recover("old"), false);
});

test("unfinished activation is restored on next startup; committed activation keeps migrated data", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-db-backup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backup = createReleaseDatabaseBackup(root);
  await backup.prepare("next");
  await fs.writeFile(path.join(root, "codeflowai.db"), "candidate");
  assert.equal(await createReleaseDatabaseBackup(root).recover("old"), true);
  await assert.rejects(fs.access(path.join(root, "codeflowai.db")));
  await backup.prepare("next");
  await fs.writeFile(path.join(root, "codeflowai.db"), "committed");
  assert.equal(await backup.recover("next"), false);
  assert.equal(await fs.readFile(path.join(root, "codeflowai.db"), "utf8"), "committed");
});
