import type {
  OrchestrationMetricEvaluationCohortItem,
  OrchestrationMetricEvaluationCohortSummary,
  OrchestrationMetricEvaluationCriterion,
  OrchestrationMetricExperimentsResponse,
  OrchestrationMetricFilters,
  TaskIntakeMetricCohortPairEvidenceRef,
  TaskIntakeMetricCohortSnapshot,
  TaskIntakeMetricComparabilityPolicy,
  TaskIntakeMetricEvidenceRef,
  TaskIntakeMetricReviewReason,
  TaskIntakeMetricReviewSnapshot,
  TaskIntakeMetricReviewStatus,
  TaskIntakeMetricReviewSummary,
} from "@codeflowai/shared";

/** Resolves the finite review state before or after current metric evidence is loaded. */
export function resolveTaskIntakeMetricReviewStatus(
  evidence: TaskIntakeMetricEvidenceRef,
  now: number,
  currentReview: TaskIntakeMetricReviewSnapshot | null = null,
): TaskIntakeMetricReviewStatus {
  if (evidence.kind === "orchestration_evaluation_cohort") return "candidate_unbound";
  if (currentReview) return currentReview.status;
  if (!evidence.observationWindow || !evidence.metricSchemaVersion || !evidence.metricDefinitionVersion || !evidence.comparabilityPolicy) {
    return "insufficient_evidence";
  }
  return now < evidence.observationWindow.to ? "waiting_observation" : "ready_to_evaluate";
}

/** Builds one exact-cohort query using the frozen baseline and candidate periods. */
export function buildTaskIntakeMetricReviewFilters(
  evidence: TaskIntakeMetricCohortPairEvidenceRef,
  cohortKey: string,
): OrchestrationMetricFilters {
  if (!evidence.observationWindow) throw new Error("复评证据缺少观察窗口");
  return {
    scopeKind: evidence.scopeKind,
    scopeId: evidence.scopeId ?? null,
    from: evidence.observationWindow.from,
    to: evidence.observationWindow.to,
    compareMode: "custom",
    compareFrom: evidence.currentPeriod.from,
    compareTo: evidence.currentPeriod.to,
    page: 1,
    pageSize: 50,
    evaluationCriteria: [evidence.baseline.criterion as OrchestrationMetricEvaluationCriterion],
    experimentComparability: "all",
    experimentCohortKey: cohortKey,
  };
}

/** Creates one immutable review snapshot from server-owned cohort summaries and Wilson intervals. */
export async function createTaskIntakeMetricReviewSnapshot(
  evidence: TaskIntakeMetricCohortPairEvidenceRef,
  baselineResponse: OrchestrationMetricExperimentsResponse,
  candidateResponse: OrchestrationMetricExperimentsResponse,
): Promise<TaskIntakeMetricReviewSnapshot> {
  if (!evidence.observationWindow) throw new Error("复评证据缺少观察窗口");
  assertResponseContext(evidence, baselineResponse);
  assertResponseContext(evidence, candidateResponse);
  if (baselineResponse.comparisonPrivacy.status === "suppressed" || candidateResponse.privacy.status === "suppressed") {
    throw new Error("复评 Cohort 受隐私保护，不能生成评审快照");
  }
  if (baselineResponse.metricSchemaVersion !== candidateResponse.metricSchemaVersion
    || baselineResponse.metricDefinitionVersion !== candidateResponse.metricDefinitionVersion
    || !samePolicy(baselineResponse.comparabilityPolicy, candidateResponse.comparabilityPolicy)) {
    throw new Error("复评两侧响应的指标版本或比较策略不一致");
  }

  const reasons = new Set<TaskIntakeMetricReviewReason>();
  if (!evidence.metricSchemaVersion || !evidence.metricDefinitionVersion || !evidence.comparabilityPolicy) {
    reasons.add("metric_version_unavailable");
  } else {
    if (evidence.metricSchemaVersion !== baselineResponse.metricSchemaVersion
      || evidence.metricDefinitionVersion !== baselineResponse.metricDefinitionVersion) reasons.add("metric_version_mismatch");
    if (!samePolicy(evidence.comparabilityPolicy, baselineResponse.comparabilityPolicy)) reasons.add("comparability_policy_mismatch");
  }

  const baselineItem = baselineResponse.cohorts.find((item) => item.cohortKey === evidence.baseline.cohortKey) ?? null;
  const candidateItem = candidateResponse.cohorts.find((item) => item.cohortKey === evidence.candidate.cohortKey) ?? null;
  if (!baselineItem) reasons.add("baseline_cohort_missing");
  if (!candidateItem) reasons.add("candidate_cohort_missing");
  const baselineIdentityMatches = baselineItem !== null && sameCohortIdentity(evidence.baseline, baselineItem);
  const candidateIdentityMatches = candidateItem !== null && sameCohortIdentity(evidence.candidate, candidateItem);
  if (baselineItem && !baselineIdentityMatches) reasons.add("cohort_identity_mismatch");
  if (candidateItem && !candidateIdentityMatches) reasons.add("cohort_identity_mismatch");

  const baselineSummary = baselineIdentityMatches ? baselineItem.comparison : null;
  const candidateSummary = candidateIdentityMatches ? candidateItem.current : null;
  const policy = baselineResponse.comparabilityPolicy;
  collectSummaryReasons("baseline", baselineSummary, policy, reasons);
  collectSummaryReasons("candidate", candidateSummary, policy, reasons);

  const status = reasons.size > 0
    ? "insufficient_evidence" as const
    : (candidateSummary!.confidenceLow! > baselineSummary!.confidenceHigh! ? "verified_improved" as const : "not_improved" as const);
  const reasonCodes = [...reasons];
  const fingerprintPayload = {
    status,
    reasonCodes,
    baselinePeriod: evidence.currentPeriod,
    candidatePeriod: evidence.observationWindow,
    baseline: baselineSummary ? { cohortKey: evidence.baseline.cohortKey, summary: copySummary(baselineSummary) } : null,
    candidate: candidateSummary ? { cohortKey: evidence.candidate.cohortKey, summary: copySummary(candidateSummary) } : null,
    metricSchemaVersion: baselineResponse.metricSchemaVersion,
    metricDefinitionVersion: baselineResponse.metricDefinitionVersion,
    comparabilityPolicy: policy,
  };
  const evidenceFingerprint = await sha256(JSON.stringify(fingerprintPayload));
  const evaluatedAt = Math.max(baselineResponse.generatedAt, candidateResponse.generatedAt);
  return {
    reviewId: `metric_review_${evaluatedAt}_${evidenceFingerprint.slice(0, 12)}`,
    evidenceFingerprint,
    ...fingerprintPayload,
    evaluatedAt,
  };
}

/** Rejects responses that do not belong to the frozen scope and periods. */
function assertResponseContext(evidence: TaskIntakeMetricCohortPairEvidenceRef, response: OrchestrationMetricExperimentsResponse): void {
  const observationWindow = evidence.observationWindow!;
  if (response.scope.scopeKind !== evidence.scopeKind || (response.scope.scopeId ?? null) !== (evidence.scopeId ?? null)
    || !samePeriod(response.currentPeriod, observationWindow) || !samePeriod(response.comparisonPeriod, evidence.currentPeriod)) {
    throw new Error("复评响应的范围或周期与冻结证据不一致");
  }
}

/** Adds deterministic insufficiency reasons without recomputing server-owned intervals. */
function collectSummaryReasons(
  side: "baseline" | "candidate",
  summary: OrchestrationMetricEvaluationCohortSummary | null,
  policy: TaskIntakeMetricComparabilityPolicy,
  reasons: Set<TaskIntakeMetricReviewReason>,
): void {
  if (!summary) return;
  if (summary.evaluatedCount === null) throw new Error("复评 Cohort 结果受隐私保护");
  if (summary.evaluatedCount < policy.minEvaluatedSamples) reasons.add(`${side}_sample_below_minimum`);
  if (summary.coverageRate !== policy.requiredCoverageRate) reasons.add(`${side}_evidence_incomplete`);
  if (summary.passRate == null || summary.confidenceLow == null || summary.confidenceHigh == null) reasons.add(`${side}_interval_unavailable`);
}

/** Copies the public summary so later response mutation cannot change saved review evidence. */
function copySummary(summary: OrchestrationMetricEvaluationCohortSummary): TaskIntakeMetricReviewSummary {
  if (summary.eligibleCount === null || summary.evaluatedCount === null || summary.passedCount === null
    || summary.failedCount === null || summary.missingEvidenceCount === null || summary.notEvaluatedCount === null) {
    throw new Error("复评 Cohort 结果受隐私保护");
  }
  return {
    factCount: summary.factCount,
    eligibleCount: summary.eligibleCount,
    evaluatedCount: summary.evaluatedCount,
    passedCount: summary.passedCount,
    failedCount: summary.failedCount,
    missingEvidenceCount: summary.missingEvidenceCount,
    notEvaluatedCount: summary.notEvaluatedCount,
    coverageRate: summary.coverageRate,
    passRate: summary.passRate,
    confidenceLow: summary.confidenceLow,
    confidenceHigh: summary.confidenceHigh,
  };
}

/** Compares every server-owned field that participates in the exact cohort identity. */
function sameCohortIdentity(snapshot: TaskIntakeMetricCohortSnapshot, item: OrchestrationMetricEvaluationCohortItem): boolean {
  return snapshot.cohortKey === item.cohortKey && snapshot.criterion === item.criterion
    && snapshot.evaluatorId === item.evaluatorId && snapshot.evaluatorVersion === item.evaluatorVersion
    && snapshot.workflowSnapshotHash === item.workflowSnapshotHash && snapshot.nodeId === item.nodeId
    && snapshot.roleSnapshotHash === item.roleSnapshotHash && snapshot.promptDefinitionHash === item.promptDefinitionHash
    && snapshot.engine === item.engine && (snapshot.model ?? null) === item.model && (snapshot.effort ?? null) === item.effort;
}

/** Compares one frozen half-open period exactly. */
function samePeriod(left: { from: number; to: number }, right: { from: number; to: number }): boolean {
  return left.from === right.from && left.to === right.to;
}

/** Compares the complete public comparability policy. */
function samePolicy(left: TaskIntakeMetricComparabilityPolicy, right: TaskIntakeMetricComparabilityPolicy): boolean {
  return left.minEvaluatedSamples === right.minEvaluatedSamples
    && left.requiredCoverageRate === right.requiredCoverageRate
    && left.confidenceLevel === right.confidenceLevel;
}

/** Hashes the normalized evidence payload for idempotent history saves. */
async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
