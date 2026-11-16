import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { ChatWorkflowRepo } from "../../apps/desktop/client/src/db/repos/chatWorkflowRepo.ts";
import { retireChatWorkflowCardsWithoutWorkflowAsset } from "../../apps/desktop/client/src/orchestration/chatWorkflowCardRetirement.ts";
import { listChatWorkflowActionRequestIds, listChatWorkflowCardIds, seedChatWorkflowCard } from "../support/chat-workflow-card-fixture.ts";
import { logger } from "../../apps/desktop/client/src/logger.ts";

/** 建一个临时客户端库，测试结束自动清理。 */
function openHarness(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-card-retirement-"));
  const db = openClientDb({ dbPath: path.join(directory, "test.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, directory, workspaceId: "ws-retire" };
}

/** 直接写一行原始 task_json，用于构造无法解析的脏数据。 */
function insertRawCard(db: ReturnType<typeof openClientDb>, id: string, workspaceId: string, taskJson: string): void {
  db.db.prepare(`INSERT INTO chat_workflow_tasks (id, workspace_id, thread_id, source_turn_id, instance_id, state, version, task_json, created_at, updated_at)
    VALUES (?, ?, 'thread-raw', 'turn-1', NULL, 'linked', 1, ?, 1, 1)`).run(id, workspaceId, taskJson);
}

test("retires only the cards whose workflow asset is missing from the authoritative graph", (t) => {
  const { db, workspaceId } = openHarness(t);
  seedChatWorkflowCard(db, { id: "card-removed", workspaceId, workflowId: "wf-removed", requestId: "req-removed" });
  seedChatWorkflowCard(db, { id: "card-present", workspaceId, workflowId: "wf-present" });
  seedChatWorkflowCard(db, { id: "card-legacy", workspaceId: "ws-legacy", workflowId: "wf-removed", requestId: "req-legacy" });

  retireChatWorkflowCardsWithoutWorkflowAsset({
    repo: new ChatWorkflowRepo(db.db),
    writeWorkspaceLog() {},
    listVisibleWorkflowIds(checkedWorkspaceId) {
      // legacy 工作区没有 Server 权威图，返回 null 表示不参与比对。
      return checkedWorkspaceId === workspaceId ? new Set(["wf-present"]) : null;
    },
  });

  assert.deepEqual(listChatWorkflowCardIds(db), ["card-legacy", "card-present"]);
  // 被回收卡片的操作回执必须同事务清掉，残留 request_id 会让重试命中过期快照。
  assert.deepEqual(listChatWorkflowActionRequestIds(db), ["req-legacy"]);
});

test("retires nothing while every referenced workflow is still visible", (t) => {
  const { db, workspaceId } = openHarness(t);
  seedChatWorkflowCard(db, { id: "card-1", workspaceId, workflowId: "wf-1", requestId: "req-1" });
  seedChatWorkflowCard(db, { id: "card-2", workspaceId, workflowId: "wf-2" });

  retireChatWorkflowCardsWithoutWorkflowAsset({
    repo: new ChatWorkflowRepo(db.db),
    writeWorkspaceLog() {},
    listVisibleWorkflowIds: () => new Set(["wf-1", "wf-2"]),
  });

  assert.deepEqual(listChatWorkflowCardIds(db), ["card-1", "card-2"]);
  assert.deepEqual(listChatWorkflowActionRequestIds(db), ["req-1"]);
});

test("retires every card of a workspace whose authoritative workflow graph is empty", (t) => {
  const { db, workspaceId } = openHarness(t);
  seedChatWorkflowCard(db, { id: "card-a", workspaceId, workflowId: "wf-1" });
  seedChatWorkflowCard(db, { id: "card-b", workspaceId, workflowId: "wf-2" });

  retireChatWorkflowCardsWithoutWorkflowAsset({
    repo: new ChatWorkflowRepo(db.db),
    writeWorkspaceLog() {},
    listVisibleWorkflowIds: () => new Set(),
  });

  assert.deepEqual(listChatWorkflowCardIds(db), []);
});

test("listWorkflowRefs skips cards without a resolvable workflow id", (t) => {
  const { db, workspaceId } = openHarness(t);
  seedChatWorkflowCard(db, { id: "card-ok", workspaceId, workflowId: "wf-1" });
  seedChatWorkflowCard(db, { id: "card-no-workflow", workspaceId, workflowId: null });
  insertRawCard(db, "card-broken", workspaceId, "not-json");

  assert.deepEqual(new ChatWorkflowRepo(db.db).listWorkflowRefs(), [
    { workspaceId, taskId: "card-ok", workflowId: "wf-1" },
  ]);
});

test("卡片回收成功诊断只写实际W，应用日志没有同条副本", t => {
  const { db, directory, workspaceId } = openHarness(t);
  const workspacePath = path.join(directory, "workspace"); fs.mkdirSync(workspacePath);
  db.workspaces.upsert({ id: workspaceId, title: "回收", path: workspacePath });
  const scoped = db.forWorkspace(workspaceId);
  seedChatWorkflowCard(scoped, { id: "card-removed", workspaceId, workflowId: "wf-removed", requestId: "req-removed" });
  const application = t.mock.method(logger, "info", () => {});
  retireChatWorkflowCardsWithoutWorkflowAsset({ repo: new ChatWorkflowRepo(scoped.db),
    listVisibleWorkflowIds: () => new Set(), writeWorkspaceLog: db.writeWorkspaceLog });
  const logDirectory = path.join(workspacePath, ".codeflowai");
  const logs = fs.readdirSync(logDirectory).filter(name => /^client-.*\.log$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(logDirectory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
  assert.equal(logs.length, 1); assert.equal(logs[0].workspaceId, workspaceId);
  assert.equal(logs[0].code, "CHAT_WORKFLOW_CARD_RETIRED"); assert.ok(logs[0].requestId);
  assert.deepEqual(logs[0].taskIds, ["card-removed"]); assert.equal(application.mock.callCount(), 0);
});

test("回收已提交后W诊断失败原值抛出，停止后续工作区且不复原已删除卡片", t => {
  const { db, directory } = openHarness(t), scopes = ["a", "b"];
  for (const workspaceId of scopes) {
    const workspacePath = path.join(directory, workspaceId); fs.mkdirSync(workspacePath);
    db.workspaces.upsert({ id: workspaceId, title: workspaceId, path: workspacePath });
    seedChatWorkflowCard(db.forWorkspace(workspaceId), { id: `card-${workspaceId}`, workspaceId, workflowId: "missing" });
  }
  const app = t.mock.method(logger, "info", () => {});
  assert.throws(() => retireChatWorkflowCardsWithoutWorkflowAsset({
    repo: {
      listWorkflowRefs: () => scopes.flatMap(id => new ChatWorkflowRepo(db.forWorkspace(id).db).listWorkflowRefs()),
      deleteByWorkflowIds: (workspaceId, ids) => new ChatWorkflowRepo(db.forWorkspace(workspaceId).db).deleteByWorkflowIds(workspaceId, ids),
    }, listVisibleWorkflowIds: () => new Set(), writeWorkspaceLog() { throw false; },
  }), error => error === false);
  assert.deepEqual(listChatWorkflowCardIds(db.forWorkspace("a")), []);
  assert.deepEqual(listChatWorkflowCardIds(db.forWorkspace("b")), ["card-b"]); assert.equal(app.mock.callCount(), 0);
});
