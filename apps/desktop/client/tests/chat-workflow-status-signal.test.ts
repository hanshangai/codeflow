import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OrchestrationId, ThreadId, WorkspaceId } from "@codeflowai/shared";

import { openClientDb } from "../src/db/clientDb.ts";
import { ChatWorkflowRepo } from "../src/db/repos/chatWorkflowRepo.ts";
import { OrchestrationEngine, type OrchestrationEngineContext } from "../src/orchestration/orchestrationEngine.ts";

/** 打开真实 Client SQLite 并装配只暴露编排事件出口的引擎，其余依赖留空。 */
function createHarness(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-signal-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "ws-signal" as WorkspaceId;
  const threadId = "chat-signal" as ThreadId;
  db.workspaces.upsert({ id: workspaceId, title: "signal", path: directory });
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "signal" });
  const emitted: Array<{ workspaceId: string; type: string; payloadJson: string }> = [];
  const engine = new OrchestrationEngine({
    db,
    workspaces: new Map([[workspaceId, directory]]),
    sessions: { interrupt: async () => {}, hasActiveTurn: () => false },
    // 与 index.ts 的生产装配一致：按实例反查会话工作流绑定
    resolveChatWorkflowBinding: (instanceId) => new ChatWorkflowRepo(db.db).findBindingByInstanceId(String(instanceId)),
    emitOrchestration: (runtimeWorkspaceId: WorkspaceId, event: { type: string; payloadJson: string }) => {
      emitted.push({ workspaceId: String(runtimeWorkspaceId), type: event.type, payloadJson: event.payloadJson });
    },
  } as unknown as OrchestrationEngineContext);
  return { db, engine, workspaceId, threadId, emitted, directory };
}

/** 创建状态为 running 的实例；节点状态保持为空，暂停路径不会触达会话中断。 */
function createRunningInstance(h: ReturnType<typeof createHarness>): OrchestrationId {
  const instance = h.db.orchInstances.create({
    workspaceId: h.workspaceId,
    workflowId: "workflow-signal" as never,
    workflowSnapshot: {
      id: "workflow-signal",
      workspaceId: h.workspaceId,
      name: "信号工作流",
      description: "",
      family: "feature-dev",
      version: 1,
      nodes: [],
      edges: [],
    } as never,
    intakeSnapshot: {
      id: "intake-signal",
      workspaceId: h.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "信号需求",
      goal: "验证状态信号",
    } as never,
  });
  h.db.db.prepare("UPDATE orch_instances SET status = 'running' WHERE id = ?").run(String(instance.id));
  return instance.id;
}

/** 绑定会话工作流任务；instance_id 有唯一索引，普通编排实例不会出现在这里。 */
function linkChatWorkflowTask(h: ReturnType<typeof createHarness>, instanceId: OrchestrationId): void {
  h.db.db.prepare(
    `INSERT INTO chat_workflow_tasks
       (id, workspace_id, thread_id, source_turn_id, instance_id, state, version, task_json, created_at, updated_at)
     VALUES ('task-signal', ?, ?, 'turn-signal', ?, 'linked', 1, '{}', 1000, 1000)`,
  ).run(String(h.workspaceId), String(h.threadId), String(instanceId));
}

function chatWorkflowStatusEvents(h: ReturnType<typeof createHarness>) {
  return h.emitted
    .filter((item) => item.type === "orchestration.chatWorkflowStatusChanged")
    .map((item) => ({ workspaceId: item.workspaceId, payload: JSON.parse(item.payloadJson) as Record<string, unknown> }));
}

test("绑定会话工作流的实例状态变化会发出源会话状态事件", async (t) => {
  const h = createHarness(t);
  const instanceId = createRunningInstance(h);
  linkChatWorkflowTask(h, instanceId);

  await h.engine.pause(instanceId);

  const events = chatWorkflowStatusEvents(h);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.workspaceId, String(h.workspaceId));
  assert.equal(events[0]!.payload.threadId, String(h.threadId));
  assert.equal(events[0]!.payload.taskId, "task-signal");
  assert.equal(events[0]!.payload.instanceId, String(instanceId));
  assert.equal(events[0]!.payload.status, "paused");
});

test("未绑定会话工作流的普通编排实例不发该事件", async (t) => {
  const h = createHarness(t);
  const instanceId = createRunningInstance(h);

  await h.engine.pause(instanceId);

  assert.deepEqual(chatWorkflowStatusEvents(h), []);
  // 普通编排自身的事件不受影响
  assert.ok(h.emitted.some((item) => item.type === "orchestration.paused"));
});

test("生产装配点必须注入会话工作流绑定解析器", () => {
  // 引擎侧的解析器是可选的：装配遗漏只会静默失去近实时，必须在源码层守住
  const indexSource = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
    "utf8",
  );
  assert.match(indexSource, /resolveChatWorkflowBinding: \(instanceId\) => new ChatWorkflowRepo\(db\.db\)\.findBindingByInstanceId\(/u);
});

/** 把承载会话的 updated_at 压到固定旧值，便于断言编排活动后确实被推进。 */
function pinHostThreadUpdatedAt(h: ReturnType<typeof createHarness>, value = 1000): void {
  h.db.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(value, String(h.threadId));
}

function chatWorkflowActivityEvents(h: ReturnType<typeof createHarness>) {
  return h.emitted
    .filter((item) => item.type === "orchestration.chatWorkflowActivity")
    .map((item) => JSON.parse(item.payloadJson) as Record<string, unknown>);
}

test("绑定实例的编排活动会同步承载会话的活动时间并发出活动事件", async (t) => {
  const h = createHarness(t);
  const instanceId = createRunningInstance(h);
  linkChatWorkflowTask(h, instanceId);
  pinHostThreadUpdatedAt(h);

  await h.engine.pause(instanceId);

  const updatedAt = Number(h.db.threads.get(h.threadId)?.updatedAt ?? 0);
  assert.ok(updatedAt > 1000, "承载会话的 updated_at 必须随编排活动推进");
  const activities = chatWorkflowActivityEvents(h);
  assert.ok(activities.length >= 1, "编排活动必须发出承载会话的活动事件");
  const payload = activities[activities.length - 1]!;
  assert.equal(payload.threadId, String(h.threadId));
  assert.equal(payload.taskId, "task-signal");
  assert.equal(payload.instanceId, String(instanceId));
  assert.ok(Number(payload.updatedAt) > 1000);
});

test("未绑定会话工作流的普通编排实例不同步会话活动时间", async (t) => {
  const h = createHarness(t);
  const instanceId = createRunningInstance(h);
  pinHostThreadUpdatedAt(h);

  await h.engine.pause(instanceId);

  assert.equal(Number(h.db.threads.get(h.threadId)?.updatedAt ?? 0), 1000);
  assert.deepEqual(chatWorkflowActivityEvents(h), []);
  // 普通编排自身的事件不受影响
  assert.ok(h.emitted.some((item) => item.type === "orchestration.paused"));
});
