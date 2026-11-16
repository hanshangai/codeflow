import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { ChatWorkflowRepo } from "../../apps/desktop/client/src/db/repos/chatWorkflowRepo.ts";
import { listChatWorkflowActionRequestIds, listChatWorkflowCardIds, seedChatWorkflowCard } from "../support/chat-workflow-card-fixture.ts";

/** 建一个临时客户端库，测试结束自动清理。 */
function openHarness(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-card-removal-"));
  const db = openClientDb({ dbPath: path.join(directory, "test.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, workspaceId: "ws-card-removal" };
}

/** 直接写原始 task_json，用于构造非法 JSON 与空对象两种边界。 */
function insertRawCard(db: ReturnType<typeof openClientDb>, id: string, workspaceId: string, taskJson: string): void {
  db.db.prepare(`INSERT INTO chat_workflow_tasks (id, workspace_id, thread_id, source_turn_id, instance_id, state, version, task_json, created_at, updated_at)
    VALUES (?, ?, 'thread-raw', 'turn-1', NULL, 'linked', 1, ?, 1, 1)`).run(id, workspaceId, taskJson);
}

test("deleteByWorkflowIds removes matching cards with their action receipts and stays inside the workspace", (t) => {
  const { db, workspaceId } = openHarness(t);
  const repo = new ChatWorkflowRepo(db.db);
  seedChatWorkflowCard(db, { id: "card-hit", workspaceId, workflowId: "wf-hit", requestId: "req-hit" });
  seedChatWorkflowCard(db, { id: "card-other", workspaceId, workflowId: "wf-other", requestId: "req-other" });
  seedChatWorkflowCard(db, { id: "card-foreign", workspaceId: "ws-other", workflowId: "wf-hit", requestId: "req-foreign" });

  const removal = repo.deleteByWorkflowIds(workspaceId, ["wf-hit", "wf-missing"]);

  assert.deepEqual(removal, { taskIds: ["card-hit"], skippedInvalidJsonCount: 0 });
  assert.deepEqual(listChatWorkflowCardIds(db), ["card-foreign", "card-other"]);
  // 回执必须随卡片一并删除，否则残留 request_id 会让后续同 requestId 的操作命中过期快照。
  assert.deepEqual(listChatWorkflowActionRequestIds(db), ["req-foreign", "req-other"]);
});

test("deleteTask removes one card with its action receipts and stays inside the workspace", (t) => {
  const { db, workspaceId } = openHarness(t);
  const repo = new ChatWorkflowRepo(db.db);
  seedChatWorkflowCard(db, { id: "card-hit", workspaceId, workflowId: "wf-hit", requestId: "req-hit" });
  seedChatWorkflowCard(db, { id: "card-keep", workspaceId, workflowId: "wf-keep" });

  assert.equal(repo.deleteTask(workspaceId, "card-hit"), true);
  assert.deepEqual(listChatWorkflowCardIds(db), ["card-keep"]);
  // 回执必须随卡片一并删除，否则残留 request_id 会让后续同 requestId 的操作命中过期快照。
  assert.deepEqual(listChatWorkflowActionRequestIds(db), []);

  // 跨工作区、卡片不存在与空 id 一律不命中且不动任何行。
  assert.equal(repo.deleteTask("ws-other", "card-keep"), false);
  assert.equal(repo.deleteTask(workspaceId, "card-missing"), false);
  assert.equal(repo.deleteTask(workspaceId, "  "), false);
  assert.deepEqual(listChatWorkflowCardIds(db), ["card-keep"]);
});

test("listTaskIdsByIntakeId only reports cards of the same workspace referencing the intake", (t) => {
  const { db, workspaceId } = openHarness(t);
  const repo = new ChatWorkflowRepo(db.db);
  seedChatWorkflowCard(db, { id: "card-intake", workspaceId, workflowId: "wf-1", intakeId: "intake-shared" });
  seedChatWorkflowCard(db, { id: "card-other-intake", workspaceId, workflowId: "wf-2", intakeId: "intake-other" });
  seedChatWorkflowCard(db, { id: "card-foreign", workspaceId: "ws-other", workflowId: "wf-1", intakeId: "intake-shared" });
  insertRawCard(db, "card-broken-json", workspaceId, "not-json");

  assert.deepEqual(repo.listTaskIdsByIntakeId(workspaceId, "intake-shared"), ["card-intake"]);
  assert.deepEqual(repo.listTaskIdsByIntakeId(workspaceId, "intake-missing"), []);
  assert.deepEqual(repo.listTaskIdsByIntakeId(workspaceId, "  "), []);
});

test("deleteByIntakeIds matches intake ids and skips malformed task_json without throwing", (t) => {
  const { db, workspaceId } = openHarness(t);
  const repo = new ChatWorkflowRepo(db.db);
  seedChatWorkflowCard(db, { id: "card-intake", workspaceId, workflowId: "wf-1", intakeId: "intake-1", instanceId: "instance-1" });
  insertRawCard(db, "card-empty-json", workspaceId, "{}");
  insertRawCard(db, "card-broken-json", workspaceId, "not-json");

  const removal = repo.deleteByIntakeIds(workspaceId, ["intake-1"]);

  assert.deepEqual(removal, { taskIds: ["card-intake"], skippedInvalidJsonCount: 1 });
  assert.deepEqual(listChatWorkflowCardIds(db), ["card-broken-json", "card-empty-json"]);
});

test("card removal is a no-op for blank id lists", (t) => {
  const { db, workspaceId } = openHarness(t);
  const repo = new ChatWorkflowRepo(db.db);
  seedChatWorkflowCard(db, { id: "card-keep", workspaceId, workflowId: "wf-keep" });

  assert.deepEqual(repo.deleteByWorkflowIds(workspaceId, ["", "  "]), { taskIds: [], skippedInvalidJsonCount: 0 });
  assert.deepEqual(listChatWorkflowCardIds(db), ["card-keep"]);
});
