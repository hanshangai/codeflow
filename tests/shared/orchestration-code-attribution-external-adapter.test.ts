import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrchestrationCodeAttributionExternalAdapterBatch,
  buildOrchestrationCodeAttributionExternalDeliveryCommit,
  buildOrchestrationCodeAttributionExternalSourceSystem,
  isOrchestrationCodeAttributionExternalSourceSystem,
  resolveOrchestrationCodeAttributionExternalCoverage,
} from "../../packages/shared/src/utils/orchestrationCodeAttribution.ts";
import type { OrchestrationMetricCodeAttributionExecutionRef } from "../../packages/shared/src/types/orchestrationMetrics.ts";

const COMMIT_SHA = "a".repeat(40);

/** Builds one source-code-free external fact used by adapter contract tests. */
function makeExternalInput() {
  return {
    adapterId: "cursor-hook-v1",
    associationId: "association-a",
    sourceBatchId: "external-batch-a",
    sourceRecordCount: 1,
    sourceContentSha256: "1".repeat(64),
    commit: {
      sourceWorkspaceId: "workspace-a",
      sourceInstanceId: "instance-a",
      repository: "example/repo",
      commitSha: COMMIT_SHA,
      disposition: "matched" as const,
      qualityStatus: "complete" as const,
      qualityReasons: [],
      commitEvidenceSha256: "2".repeat(64),
      observedAt: 1_000,
    },
    facts: [{
      sourceWorkspaceId: "workspace-a",
      sourceInstanceId: "instance-a",
      repository: "example/repo",
      commitSha: COMMIT_SHA,
      fileIdentitySha256: "3".repeat(64),
      language: "typescript",
      aiGeneratedAddedLines: 4,
      aiCandidateAddedLines: 3,
      retainedAiAddedLines: 2,
      committedAddedLines: 3,
      eligibleCommittedAddedLines: 3,
      coveredCommittedAddedLines: 3,
      qualityStatus: "complete" as const,
      qualityReasons: [],
      aiEvidenceSha256: "4".repeat(64),
      commitEvidenceSha256: "5".repeat(64),
      evidenceRef: `external-code-attribution:${"6".repeat(64)}`,
      executionRefs: [] as OrchestrationMetricCodeAttributionExecutionRef[],
      observedAt: 1_000,
      sourcePath: "D:/secret/repo/src/a.ts",
    }],
  };
}

test("外部 AI Hook 适配器使用规范来源身份并按白名单重建批次", () => {
  const batch = buildOrchestrationCodeAttributionExternalAdapterBatch(makeExternalInput());
  assert.equal(batch.sourceSystem, "external_code_attribution:cursor-hook-v1");
  assert.equal("adapterId" in batch, false);
  assert.equal("sourcePath" in batch.facts[0]!, false);
  assert.equal(isOrchestrationCodeAttributionExternalSourceSystem(batch.sourceSystem), true);
  assert.equal(isOrchestrationCodeAttributionExternalSourceSystem("external_code_attribution:Cursor"), false);
  assert.equal(buildOrchestrationCodeAttributionExternalSourceSystem("trae-hook"), "external_code_attribution:trae-hook");
  assert.throws(
    () => buildOrchestrationCodeAttributionExternalSourceSystem("Trae Hook"),
    /规范的小写标识/u,
  );
  assert.throws(
    () => buildOrchestrationCodeAttributionExternalSourceSystem("a".repeat(64)),
    /标识过长/u,
  );
  const forged = makeExternalInput();
  forged.facts[0]!.executionRefs = [{
    nodeId: "node-a",
    attemptId: "attempt-a",
    attemptNo: 1,
    promptSnapshotId: "prompt-a",
    threadId: "thread-a",
    turnId: "turn-a",
    evidenceSha256: "7".repeat(64),
  }];
  assert.throws(
    () => buildOrchestrationCodeAttributionExternalAdapterBatch(forged),
    /不能携带 CodeFlow 执行引用/u,
  );
});

test("外部 Hook 缺失状态显式映射为不可用且不推断为人工", () => {
  assert.deepEqual(resolveOrchestrationCodeAttributionExternalCoverage("complete"), {
    qualityStatus: "complete",
    qualityReasons: [],
  });
  for (const state of [
    "hook_not_installed",
    "unsupported_tool",
    "ai_trace_missing",
    "commit_diff_missing",
    "association_missing",
    "history_rewritten",
  ] as const) {
    assert.deepEqual(resolveOrchestrationCodeAttributionExternalCoverage(state), {
      qualityStatus: "unavailable",
      qualityReasons: [state],
    });
  }
});

test("代码平台权威提交只映射既有交付事件身份和受限证据引用", () => {
  const event = buildOrchestrationCodeAttributionExternalDeliveryCommit({
    associationId: "association-a",
    externalId: "commit-event-a",
    sourceWorkspaceId: "workspace-a",
    sourceInstanceId: "instance-a",
    repository: "example/repo",
    commitSha: COMMIT_SHA,
    committedAt: 2_000,
    evidenceRef: `external-delivery-evidence:${"7".repeat(64)}`,
  });
  assert.deepEqual(event, {
    associationId: "association-a",
    externalId: "commit-event-a",
    sourceWorkspaceId: "workspace-a",
    sourceInstanceId: "instance-a",
    kind: "commit",
    status: "succeeded",
    environment: null,
    repository: "example/repo",
    commitSha: COMMIT_SHA,
    pullRequestId: null,
    relatedExternalId: null,
    isRework: null,
    eventAt: 2_000,
    evidenceRef: `external-delivery-evidence:${"7".repeat(64)}`,
  });
  assert.equal(JSON.stringify(event).includes("diff"), false);
  assert.throws(
    () => buildOrchestrationCodeAttributionExternalDeliveryCommit({ ...event, committedAt: 2_000, evidenceRef: "https://secret/diff" }),
    /受限差异证据引用/u,
  );
});
