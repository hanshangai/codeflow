import assert from "node:assert/strict";
import test from "node:test";
import * as shared from "../../packages/shared/src/index.ts";

test("会话展示快照隔离过程正文，保留正文和单条过程入口", () => {
  assert.equal(typeof shared.buildThreadPresentation, "function");
  const state = shared.createConversationState("thread" as shared.ThreadId);
  state.items.push(
    { kind: "message", id: "user" as shared.ItemId, role: "user", text: "查看项目", format: "plain" },
    { kind: "reasoning", id: "reasoning" as shared.ItemId, content: "secret-detail-".repeat(100) },
    { kind: "message", id: "assistant" as shared.ItemId, role: "assistant", text: "正在检查", format: "plain" },
  );
  const result = shared.buildThreadPresentation(state, 12);
  assert.deepEqual(result.items.map(item => item.kind), ["message", "process", "message"]);
  const process = result.items[1] as shared.ConversationProcess;
  assert.equal(process.id, "process:reasoning");
  assert.equal(process.itemCount, 1);
  assert.ok(process.preview.length <= 160);
  assert.ok(!JSON.stringify(result).includes("secret-detail-".repeat(20)));
  assert.equal((result.items[2] as shared.ConversationMessage).text, "正在检查");
});

test("过程分组复用工具展示规则，任务清单和审批不折叠", () => {
  const state = shared.createConversationState("thread" as shared.ThreadId);
  state.items.push(
    { kind: "tool", id: "read1" as shared.ItemId, toolType: "Read", title: "Read", detail: '{"path":"src/a.ts"}', status: "completed" },
    { kind: "tool", id: "read2" as shared.ItemId, toolType: "Read", title: "Read", detail: '{"path":"src/b.ts"}', status: "completed" },
    { kind: "tool", id: "plan" as shared.ItemId, toolType: "update_plan", title: "plan", detail: "任务清单", status: "completed" },
    { kind: "approvalRequest", id: "approval" as shared.ItemId, requestId: "request" as any, state: "pending" } as shared.ConversationApprovalRequest,
  );
  const result = shared.buildThreadPresentation(state, 20);
  assert.deepEqual(result.items.map(item => item.kind), ["process", "tool", "approvalRequest"]);
  const process = result.items[0] as shared.ConversationProcess;
  assert.equal(process.id, "process:read1");
  assert.equal(process.itemCount, 1);
  assert.deepEqual(process.statusCounts, { done: 1, running: 0, warning: 0, failed: 0 });
});

test("过程版本通知不携带推理和工具正文，任务状态事件保持直接可见", () => {
  const event = { schema: 1, seq: 27, ts: 1, workspaceId: "workspace", threadId: "thread", engine: "codex",
    type: "item.reasoning.delta", payload: { itemId: "reasoning", delta: "private reasoning" } } as shared.ConversationEventEnvelope;
  assert.deepEqual(shared.toConversationDisplayMessage(event), { t: "conversation.changed", workspaceId: "workspace", threadId: "thread", version: 27 });
  const terminal = { ...event, type: "turn.completed", payload: { turnId: "turn" } } as shared.ConversationEventEnvelope;
  assert.deepEqual(shared.toConversationDisplayMessage(terminal), { t: "conversation.event", event: terminal });
});

test("工具完成通知保留资源刷新信号并剥离输出和diff正文", () => {
  const event = { schema: 1, seq: 28, ts: 1, workspaceId: "workspace", threadId: "thread", engine: "codex",
    type: "item.tool.completed", payload: { itemId: "tool", toolName: "Write", status: "completed", output: "private output",
      changes: [{ path: "a.ts", diff: "private diff" }] } } as shared.ConversationEventEnvelope;
  assert.deepEqual(shared.toConversationDisplayMessage(event), { t: "conversation.changed", workspaceId: "workspace", threadId: "thread", version: 28,
    toolCompleted: { seq: 28, toolName: "Write", hasFileChanges: true, managedServicesChanged: false } });
  assert.ok(!JSON.stringify(shared.toConversationDisplayMessage(event)).includes("private"));
});

test("没有toolName的任务清单状态仍独立直达", () => {
  const event = { schema: 1, seq: 29, ts: 1, workspaceId: "workspace", threadId: "thread", engine: "codex",
    type: "item.tool.inputUpdated", payload: { itemId: "plan", todolistItems: [{ step: "检查", status: "in_progress" }] } } as shared.ConversationEventEnvelope;
  assert.deepEqual(shared.toConversationDisplayMessage(event), { t: "conversation.event", event });
});
