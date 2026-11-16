import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUnsupportedOrchestrationNodeQueueMessage,
  resolveOrchestrationNodeQueueBinding,
  resolveOrchestrationNodeQueueMode,
  type OrchestrationNodeQueueBinding,
} from "../../apps/desktop/client/src/queue/orchestrationNodeQueuePolicy.ts";

/** 构造指定状态的最小节点队列绑定。 */
function createBinding(status: string): OrchestrationNodeQueueBinding {
  return {
    workspaceId: "client-a:ws-demo" as any,
    instanceId: "orch-demo" as any,
    nodeId: "node-demo",
    status,
    humanActionSource: null,
  };
}

test("orchestration node queue only appends while the provider turn is running", () => {
  assert.equal(resolveOrchestrationNodeQueueMode(createBinding("running")), "active_supplement");

  for (const status of ["result-submitted", "finalizing", "artifact-writing", "gate-checking"]) {
    const binding = createBinding(status);
    assert.equal(resolveOrchestrationNodeQueueMode(binding), "unsupported");
    assert.equal(buildUnsupportedOrchestrationNodeQueueMessage(binding), "当前节点正在完成结果处理，请稍后再试。");
  }
});

test("queue binding skips terminal instance residue and selects the active instance deterministically", () => {
  const threadId = "thread-shared" as any;
  const workspaceId = "client-a:ws-demo" as any;
  const binding = resolveOrchestrationNodeQueueBinding({
    db: {
      threads: { get: () => ({ workspaceId }) },
      orchInstances: {
        listByWorkspace: () => [
          {
            id: "orch-terminal",
            status: "failed",
            createdAt: 300,
            updatedAt: 300,
            nodeStates: { stale: { threadId, status: "waiting-feedback", humanActionSource: "execution" } },
          },
          {
            id: "orch-active-old",
            status: "running",
            createdAt: 100,
            updatedAt: 100,
            nodeStates: { old: { threadId, status: "waiting-feedback", humanActionSource: "execution" } },
          },
          {
            id: "orch-active-current",
            status: "running",
            createdAt: 200,
            updatedAt: 200,
            nodeStates: { current: { threadId, status: "waiting-feedback", humanActionSource: "execution" } },
          },
        ] as any,
      },
    },
  }, threadId);

  assert.equal(binding?.instanceId, "orch-active-current");
  assert.equal(binding?.nodeId, "current");
});

test("queue binding predicate continues past a newer non-matching binding", () => {
  const threadId = "thread-shared" as any;
  const workspaceId = "client-a:ws-demo" as any;
  const binding = resolveOrchestrationNodeQueueBinding({
    db: {
      threads: { get: () => ({ workspaceId }) },
      orchInstances: {
        listByWorkspace: () => [
          {
            id: "orch-review",
            status: "waiting-feedback",
            createdAt: 200,
            updatedAt: 200,
            nodeStates: { review: { threadId, status: "waiting-feedback", humanActionSource: "review" } },
          },
          {
            id: "orch-execution",
            status: "waiting-feedback",
            createdAt: 100,
            updatedAt: 100,
            nodeStates: { execution: { threadId, status: "waiting-feedback", humanActionSource: "execution" } },
          },
        ] as any,
      },
    },
  }, threadId, (candidate) => (
    candidate.status === "waiting-feedback" && candidate.humanActionSource === "execution"
  ));

  assert.equal(binding?.instanceId, "orch-execution");
  assert.equal(binding?.nodeId, "execution");
});

test("执行型 waiting-feedback 直接继续当前节点，不读取历史恢复投影", () => {
  const binding = {
    ...createBinding("waiting-feedback"),
    humanActionSource: "execution" as const,
    errorCode: "codex_thread_resume_unrecoverable",
    providerThreadId: "provider-thread-existing",
    userChoiceRequired: true,
    recoveryStrategies: ["retry-existing", "new-thread"],
  };
  assert.equal(resolveOrchestrationNodeQueueMode(binding), "feedback_resume");
});
