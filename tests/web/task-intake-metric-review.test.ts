import assert from "node:assert/strict";
import test from "node:test";

import type {
  OrchestrationMetricEvaluationCohortItem,
  OrchestrationMetricEvaluationCohortSummary,
  OrchestrationMetricExperimentsResponse,
  TaskIntakeMetricCohortPairEvidenceRef,
  TaskIntakeMetricEvidenceRef,
} from "../../packages/shared/src/index.js";
import {
  buildTaskIntakeMetricReviewFilters,
  createTaskIntakeMetricReviewSnapshot,
  resolveTaskIntakeMetricReviewStatus,
} from "../../apps/web/src/features/orchestration/components/task-intake-metric-review.js";

const policy = { minEvaluatedSamples: 20, requiredCoverageRate: 1, confidenceLevel: 0.95 } as const;
const visiblePrivacy = {
  status: "visible",
  policy: "single_user_exempt",
  reason: null,
  minDistinctUsers: 5,
  detailsAllowed: true,
} as const;

/** Builds one internally consistent public evaluation summary. */
function summary(input: { evaluatedCount?: number; passedCount?: number; coverageRate?: number; low: number; high: number }): OrchestrationMetricEvaluationCohortSummary {
  const evaluatedCount = input.evaluatedCount ?? 20;
  const passedCount = input.passedCount ?? 14;
  const missingEvidenceCount = input.coverageRate === 0.9 ? Math.max(1, Math.round(evaluatedCount / 9)) : 0;
  const eligibleCount = evaluatedCount + missingEvidenceCount;
  return {
    factCount: eligibleCount,
    eligibleCount,
    evaluatedCount,
    passedCount,
    failedCount: evaluatedCount - passedCount,
    missingEvidenceCount,
    notEvaluatedCount: 0,
    coverageRate: input.coverageRate ?? 1,
    passRate: passedCount / evaluatedCount,
    confidenceLow: input.low,
    confidenceHigh: input.high,
  };
}

const baselineSnapshot = {
  cohortKey: "baseline", criterion: "trace_evidence_integrity", evaluatorId: "trace-grader", evaluatorVersion: "v1",
  workflowSnapshotHash: "workflow-v1", roleSnapshotHash: "role-v1", nodeId: "dev", promptDefinitionHash: "prompt-v1",
  engine: "codex", model: "gpt-5", effort: "high", current: null, comparison: null, conclusion: null,
};
const candidateSnapshot = {
  ...baselineSnapshot, cohortKey: "candidate", workflowSnapshotHash: "workflow-v2", promptDefinitionHash: "prompt-v2",
};
const pair: TaskIntakeMetricCohortPairEvidenceRef = {
  kind: "orchestration_evaluation_cohort_pair", scopeKind: "mine", scopeId: "user-1",
  currentPeriod: { from: 200, to: 300 }, comparisonPeriod: { from: 100, to: 200 },
  baseline: baselineSnapshot, candidate: candidateSnapshot,
  metricSchemaVersion: 18, metricDefinitionVersion: "2026-07-20.22", comparabilityPolicy: policy,
  hypothesis: "候选应改善", targetVersion: "workflow-v2", observationWindow: { from: 400, to: 500 }, reviews: null, createdAt: 350,
};

/** Builds one exact cohort item for either side of the review. */
function cohort(side: "baseline" | "candidate", evidence: OrchestrationMetricEvaluationCohortSummary): OrchestrationMetricEvaluationCohortItem {
  const snapshot = side === "baseline" ? baselineSnapshot : candidateSnapshot;
  return {
    cohortKey: snapshot.cohortKey, workflowSnapshotHash: snapshot.workflowSnapshotHash, nodeId: snapshot.nodeId,
    roleSnapshotHash: snapshot.roleSnapshotHash, promptDefinitionHash: snapshot.promptDefinitionHash,
    engine: snapshot.engine, model: snapshot.model, effort: snapshot.effort, evaluatorId: snapshot.evaluatorId,
    evaluatorVersion: snapshot.evaluatorVersion, criterion: snapshot.criterion,
    current: side === "candidate" ? evidence : null, comparison: side === "baseline" ? evidence : null,
    comparable: false, incompatibilityReasons: [], passRateDelta: null, conclusion: null,
  };
}

/** Builds one focused experiment response with frozen review periods. */
function response(item: OrchestrationMetricEvaluationCohortItem, generatedAt = 600): OrchestrationMetricExperimentsResponse {
  const empty = summary({ evaluatedCount: 0, passedCount: 0, low: 0, high: 0 });
  empty.passRate = null;
  empty.confidenceLow = null;
  empty.confidenceHigh = null;
  return {
    scope: { scopeKind: "mine", scopeId: "user-1" }, currentPeriod: { from: 400, to: 500 }, comparisonPeriod: { from: 200, to: 300 },
    currentTotals: empty, comparisonTotals: empty, cohorts: [item], total: 1, page: 1, pageSize: 50,
    generatedAt, metricSchemaVersion: 18, metricDefinitionVersion: "2026-07-20.22", comparabilityPolicy: policy,
    statistics: { status: "indeterminate", reasons: ["incomparable_periods"] },
    privacy: visiblePrivacy,
    comparisonPrivacy: visiblePrivacy,
  };
}

test("metric review resolves candidate, observation, and ready states without guessing", () => {
  assert.equal(resolveTaskIntakeMetricReviewStatus({ kind: "orchestration_evaluation_cohort" } as TaskIntakeMetricEvidenceRef, 600), "candidate_unbound");
  assert.equal(resolveTaskIntakeMetricReviewStatus(pair, 450), "waiting_observation");
  assert.equal(resolveTaskIntakeMetricReviewStatus(pair, 500), "ready_to_evaluate");
  assert.equal(resolveTaskIntakeMetricReviewStatus({ ...pair, metricDefinitionVersion: null }, 500), "insufficient_evidence");
  assert.deepEqual(buildTaskIntakeMetricReviewFilters(pair, pair.candidate.cohortKey), {
    scopeKind: "mine", scopeId: "user-1", from: 400, to: 500, compareMode: "custom", compareFrom: 200, compareTo: 300,
    page: 1, pageSize: 50, evaluationCriteria: ["trace_evidence_integrity"], experimentComparability: "all", experimentCohortKey: "candidate",
  });
});

test("metric review only verifies improvement when Wilson intervals strictly separate", async () => {
  const baselineResponse = response(cohort("baseline", summary({ passedCount: 10, low: 0.4, high: 0.65 })));
  const improvedResponse = response(cohort("candidate", summary({ passedCount: 17, low: 0.72, high: 0.94 })), 601);
  const improved = await createTaskIntakeMetricReviewSnapshot(pair, baselineResponse, improvedResponse);
  assert.equal(improved.status, "verified_improved");
  assert.deepEqual(improved.reasonCodes, []);

  const unchanged = await createTaskIntakeMetricReviewSnapshot(
    pair,
    baselineResponse,
    response(cohort("candidate", summary({ passedCount: 14, low: 0.58, high: 0.82 })), 602),
  );
  assert.equal(unchanged.status, "not_improved");
  assert.equal(unchanged.evidenceFingerprint.length, 64);
});

test("metric review preserves explicit insufficiency reasons and stable evidence fingerprints", async () => {
  const baselineResponse = response(cohort("baseline", summary({ passedCount: 10, low: 0.4, high: 0.65 })));
  const weakCandidate = response(cohort("candidate", summary({ evaluatedCount: 10, passedCount: 8, coverageRate: 0.9, low: 0.5, high: 0.95 })), 610);
  const first = await createTaskIntakeMetricReviewSnapshot(pair, baselineResponse, weakCandidate);
  const second = await createTaskIntakeMetricReviewSnapshot(pair, { ...baselineResponse, generatedAt: 611 }, { ...weakCandidate, generatedAt: 612 });
  assert.equal(first.status, "insufficient_evidence");
  assert.deepEqual(first.reasonCodes, ["candidate_sample_below_minimum", "candidate_evidence_incomplete"]);
  assert.equal(first.evidenceFingerprint, second.evidenceFingerprint);

  const versionMismatch = await createTaskIntakeMetricReviewSnapshot(
    { ...pair, metricDefinitionVersion: "old-definition" },
    baselineResponse,
    response(cohort("candidate", summary({ passedCount: 17, low: 0.72, high: 0.94 })), 613),
  );
  assert.equal(versionMismatch.status, "insufficient_evidence");
  assert.ok(versionMismatch.reasonCodes.includes("metric_version_mismatch"));

  const identityMismatch = await createTaskIntakeMetricReviewSnapshot(
    pair,
    response({ ...cohort("baseline", summary({ passedCount: 10, low: 0.4, high: 0.65 })), workflowSnapshotHash: "drifted-workflow" }),
    response(cohort("candidate", summary({ passedCount: 17, low: 0.72, high: 0.94 }))),
  );
  assert.equal(identityMismatch.status, "insufficient_evidence");
  assert.deepEqual(identityMismatch.reasonCodes, ["cohort_identity_mismatch"]);
  assert.equal(identityMismatch.baseline, null);
});

test("metric review rejects response scope or period drift", async () => {
  const baselineResponse = response(cohort("baseline", summary({ passedCount: 10, low: 0.4, high: 0.65 })));
  const candidateResponse = response(cohort("candidate", summary({ passedCount: 17, low: 0.72, high: 0.94 })));
  await assert.rejects(
    createTaskIntakeMetricReviewSnapshot(pair, baselineResponse, { ...candidateResponse, currentPeriod: { from: 401, to: 500 } }),
    /范围或周期/u,
  );
});

test("metric review rejects privacy-suppressed cohorts before snapshot creation", async () => {
  const baselineResponse = response(cohort("baseline", summary({ passedCount: 10, low: 0.4, high: 0.65 })));
  const candidateResponse = response(cohort("candidate", summary({ passedCount: 17, low: 0.72, high: 0.94 })));
  await assert.rejects(
    createTaskIntakeMetricReviewSnapshot(pair, baselineResponse, {
      ...candidateResponse,
      privacy: { ...visiblePrivacy, status: "suppressed", policy: "minimum_distinct_users", reason: "below_minimum", detailsAllowed: false },
    }),
    /隐私保护/u,
  );
});
