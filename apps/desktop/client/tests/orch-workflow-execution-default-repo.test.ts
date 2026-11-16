import test from "node:test";
import assert from "node:assert/strict";

import type { WorkflowId, WorkspaceId } from "@codeflowai/shared";

import { CLIENT_DB_SCHEMA_VERSION, migrateClientDb } from "../src/db/migrateClientDb.ts";
import { OrchWorkflowExecutionDefaultRepo } from "../src/db/repos/orchWorkflowExecutionDefaultRepo.ts";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.ts";

const WORKSPACE_ID = "ws-exec-default" as WorkspaceId;
const WORKFLOW_ID = "wf-exec-default" as WorkflowId;

/** 建库并写入工作区，保证执行默认值表的 workspace 外键可以落库。 */
function setup(): { db: SqliteDb; defaults: OrchWorkflowExecutionDefaultRepo } {
  const db = openSqliteDb(":memory:");
  migrateClientDb(db);
  db.prepare("INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(WORKSPACE_ID, "执行默认值", "/tmp", Date.now(), Date.now());
  return { db, defaults: new OrchWorkflowExecutionDefaultRepo(db) };
}

function tableExists(db: SqliteDb, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function schemaVersion(db: SqliteDb): number {
  return Number(db.pragma("user_version", { simple: true }));
}

test("空库迁移创建执行默认值表并推进到当前版本", () => {
  const { db, defaults } = setup();
  try {
    assert.equal(schemaVersion(db), CLIENT_DB_SCHEMA_VERSION);
    assert.equal(tableExists(db, "orch_workflow_execution_defaults"), true);
    assert.equal(defaults.get(WORKSPACE_ID, WORKFLOW_ID), null);
  } finally {
    db.close();
  }
});

test("旧版本库升级时补齐缺失的执行默认值表", () => {
  const db = openSqliteDb(":memory:");
  try {
    migrateClientDb(db);
    db.prepare("DROP TABLE orch_workflow_execution_defaults").run();
    db.pragma("user_version = 84");

    migrateClientDb(db);

    assert.equal(schemaVersion(db), CLIENT_DB_SCHEMA_VERSION);
    assert.equal(tableExists(db, "orch_workflow_execution_defaults"), true);
  } finally {
    db.close();
  }
});

test("版本已最新但表漂移时由修复阶段幂等补齐", () => {
  const { db } = setup();
  try {
    db.prepare("DROP TABLE orch_workflow_execution_defaults").run();

    migrateClientDb(db);

    assert.equal(tableExists(db, "orch_workflow_execution_defaults"), true);
  } finally {
    db.close();
  }
});

test("执行默认值按工作区与流程单例读写，重复保存保留创建时间", () => {
  const { db, defaults } = setup();
  try {
    const created = defaults.upsert({
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      engine: "codex",
      model: "gpt-5.2-codex",
      updatedByUserId: "user-1",
    });
    assert.equal(created.engine, "codex");
    assert.equal(defaults.get(WORKSPACE_ID, WORKFLOW_ID)?.updatedByUserId, "user-1");

    const updated = defaults.upsert({
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      engine: "claude",
      model: "claude-test",
    });
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(defaults.get(WORKSPACE_ID, WORKFLOW_ID)?.model, "claude-test");

    defaults.delete(WORKSPACE_ID, WORKFLOW_ID);
    assert.equal(defaults.get(WORKSPACE_ID, WORKFLOW_ID), null);
  } finally {
    db.close();
  }
});

test("不同工作区的同名流程各存一份，互不影响", () => {
  const { db, defaults } = setup();
  try {
    db.prepare("INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("ws-exec-default-2", "另一个工作区", "/tmp", Date.now(), Date.now());
    const otherWorkspaceId = "ws-exec-default-2" as WorkspaceId;

    defaults.upsert({ workspaceId: WORKSPACE_ID, workflowId: WORKFLOW_ID, engine: "codex", model: "gpt-5.2-codex" });
    defaults.upsert({ workspaceId: otherWorkspaceId, workflowId: WORKFLOW_ID, engine: "claude", model: "claude-test" });

    assert.equal(defaults.get(WORKSPACE_ID, WORKFLOW_ID)?.engine, "codex");
    assert.equal(defaults.get(otherWorkspaceId, WORKFLOW_ID)?.engine, "claude");

    defaults.delete(WORKSPACE_ID, WORKFLOW_ID);
    assert.equal(defaults.get(otherWorkspaceId, WORKFLOW_ID)?.engine, "claude");
  } finally {
    db.close();
  }
});

test("引擎值域由表约束拒绝非法写入", () => {
  const { db } = setup();
  try {
    assert.throws(() => db
      .prepare(
        `INSERT INTO orch_workflow_execution_defaults
           (workspace_id, workflow_id, engine, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(WORKSPACE_ID, WORKFLOW_ID, "gemini", "gemini-pro", 1, 1));
  } finally {
    db.close();
  }
});

test("存储层出现非法引擎时读取显式失败，不静默回落到默认引擎", () => {
  const { db, defaults } = setup();
  try {
    db.pragma("ignore_check_constraints = ON");
    db.prepare(
      `INSERT INTO orch_workflow_execution_defaults
         (workspace_id, workflow_id, engine, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(WORKSPACE_ID, WORKFLOW_ID, "gemini", "gemini-pro", 1, 1);

    assert.throws(() => defaults.get(WORKSPACE_ID, WORKFLOW_ID), /引擎非法/);
  } finally {
    db.close();
  }
});
