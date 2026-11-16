import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EngineEventEnvelope } from "@codeflowai/shared";

import type { ThreadConversationState } from "../src/features/chat/chatTypes.ts";
import { createConversationState as createBaseConversationState } from "../../../tests/support/conversation-fixture.ts";
import { applyEngineEventToConversation } from "../src/features/chat/engineEventReducer.ts";
import { buildThreadPresentation, restoreConversationState } from "@codeflowai/shared";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function createConversationState(): ThreadConversationState {
  return createBaseConversationState({ threadId: "thread-orch-label" });
}

function buildOrchestrationEvent(type: EngineEventEnvelope["type"], payload: Record<string, unknown>): EngineEventEnvelope {
  return {
    schema: 1,
    seq: 1,
    ts: 1,
    workspaceId: "client-a:ws-demo" as never,
    threadId: "thread-orch-label" as never,
    engine: "codex",
    type,
    payload,
  } as EngineEventEnvelope;
}

/** 取出会话里最后一条编排系统消息文案。 */
function lastSystemMessageText(state: ThreadConversationState): string {
  const items = state.items.filter((item) => item.kind === "systemMessage") as Array<{ text: string }>;
  return String(items[items.length - 1]?.text ?? "");
}

test("会话编排事件文案按 nodeId 显示当前定义名，且不改写事件载荷", () => {
  const state = createConversationState();
  const event = buildOrchestrationEvent("orchestration.nodeStateChanged", {
    instanceId: "instance-1", nodeId: "dev", nodeLabel: "开发", status: "completed",
  });

  applyEngineEventToConversation(state, event, new Map([["dev", "新开发"]]));

  assert.equal(lastSystemMessageText(state), "新开发 状态变为 已完成");
  assert.equal((event.payload as Record<string, unknown>).nodeLabel, "开发", "事件载荷必须保持冻结旧名");
});

test("退回事件的起止节点名同样按 nodeId 取当前定义名", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildOrchestrationEvent("orchestration.reworkRequested", {
    instanceId: "instance-1", fromNodeId: "review", fromNodeLabel: "审核", targetNodeId: "dev", targetNodeLabel: "开发",
  }), new Map([["dev", "新开发"], ["review", "新审核"]]));

  assert.equal(lastSystemMessageText(state), "新审核 已退回到 新开发");
});

test("没有当前定义映射时事件文案保留冻结旧名", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildOrchestrationEvent("orchestration.approvalRequested", {
    instanceId: "instance-1", nodeId: "dev", nodeLabel: "开发",
  }));

  assert.equal(lastSystemMessageText(state), "开发 等待人工审核");
});

test("节点已从当前定义删除时回退冻结旧名，不显示 nodeId", () => {
  const state = createConversationState();

  applyEngineEventToConversation(state, buildOrchestrationEvent("orchestration.artifactWritten", {
    instanceId: "instance-1", nodeId: "removed-node", nodeLabel: "已删除节点", artifactKind: "报告",
  }), new Map([["dev", "新开发"]]));

  assert.equal(lastSystemMessageText(state), "已删除节点 已生成报告");
});

test("监控事件时间线按 nodeId 走实例当前快照，不再直接读 payload 冻结名", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "apps/web/src/features/orchestration/components/orchestration-monitor.vue"),
    "utf8",
  );

  assert.match(source, /function eventNodeLabel\(payload: Record<string, unknown>\): string/u);
  assert.doesNotMatch(source, /payload\.nodeLabel \?\? payload\.nodeId/u, "事件摘要必须统一走 eventNodeLabel 解析");
});

test("持久化展示快照恢复时按当前节点映射刷新文案", () => {
  const state = createConversationState();
  applyEngineEventToConversation(state, buildOrchestrationEvent("orchestration.reworkRequested", {
    instanceId: "instance-1", fromNodeId: "review", fromNodeLabel: "审核", targetNodeId: "dev", targetNodeLabel: "开发",
  }));
  const snapshot = JSON.parse(JSON.stringify(buildThreadPresentation(state, 1)));
  const restored = restoreConversationState(snapshot.state, snapshot.items, new Map([["dev", "新开发"], ["review", "新审核"]]));
  assert.equal(lastSystemMessageText(restored), "新审核 已退回到 新开发");
  assert.equal(lastSystemMessageText(state), "审核 已退回到 开发");
});
