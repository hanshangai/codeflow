import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkspaceId, ThreadId, KnowledgeAssetActorContext } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";
import { connectKnowledgeConversation, createKnowledgeConversation, createKnowledgeConversationTurn, endKnowledgeConversation, listKnowledgeConversations, requireKnowledgeConversationOwner } from "../src/knowledge/knowledgeConversationService.js";

test("知识会话与研发会话隔离，项目和目录每次明确新建，显式连接及重开数据库保留原会话", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-isolation-"));
  let db = openClientDb({ dbPath: path.join(root, "client.db") });
  const workspaceId = "workspace-a" as WorkspaceId;
  const actor: KnowledgeAssetActorContext = { userId: "owner", accountRole: "personal_normal", enterpriseId: null, requestId: "req", permissionScope: "account" };
  try {
    db.workspaces.upsert({ id: workspaceId, title: "测试项目", path: root });
    db.threads.create({ id: "development" as ThreadId, workspaceId, engine: "codex", title: "研发会话", prefs: { accessMode: "full-access" } });
    const store = new KnowledgeAssetStore(root);
    store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "docs", parentId: null, title: "架构", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
    const input = { db, store, workspaceId, actor };
    assert.throws(() => connectKnowledgeConversation({ ...input, threadId: "development" }), /独立知识会话/);
    assert.equal(createKnowledgeConversationTurn({ ...input, threadId: "development", turnId: "turn-dev", engine: "codex", model: null, effort: null, prompt: "修改源码", trustedActor: actor, isActive: () => true }), null);
    assert.equal(db.threads.get("development" as ThreadId)?.accessMode, "full-access");
    const project = createKnowledgeConversation({ ...input, nodeId: null, engine: "codex" });
    assert.notEqual(project.threadId, "development");
    assert.equal(project.createdByUserId, actor.userId);
    const secondProject = createKnowledgeConversation({ ...input, nodeId: null, engine: "codex", title: "新的项目讨论", model: "another-model", effort: "high" });
    assert.notEqual(secondProject.threadId, project.threadId);
    assert.equal(secondProject.title, "新的项目讨论");
    assert.equal(secondProject.model, "another-model");
    assert.equal(connectKnowledgeConversation({ ...input, threadId: project.threadId }).threadId, project.threadId);
    const directory = createKnowledgeConversation({ ...input, nodeId: "docs", engine: "codex" });
    assert.notEqual(createKnowledgeConversation({ ...input, nodeId: "docs", engine: "codex" }).threadId, directory.threadId);
    assert.deepEqual(db.threads.listByWorkspace(workspaceId, { threadListOnly: true, scope: "current", knowledgeActorUserId: actor.userId }).threads.map(t => t.id), ["development"]);
    assert.equal(db.threads.listByWorkspace(workspaceId, { threadListOnly: true, scope: "knowledge", knowledgeActorUserId: actor.userId }).threads.length, 4);
    assert.equal(listKnowledgeConversations(input).length, 4);
    assert.equal(listKnowledgeConversations({ ...input, actor: { ...actor, userId: "other" } }).length, 0);
    assert.throws(() => connectKnowledgeConversation({ ...input, actor: { ...actor, userId: "other" }, threadId: project.threadId }), /独立知识会话/);
    assert.throws(() => connectKnowledgeConversation({ ...input, threadId: directory.threadId, workspaceId: "other-workspace" }), /独立知识会话/);
    assert.equal(endKnowledgeConversation({ ...input, threadId: directory.threadId }).active, false);
    assert.throws(() => requireKnowledgeConversationOwner({ ...input, threadId: directory.threadId }), /已结束/);
    db.close();
    db = openClientDb({ dbPath: path.join(root, "client.db") });
    const restored = connectKnowledgeConversation({ ...input, db, threadId: directory.threadId });
    assert.equal(restored.nodeId, "docs");
    assert.equal(restored.createdByUserId, actor.userId);
    assert.equal(restored.active, true);
    assert.equal(db.threads.get(directory.threadId as ThreadId)?.threadSubtype, "knowledge-conversation");
    assert.equal(db.threads.get("development" as ThreadId)?.accessMode, "full-access");
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("共享项目资产可读，其他成员新建自己的知识会话，不继承原成员的私有会话", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-shared-conversations-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const workspaceId = "shared-host" as WorkspaceId;
  try {
    db.workspaces.upsert({ id: workspaceId, title: "共享项目", path: root });
    const store = new KnowledgeAssetStore(root);
    store.saveTree({ schemaVersion: 1, instructions: "项目要求", nodes: [{ id: "architecture", parentId: null, title: "架构", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
    store.saveDocument({ nodeId: "architecture", content: "# 共享架构文档", sources: [], expectedHash: null, origin: "manual", summary: "架构" });
    const input = { db, store, workspaceId, sharedWorkspaceId: "shared-project", actor: { userId: "owner", permissionScope: "shared_asset_admin" as const } };
    const original = createKnowledgeConversation({ ...input, nodeId: null, engine: "codex" });
    const otherInput = { ...input, actor: { ...input.actor, userId: "other-member" } };
    assert.deepEqual(listKnowledgeConversations(otherInput), []);
    assert.throws(() => connectKnowledgeConversation({ ...otherInput, threadId: original.threadId }), /独立知识会话/);
    const separate = createKnowledgeConversation({ ...otherInput, nodeId: null, engine: "codex" });
    assert.notEqual(separate.threadId, original.threadId);
    assert.equal(separate.createdByUserId, "other-member");
    assert.deepEqual(listKnowledgeConversations(input).map(item => item.threadId), [original.threadId]);
    assert.deepEqual(listKnowledgeConversations(otherInput).map(item => item.threadId), [separate.threadId]);
    assert.equal(db.threads.get(separate.threadId as ThreadId)?.ownerUserId, "other-member");
    assert.equal(db.threads.get(separate.threadId as ThreadId)?.sharedVisibility, "private");
    assert.equal(connectKnowledgeConversation({ ...otherInput, threadId: separate.threadId }).threadId, separate.threadId);
    assert.equal(new KnowledgeAssetStore(root).detail("architecture").current?.content, "# 共享架构文档");
    db.threads.setSharedAcl(original.threadId as ThreadId, { sharedWorkspaceId: "shared-project", ownerUserId: "owner", visibility: "private", participantUserIds: ["other-member"] });
    const sharedHistory = listKnowledgeConversations(otherInput).find(item => item.threadId === original.threadId);
    assert.equal(sharedHistory?.createdByUserId, "owner", "明确授权的参与会话仍显示原始创建人，供默认续聊排除");
    assert.equal(connectKnowledgeConversation({ ...otherInput, threadId: original.threadId }).createdByUserId, "owner");
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
