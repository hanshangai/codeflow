import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { EngineEventEnvelope, ThreadId, WorkspaceId } from "../../packages/shared/src/index.ts";
import { applyEngineEventToConversation } from "../../apps/web/src/features/chat/engineEventReducer.ts";
import type { ThreadConversationState } from "../../apps/web/src/features/chat/chatTypes.ts";
import { createConversationState as createBaseConversationState } from "../support/conversation-fixture.ts";

function createState(threadId = "orch-master-test" as ThreadId): ThreadConversationState {
  return createBaseConversationState({ threadId });
}

function createEvent<TType extends EngineEventEnvelope["type"]>(
  type: TType,
  payload: Extract<EngineEventEnvelope, { type: TType }>["payload"],
): Extract<EngineEventEnvelope, { type: TType }> {
  return {
    schema: 1,
    seq: 1,
    ts: Date.now(),
    workspaceId: "ws-test" as WorkspaceId,
    threadId: "orch-master-test" as ThreadId,
    engine: "claude",
    type,
    payload,
  } as Extract<EngineEventEnvelope, { type: TType }>;
}

test("orchestration master-thread events render as readable system messages", () => {
  const state = createState();

  applyEngineEventToConversation(state, createEvent("orchestration.started", {
    instanceId: "instance-1" as any,
    workflowName: "CodeFlow 标准功能开发",
  }));
  applyEngineEventToConversation(state, createEvent("orchestration.nodeStateChanged", {
    instanceId: "instance-1" as any,
    nodeId: "prd",
    nodeLabel: "需求分析师（PRD）",
    status: "running",
    threadId: null,
  }));
  applyEngineEventToConversation(state, createEvent("orchestration.error", {
    instanceId: "instance-1" as any,
    nodeId: "prd",
    error: "模型调用失败",
  }));

  assert.equal(state.items.length, 3);
  assert.deepEqual(
    state.items.map((item) => item.kind === "systemMessage" ? { type: item.type, text: item.text } : null),
    [
      { type: "info", text: "流程已启动：CodeFlow 标准功能开发" },
      { type: "info", text: "需求分析师（PRD） 状态变为 运行中" },
      { type: "error", text: "prd 执行失败：模型调用失败" },
    ],
  );
});

test("artifact publication messages do not claim that a review passed", () => {
  const state = createState();

  applyEngineEventToConversation(state, createEvent("orchestration.artifactPublished", {
    instanceId: "instance-1" as any,
    nodeId: "frontend-asset-review",
    nodeLabel: "前端资产评审",
    artifactId: "artifact-1",
    publishedPath: "codeflow-docs/reports/frontend-review.json",
    fileCount: 1,
  }));

  const message = state.items[0];
  assert.equal(message?.kind, "systemMessage");
  assert.equal(
    message?.kind === "systemMessage" ? message.text : null,
    "前端资产评审 产出物已发布：codeflow-docs/reports/frontend-review.json（1 个文件）",
  );
  assert.doesNotMatch(message?.kind === "systemMessage" ? message.text : "", /审核通过/);

  const monitorSource = readFileSync(
    new URL("../../apps/web/src/features/orchestration/components/orchestration-monitor.vue", import.meta.url),
    "utf8",
  );
  assert.ok(monitorSource.includes("产出物已发布 ${String(payload.publishedPath"));
  assert.equal(monitorSource.includes("审核通过 ${String(payload.publishedPath"), false);
});

test("nested short-lived turn does not clear the original running indicator", () => {
  const state = createState();

  applyEngineEventToConversation(state, createEvent("turn.started", {
    turnId: "turn-running" as any,
  }));
  const originalStartedAt = state.runningTurnStartedAt;

  applyEngineEventToConversation(state, createEvent("turn.started", {
    turnId: "turn-rejected" as any,
  }));
  applyEngineEventToConversation(state, createEvent("turn.error", {
    turnId: "turn-rejected" as any,
    terminationKind: "error",
    error: "当前 thread 有未完成的 turn",
  }));

  assert.equal(state.runningTurnId, "turn-running");
  assert.equal(state.runningTurnStartedAt, originalStartedAt);
  assert.equal(state.completedTurnIds["turn-rejected"], true);
});

test("completed event for a different turn does not clear the current running indicator", () => {
  const state = createState();

  applyEngineEventToConversation(state, createEvent("turn.started", {
    turnId: "turn-running" as any,
  }));
  const originalStartedAt = state.runningTurnStartedAt;

  applyEngineEventToConversation(state, createEvent("turn.completed", {
    turnId: "turn-other" as any,
    result: { responseText: "done" },
  }));

  assert.equal(state.runningTurnId, "turn-running");
  assert.equal(state.runningTurnStartedAt, originalStartedAt);
  assert.equal(state.completedTurnIds["turn-other"], true);
});
