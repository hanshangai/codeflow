import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openClientDb } from "../src/db/clientDb.js";

test("终端、模板默认值与实验结构使用工作区存储", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-remaining-"));
  const db = openClientDb({ dbPath: path.join(directory, "app.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.workspaces.upsert({ id: "remaining", path: directory, title: "其他数据" });
  const scoped = db.forWorkspace("remaining");
  for (const name of ["terminal_configs", "orch_assignee_templates", "orch_workflow_execution_defaults",
    "controlled_experiment_snapshots", "controlled_experiment_runs"]) {
    assert.ok(scoped.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name), name);
    assert.equal((scoped.db.prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<{ table: string }>).some(key => key.table === "workspaces"), false);
  }
});
