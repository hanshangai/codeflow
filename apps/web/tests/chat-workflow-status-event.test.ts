import assert from "node:assert/strict";
import test from "node:test";

import type { OrchestrationEventRecord } from "@codeflowai/shared";
import { createPinia, setActivePinia } from "pinia";

import { useChatStore } from "../src/store/chat.ts";

/** 构造编排事件；payload 走 JSON 字符串，与 WS 推送路径一致。 */
function orchestrationEvent(type: string, payload: Record<string, unknown>): OrchestrationEventRecord {
  return {
    id: "event-1" as OrchestrationEventRecord["id"],
    instanceId: "instance-1" as OrchestrationEventRecord["instanceId"],
    nodeId: null,
    type,
    payloadJson: JSON.stringify(payload),
    createdAt: 1,
  };
}

function newStore() {
  setActivePinia(createPinia());
  return useChatStore();
}

test("活跃态事件写入该会话的本地 overlay", () => {
  const store = newStore();
  store.handleOrchestrationEvent(orchestrationEvent("orchestration.chatWorkflowStatusChanged", {
    instanceId: "instance-1",
    threadId: "thread-1",
    taskId: "task-1",
    status: "running",
  }));
  assert.deepEqual(store.threadWorkflowByThreadId["thread-1"], {
    status: "running",
    instanceId: "instance-1",
    taskId: "task-1",
  });
});

test("终态事件清除该会话标签，其他会话不受影响", () => {
  const store = newStore();
  store.handleOrchestrationEvent(orchestrationEvent("orchestration.chatWorkflowStatusChanged", {
    instanceId: "instance-1", threadId: "thread-1", taskId: "task-1", status: "running",
  }));
  store.handleOrchestrationEvent(orchestrationEvent("orchestration.chatWorkflowStatusChanged", {
    instanceId: "instance-2", threadId: "thread-2", taskId: "task-2", status: "waiting-approval",
  }));
  store.handleOrchestrationEvent(orchestrationEvent("orchestration.chatWorkflowStatusChanged", {
    instanceId: "instance-1", threadId: "thread-1", taskId: "task-1", status: "completed",
  }));
  assert.equal(store.threadWorkflowByThreadId["thread-1"], undefined);
  assert.equal(store.threadWorkflowByThreadId["thread-2"]?.status, "waiting-approval");
});

test("缺 threadId 或非法 status 的事件不改动 overlay", () => {
  const store = newStore();
  store.handleOrchestrationEvent(orchestrationEvent("orchestration.chatWorkflowStatusChanged", {
    instanceId: "instance-1", status: "running",
  }));
  assert.deepEqual(store.threadWorkflowByThreadId, {});

  store.handleOrchestrationEvent(orchestrationEvent("orchestration.chatWorkflowStatusChanged", {
    instanceId: "instance-1", threadId: "thread-1", taskId: "task-1", status: "not-a-status",
  }));
  assert.deepEqual(store.threadWorkflowByThreadId, {});
});

test("无关类型事件不被该分支误消费，仍交给原有分支处理", () => {
  const store = newStore();
  store.handleOrchestrationEvent(orchestrationEvent("orchestration.managedServices.changed", {
    threadId: "thread-1",
  }));
  assert.equal(store.managedServicesByThreadId["thread-1"]?.stale, true);
  assert.deepEqual(store.threadWorkflowByThreadId, {});

  store.handleOrchestrationEvent(orchestrationEvent("orchestration.nodeStateChanged", {
    instanceId: "instance-1", threadId: "thread-1", status: "running",
  }));
  assert.deepEqual(store.threadWorkflowByThreadId, {});
});

test("setThreadWorkflowState 传入 null 即清除该会话标签，非活跃值同样按清除处理", () => {
  const store = newStore();
  store.setThreadWorkflowState("thread-1" as never, { status: "paused", instanceId: null, taskId: "task-1" });
  store.setThreadWorkflowState("thread-1" as never, null);
  assert.equal(store.threadWorkflowByThreadId["thread-1"], undefined);

  store.setThreadWorkflowState("thread-2" as never, { status: "pending", instanceId: null, taskId: "task-2" });
  assert.equal(store.threadWorkflowByThreadId["thread-2"]?.status, "pending");
});

/** 建一个已加载的会话摘要，供活动时间回填断言使用。 */
function seedThread(store: ReturnType<typeof newStore>, threadId: string, updatedAt: number): void {
  store.upsertThreadSummary({
    id: threadId,
    title: "会话",
    engine: "codex",
    threadType: "chat",
    threadSubtype: null,
    archived: false,
    createdAt: 1,
    updatedAt,
  } as never);
}

test("编排活动事件只回填该会话行的活动时间，不新建未加载会话", () => {
  const store = newStore();
  seedThread(store, "thread-1", 1);

  store.handleOrchestrationEvent(orchestrationEvent("orchestration.chatWorkflowActivity", {
    instanceId: "instance-1", threadId: "thread-1", taskId: "task-1", updatedAt: 500,
  }));
  assert.equal(store.getThreadSummary("thread-1" as never)?.updatedAt, 500);

  // 更旧的时间不回退
  store.handleOrchestrationEvent(orchestrationEvent("orchestration.chatWorkflowActivity", {
    instanceId: "instance-1", threadId: "thread-1", taskId: "task-1", updatedAt: 400,
  }));
  assert.equal(store.getThreadSummary("thread-1" as never)?.updatedAt, 500);

  // 未加载的会话不因活动事件被塞进列表
  store.handleOrchestrationEvent(orchestrationEvent("orchestration.chatWorkflowActivity", {
    instanceId: "instance-2", threadId: "thread-unknown", taskId: "task-2", updatedAt: 500,
  }));
  assert.equal(store.getThreadSummary("thread-unknown" as never), null);
});
