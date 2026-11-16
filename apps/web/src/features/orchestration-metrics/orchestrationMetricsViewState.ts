import {
  ORCHESTRATION_METRIC_DEFINITIONS,
  resolveWorkspaceIdAlias,
  type Artifact,
  type OrchestrationMetricCorrelationPoint,
  type OrchestrationMetricContractDetailItem,
  type OrchestrationMetricFlowResponse,
  type OrchestrationMetricFreshnessStatus,
  type OrchestrationMetricRateEnvelope,
  type OrchestrationMetricRouteTarget,
  type OrchestrationMetricSummary,
} from "@codeflowai/shared";

export type OrchestrationMetricsViewState = "loading" | "error" | "empty" | "content";
export type OrchestrationMetricsRefreshNotice = "success" | "info" | "warning" | "none";
export type OrchestrationMetricEvidenceTargetResolution =
  | { status: "ready"; workspaceId: string; intakeId: string; instanceId: string }
  | { status: "incomplete" }
  | { status: "workspace_unavailable" };
export type OrchestrationMetricArtifactTargetResolution =
  | { status: "ready"; artifactId: string }
  | { status: "invalid"; reason: string };
export type OrchestrationMetricOverview = {
  terminalTasks: number | null;
  recordedActiveTasks: number | null;
  periodEndWipTasks: number | null;
  periodEndWipUnresolvedTasks: number | null;
  periodEndAt: number | null;
  periodEndWipStatus: "available" | "missing_started_at" | "missing_observation" | "observation_before_range" | "partial_coverage" | "unsupported";
  verifiedSuccessRate: number | null;
  validationCoverageRate: number | null;
  firstPassRate: number | null;
  observedSuccess: OrchestrationMetricRateEnvelope | null;
  observedFirstPass: OrchestrationMetricRateEnvelope | null;
  observedContractPass: OrchestrationMetricRateEnvelope | null;
  durationSampleCount: number;
  medianDurationMs: number | null;
  p75DurationMs: number | null;
  p90DurationMs: number | null;
  p95DurationMs: number | null;
  flowEfficiency: number | null;
};

/** Adapts a complete legacy strict rate into the descriptive envelope contract. */
function resolveLegacyRateEnvelope(input: {
  definition: { metricId: string; metricVersion: string };
  envelope: OrchestrationMetricRateEnvelope | null | undefined;
  numerator: number | null | undefined;
  observedDenominator: number | null | undefined;
  eligibleDenominator: number | null | undefined;
  strictRate: number | null | undefined;
  populationComplete: boolean;
}): OrchestrationMetricRateEnvelope | null {
  if (input.envelope !== undefined) return input.envelope;
  if (input.numerator == null
    || input.observedDenominator == null
    || input.eligibleDenominator == null
    || input.strictRate == null
    || input.observedDenominator <= 0
    || input.observedDenominator !== input.eligibleDenominator) return null;
  return {
    metricId: input.definition.metricId,
    metricVersion: input.definition.metricVersion,
    status: "complete",
    populationStatus: input.populationComplete ? "authorized_scope" : "recorded_facts",
    numerator: input.numerator,
    observedDenominator: input.observedDenominator,
    eligibleDenominator: input.eligibleDenominator,
    missingCount: 0,
    observedRate: input.strictRate,
    lowerBound: input.strictRate,
    upperBound: input.strictRate,
  };
}

export function resolveOrchestrationMetricsViewState(input: {
  loading: boolean;
  errorMessage: string;
  hasSummary: boolean;
  totalTasks: number;
}): OrchestrationMetricsViewState {
  if (input.loading) return "loading";
  if (input.errorMessage) return "error";
  if (!input.hasSummary) return "loading";
  if (input.totalTasks === 0) return "empty";
  return "content";
}

export function resolveOrchestrationMetricsRefreshNotice(
  status: OrchestrationMetricFreshnessStatus,
): OrchestrationMetricsRefreshNotice {
  if (status === "fresh") return "success";
  if (status === "offline") return "info";
  if (status === "error" || status === "stale") return "warning";
  return "none";
}

/** Selects a stable two-dimensional quantile sample without changing statistical inputs. */
export function sampleOrchestrationMetricCorrelationPoints(
  points: OrchestrationMetricCorrelationPoint[],
  limit = 80,
): OrchestrationMetricCorrelationPoint[] {
  const sampleLimit = Math.max(0, Math.floor(limit));
  if (sampleLimit === 0 || points.length === 0) return [];
  const byCoordinates = (left: OrchestrationMetricCorrelationPoint, right: OrchestrationMetricCorrelationPoint) => (
    left.x - right.x || left.y - right.y || left.key.localeCompare(right.key)
  );
  const ordered = [...points].sort(byCoordinates);
  if (ordered.length <= sampleLimit) return ordered;

  const xBandCount = Math.min(10, sampleLimit);
  const yBandCount = Math.max(1, Math.floor(sampleLimit / xBandCount));
  const selected = new Map<string, OrchestrationMetricCorrelationPoint>();
  for (let xBand = 0; xBand < xBandCount; xBand += 1) {
    const xStart = Math.floor(xBand * ordered.length / xBandCount);
    const xEnd = Math.floor((xBand + 1) * ordered.length / xBandCount);
    const band = ordered.slice(xStart, xEnd).sort((left, right) => (
      left.y - right.y || left.x - right.x || left.key.localeCompare(right.key)
    ));
    const segmentCount = Math.min(yBandCount, band.length);
    for (let yBand = 0; yBand < segmentCount; yBand += 1) {
      const yStart = Math.floor(yBand * band.length / segmentCount);
      const yEnd = Math.floor((yBand + 1) * band.length / segmentCount);
      const representative = band.slice(yStart, yEnd).sort((left, right) => left.key.localeCompare(right.key))[0];
      if (representative) selected.set(representative.key, representative);
    }
  }
  if (selected.size < sampleLimit) {
    const remaining = ordered.filter((point) => !selected.has(point.key)).sort((left, right) => left.key.localeCompare(right.key));
    for (const point of remaining.slice(0, sampleLimit - selected.size)) selected.set(point.key, point);
  }
  return [...selected.values()].sort(byCoordinates);
}

/** Builds the overview from existing server-owned summary, specification, and flow metrics. */
export function resolveOrchestrationMetricOverview(
  summary: Pick<OrchestrationMetricSummary, "cards" | "specification">
    & Partial<Pick<OrchestrationMetricSummary, "coverage">>,
  flow: Pick<OrchestrationMetricFlowResponse, "totals"> | null,
): OrchestrationMetricOverview {
  const terminalTasks = summary.cards.completedTasks === null || summary.cards.failedOrInterruptedTasks === null
    ? null
    : summary.cards.completedTasks + summary.cards.failedOrInterruptedTasks;
  const recordedActiveTasks = terminalTasks === null || terminalTasks > summary.cards.totalTasks
    ? null
    : summary.cards.totalTasks - terminalTasks;
  const legacyPopulationComplete = !summary.coverage || (summary.coverage.sourceCount > 0
    && summary.coverage.onlineSourceCount === summary.coverage.sourceCount
    && summary.coverage.offlineSourceCount <= 0
    && (summary.coverage.successfulSourceCount === undefined
      || summary.coverage.successfulSourceCount === summary.coverage.sourceCount)
    && (summary.coverage.collectionFailedSourceCount ?? 0) <= 0
    && summary.coverage.truncatedSourceCount <= 0
    && summary.coverage.invalidPayloadCount <= 0);
  return {
    terminalTasks,
    recordedActiveTasks,
    periodEndWipTasks: summary.cards.periodEndWipTasks ?? null,
    periodEndWipUnresolvedTasks: summary.cards.periodEndWipUnresolvedTasks === undefined
      ? 0
      : summary.cards.periodEndWipUnresolvedTasks,
    periodEndAt: summary.cards.periodEndAt ?? null,
    periodEndWipStatus: summary.cards.periodEndWipStatus
      ?? (summary.cards.periodEndWipTasks != null
        ? "available"
        : (summary.cards.periodEndWipUnresolvedTasks ?? 0) > 0 ? "missing_started_at" : "unsupported"),
    verifiedSuccessRate: summary.cards.successRate,
    validationCoverageRate: summary.cards.validationCoverageRate,
    firstPassRate: summary.specification?.firstPassRate ?? null,
    observedSuccess: resolveLegacyRateEnvelope({
      definition: ORCHESTRATION_METRIC_DEFINITIONS.observedVerifiedSuccessRate,
      envelope: summary.cards.observedSuccess,
      numerator: summary.cards.successfulTasks,
      observedDenominator: summary.cards.validationCoveredTasks,
      eligibleDenominator: summary.cards.eligibleTasks,
      strictRate: summary.cards.successRate,
      populationComplete: legacyPopulationComplete,
    }),
    observedFirstPass: resolveLegacyRateEnvelope({
      definition: ORCHESTRATION_METRIC_DEFINITIONS.observedFirstPassRate,
      envelope: summary.specification?.observedFirstPass,
      numerator: summary.specification?.firstPassTasks,
      observedDenominator: summary.specification?.validationCoveredTasks,
      eligibleDenominator: summary.specification?.eligibleTasks,
      strictRate: summary.specification?.firstPassRate,
      populationComplete: legacyPopulationComplete,
    }),
    observedContractPass: resolveLegacyRateEnvelope({
      definition: ORCHESTRATION_METRIC_DEFINITIONS.observedContractPassRate,
      envelope: summary.specification?.observedContractPass,
      numerator: summary.specification?.passedContractFacts,
      observedDenominator: summary.specification?.evaluatedContractFacts,
      eligibleDenominator: summary.specification?.requiredContractFacts,
      strictRate: summary.specification?.contractPassRate,
      populationComplete: legacyPopulationComplete,
    }),
    durationSampleCount: summary.cards.durationSampleCount,
    medianDurationMs: summary.cards.medianDurationMs,
    p75DurationMs: summary.cards.p75DurationMs,
    p90DurationMs: summary.cards.p90DurationMs,
    p95DurationMs: summary.cards.p95DurationMs,
    flowEfficiency: flow?.totals.flowEfficiency ?? null,
  };
}

/** Resolves Artifact-backed contracts only when their key and evidence URI agree. */
export function resolveOrchestrationMetricArtifactId(
  item: Pick<OrchestrationMetricContractDetailItem, "contractType" | "contractKey" | "evidenceRef">,
): string | null {
  const evidenceRef = String(item.evidenceRef ?? "").trim();
  if (item.contractType === "artifact") {
    const artifactId = String(item.contractKey ?? "").trim();
    return artifactId && evidenceRef === `artifact:${artifactId}` ? artifactId : null;
  }
  if (item.contractType !== "output_field") return null;
  const match = /^artifact:([^#]+)#field:([^#]+)$/.exec(evidenceRef);
  if (!match) return null;
  try {
    const artifactId = decodeURIComponent(match[1]);
    const fieldKey = decodeURIComponent(match[2]);
    return String(item.contractKey ?? "").endsWith(`:${fieldKey}`) ? artifactId : null;
  } catch {
    return null;
  }
}

/** Rejects an Artifact response that drifts from the metric fact's instance or node identity. */
export function resolveOrchestrationMetricArtifactTarget(
  expected: { artifactId: string; instanceId: string; nodeId?: string | null },
  artifact: Pick<Artifact, "id" | "instanceId" | "nodeId">,
): OrchestrationMetricArtifactTargetResolution {
  if (String(artifact.id) !== expected.artifactId) {
    return { status: "invalid", reason: "Artifact 响应标识与度量事实不一致" };
  }
  if (String(artifact.instanceId) !== expected.instanceId) {
    return { status: "invalid", reason: "Artifact 所属实例与度量事实不一致" };
  }
  const expectedNodeId = String(expected.nodeId ?? "").trim();
  if (expectedNodeId && String(artifact.nodeId) !== expectedNodeId) {
    return { status: "invalid", reason: "Artifact 所属节点与度量事实不一致" };
  }
  return { status: "ready", artifactId: expected.artifactId };
}

/** Resolves one metric route target only when all IDs and one unique workspace alias exist. */
export function resolveOrchestrationMetricEvidenceTarget(
  routeTarget: OrchestrationMetricRouteTarget,
  workspaceIds: Iterable<string>,
): OrchestrationMetricEvidenceTargetResolution {
  const workspaceTarget = String(routeTarget.workspaceId ?? "").trim();
  const intakeId = String(routeTarget.intakeId ?? "").trim();
  const instanceId = String(routeTarget.instanceId ?? "").trim();
  if (!workspaceTarget || !intakeId || !instanceId) return { status: "incomplete" };
  const workspaceId = resolveWorkspaceIdAlias(workspaceTarget, workspaceIds);
  return workspaceId
    ? { status: "ready", workspaceId, intakeId, instanceId }
    : { status: "workspace_unavailable" };
}
