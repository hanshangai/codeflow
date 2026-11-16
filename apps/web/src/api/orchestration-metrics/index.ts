import type {
  ApiResult,
  ControlledExperimentCreateRequest,
  ControlledExperimentDetail,
  ControlledExperimentListResponse,
  OrchestrationMetricAnalysisResponse,
  OrchestrationMetricBottleneckResponse,
  OrchestrationMetricBottleneckSignal,
  OrchestrationMetricCorrelationMetric,
  OrchestrationMetricCorrelationResponse,
  OrchestrationMetricCodeAttributionResponse,
  OrchestrationMetricCostsResponse,
  OrchestrationMetricContractDetailsResponse,
  OrchestrationMetricConformanceResponse,
  OrchestrationMetricDetailsResponseBody,
  OrchestrationMetricDeliveryResponse,
  OrchestrationMetricFilters,
  OrchestrationMetricFlowResponse,
  OrchestrationMetricExportJob,
  OrchestrationMetricExportDataset,
  OrchestrationMetricExperimentsResponse,
  OrchestrationMetricEvaluationCriterion,
  OrchestrationMetricEvaluationSetItem,
  OrchestrationMetricEvaluationSetItemsResponse,
  OrchestrationMetricEvaluationSetKind,
  OrchestrationMetricEvaluationSetSummary,
  OrchestrationMetricEvaluationSetsResponse,
  OrchestrationMetricRefreshResponseBody,
  OrchestrationMetricNodeDetailsResponse,
  OrchestrationMetricScopesResponseBody,
  OrchestrationMetricSourceRetryResponseBody,
  OrchestrationMetricSourcesResponseBody,
  OrchestrationMetricSummary,
} from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";
import { createBrowserUuid } from "../../utils/browserUuid";

/** 页面需求退出时将同一取消信号传递到指标 HTTP 请求。 */
type MetricRequestContext = ApiRequestContext & { signal?: AbortSignal };

/** 沿现有指标接口处理当前请求，页面退出时允许取消等待。 */
export function getOrchestrationMetricScopes(
  ctx: MetricRequestContext,
): Promise<ApiResult<OrchestrationMetricScopesResponseBody>> {
  return requestJson(ctx, { signal: ctx.signal, method: "GET", path: "/api/account/orchestration-metrics/scopes" });
}

/** 沿现有指标接口处理当前请求，页面退出时允许取消等待。 */
export function getOrchestrationMetricSummary(
  ctx: MetricRequestContext,
  filters: OrchestrationMetricFilters,
): Promise<ApiResult<OrchestrationMetricSummary>> {
  return requestJson(ctx, { signal: ctx.signal,
    method: "GET",
    path: buildQueryPath("/api/account/orchestration-metrics/summary", toQuery(filters)),
  });
}

/** 沿现有指标接口处理当前请求，页面退出时允许取消等待。 */
export function refreshOrchestrationMetrics(
  ctx: MetricRequestContext,
  filters: OrchestrationMetricFilters,
  mode: "incremental" | "full",
): Promise<ApiResult<OrchestrationMetricRefreshResponseBody>> {
  return requestJson(ctx, { signal: ctx.signal,
    method: "POST",
    path: "/api/account/orchestration-metrics/refresh",
    body: { ...toQuery(filters), mode },
  });
}

/** Loads authorized source health and unreconciled delivery diagnostics. */
export function getOrchestrationMetricSources(
  ctx: MetricRequestContext,
  filters: OrchestrationMetricFilters,
): Promise<ApiResult<OrchestrationMetricSourcesResponseBody>> {
  return requestJson(ctx, { signal: ctx.signal,
    method: "GET",
    path: buildQueryPath("/api/account/orchestration-metrics/sources", toQuery(filters)),
  });
}

/** Retries one server-authorized failed source without replacing the range snapshot. */
export function retryOrchestrationMetricSource(
  ctx: MetricRequestContext,
  sourceKey: string,
  filters: OrchestrationMetricFilters,
): Promise<ApiResult<OrchestrationMetricSourceRetryResponseBody>> {
  return requestJson(ctx, { signal: ctx.signal,
    method: "POST",
    path: `/api/account/orchestration-metrics/sources/${encodeURIComponent(sourceKey)}/retry`,
    body: toQuery(filters),
  });
}

/** 沿现有指标接口处理当前请求，页面退出时允许取消等待。 */
export function getOrchestrationMetricDetails(
  ctx: MetricRequestContext,
  filters: OrchestrationMetricFilters,
): Promise<ApiResult<OrchestrationMetricDetailsResponseBody>> {
  return requestJson(ctx, { signal: ctx.signal,
    method: "GET",
    path: buildQueryPath("/api/account/orchestration-metrics/details", toQuery(filters)),
  });
}

/** 沿现有指标接口处理当前请求，页面退出时允许取消等待。 */
export function getOrchestrationMetricAnalysis(ctx: MetricRequestContext, filters: OrchestrationMetricFilters): Promise<ApiResult<OrchestrationMetricAnalysisResponse>> {
  return requestJson(ctx, { signal: ctx.signal, method: "GET", path: buildQueryPath("/api/account/orchestration-metrics/analysis", toQuery(filters)) });
}

/** Loads cycle-time decomposition and flow-efficiency facts for the selected scope. */
export function getOrchestrationMetricFlow(ctx: MetricRequestContext, filters: OrchestrationMetricFilters): Promise<ApiResult<OrchestrationMetricFlowResponse>> {
  return requestJson(ctx, { signal: ctx.signal, method: "GET", path: buildQueryPath("/api/account/orchestration-metrics/flow", toQuery(filters)) });
}

/** 沿现有指标接口处理当前请求，页面退出时允许取消等待。 */
export function getOrchestrationMetricBottlenecks(ctx: MetricRequestContext, filters: OrchestrationMetricFilters & { signal?: OrchestrationMetricBottleneckSignal }): Promise<ApiResult<OrchestrationMetricBottleneckResponse>> {
  return requestJson(ctx, { signal: ctx.signal, method: "GET", path: buildQueryPath("/api/account/orchestration-metrics/bottlenecks", { ...toQuery(filters), signal: filters.signal }) });
}

/** 沿现有指标接口处理当前请求，页面退出时允许取消等待。 */
export function getOrchestrationMetricCorrelations(ctx: MetricRequestContext, filters: OrchestrationMetricFilters & { xMetric?: OrchestrationMetricCorrelationMetric; yMetric?: OrchestrationMetricCorrelationMetric }): Promise<ApiResult<OrchestrationMetricCorrelationResponse>> {
  return requestJson(ctx, { signal: ctx.signal, method: "GET", path: buildQueryPath("/api/account/orchestration-metrics/correlations", { ...toQuery(filters), xMetric: filters.xMetric, yMetric: filters.yMetric }) });
}

/** 沿现有指标接口处理当前请求，页面退出时允许取消等待。 */
export function getOrchestrationMetricNodeDetails(ctx: MetricRequestContext, filters: OrchestrationMetricFilters): Promise<ApiResult<OrchestrationMetricNodeDetailsResponse>> {
  return requestJson(ctx, { signal: ctx.signal, method: "GET", path: buildQueryPath("/api/account/orchestration-metrics/node-details", toQuery(filters)) });
}

/** Loads one server-paged contract evidence slice for specification drill-down. */
export function getOrchestrationMetricContractDetails(ctx: MetricRequestContext, filters: OrchestrationMetricFilters): Promise<ApiResult<OrchestrationMetricContractDetailsResponse>> {
  return requestJson(ctx, { signal: ctx.signal, method: "GET", path: buildQueryPath("/api/account/orchestration-metrics/contract-details", toQuery(filters)) });
}

/** Loads one server-paged workflow conformance slice and its evidence targets. */
export function getOrchestrationMetricConformance(ctx: MetricRequestContext, filters: OrchestrationMetricFilters): Promise<ApiResult<OrchestrationMetricConformanceResponse>> {
  return requestJson(ctx, { signal: ctx.signal, method: "GET", path: buildQueryPath("/api/account/orchestration-metrics/conformance", toQuery(filters)) });
}

/** Loads Agent Trace token, tool, and immutable cost-snapshot facts. */
export function getOrchestrationMetricCosts(ctx: MetricRequestContext, filters: OrchestrationMetricFilters): Promise<ApiResult<OrchestrationMetricCostsResponse>> {
  return requestJson(ctx, { signal: ctx.signal, method: 'GET', path: buildQueryPath('/api/account/orchestration-metrics/costs', toQuery(filters)) });
}

/** Loads exact-version evaluation cohorts for the current and comparison periods. */
export function getOrchestrationMetricExperiments(ctx: MetricRequestContext, filters: OrchestrationMetricFilters): Promise<ApiResult<OrchestrationMetricExperimentsResponse>> {
  return requestJson(ctx, { signal: ctx.signal, method: "GET", path: buildQueryPath("/api/account/orchestration-metrics/experiments", toQuery(filters)) });
}

/** Loads reconciled delivery facts and exact DORA metrics for the selected scope. */
export function getOrchestrationMetricDelivery(ctx: MetricRequestContext, filters: OrchestrationMetricFilters): Promise<ApiResult<OrchestrationMetricDeliveryResponse>> {
  return requestJson(ctx, { signal: ctx.signal, method: "GET", path: buildQueryPath("/api/account/orchestration-metrics/delivery", toQuery(filters)) });
}

/** Loads authorized code contribution totals, trends, dimensions, and commit evidence. */
export function getOrchestrationMetricCodeAttribution(
  ctx: MetricRequestContext,
  filters: OrchestrationMetricFilters,
): Promise<ApiResult<OrchestrationMetricCodeAttributionResponse>> {
  return requestJson(ctx, { signal: ctx.signal,
    method: "GET",
    path: buildQueryPath("/api/account/orchestration-metrics/code-attribution", toQuery(filters)),
  });
}

/** Lists frozen benchmark and online-sample manifests for the selected scope. */
export function getOrchestrationMetricEvaluationSets(ctx: MetricRequestContext, filters: OrchestrationMetricFilters): Promise<ApiResult<OrchestrationMetricEvaluationSetsResponse>> {
  return requestJson(ctx, { signal: ctx.signal, method: "GET", path: buildQueryPath("/api/account/orchestration-metrics/evaluation-sets", toQuery(filters)) });
}

/** Creates a replayable evaluation set from the current applied filters. */
export function createOrchestrationMetricEvaluationSet(ctx: MetricRequestContext, input: {
  filters: OrchestrationMetricFilters; kind: OrchestrationMetricEvaluationSetKind; name: string;
  description: string; criterion: OrchestrationMetricEvaluationCriterion; sampleSize: number;
}): Promise<ApiResult<OrchestrationMetricEvaluationSetSummary>> {
  return requestJson(ctx, { signal: ctx.signal, method: "POST", path: "/api/account/orchestration-metrics/evaluation-sets", body: input });
}

/** Loads one server-paged frozen evaluation-set item slice. */
export function getOrchestrationMetricEvaluationSetItems(ctx: MetricRequestContext, evaluationSetId: string, page: number, pageSize: number): Promise<ApiResult<OrchestrationMetricEvaluationSetItemsResponse>> {
  return requestJson(ctx, { signal: ctx.signal, method: "GET", path: buildQueryPath(`/api/account/orchestration-metrics/evaluation-sets/${encodeURIComponent(evaluationSetId)}/items`, { page, pageSize }) });
}

/** Records one explicit human score for a frozen Trace sample. */
export function scoreOrchestrationMetricEvaluationSetItem(ctx: MetricRequestContext, evaluationSetId: string, evaluationItemId: string, input: {
  evaluationStatus: "passed" | "failed" | "missing_evidence"; explanation: string;
}): Promise<ApiResult<OrchestrationMetricEvaluationSetItem>> {
  return requestJson(ctx, { signal: ctx.signal, method: "POST", path: `/api/account/orchestration-metrics/evaluation-sets/${encodeURIComponent(evaluationSetId)}/items/${encodeURIComponent(evaluationItemId)}/score`, body: input });
}

const CONTROLLED_EXPERIMENTS_PATH = "/api/account/orchestration-metrics/controlled-experiments";

/** Lists one current-user controlled-experiment page. */
export function getControlledExperiments(
  ctx: MetricRequestContext,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<ApiResult<ControlledExperimentListResponse>> {
  return requestJson(ctx, { method: "GET", path: buildQueryPath(CONTROLLED_EXPERIMENTS_PATH, { page, pageSize }), signal });
}

/** Loads one owner-visible controlled-experiment detail. */
export function getControlledExperiment(
  ctx: MetricRequestContext,
  experimentId: string,
  signal?: AbortSignal,
): Promise<ApiResult<ControlledExperimentDetail>> {
  return requestJson(ctx, { method: "GET", path: `${CONTROLLED_EXPERIMENTS_PATH}/${encodeURIComponent(experimentId)}`, signal });
}

/** Creates one idempotent controlled-experiment draft. */
export function createControlledExperiment(
  ctx: MetricRequestContext,
  input: ControlledExperimentCreateRequest,
): Promise<ApiResult<ControlledExperimentDetail>> {
  return requestJson(ctx, { signal: ctx.signal, method: "POST", path: CONTROLLED_EXPERIMENTS_PATH, body: input });
}

/** Freezes all benchmark and execution evidence for one draft. */
export function freezeControlledExperiment(ctx: MetricRequestContext, experimentId: string): Promise<ApiResult<ControlledExperimentDetail>> {
  return requestJson(ctx, { signal: ctx.signal, method: "POST", path: `${CONTROLLED_EXPERIMENTS_PATH}/${encodeURIComponent(experimentId)}/freeze` });
}

/** Starts one ready controlled experiment. */
export function startControlledExperiment(ctx: MetricRequestContext, experimentId: string): Promise<ApiResult<ControlledExperimentDetail>> {
  return requestJson(ctx, { signal: ctx.signal, method: "POST", path: `${CONTROLLED_EXPERIMENTS_PATH}/${encodeURIComponent(experimentId)}/start` });
}

/** Requests cancellation without hiding an already terminal outcome. */
export function cancelControlledExperiment(ctx: MetricRequestContext, experimentId: string): Promise<ApiResult<ControlledExperimentDetail>> {
  return requestJson(ctx, { signal: ctx.signal, method: "POST", path: `${CONTROLLED_EXPERIMENTS_PATH}/${encodeURIComponent(experimentId)}/cancel` });
}

/** 沿现有指标接口处理当前请求，页面退出时允许取消等待。 */
export function createOrchestrationMetricExport(ctx: MetricRequestContext, filters: OrchestrationMetricFilters, dataset: OrchestrationMetricExportDataset): Promise<ApiResult<OrchestrationMetricExportJob>> {
  return requestJson(ctx, { signal: ctx.signal, method: "POST", path: "/api/account/orchestration-metrics/exports", body: { filters, dataset, idempotencyKey: dataset + ":" + Date.now() + ":" + createBrowserUuid() } });
}
/** 沿现有指标接口处理当前请求，页面退出时允许取消等待。 */
export function getOrchestrationMetricExport(ctx: MetricRequestContext, id: string): Promise<ApiResult<OrchestrationMetricExportJob>> { return requestJson(ctx, { signal: ctx.signal, method: "GET", path: "/api/account/orchestration-metrics/exports/" + encodeURIComponent(id) }); }
/** 沿现有指标接口处理当前请求，页面退出时允许取消等待。 */
export function cancelOrchestrationMetricExport(ctx: MetricRequestContext, id: string): Promise<ApiResult<OrchestrationMetricExportJob>> { return requestJson(ctx, { signal: ctx.signal, method: "POST", path: "/api/account/orchestration-metrics/exports/" + encodeURIComponent(id) + "/cancel" }); }

function toQuery(filters: OrchestrationMetricFilters): Record<string, string | number | undefined | null> {
  return {
    scopeKind: filters.scopeKind,
    scopeId: filters.scopeId ?? undefined,
    from: filters.from ?? undefined,
    to: filters.to ?? undefined,
    workflowIds: filters.workflowIds?.join(",") || undefined,
    workflowSnapshotHashes: filters.workflowSnapshotHashes?.join(",") || undefined,
    statuses: filters.statuses?.join(",") || undefined,
    page: filters.page ?? undefined,
    pageSize: filters.pageSize ?? undefined,
    compareMode: filters.compareMode,
    compareFrom: filters.compareFrom ?? undefined,
    compareTo: filters.compareTo ?? undefined,
    nodeIds: filters.nodeIds?.join(",") || undefined,
    roleStages: filters.roleStages?.join(",") || undefined,
    qualityEventTypes: filters.qualityEventTypes?.join(",") || undefined,
    contractTypes: filters.contractTypes?.join(",") || undefined,
    contractEvaluationStatuses: filters.contractEvaluationStatuses?.join(",") || undefined,
    conformanceResults: filters.conformanceResults?.join(",") || undefined,
    conformanceDeviations: filters.conformanceDeviations?.join(",") || undefined,
    engines: filters.engines?.join(',') || undefined,
    models: filters.models?.join(',') || undefined,
    costDimension: filters.costDimension ?? undefined,
    codeAttributionDimension: filters.codeAttributionDimension ?? undefined,
    repositories: filters.repositories?.join(",") || undefined,
    languages: filters.languages?.join(",") || undefined,
    codeAttributionQualityStatuses: filters.codeAttributionQualityStatuses?.join(",") || undefined,
    codeAttributionReconciliationStatuses: filters.codeAttributionReconciliationStatuses?.join(",") || undefined,
    evaluationCriteria: filters.evaluationCriteria?.join(",") || undefined,
    experimentComparability: filters.experimentComparability ?? undefined,
    experimentCohortKey: filters.experimentCohortKey ?? undefined,
    dimension: filters.dimension,
    timezone: filters.timezone ?? undefined,
  };
}

function buildQueryPath(basePath: string, query?: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value == null || value === "") return;
    params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `${basePath}?${text}` : basePath;
}
