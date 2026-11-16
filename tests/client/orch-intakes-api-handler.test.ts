import test from "node:test";
import { createUnusedExperimentExecutor } from "../support/controlled-experiment-fixture.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ClientToServerMessage,
  OrchestrationInstance,
  TaskIntake,
  WorkflowDefinition,
  WorkflowProposal,
  WorkspaceId,
} from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { listChatWorkflowActionRequestIds, listChatWorkflowCardIds, seedChatWorkflowCard } from "../support/chat-workflow-card-fixture.ts";
import { readOrchIntakeListSnapshot } from "../../apps/desktop/client/src/db/orchIntakeListSnapshot.ts";
import { handleApiRequest, type ApiHandlerContext } from "../../apps/desktop/client/src/app/handleApiRequest.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";
import { logger } from "../../apps/desktop/client/src/logger.ts";

function createHarness() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-orch-intakes-"));
  const workspaceId = "ws-orch-intakes" as WorkspaceId;
  const dbPath = path.join(workspacePath, "client.db");
  const db = openClientDb({ dbPath });
  const sent: ClientToServerMessage[] = [];
  const cancelledInstanceIds: string[] = [];
  const cancelAndWaitInstanceIds: string[] = [];
  const disposedThreadIds: string[] = [];
  const failingDisposedThreadIds = new Set<string>();

  db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
  /** 编排仓储位于工作区库；夹具读写必须使用与 API handler 相同的视图。 */
  const workspaceDb = db.forWorkspace(workspaceId);

  const ctx: ApiHandlerContext = {
    controlledExperiments: createUnusedExperimentExecutor(workspaceDb),
    /** ctx 仍传根 db，handler 会按 workspaceId 自行 scope 到工作区视图。 */
    db,
    orchIntakeListReader: {
      /** 测试内复用同一纯查询函数；生产入口只注入独立 worker service。 */
      async listIntakes(input) {
        return readOrchIntakeListSnapshot(workspaceDb.db, input);
      },
    },
    workspaces: new Map([[workspaceId, workspacePath]]),
    clientId: "client-test",
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    threads: new ThreadStore(),
    sessions: {
      async disposeThreadWithOptions(threadId: string) {
        if (failingDisposedThreadIds.has(String(threadId))) {
          throw new Error(`dispose failed: ${threadId}`);
        }
        disposedThreadIds.push(String(threadId));
      },
    } as any,
    orchEngine: {
      forWorkspace() {
        return this;
      },
      cancel(instanceId: string) {
        cancelledInstanceIds.push(String(instanceId));
      },
      async cancelAndWait(instanceId: string) {
        cancelAndWaitInstanceIds.push(String(instanceId));
      },
    } as any,
    send(message: ClientToServerMessage) {
      sent.push(message);
    },
  };

  async function call(method: string, body: Record<string, unknown>) {
    const id = `req-${method}-${Math.random().toString(36).slice(2, 8)}`;
    await handleApiRequest(ctx, {
      t: "api.req",
      id,
      method: method as any,
      path: `/${method}`,
      body,
    } as any);
    const response = [...sent].reverse().find((item) => item.t === "api.res" && item.id === id) as any;
    assert.ok(response, `missing api.res for ${method}`);
    return response;
  }

  function createIntake(title: string, goal: string): TaskIntake {
    return workspaceDb.orchIntakes.create({
      workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title,
      goal,
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: { source: "ui" },
    });
  }

  function createWorkflow(id: string): WorkflowDefinition {
    return {
      id: id as any,
      workspaceId,
      family: "feature-dev",
      name: `流程 ${id}`,
      description: "删除测试流程",
      workflowKnowledgeBundleIds: [],
      nodes: [
        { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
        { id: "role", type: "role", roleId: "role-test" as any, label: "执行", position: { x: 0, y: 120 } },
        { id: "end", type: "end", label: "结束", position: { x: 0, y: 240 } },
      ],
      edges: [
        { id: "edge-start", sourceNodeId: "start", targetNodeId: "role", conditionBranch: null, dataMappings: [] },
        { id: "edge-end", sourceNodeId: "role", targetNodeId: "end", conditionBranch: null, dataMappings: [] },
      ],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function createProposal(intake: TaskIntake, workflow: WorkflowDefinition): WorkflowProposal {
    return workspaceDb.orchProposals.create({
      workspaceId,
      intakeId: intake.id,
      intakeSnapshot: intake,
      status: "confirmed",
      recommendedFamily: workflow.family ?? "feature-dev",
      rationale: "测试删除链路",
      draftWorkflow: workflow,
      draftRoleBindings: [],
      draftKnowledgeBindings: [],
      warnings: [],
      requiresConfirmation: false,
      confirmedAt: Date.now(),
    });
  }

  function createInstance(
    intake: TaskIntake,
    workflow: WorkflowDefinition,
    proposal: WorkflowProposal,
    status: OrchestrationInstance["status"] = "pending",
  ): OrchestrationInstance {
    const masterThreadId = `thread-master-${proposal.id}` as any;
    const nodeThreadId = `thread-node-${proposal.id}` as any;
    const discussionThreadId = `thread-discussion-${proposal.id}` as any;
    workspaceDb.threads.create({
      id: masterThreadId,
      workspaceId,
      engine: "codex",
      title: "主线程",
      threadType: "orchestration",
      threadSubtype: "master",
    });
    workspaceDb.threads.create({
      id: nodeThreadId,
      workspaceId,
      engine: "codex",
      title: "节点线程",
      threadType: "chat",
      threadSubtype: "node",
    });
    workspaceDb.threads.create({
      id: discussionThreadId,
      workspaceId,
      engine: "codex",
      title: "讨论线程",
      threadType: "chat",
      threadSubtype: "node-discussion",
    });
    const created = workspaceDb.orchInstances.create({
      workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      masterThreadId,
      proposalId: proposal.id,
      intakeSnapshot: intake,
      roleSnapshots: {},
      toolsetSnapshots: {},
      runtimeConfig: null,
      artifactIndex: { role: [] },
    });
    const nodeStates = {
      ...created.nodeStates,
      role: {
        ...created.nodeStates.role,
        status: status === "paused" ? "pending" : status,
        threadId: nodeThreadId,
        discussionThreadId,
        startedAt: Date.now(),
        retryCount: 0,
      },
    };
    workspaceDb.orchInstances.updateStatus(created.id, status);
    workspaceDb.orchInstances.updateNodeStates(created.id, nodeStates);
    return workspaceDb.orchInstances.get(created.id)!;
  }

  function seedInstancePayload(instance: OrchestrationInstance): void {
    const artifact = workspaceDb.orchArtifacts.create({
      instanceId: instance.id,
      nodeId: "role",
      kind: "task-report",
      version: 1,
      title: "测试产出",
      schemaRef: null,
      status: "draft",
      contentJson: "{\"summary\":\"ok\"}",
      metadata: null,
      persistenceMode: "db-only",
      payloadMode: "text",
      workspaceStatus: null,
      workspaceBaseDir: null,
      stagingPath: null,
      publishedPath: null,
      contentHash: null,
      manifest: null,
    } as any);
    workspaceDb.orchArtifactFiles.replaceForArtifact(artifact.id, [{
      relPath: "docs/result.md",
      stagingPath: "docs/result.md",
      publishedPath: null,
      status: "staging",
      contentHash: "hash-1",
      sizeBytes: 10,
    }]);
    workspaceDb.orchEvents.append({
      instanceId: instance.id,
      nodeId: "role",
      type: "orchestration.started",
      payloadJson: "{}",
    });
    workspaceDb.orchFeedback.create({
      instanceId: instance.id,
      nodeId: "role",
      action: "retry",
      feedback: "请重试",
      artifactIds: [],
      createdAt: Date.now(),
    } as any);
    workspaceDb.orchPromptSnapshots.create({
      instanceId: instance.id,
      nodeId: "role",
      attemptNo: 1,
      threadId: null,
      turnId: null,
      engine: "codex",
      model: null,
      effort: null,
      promptEnvelope: {
        schemaVersion: "node-prompt-envelope/v1",
        meta: {
          scene: "orchestration-node",
          instanceId: instance.id,
          workflowId: instance.workflowId,
          workflowName: instance.workflowSnapshot.name,
          nodeId: "role",
          nodeLabel: "执行",
          intent: "execute",
        },
        role: {
          roleId: "role-test",
          name: "执行",
          description: "测试角色",
          responsibility: null,
          systemPrompt: null,
          formalTemplateName: "测试模板",
          inputDefinition: { instructions: "", requiredFields: [] },
          outputDefinition: {
            instructions: "",
            deliveryMode: "direct",
            format: "markdown",
            resultKey: null,
            filePathRule: null,
            files: [],
            requiredFields: [],
          },
        },
        task: {
          title: "测试目标",
          titlePathSegment: "测试目标",
          goal: "测试目标",
          background: null,
          acceptanceCriteria: null,
          renderedTaskInput: "",
          fieldBindings: {},
        },
        artifacts: { upstreamArtifacts: [] },
        knowledge: { catalogs: [], warnings: [] },
        review: { feedbackPatch: null },
        runtime: {
          runtimePolicy: {
            workflowId: instance.workflowId,
            workflowName: instance.workflowSnapshot.name,
            nodeId: "role",
            nodeLabel: "执行",
            approvalMode: "auto",
            executionEngine: "codex",
            executionProfileMode: "custom",
            executionProfileLabel: "codex:custom",
            accessMode: "current",
            toolRuntimePolicy: {
              allowedToolIds: [],
              requiresWorkspaceWrite: false,
            },
            artifactPolicy: {
              persistenceMode: "db-only",
              outputMode: "text",
              primaryKind: null,
            },
          },
          toolRegistry: null,
        },
      },
      systemMessage: "",
      developerMessage: null,
      userMessage: "执行测试",
      renderedInputPreview: "",
      runtimePolicy: {
        workflowId: instance.workflowId,
        workflowName: instance.workflowSnapshot.name,
        nodeId: "role",
        nodeLabel: "执行",
        approvalMode: "auto",
        executionEngine: "codex",
        executionProfileMode: "custom",
        executionProfileLabel: "codex:custom",
        accessMode: "current",
        toolRuntimePolicy: {
          allowedToolIds: [],
          requiresWorkspaceWrite: false,
        },
        artifactPolicy: {
          persistenceMode: "db-only",
          outputMode: "text",
          primaryKind: null,
        },
      },
      toolRegistry: null,
      knowledgeCatalogs: [],
      knowledgeWarnings: [],
      artifactInput: { artifacts: [], fieldBindings: {} },
      createdAt: Date.now(),
    } as any);
  }

  function updateSort(id: string, updatedAt: number): void {
    workspaceDb.db
      .prepare("UPDATE orch_intakes SET updated_at = ?, created_at = ? WHERE id = ?")
      .run(updatedAt, updatedAt, id);
    // 测试直接改排序字段后同步列表投影，避免绕过真实写路径的刷新副作用。
    workspaceDb.orchIntakeListStates.refreshIntake({ workspaceId, intakeId: id });
  }

  function updateInstanceSort(id: string, updatedAt: number): void {
    workspaceDb.db
      .prepare("UPDATE orch_instances SET updated_at = ?, created_at = ? WHERE id = ?")
      .run(updatedAt, updatedAt, id);
  }

  return {
    /** 测试准备与断言读取与 handler 相同的工作区视图；cleanup 仍关闭根库。 */
    db: workspaceDb,
    ctx,
    workspaceId,
    call,
    createIntake,
    createWorkflow,
    createProposal,
    createInstance,
    seedInstancePayload,
    updateSort,
    updateInstanceSort,
    cancelledInstanceIds,
    cancelAndWaitInstanceIds,
    disposedThreadIds,
    failingDisposedThreadIds,
    cleanup() {
      db.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

test("orch.intakes handlers accept scope only from trusted context and preserve unknown legacy records", async () => {
  const harness = createHarness();
  try {
    const intake = { title: "可信归属", goal: "正文不能决定归属", workspaceScope: { scopeType: "shared_workspace", scopeId: "forged" } };
    const unknown = await harness.call("orch.intakes.create", { workspaceId: harness.workspaceId, intake });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.intake.workspaceScope ?? null, null);
    (harness.ctx as any).intakeWorkspaceScope = { scopeType: "local_workspace", scopeId: harness.workspaceId };
    const local = await harness.call("orch.intakes.create", { workspaceId: harness.workspaceId, intake });
    assert.equal(local.status, 200);
    assert.deepEqual(local.body.intake.workspaceScope, { scopeType: "local_workspace", scopeId: harness.workspaceId });
    const edited = await harness.call("orch.intakes.upsert", { workspaceId: harness.workspaceId, intake: { ...local.body.intake, title: "编辑", workspaceScope: null } });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.body.intake.workspaceScope, local.body.intake.workspaceScope);
    const legacyEdit = await harness.call("orch.intakes.upsert", { workspaceId: harness.workspaceId, intake: { ...unknown.body.intake, title: "旧记录" } });
    assert.equal(legacyEdit.status, 200);
    assert.equal(legacyEdit.body.intake.workspaceScope ?? null, null);
  } finally {
    harness.cleanup();
  }
});

test("orch.intakes.create persists legacy and paired cohort evidence with strict identity checks", async () => {
  const harness = createHarness();
  try {
    const metricEvidenceRef = {
      kind: "orchestration_evaluation_cohort",
      scopeKind: "mine",
      scopeId: "user-1",
      cohortKey: "workflow\u001fdev\u001frole\u001fprompt-definition\u001fcodex\u001fgpt-5\u001fgrader\u001fv1\u001fcriterion",
      criterion: "trace_evidence_integrity",
      evaluatorId: "trace-evidence-integrity-grader",
      evaluatorVersion: "v1",
      workflowSnapshotHash: "workflow-v1",
      roleSnapshotHash: "role-v1",
      nodeId: "dev",
      promptDefinitionHash: "prompt-definition-v1",
      promptHash: null,
      engine: "codex",
      model: "gpt-5",
      effort: "high",
      currentPeriod: { from: 200, to: 300 },
      comparisonPeriod: { from: 100, to: 200 },
      current: { evaluatedCount: 20, coverageRate: 1, passRate: 0.8 },
      comparison: { evaluatedCount: 20, coverageRate: 1, passRate: 0.5 },
      conclusion: "improved",
      hypothesis: "提升运行证据完整率",
      targetVersion: "workflow-v2 / role-v2",
      observationWindow: { from: 400, to: 500 },
      createdAt: 300,
    };
    const created = await harness.call("orch.intakes.create", {
      workspaceId: harness.workspaceId,
      intake: {
        triggerMode: "manual", taskType: "analysis", title: "度量改进", goal: "改进评估结果",
        metricEvidenceRefs: [metricEvidenceRef], requester: { source: "ui" },
      },
    });
    assert.equal(created.status, 200);
    assert.deepEqual(created.body.intake.metricEvidenceRefs, [metricEvidenceRef]);

    const legacyEvidenceRef = {
      ...metricEvidenceRef,
      cohortKey: "legacy-cohort",
      promptHash: "prompt-v1",
      nodeId: undefined,
      promptDefinitionHash: undefined,
      effort: undefined,
    };
    const legacyCreated = await harness.call("orch.intakes.create", {
      workspaceId: harness.workspaceId,
      intake: {
        triggerMode: "manual", taskType: "analysis", title: "历史度量改进", goal: "兼容旧证据",
        metricEvidenceRefs: [legacyEvidenceRef], requester: { source: "ui" },
      },
    });
    assert.equal(legacyCreated.status, 200);

    const baseline = {
      cohortKey: "baseline-cohort", criterion: metricEvidenceRef.criterion,
      evaluatorId: metricEvidenceRef.evaluatorId, evaluatorVersion: metricEvidenceRef.evaluatorVersion,
      workflowSnapshotHash: "workflow-v1", roleSnapshotHash: "role-v1", nodeId: "dev",
      promptDefinitionHash: "prompt-definition-v1", engine: "codex", model: "gpt-5", effort: "high",
      current: metricEvidenceRef.current, comparison: metricEvidenceRef.comparison, conclusion: metricEvidenceRef.conclusion,
    };
    const candidate = {
      ...baseline, cohortKey: "candidate-cohort", workflowSnapshotHash: "workflow-v2",
      promptDefinitionHash: "prompt-definition-v2", conclusion: null,
    };
    const pairedEvidenceRef = {
      kind: "orchestration_evaluation_cohort_pair",
      scopeKind: "mine", scopeId: "user-1",
      currentPeriod: metricEvidenceRef.currentPeriod, comparisonPeriod: metricEvidenceRef.comparisonPeriod,
      baseline, candidate,
      metricSchemaVersion: 18, metricDefinitionVersion: "2026-07-20.22",
      comparabilityPolicy: { minEvaluatedSamples: 20, requiredCoverageRate: 1, confidenceLevel: 0.95 },
      hypothesis: metricEvidenceRef.hypothesis, targetVersion: metricEvidenceRef.targetVersion,
      observationWindow: metricEvidenceRef.observationWindow, reviews: null, createdAt: metricEvidenceRef.createdAt,
    };
    const pairedCreated = await harness.call("orch.intakes.create", {
      workspaceId: harness.workspaceId,
      intake: {
        triggerMode: "manual", taskType: "analysis", title: "候选度量改进", goal: "绑定明确候选",
        metricEvidenceRefs: [pairedEvidenceRef], requester: { source: "ui" },
      },
    });
    assert.equal(pairedCreated.status, 200);
    assert.deepEqual(pairedCreated.body.intake.metricEvidenceRefs, [pairedEvidenceRef]);

    const baselineReviewSummary = {
      factCount: 20, eligibleCount: 20, evaluatedCount: 20, passedCount: 10, failedCount: 10,
      missingEvidenceCount: 0, notEvaluatedCount: 0, coverageRate: 1, passRate: 0.5, confidenceLow: 0.3, confidenceHigh: 0.65,
    };
    const candidateReviewSummary = {
      factCount: 20, eligibleCount: 20, evaluatedCount: 20, passedCount: 17, failedCount: 3,
      missingEvidenceCount: 0, notEvaluatedCount: 0, coverageRate: 1, passRate: 0.85, confidenceLow: 0.72, confidenceHigh: 0.94,
    };
    const reviewEvidence = {
      status: "verified_improved", reasonCodes: [],
      baselinePeriod: pairedEvidenceRef.currentPeriod, candidatePeriod: pairedEvidenceRef.observationWindow,
      baseline: { cohortKey: baseline.cohortKey, summary: baselineReviewSummary },
      candidate: { cohortKey: candidate.cohortKey, summary: candidateReviewSummary },
      metricSchemaVersion: pairedEvidenceRef.metricSchemaVersion, metricDefinitionVersion: pairedEvidenceRef.metricDefinitionVersion,
      comparabilityPolicy: pairedEvidenceRef.comparabilityPolicy,
    };
    const review = {
      reviewId: "metric-review-1",
      evidenceFingerprint: crypto.createHash("sha256").update(JSON.stringify(reviewEvidence)).digest("hex"),
      ...reviewEvidence,
      evaluatedAt: pairedEvidenceRef.observationWindow.to,
    };
    const reviewedPair = { ...pairedEvidenceRef, reviews: [review] };
    const reviewedCreated = await harness.call("orch.intakes.create", {
      workspaceId: harness.workspaceId,
      intake: {
        triggerMode: "manual", taskType: "analysis", title: "已复评候选度量改进", goal: "保存复评历史",
        metricEvidenceRefs: [reviewedPair], requester: { source: "ui" },
      },
    });
    assert.equal(reviewedCreated.status, 200);
    assert.deepEqual(reviewedCreated.body.intake.metricEvidenceRefs, [reviewedPair]);

    const driftedReviewEvidence = {
      ...reviewEvidence,
      status: "insufficient_evidence",
      reasonCodes: ["metric_version_mismatch", "comparability_policy_mismatch"],
      metricDefinitionVersion: "2026-07-20.23",
      comparabilityPolicy: { ...pairedEvidenceRef.comparabilityPolicy, confidenceLevel: 0.9 },
    };
    const driftedReview = {
      reviewId: "metric-review-drifted",
      evidenceFingerprint: crypto.createHash("sha256").update(JSON.stringify(driftedReviewEvidence)).digest("hex"),
      ...driftedReviewEvidence,
      evaluatedAt: pairedEvidenceRef.observationWindow.to + 1,
    };
    const driftedCreated = await harness.call("orch.intakes.create", {
      workspaceId: harness.workspaceId,
      intake: {
        triggerMode: "manual", taskType: "analysis", title: "口径漂移复评", goal: "保留查询时版本和比较策略",
        metricEvidenceRefs: [{ ...pairedEvidenceRef, reviews: [driftedReview] }], requester: { source: "ui" },
      },
    });
    assert.equal(driftedCreated.status, 200);

    for (const invalidPair of [
      { ...pairedEvidenceRef, candidate: { ...candidate, cohortKey: baseline.cohortKey } },
      { ...pairedEvidenceRef, candidate: { ...baseline, cohortKey: "forged-candidate-cohort" } },
      { ...pairedEvidenceRef, candidate: { ...candidate, evaluatorId: "different-evaluator" } },
      { ...pairedEvidenceRef, candidate: { ...candidate, evaluatorVersion: "v2" } },
      { ...pairedEvidenceRef, candidate: { ...candidate, criterion: "different-criterion" } },
      { ...pairedEvidenceRef, candidate: { ...candidate, nodeId: undefined } },
      { ...pairedEvidenceRef, createdAt: 250, observationWindow: { from: 250, to: 350 } },
    ]) {
      const invalidPairResult = await harness.call("orch.intakes.create", {
        workspaceId: harness.workspaceId,
        intake: {
          triggerMode: "manual", taskType: "analysis", title: "非法候选绑定", goal: "拒绝损坏的候选对",
          metricEvidenceRefs: [invalidPair], requester: { source: "ui" },
        },
      });
      assert.equal(invalidPairResult.status, 400);
      assert.match(invalidPairResult.body.message, /metricEvidenceRefs/);
    }

    for (const invalidReview of [
      { ...review, candidate: { ...review.candidate, summary: { ...candidateReviewSummary, passedCount: 16 } } },
      { ...review, status: "verified_improved", candidate: { ...review.candidate, summary: { ...candidateReviewSummary, confidenceLow: 0.6 } } },
      { ...review, evaluatedAt: pairedEvidenceRef.observationWindow.to - 1 },
      { ...review, evidenceFingerprint: "b".repeat(64) },
      { ...review, candidate: { ...review.candidate, summary: { ...candidateReviewSummary, coverageRate: 0.95 } } },
    ]) {
      const invalidReviewResult = await harness.call("orch.intakes.create", {
        workspaceId: harness.workspaceId,
        intake: {
          triggerMode: "manual", taskType: "analysis", title: "非法复评历史", goal: "拒绝损坏的复评证据",
          metricEvidenceRefs: [{ ...pairedEvidenceRef, reviews: [invalidReview] }], requester: { source: "ui" },
        },
      });
      assert.equal(invalidReviewResult.status, 400);
      assert.match(invalidReviewResult.body.message, /metricEvidenceRefs/);
    }

    const damaged = await harness.call("orch.intakes.create", {
      workspaceId: harness.workspaceId,
      intake: {
        triggerMode: "manual", taskType: "analysis", title: "损坏度量证据", goal: "拒绝不完整的新证据",
        metricEvidenceRefs: [{ ...metricEvidenceRef, nodeId: undefined }], requester: { source: "ui" },
      },
    });
    assert.equal(damaged.status, 400);
    assert.match(damaged.body.message, /metricEvidenceRefs/);

    const rejected = await harness.call("orch.intakes.create", {
      workspaceId: harness.workspaceId,
      intake: {
        triggerMode: "manual", taskType: "analysis", title: "非法度量改进", goal: "拒绝重叠周期",
        metricEvidenceRefs: [{ ...metricEvidenceRef, currentPeriod: { from: 150, to: 250 } }],
      },
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.message, /metricEvidenceRefs/);

    const oversized = await harness.call("orch.intakes.create", {
      workspaceId: harness.workspaceId,
      intake: {
        triggerMode: "manual", taskType: "analysis", title: "非法度量字段", goal: "拒绝超长假设",
        metricEvidenceRefs: [{ ...metricEvidenceRef, hypothesis: "x".repeat(501) }],
      },
    });
    assert.equal(oversized.status, 400);
    assert.match(oversized.body.message, /metricEvidenceRefs/);

    const incomplete = await harness.call("orch.intakes.create", {
      workspaceId: harness.workspaceId,
      intake: {
        triggerMode: "manual", taskType: "analysis", title: "不完整改进元数据", goal: "拒绝部分字段",
        metricEvidenceRefs: [{ ...metricEvidenceRef, targetVersion: undefined }],
      },
    });
    assert.equal(incomplete.status, 400);
  } finally {
    harness.cleanup();
  }
});

test("handleApiRequest supports orch intake cursor pagination", async () => {
  const harness = createHarness();
  try {
    const newest = harness.createIntake("需求 A", "目标 A");
    const middle = harness.createIntake("需求 B", "目标 B");
    const oldest = harness.createIntake("需求 C", "目标 C");

    harness.updateSort(newest.id, 300);
    harness.updateSort(middle.id, 200);
    harness.updateSort(oldest.id, 100);

    const firstPage = await harness.call("orch.intakes.list", {
      workspaceId: harness.workspaceId,
      limit: 2,
    });
    assert.equal(firstPage.status, 200);
    assert.deepEqual(firstPage.body.intakes.map((item: TaskIntake) => item.id), [newest.id, middle.id]);
    assert.equal(firstPage.body.hasMore, true);
    assert.equal(firstPage.body.nextCursor, `200:${middle.id}`);

    const secondPage = await harness.call("orch.intakes.list", {
      workspaceId: harness.workspaceId,
      limit: 2,
      cursor: firstPage.body.nextCursor,
    });
    assert.equal(secondPage.status, 200);
    assert.deepEqual(secondPage.body.intakes.map((item: TaskIntake) => item.id), [oldest.id]);
    assert.equal(secondPage.body.hasMore, false);
    assert.equal(secondPage.body.nextCursor, null);
  } finally {
    harness.cleanup();
  }
});

test("orch.intakes.list filters by allowedResourceIds before pagination", async () => {
  const harness = createHarness();
  try {
    const newest = harness.createIntake("需求 A", "目标 A");
    const middle = harness.createIntake("需求 B", "目标 B");
    const oldest = harness.createIntake("需求 C", "目标 C");

    harness.updateSort(newest.id, 300);
    harness.updateSort(middle.id, 200);
    harness.updateSort(oldest.id, 100);

    const filtered = await harness.call("orch.intakes.list", {
      workspaceId: harness.workspaceId,
      limit: 2,
      allowedResourceIds: [oldest.id],
    });
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.body.intakes.map((item: TaskIntake) => item.id), [oldest.id]);
    assert.equal(filtered.body.hasMore, false);
    assert.equal(filtered.body.nextCursor, null);

    const empty = await harness.call("orch.intakes.list", {
      workspaceId: harness.workspaceId,
      allowedResourceIds: [],
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.intakes, []);
  } finally {
    harness.cleanup();
  }
});

test("orch.intakes.list takes local-only mode exclusively from trusted context", async () => {
  const harness = createHarness();
  try {
    const local = harness.db.orchIntakes.create({ workspaceId: harness.workspaceId, triggerMode: "manual", taskType: "feature", title: "Local", goal: "Local", workspaceScope: { scopeType: "local_workspace", scopeId: harness.workspaceId } });
    const shared = harness.db.orchIntakes.create({ workspaceId: harness.workspaceId, triggerMode: "manual", taskType: "feature", title: "Shared", goal: "Shared", workspaceScope: { scopeType: "shared_workspace", scopeId: "shared" } });
    const unknown = harness.createIntake("Unknown", "Unknown");
    harness.ctx.localWorkspaceOnly = true;
    const localResult = await harness.call("orch.intakes.list", { workspaceId: harness.workspaceId, localWorkspaceOnly: false });
    assert.equal(localResult.status, 200);
    assert.deepEqual(localResult.body.intakes.map((item: TaskIntake) => item.id), [local.id]);
    harness.ctx.localWorkspaceOnly = false;
    const remote = await harness.call("orch.intakes.list", { workspaceId: harness.workspaceId, localWorkspaceOnly: true });
    assert.equal(remote.status, 200);
    assert.deepEqual(new Set(remote.body.intakes.map((item: TaskIntake) => item.id)), new Set([local.id, shared.id, unknown.id]));
  } finally { harness.cleanup(); }
});

test("orch.intakes.list local prevalidation logs one safe failure and never falls back when reader is unavailable", async () => {
  const harness = createHarness();
  const logs: any[][] = [];
  const original = logger.error;
  logger.error = (...args: any[]) => { logs.push(args); };
  try {
    const good = harness.db.orchIntakes.create({ workspaceId: harness.workspaceId, triggerMode: "manual", taskType: "feature", title: "Good", goal: "Good", workspaceScope: { scopeType: "local_workspace", scopeId: harness.workspaceId } });
    const hidden = harness.createIntake("Hidden", "Hidden");
    const secret = "PRIVATE_HANDLER_INTAKE_JSON_ID";
    const raw = JSON.stringify({ ...hidden, id: secret });
    harness.db.db.prepare("UPDATE orch_intakes SET intake_json = ? WHERE id = ?").run(raw, hidden.id);
    harness.ctx.localWorkspaceOnly = true;
    const failed = await harness.call("orch.intakes.list", { workspaceId: harness.workspaceId, allowedResourceIds: [good.id], search: "Good" });
    assert.equal(failed.status, 500);
    assert.equal(failed.body.code, "ORCH_INTAKE_LIST_SNAPSHOT_INTAKE_INVALID");
    assert.equal(logs.length, 1);
    assert.equal(logs[0]![2].requestId, failed.id);
    assert.equal(logs[0]![2].workspaceId, harness.workspaceId);
    assert.equal(logs[0]![2].errorDetails.intakeId, hidden.id);
    assert.equal(logs[0]![2].errorDetails.reason, "json_identity_mismatch");
    assert.doesNotMatch(JSON.stringify({ logs, failed }), new RegExp(secret));
    logs.length = 0;
    harness.ctx.orchIntakeListReader = undefined;
    const unavailable = await harness.call("orch.intakes.list", { workspaceId: harness.workspaceId });
    assert.equal(unavailable.status, 500);
    assert.equal(unavailable.body.code, "ORCH_LIST_READER_UNAVAILABLE");
    assert.equal(logs.length, 1);
    logs.length = 0;
    harness.ctx.orchIntakeListReader = {
      /** 原 Reader 未就绪失败必须传回 handler，禁止改走主线程 SQL。 */
      async listIntakes() { throw Object.assign(new Error("Reader not ready"), { code: "CLIENT_DB_READER_CLOSED" }); },
    };
    const notReady = await harness.call("orch.intakes.list", { workspaceId: harness.workspaceId });
    assert.equal(notReady.status, 500);
    assert.equal(notReady.body.code, "CLIENT_DB_READER_CLOSED");
    assert.equal(logs.length, 1);
    assert.equal((harness.db.db.prepare("SELECT intake_json FROM orch_intakes WHERE id = ?").get(hidden.id) as any).intake_json, raw);
  } finally { logger.error = original; harness.cleanup(); }
});

test("orch.intakes.list validates workspace scope through the actual snapshot reader", async () => {
  const harness = createHarness();
  try {
    const unknown = harness.createIntake("旧未知归属", "仍可读取");
    const { workspaceScope: _unknownScope, ...legacy } = unknown;
    harness.db.db.prepare("UPDATE orch_intakes SET intake_json = ? WHERE id = ?").run(JSON.stringify(legacy), unknown.id);
    const local = harness.db.orchIntakes.create({ ...unknown, title: "本机归属", workspaceScope: { scopeType: "local_workspace", scopeId: harness.workspaceId } });
    const shared = harness.db.orchIntakes.create({ ...unknown, title: "共享归属", workspaceScope: { scopeType: "shared_workspace", scopeId: "shared-list" } });
    const listed = await harness.call("orch.intakes.list", { workspaceId: harness.workspaceId });
    assert.equal(listed.status, 200);
    const byId = new Map(listed.body.intakes.map((intake: TaskIntake) => [intake.id, intake]));
    assert.equal((byId.get(unknown.id) as TaskIntake).workspaceScope ?? null, null);
    assert.deepEqual((byId.get(local.id) as TaskIntake).workspaceScope, local.workspaceScope);
    assert.deepEqual((byId.get(shared.id) as TaskIntake).workspaceScope, shared.workspaceScope);
    let failure: any;
    harness.ctx.orchIntakeListReader = {
      /** 保留真实快照失败供诊断断言，仍由原 handler 翻译失败响应。 */
      async listIntakes(input) {
        try { return readOrchIntakeListSnapshot(harness.db.db, input); }
        catch (error) { failure = error; throw error; }
      },
    };
    for (const workspaceScope of [{}, [], { scopeType: "local_workspace", scopeId: "other" }, { scopeType: "shared_workspace", scopeId: " " }]) {
      const json = JSON.stringify({ ...shared, workspaceScope });
      harness.db.db.prepare("UPDATE orch_intakes SET intake_json = ? WHERE id = ?").run(json, shared.id);
      const rejected = await harness.call("orch.intakes.list", { workspaceId: harness.workspaceId });
      assert.equal(rejected.status, 500);
      assert.equal(rejected.body.ok, false);
      assert.equal(rejected.body.code, "ORCH_INTAKE_LIST_SNAPSHOT_INTAKE_INVALID");
      assert.deepEqual(failure.details, { requestId: rejected.id, workspaceId: harness.workspaceId, intakeId: shared.id, reason: "invalid_workspace_scope" });
      assert.equal(failure.cause.code, "ORCH_INTAKE_SCOPE_INVALID");
      assert.equal(failure.cause.message, "ORCH_INTAKE_SCOPE_INVALID");
      assert.equal((harness.db.db.prepare("SELECT intake_json FROM orch_intakes WHERE id = ?").get(shared.id) as any).intake_json, json);
    }
  } finally {
    harness.cleanup();
  }
});

test("orch.intakes.list fails explicitly when a list projection points to a missing summary", async () => {
  const harness = createHarness();
  try {
    const intake = harness.createIntake("带实例需求", "需要显示最新状态");
    const emptyIntake = harness.createIntake("无实例需求", "需要校验零实例投影");
    const workflow = harness.createWorkflow("wf-stale-list-meta");
    const instance = harness.createInstance(intake, workflow, harness.createProposal(intake, workflow), "completed");

    harness.db.db
      .prepare(
        `UPDATE orch_intake_list_states
         SET list_status = 'not-started',
             latest_instance_id = NULL,
             latest_instance_status = NULL,
             instance_count = 0,
             workflow_name = NULL,
             progress_text = NULL
         WHERE workspace_id = ? AND intake_id = ?`,
      )
      .run(harness.workspaceId, intake.id);
    harness.db.db
      .prepare(
        `UPDATE orch_intake_list_states
         SET list_status = 'running',
             latest_instance_id = 'missing-instance',
             latest_instance_status = 'running',
             instance_count = 1
         WHERE workspace_id = ? AND intake_id = ?`,
      )
      .run(harness.workspaceId, emptyIntake.id);

    const listed = await harness.call("orch.intakes.list", {
      workspaceId: harness.workspaceId,
      limit: 5,
    });

    assert.equal(listed.status, 500);
    assert.equal(listed.body.ok, false);
    assert.match(String(listed.body.code), /^ORCH_INSTANCE_SUMMARY_PROJECTION_/);
  } finally {
    harness.cleanup();
  }
});

test("orch.instances.list filters by allowedResourceIds before pagination", async () => {
  const harness = createHarness();
  try {
    const newest = harness.createIntake("需求 A", "目标 A");
    const middle = harness.createIntake("需求 B", "目标 B");
    const oldest = harness.createIntake("需求 C", "目标 C");
    const workflow = harness.createWorkflow("wf-instance-filter");
    const newestInstance = harness.createInstance(newest, workflow, harness.createProposal(newest, workflow));
    const middleInstance = harness.createInstance(middle, workflow, harness.createProposal(middle, workflow));
    const oldestInstance = harness.createInstance(oldest, workflow, harness.createProposal(oldest, workflow));

    harness.updateInstanceSort(newestInstance.id, 300);
    harness.updateInstanceSort(middleInstance.id, 200);
    harness.updateInstanceSort(oldestInstance.id, 100);

    const filtered = await harness.call("orch.instances.list", {
      workspaceId: harness.workspaceId,
      limit: 2,
      allowedResourceIds: [oldest.id],
    });
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.body.instances.map((item: any) => item.id), [oldestInstance.id]);
    assert.deepEqual(filtered.body.totalCountByIntake, { [oldest.id]: 1 });
    assert.equal(filtered.body.hasMore, false);

    const empty = await harness.call("orch.instances.list", {
      workspaceId: harness.workspaceId,
      allowedResourceIds: [],
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.instances, []);
    assert.deepEqual(empty.body.totalCountByIntake, {});
  } finally {
    harness.cleanup();
  }
});

test("orch list reads narrow projections without touching large node state JSON", async () => {
  const harness = createHarness();
  const sqlite = harness.db.db;
  const originalPrepare = sqlite.prepare.bind(sqlite);
  let detailSummaryReads = 0;
  let historicalSourceQueries = 0;
  try {
    const intake = harness.createIntake("大节点状态需求", "验证列表不重复解析详情文本");
    const workflow = harness.createWorkflow("wf-large-list-summary");
    const instance = harness.createInstance(intake, workflow, harness.createProposal(intake, workflow), "waiting-feedback");
    const current = harness.db.orchInstances.get(instance.id)!;
    (sqlite as any).prepare = (sql: string) => {
      if (sql.includes("node_states_json") && sql.includes("WHERE id IN (")) detailSummaryReads += 1;
      if (sql.includes("FROM orch_events") && sql.includes("triggerSource")) historicalSourceQueries += 1;
      return originalPrepare(sql);
    };
    harness.db.orchInstances.updateNodeStates(instance.id, {
      ...current.nodeStates,
      role: {
        ...current.nodeStates.role,
        status: "waiting-feedback",
        renderedInput: "x".repeat(1_000_000),
      },
    });

    const firstIntakes = await harness.call("orch.intakes.list", {
      workspaceId: harness.workspaceId,
      sourceKind: "requirement",
    });
    const firstInstances = await harness.call("orch.instances.list", {
      workspaceId: harness.workspaceId,
      sourceKind: "requirement",
    });
    assert.equal(firstIntakes.status, 200);
    assert.equal(firstInstances.status, 200);
    assert.equal(detailSummaryReads, 0);
    assert.equal(firstInstances.body.instances[0]?.runSummary.activeNodeStatus, "waiting-feedback");
    historicalSourceQueries = 0;
    for (let index = 0; index < 4; index += 1) {
      await harness.call("orch.intakes.list", { workspaceId: harness.workspaceId, sourceKind: "requirement" });
      await harness.call("orch.instances.list", { workspaceId: harness.workspaceId, sourceKind: "requirement" });
    }
    assert.equal(detailSummaryReads, 0);
    assert.equal(historicalSourceQueries, 0);

    const refreshed = harness.db.orchInstances.get(instance.id)!;
    harness.db.orchInstances.updateStatus(instance.id, "failed");
    harness.db.orchInstances.updateNodeStates(instance.id, {
      ...refreshed.nodeStates,
      role: { ...refreshed.nodeStates.role, status: "failed" },
    });
    const afterUpdate = await harness.call("orch.instances.list", {
      workspaceId: harness.workspaceId,
      sourceKind: "requirement",
    });
    assert.equal(afterUpdate.body.instances[0]?.status, "failed");
    assert.equal(detailSummaryReads, 0);
    assert.equal(historicalSourceQueries, 0);

    harness.db.orchArtifacts.create({
      instanceId: instance.id,
      nodeId: "role",
      kind: "task-report",
      version: 1,
      title: "缓存后新增产物",
      schemaRef: null,
      status: "draft",
      contentJson: "{}",
      metadata: null,
      persistenceMode: "db-only",
      payloadMode: "text",
      workspaceStatus: null,
      workspaceBaseDir: null,
      stagingPath: null,
      publishedPath: null,
      contentHash: null,
      manifest: null,
    } as any);
    const afterArtifact = await harness.call("orch.instances.list", {
      workspaceId: harness.workspaceId,
      sourceKind: "requirement",
    });
    assert.equal(afterArtifact.body.instances[0]?.runSummary.artifactCount, 1);
    assert.equal(detailSummaryReads, 0);
  } finally {
    (sqlite as any).prepare = originalPrepare;
    harness.cleanup();
  }
});

test("orch.intakes.list preserves waiting approval attention when the instance is paused", async () => {
  const harness = createHarness();
  try {
    const intake = harness.createIntake("暂停审批需求", "验证关注态优先级");
    const workflow = harness.createWorkflow("wf-paused-waiting-approval");
    const instance = harness.createInstance(
      intake,
      workflow,
      harness.createProposal(intake, workflow),
      "paused",
    );
    const current = harness.db.orchInstances.get(instance.id)!;
    harness.db.orchInstances.updateNodeStates(instance.id, {
      ...current.nodeStates,
      role: {
        ...current.nodeStates.role,
        status: "waiting-approval",
      },
    });

    const listed = await harness.call("orch.intakes.list", {
      workspaceId: harness.workspaceId,
      sourceKind: "requirement",
    });
    const meta = listed.body.listMetaById[intake.id];
    assert.equal(listed.status, 200);
    assert.equal(meta.listStatus, "paused");
    assert.equal(meta.latestInstance.status, "paused");
    assert.equal(meta.latestInstance.runSummary.activeNodeStatus, "waiting-approval");
    assert.equal(meta.attentionStatus, "waiting-approval");
    assert.equal(meta.attentionLabel, "待审批");
    assert.equal(meta.attentionActionKind, "open_orch_primary_action");
  } finally {
    harness.cleanup();
  }
});

test("orch completed intakes stay completed while local pending-mine receipts remain optional", async () => {
  const harness = createHarness();
  try {
    const completedIntake = harness.createIntake("已完成需求", "验证完成态不再被查收提醒覆盖");
    const completedWorkflow = harness.createWorkflow("wf-completed-list-status");
    const completedInstance = harness.createInstance(
      completedIntake,
      completedWorkflow,
      harness.createProposal(completedIntake, completedWorkflow),
      "completed",
    );
    const failedIntake = harness.createIntake("失败需求", "验证共享过滤后仍保留其他待处理项");
    const failedWorkflow = harness.createWorkflow("wf-failed-pending-mine");
    harness.createInstance(
      failedIntake,
      failedWorkflow,
      harness.createProposal(failedIntake, failedWorkflow),
      "failed",
    );

    const listed = await harness.call("orch.intakes.list", {
      workspaceId: harness.workspaceId,
      sourceKind: "requirement",
    });
    const completedMeta = listed.body.listMetaById[completedIntake.id];
    assert.equal(listed.status, 200);
    assert.equal(completedMeta.listStatus, "completed");
    assert.equal(completedMeta.listStatusLabel, "已完成");
    assert.equal(completedMeta.latestInstance.status, "completed");
    assert.equal(completedMeta.attentionStatus, undefined);
    assert.equal(completedMeta.attentionLabel, undefined);

    const localPendingMine = await harness.call("orch.pendingMine.list", {
      workspaceId: harness.workspaceId,
    });
    const receipt = localPendingMine.body.items.find((item: any) => item.pendingMineStatus === "receipt");
    assert.equal(localPendingMine.status, 200);
    assert.equal(receipt?.reminder.routeTarget.instanceId, completedInstance.id);
    assert.equal(receipt?.reminder.statusLabel, "待查收");

    const sharedPendingMine = await harness.call("orch.pendingMine.list", {
      workspaceId: harness.workspaceId,
      includeReceipts: false,
      limit: 1,
    });
    assert.equal(sharedPendingMine.status, 200);
    assert.deepEqual(sharedPendingMine.body.items.map((item: any) => item.pendingMineStatus), ["failed"]);
    assert.deepEqual(
      sharedPendingMine.body.statusCounts.map((item: any) => ({ status: item.status, count: item.count })),
      [{ status: "failed", count: 1 }],
    );
    assert.equal(sharedPendingMine.body.totalCount, 1);
    assert.equal(sharedPendingMine.body.hasMore, false);
    assert.equal(sharedPendingMine.body.nextCursor, null);
    assert.equal(JSON.parse(sharedPendingMine.body.listPageMeta.cursorScope).includeReceipts, false);
  } finally {
    harness.cleanup();
  }
});

test("orch lists preserve execution interruption labels across list projections", async () => {
  const harness = createHarness();
  try {
    const intake = harness.createIntake("异常中断需求", "验证列表状态一致性");
    const workflow = harness.createWorkflow("wf-execution-interrupted");
    const instance = harness.createInstance(
      intake,
      workflow,
      harness.createProposal(intake, workflow),
      "waiting-feedback",
    );
    const current = harness.db.orchInstances.get(instance.id)!;
    harness.db.orchInstances.updateNodeStates(instance.id, {
      ...current.nodeStates,
      role: {
        ...current.nodeStates.role,
        status: "waiting-feedback",
        humanActionSource: "execution",
        error: "stream disconnected before completion",
      },
    });

    const listed = await harness.call("orch.intakes.list", {
      workspaceId: harness.workspaceId,
      sourceKind: "requirement",
    });
    const listMeta = listed.body.listMetaById[intake.id];
    assert.equal(listed.status, 200);
    assert.equal(listMeta.latestInstance.runSummary.statusLabel, "异常中断");
    assert.equal(listMeta.attentionLabel, "异常中断");

    const pendingMine = await harness.call("orch.pendingMine.list", {
      workspaceId: harness.workspaceId,
    });
    assert.equal(pendingMine.status, 200);
    assert.equal(pendingMine.body.items[0]?.reminder.statusLabel, "异常中断");
    assert.equal(pendingMine.body.items[0]?.reminder.tone, "danger");
    assert.equal(pendingMine.body.items[0]?.reminder.summary, "执行 · 会话异常中断");
  } finally {
    harness.cleanup();
  }
});

test("orch list source filters use the maintained intake projection", async () => {
  const harness = createHarness();
  try {
    const requirement = harness.createIntake("普通需求", "只进入普通需求列表");
    const scheduled = harness.db.orchIntakes.create({
      workspaceId: harness.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "定时需求",
      goal: "只进入定时任务列表",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: { source: "scheduled_task" },
    });
    const workflow = harness.createWorkflow("wf-source-projection");
    const requirementInstance = harness.createInstance(requirement, workflow, harness.createProposal(requirement, workflow));
    const scheduledInstance = harness.createInstance(scheduled, workflow, harness.createProposal(scheduled, workflow));

    const requirementList = await harness.call("orch.instances.list", {
      workspaceId: harness.workspaceId,
      sourceKind: "requirement",
    });
    const scheduledList = await harness.call("orch.instances.list", {
      workspaceId: harness.workspaceId,
      sourceKind: "scheduled_task",
    });
    assert.deepEqual(requirementList.body.instances.map((item: any) => item.id), [requirementInstance.id]);
    assert.deepEqual(scheduledList.body.instances.map((item: any) => item.id), [scheduledInstance.id]);
    assert.deepEqual(requirementList.body.totalCountByIntake, { [requirement.id]: 1 });
    assert.deepEqual(scheduledList.body.totalCountByIntake, { [scheduled.id]: 1 });
  } finally {
    harness.cleanup();
  }
});

test("orch.intakes.delete rejects active instances unless forceDeleteRunning is set", async () => {
  const harness = createHarness();
  try {
    const intake = harness.createIntake("需求删除冲突", "有运行中实例");
    const workflow = harness.createWorkflow("wf-delete-conflict");
    const proposal = harness.createProposal(intake, workflow);
    harness.createInstance(intake, workflow, proposal, "running");

    const res = await harness.call("orch.intakes.delete", {
      workspaceId: harness.workspaceId,
      intakeId: intake.id,
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, "CONFLICT");
    assert.equal(res.body.details.reason, "ACTIVE_RUNNING_INSTANCE");
    assert.equal(harness.db.orchIntakes.get(intake.id)?.id, intake.id);
    assert.equal(harness.cancelledInstanceIds.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("orch.intakes.delete forceDeleteRunning cancels active instances and removes related records", async () => {
  const harness = createHarness();
  try {
    const intake = harness.createIntake("需求强制删除", "继续删除");
    const workflow = harness.createWorkflow("wf-delete-force");
    const proposal = harness.createProposal(intake, workflow);
    const instance = harness.createInstance(intake, workflow, proposal, "running");
    harness.seedInstancePayload(instance);

    const res = await harness.call("orch.intakes.delete", {
      workspaceId: harness.workspaceId,
      intakeId: intake.id,
      forceDeleteRunning: true,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.deletedProposalCount, 1);
    assert.equal(res.body.deletedInstanceCount, 1);
    assert.equal(res.body.deletedThreadCount, 3);
    assert.equal(res.body.cancelledActiveInstanceCount, 1);
    assert.deepEqual(harness.cancelAndWaitInstanceIds, [instance.id]);
    assert.equal(harness.disposedThreadIds.length, 3);
    assert.equal(harness.db.orchIntakes.get(intake.id), null);
    assert.equal(harness.db.orchProposals.listByWorkspace(harness.workspaceId).length, 0);
    assert.equal(harness.db.orchInstances.listByWorkspace(harness.workspaceId).length, 0);
    assert.equal(harness.db.orchArtifacts.listByInstance(instance.id).length, 0);
    assert.equal(harness.db.orchEvents.listByInstance(instance.id).length, 0);
    assert.equal(harness.db.orchFeedback.listByInstance(instance.id).length, 0);
    assert.equal(harness.db.orchPromptSnapshots.listByInstance(instance.id).length, 0);
  } finally {
    harness.cleanup();
  }
});

test("orch.intakes.delete rejects non-boolean forceDeleteRunning values", async () => {
  const harness = createHarness();
  try {
    const intake = harness.createIntake("需求布尔校验", "非法参数");
    const res = await harness.call("orch.intakes.delete", {
      workspaceId: harness.workspaceId,
      intakeId: intake.id,
      forceDeleteRunning: "false",
    });

    assert.equal(res.status, 400);
    assert.equal(harness.db.orchIntakes.get(intake.id)?.id, intake.id);
  } finally {
    harness.cleanup();
  }
});

test("orch.intakes.delete does not partially remove db records when thread disposal fails", async () => {
  const harness = createHarness();
  try {
    const intake = harness.createIntake("需求删除回滚", "dispose 失败");
    const workflow = harness.createWorkflow("wf-delete-dispose-fail");
    const proposal = harness.createProposal(intake, workflow);
    const instance = harness.createInstance(intake, workflow, proposal, "running");
    harness.seedInstancePayload(instance);
    harness.failingDisposedThreadIds.add(`thread-discussion-${proposal.id}`);

    const res = await harness.call("orch.intakes.delete", {
      workspaceId: harness.workspaceId,
      intakeId: intake.id,
      forceDeleteRunning: true,
    });

    assert.equal(res.status, 500);
    assert.equal(harness.db.orchIntakes.get(intake.id)?.id, intake.id);
    assert.equal(harness.db.orchProposals.listByWorkspace(harness.workspaceId).length, 1);
    assert.equal(harness.db.orchInstances.listByWorkspace(harness.workspaceId).length, 1);
    assert.equal(harness.db.orchArtifacts.listByInstance(instance.id).length, 1);
    assert.equal(harness.db.orchEvents.listByInstance(instance.id).length, 1);
    assert.equal(harness.db.orchFeedback.listByInstance(instance.id).length, 1);
    assert.equal(harness.db.orchPromptSnapshots.listByInstance(instance.id).length, 1);
  } finally {
    harness.cleanup();
  }
});

test("orch.intakes.delete removes chat workflow cards by intake id and keeps the cascade atomic", async () => {
  const harness = createHarness();
  try {
    const intake = harness.createIntake("需求删卡片", "删除需求时同步清理会话卡片");
    const workflow = harness.createWorkflow("wf-delete-cards");
    const proposal = harness.createProposal(intake, workflow);
    const instance = harness.createInstance(intake, workflow, proposal, "pending");
    seedChatWorkflowCard(harness.db, { id: "card-linked", workspaceId: harness.workspaceId,
      workflowId: workflow.id, intakeId: intake.id, instanceId: instance.id, requestId: "card-linked-start" });
    // state='starting' 时 instance_id 仍为 NULL：只按实例删会漏掉这张，必须走 intakeId 口径。
    seedChatWorkflowCard(harness.db, { id: "card-starting", workspaceId: harness.workspaceId,
      workflowId: workflow.id, intakeId: intake.id, state: "starting", requestId: "card-starting-start" });
    seedChatWorkflowCard(harness.db, { id: "card-other-intake", workspaceId: harness.workspaceId, workflowId: workflow.id, intakeId: "intake-unrelated" });
    assert.deepEqual(listChatWorkflowCardIds(harness.db), ["card-linked", "card-other-intake", "card-starting"]);

    const res = await harness.call("orch.intakes.delete", { workspaceId: harness.workspaceId, intakeId: intake.id, forceDeleteRunning: true });

    assert.equal(res.status, 200);
    assert.deepEqual(listChatWorkflowCardIds(harness.db), ["card-other-intake"]);
    assert.deepEqual(listChatWorkflowActionRequestIds(harness.db), []);
  } finally {
    harness.cleanup();
  }
});

test("orch.intakes.delete rolls back chat workflow card removal when the cascade fails", async () => {
  const harness = createHarness();
  try {
    const intake = harness.createIntake("需求删卡片回滚", "级联失败时卡片必须保留");
    seedChatWorkflowCard(harness.db, { id: "card-rollback", workspaceId: harness.workspaceId, workflowId: "wf-rollback", intakeId: intake.id, requestId: "card-rollback-start" });
    (harness.db.orchProposals as any).deleteByIntake = () => { throw new Error("proposal delete failed"); };

    const res = await harness.call("orch.intakes.delete", { workspaceId: harness.workspaceId, intakeId: intake.id });

    assert.equal(res.status, 500);
    assert.deepEqual(listChatWorkflowCardIds(harness.db), ["card-rollback"]);
    assert.deepEqual(listChatWorkflowActionRequestIds(harness.db), ["card-rollback-start"]);
  } finally {
    harness.cleanup();
  }
});



