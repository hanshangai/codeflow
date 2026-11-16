import test from "node:test";
import assert from "node:assert/strict";

import type { SharedWorkspaceId, ThreadGroupId, ThreadId, WorkspaceId } from "@codeflowai/shared";

import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { ThreadRepo } from "../src/db/repos/threadRepo.ts";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.ts";

const WORKSPACE_ID = "test:thread-groups-ws" as WorkspaceId;
const SHARED_WORKSPACE_ID = "shared-thread-groups" as SharedWorkspaceId;

function setupDb(): { db: SqliteDb; repo: ThreadRepo } {
  const db = openSqliteDb(":memory:");
  migrateClientDb(db);
  db.prepare("INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(String(WORKSPACE_ID), "thread groups ws", "/tmp/thread-groups", 1, 1);
  return { db, repo: new ThreadRepo(db) };
}

/** 创建普通自建会话，用于分组归属测试。 */
function createChat(repo: ThreadRepo, id: string, title = id): ThreadId {
  const threadId = id as ThreadId;
  repo.create({ id: threadId, workspaceId: WORKSPACE_ID, engine: "codex", title });
  return threadId;
}

/** 创建共享工作区自建会话，确保共享分组只能挂到同一共享区。 */
function createSharedChat(repo: ThreadRepo, id: string, ownerUserId: string): ThreadId {
  const threadId = id as ThreadId;
  repo.create({
    id: threadId,
    workspaceId: WORKSPACE_ID,
    engine: "codex",
    title: id,
    sharedAcl: { sharedWorkspaceId: SHARED_WORKSPACE_ID, ownerUserId },
  });
  return threadId;
}

test("ThreadRepo 支持创建分组、移动自建会话和按分组筛选", () => {
  const { db, repo } = setupDb();
  try {
    const group = repo.createGroup({ workspaceId: WORKSPACE_ID, name: "  前端  " });
    const groupedThreadId = createChat(repo, "thread-grouped", "分组会话");
    const ungroupedThreadId = createChat(repo, "thread-ungrouped", "未分组会话");

    const assignedGroupId = repo.setThreadGroup({ workspaceId: WORKSPACE_ID, threadId: groupedThreadId, groupId: group.id });

    assert.equal(group.name, "前端");
    assert.equal(group.canManage, true);
    assert.equal(assignedGroupId, group.id);
    assert.equal(repo.get(groupedThreadId)?.groupId, group.id);
    assert.deepEqual(repo.listByWorkspace(WORKSPACE_ID, { groupId: group.id }).threads.map((thread) => thread.id), [groupedThreadId]);
    assert.deepEqual(repo.listByWorkspace(WORKSPACE_ID, { groupId: "ungrouped" }).threads.map((thread) => thread.id), [ungroupedThreadId]);
  } finally {
    db.close();
  }
});

test("ThreadRepo 创建自建会话时可直接写入分组", () => {
  const { db, repo } = setupDb();
  try {
    const group = repo.createGroup({ workspaceId: WORKSPACE_ID, name: "创建默认组" });

    const thread = repo.create({ id: "thread-create-grouped" as ThreadId, workspaceId: WORKSPACE_ID, engine: "codex", title: "创建即分组", groupId: group.id });

    assert.equal(thread.groupId, group.id);
    assert.equal(repo.get(thread.id)?.groupId, group.id);
    assert.deepEqual(repo.listByWorkspace(WORKSPACE_ID, { groupId: group.id }).threads.map((item) => item.id), [thread.id]);
  } finally {
    db.close();
  }
});

test("ThreadRepo 创建非自建会话传分组时失败且不落库", () => {
  const { db, repo } = setupDb();
  try {
    const group = repo.createGroup({ workspaceId: WORKSPACE_ID, name: "非自建拒绝" });
    const orchestrationThreadId = "thread-create-orch-grouped" as ThreadId;
    const discussionThreadId = "thread-create-discussion-grouped" as ThreadId;

    assert.throws(
      () => repo.create({ id: orchestrationThreadId, workspaceId: WORKSPACE_ID, engine: "codex", title: "流程", threadType: "orchestration", groupId: group.id }),
      /只有自建会话支持分组/,
    );
    assert.throws(
      () => repo.create({ id: discussionThreadId, workspaceId: WORKSPACE_ID, engine: "codex", title: "节点讨论", threadType: "chat", threadSubtype: "node-discussion", groupId: group.id }),
      /只有自建会话支持分组/,
    );
    assert.equal(repo.get(orchestrationThreadId), null);
    assert.equal(repo.get(discussionThreadId), null);
  } finally {
    db.close();
  }
});

test("ThreadRepo 创建会话传入不存在分组时失败且不落库", () => {
  const { db, repo } = setupDb();
  try {
    const threadId = "thread-create-missing-group" as ThreadId;

    assert.throws(
      () => repo.create({ id: threadId, workspaceId: WORKSPACE_ID, engine: "codex", title: "缺失分组", groupId: "tg_missing" as ThreadGroupId }),
      /会话分组不存在或不属于当前工作区/,
    );
    assert.equal(repo.get(threadId), null);
  } finally {
    db.close();
  }
});

test("ThreadRepo 创建共享工作区自建会话时只能使用同共享区分组", () => {
  const { db, repo } = setupDb();
  try {
    const sharedGroup = repo.createGroup({
      workspaceId: WORKSPACE_ID,
      sharedWorkspaceId: SHARED_WORKSPACE_ID,
      name: "共享创建默认组",
      createdByUserId: "user-a",
    });
    const localGroup = repo.createGroup({ workspaceId: WORKSPACE_ID, name: "本地组" });
    const sharedThreadId = "thread-create-shared-grouped" as ThreadId;
    const crossScopeThreadId = "thread-create-cross-scope" as ThreadId;

    const thread = repo.create({
      id: sharedThreadId,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "共享创建即分组",
      groupId: sharedGroup.id,
      sharedAcl: { sharedWorkspaceId: SHARED_WORKSPACE_ID, ownerUserId: "user-a" },
    });

    assert.equal(thread.groupId, sharedGroup.id);
    assert.equal(repo.get(sharedThreadId)?.groupId, sharedGroup.id);
    assert.throws(
      () => repo.create({
        id: crossScopeThreadId,
        workspaceId: WORKSPACE_ID,
        engine: "codex",
        title: "共享跨域分组",
        groupId: localGroup.id,
        sharedAcl: { sharedWorkspaceId: SHARED_WORKSPACE_ID, ownerUserId: "user-a" },
      }),
      /会话分组不存在或不属于当前工作区/,
    );
    assert.equal(repo.get(crossScopeThreadId), null);
  } finally {
    db.close();
  }
});

test("ThreadRepo 分组名称在同一域内大小写和空格不敏感唯一", () => {
  const { db, repo } = setupDb();
  try {
    repo.createGroup({ workspaceId: WORKSPACE_ID, name: "研发" });

    assert.throws(() => repo.createGroup({ workspaceId: WORKSPACE_ID, name: "  研发  " }), /会话分组名称已存在/);
    assert.throws(() => repo.createGroup({ workspaceId: WORKSPACE_ID, name: "" }), /会话分组名称不能为空/);
  } finally {
    db.close();
  }
});

test("ThreadRepo 仅允许自建会话移动分组", () => {
  const { db, repo } = setupDb();
  try {
    const group = repo.createGroup({ workspaceId: WORKSPACE_ID, name: "可移动" });
    const orchestrationThreadId = "thread-orch" as ThreadId;
    const discussionThreadId = "thread-discussion" as ThreadId;
    repo.create({ id: orchestrationThreadId, workspaceId: WORKSPACE_ID, engine: "codex", title: "流程", threadType: "orchestration" });
    repo.create({ id: discussionThreadId, workspaceId: WORKSPACE_ID, engine: "codex", title: "讨论", threadType: "chat", threadSubtype: "node-discussion" });

    assert.throws(() => repo.setThreadGroup({ workspaceId: WORKSPACE_ID, threadId: orchestrationThreadId, groupId: group.id }), /只有自建会话支持分组/);
    assert.throws(() => repo.setThreadGroup({ workspaceId: WORKSPACE_ID, threadId: discussionThreadId, groupId: group.id }), /只有自建会话支持分组/);
  } finally {
    db.close();
  }
});

test("ThreadRepo 删除分组时不删除会话，组内会话回到未分组", () => {
  const { db, repo } = setupDb();
  try {
    const group = repo.createGroup({ workspaceId: WORKSPACE_ID, name: "临时分组" });
    const threadId = createChat(repo, "thread-to-ungroup");
    repo.setThreadGroup({ workspaceId: WORKSPACE_ID, threadId, groupId: group.id });

    const ungroupedCount = repo.deleteGroup({ workspaceId: WORKSPACE_ID, groupId: group.id });

    assert.equal(ungroupedCount, 1);
    assert.equal(repo.get(threadId)?.groupId, null);
    assert.deepEqual(repo.listGroups(WORKSPACE_ID).map((item) => item.id), []);
    assert.deepEqual(repo.listByWorkspace(WORKSPACE_ID, { groupId: "ungrouped" }).threads.map((thread) => thread.id), [threadId]);
  } finally {
    db.close();
  }
});

test("ThreadRepo 共享工作区分组维护权限限定为创建者或管理员", () => {
  const { db, repo } = setupDb();
  try {
    const group = repo.createGroup({
      workspaceId: WORKSPACE_ID,
      sharedWorkspaceId: SHARED_WORKSPACE_ID,
      name: "共享分组",
      createdByUserId: "user-a",
    });

    assert.equal(repo.listGroups(WORKSPACE_ID, { sharedWorkspaceId: SHARED_WORKSPACE_ID, actorUserId: "user-b" })[0]?.canManage, false);
    assert.equal(repo.listGroups(WORKSPACE_ID, { sharedWorkspaceId: SHARED_WORKSPACE_ID, actorUserId: "user-a" })[0]?.canManage, true);
    assert.throws(
      () => repo.renameGroup({ workspaceId: WORKSPACE_ID, sharedWorkspaceId: SHARED_WORKSPACE_ID, groupId: group.id, name: "无权限", actorUserId: "user-b" }),
      /无权限维护该会话分组/,
    );

    const renamed = repo.renameGroup({
      workspaceId: WORKSPACE_ID,
      sharedWorkspaceId: SHARED_WORKSPACE_ID,
      groupId: group.id,
      name: "管理员重命名",
      actorUserId: "admin",
      actorIsAdmin: true,
    });

    assert.equal(renamed.name, "管理员重命名");
    assert.equal(repo.deleteGroup({ workspaceId: WORKSPACE_ID, sharedWorkspaceId: SHARED_WORKSPACE_ID, groupId: group.id, actorUserId: "admin", actorIsAdmin: true }), 0);
  } finally {
    db.close();
  }
});

test("ThreadRepo 共享工作区分组不能跨共享区挂载", () => {
  const { db, repo } = setupDb();
  try {
    const group = repo.createGroup({
      workspaceId: WORKSPACE_ID,
      sharedWorkspaceId: SHARED_WORKSPACE_ID,
      name: "共享分组",
      createdByUserId: "user-a",
    });
    const localThreadId = createChat(repo, "thread-local");
    const sharedThreadId = createSharedChat(repo, "thread-shared", "user-a");

    assert.throws(
      () => repo.setThreadGroup({ workspaceId: WORKSPACE_ID, threadId: localThreadId, groupId: group.id, sharedWorkspaceId: SHARED_WORKSPACE_ID }),
      /thread 与分组不属于同一共享工作区/,
    );
    assert.equal(repo.setThreadGroup({ workspaceId: WORKSPACE_ID, threadId: sharedThreadId, groupId: group.id, sharedWorkspaceId: SHARED_WORKSPACE_ID }), group.id);
    assert.deepEqual(repo.listByWorkspace(WORKSPACE_ID, { sharedWorkspaceId: SHARED_WORKSPACE_ID, groupId: group.id }).threads.map((thread) => thread.id), [sharedThreadId]);
  } finally {
    db.close();
  }
});
