import assert from "node:assert/strict";
import test from "node:test";

import type { ClientToServerMessage, OrchestrationId, WorkspaceId } from "@codeflowai/shared";

import { handleOrchInstancesFeedback, handleOrchInstancesResume } from "../src/app/handlers/orchestrationHandlers.ts";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.ts";

const WORKSPACE_ID = "client-test:workspace-feedback" as WorkspaceId;
const INSTANCE_ID = "instance-feedback" as OrchestrationId;

function setup() {
  const sent: ClientToServerMessage[] = [];
  const submitCalls: Array<{ instanceId: string; nodeId: string; action: string; input: any }> = [];
  const resumeCalls: Array<{ instanceId: string }> = [];
  const instance = {
    id: INSTANCE_ID,
    workspaceId: WORKSPACE_ID,
    nodeStates: {
      analysis: {
        nodeId: "analysis",
        status: "waiting-feedback",
        humanActionSource: "execution",
        retryCount: 0,
      },
    },
  };
  const ctx = {
    workspaces: new Map([[WORKSPACE_ID, "C:\\workspace"]]),
    db: { orchInstances: { get: (id: string) => id === INSTANCE_ID ? instance : null } },
    orchEngine: {
      async submitFeedback(instanceId: string, nodeId: string, action: string, input: any) {
        submitCalls.push({ instanceId, nodeId, action, input });
      },
      async resumeInBackground(instanceId: string) {
        resumeCalls.push({ instanceId });
      },
    },
    send(message: ClientToServerMessage) {
      sent.push(message);
    },
  } as unknown as ApiHandlerContext;
  return { ctx, sent, submitCalls, resumeCalls };
}

function request(body: Record<string, unknown>): ApiRequestMessage {
  return {
    t: "api.req",
    id: `req-${Math.random()}`,
    method: "orch.instances.feedback",
    path: "/orch/instances/feedback",
    body: {
      workspaceId: WORKSPACE_ID,
      instanceId: INSTANCE_ID,
      nodeId: "analysis",
      action: "retry",
      ...body,
    },
  } as ApiRequestMessage;
}

function resumeRequest(body: Record<string, unknown>): ApiRequestMessage {
  return {
    t: "api.req",
    id: `req-resume-${Math.random()}`,
    method: "orch.instances.resume",
    path: "/orch/instances/resume",
    body: {
      workspaceId: WORKSPACE_ID,
      instanceId: INSTANCE_ID,
      nodeId: "analysis",
      ...body,
    },
  } as ApiRequestMessage;
}

function instanceResumeRequest(body: Record<string, unknown>): ApiRequestMessage {
  const requestBody = resumeRequest(body).body as Record<string, unknown>;
  delete requestBody.nodeId;
  return { ...resumeRequest(body), body: requestBody } as ApiRequestMessage;
}

function response(sent: ClientToServerMessage[]): any {
  return sent.find((message) => message.t === "api.res");
}

test("反馈 handler 不读取或透传旧会话策略字段", async () => {
  const harness = setup();
  await handleOrchInstancesFeedback(harness.ctx, request({
    recoveryStrategy: "new-thread",
    threadReusePolicy: "new-thread",
    feedback: "继续",
  }));

  assert.equal(response(harness.sent)?.status, 200);
  assert.equal(harness.submitCalls.length, 1);
  assert.equal(harness.submitCalls[0]?.input.feedback, "继续");
  assert.equal("recoveryStrategy" in harness.submitCalls[0]!.input, false);
  assert.equal("threadReusePolicy" in harness.submitCalls[0]!.input, false);
});

test("带 nodeId 的实例 resume 只提交一次反馈且不透传旧会话策略", async () => {
  const harness = setup();
  await handleOrchInstancesResume(harness.ctx, resumeRequest({
    recoveryStrategy: "new-thread",
    threadReusePolicy: "new-thread",
    feedback: "继续当前节点",
  }));

  assert.equal(response(harness.sent)?.status, 200);
  assert.equal(harness.submitCalls.length, 1);
  assert.equal(harness.submitCalls[0]?.action, "resume_with_input");
  assert.equal(harness.submitCalls[0]?.input.feedback, "继续当前节点");
  assert.equal("recoveryStrategy" in harness.submitCalls[0]!.input, false);
  assert.equal("threadReusePolicy" in harness.submitCalls[0]!.input, false);
  assert.deepEqual(harness.resumeCalls, []);
});

test("实例级 resume 忽略旧会话策略并执行一次后台恢复", async () => {
  const harness = setup();
  await handleOrchInstancesResume(harness.ctx, instanceResumeRequest({
    recoveryStrategy: "new-thread",
    threadReusePolicy: "new-thread",
  }));

  assert.equal(response(harness.sent)?.status, 200);
  assert.equal(harness.submitCalls.length, 0);
  assert.deepEqual(harness.resumeCalls, [{ instanceId: INSTANCE_ID }]);
});
