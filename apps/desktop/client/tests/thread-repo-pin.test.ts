import test from "node:test";
import assert from "node:assert/strict";

import type { ThreadId, WorkspaceId } from "@codeflowai/shared";

import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { ThreadRepo } from "../src/db/repos/threadRepo.ts";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.ts";

const WORKSPACE_ID = "test:thread-pin-ws" as WorkspaceId;

function setupDb(): { db: SqliteDb; repo: ThreadRepo } {
  const db = openSqliteDb(":memory:");
  migrateClientDb(db);
  db.prepare("INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(String(WORKSPACE_ID), "thread pin ws", "/tmp/thread-pin", 1, 1);
  return { db, repo: new ThreadRepo(db) };
}

/** 插入测试会话，允许单独设置 updatedAt 以覆盖最近活动排序。 */
function insertThread(db: SqliteDb, id: string, createdAt: number, pinnedAt: number | null = null, title = `会话 ${id}`, updatedAt = createdAt): void {
  db.prepare(
    "INSERT INTO threads (id, workspace_id, engine, title, pinned_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, String(WORKSPACE_ID), "codex", title, pinnedAt, createdAt, updatedAt);
}

test("ThreadRepo listByWorkspace 将置顶会话排在普通会话前，并支持游标分页", () => {
  const { db, repo } = setupDb();
  try {
    insertThread(db, "thread-old", 10);
    insertThread(db, "thread-new", 30);
    insertThread(db, "thread-pinned-a", 20, 100);
    insertThread(db, "thread-pinned-b", 15, 200);

    const firstPage = repo.listByWorkspace(WORKSPACE_ID, { limit: 2 });
    assert.deepEqual(firstPage.threads.map((thread) => thread.id), ["thread-pinned-b", "thread-pinned-a"]);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.threads[0]?.pinnedAt, 200);

    const secondPage = repo.listByWorkspace(WORKSPACE_ID, { limit: 2, cursor: firstPage.nextCursor });
    assert.deepEqual(secondPage.threads.map((thread) => thread.id), ["thread-new", "thread-old"]);
    assert.equal(secondPage.hasMore, false);
  } finally {
    db.close();
  }
});

test("ThreadRepo listByWorkspace 按标题服务端搜索，并保持置顶排序与游标分页", () => {
  const { db, repo } = setupDb();
  try {
    insertThread(db, "thread-alpha-old", 10, null, "Alpha 旧会话");
    insertThread(db, "thread-alpha-new", 30, null, "Alpha 新会话");
    insertThread(db, "thread-alpha-pinned", 20, 100, "Alpha 置顶会话");
    insertThread(db, "thread-beta", 40, null, "Beta 会话");
    insertThread(db, "alpha-id-only", 50, null, "普通会话");
    insertThread(db, "thread-percent", 60, null, "100% 真实会话");

    const firstPage = repo.listByWorkspace(WORKSPACE_ID, { search: "Alpha", limit: 2 });
    assert.deepEqual(firstPage.threads.map((thread) => thread.id), ["thread-alpha-pinned", "thread-alpha-new"]);
    assert.equal(firstPage.hasMore, true);

    const secondPage = repo.listByWorkspace(WORKSPACE_ID, { search: "Alpha", limit: 2, cursor: firstPage.nextCursor });
    assert.deepEqual(secondPage.threads.map((thread) => thread.id), ["thread-alpha-old"]);
    assert.equal(secondPage.hasMore, false);

    const wildcardSearch = repo.listByWorkspace(WORKSPACE_ID, { search: "%" });
    assert.deepEqual(wildcardSearch.threads.map((thread) => thread.id), ["thread-percent"]);
  } finally {
    db.close();
  }
});

test("ThreadRepo listByWorkspace 支持最近活动回退、创建时间和标题排序", () => {
  const { db, repo } = setupDb();
  try {
    insertThread(db, "thread-alpha", 30, null, "Alpha 会话", 30);
    insertThread(db, "thread-beta", 10, null, "Beta 会话", 90);
    insertThread(db, "thread-created-only", 80, null, "Created 会话", 0);
    insertThread(db, "thread-pinned", 20, 100, "Pinned 会话", 20);

    const firstActivityPage = repo.listByWorkspace(WORKSPACE_ID, { limit: 3 });
    assert.deepEqual(firstActivityPage.threads.map((thread) => thread.id), ["thread-pinned", "thread-beta", "thread-created-only"]);
    assert.equal(firstActivityPage.hasMore, true);

    const secondActivityPage = repo.listByWorkspace(WORKSPACE_ID, { limit: 3, cursor: firstActivityPage.nextCursor });
    assert.deepEqual(secondActivityPage.threads.map((thread) => thread.id), ["thread-alpha"]);
    assert.equal(secondActivityPage.hasMore, false);

    const activityAsc = repo.listByWorkspace(WORKSPACE_ID, { sort: "activity_asc" });
    assert.deepEqual(activityAsc.threads.map((thread) => thread.id), ["thread-pinned", "thread-alpha", "thread-created-only", "thread-beta"]);

    const createdAsc = repo.listByWorkspace(WORKSPACE_ID, { sort: "created_asc" });
    assert.deepEqual(createdAsc.threads.map((thread) => thread.id), ["thread-pinned", "thread-beta", "thread-alpha", "thread-created-only"]);

    const titleDesc = repo.listByWorkspace(WORKSPACE_ID, { sort: "title_desc" });
    assert.deepEqual(titleDesc.threads.map((thread) => thread.id), ["thread-pinned", "thread-created-only", "thread-beta", "thread-alpha"]);
  } finally {
    db.close();
  }
});

test("ThreadRepo setPinned 持久化置顶状态，取消置顶后恢复普通排序", () => {
  const { db, repo } = setupDb();
  try {
    insertThread(db, "thread-a", 10);
    insertThread(db, "thread-b", 20);
    const beforeUpdatedAt = repo.get("thread-a" as ThreadId)?.updatedAt;

    repo.setPinned("thread-a" as ThreadId, true);
    const pinned = repo.get("thread-a" as ThreadId);
    assert.ok(pinned?.pinnedAt);
    assert.equal(pinned.updatedAt, beforeUpdatedAt);
    assert.deepEqual(repo.listByWorkspace(WORKSPACE_ID).threads.map((thread) => thread.id), ["thread-a", "thread-b"]);

    repo.setPinned("thread-a" as ThreadId, false);
    assert.equal(repo.get("thread-a" as ThreadId)?.pinnedAt, null);
    assert.equal(repo.get("thread-a" as ThreadId)?.updatedAt, beforeUpdatedAt);
    assert.deepEqual(repo.listByWorkspace(WORKSPACE_ID).threads.map((thread) => thread.id), ["thread-b", "thread-a"]);
  } finally {
    db.close();
  }
});
