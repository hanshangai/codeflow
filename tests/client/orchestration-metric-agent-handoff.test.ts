import assert from "node:assert/strict";
import test from "node:test";

import type {
  NodeArtifactInput,
  OrchestrationMetricNodeFact,
  ResolvedNodeContext,
} from "@codeflowai/shared";

import {
  deriveAgentHandoffFacts,
  type AgentHandoffContextEvidence,
  type AgentHandoffPromptEvidence,
} from "../../apps/desktop/client/src/app/handlers/orchMetricsHandlers.js";

/** Builds the node execution identity required by one handoff attempt. */
function nodeFact(): OrchestrationMetricNodeFact {
  return {
    sourceInstanceId: "instance-1", workflowSnapshotHash: "workflow-hash", nodeId: "node-1",
    nodeExecutionId: "execution-1", attemptNo: 1, parentExecutionId: null, nodeLabel: "实现",
    nodeType: "role", roleStageId: "role-1", roleStageName: "实现", status: "running",
    attemptCount: 1, retryCount: 0, startedAt: 100, completedAt: null, durationMs: null,
    hasGateFailure: false, hasValidationFailure: false, qualityFlags: [],
  };
}

/** Builds one frozen structured input context. */
function context(status: ResolvedNodeContext["status"]): AgentHandoffContextEvidence {
  const resolved = status === "resolved";
  const value: ResolvedNodeContext = {
    schemaVersion: "node-context/v1", contextId: "context-1", instanceId: "instance-1" as any,
    nodeId: "node-1", attemptNo: 1, status, createdAt: 100,
    task: { title: "任务", titlePathSegment: "任务", goal: "完成任务" },
    inputs: [{
      inputId: "input-field", targetKey: "spec", required: true,
      status: resolved ? "resolved" : "missing", errorCode: resolved ? null : "artifact_not_found",
      errorMessage: resolved ? null : "缺少输入",
      config: {
        id: "input-field", targetKey: "spec", sourceNodeId: "upstream", sourceResultName: "spec",
        sourceSelector: { type: "field", fieldKey: "title" }, required: true, promptMode: "inline-value",
      },
      source: resolved ? {
        nodeId: "upstream", artifactId: "artifact-1" as any, resultName: "spec", version: 1, status: "approved",
      } : null,
      value: resolved ? { type: "field", fieldKey: "title", valueJson: "\"标题\"" } : null,
      promptText: resolved ? "标题" : "",
    }],
    upstreamResults: [],
  };
  return { nodeId: "node-1", attemptNo: 1, status, context: value, createdAt: 100 };
}

/** Builds the structural Prompt Snapshot evidence for one resolved field input. */
function prompt(overrides: Partial<NodeArtifactInput> = {}): AgentHandoffPromptEvidence {
  return {
    id: "prompt-1", nodeId: "node-1", attemptNo: 1, createdAt: 120,
    artifactInput: {
      artifacts: [], fieldBindings: { spec: "标题" }, inputContextId: "context-1",
      inputReferences: [{
        inputId: "input-field", targetKey: "spec", required: true, selectorType: "field",
        promptMode: "inline-value", status: "resolved", sourceArtifactId: "artifact-1" as any,
        sourceFieldKey: "title",
      }],
      ...overrides,
    },
  };
}

test("执行前阻断仍保留在必需引用分母", () => {
  const facts = deriveAgentHandoffFacts({
    sourceInstanceId: "instance-1", nodeFacts: [nodeFact()], contexts: [context("missing_required")], prompts: [],
  });

  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0]?.expectedReferenceIds, ["input-field"]);
  assert.deepEqual(facts[0]?.availableReferenceIds, []);
  assert.deepEqual(facts[0]?.injectedReferenceIds, []);
  assert.equal(facts[0]?.promptSnapshotId, null);
  assert.deepEqual(facts[0]?.missingReasons, [{ inputId: "input-field", errorCode: "artifact_not_found" }]);
});

test("首个 Prompt Snapshot 证明 Artifact 注入和字段消费", () => {
  const facts = deriveAgentHandoffFacts({
    sourceInstanceId: "instance-1", nodeFacts: [nodeFact()], contexts: [context("resolved")], prompts: [prompt()],
  });

  assert.deepEqual(facts[0]?.availableReferenceIds, ["input-field"]);
  assert.deepEqual(facts[0]?.injectedReferenceIds, ["input-field"]);
  assert.deepEqual(facts[0]?.expectedFieldReferenceIds, ["input-field"]);
  assert.deepEqual(facts[0]?.consumedFieldReferenceIds, ["input-field"]);
  assert.match(facts[0]?.sourceFingerprint ?? "", /^[a-f0-9]{64}$/);
});

test("同一 Attempt 后续 Prompt 的交接结构漂移显式失败", () => {
  const changed = prompt({
    inputReferences: [{
      inputId: "input-field", targetKey: "spec", required: true, selectorType: "field",
      promptMode: "inline-value", status: "resolved", sourceArtifactId: "artifact-other" as any,
      sourceFieldKey: "title",
    }],
  });
  changed.id = "prompt-2";
  changed.createdAt = 130;

  assert.throws(() => deriveAgentHandoffFacts({
    sourceInstanceId: "instance-1", nodeFacts: [nodeFact()], contexts: [context("resolved")], prompts: [prompt(), changed],
  }), /Prompt Snapshot 在同一 Attempt 内漂移/);
});
