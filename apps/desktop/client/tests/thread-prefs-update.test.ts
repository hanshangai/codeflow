import test from "node:test";
import assert from "node:assert/strict";

import type { RoleId, ThreadId, WorkspaceId } from "@codeflowai/shared";

import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { ThreadRepo } from "../src/db/repos/threadRepo.ts";
import { ChatWorkflowRepo } from "../src/db/repos/chatWorkflowRepo.ts";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.ts";

const WORKSPACE_ID = "test:thread-prefs-ws" as WorkspaceId;

function setupDb(): { db: SqliteDb; repo: ThreadRepo } {
  const db = openSqliteDb(":memory:");
  migrateClientDb(db);
  db.prepare("INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(String(WORKSPACE_ID), "thread prefs ws", "/tmp/thread-prefs", 1, 1);
  return { db, repo: new ThreadRepo(db) };
}

test("ThreadRepo partial update 保留未修改的模型和其它偏好", () => {
  const { db, repo } = setupDb();
  try {
    const threadId = "thread-prefs-partial" as ThreadId;
    const sentinelThreadId = "thread-prefs-partial-sentinel" as ThreadId;
    repo.create({
      id: threadId,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "partial prefs",
      prefs: {
        model: "gpt-6-luna",
        effort: "high",
        accessMode: "full-access",
        planMode: true,
        knowledgeEnabled: true,
        autoCompactPct: 88,
        contextWindow: 1_050_000,
        serviceTier: "fast",
        roleId: "role-prefs" as RoleId,
      },
    });
    repo.create({
      id: sentinelThreadId,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "partial prefs sentinel",
      prefs: { model: "gpt-5.6-terra", effort: "low", contextWindow: 180_000 },
    });
    const sentinelBefore = repo.get(sentinelThreadId);

    repo.updatePrefs(threadId, { effort: "medium" });

    const thread = repo.get(threadId);
    assert.equal(thread?.model, "gpt-6-luna");
    assert.equal(thread?.effort, "medium");
    assert.equal(thread?.accessMode, "full-access");
    assert.equal(thread?.planMode, true);
    assert.equal(thread?.knowledgeEnabled, true);
    assert.equal(thread?.autoCompactPct, 88);
    assert.equal(thread?.contextWindow, 1_050_000);
    assert.equal(thread?.serviceTier, "fast");
    assert.equal(thread?.roleId, "role-prefs");

    assert.deepEqual(repo.get(sentinelThreadId), sentinelBefore);
  } finally {
    db.close();
  }
});

test("ThreadRepo 将显式 null 解释为清空并恢复引擎默认", () => {
  const { db, repo } = setupDb();
  try {
    const threadId = "thread-prefs-explicit-null" as ThreadId;
    repo.create({
      id: threadId,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "explicit null prefs",
      prefs: {
        model: "gpt-5.5",
        effort: "high",
        contextWindow: 272_000,
        serviceTier: "fast",
      },
    });

    repo.updatePrefs(threadId, { model: null, serviceTier: null });

    const thread = repo.get(threadId);
    assert.equal(thread?.model, "gpt-6.2-sol");
    assert.equal(thread?.contextWindow, 872_000);
    assert.equal(thread?.serviceTier, null);
    assert.equal(thread?.effort, "high");
  } finally {
    db.close();
  }
});

test("新建普通会话默认关闭 Spec 和 WorkFlow，不继承其它会话的开启态", () => {
  const { db, repo } = setupDb();
  try {
    const workflows = new ChatWorkflowRepo(db);
    const existingThreadId = "thread-prefs-existing-enabled" as ThreadId;
    repo.create({ id: existingThreadId, workspaceId: WORKSPACE_ID, engine: "codex", title: "existing enabled", prefs: { knowledgeEnabled: true } });
    workflows.setEnabled(existingThreadId, true);
    const threadId = "thread-prefs-knowledge-default" as ThreadId;
    repo.create({
      id: threadId,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "knowledge default",
    });

    const thread = repo.get(threadId);
    assert.equal(thread?.knowledgeEnabled, false);
    assert.equal(workflows.isEnabled(threadId), false);
    assert.equal(repo.get(existingThreadId)?.knowledgeEnabled, true);
    assert.equal(workflows.isEnabled(existingThreadId), true);
    workflows.setEnabled(threadId, true);
    assert.equal(new ChatWorkflowRepo(db).isEnabled(threadId), true);
  } finally {
    db.close();
  }
});

test("ThreadRepo 新建 GPT 会话默认关闭 Fast，显式开启可持久化且不影响其它会话", () => {
  const { db, repo } = setupDb();
  try {
    for (const [id, prefs] of [
      ["fast-default", undefined],
      ["fast-model-only", { model: "gpt-6.2-sol" }],
      ["fast-disabled", { model: "gpt-6.2-sol", serviceTier: null }],
      ["fast-enabled", { model: "gpt-6.2-sol", serviceTier: "fast" }],
    ] as const) {
      const threadId = id as ThreadId;
      repo.create({ id: threadId, workspaceId: WORKSPACE_ID, engine: "codex", title: id, prefs });
      const thread = repo.get(threadId);
      assert.equal(thread?.model, "gpt-6.2-sol");
      assert.equal(thread?.contextWindow, 872_000);
      assert.equal(thread?.serviceTier, id === "fast-enabled" ? "fast" : null);
    }
    const threadId = "fast-model-only" as ThreadId;
    repo.updatePrefs(threadId, { serviceTier: "fast" });
    repo.updatePrefs(threadId, { effort: "medium" });
    assert.equal(repo.get(threadId)?.serviceTier, "fast");
    assert.equal(repo.get("fast-default" as ThreadId)?.serviceTier, null);
    assert.equal(repo.get("fast-disabled" as ThreadId)?.serviceTier, null);
    assert.equal(repo.get("fast-enabled" as ThreadId)?.serviceTier, "fast");
  } finally {
    db.close();
  }
});

test("ThreadRepo 将 undefined 字段视为省略而不是清空", () => {
  const { db, repo } = setupDb();
  try {
    const threadId = "thread-prefs-undefined" as ThreadId;
    repo.create({
      id: threadId,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "undefined prefs",
      prefs: { model: "gpt-5.5", effort: "high" },
    });

    repo.updatePrefs(threadId, { effort: undefined });

    const thread = repo.get(threadId);
    assert.equal(thread?.model, "gpt-5.5");
    assert.equal(thread?.effort, "high");
  } finally {
    db.close();
  }
});
